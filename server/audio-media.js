// Audio tools (ffmpeg / ffprobe): measure files, loudness, waveform peaks, music preparation (trim, loop, fades),
// voice-over splicing (segment regeneration) and the final mix (gains from measured loudness, ducking, normalisation, limiter).
// Original files are never changed: every step writes a new file.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { ff, ffError, ffprobePath } from './footage-media.js';

const num = (n, d) => { const r = process.env[n]; const v = Number(r); return r !== undefined && r !== '' && Number.isFinite(v) ? v : d; };
export const MIX_DEFAULTS = {
  voice_lufs: num('AU_VOICE_LUFS', -16),           // voice level before the mix
  music_rel_db: num('AU_MUSIC_REL_DB', -12),       // music loudness relative to the voice (LU)
  final_lufs: num('AU_FINAL_LUFS', -14),           // integrated loudness of the mix (social video)
  true_peak: num('AU_TRUE_PEAK', -1.5),            // dBTP ceiling
  ducking: true, duck_ratio: 6, duck_threshold: 0.02,
  fade_in: 0.6, fade_out: 1.2, voice_gain_db: 0, music_gain_db: 0, lead_in: num('AU_LEAD_IN', 0.25),
};

// Duration, sample rate, channels, codec, read by ffprobe.
export function probeAudio(file) {
  const bin = ffprobePath();
  if (!bin) return Promise.reject(new Error('ffprobe is not installed'));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration,format_name', '-of', 'json', file], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      try {
        const j = JSON.parse(out); const s = j.streams?.[0];
        if (code !== 0 || !s) return reject(new Error('Not a readable audio file' + (err ? `: ${err.trim().slice(0, 160)}` : '')));
        resolve({ duration: Number(j.format?.duration) || 0, sample_rate: Number(s.sample_rate) || 0, channels: s.channels || 0, codec: s.codec_name || '', format: j.format?.format_name || '' });
      } catch (e) { reject(new Error('ffprobe could not read the file')); }
    });
    p.on('error', reject);
  });
}

// Integrated loudness (LUFS), true peak (dBTP) and loudness range.
export async function loudness(file, ctx) {
  const r = await ff(['-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], ctx);
  const m = r.err.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) return { i: null, tp: null, lra: null };
  const j = JSON.parse(m[0]);
  const n = x => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 10) / 10 : null);
  return { i: n(j.input_i), tp: n(j.input_tp), lra: n(j.input_lra) };
}

// ~200 peak values (0-1) to draw a waveform.
export async function peaks(file, points = 200, ctx) {
  const r = await ff(['-i', file, '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'], ctx, { binary: true });
  const buf = r.out || Buffer.alloc(0);
  const n = Math.floor(buf.length / 2);
  if (!n) return [];
  const per = Math.max(1, Math.floor(n / points)), out = [];
  for (let i = 0; i < n; i += per) {
    let mx = 0;
    for (let k = i; k < Math.min(n, i + per); k++) mx = Math.max(mx, Math.abs(buf.readInt16LE(k * 2)));
    out.push(Math.round((mx / 32768) * 100) / 100);
  }
  return out.slice(0, points);
}

// Music cut to the creative's length: start offset, loop when too short, fades. Returns what was done.
export async function prepareMusic(src, out, { length, start = 0, fade_in = 0.6, fade_out = 1.2 }, ctx) {
  const info = await probeAudio(src);
  const avail = Math.max(0, info.duration - start);
  const loop = avail + 0.05 < length;
  const fo = Math.min(fade_out, length / 3), fi = Math.min(fade_in, length / 4);
  const chain = [`atrim=start=${start.toFixed(3)}`, 'asetpts=PTS-STARTPTS'];
  const args = ['-y'];
  if (loop) args.push('-stream_loop', '-1');
  args.push('-i', src, '-af', [...(loop ? [] : chain), `atrim=duration=${length.toFixed(3)}`, 'asetpts=PTS-STARTPTS',
    `afade=t=in:st=0:d=${fi.toFixed(2)}`, `afade=t=out:st=${Math.max(0, length - fo).toFixed(3)}:d=${fo.toFixed(2)}`].join(','),
  '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', out);
  const r = await ff(args, ctx);
  if (r.code !== 0 || !existsSync(out)) throw ffError(r, 'Could not prepare the music');
  return { source_duration: Math.round(info.duration * 100) / 100, start: loop ? 0 : start, length: Math.round(length * 100) / 100, loop, fade_in: fi, fade_out: fo };
}

