// Video edits: one per approved Audio Production Package (Module 5). Inputs and version checks, EDL versions, team
// edits on the timeline, renders, approval and the package handed to Module 7 (EDL + render + caption timing + safe area).
import { createHash } from 'node:crypto';
import { db, tx } from './db.js';
import { HttpError } from './errors.js';
import { storage } from './storage.js';
import { canEdit, projectRow, eligibleScenes } from './creative.js';
import { sceneRows } from './footage-services.js';
import { productionRow as auProduction, productionPlanOf, isOutdated as sbOutdated, checkPackage } from './audio-production.js';
import { voiceoverRow } from './audio-voice.js';
import { validateEdl, relayout, edlHash } from './video-edl.js';
import { FRAMINGS, MOTIONS, TRANSITIONS, LIMITS, SPEED_RANGE, QUALITY, outputSize, STATUSES, EDL_VERSION, PACE } from './video-schemas.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const r3 = x => Math.round(x * 1000) / 1000;
export const PACKAGE_VERSION = '1.0';

// ---------- Edits ----------
export const editRow = id => { const e = db.prepare(`SELECT * FROM vd_edits WHERE id = ?`).get(id); if (!e) throw new HttpError(404, 'Video edit not found'); return e; };
export const mustEdit = (e, user) => { if (!canEdit(projectRow(e.project_id), user)) throw new HttpError(403, 'Only the author of this project or an admin can edit its video'); };
export const setStatus = (id, status, error = '') => db.prepare(`UPDATE vd_edits SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`).run(status, error, id);

