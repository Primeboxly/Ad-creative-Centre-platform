// Audio productions: one per approved script & storyboard version (Module 4). Versions (plan, voice, voice-over, music,
// mix, synchronized storyboard, checks), music library and preparation, mixing, storyboard synchronization, validation,
// approval and the Audio Production Package (the audio input of Modules 6 and 7). Every layer stays a separate file.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, tx } from './db.js';
import { HttpError } from './errors.js';
import { TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { validate as checkSchema } from './schema.js';
import { canEdit, projectRow, eligibleScenes } from './creative.js';
import { sceneRows } from './footage-services.js';
import { music as elMusic } from './eleven.js';
import { probeAudio, prepareMusic, mix as mixAudio, MIX_DEFAULTS } from './audio-media.js';
import { voiceoverRow, scriptHash, durationPlan, DUR } from './audio-voice.js';
import { musicPrompt, MOODS } from './audio-director.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const r2 = x => Math.round(x * 100) / 100;
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const STATUSES = ['draft', 'preparing_plan', 'selecting_voice', 'generating_voiceover', 'analyzing_timing', 'validating_duration', 'preparing_music', 'generating_music', 'mixing_audio', 'synchronizing_storyboard', 'ready', 'approved', 'failed', 'cancelled'];
export const PACKAGE_VERSION = '1.0';

// ---------- Productions ----------
export const productionRow = id => { const p = db.prepare(`SELECT * FROM au_productions WHERE id = ?`).get(id); if (!p) throw new HttpError(404, 'Audio production not found'); return p; };
export const mustEdit = (prod, user) => { if (!canEdit(projectRow(prod.project_id), user)) throw new HttpError(403, 'Only the author of this project or an admin can change its audio'); };
// The approved production plan of Module 4 that this audio production uses.
export function productionPlanOf(prod) {
  const a = db.prepare(`SELECT production_plan FROM sb_approvals WHERE version_id = ? ORDER BY id DESC LIMIT 1`).get(prod.sb_version_id);
  if (!a) throw new HttpError(409, 'The script & storyboard version of this audio is not approved any more.');
  const pp = JSON.parse(a.production_plan);
  pp.product_id = pp.product_id ?? db.prepare(`SELECT product_id FROM creative_projects WHERE id = ?`).get(prod.project_id).product_id;
  return pp;
}
export const isOutdated = prod => db.prepare(`SELECT approved_version_id FROM sb_plans WHERE id = ?`).get(prod.sb_plan_id)?.approved_version_id !== prod.sb_version_id;
// Approved script & storyboard plans of a project (one per planned video), with their audio production if any.
export function approvedPlans(projectId) {
  return db.prepare(`SELECT p.id AS sb_plan_id, p.variation_index, p.brief_version, p.approved_version_id, v.number AS sb_version_number,
      (SELECT a.id FROM au_productions a WHERE a.sb_version_id = p.approved_version_id) AS production_id
    FROM sb_plans p JOIN sb_versions v ON v.id = p.approved_version_id WHERE p.project_id = ? AND p.approved_version_id IS NOT NULL ORDER BY p.brief_version DESC, p.variation_index`).all(projectId);
}
export function getOrCreateProduction(projectId, sbPlanId, user) {
  const pr = projectRow(projectId);
  if (!canEdit(pr, user)) throw new HttpError(403, 'Only the author of this project or an admin can produce its audio');
  const plan = db.prepare(`SELECT * FROM sb_plans WHERE id = ? AND project_id = ?`).get(sbPlanId, projectId);
  if (!plan) throw new HttpError(404, 'Script & storyboard plan not found');
  if (!plan.approved_version_id) throw new HttpError(400, 'Approve the script & storyboard first (step 7).');
  const ex = db.prepare(`SELECT * FROM au_productions WHERE sb_version_id = ?`).get(plan.approved_version_id);
  if (ex) return ex;
  const id = db.prepare(`INSERT INTO au_productions (project_id, sb_plan_id, sb_version_id, brief_id, variation_index, created_by) VALUES (?,?,?,?,?,?)`)
    .run(projectId, plan.id, plan.approved_version_id, plan.brief_id, plan.variation_index, user.id).lastInsertRowid;
  return productionRow(id);
}
export const setStatus = (id, status, error = '') => db.prepare(`UPDATE au_productions SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`).run(status, error, id);

// ---------- Versions ----------
const FIELDS = ['plan', 'voice', 'music', 'mix', 'sync', 'validation', 'accept', 'locked'];
export const latestVersion = id => db.prepare(`SELECT * FROM au_versions WHERE production_id = ? ORDER BY number DESC LIMIT 1`).get(id);
export const docsOf = v => (v ? { ...Object.fromEntries(FIELDS.map(k => [k, parse(v[k], ['accept', 'locked'].includes(k) ? {} : null)])), voiceover_id: v.voiceover_id } : {});
function newVersion(prodId, from, { label = '', userId = null } = {}) {
  const n = (db.prepare(`SELECT MAX(number) n FROM au_versions WHERE production_id = ?`).get(prodId).n || 0) + 1;
  const id = db.prepare(`INSERT INTO au_versions (production_id, number, parent_id, label, plan, voice, voiceover_id, music, mix, sync, validation, accept, locked, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(prodId, n, from?.id ?? null, label, from?.plan || '', from?.voice || '', from?.voiceover_id ?? null, from?.music || '', from?.mix || '', from?.sync || '', from?.validation || '', from?.accept || '{}', from?.locked || '{}', userId).lastInsertRowid;
  return db.prepare(`SELECT * FROM au_versions WHERE id = ?`).get(id);
}
export function workingVersion(prodId, userId = null) {
  const v = latestVersion(prodId);
  if (v && !v.frozen) return v;
  return newVersion(prodId, v, { label: v ? `Draft from v${v.number}` : 'First draft', userId });
}
export function saveDocs(versionId, docs) {
  const v = db.prepare(`SELECT frozen FROM au_versions WHERE id = ?`).get(versionId);
  if (v.frozen) throw new HttpError(409, 'This version is frozen: edit the working draft');
  const sets = [], vals = [];
  for (const k of FIELDS) if (docs[k] !== undefined) { sets.push(`${k} = ?`); vals.push(docs[k] === null ? '' : JSON.stringify(docs[k])); }
  if (docs.voiceover_id !== undefined) { sets.push('voiceover_id = ?'); vals.push(docs.voiceover_id); }
  if (sets.length) db.prepare(`UPDATE au_versions SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, versionId);
}

// ---------- Music library ----------
const musicRow = m => m && ({ ...m, provider: parse(m.provider, {}), license: parse(m.license, {}), favorite: !!m.favorite });
export const musicAsset = id => musicRow(db.prepare(`SELECT * FROM music_assets WHERE id = ?`).get(id));
export function musicLibrary() {
  return db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM au_versions v WHERE json_extract(v.music, '$.asset_id') = m.id) AS used FROM music_assets m ORDER BY m.favorite DESC, m.id DESC`).all().map(musicRow);
}
export async function addMusic({ file, name, source, prompt = '', mood = '', energy = 0, style = '', tempo = null, provider = {}, license = {}, cacheKey = '', userId }) {
  const info = await probeAudio(file);
  if (!(info.duration > 1)) throw new HttpError(400, 'The music file is too short or not readable');
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  const same = db.prepare(`SELECT id FROM music_assets WHERE sha256 = ?`).get(sha);
  if (same) return { id: same.id, duplicate: true };
  const key = `music/m-${Date.now()}-${sha.slice(0, 10)}.mp3`;
  await storage.put(key, file, 'audio/mpeg');
  const id = db.prepare(`INSERT INTO music_assets (name, source, prompt, duration, mood, energy, style, tempo, storage_key, format, sample_rate, sha256, provider, license, cache_key, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(name).slice(0, 120), source, prompt, r2(info.duration), MOODS.includes(mood) ? mood : '', energy | 0, style, tempo, key, info.codec, info.sample_rate, sha, JSON.stringify(provider), JSON.stringify(license), cacheKey, userId).lastInsertRowid;
  return { id, duplicate: false };
}
export async function deleteMusic(id, user) {
  const m = musicAsset(id);
  if (!m) throw new HttpError(404, 'Track not found');
  const used = db.prepare(`SELECT COUNT(*) n FROM au_versions v JOIN au_productions p ON p.id = v.production_id WHERE json_extract(v.music, '$.asset_id') = ?`).get(id).n;
  if (used) throw new HttpError(409, `This track is used by ${used} audio version(s): it cannot be deleted.`);
  if (user.role !== 'admin' && m.created_by !== user.id) throw new HttpError(403, 'Only who added this track or an admin can delete it');
  db.prepare(`DELETE FROM music_assets WHERE id = ?`).run(id);
  await storage.remove(m.storage_key);
}
// A library track that fits (same mood, long enough or loopable), favourites first.
export function reusableTrack(mood, seconds) {
  return musicLibrary().filter(m => m.mood === mood && m.license?.commercial_use !== 'no').sort((a, b) => b.favorite - a.favorite || (b.duration >= seconds) - (a.duration >= seconds) || b.id - a.id)[0] || null;
}
// Generate (or reuse the same generation) with the ElevenLabs Music API.
export async function generateMusic({ plan, seconds, productionId, userId, force = false }) {
  const prompt = musicPrompt(plan, seconds);
  const lengthMs = Math.min(600000, Math.max(10000, Math.ceil(seconds + 2) * 1000));
  const cacheKey = hash([prompt, lengthMs]);
  if (!force) { const hit = db.prepare(`SELECT id FROM music_assets WHERE cache_key = ?`).get(cacheKey); if (hit) return { id: hit.id, reused: true }; }
  const r = await elMusic({ prompt, lengthMs, instrumental: true, productionId, userId });
  const dir = join(TMP_DIR, `mu-${Date.now()}`); mkdirSync(dir, { recursive: true });
  try {
    const f = join(dir, 'music.mp3'); writeFileSync(f, r.audio);
    const out = await addMusic({ file: f, name: `${plan.music.mood} · ${plan.music.style}`.slice(0, 80), source: 'ai', prompt, mood: plan.music.mood, energy: plan.music.energy, style: plan.music.style, tempo: plan.music.tempo_bpm,
      provider: { provider: 'elevenlabs', model: r.model, song_id: r.song_id, length_ms: lengthMs, generated_at: new Date().toISOString() },
      license: { source: 'Generated with the ElevenLabs Music API on the connected account', commercial_use: 'per_plan', note: 'Commercial use follows the terms of your ElevenLabs plan.' }, cacheKey, userId });
    return { id: out.id, reused: false };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- Music preparation and mix ----------
export async function prepareVersionMusic(prod, music, final, ctx) {
  const m = musicAsset(music.asset_id);
  if (!m) throw new HttpError(400, 'The chosen music track is not in the library any more');
  const dir = join(TMP_DIR, `mp-${prod.id}-${Date.now()}`); mkdirSync(dir, { recursive: true });
  try {
    const src = await storage.toLocal(m.storage_key, join(dir, 'src.mp3'));
    const out = join(dir, 'music.mp3');
    const processing = await prepareMusic(src, out, { length: final, start: Number(music.start) || 0, fade_in: music.fade_in ?? MIX_DEFAULTS.fade_in, fade_out: music.fade_out ?? MIX_DEFAULTS.fade_out }, ctx);
    const key = `audio/p${prod.project_id}/prod${prod.id}/music-${Date.now()}.mp3`;
    await storage.put(key, out, 'audio/mpeg');
    return { ...music, asset_id: m.id, name: m.name, processed_key: key, processing, prepared_for: final };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const MUSIC_LEVEL = { low: -14, medium: -11, high: -8 }, DUCK = { light: 3, medium: 6, strong: 10 };
export function mixConfig(plan, mix) {
  return { ...MIX_DEFAULTS, ...(plan ? { music_rel_db: MUSIC_LEVEL[plan.mix.music_level] ?? MIX_DEFAULTS.music_rel_db, duck_ratio: DUCK[plan.mix.ducking] ?? MIX_DEFAULTS.duck_ratio } : {}), ...(mix?.config || {}) };
}
export async function mixVersion(prod, d, final, ctx) {
  const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null;
  const mus = d.music?.processed_key ? d.music : null;
  if (!vo && !mus) return null;
  const dir = join(TMP_DIR, `mx-${prod.id}-${Date.now()}`); mkdirSync(dir, { recursive: true });
  try {
    const voice = vo ? await storage.toLocal(vo.storage_key, join(dir, 'voice.mp3')) : null;
    const music = mus ? await storage.toLocal(mus.processed_key, join(dir, 'music.mp3')) : null;
    const out = join(dir, 'mix.mp3');
    const cfg = mixConfig(d.plan, d.mix);
    const r = await mixAudio({ voice, music, out, length: final, cfg }, ctx);
    const key = `audio/p${prod.project_id}/prod${prod.id}/mix-${Date.now()}.mp3`;
    await storage.put(key, out, 'audio/mpeg');
    return { config: r.config, key, measured: r.measured, gains: r.gains, lead_in: r.lead_in, length: final, voiceover_id: vo?.id || null, music_key: mus?.processed_key || null, made_at: new Date().toISOString(), stale: false };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- Storyboard synchronization (real speech timing → shots) ----------
// Share a window between shots in proportion to their planned lengths, each capped by its scene's length.
function share(total, weights, caps) {
  const out = caps.map(() => 0); let left = total, open = caps.map((_, i) => i).filter(i => caps[i] > 0.005);
  for (let guard = 0; left > 0.005 && open.length && guard < 20; guard++) {
    const w = open.reduce((a, i) => a + (weights[i] || 1), 0), next = [];
    let used = 0;
    for (const i of open) { const add = Math.min(left * ((weights[i] || 1) / w), caps[i] - out[i]); out[i] += add; used += add; if (caps[i] - out[i] > 0.005) next.push(i); }
    left -= used; open = next;
  }
  return { durations: out, shortfall: Math.max(0, left) };
}
export function synchronize(pp, vo, { leadIn, final }) {
  const segs = pp.voiceover.segments;
  const actual = new Map((vo?.segments || []).map(s => [s.segment_id, s]));
  const real = !!vo && vo.alignment_source !== 'estimated';
  // Each segment's window: from its speech start to the next segment's speech start (pauses belong to the earlier segment).
  const starts = segs.map(s => (actual.has(s.id) ? actual.get(s.id).start + leadIn : s.est_start));
  const windows = segs.map((s, i) => ({ id: s.id, role: s.role, start: i === 0 ? 0 : r2(starts[i]), end: i < segs.length - 1 ? r2(starts[i + 1]) : r2(final),
    speech_start: actual.has(s.id) ? r2(actual.get(s.id).start + leadIn) : null, speech_end: actual.has(s.id) ? r2(actual.get(s.id).end + leadIn) : null, est_start: s.est_start, est_end: s.est_end }));
  const ids = [...new Set(pp.shots.map(s => s.scene_id))];
  const scenes = new Map(sceneRows(ids.length ? `s.id IN (${ids.map(() => '?').join(',')})` : '0', ids).map(s => [s.id, s]));
  const eligible = eligibleScenes(pp.product_id), usable = new Set(eligible.map(s => s.id));
  // Scenes not used by the storyboard, best first: proposed (never applied silently) when the speech outlasts the footage.
  const taken = new Set(pp.shots.map(s => s.scene_id));
  const spare = eligible.filter(s => !taken.has(s.id)).sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || b.duration - a.duration);
  const shots = [], warnings = [], proposals = [];
  for (const w of windows) {
    const mine = pp.shots.filter(s => s.segment_id === w.id);
    const len = r2(w.end - w.start);
    if (!mine.length) { warnings.push(`Segment ${w.id} has no shot.`); continue; }
    const caps = mine.map(s => { const sc = scenes.get(s.scene_id); return sc ? sc.duration : 0; });
    const fill = share(len, mine.map(s => s.duration), caps);
    let t = w.start;
    mine.forEach((s, i) => {
      const sc = scenes.get(s.scene_id);
      let dur = fill.durations[i];
      const warn = [];
      if (!sc) warn.push('Scene deleted');
      else if (!usable.has(s.scene_id)) warn.push('Scene no longer usable (excluded or not silent)');
      if (i === mine.length - 1 && fill.shortfall > 0.05) {
        dur += fill.shortfall; warn.push(`Footage ${r2(fill.shortfall)} s too short for the real speech: hold or add a shot`);
        const alt = spare.find(x => x.duration >= Math.min(fill.shortfall, 1.5) && !taken.has(x.id));
        if (alt) taken.add(alt.id);
        proposals.push({ shot_id: s.id, segment_id: w.id, kind: alt ? 'add_shot' : 'visual_pause', scene_id: alt?.id ?? null, seconds: r2(fill.shortfall), note: alt ? `Add scene ${alt.id} after shot ${s.id}` : 'No alternative scene: keep a short visual pause (hold) or shorten the segment' });
      }
      const useLen = sc ? Math.min(dur, sc.duration) : 0;
      let a = s.source_start;
      if (sc && a + useLen > sc.end) a = Math.max(sc.start, sc.end - useLen);
      const change = s.duration ? Math.abs(dur - s.duration) / s.duration : 0;
      shots.push({ id: s.id, order: shots.length + 1, segment_id: w.id, scene_id: s.scene_id, asset_id: s.asset_id, source_key: s.source_key,
        source_start: r2(a), source_end: r2(a + useLen), timeline_start: r2(t), timeline_end: r2(t + dur), duration: r2(dur), old_duration: s.duration,
        change: r2(change), needs_review: change > 0.3, crop: s.crop, motion: s.motion, transition: s.transition, speed: 1, edit_notes: s.edit_notes, warnings: warn });
      t += dur;
    });
  }
  const cta = windows.at(-1);
  if (cta && cta.end - cta.start < 1) warnings.push(`The final CTA lasts only ${r2(cta.end - cta.start)} s.`);
  if (!real) warnings.push('Timing is estimated (no alignment): check it before approval.');
  return { source: real ? 'voiceover' : 'estimated', lead_in: leadIn, final_duration: r2(final), segments: windows, shots, warnings, proposals,
    review: shots.filter(s => s.needs_review).map(s => s.id), made_at: new Date().toISOString(), stale: false };
}

// ---------- Validation ----------
export function validateAudio(prod, d) {
  const errors = [], warnings = [];
  const E = (code, message) => errors.push({ code, message }), W = (code, message) => warnings.push({ code, message });
  let pp;
  try { pp = productionPlanOf(prod); } catch (e) { E('plan', e.message); return { errors, warnings, valid: false, checked_at: new Date().toISOString() }; }
  if (isOutdated(prod)) E('outdated', 'The script & storyboard changed (a newer version was approved): this audio belongs to the old version. Open the newest version to make its audio.');
  const pref = pp.production || {};
  const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null;
  if (pref.voiceover !== false) {
    if (!vo) E('no_voiceover', 'No voice-over yet.');
    else {
      if (vo.script_hash !== scriptHash(pp, prod.sb_version_id)) E('voiceover_script', 'The voice-over was made from a different script: regenerate it.');
      if (vo.alignment_source === 'estimated' && !d.accept?.estimated_timing) E('timing_estimated', 'Speech timing is only estimated (ElevenLabs returned no alignment): confirm "accept estimated timing" or regenerate.');
      if (vo.alignment_source === 'provider_normalized' || vo.alignment_source === 'provider_partial') W('timing_approx', 'Part of the timing was mapped approximately.');
      const dur = durationPlan(vo.duration, pp.format.duration_seconds, mixConfig(d.plan, d.mix).lead_in, vo.settings.speed || 1);
      if (dur.case === 'too_long' && !d.accept?.long_duration) E('too_long', `${dur.action}`);
      else if (dur.case !== 'fits') W('long', dur.action);
      if (vo.note.includes('differs')) W('uneven', vo.note);
    }
  }
  if (pref.music !== false) {
    const mode = d.music?.mode || 'ai';
    if (mode === 'none') W('no_music', 'No background music.');
    else if (!d.music?.asset_id) W('music_missing', d.music?.fallback || 'No music track yet.');
    else {
      const m = musicAsset(d.music.asset_id);
      if (!m) E('music_gone', 'The music track was deleted.');
      else if (m.source === 'upload' && !m.license?.confirmed_by) E('music_license', 'Confirm that you own or licensed the uploaded music.');
      if (d.music.fallback) W('music_fallback', d.music.fallback);
    }
  }
  if ((vo || d.music?.asset_id) && !d.mix?.key) E('no_mix', 'The audio is not mixed yet.');
  if (d.mix?.stale) E('mix_stale', 'Voice or music changed: mix again.');
  if (d.mix?.measured?.mix) {
    const m = d.mix.measured.mix;
    if (m.tp != null && m.tp > -0.5) E('clipping', `The mix peaks at ${m.tp} dBTP: risk of clipping.`);
    else if (m.tp != null && m.tp > -1) W('peak', `The mix peaks at ${m.tp} dBTP.`);
    if (m.i != null && Math.abs(m.i - d.mix.config.final_lufs) > 2) W('loudness', `Mix loudness ${m.i} LUFS (target ${d.mix.config.final_lufs}).`);
  }
  const s = d.sync;
  if (!s) E('no_sync', 'The storyboard is not synchronized yet.');
  else {
    if (s.stale) E('sync_stale', 'The voice-over changed: synchronize again.');
    let t = 0;
    for (const x of s.shots) {
      if (Math.abs(x.timeline_start - t) > 0.06) E('gap', `Shot ${x.id}: gap or overlap at ${t.toFixed(2)} s.`);
      if (!(x.duration > 0)) E('duration', `Shot ${x.id}: duration must be positive.`);
      if (x.warnings.some(w => /deleted|no longer usable/.test(w))) E('scene', `Shot ${x.id}: ${x.warnings.join(', ')}`);
      t = x.timeline_end;
    }
    if (Math.abs(t - s.final_duration) > 0.1) E('total', `Shots end at ${r2(t)} s but the audio lasts ${s.final_duration} s.`);
    for (const w of s.warnings) W('sync', w);
    for (const p of s.proposals) W('proposal', `Shot ${p.shot_id}: ${p.note}.`);
    if (s.review.length) W('review', `${s.review.length} shot(s) changed length by more than 30 %: review them.`);
  }
  return { errors, warnings, valid: !errors.length, checked_at: new Date().toISOString() };
}
export function revalidate(prodId) {
  const v = latestVersion(prodId);
  if (!v) return null;
  const val = validateAudio(productionRow(prodId), docsOf(v));
  db.prepare(`UPDATE au_versions SET validation = ? WHERE id = ?`).run(JSON.stringify(val), v.id);
  return val;
}

// ---------- Caption timing (for Module 7) ----------
export function captionTiming(prodOrPackage) {
  const vo = typeof prodOrPackage === 'object' ? prodOrPackage : null;
  const v = vo?.voiceover ? null : docsOf(latestVersion(prodOrPackage));
  const row = vo ? voiceoverRow(vo.voiceover.id) : v?.voiceover_id ? voiceoverRow(v.voiceover_id) : null;
  if (!row) return null;
  const lead = vo ? vo.mix?.lead_in ?? 0 : v.mix?.lead_in ?? 0;
  return { language: row.language, source: row.alignment_source, confidence: row.alignment_source === 'provider' ? 'high' : row.alignment_source === 'estimated' ? 'low' : 'medium', offset: lead,
    words: row.words.map(w => ({ ...w, start: r2(w.start + lead), end: r2(w.end + lead) })), sentences: row.sentences.map(s => ({ ...s, start: r2(s.start + lead), end: r2(s.end + lead) })),
    segments: row.segments.map(s => ({ segment_id: s.segment_id, text: s.text, spoken: s.speech_text, start: r2(s.start + lead), end: r2(s.end + lead) })) };
}

// ---------- Approval and package ----------
const S = { type: 'string' }, N = { type: 'number' }, I = { type: 'integer' };
const objR = (p, r = Object.keys(p)) => ({ type: 'object', required: r, properties: p });
export const PACKAGE_SCHEMA = objR({
  schema_version: S, production_id: I, project_id: I, variation_index: I, brief: objR({ id: I, version: I }), script_version: objR({ id: I, number: I }), storyboard_version: objR({ id: I, number: I }),
  audio_version: objR({ id: I, number: I }), plan: { type: ['object', 'null'] }, voice: { type: ['object', 'null'] }, voiceover: { type: ['object', 'null'] }, music: { type: ['object', 'null'] },
  mix: { type: ['object', 'null'] }, synchronized_storyboard: { type: 'object' }, final_duration: N, captions: { type: ['object', 'null'] }, original_footage_audio: S, validation: { type: 'object' }, approval: { type: 'object' },
});
export function approve(prodId, user) {
  const prod = productionRow(prodId); mustEdit(prod, user);
  const v = latestVersion(prodId);
  if (!v) throw new HttpError(400, 'Nothing to approve yet');
  const d = docsOf(v);
  const val = validateAudio(prod, d);
  db.prepare(`UPDATE au_versions SET validation = ? WHERE id = ?`).run(JSON.stringify(val), v.id);
  if (!val.valid) throw Object.assign(new HttpError(422, 'Fix the blocking problems before approving'), { details: val });
  const pp = productionPlanOf(prod);
  const sbv = db.prepare(`SELECT id, number FROM sb_versions WHERE id = ?`).get(prod.sb_version_id);
  const brief = db.prepare(`SELECT id, version FROM creative_briefs WHERE id = ?`).get(prod.brief_id);
  const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null;
  const m = d.music?.asset_id ? musicAsset(d.music.asset_id) : null;
  const pkg = {
    schema_version: PACKAGE_VERSION, production_id: prod.id, project_id: prod.project_id, variation_index: prod.variation_index,
    brief: { id: brief.id, version: brief.version }, script_version: { id: sbv.id, number: sbv.number }, storyboard_version: { id: sbv.id, number: sbv.number }, audio_version: { id: v.id, number: v.number },
    plan: d.plan, voice: d.voice ? { ...d.voice } : null,
    voiceover: vo ? { id: vo.id, storage_key: vo.storage_key, voice_id: vo.voice_id, voice_name: vo.voice_name, model_id: vo.model_id, settings: vo.settings, language: vo.language, duration: vo.duration,
      format: vo.format, alignment_source: vo.alignment_source, speech_text: vo.speech.text, segments: vo.segments } : null,
    music: m ? { asset_id: m.id, name: m.name, source: m.source, storage_key: m.storage_key, processed_key: d.music.processed_key, processing: d.music.processing, license: m.license, provider: m.provider } : null,
    mix: d.mix ? { key: d.mix.key, config: d.mix.config, gains: d.mix.gains, measured: d.mix.measured, lead_in: d.mix.lead_in } : null,
    synchronized_storyboard: d.sync, final_duration: d.sync?.final_duration ?? d.mix?.length ?? 0,
    captions: vo ? captionTiming(prodId) : null, original_footage_audio: 'excluded', validation: val,
    approval: { approved_by: user.name, approved_at: new Date().toISOString(), status: 'approved' },
  };
  const errs = checkSchema(PACKAGE_SCHEMA, pkg);
  if (errs.length) throw new HttpError(500, 'The package does not match its schema: ' + errs.slice(0, 3).join('; '));
  tx(() => {
    db.prepare(`UPDATE au_versions SET frozen = 1, approved = 1, label = ? WHERE id = ?`).run(`Approved v${v.number}`, v.id);
    db.prepare(`INSERT INTO au_approvals (production_id, version_id, package, approved_by) VALUES (?,?,?,?)`).run(prodId, v.id, JSON.stringify(pkg), user.id);
    db.prepare(`UPDATE au_productions SET approved_version_id = ?, status = 'approved', error = '', updated_at = datetime('now') WHERE id = ?`).run(v.id, prodId);
  });
  return pkg;
}
export function latestPackage(prodId) {
  const r = db.prepare(`SELECT * FROM au_approvals WHERE production_id = ? ORDER BY id DESC LIMIT 1`).get(prodId);
  return r ? { id: r.id, version_id: r.version_id, approved_at: r.approved_at, package: JSON.parse(r.package) } : null;
}
// For Modules 6 and 7: the approved audio package of a project's planned video (newest approved script version).
export function approvedAudioPackage(projectId, variationIndex = 1) {
  const p = db.prepare(`SELECT a.id FROM au_productions a JOIN sb_plans s ON s.id = a.sb_plan_id WHERE a.project_id = ? AND a.variation_index = ? AND a.approved_version_id IS NOT NULL AND s.approved_version_id = a.sb_version_id ORDER BY a.id DESC LIMIT 1`).get(projectId, variationIndex);
  return p ? latestPackage(p.id) : null;
}
// Re-check an approved package before use (files and scenes still there, script still the approved one).
export async function checkPackage(pkg) {
  const problems = [];
  for (const k of [pkg.voiceover?.storage_key, pkg.music?.processed_key, pkg.mix?.key].filter(Boolean)) if (!(await storage.exists(k))) problems.push(`Missing file: ${k}`);
  const prod = db.prepare(`SELECT * FROM au_productions WHERE id = ?`).get(pkg.production_id);
  if (!prod) problems.push('The audio production was deleted.'); else if (isOutdated(prod)) problems.push('The script & storyboard were changed and approved again since this audio.');
  const usable = new Set(eligibleScenes(db.prepare(`SELECT product_id FROM creative_projects WHERE id = ?`).get(pkg.project_id)?.product_id ?? 0).map(s => s.id));
  const gone = (pkg.synchronized_storyboard?.shots || []).filter(s => !usable.has(s.scene_id)).map(s => s.id);
  if (gone.length) problems.push(`Shots whose scene is no longer usable: ${gone.join(', ')}`);
  return { ok: !problems.length, problems };
}

// ---------- Versions: save, restore, compare ----------
export function saveVersion(prodId, user, label = '') {
  const prod = productionRow(prodId); mustEdit(prod, user);
  const v = workingVersion(prodId, user.id);
  db.prepare(`UPDATE au_versions SET frozen = 1, label = ? WHERE id = ?`).run(String(label).slice(0, 80) || v.label || `Saved v${v.number}`, v.id);
  return newVersion(prodId, db.prepare(`SELECT * FROM au_versions WHERE id = ?`).get(v.id), { label: `Draft from v${v.number}`, userId: user.id });
}
export function restoreVersion(prodId, versionId, user) {
  const prod = productionRow(prodId); mustEdit(prod, user);
  const src = db.prepare(`SELECT * FROM au_versions WHERE id = ? AND production_id = ?`).get(versionId, prodId);
  if (!src) throw new HttpError(404, 'Version not found');
  const cur = latestVersion(prodId);
  if (cur && !cur.frozen) db.prepare(`UPDATE au_versions SET frozen = 1 WHERE id = ?`).run(cur.id);
  const nv = newVersion(prodId, src, { label: `Restored v${src.number}`, userId: user.id });
  setStatus(prodId, 'ready'); revalidate(prodId);
  return nv;
}
export function compareVersions(prodId, a, b) {
  const get = id => { const v = db.prepare(`SELECT * FROM au_versions WHERE id = ? AND production_id = ?`).get(id, prodId); if (!v) throw new HttpError(404, 'Version not found'); return { v, d: docsOf(v) }; };
  const A = get(a), B = get(b);
  const vo = x => (x.d.voiceover_id ? voiceoverRow(x.d.voiceover_id) : null);
  const va = vo(A), vb = vo(B);
  const changes = [];
  const add = (field, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) changes.push({ field, before: x ?? null, after: y ?? null }); };
  add('voice', va && `${va.voice_name} · ${va.model_id}`, vb && `${vb.voice_name} · ${vb.model_id}`);
  add('voice settings', va?.settings, vb?.settings);
  add('voice-over duration (s)', va?.duration, vb?.duration);
  add('voice-over', va?.id, vb?.id);
  add('music', A.d.music && `${A.d.music.mode}${A.d.music.name ? ` · ${A.d.music.name}` : ''}`, B.d.music && `${B.d.music.mode}${B.d.music.name ? ` · ${B.d.music.name}` : ''}`);
  add('music processing', A.d.music?.processing, B.d.music?.processing);
  add('mix settings', A.d.mix?.config && { music_rel_db: A.d.mix.config.music_rel_db, ducking: A.d.mix.config.ducking, final_lufs: A.d.mix.config.final_lufs }, B.d.mix?.config && { music_rel_db: B.d.mix.config.music_rel_db, ducking: B.d.mix.config.ducking, final_lufs: B.d.mix.config.final_lufs });
  add('mix loudness', A.d.mix?.measured?.mix, B.d.mix?.measured?.mix);
  add('timeline (s)', A.d.sync?.final_duration, B.d.sync?.final_duration);
  return { a: A.v.number, b: B.v.number, changes, voiceovers: [va?.id ?? null, vb?.id ?? null], mixes: [A.d.mix?.key ?? null, B.d.mix?.key ?? null] };
}

// ---------- Everything the page needs ----------
export function productionState(prodId, user) {
  const prod = productionRow(prodId);
  const v = latestVersion(prodId), d = docsOf(v);
  let pp = null, ppError = '';
  try { pp = productionPlanOf(prod); } catch (e) { ppError = e.message; }
  const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null;
  const usage = db.prepare(`SELECT COALESCE(SUM(characters),0) chars, COALESCE(SUM(seconds),0) secs, COUNT(*) calls, COALESCE(SUM(provider_cost),0) cost FROM audio_usage WHERE production_id = ? AND ok = 1`).get(prodId);
  const ai = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) calls FROM ai_usage WHERE ref = ?`).get(`audio:${prodId}`);
  const job = db.prepare(`SELECT id, kind, target, status, stage, progress, error, failed_stage, attempts, created_at, finished_at FROM au_jobs WHERE production_id = ? ORDER BY id DESC LIMIT 1`).get(prodId) || null;
  const lead = mixConfig(d.plan, d.mix).lead_in;
  return {
    production: { ...prod, outdated: isOutdated(prod), can_edit: canEdit(projectRow(prod.project_id), user) }, pp_error: ppError,
    context: pp && { product: pp.product?.name, angles: (pp.angles || []).map(a => a.name), creative_type: pp.creative_type?.name, language: pp.target?.language_name, dialect: pp.target?.dialect,
      country: pp.target?.country, duration: pp.format?.duration_seconds, script_version: db.prepare(`SELECT number FROM sb_versions WHERE id = ?`).get(prod.sb_version_id)?.number,
      production: pp.production, segments: pp.voiceover.segments, shots: pp.shots, estimated_seconds: pp.timing?.script_seconds },
    version: v ? { id: v.id, number: v.number, frozen: !!v.frozen, approved: !!v.approved, label: v.label } : null,
    ...d, voiceover: vo, duration: vo && pp ? durationPlan(vo.duration, pp.format.duration_seconds, lead, vo.settings.speed || 1) : null,
    music_asset: d.music?.asset_id ? musicAsset(d.music.asset_id) : null,
    voiceovers: db.prepare(`SELECT id, parent_id, voice_name, model_id, duration, alignment_source, characters, note, created_at FROM au_voiceovers WHERE production_id = ? ORDER BY id DESC`).all(prodId),
    versions: db.prepare(`SELECT id, number, label, frozen, approved, voiceover_id, created_at, updated_at FROM au_versions WHERE production_id = ? ORDER BY number DESC`).all(prodId),
    job, usage: { characters: usage.chars, music_seconds: r2(usage.secs), calls: usage.calls, provider_cost: usage.cost || null, ai_usd: Math.round(ai.usd * 1000) / 1000, ai_calls: ai.calls },
    package: latestPackage(prodId),
  };
}
export { DUR };

// ---------- Team edits (an edit to an approved/frozen version goes to a new working draft) ----------
const MUSIC_MODES = ['ai', 'library', 'upload', 'none'];
export function applyEdit(prodId, body, user) {
  const prod = productionRow(prodId); mustEdit(prod, user);
  const v = workingVersion(prodId, user.id);
  const d = docsOf(v), up = {};
  const stale = (mix, sync) => { if (mix && d.mix) up.mix = { ...(up.mix || d.mix), stale: true }; if (sync && d.sync) up.sync = { ...d.sync, stale: true }; };
  if (body.voice) {
    const b = body.voice;
    const voice = { ...(d.voice || {}) };
    if (b.mode === 'auto') { voice.mode = 'auto'; delete voice.voice_id; }
    if (b.voice_id) { if (!db.prepare(`SELECT 1 FROM el_voices WHERE voice_id = ? AND available = 1`).get(String(b.voice_id))) throw new HttpError(400, 'This voice is not on the ElevenLabs account'); voice.mode = 'manual'; voice.voice_id = String(b.voice_id); }
    if (b.model_id !== undefined) voice.model_wanted = String(b.model_id || '');
    if (b.settings) voice.custom_settings = b.settings === 'reset' ? null : Object.fromEntries(['stability', 'similarity_boost', 'style', 'speed', 'use_speaker_boost'].filter(k => b.settings[k] !== undefined).map(k => [k, k === 'use_speaker_boost' ? !!b.settings[k] : Number(b.settings[k])]));
    if (b.auto_speed !== undefined) voice.auto_speed = !!b.auto_speed;
    up.voice = voice;
  }
  if (body.music) {
    const b = body.music, m = { ...(d.music || {}) };
    if (b.mode !== undefined) { if (!MUSIC_MODES.includes(b.mode)) throw new HttpError(400, 'Unknown music mode'); m.mode = b.mode; if (b.mode === 'none') { delete m.asset_id; delete m.processed_key; } }
    if (b.asset_id !== undefined) { const a = musicAsset(Number(b.asset_id)); if (!a) throw new HttpError(404, 'Track not found'); m.asset_id = a.id; m.name = a.name; m.mode = a.source === 'upload' ? 'upload' : 'library'; delete m.fallback; }
    for (const k of ['start', 'fade_in', 'fade_out']) if (b[k] !== undefined) m[k] = Math.max(0, Math.min(k === 'start' ? 600 : 10, Number(b[k]) || 0));
    delete m.processed_key; m.prepared_for = null;
    up.music = m; stale(true, false);
  }
  if (body.mix) {
    const cfg = { ...(d.mix?.config || {}) };
    for (const k of ['music_rel_db', 'voice_gain_db', 'music_gain_db', 'final_lufs', 'true_peak', 'duck_ratio', 'fade_in', 'fade_out', 'lead_in']) if (body.mix[k] !== undefined && Number.isFinite(Number(body.mix[k]))) cfg[k] = Number(body.mix[k]);
    if (body.mix.ducking !== undefined) cfg.ducking = !!body.mix.ducking;
    if (body.mix.reset) Object.keys(cfg).forEach(k => delete cfg[k]);
    cfg.true_peak = Math.min(-1, cfg.true_peak ?? MIX_DEFAULTS.true_peak); // never allow a ceiling that can clip
    up.mix = { ...(d.mix || {}), config: cfg, stale: true };
    if (body.mix.lead_in !== undefined) stale(false, true);
  }
  if (body.accept) up.accept = { ...d.accept, ...Object.fromEntries(['estimated_timing', 'long_duration'].filter(k => body.accept[k] !== undefined).map(k => [k, !!body.accept[k]])) };
  if (body.locked) up.locked = { ...d.locked, ...Object.fromEntries(['voiceover', 'music'].filter(k => body.locked[k] !== undefined).map(k => [k, !!body.locked[k]])) };
  if (body.voiceover_id !== undefined) {
    const vo = db.prepare(`SELECT id FROM au_voiceovers WHERE id = ? AND production_id = ?`).get(Number(body.voiceover_id), prodId);
    if (!vo) throw new HttpError(404, 'Voice-over not found');
    up.voiceover_id = vo.id; stale(true, true);
  }
  if (body.sync_apply) { // accept proposals: the shots marked for review are confirmed by the team
    if (!d.sync) throw new HttpError(400, 'Nothing synchronized yet');
    up.sync = { ...d.sync, review: [], shots: d.sync.shots.map(s => ({ ...s, needs_review: false, reviewed: true })) };
  }
  saveDocs(v.id, up);
  if (prod.status === 'approved') setStatus(prodId, 'ready');
  revalidate(prodId);
}
