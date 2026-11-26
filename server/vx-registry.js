// Module 7 vocabulary, stored in one place: bundled fonts (SIL Open Font License), the Caption Style Registry,
// animations, intensity modes, overlay / price / CTA templates, visual effects, positions and the Safe Zone Registry.
// Everything the renderer accepts is listed here: AI answers and team edits are checked against these lists.
import { join } from 'node:path';
import { ROOT } from './paths.js';

export const VX_SCHEMA_VERSION = '1.0';
export const FONTS_DIR = join(ROOT, 'server', 'fonts');
const num = (n, d) => { const r = process.env[n]; const v = Number(r); return r !== undefined && r !== '' && Number.isFinite(v) ? v : d; };

// ---------- Fonts (all SIL Open Font License 1.1: free for commercial use, licence files in server/fonts/licenses) ----------
// family = the name libass looks up; scripts = what the font can write (Cairo writes Arabic and Latin).
export const FONTS = {
  'montserrat-black': { family: 'Montserrat Black', file: 'Montserrat_900Black.ttf', label: 'Montserrat Black', scripts: ['latin'], license: 'OFL-1.1' },
  'montserrat-extrabold': { family: 'Montserrat ExtraBold', file: 'Montserrat_800ExtraBold.ttf', label: 'Montserrat ExtraBold', scripts: ['latin'], license: 'OFL-1.1' },
  'montserrat-medium': { family: 'Montserrat Medium', file: 'Montserrat_500Medium.ttf', label: 'Montserrat Medium', scripts: ['latin'], license: 'OFL-1.1' },
  'poppins-extrabold': { family: 'Poppins ExtraBold', file: 'Poppins_800ExtraBold.ttf', label: 'Poppins ExtraBold', scripts: ['latin'], license: 'OFL-1.1' },
  'poppins-bold': { family: 'Poppins', file: 'Poppins_700Bold.ttf', label: 'Poppins Bold', scripts: ['latin'], license: 'OFL-1.1', bold: true },
  'poppins-semibold': { family: 'Poppins SemiBold', file: 'Poppins_600SemiBold.ttf', label: 'Poppins SemiBold', scripts: ['latin'], license: 'OFL-1.1' },
  'poppins-medium': { family: 'Poppins Medium', file: 'Poppins_500Medium.ttf', label: 'Poppins Medium', scripts: ['latin'], license: 'OFL-1.1' },
  'playfair-semibold': { family: 'Playfair Display SemiBold', file: 'PlayfairDisplay_600SemiBold.ttf', label: 'Playfair Display SemiBold', scripts: ['latin'], license: 'OFL-1.1' },
  'playfair-bold': { family: 'Playfair Display', file: 'PlayfairDisplay_700Bold.ttf', label: 'Playfair Display Bold', scripts: ['latin'], license: 'OFL-1.1', bold: true },
  'anton': { family: 'Anton', file: 'Anton_400Regular.ttf', label: 'Anton', scripts: ['latin'], license: 'OFL-1.1' },
  'cairo-semibold': { family: 'Cairo SemiBold', file: 'Cairo_600SemiBold.ttf', label: 'Cairo SemiBold (Arabic + Latin)', scripts: ['arabic', 'latin'], license: 'OFL-1.1' },
  'cairo-bold': { family: 'Cairo', file: 'Cairo_700Bold.ttf', label: 'Cairo Bold (Arabic + Latin)', scripts: ['arabic', 'latin'], license: 'OFL-1.1', bold: true },
  'cairo-extrabold': { family: 'Cairo ExtraBold', file: 'Cairo_800ExtraBold.ttf', label: 'Cairo ExtraBold (Arabic + Latin)', scripts: ['arabic', 'latin'], license: 'OFL-1.1' },
};
// Arabic text (Arabic, Moroccan Darija in Arabic letters) always uses a font that writes Arabic, matched by weight.
export const ARABIC_FALLBACK = { heavy: 'cairo-extrabold', bold: 'cairo-bold', regular: 'cairo-semibold' };
export const fontWeightClass = key => (/black|extrabold|anton/.test(key) ? 'heavy' : /bold/.test(key) ? 'bold' : 'regular');

