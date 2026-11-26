// Module 7 background work (never inside a web request). Jobs live in the database (vx_jobs): one at a time per visual
// enhancement (asking twice returns the same job), a global limit (VX_CONCURRENCY), real progress (stages + ffmpeg's
// clock), cancel (kills ffmpeg), automatic retry of temporary errors, recovery after a restart, temporary folders
// removed after success or failure. Kinds: auto (strategy + plan + preview render), plan (strategy + plan), render.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { aiReady, aiMock } from './ai.js';
import { directVisuals, directorInput } from './vx-director.js';
import { renderEnhanced, visualQc, qualityCheck, sizeFor } from './vx-render.js';
import { cleanup } from './video-render.js';
import { QUALITY } from './video-schemas.js';
import { checkPackage } from './audio-production.js';
import { vxRow, mustEdit, loadInputs, inputProblems, workingVersion, docsOf, saveDocs, setStatus, latestVersion, rebuild, hashOf, planOutdated } from './vx-production.js';

const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const CFG = { concurrency: Math.min(4, num('VX_CONCURRENCY', 1)), maxAttempts: num('VX_MAX_ATTEMPTS', 2), timeout: num('VX_RENDER_TIMEOUT', 1800) };
export const KINDS = ['auto', 'plan', 'render'];
export const PARTS = ['all', 'style', 'hook', 'overlays', 'cta'];
export const RENDER_ENGINE = 'ffmpeg-libass-v1';
class Cancelled extends Error {}

