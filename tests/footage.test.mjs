// Footage library: scene planning, video details, fingerprints, scores, file checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planScenes, parseInfo, aspectOf, orientationOf, dhash, hamming, measure, techScore, sniffVideo, ff, videoInfo, sceneCuts, grayFrame, needsProxy,
} from '../server/footage-media.js';

test('planScenes: cuts on picture changes, merges too-short scenes, splits too-long ones, covers the whole video', () => {
  const s = planScenes(12, [3, 6, 9], { min: 1.2, max: 8 });
  assert.deepEqual(s, [{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }, { start: 9, end: 12 }]);
  // 0.4 s flash at 5 s is merged with its shorter neighbour
  const m = planScenes(10, [4, 4.4, 7], { min: 1.2, max: 8 });
  assert.ok(m.every(x => x.end - x.start >= 1.2));
  assert.equal(m[0].start, 0); assert.equal(m.at(-1).end, 10);
  for (let i = 1; i < m.length; i++) assert.equal(m[i].start, m[i - 1].end);
  // a 20 s single shot becomes 3 parts of ≤ 8 s
  const l = planScenes(20, [], { min: 1.2, max: 8 });
  assert.equal(l.length, 3); assert.ok(l.every(x => x.end - x.start <= 8 + 1e-9));
  // tiny video = one scene; nothing for 0 s
  assert.deepEqual(planScenes(0.8, [0.4]), [{ start: 0, end: 0.8 }]);
  assert.deepEqual(planScenes(0, []), []);
});

test('parseInfo reads size, rotation, fps, codecs and sound from ffmpeg output', () => {
  const txt = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mov':
  Duration: 00:00:14.53, start: 0.000000, bitrate: 8123 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 7900 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)`;
  const i = parseInfo(txt);
  assert.equal(i.duration, 14.53); assert.equal(i.vcodec, 'hevc'); assert.equal(i.fps, 29.97);
  assert.equal(i.width, 1080); assert.equal(i.height, 1920); assert.equal(i.rotation, 270);
  assert.equal(i.orientation, 'vertical'); assert.equal(i.aspect, '9:16'); assert.equal(i.hasAudio, true); assert.equal(i.acodec, 'aac');
  assert.equal(i.bitrate, 8123000);
  assert.equal(needsProxy(i, '.mov', 14e6), true);
  assert.equal(needsProxy({ ...i, vcodec: 'h264' }, '.mp4', 5e6), false);
});

test('aspect and orientation', () => {
  assert.equal(aspectOf(1080, 1350), '4:5'); assert.equal(aspectOf(1280, 720), '16:9'); assert.equal(aspectOf(1000, 1000), '1:1');
  assert.equal(orientationOf(720, 1280), 'vertical'); assert.equal(orientationOf(1280, 720), 'horizontal'); assert.equal(orientationOf(500, 505), 'square');
});

test('picture fingerprint: same picture → same hash, different picture → far', () => {
  const W = 160, H = 90;
  const grad = { w: W, h: H, px: Buffer.from(Array.from({ length: W * H }, (_, i) => (i % W) * 1.5)) };
  const grad2 = { w: W, h: H, px: Buffer.from(grad.px.map(v => Math.min(255, v + 3))) }; // slightly brighter
  const checker = { w: W, h: H, px: Buffer.from(Array.from({ length: W * H }, (_, i) => ((Math.floor((i % W) / 20) + Math.floor(i / W / 20)) % 2 ? 230 : 20))) };
  assert.ok(hamming(dhash(grad), dhash(grad2)) <= 2);
  assert.ok(hamming(dhash(grad), dhash(checker)) > 8);
  // sharp checkerboard has a much higher sharpness than a smooth gradient
  assert.ok(measure(checker).sharp > measure(grad).sharp * 10);
});

test('techScore: dark, blurry, small pictures score low', () => {
  const good = techScore({ sharp: 900, brightness: 120, contrast: 60 }, 1080, 1920);
  const bad = techScore({ sharp: 15, brightness: 20, contrast: 8 }, 360, 640);
  assert.ok(good.score >= 85, `good ${good.score}`); assert.ok(bad.score <= 35, `bad ${bad.score}`);
  assert.ok(bad.notes.includes('dark')); assert.ok(bad.notes.some(n => n.includes('blurry')));
});

test('sniffVideo recognises MP4/MOV and WebM, refuses other files', () => {
  assert.equal(sniffVideo(Buffer.from([0, 0, 0, 0x20, ...Buffer.from('ftypisom')])), 'mp4');
  assert.equal(sniffVideo(Buffer.from([0, 0, 0, 8, ...Buffer.from('wide')])), 'mp4');
  assert.equal(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), 'webm');
  assert.equal(sniffVideo(Buffer.from('this is not a video at all')), '');
});

test('real video: details, scene changes and a grey frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-foot-'));
  const out = join(dir, 'v.mp4');
  const r = await ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=25:duration=2', '-f', 'lavfi', '-i', 'color=c=red:size=360x640:rate=25:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', out]);
  assert.equal(r.code, 0); assert.ok(existsSync(out));
  const info = await videoInfo(out);
  assert.equal(info.width, 360); assert.equal(info.height, 640); assert.equal(info.aspect, '9:16'); assert.equal(info.fps, 25);
  assert.ok(Math.abs(info.duration - 4) < 0.1); assert.equal(info.hasAudio, false); assert.equal(info.vcodec, 'h264');
  const cuts = await sceneCuts(out, 0.3);
  assert.ok(cuts.some(t => Math.abs(t - 2) < 0.1), `cut near 2 s: ${cuts}`);
  const g = await grayFrame(out, 3);
  assert.equal(g.w, 160); assert.ok(g.h > 250);
  assert.ok(measure(g).contrast < 5); // plain red picture
});

test('silent copy: every audio stream removed, checked with ffprobe (copied and re-encoded)', async () => {
  const { makeSilentCopy, assertSilent, streamCounts, ffprobeReady } = await import('../server/footage-media.js');
  assert.ok(ffprobeReady(), 'ffprobe must be available');
  const dir = mkdtempSync(join(tmpdir(), 'acc-silent-'));
  // A video with TWO audio tracks (voice + music), as phones and editors sometimes make.
  const src = join(dir, 'loud.mp4');
  const r = await ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  assert.equal(r.code, 0);
  assert.equal((await streamCounts(src)).audio, 2);
  const info = await videoInfo(src);
  const fast = join(dir, 'silent-copy.mp4');
  assert.equal(await makeSilentCopy(src, fast, info, '.mp4', 100e3, null), 'copied');
  const a = await assertSilent(fast);
  assert.equal(a.audio, 0); assert.equal(a.video, 1);
  const enc = join(dir, 'silent-enc.mp4');
  assert.equal(await makeSilentCopy(src, enc, { ...info, vcodec: 'mpeg4' }, '.mov', 100e3, null), 'encoded');
  assert.equal((await assertSilent(enc)).audio, 0);
  await assert.rejects(() => assertSilent(src), /audio stream/);
});