// ---------- Caption styles ----------
// Sizes are fractions of the frame height (so a style looks the same at 540×960 and 1080×1920); outline and shadow too.
export const ANIMATIONS = ['static', 'fade', 'slide_up', 'slide_in', 'pop', 'bounce', 'scale_emphasis', 'word_reveal', 'karaoke'];
export const HIGHLIGHT_MODES = ['color', 'color_scale', 'box', 'bold', 'none'];
export const SEGMENTATIONS = { word: [1, 1], two: [2, 2], three: [3, 3], phrase: [2, 5], sentence: [4, 9], ai: [2, 5] };
export const POSITIONS = { top: 0.14, upper_middle: 0.3, center: 0.5, lower_middle: 0.66, bottom: 0.8 }; // vertical centre of the text block
const style = (id, name, description, s) => ({ id, name, description, builtin: true, ...s });
export const CAPTION_STYLES = {
  hormozi: style('hormozi', 'Hormozi-Inspired Bold', 'Large bold words, high contrast, key words highlighted, controlled pop-in, very short groups.', {
    font: 'montserrat-black', size: 0.058, uppercase: true, text_color: '#FFFFFF', highlight_color: '#FFD60A', highlight_mode: 'color_scale',
    outline: { width: 0.0055, color: '#000000' }, shadow: { depth: 0.003, color: '#000000', opacity: 0.6 }, background: { mode: 'none', color: '#000000', opacity: 0, radius: 0, padding: 0 },
    line_spacing: 1.0, animation: { type: 'pop', duration_ms: 160 }, position: 'lower_middle', max_lines: 2, safe_margin: 0.07, segmentation: 'three', energy: 'high' }),
  modern_bold: style('modern_bold', 'Modern Bold', 'Clean sans-serif, strong hierarchy, selective highlight colour, smooth entrance.', {
    font: 'poppins-extrabold', size: 0.05, uppercase: false, text_color: '#FFFFFF', highlight_color: '#FF6B35', highlight_mode: 'color',
    outline: { width: 0.004, color: '#111111' }, shadow: { depth: 0.004, color: '#000000', opacity: 0.45 }, background: { mode: 'none', color: '#000000', opacity: 0, radius: 0, padding: 0 },
    line_spacing: 1.05, animation: { type: 'slide_up', duration_ms: 220 }, position: 'lower_middle', max_lines: 2, safe_margin: 0.07, segmentation: 'phrase', energy: 'medium' }),
  karaoke: style('karaoke', 'Karaoke Highlight', 'A short phrase stays on screen; the word being spoken lights up with the real voice timing.', {
    font: 'poppins-bold', size: 0.046, uppercase: false, text_color: '#FFFFFF', highlight_color: '#2EE6A6', highlight_mode: 'color',
    outline: { width: 0.004, color: '#000000' }, shadow: { depth: 0.003, color: '#000000', opacity: 0.5 }, background: { mode: 'none', color: '#000000', opacity: 0, radius: 0, padding: 0 },
    line_spacing: 1.05, animation: { type: 'karaoke', duration_ms: 120 }, position: 'lower_middle', max_lines: 2, safe_margin: 0.07, segmentation: 'phrase', energy: 'medium' }),
  minimal: style('minimal', 'Minimal Clean', 'Simple readable subtitles on a soft panel, minimal animation, neutral colours.', {
    font: 'poppins-medium', size: 0.038, uppercase: false, text_color: '#FFFFFF', highlight_color: '#FFFFFF', highlight_mode: 'bold',
    outline: { width: 0, color: '#000000' }, shadow: { depth: 0, color: '#000000', opacity: 0 }, background: { mode: 'box', color: '#000000', opacity: 0.55, radius: 0.012, padding: 0.012 },
    line_spacing: 1.1, animation: { type: 'fade', duration_ms: 180 }, position: 'bottom', max_lines: 2, safe_margin: 0.07, segmentation: 'sentence', energy: 'low' }),
  luxury: style('luxury', 'Luxury', 'Elegant serif, ivory and gold, subtle fades, controlled emphasis. For watches, jewellery and premium products.', {
    font: 'playfair-semibold', size: 0.044, uppercase: false, text_color: '#F7F1E8', highlight_color: '#D4AF37', highlight_mode: 'color',
    outline: { width: 0.0015, color: '#1A1A1A' }, shadow: { depth: 0.0025, color: '#000000', opacity: 0.55 }, background: { mode: 'none', color: '#000000', opacity: 0, radius: 0, padding: 0 },
    line_spacing: 1.12, animation: { type: 'fade', duration_ms: 260 }, position: 'lower_middle', max_lines: 2, safe_margin: 0.08, segmentation: 'phrase', energy: 'low' }),
  dynamic_pop: style('dynamic_pop', 'Dynamic Pop', 'Energetic condensed type, short animated groups, scale emphasis on key words.', {
    font: 'anton', size: 0.064, uppercase: true, text_color: '#FFFFFF', highlight_color: '#FF3B5C', highlight_mode: 'color_scale',
    outline: { width: 0.006, color: '#000000' }, shadow: { depth: 0.004, color: '#000000', opacity: 0.55 }, background: { mode: 'none', color: '#000000', opacity: 0, radius: 0, padding: 0 },
    line_spacing: 1.0, animation: { type: 'bounce', duration_ms: 200 }, position: 'center', max_lines: 2, safe_margin: 0.07, segmentation: 'two', energy: 'high' }),
  social_ugc: style('social_ugc', 'Social UGC', 'Natural social-media captions: dark text on a white rounded panel, conversational.', {
    font: 'poppins-semibold', size: 0.04, uppercase: false, text_color: '#111111', highlight_color: '#E63946', highlight_mode: 'color',
    outline: { width: 0, color: '#FFFFFF' }, shadow: { depth: 0, color: '#000000', opacity: 0 }, background: { mode: 'box', color: '#FFFFFF', opacity: 0.96, radius: 0.014, padding: 0.012 },
    line_spacing: 1.08, animation: { type: 'pop', duration_ms: 140 }, position: 'lower_middle', max_lines: 2, safe_margin: 0.07, segmentation: 'phrase', energy: 'medium' }),
};
export const STYLE_FIELDS = ['font', 'size', 'uppercase', 'text_color', 'highlight_color', 'highlight_mode', 'outline', 'shadow', 'background', 'line_spacing', 'animation', 'position', 'max_lines', 'safe_margin', 'segmentation'];

