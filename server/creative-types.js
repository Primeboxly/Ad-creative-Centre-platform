// Module 3 registry: creative types (narrative templates) and every creative setting option, in one place.
// Future modules (scripts, storyboards, voice-over, editing) read the structures from here through the Creative Brief.
// To add a creative type: add one entry to CREATIVE_TYPES (unique id). Nothing else in the app hardcodes them.

// Scene categories come from Module 2 (server/footage-ai.js CATEGORIES).
export const CREATIVE_TYPES = [
  {
    id: 'problem_solution', name: 'Problem – Solution', icon: '🩹',
    description: 'Show a real everyday problem, then the product solving it.',
    structure: [
      { key: 'hook', label: 'Hook', purpose: 'Stop the scroll with the problem or its consequence.' },
      { key: 'problem', label: 'Problem', purpose: 'Show the situation and the frustration.' },
      { key: 'solution', label: 'Solution', purpose: 'The product appears and solves it.' },
      { key: 'benefits', label: 'Product Benefits', purpose: '2-3 concrete benefits, visible in the footage.' },
      { key: 'cta', label: 'CTA', purpose: 'Clear call to action.' },
    ],
    categories: ['problem', 'solution', 'demonstration', 'features', 'closeup', 'cta'],
    needs: { any: ['problem', 'solution', 'demonstration'], label: 'problem, solution or demonstration scenes' },
    defaults: { duration: 30, pace: 'dynamic', tone: 'persuasive', hook_style: 'problem' },
    rules: [],
  },
  {
    id: 'demonstration', name: 'Product Demonstration', icon: '🛠️',
    description: 'Show how the product works, step by step.',
    structure: [
      { key: 'hook', label: 'Hook', purpose: 'A striking moment of the product in action.' },
      { key: 'intro', label: 'Product Introduction', purpose: 'What it is, in one line.' },
      { key: 'how', label: 'How It Works', purpose: 'The key steps or controls.' },
      { key: 'demo', label: 'Demonstration', purpose: 'The product doing its job, close and clear.' },
      { key: 'cta', label: 'CTA', purpose: 'Clear call to action.' },
    ],
    categories: ['demonstration', 'closeup', 'showcase', 'human', 'installation', 'cta'],
    needs: { any: ['demonstration', 'human', 'installation'], label: 'demonstration or hands-on scenes' },
    defaults: { duration: 30, pace: 'balanced', tone: 'educational', hook_style: 'demonstration' },
    rules: [],
  },
  {
    id: 'ugc', name: 'UGC Style', icon: '🤳',
    description: 'Natural, phone-filmed look, like a person showing the product.',
    structure: [
      { key: 'hook', label: 'Natural Hook', purpose: 'Casual, first-person opening.' },
      { key: 'presentation', label: 'Product Presentation', purpose: 'Show the product simply.' },
      { key: 'experience', label: 'Product Experience', purpose: 'Using it in daily life (no invented experiences).' },
      { key: 'benefits', label: 'Benefits', purpose: 'What it changes, only what is supported.' },
      { key: 'cta', label: 'CTA', purpose: 'Friendly call to action.' },
    ],
    categories: ['ugc', 'human', 'lifestyle', 'demonstration', 'closeup', 'cta'],
    needs: { any: ['ugc', 'human', 'lifestyle'], label: 'UGC-style, lifestyle or human interaction scenes' },
    defaults: { duration: 30, pace: 'balanced', tone: 'conversational', hook_style: 'story' },
    rules: ['UGC is a visual style only: never invent customer experiences, never present staged or synthetic footage as a real review or testimonial.'],
  },
  {
    id: 'direct_response', name: 'Direct Response', icon: '🎯',
    description: 'Short and punchy: need, benefits, offer, order now.',
    structure: [
      { key: 'hook', label: 'Strong Hook', purpose: 'Bold, direct opening.' },
      { key: 'pain', label: 'Pain Point or Need', purpose: 'The need in one line.' },
      { key: 'benefits', label: 'Benefits', purpose: 'Fast list of benefits.' },
      { key: 'offer', label: 'Offer', purpose: 'Price or real promotion (only if provided).' },
      { key: 'cta', label: 'CTA', purpose: 'Urgent, clear call to action.' },
    ],
    categories: ['hook', 'closeup', 'features', 'showcase', 'offer', 'cta'],
    needs: { any: ['closeup', 'showcase', 'features', 'hook'], label: 'product close-up or showcase scenes' },
    defaults: { duration: 20, pace: 'fast', tone: 'persuasive', hook_style: 'benefit' },
    rules: [],
  },
  {
    id: 'features_benefits', name: 'Features & Benefits', icon: '✨',
    description: 'Key features, each turned into a customer benefit.',
    structure: [
      { key: 'hook', label: 'Hook', purpose: 'The most attractive feature or benefit.' },
      { key: 'intro', label: 'Product Introduction', purpose: 'What it is.' },
      { key: 'features', label: 'Key Features', purpose: '3-4 features shown on screen.' },
      { key: 'benefits', label: 'Customer Benefits', purpose: 'What each feature gives the buyer.' },
      { key: 'cta', label: 'CTA', purpose: 'Clear call to action.' },
    ],
    categories: ['features', 'closeup', 'showcase', 'demonstration', 'cta'],
    needs: { any: ['features', 'closeup', 'showcase'], label: 'feature, close-up or showcase scenes' },
    defaults: { duration: 30, pace: 'balanced', tone: 'professional', hook_style: 'benefit' },
    rules: [],
  },
  {
    id: 'storytelling', name: 'Storytelling', icon: '📖',
    description: 'A short story: a situation, a problem, the product as the turning point.',
    structure: [
      { key: 'hook', label: 'Story Hook', purpose: 'Start in the middle of a moment.' },
      { key: 'situation', label: 'Situation', purpose: 'Who, where, what is happening.' },
      { key: 'problem', label: 'Problem', purpose: 'What goes wrong.' },
      { key: 'discovery', label: 'Product Discovery', purpose: 'The product enters the story.' },
      { key: 'solution', label: 'Solution', purpose: 'How it ends well.' },
      { key: 'cta', label: 'CTA', purpose: 'Call to action.' },
    ],
    categories: ['lifestyle', 'human', 'problem', 'solution', 'showcase', 'cta'],
    needs: { any: ['lifestyle', 'human'], label: 'lifestyle or human interaction scenes' },
    defaults: { duration: 45, pace: 'balanced', tone: 'emotional', hook_style: 'story' },
    rules: ['A story is presented as an illustration, never as a true customer story.'],
  },
  {
    id: 'unboxing', name: 'Unboxing', icon: '📦',
    description: 'From the package to the product in use.',
    structure: [
      { key: 'package', label: 'Package Introduction', purpose: 'The box or package.' },
      { key: 'reveal', label: 'Product Reveal', purpose: 'Opening and first look.' },
      { key: 'features', label: 'Features', purpose: 'What is inside, main features.' },
      { key: 'demo', label: 'Demonstration', purpose: 'First use.' },
      { key: 'cta', label: 'CTA', purpose: 'Call to action.' },
    ],
    categories: ['unboxing', 'packaging', 'closeup', 'demonstration', 'cta'],
    needs: { any: ['unboxing', 'packaging'], label: 'unboxing or packaging scenes' },
    defaults: { duration: 30, pace: 'balanced', tone: 'energetic', hook_style: 'curiosity' },
    rules: [],
  },
  {
    id: 'offer', name: 'Offer Creative', icon: '🏷️',
    description: 'Built around a real promotion.',
    structure: [
      { key: 'hook', label: 'Hook', purpose: 'The offer or the value, straight away.' },
      { key: 'value', label: 'Product Value', purpose: 'Why it is worth it.' },
      { key: 'offer', label: 'Promotional Offer', purpose: 'The exact offer given by the team.' },
      { key: 'cta', label: 'CTA', purpose: 'Order now.' },
    ],
    categories: ['offer', 'closeup', 'showcase', 'features', 'cta'],
    needs: { any: ['closeup', 'showcase', 'offer'], label: 'product close-up, showcase or offer scenes' },
    requiresOffer: true,
    defaults: { duration: 20, pace: 'fast', tone: 'energetic', hook_style: 'offer' },
    rules: ['Only the real promotional offer written in the project settings may be used.'],
  },
  {
    id: 'before_after', name: 'Before & After', icon: '🔁',
    description: 'A situation before, the product applied, the result after.',
    structure: [
      { key: 'before', label: 'Initial Situation', purpose: 'The situation before.' },
      { key: 'application', label: 'Product Application', purpose: 'The product being used.' },
      { key: 'result', label: 'Supported Result', purpose: 'Only a result the footage really shows.' },
      { key: 'cta', label: 'CTA', purpose: 'Call to action.' },
    ],
    categories: ['before_after', 'demonstration', 'solution', 'cta'],
    needs: { any: ['before_after'], label: 'before-and-after scenes' },
    defaults: { duration: 20, pace: 'dynamic', tone: 'persuasive', hook_style: 'benefit' },
    rules: ['Never invent or exaggerate a transformation: only results supported by the product information and the footage.'],
  },
];
export const AI_RECOMMENDED = 'ai_recommended';
export const typeById = id => CREATIVE_TYPES.find(t => t.id === id) || null;

