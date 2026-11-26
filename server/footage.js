// Footage library: background processing of uploaded videos.
// process job: store the original → read its details (+ preview copy, thumbnail) → find scenes and measure them
//              → AI analysis of the scenes (description, categories, quality, placements, angles) → done.
// analyze job: (re)analyse scenes that were edited, failed or asked again.  match job: re-link scenes to changed angles.
// Jobs live in the database: after a restart they continue where they stopped. Each stage skips what is already done.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { db, tx } from './db.js';
import { TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { HttpError } from './errors.js';
import { listAngles } from './strategy.js';
import { aiReady, aiMock } from './ai.js';
import {
  videoInfo, makeSilentCopy, assertSilent, frameJpeg, grayFrame, measure, dhash, hamming, diff, techScore, planScenes, sceneCuts, sniffVideo,
} from './footage-media.js';
import { analyzeScenes, matchScenes, anglesHash, productHash, PROMPT_VERSION, CATEGORIES, PLACEMENTS } from './footage-ai.js';

const num = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : def; };
export const CFG = {
  maxMb: num('FOOTAGE_MAX_MB', 1024),              // biggest video accepted
  concurrency: Math.min(4, num('FOOTAGE_CONCURRENCY', 1)), // videos processed at the same time
  minScene: num('FOOTAGE_MIN_SCENE', 1.2),         // seconds: shorter scenes are merged with a neighbour
  maxScene: num('FOOTAGE_MAX_SCENE', 8),           // seconds: longer scenes are cut into equal parts
  threshold: num('FOOTAGE_SCENE_THRESHOLD', 0.3),  // 0-1: how big a picture change counts as a new scene
  frames: Math.min(6, num('FOOTAGE_FRAMES_PER_SCENE', 3)), // pictures of each scene sent to the AI
  frameSize: num('FOOTAGE_FRAME_SIZE', 768),       // longest side of those pictures (pixels)
  batch: Math.min(12, num('FOOTAGE_AI_BATCH', 6)), // scenes per AI call
  effort: process.env.FOOTAGE_AI_EFFORT || 'medium',
  model: process.env.FOOTAGE_AI_MODEL || process.env.ACC_MODEL || 'claude-opus-5-5',
  retries: num('FOOTAGE_MAX_ATTEMPTS', 3),
};
export const FORMATS = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const STAGE_LABEL = { uploaded: 'Uploaded', queued: 'Queued', storing: 'Saving the original', metadata: 'Extracting metadata', scenes: 'Detecting scenes',
  analyzing: 'Analyzing scenes', matching: 'Matching marketing angles', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
export { STAGE_LABEL };

const keyBase = a => `footage/p${a.product_id}/a${a.id}`;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
class Cancelled extends Error { constructor() { super('Cancelled'); } }

// ---------- Small helpers ----------
export function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
export function sniffFile(file) {
  const fd = openSync(file, 'r'); const b = Buffer.alloc(16);
  try { readSync(fd, b, 0, 16, 0); } finally { closeSync(fd); }
  return sniffVideo(b);
}
const asset = id => db.prepare(`SELECT * FROM footage_assets WHERE id = ?`).get(id);
const setAsset = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE footage_assets SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map(k => fields[k]), id);
};

// ---------- Queue ----------
// One queued/running job per asset and kind: asking twice gives the same job (no duplicates).
export function enqueue({ kind, assetId = null, productId, userId = null, options = {} }) {
  const open = db.prepare(`SELECT * FROM footage_jobs WHERE kind = ? AND product_id = ? AND asset_id IS ? AND status IN ('queued','running') ORDER BY id DESC`).all(kind, productId, assetId);
  const queued = open.find(j => j.status === 'queued');
  if (queued) {
    if (Object.keys(options).length) db.prepare(`UPDATE footage_jobs SET options = ? WHERE id = ?`).run(JSON.stringify({ ...JSON.parse(queued.options || '{}'), ...options }), queued.id);
    kick();
    return queued.id;
  }
  // None waiting (maybe one running: this new one runs right after it and picks up the new work).
  const id = db.prepare(`INSERT INTO footage_jobs (asset_id, product_id, kind, user_id, max_attempts, options) VALUES (?,?,?,?,?,?)`)
    .run(assetId, productId, kind, userId, CFG.retries, JSON.stringify(options)).lastInsertRowid;
  if (kind === 'process' && assetId && !open.length) setAsset(assetId, { status: 'queued', error: '', progress: 0 });
  kick();
  return id;
}

