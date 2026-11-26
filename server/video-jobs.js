// Module 6 background work (rendering never runs inside a web request). Jobs live in the database (vd_jobs): one at
// a time per video edit (asking twice returns the same job), a global limit of renders at once, real progress from
// the stages and ffmpeg's own clock, cancel (kills ffmpeg), automatic retry of temporary errors, retry of a failed
// job, a time limit, isolated temporary folders cleaned after success or failure, and recovery after a restart.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { aiReady, aiMock } from './ai.js';
import { directEdit } from './video-director.js';
import { buildEdl } from './video-edl.js';
import { renderEdl, qualityCheck, cleanup } from './video-render.js';
import { QUALITY, LIMITS, outputSize } from './video-schemas.js';
import { editRow, mustEdit, loadInputs, inputProblems, workingVersion, docsOf, saveDocs, validateVersion, setStatus, latestVersion, hashOf } from './video-production.js';

const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const CFG = { concurrency: Math.min(4, num('VD_CONCURRENCY', 1)), maxAttempts: num('VD_MAX_ATTEMPTS', 2) };
export const KINDS = ['full', 'plan', 'render'];
class Cancelled extends Error {}

export function enqueue(editId, kind, user, { target = '', options = {} } = {}) {
  const edit = editRow(editId); mustEdit(edit, user);
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown video job');
  const quality = kind === 'plan' ? '' : String(target || 'preview');
  if (kind !== 'plan' && !QUALITY[quality]) throw new HttpError(400, 'Unknown quality');
  if (['full', 'plan'].includes(kind) && !aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  const problems = inputProblems(edit, loadInputs(edit));
  if (problems.length) throw new HttpError(409, problems[0]);
  if (kind === 'render' && !latestVersion(editId)?.edl) throw new HttpError(400, 'Generate the editing plan first');
  const open = db.prepare(`SELECT * FROM vd_jobs WHERE edit_id = ? AND status IN ('queued','running')`).get(editId);
  if (open) { if (open.kind === kind && open.target === quality) return open.id; throw new HttpError(409, 'A video job is already running for this edit: wait for it or cancel it'); }
  const id = db.prepare(`INSERT INTO vd_jobs (edit_id, kind, target, options, max_attempts, created_by) VALUES (?,?,?,?,?,?)`).run(editId, kind, quality, JSON.stringify(options), CFG.maxAttempts, user.id).lastInsertRowid;
  if (edit.status !== 'approved') setStatus(editId, 'queued');
  kick();
  return id;
}
export function retryFailed(editId, user) {
  const j = db.prepare(`SELECT * FROM vd_jobs WHERE edit_id = ? ORDER BY id DESC LIMIT 1`).get(editId);
  if (!j || j.status !== 'failed') throw new HttpError(400, 'Nothing failed');
  // A failed render starts again: prepared clips are kept in the cache, so the work already done is not repeated.
  return enqueue(editId, j.kind, user, { target: j.target, options: { ...JSON.parse(j.options || '{}'), retry_of: j.id } });
}
export function cancel(editId, user) {
  const e = editRow(editId); mustEdit(e, user);
  const jobs = db.prepare(`SELECT * FROM vd_jobs WHERE edit_id = ? AND status IN ('queued','running')`).all(editId);
  for (const j of jobs) {
    if (j.status === 'queued') db.prepare(`UPDATE vd_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`).run(j.id);
    const a = active.get(j.id);
    if (a) { a.cancelled = true; for (const p of a.children) { try { p.kill('SIGKILL'); } catch {} } }
  }
  if (!jobs.some(j => j.status === 'running')) setStatus(editId, 'cancelled');
  return jobs.length;
}

const active = new Map();
let workers = 0, timer = null;
export function startVideoWorker() {
  // Temporary folders left by a crash are removed at start (finished work is in storage).
  try { for (const f of readdirSync(TMP_DIR)) if (f.startsWith('vd-')) rmSync(join(TMP_DIR, f), { recursive: true, force: true }); } catch {}
  if (process.env.VD_WORKER === '0') return; // a web-only instance (a separate worker service renders)
  if (!timer) { timer = setInterval(kick, 5000); timer.unref?.(); }
  kick();
}
const kick = () => setImmediate(tick);
function tick() {
  while (workers < CFG.concurrency) {
    const job = db.prepare(`UPDATE vd_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, error = '', failed_stage = ''
      WHERE id = (SELECT j.id FROM vd_jobs j WHERE j.status = 'queued' AND NOT EXISTS (SELECT 1 FROM vd_jobs r WHERE r.status = 'running' AND r.edit_id = j.edit_id) ORDER BY j.id LIMIT 1) RETURNING *`).get();
    if (!job) return;
    workers++;
    run(job).finally(() => { workers--; kick(); });
  }
}

async function run(job) {
  const ctl = { cancelled: false, children: new Set() };
  active.set(job.id, ctl);
  const started = Date.now();
  let current = '', peak = 0;
  const work = join(TMP_DIR, `vd-${job.id}-${Date.now()}`);
  const log = m => db.prepare(`UPDATE vd_jobs SET log = substr(log || ?, -20000) WHERE id = ?`).run(`${new Date().toISOString().slice(11, 19)} ${m}\n`, job.id);
  const stage = (s, p) => {
    check?.();
    current = s; peak = Math.max(peak, process.memoryUsage().rss / 1048576);
    db.prepare(`UPDATE vd_jobs SET stage = ?, progress = ? WHERE id = ?`).run(s, Math.round(p * 1000) / 1000, job.id); setStatus(job.edit_id, s);
  };
  const check = () => {
    if (ctl.cancelled) throw new Cancelled('Cancelled');
    if ((Date.now() - started) / 1000 > LIMITS.renderTimeout) throw new HttpError(504, `The job took longer than ${LIMITS.renderTimeout} s and was stopped.`);
  };
  const ctx = { children: ctl.children, check };
  let renderId = null;
  try {
    log(`Start ${job.kind}${job.target ? ` (${job.target})` : ''}, attempt ${job.attempts}`);
    const out = await pipeline(job, { log, stage, check, ctx, work, setRender: id => { renderId = id; db.prepare(`UPDATE vd_jobs SET render_id = ? WHERE id = ?`).run(id, job.id); } });
    check();
    db.prepare(`UPDATE vd_jobs SET status = 'completed', progress = 1, stage = 'done', finished_at = datetime('now') WHERE id = ?`).run(job.id);
    setStatus(job.edit_id, 'ready');
    log(out || 'Done');
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctl.cancelled;
    const transient = !cancelled && (e instanceof HttpError ? [429, 500, 502, 503, 529].includes(e.status) && !/not set up/.test(e.message) : /ECONN|ETIMEDOUT|socket|S3|storage/i.test(e.message));
    const retry = transient && job.attempts < job.max_attempts;
    log(`${cancelled ? 'Cancelled' : retry ? 'Will try again' : 'Failed'}${current ? ` at ${current}` : ''}: ${e.message}`);
    if (!cancelled) console.error(`Video job ${job.id} (${job.kind}):`, e.message);
    db.prepare(`UPDATE vd_jobs SET status = ?, error = ?, failed_stage = ?, finished_at = CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id = ?`)
      .run(cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled ? '' : String(e.message).slice(0, 500), cancelled ? '' : current, retry ? 1 : 0, job.id);
    if (renderId) db.prepare(`UPDATE vd_renders SET status = ? WHERE id = ? AND status <> 'ready'`).run(cancelled ? 'cancelled' : 'failed', renderId);
    if ((renderId || job.kind !== 'plan') && !(renderId && db.prepare(`SELECT 1 FROM vd_usage WHERE render_id = ?`).get(renderId))) db.prepare(`INSERT INTO vd_usage (edit_id, render_id, job_id, quality, wall_seconds, peak_rss_mb, ok, error, user_id) VALUES (?,?,?,?,?,?,0,?,?)`)
      .run(job.edit_id, renderId, job.id, job.target, (Date.now() - started) / 1000, peak, cancelled ? 'cancelled' : String(e.message).slice(0, 300), job.created_by);
    setStatus(job.edit_id, cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled || retry ? '' : String(e.message).slice(0, 500));
  } finally { active.delete(job.id); cleanup(work); }
}

async function pipeline(job, { log, stage, check, ctx, work, setRender }) {
  const edit = editRow(job.edit_id);
  const opts = JSON.parse(job.options || '{}');
  stage('validating_inputs', 0.02);
  const inputs = loadInputs(edit);
  const problems = inputProblems(edit, inputs);
  if (problems.length) throw new HttpError(409, problems[0]);
  const files = await (await import('./audio-production.js')).checkPackage(inputs.pkg);
  if (!files.ok) throw new HttpError(409, `Approved audio is incomplete: ${files.problems.join('; ')}`);
  const v = workingVersion(edit.id, job.created_by);
  let d = docsOf(v);
  if (job.kind === 'full' || job.kind === 'plan') {
    stage('preparing_plan', 0.06);
    const director = await directEdit({ pp: { ...inputs.pp, editing_pace: d.settings.pace || inputs.pp.editing_pace }, pkg: inputs.pkg, scenes: inputs.scenes, usable: [...inputs.usable], edit, userId: job.created_by, force: !!opts.force });
    check();
    const { _cached, ...dir } = director;
    if (d.settings.framing) dir.shots = dir.shots.map(s => ({ ...s, framing: d.settings.framing === 'manual' ? s.framing : d.settings.framing }));
    stage('resolving_footage', 0.12);
    const edl = buildEdl({ edit, pkg: inputs.pkg, pp: inputs.pp, scenes: inputs.scenes, usable: inputs.usable, director: dir, prev: d.edl, settings: { ...(d.edl?.audio || {}), selection: d.settings.selection } });
    const val = validateVersion(edit, edl, inputs);
    saveDocs(v.id, { director: dir, edl, validation: val });
    d = docsOf(db.prepare(`SELECT * FROM vd_versions WHERE id = ?`).get(v.id));
    log(`Editing plan ${_cached ? '(AI from cache)' : 'made'}: ${edl.tracks.video.length} clips, ${edl.selection.changes.length} storyboard scene(s) improved, ${edl.timeline.pace} pace, ${edl.timeline.duration} s · ${val.errors.length} blocking, ${val.warnings.length} warnings`);
    if (job.kind === 'plan') return 'Editing plan ready';
    if (!val.valid) throw new HttpError(422, `The editing plan has blocking problems: ${val.errors[0].message}`);
  }
  // Render (also the second half of "full", in preview quality unless asked otherwise).
  const ver = db.prepare(`SELECT * FROM vd_versions WHERE id = ?`).get(v.id);
  const edl = JSON.parse(ver.edl);
  const val = validateVersion(edit, edl, inputs);
  if (!val.valid) throw new HttpError(422, `Fix the blocking problems first: ${val.errors[0].message}`);
  const quality = job.target || 'preview';
  const [W, H] = outputSize(edl.timeline.aspect_ratio, quality);
  const config = { quality, W, H, fps: edl.timeline.fps, ...QUALITY[quality], engine: 'ffmpeg-h264-aac-v1' };
  const configHash = hashOf(config);
  // Same timeline + same settings = the same video: reused, never rendered twice.
  const same = db.prepare(`SELECT id FROM vd_renders WHERE edl_hash = ? AND config_hash = ? AND status = 'ready' AND edit_id = ? ORDER BY id DESC LIMIT 1`).get(ver.edl_hash, configHash, edit.id);
  if (same && !opts.force_render && (await storage.exists(db.prepare(`SELECT storage_key FROM vd_renders WHERE id = ?`).get(same.id).storage_key))) {
    if (db.prepare(`SELECT version_id FROM vd_renders WHERE id = ?`).get(same.id).version_id !== ver.id) db.prepare(`UPDATE vd_renders SET version_id = ? WHERE id = ?`).run(ver.id, same.id);
    setRender(same.id);
    return `Same timeline and settings as render #${same.id}: reused (nothing rendered again)`;
  }
  const renderId = db.prepare(`INSERT INTO vd_renders (edit_id, version_id, quality, edl_hash, config_hash, config, status, created_by) VALUES (?,?,?,?,?,?, 'rendering', ?)`)
    .run(edit.id, ver.id, quality, ver.edl_hash, configHash, JSON.stringify(config), job.created_by).lastInsertRowid;
  setRender(renderId);
  const t0 = Date.now();
  const res = await renderEdl({ edl, quality, work, ctx, stage, log, scenesById: inputs.scenes, projectId: edit.project_id });
  check();
  stage('quality_checking', 0.9);
  const expectAudio = !!(edl.tracks.voiceover || edl.tracks.music);
  const qc = await qualityCheck(res.file, edl, { W, H, fps: edl.timeline.fps, expectAudio, quality }, ctx);
  check();
  log(`Quality check: ${qc.errors.length} problems, ${qc.warnings.length} warnings`);
  stage('uploading', 0.95);
  const base = `video/p${edit.project_id}/e${edit.id}/r${renderId}-${quality}`;
  await storage.put(`${base}.mp4`, res.file, 'video/mp4');
  if (res.thumb) await storage.put(`${base}.jpg`, res.thumb, 'image/jpeg');
  const p = qc.measured.probe || {};
  const secs = (Date.now() - t0) / 1000;
  db.prepare(`UPDATE vd_renders SET status = ?, storage_key = ?, thumb_key = ?, duration = ?, width = ?, height = ?, fps = ?, vcodec = ?, acodec = ?, size = ?, qc = ?, qc_ok = ?, render_seconds = ? WHERE id = ?`)
    .run(qc.ok ? 'ready' : 'failed_qc', `${base}.mp4`, res.thumb ? `${base}.jpg` : '', p.duration || 0, p.video?.width || 0, p.video?.height || 0, p.video?.fps || 0, p.video?.codec || '', p.audio?.codec || '', p.size || 0, JSON.stringify(qc), qc.ok ? 1 : 0, secs, renderId);
  db.prepare(`INSERT INTO vd_usage (edit_id, render_id, job_id, quality, clips, clips_cached, wall_seconds, output_bytes, temp_bytes, peak_rss_mb, ok, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(edit.id, renderId, job.id, quality, res.clips, res.cached, secs, p.size || 0, res.tempBytes, Math.max(process.memoryUsage().rss / 1048576), job.created_by);
  if (!qc.ok) throw new HttpError(422, `The rendered video failed the quality check: ${qc.errors[0].message}`);
  return `Rendered ${quality} ${W}×${H} in ${secs.toFixed(1)} s (${(p.size / 1048576).toFixed(1)} MB, ${res.cached}/${res.clips} clips reused)`;
}
