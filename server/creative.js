// Module 3: creative projects. A project = a product + chosen angles + footage choice + creative types + settings
// + variation plan. Everything references Module 1/2 records (no media copied). Validation separates blocking errors
// from warnings; the Creative Brief (server/creative-brief.js) is built from a valid project.
import { db, tx } from './db.js';
import { HttpError } from './errors.js';
import { LANGUAGES } from './ai.js';
import { MARKETS } from './markets.js';
import { listAngles, latestAnalysis } from './strategy.js';
import {
  CREATIVE_TYPES, AI_RECOMMENDED, typeById, PLATFORMS, LIMITS, ASPECTS, RESOLUTIONS, PACES, TONES, HOOK_STYLES, CLAIMS,
  PRODUCTION, VARIATION_STRATEGIES, FOOTAGE_MODES,
} from './creative-types.js';

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const marketsOf = p => parse(p.markets, []);
const STEPS = ['product', 'angles', 'footage', 'type', 'settings', 'review'];

// ---------- Settings: defaults from the product (Module 1), project-level overrides ----------
export function productDefaults(p) {
  const markets = marketsOf(p);
  const country = p.country || markets[0]?.code || '';
  const mprice = markets.find(m => m.code === country)?.price || '';
  return {
    country, language: p.language || 'en', dialect: '', currency: MARKETS[country]?.currency || '',
    price: mprice || p.price || '', offer: p.offer || '',
  };
}
export function defaultSettings(p) {
  return {
    step: 'product',
    footage_mode: 'auto',
    types: [],
    market: { ...productDefaults(p), cod: true, free_delivery: false, limited_stock: false, guarantee: false },
    platform: 'fb_ig', duration: 20, aspect: '4:5', resolution: '1080p',
    pace: AI_RECOMMENDED, tone: AI_RECOMMENDED, hook_styles: [AI_RECOMMENDED], custom_hook: '',
    cta: 'Order Now',
    production: Object.fromEntries(Object.entries(PRODUCTION).map(([k, v]) => [k, v.default])),
  };
}

// Keep only known keys and values (anything else from the page is dropped).
function cleanSettings(input, current) {
  const s = { ...current, ...(input || {}) };
  const m = { ...current.market, ...(input?.market || {}) };
  const pick = (v, allowed, d) => (Object.prototype.hasOwnProperty.call(allowed, v) ? v : d);
  return {
    step: STEPS.includes(s.step) ? s.step : current.step,
    footage_mode: pick(s.footage_mode, FOOTAGE_MODES, 'auto'),
    types: [...new Set((Array.isArray(s.types) ? s.types : []).filter(t => t === AI_RECOMMENDED || typeById(t)))].slice(0, 10),
    market: {
      country: MARKETS[str(m.country, 2).toUpperCase()] ? str(m.country, 2).toUpperCase() : '',
      language: LANGUAGES[m.language] ? m.language : current.market.language,
      dialect: str(m.dialect, 60), currency: str(m.currency, 8).toUpperCase(), price: str(m.price, 40), offer: str(m.offer, 300),
      cod: !!m.cod, free_delivery: !!m.free_delivery, limited_stock: !!m.limited_stock, guarantee: !!m.guarantee,
    },
    platform: pick(s.platform, PLATFORMS, 'other'),
    duration: Number.isFinite(Number(s.duration)) ? Math.round(Number(s.duration)) : current.duration,
    aspect: pick(s.aspect, ASPECTS, '9:16'),
    resolution: RESOLUTIONS.includes(s.resolution) ? s.resolution : '1080p',
    pace: pick(s.pace, PACES, AI_RECOMMENDED),
    tone: pick(s.tone, TONES, AI_RECOMMENDED),
    hook_styles: [...new Set((Array.isArray(s.hook_styles) ? s.hook_styles : []).filter(h => HOOK_STYLES[h]))].slice(0, 8),
    custom_hook: str(s.custom_hook, 200),
    cta: str(s.cta, 120),
    production: Object.fromEntries(Object.keys(PRODUCTION).map(k => [k, s.production?.[k] !== undefined ? !!s.production[k] : !!current.production?.[k]])),
  };
}

