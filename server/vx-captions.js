// Captions from the approved voice-over timing (Module 5): the written script words are matched to the spoken words
// (numbers, prices and abbreviations are spoken as words, but shown as written), grouped into short readable caption
// groups, and the advertising keywords are marked. No new speech request and no transcription: the real word times are
// reused. When the timing was estimated (no provider alignment), captions say so.
import { SEGMENTATIONS, VX_LIMITS } from './vx-registry.js';

const r3 = x => Math.round(x * 1000) / 1000;
// ---------- Text safety ----------
// Text from scripts, briefs and team edits is DATA: characters that would act as ASS commands ({ } \) are replaced,
// control characters removed, length limited. This is the only way text reaches the renderer.
export function cleanText(s, max = VX_LIMITS.maxTextLen) {
  return String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2028\u2029]/g, ' ').replace(/[{}]/g, m => (m === '{' ? '(' : ')')).replace(/\\/g, '/')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
export const hasArabic = s => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s);
export const norm = t => (String(t).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || []).join('');
const tokens = text => cleanText(text, 2000).split(' ').filter(Boolean);
const isNumberish = t => /\d/.test(t);
const endsSentence = t => /[.!?؟…]["'»”)]*$/.test(t);
const endsClause = t => /[,;:،؛]["'»”)]*$/.test(t);

// ---------- Display words with real timing ----------
// Longest common subsequence between the written tokens and the spoken words of one segment. Matched tokens take the
// spoken word's time; a run of unmatched written tokens (e.g. "1,200 ZMW") takes the time of the unmatched spoken run
// between the same neighbours ("one thousand two hundred kwacha"), split by length.
function alignSegment(written, spoken) {
  const a = written.map(norm), b = spoken.map(w => norm(w.word));
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) { if (a[i] && a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  const out = written.map(t => ({ text: t, start: null, end: null, timing: 'exact' }));
  for (const [i, j] of pairs) Object.assign(out[i], { start: spoken[j].start, end: spoken[j].end });
  // Fill the gaps between matches.
  const anchors = [[-1, -1], ...pairs, [n, m]];
  for (let k = 0; k < anchors.length - 1; k++) {
    const [i0, j0] = anchors[k], [i1, j1] = anchors[k + 1];
    const ws = out.slice(i0 + 1, i1);
    if (!ws.length) continue;
    const sp = spoken.slice(j0 + 1, j1);
    const t0 = sp.length ? sp[0].start : i0 >= 0 ? out[i0].end : spoken[0]?.start ?? 0;
    const t1 = sp.length ? sp.at(-1).end : i1 < n ? out[i1].start ?? t0 : spoken.at(-1)?.end ?? t0;
    const total = ws.reduce((s, w) => s + Math.max(1, w.text.length), 0);
    let t = t0;
    for (const w of ws) { const d = (Math.max(0, t1 - t0) * Math.max(1, w.text.length)) / total; Object.assign(w, { start: r3(t), end: r3(t + d), timing: sp.length ? 'matched_run' : 'interpolated' }); t += d; }
  }
  return out;
}

// captions: package captions (Module 5 caption timing, already shifted by the mix lead-in). segments: script segments
// [{id, text, role}] as approved. Returns display words in order with times, segment ids and sentence ends.
export function displayWords(captions, segments) {
  if (!captions?.words?.length) return { words: [], source: 'none', exact: false, note: 'No voice-over: no word timing to caption.' };
  const bySeg = new Map();
  for (const w of captions.words) { const k = w.segment_id || '_'; if (!bySeg.has(k)) bySeg.set(k, []); bySeg.get(k).push(w); }
  const out = [];
  const segOrder = (captions.segments || []).map(s => s.segment_id);
  const ids = segOrder.length ? segOrder : [...bySeg.keys()];
  for (const id of ids) {
    const spoken = bySeg.get(id) || [];
    if (!spoken.length) continue;
    const seg = segments.find(s => s.id === id), capSeg = (captions.segments || []).find(s => s.segment_id === id);
    const written = tokens(seg?.text || capSeg?.text || spoken.map(w => w.word).join(' '));
    const same = written.length === spoken.length && written.every((t, i) => norm(t) === norm(spoken[i].word));
    const ws = same ? written.map((t, i) => ({ text: t, start: spoken[i].start, end: spoken[i].end, timing: 'exact' })) : alignSegment(written, spoken);
    for (const w of ws) out.push({ ...w, segment_id: id, role: seg?.role || '' });
  }
  // Words left without times (should not happen): spread over their neighbours.
  for (let i = 0; i < out.length; i++) if (out[i].start == null) { const p = out[i - 1]; out[i].start = p ? p.end : 0; out[i].end = out[i].start + 0.2; out[i].timing = 'interpolated'; }
  out.forEach((w, i) => { w.i = i; w.sentence_end = endsSentence(w.text) || out[i + 1]?.segment_id !== w.segment_id; w.clause_end = endsClause(w.text); });
  const exact = captions.source === 'provider' || captions.source === 'provider_normalized';
  return { words: out, source: captions.source, confidence: captions.confidence, exact,
    note: exact ? 'Word times come from the approved voice-over alignment (ElevenLabs timestamps).' : 'The voice-over timing was estimated (no provider word timestamps): captions follow the estimated timing, not exact word-level sync.' };
}

// ---------- Protected phrases (never split across caption groups) ----------
// Numbers with their currency or unit, the product name, and phrases the director asked to keep together.
export function protectedPairs(words, { productName = '', currency = '', keep = [] } = {}) {
  const join = new Set();
  const cur = norm(currency), units = new Set([cur, 'zmw', 'kwacha', 'tsh', 'ksh', 'kes', 'ugx', 'rwf', 'ngn', 'ghs', 'xof', 'xaf', 'mad', 'dh', 'dhs', 'درهم', 'usd', 'eur', 'shillings', 'shilingi', 'francs', 'naira', 'cedis', '%', 'cfa', 'fcfa']);
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (a.segment_id !== b.segment_id) continue;
    if (isNumberish(a.text) && (units.has(norm(b.text)) || /^[%$€£]/.test(b.text))) join.add(i);
    if (isNumberish(b.text) && (units.has(norm(a.text)) || /[$€£]$/.test(a.text))) join.add(i);
  }
  for (const phrase of [productName, ...keep].filter(Boolean)) {
    const p = tokens(phrase).map(norm).filter(Boolean);
    if (p.length < 2 || p.length > 5) continue;
    for (let i = 0; i + p.length <= words.length; i++) if (p.every((t, k) => norm(words[i + k].text) === t)) for (let k = 0; k < p.length - 1; k++) join.add(i + k);
  }
  return join;
}

// ---------- Caption groups ----------
// mode: word | two | three | phrase | sentence | ai. maxChars: characters per line for the format; maxLines from the style.
export function groupCaptions(words, { mode = 'phrase', maxChars = 22, maxLines = 2, keepTogether = new Set(), duration = Infinity } = {}) {
  const [minW, maxW] = SEGMENTATIONS[mode] || SEGMENTATIONS.phrase;
  const cap = maxChars * maxLines;
  const groups = [];
  let cur = [];
  const len = ws => ws.reduce((s, w) => s + w.text.length, 0) + Math.max(0, ws.length - 1);
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = cur.at(-1);
    if (prev) {
      const glued = keepTogether.has(prev.i);
      const tooMany = cur.length >= maxW, tooLong = len([...cur, w]) > cap, gap = w.start - prev.end > 0.45, newSeg = w.segment_id !== prev.segment_id;
      const sentence = prev.sentence_end, clause = prev.clause_end && cur.length >= minW && mode !== 'word', slow = w.end - cur[0].start > VX_LIMITS.maxCaptionSec;
      const hard = newSeg || (tooLong && !glued) || len([...cur, w]) > cap + 12;
      if (hard || (!glued && (tooMany || gap || sentence || clause || slow))) flush();
    }
    cur.push(w);
  }
  flush();
  // A lonely word next to a short group of the same sentence joins it (fewer flashes), if it still fits.
  if (minW > 1) for (let g = 0; g < groups.length; g++) {
    if (groups[g].length !== 1 || groups.length < 2) continue;
    const w = groups[g][0], p = groups[g - 1], n = groups[g + 1];
    if (p && p.at(-1).segment_id === w.segment_id && !p.at(-1).sentence_end && p.length < maxW && len([...p, w]) <= cap && w.start - p.at(-1).end < 0.45) { p.push(w); groups.splice(g, 1); g--; }
    else if (n && n[0].segment_id === w.segment_id && !w.sentence_end && n.length < maxW && len([w, ...n]) <= cap && n[0].start - w.end < 0.45) { n.unshift(w); groups.splice(g, 1); g--; }
  }
  // Times: from the first word to the last; short groups stay a little longer, never over the next group.
  return groups.map((ws, k) => {
    const next = groups[k + 1];
    let start = ws[0].start, end = ws.at(-1).end;
    const limit = next ? next[0].start : duration;
    if (next && limit - end < 0.3) end = limit; else end = Math.min(limit, end + 0.18);
    if (end - start < VX_LIMITS.minCaptionSec) end = Math.min(limit, start + VX_LIMITS.minCaptionSec);
    return { words: ws, start: r3(Math.max(0, start)), end: r3(Math.min(duration, end)), lines: splitLines(ws.map(w => w.text), maxChars) };
  });
}
// Balanced line break (word indices of each line).
export function splitLines(texts, maxChars) {
  const total = texts.join(' ').length;
  if (total <= maxChars || texts.length < 2) return [texts.length];
  let best = 1, bestDiff = Infinity;
  for (let k = 1; k < texts.length; k++) { const a = texts.slice(0, k).join(' ').length, b = texts.slice(k).join(' ').length; const d = Math.abs(a - b) + (Math.max(a, b) > maxChars ? 100 : 0); if (d < bestDiff) { bestDiff = d; best = k; } }
  return [best, texts.length - best];
}

// ---------- Keyword highlighting ----------
const KIND_RANK = { price: 0, offer: 1, product: 2, benefit: 3, feature: 4, pain: 5, hook: 6, cta: 7 };
// keywords: [{text, kind}] from the Visual Director (checked: they must occur in the script). share: the most groups that
// may carry a highlight. Price and offer words are always marked; one highlighted span per group at most.
export function markHighlights(groups, keywords, { share = 0.25, price = '' } = {}) {
  const kw = (keywords || []).map(k => ({ ...k, toks: tokens(k.text).map(norm).filter(Boolean) })).filter(k => k.toks.length && k.toks.length <= 4);
  const priceTok = norm(price);
  const found = [];
  groups.forEach((g, gi) => {
    let best = null;
    const ws = g.words;
    for (let i = 0; i < ws.length; i++) {
      if (priceTok && norm(ws[i].text) === priceTok) { best = { gi, from: i, to: i, kind: 'price' }; break; }
      for (const k of kw) {
        if (i + k.toks.length > ws.length || !k.toks.every((t, x) => norm(ws[i + x].text) === t)) continue;
        if (!best || KIND_RANK[k.kind] < KIND_RANK[best.kind]) best = { gi, from: i, to: i + k.toks.length - 1, kind: k.kind };
      }
    }
    if (best) found.push(best);
  });
  const max = Math.max(1, Math.round(groups.length * share));
  const keep = found.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]).filter((f, i) => i < max || ['price', 'offer'].includes(f.kind));
  for (const f of keep) for (let i = f.from; i <= f.to; i++) groups[f.gi].words[i] = { ...groups[f.gi].words[i], hl: f.kind };
  return keep.length;
}