// Replace a time range of a voice-over with a new piece (segment regeneration), with tiny crossfades at both joins.
export async function splice(src, from, to, piece, out, ctx) {
  const xf = 0.03;
  const filter = `[0:a]atrim=end=${from.toFixed(3)},asetpts=PTS-STARTPTS[a];[0:a]atrim=start=${to.toFixed(3)},asetpts=PTS-STARTPTS[c];[1:a]asetpts=PTS-STARTPTS[b];`
    + `[a][b]acrossfade=d=${xf}:c1=tri:c2=tri[ab];[ab][c]acrossfade=d=${xf}:c1=tri:c2=tri[o]`;
  const r = await ff(['-y', '-i', src, '-i', piece, '-filter_complex', filter, '-map', '[o]', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', out], ctx);
  if (r.code !== 0 || !existsSync(out)) throw ffError(r, 'Could not join the regenerated segment');
}

// Join voice-over pieces (long scripts generated in several requests).
export async function concatAudio(files, out, ctx) {
  const inputs = files.flatMap(f => ['-i', f]);
  const filter = files.map((_, i) => `[${i}:a]aresample=44100[a${i}]`).join(';') + ';' + files.map((_, i) => `[a${i}]`).join('') + `concat=n=${files.length}:v=0:a=1[o]`;
  const r = await ff(['-y', ...inputs, '-filter_complex', filter, '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '192k', out], ctx);
  if (r.code !== 0 || !existsSync(out)) throw ffError(r, 'Could not join the voice-over parts');
}

// The mix: voice (gain from its measured loudness) + music (relative level, ducked under speech) → loudness-normalised and limited.
// voice / music may be null (voice-only or music-only). Returns the settings used and the measured result.
export async function mix({ voice, music, out, length, cfg }, ctx) {
  const c = { ...MIX_DEFAULTS, ...(cfg || {}) };
  const vL = voice ? await loudness(voice, ctx) : null, mL = music ? await loudness(music, ctx) : null;
  const vGain = voice ? (c.voice_lufs - (vL.i ?? c.voice_lufs)) + c.voice_gain_db : 0;
  const mGain = music ? ((c.voice_lufs + c.music_rel_db) - (mL.i ?? (c.voice_lufs + c.music_rel_db))) + c.music_gain_db : 0;
  const lead = Math.round((voice ? c.lead_in : 0) * 1000);
  const inputs = [], parts = [];
  if (voice) { inputs.push('-i', voice); }
  if (music) { inputs.push('-i', music); }
  const vi = 0, mi = voice ? 1 : 0;
  const fmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  if (voice) parts.push(`[${vi}:a]${fmt},adelay=${lead}|${lead},volume=${vGain.toFixed(2)}dB,apad=whole_dur=${length.toFixed(3)}${music && c.ducking ? ',asplit=2[v][vsc]' : '[v]'}`);
  if (music) parts.push(`[${mi}:a]${fmt},volume=${mGain.toFixed(2)}dB,atrim=duration=${length.toFixed(3)}[m0]`);
  if (music && voice && c.ducking) parts.push(`[m0][vsc]sidechaincompress=threshold=${c.duck_threshold}:ratio=${c.duck_ratio}:attack=15:release=350:makeup=1[m]`);
  else if (music) parts.push('[m0]anull[m]');
  // Two passes: the raw mix is measured, then one exact gain brings it to the target loudness and a limiter keeps the
  // true peak under the ceiling (a single dynamic loudnorm pass is imprecise on short ads).
  const raw = out.replace(/\.[^.\\/]+$/, '') + '.raw.wav';
  const trim = `atrim=duration=${length.toFixed(3)}`;
  if (voice && music) parts.push(`[v][m]amix=inputs=2:normalize=0:duration=longest,${trim}[o]`);
  else parts.push(`[${voice ? 'v' : 'm'}]${trim}[o]`);
  const r1 = await ff(['-y', ...inputs, '-filter_complex', parts.join(';'), '-map', '[o]', '-ar', '44100', '-c:a', 'pcm_f32le', raw], ctx);
  if (r1.code !== 0 || !existsSync(raw)) throw ffError(r1, 'Could not mix the audio');
  try {
    const pre = await loudness(raw, ctx);
    const gain = Number.isFinite(pre.i) ? c.final_lufs - pre.i : 0;
    const limit = Math.pow(10, (c.true_peak - 0.5) / 20).toFixed(4);
    const r = await ff(['-y', '-i', raw, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=${limit}:attack=2:release=50:level=false,${trim}`, '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', out], ctx);
    if (r.code !== 0 || !existsSync(out)) throw ffError(r, 'Could not mix the audio');
  } finally { rmSync(raw, { force: true }); }
  const result = await loudness(out, ctx);
  return { config: c, measured: { voice: vL, music: mL, mix: result }, gains: { voice_db: Math.round(vGain * 10) / 10, music_db: Math.round(mGain * 10) / 10 }, lead_in: lead / 1000 };
}
