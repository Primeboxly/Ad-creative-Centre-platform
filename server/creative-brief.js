// The Creative Brief: a versioned, frozen snapshot of a creative project. Modules 4-9 read only this
// (getBrief + revalidateBrief), never the project's live settings. Media are referenced (scene ids, storage keys), never copied.
import { db } from './db.js';
import { HttpError } from './errors.js';
import { validate as checkSchema } from './schema.js';
import { LANGUAGES } from './ai.js';
import { MARKETS } from './markets.js';
import { typeById, ASPECTS, PLATFORMS, AI_RECOMMENDED, FOOTAGE_MODES, VARIATION_STRATEGIES } from './creative-types.js';
import { projectState, validateProject, variationPlan, resolvedTypes, resolvedSetting, resolvedHooks, eligibleScenes, projectRow, canEdit } from './creative.js';

export const BRIEF_SCHEMA_VERSION = '1.0';
const S = { type: 'string' }, N = { type: 'number' }, I = { type: 'integer' }, B = { type: 'boolean' };
const nullable = t => ({ type: [t, 'null'] });
const arr = items => ({ type: 'array', items });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });

export const BRIEF_SCHEMA = obj({
  schema_version: S, brief_version: I, project_id: I, project_name: S, product_id: I, created_at: S, updated_at: S, created_by: S,
  product: obj({
    name: S, description: S, image: S, country: S, language: S, price: S, offer: S, links: obj({ product_page: S, source: S }),
    markets: arr(obj({ code: S, price: S })),
    analysis: { type: ['object', 'null'] }, analysis_id: nullable('integer'),
  }),
  marketing_angles: arr(obj({ id: I, name: S, description: S, audience: S, pain_point: S, message: S, emotion: S, hooks: arr(S), creative_types: arr(S), why: S, relevant_scenes: I })),
  creative_types: arr(obj({ id: S, name: S, description: S, structure: arr(obj({ key: S, label: S, purpose: S })), recommended_scene_categories: arr(S), rules: arr(S), source: S })),
  footage: obj({
    mode: S, mode_label: S, audio: S,
    scene_ids: arr(I), excluded_scene_ids: arr(I),
    scenes: arr(obj({ id: I, asset_id: I, start: N, end: N, duration: N, silent_key: S, quality: nullable('integer'), favorite: B, orientation: S, categories: arr(S), angles: arr(obj({ angle_id: I, score: I })) })),
    category_counts: { type: 'object' },
  }),
  target: obj({ country: S, country_name: S, language: S, language_name: S, dialect: S, currency: S, price: S, offer: S,
    confirmed: obj({ cash_on_delivery: B, free_delivery: B, limited_stock: B, guarantee: B }) }),
  platform: obj({ id: S, name: S }),
  format: obj({ duration_seconds: I, aspect_ratio: S, resolution: S, width: I, height: I }),
  style: obj({
    tone: obj({ preference: S, value: nullable('string'), source: S }),
    editing_pace: obj({ preference: S, value: nullable('string'), source: S }),
    hook_styles: obj({ preference: arr(S), values: arr(S) }),
    custom_hook: S, cta: S,
  }),
  production: obj({ voiceover: B, music: B, captions: B, text_overlays: B, sound_effects: B, price_display: B, cta_screen: B, original_audio: S }),
  variations: obj({ count: I, strategies: arr(S), strategy_labels: arr(S), distribution: arr(obj({ key: S, angle_ids: arr(I), types: arr(S), count: I })), custom_distribution: B, videos: { type: 'array' }, explanation: S }),
  ai_recommendations: { type: ['object', 'null'] },
  validation: obj({ valid: B, errors: arr({ type: 'object' }), warnings: arr({ type: 'object' }), checked_at: S }),
});

