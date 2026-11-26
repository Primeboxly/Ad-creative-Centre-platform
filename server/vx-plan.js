// Visual Enhancement Plan: deterministic construction from the approved inputs and the Visual Director's decisions.
// Captions from the real word timing, keyword highlights, hook text, benefit overlays, price / offer / CTA graphics,
// effects and branding, each placed where it does not cover the product (Module 2 product position mapped through the
// Module 6 crop), stays inside the platform safe zone and does not collide with other text. Elements the team locked
// or edited are kept as they are. Validation lists blocking errors and review warnings.
import { createHash } from 'node:crypto';
import { CAPTION_STYLES, FONTS, ARABIC_FALLBACK, fontWeightClass, INTENSITIES, SEGMENTATIONS, POSITIONS, HOOK_TEMPLATES, BENEFIT_TEMPLATES, PRICE_TEMPLATES, CTA_TEMPLATES,
  EFFECTS, ANIMATIONS, HIGHLIGHT_MODES, TRACK_OF, LAYER_OF, VX_LIMITS, VX_SCHEMA_VERSION, ELEMENT_TYPES, isHex, contrast } from './vx-registry.js';
import { displayWords, groupCaptions, protectedPairs, markHighlights, formatPrice, phrase, cleanText, hasArabic, norm } from './vx-captions.js';
import { cleanliness } from './video-select.js';

const r3 = x => Math.round(x * 1000) / 1000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const planHash = p => createHash('sha256').update(JSON.stringify({ e: p.elements, o: p.output, s: p.style, b: p.brand_kit, z: p.safe_zone, c: p.caption })).digest('hex');

// ---------- Settings ----------
export const DEFAULT_SETTINGS = { style_id: '', style_overrides: {}, intensity: 'ai', segmentation: 'ai', caption_position: 'auto',
  show: { captions: null, hook: null, benefits: null, price: null, offer: null, cta: null, branding: null, effects: null } /* null = follow the brief */, brand_kit_id: null, safe_zone: '', logo_mode: 'after_hook' };
export function resolveStyle(id, overrides = {}, custom = new Map()) {
  const base = CAPTION_STYLES[id] || custom.get(id) || CAPTION_STYLES.modern_bold;
  return checkStyle({ ...structuredClone(base), ...structuredClone(overrides || {}), id: base.id, name: base.name });
}
// Every style value is clamped to what the renderer accepts (also for custom presets saved by the team).
export function checkStyle(s) {
  const o = { ...s };
  if (!FONTS[o.font]) o.font = 'poppins-bold';
  o.size = clamp(Number(o.size) || 0.045, VX_LIMITS.minFontFrac, VX_LIMITS.maxFontFrac);
  for (const k of ['text_color', 'highlight_color']) if (!isHex(o[k])) o[k] = k === 'text_color' ? '#FFFFFF' : '#FFD60A';
  if (!HIGHLIGHT_MODES.includes(o.highlight_mode)) o.highlight_mode = 'color';
  o.outline = { width: clamp(Number(o.outline?.width) || 0, 0, 0.012), color: isHex(o.outline?.color) ? o.outline.color : '#000000' };
  o.shadow = { depth: clamp(Number(o.shadow?.depth) || 0, 0, 0.01), color: isHex(o.shadow?.color) ? o.shadow.color : '#000000', opacity: clamp(Number(o.shadow?.opacity) || 0, 0, 1) };
  o.background = { mode: ['none', 'box'].includes(o.background?.mode) ? o.background.mode : 'none', color: isHex(o.background?.color) ? o.background.color : '#000000', opacity: clamp(Number(o.background?.opacity) || 0, 0, 1), radius: clamp(Number(o.background?.radius) || 0, 0, 0.05), padding: clamp(Number(o.background?.padding) || 0.01, 0, 0.04) };
  o.line_spacing = clamp(Number(o.line_spacing) || 1, 0.8, 1.6);
  o.animation = { type: ANIMATIONS.includes(o.animation?.type) ? o.animation.type : 'fade', duration_ms: clamp(Math.round(Number(o.animation?.duration_ms) || 180), 0, 600) };
  if (!POSITIONS[o.position]) o.position = 'lower_middle';
  o.max_lines = clamp(Math.round(Number(o.max_lines) || 2), 1, 3);
  o.safe_margin = clamp(Number(o.safe_margin) || 0.07, 0.02, 0.15);
  if (!SEGMENTATIONS[o.segmentation]) o.segmentation = 'phrase';
  o.uppercase = !!o.uppercase;
  return o;
}

// ---------- Geometry ----------
const CHAR_W = { anton: 0.43, 'montserrat-black': 0.68, 'montserrat-extrabold': 0.64, 'montserrat-medium': 0.6, 'poppins-extrabold': 0.64, 'poppins-bold': 0.62, 'poppins-semibold': 0.6, 'poppins-medium': 0.58,
  'playfair-semibold': 0.54, 'playfair-bold': 0.56, 'cairo-semibold': 0.5, 'cairo-bold': 0.52, 'cairo-extrabold': 0.54 };