// ---------- Prices ----------
// The price exactly as the brief gives it, with thousands grouped for the language when it is a plain number.
export function formatPrice(price, currency, lang = 'en') {
  const p = cleanText(price, 30), c = cleanText(currency, 12);
  if (!p) return '';
  const n = Number(p.replace(/[\s,]/g, ''));
  const loc = { fr: 'fr-FR', sw: 'en-KE', rw: 'en-RW', ar: 'ar-MA-u-nu-latn' }[lang] || 'en-US';
  const shown = /^\d[\d\s,.]*$/.test(p) && Number.isFinite(n) ? new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(n).replace(/ | /g, ' ') : p;
  if (!c || p.toLowerCase().includes(c.toLowerCase())) return shown;
  return ['sw'].includes(lang) ? `${c} ${shown}` : `${shown} ${c}`;
}

// ---------- Fixed phrases in the target language ----------
const PHRASES = {
  en: { cod: 'Cash on delivery', free_delivery: 'Free delivery', order: 'Order now' },
  fr: { cod: 'Paiement à la livraison', free_delivery: 'Livraison gratuite', order: 'Commandez maintenant' },
  sw: { cod: 'Lipa ukipokea', free_delivery: 'Usafirishaji bure', order: 'Agiza sasa' },
  rw: { cod: 'Wishyura ubonye igicuruzwa', free_delivery: 'Kugeza ku buntu', order: 'Tumiza nonaha' },
  ar: { cod: 'الدفع عند الاستلام', free_delivery: 'توصيل مجاني', order: 'اطلب الآن' },
};
export const phrase = (lang, key) => (PHRASES[String(lang || 'en').slice(0, 2)] || PHRASES.en)[key] || PHRASES.en[key];

