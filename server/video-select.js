// Visual selection for the edit (deterministic, explainable): clean-footage classes, look-alike detection
// (Module 2 picture fingerprints), and scene scores for the opening hook, the closing shot and every other shot
// with repetition penalties. The approved storyboard's choice is kept unless another scene with the SAME meaning is
// clearly better; every change is listed with its reason and can be undone (nothing is replaced silently).
import { db } from './db.js';
import { LIMITS } from './video-schemas.js';

// ---------- Clean footage ----------
// clean | text (captions, promo text) | graphics (arrows, emojis, stickers, banners) | review (watermark / third-party marks)
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}\u{27A1}]/u;
const PROMO = /%|off\b|sale|promo|buy|order|now|free|price|\$|ksh|zmw|cfa|discount|limited|only|offer|deal|link/i;
export function cleanliness(sc) {
  const d = sc?.details || {};
  const g = d.graphics, texts = d.text_overlays || [];
  const reasons = [];
  if (d.watermark?.present) reasons.push(`watermark${d.watermark.text ? ` (${d.watermark.text})` : ''}`);
  if (g) {
    if (g.arrows_stickers) reasons.push('arrows / stickers / emojis');
    if (g.other_graphics) reasons.push('graphic overlays');
    if (g.captions) reasons.push('captions');
    if (g.promo_text) reasons.push('promotional text');
  } else {
    if (texts.some(t => EMOJI.test(t))) reasons.push('emojis or arrows in the on-screen text');
    if (texts.some(t => PROMO.test(t))) reasons.push('promotional text');
    else if (texts.length) reasons.push('on-screen text');
  }
  const cls = d.watermark?.present ? 'review' : (g?.arrows_stickers || g?.other_graphics || (!g && texts.some(t => EMOJI.test(t)))) ? 'graphics' : reasons.length ? 'text' : 'clean';
  return { class: cls, reasons, detailed: !!g, label: { clean: 'Clean footage', text: 'Footage with embedded text', graphics: 'Footage with graphic overlays', review: 'Needs manual review (watermark)' }[cls] };
}

