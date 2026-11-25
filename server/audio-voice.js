// Voice-over: voice and model choice, generation with ElevenLabs timestamps, mapping of the real timing back to the
// script segment ids (words, sentences, segments), segment regeneration spliced into the full take, duration checks.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { tts, models as elModels, pickModel, voiceRows, voiceLanguageFit, dictionaryFor, subscription, DEFAULT_SETTINGS, SETTING_RANGES } from './eleven.js';
import { buildSpeech, rulesFor } from './audio-text.js';
import { probeAudio, loudness, peaks, splice, concatAudio } from './audio-media.js';

const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v >= 0 ? v : d; };
export const DUR = { fit: num('AU_FIT_TOLERANCE', 0.05), long: num('AU_LONG_TOLERANCE', 0.2), ctaHold: num('AU_CTA_HOLD', 1), maxChars: num('AU_MAX_CHARS', 0) };
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const r2 = x => Math.round(x * 100) / 100;
export const scriptHash = (pp, sbVersionId) => hash([sbVersionId, pp.voiceover.segments.map(s => [s.id, s.text])]);

// ---------- Voice and model ----------
export function candidateVoices(lang) {
  return voiceRows().map(v => ({ ...v, fit: voiceLanguageFit(v, lang) })).filter(v => v.fit.level !== 'none')
    .sort((a, b) => ({ verified: 3, likely: 2, unknown: 1 }[b.fit.level] - { verified: 3, likely: 2, unknown: 1 }[a.fit.level]) || b.favorite - a.favorite);
}
// Choice order: the team's manual choice → preferred voice for the market → for the creative type → AI ranking → best language fit.
export function chooseVoice({ voice, plan, pp }) {
  const lang = pp.target.language, all = voiceRows(), byId = id => all.find(v => v.voice_id === id);
  const fitOk = v => v && voiceLanguageFit(v, lang).level !== 'none';
  const why = [];
  let v = null, source = '';
  if (voice?.mode === 'manual' && voice.voice_id) { v = byId(voice.voice_id); source = 'manual'; if (!v) throw new HttpError(400, 'The chosen voice is no longer on the ElevenLabs account: choose another one.'); }
  if (!v) { const p = db.prepare(`SELECT voice_id FROM voice_preferences WHERE scope = 'market' AND scope_key = ?`).get(`${pp.target.country}:${lang}`); if (p && fitOk(byId(p.voice_id))) { v = byId(p.voice_id); source = 'market preference'; } }
  if (!v) { const p = db.prepare(`SELECT voice_id FROM voice_preferences WHERE scope = 'type' AND scope_key = ?`).get(pp.creative_type.id); if (p && fitOk(byId(p.voice_id))) { v = byId(p.voice_id); source = 'creative type preference'; } }
  if (!v) for (const r of plan?.voice_ranking || []) if (fitOk(byId(r.voice_id))) { v = byId(r.voice_id); source = 'AI recommendation'; why.push(r.reason); break; }
  if (!v) { v = candidateVoices(lang)[0]; source = 'best language match'; }
  if (!v) throw new HttpError(400, `No voice on the ElevenLabs account speaks ${pp.target.language_name || lang}. Add one in ElevenLabs (Voice Library) and refresh the voice library.`);
  const fit = voiceLanguageFit(v, lang);
  const limits = [];
  if (fit.level !== 'verified') limits.push(`${v.name} is not verified for ${pp.target.language_name || lang} on ElevenLabs: listen to the result.`);
  if (pp.target.dialect && !fit.accents.some(a => pp.target.dialect.toLowerCase().includes(a.toLowerCase()))) limits.push(`No ${pp.target.dialect} accent is listed for ${v.name}${fit.accents.length ? ` (listed: ${fit.accents.join(', ')})` : ''}: closest available voice used.`);
  return { voice: v, source, fit, limitations: limits, reasons: why };
}
export async function chooseModel(pp, wanted = '') {
  const list = await elModels();
  if (wanted) { const m = list.find(x => x.model_id === wanted); if (!m) throw new HttpError(400, `Model ${wanted} is not available on this account`); return m; }
  const m = pickModel(list, pp.target.language, pp.target.language_name);
  if (!m) throw new HttpError(400, `No ElevenLabs model on this account supports ${pp.target.language_name || pp.target.language}.`);
  return m;
}
// Settings sent to ElevenLabs: the AI plan's (or the team's), kept inside ranges and to what the model supports.
export function modelSettings(model, s) {
  const clamp = (x, [a, b], d) => (Number.isFinite(Number(x)) ? Math.max(a, Math.min(b, Number(x))) : d);
  const out = { stability: clamp(s?.stability, SETTING_RANGES.stability, DEFAULT_SETTINGS.stability), similarity_boost: clamp(s?.similarity_boost, SETTING_RANGES.similarity_boost, DEFAULT_SETTINGS.similarity_boost), speed: clamp(s?.speed, SETTING_RANGES.speed, 1) };
  if (model.can_use_style) out.style = clamp(s?.style, SETTING_RANGES.style, 0);
  if (model.can_use_speaker_boost) out.use_speaker_boost = s?.use_speaker_boost !== false;
  return out;
}