const active = new Map(); // job id → { cancelled, children }
let workers = 0, timer = null;
export function startFootageWorker() {
  if (!timer) timer = setInterval(kick, 5000);
  timer.unref?.();
  kick();
}
export function kick() { setImmediate(tick); }
function tick() {
  while (workers < CFG.concurrency) {
    // Next due job whose video is not already being worked on.
    const job = db.prepare(`UPDATE footage_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, error = ''
      WHERE id = (SELECT j.id FROM footage_jobs j WHERE j.status = 'queued' AND j.run_after <= datetime('now')
        AND NOT EXISTS (SELECT 1 FROM footage_jobs r WHERE r.status = 'running' AND r.product_id = j.product_id AND (r.asset_id IS j.asset_id OR r.asset_id IS NULL OR j.asset_id IS NULL))
        ORDER BY j.id LIMIT 1) RETURNING *`).get();
    if (!job) return;
    workers++;
    runJob(job).finally(() => { workers--; kick(); });
  }
}

export function cancelJobsOf(assetId) {
  const jobs = db.prepare(`SELECT * FROM footage_jobs WHERE asset_id = ? AND status IN ('queued','running')`).all(assetId);
  for (const j of jobs) {
    if (j.status === 'queued') db.prepare(`UPDATE footage_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`).run(j.id);
    const a = active.get(j.id);
    if (a) { a.cancelled = true; for (const c of a.children) c.kill('SIGKILL'); }
  }
  return jobs.length;
}

async function runJob(job) {
  const ctx = { job, children: new Set(), cancelled: false, work: join(TMP_DIR, `fjob-${job.id}`) };
  active.set(job.id, ctx);
  mkdirSync(ctx.work, { recursive: true });
  // Each line is saved at once (a crash or restart keeps the log of the attempt).
  ctx.log = msg => db.prepare(`UPDATE footage_jobs SET log = substr(log || ?, -20000) WHERE id = ?`).run(`${now()} ${msg}\n`, job.id);
  ctx.check = () => { if (ctx.cancelled) throw new Cancelled(); };
  ctx.stage = (stage, progress) => {
    db.prepare(`UPDATE footage_jobs SET stage = ?, progress = ? WHERE id = ?`).run(stage, progress, job.id);
    if (job.asset_id && job.kind !== 'match') setAsset(job.asset_id, { status: stage, progress });
  };
  ctx.log(`Start ${job.kind} (attempt ${job.attempts}/${job.max_attempts})`);
  const options = JSON.parse(job.options || '{}');
  try {
    if (job.kind === 'process') await processAsset(ctx, options);
    else if (job.kind === 'analyze') await analyzeAsset(ctx, options);
    else if (job.kind === 'match') await rematchProduct(ctx, options);
    ctx.check();
    db.prepare(`UPDATE footage_jobs SET status = 'completed', progress = 1, stage = 'completed', finished_at = datetime('now') WHERE id = ?`).run(job.id);
    if (job.asset_id && job.kind !== 'match' && asset(job.asset_id)) {
      const failedScenes = db.prepare(`SELECT COUNT(*) n FROM footage_scenes WHERE asset_id = ? AND status = 'failed'`).get(job.asset_id).n;
      setAsset(job.asset_id, { status: 'completed', progress: 1, error: failedScenes ? `${failedScenes} scene(s) could not be analysed: retry the analysis` : '' });
    }
    ctx.log('Done');
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctx.cancelled;
    const retry = !cancelled && e.transient && job.attempts < job.max_attempts;
    ctx.log(`${cancelled ? 'Cancelled' : retry ? 'Will try again' : 'Failed'}: ${e.message}`);
    if (!cancelled) console.error(`Footage job ${job.id} (${job.kind}):`, e.message);
    db.prepare(`UPDATE footage_jobs SET status = ?, error = ?, run_after = datetime('now', ?), finished_at = CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id = ?`)
      .run(cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled ? '' : String(e.message).slice(0, 500), `+${20 * job.attempts} seconds`, retry ? 1 : 0, job.id);
    if (job.asset_id && asset(job.asset_id) && job.kind !== 'match')
      setAsset(job.asset_id, cancelled ? { status: 'cancelled', error: '' } : retry ? { status: 'queued', error: `Retrying soon: ${String(e.message).slice(0, 300)}` } : { status: 'failed', error: String(e.message).slice(0, 500) });
  } finally {
    active.delete(job.id);
    rmSync(ctx.work, { recursive: true, force: true });
    // The uploaded file stays on the server only until it is safely stored.
    const a = job.asset_id && asset(job.asset_id);
    if (a?.incoming && a.storage_key && storage.driver === 's3' && await storage.exists(a.storage_key).catch(() => false)) {
      rmSync(a.incoming, { force: true }); setAsset(a.id, { incoming: '' });
    }
  }
}

// A local copy of the video to work on (the stored file on a volume; a download from S3).
async function localSource(ctx, a) {
  if (a.incoming && existsSync(a.incoming)) return a.incoming;
  if (!a.storage_key) throw new Error('The original video was not stored: upload it again');
  if (ctx.src) return ctx.src;
  ctx.src = await storage.toLocal(a.storage_key, join(ctx.work, 'source' + a.ext)).catch(e => { e.transient = true; throw e; });
  return ctx.src;
}

