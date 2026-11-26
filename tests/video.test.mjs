// Module 6: AI video editing engine. Real footage made with ffmpeg (mixed sizes, codecs, frame rates, one variable
// frame rate, originals WITH sound), the full chain Modules 3-5 in test mode (fake ElevenLabs, test-mode AI), then
// editing plan, real MP4 renders, quality control, edits, cache, cancel, retry, approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.ACC_DATA = mkdtempSync(join(tmpdir(), 'acc-vd-'));
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
const dir = mkdtempSync(join(tmpdir(), 'vd-src-'));
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
SJ.startSbWorker(); AJ.startAudioWorker(); VJ.startVideoWorker();
const wait = async (table, col, id, ms = 240000) => { for (let i = 0; i < ms / 50; i++) { const j = db.prepare(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY id DESC LIMIT 1`).get(id); if (j && !['queued', 'running'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('job timeout'); };
const plan = SP.getOrCreatePlan(proj, 1, admin);
SJ.enqueue(plan.id, 'full', admin); assert.equal((await wait('sb_jobs', 'plan_id', plan.id)).status, 'completed');
SP.approve(plan.id, admin);
const prod = AP.getOrCreateProduction(proj, plan.id, admin);
AJ.enqueue(prod.id, 'full', admin);
{ const j = await wait('au_jobs', 'production_id', prod.id); assert.equal(j.status, 'completed', j.error); }
AP.approve(prod.id, admin);
const elCalls = () => calls.filter(c => /text-to-speech|music/.test(c.path)).length;

let edit, preview;
test('one button: approved inputs → editing plan (EDL) → real preview MP4 with quality control', async () => {
  const vids = VP.readyVideos(proj);
  assert.equal(vids.length, 1); assert.ok(vids[0].latest);
  assert.throws(() => VP.getOrCreateEdit(proj, vids[0].au_approval_id, member), /author/);
  edit = VP.getOrCreateEdit(proj, vids[0].au_approval_id, admin);
  const before = elCalls();
  const id1 = VJ.enqueue(edit.id, 'full', admin, { target: 'preview' });
  assert.equal(VJ.enqueue(edit.id, 'full', admin, { target: 'preview' }), id1, 'a second click returns the same job');
  const j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'completed', `${j.error}\n${j.log}`);
  assert.equal(elCalls(), before, 'no ElevenLabs call while editing');
  const s = VP.editState(edit.id, admin);
  const edl = s.edl;
  assert.deepEqual(validate(VS.EDL_SCHEMA, edl), []);
  assert.equal(s.validation.errors.length, 0, JSON.stringify(s.validation.errors));
  // Timeline: whole frames, contiguous, exactly the approved audio length; sources inside their scenes.
  const pkg = AP.latestPackage(prod.id).package;
  assert.equal(edl.timeline.frames, Math.round(pkg.synchronized_storyboard.final_duration * 30));
  let at = 0;
  for (const c of edl.tracks.video) {
    assert.equal(c.start_frame, at); at += c.frames;
    const row = db.prepare(`SELECT * FROM footage_scenes WHERE id = ?`).get(c.scene_id);
    assert.ok(c.source_start >= row.start - 0.002 && c.source_end <= row.end + 0.002, `clip ${c.id} inside scene`);
    assert.equal(c.asset_id, row.asset_id);
  }
  assert.equal(at, edl.timeline.frames);
  // Clips follow the real speech: each segment's first clip starts at its window from Module 5.
  for (const w of pkg.synchronized_storyboard.segments) { const first = edl.tracks.video.find(c => c.segment_id === w.id); if (first) assert.ok(Math.abs(first.timeline_start - (w === pkg.synchronized_storyboard.segments[0] ? 0 : w.start)) <= 1 / 30 + 0.001, `segment ${w.id}`); }
  assert.ok(edl.tracks.video.length > pkg.synchronized_storyboard.shots.length || Object.values(Object.groupBy(edl.tracks.video, c => c.segment_id)).some(g => g.length > 1), 'several clips for one spoken segment');
  assert.ok(edl.tracks.captions.reserved && edl.tracks.overlays.reserved && edl.safe_area.bottom > 0);
  // The real file
  preview = s.renders.find(r => r.status === 'ready');
  assert.ok(preview && preview.quality === 'preview' && preview.qc_ok);
  const local = await storage.toLocal(preview.storage_key, join(process.env.ACC_DATA, 'p.mp4'));
  const info = await VR.probeVideo(local);
  assert.equal(info.video.width, 540); assert.equal(info.video.height, 960); assert.equal(info.video.fps, 30);
  assert.equal(info.video.codec, 'h264'); assert.equal(info.audio.codec, 'aac'); assert.equal(info.audio_streams, 1);
  assert.ok(Math.abs(info.duration - edl.timeline.duration) < 0.1, `${info.duration} vs ${edl.timeline.duration}`);
  assert.ok(Math.abs(info.video.frames - edl.timeline.frames) <= 2);
  assert.ok(preview.thumb_key && (await storage.exists(preview.thumb_key)));
  assert.equal(readdirSync(TMP_DIR).filter(f => f.startsWith('vd-')).length, 0, 'temporary folder removed');
});

test('same timeline + same settings: the render is reused, not made twice', async () => {
  const n = db.prepare(`SELECT COUNT(*) n FROM vd_renders`).get().n;
  VJ.enqueue(edit.id, 'render', admin, { target: 'preview' });
  const j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'completed'); assert.match(j.log, /reused/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM vd_renders`).get().n, n);
});