// Planned videos of a project whose audio is approved, newest audio approval first, with their video edit if any.
export function readyVideos(projectId) {
  return db.prepare(`SELECT a.id AS au_approval_id, a.approved_at, p.id AS au_production_id, p.variation_index, p.sb_version_id, v.number AS audio_version,
      (SELECT number FROM sb_versions WHERE id = p.sb_version_id) AS script_version, (SELECT e.id FROM vd_edits e WHERE e.au_approval_id = a.id) AS edit_id,
      (a.id = (SELECT MAX(a2.id) FROM au_approvals a2 JOIN au_productions p2 ON p2.id = a2.production_id WHERE p2.project_id = p.project_id AND p2.variation_index = p.variation_index)) AS latest
    FROM au_approvals a JOIN au_productions p ON p.id = a.production_id JOIN au_versions v ON v.id = a.version_id WHERE p.project_id = ? ORDER BY p.variation_index, a.id DESC`).all(projectId)
    .map(r => ({ ...r, latest: !!r.latest }));
}
export function getOrCreateEdit(projectId, auApprovalId, user) {
  const pr = projectRow(projectId);
  if (!canEdit(pr, user)) throw new HttpError(403, 'Only the author of this project or an admin can edit its video');
  const a = db.prepare(`SELECT a.*, p.project_id, p.variation_index, p.sb_plan_id, p.sb_version_id, p.brief_id FROM au_approvals a JOIN au_productions p ON p.id = a.production_id WHERE a.id = ?`).get(auApprovalId);
  if (!a || a.project_id !== projectId) throw new HttpError(404, 'Approved audio not found for this project');
  const ex = db.prepare(`SELECT * FROM vd_edits WHERE au_approval_id = ?`).get(a.id);
  if (ex) return ex;
  const id = db.prepare(`INSERT INTO vd_edits (project_id, product_id, variation_index, brief_id, sb_plan_id, sb_version_id, au_production_id, au_approval_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(projectId, pr.product_id, a.variation_index, a.brief_id, a.sb_plan_id, a.sb_version_id, a.production_id, a.id, user.id).lastInsertRowid;
  return editRow(id);
}

// Everything the edit needs, from the approved data of Modules 2-5; nothing is typed again.
export function loadInputs(edit) {
  const a = db.prepare(`SELECT * FROM au_approvals WHERE id = ?`).get(edit.au_approval_id);
  if (!a) throw new HttpError(409, 'The approved audio of this video was deleted.');
  const pkg = JSON.parse(a.package);
  const prod = auProduction(edit.au_production_id);
  const pp = productionPlanOf(prod);
  const brief = parse(db.prepare(`SELECT brief FROM creative_briefs WHERE id = ?`).get(edit.brief_id)?.brief, null);
  const allowed = new Set(brief?.footage?.scene_ids || []);
  const eligible = eligibleScenes(edit.product_id).filter(s => !allowed.size || allowed.has(s.id));
  const usable = new Set(eligible.map(s => s.id));
  const ids = [...new Set([...usable, ...pkg.synchronized_storyboard.shots.map(s => s.scene_id)])];
  const scenes = new Map(ids.length ? sceneRows(`s.id IN (${ids.map(() => '?').join(',')})`, ids).map(s => [s.id, s]) : []);
  return { pkg, pp, prod, brief, scenes, usable, approval: a };
}
// Version compatibility: stale or incompatible inputs never reach the renderer.
export function inputProblems(edit, inputs) {
  const p = [];
  const { prod, pkg } = inputs;
  if (sbOutdated(prod)) p.push('The script & storyboard were changed and approved again after this audio: make and approve the new audio (step 8), then edit its video.');
  if (prod.approved_version_id !== pkg.audio_version.id) p.push('The audio of this video was changed and approved again: open the newest approved audio.');
  if (pkg.script_version.id !== edit.sb_version_id) p.push('The audio package belongs to another script version.');
  if (pkg.schema_version !== '1.0') p.push(`Unsupported audio package version ${pkg.schema_version}.`);
  return p;
}
export const isOutdated = edit => { try { return inputProblems(edit, loadInputs(edit)).length > 0; } catch { return true; } };

// ---------- Versions ----------
export const latestVersion = id => db.prepare(`SELECT * FROM vd_versions WHERE edit_id = ? ORDER BY number DESC LIMIT 1`).get(id);
export const docsOf = v => (v ? { director: parse(v.director, null), edl: parse(v.edl, null), settings: parse(v.settings, {}), validation: parse(v.validation, null) } : {});
function newVersion(editId, from, { label = '', userId = null } = {}) {
  const n = (db.prepare(`SELECT MAX(number) n FROM vd_versions WHERE edit_id = ?`).get(editId).n || 0) + 1;
  const id = db.prepare(`INSERT INTO vd_versions (edit_id, number, parent_id, label, director, edl, edl_hash, settings, validation, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(editId, n, from?.id ?? null, label, from?.director || '', from?.edl || '', from?.edl_hash || '', from?.settings || '{}', from?.validation || '', userId).lastInsertRowid;
  if (from) db.prepare(`INSERT INTO vd_clips (version_id, clip_id, ord, scene_id, asset_id, segment_id, timeline_start, timeline_end, source_start, source_end) SELECT ?, clip_id, ord, scene_id, asset_id, segment_id, timeline_start, timeline_end, source_start, source_end FROM vd_clips WHERE version_id = ?`).run(id, from.id);
  return db.prepare(`SELECT * FROM vd_versions WHERE id = ?`).get(id);
}
export function workingVersion(editId, userId = null) {
  const v = latestVersion(editId);
  if (v && !v.frozen) return v;
  return newVersion(editId, v, { label: v ? `Draft from v${v.number}` : 'First draft', userId });
}
export function saveDocs(versionId, docs) {
  const v = db.prepare(`SELECT frozen FROM vd_versions WHERE id = ?`).get(versionId);
  if (v.frozen) throw new HttpError(409, 'This version is frozen: edit the working draft');
  tx(() => {
    if (docs.director !== undefined) db.prepare(`UPDATE vd_versions SET director = ? WHERE id = ?`).run(JSON.stringify(docs.director), versionId);
    if (docs.settings !== undefined) db.prepare(`UPDATE vd_versions SET settings = ? WHERE id = ?`).run(JSON.stringify(docs.settings), versionId);
    if (docs.validation !== undefined) db.prepare(`UPDATE vd_versions SET validation = ? WHERE id = ?`).run(JSON.stringify(docs.validation), versionId);
    if (docs.edl !== undefined) {
      db.prepare(`UPDATE vd_versions SET edl = ?, edl_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(docs.edl), edlHash(docs.edl), versionId);
      db.prepare(`DELETE FROM vd_clips WHERE version_id = ?`).run(versionId);
      const ins = db.prepare(`INSERT INTO vd_clips (version_id, clip_id, ord, scene_id, asset_id, segment_id, timeline_start, timeline_end, source_start, source_end) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const c of docs.edl.tracks.video) if (!c.missing) ins.run(versionId, c.id, c.order, c.scene_id, c.asset_id, c.segment_id, c.timeline_start, c.timeline_end, c.source_start, c.source_end);
    }
  });
}
export function validateVersion(edit, edl, inputs = loadInputs(edit)) {
  const val = validateEdl(edl, { scenes: inputs.scenes, usable: inputs.usable });
  for (const m of inputProblems(edit, inputs)) val.errors.unshift({ code: 'outdated', message: m });
  val.valid = !val.errors.length;
  edl.validation = { valid: val.valid, errors: val.errors.length, warnings: val.warnings.length, checked_at: val.checked_at };
  return val;
}
export function revalidate(editId) {
  const edit = editRow(editId), v = latestVersion(editId);
  if (!v?.edl) return null;
  const edl = JSON.parse(v.edl);
  const val = validateVersion(edit, edl);
  db.prepare(`UPDATE vd_versions SET validation = ?, edl = ? WHERE id = ?`).run(JSON.stringify(val), JSON.stringify(edl), v.id);
  return val;
}

// ---------- Team edits on the timeline (always on the working draft; the voice-over and music are never touched) ----------
function fitSource(scene, need, from, speed = 1) {
  let s = Math.max(scene.start, Math.min(from, scene.end));
  if (s + need * speed > scene.end) s = Math.max(scene.start, scene.end - need * speed);
  const avail = scene.end - s;
  let hold = 0;
  if (avail + 0.0005 < need * speed) { speed = Math.max(SPEED_RANGE[0], avail / need); if (avail / speed < need) hold = r3(need - avail / speed); }
  return { source_start: r3(s), source_end: r3(s + Math.min(avail, (need - hold) * speed)), speed: r3(speed), hold };
}
export function applyEdit(editId, body, user) {
  const edit = editRow(editId); mustEdit(edit, user);
  if (db.prepare(`SELECT 1 FROM vd_jobs WHERE edit_id = ? AND status IN ('queued','running')`).get(editId)) throw new HttpError(409, 'A render is running: wait for it or cancel it');
  const inputs = loadInputs(edit);
  const v = workingVersion(editId, user.id);
  const d = docsOf(v);
  if (!d.edl) throw new HttpError(400, 'Generate the editing plan first');
  const edl = d.edl, fps = edl.timeline.fps, clips = edl.tracks.video;
  if (body.clip) {
    const b = body.clip, i = clips.findIndex(c => c.id === b.id);
    if (i < 0) throw new HttpError(404, 'Clip not found');
    const c = clips[i];
    if (c.locked && b.locked !== false && Object.keys(b).some(k => !['id', 'locked'].includes(k))) throw new HttpError(409, 'This clip is locked: unlock it first');
    if (b.scene_id !== undefined) {
      const sc = inputs.scenes.get(Number(b.scene_id));
      if (!sc || !inputs.usable.has(sc.id)) throw new HttpError(400, 'This scene is not usable for this video (excluded, not silent or not in the brief).');
      Object.assign(c, { scene_id: sc.id, asset_id: sc.asset_id, source_key: '', missing: undefined, reason: 'Chosen by the team', source: 'team', ...fitSource(sc, c.frames / fps, sc.start) });
      if (!c.crop) c.crop = { mode: 'center_crop', x: 0.5, y: 0.5, zoom: 1, uncertain: false };
      c.position = c.position || { x: 0.5, y: 0.5 }; c.scale = c.scale || 1; c.motion = c.motion || 'none'; c.transition_in = c.transition_in || { type: 'hard_cut', duration: LIMITS.transition };
      c.order = c.order || i + 1; c.timeline_start = c.timeline_start ?? r3(c.start_frame / fps); c.timeline_end = c.timeline_end ?? r3((c.start_frame + c.frames) / fps);
    }
    if (b.source_start !== undefined) {
      const sc = inputs.scenes.get(c.scene_id);
      if (!sc) throw new HttpError(400, 'Scene not found');
      const want = Number(b.source_start);
      if (!(want >= sc.start - 0.001 && want < sc.end)) throw new HttpError(400, `Trim inside the scene: ${sc.start.toFixed(2)}–${sc.end.toFixed(2)} s.`);
      Object.assign(c, fitSource(sc, c.frames / fps, want, c.speed));
    }
    if (b.duration !== undefined) {
      const frames = Math.round(Number(b.duration) * fps), minF = Math.round(0.3 * fps);
      const j = clips[i + 1]?.segment_id === c.segment_id ? i + 1 : clips[i - 1]?.segment_id === c.segment_id ? i - 1 : -1;
      if (j < 0) throw new HttpError(400, 'This clip is the only one on its spoken segment: its length follows the voice-over. Change the length of another clip of the segment instead.');
      const delta = frames - c.frames;
      if (frames < minF || clips[j].frames - delta < minF) throw new HttpError(400, 'Too short: every clip needs at least 0.3 s.');
      if (clips[j].locked) throw new HttpError(409, 'The neighbouring clip is locked.');
      c.frames = frames; clips[j].frames -= delta;
      for (const k of [i, j]) { const x = clips[k], sc = inputs.scenes.get(x.scene_id); if (sc) Object.assign(x, fitSource(sc, x.frames / fps, x.source_start, 1)); }
    }
    if (b.crop) {
      const cr = { ...(c.crop || {}) };
      if (b.crop.mode !== undefined) { if (!FRAMINGS.includes(b.crop.mode)) throw new HttpError(400, 'Unknown framing'); cr.mode = b.crop.mode; }
      for (const k of ['x', 'y']) if (b.crop[k] !== undefined) cr[k] = r3(Math.max(0, Math.min(1, Number(b.crop[k]) || 0)));
      if (b.crop.zoom !== undefined) cr.zoom = r3(Math.max(1, Math.min(1.6, Number(b.crop.zoom) || 1)));
      if (b.crop.mode === 'center_crop') { cr.x = 0.5; cr.y = 0.5; }
      cr.uncertain = false; // checked by the team
      c.crop = cr;
    }
    if (b.motion !== undefined) { if (!MOTIONS.includes(b.motion)) throw new HttpError(400, 'Unknown motion'); c.motion = b.motion; }
    if (b.transition !== undefined) {
      if (!TRANSITIONS.includes(b.transition)) throw new HttpError(400, 'Unknown transition');
      c.transition_in = { type: b.transition, duration: Math.max(0.2, Math.min(1, Number(b.transition_duration) || c.transition_in?.duration || LIMITS.transition)) };
    }
    if (b.locked !== undefined) c.locked = !!b.locked;
    if (b.move) {
      const j = i + (b.move > 0 ? 1 : -1);
      if (!clips[j] || clips[j].segment_id !== c.segment_id) throw new HttpError(400, 'Clips can only change order inside the same spoken segment (the picture stays on the voice).');
      [clips[i], clips[j]] = [clips[j], clips[i]];
    }
    if (Object.keys(b).some(k => !['id', 'locked'].includes(k))) { c.source = 'team'; if (!/team/.test(c.reason || '')) c.reason = `${c.reason || ''} · adjusted by the team`.replace(/^ · /, ''); }
  }
  if (body.audio) {
    for (const k of ['voice_gain_db', 'music_gain_db']) if (body.audio[k] !== undefined) edl.audio[k] = Math.max(-12, Math.min(12, Math.round((Number(body.audio[k]) || 0) * 2) / 2));
    if (body.audio.reset) { edl.audio.voice_gain_db = 0; edl.audio.music_gain_db = 0; }
    edl.audio.uses_package_mix = !edl.audio.voice_gain_db && !edl.audio.music_gain_db;
  }
  if (body.settings) {
    const s = { ...d.settings };
    if (body.settings.pace !== undefined) { if (!PACE[body.settings.pace] && body.settings.pace !== '') throw new HttpError(400, 'Unknown pace'); s.pace = body.settings.pace; }
    if (body.settings.framing !== undefined) { if (!FRAMINGS.includes(body.settings.framing) && body.settings.framing !== '') throw new HttpError(400, 'Unknown framing'); s.framing = body.settings.framing; }
    saveDocs(v.id, { settings: s });
  }
  relayout(edl);
  const val = validateVersion(edit, edl, inputs);
  saveDocs(v.id, { edl, validation: val });
  if (edit.status === 'approved') setStatus(editId, 'ready');
}

// ---------- Versions: save, restore, compare ----------
export function saveVersion(editId, user, label = '') {
  const e = editRow(editId); mustEdit(e, user);
  const v = workingVersion(editId, user.id);
  db.prepare(`UPDATE vd_versions SET frozen = 1, label = ? WHERE id = ?`).run(String(label).slice(0, 80) || v.label || `Saved v${v.number}`, v.id);
  return newVersion(editId, db.prepare(`SELECT * FROM vd_versions WHERE id = ?`).get(v.id), { label: `Draft from v${v.number}`, userId: user.id });
}
export function restoreVersion(editId, versionId, user) {
  const e = editRow(editId); mustEdit(e, user);
  const src = db.prepare(`SELECT * FROM vd_versions WHERE id = ? AND edit_id = ?`).get(versionId, editId);
  if (!src) throw new HttpError(404, 'Version not found');
  const cur = latestVersion(editId);
  if (cur && !cur.frozen) db.prepare(`UPDATE vd_versions SET frozen = 1 WHERE id = ?`).run(cur.id);
  const nv = newVersion(editId, src, { label: `Restored v${src.number}`, userId: user.id });
  db.prepare(`UPDATE vd_versions SET approved = 0 WHERE id = ?`).run(nv.id);
  setStatus(editId, 'ready'); revalidate(editId);
  return nv;
}
export function compareVersions(editId, a, b) {
  const get = id => { const v = db.prepare(`SELECT * FROM vd_versions WHERE id = ? AND edit_id = ?`).get(id, editId); if (!v) throw new HttpError(404, 'Version not found'); return { v, edl: parse(v.edl, null) }; };
  const A = get(a), B = get(b);
  const ca = new Map((A.edl?.tracks.video || []).map(c => [c.id, c])), cb = new Map((B.edl?.tracks.video || []).map(c => [c.id, c]));
  const clips = [];
  for (const id of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(id), y = cb.get(id);
    if (!x) clips.push({ id, change: 'added', after: y.scene_id }); else if (!y) clips.push({ id, change: 'removed', before: x.scene_id });
    else {
      const diff = ['scene_id', 'source_start', 'frames', 'speed', 'motion'].filter(k => x[k] !== y[k]);
      if (JSON.stringify(x.crop) !== JSON.stringify(y.crop)) diff.push('framing');
      if (x.transition_in?.type !== y.transition_in?.type) diff.push('transition');
      if (diff.length) clips.push({ id, change: 'changed', fields: diff, before: x.scene_id, after: y.scene_id });
    }
  }
  const renders = id => db.prepare(`SELECT id, quality, status, duration, storage_key FROM vd_renders WHERE version_id = ? AND status = 'ready' ORDER BY id DESC`).all(id);
  return { a: A.v.number, b: B.v.number, clips, audio: JSON.stringify(A.edl?.audio) !== JSON.stringify(B.edl?.audio) ? { before: A.edl?.audio, after: B.edl?.audio } : null,
    duration: [A.edl?.timeline.duration ?? null, B.edl?.timeline.duration ?? null], renders: [renders(A.v.id), renders(B.v.id)] };
}

// ---------- Approval and the package for Module 7 ----------
export function approve(editId, renderId, user) {
  const edit = editRow(editId); mustEdit(edit, user);
  const v = latestVersion(editId);
  const r = db.prepare(`SELECT * FROM vd_renders WHERE id = ? AND edit_id = ?`).get(renderId, editId);
  if (!v || !r) throw new HttpError(404, 'Render not found');
  if (r.version_id !== v.id || r.edl_hash !== v.edl_hash) throw new HttpError(409, 'This render is from an older timeline: render the current version first.');
  if (r.status !== 'ready' || !r.qc_ok) throw new HttpError(422, 'This render did not pass the quality checks.');
  if (r.quality === 'preview') throw new HttpError(400, 'Approve a Standard or High quality render (previews are smaller and lighter).');
  const inputs = loadInputs(edit);
  const edl = JSON.parse(v.edl);
  const val = validateVersion(edit, edl, inputs);
  if (!val.valid) throw Object.assign(new HttpError(422, 'Fix the blocking problems before approving'), { details: val });
  const { pkg } = inputs;
  const out = {
    schema_version: PACKAGE_VERSION, edit_id: edit.id, project_id: edit.project_id, product_id: edit.product_id, variation_index: edit.variation_index,
    brief: pkg.brief, script_version: pkg.script_version, storyboard_version: pkg.storyboard_version, audio_package: edl.audio_package,
    video_version: { id: v.id, number: v.number, edl_hash: v.edl_hash },
    edl, render: { id: r.id, storage_key: r.storage_key, thumb_key: r.thumb_key, quality: r.quality, duration: r.duration, width: r.width, height: r.height, fps: r.fps, vcodec: r.vcodec, acodec: r.acodec, size: r.size, config: parse(r.config, {}) },
    captions: pkg.captions, overlay_suggestions: edl.tracks.overlays.suggestions, safe_area: edl.safe_area, audio_layers: { voiceover: edl.tracks.voiceover, music: edl.tracks.music, mix: edl.tracks.mix, levels: edl.audio },
    qc: parse(r.qc, {}), original_footage_audio: 'excluded', note: 'Module 7 re-renders from the EDL and the original sources (no re-encoding of this file).',
    approval: { approved_by: user.name, approved_at: new Date().toISOString() },
  };
  tx(() => {
    db.prepare(`UPDATE vd_versions SET frozen = 1, approved = 1, label = ?, validation = ? WHERE id = ?`).run(`Approved v${v.number}`, JSON.stringify(val), v.id);
    db.prepare(`INSERT INTO vd_approvals (edit_id, version_id, render_id, package, approved_by) VALUES (?,?,?,?,?)`).run(editId, v.id, r.id, JSON.stringify(out), user.id);
    db.prepare(`UPDATE vd_edits SET approved_version_id = ?, approved_render_id = ?, status = 'approved', error = '', updated_at = datetime('now') WHERE id = ?`).run(v.id, r.id, editId);
  });
  return out;
}
export function latestPackage(editId) {
  const r = db.prepare(`SELECT * FROM vd_approvals WHERE edit_id = ? ORDER BY id DESC LIMIT 1`).get(editId);
  return r ? { id: r.id, version_id: r.version_id, render_id: r.render_id, approved_at: r.approved_at, package: JSON.parse(r.package) } : null;
}
// For Module 7: the approved video edit of a project's planned video (only if its audio is still the latest approved one).
export function approvedVideoPackage(projectId, variationIndex = 1) {
  const e = db.prepare(`SELECT e.* FROM vd_edits e WHERE e.project_id = ? AND e.variation_index = ? AND e.approved_version_id IS NOT NULL ORDER BY e.au_approval_id DESC LIMIT 1`).get(projectId, variationIndex);
  if (!e || isOutdated(e)) return null;
  return latestPackage(e.id);
}

// ---------- Everything the page needs ----------
export function editState(editId, user) {
  const edit = editRow(editId);
  let inputs = null, inErr = '';
  try { inputs = loadInputs(edit); } catch (e) { inErr = e.message; }
  const v = latestVersion(editId), d = docsOf(v);
  const pp = inputs?.pp, pkg = inputs?.pkg;
  const renders = db.prepare(`SELECT id, version_id, quality, status, storage_key, thumb_key, duration, width, height, fps, vcodec, acodec, size, qc, qc_ok, render_seconds, edl_hash, created_at FROM vd_renders WHERE edit_id = ? ORDER BY id DESC LIMIT 30`).all(editId)
    .map(r => ({ ...r, qc: parse(r.qc, null), current: !!v && r.version_id === v.id && r.edl_hash === v.edl_hash, version_number: db.prepare(`SELECT number FROM vd_versions WHERE id = ?`).get(r.version_id)?.number }));
  const job = db.prepare(`SELECT id, kind, target, status, stage, progress, error, failed_stage, attempts, render_id, created_at, finished_at FROM vd_jobs WHERE edit_id = ? ORDER BY id DESC LIMIT 1`).get(editId) || null;
  const usage = db.prepare(`SELECT COUNT(*) renders, COALESCE(SUM(wall_seconds),0) wall, COALESCE(SUM(output_bytes),0) bytes, COALESCE(MAX(peak_rss_mb),0) rss, COALESCE(SUM(clips_cached),0) cached, COALESCE(SUM(clips),0) clips FROM vd_usage WHERE edit_id = ? AND ok = 1`).get(editId);
  const ai = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) calls FROM ai_usage WHERE ref = ?`).get(`video:${editId}`);
  const used = new Set((d.edl?.tracks.video || []).map(c => c.scene_id));
  const vo = pkg?.voiceover ? voiceoverRow(pkg.voiceover.id) : null;
  const problems = inputs ? inputProblems(edit, inputs) : [inErr];
  return {
    edit: { ...edit, outdated: problems.length > 0, problems, can_edit: canEdit(projectRow(edit.project_id), user) },
    context: pp && { product: pp.product?.name, angles: (pp.angles || []).map(a => a.name), creative_type: pp.creative_type?.name, language: pp.target?.language_name, country: pp.target?.country,
      duration: pp.format?.duration_seconds, aspect: pp.format?.aspect_ratio, platform: pp.platform?.name || pp.platform || '', pace: pp.editing_pace, script_version: pkg.script_version.number,
      audio_version: pkg.audio_version.number, final_duration: pkg.synchronized_storyboard.final_duration, voiceover: !!pkg.voiceover, music: pkg.music?.name || null,
      segments: pkg.synchronized_storyboard.segments.map(w => ({ ...w, text: pp.voiceover.segments.find(s => s.id === w.id)?.text || '' })) },
    version: v ? { id: v.id, number: v.number, frozen: !!v.frozen, approved: !!v.approved, label: v.label, edl_hash: v.edl_hash } : null,
    ...d, renders, job, versions: db.prepare(`SELECT id, number, label, frozen, approved, created_at, updated_at FROM vd_versions WHERE edit_id = ? ORDER BY number DESC`).all(editId),
    usage: { renders: usage.renders, render_seconds: Math.round(usage.wall * 10) / 10, output_mb: Math.round(usage.bytes / 1048576 * 10) / 10, peak_rss_mb: Math.round(usage.rss), clips_reused: usage.cached, clips_total: usage.clips, ai_usd: Math.round(ai.usd * 1000) / 1000, ai_calls: ai.calls },
    scenes: inputs ? [...inputs.usable].map(id => inputs.scenes.get(id)).filter(Boolean).map(s => ({ id: s.id, asset_id: s.asset_id, start: s.start, end: s.end, duration: s.duration, orientation: s.orientation, width: s.width, height: s.height, quality: s.quality,
      description: s.description, semantic: s.semantic, categories: s.categories.map(c => c.key), used: used.has(s.id), product_visible: s.details?.product_visible ?? null })) : [],
    waveform: vo?.peaks || [], lead_in: pkg?.mix?.lead_in ?? 0, qualities: Object.fromEntries(Object.entries(QUALITY).map(([k, q]) => [k, { label: q.label, size: outputSize(pp?.format?.aspect_ratio || '9:16', k) }])),
    package: latestPackage(editId), statuses: STATUSES, edl_version: EDL_VERSION,
  };
}
export const hashOf = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export { checkPackage };
