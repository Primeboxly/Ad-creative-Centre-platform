// "BSS" style (docs/style-bss-watch.md): one continuous voice-over, a fast montage of short shots (~2 s),
// word-by-word captions with one yellow key word, and red arrows pointing down during the CTA. 4:5 or 9:16.
import { join, dirname } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { run, probe, ffmpegError, X264, plain, FONT } from './video.js';
import { speakTimed, evenWordTimes } from './tts.js';

export const FORMATS = { '4x5': [1080, 1350], '9x16': [1080, 1920] };
const SHOT = 2.1;           // target length of a body shot (seconds)
const LEAD = 0.25;          // the voice starts a moment after the picture
const TAIL = 0.9;           // picture after the last word

// Deterministic "random" from a seed, so a video made again comes out the same.
const rng = seed => () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

// The shots of the ad. parts: { hook: [clip], body: [clip...], cta: [clip] } (clip = { file, duration }),
// bounds: { hookEnd, ctaStart, total } in seconds. Returns [{ file, offset, dur, loop }].
export function planShots(parts, bounds, seed = 1) {
  const rand = rng(seed);
  const used = new Map(); // clip file → how far we already used it (so the same frames don't come back)
  const shot = (clip, dur) => {
    const room = Math.max(0, clip.duration - dur);
    let offset = used.has(clip.file) ? used.get(clip.file) : room * rand() * 0.3;
    if (offset > room) offset = room * rand();
    used.set(clip.file, offset + dur);
    return { file: clip.file, offset: Number(offset.toFixed(3)), dur: Number(dur.toFixed(3)), loop: clip.duration < dur + 0.05 };
  };
  const split = (len, target) => {
    const n = Math.max(1, Math.round(len / target));
    return Array(n).fill(len / n);
  };
  const body = parts.body.length ? parts.body : [...parts.hook, ...parts.cta];
  const hook = parts.hook.length ? parts.hook : body;
  const cta = parts.cta.length ? parts.cta : body;
  const shots = [];
  split(bounds.hookEnd, 3.2).forEach((d, i) => shots.push(shot(hook[i % hook.length], d)));
  let k = Math.floor(rand() * body.length);
  split(bounds.ctaStart - bounds.hookEnd, SHOT).forEach(d => shots.push(shot(body[k++ % body.length], d)));
  split(bounds.total - bounds.ctaStart, 3.5).forEach((d, i) => shots.push(shot(cta[i % cta.length], d)));
  return shots.filter(s => s.dur > 0.05);
}

// ---------- Captions (ASS subtitles, drawn by libass) ----------
const assTime = t => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
// Caption words are shown without punctuation (like the references); apostrophes stay ("she'll").
const assText = t => String(t).replace(/[{}\\]/g, '').replace(/[.,!?;:…"“”()]+/g, '');

// Words → groups of up to 3 words (18 letters). The longest word of each group is the yellow one.
export function captionGroups(words, maxWords = 3, maxChars = 18) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    const endsSentence = cur.length && /[.!?…]$/.test(cur[cur.length - 1].w);
    if (cur.length && (endsSentence || cur.length >= maxWords || (cur.map(x => x.w).join(' ') + ' ' + w.w).length > maxChars)) { groups.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => {
    const key = g.reduce((a, b) => (plain(b.w).length > plain(a.w).length ? b : a));
    return { words: g, key: plain(key.w).length >= 4 ? key : null, start: g[0].start, end: groups[i + 1] ? groups[i + 1][0].start : g[g.length - 1].end + 0.4 };
  });
}

export function buildAss(groups, { width, height, ctaStart, total, fontName }) {
  const size = Math.round(width * 0.052);           // ~56 px on 1080 wide, like the references
  const marginV = Math.round(height * 0.2);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${fontName},${size},&H00FFFFFF,&H00FFFFFF,&H00202020,&H90000000,-1,0,0,0,100,100,0,0,1,3.5,2.5,2,60,60,${marginV},1`,
    `Style: Arrow,${fontName},${size},&HFF000000,&HFF000000,&H002A2AFF,&H00000000,0,0,0,0,100,100,0,0,1,7,0,7,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const g of groups) {
    const text = g.words.map(w => (w === g.key
      ? `{\\c&H00E6FF&\\fs${Math.round(size * 1.3)}}${assText(w.w)}{\\r}`
      : assText(w.w))).join(' ');
    // A small "pop" when a group appears.
    lines.push(`Dialogue: 0,${assTime(g.start)},${assTime(g.end)},Cap,,0,0,0,,{\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)}${text}`);
  }
  // Red outlined arrows pointing down (to the button under the ad), bouncing during the CTA.
  const arrow = 'm 0 0 l 46 0 l 46 70 l 86 70 l 23 140 l -40 70 l 0 70';
  const y = Math.round(height * 0.83), xs = [Math.round(width * 0.09), Math.round(width * 0.87)];
  for (let t = ctaStart; t < total - 0.05; t += 0.6) {
    const end = Math.min(t + 0.6, total);
    for (const x of xs) lines.push(`Dialogue: 1,${assTime(t)},${assTime(end)},Arrow,,0,0,0,,{\\move(${x},${y},${x},${y + 30})\\p1}${arrow}{\\p0}`);
  }
  return lines.join('\n') + '\n';
}