test('team edits: replace a clip, trim inside the scene only, order only inside a segment, crossfade keeps the length', async () => {
  let s = VP.editState(edit.id, admin);
  const c0 = s.edl.tracks.video[0];
  const unused = s.scenes.find(x => !x.used) || s.scenes.find(x => x.id !== c0.scene_id);
  VP.applyEdit(edit.id, { clip: { id: c0.id, scene_id: unused.id } }, admin);
  s = VP.editState(edit.id, admin);
  const r0 = s.edl.tracks.video[0];
  assert.equal(r0.scene_id, unused.id); assert.equal(r0.frames, c0.frames, 'replacement keeps the timing');
  assert.throws(() => VP.applyEdit(edit.id, { clip: { id: r0.id, scene_id: 999999 } }, admin), /not usable/);
  assert.throws(() => VP.applyEdit(edit.id, { clip: { id: r0.id, source_start: 999 } }, admin), /Trim inside/);
  const segs = Object.values(Object.groupBy(s.edl.tracks.video, c => c.segment_id));
  const pair = segs.find(g => g.length > 1);
  const lone = segs.find(g => g.length === 1);
  if (lone) assert.throws(() => VP.applyEdit(edit.id, { clip: { id: lone[0].id, duration: 1 } }, admin), /only one on its spoken segment/);
  const lastOfFirstSeg = s.edl.tracks.video.findLast(c => c.segment_id === s.edl.tracks.video[0].segment_id);
  const next = s.edl.tracks.video[s.edl.tracks.video.indexOf(lastOfFirstSeg) + 1];
  if (next) assert.throws(() => VP.applyEdit(edit.id, { clip: { id: lastOfFirstSeg.id, move: 1 } }, admin), /same spoken segment/);
  VP.applyEdit(edit.id, { clip: { id: pair[0].id, duration: (pair[0].frames + 6) / 30 } }, admin);
  VP.applyEdit(edit.id, { clip: { id: pair[1].id, transition: 'crossfade' } }, admin);
  VP.applyEdit(edit.id, { clip: { id: pair[1].id, crop: { mode: 'fit_background' } } }, admin);
  s = VP.editState(edit.id, admin);
  assert.equal(s.validation.errors.length, 0, JSON.stringify(s.validation.errors));
  const before = elCalls();
  VJ.enqueue(edit.id, 'render', admin, { target: 'preview' });
  const j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'completed', `${j.error}\n${j.log}`);
  assert.match(j.log, /reused from the cache/);
  assert.equal(elCalls(), before, 'voice-over and music not regenerated');
  const r = VP.editState(edit.id, admin).renders.find(x => x.current && x.status === 'ready');
  const info = await VR.probeVideo(await storage.toLocal(r.storage_key, join(process.env.ACC_DATA, 'p2.mp4')));
  assert.ok(Math.abs(info.duration - s.edl.timeline.duration) < 0.1, 'the crossfade did not shorten the video');
});

