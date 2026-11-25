// Module 3: creative projects, validation, variation plan, Creative Brief, recommendations (test data in a temp folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACC_DATA = mkdtempSync(join(tmpdir(), 'acc-creative-'));
process.env.ACC_AI_MOCK = '1';
const { db } = await import('../server/db.js');
const C = await import('../server/creative.js');
const B = await import('../server/creative-brief.js');
const { recommend } = await import('../server/creative-ai.js');
const { validate } = await import('../server/schema.js');
const { CREATIVE_TYPES } = await import('../server/creative-types.js');

// Two users, one product with 3 angles, one silent video with 6 analysed scenes, one product without footage.
const admin = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('a@t', 'Admin', 'x', 'admin')`).run().lastInsertRowid, role: 'admin', name: 'Admin' };
const member = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('m@t', 'Member', 'x', 'member')`).run().lastInsertRowid, role: 'member', name: 'Member' };
const pid = db.prepare(`INSERT INTO products (name, created_by, description, price, country, language, markets) VALUES ('Watch', ?, 'A watch', '780', 'ZM', 'en', '[{"code":"ZM","price":"780"}]')`).run(admin.id).lastInsertRowid;
const empty = db.prepare(`INSERT INTO products (name, created_by) VALUES ('Empty', ?)`).run(admin.id).lastInsertRowid;
const angle = (name, sel) => db.prepare(`INSERT INTO angles (product_id, name, message, hooks, creative_types, selected) VALUES (?,?,?,?,?,?)`).run(pid, name, `${name} message`, '["h1","h2","h3"]', '[]', sel).lastInsertRowid;
const [a1, a2, a3] = [angle('Gift', 1), angle('Value', 1), angle('Elegance', 0)];
const asset = db.prepare(`INSERT INTO footage_assets (product_id, name, status, silent, proxy_key, storage_key, orientation, width, height, duration) VALUES (?, 'v', 'completed', 1, 'footage/p1/a1/silent.mp4', 'footage/p1/a1/original.mp4', 'vertical', 720, 1280, 30)`).run(pid).lastInsertRowid;
const cats = [['demonstration'], ['closeup'], ['human'], ['showcase'], ['problem'], ['demonstration', 'human']];
const scenes = cats.map((cs, i) => {
  const id = db.prepare(`INSERT INTO footage_scenes (asset_id, product_id, start, end, duration, status, favorite, thumb_key) VALUES (?,?,?,?,?, 'analyzed', ?, 't')`).run(asset, pid, i * 5, i * 5 + 5, 5, i === 0 ? 1 : 0).lastInsertRowid;
  db.prepare(`INSERT INTO scene_analyses (scene_id, quality, description) VALUES (?, 80, 'scene')`).run(id);
  for (const c of cs) db.prepare(`INSERT INTO scene_tags (scene_id, kind, tag, source) VALUES (?, 'category', ?, 'ai')`).run(id, c);
  db.prepare(`INSERT INTO scene_angles (scene_id, angle_id, score) VALUES (?,?,?)`).run(id, i % 2 ? a1 : a2, 70);
  return id;
});

test('a new project inherits the product and its chosen angles', () => {
  const id = C.createProject({ productId: pid, user: admin });
  const st = C.projectState(id);
  assert.deepEqual(st.angle_ids, [a1, a2]);
  assert.equal(st.settings.market.country, 'ZM'); assert.equal(st.settings.market.currency, 'ZMW'); assert.equal(st.settings.market.price, '780');
  assert.equal(st.footage.used_ids.length, 6);
  assert.equal(st.typeSupport.unboxing, 0); assert.ok(st.typeSupport.demonstration >= 2);
  const v = C.validateProject(st);
  assert.ok(v.errors.some(e => e.code === 'types'));
});