// ---------- Intensity ----------
// How much the Visual Director may add. "ai" lets the director choose one of the three.
export const INTENSITIES = {
  minimal: { label: 'Minimal', highlight_share: 0.12, benefits: 1, effects: ['gradient_band'], hook: 'static_or_fade', price_templates: ['price_card', 'premium_price'], anim_scale: 0.6 },
  balanced: { label: 'Balanced', highlight_share: 0.25, benefits: 2, effects: ['gradient_band', 'accent_line', 'card_reveal', 'highlight_pulse', 'cta_pulse'], hook: 'animated', anim_scale: 1 },
  dynamic: { label: 'Dynamic', highlight_share: 0.35, benefits: 3, effects: ['gradient_band', 'accent_line', 'card_reveal', 'highlight_pulse', 'cta_pulse', 'banner_slide', 'keyword_scale'], hook: 'animated', anim_scale: 1.25 },
};
export const DEFAULT_INTENSITY = ['minimal', 'balanced', 'dynamic'].includes(process.env.VX_DEFAULT_INTENSITY) ? process.env.VX_DEFAULT_INTENSITY : 'balanced';

// ---------- Overlay templates ----------
export const HOOK_TEMPLATES = { bold_headline: 'Bold headline', question_headline: 'Question headline', highlighted_keyword: 'Highlighted keyword', minimal_premium: 'Minimal premium headline', animated_reveal: 'Animated text reveal', benefit_headline: 'Product benefit headline' };
export const BENEFIT_TEMPLATES = { label: 'Text label', badge: 'Feature badge', card: 'Feature information card', highlight_line: 'Highlight line', callout: 'Callout with pointer (needs the product position)' };
export const PRICE_TEMPLATES = { price_card: 'Clean price card', offer_badge: 'Bold offer badge', premium_price: 'Premium price display', promo_banner: 'Promotional banner', bundle_card: 'Bundle offer card', price_reveal: 'Animated price reveal' };
export const CTA_TEMPLATES = { order_now_text: 'Animated “Order now” text', shop_now_pill: 'Shop-now style label', showcase_cta: 'Product showcase with CTA', price_cta: 'Price and CTA', minimal_premium: 'Minimal premium closing', cod_card: 'Cash on delivery closing card', promo_card: 'Promotional closing card' };
export const EFFECTS = {
  gradient_band: 'Soft dark gradient behind the captions (readability)',
  accent_line: 'Graphic accent line under the hook',
  card_reveal: 'Benefit cards slide in',
  highlight_pulse: 'One gentle pulse on a highlighted keyword',
  cta_pulse: 'Slow pulse on the CTA label',
  banner_slide: 'Offer banner slides in',
  keyword_scale: 'Highlighted words scale up slightly',
};
export const ELEMENT_TYPES = ['caption', 'hook', 'benefit', 'feature', 'price', 'offer', 'cta', 'effect', 'logo'];
export const TRACKS = { captions: 'Captions', hook: 'Hook text', features: 'Product features', benefits: 'Benefit overlays', promo: 'Promotional graphics', cta: 'CTA graphics', effects: 'Visual effects', branding: 'Branding' };
export const TRACK_OF = { caption: 'captions', hook: 'hook', benefit: 'benefits', feature: 'features', price: 'promo', offer: 'promo', cta: 'cta', effect: 'effects', logo: 'branding' };
export const LAYER_OF = { effect: 1, caption: 5, hook: 6, benefit: 4, feature: 4, price: 7, offer: 7, cta: 8, logo: 9 };

