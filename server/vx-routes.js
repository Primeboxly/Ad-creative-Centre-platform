// Module 7 API: visual enhancements of approved video edits (Auto Enhance, targeted regeneration, team edits on the
// visual timeline, versions, renders, approval, package for Module 8), brand kits (logo upload: PNG / JPEG / WebP only,
// re-encoded to PNG; no SVG), team caption presets and safe-zone presets. Behind sign-in; renders are served by this
// server only.
import multer from 'multer';
import { readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { DATA_DIR, TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { projectRow } from './creative.js';
import { run, probeVideo } from './video-render.js';
import { CAPTION_STYLES, FONTS, ANIMATIONS, INTENSITIES, SEGMENTATIONS, POSITIONS, HOOK_TEMPLATES, BENEFIT_TEMPLATES, PRICE_TEMPLATES, CTA_TEMPLATES, EFFECTS, TRACKS, VX_STATUSES, VX_SCHEMA_VERSION, VX_LIMITS } from './vx-registry.js';
import { VX_DIRECTOR_SCHEMA } from './vx-director.js';
import { readyEdits, getOrCreate, vxRow, vxState, applyEdit, saveVersion, restoreVersion, compareVersions, approve, latestPackage, approvedEnhancedPackage, loadInputs, revalidate, latestVersion, docsOf, saveDocs, workingVersion, mustEdit,
  brandKits, brandKit, saveBrandKit, customStyles, saveCustomStyle, deleteCustomStyle, safeZones, saveSafeZone } from './vx-production.js';
import { enqueue, cancel, retryFailed, PARTS } from './vx-jobs.js';

const INCOMING = join(DATA_DIR, 'incoming');
const IMG = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

export const PLAN_SCHEMA_DOC = {
  schema_version: VX_SCHEMA_VERSION,
  plan: { required: ['schema_version', 'vx_id', 'project_id', 'variation_index', 'inputs', 'output', 'style', 'intensity', 'palette', 'brand_kit', 'safe_zone', 'caption', 'settings', 'elements', 'validation'],
    inputs: 'brief {id, version}, script_version, storyboard_version, audio_package {id, version_id}, video {edit_id, version_id, edl_hash, approval_id}',
    output: '{aspect_ratio, width, height, fps, duration (s), frames}' },
  element: { id: 'unique id', type: ['caption', 'hook', 'benefit', 'feature', 'price', 'offer', 'cta', 'effect', 'logo'], track: Object.keys(TRACKS), text: 'string', lines: 'string[]',
    words: 'caption words [{text, start, end, hl?, timing}]', start: 's (ms precision)', end: 's', start_frame: 'int', end_frame: 'int', position: '{x, y} centre, fractions of the frame + preset',
    size: '{w, h} estimated fractions', max_width: 'fraction', font: '{key, family, size (fraction of height), uppercase, weight}', colors: '{text, highlight, outline, accent}', outline: '{width, color}',
    shadow: '{depth, color, opacity}', background: '{mode none|box, color, opacity, padding}', animation: `{type ${ANIMATIONS.join('|')}, in_ms, out_ms, pulse?}`, template: 'from the template lists', layer: 'int',
    segment_id: 'script segment', clip_id: 'Module 6 clip', visibility: '{enabled, rule}', locked: 'bool', edited: 'bool', source: 'voiceover|ai|brief|brand_kit|team', purpose: 'why it is there' },
};

export function mountVisual(app, { idParam }) {
  const upload = multer({ dest: INCOMING, limits: { fileSize: VX_LIMITS.logoMaxBytes, files: 1 } });
  const receive = (req, res) => new Promise((resolve, reject) => upload.single('file')(req, res, err => {
    if (!err) return resolve();
    if (req.file) rmSync(req.file.path, { force: true });
    reject(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'The logo is bigger than 2 MB' : err.message));
  }));

  app.get('/api/visual/config', (req, res) => res.json({ schema_version: VX_SCHEMA_VERSION, styles: { ...CAPTION_STYLES, ...Object.fromEntries(customStyles()) }, fonts: FONTS, animations: ANIMATIONS,
    intensities: INTENSITIES, segmentations: SEGMENTATIONS, positions: POSITIONS, hook_templates: HOOK_TEMPLATES, benefit_templates: BENEFIT_TEMPLATES, price_templates: PRICE_TEMPLATES, cta_templates: CTA_TEMPLATES,
    effects: EFFECTS, tracks: TRACKS, statuses: VX_STATUSES, safe_zones: safeZones(), limits: VX_LIMITS, parts: PARTS }));
  app.get('/api/visual/schemas', (req, res) => res.json({ version: VX_SCHEMA_VERSION, plan: PLAN_SCHEMA_DOC, director: VX_DIRECTOR_SCHEMA }));
  app.get('/api/creative-projects/:id/visual', (req, res) => { const id = idParam(req.params.id); projectRow(id); res.json({ edits: readyEdits(id) }); });
  app.post('/api/creative-projects/:id/visual/open', (req, res) => res.json({ vx_id: getOrCreate(idParam(req.params.id), idParam(req.body?.vd_approval_id), req.user).id }));
  // One button (Auto Enhance): create or open, then strategy → captions → overlays → effects → checks → render → QC.
  app.post('/api/creative-projects/:id/visual/auto', (req, res) => {
    const x = getOrCreate(idParam(req.params.id), idParam(req.body?.vd_approval_id), req.user);
    res.status(202).json({ vx_id: x.id, job: enqueue(x.id, 'auto', req.user, { target: ['preview', 'standard', 'high'].includes(req.body?.quality) ? req.body.quality : 'preview', options: { force: !!req.body?.force } }) });
  });
  app.get('/api/visual-edits/:id', (req, res) => res.json(vxState(idParam(req.params.id), req.user)));
  app.post('/api/visual-edits/:id/jobs', (req, res) => {
    const b = req.body || {};
    res.status(202).json({ job: enqueue(idParam(req.params.id), String(b.kind || ''), req.user, { target: b.quality || '', options: { ...(b.force ? { force: true } : {}), ...(b.force_render ? { force_render: true } : {}), ...(Array.isArray(b.parts) && b.parts.length ? { parts: b.parts.map(String) } : {}) } }) });
  });
  app.post('/api/visual-edits/:id/retry', (req, res) => res.status(202).json({ job: retryFailed(idParam(req.params.id), req.user) }));
  app.post('/api/visual-edits/:id/cancel', (req, res) => res.json({ cancelled: cancel(idParam(req.params.id), req.user) }));
  app.get('/api/visual-edits/:id/jobs/latest', (req, res) => res.json(db.prepare(`SELECT * FROM vx_jobs WHERE vx_id = ? ORDER BY id DESC LIMIT 1`).get(idParam(req.params.id)) || null));
  app.patch('/api/visual-edits/:id', (req, res) => { const id = idParam(req.params.id); applyEdit(id, req.body || {}, req.user); res.json(vxState(id, req.user)); });
  app.post('/api/visual-edits/:id/validate', (req, res) => {
    const id = idParam(req.params.id), x = vxRow(id); mustEdit(x, req.user);
    const v = workingVersion(id, req.user.id), d = docsOf(v);
    if (d.plan) { revalidate(d.plan, loadInputs(x)); saveDocs(v.id, { plan: d.plan }); }
    res.json(vxState(id, req.user));
  });
  app.post('/api/visual-edits/:id/versions', (req, res) => { const id = idParam(req.params.id); saveVersion(id, req.user, req.body?.label); res.status(201).json(vxState(id, req.user)); });
  app.post('/api/visual-edits/:id/versions/:vid/restore', (req, res) => { const id = idParam(req.params.id); restoreVersion(id, idParam(req.params.vid), req.user); res.json(vxState(id, req.user)); });
  app.get('/api/visual-edits/:id/compare', (req, res) => res.json(compareVersions(idParam(req.params.id), idParam(req.query.a), idParam(req.query.b))));
  app.get('/api/visual-edits/:id/plan', (req, res) => {
    const id = idParam(req.params.id); vxRow(id);
    const v = req.query.version ? db.prepare(`SELECT * FROM vx_versions WHERE id = ? AND vx_id = ?`).get(idParam(req.query.version), id) : latestVersion(id);
    if (!v?.plan) throw new HttpError(404, 'No visual plan yet');
    res.json(JSON.parse(v.plan));
  });
  app.post('/api/visual-edits/:id/approve', (req, res) => {
    const id = idParam(req.params.id);
    try { approve(id, idParam(req.body?.render_id), req.user); res.json(vxState(id, req.user)); }
    catch (e) { if (e.details) return res.status(422).json({ error: e.message, validation: e.details }); throw e; }
  });
  app.get('/api/visual-edits/:id/package', (req, res) => { const p = latestPackage(idParam(req.params.id)); if (!p) throw new HttpError(404, 'Nothing approved yet'); res.json(p); });
  // For Module 8: the approved enhanced creative of a project's planned video.
  app.get('/api/creative-projects/:id/enhanced-package', (req, res) => {
    const p = approvedEnhancedPackage(idParam(req.params.id), Number(req.query.variation) || 1);
    if (!p) throw new HttpError(404, 'No approved visual enhancement for this video yet');
    res.json(p);
  });
  app.get('/api/visual-renders/:rid/:what', async (req, res) => {
    const r = db.prepare(`SELECT * FROM vx_renders WHERE id = ?`).get(idParam(req.params.rid));
    if (!r) throw new HttpError(404, 'Render not found');
    projectRow(vxRow(r.vx_id).project_id);
    const what = String(req.params.what);
    if (what === 'thumb') { if (!r.thumb_key) throw new HttpError(404, 'No thumbnail'); return storage.serve(res, r.thumb_key, { type: 'image/jpeg', maxAge: 3600 }); }
    if (what === 'ass') { if (!r.ass_key) throw new HttpError(404, 'No overlay script'); return storage.serve(res, r.ass_key, { type: 'text/plain; charset=utf-8', download: `creative-visual-r${r.id}.ass` }); }
    if (what === 'video') { if (!r.storage_key) throw new HttpError(404, 'Not rendered yet'); return storage.serve(res, r.storage_key, { type: 'video/mp4', download: req.query.download ? `creative-visual-${r.vx_id}-r${r.id}-${r.quality}.mp4` : undefined }); }
    throw new HttpError(404, 'Unknown file');
  });

  // ---------- Brand kits ----------
  app.get('/api/brand-kits', (req, res) => res.json({ kits: brandKits() }));
  app.post('/api/brand-kits', (req, res) => res.status(201).json(saveBrandKit(null, req.body || {}, req.user)));
  app.patch('/api/brand-kits/:id', (req, res) => res.json(saveBrandKit(idParam(req.params.id), req.body || {}, req.user)));
  app.delete('/api/brand-kits/:id', async (req, res) => {
    const k = db.prepare(`SELECT * FROM vx_brand_kits WHERE id = ?`).get(idParam(req.params.id));
    if (!k) throw new HttpError(404, 'Brand kit not found');
    if (k.created_by !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only its author or an admin can delete this brand kit');
    db.prepare(`DELETE FROM vx_brand_kits WHERE id = ?`).run(k.id); // its logo file stays in storage: approved creatives may still reference it
    res.json({ deleted: true });
  });
  app.post('/api/brand-kits/:id/logo', async (req, res) => {
    const id = idParam(req.params.id);
    const k = db.prepare(`SELECT * FROM vx_brand_kits WHERE id = ?`).get(id);
    if (!k) throw new HttpError(404, 'Brand kit not found');
    if (k.created_by !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only its author or an admin can change this brand kit');
    mkdirSync(INCOMING, { recursive: true });
    await receive(req, res);
    if (!req.file) throw new HttpError(400, 'Choose a PNG, JPEG or WebP logo');
    const work = join(TMP_DIR, `vx-logo-${id}-${Date.now()}`);
    try {
      const head = [...readFileSync(req.file.path).subarray(0, 12)];
      const type = Object.entries(IMG).find(([t, sig]) => sig.every((b, i) => head[i] === b) && (t !== 'webp' || String.fromCharCode(...head.slice(8, 12)) === 'WEBP'))?.[0];
      if (!type) throw new HttpError(400, 'Only PNG, JPEG or WebP logos (SVG and other files are refused for safety).');
      mkdirSync(work, { recursive: true });
      const info = await probeVideo(req.file.path).catch(() => null);
      const w = info?.video?.width, h = info?.video?.height;
      if (!w || !h || w > 6000 || h > 6000) throw new HttpError(400, 'The logo cannot be read or is too large (max 6000 × 6000 px).');
      // Re-encoded to a clean PNG (no metadata, at most 800 px wide, transparency kept).
      const out = join(work, 'logo.png');
      const r = await run(['-y', '-i', req.file.path, '-frames:v', '1', '-vf', `scale='min(800,iw)':-2:flags=lanczos,format=rgba`, '-map_metadata', '-1', out]);
      if (r.code !== 0 || !existsSync(out)) throw new HttpError(400, 'The logo could not be processed.');
      const key = `brand/k${id}/logo-${Date.now()}.png`;
      await storage.put(key, out, 'image/png');
      db.prepare(`UPDATE vx_brand_kits SET logo_key = ?, logo_ratio = ?, updated_at = datetime('now') WHERE id = ?`).run(key, Math.round((h / w) * 1000) / 1000, id);
      res.json(brandKit(id));
    } finally { rmSync(req.file.path, { force: true }); rmSync(work, { recursive: true, force: true }); }
  });
  app.get('/api/brand-kits/:id/logo', async (req, res) => { const k = brandKit(idParam(req.params.id)); if (!k?.logo_key) throw new HttpError(404, 'No logo'); return storage.serve(res, k.logo_key, { type: 'image/png', maxAge: 3600 }); });

  // ---------- Caption presets and safe zones ----------
  app.get('/api/caption-styles', (req, res) => res.json({ builtin: Object.values(CAPTION_STYLES), custom: [...customStyles().values()] }));
  app.post('/api/caption-styles', (req, res) => res.status(201).json(saveCustomStyle(req.body || {}, req.user)));
  app.delete('/api/caption-styles/:id', (req, res) => { deleteCustomStyle(idParam(req.params.id), req.user); res.json({ deleted: true }); });
  app.get('/api/safe-zones', (req, res) => res.json(safeZones()));
  app.put('/api/safe-zones/:key', (req, res) => res.json(saveSafeZone(String(req.params.key), req.body || {}, req.user)));
}
