// Video work with ffmpeg: read clip info, make thumbnails, and turn hook + body + CTA clips into one 9:16 ad
// with voice-over, captions, a CTA banner and music.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { db } from './db.js';
import { CLIPS_DIR, RENDERS_DIR, THUMBS_DIR, MUSIC_DIR, WORK_DIR } from './paths.js';
import { speak } from './tts.js';

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

// ---------- Captions ----------
// A font that exists here: ACC_FONT, the Docker one (fonts-dejavu-core), or a Windows one.
const FONT = [process.env.ACC_FONT, '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf'].find(f => f && existsSync(f)) || null;
export const captionsReady = () => Boolean(FONT);

// Emojis cannot be drawn with the font and must not be read aloud.
export const plain = t => String(t || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '').replace(/\s+/g, ' ').trim();

// Text → small groups of words shown one after the other, timed by their length over [t0, t1].
export function chunkCaptions(text, t0, t1, maxWords = 4, maxChars = 24) {
  const words = plain(text).split(' ').filter(Boolean);
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || (cur.join(' ') + ' ' + w).length > maxChars)) { groups.push(cur.join(' ')); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur.join(' '));
  const total = groups.reduce((s, g) => s + g.length + 2, 0) || 1;
  let t = t0;
  return groups.map(g => {
    const d = (t1 - t0) * (g.length + 2) / total;
    const c = { text: g, start: t, end: t + d };
    t += d;
    return c;
  });
}

// Long caption lines are wrapped so they stay inside the picture.
const wrap = (text, max = 16) => text.split(' ').reduce((lines, w) => {
  const last = lines[lines.length - 1];
  if (last !== undefined && (last + ' ' + w).length <= max) lines[lines.length - 1] = last + ' ' + w;
  else lines.push(w);
  return lines;
}, []).join('\n');

// A path or text inside a filter option, between single quotes (":" must still be escaped there).
const q = v => "'" + String(v).replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:') + "'";

// drawtext / drawbox filters for one part. The words go through files, so no quoting problems.
function overlays(part, workDir, tag) {
  if (!FONT || !workDir) return '';
  const out = [];
  // One drawtext per line, so every line is centred (multi-line drawtext aligns left).
  (part.captions || []).forEach((c, k) => {
    wrap(c.text).split('\n').forEach((line, l) => {
      const tf = join(workDir, `${tag}-c${k}-${l}.txt`);
      writeFileSync(tf, line);
      out.push(`drawtext=fontfile=${q(FONT)}:textfile=${q(tf)}:expansion=none:fontsize=80:fontcolor=white:borderw=7:bordercolor=black@0.9:` +
        `x=(w-text_w)/2:y=h*0.60+${l * 100}:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`);
    });
  });
  if (part.banner) {
    const tf = join(workDir, `${tag}-banner.txt`);
    writeFileSync(tf, part.banner);
    out.push('drawbox=x=0:y=ih*0.11:w=iw:h=150:color=0xFF4D2E@0.95:t=fill');
    out.push(`drawtext=fontfile=${q(FONT)}:textfile=${q(tf)}:expansion=none:fontsize=60:fontcolor=white:x=(w-text_w)/2:y=h*0.11+(150-text_h)/2`);
  }
  return out.length ? ',' + out.join(',') : '';
}

// ---------- One ad = its parts glued together ----------
// parts: [{ file, duration, hasAudio, seg, vo, captions, banner }]
//   seg = how long the part lasts in the ad (the clip loops when the voice is longer than the clip)
//   vo  = voice-over MP3 of this part. When any part has a voice, clips' own sound is left out.
// opts:  { music: file|null, workDir }
// Every part is fitted into 1080x1920 (black bars if needed) at 30 fps.
export function adArgs(parts, out, opts = {}) {
  const args = ['-y'];
  let n = 0;
  const vIn = [], voIn = [];
  parts.forEach((p, i) => {
    if (p.seg > p.duration + 0.05) args.push('-stream_loop', '-1');
    args.push('-i', p.file);
    vIn[i] = n++;
  });
  parts.forEach((p, i) => { if (p.vo) { args.push('-i', p.vo); voIn[i] = n++; } });
  let musicIn = null;
  if (opts.music) { args.push('-stream_loop', '-1', '-i', opts.music); musicIn = n++; }

  const fmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const total = parts.reduce((s, p) => s + p.seg, 0);
  const anyVoice = parts.some(p => p.vo);
  const f = [];
  parts.forEach((p, i) => {
    const d = p.seg.toFixed(3);
    f.push(`[${vIn[i]}:v]trim=0:${d},setpts=PTS-STARTPTS,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p${overlays(p, opts.workDir, 'p' + i)}[v${i}]`);
    const src = p.vo ? `[${voIn[i]}:a]${fmt},adelay=150|150`
      : !anyVoice && p.hasAudio ? `[${vIn[i]}:a]${fmt}`
      : `anullsrc=r=44100:cl=stereo,${fmt}`;
    f.push(`${src},apad,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`);
  });
  f.push(parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0[v]`);
  f.push(parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1${musicIn !== null ? '[voice]' : '[a]'}`);
  if (musicIn !== null) {
    const vol = anyVoice ? 0.13 : 0.35; // quiet under a voice, louder under the clips' own sound
    f.push(`[${musicIn}:a]${fmt},volume=${vol},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${Math.max(total - 1.2, 0).toFixed(3)}:d=1.2[mus]`);
    f.push('[voice][mus]amix=inputs=2:duration=first:normalize=0[a]');
  }
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  return args;
}