// Estimated size of a text block (fractions of the frame); the measured check after rendering confirms it.
export function textSize(lines, font, size, { W, H, uppercase = false, spacing = 1, pad = 0 }) {
  const longest = Math.max(1, ...lines.map(l => l.length));
  const w = (longest * size * H * (CHAR_W[font] || 0.6) * (uppercase ? 1.12 : 1)) / W + 2 * pad * H / W;
  const h = lines.length * size * spacing * 1.22 + 2 * pad;
  return { w: r3(Math.min(1, w)), h: r3(h) };
}
// Where the product is on screen during a clip: Module 2 product box mapped through the Module 6 framing.
export function productOnScreen(clip, scene, W, H) {
  const b = scene?.details?.product_box;
  if (!b?.present || !(b.w > 0) || !scene.width || !scene.height) return null;
  const sw = scene.width, sh = scene.height, cr = clip.crop || {};
  let x, y, w, h;
  if (cr.mode === 'fit_background') {
    const s = Math.min(W / sw, H / sh), fw = sw * s, fh = sh * s, ox = (W - fw) / 2, oy = (H - fh) / 2;
    x = (ox + b.x * fw) / W; y = (oy + b.y * fh) / H; w = (b.w * fw) / W; h = (b.h * fh) / H;
  } else {
    const z = clamp(Number(cr.zoom) || 1, 1, 2), fx = cr.mode === 'center_crop' ? 0.5 : clamp(cr.x ?? 0.5, 0, 1), fy = cr.mode === 'center_crop' ? 0.5 : clamp(cr.y ?? 0.5, 0, 1);
    const s = Math.max((W * z) / sw, (H * z) / sh), cx = (sw * s - W) * fx, cy = (sh * s - H) * fy;
    x = (b.x * sw * s - cx) / W; y = (b.y * sh * s - cy) / H; w = (b.w * sw * s) / W; h = (b.h * sh * s) / H;
  }
  const x0 = clamp(x, 0, 1), y0 = clamp(y, 0, 1), x1 = clamp(x + w, 0, 1), y1 = clamp(y + h, 0, 1);
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}
const rectOf = e => ({ x: e.position.x - e.size.w / 2, y: e.position.y - e.size.h / 2, w: e.size.w, h: e.size.h });
const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const timeOverlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.02;
// Keep a block inside the safe zone (vertical centre moved in; horizontal centre kept between the side margins).
export function fitSafe(yc, size, sz, xc = 0.5) {
  const lo = sz.top + size.h / 2 + 0.01, hi = 1 - sz.bottom - size.h / 2 - 0.01;
  const y = lo <= hi ? clamp(yc, lo, hi) : (sz.top + 1 - sz.bottom) / 2;
  const xl = sz.left + size.w / 2 + 0.005, xh = 1 - sz.right - size.w / 2 - 0.005;
  const x = xl <= xh ? clamp(xc, xl, xh) : (sz.left + 1 - sz.right) / 2;
  return { x: r3(x), y: r3(y) };
}