// ---------- Claims ----------
// A promotional text may only state numbers, guarantees, free delivery or scarcity that the brief confirms or the
// approved script / product information already says.
export function unsupportedClaim(text, { sources = '', confirmed = {}, price = '', offer = '' } = {}) {
  const t = String(text).toLowerCase(), src = `${sources} ${price} ${offer}`.toLowerCase();
  const nums = t.match(/\d+(?:[.,]\d+)?/g) || [];
  for (const n of nums) if (!src.includes(n) && !src.replace(/[\s,]/g, '').includes(n.replace(/[,]/g, ''))) return `the number ${n} is not in the brief or the script`;
  if (/guarant|garanti|dhamana|ضمان/.test(t) && !confirmed.guarantee && !/guarant|garanti|dhamana|ضمان/.test(src)) return 'a guarantee that the brief does not confirm';
  if (/free deliver|livraison gratuite|bure|مجاني|free shipping/.test(t) && !confirmed.free_delivery) return 'free delivery that the brief does not confirm';
  if (/limited|last chance|only \d+ (left|pieces|items)|in stock|stock limit|derniers|chache|محدود/.test(t) && !confirmed.limited_stock && !/limited|stock|محدود/.test(src)) return 'scarcity that the brief does not confirm';
  if (/review|avis|customers say|★|⭐|\d+\s*stars?/.test(t) && !/review|avis|stars?/.test(src)) return 'a customer review or rating that is not in the brief';
  if (/(^|\s)(#1|no\.?\s?1|best[- ]seller|number one)(\s|$)/.test(t) && !/#1|best[- ]seller|number one/.test(src)) return 'a ranking claim that is not in the brief';
  return '';
}
