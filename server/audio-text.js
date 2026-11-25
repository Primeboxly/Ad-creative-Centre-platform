// Speech-ready text: the approved script is never changed; this builds a separate spoken version per segment, with
// numbers, prices and currencies written as words in the target language, abbreviations, symbols and URLs spelled out,
// and the team's pronunciation rules (alias = replaced in the text; phoneme = sent as an ElevenLabs dictionary).
import { db } from './db.js';

// ---------- Numbers as words ----------
const EN = { ones: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'],
  tens: ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] };
function en(n) {
  if (n < 20) return EN.ones[n];
  if (n < 100) return EN.tens[Math.floor(n / 10)] + (n % 10 ? `-${EN.ones[n % 10]}` : '');
  if (n < 1000) return `${EN.ones[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${en(n % 100)}` : ''}`;
  for (const [v, w] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) if (n >= v) return `${en(Math.floor(n / v))} ${w}${n % v ? (n % v < 100 ? ' and ' : ' ') + en(n % v) : ''}`;
  return String(n);
}
const FR1 = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const FR10 = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];
function fr(n) {
  if (n < 20) return FR1[n];
  if (n < 70) { const t = Math.floor(n / 10), u = n % 10; return FR10[t] + (u === 1 ? '-et-un' : u ? `-${FR1[u]}` : ''); }
  if (n < 80) return n === 71 ? 'soixante-et-onze' : `soixante-${FR1[n - 60]}`;
  if (n < 100) return n === 80 ? 'quatre-vingts' : `quatre-vingt-${FR1[n - 80]}`;
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return (h === 1 ? 'cent' : `${FR1[h]} cent${r ? '' : 's'}`) + (r ? ` ${fr(r)}` : ''); }
  if (n < 1e6) { const k = Math.floor(n / 1000), r = n % 1000; return (k === 1 ? 'mille' : `${fr(k)} mille`) + (r ? ` ${fr(r)}` : ''); }
  const m = Math.floor(n / 1e6), r = n % 1e6; return `${fr(m)} million${m > 1 ? 's' : ''}${r ? ` ${fr(r)}` : ''}`;
}
const SW1 = ['sifuri', 'moja', 'mbili', 'tatu', 'nne', 'tano', 'sita', 'saba', 'nane', 'tisa'];
const SW10 = ['', 'kumi', 'ishirini', 'thelathini', 'arobaini', 'hamsini', 'sitini', 'sabini', 'themanini', 'tisini'];
function sw(n) {
  if (n < 10) return SW1[n];
  if (n < 100) return SW10[Math.floor(n / 10)] + (n % 10 ? ` na ${SW1[n % 10]}` : '');
  if (n < 1000) return `mia ${SW1[Math.floor(n / 100)]}${n % 100 ? ` na ${sw(n % 100)}` : ''}`;
  if (n < 1e6) return `elfu ${sw(Math.floor(n / 1000))}${n % 1000 ? ` na ${sw(n % 1000)}` : ''}`;
  return `milioni ${sw(Math.floor(n / 1e6))}${n % 1e6 ? ` na ${sw(n % 1e6)}` : ''}`;
}
export function numberWords(n, lang) {
  const f = { fr, sw }[lang] || en;
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) return String(n);
  const [i, d] = String(n).split('.');
  const whole = f(Number(i));
  if (!d) return whole;
  const sep = { fr: 'virgule', sw: 'nukta' }[lang] || 'point';
  return `${whole} ${sep} ${[...d].map(x => f(Number(x))).join(' ')}`;
}

// ---------- Currencies (code or symbol → spoken name, per language) ----------
const CURRENCY = {
  ZMW: { en: 'kwacha', fr: 'kwacha', sw: 'kwacha', re: /\b(ZMW|ZK|kwacha)\b/i },
  KES: { en: 'Kenyan shillings', fr: 'shillings kényans', sw: 'shilingi za Kenya', re: /\b(KES|KSh|Ksh)\b/ },
  TZS: { en: 'Tanzanian shillings', fr: 'shillings tanzaniens', sw: 'shilingi za Tanzania', re: /\b(TZS|TSh|Tsh)\b/ },
  UGX: { en: 'Ugandan shillings', fr: 'shillings ougandais', sw: 'shilingi za Uganda', re: /\b(UGX|USh)\b/ },
  USD: { en: 'US dollars', fr: 'dollars américains', sw: 'dola za Marekani', re: /(\bUSD\b|US\$|\$)/ },
  XOF: { en: 'CFA francs', fr: 'francs CFA', sw: 'faranga za CFA', re: /\b(XOF|FCFA|CFA)\b/ },
  XAF: { en: 'CFA francs', fr: 'francs CFA', sw: 'faranga za CFA', re: /\bXAF\b/ },
  NGN: { en: 'naira', fr: 'nairas', sw: 'naira', re: /(\bNGN\b|₦)/ },
  GHS: { en: 'Ghana cedis', fr: 'cedis', sw: 'sedi za Ghana', re: /(\bGHS\b|GH₵)/ },
  MWK: { en: 'Malawian kwacha', fr: 'kwachas malawites', sw: 'kwacha za Malawi', re: /\bMWK\b/ },
  RWF: { en: 'Rwandan francs', fr: 'francs rwandais', sw: 'faranga za Rwanda', re: /\b(RWF|FRw)\b/ },
  MAD: { en: 'dirhams', fr: 'dirhams', sw: 'dirham', re: /\b(MAD|DH|dh)\b/ },
  EUR: { en: 'euros', fr: 'euros', sw: 'yuro', re: /(\bEUR\b|€)/ },
  BWP: { en: 'pula', fr: 'pula', sw: 'pula', re: /\bBWP\b/ }, NAD: { en: 'Namibian dollars', fr: 'dollars namibiens', sw: 'dola za Namibia', re: /\bNAD\b/ },
  MZN: { en: 'meticais', fr: 'meticais', sw: 'metikali', re: /\bMZN\b/ }, CDF: { en: 'Congolese francs', fr: 'francs congolais', sw: 'faranga za Kongo', re: /\bCDF\b/ },
};
const WORDS = {
  en: { percent: 'percent', and: 'and', dot: 'dot', slash: 'slash', at: 'at' },
  fr: { percent: 'pour cent', and: 'et', dot: 'point', slash: 'slash', at: 'arobase' },
  sw: { percent: 'asilimia', and: 'na', dot: 'nukta', slash: 'mkwaju', at: 'at' },
};
const UNITS = { cm: { en: 'centimetres', fr: 'centimètres', sw: 'sentimita' }, mm: { en: 'millimetres', fr: 'millimètres', sw: 'milimita' }, m: { en: 'metres', fr: 'mètres', sw: 'mita' },
  kg: { en: 'kilograms', fr: 'kilos', sw: 'kilo' }, g: { en: 'grams', fr: 'grammes', sw: 'gramu' }, ml: { en: 'millilitres', fr: 'millilitres', sw: 'mililita' }, l: { en: 'litres', fr: 'litres', sw: 'lita' },
  mah: { en: 'milliamp hours', fr: 'milliampères-heure', sw: 'miliampea saa' }, w: { en: 'watts', fr: 'watts', sw: 'wati' }, v: { en: 'volts', fr: 'volts', sw: 'volti' } };
// Swahili says the currency first (shilingi elfu mbili), the other languages after the number.
const price = (words, cur, L) => (L === 'sw' ? `${cur} ${words}` : `${words} ${cur}`);
const toNum = s => Number(String(s).replace(/[ ,](?=\d{3}\b)/g, '').replace(/,/g, ''));

// Spoken version of one text. rules: [{ term, spoken, type, case_sensitive }]
export function speechText(text, lang, rules = [], currency = '') {
  let t = String(text || '');
  for (const r of rules.filter(x => x.type === 'alias')) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${r.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, r.case_sensitive ? 'gu' : 'giu');
    t = t.replace(re, r.spoken);
  }
  const L = WORDS[lang] ? lang : 'en';
  // URLs and emails
  t = t.replace(/\b(https?:\/\/)?(www\.)?([a-z0-9-]+)\.([a-z]{2,})(\/[^\s]*)?/gi, (m, p, w, a, b) => `${w ? 'www ' + WORDS[L].dot + ' ' : ''}${a} ${WORDS[L].dot} ${b}`);
  // Prices: "780 ZMW", "ZMW 780", "K780", "$25", "1,200 KES"
  for (const [code, c] of Object.entries(CURRENCY)) {
    const sym = c.re.source;
    t = t.replace(new RegExp(`(?:${sym})\\s?(\\d[\\d,. ]*\\d|\\d)`, 'g'), (m, ...g) => { const d = g.find(x => /^\d/.test(x || '')); return price(numberWords(toNum(d), L), c[L], L); });
    t = t.replace(new RegExp(`(\\d[\\d,. ]*\\d|\\d)\\s?(?:${sym})`, 'g'), (m, d) => price(numberWords(toNum(d), L), c[L], L));
  }
  if (currency === 'ZMW') t = t.replace(/\bK\s?(\d[\d,]*)/g, (m, d) => price(numberWords(toNum(d), L), CURRENCY.ZMW[L], L));
  // Percent, measurements, plain numbers
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, (m, d) => `${numberWords(Number(d), L)} ${WORDS[L].percent}`);
  t = t.replace(/(\d+(?:\.\d+)?)\s?(mah|cm|mm|kg|ml|m|g|l|w|v)\b/gi, (m, d, u) => `${numberWords(Number(d), L)} ${UNITS[u.toLowerCase()][L]}`);
  t = t.replace(/(\d+)\s?[x×]\s?(\d+)/g, (m, a, b) => `${numberWords(Number(a), L)} ${L === 'fr' ? 'fois' : L === 'sw' ? 'mara' : 'by'} ${numberWords(Number(b), L)}`);
  t = t.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\b/g, (m) => numberWords(toNum(m), L));
  t = t.replace(/\s*&\s*/g, ` ${WORDS[L].and} `).replace(/\s{2,}/g, ' ').trim();
  return t;
}

// Rules for a product and language (global rules + product rules).
export function rulesFor(productId, lang) {
  return db.prepare(`SELECT * FROM pronunciation_rules WHERE (product_id IS NULL OR product_id = ?) AND (language = '' OR language = ?) ORDER BY length(term) DESC`).all(productId, lang);
}

// Speech-ready script: one entry per segment with its character range in the full text sent to ElevenLabs.
export function buildSpeech(segments, lang, rules, currency) {
  let full = '';
  const parts = segments.map(s => {
    const spoken = speechText(s.text, lang, rules, currency);
    const start = full.length ? full.length + 1 : 0;
    full = full ? `${full} ${spoken}` : spoken;
    return { segment_id: s.id, role: s.role, text: s.text, speech_text: spoken, from: start, to: full.length };
  });
  return { text: full, parts, changed: parts.some(p => p.speech_text !== p.text) };
}