export const PLATFORMS = {
  facebook: { name: 'Facebook Ads', defaults: { aspect: '4:5', duration: 30, pace: 'balanced' } },
  instagram: { name: 'Instagram Ads', defaults: { aspect: '9:16', duration: 20, pace: 'dynamic' } },
  fb_ig: { name: 'Facebook and Instagram Ads', defaults: { aspect: '4:5', duration: 20, pace: 'dynamic' } },
  tiktok: { name: 'TikTok Ads', defaults: { aspect: '9:16', duration: 20, pace: 'fast' } },
  yt_shorts: { name: 'YouTube Shorts', defaults: { aspect: '9:16', duration: 30, pace: 'dynamic' } },
  youtube: { name: 'YouTube Ads', defaults: { aspect: '16:9', duration: 30, pace: 'balanced' } },
  other: { name: 'Other', defaults: { aspect: '9:16', duration: 30, pace: 'balanced' } },
};

const num = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : def; };
export const LIMITS = {
  minDuration: num('CREATIVE_MIN_DURATION', 6),     // seconds
  maxDuration: num('CREATIVE_MAX_DURATION', 180),
  maxVariations: num('CREATIVE_MAX_VARIATIONS', 50),
};
export const DURATIONS = [15, 20, 30, 45, 60];

// Output size for each aspect ratio (long side 1920 or 1080 base).
export const ASPECTS = {
  '9:16': { name: 'Vertical 9:16', fits: 'vertical', sizes: { '1080p': [1080, 1920], '720p': [720, 1280] } },
  '1:1': { name: 'Square 1:1', fits: 'square', sizes: { '1080p': [1080, 1080], '720p': [720, 720] } },
  '4:5': { name: 'Portrait 4:5', fits: 'vertical', sizes: { '1080p': [1080, 1350], '720p': [720, 900] } },
  '16:9': { name: 'Horizontal 16:9', fits: 'horizontal', sizes: { '1080p': [1920, 1080], '720p': [1280, 720] } },
};
export const RESOLUTIONS = ['1080p', '720p'];

