// Visual enhancements: one per approved video edit (Module 6). Inputs and version checks, plan versions, team edits on
// the visual timeline (non-destructive: the footage, EDL and audio are never changed), renders, approval and the
// package handed to Module 8. Also brand kits, team caption presets and the safe-zone presets.
import { createHash } from 'node:crypto';
import { db, tx } from './db.js';
import { HttpError } from './errors.js';
import { canEdit, projectRow } from './creative.js';
import { editRow as vdEditRow, loadInputs as vdLoadInputs, inputProblems as vdProblems } from './video-production.js';
import { cleanliness } from './video-select.js';
import { CAPTION_STYLES, STYLE_FIELDS, INTENSITIES, SEGMENTATIONS, POSITIONS, SAFE_ZONES, defaultSafeZone, FONTS, ANIMATIONS, HOOK_TEMPLATES, BENEFIT_TEMPLATES,
  PRICE_TEMPLATES, CTA_TEMPLATES, EFFECTS, TRACKS, VX_STATUSES, VX_SCHEMA_VERSION, isHex, VX_LIMITS } from './vx-registry.js';
import { buildPlan, validatePlan, planHash, productOnScreen, checkStyle, textSize, fitSafe, DEFAULT_SETTINGS } from './vx-plan.js';
import { cleanText, splitLines, hasArabic } from './vx-captions.js';
import { QUALITY, outputSize } from './video-schemas.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const r3 = x => Math.round(x * 1000) / 1000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const PACKAGE_VERSION = '1.0';
export const hashOf = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');

// ---------- Visual projects ----------
export const vxRow = id => { const e = db.prepare(`SELECT * FROM vx_projects WHERE id = ?`).get(id); if (!e) throw new HttpError(404, 'Visual enhancement not found'); return e; };
export const mustEdit = (vx, user) => { if (!canEdit(projectRow(vx.project_id), user)) throw new HttpError(403, 'Only the author of this project or an admin can change its visuals'); };
export const setStatus = (id, status, error = '') => db.prepare(`UPDATE vx_projects SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`).run(status, error, id);

// Approved video edits of a project (newest approval first per video), with their visual enhancement if any.
export function readyEdits(projectId) {
  return db.prepare(`SELECT a.id AS vd_approval_id, a.approved_at, e.id AS vd_edit_id, e.variation_index, v.number AS video_version,
      (SELECT x.id FROM vx_projects x WHERE x.vd_approval_id = a.id) AS vx_id,
      (a.id = (SELECT MAX(a2.id) FROM vd_approvals a2 JOIN vd_edits e2 ON e2.id = a2.edit_id WHERE e2.project_id = e.project_id AND e2.variation_index = e.variation_index)) AS latest
    FROM vd_approvals a JOIN vd_edits e ON e.id = a.edit_id JOIN vd_versions v ON v.id = a.version_id WHERE e.project_id = ? ORDER BY e.variation_index, a.id DESC`).all(projectId)
    .map(r => ({ ...r, latest: !!r.latest }));
}
export function getOrCreate(projectId, vdApprovalId, user) {
  const pr = projectRow(projectId);
  if (!canEdit(pr, user)) throw new HttpError(403, 'Only the author of this project or an admin can change its visuals');
  const a = db.prepare(`SELECT a.*, e.project_id, e.product_id, e.variation_index FROM vd_approvals a JOIN vd_edits e ON e.id = a.edit_id WHERE a.id = ?`).get(vdApprovalId);
  if (!a || a.project_id !== projectId) throw new HttpError(404, 'Approved video edit not found for this project');
  const ex = db.prepare(`SELECT * FROM vx_projects WHERE vd_approval_id = ?`).get(a.id);
  if (ex) return ex;
  const id = db.prepare(`INSERT INTO vx_projects (project_id, product_id, variation_index, vd_edit_id, vd_approval_id, created_by) VALUES (?,?,?,?,?,?)`)
    .run(projectId, a.product_id, a.variation_index, a.edit_id, a.id, user.id).lastInsertRowid;
  return vxRow(id);
}