const tgtCod = pp => !!pp.target?.confirmed?.cash_on_delivery;
// ---------- Build ----------
// ctx: { vx, edl, pkg (audio package), pp, brief, scenes (Map), director, settings, prev (plan|null), customStyles (Map),
//        brandKit (|null), safeZone {key, top, bottom, left, right, source}, refs {brief, script, storyboard, audio, video} }
export function buildPlan(ctx) {
  const { edl, pkg, pp, scenes, prev } = ctx;
  let dir = ctx.director;
  const settings = { ...DEFAULT_SETTINGS, ...(ctx.settings || {}), show: { ...DEFAULT_SETTINGS.show, ...(ctx.settings?.show || {}) } };
  const warnings = [], notes = [];
  const fps = edl.timeline.fps, D = edl.timeline.duration, aspect = edl.timeline.aspect_ratio;
  const [W, H] = [edl.timeline.width, edl.timeline.height];
  const kit = ctx.brandKit || null;
  const styleId = settings.style_id || kit?.caption_style || dir.style_id;
  const style = resolveStyle(styleId, settings.style_overrides, ctx.customStyles);
  const intensity = INTENSITIES[settings.intensity] ? settings.intensity : dir.intensity;
  const I = INTENSITIES[intensity];
  const palette = { primary: kit?.primary_color || dir.palette.primary, accent: kit?.accent_color || dir.palette.accent, secondary: kit?.secondary_color || dir.palette.text || '#FFFFFF' };
  if (kit?.accent_color && !settings.style_overrides?.highlight_color) style.highlight_color = kit.accent_color;
  const sz = ctx.safeZone;
  if (style.id !== dir.style_id) {
    const calm = ['luxury', 'minimal'].includes(style.base || style.id), bold = (style.energy || CAPTION_STYLES[style.base]?.energy) === 'high';
    dir = { ...dir, hook: { ...dir.hook, template: calm ? 'minimal_premium' : bold ? 'bold_headline' : dir.hook.template === 'minimal_premium' ? 'bold_headline' : dir.hook.template },
      price: { ...dir.price, template: calm ? 'premium_price' : dir.price.template === 'premium_price' ? (bold ? 'price_reveal' : 'price_card') : dir.price.template },
      cta: { ...dir.cta, template: calm ? 'minimal_premium' : dir.cta.template === 'minimal_premium' ? (tgtCod(pp) ? 'cod_card' : 'shop_now_pill') : dir.cta.template } };
  }
  const lang = String(pp.target?.language || 'en');
  const tgt = pp.target || {};
  const segs = pp.voiceover?.segments || [];
  const segTiming = pkg.synchronized_storyboard.segments;
  const prod = pp.production || {};
  // Each layer follows the brief's production preferences unless the team switched it on or off here.
  const want = (k, briefDefault) => (settings.show[k] === null || settings.show[k] === undefined ? briefDefault : !!settings.show[k]);
  const segAt = t => segTiming.find(w => t >= w.start && t < w.end);
  const roleOf = id => segs.find(s => s.id === id)?.role || segTiming.find(s => s.id === id)?.role || '';
  const clips = edl.tracks.video.filter(c => !c.missing);
  const clipAt = t => clips.find(c => t >= c.timeline_start && t < c.timeline_end) || clips.at(-1);
  const products = clips.map(c => ({ start: c.timeline_start, end: c.timeline_end, rect: productOnScreen(c, scenes.get(c.scene_id), W, H), clip: c }));
  const dirty = clips.map(c => { const sc = scenes.get(c.scene_id); const cl = sc ? cleanliness(sc) : { class: 'clean', reasons: [] }; return { start: c.timeline_start, end: c.timeline_end, clip: c, class: cl.class, reasons: cl.reasons }; }).filter(x => x.class !== 'clean');
  const unknownProduct = products.filter(p => !p.rect).length;
  if (unknownProduct) notes.push(`${unknownProduct} of ${products.length} clips have no measured product position: text there uses the style's default places (conservative).`);
  const elements = [];
  const fontFor = (key, text) => (hasArabic(text) ? ARABIC_FALLBACK[fontWeightClass(key)] : key);
  const fr = t => Math.round(t * fps);
  const mk = (type, e) => {
    const start = r3(clamp(e.start, 0, D)), end = r3(clamp(e.end, 0, D));
    return { id: e.id, type, track: TRACK_OF[type], text: e.text || '', lines: e.lines || [e.text || ''], start, end, start_frame: fr(start), end_frame: fr(end), position: e.position, size: e.size,
      max_width: r3(1 - sz.left - sz.right), font: e.font, colors: e.colors, outline: e.outline ?? null, shadow: e.shadow ?? null, background: e.background ?? null, animation: e.animation, template: e.template || '',
      layer: LAYER_OF[type], segment_id: e.segment_id || segAt(start)?.id || null, clip_id: e.clip_id || clipAt(start)?.id || null, visibility: { enabled: e.enabled !== false, rule: e.rule || '' },
      locked: false, edited: false, source: e.source || 'ai', purpose: e.purpose || '', ...(e.words ? { words: e.words } : {}), ...(e.ref ? { ref: e.ref } : {}), ...(e.extra || {}) };
  };
  const anim = (type, ms) => ({ type: ANIMATIONS.includes(type) ? type : 'fade', in_ms: Math.round(clamp(ms * I.anim_scale, 0, 600)), out_ms: Math.round(clamp(Math.min(160, ms), 0, 300)) });
  const fontObj = (key, size, uppercase = false) => ({ key, family: FONTS[key].family, size: r3(size), uppercase, weight: fontWeightClass(key) });

  // Collision helpers: rectangles in use over time (product: soft; text: hard).
  const used = [];
  const collides = (e, { productLimit = 0.18, ignore = [] } = {}) => {
    const r = rectOf(e), area = Math.max(1e-6, r.w * r.h);
    for (const p of products) if (p.rect && timeOverlap(e, p) && inter(r, p.rect) / area > productLimit) return 'product';
    // Text blocks keep a small gap between them (inflated rectangles), so two messages never stick together.
    const g = 0.018, rg = { x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g };
    for (const u of used) if (!ignore.includes(u.type) && timeOverlap(e, u) && inter(rg, rectOf(u)) > 0) return u.id;
    return '';
  };
  const productCover = t => { const r = rectOf(t), a = Math.max(1e-6, r.w * r.h); return products.filter(p => p.rect && timeOverlap(t, p)).reduce((m, p) => Math.max(m, inter(r, p.rect) / a), 0); };
  const place = (e, prefs, opts) => {
    const tries = prefs.map(p => { const pos = fitSafe(POSITIONS[p], e.size, sz); const t = { ...e, position: { ...pos, preset: p } }; return { t, hit: collides(t, opts) }; });
    const free = tries.find(x => !x.hit);
    if (free) return free.t;
    // Nothing is completely free: never on other text; the place covering the product least.
    const noText = tries.filter(x => x.hit === 'product').sort((a, b) => productCover(a.t) - productCover(b.t));
    const best = noText[0] || tries[0];
    return { ...best.t, conflict: best.hit };
  };

  // ---------- Captions ----------
  const dw = displayWords(pkg.captions, segs);
  const captionsOn = want('captions', prod.captions !== false) && dw.words.length > 0;
  let groups = [];
  const capFont = style.font;
  const maxChars = VX_LIMITS.maxCharsLine[aspect] || 22;
  const mode = SEGMENTATIONS[settings.segmentation] && settings.segmentation !== 'ai' ? settings.segmentation : dir.caption_segmentation || style.segmentation;
  if (captionsOn) {
    const keep = protectedPairs(dw.words, { productName: pp.product?.name, currency: tgt.currency });
    // Characters per line from the real width available (safe zone and style margins) and the font's width.
    const capCharsLine = Math.floor(((1 - sz.left - sz.right - 2 * style.safe_margin * 0.5) * W) / (style.size * H * (CHAR_W[capFont] || 0.6) * (style.uppercase ? 1.12 : 1)));
    groups = groupCaptions(dw.words, { mode: mode === 'ai' ? 'phrase' : mode, maxChars: clamp(Math.min(capCharsLine, maxChars + 6), 8, 40), maxLines: style.max_lines, keepTogether: keep, duration: D });
    markHighlights(groups, style.highlight_mode === 'none' ? [] : dir.keywords, { share: I.highlight_share, price: tgt.price });
    if (!dw.exact) warnings.push({ code: 'timing_estimated', message: dw.note });
  } else if (want('captions', prod.captions !== false) && !dw.words.length) notes.push(dw.note);
  // One caption position for the whole video (consistency), the one that covers the product least and fits the safe zone.
  const capPrefs = POSITIONS[settings.caption_position] ? [settings.caption_position] : POSITIONS[dir.caption_position] ? [dir.caption_position, style.position] : [style.position];
  for (const p of ['lower_middle', 'bottom', 'upper_middle', 'center', 'top']) if (!capPrefs.includes(p)) capPrefs.push(p);
  const capItems = groups.map((g, k) => {
    const texts = g.words.map(w => w.text);
    const lines = []; let n = 0; for (const c of g.lines) { lines.push(texts.slice(n, n + c).join(' ')); n += c; }
    const font = fontFor(capFont, texts.join(' '));
    const panel = style.background.mode === 'box' || dirty.some(d => timeOverlap(g, d));
    const pad = panel ? Math.max(style.background.padding, 0.008) : 0;
    return { g, k, lines, font, panel, size: textSize(lines.map(l => (style.uppercase ? l.toUpperCase() : l)), font, style.size, { W, H, uppercase: style.uppercase, spacing: style.line_spacing, pad }) };
  });
  let capBand = capPrefs[0];
  if (capItems.length) {
    const cost = p => capItems.reduce((s, it) => { const pos = fitSafe(POSITIONS[p], it.size, sz); const r = { x: pos.x - it.size.w / 2, y: pos.y - it.size.h / 2, w: it.size.w, h: it.size.h }; return s + products.filter(pr => pr.rect && timeOverlap(it.g, pr)).reduce((a, pr) => a + inter(r, pr.rect) / (r.w * r.h), 0); }, 0);
    const scored = capPrefs.map((p, i) => ({ p, c: cost(p) + i * 0.05 })).sort((a, b) => a.c - b.c);
    // Keep the style's place unless another one clearly covers the product less.
    capBand = cost(capPrefs[0]) - scored[0].c > 0.5 ? scored[0].p : capPrefs[0];
  }
  for (const it of capItems) {
    const { g, k, lines, font, panel } = it;
    const words = g.words.map(w => ({ text: w.text, start: r3(w.start), end: r3(w.end), ...(w.hl ? { hl: w.hl } : {}), timing: w.timing }));
    let e = mk('caption', { id: `cap-${g.words[0].i}`, text: g.words.map(w => w.text).join(' '), lines, words, start: g.start, end: g.end, size: it.size, position: { ...fitSafe(POSITIONS[capBand], it.size, sz), preset: capBand },
      font: fontObj(font, style.size, style.uppercase), colors: { text: style.text_color, highlight: style.highlight_color, outline: style.outline.color },
      outline: style.outline, shadow: style.shadow, background: panel ? { ...style.background, mode: 'box', opacity: style.background.mode === 'box' ? style.background.opacity : 0.5, color: style.background.mode === 'box' ? style.background.color : '#000000' } : style.background,
      animation: anim(style.animation.type, style.animation.duration_ms), template: style.id, source: 'voiceover', purpose: 'Accessibility captions synchronized with the voice-over',
      extra: { highlight_mode: style.highlight_mode, caption_mode: mode, rtl: hasArabic(lines.join(' ')), panel_reason: panel && style.background.mode !== 'box' ? 'source footage already shows text here: panel added for readability' : '' } });
    // A group that would cover the product moves to a free band for its duration only.
    if (collides(e, { productLimit: 0.35 })) { const moved = place(e, capPrefs.filter(p => p !== capBand), { productLimit: 0.35 }); if (!moved.conflict) e = { ...moved, extra_moved: true }; }
    elements.push(e);
  }
  used.push(...elements);
  const capY = elements.length ? elements[0].position.y : POSITIONS[capBand];
  const awayFromCaptions = prefs => [...prefs].sort((a, b) => Math.abs(POSITIONS[b] - capY) - Math.abs(POSITIONS[a] - capY) || prefs.indexOf(a) - prefs.indexOf(b));

  const fxOn = k => want('effects', true) && (INTENSITIES[settings.intensity] && settings.intensity !== dir.intensity ? I.effects : dir.effects || []).includes(k) && I.effects.includes(k);
  // Captions under a promotional graphic move to another band for that moment only (never two texts on top of each other).
  const moveCaptionsAway = el => {
    for (const c of elements.filter(x => x.type === 'caption' && timeOverlap(x, el))) {
      const r = rectOf(c), g = 0.018;
      if (inter({ x: r.x - g, y: r.y - g, w: r.w + 2 * g, h: r.h + 2 * g }, rectOf(el)) <= 0) continue;
      const opts = ['bottom', 'lower_middle', 'center', 'upper_middle', 'top'].filter(p => Math.abs(fitSafe(POSITIONS[p], c.size, sz).y - el.position.y) > (c.size.h + el.size.h) / 2 + 0.03);
      if (!opts.length) continue;
      const moved = place({ ...c }, opts, { productLimit: 0.35, ignore: ['caption'] });
      Object.assign(c, { position: moved.position, moved_for: el.type });
    }
  };
  // ---------- CTA window (end of the video) ----------
  const ctaSeg = segTiming.find(w => roleOf(w.id) === 'cta');
  // The CTA graphic appears when the voice says the CTA (or ~2.6 s before the end) and stays to the end, at least 2 s.
  let ctaStart = ctaSeg ? ctaSeg.start : D - VX_LIMITS.ctaIdeal;
  ctaStart = r3(clamp(Math.min(ctaStart, D - VX_LIMITS.ctaMin), D / 2, D - Math.min(VX_LIMITS.ctaMin, D / 3)));
  const ctaOn = want('cta', prod.cta_screen !== false) && !!dir.cta?.text;
  const hookSeg = segTiming[0];
  const hookEnd = r3(clamp(Math.max(Math.min(hookSeg?.end ?? 2.5, 3.2), 1.6), 0, Math.min(D, ctaStart)));
  const heavy = /black|extrabold|anton/.test(style.font) ? style.font : I === INTENSITIES.minimal ? style.font : 'montserrat-extrabold';
  const headFont = style.id === 'luxury' ? 'playfair-semibold' : heavy;

  // ---------- Price and offer (only real brief values) ----------
  const priceText = tgt.price ? formatPrice(tgt.price, tgt.currency, lang) : '';
  const offerText = cleanText(tgt.offer || '', 40);
  const priceOn = want('price', prod.price_display === true) && !!priceText && (dir.price?.show || settings.show.price === true);
  const offerOn = want('offer', true) && !!offerText && (dir.offer?.show || settings.show.offer === true);
  const confirmedCod = !!tgt.confirmed?.cash_on_delivery, freeDel = !!tgt.confirmed?.free_delivery;
  if (!tgt.price && want('price', prod.price_display === true)) notes.push('No price in the brief: no price graphic (nothing is invented).');
  notes.push('No crossed-out "before" price: the brief has no substantiated previous price.');

  // CTA
  if (ctaOn) {
    let tpl = CTA_TEMPLATES[dir.cta.template] ? dir.cta.template : 'shop_now_pill';
    if (tpl === 'cod_card' && !confirmedCod) tpl = 'shop_now_pill';
    if (tpl === 'price_cta' && !priceOn) tpl = 'shop_now_pill';
    if (tpl === 'promo_card' && !offerOn) tpl = 'shop_now_pill';
    const main = cleanText(dir.cta.text, 40);
    const sub = tpl === 'cod_card' ? phrase(lang, 'cod') : tpl === 'price_cta' ? priceText : tpl === 'promo_card' ? offerText : '';
    const lines = [main, ...(sub ? [sub] : [])];
    const font = fontFor(tpl === 'minimal_premium' ? 'playfair-semibold' : headFont, lines.join(' '));
    const size = tpl === 'order_now_text' ? 0.056 : tpl === 'minimal_premium' ? 0.042 : 0.044;
    const boxed = ['shop_now_pill', 'cod_card', 'price_cta', 'promo_card', 'showcase_cta'].includes(tpl);
    const sizeE = textSize(lines.map(l => (tpl === 'order_now_text' ? l.toUpperCase() : l)), font, size, { W, H, uppercase: tpl === 'order_now_text', spacing: 1.15, pad: boxed ? 0.016 : 0 });
    const e = mk('cta', { id: 'cta-1', text: main, lines, start: ctaStart, end: D, size: sizeE, position: { x: 0.5, y: 0.8, preset: 'bottom' }, font: fontObj(font, size, tpl === 'order_now_text'),
      colors: { text: boxed ? '#FFFFFF' : palette.secondary, highlight: palette.accent, outline: '#000000', accent: palette.accent }, outline: { width: boxed ? 0 : 0.004, color: '#000000' }, shadow: { depth: 0.003, color: '#000000', opacity: 0.5 },
      background: boxed ? { mode: 'box', color: palette.accent, opacity: 0.95, padding: 0.016, radius: 0.02 } : { mode: 'none' }, animation: { ...anim(I.anim_scale > 1 ? 'pop' : 'slide_up', 260), pulse: fxOn('cta_pulse') && tpl !== 'minimal_premium' },
      template: tpl, segment_id: ctaSeg?.id, source: 'brief', purpose: 'Call to action from the approved CTA', clip_id: clips.at(-1)?.id });
    elements.push(place(e, ['bottom', 'lower_middle', 'upper_middle', 'top', 'center'], { productLimit: 0.15, ignore: ['caption'] }));
    used.push(elements.at(-1));
    moveCaptionsAway(elements.at(-1));
  }
  if (priceOn) {
    const tpl = PRICE_TEMPLATES[dir.price.template] ? dir.price.template : 'price_card';
    const ctaEl = elements.find(x => x.type === 'cta');
    if (!(ctaEl?.template === 'price_cta')) {
      // When the voice says the price, show it then; otherwise just before the CTA.
      const digits = norm(tgt.price);
      const said = dw.words.find(w => digits && norm(w.text).includes(digits));
      let start = said ? said.start - 0.1 : ctaStart - 2.4, end = said ? Math.max(said.end + 1.6, start + 2) : ctaStart;
      if (said && end > ctaStart && ctaEl) end = ctaStart;
      if (end - start >= VX_LIMITS.minOverlaySec) {
        const font = fontFor(tpl === 'premium_price' ? 'playfair-bold' : headFont, priceText);
        const size = tpl === 'price_reveal' ? 0.06 : 0.05, boxed = ['price_card', 'promo_banner', 'bundle_card', 'offer_badge'].includes(tpl);
        const e = mk('price', { id: 'price-1', text: priceText, lines: [priceText], start, end, size: textSize([priceText], font, size, { W, H, pad: boxed ? 0.014 : 0 }), position: { x: 0.5, y: 0.3 },
          font: fontObj(font, size), colors: { text: tpl === 'premium_price' ? palette.accent : '#FFFFFF', highlight: palette.accent, outline: '#000000', accent: palette.accent },
          outline: { width: boxed ? 0 : 0.003, color: '#000000' }, shadow: { depth: 0.003, color: '#000000', opacity: 0.5 }, background: boxed ? { mode: 'box', color: palette.primary, opacity: 0.9, padding: 0.014 } : { mode: 'none' },
          animation: anim(tpl === 'price_reveal' ? 'pop' : tpl === 'promo_banner' ? 'slide_in' : 'fade', 240), template: tpl, source: 'brief', purpose: 'Price from the Creative Brief' + (said ? ' (when the voice says it)' : '') });
        elements.push(place(e, awayFromCaptions(['upper_middle', 'top', 'center']), { productLimit: 0.15, ignore: ['caption'] }));
        used.push(elements.at(-1)); moveCaptionsAway(elements.at(-1));
      } else notes.push('Price graphic skipped: no free moment of at least 1.2 s before the CTA.');
    }
  }
  if (offerOn && elements.find(x => x.type === 'cta')?.template !== 'promo_card') {
    const tpl = PRICE_TEMPLATES[dir.offer.template] ? dir.offer.template : 'offer_badge';
    const offSeg = segTiming.find(w => roleOf(w.id) === 'offer');
    let start = offSeg ? offSeg.start + 0.1 : Math.max(hookEnd + 0.2, ctaStart - 4.6), end = offSeg ? Math.min(offSeg.end, start + 3) : Math.min(start + 2.2, ctaStart);
    const lines = [offerText, ...(freeDel && tpl === 'bundle_card' ? [phrase(lang, 'free_delivery')] : [])];
    const font = fontFor(headFont, lines.join(' ')), size = 0.042, banner = tpl === 'promo_banner';
    const e = mk('offer', { id: 'offer-1', text: offerText, lines, start, end, size: banner ? { w: 1 - sz.left - sz.right, h: 0.075 } : textSize(lines.map(l => l.toUpperCase()), font, size, { W, H, uppercase: true, pad: 0.012 }), position: { x: 0.5, y: 0.3 },
      font: fontObj(font, size, true), colors: { text: '#FFFFFF', highlight: palette.accent, outline: '#000000', accent: palette.accent }, outline: { width: 0, color: '#000000' }, shadow: { depth: 0.003, color: '#000000', opacity: 0.5 },
      background: { mode: 'box', color: palette.accent, opacity: 0.95, padding: 0.012 }, animation: anim(fxOn('banner_slide') ? 'slide_in' : 'pop', 220), template: tpl, source: 'brief', purpose: 'Offer from the Creative Brief', segment_id: offSeg?.id });
    if (end - start >= VX_LIMITS.minOverlaySec) { elements.push(place(e, awayFromCaptions(['upper_middle', 'top', 'center']), { productLimit: 0.15, ignore: ['caption'] })); used.push(elements.at(-1)); moveCaptionsAway(elements.at(-1)); }
    else notes.push('Offer graphic skipped: no free moment of at least 1.2 s.');
  }

  // ---------- Hook ----------
  if (want('hook', prod.text_overlays !== false) && dir.hook?.show && dir.hook.text) {
    const tpl = HOOK_TEMPLATES[dir.hook.template] ? dir.hook.template : 'bold_headline';
    const text = cleanText(dir.hook.text, 60);
    const upper = ['bold_headline', 'highlighted_keyword', 'animated_reveal'].includes(tpl) && style.id !== 'luxury' && !hasArabic(text);
    const font = fontFor(tpl === 'minimal_premium' ? (style.id === 'luxury' ? 'playfair-semibold' : 'montserrat-medium') : headFont, text);
    // The headline is never smaller than the captions of the same video.
    const size = tpl === 'minimal_premium' ? 0.046 : clamp(Math.max(0.054, style.size * 1.12), 0.054, 0.075);
    const lines = (() => { const t = text.split(' '); const sp = t.length > 2 && text.length > 16 ? [Math.ceil(t.length / 2)] : [t.length]; return sp[0] < t.length ? [t.slice(0, sp[0]).join(' '), t.slice(sp[0]).join(' ')] : [text]; })();
    const boxed = ['question_headline', 'benefit_headline'].includes(tpl);
    const e = mk('hook', { id: 'hook-1', text, lines, start: Math.min(0.2, hookEnd / 4), end: hookEnd, size: textSize(lines.map(l => (upper ? l.toUpperCase() : l)), font, size, { W, H, uppercase: upper, spacing: 1.1, pad: boxed ? 0.014 : 0 }), position: { x: 0.5, y: 0.14 },
      font: fontObj(font, size, upper), colors: { text: style.id === 'luxury' ? '#F7F1E8' : '#FFFFFF', highlight: palette.accent, outline: '#000000', accent: palette.accent },
      outline: { width: boxed ? 0 : style.id === 'luxury' ? 0.0015 : 0.005, color: '#000000' }, shadow: { depth: 0.003, color: '#000000', opacity: 0.55 },
      background: boxed ? { mode: 'box', color: tpl === 'question_headline' ? palette.primary : palette.accent, opacity: 0.92, padding: 0.014 } : { mode: 'none' },
      animation: anim(tpl === 'animated_reveal' ? 'word_reveal' : tpl === 'minimal_premium' ? 'fade' : I.anim_scale > 1 ? 'pop' : 'slide_up', tpl === 'minimal_premium' ? 320 : 240),
      template: tpl, source: 'ai', purpose: 'Opening headline supporting the spoken hook', extra: { keyword: cleanText(dir.hook.keyword || '', 30), accent_line: fxOn('accent_line') } });
    elements.push(place(e, awayFromCaptions(['top', 'upper_middle', 'center']), { productLimit: 0.2, ignore: [] }));
    used.push(elements.at(-1));
  }

  // ---------- Benefit overlays ----------
  if (want('benefits', prod.text_overlays !== false)) {
    const busy = elements.filter(x => x.type !== 'caption');
    let n = 0;
    for (const b of dir.benefits || []) {
      if (n >= I.benefits) break;
      const w = segTiming.find(s => s.id === b.segment_id);
      if (!w) continue;
      const start = r3(w.start + 0.15), end = r3(Math.min(w.end, start + 2.6, ctaOn ? ctaStart : D));
      if (end - start < VX_LIMITS.minOverlaySec) { notes.push(`Overlay “${b.text}” skipped: its segment is too short to read it.`); continue; }
      const win = { start, end };
      if (busy.some(x => timeOverlap(x, win))) { notes.push(`Overlay “${b.text}” skipped: another text is on screen then.`); continue; }
      const d = dirty.find(x => timeOverlap(x, win));
      if (d) { warnings.push({ code: 'embedded_text', message: `Overlay “${b.text}” skipped: the footage at ${start.toFixed(1)} s already shows text or graphics (${d.reasons.join(', ')}).`, clip: d.clip.id }); continue; }
      let tpl = BENEFIT_TEMPLATES[b.template] ? b.template : 'label';
      const pr = products.find(p => timeOverlap(p, win))?.rect;
      if (tpl === 'callout' && !pr) tpl = 'label';
      const text = cleanText(b.text, 40), font = fontFor(style.id === 'luxury' ? 'playfair-semibold' : 'poppins-bold', text), size = 0.036;
      const boxed = ['label', 'badge', 'card'].includes(tpl);
      const e = mk('benefit', { id: `ben-${b.segment_id}`, text, lines: [text], start, end, size: textSize([tpl === 'badge' ? text.toUpperCase() : text], font, size, { W, H, uppercase: tpl === 'badge', pad: boxed ? 0.012 : 0 }), position: { x: 0.5, y: 0.3 },
        font: fontObj(font, size, tpl === 'badge'), colors: { text: tpl === 'card' ? '#111111' : '#FFFFFF', highlight: palette.accent, outline: '#000000', accent: palette.accent },
        outline: { width: boxed ? 0 : 0.003, color: '#000000' }, shadow: { depth: boxed ? 0.002 : 0.003, color: '#000000', opacity: 0.45 },
        background: boxed ? { mode: 'box', color: tpl === 'card' ? '#FFFFFF' : tpl === 'badge' ? palette.accent : palette.primary, opacity: 0.93, padding: 0.012 } : { mode: 'none' },
        animation: anim(fxOn('card_reveal') ? 'slide_in' : 'fade', 220), template: tpl, segment_id: b.segment_id, source: 'ai',
        purpose: `Restates: “${cleanText(b.source_text, 80)}”`, extra: { pointer: tpl === 'callout' ? { x: r3(pr.x + pr.w / 2), y: r3(pr.y + pr.h / 2) } : null } });
      const placed = place(e, awayFromCaptions(['upper_middle', 'top', 'center']), { productLimit: 0.12, ignore: [] });
      if (placed.conflict) { notes.push(`Overlay “${text}” skipped: no free place without covering ${placed.conflict === 'product' ? 'the product' : 'other text'}.`); continue; }
      elements.push(placed); used.push(placed); busy.push(placed); n++;
    }
  }

  // ---------- Effects ----------
  // When the team chose another intensity than the director, that intensity's own effects are used.
  const fxWanted = INTENSITIES[settings.intensity] && settings.intensity !== dir.intensity ? I.effects : dir.effects || [];
  const fx = want('effects', true) ? fxWanted.filter(k => EFFECTS[k] && I.effects.includes(k)) : [];
  if (fx.includes('gradient_band') && capItems.length && style.background.mode === 'none') {
    const caps = elements.filter(x => x.type === 'caption');
    const y = caps[0].position.y, h = Math.min(0.32, Math.max(...caps.map(c => c.size.h)) * 2.6);
    elements.push(mk('effect', { id: 'fx-gradient', text: '', lines: [], start: caps[0].start, end: caps.at(-1).end, size: { w: 1, h: r3(h) }, position: { x: 0.5, y: r3(y), preset: caps[0].position.preset },
      font: null, colors: { text: '#000000', accent: '#000000' }, animation: { type: 'fade', in_ms: 300, out_ms: 300 }, template: 'gradient_band', source: 'ai', purpose: EFFECTS.gradient_band }));
  }
  if (fx.includes('highlight_pulse') || fx.includes('keyword_scale')) for (const c of elements.filter(x => x.type === 'caption')) c.emphasis = fx.includes('keyword_scale') ? 'scale' : 'pulse';

  // ---------- Branding ----------
  if (kit?.logo_key && kit.logo_visible !== false && want('branding', true) && settings.logo_mode !== 'hidden') {
    const corner = ['top_left', 'top_right', 'bottom_left', 'bottom_right'].includes(kit.logo_position) ? kit.logo_position : 'top_right';
    const w = aspect === '16:9' ? 0.1 : 0.16, h = r3((w * W * (kit.logo_ratio || 1)) / H);
    const x = corner.endsWith('left') ? sz.left + w / 2 + 0.01 : 1 - sz.right - w / 2 - 0.01, y = corner.startsWith('top') ? sz.top + h / 2 + 0.01 : 1 - sz.bottom - h / 2 - 0.01;
    const start = settings.logo_mode === 'closing' ? ctaStart : hookEnd + 0.2;
    elements.push(mk('logo', { id: 'logo-1', text: '', lines: [], start, end: D, size: { w, h }, position: { x: r3(x), y: r3(y), preset: corner }, font: null, colors: {}, animation: { type: 'fade', in_ms: 300, out_ms: 0 },
      template: 'logo', source: 'brand_kit', purpose: `Brand logo (${kit.name})`, extra: { asset: kit.logo_key } }));
  }

  // ---------- Team edits and locks win ----------
  if (prev?.elements) {
    const keep = new Map(prev.elements.filter(e => e.locked || e.edited).map(e => [e.id, e]));
    for (let i = 0; i < elements.length; i++) { const k = keep.get(elements[i].id); if (k) { elements[i] = { ...k, start: r3(clamp(k.start, 0, D)), end: r3(clamp(k.end, 0, D)) }; keep.delete(k.id); } }
    // A layer switched off stays off, even for elements the team edited.
    const showKey = { caption: 'captions', hook: 'hook', benefit: 'benefits', feature: 'benefits', price: 'price', offer: 'offer', cta: 'cta', effect: 'effects', logo: 'branding' };
    for (const k of keep.values()) {
      if (settings.show[showKey[k.type]] === false || (k.type === 'caption' && !captionsOn)) continue;
      if (k.type !== 'caption' || !elements.some(e => e.type === 'caption' && timeOverlap(e, k))) elements.push(k);
    }
  }
  // Text on a panel: dark or light, whichever reads better on that panel colour.
  for (const e of elements) if (e.background?.mode === 'box' && e.colors?.text && !e.edited && contrast(e.colors.text, e.background.color) < 4.5) e.colors.text = contrast('#FFFFFF', e.background.color) >= contrast('#111111', e.background.color) ? '#FFFFFF' : '#111111';
  elements.sort((a, b) => a.start - b.start || a.layer - b.layer);
  const plan = {
    schema_version: VX_SCHEMA_VERSION, vx_id: ctx.vx.id, project_id: ctx.vx.project_id, product_id: ctx.vx.product_id, variation_index: ctx.vx.variation_index,
    inputs: ctx.refs, output: { aspect_ratio: aspect, width: W, height: H, fps, duration: D, frames: edl.timeline.frames },
    visual_style: dir.visual_style || '', director_summary: dir.summary || '',
    style: { id: style.id, name: style.name, config: style }, intensity, palette, brand_kit: kit ? { id: kit.id, name: kit.name } : null,
    safe_zone: { preset: sz.key, label: sz.label, top: sz.top, bottom: sz.bottom, left: sz.left, right: sz.right, source: sz.source, verified: !!sz.verified },
    caption: { enabled: captionsOn, mode, position: capBand, timing_source: dw.source, timing_confidence: dw.confidence || null, exact_word_timing: !!dw.exact, note: dw.note, groups: elements.filter(e => e.type === 'caption').length },
    settings, elements, notes, director_warnings: dir.warnings || [],
  };
  plan.validation = validatePlan(plan, { products, dirty, extraWarnings: warnings });
  return plan;
}