test('music level change re-mixes the same audio files (no new voice or music); voice-over complete', async () => {
  const before = elCalls();
  VP.applyEdit(edit.id, { audio: { music_gain_db: -6 } }, admin);
  assert.equal(VP.editState(edit.id, admin).edl.audio.uses_package_mix, false);
  VJ.enqueue(edit.id, 'render', admin, { target: 'preview' });
  const j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'completed', `${j.error}\n${j.log}`);
  assert.match(j.log, /re-mixed/); assert.equal(elCalls(), before);
  const r = VP.editState(edit.id, admin).renders.find(x => x.current && x.status === 'ready');
  assert.ok(r.qc.measured.loudness.true_peak <= -1, `peak ${r.qc.measured.loudness.true_peak}`);
});

test('footage sound is never used: originals with sound render silent when audio layers are off; 16:9 from vertical keeps proportions', async () => {
  const s = VP.editState(edit.id, admin);
  const edl = structuredClone(s.edl);
  Object.assign(edl.timeline, { aspect_ratio: '16:9', width: 1920, height: 1080, frames: 60, duration: 2 });
  edl.tracks.video = [{ ...edl.tracks.video.find(c => c.asset_id === aA), id: 'x1', order: 1, start_frame: 0, frames: 60, timeline_start: 0, timeline_end: 2, crop: { mode: 'fit_background', x: 0.5, y: 0.5, zoom: 1, uncertain: false }, motion: 'none', hold: 0, transition_in: { type: 'hard_cut', duration: 0.4 } }];
  const c = edl.tracks.video[0]; c.source_end = c.source_start + 2; c.speed = 1;
  edl.tracks.voiceover = null; edl.tracks.music = null;
  const work = join(TMP_DIR, 'vd-test-silent');
  const scenes = new Map(VP.loadInputs(edit).scenes);
  const out = await VR.renderEdl({ edl, quality: 'standard', work, stage: () => {}, scenesById: scenes, projectId: proj });
  const info = await VR.probeVideo(out.file);
  assert.equal(info.audio_streams, 0, 'no sound at all (the original file had a sound track)');
  assert.equal(info.video.width, 1920); assert.equal(info.video.height, 1080);
  const qc = await VR.qualityCheck(out.file, edl, { W: 1920, H: 1080, fps: 30, expectAudio: false, quality: 'standard' });
  assert.ok(qc.ok, JSON.stringify(qc.errors));
  assert.ok(VR.sourceFor(aA, 'standard', 1920, 1080).original, 'high resolution read from the original picture');
  VR.cleanup(work);
});

test('quality control catches corrupted and truncated files', async () => {
  const s = VP.editState(edit.id, admin);
  const bad = join(process.env.ACC_DATA, 'bad.mp4'); writeFileSync(bad, Buffer.alloc(5000, 7));
  const q1 = await VR.qualityCheck(bad, s.edl, { W: 540, H: 960, fps: 30, expectAudio: true });
  assert.ok(!q1.ok && q1.errors.some(e => e.code === 'corrupt'));
  const good = await storage.toLocal(s.renders.find(r => r.status === 'ready').storage_key, join(process.env.ACC_DATA, 'g.mp4'));
  const cut = join(process.env.ACC_DATA, 'cut.mp4');
  ff(['-i', good, '-t', '3', '-c', 'copy', cut]);
  const q2 = await VR.qualityCheck(cut, s.edl, { W: 540, H: 960, fps: 30, expectAudio: true });
  assert.ok(q2.errors.some(e => e.code === 'duration'), JSON.stringify(q2.errors));
  assert.ok(q2.errors.some(e => e.code === 'voice_cut'));
});