export const PACES = { slow: 'Slow', balanced: 'Balanced', dynamic: 'Dynamic', fast: 'Fast', [AI_RECOMMENDED]: 'AI Recommended' };
export const TONES = { persuasive: 'Persuasive', professional: 'Professional', conversational: 'Conversational', emotional: 'Emotional',
  energetic: 'Energetic', educational: 'Educational', premium: 'Premium', [AI_RECOMMENDED]: 'AI Recommended' };
export const HOOK_STYLES = { question: 'Question Hook', problem: 'Problem Hook', curiosity: 'Curiosity Hook', demonstration: 'Product Demonstration Hook',
  benefit: 'Benefit Hook', offer: 'Offer Hook', story: 'Story Hook', [AI_RECOMMENDED]: 'AI Recommended' };

// CTA suggestions: some only when the condition is confirmed in the project.
export const CTA_SUGGESTIONS = [
  { text: 'Order Now' }, { text: 'Shop Now' }, { text: 'Get Yours Today' },
  { text: 'Cash on Delivery', needs: 'cod' }, { text: 'Order Now and Pay on Delivery', needs: 'cod' },
];
// Claims that need a confirmed condition (checked in the CTA, custom hook and offer text).
export const CLAIMS = [
  { key: 'cod', label: 'cash on delivery', re: /\b(cash on delivery|pay(ment)? on delivery|COD|pay when (it|you) (arrive|receive)s?)\b/i },
  { key: 'free_delivery', label: 'free delivery', re: /\bfree (delivery|shipping)\b/i },
  { key: 'limited_stock', label: 'limited stock', re: /\b(limited (stock|quantity|quantities)|while stocks? last|only \d+ left|few left)\b/i },
  { key: 'guarantee', label: 'a guarantee', re: /\b(guarantee[ds]?|warranty|money[- ]back)\b/i },
  { key: 'promotion', label: 'a promotion', re: /(\b\d+\s?% ?off\b|\bdiscount\b|\bbuy \d+,? get\b|\bfree gift\b|\bsale\b|\bpromo(tion)?\b)/i },
];

