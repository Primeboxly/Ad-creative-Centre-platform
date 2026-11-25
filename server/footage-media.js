// Video tools for the footage library: read a video's details, plan scenes, grab frames,
// and measure each scene (sharpness, light, contrast, movement, picture fingerprint) without any AI.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;

// Run ffmpeg. `ctx.children` (a Set) lets a cancelled job stop it. `binary` keeps stdout as a Buffer.
export function ff(args, ctx = null, { binary = false } = {}) {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    ctx?.children?.add(p);
    let err = '';
    const out = [];
    p.stderr.on('data', d => { err += d; if (err.length > 200e3) err = err.slice(-100e3); });
    p.stdout.on('data', d => { if (binary) out.push(d); });
    p.on('close', (code, signal) => { ctx?.children?.delete(p); resolve({ code, signal, err, out: binary ? Buffer.concat(out) : null }); });
    p.on('error', e => { ctx?.children?.delete(p); resolve({ code: -1, err: String(e), out: null }); });
  });
}

// A failed ffmpeg run as an Error. Killed by the system (memory) → worth trying again later.
export function ffError(r, what) {
  const lines = String(r.err || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !/^(frame=|size=|video:|\[out#|Stream mapping|Press \[q\])/.test(l));
  const bad = lines.filter(l => /error|invalid|no such|failed|cannot|unable|not found|unknown|does not|too many|killed|out of memory/i.test(l));
  const e = new Error(`${what}: ` + ((r.signal || r.code === null || r.code === 137) ? `ffmpeg was stopped (${r.signal || r.code}), probably out of memory`
    : (bad.length ? bad.slice(-2) : lines.slice(-2)).join(' | ').slice(0, 300)));
  e.transient = Boolean(r.signal || r.code === null || r.code === 137);
  return e;
}

const ASPECTS = [[9, 16], [2, 3], [3, 4], [4, 5], [1, 1], [5, 4], [4, 3], [3, 2], [16, 9], [21, 9]];
export function aspectOf(w, h) {
  if (!(w > 0 && h > 0)) return '';
  const r = w / h;
  const best = ASPECTS.reduce((a, b) => (Math.abs(b[0] / b[1] - r) < Math.abs(a[0] / a[1] - r) ? b : a));
  if (Math.abs(best[0] / best[1] - r) / r < 0.03) return `${best[0]}:${best[1]}`;
  const g = (a, b) => (b ? g(b, a % b) : a), d = g(w, h);
  return `${w / d}:${h / d}`;
}
export const orientationOf = (w, h) => (!(w > 0 && h > 0) ? '' : Math.abs(w - h) / Math.max(w, h) < 0.03 ? 'square' : h > w ? 'vertical' : 'horizontal');

// Everything we need to know about a video, read from ffmpeg's description of the file.
// (Same tool locally and on the server: ffmpeg's own report, so no separate ffprobe is needed.)
export function parseInfo(text) {
  const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const br = text.match(/Duration:[^\n]*bitrate: (\d+) kb\/s/);
  const vLine = text.split(/\r?\n/).find(l => /Stream #\d+:\d+.*: Video: /.test(l) && !/attached pic/.test(l)) || '';
  const aLine = text.split(/\r?\n/).find(l => /Stream #\d+:\d+.*: Audio: /.test(l)) || '';
  const vcodec = (vLine.match(/Video: (\w+)/) || [])[1] || '';
  const size = vLine.match(/, (\d{2,5})x(\d{2,5})/);
  const sar = vLine.match(/SAR (\d+):(\d+)/);
  const fps = vLine.match(/([\d.]+) fps/) || vLine.match(/([\d.]+) tbr/);
  const rot = text.match(/rotation of (-?[\d.]+) degrees/) || text.match(/rotate\s*:\s*(-?\d+)/);
  let w = size ? Number(size[1]) : 0, h = size ? Number(size[2]) : 0;
  if (sar && Number(sar[1]) && Number(sar[2]) && sar[1] !== sar[2]) w = Math.round((w * Number(sar[1])) / Number(sar[2]));
  const rotation = rot ? ((Math.round(Number(rot[1])) % 360) + 360) % 360 : 0;
  if (rotation === 90 || rotation === 270) [w, h] = [h, w];
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    bitrate: br ? Number(br[1]) * 1000 : 0,
    hasVideo: Boolean(vLine), vcodec, width: w, height: h,
    fps: fps ? Math.round(Number(fps[1]) * 100) / 100 : 0,
    hasAudio: Boolean(aLine), acodec: (aLine.match(/Audio: (\w+)/) || [])[1] || '',
    rotation, aspect: aspectOf(w, h), orientation: orientationOf(w, h),
  };
}
export async function videoInfo(file, ctx) {
  if (!existsSync(file)) throw new Error('The video file is missing');
  const r = await ff(['-i', file], ctx);
  return parseInfo(r.err);
}

// Browsers and phones play H.264 MP4 well. Anything else, or a very big file, is re-encoded for the silent copy.
export const needsProxy = (info, ext, size) => ext !== '.mp4' || info.vcodec !== 'h264' || Math.max(info.width, info.height) > 1920
  || (info.duration > 0 && size / info.duration > 1.6e6);

// The silent working copy of a video: the picture only, every audio stream removed (-an, first video stream only).
// Light videos keep their picture as it is (no quality loss); others become H.264, longest side 1280 px.
export async function makeSilentCopy(src, out, info, ext, size, ctx) {
  let r;
  if (!needsProxy(info, ext, size)) {
    r = await ff(['-y', '-i', src, '-map', '0:v:0', '-c:v', 'copy', '-an', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', out], ctx);
    if (r.code === 0 && existsSync(out)) return 'copied';
  }
  const long = Math.max(info.width, info.height);
  const scale = long > 1280 ? (info.width >= info.height ? 'scale=1280:-2' : 'scale=-2:1280') : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  r = await ff(['-y', '-i', src, '-map', '0:v:0', '-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-an', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', out], ctx);
  if (r.code !== 0 || !existsSync(out)) throw ffError(r, 'Could not make the silent copy');
  return 'encoded';
}

// ffprobe: the server's (FFPROBE_PATH, /usr/bin/ffprobe in Docker), else the development copy (ffprobe-static).
const FFPROBE = process.env.FFPROBE_PATH || (existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe'
  : await import('ffprobe-static').then(m => m.default?.path || '').catch(() => ''));
export const ffprobeReady = () => Boolean(FFPROBE);

// How many audio and video streams a file has, read by ffprobe.
export function streamCounts(file, ctx) {
  if (!FFPROBE) return Promise.reject(new Error('ffprobe is not installed (set FFPROBE_PATH)'));
  return new Promise(resolve => {
    const p = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { windowsHide: true });
    ctx?.children?.add(p);
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      ctx?.children?.delete(p);
      const types = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      resolve({ ok: code === 0, audio: types.filter(t => t === 'audio').length, video: types.filter(t => t === 'video').length, error: err.trim() });
    });
    p.on('error', e => { ctx?.children?.delete(p); resolve({ ok: false, audio: -1, video: 0, error: String(e) }); });
  });
}

// Must be silent: no audio stream at all, and a picture.
export async function assertSilent(file, ctx) {
  const s = await streamCounts(file, ctx);
  if (!s.ok) throw new Error('ffprobe could not read the silent copy: ' + s.error.slice(0, 200));
  if (s.audio !== 0) throw new Error(`The silent copy still has ${s.audio} audio stream(s)`);
  if (s.video < 1) throw new Error('The silent copy has no picture');
  return s;
}

// One picture (JPEG) at `t` seconds. `long` = size of the longest side.
export async function frameJpeg(src, t, out, long, ctx, quality = 4) {
  const vf = `scale='if(gte(iw,ih),min(${long},iw),-2)':'if(gte(iw,ih),-2,min(${long},ih))'`;
  let r = await ff(['-y', '-ss', Math.max(0, t).toFixed(3), '-i', src, '-frames:v', '1', '-update', '1', '-vf', vf, '-q:v', String(quality), out], ctx);
  if (r.code !== 0 || !existsSync(out)) r = await ff(['-y', '-i', src, '-frames:v', '1', '-update', '1', '-vf', vf, '-q:v', String(quality), out], ctx);
  if (r.code !== 0 || !existsSync(out)) throw ffError(r, 'Could not take a picture from the video');
}

// A small grey picture at `t` seconds, as raw pixels (for measurements and the fingerprint).
export const GW = 160;
export async function grayFrame(src, t, ctx) {
  const r = await ff(['-ss', Math.max(0, t).toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${GW}:-2,format=gray`, '-f', 'rawvideo', 'pipe:1'], ctx, { binary: true });
  if (!r.out || r.out.length < GW * 2) return null;
  return { w: GW, h: Math.floor(r.out.length / GW), px: r.out };
}

// Measurements of one grey picture: brightness and contrast (0-255), sharpness (variance of the Laplacian).
export function measure(f) {
  const { w, h, px } = f;
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum += px[i];
  const mean = sum / (w * h);
  let v = 0;
  for (let i = 0; i < w * h; i++) v += (px[i] - mean) ** 2;
  let lap = 0, lap2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * px[i] - px[i - 1] - px[i + 1] - px[i - w] - px[i + w];
    lap += l; lap2 += l * l; n++;
  }
  const lm = n ? lap / n : 0;
  return { brightness: mean, contrast: Math.sqrt(v / (w * h)), sharp: n ? lap2 / n - lm * lm : 0 };
}

// 64-bit "difference hash": almost the same picture → almost the same hash (few different bits).
export function dhash(f) {
  const { w, h, px } = f;
  const cell = (cx, cy) => {
    const x0 = Math.floor((cx * w) / 9), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / 9));
    const y0 = Math.floor((cy * h) / 8), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / 8));
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += px[y * w + x]; n++; }
    return s / n;
  };
  let bits = '';
  for (let y = 0; y < 8; y++) { const row = Array.from({ length: 9 }, (_, x) => cell(x, y)); for (let x = 0; x < 8; x++) bits += row[x] > row[x + 1] ? '1' : '0'; }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}
export function hamming(a, b) {
  if (!a || !b) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
// How different two grey pictures are (0 = same, 100 = completely different).
export function diff(a, b) {
  if (!a || !b || a.px.length !== b.px.length) return 0;
  let s = 0;
  for (let i = 0; i < a.px.length; i++) s += Math.abs(a.px[i] - b.px[i]);
  return (s / a.px.length / 255) * 100;
}

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
// Measured quality (0-100) and what lowers it.
export function techScore({ sharp, brightness, contrast }, width, height) {
  const sharpness = clamp(((Math.log10(sharp + 1) - 1.3) / 1.7) * 100);
  const exposure = brightness < 35 ? clamp(brightness * 1.6) : brightness < 70 ? 55 + (brightness - 35) * 1.3 : brightness <= 185 ? 100 : clamp(100 - (brightness - 185) * 1.4);
  const contr = clamp((contrast / 45) * 100);
  const short = Math.min(width, height);
  const resolution = short >= 1080 ? 100 : short >= 720 ? 85 : short >= 540 ? 65 : short >= 360 ? 45 : 25;
  const score = Math.round(sharpness * 0.4 + exposure * 0.25 + contr * 0.15 + resolution * 0.2);
  const notes = [];
  if (sharpness < 40) notes.push('soft / blurry picture');
  if (brightness < 50) notes.push('dark'); else if (brightness > 200) notes.push('over-exposed');
  if (contr < 40) notes.push('flat, low contrast');
  if (resolution < 65) notes.push(`low resolution (${width}×${height})`);
  return { score, sharpness: Math.round(sharpness), exposure: Math.round(exposure), contrast: Math.round(contr), resolution, notes };
}

// Turn scene-change times into usable scenes: no scene shorter than `min` (merged with a neighbour),
// none longer than `max` (cut into equal parts). Returns [{ start, end }] covering the whole video.
export function planScenes(duration, cuts = [], { min = 1.2, max = 8 } = {}) {
  if (!(duration > 0)) return [];
  if (duration <= min) return [{ start: 0, end: duration }];
  const pts = [...new Set(cuts.filter(t => t > 0.05 && t < duration - 0.05).map(t => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
  let segs = [0, ...pts, duration].slice(0, -1).map((s, i, arr) => ({ start: s, end: i + 1 < arr.length ? arr[i + 1] : duration }));
  // Merge the shortest too-short scene into its shorter neighbour, again and again.
  for (;;) {
    let k = -1;
    segs.forEach((s, i) => { if (s.end - s.start < min && (k < 0 || s.end - s.start < segs[k].end - segs[k].start)) k = i; });
    if (k < 0 || segs.length === 1) break;
    const prev = segs[k - 1], next = segs[k + 1];
    const into = !prev ? k + 1 : !next ? k - 1 : (prev.end - prev.start <= next.end - next.start ? k - 1 : k + 1);
    const a = Math.min(k, into), b = Math.max(k, into);
    segs.splice(a, 2, { start: segs[a].start, end: segs[b].end });
  }
  const out = [];
  for (const s of segs) {
    const len = s.end - s.start, n = Math.ceil(len / max - 1e-9);
    for (let i = 0; i < n; i++) out.push({ start: s.start + (len * i) / n, end: i === n - 1 ? s.end : s.start + (len * (i + 1)) / n });
  }
  return out.map(s => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 }));
}

// Scene-change times (seconds) where the picture changes a lot.
export async function sceneCuts(file, threshold, ctx) {
  const r = await ff(['-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], ctx);
  if (r.code !== 0) throw ffError(r, 'Scene detection failed');
  return [...r.err.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1])).filter(Number.isFinite);
}

// Is this file really a video we accept? (looks at its first bytes, not only its name)
export function sniffVideo(head) {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  const box = head.length >= 8 ? head.toString('latin1', 4, 8) : '';
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(box)) return 'mp4';
  return '';
}