// ---------- process ----------
async function processAsset(ctx, options) {
  let a = asset(ctx.job.asset_id);
  if (!a) throw new Error('This video was deleted');
  // 1. Keep the original for good.
  if (!a.storage_key) {
    ctx.stage('storing', 0.02);
    if (!a.incoming || !existsSync(a.incoming)) throw new Error('The uploaded file is gone: upload the video again');
    const key = `${keyBase(a)}/original${a.ext}`;
    try { await storage.put(key, a.incoming, a.mime, { move: storage.driver === 'volume' }); } catch (e) { e.transient = true; throw e; }
    setAsset(a.id, { storage_key: key, ...(storage.driver === 'volume' ? { incoming: '' } : {}) });
    ctx.log(`Stored the original (${storage.driver})`);
    a = asset(a.id);
  }
  ctx.check();
  // 2. Metadata, thumbnail, preview copy.
  if (!a.meta_done) {
    ctx.stage('metadata', 0.06);
    const src = await localSource(ctx, a);
    const info = await videoInfo(src, ctx);
    if (!info.hasVideo || !(info.duration > 0)) throw new Error('This file is not a readable video');
    const thumbFile = join(ctx.work, 'thumb.jpg');
    await frameJpeg(src, Math.min(1, info.duration / 3), thumbFile, 480, ctx);
    const thumbKey = `${keyBase(a)}/thumb.jpg`;
    await storage.put(thumbKey, thumbFile, 'image/jpeg');
    // The silent copy: what scenes, previews and future editing use. Every original sound (voice, music, effects,
    // background) is removed with ffmpeg, then ffprobe checks that no audio stream is left. The original stays untouched.
    ctx.check();
    const silentFile = join(ctx.work, 'silent.mp4');
    const how = await makeSilentCopy(src, silentFile, info, a.ext, a.size, ctx);
    const check = await assertSilent(silentFile, ctx);
    const proxyKey = `${keyBase(a)}/silent.mp4`;
    await storage.put(proxyKey, silentFile, 'video/mp4');
    ctx.log(`Silent copy ${how === 'copied' ? '(picture kept as is)' : '(re-encoded)'}: ffprobe found ${check.audio} audio / ${check.video} video stream(s)`);
    setAsset(a.id, {
      duration: info.duration, width: info.width, height: info.height, fps: info.fps, vcodec: info.vcodec, acodec: info.acodec,
      has_audio: info.hasAudio ? 1 : 0, rotation: info.rotation, orientation: info.orientation, aspect: info.aspect, bitrate: info.bitrate,
      thumb_key: thumbKey, proxy_key: proxyKey, silent: 1, meta_done: 1,
    });
    ctx.log(`Metadata: ${info.width}x${info.height} ${info.fps}fps ${info.vcodec} ${info.duration.toFixed(1)}s`);
    a = asset(a.id);
  }
  ctx.check();
  // 3. Scenes.
  if (!a.scenes_done) {
    ctx.stage('scenes', 0.12);
    const src = await localSource(ctx, a);
    const cuts = await sceneCuts(src, CFG.threshold, ctx);
    const plan = planScenes(a.duration, cuts, { min: CFG.minScene, max: CFG.maxScene });
    ctx.log(`${cuts.length} picture changes → ${plan.length} scenes`);
    // A retry starts the scenes again (the original video never changes).
    for (const s of db.prepare(`SELECT id, thumb_key FROM footage_scenes WHERE asset_id = ?`).all(a.id)) await storage.remove(s.thumb_key);
    db.prepare(`DELETE FROM footage_scenes WHERE asset_id = ?`).run(a.id);
    for (let i = 0; i < plan.length; i++) {
      ctx.check();
      const id = db.prepare(`INSERT INTO footage_scenes (asset_id, product_id, start, end, duration) VALUES (?,?,?,?,?)`)
        .run(a.id, a.product_id, plan[i].start, plan[i].end, plan[i].end - plan[i].start).lastInsertRowid;
      await measureScene(ctx, a, id, src);
      ctx.stage('scenes', 0.12 + 0.18 * ((i + 1) / plan.length));
    }
    markLookAlikes(a.product_id);
    setAsset(a.id, { scenes_done: 1 });
    a = asset(a.id);
  }
  // 4. AI analysis + 5. angle matching.
  await analyzeAsset(ctx, options, 0.3);
}

