// Footage library API. Every route is behind sign-in (/api and /media need a session).
import multer from 'multer';
import { mkdirSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { db } from './db.js';
import { DATA_DIR, RAW_DIR } from './paths.js';
import { HttpError } from './errors.js';
import { storage } from './storage.js';
import { PRICES } from './ai.js';
import { queueSplits, rawName } from './split.js';
import {
  CFG, FORMATS, STAGE_LABEL, enqueue, fileSha256, sniffFile, assetOr404, deleteAsset, retryAsset, cancelJobsOf, anglesStale,
  sceneOr404, splitScene, mergeWithNext, trimScene, reanalyze, updateScene,
} from './footage.js';
import { productScenes, sceneRows, scenesForAngle, scenesForSentence, planTimeline, selectScenes, sceneSource, CATEGORIES, PLACEMENTS } from './footage-services.js';

const INCOMING = join(DATA_DIR, 'incoming'); // uploads wait here (on the volume) until stored for good
mkdirSync(INCOMING, { recursive: true });

// Rough AI cost of analysing a video (to show before/after processing).
export function estimateCost(seconds) {
  const scenes = Math.max(1, Math.round(seconds / 3.5));
  const frameTokens = Math.round((CFG.frameSize * Math.round(CFG.frameSize * 9 / 16)) / 750);
  const input = scenes * (CFG.frames * frameTokens + 150) + Math.ceil(scenes / CFG.batch) * 1500;
  const output = scenes * 900; // answer + thinking
  const [pi, po] = PRICES[CFG.model] || PRICES['claude-opus-5-5'];
  return { scenes, input_tokens: input, output_tokens: output, usd: Math.round(((input * pi + output * po) / 1e6) * 1000) / 1000 };
}

export function mountFootage(app, { h, idParam, str, productOr404 }) {
  const upload = multer({
    dest: INCOMING,
    limits: { fileSize: CFG.maxMb * 1024 * 1024, files: 20 },
    fileFilter: (req, file, cb) => {
      const ok = Boolean(FORMATS[extname(file.originalname).toLowerCase()]);
      if (!ok) (req.rejected ||= []).push({ name: file.originalname, reason: 'Only MP4, MOV and WebM videos' });
      cb(null, ok);
    },
  });
  // Multer errors (too big…) as clear messages, files cleaned up.
  const receive = (req, res) => new Promise((resolve, reject) => upload.array('files', 20)(req, res, err => {
    if (!err) return resolve();
    for (const f of req.files || []) rmSync(f.path, { force: true });
    reject(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? `A video is bigger than ${CFG.maxMb} MB` : err.code === 'LIMIT_FILE_COUNT' ? 'At most 20 videos at a time' : err.message));
  }));

  app.get('/api/footage/config', (req, res) => res.json({
    storage: storage.driver, maxMb: CFG.maxMb, formats: Object.keys(FORMATS), categories: CATEGORIES, placements: PLACEMENTS, stages: STAGE_LABEL,
    estimate30s: estimateCost(30), model: CFG.model, framesPerScene: CFG.frames,
  }));

  // ---------- Videos ----------
  app.post('/api/products/:id/footage', h(async (req, res) => {
    const p = productOr404(idParam(req.params.id));
    await receive(req, res);
    const files = req.files || [];
    const added = [], duplicates = [], rejected = [...(req.rejected || [])];
    for (const f of files) {
      try {
        const ext = extname(f.originalname).toLowerCase();
        if (!sniffFile(f.path)) { rejected.push({ name: f.originalname, reason: 'Not a real MP4/MOV/WebM video' }); rmSync(f.path, { force: true }); continue; }
        const sha = await fileSha256(f.path);
        const same = db.prepare(`SELECT id, name, status FROM footage_assets WHERE product_id = ? AND sha256 = ?`).get(p.id, sha);
        if (same) { duplicates.push({ name: f.originalname, id: same.id, existing: same.name, status: same.status }); rmSync(f.path, { force: true }); continue; }
        const incoming = join(INCOMING, `${f.filename}${ext}`);
        renameSync(f.path, incoming);
        const name = f.originalname.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'Video';
        const id = db.prepare(`INSERT INTO footage_assets (product_id, name, original_name, ext, mime, size, sha256, incoming, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(p.id, name, f.originalname.slice(0, 200), ext, FORMATS[ext], f.size, sha, incoming, req.user.id).lastInsertRowid;
        enqueue({ kind: 'process', assetId: id, productId: p.id, userId: req.user.id });
        added.push(id);
      } catch (e) {
        rmSync(f.path, { force: true });
        rejected.push({ name: f.originalname, reason: e.message });
      }
    }
    if (!files.length && !rejected.length) throw new HttpError(400, 'No video received');
    res.status(added.length ? 201 : 200).json({ added, duplicates, rejected });
  }));

  app.get('/api/products/:id/footage', (req, res) => {
    const p = productOr404(idParam(req.params.id));
    const assets = db.prepare(`SELECT * FROM footage_assets WHERE product_id = ? ORDER BY id DESC`).all(p.id);
    const jobs = db.prepare(`SELECT id, asset_id, kind, status, stage, progress, attempts, max_attempts, error, created_at, finished_at FROM footage_jobs WHERE product_id = ? ORDER BY id DESC`).all(p.id);
    const counts = db.prepare(`SELECT asset_id, COUNT(*) n, SUM(status = 'analyzed') analyzed, SUM(status = 'failed') failed, SUM(excluded) excluded FROM footage_scenes WHERE product_id = ? GROUP BY asset_id`).all(p.id);
    const costs = db.prepare(`SELECT ref, SUM(cost_usd) usd, SUM(input_tokens) i, SUM(output_tokens) o, COUNT(*) calls FROM ai_usage WHERE product_id = ? AND ref LIKE 'asset:%' GROUP BY ref`).all(p.id);
    const matchCost = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) usd FROM ai_usage WHERE product_id = ? AND kind = 'scene-match'`).get(p.id).usd;
    res.json({
      assets: assets.map(a => {
        const c = counts.find(x => x.asset_id === a.id) || { n: 0, analyzed: 0, failed: 0, excluded: 0 };
        const cost = costs.find(x => x.ref === `asset:${a.id}`);
        const { incoming, storage_key, proxy_key, thumb_key, sha256, ...pub } = a;
        return {
          ...pub, has_proxy: !!proxy_key, stored: !!storage_key, fingerprint: sha256.slice(0, 12),
          scenes: c.n, analyzed: c.analyzed || 0, failed_scenes: c.failed || 0, excluded: c.excluded || 0,
          ai_cost: cost ? Math.round(cost.usd * 1000) / 1000 : 0, ai_calls: cost?.calls || 0,
          job: jobs.find(j => j.asset_id === a.id) || null,
        };
      }),
      match_job: jobs.find(j => j.kind === 'match') || null,
      angles_stale: anglesStale(p.id),
      angles: db.prepare(`SELECT id, name, selected FROM angles WHERE product_id = ? ORDER BY position, id`).all(p.id),
      totals: { ai_cost: Math.round((costs.reduce((s, c) => s + c.usd, 0) + matchCost) * 1000) / 1000 },
    });
  });

  app.patch('/api/footage/:id', (req, res) => {
    const a = assetOr404(idParam(req.params.id));
    const name = str(req.body?.name, 120);
    if (!name) throw new HttpError(400, 'Give the video a name');
    db.prepare(`UPDATE footage_assets SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(name, a.id);
    res.json({ ok: true });
  });
  app.delete('/api/footage/:id', h(async (req, res) => {
    await deleteAsset(assetOr404(idParam(req.params.id)));
    res.json({ ok: true });
  }));
  app.post('/api/footage/:id/retry', (req, res) => {
    const a = assetOr404(idParam(req.params.id));
    if (['queued', 'storing', 'metadata', 'scenes', 'analyzing', 'matching'].includes(a.status) && db.prepare(`SELECT 1 FROM footage_jobs WHERE asset_id = ? AND status IN ('queued','running')`).get(a.id))
      throw new HttpError(409, 'This video is already being processed');
    res.json({ job: retryAsset(a, req.user.id) });
  });
  app.post('/api/footage/:id/cancel', (req, res) => {
    const a = assetOr404(idParam(req.params.id));
    const n = cancelJobsOf(a.id);
    if (!n) throw new HttpError(400, 'Nothing is running for this video');
    if (!db.prepare(`SELECT 1 FROM footage_jobs WHERE asset_id = ? AND status = 'running'`).get(a.id))
      db.prepare(`UPDATE footage_assets SET status = 'cancelled' WHERE id = ?`).run(a.id);
    res.json({ ok: true });
  });
  app.get('/api/footage/:id/jobs', (req, res) => {
    const a = assetOr404(idParam(req.params.id));
    res.json(db.prepare(`SELECT id, kind, status, stage, progress, attempts, error, log, created_at, started_at, finished_at FROM footage_jobs WHERE asset_id = ? ORDER BY id DESC LIMIT 10`).all(a.id));
  });
  // The same video also goes to the current ad maker (auto-split into clips).
  app.post('/api/footage/:id/to-clips', h(async (req, res) => {
    const a = assetOr404(idParam(req.params.id));
    if (!a.storage_key) throw new HttpError(409, 'The video is still being saved: try again in a moment');
    const file = rawName(a.product_id, a.original_name || a.name + a.ext);
    const dest = join(RAW_DIR, file);
    if (storage.driver === 'volume') copyFileSync(await storage.toLocal(a.storage_key), dest);
    else await storage.toLocal(a.storage_key, dest);
    db.prepare(`INSERT INTO raws (product_id, file, original_name, uploaded_by) VALUES (?,?,?,?)`).run(a.product_id, file, a.original_name || a.name + a.ext, req.user.id);
    queueSplits();
    res.status(201).json({ ok: true });
  }));

  // Video, preview and pictures (served from the volume, or a short-lived signed S3 link).
  app.get('/media/footage/:id/:what', h(async (req, res) => {
    const a = assetOr404(idParam(req.params.id));
    const what = req.params.what;
    if (what === 'thumb') { if (!a.thumb_key) throw new HttpError(404, 'No picture yet'); return storage.serve(res, a.thumb_key, { type: 'image/jpeg', maxAge: 3600 }); }
    if (!a.storage_key) throw new HttpError(404, 'The video is still being saved');
    if (what === 'preview') return storage.serve(res, a.proxy_key || a.storage_key, { type: a.proxy_key ? 'video/mp4' : a.mime });
    if (what === 'original') return storage.serve(res, a.storage_key, { type: a.mime, download: req.query.download ? (a.original_name || a.name + a.ext) : undefined });
    throw new HttpError(404, 'Not found');
  }));
  app.get('/media/scene/:id/thumb', h(async (req, res) => {
    const s = sceneOr404(idParam(req.params.id));
    if (!s.thumb_key) throw new HttpError(404, 'No picture yet');
    return storage.serve(res, s.thumb_key, { type: 'image/jpeg', maxAge: 3600 });
  }));

  // ---------- Scenes ----------
  app.get('/api/products/:id/scenes', (req, res) => {
    const p = productOr404(idParam(req.params.id));
    res.json({ scenes: productScenes(p.id), angles_stale: anglesStale(p.id) });
  });
  app.get('/api/scenes/:id', (req, res) => {
    const s = sceneOr404(idParam(req.params.id));
    res.json(sceneRows('s.id = ?', [s.id])[0]);
  });
  app.patch('/api/scenes/:id', (req, res) => {
    const id = idParam(req.params.id);
    updateScene(id, req.body || {});
    res.json(sceneRows('s.id = ?', [id])[0]);
  });
  app.post('/api/scenes/:id/split', h(async (req, res) => res.json({ ids: await splitScene(idParam(req.params.id), req.body?.at, req.user.id) })));
  app.post('/api/scenes/:id/merge', h(async (req, res) => res.json({ id: await mergeWithNext(idParam(req.params.id), req.user.id) })));
  app.post('/api/scenes/:id/trim', h(async (req, res) => { await trimScene(idParam(req.params.id), req.body?.start, req.body?.end, req.user.id); res.json({ ok: true }); }));
  app.post('/api/scenes/:id/reanalyze', (req, res) => { reanalyze([idParam(req.params.id)], req.user.id); res.json({ ok: true }); });
  app.post('/api/products/:id/scenes/rematch', (req, res) => {
    const p = productOr404(idParam(req.params.id));
    res.json({ job: enqueue({ kind: 'match', productId: p.id, userId: req.user.id, options: req.body?.force ? { force: true } : {} }) });
  });

  // ---------- For the next modules ----------
  app.get('/api/angles/:id/scenes', (req, res) => {
    const id = idParam(req.params.id);
    if (!db.prepare(`SELECT 1 FROM angles WHERE id = ?`).get(id)) throw new HttpError(404, 'Angle not found');
    res.json(scenesForAngle(id, { minScore: Number(req.query.minScore) || 40, minQuality: Number(req.query.minQuality) || 0 }));
  });
  app.post('/api/products/:id/scenes/search', (req, res) => {
    const p = productOr404(idParam(req.params.id));
    const b = req.body || {};
    res.json(b.sentence ? scenesForSentence(p.id, str(b.sentence, 500), b) : selectScenes(p.id, b));
  });
  app.post('/api/products/:id/footage/plan', (req, res) => {
    const p = productOr404(idParam(req.params.id));
    const slots = Array.isArray(req.body?.slots) ? req.body.slots.slice(0, 40) : [];
    if (!slots.length) throw new HttpError(400, 'Give slots: [{ placement, duration, sentence? }]');
    res.json(planTimeline(p.id, slots, { angleId: req.body.angleId ?? null, minQuality: Number(req.body.minQuality) || 0 }));
  });
  app.get('/api/scenes/:id/source', (req, res) => res.json(sceneSource(idParam(req.params.id)) || {}));
}
