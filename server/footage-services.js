// Footage services for the next modules (AI Creative Director, automatic editing).
// They only read: find scenes for an angle or a script sentence, pick scenes by quality and length,
// give exact timestamps, avoid repeating look-alike footage, and lay out a timeline (no rendering here).
import { db } from './db.js';
import { CATEGORIES, PLACEMENTS } from './footage-ai.js';

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

// A scene with everything known about it (AI analysis, categories, tags, angle links, video info).
export function sceneRows(where = '1', params = []) {
  const rows = db.prepare(`SELECT s.*, a.name AS asset_name, a.width, a.height, a.fps, a.aspect, a.orientation, a.storage_key, a.proxy_key, a.duration AS asset_duration,
      sa.description, sa.semantic, sa.data, sa.relevance, sa.ai_quality, sa.quality, sa.quality_note, sa.flags, sa.placements, sa.angles_hash, sa.edited, sa.model
    FROM footage_scenes s JOIN footage_assets a ON a.id = s.asset_id LEFT JOIN scene_analyses sa ON sa.scene_id = s.id
    WHERE ${where} ORDER BY a.id, s.start`).all(...params);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const marks = ids.map(() => '?').join(',');
  const tags = db.prepare(`SELECT scene_id, kind, tag, source FROM scene_tags WHERE scene_id IN (${marks})`).all(...ids);
  const links = db.prepare(`SELECT sa.scene_id, sa.angle_id, sa.score, sa.reason, sa.source, an.name FROM scene_angles sa JOIN angles an ON an.id = sa.angle_id WHERE sa.scene_id IN (${marks}) ORDER BY sa.score DESC`).all(...ids);
  return rows.map(r => ({
    id: r.id, asset_id: r.asset_id, product_id: r.product_id, asset_name: r.asset_name,
    start: r.start, end: r.end, duration: r.duration, source: r.source, has_thumb: !!r.thumb_key,
    excluded: !!r.excluded, favorite: !!r.favorite, duplicate_of: r.duplicate_of, similar_to: r.similar_to, status: r.status, error: r.error,
    width: r.width, height: r.height, fps: r.fps, aspect: r.aspect, orientation: r.orientation,
    measured: { sharpness: r.sharpness, brightness: r.brightness, contrast: r.contrast, motion: r.motion, score: r.tech_score },
    description: r.description || '', semantic: r.semantic || '', details: parse(r.data, {}),
    relevance: r.relevance ?? null, ai_quality: r.ai_quality ?? null, quality: r.quality ?? (r.status === 'analyzed' ? 0 : null), quality_note: r.quality_note || '',
    flags: parse(r.flags, []), placements: parse(r.placements, []), edited: !!r.edited, model: r.model || '',
    categories: tags.filter(t => t.scene_id === r.id && t.kind === 'category').map(t => ({ key: t.tag, label: CATEGORIES[t.tag] || t.tag, source: t.source })),
    tags: tags.filter(t => t.scene_id === r.id && t.kind === 'tag').map(t => ({ tag: t.tag, source: t.source })),
    angles: links.filter(l => l.scene_id === r.id).map(l => ({ angle_id: l.angle_id, name: l.name, score: l.score, reason: l.reason, source: l.source })),
  }));
}

export const productScenes = productId => sceneRows('s.product_id = ?', [productId]);

// Exact source of a scene for editing: the silent copy (no audio stream, checked by ffprobe) and the seconds to use.
export function sceneSource(sceneId) {
  const r = db.prepare(`SELECT s.id, s.asset_id, s.start, s.end, s.duration, a.proxy_key AS silent_key, a.silent, a.width, a.height, a.fps, a.duration AS video_duration
    FROM footage_scenes s JOIN footage_assets a ON a.id = s.asset_id WHERE s.id = ?`).get(sceneId);
  return r ? { ...r, silent: !!r.silent } : null;
}

// Usable scenes with filters: { placement, categories, angleId, minQuality, minDuration, maxDuration, includeExcluded, favoritesOnly }
export function selectScenes(productId, f = {}) {
  let list = productScenes(productId).filter(s => s.status === 'analyzed');
  if (!f.includeExcluded) list = list.filter(s => !s.excluded);
  if (f.favoritesOnly) list = list.filter(s => s.favorite);
  if (f.minQuality) list = list.filter(s => (s.quality ?? 0) >= f.minQuality);
  if (f.minDuration) list = list.filter(s => s.duration >= f.minDuration);
  if (f.maxDuration) list = list.filter(s => s.duration <= f.maxDuration);
  if (f.categories?.length) list = list.filter(s => s.categories.some(c => f.categories.includes(c.key)));
  if (f.placement) list = list.filter(s => s.placements.some(p => p.placement === f.placement));
  if (f.angleId) list = list.filter(s => s.angles.some(a => a.angle_id === Number(f.angleId)));
  return list;
}