// Thumbnail + measurements of one scene (no AI).
async function measureScene(ctx, a, sceneId, src) {
  const s = db.prepare(`SELECT * FROM footage_scenes WHERE id = ?`).get(sceneId);
  const len = s.end - s.start;
  const g1 = await grayFrame(src, s.start + len * 0.25, ctx), gm = await grayFrame(src, s.start + len * 0.5, ctx), g3 = await grayFrame(src, s.start + len * 0.75, ctx);
  const ms = [g1, gm, g3].filter(Boolean).map(measure);
  const avg = k => (ms.length ? ms.reduce((x, m) => x + m[k], 0) / ms.length : 0);
  const m = { sharp: avg('sharp'), brightness: avg('brightness'), contrast: avg('contrast') };
  const tech = techScore(m, a.width, a.height);
  const thumbFile = join(ctx.work, `s${sceneId}.jpg`);
  await frameJpeg(src, s.start + len * 0.5, thumbFile, 480, ctx);
  const thumbKey = `${keyBase(a)}/scenes/s${sceneId}-${Math.round(s.start * 1000)}.jpg`;
  await storage.put(thumbKey, thumbFile, 'image/jpeg');
  if (s.thumb_key && s.thumb_key !== thumbKey) await storage.remove(s.thumb_key);
  db.prepare(`UPDATE footage_scenes SET thumb_key = ?, phash = ?, sharpness = ?, brightness = ?, contrast = ?, motion = ?, tech_score = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(thumbKey, gm ? dhash(gm) : '', tech.sharpness, Math.round((m.brightness / 255) * 100), tech.contrast, Math.round(diff(g1, g3)), tech.score, sceneId);
}

// Look-alike scenes in a product (same fingerprint = duplicate, close = similar). The earliest one is the reference.
export function markLookAlikes(productId) {
  // Plain pictures (one colour, almost no detail) have no useful fingerprint: they are never called look-alikes.
  const informative = h => { const bits = [...BigInt('0x' + h).toString(2)].filter(b => b === '1').length; return bits >= 6 && bits <= 58; };
  const all = db.prepare(`SELECT id, phash, duration, contrast FROM footage_scenes WHERE product_id = ? ORDER BY id`).all(productId);
  const scenes = all.filter(s => s.phash && s.contrast >= 8 && informative(s.phash));
  db.prepare(`UPDATE footage_scenes SET duplicate_of = NULL, similar_to = NULL WHERE product_id = ?`).run(productId);
  const upd = db.prepare(`UPDATE footage_scenes SET duplicate_of = ?, similar_to = ? WHERE id = ?`);
  tx(() => {
    for (let i = 0; i < scenes.length; i++) {
      let dup = null, sim = null;
      for (let j = 0; j < i; j++) {
        const d = hamming(scenes[i].phash, scenes[j].phash);
        if (d <= 2 && Math.abs(scenes[i].duration - scenes[j].duration) < 0.3) { dup = scenes[j].id; break; }
        if (d <= 8 && sim === null) sim = scenes[j].id;
      }
      upd.run(dup, dup ? null : sim, scenes[i].id);
    }
  });
}

// ---------- analysis ----------
const frameTimes = (s, n) => Array.from({ length: n }, (_, i) => s.start + (s.end - s.start) * (n === 1 ? 0.5 : 0.12 + (0.76 * i) / (n - 1)));
const cacheKey = (a, s, p, aHash) => createHash('sha256').update([a.sha256, s.start.toFixed(2), s.end.toFixed(2), CFG.frames, CFG.frameSize, CFG.model, PROMPT_VERSION, productHash(p), aHash].join('|')).digest('hex');

async function analyzeAsset(ctx, options, base = 0) {
  const a = asset(ctx.job.asset_id);
  if (!a) throw new Error('This video was deleted');
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(a.product_id);
  const angles = listAngles(a.product_id);
  const aHash = anglesHash(angles);
  // Scenes that were split/merged/trimmed first get a new thumbnail and measurements.
  const unmeasured = db.prepare(`SELECT id FROM footage_scenes WHERE asset_id = ? AND thumb_key = ''`).all(a.id);
  if (unmeasured.length) {
    ctx.stage('scenes', base);
    const src = await localSource(ctx, a);
    for (const s of unmeasured) { ctx.check(); await measureScene(ctx, a, s.id, src); }
    markLookAlikes(a.product_id);
  }
  const todo = db.prepare(`SELECT * FROM footage_scenes WHERE asset_id = ? AND status IN ('pending','failed') ORDER BY start`).all(a.id);
  if (!todo.length) return;
  if (!aiReady() && !aiMock()) throw Object.assign(new Error('AI is not set up (ANTHROPIC_API_KEY): scenes were found, but not analysed. Add the key, then retry.'), { transient: false });
  ctx.stage('analyzing', Math.max(base, 0.3));
  let done = 0;
  const step = () => ctx.stage('analyzing', 0.3 + 0.65 * (done / todo.length));
  // Cached answers first: the same scene of the same file with the same settings is not paid twice.
  const fresh = [];
  for (const s of todo) {
    const key = options.force ? null : cacheKey(a, s, p, aHash);
    const hit = key && db.prepare(`SELECT json FROM ai_cache WHERE key = ?`).get(key);
    if (hit) { saveAnalysis(s, JSON.parse(hit.json), { key, aHash, model: CFG.model + ' (cached)' }); done++; continue; }
    fresh.push(s);
  }
  if (done) { ctx.log(`${done} scene(s) from the cache`); step(); }
  for (let i = 0; i < fresh.length; i += CFG.batch) {
    ctx.check();
    const batch = fresh.slice(i, i + CFG.batch);
    const src = await localSource(ctx, a);
    const items = [];
    for (const s of batch) {
      const frames = [];
      for (const [k, t] of frameTimes(s, CFG.frames).entries()) {
        const file = join(ctx.work, `f${s.id}-${k}.jpg`);
        await frameJpeg(src, t, file, CFG.frameSize, ctx, 5);
        frames.push({ t, file });
      }
      items.push({ ref: `S${s.id}`, start: s.start, end: s.end, frames, measured: measuredOf(s) });
    }
    ctx.check();
    let out;
    try {
      out = await analyzeScenes({ product: p, angles, items, asset: a, userId: ctx.job.user_id, model: CFG.model, effort: CFG.effort });
    } catch (e) {
      e.transient = e.transient ?? (e instanceof HttpError ? [429, 500, 502, 529].includes(e.status) : true);
      throw e;
    }
    for (const s of batch) {
      const r = out.find(x => x.ref === `S${s.id}`);
      if (!r) { db.prepare(`UPDATE footage_scenes SET status = 'failed', error = 'The AI gave no answer for this scene' WHERE id = ?`).run(s.id); continue; }
      const key = cacheKey(a, s, p, aHash);
      db.prepare(`INSERT OR REPLACE INTO ai_cache (key, kind, json) VALUES (?, 'scene', ?)`).run(key, JSON.stringify(r));
      saveAnalysis(s, r, { key, aHash, model: CFG.model });
    }
    for (const it of items) for (const f of it.frames) rmSync(f.file, { force: true });
    done += batch.length;
    step();
    ctx.log(`Analysed ${done}/${todo.length} scenes`);
  }
  // Scenes analysed with older angles get re-linked (text only, no pictures).
  if (angles.length && db.prepare(`SELECT 1 FROM scene_analyses sa JOIN footage_scenes s ON s.id = sa.scene_id WHERE s.asset_id = ? AND sa.angles_hash != ?`).get(a.id, aHash)) {
    ctx.stage('matching', 0.96);
    await matchAngles(ctx, p, angles, db.prepare(`SELECT s.* FROM footage_scenes s JOIN scene_analyses sa ON sa.scene_id = s.id WHERE s.asset_id = ? AND sa.angles_hash != ?`).all(a.id, aHash));
  }
}

const measuredOf = s => ({ sharpness: s.sharpness, exposure: s.brightness, contrast: s.contrast, motion: s.motion, tech: s.tech_score });

// Save the AI's answer for a scene. The team's own changes (user tags, user angle links) are kept.
function saveAnalysis(s, r, { key, aHash, model }) {
  const scene = db.prepare(`SELECT * FROM footage_scenes WHERE id = ?`).get(s.id);
  const flags = [];
  if (r.watermark?.present) flags.push('watermark');
  if (r.text_overlays?.length || r.graphics?.captions || r.graphics?.promo_text) flags.push('text_overlay');
  if (r.graphics?.arrows_stickers || r.graphics?.other_graphics) flags.push('graphics');
  if (r.origin === 'staged_or_promotional' || r.origin === 'synthetic_or_cgi') flags.push('staged');
  if (r.relevance < 30) flags.push('irrelevant');
  const ai = Math.round(r.quality?.score ?? 0);
  // Final score: AI judgment of ad usability + measured picture quality; watermarks cost points.
  let quality = Math.round(ai * 0.55 + scene.tech_score * 0.45 - (r.watermark?.present ? 10 : 0));
  quality = Math.max(0, Math.min(100, quality));
  if (quality < 45) flags.push('low_quality');
  const techNotes = [];
  if (scene.sharpness < 40) techNotes.push('soft picture');
  if (scene.brightness < 20) techNotes.push('dark');
  const note = [r.quality?.note, techNotes.length ? `Measured: ${techNotes.join(', ')}.` : ''].filter(Boolean).join(' ');
  const data = {
    objects: r.objects, product_visible: r.product_visible, features_shown: r.features_shown, benefits_supported: r.benefits_supported,
    human_interaction: r.human_interaction, environment: r.environment, camera_movement: r.camera_movement, composition: r.composition,
    text_overlays: r.text_overlays, watermark: r.watermark, graphics: r.graphics, product_box: r.product_box, origin: r.origin, relevance_note: r.relevance_note, quality_parts: r.quality,
  };
  const prev = db.prepare(`SELECT edited, placements FROM scene_analyses WHERE scene_id = ?`).get(s.id);
  const validAngles = new Set(db.prepare(`SELECT id FROM angles WHERE product_id = ?`).all(scene.product_id).map(x => x.id));
  tx(() => {
    db.prepare(`INSERT OR REPLACE INTO scene_analyses (scene_id, cache_key, model, description, semantic, data, relevance, ai_quality, quality, quality_note, flags, placements, angles_hash, edited)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, key || '', model, r.description, r.semantic, JSON.stringify(data), Math.round(r.relevance), ai, quality, note,
      JSON.stringify(flags), prev?.edited ? prev.placements : JSON.stringify(r.placements || []), aHash, prev?.edited || 0);
    db.prepare(`DELETE FROM scene_tags WHERE scene_id = ? AND source = 'ai'`).run(s.id);
    const ins = db.prepare(`INSERT OR IGNORE INTO scene_tags (scene_id, kind, tag, source) VALUES (?,?,?, 'ai')`);
    for (const c of r.categories || []) if (CATEGORIES[c]) ins.run(s.id, 'category', c);
    for (const t of r.tags || []) if (String(t).trim()) ins.run(s.id, 'tag', String(t).trim().toLowerCase().slice(0, 40));
    db.prepare(`DELETE FROM scene_angles WHERE scene_id = ? AND source = 'ai'`).run(s.id);
    const insA = db.prepare(`INSERT OR IGNORE INTO scene_angles (scene_id, angle_id, score, reason, source) VALUES (?,?,?,?, 'ai')`);
    for (const x of r.angles || []) if (validAngles.has(x.angle_id)) insA.run(s.id, x.angle_id, Math.max(0, Math.min(100, Math.round(x.score))), String(x.reason || '').slice(0, 300));
    db.prepare(`UPDATE footage_scenes SET status = 'analyzed', error = '', updated_at = datetime('now') WHERE id = ?`).run(s.id);
  });
}

