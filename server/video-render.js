// FFmpeg rendering engine (CPU only). Commands are built here from validated EDL values only (numbers clamped, enums
// checked, files are local temporary paths): no shell, no AI-written filter graph. Steps: source resolution →
// accurate trim + normalisation of every clip (cached) → timeline assembly (stream copy, or xfade when crossfades) →
// approved audio (Module 5 mix, or a re-mix with new levels from the same voice and music files) → MP4 → thumbnail.
// Every source is opened with "-map 0:v:0" and "-an": footage sound can never reach the output.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, statfsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { ffmpegBin, ffprobePath } from './footage-media.js';
import { mix as mixAudio, MIX_DEFAULTS } from './audio-media.js';
import { QUALITY, LIMITS, FRAMINGS, MOTIONS, outputSize } from './video-schemas.js';

const f3 = x => (Math.round(Number(x) * 1000) / 1000).toFixed(3);
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number(x) || 0));

// ffmpeg with real progress (-progress pipe:1 → out_time). Killed on cancel (ctx.children) or timeout.
export function run(args, ctx = null, { onTime = null, timeout = LIMITS.renderTimeout * 1000 } = {}) {
  return new Promise(resolve => {
    const p = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
    ctx?.children?.add(p);
    let err = '', buf = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} err += '\nTimed out'; }, timeout);
    p.stdout.on('data', d => { buf += d; const m = buf.match(/out_time_us=(\d+)/g); if (m && onTime) onTime(Number(m.at(-1).split('=')[1]) / 1e6); if (buf.length > 4000) buf = buf.slice(-500); });
    p.stderr.on('data', d => { err += d; if (err.length > 200e3) err = err.slice(-100e3); });
    p.on('close', (code, signal) => { clearTimeout(timer); ctx?.children?.delete(p); resolve({ code, signal, err }); });
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, err: e.message }); });
  });
}
const fail = (r, what) => new Error(`${what}: ${(r.err || '').split('\n').filter(l => /error|invalid|no such|not found|timed out|failed/i.test(l)).slice(-2).join(' ').slice(0, 300) || `ffmpeg exit ${r.code}`}`);

export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath(), ['-v', 'error', '-count_packets', '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,duration,pix_fmt,sample_rate,channels:format=duration,size,format_name', '-of', 'json', file], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      try {
        const j = JSON.parse(out);
        if (code !== 0) throw new Error(err);
        const v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.find(s => s.codec_type === 'audio');
        const rate = s => { const [x, y] = String(s || '0/1').split('/').map(Number); return y ? x / y : 0; };
        resolve({ duration: Number(j.format.duration) || 0, size: Number(j.format.size) || 0, format: j.format.format_name,
          video: v && { codec: v.codec_name, width: v.width, height: v.height, fps: Math.round(rate(v.avg_frame_rate || v.r_frame_rate) * 100) / 100, frames: Number(v.nb_read_packets) || 0, duration: Number(v.duration) || 0, pix_fmt: v.pix_fmt },
          audio: a && { codec: a.codec_name, duration: Number(a.duration) || 0, sample_rate: Number(a.sample_rate) || 0, channels: a.channels }, audio_streams: j.streams.filter(s => s.codec_type === 'audio').length });
      } catch (e) { reject(new Error('The video file cannot be read' + (err ? `: ${err.trim().slice(0, 200)}` : ''))); }
    });
    p.on('error', reject);
  });
}

// Which stored file to read for a clip: the silent copy (always silent) unless a higher-resolution original is needed.
export function sourceFor(assetId, quality, outW, outH) {
  const a = db.prepare(`SELECT id, storage_key, proxy_key, width, height, silent FROM footage_assets WHERE id = ?`).get(assetId);
  if (!a) throw new HttpError(409, `Footage ${assetId} was deleted`);
  if (!a.silent || !a.proxy_key) throw new HttpError(409, `Footage ${assetId} has no verified silent copy (Module 2)`);
  const needLong = Math.max(outW, outH), origLong = Math.max(a.width, a.height);
  const useOriginal = quality !== 'preview' && origLong > 1280 && needLong > 1280 && !!a.storage_key;
  return { key: useOriginal ? a.storage_key : a.proxy_key, original: useOriginal, alt: a.proxy_key };
}

