// Voice-over with ElevenLabs: turns script text into an MP3. Each (model, voice, text) is made once and kept.
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOICE_DIR } from './paths.js';
import { HttpError } from './errors.js';

const API = 'https://api.elevenlabs.io';
// eleven_v3 reads English, French and Swahili (eleven_multilingual_v2 has no Swahili).
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_v3';
const LANG_CODE = { en: 'en', sw: 'sw', fr: 'fr' };

export const ttsReady = () => Boolean(process.env.ELEVENLABS_API_KEY);
const headers = () => ({ 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' });

// permission = the key setting needed for this call, named as on the ElevenLabs API key page.
async function failure(r, permission = 'Text to Speech → Access') {
  let msg = '';
  try { const j = await r.json(); msg = j?.detail?.message || j?.detail?.status || (typeof j?.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)); } catch {}
  if (r.status === 401 || r.status === 403)
    return new HttpError(502, `ElevenLabs refused the key: it is wrong, or it lacks the permission "${permission}". ${msg}`.trim());
  if (r.status === 429) return new HttpError(429, 'ElevenLabs is busy or your monthly characters are used up. ' + msg);
  return new HttpError(502, `ElevenLabs error ${r.status}: ${msg}`.slice(0, 300));
}

// The account's voices (premade + your own), cached 10 minutes.
let cache = { at: 0, list: [] };
const toVoice = v => {
  const l = v.labels || {};
  return { id: v.voice_id, name: v.name, category: v.category || '', preview: v.preview_url || '',
    info: [l.gender, l.accent, l.age, l.language].filter(Boolean).join(' · ') };
};

// v2 lists the voices page by page; the older v1 list is tried when v2 fails or gives nothing.
async function voicesV2() {
  const list = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ page_size: '100', sort: 'name', sort_direction: 'asc' });
    if (token) q.set('next_page_token', token);
    const r = await fetch(`${API}/v2/voices?${q}`, { headers: headers() });
    if (!r.ok) throw await failure(r, 'Voices → Read');
    const j = await r.json();
    list.push(...(j.voices || []).map(toVoice));
    if (!j.has_more || !j.next_page_token) break;
    token = j.next_page_token;
  }
  return list;
}

async function voicesV1() {
  const r = await fetch(`${API}/v1/voices`, { headers: headers() });
  if (!r.ok) throw await failure(r, 'Voices → Read');
  return ((await r.json()).voices || []).map(toVoice).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listVoices() {
  if (!ttsReady()) return [];
  if (Date.now() - cache.at < 10 * 60e3 && cache.list.length) return cache.list;
  let list = [], error = null;
  try { list = await voicesV2(); } catch (e) { error = e; }
  if (!list.length) {
    try { list = await voicesV1(); } catch (e) { error ??= e; }
  }
  if (!list.length && error) throw error;
  cache = { at: Date.now(), list };
  return list;
}

// ---------- Music (Eleven Music) ----------
// Instrumental music from a short description, e.g. "elegant luxury pop, soft piano, confident, for a watch ad".
// Returns the MP3 bytes. Music cannot name artists or songs (ElevenLabs refuses with a suggestion).
const MUSIC_MODEL = process.env.ELEVENLABS_MUSIC_MODEL || 'music_v2_5';
export async function composeMusic(prompt, seconds = 30) {
  if (!ttsReady()) throw new HttpError(503, 'ElevenLabs is not set up: add ELEVENLABS_API_KEY to the server settings.');
  const ms = Math.round(Math.min(Math.max(Number(seconds) || 30, 10), 120) * 1000);
  const ask = model => fetch(`${API}/v1/music?output_format=mp3_44100_128`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ prompt, music_length_ms: ms, model_id: model, force_instrumental: true }),
  });
  let r = await ask(MUSIC_MODEL);
  if (r.status === 422 && MUSIC_MODEL !== 'music_v1') r = await ask('music_v1'); // older model as a second try
  if (!r.ok) {
    if (r.status === 400 || r.status === 422) {
      let j = {};
      try { j = await r.clone().json(); } catch {}
      const tip = j?.detail?.data?.prompt_suggestion;
      if (j?.detail?.status === 'bad_prompt') throw new HttpError(400, `ElevenLabs refused this description (no artist or song names).${tip ? ` Try: "${tip}"` : ''}`);
    }
    throw await failure(r, 'Music Generation → Access');
  }
  return Buffer.from(await r.arrayBuffer());
}

// Text → MP3 file path (reused when the same text was already spoken by the same voice).
export async function speak(text, voiceId, language) {
  if (!ttsReady()) throw new HttpError(503, 'Voice-over is not set up: add ELEVENLABS_API_KEY to the server settings.');
  const clean = String(text || '').trim();
  if (!clean) return null;
  const file = join(VOICE_DIR, createHash('sha1').update(`${MODEL}|${voiceId}|${language}|${clean}`).digest('hex') + '.mp3');
  if (existsSync(file)) return file;
  const body = { text: clean, model_id: MODEL };
  if (LANG_CODE[language]) body.language_code = LANG_CODE[language];
  const r = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!r.ok) throw await failure(r);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
