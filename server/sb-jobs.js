// Module 4 background work: the one-button run (strategy → hooks → hook choice → script → footage → storyboard → checks)
// and targeted regenerations. Jobs live in the database (sb_jobs): one at a time per plan (asking twice gives the same job),
// cancel, automatic retry of temporary AI errors, and after a restart running jobs go back to the queue.
import { db } from './db.js';
import { HttpError } from './errors.js';
import { aiReady, aiMock } from './ai.js';
import { revalidateBrief } from './creative-brief.js';
import { canEdit, projectRow } from './creative.js';
import { genStrategy, genHooks, genOneHook, genScript, genSegment, genShots } from './sb-director.js';
import { durationCheck } from './sb-duration.js';
import { planRow, setStatus, loadContext, workingVersion, docsOf, saveDocs, buildScript, retimeScript, assembleStoryboard, retimeStoryboard, candidatesFor, revalidate } from './sb-plan.js';

const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v >= 0 ? v : d; };
const CFG = { concurrency: Math.min(3, num('SB_CONCURRENCY', 1)) || 1, maxAttempts: num('SB_MAX_ATTEMPTS', 2) || 1, durationFixes: num('SB_MAX_DURATION_FIXES', 2) };
export const KINDS = ['full', 'strategy', 'hooks', 'hook', 'script', 'segment', 'match', 'shot', 'storyboard'];
const STAGE_STATUS = { strategy: 'generating_strategy', hooks: 'generating_hooks', script: 'generating_script', match: 'matching_footage', storyboard: 'generating_storyboard', validate: 'validating' };
class Cancelled extends Error {}

export function enqueue(planId, kind, user, { target = '', options = {} } = {}) {
  const plan = planRow(planId);
  if (!canEdit(projectRow(plan.project_id), user)) throw new HttpError(403, 'Only the author of this project or an admin can generate its script');
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown generation');
  if (!aiReady() && !aiMock() && !['match', 'shot'].includes(kind)) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  const open = db.prepare(`SELECT * FROM sb_jobs WHERE plan_id = ? AND status IN ('queued','running')`).get(planId);
  if (open) { if (open.kind === kind && open.target === String(target)) return open.id; throw new HttpError(409, 'Generation is already running for this video: wait for it or cancel it'); }
  const { b } = loadContext(plan);
  const chk = revalidateBrief(b.brief);
  if (!chk.ok) throw new HttpError(400, 'The Creative Brief cannot be used: ' + chk.problems.join(' '));
  const id = db.prepare(`INSERT INTO sb_jobs (plan_id, kind, target, options, max_attempts, created_by) VALUES (?,?,?,?,?,?)`).run(planId, kind, String(target), JSON.stringify(options), CFG.maxAttempts, user.id).lastInsertRowid;
  kick();
  return id;
}
export function cancel(planId, user) {
  const plan = planRow(planId);
  if (!canEdit(projectRow(plan.project_id), user)) throw new HttpError(403, 'Not allowed');
  const jobs = db.prepare(`SELECT * FROM sb_jobs WHERE plan_id = ? AND status IN ('queued','running')`).all(planId);
  for (const j of jobs) {
    if (j.status === 'queued') db.prepare(`UPDATE sb_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`).run(j.id);
    const a = active.get(j.id); if (a) a.cancelled = true;
  }
  if (!jobs.some(j => j.status === 'running')) setStatus(planId, db.prepare(`SELECT 1 FROM sb_versions WHERE plan_id = ?`).get(planId) ? 'ready' : 'draft');
  return jobs.length;
}

const active = new Map();
let workers = 0, timer = null;
export function startSbWorker() { if (!timer) { timer = setInterval(kick, 5000); timer.unref?.(); } kick(); }
const kick = () => setImmediate(tick);
function tick() {
  while (workers < CFG.concurrency) {
    const job = db.prepare(`UPDATE sb_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, error = ''
      WHERE id = (SELECT j.id FROM sb_jobs j WHERE j.status = 'queued' AND NOT EXISTS (SELECT 1 FROM sb_jobs r WHERE r.status = 'running' AND r.plan_id = j.plan_id) ORDER BY j.id LIMIT 1) RETURNING *`).get();
    if (!job) return;
    workers++;
    run(job).finally(() => { workers--; kick(); });
  }
}

