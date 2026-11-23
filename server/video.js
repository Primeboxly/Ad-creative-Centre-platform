// Video work with ffmpeg: read clip info, make thumbnails, and glue hook + body + CTA into one 9:16 ad.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { db } from './db.js';
import { CLIPS_DIR, RENDERS_DIR, THUMBS_DIR } from './paths.js';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;
export const WIDTH = 1080, HEIGHT = 1920; // vertical: Reels, TikTok, Stories

export function run(args) {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-hide_banner', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 200e3) err = err.slice(-100e3); });
    p.on('close', code => resolve({ code, err }));
    p.on('error', e => resolve({ code: -1, err: String(e) }));
  });
}

// Duration (seconds), whether it has sound, and whether it is a video at all.
export async function probe(file) {
  const { err } = await run(['-i', file]);
  const m = err.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0,
    hasVideo: /Stream #.*Video:/.test(err),
    hasAudio: /Stream #.*Audio:/.test(err),
  };
}

export async function thumbnail(input, out) {
  const r = await run(['-y', '-ss', '0.3', '-i', input, '-frames:v', '1', '-update', '1', '-vf', 'scale=360:-2', '-q:v', '4', out]);
  if (r.code !== 0) await run(['-y', '-i', input, '-frames:v', '1', '-update', '1', '-vf', 'scale=360:-2', '-q:v', '4', out]);
}

export const thumbOf = (type, id) => join(THUMBS_DIR, `${type}-${id}.jpg`);

// ffmpeg arguments that join the parts (each { file, duration, hasAudio }) into one MP4.
// Every part is fitted into 1080x1920 (black bars if needed), 30 fps; parts without sound get silence.
export function concatArgs(parts, out) {
  const args = ['-y'];
  parts.forEach(p => args.push('-i', p.file));
  const silent = [];
  parts.forEach((p, i) => {
    if (!p.hasAudio) { silent[i] = parts.length + silent.filter(x => x !== undefined).length; args.push('-f', 'lavfi', '-t', String(p.duration), '-i', 'anullsrc=r=44100:cl=stereo'); }
  });
  const f = [];
  parts.forEach((p, i) => {
    const d = p.duration.toFixed(3);
    f.push(`[${i}:v]trim=0:${d},setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${i}]`);
    const src = p.hasAudio ? `${i}:a` : `${silent[i]}:a`;
    f.push(`[${src}]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`);
  });
  f.push(parts.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${parts.length}:v=1:a=1[v][a]`);
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
  return args;
}

// ---------- Render queue: one video at a time, in the background ----------
let busy = false;

export function queueRenders() { if (!busy) next(); }

async function next() {
  const c = db.prepare(`SELECT * FROM creatives WHERE render = 'queued' ORDER BY id LIMIT 1`).get();
  if (!c) { busy = false; return; }
  busy = true;
  db.prepare(`UPDATE creatives SET render = 'rendering', error = '' WHERE id = ?`).run(c.id);
  try {
    const ids = [c.hook_clip, c.body_clip, c.cta_clip].filter(Boolean);
    const clips = ids.map(id => db.prepare(`SELECT * FROM clips WHERE id = ?`).get(id)).filter(Boolean);
    if (!clips.length) throw new Error('Its clips were deleted');
    const parts = clips.map(k => ({ file: join(CLIPS_DIR, k.file), duration: k.duration, hasAudio: !!k.has_audio }));
    const name = `creative-${c.id}.mp4`, out = join(RENDERS_DIR, name);
    const r = await run(concatArgs(parts, out));
    if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg failed: ' + r.err.trim().split('\n').slice(-3).join(' '));
    await thumbnail(out, thumbOf('creative', c.id));
    const total = parts.reduce((s, p) => s + p.duration, 0);
    db.prepare(`UPDATE creatives SET render = 'ready', file = ?, duration = ? WHERE id = ?`).run(name, total, c.id);
  } catch (e) {
    console.error(`Creative ${c.id}:`, e.message);
    db.prepare(`UPDATE creatives SET render = 'failed', error = ? WHERE id = ?`).run(e.message.slice(0, 500), c.id);
  }
  next();
}

// A server restart in the middle of a render: start it again.
export function resumeRenders() {
  db.prepare(`UPDATE creatives SET render = 'queued' WHERE render = 'rendering'`).run();
  queueRenders();
}

export function removeFile(dir, name) { if (name) rmSync(join(dir, name), { force: true }); }
