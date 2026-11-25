// ElevenLabs provider (the only place that talks to ElevenLabs). The key stays on the server (ELEVENLABS_API_KEY).
// Interfaces: account (subscription), models, voices (+ previews), text-to-speech with timestamps, music, pronunciation
// dictionaries, usage logging. Capabilities are read from the API (models, languages, voices) and never assumed.
// ELEVENLABS_BASE_URL can point to a test server (tests/helpers/fake-elevenlabs.mjs).
import { db } from './db.js';
import { HttpError } from './errors.js';

const BASE = () => (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');
const KEY = () => process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '';
export const elevenReady = () => Boolean(KEY());
const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
const RETRIES = num('EL_MAX_RETRIES', 3);

// Settings ranges (the docs give defaults, not ranges: these are the long-documented ones, configurable).
export const SETTING_RANGES = { stability: [0, 1], similarity_boost: [0, 1], style: [0, 1], speed: [num('EL_SPEED_MIN', 0.7), num('EL_SPEED_MAX', 1.2)] };
export const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 };

export class ElevenError extends HttpError {
  constructor(status, message, { transient = false, code = '' } = {}) { super(status, message); this.transient = transient; this.code = code; }
}
function explain(status, body) {
  const d = body?.detail;
  const msg = typeof d === 'string' ? d : d?.message || body?.message || '';
  const code = (typeof d === 'object' && d?.status) || '';
  if (status === 401 && /permission|missing_permissions/i.test(`${code} ${msg}`)) return { m: `The ElevenLabs key lacks a permission: ${String(msg || code).replace(/\.+$/, '')}. In ElevenLabs → Developers → API keys, edit the key and allow it.`, code: 'missing_permissions' };
  if (status === 401) return { m: 'The ElevenLabs key is wrong or expired (ELEVENLABS_API_KEY).', code: 'invalid_key' };
  if (status === 402 || /quota|credits|insufficient/i.test(`${code} ${msg}`)) return { m: `Not enough ElevenLabs credits for this request${msg ? `: ${msg}` : ''}.`, code: 'quota' };
  if (status === 403) return { m: `Not available on this ElevenLabs account or plan${msg ? `: ${msg}` : ''}.`, code: 'not_allowed' };
  if (status === 429) return { m: 'ElevenLabs is busy (rate or concurrency limit): retrying.', code: 'rate_limited' };
  if (status === 422) return { m: `ElevenLabs refused the request: ${typeof d === 'object' ? JSON.stringify(d).slice(0, 300) : msg}`, code: 'invalid_request' };
  return { m: `ElevenLabs error ${status}${msg ? `: ${msg}` : ''}`, code: code || 'error' };
}