test('footage modes, exclusions and ownership of scenes and angles', () => {
  const id = C.createProject({ productId: pid, user: admin });
  C.updateProject(id, { settings: { footage_mode: 'favorites' } }, admin);
  assert.deepEqual(C.projectState(id).footage.used_ids, [scenes[0]]);
  C.updateProject(id, { settings: { footage_mode: 'manual' }, scenes: { include: [scenes[1], scenes[2]] } }, admin);
  assert.deepEqual(C.projectState(id).footage.used_ids, [scenes[1], scenes[2]]);
  C.updateProject(id, { settings: { footage_mode: 'auto' }, scenes: { include: [], exclude: [scenes[3]] } }, admin);
  assert.equal(C.projectState(id).footage.used_ids.length, 5);
  // A scene excluded in Module 2 is never eligible.
  db.prepare(`UPDATE footage_scenes SET excluded = 1 WHERE id = ?`).run(scenes[5]);
  assert.ok(!C.projectState(id).footage.used_ids.includes(scenes[5]));
  db.prepare(`UPDATE footage_scenes SET excluded = 0 WHERE id = ?`).run(scenes[5]);
  // Records of another product are refused.
  const other = db.prepare(`INSERT INTO angles (product_id, name) VALUES (?, 'x')`).run(empty).lastInsertRowid;
  assert.throws(() => C.updateProject(id, { angle_ids: [other] }, admin), /do not belong/);
  assert.throws(() => C.updateProject(id, { scenes: { include: [999999] } }, admin), /do not belong/);
  // A product without footage: clear blocking error.
  const e = C.createProject({ productId: empty, user: admin });
  assert.ok(C.validateProject(C.projectState(e)).errors.some(x => x.code === 'footage_none'));
});

test('claims must be confirmed; offer type needs a real offer; duration and variation limits', () => {
  const id = C.createProject({ productId: pid, user: admin });
  C.updateProject(id, { settings: { types: ['demonstration'], cta: 'Order now, free delivery!', market: { cod: false } } }, admin);
  let v = C.validateProject(C.projectState(id));
  assert.ok(v.errors.some(e => e.code === 'claim_free_delivery'));
  C.updateProject(id, { settings: { cta: 'Pay on delivery' } }, admin);
  assert.ok(C.validateProject(C.projectState(id)).errors.some(e => e.code === 'claim_cod'));
  C.updateProject(id, { settings: { market: { cod: true }, types: ['offer'] } }, admin);
  assert.ok(C.validateProject(C.projectState(id)).errors.some(e => e.code === 'offer_missing'));
  C.updateProject(id, { settings: { types: ['unboxing'], duration: 2 }, variations: { count: 999, strategies: [] } }, admin);
  v = C.validateProject(C.projectState(id));
  assert.ok(v.errors.some(e => e.code === 'duration')); assert.ok(v.errors.some(e => e.code === 'variations'));
  assert.ok(v.warnings.some(w => w.code === 'type_footage'));
});

test('variation plan: totals, combinations, custom distribution, rotations', () => {
  const id = C.createProject({ productId: pid, user: admin });
  C.updateProject(id, { angle_ids: [a1, a2, a3], settings: { types: ['demonstration', 'features_benefits'], hook_styles: ['question', 'benefit'], pace: 'fast' },
    variations: { count: 10, strategies: ['angles', 'types', 'hooks', 'editing'] } }, admin);
  let p = C.variationPlan(C.projectState(id));
  assert.equal(p.combos.length, 6); assert.equal(p.total, 10); assert.equal(p.videos.length, 10);
  assert.deepEqual(p.combos.map(c => c.count), [2, 2, 2, 2, 1, 1]);
  assert.deepEqual([...new Set(p.videos.map(v => v.hook_style))], ['question', 'benefit']);
  assert.equal(p.videos[0].editing_style, 'fast'); assert.notEqual(p.videos[1].editing_style, 'fast');
  C.updateProject(id, { variations: { count: 10, strategies: ['angles', 'types', 'hooks', 'editing'], distribution: p.combos.map((c, i) => ({ key: c.key, count: i === 0 ? 5 : 1 })) } }, admin);
  p = C.variationPlan(C.projectState(id));
  assert.equal(p.custom, true); assert.equal(p.combos[0].count, 5); assert.equal(p.total, 10);
  C.updateProject(id, { variations: { count: 10, strategies: ['hooks'], distribution: null } }, admin);
  p = C.variationPlan(C.projectState(id));
  assert.equal(p.combos.length, 1); assert.equal(p.combos[0].angle_ids.length, 3);
});

