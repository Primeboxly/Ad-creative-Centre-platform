// Module 4 core: plans (one per project + brief version + planned video), versions, storyboard assembly on a timeline,
// targeted edits with locks, validation (blocking vs warnings), versions (save, restore, duplicate, compare), approval and
// the production plan handed to Modules 5-8. Media are referenced (scene ids + source seconds), never copied or cut.
import { db, tx } from './db.js';
import { HttpError } from './errors.js';
import { validate as checkSchema } from './schema.js';
import { canEdit, projectRow } from './creative.js';
import { revalidateBrief } from './creative-brief.js';
import { CLAIMS } from './creative-types.js';
import { sceneRows } from './footage-services.js';
import { timeSegments, durationCheck, estimate, round } from './sb-duration.js';
import { rankScenes, scoreScene, usableScenes, usageElsewhere, SHOT_LENGTH } from './sb-matching.js';
import { contextOf, roleOfKey } from './sb-director.js';
import { SB_SCHEMA_VERSION, ROLES, STRATEGY_DOC, HOOKS_DOC, SCRIPT_DOC, STORYBOARD_DOC, TRANSITIONS, MOTIONS, CROPS } from './sb-schemas.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
export const STATUSES = ['draft', 'generating_strategy', 'generating_hooks', 'generating_script', 'matching_footage', 'generating_storyboard', 'validating', 'ready', 'approved', 'failed'];

// ---------- Plans ----------
export const planRow = id => {
  const p = db.prepare(`SELECT * FROM sb_plans WHERE id = ?`).get(id);
  if (!p) throw new HttpError(404, 'Script plan not found');
  return p;
};
export const briefRow = briefId => {
  const b = db.prepare(`SELECT * FROM creative_briefs WHERE id = ?`).get(briefId);
  if (!b) throw new HttpError(404, 'Creative Brief not found');
  return { id: b.id, version: b.version, project_id: b.project_id, brief: JSON.parse(b.brief) };
};
const mustEdit = (plan, user) => {
  if (!canEdit(projectRow(plan.project_id), user)) throw new HttpError(403, 'Only the author of this project or an admin can change its script and storyboard');
};
export function getOrCreatePlan(projectId, variationIndex, user) {
  const pr = projectRow(projectId);
  if (!canEdit(pr, user)) throw new HttpError(403, 'Only the author of this project or an admin can generate its script');
  const b = db.prepare(`SELECT id, version, brief FROM creative_briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1`).get(projectId);
  if (!b) throw new HttpError(400, 'Save the Creative Brief first (Review & save step).');
  const brief = JSON.parse(b.brief);
  const vi = Number(variationIndex) || 1;
  if (!brief.variations.videos.some(v => v.index === vi)) throw new HttpError(400, `The brief has no planned video ${vi}`);
  const ex = db.prepare(`SELECT * FROM sb_plans WHERE project_id = ? AND brief_id = ? AND variation_index = ?`).get(projectId, b.id, vi);
  if (ex) return ex;
  const id = db.prepare(`INSERT INTO sb_plans (project_id, brief_id, brief_version, variation_index, created_by) VALUES (?,?,?,?,?)`).run(projectId, b.id, b.version, vi, user.id).lastInsertRowid;
  return planRow(id);
}
export const setStatus = (planId, status, error = '') => db.prepare(`UPDATE sb_plans SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`).run(status, error, planId);

// ---------- Versions ----------
const latestVersion = planId => db.prepare(`SELECT * FROM sb_versions WHERE plan_id = ? ORDER BY number DESC LIMIT 1`).get(planId);
export const docsOf = v => (v ? { strategy: parse(v.strategy, null), hooks: parse(v.hooks, null), script: parse(v.script, null), storyboard: parse(v.storyboard, null), validation: parse(v.validation, null) } : {});
function newVersion(planId, from, { label = '', userId = null } = {}) {
  const n = (db.prepare(`SELECT MAX(number) n FROM sb_versions WHERE plan_id = ?`).get(planId).n || 0) + 1;
  const id = db.prepare(`INSERT INTO sb_versions (plan_id, number, parent_id, label, strategy, strategy_rev, hooks, script, storyboard, validation, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(planId, n, from?.id ?? null, label, from?.strategy || '', from?.strategy_rev || 0, from?.hooks || '', from?.script || '', from?.storyboard || '', from?.validation || '', userId).lastInsertRowid;
  if (from) db.prepare(`INSERT INTO sb_version_scenes (version_id, shot_id, scene_id) SELECT ?, shot_id, scene_id FROM sb_version_scenes WHERE version_id = ?`).run(id, from.id);
  return db.prepare(`SELECT * FROM sb_versions WHERE id = ?`).get(id);
}
// The editable draft: the newest version if it is not frozen, else a new draft copied from it (approved versions never change).
export function workingVersion(planId, userId = null) {
  const v = latestVersion(planId);
  if (v && !v.frozen) return v;
  return newVersion(planId, v, { label: v ? `Draft from v${v.number}` : 'First draft', userId });
}

// Store documents (checked against their schema) and keep the scene links in step.
export function saveDocs(versionId, docs) {
  const v = db.prepare(`SELECT * FROM sb_versions WHERE id = ?`).get(versionId);
  if (v.frozen) throw new HttpError(409, 'This version is frozen: edit the working draft');
  const sets = [], vals = [];
  const put = (k, schema) => {
    if (docs[k] === undefined) return;
    if (docs[k] !== null) {
      const errs = checkSchema(schema, docs[k]);
      if (errs.length) throw new HttpError(500, `The ${k} does not match its schema: ${errs.slice(0, 3).join('; ')}`);
    }
    sets.push(`${k} = ?`); vals.push(docs[k] === null ? '' : JSON.stringify(docs[k]));
  };
  put('strategy', STRATEGY_DOC); put('hooks', HOOKS_DOC); put('script', SCRIPT_DOC); put('storyboard', STORYBOARD_DOC);
  if (docs.strategy) { sets.push('strategy_rev = strategy_rev + 1'); }
  if (!sets.length) return;
  tx(() => {
    db.prepare(`UPDATE sb_versions SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, versionId);
    if (docs.storyboard !== undefined) {
      db.prepare(`DELETE FROM sb_version_scenes WHERE version_id = ?`).run(versionId);
      const ok = new Set(db.prepare(`SELECT id FROM footage_scenes`).all().map(r => r.id));
      for (const s of docs.storyboard?.shots || []) if (ok.has(s.scene_id)) db.prepare(`INSERT OR IGNORE INTO sb_version_scenes (version_id, shot_id, scene_id) VALUES (?,?,?)`).run(versionId, s.id, s.scene_id);
    }
  });
}

