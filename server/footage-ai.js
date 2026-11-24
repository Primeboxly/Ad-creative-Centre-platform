// AI scene analysis: the AI looks at a few frames of each scene and says what is in it, how good it is for ads,
// which categories and ad placements fit, and which marketing angles it supports. Structured JSON, checked.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { callJson, aiMock } from './ai.js';
import { productContext } from './strategy.js';

export const PROMPT_VERSION = 'scene-v1';

export const CATEGORIES = {
  hook: 'Hook Footage', closeup: 'Product Close-up', showcase: 'Product Showcase', demonstration: 'Product Demonstration',
  problem: 'Problem Visualization', solution: 'Solution Visualization', features: 'Features and Benefits', before_after: 'Before and After',
  unboxing: 'Unboxing', installation: 'Installation', lifestyle: 'Lifestyle', human: 'Human Interaction', ugc: 'UGC-style Footage',
  packaging: 'Packaging', offer: 'Offer Footage', cta: 'CTA Footage', broll: 'B-roll', other: 'Other',
};
export const PLACEMENTS = {
  opening_hook: 'Opening Hook', problem: 'Problem', solution: 'Solution', intro: 'Product Introduction', demonstration: 'Product Demonstration',
  benefit: 'Benefit Explanation', offer: 'Offer', cta: 'Call to Action', broll: 'Supporting B-roll',
};
const CAMERA = ['static', 'handheld', 'shaky', 'pan', 'tilt', 'zoom', 'tracking', 'mixed'];
const ORIGIN = ['real_customer_style', 'staged_or_promotional', 'synthetic_or_cgi', 'unclear'];

const str = { type: 'string' };
const strList = max => ({ type: 'array', items: str, maxItems: max });
const score = { type: 'integer', minimum: 0, maximum: 100 };
const ANGLE_LINKS = {
  type: 'array', maxItems: 6,
  items: { type: 'object', additionalProperties: false, required: ['angle_id', 'score', 'reason'], properties: { angle_id: { type: 'integer' }, score, reason: str } },
};
const SCENE = {
  type: 'object', additionalProperties: false,
  required: ['ref', 'description', 'semantic', 'objects', 'product_visible', 'features_shown', 'benefits_supported', 'human_interaction', 'environment',
    'camera_movement', 'composition', 'text_overlays', 'watermark', 'origin', 'relevance', 'relevance_note', 'quality', 'categories', 'tags', 'placements', 'angles'],
  properties: {
    ref: str,
    description: { type: 'string', description: 'What happens in the scene, 1-2 plain sentences.' },
    semantic: { type: 'string', description: 'One short line made to be matched with a voice-over sentence, e.g. "hand presses the button and the blender crushes ice".' },
    objects: strList(10),
    product_visible: { type: 'boolean' },
    features_shown: strList(6),
    benefits_supported: strList(6),
    human_interaction: { type: 'string', description: 'What a person does with the product ("" if nobody).' },
    environment: str,
    camera_movement: { type: 'string', enum: CAMERA },
    composition: str,
    text_overlays: strList(6),
    watermark: { type: 'object', additionalProperties: false, required: ['present', 'text'], properties: { present: { type: 'boolean' }, text: str } },
    origin: { type: 'string', enum: ORIGIN },
    relevance: score,
    relevance_note: str,
    quality: {
      type: 'object', additionalProperties: false,
      required: ['sharpness', 'lighting', 'stability', 'product_visibility', 'composition', 'score', 'note'],
      properties: { sharpness: score, lighting: score, stability: score, product_visibility: score, composition: score, score, note: str },
    },
    categories: { type: 'array', items: { type: 'string', enum: Object.keys(CATEGORIES) }, minItems: 1, maxItems: 4 },
    tags: strList(6),
    placements: {
      type: 'array', maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['placement', 'fit'], properties: { placement: { type: 'string', enum: Object.keys(PLACEMENTS) }, fit: score } },
    },
    angles: ANGLE_LINKS,
  },
};
export const SCENES_SCHEMA = { type: 'object', additionalProperties: false, required: ['scenes'], properties: { scenes: { type: 'array', items: SCENE } } };
export const MATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scenes'],
  properties: { scenes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'angles'], properties: { ref: str, angles: ANGLE_LINKS } } } },
};

const SYSTEM = `You analyse short video footage for a team that makes vertical video ads (TikTok, Reels) for cash-on-delivery e-commerce in African countries.
For each scene you get a few frames in time order (start → end) and measured numbers. Describe and judge the scene for ad editing.

Rules:
- Describe only what is visible in the frames. Do not invent product features: list a feature only if it is visibly demonstrated, or clearly shown AND consistent with the product information.
- Benefits must be visually supported by the scene (e.g. "fits in a small bag" only if you see it fit).
- People: describe actions, hands, gestures and setting only. Never identify anyone, and never guess age, ethnicity, religion, health, body traits or any other sensitive attribute.
- origin: say if the footage looks like a real customer's video, staged/promotional footage, or synthetic/CGI. Staged or synthetic footage must never be presented as a real customer testimonial; "ugc" as a category only means the visual style.
- text_overlays: copy visible on-screen text (captions, prices, brand text) briefly. watermark: platform or creator logos/handles (TikTok logo, @names), supplier marks.
- relevance (0-100): how much the scene is about THIS product. Footage of another product, or with nothing of the product, scores low.
- quality (0-100 each): sharpness, lighting, stability (camera shake), product_visibility, composition; score = overall usability in a paid ad. Use the measured numbers as hints; the note is one short sentence.
- categories: 1-4 that clearly fit. placements: where in an ad the scene could be used, with a fit 0-100; 1-5 entries.
- angles: only angle ids from the list given; include an angle only if the scene visibly supports it (score ≥ 40), with a short reason. An empty list is fine.
- semantic: one short concrete line about the action, for matching to a voice-over sentence.
- Write in plain English.`;