test('Creative Brief: blocked when invalid, versioned, frozen, valid against its schema, revalidated', () => {
  const id = C.createProject({ productId: pid, user: admin });
  assert.throws(() => B.saveBrief(id, admin), /blocking/);
  C.updateProject(id, { settings: { types: ['demonstration'], tone: 'premium', pace: 'balanced', hook_styles: ['question'] }, variations: { count: 3, strategies: ['hooks'] } }, admin);
  const r1 = B.saveBrief(id, admin);
  assert.equal(r1.version, 1);
  assert.deepEqual(validate(B.BRIEF_SCHEMA, r1.brief), []);
  assert.equal(r1.brief.footage.scenes.every(s => s.silent_key.endsWith('silent.mp4')), true);
  assert.equal(r1.brief.production.original_audio, 'excluded');
  assert.equal(r1.brief.creative_types[0].structure.length, 5);
  assert.equal(C.projectState(id).project.status, 'ready');
  // Editing makes it a draft; the saved version does not change, even when the product changes.
  C.updateProject(id, { settings: { tone: 'emotional' } }, admin);
  assert.equal(C.projectState(id).project.status, 'draft');
  db.prepare(`UPDATE products SET name = 'Renamed' WHERE id = ?`).run(pid);
  const r2 = B.saveBrief(id, admin);
  assert.equal(r2.version, 2);
  const v1 = B.getBrief(id, 1).brief;
  assert.equal(v1.style.tone.value, 'premium'); assert.equal(v1.product.name, 'Watch'); assert.equal(B.getBrief(id).brief.product.name, 'Renamed');
  db.prepare(`UPDATE products SET name = 'Watch' WHERE id = ?`).run(pid);
  // Revalidation before generation: a scene excluded later is reported.
  db.prepare(`UPDATE footage_scenes SET excluded = 1 WHERE id = ?`).run(scenes[2]);
  const chk = B.revalidateBrief(v1);
  assert.equal(chk.ok, true); assert.deepEqual(chk.missing_scene_ids, [scenes[2]]);
  db.prepare(`UPDATE footage_scenes SET excluded = 0 WHERE id = ?`).run(scenes[2]);
});

test('permissions and duplicate (no media copied)', () => {
  const id = C.createProject({ productId: pid, user: admin });
  assert.throws(() => C.updateProject(id, { name: 'x' }, member), /author/);
  assert.throws(() => C.deleteProject(id, member), /author/);
  const copy = C.duplicateProject(id, member);
  const st = C.projectState(copy);
  assert.equal(st.project.created_by, member.id); assert.deepEqual(st.angle_ids, C.projectState(id).angle_ids); assert.equal(st.briefs.length, 0);
  const assets = db.prepare(`SELECT COUNT(*) n FROM footage_assets`).get().n;
  assert.equal(assets, 1);
  C.deleteProject(copy, member);
  assert.throws(() => C.projectRow(copy), /not found/);
});

test('AI recommendations: only types the footage supports, cached when nothing changed', async () => {
  const id = C.createProject({ productId: pid, user: admin });
  const r = await recommend(id, admin);
  assert.ok(r.creative_types.length > 0);
  for (const t of r.creative_types) assert.ok(C.projectState(id).typeSupport[t.id] > 0, `${t.id} needs footage`);
  assert.ok(!r.creative_types.some(t => t.id === 'unboxing' || t.id === 'before_after' || t.id === 'offer'));
  const again = await recommend(id, admin);
  assert.equal(again.cached, true);
  const calls = db.prepare(`SELECT COUNT(*) n FROM ai_usage WHERE kind = 'creative-reco'`).get().n;
  assert.equal(calls, 1);
  // "AI Recommended" type resolves to the recommended types in the brief.
  C.updateProject(id, { settings: { types: ['ai_recommended'] } }, admin);
  assert.deepEqual(C.resolvedTypes(C.projectState(id)), r.creative_types.map(t => t.id));
  assert.equal(CREATIVE_TYPES.length, 9);
});