// One request with retries on rate limits and server errors (Retry-After respected).
export async function request(path, { method = 'GET', query = {}, body, binary = false, timeout = 180000 } = {}) {
  if (!elevenReady()) throw new ElevenError(503, 'ElevenLabs is not connected: add ELEVENLABS_API_KEY to the server settings.', { code: 'no_key' });
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  for (let attempt = 1; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    let r;
    try {
      r = await fetch(`${BASE()}${path}${qs ? `?${qs}` : ''}`, { method, signal: ctl.signal, headers: { 'xi-api-key': KEY(), ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: binary ? 'audio/mpeg, */*' : 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      clearTimeout(t);
      if (attempt < RETRIES) { await sleep(1000 * attempt); continue; }
      throw new ElevenError(502, `Could not reach ElevenLabs: ${e.name === 'AbortError' ? 'timed out' : e.message}`, { transient: true, code: 'network' });
    }
    clearTimeout(t);
    if (r.ok) {
      const headers = Object.fromEntries(['character-cost', 'request-id', 'x-trace-id', 'song-id', 'current-concurrent-requests', 'maximum-concurrent-requests'].map(h => [h, r.headers.get(h)]).filter(([, v]) => v));
      return binary ? { data: Buffer.from(await r.arrayBuffer()), headers, type: r.headers.get('content-type') || '' } : { data: await r.json(), headers };
    }
    const errBody = await r.json().catch(() => ({}));
    const { m, code } = explain(r.status, errBody);
    if ((r.status === 429 || r.status >= 500) && attempt < RETRIES) { await sleep(Math.min(30, Number(r.headers.get('retry-after')) || 2 * attempt) * 1000); continue; }
    throw new ElevenError(r.status === 401 || r.status === 403 ? r.status : r.status >= 500 ? 502 : r.status, m, { transient: r.status === 429 || r.status >= 500, code });
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Usage log (characters for speech, seconds for music) with the provider's request id.
export function logUsage({ kind, characters = 0, seconds = 0, headers = {}, productionId = null, userId = null, ok = true, error = '' }) {
  db.prepare(`INSERT INTO audio_usage (provider, kind, characters, seconds, provider_cost, request_id, production_id, user_id, ok, error) VALUES ('elevenlabs',?,?,?,?,?,?,?,?,?)`)
    .run(kind, characters, seconds, headers['character-cost'] ? Number(headers['character-cost']) : null, headers['request-id'] || headers['song-id'] || '', productionId, userId, ok ? 1 : 0, String(error).slice(0, 400));
}

// ---------- Account & models ----------
export async function subscription() {
  const { data } = await request('/v1/user/subscription');
  return { tier: data.tier, status: data.status, character_count: data.character_count, character_limit: data.character_limit,
    reset_unix: data.next_character_count_reset_unix, can_extend: data.can_extend_character_limit, currency: data.currency };
}
export async function models({ force = false } = {}) {
  const cached = db.prepare(`SELECT data, fetched_at FROM el_cache WHERE key = 'models'`).get();
  if (cached && !force && Date.now() - new Date(cached.fetched_at + 'Z') < 6 * 3600e3) return JSON.parse(cached.data);
  const { data } = await request('/v1/models');
  const list = data.filter(m => m.can_do_text_to_speech).map(m => ({ model_id: m.model_id, name: m.name, description: m.description || '',
    can_use_style: !!m.can_use_style, can_use_speaker_boost: !!m.can_use_speaker_boost, max_chars: m.maximum_text_length_per_request || 5000,
    languages: (m.languages || []).map(l => ({ id: l.language_id, name: l.name })), cost_multiplier: m.model_rates?.character_cost_multiplier ?? m.token_cost_factor ?? 1,
    requires_alpha: !!m.requires_alpha_access }));
  db.prepare(`INSERT OR REPLACE INTO el_cache (key, data, fetched_at) VALUES ('models', ?, datetime('now'))`).run(JSON.stringify(list));
  return list;
}
// Language support of a model: by ISO code or by name (the API gives both).
export const modelSupports = (m, lang, langName) => m.languages.some(l => l.id === lang || l.id?.startsWith(`${lang}-`) || (langName && l.name?.toLowerCase().startsWith(langName.toLowerCase())));
// Preference order when several models speak the language (quality first; override with EL_TTS_MODEL).
const MODEL_ORDER = ['eleven_multilingual_v2', 'eleven_v3', 'eleven_v4', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_v4_turbo', 'eleven_flash_v2'];
export function pickModel(list, lang, langName) {
  const want = process.env.EL_TTS_MODEL;
  const ok = list.filter(m => modelSupports(m, lang, langName) && !m.requires_alpha);
  if (want && ok.some(m => m.model_id === want)) return ok.find(m => m.model_id === want);
  return [...ok].sort((a, b) => (MODEL_ORDER.indexOf(a.model_id) + 1 || 99) - (MODEL_ORDER.indexOf(b.model_id) + 1 || 99))[0] || null;
}

// ---------- Voices ----------
export async function syncVoices() {
  const all = [];
  let token = null;
  for (let page = 0; page < 30; page++) {
    const { data } = await request('/v2/voices', { query: { page_size: 100, next_page_token: token, include_total_count: false } });
    all.push(...data.voices);
    if (!data.has_more || !data.next_page_token) break;
    token = data.next_page_token;
  }
  const up = db.prepare(`INSERT INTO el_voices (voice_id, name, category, description, labels, languages, preview_url, models, available, fetched_at) VALUES (?,?,?,?,?,?,?,?,1,datetime('now'))
    ON CONFLICT(voice_id) DO UPDATE SET name=excluded.name, category=excluded.category, description=excluded.description, labels=excluded.labels, languages=excluded.languages, preview_url=excluded.preview_url, models=excluded.models, available=1, fetched_at=excluded.fetched_at`);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE el_voices SET available = 0`).run();
    for (const v of all) up.run(v.voice_id, v.name || v.voice_id, v.category || '', v.description || '', JSON.stringify(v.labels || {}),
      JSON.stringify((v.verified_languages || []).map(l => ({ language: l.language, model_id: l.model_id, accent: l.accent || '', locale: l.locale || '', preview_url: l.preview_url || '' }))),
      v.preview_url || '', JSON.stringify(v.high_quality_base_model_ids || []));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.prepare(`INSERT OR REPLACE INTO el_cache (key, data, fetched_at) VALUES ('voices_synced', ?, datetime('now'))`).run(String(all.length));
  return all.length;
}
export const voicesSyncedAt = () => db.prepare(`SELECT fetched_at FROM el_cache WHERE key = 'voices_synced'`).get()?.fetched_at || null;
export function voiceRows() {
  return db.prepare(`SELECT v.*, (SELECT 1 FROM voice_favorites f WHERE f.voice_id = v.voice_id) AS favorite FROM el_voices v WHERE available = 1 ORDER BY name`).all().map(v => ({
    voice_id: v.voice_id, name: v.name, category: v.category, description: v.description, labels: JSON.parse(v.labels || '{}'),
    languages: JSON.parse(v.languages || '[]'), preview_url: v.preview_url, models: JSON.parse(v.models || '[]'), favorite: !!v.favorite,
  }));
}
// Does a voice speak a language? Verified languages when the API gives them; else only English is assumed for premade voices.
export function voiceLanguageFit(v, lang) {
  const verified = v.languages.filter(l => l.language === lang || l.language?.startsWith(`${lang}-`));
  if (verified.length) return { level: 'verified', accents: [...new Set(verified.map(l => l.accent).filter(Boolean))], locales: [...new Set(verified.map(l => l.locale).filter(Boolean))] };
  if (!v.languages.length && lang === 'en') return { level: 'likely', accents: [v.labels?.accent].filter(Boolean), locales: [] };
  return { level: v.languages.length ? 'none' : 'unknown', accents: [], locales: [] };
}

// ---------- Text-to-speech with timestamps ----------
export async function tts({ voiceId, modelId, text, settings, languageCode, previousText, nextText, previousRequestIds, dictionaries, productionId, userId }) {
  const body = {
    text, model_id: modelId, voice_settings: settings,
    ...(languageCode && modelId !== 'eleven_multilingual_v2' ? { language_code: languageCode } : {}),
    ...(previousText ? { previous_text: previousText } : {}), ...(nextText ? { next_text: nextText } : {}),
    ...(previousRequestIds?.length ? { previous_request_ids: previousRequestIds.slice(-3) } : {}),
    ...(dictionaries?.length ? { pronunciation_dictionary_locators: dictionaries.slice(0, 3) } : {}),
  };
  try {
    const { data, headers } = await request(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, { method: 'POST', query: { output_format: 'mp3_44100_128' }, body });
    logUsage({ kind: 'tts', characters: text.length, headers, productionId, userId });
    if (!data.audio_base64) throw new ElevenError(502, 'ElevenLabs returned no audio');
    return { audio: Buffer.from(data.audio_base64, 'base64'), alignment: data.alignment || null, normalized: data.normalized_alignment || null, request_id: headers['request-id'] || '', character_cost: headers['character-cost'] ? Number(headers['character-cost']) : null };
  } catch (e) { logUsage({ kind: 'tts', characters: text.length, productionId, userId, ok: false, error: e.message }); throw e; }
}

// ---------- Music ----------
export async function music({ prompt, lengthMs, instrumental = true, productionId, userId }) {
  const models = [process.env.EL_MUSIC_MODEL, 'music_v2_5', 'music_v2', 'music_v1'].filter(Boolean);
  let last;
  for (const model of [...new Set(models)]) {
    try {
      const { data, headers, type } = await request('/v1/music', { method: 'POST', body: { prompt, music_length_ms: Math.max(3000, Math.min(600000, Math.round(lengthMs))), model_id: model, force_instrumental: instrumental }, binary: true, timeout: 600000 });
      logUsage({ kind: 'music', seconds: lengthMs / 1000, headers, productionId, userId });
      return { audio: data, model, song_id: headers['song-id'] || '', type };
    } catch (e) {
      last = e;
      if (e.status === 422 && /model/i.test(e.message)) continue; // that model is not offered: try the next one
      logUsage({ kind: 'music', seconds: lengthMs / 1000, productionId, userId, ok: false, error: e.message });
      throw e;
    }
  }
  throw last;
}

// ---------- Pronunciation dictionaries (phoneme rules; alias rules are applied in the text) ----------
export async function dictionaryFor(rules) {
  if (!rules.length) return [];
  const key = 'dict:' + JSON.stringify(rules);
  const hit = db.prepare(`SELECT data FROM el_cache WHERE key = ?`).get(key);
  if (hit) return [JSON.parse(hit.data)];
  const { data } = await request('/v1/pronunciation-dictionaries/add-from-rules', { method: 'POST', body: {
    name: `acc-${Date.now()}`, rules: rules.map(r => ({ string_to_replace: r.term, type: 'phoneme', phoneme: r.spoken, alphabet: r.alphabet || 'ipa', case_sensitive: !!r.case_sensitive, word_boundaries: true })) } });
  const loc = { pronunciation_dictionary_id: data.id, version_id: data.version_id || null };
  db.prepare(`INSERT OR REPLACE INTO el_cache (key, data, fetched_at) VALUES (?,?,datetime('now'))`).run(key, JSON.stringify(loc));
  return [loc];
}

// Preview audio of a voice (the provider's sample), downloaded once and kept.
export async function previewAudio(url) {
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(502, 'Could not download the voice preview');
  return Buffer.from(await r.arrayBuffer());
}