// ---------- Look-alikes ----------
const popcount = x => { let n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
export function phashes(ids) {
  if (!ids.length) return new Map();
  return new Map(db.prepare(`SELECT id, phash FROM footage_scenes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).filter(r => r.phash).map(r => [r.id, r.phash]));
}
export function lookAlike(a, b, ph) {
  if (a.id === b.id) return 1;
  if (a.duplicate_of === b.id || b.duplicate_of === a.id) return 1;
  if (a.similar_to === b.id || b.similar_to === a.id || (a.similar_to && a.similar_to === b.similar_to)) return 0.75;
  const x = ph.get(a.id), y = ph.get(b.id);
  if (x && y && x.length === y.length) { const d = popcount(BigInt('0x' + x) ^ BigInt('0x' + y)); if (d <= 2) return 1; if (d <= 8) return 0.7; if (d <= 12) return 0.35; }
  if (a.asset_id === b.asset_id && (Math.abs(a.start - b.end) < 0.5 || Math.abs(b.start - a.end) < 0.5)) return 0.25; // next to each other in one video (a scene cut usually means a new shot)
  // Same source video and almost the same description: the same action filmed again.
  if (a.asset_id === b.asset_id && jac(words(`${a.semantic} ${a.description}`), words(`${b.semantic} ${b.description}`)) >= 0.5) return 0.5;
  return 0;
}

// ---------- Meaning ----------
const STOP = new Set('the a an and or of to in on with for is it this that your you are be at by from as its into very can will just look watch see how get our'.split(' '));
function words(t) { return wordsOf(t); }
const wordsOf = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9à-ÿ\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|es|s|ed)$/, '')));
function jac(a, b) { return jacOf(a, b); }
const jacOf = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const GENERIC = new Set(['other', 'broll', 'human', 'ugc']);
const cats = sc => new Set((sc?.categories || []).map(c => c.key || c));
const meaningful = sc => new Set([...cats(sc)].filter(c => !GENERIC.has(c)));
// Same idea as the storyboard's scene (so a swap keeps the approved meaning)?
export function sameIdea(cand, ref, segText) {
  if (cand.id === ref.id) return 1;
  const shared = [...meaningful(cand)].filter(c => meaningful(ref).has(c)).length;
  const t = jac(words(`${cand.semantic} ${cand.description}`), words(`${ref.semantic} ${ref.description}`));
  const s = jac(words(`${cand.semantic} ${cand.description}`), words(segText));
  return Math.min(1, (shared ? 0.5 + 0.15 * (shared - 1) : 0) + t * 1.2 + s * 0.8);
}

// ---------- Room for text overlays (Module 7) ----------
// Fractions of the frame free above and below the product. Known from the product position; otherwise estimated.
export function overlayRoom(sc) {
  const d = sc?.details || {}, b = d.product_box;
  if (b?.present && b.h > 0) return { top: Math.max(0, b.y), bottom: Math.max(0, 1 - b.y - b.h), basis: 'product position' };
  const comp = d.composition || '';
  if (/space|plain|background|minimal|negative/i.test(comp)) return { top: 0.2, bottom: 0.25, basis: 'composition notes' };
  if (/tight|fills the frame|extreme close|macro/i.test(comp)) return { top: 0.05, bottom: 0.05, basis: 'composition notes' };
  return { top: 0.12, bottom: 0.15, basis: 'estimate' };
}
const roomScore = sc => { const r = overlayRoom(sc); return (r.top >= 0.15 ? 0.1 : r.top < 0.08 ? -0.1 : 0) + (r.bottom >= 0.2 ? 0.15 : r.bottom < 0.1 ? -0.15 : 0); };

// ---------- Scores ----------
const PACK = new Set(['packaging', 'unboxing']);
const mentionsBox = t => /(^|[^a-z])(box|boxes|unbox|packag|parcel|wrapp)/i.test(t || '');
function roleFit(sc, role, text) {
  const c = cats(sc), d = sc.details || {};
  const vis = d.product_visible === false ? -0.5 : d.product_visible ? 0.2 : 0;
  const moving = (sc.measured?.motion ?? 0) > 12 || ['handheld', 'pan', 'tilt', 'zoom', 'tracking'].includes(d.camera_movement);
  const pack = [...c].some(x => PACK.has(x)) && !mentionsBox(text);
  if (role === 'hook') return vis * 1.5 + (c.has('closeup') ? 0.35 : 0) + (c.has('hook') ? 0.3 : 0) + (c.has('demonstration') || c.has('showcase') ? 0.2 : 0) + (moving ? 0.15 : 0) + (pack ? -0.7 : 0) + roomScore(sc);
  if (role === 'closing') {
    const space = /space|background|minimal|clean|plain|centred|centered/i.test(d.composition || '');
    // A clean, attractive close-up or showcase of the product closes best (people / lifestyle less so).
    return vis * 1.5 + (c.has('showcase') ? 0.5 : 0) + (c.has('closeup') ? 0.45 : 0) + (c.has('cta') ? 0.15 : 0) + (c.has('lifestyle') || c.has('demonstration') ? 0.05 : 0)
      + (!c.has('showcase') && !c.has('closeup') ? -0.25 : 0) + (space ? 0.1 : 0) + roomScore(sc) + (d.camera_movement === 'shaky' ? -0.3 : 0) + (pack ? -0.4 : 0);
  }
  return vis + (pack && !mentionsBox(text) ? -0.2 : 0);
}
const CLEAN_PEN = { clean: 0, text: -0.45, graphics: -0.6, review: -0.7 };
// used: [{ scene, start, end, order }] already placed (in timeline order)
export function diversityPenalty(sc, from, to, used, ph) {
  let p = 0;
  const last = used.at(-1);
  for (const [k, u] of used.entries()) {
    const near = used.length - k <= 3;
    if (u.scene.id === sc.id) {
      if (from < u.end && to > u.start) return -5; // the same frames again
      p -= near ? 1.0 : 0.6;
      continue;
    }
    const sim = lookAlike(sc, u.scene, ph);
    if (sim) p -= sim * (near ? 1.3 : 0.7);
  }
  if (last && last.scene.asset_id === sc.asset_id) p -= 0.15; // prefer another source video when equally relevant
  if (last && last.scene.details?.camera_movement && last.scene.details.camera_movement === sc.details?.camera_movement && [...meaningful(sc)][0] === [...meaningful(last.scene)][0]) p -= 0.1; // vary the camera angle
  return p;
}
export function sceneScore(sc, { role, text, ref, used, from, to, ph, outShort }) {
  const cl = cleanliness(sc);
  const q = ((sc.quality ?? 55) - 60) / 100;
  const angle = Math.max(0, ...(sc.angles || []).map(a => a.score || 0)) / 100;
  const idea = ref ? sameIdea(sc, ref, text) : 0.5;
  const res = sc.width && sc.height && outShort && Math.min(sc.width, sc.height) < outShort * 0.6 ? -0.15 : 0;
  // The closing shot is chosen first for being the best product shot: repetition counts a little less there.
  const parts = { idea: idea * 0.6, role: roleFit(sc, role, text), quality: q, angle: angle * 0.15, clean: CLEAN_PEN[cl.class], diversity: diversityPenalty(sc, from, to, used, ph) * (role === 'closing' ? 0.6 : 1), resolution: res };
  return { score: Object.values(parts).reduce((a, b) => a + b, 0), parts, clean: cl };
}

// Choose the scene of every storyboard shot. mode 'improve' (default) or 'storyboard' (keep every approved scene).
// Returns { shots: [{ shot, scene, original, changed, reason, clean }], changes, cleanReport }
export function selectScenes({ sync, pp, scenes, usable, mode = 'improve', lockedShots = new Set(), outShort = 1080 }) {
  const all = [...usable].map(id => scenes.get(id)).filter(Boolean);
  const cleanPool = all.filter(c => cleanliness(c).class === 'clean' && c.details?.product_visible !== false);
  const total = sync.final_duration || sync.shots.reduce((a, x) => a + x.duration, 0);
  // Enough clean footage = clean scenes covering the whole video at least once, and enough of them for variety.
  const enoughClean = cleanPool.reduce((a, c) => a + c.duration, 0) >= total && cleanPool.length >= Math.min(5, sync.shots.length);
  const pool = mode !== 'storyboard' && enoughClean ? cleanPool : all;
  const ph = phashes([...new Set([...pool.map(s => s.id), ...sync.shots.map(s => s.scene_id)])]);
  const segText = id => pp.voiceover.segments.find(s => s.id === id)?.text || '';
  const used = [], out = [], changes = [];
  const lastShot = sync.shots.at(-1)?.id;
  sync.shots.forEach((shot, i) => {
    const ref = scenes.get(shot.scene_id);
    const text = segText(shot.segment_id);
    const role = i === 0 ? 'hook' : shot.id === lastShot ? 'closing' : 'body';
    const need = shot.duration;
    let pick = ref, why = '';
    if (ref && mode !== 'storyboard' && !lockedShots.has(shot.id)) {
      const minIdea = role === 'hook' || role === 'closing' ? 0.35 : 0.5;
      // A weak storyboard choice (packaging opening the hook does not talk about, footage with text/graphics/watermark,
      // product not visible, a closing shot that is weak or too short) may be replaced by any clean scene that fits the role.
      const refClean = cleanliness(ref).class === 'clean' || (!enoughClean && cleanliness(ref).class === 'text');
      const weak = !refClean || ref.details?.product_visible === false
        || (role === 'hook' && [...cats(ref)].some(x => PACK.has(x)) && !mentionsBox(text))
        || (role === 'closing' && (roleFit(ref, 'closing', text) < 0.3 || ref.duration < need * 0.6));
      const roleOk = c => (role === 'hook' || role === 'closing' ? roleFit(c, role, text) >= 0.45 : sameIdea(c, ref, text) >= 0.35) && cleanliness(c).class === 'clean' && c.details?.product_visible !== false;
      const RANK = { clean: 0, text: 1, graphics: 2, review: 3 }, refRank = RANK[cleanliness(ref).class];
      // A swap never brings footage that is less clean than the storyboard's.
      let cands = pool.filter(c => c.id === ref.id || (c.duration >= Math.min(need, 1.2) && RANK[cleanliness(c).class] <= refRank && (sameIdea(c, ref, text) >= minIdea || (weak && roleOk(c)))));
      // With enough clean footage a storyboard scene with overlays is always replaced: by the same idea if possible, else by
      // the clean scene that fits the role best (product visible, angle, quality, variety).
      if (enoughClean && cleanliness(ref).class !== 'clean') {
        const same = cands.filter(c => c.id !== ref.id);
        cands = same.length ? same : cleanPool.filter(c => c.duration >= Math.min(need, 1.2));
      }
      // Opening and closing, or a weak storyboard choice: clean footage only, as long as some fits.
      const cleanOnes = cands.filter(c => c.id !== ref.id && cleanliness(c).class === 'clean');
      if ((weak || role !== 'body') && cleanOnes.length && cleanliness(ref).class !== 'clean') cands.splice(0, cands.length, ...cands.filter(c => cleanliness(c).class === 'clean' || c.id === ref.id));
      const next = scenes.get(sync.shots[i + 1]?.scene_id); // look ahead: no look-alike right before the next shot
      const scored = cands.map(c => { const s = sceneScore(c, { role, text, ref, used, from: -1, to: -1, ph, outShort }); if (next) { const la = lookAlike(c, next, ph) * 1.0; s.score -= la; s.parts.diversity -= la; } return { c, s }; });
      // The approved choice wins ties; a weak one does not, and the comparison is then on the role, quality and cleanliness only.
      for (const x of scored) { if (weak) { x.s.score += 0.4 - x.s.parts.idea; x.s.parts.idea = 0.4; } else if (x.c.id === ref.id) x.s.score += 0.25; }
      scored.sort((a, b) => b.s.score - a.s.score);
      const best = scored[0];
      if (best && best.c.id !== ref.id) {
        const refS = scored.find(x => x.c.id === ref.id)?.s;
        pick = best.c;
        const r = [];
        if (!refS && cleanliness(ref).class !== 'clean') r.push(`clean footage instead of a scene with ${cleanliness(ref).reasons.join(', ')}`);
        if (refS && best.s.parts.clean > refS.parts.clean) r.push(`cleaner footage (storyboard scene has ${refS.clean.reasons.join(', ') || 'overlays'})`);
        if (refS && best.s.parts.diversity > refS.parts.diversity + 0.2) r.push('avoids repeating a similar shot');
        if (refS && best.s.parts.role > refS.parts.role + 0.2) r.push(role === 'hook' ? 'stronger opening (product visible right away)' : role === 'closing' ? 'stronger closing product shot' : 'product more visible');
        if (refS && best.s.parts.quality > refS.parts.quality + 0.08) r.push('better picture quality');
        if (role === 'closing' && ref.duration < need * 0.6 && best.c.duration > ref.duration) r.push('long enough for the closing moment');
        why = `${sameIdea(best.c, ref, text) >= minIdea ? `Same idea as storyboard scene ${ref.id}` : `Replaces weak storyboard scene ${ref.id} (${role === 'hook' ? 'opening' : role})`}, ${r.join(', ') || 'better overall'}.`;
        changes.push({ shot_id: shot.id, segment_id: shot.segment_id, role, from: ref.id, to: pick.id, reason: why });
      }
    }
    if (pick) used.push({ scene: pick, start: pick.start, end: pick.start + Math.min(need, pick.duration), order: i });
    out.push({ shot, scene: pick || null, original: ref?.id ?? shot.scene_id, changed: !!pick && !!ref && pick.id !== ref.id, reason: why, role, clean: pick ? cleanliness(pick) : null });
  });
  return { shots: out, changes, ph, pool, enoughClean };
}

// Extra scenes for a long shot (same idea, best first, no repeats of frames already used).
export function extrasFor({ shotSel, text, pool, used, ph, outShort, preferred = [] }) {
  const ref = shotSel.scene;
  if (!ref) return [];
  return pool.filter(c => c.id !== ref.id && (sameIdea(c, ref, text) >= 0.5 || (shotSel.role === 'closing' && cleanliness(c).class === 'clean' && roleFit(c, 'closing', text) >= 0.45)))
    .map(c => { const s = sceneScore(c, { role: shotSel.role === 'closing' ? 'closing' : 'body', text, ref, used, from: -1, to: -1, ph, outShort }); return { c, score: s.score + (preferred.includes(c.id) ? 0.2 : 0) }; })
    .filter(x => x.score > -1.5).sort((a, b) => b.score - a.score).map(x => x.c)
    .filter((c, i, all) => cleanliness(c).class === 'clean' || all.filter(x => cleanliness(x).class === 'clean').length < 2).slice(0, 4);
}

// Summary of the footage cleanliness for the page (used scenes and the whole usable pool).
export function cleanReport(clips, scenes, usable) {
  const count = list => list.reduce((m, sc) => { const c = cleanliness(sc).class; m[c] = (m[c] || 0) + 1; return m; }, {});
  const usedScenes = clips.filter(c => !c.missing).map(c => scenes.get(c.scene_id)).filter(Boolean);
  const poolScenes = [...usable].map(id => scenes.get(id)).filter(Boolean);
  const used = count(usedScenes), pool = count(poolScenes);
  const notClean = usedScenes.length - (used.clean || 0);
  const undetailed = poolScenes.filter(s => !cleanliness(s).detailed).map(s => s.id);
  return { used, pool, not_clean_share: usedScenes.length ? Math.round((notClean / usedScenes.length) * 100) : 0, undetailed,
    insufficient: usedScenes.length > 0 && notClean / usedScenes.length > 0.3, max_scene_uses: LIMITS.maxSceneUses };
}