// ---------- Context helpers ----------
export function loadContext(plan) {
  const b = briefRow(plan.brief_id);
  const ctx = contextOf(b.brief, plan.variation_index);
  const scenes = usableScenes(b.brief);
  return { b, ctx, scenes, byId: new Map(scenes.map(s => [s.id, s])) };
}
const nextId = (prefix, items) => `${prefix}${1 + Math.max(0, ...items.map(x => Number(String(x.id).replace(/\D/g, '')) || 0))}`;

// ---------- Script normalisation (ids, roles, timing, duration) ----------
export function buildScript(ctx, rawSegments, { hookId = null, prev = null } = {}) {
  const prevSegs = prev?.segments || [];
  const segs = [];
  const keptIds = new Set(rawSegments.map(s => s.keep).filter(Boolean));
  for (const [i, s] of rawSegments.entries()) {
    const keep = s.keep && prevSegs.find(p => p.id === s.keep && p.locked);
    // A new segment takes the id of the old unlocked segment at the same place (shots and comparisons stay linked).
    const samePlace = prevSegs[i] && !prevSegs[i].locked && !keptIds.has(prevSegs[i].id) && !segs.some(x => x.id === prevSegs[i].id) ? prevSegs[i].id : null;
    const id = keep ? keep.id : samePlace || (s.id && !segs.some(x => x.id === s.id) ? s.id : nextId('s', [...prevSegs, ...segs]));
    segs.push(keep ? { ...keep } : {
      id, role: ROLES[s.role] ? s.role : 'supporting', text: str(s.text, 1200), on_screen_text: ctx.production.text_overlays ? str(s.on_screen_text, 120) : '',
      visual_intent: str(s.visual_intent, 400), scene_categories: (s.scene_categories || []).map(x => str(x, 30)).slice(0, 4),
      features: (s.features || []).map(x => str(x, 80)).slice(0, 4), benefits: (s.benefits || []).map(x => str(x, 80)).slice(0, 4),
      emotion: str(s.emotion, 60), transition: TRANSITIONS.includes(s.transition) ? s.transition : 'smooth_cut', locked: !!s.locked, source: s.source || 'ai',
    });
  }
  // Locked segments the AI dropped come back at their old place.
  for (const p of prevSegs.filter(p => p.locked && !segs.some(s => s.id === p.id))) segs.splice(Math.min(p.order - 1, segs.length), 0, { ...p });
  return retimeScript(ctx, { hook_id: hookId ?? prev?.hook_id ?? null, segments: segs });
}
export function retimeScript(ctx, script) {
  const t = timeSegments(script.segments.filter(s => s.text.trim()), { lang: ctx.lang, dialect: ctx.dialect, tone: ctx.tone });
  const check = durationCheck(t.seconds, ctx.duration);
  return {
    schema_version: SB_SCHEMA_VERSION, language: ctx.lang, dialect: ctx.dialect || '', tone: ctx.tone, target_seconds: ctx.duration,
    est_seconds: t.seconds, diff_seconds: check.diff, words: t.words, structure: ctx.type.structure.map(b => b.label), hook_id: script.hook_id ?? null,
    segments: t.segments.map(s => ({ id: s.id, order: s.order, role: s.role, text: s.text, on_screen_text: s.on_screen_text || '', visual_intent: s.visual_intent || '',
      scene_categories: s.scene_categories || [], features: s.features || [], benefits: s.benefits || [], emotion: s.emotion || '', transition: s.transition || 'smooth_cut',
      est_start: s.est_start, est_end: s.est_end, est_duration: s.est_duration, words: s.words, locked: !!s.locked, source: s.source || 'ai' })),
  };
}

// ---------- Storyboard assembly ----------
// Share a segment's time between its shots without going past what each scene has ("water filling").
function shareTime(total, caps) {
  const out = caps.map(() => 0);
  let left = total, open = caps.map((_, i) => i);
  while (left > 0.01 && open.length) {
    const share = left / open.length;
    const next = [];
    for (const i of open) { const add = Math.min(share, caps[i] - out[i]); out[i] += add; left -= add; if (caps[i] - out[i] > 0.01) next.push(i); }
    if (next.length === open.length && share < 0.01) break;
    open = next;
  }
  return { durations: out, shortfall: Math.max(0, left) };
}
const shotCount = (segDur, pace) => Math.max(1, Math.min(3, Math.round(segDur / (SHOT_LENGTH[pace] || 2.5))));