async function run(job) {
  const ctl = { cancelled: false };
  active.set(job.id, ctl);
  const log = m => db.prepare(`UPDATE sb_jobs SET log = substr(log || ?, -20000) WHERE id = ?`).run(`${new Date().toISOString().slice(11, 19)} ${m}\n`, job.id);
  const stage = (s, p) => { db.prepare(`UPDATE sb_jobs SET stage = ?, progress = ? WHERE id = ?`).run(s, p, job.id); setStatus(job.plan_id, STAGE_STATUS[s] || 'validating'); };
  const check = () => { if (ctl.cancelled) throw new Cancelled('Cancelled'); };
  try {
    log(`Start ${job.kind}${job.target ? ` (${job.target})` : ''}, attempt ${job.attempts}`);
    await pipeline(job, { log, stage, check });
    check();
    stage('validate', 0.97);
    const val = revalidate(job.plan_id);
    db.prepare(`UPDATE sb_jobs SET status = 'completed', progress = 1, stage = 'done', finished_at = datetime('now') WHERE id = ?`).run(job.id);
    setStatus(job.plan_id, 'ready');
    log(`Done: ${val?.errors.length || 0} blocking, ${val?.warnings.length || 0} warnings`);
  } catch (e) {
    const cancelled = e instanceof Cancelled;
    const transient = !cancelled && (e instanceof HttpError ? [429, 500, 502, 503, 529].includes(e.status) && !/not set up|cannot be used/.test(e.message) : !(e instanceof HttpError));
    const retry = transient && job.attempts < job.max_attempts;
    log(`${cancelled ? 'Cancelled' : retry ? 'Will try again' : 'Failed'}: ${e.message}`);
    if (!cancelled) console.error(`Script job ${job.id} (${job.kind}):`, e.message);
    db.prepare(`UPDATE sb_jobs SET status = ?, error = ?, finished_at = CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id = ?`).run(cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled ? '' : String(e.message).slice(0, 500), retry ? 1 : 0, job.id);
    setStatus(job.plan_id, cancelled ? 'ready' : retry ? STAGE_STATUS.strategy : 'failed', cancelled || retry ? '' : String(e.message).slice(0, 500));
    if (cancelled) revalidate(job.plan_id);
  } finally { active.delete(job.id); }
}

