// Module 7: AI captions & visual effects on a real approved Module 6 edit (same chain as tests/video.test.mjs:
// real ffmpeg footage, test-mode AI, fake ElevenLabs), then Visual Director, plan, real MP4 renders with burnt-in
// captions and graphics, measured visual QC, targeted edits, versions, approval and the Module 8 package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.ACC_DATA = mkdtempSync(join(tmpdir(), 'acc-vx-'));
process.env.ACC_AI_MOCK = '1';
const { startFake, calls } = await import('./helpers/fake-elevenlabs.mjs');
const fake = await startFake(0);
process.env.ELEVENLABS_BASE_URL = fake.url;
process.env.ELEVENLABS_API_KEY = 'test-key';
const { db } = await import('../server/db.js');
const { TMP_DIR } = await import('../server/paths.js');
const { storage } = await import('../server/storage.js');
const C = await import('../server/creative.js');
const B = await import('../server/creative-brief.js');
const SP = await import('../server/sb-plan.js');
const SJ = await import('../server/sb-jobs.js');
const AP = await import('../server/audio-production.js');
const AJ = await import('../server/audio-jobs.js');
const VP = await import('../server/video-production.js');
const VJ = await import('../server/video-jobs.js');
const VE = await import('../server/video-edl.js');
const VR = await import('../server/video-render.js');
const VS = await import('../server/video-schemas.js');
const { validate } = await import('../server/schema.js');
const ffmpeg = (await import('ffmpeg-static')).default;
test.after(() => fake.server.close());