// ---------- angle matching (text only) ----------
async function matchAngles(ctx, p, angles, scenes) {
  const aHash = anglesHash(angles);
  const validAngles = new Set(angles.map(a => a.id));
  const textOf = s => {
    const an = db.prepare(`SELECT description, semantic, data FROM scene_analyses WHERE scene_id = ?`).get(s.id);
    const d = JSON.parse(an?.data || '{}');
    const cats = db.prepare(`SELECT tag FROM scene_tags WHERE scene_id = ? AND kind = 'category'`).all(s.id).map(x => CATEGORIES[x.tag] || x.tag);
    return `${an?.description || ''} Action: ${an?.semantic || ''}. Shows: ${(d.features_shown || []).join(', ') || '-'}. Benefits seen: ${(d.benefits_supported || []).join(', ') || '-'}. People: ${d.human_interaction || '-'}. Categories: ${cats.join(', ')}.`;
  };
  for (let i = 0; i < scenes.length; i += 20) {
    ctx.check();
    const batch = scenes.slice(i, i + 20);
    let out;
    try {
      out = await matchScenes({ product: p, angles, scenes: batch.map(s => ({ ref: `S${s.id}`, text: textOf(s) })), userId: ctx.job.user_id, model: CFG.model, effort: 'low' });
    } catch (e) { e.transient = e.transient ?? (e instanceof HttpError ? [429, 500, 502, 529].includes(e.status) : true); throw e; }
    tx(() => {
      for (const s of batch) {
        const r = out.find(x => x.ref === `S${s.id}`);
        if (!r) continue;
        db.prepare(`DELETE FROM scene_angles WHERE scene_id = ? AND source = 'ai'`).run(s.id);
        const insA = db.prepare(`INSERT OR IGNORE INTO scene_angles (scene_id, angle_id, score, reason, source) VALUES (?,?,?,?, 'ai')`);
        for (const x of r.angles) if (validAngles.has(x.angle_id)) insA.run(s.id, x.angle_id, Math.max(0, Math.min(100, Math.round(x.score))), String(x.reason || '').slice(0, 300));
        db.prepare(`UPDATE scene_analyses SET angles_hash = ? WHERE scene_id = ?`).run(aHash, s.id);
      }
    });
    ctx.stage('matching', Math.min(0.99, 0.5 + 0.5 * ((i + batch.length) / scenes.length)));
    ctx.log(`Matched ${Math.min(i + 20, scenes.length)}/${scenes.length} scenes with the angles`);
  }
}