const anglesText = angles => (angles.length
  ? 'Marketing angles (use these ids):\n' + angles.map(a => `- id ${a.id}: ${a.name}: ${a.message || a.description}`).join('\n')
  : 'Marketing angles: none yet (return an empty angles list).');

export const anglesHash = angles => createHash('sha1').update(JSON.stringify(angles.map(a => [a.id, a.name, a.message, a.description]))).digest('hex').slice(0, 16);
export const productHash = p => createHash('sha1').update(productContext(p)).digest('hex').slice(0, 16);

// One AI call for several scenes. items: [{ ref, start, end, frames: [{ t, file }], measured }]
export async function analyzeScenes({ product, angles, items, asset, userId, model, effort }) {
  const content = [{ type: 'text', text: `${productContext(product)}\n\n${anglesText(angles)}\n\nVideo: "${asset.name}", ${asset.width}×${asset.height}, ${asset.duration.toFixed(1)} s. Scenes follow.` }];
  for (const it of items) {
    content.push({ type: 'text', text: `Scene ${it.ref}: ${it.start.toFixed(2)}s → ${it.end.toFixed(2)}s (${(it.end - it.start).toFixed(1)} s). Measured: sharpness ${it.measured.sharpness}/100, exposure ${it.measured.exposure}/100, contrast ${it.measured.contrast}/100, movement ${it.measured.motion}/100. Frames at ${it.frames.map(f => f.t.toFixed(1) + 's').join(', ')}:` });
    for (const f of it.frames) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(f.file).toString('base64') } });
  }
  content.push({ type: 'text', text: `Return one entry per scene, with ref exactly as given (${items.map(i => i.ref).join(', ')}).` });
  const data = await callJson({
    kind: 'scenes', system: SYSTEM, content, schema: SCENES_SCHEMA, productId: product.id, userId, effort, model,
    maxTokens: 64000, ref: `asset:${asset.id}`, mock: () => mockScenes(items, angles),
  });
  return data.scenes;
}

// Angles only, from the scene descriptions (no pictures: cheap). scenes: [{ ref, text }]
export async function matchScenes({ product, angles, scenes, userId, model, effort }) {
  const content = [{ type: 'text', text: `${productContext(product)}\n\n${anglesText(angles)}\n\nFor each scene below (already analysed from its frames), say which angles it visually supports.\n\n`
    + scenes.map(s => `Scene ${s.ref}: ${s.text}`).join('\n') }];
  const data = await callJson({
    kind: 'scene-match', system: SYSTEM, content, schema: MATCH_SCHEMA, productId: product.id, userId, effort, model, maxTokens: 32000,
    ref: `product:${product.id}`, mock: () => ({ scenes: scenes.map((s, i) => ({ ref: s.ref, angles: mockAngles(angles, i) })) }),
  });
  return data.scenes;
}

// ---------- Test mode (ACC_AI_MOCK=1): believable answers without calling the AI ----------
const mockAngles = (angles, i) => angles.slice(0, 3).filter((_, k) => (i + k) % 2 === 0).map((a, k) => ({ angle_id: a.id, score: 85 - k * 15 - (i % 3) * 5, reason: `Shows the product in a way that fits "${a.name}"` }));
function mockScenes(items, angles) {
  const cats = Object.keys(CATEGORIES), pl = Object.keys(PLACEMENTS);
  return {
    scenes: items.map((it, i) => ({
      ref: it.ref,
      description: `Test scene ${it.ref}: a hand shows the product on a table, then turns it to the camera.`,
      semantic: i % 2 ? 'hand turns the product to show the side' : 'close view of the product on a table',
      objects: ['product', 'table', 'hand'], product_visible: true,
      features_shown: i % 2 ? ['side buttons'] : [], benefits_supported: i % 3 === 0 ? ['easy to hold'] : [],
      human_interaction: i % 2 ? 'a hand turns the product' : '', environment: 'indoor, home table',
      camera_movement: CAMERA[i % CAMERA.length], composition: 'product centred, close framing',
      text_overlays: i % 4 === 3 ? ['50% OFF'] : [], watermark: { present: i % 5 === 4, text: i % 5 === 4 ? '@seller' : '' },
      origin: i % 3 === 2 ? 'staged_or_promotional' : 'real_customer_style',
      relevance: 90 - (i % 4) * 15, relevance_note: 'The product is clearly in view.',
      quality: { sharpness: 80 - i * 3, lighting: 75, stability: 70, product_visibility: 85, composition: 72, score: Math.max(20, 82 - i * 6), note: 'Clear close view, a bit dark at the end.' },
      categories: [cats[i % 4 === 0 ? 0 : 1 + (i % 6)], ...(i % 2 ? ['human'] : [])],
      tags: ['table', i % 2 ? 'hands' : 'close-up'],
      placements: [{ placement: pl[i % pl.length], fit: 80 }, { placement: 'broll', fit: 55 }],
      angles: mockAngles(angles, i),
    })),
  };
}
export const mockMode = aiMock;