test('insufficient footage: short hold allowed, longer gaps block; missing files and storage failures fail clearly and retry works', async () => {
  const inputs = VP.loadInputs(edit);
  const s = VP.editState(edit.id, admin);
  const edl = structuredClone(s.edl);
  const c = edl.tracks.video[0];
  const row = inputs.scenes.get(c.scene_id);
  c.source_start = row.end - 0.5; c.source_end = row.end; c.hold = 2; c.speed = 0.85;
  const val = VE.validateEdl(edl, { scenes: inputs.scenes, usable: inputs.usable });
  assert.ok(val.errors.some(e => e.code === 'hold'));
  // Missing source file
  const key = db.prepare(`SELECT proxy_key FROM footage_assets WHERE id = ?`).get(s.edl.tracks.video[1].asset_id).proxy_key;
  const keep = join(process.env.ACC_DATA, 'keep.mp4'); copyFileSync(await storage.toLocal(key, join(process.env.ACC_DATA, 'k0.mp4')), keep); await storage.remove(key);
  db.prepare(`DELETE FROM vd_clip_cache`).run();
  VP.applyEdit(edit.id, { audio: { music_gain_db: -3 } }, admin);
  VJ.enqueue(edit.id, 'render', admin, { target: 'preview' });
  let j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'failed'); assert.match(j.error, /missing from storage/);
  await storage.put(key, keep, 'video/mp4');
  // Upload failure once, then retry succeeds
  const put = storage.put; let failed = false;
  storage.put = async (k, ...rest) => { if (!failed && /^video\/p\d+\/e\d+\/r\d+/.test(k)) { failed = true; throw new Error('S3 upload refused (test)'); } return put.call(storage, k, ...rest); };
  VJ.retryFailed(edit.id, admin);
  j = await wait('vd_jobs', 'edit_id', edit.id);
  storage.put = put;
  assert.ok(failed);
  assert.equal(j.status, 'completed', `${j.error}\n${j.log}`, 'the upload error was retried automatically');
});

test('disk space guard, cancel and restart cleanup', async () => {
  const old = VS.LIMITS.minFreeDiskMb; VS.LIMITS.minFreeDiskMb = 1e12;
  VP.applyEdit(edit.id, { audio: { music_gain_db: -2 } }, admin);
  VJ.enqueue(edit.id, 'render', admin, { target: 'preview' });
  let j = await wait('vd_jobs', 'edit_id', edit.id);
  VS.LIMITS.minFreeDiskMb = old;
  assert.equal(j.status, 'failed'); assert.match(j.error, /disk left/);
  VJ.enqueue(edit.id, 'render', admin, { target: 'high' });
  await new Promise(r => setTimeout(r, 300));
  VJ.cancel(edit.id, admin);
  j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'cancelled');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(readdirSync(TMP_DIR).filter(f => f.startsWith('vd-')).length, 0, 'cancelled job cleaned its files');
  mkdirSync(join(TMP_DIR, 'vd-999-crashed'), { recursive: true });
  VJ.startVideoWorker();
  assert.ok(!existsSync(join(TMP_DIR, 'vd-999-crashed')), 'leftovers of a crash are removed at start');
});

test('approval: preview refused, standard approved, package for Module 7, edits after approval make a draft, outdated after new audio', async () => {
  VP.applyEdit(edit.id, { audio: { reset: true } }, admin);
  VJ.enqueue(edit.id, 'render', admin, { target: 'preview' }); await wait('vd_jobs', 'edit_id', edit.id);
  let s = VP.editState(edit.id, admin);
  const pv = s.renders.find(r => r.current && r.status === 'ready' && r.quality === 'preview');
  assert.throws(() => VP.approve(edit.id, pv.id, admin), /Standard or High/);
  VJ.enqueue(edit.id, 'render', admin, { target: 'standard' });
  const j = await wait('vd_jobs', 'edit_id', edit.id);
  assert.equal(j.status, 'completed', `${j.error}\n${j.log}`);
  s = VP.editState(edit.id, admin);
  const st = s.renders.find(r => r.current && r.quality === 'standard' && r.status === 'ready');
  assert.equal(st.width, 1080); assert.equal(st.height, 1920);
  assert.throws(() => VP.approve(edit.id, st.id, member), /author/);
  const pkg = VP.approve(edit.id, st.id, admin);
  assert.equal(pkg.original_footage_audio, 'excluded');
  assert.ok(pkg.edl.tracks.video.length && pkg.captions.words.length && pkg.safe_area);
  assert.equal(VP.approvedVideoPackage(proj, 1).package.render.id, st.id);
  const approvedId = pkg.video_version.id;
  VP.applyEdit(edit.id, { clip: { id: pkg.edl.tracks.video[0].id, motion: 'zoom_out' } }, admin);
  s = VP.editState(edit.id, admin);
  assert.ok(s.version.id !== approvedId && !s.version.frozen);
  assert.ok(VP.compareVersions(edit.id, approvedId, s.version.id).clips.some(c => c.fields?.includes('motion')));
  // New audio approved in Module 5: this edit is outdated, no package for the old audio.
  AP.applyEdit(prod.id, { mix: { music_rel_db: -14 } }, admin);
  AJ.enqueue(prod.id, 'mix', admin); await wait('au_jobs', 'production_id', prod.id);
  AP.approve(prod.id, admin);
  assert.ok(VP.isOutdated(VP.editRow(edit.id)));
  assert.throws(() => VJ.enqueue(edit.id, 'render', admin, { target: 'preview' }), /approved again/);
  assert.equal(VP.approvedVideoPackage(proj, 1), null);
  assert.equal(VP.readyVideos(proj).filter(v => v.latest).length, 1);
});