async function rematchProduct(ctx, options) {
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(ctx.job.product_id);
  if (!p) throw new Error('Product deleted');
  const angles = listAngles(p.id);
  const aHash = anglesHash(angles);
  if (!angles.length) {
    db.prepare(`DELETE FROM scene_angles WHERE source = 'ai' AND scene_id IN (SELECT id FROM footage_scenes WHERE product_id = ?)`).run(p.id);
    return;
  }
  if (!aiReady() && !aiMock()) throw new Error('AI is not set up (ANTHROPIC_API_KEY)');
  ctx.stage('matching', 0.05);
  const scenes = db.prepare(`SELECT s.* FROM footage_scenes s JOIN scene_analyses sa ON sa.scene_id = s.id WHERE s.product_id = ? ${options.force ? '' : 'AND sa.angles_hash != ?'} ORDER BY s.id`)
    .all(...(options.force ? [p.id] : [p.id, aHash]));
  ctx.log(`${scenes.length} scene(s) to match with ${angles.length} angles`);
  await matchAngles(ctx, p, angles, scenes);
}

// Do some analysed scenes still use older marketing angles?
export function anglesStale(productId) {
  const h = anglesHash(listAngles(productId));
  return db.prepare(`SELECT COUNT(*) n FROM scene_analyses sa JOIN footage_scenes s ON s.id = sa.scene_id WHERE s.product_id = ? AND sa.angles_hash != ?`).get(productId, h).n;
}