// Clips only, each at its own length with its own sound.
export const concatArgs = (parts, out) => adArgs(parts.map(p => ({ ...p, seg: p.duration })), out);

export const CTA_BANNER = { en: 'PAY ON DELIVERY', sw: 'LIPA UKIPOKEA', fr: 'PAIEMENT À LA LIVRAISON' };

// ---------- Render queue: one video at a time, in the background ----------
let busy = false;

export function queueRenders() { if (!busy) next(); }

async function next() {
  const c = db.prepare(`SELECT * FROM creatives WHERE render = 'queued' ORDER BY id LIMIT 1`).get();
  if (!c) { busy = false; return; }
  busy = true;
  db.prepare(`UPDATE creatives SET render = 'rendering', error = '' WHERE id = ?`).run(c.id);
  const workDir = join(WORK_DIR, `creative-${c.id}`);
  try {
    const script = c.script_id ? db.prepare(`SELECT * FROM scripts WHERE id = ?`).get(c.script_id) : null;
    const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(c.product_id);
    const parts = [];
    for (const [kind, id] of [['hook', c.hook_clip], ['body', c.body_clip], ['cta', c.cta_clip]]) {
      const k = id && db.prepare(`SELECT * FROM clips WHERE id = ?`).get(id);
      if (!k) continue;
      const p = { kind, file: join(CLIPS_DIR, k.file), duration: k.duration, hasAudio: !!k.has_audio, seg: k.duration };
      const text = script ? plain(script[kind]) : '';
      if (text && c.voice_id) {
        p.vo = await speak(text, c.voice_id, script.language);
        p.seg = (await probe(p.vo)).duration + (kind === 'cta' ? 0.8 : 0.35); // a short breath after the words
      }
      if (text && c.captions) p.captions = chunkCaptions(text, p.vo ? 0.15 : 0.1, p.seg - 0.15);
      if (c.captions && kind === 'cta') p.banner = (product?.banner || '').trim() || CTA_BANNER[script?.language] || CTA_BANNER.en;
      parts.push(p);
    }
    if (!parts.length) throw new Error('Its clips were deleted');
    const music = c.music_id ? db.prepare(`SELECT file FROM music WHERE id = ?`).get(c.music_id) : null;
    mkdirSync(workDir, { recursive: true });
    const name = `creative-${c.id}.mp4`, out = join(RENDERS_DIR, name);
    const r = await run(adArgs(parts, out, { music: music ? join(MUSIC_DIR, music.file) : null, workDir }));
    if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg failed: ' + r.err.trim().split('\n').slice(-3).join(' '));
    await thumbnail(out, thumbOf('creative', c.id));
    const total = parts.reduce((s, p) => s + p.seg, 0);
    db.prepare(`UPDATE creatives SET render = 'ready', file = ?, duration = ? WHERE id = ?`).run(name, total, c.id);
  } catch (e) {
    console.error(`Creative ${c.id}:`, e.message);
    db.prepare(`UPDATE creatives SET render = 'failed', error = ? WHERE id = ?`).run(String(e.message).slice(0, 500), c.id);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  next();
}

// A server restart in the middle of a render: start it again.
export function resumeRenders() {
  db.prepare(`UPDATE creatives SET render = 'queued' WHERE render = 'rendering'`).run();
  queueRenders();
}

export function removeFile(dir, name) { if (name) rmSync(join(dir, name), { force: true }); }