// ---------- Test footage ----------
const dir = mkdtempSync(join(tmpdir(), 'vx-src-'));
const ff = args => { const r = spawnSync(process.env.FFMPEG_PATH || ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status) throw new Error(String(r.stderr)); };
const mk = (name, { w, h, fps, dur, codec = 'libx264', audio = false, vfr = false }) => {
  const out = join(dir, name);
  const v = ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${dur}`];
  const a = audio ? ['-f', 'lavfi', '-i', `sine=frequency=900:duration=${dur}`] : [];
  ff([...v, ...a, ...(vfr ? ['-vf', "select='not(mod(n\\,5))'", '-vsync', 'vfr'] : []), '-c:v', codec, ...(codec === 'libx264' ? ['-pix_fmt', 'yuv420p', '-preset', 'ultrafast'] : ['-q:v', '5']), ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']), out]);
  return out;
};
const silent = (src, name) => { const out = join(dir, name); ff(['-i', src, '-map', '0:v:0', '-c', 'copy', '-an', out]); return out; };
const A_orig = mk('a.mp4', { w: 1080, h: 1920, fps: 30, dur: 12, audio: true }); const A_proxy = join(dir, 'a-proxy.mp4'); ff(['-i', A_orig, '-map', '0:v:0', '-vf', 'scale=720:1280', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', A_proxy]);
const B_orig = mk('b.mp4', { w: 1280, h: 720, fps: 25, dur: 10, codec: 'mpeg4', audio: true }); const B_proxy = silent(B_orig, 'b-proxy.mp4');
const C_orig = mk('c.mp4', { w: 640, h: 640, fps: 24, dur: 8, vfr: true }); const C_proxy = silent(C_orig, 'c-proxy.mp4');

const admin = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('a@t', 'Admin', 'x', 'admin')`).run().lastInsertRowid, role: 'admin', name: 'Admin' };
const member = { id: db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES ('m@t', 'Member', 'x', 'member')`).run().lastInsertRowid, role: 'member', name: 'Member' };
const pid = db.prepare(`INSERT INTO products (name, created_by, description, price, country, language, markets) VALUES ('Watch', ?, 'A crystal watch', '780', 'ZM', 'en', '[{"code":"ZM","price":"780"}]')`).run(admin.id).lastInsertRowid;
const a1 = db.prepare(`INSERT INTO angles (product_id, name, message, hooks, creative_types, selected) VALUES (?, 'Gift', 'The perfect gift', '["h1","h2","h3"]', '[]', 1)`).run(pid).lastInsertRowid;
const asset = async (name, orig, proxy, w, h, fps, dur, orientation) => {
  const id = db.prepare(`INSERT INTO footage_assets (product_id, name, status, silent, proxy_key, storage_key, orientation, width, height, fps, duration, has_audio) VALUES (?,?, 'completed', 1, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(pid, name, `footage/p${pid}/${name}/silent.mp4`, `footage/p${pid}/${name}/original.mp4`, orientation, w, h, fps, dur).lastInsertRowid;
  await storage.put(`footage/p${pid}/${name}/original.mp4`, orig, 'video/mp4');
  await storage.put(`footage/p${pid}/${name}/silent.mp4`, proxy, 'video/mp4');
  return id;
};
const scene = (assetId, start, dur, cats, semantic, details = {}) => {
  const id = db.prepare(`INSERT INTO footage_scenes (asset_id, product_id, start, end, duration, status, thumb_key) VALUES (?,?,?,?,?, 'analyzed', 't')`).run(assetId, pid, start, start + dur, dur).lastInsertRowid;
  db.prepare(`INSERT INTO scene_analyses (scene_id, quality, description, semantic, data, flags) VALUES (?, 80, ?, ?, ?, '[]')`).run(id, semantic, semantic, JSON.stringify({ product_visible: true, composition: 'product centred', ...details }));
  for (const c of cats) db.prepare(`INSERT INTO scene_tags (scene_id, kind, tag, source) VALUES (?, 'category', ?, 'ai')`).run(id, c);
  db.prepare(`INSERT INTO scene_angles (scene_id, angle_id, score) VALUES (?,?,70)`).run(id, a1);
  return id;
};
const aA = await asset('a', A_orig, A_proxy, 1080, 1920, 30, 12, 'vertical');
const aB = await asset('b', B_orig, B_proxy, 1280, 720, 25, 10, 'horizontal');
const aC = await asset('c', C_orig, C_proxy, 640, 640, 24, 8, 'square');
const sc = {
  hook: scene(aA, 0, 4, ['hook', 'closeup'], 'close view of the watch on a table'), show: scene(aA, 4, 4, ['showcase'], 'hand turns the watch to show the side'),
  demo: scene(aA, 8, 4, ['demonstration', 'human'], 'hand shows how the clasp closes'), feat: scene(aB, 0, 5, ['features', 'closeup'], 'gold finish of the bracelet'),
  life: scene(aB, 5, 5, ['lifestyle'], 'woman wearing the watch at dinner', { watermark: { present: true, text: '@seller' } }), cta: scene(aC, 0, 4, ['cta', 'showcase'], 'watch in its gift box'),
  box: scene(aC, 4, 4, ['showcase'], 'gift box opened'),
};
const proj = C.createProject({ productId: pid, user: admin });
C.updateProject(proj, { settings: { types: ['demonstration'], tone: 'persuasive', pace: 'dynamic', hook_styles: ['question'], duration: 15, aspect: '9:16' }, variations: { count: 1, strategies: ['hooks'] } }, admin);
B.saveBrief(proj, admin);
const XP = await import('../server/vx-production.js');
const XJ = await import('../server/vx-jobs.js');
const XR = await import('../server/vx-render.js');
const XC = await import('../server/vx-captions.js');
const XA = await import('../server/vx-ass.js');
const XPL = await import('../server/vx-plan.js');
SJ.startSbWorker(); AJ.startAudioWorker(); VJ.startVideoWorker(); XJ.startVisualWorker();
const wait = async (table, col, id, ms = 240000) => { for (let i = 0; i < ms / 50; i++) { const j = db.prepare(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY id DESC LIMIT 1`).get(id); if (j && !['queued', 'running'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('job timeout'); };
const plan = SP.getOrCreatePlan(proj, 1, admin);
SJ.enqueue(plan.id, 'full', admin); assert.equal((await wait('sb_jobs', 'plan_id', plan.id)).status, 'completed');
SP.approve(plan.id, admin);
const prod = AP.getOrCreateProduction(proj, plan.id, admin);
AJ.enqueue(prod.id, 'full', admin);
{ const j = await wait('au_jobs', 'production_id', prod.id); assert.equal(j.status, 'completed', j.error); }
AP.approve(prod.id, admin);
const edit = VP.getOrCreateEdit(proj, VP.readyVideos(proj)[0].au_approval_id, admin);
VJ.enqueue(edit.id, 'full', admin, { target: 'standard' });
{ const j = await wait('vd_jobs', 'edit_id', edit.id); assert.equal(j.status, 'completed', j.error); VP.approve(edit.id, j.render_id, admin); }
const elCalls = () => calls.filter(c => /text-to-speech|music|speech-to-text/.test(c.path)).length;
const aiCalls = () => db.prepare(`SELECT COUNT(*) n FROM ai_usage WHERE kind = 'visual-director'`).get().n;
const audioPkg = AP.latestPackage(prod.id).package;

test('captions: written words keep the real voice timing; groups, protected prices, highlights, safe text', () => {
  const spoken = [{ word: 'Only', start: 1, end: 1.3, segment_id: 's1' }, { word: 'one', start: 1.35, end: 1.5, segment_id: 's1' }, { word: 'thousand', start: 1.5, end: 1.9, segment_id: 's1' },
    { word: 'two', start: 1.95, end: 2.1, segment_id: 's1' }, { word: 'hundred', start: 2.1, end: 2.4, segment_id: 's1' }, { word: 'kwacha', start: 2.45, end: 2.9, segment_id: 's1' }, { word: 'today.', start: 2.95, end: 3.3, segment_id: 's1' }];
  const dw = XC.displayWords({ source: 'provider', words: spoken, segments: [{ segment_id: 's1' }] }, [{ id: 's1', text: 'Only 1,200 ZMW today.', role: 'offer' }]);
  assert.deepEqual(dw.words.map(w => w.text), ['Only', '1,200', 'ZMW', 'today.']);
  assert.equal(dw.words[0].start, 1); assert.equal(dw.words[3].end, 3.3); assert.equal(dw.words[0].timing, 'exact');
  assert.ok(dw.words[1].start >= 1.35 - 0.001 && dw.words[2].end <= 2.9 + 0.001, 'the price takes the time of its spoken words');
  assert.ok(dw.exact);
  const keep = XC.protectedPairs(dw.words, { currency: 'ZMW' });
  const g = XC.groupCaptions(dw.words, { mode: 'two', maxChars: 20, keepTogether: keep, duration: 10 });
  assert.ok(g.some(x => x.words.map(w => w.text).join(' ').includes('1,200 ZMW')), 'number and currency stay together');
  assert.equal(XC.groupCaptions(dw.words, { mode: 'word', maxChars: 20, duration: 10 }).length, 4);
  assert.equal(XC.displayWords({ source: 'estimated', words: spoken, segments: [{ segment_id: 's1' }] }, []).exact, false, 'estimated timing is never called exact');
  assert.equal(XC.cleanText('{\\pos(0,0)\\fs300}Hi\\N'), '(/pos(0,0)/fs300)Hi/N', 'text can never carry ASS commands');
  assert.equal(XC.formatPrice('1200', 'ZMW', 'en'), '1,200 ZMW');
  assert.equal(XC.formatPrice('1200', 'TSh', 'sw'), 'TSh 1,200');
  const ctx = { sources: 'A crystal watch, the perfect gift', confirmed: { cash_on_delivery: true }, price: '780 ZMW' };
  assert.match(XC.unsupportedClaim('50% off today', ctx), /number 50/);
  assert.match(XC.unsupportedClaim('1 year guarantee', ctx), /number|guarantee/);
  assert.match(XC.unsupportedClaim('Free delivery', ctx), /free delivery/);
  assert.match(XC.unsupportedClaim('5 stars reviews', ctx), /number|review/);
  assert.equal(XC.unsupportedClaim('The perfect gift', ctx), '');
  assert.equal(XC.unsupportedClaim('Only 780 ZMW', ctx), '');
});

let x, first;
test('Auto Enhance: approved package → AI visual plan → captions on real word times → real MP4 with measured visual QC', async () => {
  const ready = XP.readyEdits(proj);
  assert.equal(ready.length, 1); assert.ok(ready[0].latest);
  assert.throws(() => XP.getOrCreate(proj, ready[0].vd_approval_id, member), /author/);
  x = XP.getOrCreate(proj, ready[0].vd_approval_id, admin);
  const el0 = elCalls(), ai0 = aiCalls();
  const id1 = XJ.enqueue(x.id, 'auto', admin, { target: 'preview' });
  assert.equal(XJ.enqueue(x.id, 'auto', admin, { target: 'preview' }), id1, 'a second click returns the same job');
  const j = await wait('vx_jobs', 'vx_id', x.id);
  assert.equal(j.status, 'completed', `${j.error}\n${j.log}`);
  assert.equal(elCalls(), el0, 'no ElevenLabs request (no new voice, no transcription)');
  assert.equal(aiCalls(), ai0 + 1, 'one Visual Director call');
  const s = XP.vxState(x.id, admin), p = s.plan;
  assert.equal(p.validation.errors.length, 0, JSON.stringify(p.validation.errors));
  assert.equal(p.schema_version, '1.0');
  assert.equal(p.inputs.video.version_id, db.prepare(`SELECT approved_version_id FROM vd_edits WHERE id = ?`).get(edit.id).approved_version_id);
  const caps = p.elements.filter(e => e.type === 'caption');
  assert.ok(caps.length >= 3);
  const starts = new Set(audioPkg.captions.words.map(w => w.start));
  for (const c of caps) { assert.ok(starts.has(c.start) || c.words[0].timing !== 'exact', `caption ${c.id} starts on a spoken word`); assert.ok(c.end <= p.output.duration && c.end > c.start); assert.ok(c.words.length <= 5); }
  assert.ok(p.caption.exact_word_timing);
  for (let i = 1; i < caps.length; i++) assert.ok(caps[i].start >= caps[i - 1].end - 0.001, 'one caption group at a time');
  assert.ok(caps.filter(c => c.words.some(w => w.hl)).length <= Math.ceil(caps.length * 0.4), 'not every group highlighted');
  const cta = p.elements.find(e => e.type === 'cta');
  assert.ok(cta && Math.abs(cta.end - p.output.duration) < 0.001 && cta.end - cta.start >= 2, 'CTA readable until the end');
  for (const e of p.elements) assert.ok(e.start >= 0 && e.end <= p.output.duration + 0.034 && e.id && e.track && e.layer !== undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM vx_elements WHERE version_id = ?`).get(s.version.id).n, p.elements.length);
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM vx_caption_words WHERE version_id = ?`).get(s.version.id).n >= caps.length);
  first = s.renders.find(r => r.status === 'ready');
  assert.ok(first && first.qc_ok, JSON.stringify(first?.qc?.errors));
  const local = await storage.toLocal(first.storage_key, join(process.env.ACC_DATA, 'x.mp4'));
  const info = await VR.probeVideo(local);
  assert.equal(info.video.width, 540); assert.equal(info.video.height, 960); assert.equal(info.video.fps, 30);
  assert.equal(info.audio_streams, 1); assert.ok(Math.abs(info.duration - p.output.duration) < 0.1);
  assert.ok(Math.abs(info.video.frames - p.output.frames) <= 2);
  const vq = first.qc.measured.visual;
  assert.ok(vq.elements_checked >= caps.length, 'every caption measured on screen in its window');
  assert.ok(vq.fonts.length >= 1 && vq.fonts.every(f => !/Arial|DejaVu|Segoe/.test(f)), vq.fonts.join());
  // Text really burnt in: the frame differs from the approved Module 6 render at a caption time.
  const vdR = db.prepare(`SELECT storage_key FROM vd_renders WHERE id = (SELECT approved_render_id FROM vd_edits WHERE id = ?)`).get(edit.id);
  const base = await storage.toLocal(vdR.storage_key, join(process.env.ACC_DATA, 'base.mp4'));
  const t = ((caps[0].start + caps[0].end) / 2).toFixed(2);
  const diff = spawnSync(ffmpeg, ['-hide_banner', '-ss', t, '-i', local, '-ss', t, '-i', base, '-filter_complex', '[1:v]scale=540:960[b];[0:v][b]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YMAX', '-frames:v', '1', '-f', 'null', '-']);
  const ymax = Number(String(diff.stderr).match(/YMAX=(\d+)/)?.[1] || 0);
  assert.ok(ymax > 60, `captions visible in the frame (difference ${ymax})`);
  assert.ok(await storage.exists(first.storage_key.replace('.mp4', '.ass')), 'the ASS overlay script is stored for Module 8');
  assert.equal(readdirSync(TMP_DIR).filter(f => f.startsWith('vx-')).length, 0, 'temporary folder removed');
});

test('style, colour and intensity changes: no AI, no ElevenLabs; render cache; locked and edited elements kept', async () => {
  const ai0 = aiCalls(), el0 = elCalls();
  const st0 = XP.vxState(x.id, admin).plan;
  const hook = st0.elements.find(e => e.type === 'hook') || st0.elements.find(e => e.type === 'cta');
  XP.applyEdit(x.id, { element: { id: hook.id, text: 'The gift she keeps', locked: true } }, admin);
  for (const [style, intensity] of [['luxury', 'minimal'], ['modern_bold', 'balanced'], ['dynamic_pop', 'dynamic']]) {
    XP.applyEdit(x.id, { settings: { style_id: style, intensity } }, admin);
    const p = XP.vxState(x.id, admin).plan;
    assert.equal(p.style.id, style); assert.equal(p.intensity, intensity);
    assert.equal(p.elements.find(e => e.id === hook.id).text, 'The gift she keeps', 'locked element kept');
  }
  XP.applyEdit(x.id, { settings: { style_overrides: { text_color: '#FFEE00', animation: { type: 'karaoke', duration_ms: 120 } } } }, admin);
  const p = XP.vxState(x.id, admin).plan;
  assert.equal(p.elements.find(e => e.type === 'caption').colors.text, '#FFEE00');
  assert.ok(p.elements.filter(e => e.type === 'effect').length >= 1, 'dynamic intensity adds purposeful effects');
  assert.throws(() => XP.applyEdit(x.id, { settings: { style_overrides: { animation: { type: 'strobe' } } } }, admin), /Unknown animation/);
  assert.throws(() => XP.applyEdit(x.id, { settings: { style_overrides: { text_color: 'red;}' } } }, admin), /colour/);
  assert.equal(aiCalls(), ai0, 'style changes are deterministic');
  // Karaoke: one ASS event per spoken word.
  const ass = XA.planToAss(p, 540, 960);
  const words = p.elements.filter(e => e.type === 'caption').reduce((a, e) => a + e.words.length, 0);
  assert.ok((ass.match(/Dialogue: 5,/g) || []).length >= words);
  XJ.enqueue(x.id, 'render', admin, { target: 'preview' });
  const j = await wait('vx_jobs', 'vx_id', x.id);
  assert.equal(j.status, 'completed', j.error);
  XJ.enqueue(x.id, 'render', admin, { target: 'preview' });
  assert.match((await wait('vx_jobs', 'vx_id', x.id)).log, /reused/);
  assert.equal(elCalls(), el0);
  // Regenerating only the hook (AI) keeps the locked element.
  XJ.enqueue(x.id, 'plan', admin, { options: { parts: ['hook'] } });
  assert.equal((await wait('vx_jobs', 'vx_id', x.id)).status, 'completed');
  assert.equal(XP.vxState(x.id, admin).plan.elements.find(e => e.id === hook.id).text, 'The gift she keeps');
});

test('caption correction keeps the voice timing; times, positions and templates are validated; text is never a command', () => {
  const p = XP.vxState(x.id, admin).plan;
  const c = p.elements.find(e => e.type === 'caption' && e.words.length >= 2);
  XP.applyEdit(x.id, { element: { id: c.id, text: c.words.map(w => w.text).reverse().join(' ') } }, admin);
  let n = XP.vxState(x.id, admin).plan.elements.find(e => e.id === c.id);
  assert.deepEqual(n.words.map(w => w.start), c.words.map(w => w.start), 'same word count: real word times kept');
  assert.ok(n.edited && n.correction);
  XP.applyEdit(x.id, { element: { id: c.id, text: '{\\fs200\\pos(0,0)}Injected text here now' } }, admin);
  n = XP.vxState(x.id, admin).plan.elements.find(e => e.id === c.id);
  assert.equal(n.start, c.start); assert.equal(n.end, c.end);
  assert.ok(n.words.every(w => w.start >= c.start - 0.001 && w.end <= c.end + 0.001), 'new words share the group time');
  const ass = XA.planToAss(XP.vxState(x.id, admin).plan, 540, 960);
  assert.ok(!ass.includes('\\fs200') && !ass.includes('\\pos(0,0)}Injected'), 'no command from text');
  assert.throws(() => XP.applyEdit(x.id, { element: { id: c.id, start: 0 } }, admin), /voice-over/);
  const cta = XP.vxState(x.id, admin).plan.elements.find(e => e.type === 'cta');
  assert.throws(() => XP.applyEdit(x.id, { element: { id: cta.id, start: -1, end: 2 } }, admin), /inside the video/);
  assert.throws(() => XP.applyEdit(x.id, { element: { id: cta.id, template: 'fake_button' } }, admin), /Unknown template/);
  XP.applyEdit(x.id, { element: { id: cta.id, position: { preset: 'top' } } }, admin);
  const moved = XP.vxState(x.id, admin).plan;
  const e2 = moved.elements.find(e => e.id === cta.id);
  assert.ok(e2.position.y - e2.size.h / 2 >= moved.safe_zone.top - 0.001, 'kept inside the safe zone');
  XP.applyEdit(x.id, { element: { id: cta.id, enabled: false } }, admin);
  assert.equal(XP.vxState(x.id, admin).plan.elements.find(e => e.id === cta.id).visibility.enabled, false);
  XP.applyEdit(x.id, { element: { id: cta.id, enabled: true } }, admin);
});

test('captions off, voice-over missing, outdated plan, collision checks', () => {
  XP.applyEdit(x.id, { settings: { show: { captions: false } } }, admin);
  assert.equal(XP.vxState(x.id, admin).plan.elements.filter(e => e.type === 'caption').length, 0);
  XP.applyEdit(x.id, { settings: { show: { captions: null } } }, admin);
  assert.ok(XP.vxState(x.id, admin).plan.elements.some(e => e.type === 'caption'), 'back to the brief (captions on)');
  assert.equal(XC.displayWords(null, []).words.length, 0, 'no voice-over: no captions, with a note');
  const s = XP.vxState(x.id, admin);
  const inputs = XP.loadInputs(XP.vxRow(x.id));
  assert.equal(XP.planOutdated(s.plan, inputs), '');
  assert.match(XP.planOutdated({ ...s.plan, inputs: { ...s.plan.inputs, video: { ...s.plan.inputs.video, edl_hash: 'other' } } }, inputs), /another version/);
  const p = structuredClone(s.plan);
  const a = p.elements.find(e => e.type === 'cta'), cap = p.elements.find(e => e.type === 'caption');
  p.elements.push({ ...a, id: 'dup', type: 'offer', track: 'promo', text: 'Same place', start: a.start, end: a.end });
  p.elements.push({ ...cap, id: 'tiny', font: { ...cap.font, size: 0.01 } });
  const v = XPL.validatePlan(p);
  assert.ok(v.warnings.some(w => w.code === 'overlap'));
  assert.ok(v.errors.some(e => e.code === 'font_size'));
});

test('Arabic (right to left, shaped) and French accents: real MP4 with every glyph found', async () => {
  const inputs = XP.loadInputs(XP.vxRow(x.id));
  for (const [lang, texts] of [['ar', ['هادي هي الساعة الفاخرة', 'اطلب دابا', 'الدفع عند الاستلام']], ['fr', ['Le cadeau idéal à 780 ZMW', 'Commandez maintenant', 'Paiement à la livraison']]]) {
    const p = structuredClone(XP.vxState(x.id, admin).plan);
    let k = 0;
    for (const e of p.elements.filter(e => ['caption', 'hook', 'cta'].includes(e.type))) {
      const t = texts[k++ % texts.length];
      e.text = t; e.lines = [t];
      if (e.type === 'caption') e.words = t.split(' ').map((w, i, a) => ({ text: w, start: e.start + ((e.end - e.start) * i) / a.length, end: e.start + ((e.end - e.start) * (i + 1)) / a.length }));
      if (lang === 'ar') e.font = { ...e.font, key: 'cairo-bold', family: 'Cairo', uppercase: false };
    }
    assert.ok(XPL.validatePlan(p).errors.every(er => er.code !== 'font_script'));
    const work = join(process.env.ACC_DATA, `lang-${lang}`);
    const res = await XR.renderEnhanced({ plan: p, edl: inputs.edl, quality: 'preview', work, ctx: null, stage: () => {}, log: () => {}, scenes: inputs.scenes, projectId: x.project_id });
    const q = await XR.visualQc(p, { work, W: 540, H: 960 });
    assert.deepEqual(q.errors, [], `${lang}: ${JSON.stringify(q.errors)}`);
    if (lang === 'ar') assert.ok(q.measured.fonts.some(f => /Cairo/.test(f)), q.measured.fonts.join());
    assert.equal((await VR.probeVideo(res.file)).video.width, 540);
  }
  const bad = structuredClone(XP.vxState(x.id, admin).plan);
  bad.elements.find(e => e.type === 'caption').text = 'مرحبا';
  assert.ok(XPL.validatePlan(bad).errors.some(e => e.code === 'font_script'), 'Arabic in a Latin-only font is blocked');
});

test('multiple aspect ratios: exact preview sizes and platform safe zones', () => {
  for (const [aspect, size, platform, zone] of [['4:5', [544, 680], 'facebook', 'facebook_feed'], ['1:1', [540, 540], 'other', 'generic_square'], ['16:9', [960, 540], 'youtube', 'youtube_ads'], ['9:16', [540, 960], 'tiktok', 'tiktok']]) {
    assert.deepEqual(XR.sizeFor({ timeline: { aspect_ratio: aspect } }, 'preview'), { W: size[0], H: size[1] });
    assert.equal(XP.resolveSafeZone({}, { platform: { id: platform } }, aspect).key, zone);
  }
});

test('brand kit (logo at the closing only), caption presets, safe-zone presets (admin only)', async () => {
  const kit = XP.saveBrandKit(null, { name: 'Lux', primary_color: '#101010', accent_color: '#C9A227', logo_position: 'top_left' }, admin);
  assert.throws(() => XP.saveBrandKit(null, { name: 'x', accent_color: 'gold' }, admin), /colour/);
  const logo = join(dir, 'logo.png'); ff(['-f', 'lavfi', '-i', 'color=c=white:s=300x120', '-frames:v', '1', logo]);
  const key = `brand/k${kit.id}/logo.png`; await storage.put(key, logo, 'image/png');
  db.prepare(`UPDATE vx_brand_kits SET logo_key = ?, logo_ratio = 0.4 WHERE id = ?`).run(key, kit.id);
  XP.applyEdit(x.id, { settings: { brand_kit_id: kit.id, logo_mode: 'closing' } }, admin);
  const p = XP.vxState(x.id, admin).plan;
  const lg = p.elements.find(e => e.type === 'logo');
  assert.ok(lg && lg.start >= p.elements.find(e => e.type === 'cta').start - 0.01, 'logo only at the closing, never during the hook');
  assert.equal(p.palette.accent, '#C9A227');
  XJ.enqueue(x.id, 'render', admin, { target: 'preview' });
  const j = await wait('vx_jobs', 'vx_id', x.id);
  assert.equal(j.status, 'completed', j.error);
  const preset = XP.saveCustomStyle({ name: 'Team gold', base: 'luxury', config: { highlight_color: '#FFCC00', size: 9 } }, admin);
  assert.equal(preset.size, 0.11, 'clamped'); assert.equal(preset.highlight_color, '#FFCC00');
  XP.applyEdit(x.id, { settings: { style_id: preset.id } }, admin);
  assert.equal(XP.vxState(x.id, admin).plan.style.id, preset.id);
  assert.throws(() => XP.saveSafeZone('tiktok', { top: 0.1, bottom: 0.3, left: 0.05, right: 0.15 }, member), /admin/);
  assert.equal(XP.saveSafeZone('tiktok', { top: 0.1, bottom: 0.3, left: 0.05, right: 0.15, source: 'test' }, admin).bottom, 0.3);
  XP.saveSafeZone('tiktok', { reset: true }, admin);
});

test('cancel, versions, approval of a production render and the Module 8 package', async () => {
  XP.applyEdit(x.id, { settings: { style_id: 'modern_bold', brand_kit_id: null } }, admin);
  XJ.enqueue(x.id, 'render', admin, { target: 'high', options: { force_render: true } });
  await new Promise(r => setTimeout(r, 400));
  XJ.cancel(x.id, admin);
  assert.equal((await wait('vx_jobs', 'vx_id', x.id)).status, 'cancelled');
  assert.throws(() => XP.approve(x.id, first.id, admin), /older visual plan/);
  XJ.enqueue(x.id, 'render', admin, { target: 'standard' });
  const j = await wait('vx_jobs', 'vx_id', x.id);
  assert.equal(j.status, 'completed', j.error);
  const r = XP.vxState(x.id, admin).renders.find(q => q.id === j.render_id);
  assert.equal(r.width, 1080); assert.equal(r.height, 1920); assert.ok(r.qc_ok);
  const pkg = XP.approve(x.id, r.id, admin);
  for (const k of ['edl', 'visual_plan', 'timeline', 'audio_layers', 'renders', 'output', 'qc', 'approval']) assert.ok(pkg[k], k);
  assert.ok(pkg.timeline.captions.length && pkg.renders.enhanced.ass_key && pkg.renders.approved_video_edit);
  assert.equal(XP.approvedEnhancedPackage(proj).package.visual_version.id, pkg.visual_version.id);
  XP.applyEdit(x.id, { settings: { intensity: 'minimal' } }, admin);
  const after = XP.vxState(x.id, admin);
  assert.ok(after.version.number > pkg.visual_version.number && !after.version.frozen, 'an edit after approval makes a new draft');
  assert.equal(db.prepare(`SELECT frozen FROM vx_versions WHERE id = ?`).get(pkg.visual_version.id).frozen, 1);
  const cmp = XP.compareVersions(x.id, pkg.visual_version.id, after.version.id);
  assert.notEqual(cmp.intensity[0], cmp.intensity[1]);
  XP.restoreVersion(x.id, pkg.visual_version.id, admin);
  assert.equal(XP.vxState(x.id, admin).plan.intensity, pkg.visual_plan.intensity);
});
