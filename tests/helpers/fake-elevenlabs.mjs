// A local stand-in for the ElevenLabs API (same paths and JSON shapes as the official docs), for tests and local runs
// without a key or paid calls. Speech = a real MP3 (tones) whose length follows the text, with character timestamps.
// Options (env): FAKE_EL_NO_MUSIC=1 (music refused like a plan without music), FAKE_EL_NO_ALIGN=1 (no alignment returned).
// Run alone: node tests/helpers/fake-elevenlabs.mjs 3199
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';

const FF = process.env.FFMPEG_PATH || ffmpeg;
const dir = mkdtempSync(join(tmpdir(), 'fake-el-'));
let n = 0;
function tone(seconds, freq = 220, kind = 'speech') {
  const out = join(dir, `a${++n}.mp3`);
  const src = kind === 'speech'
    ? `sine=frequency=${freq}:duration=${seconds.toFixed(3)},volume=0.6,tremolo=f=4:d=0.7`
    : `sine=frequency=${freq}:duration=${seconds.toFixed(3)},volume=0.4`;
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', out]);
  if (r.status !== 0) throw new Error('ffmpeg failed in the fake server');
  return readFileSync(out);
}
export const VOICES = [
  { voice_id: 'v_en_f', name: 'Amara', category: 'premade', labels: { gender: 'female', age: 'young', accent: 'african', description: 'warm', use_case: 'advertisement' }, description: 'Warm, confident female voice', preview_url: '', high_quality_base_model_ids: ['eleven_multilingual_v2'],
    verified_languages: [{ language: 'en', model_id: 'eleven_multilingual_v2', accent: 'nigerian', locale: 'en-NG', preview_url: '' }, { language: 'sw', model_id: 'eleven_v3', accent: 'kenyan', locale: 'sw-KE', preview_url: '' }] },
  { voice_id: 'v_en_m', name: 'Daniel', category: 'premade', labels: { gender: 'male', age: 'middle_aged', accent: 'british', description: 'deep', use_case: 'narration' }, description: 'Deep, calm narrator', preview_url: '', high_quality_base_model_ids: ['eleven_multilingual_v2'],
    verified_languages: [{ language: 'en', model_id: 'eleven_multilingual_v2', accent: 'british', locale: 'en-GB', preview_url: '' }] },
  { voice_id: 'v_fr_f', name: 'Claire', category: 'premade', labels: { gender: 'female', age: 'young', accent: 'french', description: 'bright', use_case: 'social media' }, description: 'Bright French voice', preview_url: '', high_quality_base_model_ids: [],
    verified_languages: [{ language: 'fr', model_id: 'eleven_multilingual_v2', accent: 'parisian', locale: 'fr-FR', preview_url: '' }] },
  { voice_id: 'v_any', name: 'Sam', category: 'premade', labels: { gender: 'male', accent: 'american', use_case: 'conversational' }, description: 'Friendly', preview_url: '', high_quality_base_model_ids: [], verified_languages: [] },
];
const MODELS = [
  { model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, maximum_text_length_per_request: 10000, languages: [{ language_id: 'en', name: 'English' }, { language_id: 'fr', name: 'French' }], model_rates: { character_cost_multiplier: 1 } },
  { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: false, maximum_text_length_per_request: 5000, languages: [{ language_id: 'en', name: 'English' }, { language_id: 'fr', name: 'French' }, { language_id: 'sw', name: 'Swahili' }], model_rates: { character_cost_multiplier: 1 } },
  { model_id: 'eleven_multilingual_sts_v2', name: 'STS', can_do_text_to_speech: false, languages: [] },
];
export const calls = [];
export function startFake(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, path: u.pathname });
      const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (req.headers['xi-api-key'] !== 'test-key') return json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      if (u.pathname === '/v1/models') return json(200, MODELS);
      if (u.pathname === '/v1/user/subscription') return json(200, { tier: 'creator', status: 'active', character_count: 12000, character_limit: 100000, next_character_count_reset_unix: 1800000000, can_extend_character_limit: true, currency: 'usd' });
      if (u.pathname === '/v2/voices') {
        const size = Number(u.searchParams.get('page_size') || 10), from = Number(u.searchParams.get('next_page_token') || 0);
        const page = VOICES.slice(from, from + Math.min(size, 2)); // 2 per page to test paging
        return json(200, { voices: page, has_more: from + 2 < VOICES.length, total_count: VOICES.length, next_page_token: from + 2 < VOICES.length ? String(from + 2) : null });
      }
      const tts = u.pathname.match(/^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/);
      if (tts && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        if (!VOICES.some(v => v.voice_id === tts[1])) return json(404, { detail: { status: 'voice_not_found', message: 'Voice not found' } });
        const text = String(b.text || '');
        const speed = b.voice_settings?.speed || 1;
        const per = 0.062 / speed;
        const seconds = Math.max(0.5, text.length * per);
        const audio = tone(seconds, 200 + (tts[1].length * 10));
        const chars = [...text];
        const align = { characters: chars, character_start_times_seconds: chars.map((_, i) => +(i * per).toFixed(3)), character_end_times_seconds: chars.map((_, i) => +((i + 1) * per).toFixed(3)) };
        return json(200, { audio_base64: audio.toString('base64'), alignment: process.env.FAKE_EL_NO_ALIGN ? null : align, normalized_alignment: process.env.FAKE_EL_NO_ALIGN ? null : align },
          { 'request-id': `req_${n}`, 'character-cost': String(text.length) });
      }
      if (u.pathname === '/v1/music' && req.method === 'POST') {
        if (process.env.FAKE_EL_NO_MUSIC) return json(403, { detail: { status: 'not_allowed', message: 'Music is not available on your plan' } });
        const b = JSON.parse(body || '{}');
        const audio = tone((b.music_length_ms || 10000) / 1000, 330, 'music');
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'song-id': `song_${n}` }); return res.end(audio);
      }
      if (u.pathname === '/v1/pronunciation-dictionaries/add-from-rules' && req.method === 'POST') return json(200, { id: `dict_${++n}`, version_id: 'v1', name: 'x' });
      json(404, { detail: 'not found' });
    });
  });
  return new Promise(r => server.listen(port, () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/helpers/fake-elevenlabs.mjs')) {
  startFake(Number(process.argv[2]) || 3199).then(({ url }) => console.log(`Fake ElevenLabs on ${url} (key: test-key)`));
}