// ---------- Timing from the alignment ----------
// Times of the words, sentences and segments of the spoken text. source: provider | provider_normalized | estimated
export function timingFrom(speech, alignment, duration) {
  const text = speech.text;
  let starts, ends, source = 'provider';
  if (alignment && alignment.characters?.join('') === text) { starts = alignment.character_start_times_seconds; ends = alignment.character_end_times_seconds; }
  else if (alignment?.characters?.length) {
    // Text changed by the provider's own normalisation: map characters by position (approximate).
    source = 'provider_normalized';
    const k = alignment.characters.length / text.length;
    starts = [...text].map((_, i) => alignment.character_start_times_seconds[Math.min(alignment.characters.length - 1, Math.floor(i * k))]);
    ends = [...text].map((_, i) => alignment.character_end_times_seconds[Math.min(alignment.characters.length - 1, Math.floor((i + 1) * k) - 1 < 0 ? 0 : Math.floor((i + 1) * k) - 1)]);
  } else {
    source = 'estimated';
    const per = duration / Math.max(1, text.length);
    starts = [...text].map((_, i) => i * per); ends = [...text].map((_, i) => (i + 1) * per);
  }
  const span = (a, b) => { // first and last non-space character in [a, b)
    let i = a, j = b - 1;
    while (i < b && /\s/.test(text[i])) i++;
    while (j >= a && /\s/.test(text[j])) j--;
    return i <= j ? { start: r2(starts[i]), end: r2(ends[j]) } : null;
  };
  const segments = speech.parts.map((p, i) => ({ segment_id: p.segment_id, order: i + 1, role: p.role, text: p.text, speech_text: p.speech_text, ...(span(p.from, p.to) || { start: 0, end: 0 }) }));
  const words = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’\-.,]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu)) {
    const a = m.index, b = a + m[0].length;
    const part = speech.parts.find(p => a >= p.from && a < p.to + 1);
    const t = span(a, b);
    if (t) words.push({ word: m[0], start: t.start, end: t.end, segment_id: part?.segment_id || null, char_start: a, char_end: b, original: part && part.text === part.speech_text ? m[0] : null });
  }
  const sentences = [];
  for (const p of speech.parts) {
    let from = p.from;
    for (const m of p.speech_text.matchAll(/[^.!?…]+[.!?…]*/g)) {
      const a = p.from + m.index, b = a + m[0].length;
      const t = span(a, b);
      if (t && m[0].trim()) sentences.push({ text: m[0].trim(), segment_id: p.segment_id, ...t });
      from = b;
    }
    void from;
  }
  return { source, segments, words, sentences, alignment: { chars: text, starts: starts.map(r2), ends: ends.map(r2) } };
}