// Filter graph of one clip, from validated values only.
export function clipGraph(c, { W, H, fps, fadeIn = 0, fadeOut = 0, frames }) {
  const mode = FRAMINGS.includes(c.crop?.mode) ? c.crop.mode : 'center_crop';
  const z = clamp(c.crop?.zoom ?? 1, 1, 2), fx = clamp(c.crop?.x ?? 0.5, 0, 1), fy = clamp(c.crop?.y ?? 0.5, 0, 1);
  const speed = clamp(c.speed || 1, 0.5, 2);
  const pre = `[0:v]setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=${fps}`;
  const zw = Math.round((W * z) / 2) * 2, zh = Math.round((H * z) / 2) * 2;
  let g;
  if (mode === 'fit_background') {
    g = `${pre},split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  } else {
    g = `${pre},scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${fx.toFixed(3)}:(ih-${H})*${fy.toFixed(3)},setsar=1`;
  }
  const motion = MOTIONS.includes(c.motion) ? c.motion : 'none';
  if (motion !== 'none') {
    const n = Math.max(1, frames);
    const zexpr = motion === 'zoom_in' ? `1+0.06*on/${n}` : `1.06-0.06*on/${n}`;
    g += `,zoompan=z='${zexpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`;
  }
  // The planned hold, plus two frames of safety against rounding at the end of a source (the frame count is exact anyway).
  g += `,tpad=stop_mode=clone:stop_duration=${f3(clamp(c.hold || 0, 0, LIMITS.maxHold) + 2 / fps)}`;
  if (fadeIn > 0) g += `,fade=t=in:st=0:d=${f3(fadeIn)}`;
  if (fadeOut > 0) g += `,fade=t=out:st=${f3(frames / fps - fadeOut)}:d=${f3(fadeOut)}`;
  return `${g},format=yuv420p[v]`;
}

// Fades and crossfade handles from the transitions (all inside the timeline: total length never changes).
export function transitionsOf(edl) {
  const v = edl.tracks.video, fps = edl.timeline.fps, out = v.map(() => ({ fadeIn: 0, fadeOut: 0, handle: 0, xfade: 0 }));
  v.forEach((c, i) => {
    const t = c.transition_in?.type, d = clamp(c.transition_in?.duration ?? LIMITS.transition, 0.1, 1.5);
    const len = c.frames / fps, prevLen = i ? v[i - 1].frames / fps : 0;
    if (t === 'fade_in') out[i].fadeIn = Math.min(d, len / 2);
    if (t === 'fade_out' && i) out[i - 1].fadeOut = Math.min(d, prevLen / 2);
    if (t === 'dip_to_black' && i) { out[i - 1].fadeOut = Math.min(d / 2, prevLen / 2); out[i].fadeIn = Math.min(d / 2, len / 2); }
    if (t === 'crossfade' && i && len >= d * 1.5 && prevLen >= d * 1.5) {
      const sceneStart = c._scene_start ?? 0;
      if (c.source_start - d * c.speed >= sceneStart - 0.002) { out[i].handle = Math.round(d * fps) / fps; out[i].xfade = out[i].handle; }
    }
  });
  if (v.length) out[v.length - 1].fadeOut = Math.max(out[v.length - 1].fadeOut, 0); // the CTA ends on its last frame (no forced fade)
  return out;
}

const cacheKeyOf = (c, src, tr, W, H, fps, q) => createHash('sha256').update(JSON.stringify([src, c.source_start, c.source_end, c.speed, c.crop, c.motion, c.hold, c.frames, tr, W, H, fps, q.preset, q.clip_crf ?? q.crf, 'v1'])).digest('hex');

