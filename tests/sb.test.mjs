// Module 4: AI Creative Director, script, footage matching, storyboard, validation, versions, approval (test data, test-mode AI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACC_DATA = mkdtempSync(join(tmpdir(), 'acc-sb-'));
process.env.ACC_AI_MOCK = '1';
const { db } = await import('../server/db.js');
const C = await import('../server/creative.js');
const B = await import('../server/creative-brief.js');
const P = await import('../server/sb-plan.js');
const J = await import('../server/sb-jobs.js');
const D = await import('../server/sb-duration.js');
const { validate } = await import('../server/schema.js');
const { SCRIPT_DOC, STORYBOARD_DOC } = await import('../server/sb-schemas.js');

const admin = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('a@t', 'Admin', 'x', 'admin')`).run().lastInsertRowid, role: 'admin', name: 'Admin' };
const member = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('m@t', 'Member', 'x', 'member')`).run().lastInsertRowid, role: 'member', name: 'Member' };
const pid = db.prepare(`INSERT INTO products (name, created_by, description, price, country, language, markets) VALUES ('Watch', ?, 'A crystal watch', '780', 'ZM', 'en', '[{"code":"ZM","price":"780"}]')`).run(admin.id).lastInsertRowid;
const a1 = db.prepare(`INSERT INTO angles (product_id, name, message, hooks, creative_types, selected) VALUES (?, 'Gift', 'The perfect gift', '["h1","h2","h3"]', '[]', 1)`).run(pid).lastInsertRowid;
const asset = db.prepare(`INSERT INTO footage_assets (product_id, name, status, silent, proxy_key, storage_key, orientation, width, height, duration) VALUES (?, 'v', 'completed', 1, 'footage/p1/a1/silent.mp4', 'k', 'vertical', 720, 1280, 60)`).run(pid).lastInsertRowid;
const mk = (start, dur, cats, semantic, extra = {}) => {
  const id = db.prepare(`INSERT INTO footage_scenes (asset_id, product_id, start, end, duration, status, thumb_key) VALUES (?,?,?,?,?, 'analyzed', 't')`).run(asset, pid, start, start + dur, dur).lastInsertRowid;
  db.prepare(`INSERT INTO scene_analyses (scene_id, quality, description, semantic, data, flags) VALUES (?, ?, ?, ?, ?, ?)`).run(id, extra.quality ?? 80, semantic, semantic, JSON.stringify({ product_visible: true, features_shown: extra.features || [] }), JSON.stringify(extra.flags || []));
  for (const c of cats) db.prepare(`INSERT INTO scene_tags (scene_id, kind, tag, source) VALUES (?, 'category', ?, 'ai')`).run(id, c);
  db.prepare(`INSERT INTO scene_angles (scene_id, angle_id, score) VALUES (?,?,70)`).run(id, a1);
  return id;
};
const sc = [
  mk(0, 3, ['hook', 'closeup'], 'close view of the watch on a table'),
  mk(3, 3, ['showcase'], 'hand turns the watch to show the side'),
  mk(6, 4, ['demonstration', 'human'], 'hand shows how the clasp closes'),
  mk(10, 3, ['features', 'closeup'], 'gold finish of the bracelet in close-up', { features: ['gold finish'] }),
  mk(13, 3, ['cta', 'showcase'], 'watch in its gift box'),
  mk(16, 0.6, ['demonstration'], 'very short flash of the watch'),
];
const proj = C.createProject({ productId: pid, user: admin });
C.updateProject(proj, { settings: { types: ['demonstration'], tone: 'persuasive', pace: 'dynamic', hook_styles: ['question'], duration: 20, aspect: '9:16' }, variations: { count: 2, strategies: ['hooks'] } }, admin);
B.saveBrief(proj, admin);
J.startSbWorker();
const waitJob = async planId => { for (let i = 0; i < 200; i++) { const j = db.prepare(`SELECT * FROM sb_jobs WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(planId); if (!['queued', 'running'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 25)); } throw new Error('job timeout'); };

test('duration: language-specific speaking rates, tone and pauses', () => {
  const t = 'Look closely at this watch, it shines every day and fits every outfit you have.';
  const en = D.estimate(t, { lang: 'en' }), sw = D.estimate(t, { lang: 'sw' }), emo = D.estimate(t, { lang: 'en', tone: 'emotional' });
  assert.equal(en.words, 15);
  assert.ok(sw.seconds > en.seconds, 'Swahili rate is slower per word');
  assert.ok(emo.seconds > en.seconds, 'emotional tone is slower');
  assert.ok(D.durationCheck(20, 20).ok && D.durationCheck(26, 20).tooLong && D.durationCheck(14, 20).tooShort);
});

let plan;
test('one-button run: strategy, 5 hooks with an automatic choice, timed script, storyboard on real scenes', async () => {
  plan = P.getOrCreatePlan(proj, 1, admin);
  J.enqueue(plan.id, 'full', admin);
  const job = await waitJob(plan.id);
  assert.equal(job.status, 'completed', job.error);
  const s = P.planState(plan.id, admin);
  assert.ok(s.strategy.main_message);
  assert.equal(s.hooks.items.length, 5);
  assert.ok(s.hooks.items.some(h => h.id === s.hooks.selected) && s.hooks.auto);
  assert.deepEqual(validate(SCRIPT_DOC, s.script), []);
  assert.deepEqual(validate(STORYBOARD_DOC, s.storyboard), []);
  assert.equal(s.script.segments[0].role, 'hook'); assert.equal(s.script.segments.at(-1).role, 'cta');
  let t = 0;
  for (const seg of s.script.segments) { assert.ok(Math.abs(seg.est_start - t) < 0.02); t = seg.est_end; }
  t = 0;
  for (const shot of s.storyboard.shots) {
    const scene = db.prepare(`SELECT * FROM footage_scenes WHERE id = ?`).get(shot.scene_id);
    assert.ok(scene && scene.product_id === pid, 'real scene of this product');
    assert.ok(shot.source_start >= scene.start - 0.01 && shot.source_end <= scene.end + 0.01, 'source inside the scene');
    assert.ok(Math.abs(shot.timeline_start - t) < 0.06 && shot.duration > 0, 'no gap, positive');
    t = shot.timeline_end;
  }
  assert.ok(Math.abs(s.storyboard.total_seconds - s.script.est_seconds) < 0.31);
  assert.equal(s.validation.errors.length, 0, JSON.stringify(s.validation.errors));
});

test('AI scene ids outside the candidates are ignored; short scenes get help; weak matches give missing-footage warnings', () => {
  const { ctx, byId, scenes } = P.loadContext(plan);
  const seg = { id: 'x1', role: 'demonstration', text: 'Watch how the clasp closes.', visual_intent: 'hand closing the clasp', scene_categories: ['demonstration'], est_start: 0, est_end: 5, est_duration: 5, transition: 'hard_cut' };
  const script = { segments: [seg] };
  const cands = P.candidatesFor(ctx, plan, script, scenes);
  const board = P.assembleStoryboard(ctx, script, { x1: [{ scene_id: 999999 }, { scene_id: sc[5] }] }, cands, byId);
  assert.ok(!board.shots.some(s => s.scene_id === 999999), 'invented id never used');
  assert.ok(board.shots.length >= 2, 'a too-short scene (0.6 s) is completed by another scene');
  assert.ok(Math.abs(board.total_seconds - 5) < 0.02);
  for (const s of board.shots) { const x = byId.get(s.scene_id); assert.ok(s.source_end <= x.end + 0.01); }
  // Nothing relevant: no unrelated scene is forced in, a missing-footage note instead.
  const odd = { id: 'x2', role: 'supporting', text: 'Zebras running across the savannah at sunset.', visual_intent: 'zebras', scene_categories: ['lifestyle'], est_start: 0, est_end: 3, est_duration: 3, transition: 'hard_cut' };
  const c2 = P.candidatesFor(ctx, plan, { segments: [odd] }, scenes);
  const b2 = P.assembleStoryboard(ctx, { segments: [odd] }, {}, c2, byId);
  assert.equal(b2.shots.length, 0); assert.equal(b2.missing.length, 1);
});

test('edits: locks survive regeneration, targeted regeneration keeps the rest, scenes are checked', async () => {
  let s = P.planState(plan.id, admin);
  const seg = s.script.segments[1];
  P.applyEdit(plan.id, { segment: { id: seg.id, text: 'Meet the Watch: a gold finish and a gift box.', locked: true } }, admin);
  const keepShot = P.planState(plan.id, admin).storyboard.shots[0];
  P.applyEdit(plan.id, { shot: { id: keepShot.id, locked: true } }, admin);
  J.enqueue(plan.id, 'script', admin);
  assert.equal((await waitJob(plan.id)).status, 'completed');
  s = P.planState(plan.id, admin);
  assert.equal(s.script.segments.find(x => x.id === seg.id).text, 'Meet the Watch: a gold finish and a gift box.');
  assert.ok(s.storyboard.shots.some(x => x.id === keepShot.id && x.scene_id === keepShot.scene_id && x.locked));
  const other = s.storyboard.shots.find(x => !x.locked);
  const rest = s.storyboard.shots.filter(x => x.id !== other.id).map(x => `${x.id}:${x.scene_id}`).join();
  J.enqueue(plan.id, 'shot', admin, { target: other.id });
  assert.equal((await waitJob(plan.id)).status, 'completed');
  s = P.planState(plan.id, admin);
  assert.equal(s.storyboard.shots.filter(x => x.id !== other.id).map(x => `${x.id}:${x.scene_id}`).join(), rest);
  assert.throws(() => P.applyEdit(plan.id, { shot: { id: other.id, scene_id: 999999 } }, admin), /not usable/);
  const scn = s.scenes.find(x => x.id === s.storyboard.shots[1].scene_id);
  assert.throws(() => P.applyEdit(plan.id, { shot: { id: s.storyboard.shots[1].id, source_start: scn.start - 2, source_end: scn.end } }, admin), /Trim inside/);
  assert.throws(() => P.applyEdit(plan.id, { segment: { id: seg.id, text: 'x' } }, member), /author/);
});

test('validation: claims, prices, excluded footage; approval freezes and hands over the production plan', async () => {
  let s = P.planState(plan.id, admin);
  const cta = s.script.segments.at(-1);
  P.applyEdit(plan.id, { segment: { id: cta.id, text: 'Order now with free delivery for only 500 ZMW!' } }, admin);
  let v = P.planState(plan.id, admin).validation;
  assert.ok(v.errors.some(e => e.code === 'claim_free_delivery') && v.errors.some(e => e.code === 'price'));
  assert.throws(() => P.approve(plan.id, admin), /blocking/);
  P.applyEdit(plan.id, { segment: { id: cta.id, text: 'Order now, pay on delivery: 780 ZMW.' } }, admin);
  // A scene excluded later in Module 2 is caught.
  const used = P.planState(plan.id, admin).storyboard.shots[0].scene_id;
  db.prepare(`UPDATE footage_scenes SET excluded = 1 WHERE id = ?`).run(used);
  v = P.planState(plan.id, admin); P.revalidate(plan.id); v = P.planState(plan.id, admin).validation;
  assert.ok(v.errors.some(e => e.code === 'scene_unusable'));
  db.prepare(`UPDATE footage_scenes SET excluded = 0 WHERE id = ?`).run(used);
  P.revalidate(plan.id);
  assert.equal(P.planState(plan.id, admin).validation.errors.length, 0, JSON.stringify(P.planState(plan.id, admin).validation.errors));
  const pp = P.approve(plan.id, admin);
  assert.ok(pp.shots.length && pp.voiceover.segments.length && pp.timing.provisional && pp.footage_audio.startsWith('excluded'));
  s = P.planState(plan.id, admin);
  assert.ok(s.version.approved && s.version.frozen && s.plan.status === 'approved');
  // Editing after approval creates a new draft; the approved version is unchanged.
  const approvedId = s.version.id;
  P.applyEdit(plan.id, { segment: { id: s.script.segments[0].id, text: 'A new hook?' } }, admin);
  s = P.planState(plan.id, admin);
  assert.ok(s.version.id !== approvedId && !s.version.frozen);
  assert.notEqual(JSON.parse(db.prepare(`SELECT script FROM sb_versions WHERE id = ?`).get(approvedId).script).segments[0].text, 'A new hook?');
  assert.ok(P.approvedProductionPlan(proj, 1).production_plan.version.id === approvedId);
  const cmp = P.compareVersions(plan.id, approvedId, s.version.id);
  assert.ok(cmp.script.some(c => c.change === 'changed'));
});

test('generation refuses without AI, without a brief, twice at once; other planned videos get their own plan', async () => {
  delete process.env.ACC_AI_MOCK;
  const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  assert.throws(() => J.enqueue(plan.id, 'script', admin), /AI is not set up/);
  process.env.ACC_AI_MOCK = '1'; if (key) process.env.ANTHROPIC_API_KEY = key;
  const noBrief = C.createProject({ productId: pid, user: admin });
  assert.throws(() => P.getOrCreatePlan(noBrief, 1, admin), /Creative Brief/);
  const p2 = P.getOrCreatePlan(proj, 2, admin);
  assert.notEqual(p2.id, plan.id);
  J.enqueue(p2.id, 'full', admin);
  assert.throws(() => J.enqueue(p2.id, 'script', admin), /already running/);
  assert.equal((await waitJob(p2.id)).status, 'completed');
});