// Lay the shots of every segment on the voice-over timeline. picks: { segId: [{ scene_id, reason, confidence, crop, motion, transition, edit_notes, text_emphasis }] }
export function assembleStoryboard(ctx, script, picks, cands, byId, { prev = null, keepLocked = true } = {}) {
  const shots = [], missing = [];
  const prevShots = prev?.shots || [];
  const used = new Set(), usedLooks = new Set();
  const look = s => s.duplicate_of || s.similar_to || s.id;
  for (const seg of script.segments) {
    const lockedHere = keepLocked ? prevShots.filter(p => p.segment_id === seg.id && p.locked && byId.has(p.scene_id)) : [];
    let chosen;
    if (lockedHere.length) chosen = lockedHere.map(p => ({ ...p, _keep: true }));
    else {
      const list = (picks[seg.id] || []).filter(p => byId.has(p.scene_id) && (cands[seg.id] || []).some(c => c.scene.id === p.scene_id));
      chosen = [];
      for (const p of list) {
        // A scene already used in this ad is swapped for an unused relevant candidate when there is one.
        if (used.has(p.scene_id) || chosen.some(c => c.scene_id === p.scene_id)) {
          const alt = (cands[seg.id] || []).find(c => c.semantic >= 25 && !used.has(c.scene.id) && !chosen.some(x => x.scene_id === c.scene.id));
          if (alt) { chosen.push({ ...p, scene_id: alt.scene.id, reason: `${alt.scene.semantic || 'Relevant scene'} (chosen instead of a scene already used)`, confidence: alt.score }); continue; }
          if (chosen.some(c => c.scene_id === p.scene_id)) continue;
        }
        chosen.push({ ...p });
      }
      if (!picks[seg.id]) { // no AI answer for this segment: best candidates that are not used yet
        const want = shotCount(seg.est_duration, ctx.pace);
        chosen = (cands[seg.id] || []).filter(c => c.semantic >= 25).sort((a, b) => used.has(a.scene.id) - used.has(b.scene.id)).slice(0, want).map(c => ({ scene_id: c.scene.id, reason: `Best match (${c.score}/100): ${c.scene.semantic || 'scene'}`, confidence: c.score }));
      }
    }
    if (!chosen.length) {
      missing.push({ segment_id: seg.id, need: seg.visual_intent || `Footage for: ${seg.text}`, alternative: picks[`${seg.id}:missing`] || 'Rewrite this segment around what the footage shows, or upload footage for it.' });
      continue;
    }
    // Make sure the scenes can cover the segment: add more candidates when they are too short.
    const caps = () => chosen.map(c => c._keep && c.trimmed ? c.source_end - c.source_start : byId.get(c.scene_id).duration);
    let fill = shareTime(seg.est_duration, caps());
    for (const c of cands[seg.id] || []) {
      if (fill.shortfall < 0.3 || chosen.length >= 4 || lockedHere.length) break;
      if (chosen.some(x => x.scene_id === c.scene.id) || used.has(c.scene.id) || c.semantic < 25) continue;
      chosen.push({ scene_id: c.scene.id, reason: `Added to cover the segment length: ${c.scene.semantic || ''}`, confidence: c.score });
      fill = shareTime(seg.est_duration, caps());
    }
    let t = seg.est_start;
    chosen.forEach((c, i) => {
      const sc = byId.get(c.scene_id);
      let dur = fill.durations[i];
      const isLast = i === chosen.length - 1;
      const warnings = [];
      if (isLast && fill.shortfall > 0.05) { dur += fill.shortfall; warnings.push(`Scene too short by ${round(fill.shortfall)} s: hold the last frame or add a shot`); }
      const useLen = Math.min(dur, c._keep && c.trimmed ? c.source_end - c.source_start : sc.duration);
      const start = c._keep && c.trimmed ? c.source_start : round(sc.start + Math.max(0, (sc.duration - useLen) / 2));
      if ((sc.flags || []).includes('watermark')) warnings.push('Watermark in the footage');
      if ((sc.flags || []).includes('text_overlay')) warnings.push('Text already in the footage');
      if (used.has(sc.id)) warnings.push('Scene already used earlier in this ad');
      const conf = c.confidence ?? scoreScene(sc, seg, ctx).score;
      if (conf < 35) warnings.push('Weak match with the spoken text');
      used.add(sc.id); usedLooks.add(look(sc));
      const prevShot = c._keep ? c : null;
      shots.push({
        id: prevShot?.id || null, order: 0, segment_id: seg.id, role: seg.role, scene_id: sc.id, asset_id: sc.asset_id, source_key: sc.proxy_key || '',
        source_start: round(start), source_end: round(start + useLen), source_duration: round(useLen),
        timeline_start: round(t), timeline_end: round(t + dur), duration: round(dur),
        voiceover: i === 0 ? seg.text : '', on_screen_text: prevShot ? prevShot.on_screen_text || '' : i === 0 && ctx.production.text_overlays ? seg.on_screen_text : '',
        visual_description: sc.description || sc.semantic || '', reason: str(c.reason, 300), confidence: Math.max(0, Math.min(100, Math.round(conf))),
        crop: CROPS.includes(c.crop) ? c.crop : (sc.orientation && ctx.aspect === '9:16' && sc.orientation !== 'vertical' ? 'product_focus' : 'none'),
        motion: MOTIONS.includes(c.motion) ? c.motion : 'none', transition: TRANSITIONS.includes(c.transition) ? c.transition : (i ? 'hard_cut' : seg.transition),
        speed: 1, edit_notes: str(c.edit_notes, 300), text_emphasis: !!c.text_emphasis,
        alternatives: cands[seg.id] ? cands[seg.id].map(x => x.scene.id).filter(id => id !== sc.id).slice(0, 4) : (prevShot?.alternatives || []).filter(id => id !== sc.id),
        warnings, locked: !!prevShot?.locked, source: prevShot?.source || 'ai', trimmed: !!prevShot?.trimmed,
      });
      t += dur;
    });
  }
  shots.forEach((s, i) => { s.order = i + 1; });
  shots.forEach(s => { if (!s.id) s.id = nextId('k', [...prevShots, ...shots.filter(x => x.id)]); });
  return finishStoryboard(ctx, shots, missing);
}
const finishStoryboard = (ctx, shots, missing) => ({
  schema_version: SB_SCHEMA_VERSION, total_seconds: round(shots.length ? shots[shots.length - 1].timeline_end : 0), pace: ctx.pace, aspect: ctx.aspect,
  shots: shots.map(({ trimmed, _keep, ...s }) => s), missing,
});
// Keep scene choices (and trims) but re-share the time after the script timing changed.
export function retimeStoryboard(ctx, script, board, byId) {
  const picks = {};
  const keep = board.shots.map(s => ({ ...s, locked: true, trimmed: s.source === 'user' }));
  return withFlags(board, assembleStoryboard(ctx, script, picks, {}, byId, { prev: { shots: keep } }));
}
function withFlags(oldBoard, board) {
  // assembleStoryboard marks kept shots locked: restore the team's real lock flags.
  const was = new Map(oldBoard.shots.map(s => [s.id, s]));
  board.shots = board.shots.map(s => ({ ...s, locked: !!was.get(s.id)?.locked, source: was.get(s.id)?.source || s.source }));
  return board;
}

// Candidates for every segment (also used to rank alternatives in the page).
export function candidatesFor(ctx, plan, script, scenes, extraUsed = new Set()) {
  const elsewhere = usageElsewhere(plan.project_id, plan.id);
  const out = {};
  const used = new Set(extraUsed);
  for (const seg of script.segments) {
    const r = rankScenes(scenes, seg, { angleIds: ctx.angles.map(a => a.id), aspect: ctx.aspect, shotLength: SHOT_LENGTH[ctx.pace], used, elsewhere });
    out[seg.id] = r.candidates;
    if (r.candidates[0]) used.add(r.candidates[0].scene.id);
  }
  return out;
}