// Render one EDL to an MP4. Returns the file path (in work) and details. stage(name, progress 0-1) reports progress.
export async function renderEdl({ edl, quality = 'preview', work, ctx, stage, log, scenesById, projectId }) {
  const q = QUALITY[quality] || QUALITY.preview;
  const [W, H] = outputSize(edl.timeline.aspect_ratio, quality), fps = edl.timeline.fps;
  // Free temporary disk before starting (a full disk breaks renders in confusing ways).
  try { const s = statfsSync(TMP_DIR); const free = (s.bavail * s.bsize) / 1048576; if (free < LIMITS.minFreeDiskMb) throw new HttpError(507, `Only ${Math.round(free)} MB of temporary disk left (need ${LIMITS.minFreeDiskMb} MB).`); } catch (e) { if (e instanceof HttpError) throw e; }
  mkdirSync(work, { recursive: true });
  const v = edl.tracks.video.map(c => ({ ...c, _scene_start: scenesById.get(c.scene_id)?.start ?? 0 }));
  const tr = transitionsOf({ ...edl, tracks: { ...edl.tracks, video: v } });
  // 1. Sources and clips
  stage('resolving_footage', 0.05);
  const local = new Map();
  const getSrc = async (c) => {
    const s = sourceFor(c.asset_id, quality, W, H);
    if (local.has(s.key)) return { ...s, file: local.get(s.key) };
    let key = s.key;
    if (!(await storage.exists(key))) { if (s.original && (await storage.exists(s.alt))) key = s.alt; else throw new HttpError(409, `The footage file of clip ${c.order} is missing from storage (${key}).`); }
    const f = await storage.toLocal(key, join(work, `src-${local.size}${key.match(/\.\w+$/)?.[0] || '.mp4'}`));
    local.set(s.key, f);
    return { ...s, key, file: f };
  };
  stage('preparing_video', 0.1);
  const files = [];
  let cached = 0;
  for (const [i, c] of v.entries()) {
    ctx?.check?.();
    const t = tr[i];
    const src = await getSrc(c);
    const totalFrames = c.frames + Math.round(t.handle * fps);
    const hash = cacheKeyOf(c, src.key, t, W, H, fps, q);
    let out = join(work, `clip-${String(i).padStart(3, '0')}.mp4`);
    const hit = db.prepare(`SELECT storage_key FROM vd_clip_cache WHERE hash = ?`).get(hash);
    if (hit && (await storage.exists(hit.storage_key))) {
      out = await storage.toLocal(hit.storage_key, out); cached++; // (on the volume driver this is the stored file itself: read only)
      db.prepare(`UPDATE vd_clip_cache SET used_at = datetime('now') WHERE hash = ?`).run(hash);
    } else {
      const start = Math.max(0, c.source_start - t.handle * c.speed);
      const srcLen = c.source_end - c.source_start + t.handle * c.speed;
      const graph = clipGraph(c, { W, H, fps, fadeIn: t.fadeIn, fadeOut: t.fadeOut, frames: totalFrames });
      // -ss before -i with re-encoding decodes from the previous keyframe and drops frames up to the exact time (frame accurate).
      const r = await run(['-y', '-ss', f3(start), '-t', f3(srcLen + 0.5), '-i', src.file, '-filter_complex', graph, '-map', '[v]', '-an', '-sn', '-dn',
        '-frames:v', String(totalFrames), '-r', String(fps), '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.clip_crf ?? q.crf), '-g', String(fps * 2),
        '-pix_fmt', 'yuv420p', '-threads', String(LIMITS.ffThreads), '-video_track_timescale', String(fps * 1000), out], ctx);
      if (r.code !== 0 || !existsSync(out)) throw fail(r, `Clip ${c.order} could not be prepared`);
      const key = `video/cache/p${projectId}/${hash.slice(0, 24)}.mp4`;
      await storage.put(key, out, 'video/mp4');
      db.prepare(`INSERT OR REPLACE INTO vd_clip_cache (hash, storage_key, frames, size, project_id) VALUES (?,?,?,?,?)`).run(hash, key, totalFrames, statSync(out).size, projectId);
    }
    files.push(out);
    stage('preparing_video', 0.1 + 0.5 * ((i + 1) / v.length));
  }
  log?.(`${v.length} clips ready (${cached} reused from the cache)`);
  // 2. Audio: the approved mix, or a new mix of the same voice and music files with the team's levels. Never footage audio.
  stage('preparing_audio', 0.62);
  let audio = null;
  const A = edl.tracks, needAudio = !!(A.voiceover || A.music);
  if (needAudio) {
    if (edl.audio.uses_package_mix && A.mix?.key) audio = await storage.toLocal(A.mix.key, join(work, 'mix.mp3'));
    else {
      const voice = A.voiceover ? await storage.toLocal(A.voiceover.key, join(work, 'voice.mp3')) : null;
      const music = A.music ? await storage.toLocal(A.music.key, join(work, 'music.mp3')) : null;
      const cfg = { ...MIX_DEFAULTS, ...(A.mix?.config || {}) };
      cfg.voice_gain_db = (cfg.voice_gain_db || 0) + edl.audio.voice_gain_db;
      cfg.music_gain_db = (cfg.music_gain_db || 0) + edl.audio.music_gain_db;
      audio = join(work, 'mix-new.mp3');
      await mixAudio({ voice, music, out: audio, length: edl.timeline.duration, cfg }, ctx);
      log?.(`Audio re-mixed with voice ${edl.audio.voice_gain_db >= 0 ? '+' : ''}${edl.audio.voice_gain_db} dB, music ${edl.audio.music_gain_db >= 0 ? '+' : ''}${edl.audio.music_gain_db} dB (no new voice or music generated)`);
    }
  }
  // 3. Timeline: stream copy of identical clips when there is no crossfade (no second encode), else one xfade pass.
  stage('building_timeline', 0.66);
  const videoOnly = join(work, 'video.mp4');
  const dur = edl.timeline.duration;
  if (!tr.some(t => t.xfade)) {
    writeFileSync(join(work, 'list.txt'), files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const r = await run(['-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'), '-map', '0:v:0', '-an', '-c', 'copy', videoOnly], ctx);
    if (r.code !== 0) throw fail(r, 'The timeline could not be assembled');
  } else {
    stage('rendering', 0.7);
    const inputs = files.flatMap(f => ['-i', f]);
    const parts = files.map((_, i) => `[${i}:v]fps=${fps},settb=1/${fps},setpts=PTS-STARTPTS[s${i}]`);
    let acc = 's0', accLen = (v[0].frames) / fps;
    for (let i = 1; i < files.length; i++) {
      const o = `a${i}`;
      if (tr[i].xfade) { parts.push(`[${acc}][s${i}]xfade=transition=fade:duration=${f3(tr[i].xfade)}:offset=${f3(accLen - tr[i].xfade)}[${o}]`); }
      else parts.push(`[${acc}][s${i}]concat=n=2:v=1:a=0,settb=1/${fps}[${o}]`);
      accLen += v[i].frames / fps; acc = o;
    }
    const r = await run(['-y', ...inputs, '-filter_complex', parts.join(';'), '-map', `[${acc}]`, '-an', '-frames:v', String(edl.timeline.frames), '-r', String(fps), '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
      '-pix_fmt', 'yuv420p', '-threads', String(LIMITS.ffThreads), videoOnly], ctx, { onTime: t => stage('rendering', 0.7 + 0.15 * Math.min(1, t / dur)) });
    if (r.code !== 0) { if (process.env.VD_KEEP_WORK) writeFileSync(join(work, 'xfade-error.txt'), JSON.stringify({ inputs, graph: parts }, null, 1) + '\n' + r.err); throw fail(r, 'The transitions could not be rendered'); }
  }
  // 4. Final MP4: video + approved audio, exact length, web-optimised.
  stage('rendering', 0.86);
  const final = join(work, 'final.mp4');
  const args = ['-y', '-i', videoOnly];
  if (audio) args.push('-i', audio);
  args.push('-map', '0:v:0');
  if (audio) args.push('-map', '1:a:0', '-af', `apad,atrim=0:${f3(dur)}`, '-c:a', 'aac', '-b:a', `${q.audio_kbps}k`, '-ar', '48000');
  else args.push('-an');
  args.push('-c:v', 'copy', '-t', f3(dur), '-movflags', '+faststart', final);
  const r = await run(args, ctx);
  if (r.code !== 0 || !existsSync(final)) throw fail(r, 'The video could not be written');
  // 5. Thumbnail (the hook frame).
  const thumb = join(work, 'thumb.jpg');
  await run(['-y', '-ss', f3(Math.min(1, dur / 3)), '-i', final, '-frames:v', '1', '-vf', 'scale=480:-2', thumb], ctx);
  const tempBytes = readdirSync(work).reduce((n, f) => { try { return n + statSync(join(work, f)).size; } catch { return n; } }, 0);
  return { file: final, thumb: existsSync(thumb) ? thumb : null, audio, W, H, fps, cached, clips: v.length, tempBytes };
}