// ---------- Inputs (approved data of Modules 1-6; nothing is typed again) ----------
export function loadInputs(vx) {
  const ap = db.prepare(`SELECT * FROM vd_approvals WHERE id = ?`).get(vx.vd_approval_id);
  if (!ap) throw new HttpError(409, 'The approved video edit of this creative was deleted.');
  const vpkg = JSON.parse(ap.package);
  const edit = vdEditRow(vx.vd_edit_id);
  const base = vdLoadInputs(edit);
  const edl = vpkg.edl;
  const refs = { brief: vpkg.brief, script_version: vpkg.script_version, storyboard_version: vpkg.storyboard_version, audio_package: vpkg.audio_package,
    video: { edit_id: edit.id, version_id: vpkg.video_version.id, version: vpkg.video_version.number, edl_hash: vpkg.video_version.edl_hash, approval_id: ap.id, edl_schema: edl.schema_version } };
  return { ...base, vpkg, edl, edit, approval: ap, refs };
}
export function inputProblems(vx, inputs) {
  const p = vdProblems(inputs.edit, inputs);
  const latest = db.prepare(`SELECT id FROM vd_approvals WHERE edit_id = ? ORDER BY id DESC LIMIT 1`).get(inputs.edit.id);
  if (latest && latest.id !== inputs.approval.id) p.push('The video edit was changed and approved again: open the newest approved video edit.');
  if (inputs.edit.approved_version_id !== inputs.vpkg.video_version.id) p.push('The approved video edit changed: open the newest approved video edit.');
  if (!inputs.edl?.tracks?.video?.length) p.push('The approved editing plan has no clips.');
  return p;
}
export const isOutdated = vx => { try { return inputProblems(vx, loadInputs(vx)).length > 0; } catch { return true; } };
// A plan made from other approved inputs (script, audio alignment or timeline changed) is never rendered or approved.
export function planOutdated(plan, inputs) {
  if (!plan) return '';
  const a = plan.inputs?.video, b = inputs.refs.video;
  if (a?.version_id !== b.version_id || a?.edl_hash !== b.edl_hash) return 'This visual plan was made for another version of the video timeline: regenerate it (Auto Enhance).';
  if (plan.inputs?.audio_package?.version_id !== inputs.refs.audio_package?.version_id) return 'The approved audio changed since this visual plan: regenerate it.';
  if (plan.inputs?.script_version?.id !== inputs.refs.script_version?.id) return 'The approved script changed since this visual plan: regenerate it.';
  return '';
}