// ---------- Editing quality improvements (hook, closing, diversity, clean footage, crops, rhythm) ----------
const SEL = await import('../server/video-select.js');
const mkScene = (id, cats, details = {}, extra = {}) => ({ id, asset_id: extra.asset_id ?? id, start: 0, end: 4, duration: 4, width: extra.w ?? 720, height: extra.h ?? 1280, quality: extra.q ?? 80,
  categories: cats.map(key => ({ key })), angles: [{ score: 70 }], semantic: extra.semantic || cats.join(' '), description: extra.semantic || '', measured: { motion: 20 },
  details: { product_visible: true, composition: 'product centred', camera_movement: 'handheld', graphics: { captions: false, promo_text: false, arrows_stickers: false, other_graphics: false }, ...details } });

test('clean footage classes: clean, embedded text, graphic overlays, watermark review; old analyses use their text', () => {
  assert.equal(SEL.cleanliness(mkScene(1, ['closeup'])).class, 'clean');
  assert.equal(SEL.cleanliness(mkScene(2, ['closeup'], { graphics: { captions: true, promo_text: false, arrows_stickers: false, other_graphics: false } })).class, 'text');
  assert.equal(SEL.cleanliness(mkScene(3, ['closeup'], { graphics: { captions: false, promo_text: true, arrows_stickers: true, other_graphics: false } })).class, 'graphics');
  assert.equal(SEL.cleanliness(mkScene(4, ['closeup'], { watermark: { present: true, text: '@shop' } })).class, 'review');
  const old = mkScene(5, ['closeup'], { graphics: undefined, text_overlays: ['50% OFF 🔥'] });
  delete old.details.graphics;
  const c = SEL.cleanliness(old);
  assert.equal(c.class, 'graphics'); assert.equal(c.detailed, false);
});

test('hook avoids packaging the hook does not mention; closing prefers a clean showcase; swaps never bring dirtier footage', () => {
  const box = mkScene(10, ['packaging', 'unboxing'], {}, { semantic: 'closed watch box on a table' });
  const dial = mkScene(11, ['closeup', 'hook'], {}, { semantic: 'close-up of the gold watch dial' });
  const promo = mkScene(12, ['showcase', 'cta'], { watermark: { present: true, text: '@x' } }, { semantic: 'watch on display' });
  const show = mkScene(13, ['showcase', 'closeup'], { camera_movement: 'static', composition: 'product centred on a plain background' }, { semantic: 'watch on display, side view' });
  const sticker = mkScene(14, ['closeup', 'hook'], { graphics: { captions: false, promo_text: true, arrows_stickers: true, other_graphics: false } }, { semantic: 'close-up of the gold watch dial with arrows' });
  const scenes = new Map([box, dial, promo, show, sticker].map(s => [s.id, s]));
  const sync = { shots: [{ id: 'k1', scene_id: 10, segment_id: 's1', duration: 2.5 }, { id: 'k2', scene_id: 11, segment_id: 's2', duration: 2 }, { id: 'k3', scene_id: 12, segment_id: 's3', duration: 3 }] };
  const pp = { voiceover: { segments: [{ id: 's1', text: 'Looking for the perfect gift?' }, { id: 's2', text: 'See the gold dial.' }, { id: 's3', text: 'Order now.' }] } };
  const r = SEL.selectScenes({ sync, pp, scenes, usable: new Set(scenes.keys()) });
  assert.notEqual(r.shots[0].scene.id, 10, 'no packaging opening');
  assert.equal(r.shots[0].clean.class, 'clean');
  assert.equal(r.shots[2].scene.id, 13, 'clean product showcase to close');
  assert.ok(r.changes.every(c => c.reason));
  assert.ok(r.shots.every(s => s.scene.id !== 14), 'footage with stickers never chosen over clean footage');
  const strict = SEL.selectScenes({ sync, pp, scenes, usable: new Set(scenes.keys()), mode: 'storyboard' });
  assert.deepEqual(strict.shots.map(s => s.scene.id), [10, 11, 12], 'storyboard mode keeps every approved scene');
  // A hook that talks about the box may open on it.
  const pp2 = { voiceover: { segments: [{ id: 's1', text: 'Look at this box!' }, ...pp.voiceover.segments.slice(1)] } };
  assert.equal(SEL.selectScenes({ sync, pp: pp2, scenes, usable: new Set(scenes.keys()) }).shots[0].scene.id, 10);
});