// ---------- Safe Zone Registry ----------
// Fractions of the frame to keep free of text and logos (platform buttons, account name, description, navigation).
// These are planning guides, not universal truths: platforms change their interface. Admins can update every preset
// (Visual Studio → Safe zones); "source" says where the numbers come from and when they were last reviewed.
export const SAFE_ZONES = {
  instagram_reels: { label: 'Instagram Reels', aspect: '9:16', top: 0.14, bottom: 0.35, left: 0.06, right: 0.06, source: 'Meta Reels ads guidance as widely cited (14% top, 35% bottom, 6% sides; 40% bottom when a disclaimer is shown). Not confirmed on a Meta page in our 2026-11 review: check the Safe Zone overlay in Ads Manager.', verified: false },
  facebook_reels: { label: 'Facebook Reels', aspect: '9:16', top: 0.14, bottom: 0.35, left: 0.06, right: 0.06, source: 'Same as Instagram Reels (Meta Reels ads guidance as widely cited, reviewed 2026-11; confirm in Ads Manager).', verified: false },
  facebook_feed: { label: 'Facebook Feed', aspect: '4:5', top: 0.05, bottom: 0.1, left: 0.05, right: 0.05, source: 'Conservative margin: feed videos show the full frame; the bottom can be covered by captions/controls.', verified: false },
  instagram_feed: { label: 'Instagram Feed', aspect: '4:5', top: 0.05, bottom: 0.1, left: 0.05, right: 0.05, source: 'Conservative margin for feed placements.', verified: false },
  tiktok: { label: 'TikTok', aspect: '9:16', top: 0.09, bottom: 0.25, left: 0.06, right: 0.15, source: 'Approximate TikTok interface (caption and account at the bottom, buttons on the right). Check TikTok Ads Manager safe-zone overlay.', verified: false },
  youtube_shorts: { label: 'YouTube Shorts', aspect: '9:16', top: 0.1, bottom: 0.22, left: 0.06, right: 0.14, source: 'Approximate Shorts interface (title and channel at the bottom, buttons on the right).', verified: false },
  youtube_ads: { label: 'YouTube Ads (in-stream)', aspect: '16:9', top: 0.06, bottom: 0.16, left: 0.05, right: 0.05, source: 'Approximate: skip button, progress bar and advertiser card at the bottom.', verified: false },
  generic_vertical: { label: 'Generic vertical 9:16', aspect: '9:16', top: 0.1, bottom: 0.22, left: 0.06, right: 0.1, source: 'Conservative default covering the common vertical interfaces.', verified: false },
  generic_square: { label: 'Generic square 1:1', aspect: '1:1', top: 0.05, bottom: 0.08, left: 0.05, right: 0.05, source: 'Conservative default.', verified: false },
  generic_45: { label: 'Generic 4:5', aspect: '4:5', top: 0.05, bottom: 0.1, left: 0.05, right: 0.05, source: 'Conservative default.', verified: false },
  generic_landscape: { label: 'Generic landscape 16:9', aspect: '16:9', top: 0.05, bottom: 0.1, left: 0.05, right: 0.05, source: 'Conservative default.', verified: false },
};
// Default preset from the brief's platform and the video's format.
export function defaultSafeZone(platformId, aspect) {
  const vertical = aspect === '9:16';
  const map = { tiktok: vertical ? 'tiktok' : null, yt_shorts: vertical ? 'youtube_shorts' : null, youtube: aspect === '16:9' ? 'youtube_ads' : null,
    instagram: vertical ? 'instagram_reels' : 'instagram_feed', facebook: vertical ? 'facebook_reels' : 'facebook_feed', fb_ig: vertical ? 'instagram_reels' : 'facebook_feed' };
  return map[platformId] || { '9:16': 'generic_vertical', '1:1': 'generic_square', '4:5': 'generic_45', '16:9': 'generic_landscape' }[aspect] || 'generic_vertical';
}