export const PRODUCTION = {
  voiceover: { label: 'AI voice-over', default: true },
  music: { label: 'Background music', default: true },
  captions: { label: 'Automatic captions', default: true },
  text_overlays: { label: 'Text overlays', default: true },
  sound_effects: { label: 'Sound effects', default: false },
  price_display: { label: 'Show the price', default: false },
  cta_screen: { label: 'CTA end screen', default: true },
};

export const VARIATION_COUNTS = [1, 3, 5, 10];
export const VARIATION_STRATEGIES = {
  hooks: 'Different Hooks', angles: 'Different Marketing Angles', types: 'Different Creative Types', footage: 'Different Footage Selection',
  scripts: 'Different Scripts', editing: 'Different Editing Styles', full: 'Full Creative Variations',
};
export const FOOTAGE_MODES = { auto: 'Automatic Selection', favorites: 'Favorites Only', manual: 'Manual Selection' };

export const DIALECTS = {
  en: ['East African English', 'Southern African English', 'West African English', 'International English'],
  sw: ['Kenyan Swahili', 'Tanzanian Swahili', 'Ugandan Swahili'],
  fr: ['West African French', 'Central African French', 'North African French'],
};

// Everything the pages need to draw the options (one call).
export const registry = () => ({
  types: CREATIVE_TYPES.map(({ id, name, icon, description, structure, categories, needs, defaults, rules, requiresOffer }) =>
    ({ id, name, icon, description, structure, categories, needs, defaults, rules, requiresOffer: !!requiresOffer })),
  platforms: PLATFORMS, durations: DURATIONS, limits: LIMITS, aspects: ASPECTS, resolutions: RESOLUTIONS,
  paces: PACES, tones: TONES, hookStyles: HOOK_STYLES, ctas: CTA_SUGGESTIONS, production: PRODUCTION,
  variationCounts: VARIATION_COUNTS, strategies: VARIATION_STRATEGIES, footageModes: FOOTAGE_MODES, dialects: DIALECTS,
  claims: CLAIMS.map(({ key, label }) => ({ key, label })),
});
