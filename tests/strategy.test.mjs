// Module 1: schema checks, safe URLs, page extraction, and the analysis → angles → selection flow (test mode, no real AI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'acc-strat-'));
process.env.ACC_DATA = join(dir, 'data');
process.env.ACC_AI_MOCK = '1';
const { validate, forApi } = await import('../server/schema.js');
const { isPrivateIp, checkPublicUrl, extractProduct } = await import('../server/fetchpage.js');
const S = await import('../server/strategy.js');
const { db } = await import('../server/db.js');

const waitJobs = async pid => {
  for (let i = 0; i < 200; i++) {
    if (!db.prepare(`SELECT 1 FROM ai_jobs WHERE product_id = ? AND status = 'running'`).get(pid)) {
      await new Promise(r => setTimeout(r, 80)); // a chained job may start right after
      if (!db.prepare(`SELECT 1 FROM ai_jobs WHERE product_id = ? AND status = 'running'`).get(pid)) return;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('jobs did not finish');
};

test('schema: types, required, limits, no extra fields', () => {
  assert.deepEqual(validate(S.ANGLES_SCHEMA, { angles: [] }), ['$.angles: needs at least 8 items (got 0)']);
  const one = { name: 'Gift', description: '', audience: '', pain_point: '', message: '', emotion: '', hooks: ['a', 'b'], creative_types: ['UGC'], why: '' };
  assert.match(validate(S.ONE_ANGLE_SCHEMA, { angle: one }).join(), /hooks: needs at least 3/);
  assert.match(validate(S.ONE_ANGLE_SCHEMA, { angle: { ...one, hooks: ['a', 'b', 'c'], extra: 1 } }).join(), /extra: not allowed/);
  assert.deepEqual(validate(S.ONE_ANGLE_SCHEMA, { angle: { ...one, hooks: ['a', 'b', 'c'] } }), []);
  assert.ok(!JSON.stringify(forApi(S.ANGLES_SCHEMA)).includes('minItems'));
});

test('URL safety: private and local addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '104.16.0.1']) assert.ok(!isPrivateIp(ip), ip);
  for (const u of ['http://localhost:3100', 'http://127.0.0.1/', 'ftp://x.com', 'http://user:pw@example.com', 'http://169.254.169.254/latest'])
    await assert.rejects(checkPublicUrl(u));
});

test('page extraction: JSON-LD product, meta tags, pictures, text', () => {
  const html = `<html><head><title>Shop | Watch</title><meta property="og:image" content="/img/main.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Luxury Watch &amp; Box","description":"Gold tone, crystal bracelet.",
    "image":["https://cdn.x.com/a.jpg"],"offers":{"@type":"Offer","price":"780","priceCurrency":"ZMW"}}]}</script><style>.x{}</style></head>
    <body><img src="/logo.svg"><img src="https://cdn.x.com/b.jpg" width="800"><img src="/tiny.jpg" width="40"><p>Water resistant 30M</p><script>var a=1</script></body></html>`;
  const p = extractProduct(html, 'https://shop.example.com/p/watch');
  assert.equal(p.name, 'Luxury Watch & Box');
  assert.equal(p.description, 'Gold tone, crystal bracelet.');
  assert.equal(p.price, '780');
  assert.equal(p.currency, 'ZMW');
  assert.deepEqual(p.images, ['https://cdn.x.com/a.jpg', 'https://shop.example.com/img/main.jpg', 'https://cdn.x.com/b.jpg']);
  assert.match(p.text, /Water resistant 30M/);
  assert.doesNotMatch(p.text, /var a=1/);
});

test('flow: analysis → 8-12 angles → edit, custom, select, regenerate one, regenerate all', async () => {
  const pid = db.prepare(`INSERT INTO products (name, description, country, language) VALUES ('Luxury Watch', 'Gold watch with crystal bracelet', 'ZM', 'en')`).run().lastInsertRowid;
  // Nothing to analyse → refused
  const empty = db.prepare(`INSERT INTO products (name) VALUES ('Empty')`).run().lastInsertRowid;
  assert.throws(() => S.startAnalysis(empty, null), /description or pictures/);

  S.startAnalysis(pid, null);
  assert.throws(() => S.startAnalysis(pid, null), /already working/); // no duplicate run
  await waitJobs(pid);
  const st = S.strategyState(pid);
  assert.equal(st.analysis.data.category, 'Fashion accessories');
  assert.ok(st.angles.length >= 8 && st.angles.length <= 12, `${st.angles.length} angles`);
  assert.ok(st.angles.every(a => a.hooks.length === 3));

  const [a1, a2, a3] = st.angles;
  S.updateAngle(a1.id, { selected: true });
  S.updateAngle(a2.id, { name: 'Edited angle', hooks: 'one\ntwo\nthree' });
  const custom = S.addCustomAngle(pid, { name: 'Our own angle', message: 'Pay when you see it', hooks: ['h1', 'h2', 'h3'] }, null);
  assert.throws(() => S.addCustomAngle(pid, { name: ' ' }, null), /name/);

  S.startOneAngle(a3.id, null);
  await waitJobs(pid);
  const after = S.listAngles(pid);
  assert.equal(after.find(a => a.id === a3.id).position, a3.position); // same place, new content
  assert.ok(after.find(a => a.id === a2.id).custom);
  assert.deepEqual(after.find(a => a.id === a2.id).hooks, ['one', 'two', 'three']);

  // Regenerate all: selected (a1), edited (a2) and custom angles stay
  S.startAngles(pid, null);
  await waitJobs(pid);
  const again = S.listAngles(pid);
  for (const id of [a1.id, a2.id, custom]) assert.ok(again.some(a => a.id === id), `kept ${id}`);
  assert.equal(again.filter(a => !a.custom && !a.selected).length, 9);

  assert.equal(S.saveSelection(pid, [a2.id, custom]), 2);
  assert.deepEqual(S.listAngles(pid).filter(a => a.selected).map(a => a.id).sort(), [a2.id, custom].sort());
  // usage is logged
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM ai_usage WHERE product_id = ?`).get(pid).n >= 3);
});

test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