// ---------- The steps ----------
async function pipeline(job, { log, stage, check }) {
  const plan = planRow(job.plan_id);
  const { ctx, scenes, byId } = loadContext(plan);
  if (!scenes.length) throw new HttpError(400, 'No usable footage: the brief\'s scenes are no longer production-ready.');
  const opts = { planId: plan.id, productId: ctx.brief.product_id, userId: job.created_by, force: job.kind !== 'full' || JSON.parse(job.options || '{}').force };
  const v = workingVersion(plan.id, job.created_by);
  let d = docsOf(v);
  const save = docs => { saveDocs(v.id, docs); d = { ...d, ...docs }; };
  const kind = job.kind, full = kind === 'full';

  if (full || kind === 'strategy') {
    stage('strategy', 0.05);
    const s = await genStrategy(ctx, scenes, opts); check();
    const { _cached, ...rest } = s;
    save({ strategy: { ...rest, source: 'ai', rev: (d.strategy?.rev || 0) + 1 } });
    log(`Strategy ${_cached ? '(from cache)' : 'written'}: ${rest.main_message}`);
    if (!full) return;
  }
  if (!d.strategy) throw new HttpError(400, 'Generate the creative strategy first');

  if (full || kind === 'hooks') {
    stage('hooks', 0.2);
    const r = await genHooks(ctx, scenes, d.strategy, opts); check();
    const locked = (d.hooks?.items || []).filter(h => h.locked);
    const items = [...locked, ...r.hooks.slice(0, 5 - locked.length).map((h, i) => ({ id: `h${(d.hooks?.items.length || 0) + i + 1}`, ...h, source: 'ai', locked: false }))]
      .map((h, i, all) => ({ ...h, id: all.findIndex(x => x.id === h.id) === i ? h.id : `h${i + 100}` }));
    const auto = d.hooks ? d.hooks.auto : true;
    const rec = items.find(h => h.text === r.hooks[r.recommended]?.text) || items[0];
    const keepSel = !auto && items.some(h => h.id === d.hooks?.selected) ? d.hooks.selected : rec.id;
    save({ hooks: { items, selected: keepSel, auto } });
    log(`${items.length} hooks, selected: "${items.find(h => h.id === keepSel).text}"`);
    if (!full) return;
  }
  if (kind === 'hook') {
    stage('hooks', 0.3);
    const h = d.hooks?.items.find(x => x.id === job.target);
    if (!h) throw new HttpError(404, 'Hook not found');
    if (h.locked) throw new HttpError(409, 'This hook is locked: unlock it first');
    const n = await genOneHook(ctx, scenes, d.strategy, d.hooks.items.filter(x => x.id !== h.id), h.style, opts); check();
    const items = d.hooks.items.map(x => (x.id === h.id ? { ...n, id: h.id, source: 'ai', locked: false } : x));
    save({ hooks: { ...d.hooks, items } });
    if (d.hooks.selected === h.id && d.script) {
      const hs = d.script.segments.find(s => s.role === 'hook' && !s.locked);
      if (hs) { hs.text = n.text; if (ctx.production.text_overlays) hs.on_screen_text = n.on_screen_text; const sc = retimeScript(ctx, d.script); save({ script: sc }); if (d.storyboard) save({ storyboard: retimeStoryboard(ctx, sc, d.storyboard, byId) }); }
    }
    return;
  }
  const hook = d.hooks?.items.find(h => h.id === d.hooks.selected) || null;

  if (full || kind === 'script') {
    stage('script', 0.4);
    const locked = (d.script?.segments || []).filter(s => s.locked).map(s => ({ id: s.id, role: s.role, text: s.text }));
    let raw = await genScript(ctx, scenes, d.strategy, hook, locked, opts); check();
    let script = buildScript(ctx, raw.segments, { hookId: hook?.id || null, prev: d.script });
    for (let i = 0; i < CFG.durationFixes; i++) {
      const dc = durationCheck(script.est_seconds, ctx.duration);
      if (dc.ok) break;
      log(`Script ${script.est_seconds} s for ${ctx.duration} s: ${dc.tooLong ? 'shortening' : 'expanding'}`);
      raw = await genScript(ctx, scenes, d.strategy, hook, locked, opts, { seconds: script.est_seconds, tooLong: dc.tooLong, tooShort: dc.tooShort }); check();
      script = buildScript(ctx, raw.segments, { hookId: hook?.id || null, prev: d.script });
    }
    save({ script });
    log(`Script: ${script.segments.length} segments, ${script.words} words, ~${script.est_seconds} s (target ${ctx.duration} s)`);
  }
  if (kind === 'segment') {
    stage('script', 0.4);
    const seg = d.script?.segments.find(s => s.id === job.target);
    if (!seg) throw new HttpError(404, 'Segment not found');
    if (seg.locked) throw new HttpError(409, 'This segment is locked: unlock it first');
    const n = await genSegment(ctx, scenes, d.strategy, d.script, seg, JSON.parse(job.options || '{}').instruction || '', opts); check();
    const segs = d.script.segments.map(s => (s.id === seg.id ? { ...s, ...n, id: seg.id, role: seg.role, keep: undefined, source: 'ai' } : s)).map(({ keep, ...s }) => s);
    const script = retimeScript(ctx, { ...d.script, segments: segs });
    save({ script });
    // Only this segment's shots are matched again (unless locked); the others are kept and retimed.
    if (d.storyboard) {
      const cands = candidatesFor(ctx, plan, { segments: script.segments.filter(s => s.id === seg.id) }, scenes, new Set(d.storyboard.shots.filter(s => s.segment_id !== seg.id).map(s => s.scene_id)));
      const keep = d.storyboard.shots.filter(s => s.segment_id !== seg.id || s.locked).map(s => ({ ...s, locked: true, trimmed: s.source === 'user', _was: s.locked }));
      const board = assembleStoryboard(ctx, script, {}, cands, byId, { prev: { shots: keep } });
      board.shots = board.shots.map(s => ({ ...s, locked: !!keep.find(k => k.id === s.id)?._was }));
      save({ storyboard: board });
    }
    return;
  }
  if (kind === 'match' || kind === 'shot') {
    stage('match', 0.6);
    if (!d.storyboard) throw new HttpError(400, 'Generate the storyboard first');
    const shot = kind === 'shot' ? d.storyboard.shots.find(s => s.id === job.target) : null;
    const segId = shot ? shot.segment_id : job.target;
    const seg = d.script.segments.find(s => s.id === segId);
    if (!seg) throw new HttpError(404, 'Segment not found');
    if (shot?.locked) throw new HttpError(409, 'This shot is locked: unlock it first');
    const usedOther = new Set(d.storyboard.shots.filter(s => (shot ? s.id !== shot.id : s.segment_id !== segId)).map(s => s.scene_id));
    const cands = candidatesFor(ctx, plan, { segments: [seg] }, scenes, usedOther)[segId].filter(c => c.semantic >= 25 && (!shot || c.scene.id !== shot.scene_id));
    if (!cands.length) throw new HttpError(400, 'No other scene matches this segment: upload footage or rewrite the segment');
    let shots;
    if (shot) shots = d.storyboard.shots.map(s => (s.id === shot.id ? { ...s, scene_id: cands[0].scene.id, asset_id: cands[0].scene.asset_id, source_key: cands[0].scene.proxy_key || '', source_start: cands[0].scene.start, source_end: cands[0].scene.end, source: 'ai', reason: `Next best match (${cands[0].score}/100): ${cands[0].scene.semantic || ''}`, confidence: cands[0].score, locked: true, _new: true } : { ...s, locked: true, _was: s.locked }));
    else {
      const n = Math.max(1, d.storyboard.shots.filter(s => s.segment_id === segId).length);
      const rest = d.storyboard.shots.filter(s => s.segment_id !== segId || s.locked).map(s => ({ ...s, locked: true, _was: s.locked }));
      const fresh = cands.slice(0, n).map(c => ({ id: null, segment_id: segId, scene_id: c.scene.id, source_start: c.scene.start, source_end: c.scene.end, reason: `Matched again (${c.score}/100): ${c.scene.semantic || ''}`, confidence: c.score, locked: true, _new: true }));
      shots = [];
      for (const s of d.script.segments) shots.push(...(s.id === segId && !rest.some(r => r.segment_id === segId) ? fresh : rest.filter(r => r.segment_id === s.id)));
      shots.forEach((s, i) => { if (!s.id) s.id = `k${900 + i}`; });
    }
    const board = assembleStoryboard(ctx, d.script, {}, {}, byId, { prev: { shots } });
    board.shots = board.shots.map(s => { const o = shots.find(x => x.id === s.id); return { ...s, locked: o?._new ? false : !!o?._was, reason: o?.reason || s.reason, confidence: o?.confidence ?? s.confidence }; });
    save({ storyboard: board });
    log(shot ? `Shot ${shot.id}: scene ${shot.scene_id} → ${cands[0].scene.id}` : `Segment ${segId} matched again`);
    return;
  }
  if (full || kind === 'script' || kind === 'storyboard') {
    stage('match', 0.65);
    if (!d.script) throw new HttpError(400, 'Generate the script first');
    const cands = candidatesFor(ctx, plan, d.script, scenes);
    stage('storyboard', 0.8);
    const picksRaw = await genShots(ctx, d.script.segments, cands, opts); check();
    const picks = {};
    for (const p of picksRaw) {
      const valid = (p.shots || []).filter(x => (cands[p.segment_id] || []).some(c => c.scene.id === x.scene_id));
      const invalid = (p.shots || []).length - valid.length;
      if (invalid) log(`Ignored ${invalid} scene id(s) the AI gave outside the candidates of ${p.segment_id}`);
      if (valid.length || p.missing) picks[p.segment_id] = valid;
      if (p.missing) picks[`${p.segment_id}:missing`] = p.missing;
    }
    const board = assembleStoryboard(ctx, d.script, picks, cands, byId, { prev: d.storyboard });
    save({ storyboard: board });
    log(`Storyboard: ${board.shots.length} shots, ${board.total_seconds} s${board.missing.length ? `, ${board.missing.length} segment(s) without footage` : ''}`);
  }
}
