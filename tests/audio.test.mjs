// Module 5: AI voice-over and background music, against a local fake ElevenLabs server (no key, no paid calls)
// and test-mode AI. Real ffmpeg audio: generation, alignment, duration, music, mixing loudness, storyboard sync, approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACC_DATA = mkdtempSync(join(tmpdir(), 'acc-au-'));
process.env.ACC_AI_MOCK = '1';
const { startFake, calls } = await import('./helpers/fake-elevenlabs.mjs');
const fake = await startFake(0);
process.env.ELEVENLABS_BASE_URL = fake.url;
process.env.ELEVENLABS_API_KEY = 'test-key';
const { db } = await import('../server/db.js');
const C = await import('../server/creative.js');
const B = await import('../server/creative-brief.js');
const SP = await import('../server/sb-plan.js');
const SJ = await import('../server/sb-jobs.js');
const E = await import('../server/eleven.js');
const T = await import('../server/audio-text.js');
const V = await import('../server/audio-voice.js');
const P = await import('../server/audio-production.js');
const J = await import('../server/audio-jobs.js');
const M = await import('../server/audio-media.js');
const { storage } = await import('../server/storage.js');
const { validate } = await import('../server/schema.js');

test.after(() => fake.server.close());
const admin = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('a@t', 'Admin', 'x', 'admin')`).run().lastInsertRowid, role: 'admin', name: 'Admin' };
const member = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('m@t', 'Member', 'x', 'member')`).run().lastInsertRowid, role: 'member', name: 'Member' };
const pid = db.prepare(`INSERT INTO products (name, created_by, description, price, country, language, markets) VALUES ('Watch', ?, 'A crystal watch', '780', 'ZM', 'en', '[{"code":"ZM","price":"780"}]')`).run(admin.id).lastInsertRowid;
const a1 = db.prepare(`INSERT INTO angles (product_id, name, message, hooks, creative_types, selected) VALUES (?, 'Gift', 'The perfect gift', '["h1","h2","h3"]', '[]', 1)`).run(pid).lastInsertRowid;
const asset = db.prepare(`INSERT INTO footage_assets (product_id, name, status, silent, proxy_key, storage_key, orientation, width, height, duration) VALUES (?, 'v', 'completed', 1, 'footage/p1/a1/silent.mp4', 'k', 'vertical', 720, 1280, 60)`).run(pid).lastInsertRowid;
const mk = (start, dur, cats, semantic) => {
  const id = db.prepare(`INSERT INTO footage_scenes (asset_id, product_id, start, end, duration, status, thumb_key) VALUES (?,?,?,?,?, 'analyzed', 't')`).run(asset, pid, start, start + dur, dur).lastInsertRowid;
  db.prepare(`INSERT INTO scene_analyses (scene_id, quality, description, semantic, data, flags) VALUES (?, 80, ?, ?, '{"product_visible":true}', '[]')`).run(id, semantic, semantic);
  for (const c of cats) db.prepare(`INSERT INTO scene_tags (scene_id, kind, tag, source) VALUES (?, 'category', ?, 'ai')`).run(id, c);
  db.prepare(`INSERT INTO scene_angles (scene_id, angle_id, score) VALUES (?,?,70)`).run(id, a1);
  return id;
};
mk(0, 4, ['hook', 'closeup'], 'close view of the watch on a table'); mk(4, 4, ['showcase'], 'hand turns the watch to show the side');
mk(8, 5, ['demonstration', 'human'], 'hand shows how the clasp closes'); mk(13, 4, ['features', 'closeup'], 'gold finish of the bracelet');
mk(17, 4, ['cta', 'showcase'], 'watch in its gift box'); mk(21, 6, ['lifestyle'], 'woman wearing the watch at dinner');
const proj = C.createProject({ productId: pid, user: admin });
C.updateProject(proj, { settings: { types: ['demonstration'], tone: 'persuasive', pace: 'dynamic', hook_styles: ['question'], duration: 20, aspect: '9:16' }, variations: { count: 1, strategies: ['hooks'] } }, admin);
B.saveBrief(proj, admin);
SJ.startSbWorker(); J.startAudioWorker();
const wait = async (table, col, id) => { for (let i = 0; i < 1200; i++) { const j = db.prepare(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY id DESC LIMIT 1`).get(id); if (j && !['queued', 'running'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 25)); } throw new Error('job timeout'); };
const plan = SP.getOrCreatePlan(proj, 1, admin);
SJ.enqueue(plan.id, 'full', admin);
assert.equal((await wait('sb_jobs', 'plan_id', plan.id)).status, 'completed');
SP.approve(plan.id, admin);
const ttsCalls = () => calls.filter(c => c.path.includes('text-to-speech')).length;

test('provider: models by language, voices with paging, voice language fit', async () => {
  const models = await E.models({ force: true });
  assert.ok(models.every(m => m.model_id !== 'eleven_multilingual_sts_v2'), 'only text-to-speech models');
  assert.equal(E.pickModel(models, 'en', 'English').model_id, 'eleven_multilingual_v2');
  assert.equal(E.pickModel(models, 'sw', 'Swahili').model_id, 'eleven_v3', 'Swahili only on v3');
  assert.equal(E.pickModel(models, 'zu', 'Zulu'), null, 'no invented support');
  assert.equal(await E.syncVoices(), 4, 'all pages read');
  const v = E.voiceRows();
  assert.equal(E.voiceLanguageFit(v.find(x => x.voice_id === 'v_en_f'), 'sw').level, 'verified');
  assert.equal(E.voiceLanguageFit(v.find(x => x.voice_id === 'v_fr_f'), 'en').level, 'none');
  assert.equal(E.voiceLanguageFit(v.find(x => x.voice_id === 'v_any'), 'en').level, 'likely');
  process.env.ELEVENLABS_API_KEY = 'wrong';
  await assert.rejects(E.subscription(), /key is wrong/i);
  process.env.ELEVENLABS_API_KEY = 'test-key';
});

test('speech text: prices, currencies, numbers in the target language; script itself unchanged', () => {
  assert.equal(T.speechText('Only 780 ZMW today', 'en', [], 'ZMW'), 'Only seven hundred and eighty kwacha today');
  assert.equal(T.speechText('Bei KES 2,500 tu', 'sw', []), 'Bei shilingi za Kenya elfu mbili na mia tano tu');
  assert.equal(T.speechText('Seulement 15 000 FCFA', 'fr', []), 'Seulement quinze mille francs CFA');
  assert.equal(T.speechText('50% off, K350', 'en', [], 'ZMW'), 'fifty percent off, three hundred and fifty kwacha');
  assert.equal(T.speechText('Get the Xiomi now', 'en', [{ type: 'alias', term: 'Xiomi', spoken: 'Shao-mee' }]), 'Get the Shao-mee now');
  const sp = T.buildSpeech([{ id: 's1', role: 'hook', text: 'Only 780 ZMW.' }, { id: 's2', role: 'cta', text: 'Order now.' }], 'en', [], 'ZMW');
  assert.equal(sp.parts[0].text, 'Only 780 ZMW.');
  assert.equal(sp.text.slice(sp.parts[1].from, sp.parts[1].to), 'Order now.');
});

test('duration rules: fits, slightly long → speed, much too long → shorter script; never cut', () => {
  assert.equal(V.durationPlan(18, 20, 0.25).case, 'fits');
  const s = V.durationPlan(21.5, 20, 0.25);
  assert.equal(s.case, 'slightly_long'); assert.ok(s.speed > 1 && s.speed <= E.SETTING_RANGES.speed[1]);
  const l = V.durationPlan(30, 20, 0.25);
  assert.equal(l.case, 'too_long'); assert.ok(l.final >= 30, 'the video grows instead of cutting speech');
});

let prod;
test('one button: plan, voice, voice-over with real timing, music, mix, synchronized storyboard, checks', async () => {
  const sbp = P.approvedPlans(proj)[0];
  prod = P.getOrCreateProduction(proj, sbp.sb_plan_id, admin);
  assert.throws(() => P.getOrCreateProduction(proj, sbp.sb_plan_id, member), /author/);
  J.enqueue(prod.id, 'full', admin);
  const job = await wait('au_jobs', 'production_id', prod.id);
  assert.equal(job.status, 'completed', job.error + '\n' + job.log);
  const s = P.productionState(prod.id, admin);
  const pp = P.productionPlanOf(prod);
  // Plan and voice
  assert.ok(s.plan.music.prompt && P.STATUSES.includes(s.production.status));
  assert.ok(['v_en_f', 'v_en_m', 'v_any'].includes(s.voice.voice_id), 'an English-capable voice');
  assert.equal(s.voice.model_id, 'eleven_multilingual_v2');
  // Voice-over: real file, real duration, provider timing mapped to every script segment in order
  const vo = s.voiceover;
  assert.equal(vo.alignment_source, 'provider');
  assert.deepEqual(vo.segments.map(x => x.segment_id), pp.voiceover.segments.map(x => x.id));
  const real = (await M.probeAudio(await storage.toLocal(vo.storage_key, join(process.env.ACC_DATA, 'vo.mp3')))).duration;
  assert.ok(Math.abs(real - vo.duration) < 0.05);
  for (let i = 1; i < vo.segments.length; i++) assert.ok(vo.segments[i].start >= vo.segments[i - 1].end - 0.01);
  assert.ok(vo.words.length > 5 && vo.words.every(w => w.end >= w.start));
  // Music: AI, instrumental, licence and provenance stored
  assert.ok(s.music_asset && s.music_asset.source === 'ai' && s.music_asset.license.commercial_use === 'per_plan' && s.music_asset.provider.provider === 'elevenlabs');
  assert.match(s.music_asset.prompt, /no vocals/i);
  // Mix: measured loudness near the target, no clipping
  assert.ok(Math.abs(s.mix.measured.mix.i - s.mix.config.final_lufs) <= 2, JSON.stringify(s.mix.measured));
  assert.ok(s.mix.measured.mix.tp <= -1 + 0.3, `peak ${s.mix.measured.mix.tp}`);
  const mixDur = (await M.probeAudio(await storage.toLocal(s.mix.key, join(process.env.ACC_DATA, 'mix.mp3')))).duration;
  assert.ok(Math.abs(mixDur - s.sync.final_duration) < 0.15, `${mixDur} vs ${s.sync.final_duration}`);
  // Storyboard follows the real speech: contiguous, inside the scenes, to the final length
  let t = 0;
  for (const sh of s.sync.shots) {
    assert.ok(Math.abs(sh.timeline_start - t) < 0.06 && sh.duration > 0);
    const sc = db.prepare(`SELECT * FROM footage_scenes WHERE id = ?`).get(sh.scene_id);
    assert.ok(sh.source_start >= sc.start - 0.01 && sh.source_end <= sc.end + 0.01);
    t = sh.timeline_end;
  }
  assert.ok(Math.abs(t - s.sync.final_duration) < 0.1);
  const first = s.sync.segments[1];
  assert.ok(Math.abs(first.start - first.speech_start) < 0.01, 'segment windows start at the real speech');
  assert.equal(s.validation.errors.length, 0, JSON.stringify(s.validation.errors));
  assert.ok(s.usage.characters > 0 && s.usage.calls >= 2);
});

test('cache: same text, voice and settings reuse the voice-over and the music (no new paid call)', async () => {
  const before = ttsCalls(), musicBefore = calls.filter(c => c.path === '/v1/music').length;
  const vo = P.productionState(prod.id, admin).voiceover.id;
  J.enqueue(prod.id, 'full', admin);
  assert.equal((await wait('au_jobs', 'production_id', prod.id)).status, 'completed');
  assert.equal(ttsCalls(), before);
  assert.equal(calls.filter(c => c.path === '/v1/music').length, musicBefore);
  assert.equal(P.productionState(prod.id, admin).voiceover.id, vo);
});

test('segment regeneration: only that segment is new; timing re-mapped; mix and sync redone', async () => {
  const s0 = P.productionState(prod.id, admin);
  const seg = s0.voiceover.segments[1].segment_id;
  J.enqueue(prod.id, 'segment', admin, { target: seg });
  assert.equal((await wait('au_jobs', 'production_id', prod.id)).status, 'completed');
  const s = P.productionState(prod.id, admin);
  assert.equal(s.voiceover.parent_id, s0.voiceover.id);
  assert.ok(s.voiceover.segments.find(x => x.segment_id === seg).regenerated);
  assert.equal(s.voiceover.segments[0].start, s0.voiceover.segments[0].start, 'earlier segments unchanged');
  assert.ok(!s.mix.stale && !s.sync.stale && s.mix.voiceover_id === s.voiceover.id);
  // Restore the previous take: a choice of the team, the mix has to be redone.
  P.applyEdit(prod.id, { voiceover_id: s0.voiceover.id }, admin);
  assert.ok(P.productionState(prod.id, admin).validation.errors.some(e => e.code === 'mix_stale'));
  J.enqueue(prod.id, 'mix', admin); await wait('au_jobs', 'production_id', prod.id);
  J.enqueue(prod.id, 'sync', admin); await wait('au_jobs', 'production_id', prod.id);
  assert.equal(P.productionState(prod.id, admin).validation.errors.length, 0);
});

test('no alignment from the provider: timing estimated and must be accepted before approval', async () => {
  process.env.FAKE_EL_NO_ALIGN = '1';
  J.enqueue(prod.id, 'voiceover', admin, { options: { force_voice: true } });
  const j = await wait('au_jobs', 'production_id', prod.id);
  delete process.env.FAKE_EL_NO_ALIGN;
  assert.equal(j.status, 'completed', j.error);
  let s = P.productionState(prod.id, admin);
  assert.equal(s.voiceover.alignment_source, 'estimated');
  assert.ok(s.validation.errors.some(e => e.code === 'timing_estimated'));
  assert.equal(s.sync.source, 'estimated');
  P.applyEdit(prod.id, { accept: { estimated_timing: true } }, admin);
  s = P.productionState(prod.id, admin);
  assert.ok(!s.validation.errors.some(e => e.code === 'timing_estimated'));
});

test('AI music refused by the plan: falls back to a library track, never blocks', async () => {
  process.env.FAKE_EL_NO_MUSIC = '1';
  J.enqueue(prod.id, 'music', admin, { options: { force: true } });
  const j = await wait('au_jobs', 'production_id', prod.id);
  delete process.env.FAKE_EL_NO_MUSIC;
  assert.equal(j.status, 'completed', j.error);
  const s = P.productionState(prod.id, admin);
  assert.match(s.music.fallback, /library track/);
  assert.ok(s.music.processed_key && s.mix.key);
  assert.ok(s.validation.warnings.some(w => w.code === 'music_fallback'));
});

test('mixing: voice level wins over music, ducking on, true peak under the ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-'));
  const { ff } = await import('../server/footage-media.js');
  await ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6,volume=0.9', '-ar', '44100', join(dir, 'v.mp3')]);
  await ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=80:duration=10,volume=1.0', '-ar', '44100', join(dir, 'm.mp3')]);
  const r = await M.mix({ voice: join(dir, 'v.mp3'), music: join(dir, 'm.mp3'), out: join(dir, 'o.mp3'), length: 8, cfg: M.MIX_DEFAULTS });
  assert.ok(r.gains.music_db < r.gains.voice_db, JSON.stringify(r.gains));
  assert.ok(r.measured.mix.tp <= -1, `true peak ${r.measured.mix.tp}`);
  assert.ok(Math.abs((await M.probeAudio(join(dir, 'o.mp3'))).duration - 8) < 0.1);
});

test('approval: Audio Production Package matches its schema; footage audio excluded; edits after approval make a draft', async () => {
  assert.throws(() => P.approve(prod.id, member), /author/);
  const pkg = P.approve(prod.id, admin);
  assert.deepEqual(validate(P.PACKAGE_SCHEMA, pkg), []);
  assert.equal(pkg.original_footage_audio, 'excluded');
  assert.ok(pkg.voiceover.segments.length && pkg.captions.words.length && pkg.synchronized_storyboard.shots.length);
  assert.ok(pkg.captions.words[0].start >= pkg.mix.lead_in - 0.01, 'captions on the final timeline');
  assert.ok((await P.checkPackage(pkg)).ok);
  assert.equal(P.approvedAudioPackage(proj, 1).package.audio_version.id, pkg.audio_version.id);
  const approvedId = pkg.audio_version.id;
  P.applyEdit(prod.id, { mix: { music_rel_db: -16 } }, admin);
  const s = P.productionState(prod.id, admin);
  assert.ok(s.version.id !== approvedId && !s.version.frozen);
  assert.ok(P.compareVersions(prod.id, approvedId, s.version.id).changes.length >= 0);
  // The script changes and is approved again in Module 4: this audio is outdated.
  const sp = SP.planState(plan.id, admin);
  SP.applyEdit(plan.id, { segment: { id: sp.script.segments[0].id, text: 'Looking for the perfect gift?' } }, admin);
  SP.approve(plan.id, admin);
  assert.ok(P.isOutdated(P.productionRow(prod.id)));
  assert.ok(P.validateAudio(P.productionRow(prod.id), P.docsOf(P.latestVersion(prod.id))).errors.some(e => e.code === 'outdated'));
  assert.throws(() => J.enqueue(prod.id, 'full', admin), /changed/);
  assert.equal(P.approvedAudioPackage(proj, 1), null, 'no package for the new script until its audio is approved');
});

test('cancel stops a running job; music library: upload rules and delete only when unused', async () => {
  const sbp = P.approvedPlans(proj)[0];
  const p2 = P.getOrCreateProduction(proj, sbp.sb_plan_id, admin);
  assert.notEqual(p2.id, prod.id);
  J.enqueue(p2.id, 'full', admin);
  J.cancel(p2.id, admin);
  const j = await wait('au_jobs', 'production_id', p2.id);
  assert.equal(j.status, 'cancelled');
  const used = P.musicLibrary().find(m => m.used > 0);
  await assert.rejects(P.deleteMusic(used.id, admin), /used by/);
});
