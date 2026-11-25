// AI recommendations for a creative project: angles, creative types, duration, pace, tone, hook styles, footage categories,
// each with a short reason. The AI sees the product analysis AND the footage that really exists; types whose footage
// is missing are removed afterwards as a safety net. Same inputs → cached answer (no new AI call).
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { callJson } from './ai.js';
import { productContext } from './strategy.js';
import { CREATIVE_TYPES, typeById, PLATFORMS, PACES, TONES, HOOK_STYLES, AI_RECOMMENDED, LIMITS } from './creative-types.js';
import { CATEGORIES } from './footage-ai.js';
import { projectState, projectRow, canEdit } from './creative.js';
import { HttpError } from './errors.js';

const S = { type: 'string' };
const pickOne = values => ({ type: 'object', additionalProperties: false, required: ['value', 'reason'], properties: { value: { type: 'string', enum: values }, reason: S } });
const realPaces = Object.keys(PACES).filter(k => k !== AI_RECOMMENDED), realTones = Object.keys(TONES).filter(k => k !== AI_RECOMMENDED);
const realHooks = Object.keys(HOOK_STYLES).filter(k => k !== AI_RECOMMENDED);
export const RECO_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['angles', 'creative_types', 'duration', 'pace', 'tone', 'hook_styles', 'scene_categories', 'summary'],
  properties: {
    angles: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'integer' }, reason: S } } },
    creative_types: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: { type: 'string', enum: CREATIVE_TYPES.map(t => t.id) }, reason: S } } },
    duration: { type: 'object', additionalProperties: false, required: ['value', 'reason'], properties: { value: { type: 'integer' }, reason: S } },
    pace: pickOne(realPaces), tone: pickOne(realTones),
    hook_styles: { type: 'array', maxItems: 3, items: pickOne(realHooks) },
    scene_categories: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['value', 'reason'], properties: { value: { type: 'string', enum: Object.keys(CATEGORIES) }, reason: S } } },
    summary: S,
  },
};

const SYSTEM = `You are the creative strategist of a team making short video ads for cash-on-delivery e-commerce in African countries.
Recommend how to set up ONE creative project, using only the facts given: product information and analysis, the marketing angles (with how many relevant footage scenes each has), the footage categories really available, the target country, platform and duration.
Rules:
- Never recommend a creative type whose footage is missing (each type lists its "footage support": 0 means no matching scene). Do not recommend Before & After unless before/after footage exists and the product information supports the result. Do not recommend Offer Creative without a real offer. Do not recommend Unboxing without unboxing or packaging scenes.
- Prefer angles that have relevant footage. Use only the angle ids given.
- Duration in seconds, suited to the platform and the creative type (between ${LIMITS.minDuration} and ${LIMITS.maxDuration}).
- Each reason: one short, concrete sentence in plain English (what in the product or footage makes it fit).
- summary: 1-2 sentences for the team.`;

export function recoInput(st) {
  const s = st.settings;
  const support = Object.fromEntries(CREATIVE_TYPES.map(t => [t.id, st.typeSupport[t.id]]));
  return {
    product: productContext(st.product), analysis: st.analysis?.data || null,
    angles: st.angles.map(a => ({ id: a.id, name: a.name, message: a.message, emotion: a.emotion, selected_in_project: st.angle_ids.includes(a.id), relevant_scenes: st.angleScenes[a.id] || 0 })),
    footage: { usable_scenes: st.footage.used_ids.length, categories: st.footage.categories },
    types: CREATIVE_TYPES.map(t => ({ id: t.id, name: t.name, needs: t.needs.label, footage_support: support[t.id], requires_offer: !!t.requiresOffer })),
    target: { country: s.market.country, language: s.market.language, offer: s.market.offer || '(none)', price: s.market.price || '(not given)' },
    platform: PLATFORMS[s.platform]?.name || s.platform, duration_wanted: s.duration,
  };
}
export const recoKey = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// Remove anything the footage or the facts do not support (safety net after the AI).
export function cleanReco(r, st) {
  const angleIds = new Set(st.angles.map(a => a.id));
  return {
    ...r,
    angles: r.angles.filter(a => angleIds.has(a.id)),
    creative_types: r.creative_types.filter(t => {
      const def = typeById(t.id);
      return def && st.typeSupport[t.id] > 0 && !(def.requiresOffer && !st.settings.market.offer);
    }),
    duration: { ...r.duration, value: Math.min(LIMITS.maxDuration, Math.max(LIMITS.minDuration, Math.round(r.duration.value))) },
    scene_categories: r.scene_categories.filter(c => (st.footage.categories[c.value] || 0) > 0),
    made_at: new Date().toISOString(),
  };
}

export async function recommend(projectId, user, { force = false } = {}) {
  const pr = projectRow(projectId);
  if (!canEdit(pr, user)) throw new HttpError(403, 'Only the author of this project or an admin can change it');
  const st = projectState(projectId);
  if (!st.angles.length) throw new HttpError(400, 'This product has no marketing angles yet: analyse it in Marketing angles (Module 1) first.');
  const input = recoInput(st);
  const key = recoKey(input);
  if (!force && pr.reco_key === key && st.recommendations) return { ...st.recommendations, cached: true };
  const hit = !force && db.prepare(`SELECT json FROM ai_cache WHERE key = ?`).get('reco:' + key);
  let r;
  if (hit) r = JSON.parse(hit.json);
  else {
    r = await callJson({
      kind: 'creative-reco', system: SYSTEM, productId: st.product.id, userId: user.id, effort: 'low', maxTokens: 8000, ref: `project:${projectId}`,
      content: `Recommend the set-up of this creative project.\n\n${JSON.stringify(input, null, 1)}`, schema: RECO_SCHEMA,
      mock: () => mockReco(st),
    });
    db.prepare(`INSERT OR REPLACE INTO ai_cache (key, kind, json) VALUES (?, 'creative-reco', ?)`).run('reco:' + key, JSON.stringify(r));
  }
  const clean = cleanReco(r, st);
  db.prepare(`UPDATE creative_projects SET recommendations = ?, reco_key = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(clean), key, projectId);
  return { ...clean, cached: !!hit };
}

// Test mode (ACC_AI_MOCK=1): recommendations built from the real footage counts.
function mockReco(st) {
  const types = CREATIVE_TYPES.filter(t => st.typeSupport[t.id] > 0).sort((a, b) => st.typeSupport[b.id] - st.typeSupport[a.id]).slice(0, 2);
  const angles = [...st.angles].sort((a, b) => (st.angleScenes[b.id] || 0) - (st.angleScenes[a.id] || 0)).slice(0, 2);
  const cats = Object.entries(st.footage.categories).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    angles: angles.map(a => ({ id: a.id, reason: `${st.angleScenes[a.id] || 0} scenes support "${a.name}".` })),
    creative_types: types.map(t => ({ id: t.id, reason: `${st.typeSupport[t.id]} scenes match its ${t.needs.label}.` })),
    duration: { value: 20, reason: 'Short videos work best on feeds for impulse purchases.' },
    pace: { value: 'dynamic', reason: 'Several short scenes are available.' },
    tone: { value: 'persuasive', reason: 'Cash-on-delivery buyers need a clear reason to order.' },
    hook_styles: [{ value: 'question', reason: 'Starts a conversation with the viewer.' }, { value: 'benefit', reason: 'The main benefit is visible in the footage.' }],
    scene_categories: cats.map(([c, n]) => ({ value: c, reason: `${n} scenes of this kind.` })),
    summary: 'Test mode: recommendations made from the real footage counts, without calling the AI.',
  };
}
