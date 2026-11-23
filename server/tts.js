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

async function failure(r) {
  let msg = '';
  try { const j = await r.json(); msg = j?.detail?.message || j?.detail?.status || (typeof j?.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)); } catch {}
  if (r.status === 401) return new HttpError(502, 'ElevenLabs key is wrong or missing (ELEVENLABS_API_KEY).');
  if (r.status === 429) return new HttpError(429, 'ElevenLabs is busy or your monthly characters are used up. ' + msg);
  return new HttpError(502, `ElevenLabs error ${r.status}: ${msg}`.slice(0, 300));
}

// The account's voices (premade + your own), cached 10 minutes.
let cache = { at: 0, list: [] };
export async function listVoices() {
  if (!ttsReady()) return [];
  if (Date.now() - cache.at < 10 * 60e3 && cache.list.length) return cache.list;
  const list = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ page_size: '100', sort: 'name', sort_direction: 'asc' });
    if (token) q.set('next_page_token', token);
    const r = await fetch(`${API}/v2/voices?${q}`, { headers: headers() });
    if (!r.ok) throw await failure(r);
    const j = await r.json();
    for (const v of j.voices || []) {
      const l = v.labels || {};
      list.push({ id: v.voice_id, name: v.name, category: v.category || '', preview: v.preview_url || '',
        info: [l.gender, l.accent, l.age, l.language].filter(Boolean).join(' · ') });
    }
    if (!j.has_more || !j.next_page_token) break;
    token = j.next_page_token;
  }
  cache = { at: Date.now(), list };
  return list;
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