// Build the brief from the project as it is now.
export function buildBrief(st, { version = 0, author = '' } = {}) {
  const s = st.settings, m = s.market, p = st.product;
  const val = validateProject(st);
  const plan = variationPlan(st);
  const used = st.footage.scenes.filter(x => st.footage.used_ids.includes(x.id));
  const keys = Object.fromEntries(db.prepare(`SELECT id, proxy_key FROM footage_assets WHERE product_id = ?`).all(p.id).map(r => [r.id, r.proxy_key]));
  const size = ASPECTS[s.aspect]?.sizes[s.resolution] || [0, 0];
  const now = new Date().toISOString();
  const tone = resolvedSetting(st, 'tone'), pace = resolvedSetting(st, 'pace');
  return {
    schema_version: BRIEF_SCHEMA_VERSION, brief_version: version, project_id: st.project.id, project_name: st.project.name, product_id: p.id,
    created_at: now, updated_at: now, created_by: author,
    product: {
      name: p.name, description: p.description || '', image: p.image || '', country: p.country || '', language: p.language || 'en',
      price: p.price || '', offer: p.offer || '', links: { product_page: p.link_product || '', source: p.link_alibaba || '' },
      markets: (JSON.parse(p.markets || '[]')).map(x => ({ code: String(x.code), price: String(x.price || '') })),
      analysis: st.analysis?.data || null, analysis_id: st.analysis?.id ?? null,
    },
    marketing_angles: st.angle_ids.map(id => st.angles.find(a => a.id === id)).filter(Boolean).map(a => ({
      id: a.id, name: a.name, description: a.description, audience: a.audience, pain_point: a.pain_point, message: a.message, emotion: a.emotion,
      hooks: a.hooks, creative_types: a.creative_types, why: a.why, relevant_scenes: st.angleScenes[a.id] || 0,
    })),
    creative_types: resolvedTypes(st).map(typeById).filter(Boolean).map(t => ({
      id: t.id, name: t.name, description: t.description, structure: t.structure, recommended_scene_categories: t.categories, rules: t.rules,
      source: s.types.includes(t.id) ? 'user' : 'ai',
    })),
    footage: {
      mode: s.footage_mode, mode_label: FOOTAGE_MODES[s.footage_mode],
      audio: 'none: only silent copies (all original audio removed and checked with ffprobe)',
      scene_ids: used.map(x => x.id), excluded_scene_ids: st.footage.exclude,
      scenes: used.map(x => ({ id: x.id, asset_id: x.asset_id, start: x.start, end: x.end, duration: x.duration, silent_key: keys[x.asset_id] || '',
        quality: x.quality ?? null, favorite: !!x.favorite, orientation: x.orientation || '', categories: x.categories, angles: x.angles.map(a => ({ angle_id: a.angle_id, score: a.score })) })),
      category_counts: st.footage.categories,
    },
    target: {
      country: m.country, country_name: MARKETS[m.country]?.name || '', language: m.language, language_name: LANGUAGES[m.language] || '', dialect: m.dialect,
      currency: m.currency, price: m.price, offer: m.offer,
      confirmed: { cash_on_delivery: !!m.cod, free_delivery: !!m.free_delivery, limited_stock: !!m.limited_stock, guarantee: !!m.guarantee },
    },
    platform: { id: s.platform, name: PLATFORMS[s.platform]?.name || s.platform },
    format: { duration_seconds: s.duration, aspect_ratio: s.aspect, resolution: s.resolution, width: size[0], height: size[1] },
    style: {
      tone: { preference: s.tone, value: tone.value, source: tone.source },
      editing_pace: { preference: s.pace, value: pace.value, source: pace.source },
      hook_styles: { preference: s.hook_styles, values: resolvedHooks(st) },
      custom_hook: s.custom_hook, cta: s.cta,
    },
    production: { ...s.production, original_audio: 'excluded' },
    variations: { count: plan.count, strategies: plan.strategies, strategy_labels: plan.strategies.map(k => VARIATION_STRATEGIES[k]),
      distribution: plan.combos, custom_distribution: plan.custom, videos: plan.videos, explanation: plan.explanation },
    ai_recommendations: st.recommendations || null,
    validation: { ...val, checked_at: now },
  };
}

// Save a new brief version (only when there is no blocking error). The project becomes "ready".
export function saveBrief(projectId, user) {
  const pr = projectRow(projectId);
  if (!canEdit(pr, user)) throw new HttpError(403, 'Only the author of this project or an admin can save its brief');
  const st = projectState(projectId);
  const version = (db.prepare(`SELECT MAX(version) v FROM creative_briefs WHERE project_id = ?`).get(projectId).v || 0) + 1;
  const brief = buildBrief(st, { version, author: user.name });
  if (!brief.validation.valid) throw Object.assign(new HttpError(422, 'Fix the blocking problems before saving the Creative Brief'), { details: brief.validation });
  const errs = checkSchema(BRIEF_SCHEMA, brief);
  if (errs.length) throw new HttpError(500, 'The brief does not match its schema: ' + errs.slice(0, 3).join('; '));
  const id = db.prepare(`INSERT INTO creative_briefs (project_id, version, schema_version, brief, created_by) VALUES (?,?,?,?,?)`)
    .run(projectId, version, BRIEF_SCHEMA_VERSION, JSON.stringify(brief), user.id).lastInsertRowid;
  db.prepare(`UPDATE creative_projects SET status = 'ready', updated_at = datetime('now') WHERE id = ?`).run(projectId);
  return { id, version, brief };
}

// For the next modules: the saved brief (latest, or a given version).
export function getBrief(projectId, version = null) {
  const r = version
    ? db.prepare(`SELECT * FROM creative_briefs WHERE project_id = ? AND version = ?`).get(projectId, version)
    : db.prepare(`SELECT * FROM creative_briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1`).get(projectId);
  if (!r) throw new HttpError(404, 'No Creative Brief saved for this project yet');
  return { id: r.id, version: r.version, schema_version: r.schema_version, created_at: r.created_at, brief: JSON.parse(r.brief) };
}

// Before any generation: is everything the brief points to still there and usable?
export function revalidateBrief(brief) {
  const problems = [], warnings = [];
  const p = db.prepare(`SELECT id FROM products WHERE id = ?`).get(brief.product_id);
  if (!p) problems.push('The product was deleted.');
  const angleIds = brief.marketing_angles.map(a => a.id);
  const angles = new Set(angleIds.length ? db.prepare(`SELECT id FROM angles WHERE id IN (${angleIds.map(() => '?').join(',')})`).all(...angleIds).map(r => r.id) : []);
  const goneAngles = angleIds.filter(id => !angles.has(id));
  if (goneAngles.length) warnings.push(`${goneAngles.length} marketing angle(s) were deleted since the brief (the brief keeps their snapshot).`);
  const ok = new Set(p ? eligibleScenes(brief.product_id).map(s => s.id) : []);
  const missing = brief.footage.scene_ids.filter(id => !ok.has(id));
  if (missing.length) warnings.push(`${missing.length} scene(s) are no longer usable (deleted, excluded or not analysed).`);
  const usable = brief.footage.scene_ids.length - missing.length;
  if (!usable) problems.push('None of the brief\'s scenes is usable any more.');
  for (const t of brief.creative_types) if (!typeById(t.id)) warnings.push(`Creative type "${t.id}" is no longer in the registry (its snapshot is kept).`);
  return { ok: !problems.length, problems, warnings, usable_scene_ids: brief.footage.scene_ids.filter(id => ok.has(id)), missing_scene_ids: missing };
}

export { AI_RECOMMENDED };