// A path inside a filter option, between single quotes (":" escaped).
const q = v => "'" + String(v).replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:') + "'";

// Makes the video file `out`. clips: { hook: [..], body: [..], cta: [..] } with { file, duration };
// script: { hook, body, cta, language }; opts: { voiceId, music, format, seed, workDir }.
// opts.voice ({ file, words }) skips ElevenLabs (used by the tests).
export async function renderBss({ clips, script, voiceId, music, format = '4x5', seed = 1, workDir, out, voice: given }) {
  const [W, H] = FORMATS[format] || FORMATS['4x5'];
  if (!voiceId && !given) throw new Error('The BSS style needs a voice');
  const parts = ['hook', 'body', 'cta'].map(k => plain(script[k]));
  const text = parts.filter(Boolean).join(' ');
  const voice = given || await speakTimed(text, voiceId, script.language);
  const vd = (await probe(voice.file)).duration;
  const words = (voice.words || evenWordTimes(text, vd)).map(w => ({ ...w, start: w.start + LEAD, end: w.end + LEAD }));
  // Where hook and CTA start: at the first word of each part.
  const nHook = parts[0].split(' ').filter(Boolean).length, nBody = parts[1].split(' ').filter(Boolean).length;
  const total = vd + LEAD + TAIL;
  const hookEnd = nHook && words[nHook] ? words[nHook].start - 0.05 : Math.min(3, total / 4);
  const ctaStart = words[nHook + nBody] ? words[nHook + nBody].start - 0.05 : total - 3;

  mkdirSync(workDir, { recursive: true });
  // 1. every shot as its own small file (low memory), 2. glued, 3. captions + voice + music on top.
  const shots = planShots(clips, { hookEnd, ctaStart, total }, seed);
  const list = [];
  for (const [i, s] of shots.entries()) {
    const f = join(workDir, `shot${i}.mp4`);
    const r = await run(['-y', ...(s.loop ? ['-stream_loop', '-1'] : []), '-ss', String(s.offset), '-i', s.file, '-t', String(s.dur), '-an',
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,format=yuv420p`,
      ...X264, '-crf', '18', f]);
    if (r.code !== 0 || !existsSync(f)) throw new Error(ffmpegError(r));
    list.push(`file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
  }
  const listFile = join(workDir, 'shots.txt'), joined = join(workDir, 'joined.mp4');
  writeFileSync(listFile, list.join('\n'));
  let r = await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined]);
  if (r.code !== 0) throw new Error(ffmpegError(r));

  const assFile = join(workDir, 'captions.ass');
  const fontName = /dejavu/i.test(FONT || '') ? 'DejaVu Sans' : 'Arial';
  writeFileSync(assFile, buildAss(captionGroups(words), { width: W, height: H, ctaStart, total, fontName }));
  const fmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const args = ['-y', '-i', joined, '-i', voice.file];
  if (music) args.push('-stream_loop', '-1', '-i', music);
  const subs = `subtitles=${q(assFile)}${FONT ? `:fontsdir=${q(dirname(FONT))}` : ''}`;
  const f = [`[0:v]${subs}[v]`,
    `[1:a]${fmt},adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad,atrim=0:${total.toFixed(3)}[vo]`];
  if (music) {
    f.push(`[2:a]${fmt},volume=0.12,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[mus]`);
    f.push('[vo][mus]amix=inputs=2:duration=first:normalize=0[a]');
  } else f.push('[vo]anull[a]');
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3),
    ...X264, '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  r = await run(args);
  if (r.code !== 0 || !existsSync(out)) throw new Error(ffmpegError(r));
  return total;
}