// ---------- Brand kits, caption presets, safe zones ----------
const kitOut = k => k && { ...k, fonts: parse(k.fonts, []), logo_visible: !!k.logo_visible, logo_url: k.logo_key ? `/api/brand-kits/${k.id}/logo` : '' };
export const brandKits = () => db.prepare(`SELECT * FROM vx_brand_kits ORDER BY name`).all().map(kitOut);
export const brandKit = id => (id ? kitOut(db.prepare(`SELECT * FROM vx_brand_kits WHERE id = ?`).get(id)) : null);
export function saveBrandKit(id, b, user) {
  const row = id ? db.prepare(`SELECT * FROM vx_brand_kits WHERE id = ?`).get(id) : null;
  if (id && !row) throw new HttpError(404, 'Brand kit not found');
  if (row && row.created_by !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only its author or an admin can change this brand kit');
  const v = { name: cleanText(b.name ?? row?.name ?? '', 60) };
  if (!v.name) throw new HttpError(400, 'Give the brand kit a name');
  for (const k of ['primary_color', 'secondary_color', 'accent_color']) { const c = b[k] ?? row?.[k] ?? ''; if (c && !isHex(c)) throw new HttpError(400, `${k}: use a colour like #FF6B35`); v[k] = c; }
  v.caption_style = b.caption_style ?? row?.caption_style ?? '';
  if (v.caption_style && !CAPTION_STYLES[v.caption_style] && !/^custom:\d+$/.test(v.caption_style)) throw new HttpError(400, 'Unknown caption style');
  v.cta_style = b.cta_style ?? row?.cta_style ?? '';
  if (v.cta_style && !CTA_TEMPLATES[v.cta_style]) throw new HttpError(400, 'Unknown CTA style');
  v.logo_position = b.logo_position ?? row?.logo_position ?? 'top_right';
  if (!['top_left', 'top_right', 'bottom_left', 'bottom_right'].includes(v.logo_position)) throw new HttpError(400, 'Unknown logo position');
  v.logo_visible = (b.logo_visible ?? (row ? !!row.logo_visible : true)) ? 1 : 0;
  v.fonts = JSON.stringify((Array.isArray(b.fonts) ? b.fonts : parse(row?.fonts, [])).filter(f => FONTS[f]).slice(0, 3));
  if (row) { db.prepare(`UPDATE vx_brand_kits SET name=?, primary_color=?, secondary_color=?, accent_color=?, caption_style=?, cta_style=?, logo_position=?, logo_visible=?, fonts=?, updated_at=datetime('now') WHERE id=?`).run(v.name, v.primary_color, v.secondary_color, v.accent_color, v.caption_style, v.cta_style, v.logo_position, v.logo_visible, v.fonts, id); return brandKit(id); }
  const nid = db.prepare(`INSERT INTO vx_brand_kits (name, primary_color, secondary_color, accent_color, caption_style, cta_style, logo_position, logo_visible, fonts, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(v.name, v.primary_color, v.secondary_color, v.accent_color, v.caption_style, v.cta_style, v.logo_position, v.logo_visible, v.fonts, user.id).lastInsertRowid;
  return brandKit(nid);
}
export function customStyles() {
  return new Map(db.prepare(`SELECT * FROM vx_caption_styles ORDER BY id`).all().map(r => [`custom:${r.id}`, { ...checkStyle({ ...CAPTION_STYLES[r.base], ...parse(r.config, {}) }), id: `custom:${r.id}`, name: r.name, base: r.base, builtin: false, created_by: r.created_by }]));
}
export function saveCustomStyle(b, user) {
  const base = CAPTION_STYLES[b.base] ? b.base : 'modern_bold';
  const name = cleanText(b.name, 50);
  if (!name) throw new HttpError(400, 'Give the caption preset a name');
  const cfg = {};
  for (const k of STYLE_FIELDS) if (b.config?.[k] !== undefined) cfg[k] = b.config[k];
  const checked = checkStyle({ ...CAPTION_STYLES[base], ...cfg });
  const keep = Object.fromEntries(Object.keys(cfg).map(k => [k, checked[k]]));
  const id = db.prepare(`INSERT INTO vx_caption_styles (name, base, config, created_by) VALUES (?,?,?,?)`).run(name, base, JSON.stringify(keep), user.id).lastInsertRowid;
  return customStyles().get(`custom:${id}`);
}
export function deleteCustomStyle(id, user) {
  const r = db.prepare(`SELECT * FROM vx_caption_styles WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Preset not found');
  if (r.created_by !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only its author or an admin can delete this preset');
  db.prepare(`DELETE FROM vx_caption_styles WHERE id = ?`).run(id);
}
export function safeZones() {
  const over = new Map(db.prepare(`SELECT key, config, updated_at FROM vx_safe_zones`).all().map(r => [r.key, { ...parse(r.config, {}), updated_at: r.updated_at }]));
  return Object.fromEntries(Object.entries(SAFE_ZONES).map(([k, z]) => [k, { ...z, ...(over.get(k) || {}), key: k, customized: over.has(k) }]));
}
export function saveSafeZone(key, b, user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only an admin can change the safe-zone presets');
  if (!SAFE_ZONES[key]) throw new HttpError(404, 'Unknown preset');
  if (b.reset) { db.prepare(`DELETE FROM vx_safe_zones WHERE key = ?`).run(key); return safeZones()[key]; }
  const cfg = {};
  for (const k of ['top', 'bottom', 'left', 'right']) { const v = Number(b[k]); if (!(v >= 0 && v <= 0.45)) throw new HttpError(400, `${k}: a fraction between 0 and 0.45`); cfg[k] = r3(v); }
  cfg.source = cleanText(b.source || `Updated by ${user.name}`, 300); cfg.verified = !!b.verified;
  db.prepare(`INSERT OR REPLACE INTO vx_safe_zones (key, config, updated_by, updated_at) VALUES (?,?,?, datetime('now'))`).run(key, JSON.stringify(cfg), user.id);
  return safeZones()[key];
}
export function resolveSafeZone(settings, pp, aspect) {
  const all = safeZones();
  const key = settings.safe_zone && all[settings.safe_zone] ? settings.safe_zone : defaultSafeZone(pp.platform?.id, aspect);
  return all[key];
}

// ---------- Versions ----------
export const latestVersion = id => db.prepare(`SELECT * FROM vx_versions WHERE vx_id = ? ORDER BY number DESC LIMIT 1`).get(id);
export const docsOf = v => (v ? { director: parse(v.director, null), plan: parse(v.plan, null), settings: { ...DEFAULT_SETTINGS, ...parse(v.settings, {}) }, validation: parse(v.validation, null) } : { settings: { ...DEFAULT_SETTINGS } });
function newVersion(vxId, from, { label = '', userId = null } = {}) {
  const n = (db.prepare(`SELECT MAX(number) n FROM vx_versions WHERE vx_id = ?`).get(vxId).n || 0) + 1;
  const id = db.prepare(`INSERT INTO vx_versions (vx_id, number, parent_id, label, director, plan, plan_hash, settings, validation, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(vxId, n, from?.id ?? null, label, from?.director || '', from?.plan || '', from?.plan_hash || '', from?.settings || '{}', from?.validation || '', userId).lastInsertRowid;
  const v = db.prepare(`SELECT * FROM vx_versions WHERE id = ?`).get(id);
  if (from?.plan) mirror(id, JSON.parse(from.plan));
  return v;
}
export function workingVersion(vxId, userId = null) {
  const v = latestVersion(vxId);
  if (v && !v.frozen) return v;
  return newVersion(vxId, v, { label: v ? `Draft from v${v.number}` : 'First draft', userId });
}
function mirror(versionId, plan) {
  db.prepare(`DELETE FROM vx_elements WHERE version_id = ?`).run(versionId);
  db.prepare(`DELETE FROM vx_caption_words WHERE version_id = ?`).run(versionId);
  const ie = db.prepare(`INSERT INTO vx_elements (version_id, element_id, type, track, text, start, end, layer, template, animation, enabled, locked, edited, segment_id, clip_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const iw = db.prepare(`INSERT INTO vx_caption_words (version_id, element_id, idx, word, start, end, highlight, timing) VALUES (?,?,?,?,?,?,?,?)`);
  for (const e of plan.elements) {
    ie.run(versionId, e.id, e.type, e.track, e.text || '', e.start, e.end, e.layer || 0, e.template || '', e.animation?.type || '', e.visibility?.enabled === false ? 0 : 1, e.locked ? 1 : 0, e.edited ? 1 : 0, e.segment_id || null, e.clip_id || null);
    (e.words || []).forEach((w, i) => iw.run(versionId, e.id, i, w.text, w.start, w.end, w.hl || '', w.timing || ''));
  }
}
export function saveDocs(versionId, docs) {
  const v = db.prepare(`SELECT frozen FROM vx_versions WHERE id = ?`).get(versionId);
  if (v.frozen) throw new HttpError(409, 'This version is frozen: edit the working draft');
  tx(() => {
    if (docs.director !== undefined) db.prepare(`UPDATE vx_versions SET director = ? WHERE id = ?`).run(JSON.stringify(docs.director), versionId);
    if (docs.settings !== undefined) db.prepare(`UPDATE vx_versions SET settings = ? WHERE id = ?`).run(JSON.stringify(docs.settings), versionId);
    if (docs.plan !== undefined) {
      db.prepare(`UPDATE vx_versions SET plan = ?, plan_hash = ?, validation = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(docs.plan), planHash(docs.plan), JSON.stringify(docs.plan.validation), versionId);
      mirror(versionId, docs.plan);
    }
  });
}

// Products on screen and footage with embedded text, for placement checks.
export function footageFacts(edl, scenes) {
  const clips = edl.tracks.video.filter(c => !c.missing);
  return {
    products: clips.map(c => ({ start: c.timeline_start, end: c.timeline_end, rect: productOnScreen(c, scenes.get(c.scene_id), edl.timeline.width, edl.timeline.height), clip: c })),
    dirty: clips.map(c => { const sc = scenes.get(c.scene_id); const cl = sc ? cleanliness(sc) : { class: 'clean', reasons: [] }; return { start: c.timeline_start, end: c.timeline_end, clip: c, class: cl.class, reasons: cl.reasons }; }).filter(x => x.class !== 'clean'),
  };
}
export function revalidate(plan, inputs) {
  const f = footageFacts(inputs.edl, inputs.scenes);
  const keep = (plan.validation?.warnings || []).filter(w => w.code === 'timing_estimated');
  plan.validation = validatePlan(plan, { ...f, extraWarnings: keep });
  const out = planOutdated(plan, inputs);
  if (out) { plan.validation.errors.unshift({ code: 'outdated', message: out }); plan.validation.valid = false; }
  return plan.validation;
}
// Deterministic plan from saved director decisions (no AI, no voice, no footage analysis).
export function rebuild(vx, inputs, docs, { director = docs.director, settings = docs.settings, keepPrev = true } = {}) {
  const kit = brandKit(settings.brand_kit_id);
  const sz = resolveSafeZone(settings, inputs.pp, inputs.edl.timeline.aspect_ratio);
  const plan = buildPlan({ vx, edl: inputs.edl, pkg: inputs.pkg, pp: inputs.pp, brief: inputs.brief, scenes: inputs.scenes, director, settings, prev: keepPrev ? docs.plan : null,
    customStyles: customStyles(), brandKit: kit, safeZone: sz, refs: inputs.refs });
  revalidate(plan, inputs);
  return plan;
}

// ---------- Team edits (always on the working draft) ----------
export function applyEdit(vxId, body, user) {
  const vx = vxRow(vxId); mustEdit(vx, user);
  if (db.prepare(`SELECT 1 FROM vx_jobs WHERE vx_id = ? AND status IN ('queued','running')`).get(vxId)) throw new HttpError(409, 'A visual job is running: wait for it or cancel it');
  const inputs = loadInputs(vx);
  const v = workingVersion(vxId, user.id);
  const d = docsOf(v);
  if (!d.director || !d.plan) throw new HttpError(400, 'Run Auto Enhance first');
  if (body.settings) {
    const s = { ...d.settings, show: { ...d.settings.show } }, b = body.settings;
    if (b.style_id !== undefined) { if (b.style_id && !CAPTION_STYLES[b.style_id] && !customStyles().has(b.style_id)) throw new HttpError(400, 'Unknown caption style'); s.style_id = b.style_id; if (b.style_id !== d.settings.style_id) s.style_overrides = {}; }
    if (b.style_overrides !== undefined) {
      const o = {};
      for (const [k, val] of Object.entries(b.style_overrides || {})) if (STYLE_FIELDS.includes(k)) o[k] = val;
      if (o.text_color && !isHex(o.text_color)) throw new HttpError(400, 'Text colour: use #RRGGBB');
      if (o.highlight_color && !isHex(o.highlight_color)) throw new HttpError(400, 'Highlight colour: use #RRGGBB');
      if (o.animation && !ANIMATIONS.includes(o.animation.type)) throw new HttpError(400, 'Unknown animation');
      if (o.font && !FONTS[o.font]) throw new HttpError(400, 'Unknown font');
      s.style_overrides = { ...s.style_overrides, ...o };
    }
    if (b.intensity !== undefined) { if (b.intensity !== 'ai' && !INTENSITIES[b.intensity]) throw new HttpError(400, 'Unknown intensity'); s.intensity = b.intensity; }
    if (b.segmentation !== undefined) { if (!SEGMENTATIONS[b.segmentation]) throw new HttpError(400, 'Unknown caption grouping'); s.segmentation = b.segmentation; }
    if (b.caption_position !== undefined) { if (b.caption_position !== 'auto' && !POSITIONS[b.caption_position]) throw new HttpError(400, 'Unknown position'); s.caption_position = b.caption_position; }
    if (b.show) for (const k of Object.keys(DEFAULT_SETTINGS.show)) if (b.show[k] !== undefined) s.show[k] = b.show[k] === null ? null : !!b.show[k];
    if (b.brand_kit_id !== undefined) { if (b.brand_kit_id && !brandKit(Number(b.brand_kit_id))) throw new HttpError(400, 'Brand kit not found'); s.brand_kit_id = b.brand_kit_id ? Number(b.brand_kit_id) : null; }
    if (b.safe_zone !== undefined) { if (b.safe_zone && !SAFE_ZONES[b.safe_zone]) throw new HttpError(400, 'Unknown safe-zone preset'); s.safe_zone = b.safe_zone; }
    if (b.logo_mode !== undefined) { if (!['after_hook', 'closing', 'hidden'].includes(b.logo_mode)) throw new HttpError(400, 'Unknown logo mode'); s.logo_mode = b.logo_mode; }
    const plan = rebuild(vx, inputs, d, { settings: s });
    saveDocs(v.id, { settings: s, plan });
  }
  if (body.element) {
    const plan = docsOf(db.prepare(`SELECT * FROM vx_versions WHERE id = ?`).get(v.id)).plan;
    const b = body.element, e = plan.elements.find(x => x.id === b.id);
    if (!e) throw new HttpError(404, 'Element not found');
    const changing = Object.keys(b).some(k => !['id', 'locked'].includes(k));
    if (e.locked && b.locked !== false && changing) throw new HttpError(409, 'This element is locked: unlock it first');
    const D = plan.output.duration, W = plan.output.width, H = plan.output.height;
    if (b.text !== undefined) {
      const t = cleanText(b.text, e.type === 'caption' ? 120 : VX_LIMITS.maxTextLen);
      if (!t) throw new HttpError(400, 'The text is empty: hide the element instead');
      if (e.type === 'caption') {
        // Corrected caption: same group times; words keep their real times when the count is unchanged, otherwise the
        // group's time is shared by word length (marked "corrected", still inside the spoken group).
        const toks = t.split(' '), old = e.words || [];
        if (toks.length === old.length) e.words = old.map((w, i) => ({ ...w, text: toks[i] }));
        else { const total = toks.reduce((a, x) => a + x.length, 0); let at = e.start; e.words = toks.map(x => { const dd = ((e.end - e.start) * x.length) / total; const w = { text: x, start: r3(at), end: r3(at + dd), timing: 'corrected' }; at += dd; return w; }); }
        const maxChars = VX_LIMITS.maxCharsLine[plan.output.aspect_ratio] || 22;
        const sp = splitLines(toks, Math.round(maxChars * (0.05 / e.font.size)));
        e.lines = []; let n = 0; for (const c of sp) { e.lines.push(toks.slice(n, n + c).join(' ')); n += c; }
        e.correction = { original: e.correction?.original ?? e.text, kind: 'accessibility caption corrected by the team (timing kept from the voice-over)' };
      } else { e.lines = e.lines?.length > 1 && b.lines === undefined ? [t, ...e.lines.slice(1)] : [t]; }
      e.text = t;
      if (hasArabic(t) && !FONTS[e.font?.key]?.scripts.includes('arabic')) e.font = { ...e.font, key: 'cairo-bold', family: FONTS['cairo-bold'].family };
    }
    if (b.start !== undefined || b.end !== undefined) {
      const s = b.start !== undefined ? Number(b.start) : e.start, en = b.end !== undefined ? Number(b.end) : e.end;
      if (!(s >= 0 && en <= D + 0.001 && en - s >= 0.2)) throw new HttpError(400, `Times must be inside the video (0–${D} s) and at least 0.2 s long.`);
      if (e.type === 'caption') throw new HttpError(400, 'Caption times follow the voice-over: correct the text instead.');
      e.start = r3(s); e.end = r3(en); e.start_frame = Math.round(e.start * plan.output.fps); e.end_frame = Math.round(e.end * plan.output.fps);
    }
    if (b.position) {
      if (b.position.preset) { if (!POSITIONS[b.position.preset]) throw new HttpError(400, 'Unknown position'); e.position = { ...fitSafe(POSITIONS[b.position.preset], e.size || { w: 0.5, h: 0.08 }, plan.safe_zone), preset: b.position.preset }; }
      else e.position = { x: r3(clamp(Number(b.position.x) || 0.5, 0, 1)), y: r3(clamp(Number(b.position.y) || 0.5, 0, 1)), preset: 'custom' };
    }
    if (b.font_size !== undefined && e.font) e.font.size = r3(clamp(Number(b.font_size) || e.font.size, VX_LIMITS.minFontFrac, VX_LIMITS.maxFontFrac));
    if (b.colors) for (const k of ['text', 'highlight', 'accent']) if (b.colors[k] !== undefined) { if (!isHex(b.colors[k])) throw new HttpError(400, 'Use colours like #FF6B35'); e.colors[k] = b.colors[k]; }
    if (b.animation !== undefined) { if (!ANIMATIONS.includes(b.animation)) throw new HttpError(400, 'Unknown animation'); e.animation = { ...e.animation, type: b.animation }; }
    if (b.template !== undefined) {
      const lists = { hook: HOOK_TEMPLATES, benefit: BENEFIT_TEMPLATES, feature: BENEFIT_TEMPLATES, price: PRICE_TEMPLATES, offer: PRICE_TEMPLATES, cta: CTA_TEMPLATES };
      if (!lists[e.type]?.[b.template]) throw new HttpError(400, 'Unknown template for this element');
      if (b.template === 'callout' && !e.pointer) throw new HttpError(400, 'A pointer needs the measured product position, not known for this moment.');
      e.template = b.template;
    }
    if (b.enabled !== undefined) e.visibility = { ...e.visibility, enabled: !!b.enabled, rule: b.enabled ? '' : 'hidden by the team' };
    if (b.locked !== undefined) e.locked = !!b.locked;
    if (changing) { e.edited = true; e.source = e.type === 'caption' ? 'voiceover (corrected)' : 'team'; }
    if (e.font && (b.text !== undefined || b.font_size !== undefined)) e.size = textSize(e.lines.map(l => (e.font.uppercase ? l.toUpperCase() : l)), e.font.key, e.font.size, { W, H, uppercase: e.font.uppercase, spacing: 1.1, pad: e.background?.mode === 'box' ? e.background.padding || 0.012 : 0 });
    revalidate(plan, inputs);
    saveDocs(v.id, { plan });
  }
  if (vx.status === 'approved') setStatus(vxId, 'ready');
}

// ---------- Versions: save, restore, compare ----------
export function saveVersion(vxId, user, label = '') {
  const vx = vxRow(vxId); mustEdit(vx, user);
  const v = workingVersion(vxId, user.id);
  db.prepare(`UPDATE vx_versions SET frozen = 1, label = ? WHERE id = ?`).run(String(label).slice(0, 80) || v.label || `Saved v${v.number}`, v.id);
  return newVersion(vxId, db.prepare(`SELECT * FROM vx_versions WHERE id = ?`).get(v.id), { label: `Draft from v${v.number}`, userId: user.id });
}
export function restoreVersion(vxId, versionId, user) {
  const vx = vxRow(vxId); mustEdit(vx, user);
  const src = db.prepare(`SELECT * FROM vx_versions WHERE id = ? AND vx_id = ?`).get(versionId, vxId);
  if (!src) throw new HttpError(404, 'Version not found');
  const cur = latestVersion(vxId);
  if (cur && !cur.frozen) db.prepare(`UPDATE vx_versions SET frozen = 1 WHERE id = ?`).run(cur.id);
  const nv = newVersion(vxId, src, { label: `Restored v${src.number}`, userId: user.id });
  setStatus(vxId, 'ready');
  return nv;
}
export function compareVersions(vxId, a, b) {
  const get = id => { const v = db.prepare(`SELECT * FROM vx_versions WHERE id = ? AND vx_id = ?`).get(id, vxId); if (!v) throw new HttpError(404, 'Version not found'); return { v, plan: parse(v.plan, null) }; };
  const A = get(a), B = get(b);
  const ea = new Map((A.plan?.elements || []).map(e => [e.id, e])), eb = new Map((B.plan?.elements || []).map(e => [e.id, e]));
  const elements = [];
  for (const id of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(id), y = eb.get(id);
    if (!x) elements.push({ id, change: 'added', type: y.type, text: y.text }); else if (!y) elements.push({ id, change: 'removed', type: x.type, text: x.text });
    else { const diff = ['text', 'start', 'end', 'template'].filter(k => x[k] !== y[k]); if (JSON.stringify(x.position) !== JSON.stringify(y.position)) diff.push('position'); if (x.visibility?.enabled !== y.visibility?.enabled) diff.push('visibility'); if (JSON.stringify(x.colors) !== JSON.stringify(y.colors)) diff.push('colours'); if (diff.length) elements.push({ id, change: 'changed', type: y.type, fields: diff, before: x.text, after: y.text }); }
  }
  const renders = id => db.prepare(`SELECT id, quality, status, duration FROM vx_renders WHERE version_id = ? AND status = 'ready' ORDER BY id DESC`).all(id);
  return { a: A.v.number, b: B.v.number, style: [A.plan?.style?.name, B.plan?.style?.name], intensity: [A.plan?.intensity, B.plan?.intensity], elements, renders: [renders(A.v.id), renders(B.v.id)] };
}

// ---------- Approval and the package for Module 8 ----------
export function approve(vxId, renderId, user) {
  const vx = vxRow(vxId); mustEdit(vx, user);
  const v = latestVersion(vxId);
  const r = db.prepare(`SELECT * FROM vx_renders WHERE id = ? AND vx_id = ?`).get(renderId, vxId);
  if (!v || !r) throw new HttpError(404, 'Render not found');
  if (r.version_id !== v.id || r.plan_hash !== v.plan_hash) throw new HttpError(409, 'This render is from an older visual plan: render the current version first.');
  if (r.status !== 'ready' || !r.qc_ok) throw new HttpError(422, 'This render did not pass the quality checks.');
  if (r.quality === 'preview') throw new HttpError(400, 'Approve a Production render (previews are smaller and lighter).');
  const inputs = loadInputs(vx);
  const plan = JSON.parse(v.plan);
  const val = revalidate(plan, inputs);
  const problems = inputProblems(vx, inputs);
  if (problems.length) val.errors.unshift(...problems.map(m => ({ code: 'outdated', message: m })));
  if (val.errors.length) throw Object.assign(new HttpError(422, 'Fix the blocking problems before approving'), { details: val });
  const vp = inputs.vpkg;
  const pkg = {
    schema_version: PACKAGE_VERSION, vx_id: vx.id, project_id: vx.project_id, product_id: vx.product_id, variation_index: vx.variation_index,
    brief: vp.brief, script_version: vp.script_version, storyboard_version: vp.storyboard_version, audio_package: vp.audio_package, video_version: vp.video_version,
    visual_version: { id: v.id, number: v.number, plan_hash: v.plan_hash, schema_version: VX_SCHEMA_VERSION },
    edl: vp.edl, visual_plan: plan, timeline: { video: vp.edl.tracks.video, captions: plan.elements.filter(e => e.type === 'caption'), overlays: plan.elements.filter(e => !['caption', 'effect', 'logo'].includes(e.type)), effects: plan.elements.filter(e => e.type === 'effect'), branding: plan.elements.filter(e => e.type === 'logo') },
    audio_layers: vp.audio_layers, renders: { approved_video_edit: vp.render, preview: db.prepare(`SELECT id, storage_key, quality, width, height FROM vx_renders WHERE version_id = ? AND quality = 'preview' AND status = 'ready' ORDER BY id DESC LIMIT 1`).get(v.id) || null,
      enhanced: { id: r.id, storage_key: r.storage_key, ass_key: r.ass_key, thumb_key: r.thumb_key, quality: r.quality, duration: r.duration, width: r.width, height: r.height, fps: r.fps, vcodec: r.vcodec, acodec: r.acodec, size: r.size, config: parse(r.config, {}) } },
    output: plan.output, qc: parse(r.qc, {}), original_footage_audio: 'excluded', non_destructive: 'Footage, EDL and audio are untouched; the visual layers are separate data (plan + ASS script).',
    approval: { approved_by: user.name, approved_at: new Date().toISOString(), status: 'approved' },
  };
  tx(() => {
    db.prepare(`UPDATE vx_versions SET frozen = 1, approved = 1, label = ?, validation = ? WHERE id = ?`).run(`Approved v${v.number}`, JSON.stringify(val), v.id);
    db.prepare(`INSERT INTO vx_approvals (vx_id, version_id, render_id, package, approved_by) VALUES (?,?,?,?,?)`).run(vxId, v.id, r.id, JSON.stringify(pkg), user.id);
    db.prepare(`UPDATE vx_projects SET approved_version_id = ?, approved_render_id = ?, status = 'approved', error = '', updated_at = datetime('now') WHERE id = ?`).run(v.id, r.id, vxId);
  });
  return pkg;
}
export function latestPackage(vxId) {
  const r = db.prepare(`SELECT * FROM vx_approvals WHERE vx_id = ? ORDER BY id DESC LIMIT 1`).get(vxId);
  return r ? { id: r.id, version_id: r.version_id, render_id: r.render_id, approved_at: r.approved_at, package: JSON.parse(r.package) } : null;
}
// For Module 8: the approved enhanced creative of a project's planned video (only while its inputs are still current).
export function approvedEnhancedPackage(projectId, variationIndex = 1) {
  const x = db.prepare(`SELECT * FROM vx_projects WHERE project_id = ? AND variation_index = ? AND approved_version_id IS NOT NULL ORDER BY vd_approval_id DESC LIMIT 1`).get(projectId, variationIndex);
  if (!x || isOutdated(x)) return null;
  return latestPackage(x.id);
}

// ---------- Everything the page needs ----------
export function vxState(vxId, user) {
  const vx = vxRow(vxId);
  let inputs = null, inErr = '';
  try { inputs = loadInputs(vx); } catch (e) { inErr = e.message; }
  const v = latestVersion(vxId), d = docsOf(v);
  const pp = inputs?.pp, edl = inputs?.edl;
  const renders = db.prepare(`SELECT id, version_id, quality, status, storage_key, thumb_key, duration, width, height, fps, vcodec, acodec, size, qc, qc_ok, render_seconds, plan_hash, created_at FROM vx_renders WHERE vx_id = ? ORDER BY id DESC LIMIT 30`).all(vxId)
    .map(r => ({ ...r, qc: parse(r.qc, null), current: !!v && r.version_id === v.id && r.plan_hash === v.plan_hash, version_number: db.prepare(`SELECT number FROM vx_versions WHERE id = ?`).get(r.version_id)?.number }));
  const job = db.prepare(`SELECT id, kind, target, status, stage, progress, error, failed_stage, attempts, render_id, created_at, finished_at FROM vx_jobs WHERE vx_id = ? ORDER BY id DESC LIMIT 1`).get(vxId) || null;
  const usage = db.prepare(`SELECT COUNT(*) renders, COALESCE(SUM(wall_seconds),0) wall, COALESCE(SUM(output_bytes),0) bytes, COALESCE(MAX(peak_rss_mb),0) rss FROM vx_usage WHERE vx_id = ? AND ok = 1`).get(vxId);
  const ai = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) calls FROM ai_usage WHERE ref = ?`).get(`visual:${vxId}`);
  const problems = inputs ? inputProblems(vx, inputs) : [inErr];
  const stale = d.plan && inputs ? planOutdated(d.plan, inputs) : '';
  const cs = customStyles();
  return {
    vx: { ...vx, outdated: problems.length > 0, problems, can_edit: canEdit(projectRow(vx.project_id), user), plan_outdated: stale },
    context: pp && { product: pp.product?.name, angles: (pp.angles || []).map(a => a.name), creative_type: pp.creative_type?.name, language: pp.target?.language_name, language_code: pp.target?.language, dialect: pp.target?.dialect,
      platform: pp.platform?.name || '', duration: edl.timeline.duration, aspect: edl.timeline.aspect_ratio, output: [edl.timeline.width, edl.timeline.height], fps: edl.timeline.fps, video_version: inputs.refs.video.version,
      price: pp.target?.price ? `${pp.target.price} ${pp.target.currency || ''}`.trim() : '', offer: pp.target?.offer || '', cta: pp.cta || '', cod: !!pp.target?.confirmed?.cash_on_delivery, free_delivery: !!pp.target?.confirmed?.free_delivery,
      captions_in_brief: pp.production?.captions !== false, overlays_in_brief: pp.production?.text_overlays !== false, price_in_brief: !!pp.production?.price_display, cta_in_brief: pp.production?.cta_screen !== false,
      voiceover: !!inputs.pkg.voiceover, base_render: inputs.vpkg.render?.id || null, clips: edl.tracks.video.map(c => ({ id: c.id, order: c.order, start: c.timeline_start, end: c.timeline_end, scene_id: c.scene_id, clean: c.clean || 'clean' })) },
    version: v ? { id: v.id, number: v.number, frozen: !!v.frozen, approved: !!v.approved, label: v.label, plan_hash: v.plan_hash } : null,
    ...d, renders, job, versions: db.prepare(`SELECT id, number, label, frozen, approved, created_at, updated_at FROM vx_versions WHERE vx_id = ? ORDER BY number DESC`).all(vxId),
    usage: { renders: usage.renders, render_seconds: Math.round(usage.wall * 10) / 10, output_mb: Math.round((usage.bytes / 1048576) * 10) / 10, peak_rss_mb: Math.round(usage.rss), ai_usd: Math.round(ai.usd * 1000) / 1000, ai_calls: ai.calls },
    library: { styles: [...Object.values(CAPTION_STYLES), ...cs.values()], fonts: Object.entries(FONTS).map(([k, f]) => ({ key: k, label: f.label, scripts: f.scripts })), animations: ANIMATIONS,
      intensities: Object.fromEntries(Object.entries(INTENSITIES).map(([k, x]) => [k, x.label])), segmentations: Object.keys(SEGMENTATIONS), positions: Object.keys(POSITIONS),
      hook_templates: HOOK_TEMPLATES, benefit_templates: BENEFIT_TEMPLATES, price_templates: PRICE_TEMPLATES, cta_templates: CTA_TEMPLATES, effects: EFFECTS, tracks: TRACKS, safe_zones: safeZones(), brand_kits: brandKits() },
    qualities: Object.fromEntries(Object.entries(QUALITY).map(([k, q]) => [k, { label: q.label, size: outputSize(edl?.timeline.aspect_ratio || '9:16', k) }])),
    package: latestPackage(vxId), statuses: VX_STATUSES, schema_version: VX_SCHEMA_VERSION,
  };
}