// ---------- Scene editing (the original video never changes: only times) ----------
const MIN_LEN = 0.3;
export const sceneOr404 = id => {
  const s = db.prepare(`SELECT * FROM footage_scenes WHERE id = ?`).get(id);
  if (!s) throw new HttpError(404, 'Scene not found');
  return s;
};
const resetScene = id => db.prepare(`UPDATE footage_scenes SET thumb_key = '', status = 'pending', source = ?, updated_at = datetime('now') WHERE id = ?`);
async function dropThumb(s) { if (s.thumb_key) await storage.remove(s.thumb_key); }

export async function splitScene(id, at, userId) {
  const s = sceneOr404(id);
  const t = Number(at);
  if (!(t > s.start + MIN_LEN && t < s.end - MIN_LEN)) throw new HttpError(400, `Split inside the scene, at least ${MIN_LEN}s from each end`);
  await dropThumb(s);
  const newId = tx(() => {
    db.prepare(`UPDATE footage_scenes SET end = ?, duration = ? WHERE id = ?`).run(t, t - s.start, s.id);
    resetScene().run('split', s.id);
    db.prepare(`DELETE FROM scene_analyses WHERE scene_id = ?`).run(s.id);
    db.prepare(`DELETE FROM scene_tags WHERE scene_id = ? AND source = 'ai'`).run(s.id);
    db.prepare(`DELETE FROM scene_angles WHERE scene_id = ? AND source = 'ai'`).run(s.id);
    return db.prepare(`INSERT INTO footage_scenes (asset_id, product_id, start, end, duration, source, excluded, favorite) VALUES (?,?,?,?,?, 'split', ?, ?)`)
      .run(s.asset_id, s.product_id, t, s.end, s.end - t, s.excluded, s.favorite).lastInsertRowid;
  });
  enqueue({ kind: 'analyze', assetId: s.asset_id, productId: s.product_id, userId, options: {} });
  return [s.id, newId];
}

export async function mergeWithNext(id, userId) {
  const s = sceneOr404(id);
  const next = db.prepare(`SELECT * FROM footage_scenes WHERE asset_id = ? AND start >= ? AND id != ? ORDER BY start LIMIT 1`).get(s.asset_id, s.end - 0.01, s.id);
  if (!next) throw new HttpError(400, 'This is the last scene of the video');
  await dropThumb(s); await dropThumb(next);
  tx(() => {
    db.prepare(`UPDATE footage_scenes SET end = ?, duration = ?, favorite = MAX(favorite, ?) WHERE id = ?`).run(next.end, next.end - s.start, next.favorite, s.id);
    resetScene().run('merge', s.id);
    db.prepare(`DELETE FROM scene_analyses WHERE scene_id = ?`).run(s.id);
    db.prepare(`DELETE FROM scene_tags WHERE scene_id = ? AND source = 'ai'`).run(s.id);
    db.prepare(`DELETE FROM scene_angles WHERE scene_id = ? AND source = 'ai'`).run(s.id);
    // The team's own tags and angle links of the second scene move to the merged one.
    db.prepare(`UPDATE OR IGNORE scene_tags SET scene_id = ? WHERE scene_id = ? AND source = 'user'`).run(s.id, next.id);
    db.prepare(`UPDATE OR IGNORE scene_angles SET scene_id = ? WHERE scene_id = ? AND source = 'user'`).run(s.id, next.id);
    db.prepare(`DELETE FROM footage_scenes WHERE id = ?`).run(next.id);
  });
  enqueue({ kind: 'analyze', assetId: s.asset_id, productId: s.product_id, userId, options: {} });
  return s.id;
}

export async function trimScene(id, start, end, userId) {
  const s = sceneOr404(id);
  const a = asset(s.asset_id);
  const st = Number(start), en = Number(end);
  if (!(st >= 0 && en <= a.duration + 0.01 && en - st >= MIN_LEN)) throw new HttpError(400, `Start and end must be inside the video and at least ${MIN_LEN}s apart`);
  await dropThumb(s);
  tx(() => {
    db.prepare(`UPDATE footage_scenes SET start = ?, end = ?, duration = ? WHERE id = ?`).run(st, en, en - st, s.id);
    resetScene().run('trim', s.id);
  });
  enqueue({ kind: 'analyze', assetId: s.asset_id, productId: s.product_id, userId, options: {} });
}