// ---------- Generation ----------
// Generate (or reuse) the full voice-over of a production. Returns the au_voiceovers row id.
export async function generateVoiceover({ production, pp, voiceChoice, model, settings, plan, userId, ctx, force = false, applyAiPronunciation = true }) {
  const lang = pp.target.language;
  const rules = rulesFor(pp.product_id, lang);
  const aiRules = applyAiPronunciation ? (plan?.pronunciation || []).filter(r => r.term && r.spoken && r.term !== r.spoken).map(r => ({ type: 'alias', term: r.term, spoken: r.spoken })) : [];
  const alias = [...rules.filter(r => r.type === 'alias'), ...aiRules.filter(a => !rules.some(r => r.term.toLowerCase() === a.term.toLowerCase()))];
  const speech = buildSpeech(pp.voiceover.segments, lang, alias, pp.target.currency);
  let dictionaries = [], dictNote = '';
  const phon = rules.filter(r => r.type === 'phoneme');
  if (phon.length) { try { dictionaries = await dictionaryFor(phon); } catch (e) { dictNote = `Phoneme rules not applied: ${e.message}`; } }
  const sh = scriptHash(pp, production.sb_version_id);
  const cacheKey = hash([sh, speech.text, voiceChoice.voice.voice_id, model.model_id, settings, lang, dictionaries]);
  if (!force) {
    const same = db.prepare(`SELECT v.id FROM au_voiceovers v JOIN au_productions p ON p.id = v.production_id WHERE v.cache_key = ? AND p.project_id = ? ORDER BY v.id DESC LIMIT 1`).get(cacheKey, production.project_id);
    if (same) return { id: same.id, reused: true };
  }
  const chars = Math.ceil(speech.text.length * (model.cost_multiplier || 1));
  if (DUR.maxChars && speech.text.length > DUR.maxChars) throw new HttpError(400, `The voice-over has ${speech.text.length} characters, above the budget AU_MAX_CHARS (${DUR.maxChars}).`);
  const sub = await subscription().catch(() => null);
  if (sub && sub.character_limit && sub.character_count + chars > sub.character_limit && !sub.can_extend) throw new HttpError(402, `Not enough ElevenLabs credits: about ${chars} needed, ${sub.character_limit - sub.character_count} left this period.`);
  // Long scripts: several requests split between segments, linked with previous/next text and request ids for continuity.
  const max = Math.max(500, (model.max_chars || 5000) - 50);
  const groups = [];
  for (const p of speech.parts) { const g = groups.at(-1); if (g && g.reduce((n, x) => n + x.speech_text.length + 1, 0) + p.speech_text.length <= max) g.push(p); else groups.push([p]); }
  const work = join(TMP_DIR, `vo-${production.id}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const files = [], aligns = [], reqIds = [];
    let offset = 0;
    for (const [gi, g] of groups.entries()) {
      ctx?.check?.();
      const text = g.map(p => p.speech_text).join(' ');
      const prev = groups.slice(0, gi).flat().map(p => p.speech_text).join(' ').slice(-1000), next = groups.slice(gi + 1).flat().map(p => p.speech_text).join(' ').slice(0, 1000);
      const r = await tts({ voiceId: voiceChoice.voice.voice_id, modelId: model.model_id, text, settings, languageCode: lang, previousText: prev, nextText: next, previousRequestIds: reqIds, dictionaries, productionId: production.id, userId });
      const f = join(work, `part${gi}.mp3`);
      writeFileSync(f, r.audio);
      const d = (await probeAudio(f)).duration;
      files.push(f); reqIds.push(r.request_id);
      aligns.push(r.alignment ? { ...r.alignment, offset, sep: gi ? ' ' : '' } : null);
      offset += d;
    }
    const full = join(work, 'voice.mp3');
    if (files.length > 1) await concatAudio(files, full, ctx); else copyFileSync(files[0], full);
    const info = await probeAudio(full);
    // Join the chunk alignments (a space between chunks, timed at the join).
    let alignment = null;
    if (aligns.every(Boolean)) {
      alignment = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
      for (const a of aligns) {
        if (a.sep) { alignment.characters.push(' '); alignment.character_start_times_seconds.push(a.offset); alignment.character_end_times_seconds.push(a.offset); }
        alignment.characters.push(...a.characters); alignment.character_start_times_seconds.push(...a.character_start_times_seconds.map(t => t + a.offset)); alignment.character_end_times_seconds.push(...a.character_end_times_seconds.map(t => t + a.offset));
      }
    }
    const timing = timingFrom(speech, alignment, info.duration);
    const key = `audio/p${production.project_id}/prod${production.id}/vo-${Date.now()}.mp3`;
    await storage.put(key, full, 'audio/mpeg');
    const id = saveVoiceover({ production, pp, voiceChoice, model, settings, speech, timing, info, key, chars, reqIds, cacheKey, sh, userId,
      loud: await loudness(full, ctx), pk: await peaks(full, 240, ctx), note: [dictNote, files.length > 1 ? `${files.length} requests joined` : ''].filter(Boolean).join(' · ') });
    return { id, reused: false };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function saveVoiceover({ production, pp, voiceChoice, model, settings, speech, timing, info, key, chars, reqIds, cacheKey, sh, userId, loud, pk, note, parentId = null, regenerated = [] }) {
  return (() => {
    db.exec('BEGIN');
    try {
      const id = db.prepare(`INSERT INTO au_voiceovers (production_id, parent_id, sb_version_id, script_hash, voice_id, voice_name, model_id, settings, language, speech, storage_key, duration, sample_rate, format,
          alignment, words, sentences, alignment_source, characters, request_ids, cache_key, loudness, peaks, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(production.id, parentId, production.sb_version_id, sh, voiceChoice.voice.voice_id, voiceChoice.voice.name, model.model_id, JSON.stringify(settings), pp.target.language,
          JSON.stringify({ text: speech.text, parts: speech.parts, changed: speech.changed }), key, r2(info.duration), info.sample_rate, `${info.codec} ${info.sample_rate} Hz`,
          JSON.stringify(timing.alignment), JSON.stringify(timing.words), JSON.stringify(timing.sentences), timing.source, chars, JSON.stringify(reqIds), cacheKey,
          JSON.stringify(loud), JSON.stringify(pk), note, userId).lastInsertRowid;
      for (const s of timing.segments) db.prepare(`INSERT INTO au_voice_segments (voiceover_id, segment_id, ord, start, end, text, speech_text, regenerated) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, s.segment_id, s.order, s.start, s.end, s.text, s.speech_text, regenerated.includes(s.segment_id) ? 1 : 0);
      db.exec('COMMIT');
      return id;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  })();
}

export function voiceoverRow(id) {
  const v = db.prepare(`SELECT * FROM au_voiceovers WHERE id = ?`).get(id);
  if (!v) return null;
  return { ...v, settings: JSON.parse(v.settings), speech: JSON.parse(v.speech), words: JSON.parse(v.words), sentences: JSON.parse(v.sentences), request_ids: JSON.parse(v.request_ids),
    loudness: JSON.parse(v.loudness), peaks: JSON.parse(v.peaks), alignment: undefined,
    segments: db.prepare(`SELECT segment_id, ord, start, end, text, speech_text, regenerated FROM au_voice_segments WHERE voiceover_id = ? ORDER BY ord`).all(id).map(s => ({ ...s, regenerated: !!s.regenerated })) };
}

// Regenerate one segment with the same voice, model and settings, using the surrounding text for continuity, and splice it in.
export async function regenerateSegment({ production, pp, base, segmentId, model, userId, ctx }) {
  const v = voiceoverRow(base);
  const al = JSON.parse(db.prepare(`SELECT alignment FROM au_voiceovers WHERE id = ?`).get(base).alignment);
  const i = v.speech.parts.findIndex(p => p.segment_id === segmentId);
  if (i < 0) throw new HttpError(404, 'Segment not found in this voice-over');
  const part = v.speech.parts[i], segs = v.segments;
  const s = segs[i], prev = segs[i - 1], next = segs[i + 1];
  const cutA = prev ? r2((prev.end + s.start) / 2) : 0, cutB = next ? r2((s.end + next.start) / 2) : v.duration;
  const work = join(TMP_DIR, `vo-seg-${production.id}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const src = await storage.toLocal(v.storage_key, join(work, 'base.mp3'));
    const r = await tts({ voiceId: v.voice_id, modelId: v.model_id, text: part.speech_text, settings: v.settings, languageCode: v.language,
      previousText: v.speech.parts.slice(0, i).map(p => p.speech_text).join(' ').slice(-1000), nextText: v.speech.parts.slice(i + 1).map(p => p.speech_text).join(' ').slice(0, 1000),
      productionId: production.id, userId });
    const piece = join(work, 'piece.mp3');
    writeFileSync(piece, r.audio);
    const pd = (await probeAudio(piece)).duration;
    const out = join(work, 'voice.mp3');
    await splice(src, cutA, cutB, piece, out, ctx);
    const info = await probeAudio(out);
    // New alignment: earlier characters unchanged, this segment from the new piece (at cutA), later ones shifted.
    const delta = (cutA + pd) - cutB;
    const chars = [...v.speech.text];
    const starts = [...al.starts], ends = [...al.ends];
    const pa = r.alignment && r.alignment.characters.join('') === part.speech_text ? r.alignment : null;
    for (let k = part.from; k < part.to; k++) {
      const j = k - part.from;
      starts[k] = r2(cutA + (pa ? pa.character_start_times_seconds[j] : (j / part.speech_text.length) * pd));
      ends[k] = r2(cutA + (pa ? pa.character_end_times_seconds[j] : ((j + 1) / part.speech_text.length) * pd));
    }
    for (let k = part.to; k < chars.length; k++) { starts[k] = r2(starts[k] + delta); ends[k] = r2(ends[k] + delta); }
    const timing = timingFrom(v.speech, { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends }, info.duration);
    if (v.alignment_source === 'estimated' || !pa) timing.source = v.alignment_source === 'provider' && !pa ? 'provider_partial' : v.alignment_source;
    const loudOld = v.loudness?.i, loudPiece = (await loudness(piece, ctx)).i;
    const key = `audio/p${production.project_id}/prod${production.id}/vo-${Date.now()}.mp3`;
    await storage.put(key, out, 'audio/mpeg');
    const note = `Segment ${segmentId} regenerated${loudOld != null && loudPiece != null && Math.abs(loudOld - loudPiece) > 3 ? ` · level differs by ${Math.abs(loudOld - loudPiece).toFixed(1)} LU: regenerate the full voice-over if it sounds uneven` : ''}`;
    const id = saveVoiceover({ production, pp, voiceChoice: { voice: { voice_id: v.voice_id, name: v.voice_name } }, model: { model_id: v.model_id }, settings: v.settings,
      speech: v.speech, timing, info, key, chars: part.speech_text.length, reqIds: [...v.request_ids, r.request_id], cacheKey: '', sh: v.script_hash, userId,
      loud: await loudness(out, ctx), pk: await peaks(out, 240, ctx), note, parentId: v.id, regenerated: [segmentId] });
    return { id, uneven: note.includes('differs') };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// ---------- Duration management ----------
// Compare the real voice-over with the target. Never cuts audio: recommends a speed change or a shorter script.
export function durationPlan(voice, target, leadIn, currentSpeed = 1) {
  const speech = r2(leadIn + voice);
  const ratio = speech / target;
  if (ratio <= 1 + DUR.fit) return { case: 'fits', target, actual: r2(voice), speech_end: speech, final: r2(Math.max(target, speech + DUR.ctaHold)), diff: r2(speech - target), action: speech < target ? `Fits: ${r2(target - speech)} s left for visual pauses and the CTA screen.` : 'Fits the target.' };
  const final = r2(speech + DUR.ctaHold);
  if (ratio <= 1 + DUR.long) {
    const speed = Math.min(SETTING_RANGES.speed[1], r2(currentSpeed * ratio));
    return { case: 'slightly_long', target, actual: r2(voice), speech_end: speech, final, diff: r2(speech - target), speed, action: speed > currentSpeed ? `Slightly long: regenerate at speed ${speed} (natural range), or keep a ${final} s video.` : `Slightly long: keep a ${final} s video or shorten the script.` };
  }
  return { case: 'too_long', target, actual: r2(voice), speech_end: speech, final, diff: r2(speech - target), action: `Much longer than ${target} s: shorten the script (proposal available), or accept a ${final} s video.` };
}
