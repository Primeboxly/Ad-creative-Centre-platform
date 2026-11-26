// Visual Enhancement Plan → ASS subtitle script for FFmpeg's libass renderer (fribidi + HarfBuzz: Arabic is shaped and
// written right to left, accents and currency symbols come from the bundled fonts). Only values from the plan,
// clamped and allowlisted, are written; text is cleaned (no ASS commands can come from text). Positions are fractions
// of the frame, so one plan renders identically at preview and production sizes.
import { FONTS, VX_LIMITS, hexToRgb } from './vx-registry.js';
import { cleanText, hasArabic } from './vx-captions.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, Number(x) || 0));
const ms = t => Math.max(0, Math.round(t * 100)); // centiseconds
const ts = t => { const c = ms(t), h = Math.floor(c / 360000), m = Math.floor((c % 360000) / 6000), s = Math.floor((c % 6000) / 100), cc = c % 100; return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cc).padStart(2, '0')}`; };
const col = hex => { const [r, g, b] = hexToRgb(/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#FFFFFF'); return `&H${[b, g, r].map(v => v.toString(16).padStart(2, '0').toUpperCase()).join('')}&`; };
const alpha = opacity => `&H${Math.round((1 - clamp(opacity, 0, 1)) * 255).toString(16).padStart(2, '0').toUpperCase()}&`;
const esc = s => cleanText(s, 400); // { } \ removed
const n1 = x => (Math.round(x * 10) / 10).toString();

// Override tags of one text block (font, size, colours, outline, shadow, panel).
function look(e, W, H, { color = null } = {}) {
  const f = FONTS[e.font.key];
  const size = clamp(e.font.size, VX_LIMITS.minFontFrac, VX_LIMITS.maxFontFrac) * H;
  const box = e.background?.mode === 'box';
  const pad = box ? clamp(e.background.padding ?? 0.012, 0, 0.04) * H : 0;
  const t = [`\\fn${f.family}`, `\\fs${n1(size)}`, `\\b${f.bold ? 1 : 0}`, '\\i0', `\\1c${col(color || e.colors.text)}`, '\\1a&H00&'];
  if (box) t.push(`\\3c${col(e.background.color)}`, `\\3a${alpha(e.background.opacity ?? 0.9)}`, `\\bord${n1(pad)}`, `\\4c${col('#000000')}`, `\\4a${alpha(0.25)}`, `\\shad${n1(H * 0.002)}`, '\\blur0.6');
  else {
    t.push(`\\3c${col(e.outline?.color || '#000000')}`, '\\3a&H00&', `\\bord${n1(clamp(e.outline?.width, 0, 0.012) * H)}`);
    t.push(`\\4c${col(e.shadow?.color || '#000000')}`, `\\4a${alpha(e.shadow?.opacity ?? 0)}`, `\\shad${n1(clamp(e.shadow?.depth, 0, 0.01) * H)}`);
  }
  return t.join('');
}
// Entrance animation (allowlisted). x, y in pixels; d = duration (ms) of the element.
function entrance(type, inMs, x, y, W, H) {
  const a = Math.round(clamp(inMs, 0, 600));
  switch (type) {
    case 'pop': return `\\pos(${x},${y})\\fscx72\\fscy72\\t(0,${Math.round(a * 0.65)},\\fscx106\\fscy106)\\t(${Math.round(a * 0.65)},${a},\\fscx100\\fscy100)\\fad(${Math.round(a * 0.5)},0)`;
    case 'bounce': return `\\move(${x},${y + Math.round(H * 0.012)},${x},${y},0,${a})\\fscx80\\fscy80\\t(0,${Math.round(a * 0.6)},\\fscx108\\fscy108)\\t(${Math.round(a * 0.6)},${a},\\fscx100\\fscy100)\\fad(${Math.round(a * 0.4)},0)`;
    case 'slide_up': return `\\move(${x},${y + Math.round(H * 0.018)},${x},${y},0,${a})\\fad(${Math.round(a * 0.7)},0)`;
    case 'slide_in': return `\\move(${x - Math.round(W * 0.06)},${y},${x},${y},0,${a})\\fad(${Math.round(a * 0.7)},0)`;
    case 'fade': case 'karaoke': case 'word_reveal': return `\\pos(${x},${y})\\fad(${a},0)`;
    case 'scale_emphasis': return `\\pos(${x},${y})\\fscx92\\fscy92\\t(0,${a},\\fscx100\\fscy100)\\fad(${Math.round(a * 0.5)},0)`;
    default: return `\\pos(${x},${y})`;
  }
}
const outFade = (e, kind) => (kind === 'caption' ? '' : `\\fad(0,${Math.round(clamp(e.animation?.out_ms ?? 120, 0, 300))})`);
const line = (layer, a, b, text, style = 'Base') => `Dialogue: ${layer},${ts(a)},${ts(b)},${style},,0,0,0,,${text}`;
const rect = (w, h) => `m 0 0 l ${Math.round(w)} 0 l ${Math.round(w)} ${Math.round(h)} l 0 ${Math.round(h)}`;

// The words of a caption group as ASS text: line breaks, highlighted words, the active word (karaoke / reveal).
function captionText(e, { active = -1, revealUpTo = -1 } = {}) {
  const up = e.font.uppercase;
  const hlCol = col(e.colors.highlight), txt = col(e.colors.text);
  const scale = e.emphasis === 'scale' || e.highlight_mode === 'color_scale';
  const lines = [], counts = [];
  let n = 0;
  for (const l of e.lines) { const c = l.split(' ').filter(Boolean).length; counts.push(c); n += c; }
  const words = e.words?.length === n ? e.words : e.lines.join(' ').split(' ').map(t => ({ text: t }));
  let k = 0;
  for (const c of counts) {
    const parts = [];
    for (let i = 0; i < c; i++, k++) {
      const w = words[k]; if (!w) continue;
      let t = esc(up ? w.text.toLocaleUpperCase() : w.text);
      const hl = !!w.hl && e.highlight_mode !== 'none';
      if (revealUpTo >= 0 && k > revealUpTo) { parts.push(`{\\alpha&HFF&}${t}{\\alpha&H00&}`); continue; }
      if (k === active) parts.push(`{\\1c${hlCol}}${t}{\\1c${txt}}`);
      else if (hl && e.highlight_mode === 'bold') parts.push(`{\\b1}${t}{\\b0}`);
      else if (hl && e.highlight_mode === 'box') parts.push(`{\\3c${hlCol}\\1c${col('#111111')}}${t}{\\3c${col(e.outline?.color || '#000000')}\\1c${txt}}`);
      else if (hl) parts.push(scale ? `{\\1c${hlCol}\\fscx112\\fscy112}${t}{\\1c${txt}\\fscx100\\fscy100}` : `{\\1c${hlCol}}${t}{\\1c${txt}}`);
      else parts.push(t);
    }
    lines.push(parts.join(' '));
  }
  return lines.join('\\N');
}

export function planToAss(plan, W, H) {
  const out = [];
  const px = e => [Math.round(e.position.x * W), Math.round(e.position.y * H)];
  const els = plan.elements.filter(e => e.visibility?.enabled !== false && e.end > e.start && e.type !== 'logo');
  for (const e of els) {
    const [x, y] = px(e), L = e.layer || 5, S = e.background?.mode === 'box' ? 'Box' : 'Base';
    const anim = e.animation?.type || 'fade', inMs = e.animation?.in_ms ?? 180;
    if (e.type === 'effect') {
      if (e.template === 'gradient_band') {
        // Soft dark band behind the captions: three stacked translucent rectangles, blurred.
        const h = e.size.h * H, top = y - h / 2;
        [[1, 0.18], [0.66, 0.16], [0.36, 0.14]].forEach(([f, o]) => out.push(line(1, e.start, e.end, `{\\an7\\pos(0,${Math.round(top + (h * (1 - f)) / 2)})\\p1\\bord0\\shad0\\1c&H000000&\\1a${alpha(o)}\\blur${Math.round(H * 0.02)}\\fad(300,300)}${rect(W, h * f)}{\\p0}`)));
      }
      continue;
    }
    const base = `{\\an5${entrance(anim, inMs, x, y, W, H)}${outFade(e, e.type)}${look(e, W, H)}}`;
    if (e.type === 'caption') {
      const ws = e.words || [];
      const timed = ws.length > 1 && (anim === 'karaoke' || anim === 'word_reveal');
      if (!timed) { out.push(line(L, e.start, e.end, base + captionText(e), S)); continue; }
      // One event per spoken word: same layout, the active (or newly revealed) word changes with the real timing.
      for (let k = 0; k < ws.length; k++) {
        const a = k === 0 ? e.start : Math.max(e.start, ws[k].start), b = k === ws.length - 1 ? e.end : Math.max(a + 0.01, ws[k + 1].start);
        if (b <= a) continue;
        const head = k === 0 ? base : `{\\an5\\pos(${x},${y})${look(e, W, H)}}`;
        out.push(line(L, a, b, head + captionText(e, anim === 'karaoke' ? { active: k } : { revealUpTo: k }), S));
      }
      // A single gentle pulse on the first highlighted word's group (highlight_pulse).
      continue;
    }
    if (e.type === 'hook') {
      let text = e.lines.map(l => esc(e.font.uppercase ? l.toLocaleUpperCase() : l));
      if (e.keyword) { const k = esc(e.font.uppercase ? e.keyword.toLocaleUpperCase() : e.keyword); text = text.map(l => (k && l.includes(k) ? l.replace(k, `{\\1c${col(e.colors.highlight)}}${k}{\\1c${col(e.colors.text)}}`) : l)); }
      if (anim === 'word_reveal') {
        // Words appear one after the other (120 ms apart).
        let i = 0;
        text = text.map(l => l.split(' ').map(w => `{\\alpha&HFF&\\t(${i * 120},${i++ * 120 + 160},\\alpha&H00&)}${w}`).join(' '));
      }
      out.push(line(L, e.start, e.end, base + text.join('\\N'), S));
      if (e.accent_line) {
        const lw = Math.round(Math.min(e.size.w * 0.6, 0.4) * W), lh = Math.max(3, Math.round(H * 0.0045)), ly = Math.round(y + (e.size.h * H) / 2 + H * 0.008);
        out.push(line(L, e.start + 0.15, e.end, `{\\an7\\pos(${x - Math.round(lw / 2)},${ly})\\p1\\bord0\\shad0\\1c${col(e.colors.accent || e.colors.highlight)}\\fscx0\\t(0,320,\\fscx100)\\fad(0,120)}${rect(lw, lh)}{\\p0}`));
      }
      continue;
    }
    if (e.type === 'cta' && e.animation?.pulse) {
      // A slow pulse (two gentle cycles) after the entrance: emphasis without flashing.
      const d = Math.round((e.end - e.start) * 1000), p0 = Math.round(inMs) + 300;
      const pulse = [0, 1].map(i => { const s = p0 + i * 900; return s + 800 < d ? `\\t(${s},${s + 400},\\fscx105\\fscy105)\\t(${s + 400},${s + 800},\\fscx100\\fscy100)` : ''; }).join('');
      out.push(line(L, e.start, e.end, `{\\an5${entrance(anim, inMs, x, y, W, H)}${look(e, W, H)}${pulse}}` + e.lines.map((l, i) => (i ? `{\\fs${n1(e.font.size * H * 0.62)}}` : '') + esc(e.font.uppercase && !i ? l.toLocaleUpperCase() : l)).join('\\N'), S));
      continue;
    }
    const body = e.lines.map((l, i) => (i ? `{\\fs${n1(e.font.size * H * 0.62)}}` : '') + esc(e.font.uppercase && !i ? l.toLocaleUpperCase() : l)).join('\\N');
    if (e.type === 'offer' && e.template === 'promo_banner') {
      const bh = Math.round(e.size.h * H), bw = Math.round(e.size.w * W);
      out.push(line(L - 1, e.start, e.end, `{\\an7\\move(${-bw},${y - bh / 2},${x - bw / 2},${y - bh / 2},0,${Math.round(inMs)})\\p1\\bord0\\shad0\\1c${col(e.background.color)}\\1a${alpha(e.background.opacity)}\\fad(0,120)}${rect(bw, bh)}{\\p0}`));
      out.push(line(L, e.start, e.end, `{\\an5${entrance('slide_in', inMs, x, y, W, H)}${outFade(e)}${look({ ...e, background: { mode: 'none' }, outline: { width: 0 } }, W, H)}}${body}`));
      continue;
    }
    if (e.template === 'highlight_line' || e.template === 'premium_price' || e.template === 'minimal_premium') {
      out.push(line(L, e.start, e.end, base + body, S));
      const lw = Math.round(Math.min(e.size.w * 0.5, 0.3) * W), lh = Math.max(2, Math.round(H * 0.003)), ly = Math.round(y + (e.size.h * H) / 2 + H * 0.006);
      out.push(line(L, e.start + 0.1, e.end, `{\\an7\\pos(${x - Math.round(lw / 2)},${ly})\\p1\\bord0\\shad0\\1c${col(e.colors.accent || e.colors.highlight)}\\fscx0\\t(0,300,\\fscx100)\\fad(0,120)}${rect(lw, lh)}{\\p0}`));
      continue;
    }
    if (e.template === 'callout' && e.pointer) {
      // A thin pointer line from the label to the measured product position (only drawn when that position is known).
      const [tx, ty] = [Math.round(e.pointer.x * W), Math.round(e.pointer.y * H)], sy = Math.round(y + Math.sign(ty - y) * (e.size.h * H) / 2);
      const dx = tx - x, dy = ty - sy, len = Math.hypot(dx, dy), th = Math.max(2, Math.round(H * 0.0025));
      if (len > 10) { const nx = (-dy / len) * th / 2, ny = (dx / len) * th / 2; out.push(line(L - 1, e.start + 0.15, e.end, `{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${col(e.colors.accent)}\\fad(200,120)}m ${Math.round(x + nx)} ${Math.round(sy + ny)} l ${Math.round(tx + nx)} ${Math.round(ty + ny)} l ${Math.round(tx - nx)} ${Math.round(ty - ny)} l ${Math.round(x - nx)} ${Math.round(sy - ny)}{\\p0}`)); }
    }
    out.push(line(L, e.start, e.end, base + body, S));
  }
  // Encoding -1: libass chooses the base direction from the text (Arabic lines are right to left).
  return `[Script Info]
; Generated by Ad creative Centre Module 7 from Visual Enhancement Plan ${plan.schema_version}
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,Poppins,${Math.round(H * 0.045)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,5,0,0,0,-1
Style: Box,Poppins,${Math.round(H * 0.045)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,2,0,5,0,0,0,-1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${out.join('\n')}
`;
}
// Fonts the script needs (copied next to it for the render).
export const fontsOf = plan => [...new Set(plan.elements.filter(e => e.font && e.visibility?.enabled !== false).map(e => FONTS[e.font.key]?.file).filter(Boolean)), FONTS['poppins-bold'].file];