export function enqueue(vxId, kind, user, { target = '', options = {} } = {}) {
  const vx = vxRow(vxId); mustEdit(vx, user);
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown visual job');
  const quality = kind === 'plan' ? '' : String(target || 'preview');
  if (kind !== 'plan' && !QUALITY[quality]) throw new HttpError(400, 'Unknown quality');
  if (options.parts && !(Array.isArray(options.parts) && options.parts.every(p => PARTS.includes(p)))) throw new HttpError(400, 'Unknown part to regenerate');
  const inputs = loadInputs(vx);
  const problems = inputProblems(vx, inputs);
  if (problems.length) throw new HttpError(409, problems[0]);
  const d = docsOf(latestVersion(vxId));
  const needAi = kind !== 'render' && (!d.director || options.parts?.length || options.force);
  if (needAi && !aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  if (kind === 'render') { if (!d.plan) throw new HttpError(400, 'Run Auto Enhance first'); const o = planOutdated(d.plan, inputs); if (o) throw new HttpError(409, o); }
  const open = db.prepare(`SELECT * FROM vx_jobs WHERE vx_id = ? AND status IN ('queued','running')`).get(vxId);
  if (open) { if (open.kind === kind && open.target === quality && open.options === JSON.stringify(options)) return open.id; throw new HttpError(409, 'A visual job is already running for this creative: wait for it or cancel it'); }
  const id = db.prepare(`INSERT INTO vx_jobs (vx_id, kind, target, options, max_attempts, created_by) VALUES (?,?,?,?,?,?)`).run(vxId, kind, quality, JSON.stringify(options), CFG.maxAttempts, user.id).lastInsertRowid;
  if (vx.status !== 'approved') setStatus(vxId, 'queued');
  kick();
  return id;
}
export function retryFailed(vxId, user) {
  const j = db.prepare(`SELECT * FROM vx_jobs WHERE vx_id = ? ORDER BY id DESC LIMIT 1`).get(vxId);
  if (!j || j.status !== 'failed') throw new HttpError(400, 'Nothing failed');
  return enqueue(vxId, j.kind, user, { target: j.target, options: JSON.parse(j.options || '{}') });
}
export function cancel(vxId, user) {
  const vx = vxRow(vxId); mustEdit(vx, user);
  const jobs = db.prepare(`SELECT * FROM vx_jobs WHERE vx_id = ? AND status IN ('queued','running')`).all(vxId);
  for (const j of jobs) {
    if (j.status === 'queued') db.prepare(`UPDATE vx_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`).run(j.id);
    const a = active.get(j.id);
    if (a) { a.cancelled = true; for (const p of a.children) { try { p.kill('SIGKILL'); } catch {} } }
  }
  if (!jobs.some(j => j.status === 'running')) setStatus(vxId, 'cancelled');
  return jobs.length;
}

const active = new Map();
let workers = 0, timer = null;
export function startVisualWorker() {
  try { for (const f of readdirSync(TMP_DIR)) if (f.startsWith('vx-')) rmSync(join(TMP_DIR, f), { recursive: true, force: true }); } catch {}
  if (process.env.VX_WORKER === '0' || process.env.VD_WORKER === '0') return;
  if (!timer) { timer = setInterval(kick, 5000); timer.unref?.(); }
  kick();
}
const kick = () => setImmediate(tick);
function tick() {
  while (workers < CFG.concurrency) {
    const job = db.prepare(`UPDATE vx_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, error = '', failed_stage = ''
      WHERE id = (SELECT j.id FROM vx_jobs j WHERE j.status = 'queued' AND NOT EXISTS (SELECT 1 FROM vx_jobs r WHERE r.status = 'running' AND r.vx_id = j.vx_id) ORDER BY j.id LIMIT 1) RETURNING *`).get();
    if (!job) return;
    workers++;
    runJob(job).finally(() => { workers--; kick(); });
  }
}

// Module 6 render stages are shown as "Rendering" with their real progress inside the rendering band.
const OWN = new Set(['preparing_strategy', 'generating_captions', 'generating_overlays', 'preparing_effects', 'validating_plan', 'rendering', 'quality_checking', 'uploading']);
async function runJob(job) {
  const ctl = { cancelled: false, children: new Set() };
  active.set(job.id, ctl);
  const started = Date.now();
  let current = '', peak = 0;
  const work = join(TMP_DIR, `vx-${job.id}-${Date.now()}`);
  const log = m => db.prepare(`UPDATE vx_jobs SET log = substr(log || ?, -20000) WHERE id = ?`).run(`${new Date().toISOString().slice(11, 19)} ${m}\n`, job.id);
  const check = () => {
    if (ctl.cancelled) throw new Cancelled('Cancelled');
    if ((Date.now() - started) / 1000 > CFG.timeout) throw new HttpError(504, `The job took longer than ${CFG.timeout} s and was stopped.`);
  };
  const stage = (s, p) => {
    check();
    const own = OWN.has(s) ? s : 'rendering';
    current = own; peak = Math.max(peak, process.memoryUsage().rss / 1048576);
    db.prepare(`UPDATE vx_jobs SET stage = ?, progress = ? WHERE id = ?`).run(own, Math.round(p * 1000) / 1000, job.id); setStatus(job.vx_id, own);
  };
  const ctx = { children: ctl.children, check };
  let renderId = null;
  try {
    log(`Start ${job.kind}${job.target ? ` (${job.target})` : ''}, attempt ${job.attempts}`);
    const out = await pipeline(job, { log, stage, check, ctx, work, setRender: id => { renderId = id; db.prepare(`UPDATE vx_jobs SET render_id = ? WHERE id = ?`).run(id, job.id); } });
    check();
    db.prepare(`UPDATE vx_jobs SET status = 'completed', progress = 1, stage = 'done', finished_at = datetime('now') WHERE id = ?`).run(job.id);
    setStatus(job.vx_id, 'ready');
    log(out || 'Done');
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctl.cancelled;
    const transient = !cancelled && (e instanceof HttpError ? [429, 500, 502, 503, 529].includes(e.status) && !/not set up/.test(e.message) : /ECONN|ETIMEDOUT|socket|S3|storage/i.test(e.message));
    const retry = transient && job.attempts < job.max_attempts;
    log(`${cancelled ? 'Cancelled' : retry ? 'Will try again' : 'Failed'}${current ? ` at ${current}` : ''}: ${e.message}`);
    if (!cancelled) console.error(`Visual job ${job.id} (${job.kind}):`, e.message);
    db.prepare(`UPDATE vx_jobs SET status = ?, error = ?, failed_stage = ?, finished_at = CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id = ?`)
      .run(cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled ? '' : String(e.message).slice(0, 500), cancelled ? '' : current, retry ? 1 : 0, job.id);
    if (renderId) db.prepare(`UPDATE vx_renders SET status = ? WHERE id = ? AND status <> 'ready'`).run(cancelled ? 'cancelled' : 'failed', renderId);
    if (job.kind !== 'plan' && !(renderId && db.prepare(`SELECT 1 FROM vx_usage WHERE render_id = ?`).get(renderId))) db.prepare(`INSERT INTO vx_usage (vx_id, render_id, job_id, quality, wall_seconds, peak_rss_mb, ok, error, user_id) VALUES (?,?,?,?,?,?,0,?,?)`)
      .run(job.vx_id, renderId, job.id, job.target, (Date.now() - started) / 1000, peak, cancelled ? 'cancelled' : String(e.message).slice(0, 300), job.created_by);
    setStatus(job.vx_id, cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled || retry ? '' : String(e.message).slice(0, 500));
  } finally { active.delete(job.id); cleanup(work); }
}

async function pipeline(job, { log, stage, check, ctx, work, setRender }) {
  const vx = vxRow(job.vx_id);
  const opts = JSON.parse(job.options || '{}');
  stage('preparing_strategy', 0.02);
  const inputs = loadInputs(vx);
  const problems = inputProblems(vx, inputs);
  if (problems.length) throw new HttpError(409, problems[0]);
  const files = await checkPackage(inputs.pkg);
  if (!files.ok) throw new HttpError(409, `Approved audio is incomplete: ${files.problems.join('; ')}`);
  const v = workingVersion(vx.id, job.created_by);
  let d = docsOf(v);
  if (job.kind !== 'render') {
    // 1. Visual strategy (AI, cached by its inputs; only the asked parts change when regenerating one part).
    const input = directorInput({ pp: inputs.pp, brief: inputs.brief, pkg: inputs.pkg, edl: inputs.edl, scenes: inputs.scenes, intensityPref: d.settings.intensity, stylePref: d.settings.style_id });
    const parts = opts.parts || [];
    const fresh = await directVisuals({ input, ref: `visual:${vx.id}`, userId: job.created_by, force: !!opts.force || (parts.length > 0 && !!d.director) });
    check();
    const { _cached, ...answer } = fresh;
    let dir = answer;
    if (d.director && parts.length && !parts.includes('all')) {
      dir = { ...d.director, warnings: answer.warnings };
      if (parts.includes('style')) Object.assign(dir, { style_id: answer.style_id, style_reason: answer.style_reason, intensity: answer.intensity, intensity_reason: answer.intensity_reason, palette: answer.palette, caption_segmentation: answer.caption_segmentation, caption_position: answer.caption_position, effects: answer.effects, visual_style: answer.visual_style });
      if (parts.includes('hook')) dir.hook = answer.hook;
      if (parts.includes('overlays')) Object.assign(dir, { benefits: answer.benefits, keywords: answer.keywords, price: answer.price, offer: answer.offer });
      if (parts.includes('cta')) dir.cta = answer.cta;
    }
    log(`Visual strategy ${_cached ? '(AI from cache)' : 'made'}: ${dir.style_id}, ${dir.intensity}${parts.length ? ` · regenerated: ${parts.join(', ')}` : ''}`);
    // A regeneration of one part keeps the team's settings; elements the team locked or edited are kept.
    if (parts.includes('hook') && d.plan) d.plan.elements = d.plan.elements.filter(e => e.type !== 'hook' || e.locked);
    if (parts.includes('cta') && d.plan) d.plan.elements = d.plan.elements.filter(e => e.type !== 'cta' || e.locked);
    if (parts.includes('overlays') && d.plan) d.plan.elements = d.plan.elements.filter(e => !['benefit', 'feature', 'price', 'offer'].includes(e.type) || e.locked);
    stage('generating_captions', 0.08);
    stage('generating_overlays', 0.1);
    stage('preparing_effects', 0.12);
    const plan = rebuild(vx, inputs, d, { director: dir });
    stage('validating_plan', 0.14);
    saveDocs(v.id, { director: dir, plan });
    d = docsOf(db.prepare(`SELECT * FROM vx_versions WHERE id = ?`).get(v.id));
    const n = t => plan.elements.filter(e => e.type === t && e.visibility?.enabled !== false).length;
    log(`Visual plan: ${n('caption')} caption groups (${plan.caption.exact_word_timing ? 'real word timing' : 'estimated timing'}), hook ${n('hook')}, overlays ${n('benefit')}, price ${n('price')}, offer ${n('offer')}, CTA ${n('cta')}, effects ${n('effect')} · ${plan.validation.errors.length} blocking, ${plan.validation.warnings.length} warnings`);
    if (job.kind === 'plan') return 'Visual plan ready';
    if (!plan.validation.valid) throw new HttpError(422, `The visual plan has blocking problems: ${plan.validation.errors[0].message}`);
  }
  // 2. Render (second half of "auto", in preview quality unless asked otherwise).
  const ver = db.prepare(`SELECT * FROM vx_versions WHERE id = ?`).get(v.id);
  const plan = JSON.parse(ver.plan);
  const out = planOutdated(plan, inputs);
  if (out) throw new HttpError(409, out);
  if (!plan.validation?.valid) throw new HttpError(422, `Fix the blocking problems first: ${plan.validation?.errors?.[0]?.message || ''}`);
  const quality = job.target || 'preview';
  const { W, H } = sizeFor(inputs.edl, quality);
  const config = { quality, W, H, fps: inputs.edl.timeline.fps, ...QUALITY[quality], engine: RENDER_ENGINE };
  const configHash = hashOf(config), edlHash = inputs.refs.video.edl_hash;
  const same = db.prepare(`SELECT id, version_id, storage_key FROM vx_renders WHERE plan_hash = ? AND edl_hash = ? AND config_hash = ? AND status = 'ready' AND vx_id = ? ORDER BY id DESC LIMIT 1`).get(ver.plan_hash, edlHash, configHash, vx.id);
  if (same && !opts.force_render && (await storage.exists(same.storage_key))) {
    if (same.version_id !== ver.id) db.prepare(`UPDATE vx_renders SET version_id = ? WHERE id = ?`).run(ver.id, same.id);
    setRender(same.id);
    return `Same visual plan and settings as render #${same.id}: reused (nothing rendered again)`;
  }
  const renderId = db.prepare(`INSERT INTO vx_renders (vx_id, version_id, quality, plan_hash, edl_hash, config_hash, config, status, created_by) VALUES (?,?,?,?,?,?,?, 'rendering', ?)`)
    .run(vx.id, ver.id, quality, ver.plan_hash, edlHash, configHash, JSON.stringify(config), job.created_by).lastInsertRowid;
  setRender(renderId);
  const t0 = Date.now();
  stage('rendering', 0.16);
  const res = await renderEnhanced({ plan, edl: inputs.edl, quality, work, ctx, stage: (s, p) => stage(s, 0.16 + p * 0.7), log, scenes: inputs.scenes, projectId: vx.project_id });
  check();
  stage('quality_checking', 0.88);
  const expectAudio = !!(inputs.edl.tracks.voiceover || inputs.edl.tracks.music);
  const qc = await qualityCheck(res.file, inputs.edl, { W, H, fps: inputs.edl.timeline.fps, expectAudio, quality }, ctx);
  const vq = await visualQc(plan, { work, W, H, ctx });
  qc.errors.push(...vq.errors); qc.warnings.push(...vq.warnings); qc.measured.visual = vq.measured; qc.ok = !qc.errors.length;
  check();
  log(`Quality check: ${qc.errors.length} problems, ${qc.warnings.length} warnings · fonts: ${(vq.measured.fonts || []).join('; ')}`);
  stage('uploading', 0.95);
  const base = `visual/p${vx.project_id}/x${vx.id}/r${renderId}-${quality}`;
  await storage.put(`${base}.mp4`, res.file, 'video/mp4');
  if (res.thumb) await storage.put(`${base}.jpg`, res.thumb, 'image/jpeg');
  await storage.put(`${base}.ass`, res.assFile, 'text/plain');
  const p = qc.measured.probe || {};
  const secs = (Date.now() - t0) / 1000;
  db.prepare(`UPDATE vx_renders SET status = ?, storage_key = ?, thumb_key = ?, ass_key = ?, duration = ?, width = ?, height = ?, fps = ?, vcodec = ?, acodec = ?, size = ?, qc = ?, qc_ok = ?, render_seconds = ? WHERE id = ?`)
    .run(qc.ok ? 'ready' : 'failed_qc', `${base}.mp4`, res.thumb ? `${base}.jpg` : '', `${base}.ass`, p.duration || 0, p.video?.width || 0, p.video?.height || 0, p.video?.fps || 0, p.video?.codec || '', p.audio?.codec || '', p.size || 0, JSON.stringify(qc), qc.ok ? 1 : 0, secs, renderId);
  db.prepare(`INSERT INTO vx_usage (vx_id, render_id, job_id, quality, wall_seconds, output_bytes, peak_rss_mb, ok, user_id) VALUES (?,?,?,?,?,?,?,1,?)`)
    .run(vx.id, renderId, job.id, quality, secs, p.size || 0, process.memoryUsage().rss / 1048576, job.created_by);
  if (!qc.ok) throw new HttpError(422, `The enhanced video failed the quality check: ${qc.errors[0].message}`);
  return `Rendered ${quality} ${W}×${H} in ${secs.toFixed(1)} s (${((p.size || 0) / 1048576).toFixed(1)} MB, ${res.cached}/${res.clips} clips reused)`;
}