// ---------- Readability limits ----------
export const VX_LIMITS = {
  minFontFrac: num('VX_MIN_FONT', 0.028),          // smallest readable text, fraction of the frame height
  maxFontFrac: 0.11,
  minCaptionSec: num('VX_MIN_CAPTION', 0.35),       // a caption group stays at least this long (if the speech allows)
  maxCaptionSec: num('VX_MAX_CAPTION', 2.6),
  minOverlaySec: num('VX_MIN_OVERLAY', 1.2),        // promotional text needs time to be read
  ctaMin: num('VX_CTA_MIN', 2), ctaIdeal: num('VX_CTA_IDEAL', 2.6),
  maxSimultaneousText: 3,                           // captions + at most two other text blocks at once
  maxCharsLine: { '9:16': 22, '4:5': 24, '1:1': 24, '16:9': 36 },
  maxTextLen: 90,                                   // any single overlay text
  logoMaxBytes: 2 * 1024 * 1024,
  minContrast: 3,                                   // WCAG-like ratio between text and its outline / panel
};
export const VX_STATUSES = ['draft', 'queued', 'preparing_strategy', 'generating_captions', 'generating_overlays', 'preparing_effects', 'validating_plan', 'rendering', 'quality_checking', 'uploading', 'ready', 'approved', 'failed', 'cancelled'];

// ---------- Colours ----------
export const isHex = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
export const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = h => { const [r, g, b] = hexToRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