// ---------- Validation ----------
export function validatePlan(plan, { products = [], dirty = [], extraWarnings = [] } = {}) {
  const errors = [], warnings = [...extraWarnings];
  const D = plan.output.duration, fps = plan.output.fps, sz = plan.safe_zone;
  const on = plan.elements.filter(e => e.visibility?.enabled !== false);
  const ids = new Set();
  for (const e of plan.elements) {
    const tag = `${e.type} “${(e.text || e.template).slice(0, 30)}”`;
    if (ids.has(e.id)) errors.push({ code: 'duplicate_id', message: `Two elements share the id ${e.id}.`, element: e.id }); ids.add(e.id);
    if (!ELEMENT_TYPES.includes(e.type)) errors.push({ code: 'type', message: `Unknown element type ${e.type}.`, element: e.id });
    if (!(e.start >= 0) || !(e.end <= D + 1 / fps + 0.001) || !(e.end > e.start)) errors.push({ code: 'time', message: `${tag}: times ${e.start}–${e.end} s are outside the video (0–${D} s).`, element: e.id });
    if (e.animation && !ANIMATIONS.includes(e.animation.type)) errors.push({ code: 'animation', message: `${tag}: unknown animation.`, element: e.id });
    if (e.font) {
      if (!FONTS[e.font.key]) errors.push({ code: 'font', message: `${tag}: unknown font.`, element: e.id });
      if (e.font.size < VX_LIMITS.minFontFrac) errors.push({ code: 'font_size', message: `${tag}: text too small to read on a phone.`, element: e.id });
      if (hasArabic(e.text) && !FONTS[e.font.key]?.scripts.includes('arabic')) errors.push({ code: 'font_script', message: `${tag}: Arabic text needs an Arabic font.`, element: e.id });
    }
    if ((e.text || '').length > VX_LIMITS.maxTextLen) errors.push({ code: 'text_long', message: `${tag}: text too long.`, element: e.id });
    if (e.visibility?.enabled === false) continue;
    if (e.type !== 'effect' && e.type !== 'logo' && e.size) {
      const r = rectOf(e);
      if (r.x < -0.001 || r.y < -0.001 || r.x + r.w > 1.001 || r.y + r.h > 1.001) warnings.push({ code: 'frame', message: `${tag}: may not fit in the frame (estimated); the measured check after rendering confirms it.`, element: e.id });
      else if (r.y < sz.top - 0.005 || r.y + r.h > 1 - sz.bottom + 0.005 || r.x < sz.left - 0.005 || r.x + r.w > 1 - sz.right + 0.005) warnings.push({ code: 'safe_zone', message: `${tag}: outside the ${sz.label} safe zone (platform buttons may cover it).`, element: e.id });
      const area = Math.max(1e-6, r.w * r.h);
      const hit = products.find(p => p.rect && timeOverlap(e, p) && inter(r, p.rect) / area > (e.type === 'caption' ? 0.35 : 0.15));
      if (hit) warnings.push({ code: 'product_cover', message: `${tag} may cover the product at ${Math.max(e.start, hit.start).toFixed(1)} s. Move it or lock another position.`, element: e.id, clip: hit.clip.id });
      const bg = e.background?.mode === 'box' ? e.background.color : null;
      const ratio = bg ? contrast(e.colors.text, bg) : e.outline?.width > 0.001 ? contrast(e.colors.text, e.outline.color) : e.shadow?.depth > 0 ? contrast(e.colors.text, e.shadow.color) : 1;
      if (ratio < VX_LIMITS.minContrast) warnings.push({ code: 'contrast', message: `${tag}: low contrast (${ratio.toFixed(1)}:1). Add an outline or a panel.`, element: e.id });
      if (e.type !== 'caption' && e.type !== 'cta' && e.end - e.start < VX_LIMITS.minOverlaySec) warnings.push({ code: 'reading_time', message: `${tag}: on screen ${(e.end - e.start).toFixed(1)} s, short to read.`, element: e.id });
      if (e.type !== 'caption' && (e.text || '').length / Math.max(0.1, e.end - e.start) > 22) warnings.push({ code: 'reading_speed', message: `${tag}: a lot of text for its time on screen.`, element: e.id });
    }
  }
  // Text over source footage that already has text (Module 2 detection; the exact place of that text is not known).
  for (const d of dirty) {
    const over = on.filter(e => e.type !== 'effect' && e.type !== 'logo' && timeOverlap(e, d));
    if (over.length) warnings.push({ code: 'embedded_text', message: `Clip ${d.clip.order} (${d.start.toFixed(1)}–${d.end.toFixed(1)} s) already shows ${d.reasons.join(', ') || 'text'}: new text may clutter it. Check the preview; clean footage is better.`, clip: d.clip.id });
  }
  // Simultaneous text and overlaps between text elements.
  const texts = on.filter(e => !['effect', 'logo'].includes(e.type));
  for (const t of [...new Set(texts.map(e => e.start))]) {
    const at = texts.filter(e => e.start <= t + 0.01 && e.end > t + 0.01);
    if (at.length > VX_LIMITS.maxSimultaneousText) { warnings.push({ code: 'too_much_text', message: `${at.length} text blocks on screen at ${t.toFixed(1)} s: too many competing messages.` }); break; }
  }
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (a.type === 'caption' && b.type === 'caption') continue;
    if (timeOverlap(a, b) && inter(rectOf(a), rectOf(b)) > 0.002) warnings.push({ code: 'overlap', message: `${a.type} “${a.text.slice(0, 20)}” and ${b.type} “${b.text.slice(0, 20)}” overlap on screen at ${Math.max(a.start, b.start).toFixed(1)} s.`, element: b.id });
  }
  const promo = on.filter(e => ['benefit', 'feature', 'hook', 'offer'].includes(e.type)).map(e => norm(e.text));
  if (promo.length !== new Set(promo).size) warnings.push({ code: 'repeated', message: 'The same promotional message appears twice.' });
  const val = { valid: !errors.length, errors, warnings, checked_at: new Date().toISOString() };
  return val;
}