export function reanalyze(sceneIds, userId) {
  const scenes = sceneIds.map(sceneOr404);
  db.prepare(`UPDATE footage_scenes SET status = 'pending' WHERE id IN (${scenes.map(() => '?').join(',')})`).run(...scenes.map(s => s.id));
  for (const assetId of new Set(scenes.map(s => s.asset_id))) enqueue({ kind: 'analyze', assetId, productId: scenes[0].product_id, userId, options: { force: true } });
}

// Team edits: favourite, exclude, description, categories, tags, placements, angle links.
export function updateScene(id, b) {
  const s = sceneOr404(id);
  tx(() => {
    if (b.favorite !== undefined) db.prepare(`UPDATE footage_scenes SET favorite = ? WHERE id = ?`).run(b.favorite ? 1 : 0, s.id);
    if (b.excluded !== undefined) db.prepare(`UPDATE footage_scenes SET excluded = ? WHERE id = ?`).run(b.excluded ? 1 : 0, s.id);
    const an = db.prepare(`SELECT 1 FROM scene_analyses WHERE scene_id = ?`).get(s.id);
    if (!an && (b.description !== undefined || b.semantic !== undefined || b.placements !== undefined))
      db.prepare(`INSERT INTO scene_analyses (scene_id, model) VALUES (?, 'team')`).run(s.id);
    if (b.description !== undefined) db.prepare(`UPDATE scene_analyses SET description = ?, edited = 1 WHERE scene_id = ?`).run(String(b.description).slice(0, 1000), s.id);
    if (b.semantic !== undefined) db.prepare(`UPDATE scene_analyses SET semantic = ?, edited = 1 WHERE scene_id = ?`).run(String(b.semantic).slice(0, 300), s.id);
    if (Array.isArray(b.placements)) {
      const list = b.placements.filter(x => PLACEMENTS[x?.placement]).map(x => ({ placement: x.placement, fit: Math.max(0, Math.min(100, Math.round(Number(x.fit) || 70))) }));
      db.prepare(`UPDATE scene_analyses SET placements = ?, edited = 1 WHERE scene_id = ?`).run(JSON.stringify(list), s.id);
    }
    // Categories and tags given → they replace the current ones (all become the team's).
    for (const [kind, list] of [['category', b.categories], ['tag', b.tags]]) {
      if (!Array.isArray(list)) continue;
      const clean = [...new Set(list.map(t => String(t).trim().toLowerCase().slice(0, 40)).filter(t => t && (kind === 'tag' || CATEGORIES[t])))];
      db.prepare(`DELETE FROM scene_tags WHERE scene_id = ? AND kind = ?`).run(s.id, kind);
      for (const t of clean) db.prepare(`INSERT INTO scene_tags (scene_id, kind, tag, source) VALUES (?,?,?, 'user')`).run(s.id, kind, t);
    }
    if (Array.isArray(b.angles)) {
      const valid = new Set(db.prepare(`SELECT id FROM angles WHERE product_id = ?`).all(s.product_id).map(x => x.id));
      db.prepare(`DELETE FROM scene_angles WHERE scene_id = ?`).run(s.id);
      for (const x of b.angles) if (valid.has(Number(x.angle_id)))
        db.prepare(`INSERT OR REPLACE INTO scene_angles (scene_id, angle_id, score, reason, source) VALUES (?,?,?,?, 'user')`)
          .run(s.id, Number(x.angle_id), Math.max(0, Math.min(100, Math.round(Number(x.score) || 70))), String(x.reason || '').slice(0, 300));
    }
    db.prepare(`UPDATE footage_scenes SET updated_at = datetime('now') WHERE id = ?`).run(s.id);
  });
}

// ---------- Assets ----------
export const assetOr404 = id => {
  const a = asset(id);
  if (!a) throw new HttpError(404, 'Video not found');
  return a;
};

export async function deleteAsset(a) {
  cancelJobsOf(a.id);
  const keys = [a.storage_key, a.proxy_key, a.thumb_key, ...db.prepare(`SELECT thumb_key FROM footage_scenes WHERE asset_id = ?`).all(a.id).map(s => s.thumb_key)];
  db.prepare(`DELETE FROM footage_assets WHERE id = ?`).run(a.id);
  if (a.incoming) rmSync(a.incoming, { force: true });
  for (const k of keys) if (k) await storage.remove(k);
  await storage.removePrefix(`${keyBase(a)}/`).catch(e => console.error('Footage delete', a.id, e.message));
  markLookAlikes(a.product_id);
}

export async function deleteProductFootage(productId) {
  for (const a of db.prepare(`SELECT * FROM footage_assets WHERE product_id = ?`).all(productId)) await deleteAsset(a);
}

// Try again: a new process job continues from the last finished stage; failed scenes are analysed again.
export function retryAsset(a, userId) {
  db.prepare(`UPDATE footage_scenes SET status = 'pending' WHERE asset_id = ? AND status = 'failed'`).run(a.id);
  return enqueue({ kind: 'process', assetId: a.id, productId: a.product_id, userId });
}

export const fileSizeOk = f => statSync(f).size <= CFG.maxMb * 1024 * 1024;
