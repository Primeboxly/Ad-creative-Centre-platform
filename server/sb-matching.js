// Scene matching for script segments: ranks the brief's eligible scenes for one segment using the Module 2 metadata
// (AI description, action line, categories, tags, features and benefits shown, product visibility, angle scores,
// quality, flags, duration, orientation). Meaning comes first: a beautiful scene that does not show what is said ranks low.
// No video is analysed again here; only this metadata is used. Reusable by Module 6.
import { db } from './db.js';
import { sceneRows } from './footage-services.js';
import { eligibleScenes } from './creative.js';
import { ASPECTS } from './creative-types.js';

// Scene categories that usually fit each narrative role (used when the segment gives none, and as a bonus).
export const ROLE_CATEGORIES = {
  hook: ['hook', 'closeup', 'showcase', 'demonstration'], problem: ['problem', 'lifestyle', 'human'], intro: ['showcase', 'closeup', 'unboxing', 'packaging'],
  solution: ['solution', 'demonstration', 'human'], demonstration: ['demonstration', 'human', 'installation', 'closeup'],
  feature: ['features', 'closeup', 'demonstration'], benefit: ['features', 'solution', 'lifestyle', 'human'], objection: ['features', 'demonstration', 'closeup'],
  offer: ['offer', 'showcase', 'closeup', 'packaging'], cta: ['cta', 'showcase', 'closeup', 'offer'], supporting: ['broll', 'lifestyle', 'showcase'],
};
// Target length of one shot for each editing pace (seconds).
export const SHOT_LENGTH = { slow: 4, balanced: 3, dynamic: 2.2, fast: 1.6 };

const STOP = new Set('the a an and or of to in on with for is are it this that your you my our at by from as be will can just so very get got its le la les un une des et ou de du en pour avec est sur ni na ya wa kwa ni za la cha vya hii huu'.split(' '));
export const tokens = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
  .filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, ''));

// The scenes a plan may use: the brief's scene ids that are still production-ready (silent, analysed, not excluded).
export function usableScenes(brief) {
  const ok = new Set(eligibleScenes(brief.product_id).map(s => s.id));
  const ids = brief.footage.scene_ids.filter(id => ok.has(id));
  return ids.length ? sceneRows(`s.id IN (${ids.map(() => '?').join(',')})`, ids) : [];
}

// How often each scene is used by the other planned videos of the project (to vary footage between variations).
export function usageElsewhere(projectId, planId) {
  const rows = db.prepare(`SELECT vs.scene_id, COUNT(*) n FROM sb_version_scenes vs JOIN sb_versions v ON v.id = vs.version_id JOIN sb_plans p ON p.id = v.plan_id
    WHERE p.project_id = ? AND p.id <> ? AND v.id = (SELECT MAX(id) FROM sb_versions WHERE plan_id = p.id) GROUP BY vs.scene_id`).all(projectId, planId);
  return new Map(rows.map(r => [r.scene_id, r.n]));
}

function sceneText(s) {
  const d = s.details || {};
  return [s.semantic, s.semantic, s.description, ...(d.features_shown || []), ...(d.benefits_supported || []), ...(d.objects || []),
    d.human_interaction, d.environment, ...s.tags.map(t => t.tag), ...s.categories.map(c => c.label)].join(' ');
}

// Score one scene for one segment (0-100) with the parts that make it, for transparency.
export function scoreScene(scene, seg, ctx) {
  const want = new Set(tokens([seg.text, seg.visual_intent, ...(seg.features || []), ...(seg.benefits || [])].join(' ')));
  const have = new Set(tokens(sceneText(scene)));
  let hits = 0;
  for (const w of want) if (have.has(w)) hits++;
  const text = want.size ? Math.min(1, hits / Math.max(3, want.size * 0.5)) : 0;
  const cats = scene.categories.map(c => c.key);
  const wanted = (seg.scene_categories || []).length ? seg.scene_categories : ROLE_CATEGORIES[seg.role] || [];
  const catHit = wanted.filter(c => cats.includes(c)).length;
  const category = wanted.length ? Math.min(1, catHit / Math.min(2, wanted.length)) : 0;
  const roleBonus = (ROLE_CATEGORIES[seg.role] || []).some(c => cats.includes(c)) ? 0.15 : 0;
  const semantic = Math.min(1, 0.55 * category + 0.45 * text + roleBonus);
  const angle = Math.max(0, ...scene.angles.filter(a => (ctx.angleIds || []).includes(a.angle_id)).map(a => a.score / 100));
  const quality = (scene.quality ?? 50) / 100;
  const visible = scene.details?.product_visible === false ? -0.1 : 0.03;
  const fits = ASPECTS[ctx.aspect]?.fits;
  const orientation = !fits || !scene.orientation || scene.orientation === fits ? 1 : fits === 'square' ? 0.7 : 0.4;
  const durationFit = Math.min(1, scene.duration / (ctx.shotLength || 2.5));
  let penalty = 0;
  const flags = scene.flags || [];
  if (flags.includes('watermark')) penalty += 0.12;
  if (flags.includes('text_overlay')) penalty += 0.04;
  if (flags.includes('irrelevant')) penalty += 0.3;
  if (flags.includes('low_quality')) penalty += 0.08;
  if (ctx.used?.has(scene.id)) penalty += 0.35;
  const look = scene.duplicate_of || scene.similar_to || scene.id;
  if (ctx.usedLooks?.has(look) && !ctx.used?.has(scene.id)) penalty += 0.15;
  penalty += Math.min(0.15, 0.05 * (ctx.elsewhere?.get(scene.id) || 0));
  const total = 0.6 * semantic + 0.12 * angle + 0.13 * quality + 0.07 * durationFit + 0.08 * orientation + visible - penalty;
  return { score: Math.max(0, Math.min(100, Math.round(total * 100))), semantic: Math.round(semantic * 100), text: Math.round(text * 100), category: Math.round(category * 100), angle: Math.round(angle * 100) };
}

// Ranked candidates for a segment. weak = nothing really shows what the segment says.
export function rankScenes(scenes, seg, ctx, limit = 6) {
  const ranked = scenes.map(s => ({ scene: s, ...scoreScene(s, seg, ctx) })).sort((a, b) => b.score - a.score || b.semantic - a.semantic);
  return { candidates: ranked.slice(0, limit), weak: !ranked.length || ranked[0].semantic < 25 };
}