test('cropping keeps the whole product: product position → crop around it, too wide → whole frame, unknown → flagged', async () => {
  const { cropFor } = VE;
  const wide = mkScene(20, ['lifestyle'], { product_box: { present: true, x: 0.6, y: 0.3, w: 0.2, h: 0.4 } }, { w: 1920, h: 1080 });
  const c = cropFor(wide, {}, '9:16');
  const cw = (9 / 16) / (1920 / 1080);
  const left = c.x * (1 - cw / c.zoom), right = left + cw / c.zoom;
  assert.ok(left <= 0.6 + 0.001 && right >= 0.8 - 0.001, `product inside the crop (${left.toFixed(3)}-${right.toFixed(3)})`);
  assert.equal(c.uncertain, false);
  const tooWide = mkScene(21, ['lifestyle'], { product_box: { present: true, x: 0.1, y: 0.3, w: 0.8, h: 0.4 } }, { w: 1920, h: 1080 });
  assert.equal(cropFor(tooWide, {}, '9:16').mode, 'fit_background', 'never cut a wide product');
  const unknown = mkScene(22, ['showcase'], { composition: 'product centred' }, { w: 1920, h: 1080 });
  assert.equal(cropFor(unknown, {}, '9:16').uncertain, true);
  const people = mkScene(23, ['lifestyle'], { composition: 'wide shot, two people', human_interaction: 'two people' }, { w: 1920, h: 1080 });
  assert.equal(cropFor(people, {}, '9:16').mode, 'fit_background', 'conservative when people and no position');
});

test('rhythm and duration: dynamic shots about 1.5-3 s, cuts between words, timeline = approved audio, CTA kept', () => {
  const s = VP.editState(edit.id, admin);
  const inp = VP.loadInputs(VP.editRow(edit.id));
  const fresh = VE.buildEdl({ edit: VP.editRow(edit.id), pkg: inp.pkg, pp: inp.pp, scenes: inp.scenes, usable: inp.usable, director: null });
  const fps = fresh.timeline.fps;
  const body = fresh.tracks.video.slice(0, -1).map(c => c.frames / fps);
  assert.ok(body.filter(x => x <= 3.3).length >= body.length - 1, `shots ${body.map(x => x.toFixed(1))}`);
  const pkg = AP.latestPackage(prod.id).package;
  const words = pkg.captions.words;
  const inside = fresh.tracks.video.slice(1).filter(c => words.some(w => c.timeline_start > w.start + 0.04 && c.timeline_start < w.end - 0.04));
  assert.equal(inside.length, 0, 'no cut in the middle of a word');
  assert.ok(fresh.closing && fresh.tracks.video.at(-1).closing);
  assert.equal(fresh.timeline.duration, pkg.synchronized_storyboard.final_duration);
  assert.ok(!s.validation.errors.some(e => e.code === 'duration_mismatch' || e.code === 'cta_cut'));
  const bad = structuredClone(s.edl); bad.timeline.duration += 1;
  const val = VP.validateVersion(VP.editRow(edit.id), bad);
  assert.ok(val.errors.some(e => e.code === 'duration_mismatch'));
});
