// Script duration estimate (provisional: the real voice-over of Module 5 becomes the timing authority).
// Speaking rate depends on the language (Swahili words are longer than English ones), the dialect and the tone,
// plus short pauses at commas, sentence ends and between segments. Everything is configurable.
const parseJson = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

// Words per second for an ad voice-over (clear, slightly faster than conversation).
export const RATES = { en: 2.6, fr: 2.7, sw: 2.1, ...parseJson(process.env.SB_SPEECH_RATES, {}) };
// Optional per-dialect adjustment (multiplier on the language rate).
export const DIALECT_FACTORS = {
  'West African English': 0.96, 'East African English': 0.97, 'Southern African English': 0.98,
  'Kenyan Swahili': 1, 'Tanzanian Swahili': 0.97, 'Ugandan Swahili': 0.96,
  'West African French': 0.97, 'Central African French': 0.97, 'North African French': 1,
  ...parseJson(process.env.SB_DIALECT_FACTORS, {}),
};
// Tone changes the delivery speed.
export const TONE_FACTORS = { energetic: 1.08, persuasive: 1, conversational: 1, professional: 0.97, educational: 0.95, emotional: 0.9, premium: 0.9 };
export const PAUSES = { comma: 0.15, sentence: 0.3, segment: 0.25 };
export const TOLERANCE = Number(process.env.SB_DURATION_TOLERANCE) > 0 ? Number(process.env.SB_DURATION_TOLERANCE) : 0.12; // ±12 %

export const words = t => (String(t || '').trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
export function wordsPerSecond(lang, dialect, tone) {
  return (RATES[lang] || RATES.en) * (DIALECT_FACTORS[dialect] || 1) * (TONE_FACTORS[tone] || 1);
}
export function estimate(text, { lang = 'en', dialect = '', tone = 'persuasive' } = {}) {
  const t = String(text || '');
  const w = words(t);
  if (!w) return { words: 0, seconds: 0 };
  const commas = (t.match(/[,;:—–]/g) || []).length;
  const ends = (t.match(/[.!?…]+/g) || []).length || 1;
  const seconds = w / wordsPerSecond(lang, dialect, tone) + commas * PAUSES.comma + ends * PAUSES.sentence;
  return { words: w, seconds: Math.round(seconds * 100) / 100 };
}
// About how many words fit in a duration (for the AI's word budget).
export const wordBudget = (seconds, opts = {}) => Math.max(6, Math.round(seconds * wordsPerSecond(opts.lang, opts.dialect, opts.tone) * 0.88));

// Times of every segment, one after the other (with a short pause between segments).
export function timeSegments(segments, opts) {
  let t = 0;
  const out = segments.map((s, i) => {
    const e = estimate(s.text, opts);
    const dur = Math.max(0.6, e.seconds + (i < segments.length - 1 ? PAUSES.segment : 0));
    const r = { ...s, order: i + 1, words: e.words, est_start: round(t), est_end: round(t + dur), est_duration: round(dur) };
    t += dur;
    return r;
  });
  return { segments: out, seconds: round(t), words: out.reduce((n, s) => n + s.words, 0) };
}
export const round = x => Math.round(x * 100) / 100;
export function durationCheck(seconds, target) {
  const diff = round(seconds - target);
  const ratio = target ? seconds / target : 1;
  return { seconds, target, diff, ok: Math.abs(ratio - 1) <= TOLERANCE, tooLong: ratio > 1 + TOLERANCE, tooShort: ratio < 1 - TOLERANCE };
}