// ---------- Projects ----------
export const projectRow = id => {
  const r = db.prepare(`SELECT * FROM creative_projects WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Creative project not found');
  return r;
};
const productOf = pid => {
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(pid);
  if (!p) throw new HttpError(404, 'Product not found');
  return p;
};
// Team members see every project; only its author or an admin may change or delete it.
export function canEdit(project, user) { return user.role === 'admin' || project.created_by === user.id; }
const mustEdit = (project, user) => { if (!canEdit(project, user)) throw new HttpError(403, 'Only the author of this project or an admin can change it'); };

export function createProject({ productId, name, user }) {
  const p = productOf(Number(productId));
  const n = str(name, 120) || `${p.name}: creative ${db.prepare(`SELECT COUNT(*) n FROM creative_projects WHERE product_id = ?`).get(p.id).n + 1}`;
  const s = defaultSettings(p);
  return tx(() => {
    const id = db.prepare(`INSERT INTO creative_projects (product_id, name, settings, created_by) VALUES (?,?,?,?)`).run(p.id, n, JSON.stringify(s), user.id).lastInsertRowid;
    db.prepare(`INSERT INTO creative_variation_plans (project_id, count, strategies) VALUES (?, 3, '["hooks","angles"]')`).run(id);
    // Start with the angles chosen in Module 1 (the team can change them).
    listAngles(p.id).filter(a => a.selected).forEach((a, i) => db.prepare(`INSERT INTO creative_project_angles (project_id, angle_id, position) VALUES (?,?,?)`).run(id, a.id, i));
    return id;
  });
}

// Save any part of a project (settings, angles, scenes, variation plan). Changing a ready project makes it a draft again.
export function updateProject(id, body, user) {
  const pr = projectRow(id);
  mustEdit(pr, user);
  const p = productOf(pr.product_id);
  tx(() => {
    if (body.name !== undefined) {
      const n = str(body.name, 120);
      if (!n) throw new HttpError(400, 'Give the project a name');
      db.prepare(`UPDATE creative_projects SET name = ? WHERE id = ?`).run(n, id);
    }
    if (body.settings) {
      const cur = { ...defaultSettings(p), ...parse(pr.settings, {}) };
      db.prepare(`UPDATE creative_projects SET settings = ? WHERE id = ?`).run(JSON.stringify(cleanSettings(body.settings, cur)), id);
    }
    if (Array.isArray(body.angle_ids)) {
      const valid = new Set(listAngles(p.id).map(a => a.id));
      const ids = [...new Set(body.angle_ids.map(Number))];
      const bad = ids.filter(x => !valid.has(x));
      if (bad.length) throw new HttpError(400, `These angles do not belong to the product: ${bad.join(', ')}`);
      db.prepare(`DELETE FROM creative_project_angles WHERE project_id = ?`).run(id);
      ids.forEach((a, i) => db.prepare(`INSERT INTO creative_project_angles (project_id, angle_id, position) VALUES (?,?,?)`).run(id, a, i));
    }
    if (body.scenes) {
      // { include: [ids], exclude: [ids] } replaces the project's scene choices. Scenes must belong to the product.
      const inc = [...new Set((body.scenes.include || []).map(Number))], exc = [...new Set((body.scenes.exclude || []).map(Number))];
      const all = [...inc, ...exc];
      if (all.length) {
        const own = new Set(db.prepare(`SELECT id FROM footage_scenes WHERE product_id = ? AND id IN (${all.map(() => '?').join(',')})`).all(p.id, ...all).map(r => r.id));
        const bad = all.filter(x => !own.has(x));
        if (bad.length) throw new HttpError(400, `These scenes do not belong to the product: ${bad.join(', ')}`);
      }
      db.prepare(`DELETE FROM creative_project_scenes WHERE project_id = ?`).run(id);
      for (const s of inc) db.prepare(`INSERT INTO creative_project_scenes (project_id, scene_id, choice) VALUES (?,?, 'include')`).run(id, s);
      for (const s of exc) if (!inc.includes(s)) db.prepare(`INSERT INTO creative_project_scenes (project_id, scene_id, choice) VALUES (?,?, 'exclude')`).run(id, s);
    }
    if (body.variations) {
      const v = body.variations;
      const count = Math.round(Number(v.count));
      const strategies = [...new Set((Array.isArray(v.strategies) ? v.strategies : []).filter(x => VARIATION_STRATEGIES[x]))];
      const dist = Array.isArray(v.distribution) ? v.distribution.map(d => ({ key: str(d.key, 60), count: Math.max(0, Math.round(Number(d.count) || 0)) })) : null;
      db.prepare(`UPDATE creative_variation_plans SET count = ?, strategies = ?, distribution = ?, updated_at = datetime('now') WHERE project_id = ?`)
        .run(Number.isFinite(count) && count >= 1 ? Math.min(count, 1000) : 1, JSON.stringify(strategies), dist ? JSON.stringify(dist) : '', id);
    }
    // Only edits that change the brief turn a ready project back into a draft (moving between steps does not).
    const onlyStep = body.settings && Object.keys(body.settings).every(k => k === 'step') && !body.angle_ids && !body.scenes && !body.variations && body.name === undefined;
    db.prepare(`UPDATE creative_projects SET updated_at = datetime('now')${onlyStep ? '' : ", status = 'draft'"} WHERE id = ?`).run(id);
  });
}

export function duplicateProject(id, user) {
  const pr = projectRow(id);
  return tx(() => {
    const nid = db.prepare(`INSERT INTO creative_projects (product_id, name, settings, recommendations, reco_key, created_by) VALUES (?,?,?,?,?,?)`)
      .run(pr.product_id, `${pr.name} (copy)`.slice(0, 120), pr.settings, pr.recommendations, pr.reco_key, user.id).lastInsertRowid;
    db.prepare(`INSERT INTO creative_project_angles (project_id, angle_id, position) SELECT ?, angle_id, position FROM creative_project_angles WHERE project_id = ?`).run(nid, id);
    db.prepare(`INSERT INTO creative_project_scenes (project_id, scene_id, choice) SELECT ?, scene_id, choice FROM creative_project_scenes WHERE project_id = ?`).run(nid, id);
    db.prepare(`INSERT INTO creative_variation_plans (project_id, count, strategies, distribution) SELECT ?, count, strategies, distribution FROM creative_variation_plans WHERE project_id = ?`).run(nid, id);
    return nid;
  });
}

export function deleteProject(id, user) {
  const pr = projectRow(id);
  mustEdit(pr, user);
  db.prepare(`DELETE FROM creative_projects WHERE id = ?`).run(id); // angles, scenes, plan and briefs go with it (no media files)
}

export function listProjects({ product, country, type, status, q } = {}) {
  const rows = db.prepare(`SELECT cp.*, p.name AS product_name, p.image AS product_image, u.name AS author,
      (SELECT MAX(version) FROM creative_briefs WHERE project_id = cp.id) AS brief_version,
      (SELECT count FROM creative_variation_plans WHERE project_id = cp.id) AS variations,
      (SELECT COUNT(*) FROM creative_project_angles WHERE project_id = cp.id) AS angles
    FROM creative_projects cp JOIN products p ON p.id = cp.product_id LEFT JOIN users u ON u.id = cp.created_by ORDER BY cp.updated_at DESC, cp.id DESC`).all();
  return rows.map(r => {
    const s = parse(r.settings, {});
    return { id: r.id, name: r.name, status: r.status, product_id: r.product_id, product_name: r.product_name, product_image: r.product_image,
      author: r.author || '', created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, brief_version: r.brief_version,
      variations: r.variations, angles: r.angles, country: s.market?.country || '', language: s.market?.language || '',
      types: s.types || [], platform: s.platform || '', duration: s.duration, aspect: s.aspect, step: s.step || 'product' };
  }).filter(r => (!product || r.product_id === Number(product)) && (!country || r.country === country)
    && (!type || r.types.includes(type)) && (!status || r.status === status)
    && (!q || `${r.name} ${r.product_name}`.toLowerCase().includes(String(q).toLowerCase())));
}

// ---------- Footage (Module 2): what a project may use ----------
// Eligible = analysed scene, not excluded in Module 2, from a video whose silent copy was checked (no audio stream).
export function eligibleScenes(productId) {
  return db.prepare(`SELECT s.id, s.asset_id, s.start, s.end, s.duration, s.favorite, s.duplicate_of, s.similar_to, s.status, s.excluded,
      a.name AS asset_name, a.orientation, a.aspect, a.width, a.height, sa.quality, sa.description, sa.semantic
    FROM footage_scenes s JOIN footage_assets a ON a.id = s.asset_id LEFT JOIN scene_analyses sa ON sa.scene_id = s.id
    WHERE s.product_id = ? AND s.status = 'analyzed' AND s.excluded = 0 AND a.silent = 1 AND a.proxy_key <> ''
    ORDER BY a.id, s.start`).all(productId);
}
const sceneCats = ids => {
  const out = new Map(ids.map(i => [i, []]));
  if (ids.length) for (const r of db.prepare(`SELECT scene_id, tag FROM scene_tags WHERE kind = 'category' AND scene_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) out.get(r.scene_id)?.push(r.tag);
  return out;
};
const sceneAngles = ids => {
  const out = new Map(ids.map(i => [i, []]));
  if (ids.length) for (const r of db.prepare(`SELECT scene_id, angle_id, score FROM scene_angles WHERE scene_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) out.get(r.scene_id)?.push(r);
  return out;
};
export function footageStatus(productId) {
  const one = (sql) => db.prepare(sql).get(productId).n;
  return {
    videos: one(`SELECT COUNT(*) n FROM footage_assets WHERE product_id = ?`),
    processing: one(`SELECT COUNT(*) n FROM footage_assets WHERE product_id = ? AND status IN ('uploaded','queued','storing','metadata','scenes','analyzing','matching')`),
    scenes: one(`SELECT COUNT(*) n FROM footage_scenes WHERE product_id = ?`),
    analysed: one(`SELECT COUNT(*) n FROM footage_scenes WHERE product_id = ? AND status = 'analyzed'`),
    favorites: one(`SELECT COUNT(*) n FROM footage_scenes WHERE product_id = ? AND favorite = 1 AND status = 'analyzed' AND excluded = 0`),
    eligible: eligibleScenes(productId).length,
  };
}

// The scenes this project will give to the next modules, after its footage mode and its own include/exclude choices.
export function projectScenes(pr, settings) {
  const all = eligibleScenes(pr.product_id);
  const choices = db.prepare(`SELECT scene_id, choice FROM creative_project_scenes WHERE project_id = ?`).all(pr.id);
  const inc = new Set(choices.filter(c => c.choice === 'include').map(c => c.scene_id));
  const exc = new Set(choices.filter(c => c.choice === 'exclude').map(c => c.scene_id));
  const mode = settings.footage_mode;
  const used = all.filter(s => !exc.has(s.id) && (mode === 'manual' ? inc.has(s.id) : mode === 'favorites' ? s.favorite : true));
  const eligibleIds = new Set(all.map(s => s.id));
  const unavailable = [...inc].filter(id => !eligibleIds.has(id)); // picked by hand but no longer usable
  return { all, used, include: [...inc], exclude: [...exc], unavailable };
}

// ---------- Everything about a project, for the pages and for the brief ----------
export function projectState(id) {
  const pr = projectRow(id);
  const p = productOf(pr.product_id);
  const settings = { ...defaultSettings(p), ...parse(pr.settings, {}) };
  settings.market = { ...defaultSettings(p).market, ...(settings.market || {}) };
  const plan = db.prepare(`SELECT * FROM creative_variation_plans WHERE project_id = ?`).get(pr.id) || { count: 1, strategies: '[]', distribution: '' };
  const angleIds = db.prepare(`SELECT angle_id FROM creative_project_angles WHERE project_id = ? ORDER BY position`).all(pr.id).map(r => r.angle_id);
  const angles = listAngles(p.id);
  const sc = projectScenes(pr, settings);
  const cats = sceneCats(sc.all.map(s => s.id)), links = sceneAngles(sc.all.map(s => s.id));
  const scenes = sc.all.map(s => ({ ...s, favorite: !!s.favorite, categories: cats.get(s.id) || [], angles: links.get(s.id) || [] }));
  const usedIds = new Set(sc.used.map(s => s.id));
  const usedScenes = scenes.filter(s => usedIds.has(s.id));
  // Relevant scenes per angle (angle score ≥ 50 among the scenes the project uses).
  const angleScenes = Object.fromEntries(angles.map(a => [a.id, usedScenes.filter(s => s.angles.some(x => x.angle_id === a.id && x.score >= 50)).length]));
  const catCounts = {};
  for (const s of usedScenes) for (const c of s.categories) catCounts[c] = (catCounts[c] || 0) + 1;
  const typeSupport = Object.fromEntries(CREATIVE_TYPES.map(t => [t.id, t.needs.any.reduce((n, c) => n + (catCounts[c] || 0), 0)]));
  const briefs = db.prepare(`SELECT id, version, schema_version, created_at, created_by FROM creative_briefs WHERE project_id = ? ORDER BY version DESC`).all(pr.id);
  return {
    project: { id: pr.id, name: pr.name, status: pr.status, product_id: pr.product_id, created_by: pr.created_by, created_at: pr.created_at, updated_at: pr.updated_at },
    product: p, analysis: latestAnalysis(p.id), productDefaults: productDefaults(p), settings,
    angles, angle_ids: angleIds.filter(x => angles.some(a => a.id === x)), angleScenes,
    footage: { status: footageStatus(p.id), scenes, used_ids: [...usedIds], include: sc.include, exclude: sc.exclude, unavailable: sc.unavailable, categories: catCounts },
    typeSupport,
    variations: { count: plan.count, strategies: parse(plan.strategies, []), distribution: parse(plan.distribution, null) },
    recommendations: parse(pr.recommendations, null), reco_key: pr.reco_key,
    briefs,
  };
}

// ---------- Creative types actually used (AI Recommended resolved with the recommendations) ----------
export function resolvedTypes(st) {
  const chosen = st.settings.types.filter(t => t !== AI_RECOMMENDED);
  if (st.settings.types.includes(AI_RECOMMENDED)) {
    for (const r of st.recommendations?.creative_types || []) if (typeById(r.id) && !chosen.includes(r.id)) chosen.push(r.id);
  }
  return chosen;
}
// A setting left on "AI Recommended" takes the recommended value (if there is one).
export function resolvedSetting(st, key) {
  const v = st.settings[key];
  if (v !== AI_RECOMMENDED) return { value: v, source: 'user' };
  const r = st.recommendations?.[key];
  return r?.value ? { value: r.value, source: 'ai' } : { value: null, source: 'pending' };
}
export function resolvedHooks(st) {
  const own = st.settings.hook_styles.filter(h => h !== AI_RECOMMENDED);
  if (st.settings.hook_styles.includes(AI_RECOMMENDED) || !own.length) {
    for (const h of st.recommendations?.hook_styles || []) if (HOOK_STYLES[h.value] && h.value !== AI_RECOMMENDED && !own.includes(h.value)) own.push(h.value);
  }
  return own;
}

// ---------- Variation plan ----------
// Combinations = angles × creative types (only when the matching strategy is on). The total is split evenly over them
// (or follows the team's own distribution when it matches); each video then gets its hook style, footage set and edit style.
export function variationPlan(st) {
  const v = st.variations;
  const strat = new Set(v.strategies);
  const full = strat.has('full');
  const angleIds = st.angle_ids;
  const types = resolvedTypes(st);
  const hooks = resolvedHooks(st);
  const angleAxis = (full || strat.has('angles')) && angleIds.length > 1 ? angleIds.map(a => [a]) : [angleIds];
  const typeAxis = (full || strat.has('types')) && types.length > 1 ? types.map(t => [t]) : [types.slice(0, 1)];
  const combos = [];
  for (const a of angleAxis) for (const t of typeAxis) combos.push({ key: `${a.join('+') || 'none'}|${t.join('+') || 'none'}`, angle_ids: a, types: t });
  const count = v.count;
  let dist;
  const own = Array.isArray(v.distribution) ? v.distribution : null;
  const ownMatches = own && own.length === combos.length && combos.every(c => own.some(d => d.key === c.key));
  if (ownMatches) dist = combos.map(c => ({ ...c, count: own.find(d => d.key === c.key).count }));
  else {
    const base = Math.floor(count / combos.length), rest = count % combos.length;
    dist = combos.map((c, i) => ({ ...c, count: base + (i < rest ? 1 : 0) }));
  }
  const total = dist.reduce((n, d) => n + d.count, 0);
  const paceRes = resolvedSetting(st, 'pace').value || 'balanced';
  const paces = Object.keys(PACES).filter(k => k !== AI_RECOMMENDED);
  const editRotation = [paceRes, ...paces.filter(p => p !== paceRes)];
  const videos = [];
  let n = 0;
  for (const d of dist) for (let i = 0; i < d.count; i++) {
    videos.push({
      index: ++n, angle_ids: d.angle_ids, creative_type: d.types[0] || null,
      hook_style: (full || strat.has('hooks')) && hooks.length ? hooks[(n - 1) % hooks.length] : hooks[0] || null,
      footage_set: full || strat.has('footage') ? n : 1,
      script: full || strat.has('scripts') ? `distinct script ${n}` : 'same script base',
      editing_style: full || strat.has('editing') ? editRotation[(n - 1) % editRotation.length] : paceRes,
    });
  }
  const angleName = id => st.angles.find(a => a.id === id)?.name || `angle ${id}`;
  const typeName = id => typeById(id)?.name || id;
  const lines = dist.map(d => `${d.count} × ${d.angle_ids.map(angleName).join(' + ') || 'no angle'} · ${d.types.map(typeName).join(' + ') || 'no type yet'}`);
  const explanation = `${count} video${count > 1 ? 's' : ''} in total, split over ${combos.length} combination${combos.length > 1 ? 's' : ''} `
    + `(${angleAxis.length} angle group${angleAxis.length > 1 ? 's' : ''} × ${typeAxis.length} creative type${typeAxis.length > 1 ? 's' : ''}). `
    + (full ? 'Full variations: every video changes hook, footage, script and editing style. '
      : [strat.has('hooks') && 'hooks rotate', strat.has('footage') && 'each video gets its own footage set', strat.has('scripts') && 'each video gets its own script', strat.has('editing') && 'editing styles rotate'].filter(Boolean).join(', '));
  return { count, total, strategies: [...strat], combos: dist.map(({ key, angle_ids, types, count: c }) => ({ key, angle_ids, types, count: c })), custom: !!ownMatches, videos, explanation: explanation.trim(), lines };
}

// ---------- Validation: blocking errors vs warnings ----------
export function validateProject(st) {
  const errors = [], warnings = [];
  const E = (code, message, step) => errors.push({ code, message, step });
  const W = (code, message, step) => warnings.push({ code, message, step });
  const s = st.settings, m = s.market;
  const types = resolvedTypes(st);
  const used = st.footage.scenes.filter(x => st.footage.used_ids.includes(x.id));

  // Product & angles
  if (!st.product) E('product', 'The product does not exist any more.', 'product');
  if (!st.angle_ids.length) E('angles', 'Choose at least one marketing angle.', 'angles');
  for (const a of st.angle_ids) if ((st.angleScenes[a] || 0) < 2) W('angle_footage', `Angle "${st.angles.find(x => x.id === a)?.name}" has only ${st.angleScenes[a] || 0} relevant scene(s).`, 'angles');

  // Footage
  if (!st.footage.status.eligible) E('footage_none', 'This product has no analysed silent footage yet: upload and analyse videos in its Footage library (Module 2).', 'footage');
  else if (!used.length) E('footage_empty', st.settings.footage_mode === 'favorites' ? 'No favourite scene is available: mark favourites in the Footage library, or choose another mode.' : st.settings.footage_mode === 'manual' ? 'Pick at least one scene.' : 'Every scene is left out: include at least one.', 'footage');
  if (st.footage.unavailable.length) W('scenes_gone', `${st.footage.unavailable.length} picked scene(s) are no longer available (excluded, deleted or not analysed): they will not be used.`, 'footage');

  // Creative types
  if (!s.types.length) E('types', 'Choose at least one creative type (or AI Recommended).', 'type');
  if (s.types.includes(AI_RECOMMENDED) && !(st.recommendations?.creative_types || []).length) E('types_ai', 'AI Recommended is chosen: get the AI recommendations first, or choose a type.', 'type');
  for (const t of types) {
    const def = typeById(t);
    if (!def) { E('type_bad', `Unknown creative type: ${t}`, 'type'); continue; }
    const support = def.needs.any.reduce((n, c) => n + used.filter(x => x.categories.includes(c)).length, 0);
    if (!support) W('type_footage', `${def.name}: the chosen footage has no ${def.needs.label}.`, 'type');
    if (def.requiresOffer && !m.offer) E('offer_missing', `${def.name} needs a real promotional offer: write it in the settings, or choose another type.`, 'settings');
  }

  // Market & format
  if (!LANGUAGES[m.language]) E('language', 'Choose a valid language.', 'settings');
  if (!m.country) W('country', 'No target country is set.', 'settings');
  if (!(s.duration >= LIMITS.minDuration && s.duration <= LIMITS.maxDuration)) E('duration', `The duration must be between ${LIMITS.minDuration} and ${LIMITS.maxDuration} seconds.`, 'settings');
  if (!ASPECTS[s.aspect]) E('aspect', 'Choose a supported aspect ratio.', 'settings');
  if (!m.price) W('price', s.production.price_display ? 'Show the price is on, but no selling price is set.' : 'No selling price is set.', 'settings');
  if (!m.offer) W('offer', 'No promotional offer is set (fine if there is none).', 'settings');
  if (used.length && ASPECTS[s.aspect]) {
    const fits = ASPECTS[s.aspect].fits;
    const off = used.filter(x => x.orientation && x.orientation !== fits).length;
    if (off) W('crop', `${off} of ${used.length} scene(s) are ${fits === 'horizontal' ? 'not horizontal' : fits === 'square' ? 'not square' : 'not vertical'}: they will need cropping for ${s.aspect}.`, 'settings');
  }
  if (!s.cta) W('cta', 'No call to action is written.', 'settings');

  // Claims must be confirmed (CTA, custom hook, offer text)
  const said = [s.cta, s.custom_hook, m.offer].join(' \n ');
  for (const c of CLAIMS) {
    if (!c.re.test(said)) continue;
    if (c.key === 'promotion' ? !m.offer : !m[c.key]) {
      const where = c.re.test(s.cta) ? 'the CTA' : c.re.test(s.custom_hook) ? 'the custom hook' : 'the offer';
      E(`claim_${c.key}`, `${where[0].toUpperCase() + where.slice(1)} mentions ${c.label}, but it is not confirmed in the market settings.`, 'settings');
    }
  }

  // Variations
  const v = st.variations;
  if (!(v.count >= 1 && v.count <= LIMITS.maxVariations)) E('variations', `Choose between 1 and ${LIMITS.maxVariations} variations.`, 'settings');
  if (!v.strategies.length && v.count > 1) W('strategies', 'Several videos without a variation strategy will be very similar: choose at least one strategy.', 'settings');
  const plan = variationPlan(st);
  if (plan.total !== v.count) E('distribution', `The distribution adds up to ${plan.total} video(s), but ${v.count} are requested.`, 'settings');
  if (plan.combos.some(c => !c.count)) W('distribution_empty', `${plan.combos.filter(c => !c.count).length} combination(s) get no video: raise the number of variations or change the distribution.`, 'settings');
  const distinct = new Set(used.map(x => x.duplicate_of || x.similar_to || x.id)).size;
  const beats = Math.max(...types.map(t => typeById(t)?.structure.length || 4), 4);
  if (used.length && distinct < Math.min(beats + v.count - 1, 15)) W('few_scenes', `Only ${distinct} distinct scene(s) for ${v.count} video(s) of about ${beats} parts: videos may repeat footage.`, 'footage');
  return { errors, warnings, valid: !errors.length };
}

export { STEPS };