// ---------- Quality control: measured checks (errors) and review hints (warnings) ----------
export async function qualityCheck(file, edl, { W, H, fps, expectAudio, quality }, ctx) {
  const errors = [], warnings = [], measured = {};
  const E = (code, message) => errors.push({ code, message, kind: 'measured' }), Wn = (code, message, kind = 'measured') => warnings.push({ code, message, kind });
  let info;
  try { info = await probeVideo(file); } catch (e) { E('corrupt', e.message); return { errors, warnings, measured, ok: false }; }
  measured.probe = info;
  const dur = edl.timeline.duration, tol = LIMITS.frameTolerance / fps;
  if (!info.video) E('no_video', 'The file has no video stream.');
  else {
    if (info.video.width !== W || info.video.height !== H) E('size', `Size ${info.video.width}×${info.video.height}, expected ${W}×${H}.`);
    if (Math.abs(info.video.fps - fps) > 0.05) E('fps', `Frame rate ${info.video.fps}, expected ${fps}.`);
    if (Math.abs(info.duration - dur) > tol + 0.05) E('duration', `Duration ${info.duration.toFixed(3)} s, expected ${dur} s.`);
    const expFrames = edl.timeline.frames;
    if (info.video.frames && Math.abs(info.video.frames - expFrames) > LIMITS.frameTolerance) E('frames', `${info.video.frames} frames, expected ${expFrames}.`);
    if (info.video.codec !== 'h264' || info.video.pix_fmt !== 'yuv420p') E('codec', `Video is ${info.video.codec}/${info.video.pix_fmt}, expected h264/yuv420p.`);
  }
  if (expectAudio) {
    if (!info.audio) E('no_audio', 'The voice-over / music track is missing.');
    else {
      if (info.audio_streams !== 1) E('audio_streams', `${info.audio_streams} audio tracks found (only the approved mix is allowed).`);
      if (Math.abs(info.audio.duration - (info.video?.duration || info.duration)) > 2 / fps + 0.05) E('drift', `Audio lasts ${info.audio.duration.toFixed(3)} s, video ${(info.video?.duration || 0).toFixed(3)} s.`);
      const speechEnd = edl.tracks.voiceover?.speech_end;
      if (speechEnd && info.audio.duration + 0.02 < speechEnd) E('voice_cut', `The voice-over ends at ${speechEnd} s but the audio stops at ${info.audio.duration.toFixed(2)} s.`);
    }
  } else if (info.audio) E('unexpected_audio', 'The video has sound although voice-over and music are off.');
  // One decoding pass: black frames, frozen frames, silence, loudness and true peak; decoding errors mean corruption.
  const af = expectAudio && info.audio ? ['-af', 'silencedetect=n=-50dB:d=1.5,ebur128=peak=true'] : ['-an'];
  const r = await run(['-i', file, '-vf', 'blackdetect=d=0.25:pix_th=0.08,freezedetect=n=0.001:d=1.5', ...af, '-f', 'null', '-'], ctx);
  if (r.code !== 0 || /error while decoding|corrupt|invalid nal/i.test(r.err)) E(/Invalid data|Error opening input|moov atom/i.test(r.err) ? 'corrupt' : 'decode', 'The video does not decode cleanly' + (r.err ? `: ${r.err.split('\n').filter(l => /error|corrupt/i.test(l)).slice(0, 1).join('')}` : ''));
  const blacks = [...r.err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const freezes = [...r.err.matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_duration: ([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const silences = [...r.err.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const loud = r.err.match(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS[\s\S]*?True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/);
  measured.black = blacks; measured.freeze = freezes; measured.silence = silences;
  if (loud) measured.loudness = { i: Number(loud[1]), true_peak: loud[2] === '-inf' ? null : Number(loud[2]) };
  const tr = transitionsOf(edl), v = edl.tracks.video;
  const planned = v.flatMap((c, i) => [tr[i].fadeIn ? [c.timeline_start, c.timeline_start + tr[i].fadeIn] : null, tr[i].fadeOut ? [c.timeline_end - tr[i].fadeOut, c.timeline_end] : null]).filter(Boolean);
  for (const [a, b] of blacks) {
    if (planned.some(([x, y]) => a >= x - 0.1 && b <= y + 0.1)) continue;
    if (b - a >= 1 || a < 0.05) E('black', `Black picture from ${a.toFixed(2)} to ${b.toFixed(2)} s.`);
    else Wn('black', `Short dark moment at ${a.toFixed(2)} s (check the footage).`);
  }
  for (const [a, d] of freezes) {
    const held = v.some(c => c.hold > 0 && a >= c.timeline_end - c.hold - 0.2 && a <= c.timeline_end);
    if (d >= 3 && !held) Wn('frozen', `The picture does not move for ${d.toFixed(1)} s from ${a.toFixed(1)} s (a very static shot, or a frozen video).`);
  }
  const vo = edl.tracks.voiceover;
  if (vo) for (const [a, b] of silences) if (b > vo.start + 0.5 && a < vo.speech_end - 0.5 && b - a > 2) Wn('silence', `No sound from ${a.toFixed(1)} to ${b.toFixed(1)} s while the voice should be speaking.`);
  if (measured.loudness?.true_peak != null) {
    if (measured.loudness.true_peak > -0.1) E('clipping', `Audio peaks at ${measured.loudness.true_peak} dBTP: clipping.`);
    else if (measured.loudness.true_peak > -1) Wn('peak', `Audio peaks at ${measured.loudness.true_peak} dBTP.`);
  }
  return { errors, warnings, measured, ok: !errors.length, quality, checked_at: new Date().toISOString() };
}

export function cleanup(work) { if (process.env.VD_KEEP_WORK) return; try { rmSync(work, { recursive: true, force: true }); } catch {} }