// Scenes that support a marketing angle, best first (angle score, then quality).
export function scenesForAngle(angleId, { minScore = 40, minQuality = 0, limit = 30, includeExcluded = false } = {}) {
  const a = db.prepare(`SELECT product_id FROM angles WHERE id = ?`).get(angleId);
  if (!a) return [];
  return selectScenes(a.product_id, { angleId, minQuality, includeExcluded })
    .map(s => ({ ...s, angle_score: s.angles.find(x => x.angle_id === Number(angleId))?.score ?? 0 }))
    .filter(s => s.angle_score >= minScore)
    .sort((x, y) => y.angle_score - x.angle_score || (y.quality ?? 0) - (x.quality ?? 0) || y.favorite - x.favorite)
    .slice(0, limit);
}

// How well a scene fits a script sentence (0-100), from shared words in its description, action, tags and details.
// Simple and free; a later module may replace it with an AI or embedding match.
const STOP = new Set('the a an and or of to in on with for is are it this that your you my our at by from as be will can just so very get got its'.split(' '));
const words = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, ''));
export function sentenceFit(scene, sentence) {
  const want = new Set(words(sentence));
  if (!want.size) return 0;
  const have = new Set(words([scene.semantic, scene.description, ...scene.tags.map(t => t.tag), ...(scene.details.features_shown || []),
    ...(scene.details.benefits_supported || []), ...(scene.details.objects || []), scene.details.human_interaction].join(' ')));
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return Math.round((hit / want.size) * 100);
}
export function scenesForSentence(productId, sentence, { limit = 10, ...filters } = {}) {
  return selectScenes(productId, filters).map(s => ({ ...s, sentence_fit: sentenceFit(s, sentence) }))
    .filter(s => s.sentence_fit > 0).sort((a, b) => b.sentence_fit - a.sentence_fit || (b.quality ?? 0) - (a.quality ?? 0)).slice(0, limit);
}

// Look-alike group of a scene (scenes marked duplicate/similar share the same reference).
const groupOf = s => s.duplicate_of || s.similar_to || s.id;

// Lay out a timeline: slots [{ placement, duration, sentence?, angleId? }] → one scene (and exact seconds) per slot.
// Never uses the same scene twice, avoids look-alikes and two shots in a row from the same video when possible.
export function planTimeline(productId, slots, { angleId = null, minQuality = 0 } = {}) {
  const pool = selectScenes(productId, { minQuality });
  const used = new Set(), groups = new Set();
  let lastAsset = null;
  return slots.map((slot, i) => {
    const want = Number(slot.duration) || 2;
    const aid = slot.angleId ?? angleId;
    const ranked = pool.filter(s => !used.has(s.id)).map(s => {
      const fit = s.placements.find(p => p.placement === slot.placement)?.fit ?? 0;
      const ang = aid ? (s.angles.find(a => a.angle_id === Number(aid))?.score ?? 0) : 50;
      const sent = slot.sentence ? sentenceFit(s, slot.sentence) : 50;
      let score = fit * 0.35 + ang * 0.25 + (s.quality ?? 0) * 0.25 + sent * 0.15 + (s.favorite ? 5 : 0);
      if (groups.has(groupOf(s))) score -= 40;
      if (s.asset_id === lastAsset) score -= 10;
      if (s.duration < want * 0.6) score -= 15;
      return { s, score };
    }).sort((a, b) => b.score - a.score);
    const pick = ranked[0];
    if (!pick) return { slot: i, placement: slot.placement, scene_id: null };
    used.add(pick.s.id); groups.add(groupOf(pick.s)); lastAsset = pick.s.asset_id;
    const len = Math.min(want, pick.s.duration);
    return { slot: i, placement: slot.placement, scene_id: pick.s.id, asset_id: pick.s.asset_id, start: pick.s.start, end: Math.round((pick.s.start + len) * 1000) / 1000, score: Math.round(pick.score) };
  });
}

export { CATEGORIES, PLACEMENTS };