// ---------- Validation ----------
const STOPWORDS = {
  en: 'the and you your with this for that are have get now just what who it is to of'.split(' '),
  fr: 'le la les et vous votre avec pour est une des du que qui ce cette dans sur pas'.split(' '),
  sw: 'na ya wa kwa ni za la hii huu sasa leo yako wako kama kwenye pia sana'.split(' '),
};
export function detectLanguage(text) {
  const w = String(text).toLowerCase().split(/[^\p{L}]+/u);
  const score = Object.fromEntries(Object.entries(STOPWORDS).map(([k, list]) => [k, w.filter(x => list.includes(x)).length]));
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 2 ? best[0] : null;
}
const TESTIMONIAL = /\b(i (bought|ordered|tried|use[d]?|love[d]?) (it|this|mine)|my (customers|clients) (say|love)|\d(\.\d)? ?stars?|best reviews?|customers (say|love)|testimonials?|nimenunua|j'ai (acheté|essayé))\b/i;

export function validateVersion(plan, docs, briefCtx) {
  const errors = [], warnings = [];
  const E = (code, message, where = '') => errors.push({ code, message, where });
  const W = (code, message, where = '') => warnings.push({ code, message, where });
  const { b, ctx, byId } = briefCtx;
  const chk = revalidateBrief(b.brief);
  for (const p of chk.problems) E('brief', p, 'brief');
  const { script, storyboard: board } = docs;
  if (!docs.strategy) W('strategy', 'No creative strategy yet.', 'strategy');
  if (!script?.segments?.length) { E('script', 'No script yet.', 'script'); return { errors, warnings, valid: false, checked_at: new Date().toISOString() }; }
  const segs = script.segments;
  // Script
  if (!segs.some(s => s.role === 'cta')) E('cta', 'The script has no call-to-action segment.', 'script');
  if (segs[0].role !== 'hook') W('hook_first', 'The script does not start with a hook segment.', 'script');
  const roles = new Set(segs.map(s => s.role));
  const expected = [...new Set(ctx.type.structure.map(x => roleOfKey(x.key)))].filter(r => r !== 'supporting');
  const absent = expected.filter(r => !roles.has(r) && !(r === 'benefit' && roles.has('feature')) && !(r === 'demonstration' && roles.has('solution')));
  if (absent.length) W('structure', `The script skips parts of the ${ctx.type.name} structure: ${absent.map(r => ROLES[r]).join(', ')}.`, 'script');
  const allText = segs.map(s => s.text).join(' ');
  const lang = detectLanguage(allText);
  if (lang && lang !== ctx.lang) W('language', `The script looks written in ${lang.toUpperCase()}, but the target language is ${ctx.langName}.`, 'script');
  const d = durationCheck(script.est_seconds, ctx.duration);
  if (d.tooLong) W('too_long', `Estimated voice-over ${script.est_seconds} s for a ${ctx.duration} s target (+${d.diff} s).`, 'script');
  if (d.tooShort) W('too_short', `Estimated voice-over ${script.est_seconds} s for a ${ctx.duration} s target (${d.diff} s).`, 'script');
  if (script.est_seconds > ctx.duration * 1.5) E('far_too_long', `The script (${script.est_seconds} s) is far longer than the ${ctx.duration} s target: shorten it.`, 'script');
  for (const s of segs) if (!s.text.trim()) E('empty_segment', `Segment ${s.order} is empty.`, s.id);
  // Claims, prices, testimonials (spoken text and on-screen text)
  const said = [allText, ...segs.map(s => s.on_screen_text), ...(board?.shots || []).map(s => s.on_screen_text), ...(docs.hooks?.items || []).filter(h => h.id === docs.hooks.selected).map(h => h.on_screen_text)].join(' \n ');
  const conf = b.brief.target.confirmed, offer = b.brief.target.offer;
  const confirmedOf = { cod: conf.cash_on_delivery, free_delivery: conf.free_delivery, limited_stock: conf.limited_stock, guarantee: conf.guarantee };
  for (const c of CLAIMS) if (c.re.test(said) && (c.key === 'promotion' ? !offer : !confirmedOf[c.key])) E(`claim_${c.key}`, `The script or on-screen text mentions ${c.label}, which the brief does not confirm.`, 'script');
  const price = String(b.brief.target.price || '').replace(/[^\d.]/g, '');
  const cur = b.brief.target.currency;
  const priced = [...said.matchAll(new RegExp(`(?:${cur || 'K'}|kwacha|\\$|usd|ksh|kes|shilling[s]?)\\s?([\\d][\\d,.]*)|([\\d][\\d,.]*)\\s?(?:${cur || 'K'}|kwacha|usd|ksh|kes|shilling[s]?)\\b`, 'gi'))].map(m => (m[1] || m[2]).replace(/[,]/g, ''));
  for (const p of priced) if (!price || Number(p) !== Number(price)) E('price', `A price (${p}) is used that does not match the brief (${price ? `${price} ${cur}` : 'no price'}).`, 'script');
  if (TESTIMONIAL.test(said)) W('testimonial', 'The text sounds like a customer testimonial or review: check it is not presented as a real one.', 'script');
  // Storyboard
  if (!board?.shots?.length) { E('storyboard', 'No storyboard yet.', 'storyboard'); return { errors, warnings, valid: !errors.length, checked_at: new Date().toISOString() }; }
  const shots = board.shots;
  const allowed = new Set(b.brief.footage.scene_ids);
  const live = new Map(sceneRows(`s.id IN (${shots.map(() => '?').join(',')})`, shots.map(s => s.scene_id)).map(s => [s.id, s]));
  let t = 0;
  const seen = new Map();
  for (const s of shots) {
    const sc = live.get(s.scene_id);
    if (!sc) { E('scene_missing', `Shot ${s.order}: scene ${s.scene_id} does not exist any more.`, s.id); continue; }
    if (sc.product_id !== b.brief.product_id) E('scene_product', `Shot ${s.order}: the scene belongs to another product.`, s.id);
    if (!allowed.has(s.scene_id)) E('scene_not_allowed', `Shot ${s.order}: the scene is not allowed by the brief's footage selection.`, s.id);
    else if (!byId.has(s.scene_id)) E('scene_unusable', `Shot ${s.order}: the scene is no longer usable (excluded, not analysed or not silent).`, s.id);
    if (s.asset_id !== sc.asset_id) E('asset', `Shot ${s.order}: wrong source video reference.`, s.id);
    if (!(s.source_start >= sc.start - 0.01 && s.source_end <= sc.end + 0.01 && s.source_end > s.source_start)) E('source_times', `Shot ${s.order}: source times ${s.source_start}-${s.source_end} s are outside the scene (${sc.start}-${sc.end} s).`, s.id);
    if (!(s.duration > 0)) E('duration', `Shot ${s.order}: duration must be positive.`, s.id);
    if (Math.abs(s.timeline_start - t) > 0.06) E('timeline', `Shot ${s.order}: timeline gap or overlap at ${t.toFixed(2)} s.`, s.id);
    if (Math.abs(s.timeline_end - s.timeline_start - s.duration) > 0.06) E('timeline', `Shot ${s.order}: timeline start/end do not match its duration.`, s.id);
    t = s.timeline_end;
    if (s.source_duration + 0.05 < s.duration) W('hold', `Shot ${s.order}: the scene is ${round(s.duration - s.source_duration)} s shorter than the shot.`, s.id);
    if (s.speed !== 1) W('speed', `Shot ${s.order}: speed change planned; make sure it does not mislead.`, s.id);
    if (s.confidence < 35) W('weak_visual', `Shot ${s.order}: the footage may not show what is said.`, s.id);
    if ((sc.quality ?? 100) < 45) W('low_quality', `Shot ${s.order}: low-quality footage (${sc.quality}/100).`, s.id);
    if ((sc.flags || []).includes('watermark')) W('watermark', `Shot ${s.order}: watermark in the footage.`, s.id);
    if ((sc.flags || []).includes('text_overlay')) W('text_in_footage', `Shot ${s.order}: text already in the footage.`, s.id);
    if (sc.orientation && ctx.aspect === '9:16' && sc.orientation !== 'vertical') W('crop', `Shot ${s.order}: ${sc.orientation} footage will be cropped for 9:16.`, s.id);
    if (sc.orientation && ctx.aspect === '16:9' && sc.orientation !== 'horizontal') W('crop', `Shot ${s.order}: ${sc.orientation} footage will be cropped for 16:9.`, s.id);
    seen.set(s.scene_id, (seen.get(s.scene_id) || 0) + 1);
  }
  const repeats = [...seen.values()].filter(n => n > 1).length;
  if (repeats) W('repeats', `${repeats} scene(s) are used more than once.`, 'storyboard');
  for (const seg of segs) if (!shots.some(s => s.segment_id === seg.id)) E('no_footage', `Segment ${seg.order} (${ROLES[seg.role] || seg.role}) has no footage: pick a scene or rewrite it.`, seg.id);
  for (const m of board.missing || []) W('missing_footage', `Missing footage: ${m.need}`, m.segment_id);
  if (Math.abs(board.total_seconds - script.est_seconds) > 0.3) E('timeline_total', `The storyboard (${board.total_seconds} s) does not match the script timing (${script.est_seconds} s): regenerate or retime it.`, 'storyboard');
  if (!b.brief.footage.audio.startsWith('none')) E('audio', 'Original footage audio must be excluded.', 'storyboard');
  return { errors, warnings, valid: !errors.length, checked_at: new Date().toISOString() };
}
export function revalidate(planId) {
  const plan = planRow(planId);
  const v = latestVersion(planId);
  if (!v) return null;
  const val = validateVersion(plan, docsOf(v), loadContext(plan));
  db.prepare(`UPDATE sb_versions SET validation = ? WHERE id = ?`).run(JSON.stringify(val), v.id);
  return val;
}

// ---------- Team edits (on the working draft; an approved version is copied first) ----------
export function applyEdit(planId, body, user) {
  const plan = planRow(planId);
  mustEdit(plan, user);
  if (db.prepare(`SELECT 1 FROM sb_jobs WHERE plan_id = ? AND status IN ('queued','running')`).get(planId)) throw new HttpError(409, 'Generation is running: wait for it or cancel it');
  const bc = loadContext(plan);
  const { ctx, byId } = bc;
  const v = workingVersion(planId, user.id);
  const d = docsOf(v);
  let script = d.script, board = d.storyboard, hooks = d.hooks, strategy = d.strategy;
  const touched = {};
  const retime = () => { script = retimeScript(ctx, script); if (board) board = retimeStoryboard(ctx, script, board, byId); touched.script = touched.storyboard = true; };

  if (body.strategy) {
    strategy = { ...(strategy || {}), ...Object.fromEntries(Object.entries(body.strategy).filter(([k]) => STRATEGY_DOC.properties[k] && !['source', 'rev'].includes(k)).map(([k, x]) => [k, typeof x === 'string' ? str(x, 600) : x])), source: 'user', rev: (strategy?.rev || 0) + 1 };
    touched.strategy = true;
  }
  if (body.hook_select !== undefined || body.hook_edit || body.hook_auto !== undefined) {
    if (!hooks) throw new HttpError(400, 'No hooks yet');
    if (body.hook_auto !== undefined) hooks.auto = !!body.hook_auto;
    if (body.hook_edit) {
      const h = hooks.items.find(x => x.id === body.hook_edit.id);
      if (!h) throw new HttpError(404, 'Hook not found');
      for (const k of ['text', 'on_screen_text', 'visual_opening']) if (body.hook_edit[k] !== undefined) h[k] = str(body.hook_edit[k], 300);
      h.source = 'user';
    }
    if (body.hook_select !== undefined) {
      if (!hooks.items.some(x => x.id === body.hook_select)) throw new HttpError(404, 'Hook not found');
      hooks.selected = body.hook_select; hooks.auto = false;
    }
    touched.hooks = true;
    // The chosen hook text goes into the script's hook segment (unless it is locked).
    const h = hooks.items.find(x => x.id === hooks.selected);
    const hs = script?.segments.find(s => s.role === 'hook');
    if (h && hs && !hs.locked && (body.hook_select !== undefined || body.hook_edit?.id === hooks.selected)) { hs.text = h.text; if (ctx.production.text_overlays) hs.on_screen_text = h.on_screen_text; script.hook_id = h.id; retime(); }
  }
  if (script) {
    const segById = id => { const s = script.segments.find(x => x.id === id); if (!s) throw new HttpError(404, 'Segment not found'); return s; };
    if (body.segment) {
      const s = segById(body.segment.id);
      const textChanged = body.segment.text !== undefined && str(body.segment.text, 1200) !== s.text;
      for (const k of ['text', 'on_screen_text', 'visual_intent', 'emotion']) if (body.segment[k] !== undefined) s[k] = str(body.segment[k], k === 'text' ? 1200 : 400);
      if (body.segment.role !== undefined && ROLES[body.segment.role]) s.role = body.segment.role;
      if (body.segment.transition !== undefined && TRANSITIONS.includes(body.segment.transition)) s.transition = body.segment.transition;
      if (body.segment.locked !== undefined) s.locked = !!body.segment.locked;
      if (textChanged || body.segment.role !== undefined) s.source = 'user';
      retime();
      // Affected shots: re-check how well their footage fits the new text.
      if (board && textChanged) for (const sh of board.shots.filter(x => x.segment_id === s.id)) {
        const sc = byId.get(sh.scene_id);
        if (sc) { sh.confidence = scoreScene(sc, s, { angleIds: ctx.angles.map(a => a.id), aspect: ctx.aspect }).score; if (sh.confidence < 35 && !sh.warnings.includes('Weak match with the spoken text')) sh.warnings.push('Weak match with the spoken text'); }
        if (sh.order === board.shots.find(x => x.segment_id === s.id)?.order) sh.voiceover = s.text;
      }
    }
    if (body.add_segment) {
      const after = body.add_segment.after_id ? script.segments.findIndex(x => x.id === body.add_segment.after_id) : script.segments.length - 1;
      const role = ROLES[body.add_segment.role] ? body.add_segment.role : 'supporting';
      script.segments.splice(after + 1, 0, { id: nextId('s', script.segments), role, text: str(body.add_segment.text || 'New segment.', 1200), on_screen_text: '', visual_intent: '', scene_categories: [], features: [], benefits: [], emotion: '', transition: 'smooth_cut', locked: false, source: 'user' });
      retime();
    }
    if (body.remove_segment) {
      const s = segById(body.remove_segment);
      script.segments = script.segments.filter(x => x.id !== s.id);
      if (board) board.shots = board.shots.filter(x => x.segment_id !== s.id);
      retime();
    }
    if (Array.isArray(body.segment_order)) {
      const ids = body.segment_order;
      if (ids.length !== script.segments.length || !ids.every(id => script.segments.some(x => x.id === id))) throw new HttpError(400, 'The new order must list every segment once');
      script.segments = ids.map(id => script.segments.find(x => x.id === id));
      if (board) board.shots.sort((a, c) => ids.indexOf(a.segment_id) - ids.indexOf(c.segment_id) || a.order - c.order);
      retime();
    }
    if (body.script_text !== undefined) {
      // Whole script edited at once: paragraphs (blank lines) = segments; roles kept by position (unlocked ones).
      const parts = String(body.script_text).split(/\n\s*\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
      if (!parts.length) throw new HttpError(400, 'The script is empty');
      const old = script.segments;
      script.segments = parts.map((p, i) => old[i] ? (old[i].locked ? old[i] : { ...old[i], text: str(p, 1200), source: old[i].text === p ? old[i].source : 'user' })
        : { id: nextId('s', [...old, ...parts.slice(0, i).map((_, k) => ({ id: `s${old.length + k + 1}` }))]), role: i === parts.length - 1 ? 'cta' : 'supporting', text: str(p, 1200), on_screen_text: '', visual_intent: '', scene_categories: [], features: [], benefits: [], emotion: '', transition: 'smooth_cut', locked: false, source: 'user' });
      if (board) board.shots = board.shots.filter(x => script.segments.some(s => s.id === x.segment_id));
      retime();
    }
  }
  if (board) {
    const shotById = id => { const s = board.shots.find(x => x.id === id); if (!s) throw new HttpError(404, 'Shot not found'); return s; };
    if (body.shot) {
      const s = shotById(body.shot.id);
      if (body.shot.scene_id !== undefined) {
        const sc = byId.get(Number(body.shot.scene_id));
        if (!sc) throw new HttpError(400, 'This scene is not usable for this ad (not in the brief, excluded, or not silent and analysed)');
        Object.assign(s, { scene_id: sc.id, asset_id: sc.asset_id, source_key: sc.proxy_key || '', visual_description: sc.description || sc.semantic || '', reason: 'Chosen by the team', source: 'user' });
        const seg = script.segments.find(x => x.id === s.segment_id);
        s.confidence = seg ? scoreScene(sc, seg, { angleIds: ctx.angles.map(a => a.id), aspect: ctx.aspect }).score : 50;
        s.source_start = sc.start; s.source_end = sc.end; // the whole scene is available; the timeline takes what it needs
      }
      if (body.shot.source_start !== undefined || body.shot.source_end !== undefined) {
        const sc = byId.get(s.scene_id);
        const a = Number(body.shot.source_start ?? s.source_start), e = Number(body.shot.source_end ?? s.source_end);
        if (!sc || !(a >= sc.start - 0.001 && e <= sc.end + 0.001 && e - a >= 0.3)) throw new HttpError(400, `Trim inside the scene (${sc?.start}-${sc?.end} s), at least 0.3 s`);
        s.source_start = round(a); s.source_end = round(e); s.source = 'user';
      }
      for (const k of ['on_screen_text', 'edit_notes']) if (body.shot[k] !== undefined) s[k] = str(body.shot[k], 300);
      if (body.shot.transition !== undefined && TRANSITIONS.includes(body.shot.transition)) s.transition = body.shot.transition;
      if (body.shot.motion !== undefined && MOTIONS.includes(body.shot.motion)) s.motion = body.shot.motion;
      if (body.shot.crop !== undefined && CROPS.includes(body.shot.crop)) s.crop = body.shot.crop;
      if (body.shot.locked !== undefined) s.locked = !!body.shot.locked;
      board = retimeStoryboard(ctx, script, board, byId); touched.storyboard = true;
    }
    if (body.add_shot) {
      const after = shotById(body.add_shot.after_id);
      const sc = byId.get(Number(body.add_shot.scene_id));
      if (!sc) throw new HttpError(400, 'This scene is not usable for this ad');
      board.shots.splice(board.shots.indexOf(after) + 1, 0, { ...after, id: nextId('k', board.shots), scene_id: sc.id, asset_id: sc.asset_id, source_key: sc.proxy_key || '', source_start: sc.start, source_end: sc.end, voiceover: '', on_screen_text: '', visual_description: sc.description || '', reason: 'Added by the team', confidence: 50, alternatives: [], warnings: [], locked: false, source: 'user' });
      board = retimeStoryboard(ctx, script, board, byId); touched.storyboard = true;
    }
    if (body.remove_shot) {
      const s = shotById(body.remove_shot);
      board.shots = board.shots.filter(x => x.id !== s.id);
      board = retimeStoryboard(ctx, script, board, byId); touched.storyboard = true;
    }
    if (body.move_shot) {
      const s = shotById(body.move_shot.id);
      const same = board.shots.filter(x => x.segment_id === s.segment_id);
      const i = same.indexOf(s), j = i + (body.move_shot.dir < 0 ? -1 : 1);
      if (j < 0 || j >= same.length) throw new HttpError(400, 'A shot moves inside its own segment (reorder segments to move more)');
      const a = board.shots.indexOf(same[i]), c = board.shots.indexOf(same[j]);
      [board.shots[a], board.shots[c]] = [board.shots[c], board.shots[a]];
      board = retimeStoryboard(ctx, script, board, byId); touched.storyboard = true;
    }
  }
  saveDocs(v.id, { ...(touched.strategy ? { strategy } : {}), ...(touched.hooks ? { hooks } : {}), ...(touched.script ? { script } : {}), ...(touched.storyboard && board ? { storyboard: board } : {}) });
  setStatus(planId, 'ready');
  revalidate(planId);
}

// ---------- Versions: save, restore, duplicate, compare, approve ----------
export function saveVersion(planId, user, label = '') {
  const plan = planRow(planId); mustEdit(plan, user);
  const v = workingVersion(planId, user.id);
  db.prepare(`UPDATE sb_versions SET frozen = 1, label = ? WHERE id = ?`).run(str(label, 80) || v.label || `Saved v${v.number}`, v.id);
  return newVersion(planId, db.prepare(`SELECT * FROM sb_versions WHERE id = ?`).get(v.id), { label: `Draft from v${v.number}`, userId: user.id });
}
export function restoreVersion(planId, versionId, user, { duplicate = false } = {}) {
  const plan = planRow(planId); mustEdit(plan, user);
  const src = db.prepare(`SELECT * FROM sb_versions WHERE id = ? AND plan_id = ?`).get(versionId, planId);
  if (!src) throw new HttpError(404, 'Version not found');
  const cur = latestVersion(planId);
  if (cur && !cur.frozen) db.prepare(`UPDATE sb_versions SET frozen = 1, label = CASE WHEN label = '' THEN ? ELSE label END WHERE id = ?`).run(`Draft v${cur.number}`, cur.id);
  const nv = newVersion(planId, src, { label: `${duplicate ? 'Copy' : 'Restored'} of v${src.number}`, userId: user.id });
  db.prepare(`UPDATE sb_versions SET approved = 0 WHERE id = ?`).run(nv.id);
  setStatus(planId, 'ready');
  revalidate(planId);
  return nv;
}
export function compareVersions(planId, aId, bId) {
  const get = id => { const v = db.prepare(`SELECT * FROM sb_versions WHERE id = ? AND plan_id = ?`).get(id, planId); if (!v) throw new HttpError(404, 'Version not found'); return { v, d: docsOf(v) }; };
  const A = get(aId), B = get(bId);
  const segs = x => x.d.script?.segments || [];
  const byIdA = new Map(segs(A).map(s => [s.id, s])), byIdB = new Map(segs(B).map(s => [s.id, s]));
  const script = [];
  for (const s of segs(B)) { const o = byIdA.get(s.id); if (!o) script.push({ id: s.id, change: 'added', after: s.text }); else if (o.text !== s.text || o.role !== s.role) script.push({ id: s.id, change: 'changed', before: o.text, after: s.text, role_before: o.role, role_after: s.role }); }
  for (const s of segs(A)) if (!byIdB.has(s.id)) script.push({ id: s.id, change: 'removed', before: s.text });
  const shots = x => x.d.storyboard?.shots || [];
  const shotA = new Map(shots(A).map(s => [s.id, s]));
  const board = [];
  for (const s of shots(B)) { const o = shotA.get(s.id); if (!o) board.push({ id: s.id, change: 'added', scene_after: s.scene_id }); else if (o.scene_id !== s.scene_id || o.source_start !== s.source_start || o.source_end !== s.source_end) board.push({ id: s.id, change: 'changed', scene_before: o.scene_id, scene_after: s.scene_id, trim_before: [o.source_start, o.source_end], trim_after: [s.source_start, s.source_end] }); }
  for (const s of shots(A)) if (!shots(B).some(x => x.id === s.id)) board.push({ id: s.id, change: 'removed', scene_before: s.scene_id });
  const strategy = Object.keys(STRATEGY_DOC.properties).filter(k => !['rev', 'source'].includes(k) && JSON.stringify(A.d.strategy?.[k]) !== JSON.stringify(B.d.strategy?.[k])).map(k => ({ field: k, before: A.d.strategy?.[k], after: B.d.strategy?.[k] }));
  const hook = (A.d.hooks?.items || []).find(h => h.id === A.d.hooks?.selected)?.text !== (B.d.hooks?.items || []).find(h => h.id === B.d.hooks?.selected)?.text
    ? { before: (A.d.hooks?.items || []).find(h => h.id === A.d.hooks?.selected)?.text, after: (B.d.hooks?.items || []).find(h => h.id === B.d.hooks?.selected)?.text } : null;
  return { a: A.v.number, b: B.v.number, strategy, hook, script, storyboard: board, seconds: [A.d.script?.est_seconds, B.d.script?.est_seconds] };
}

export function approve(planId, user) {
  const plan = planRow(planId); mustEdit(plan, user);
  const v = latestVersion(planId);
  if (!v) throw new HttpError(400, 'Nothing to approve yet');
  const val = validateVersion(plan, docsOf(v), loadContext(plan));
  db.prepare(`UPDATE sb_versions SET validation = ? WHERE id = ?`).run(JSON.stringify(val), v.id);
  if (!val.valid) throw Object.assign(new HttpError(422, 'Fix the blocking problems before approving'), { details: val });
  const prodPlan = productionPlan(plan, v, docsOf(v));
  tx(() => {
    db.prepare(`UPDATE sb_versions SET frozen = 1, approved = 1, label = ? WHERE id = ?`).run(`Approved v${v.number}`, v.id);
    db.prepare(`INSERT INTO sb_approvals (plan_id, version_id, brief_id, production_plan, approved_by) VALUES (?,?,?,?,?)`).run(planId, v.id, plan.brief_id, JSON.stringify(prodPlan), user.id);
    db.prepare(`UPDATE sb_plans SET approved_version_id = ?, status = 'approved', error = '', updated_at = datetime('now') WHERE id = ?`).run(v.id, planId);
  });
  return prodPlan;
}

// The hand-off for Modules 5-8: everything needed for voice-over, music, editing, captions and preview.
export const PRODUCTION_PLAN_VERSION = '1.0';
export function productionPlan(plan, v, d) {
  const { b, ctx } = loadContext(plan);
  const br = b.brief, sc = d.script, sb = d.storyboard;
  const hook = d.hooks?.items.find(h => h.id === d.hooks.selected) || null;
  return {
    schema_version: PRODUCTION_PLAN_VERSION, plan_id: plan.id, project_id: plan.project_id, product_id: br.product_id,
    brief: { id: b.id, version: b.version }, version: { id: v.id, number: v.number, strategy_rev: v.strategy_rev }, variation: ctx.video,
    product: { name: br.product.name }, creative_type: { id: ctx.type.id, name: ctx.type.name },
    angles: ctx.angles.map(a => ({ id: a.id, name: a.name })),
    target: { country: br.target.country, language: ctx.lang, language_name: ctx.langName, dialect: ctx.dialect, currency: br.target.currency, price: br.target.price, offer: br.target.offer, confirmed: br.target.confirmed },
    platform: br.platform, format: br.format, tone: ctx.tone, editing_pace: ctx.pace, cta: ctx.cta,
    timing: { provisional: true, authority: 'Module 5 voice-over durations replace these estimates', script_seconds: sc.est_seconds, target_seconds: sc.target_seconds },
    strategy: d.strategy, hook: hook && { id: hook.id, style: hook.style, text: hook.text, on_screen_text: hook.on_screen_text },
    voiceover: { enabled: br.production.voiceover, language: ctx.lang, dialect: ctx.dialect, tone: ctx.tone,
      segments: sc.segments.map(s => ({ id: s.id, order: s.order, role: s.role, text: s.text, est_start: s.est_start, est_end: s.est_end, emotion: s.emotion })) },
    music: { enabled: br.production.music, mood: d.strategy?.emotional_approach || ctx.tone, pace: ctx.pace },
    captions: { enabled: br.production.captions, language: ctx.lang, source: 'voiceover segments' },
    text_overlays: br.production.text_overlays ? sb.shots.filter(s => s.on_screen_text).map(s => ({ shot_id: s.id, segment_id: s.segment_id, text: s.on_screen_text, start: s.timeline_start, end: s.timeline_end, emphasis: s.text_emphasis })) : [],
    shots: sb.shots.map(s => ({ id: s.id, order: s.order, segment_id: s.segment_id, scene_id: s.scene_id, asset_id: s.asset_id, source_key: s.source_key, source_start: s.source_start, source_end: s.source_end,
      timeline_start: s.timeline_start, timeline_end: s.timeline_end, duration: s.duration, crop: s.crop, motion: s.motion, transition: s.transition, speed: s.speed, edit_notes: s.edit_notes })),
    production: br.production, footage_audio: 'excluded (silent copies only)',
    sound_effects: br.production.sound_effects, cta_screen: br.production.cta_screen, price_display: br.production.price_display,
    approved_at: new Date().toISOString(),
  };
}
export function latestApproval(planId) {
  const r = db.prepare(`SELECT * FROM sb_approvals WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(planId);
  return r ? { id: r.id, version_id: r.version_id, approved_by: r.approved_by, approved_at: r.approved_at, production_plan: JSON.parse(r.production_plan) } : null;
}
// For Modules 5-8: the approved production plan of a project's planned video.
export function approvedProductionPlan(projectId, variationIndex = 1) {
  const p = db.prepare(`SELECT * FROM sb_plans WHERE project_id = ? AND variation_index = ? AND approved_version_id IS NOT NULL ORDER BY brief_version DESC LIMIT 1`).get(projectId, variationIndex);
  return p ? latestApproval(p.id) : null;
}

// ---------- Everything the page needs ----------
export function planState(planId, user) {
  const plan = planRow(planId);
  const { b, ctx, scenes } = loadContext(plan);
  const v = latestVersion(planId);
  const d = docsOf(v);
  const versions = db.prepare(`SELECT id, number, parent_id, label, frozen, approved, strategy_rev, created_at, updated_at FROM sb_versions WHERE plan_id = ? ORDER BY number DESC`).all(planId);
  const job = db.prepare(`SELECT id, kind, target, status, stage, progress, error, attempts, created_at, finished_at FROM sb_jobs WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(planId) || null;
  const cost = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) calls, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM ai_usage WHERE ref = ?`).get(`sbplan:${planId}`);
  const latestBrief = db.prepare(`SELECT version FROM creative_briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1`).get(plan.project_id)?.version;
  return {
    plan: { ...plan, can_edit: canEdit(projectRow(plan.project_id), user), newer_brief: latestBrief > plan.brief_version ? latestBrief : null },
    context: { product: b.brief.product.name, angles: ctx.angles.map(a => ({ id: a.id, name: a.name, message: a.message })), type: { id: ctx.type.id, name: ctx.type.name, structure: ctx.type.structure },
      country: b.brief.target.country_name, language: ctx.langName, dialect: ctx.dialect, duration: ctx.duration, aspect: ctx.aspect, platform: ctx.platform,
      footage_mode: b.brief.footage.mode_label, tone: ctx.tone, pace: ctx.pace, cta: ctx.cta, video: ctx.video, usable_scenes: scenes.length },
    version: v ? { id: v.id, number: v.number, frozen: !!v.frozen, approved: !!v.approved, label: v.label, strategy_rev: v.strategy_rev } : null,
    ...d, versions, job, cost: { usd: Math.round(cost.usd * 1000) / 1000, calls: cost.calls, input_tokens: cost.i, output_tokens: cost.o },
    approval: latestApproval(planId),
    scenes: scenes.map(s => ({ id: s.id, asset_id: s.asset_id, start: s.start, end: s.end, duration: s.duration, quality: s.quality, description: s.description, semantic: s.semantic,
      categories: s.categories.map(c => c.key), flags: s.flags, orientation: s.orientation, favorite: s.favorite })),
  };
}

// Plans of a project (one per brief version and planned video).
export function listPlans(projectId) {
  return db.prepare(`SELECT p.id, p.brief_version, p.variation_index, p.status, p.approved_version_id, p.updated_at,
      (SELECT MAX(number) FROM sb_versions WHERE plan_id = p.id) AS versions FROM sb_plans p WHERE p.project_id = ? ORDER BY p.brief_version DESC, p.variation_index`).all(projectId);
}
