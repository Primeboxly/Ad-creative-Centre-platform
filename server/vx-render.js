// Module 7 rendering: the approved EDL is rendered again by the Module 6 engine (cached clips, approved audio, never
// the footage's sound) with the visual layers burnt in during the one final encode: an ASS script (libass: captions,
// text, shapes, animations) and, if a brand kit is used, the logo. The ASS script and the fonts are written in the
// job's temporary folder: no user text ever reaches a command line.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storage } from './storage.js';
import { renderEdl, run, qualityCheck } from './video-render.js';
import { planToAss, fontsOf } from './vx-ass.js';
import { FONTS_DIR } from './vx-registry.js';
import { norm } from './vx-captions.js';
import { outputSize } from './video-schemas.js';

export async function renderEnhanced({ plan, edl, quality, work, ctx, stage, log, scenes, projectId }) {
  mkdirSync(join(work, 'fonts'), { recursive: true });
  const { W, H } = sizeFor(edl, quality);
  writeFileSync(join(work, 'vx.ass'), planToAss(plan, W, H), 'utf8');
  for (const f of fontsOf(plan)) copyFileSync(join(FONTS_DIR, f), join(work, 'fonts', f));
  let logo = null;
  const L = plan.elements.find(e => e.type === 'logo' && e.visibility?.enabled !== false);
  if (L?.asset && (await storage.exists(L.asset))) {
    const file = await storage.toLocal(L.asset, join(work, 'logo.png'));
    logo = { file, x: L.position.x, y: L.position.y, w: L.size.w, start: L.start, end: L.end };
  } else if (L) log?.('Brand logo file missing: rendered without the logo');
  const res = await renderEdl({ edl, quality, work, ctx, stage, log, scenesById: scenes, projectId, overlay: { ass: 'vx.ass', fontsDir: 'fonts', logo } });
  return { ...res, assFile: join(work, 'vx.ass') };
}
export function sizeFor(edl, quality) { const [W, H] = outputSize(edl.timeline.aspect_ratio, quality); return { W, H }; }

// ---------- Measured visual checks ----------
// The ASS script is rendered alone on black at 5 frames per second (same size, same fonts): every frame's text area is
// measured (cropdetect) and libass reports which font it used and any missing letter. This proves, on the real
// renderer, that each caption and overlay appears in its time window, stays inside the frame and the safe zone, and that
// (black is luma 16: a row or column counts as text when its average is above 17)
// every character (Arabic, accents, currency symbols) has a glyph.
export async function visualQc(plan, { work, W, H, ctx }) {
  const errors = [], warnings = [], measured = {};
  const E = (code, message) => errors.push({ code, message, kind: 'measured' }), Wn = (code, message) => warnings.push({ code, message, kind: 'measured' });
  const D = plan.output.duration, fps = 5;
  const r = await run(['-loglevel', 'verbose', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${D.toFixed(3)}`, '-vf', 'ass=filename=vx.ass:fontsdir=fonts,cropdetect=limit=17:round=2:reset=1', '-f', 'null', '-'], ctx, { cwd: work });
  if (r.code !== 0) { E('overlay_render', `The text layer could not be rendered: ${(r.err || '').split('\n').filter(l => /error/i.test(l)).slice(-1)[0] || `exit ${r.code}`}`); return { errors, warnings, measured }; }
  // Fonts: what libass actually used for each requested family.
  const sel = [...r.err.matchAll(/fontselect: \(([^,]+), \d+, \d+\) -> ([^,\s]+)/g)].map(m => ({ family: m[1].trim(), got: m[2].trim() }));
  const bad = sel.filter(s => !norm(s.got).startsWith(norm(s.family).slice(0, 6)));
  measured.fonts = [...new Map(sel.map(s => [s.family, s.got])).entries()].map(([f, g]) => `${f} → ${g}`);
  if (bad.length) E('font_missing', `Fonts not found, replaced by others: ${[...new Set(bad.map(b => b.family))].join(', ')}.`);
  const glyphs = [...new Set([...r.err.matchAll(/Glyph 0x([0-9A-Fa-f]+) not found/g)].map(m => m[1]))];
  const noFallback = /failed to find any fallback/i.test(r.err);
  if (glyphs.length) (noFallback ? E : Wn)('glyph', `${glyphs.length} character(s) not in the chosen font (${glyphs.slice(0, 6).map(g => String.fromCodePoint(parseInt(g, 16))).join(' ')})${noFallback ? ': they are missing from the video' : ': another bundled font was used'}.`);
  // Text area per frame.
  const frames = [...r.err.matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+)[^\n]*? t:([\d.]+)/g)].map(m => ({ x1: +m[1], x2: +m[2], y1: +m[3], y2: +m[4], t: +m[5] }))
    .map(f => ({ ...f, empty: f.x2 <= f.x1 || f.y2 <= f.y1 }));
  measured.frames = frames.length;
  const texts = plan.elements.filter(e => e.visibility?.enabled !== false && !['effect', 'logo'].includes(e.type) && e.end - e.start >= 0.3);
  let checked = 0;
  for (const e of texts) {
    const settle = Math.min(0.45, (e.end - e.start) / 2);
    const win = frames.filter(f => f.t >= e.start + settle && f.t <= e.end - 0.08);
    if (!win.length) continue;
    checked++;
    if (win.every(f => f.empty)) E('missing_text', `${e.type} “${(e.text || '').slice(0, 30)}” does not appear between ${e.start.toFixed(2)} and ${e.end.toFixed(2)} s.`);
  }
  measured.elements_checked = checked;
  const anyAt = t => plan.elements.some(e => e.visibility?.enabled !== false && !['effect', 'logo'].includes(e.type) && t >= e.start - 0.05 && t <= e.end + 0.35);
  const stray = frames.filter(f => !f.empty && !anyAt(f.t));
  if (stray.length) Wn('unexpected_text', `Text visible at ${stray.slice(0, 3).map(f => `${f.t.toFixed(1)} s`).join(', ')} where no element is planned.`);
  // Inside the frame (after entrance animations) and inside the safe zone.
  const settled = frames.filter(f => !f.empty && plan.elements.some(e => e.visibility?.enabled !== false && !['effect', 'logo'].includes(e.type) && f.t >= e.start + 0.7 && f.t <= e.end));
  const cut = settled.filter(f => f.x1 <= 1 || f.y1 <= 1 || f.x2 >= W - 2 || f.y2 >= H - 2);
  if (cut.length) E('text_cut', `Text touches the edge of the frame at ${cut.slice(0, 3).map(f => `${f.t.toFixed(1)} s`).join(', ')}: it may be cut.`);
  const sz = plan.safe_zone, tol = 0.015;
  const out = settled.filter(f => f.y1 < (sz.top - tol) * H || f.y2 > (1 - sz.bottom + tol) * H || f.x1 < (sz.left - tol) * W || f.x2 > (1 - sz.right + tol) * W);
  if (out.length) Wn('safe_zone', `Text outside the ${sz.label} safe zone at ${[...new Set(out.map(f => f.t.toFixed(1)))].slice(0, 4).join(', ')} s (platform buttons may cover it).`);
  measured.text_area = settled.length ? { x1: Math.min(...settled.map(f => f.x1)), y1: Math.min(...settled.map(f => f.y1)), x2: Math.max(...settled.map(f => f.x2)), y2: Math.max(...settled.map(f => f.y2)) } : null;
  return { errors, warnings, measured };
}
export { qualityCheck };
