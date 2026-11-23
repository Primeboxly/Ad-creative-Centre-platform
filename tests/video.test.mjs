// Joins three test clips of different sizes, lengths, with and without sound, and checks the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';

const dir = mkdtempSync(join(tmpdir(), 'acc-test-'));
process.env.ACC_DATA = join(dir, 'data');
const { concatArgs, probe } = await import('../server/video.js');
const { db } = await import('../server/db.js');

const make = (name, size, secs, sound) => {
  const f = join(dir, name);
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${secs}`];
  if (sound) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-c:a', 'aac', '-shortest'] : []), f);
  assert.equal(spawnSync(ffmpeg, args).status, 0, `could not make ${name}`);
  return f;
};

test('hook + body + CTA become one 1080x1920 video with sound', async () => {
  const parts = [
    { file: make('hook.mp4', '720x1280', 2, true) },
    { file: make('body.mp4', '1280x720', 3, false) },   // landscape, no sound
    { file: make('cta.mp4', '1080x1080', 1.5, true) },
  ];
  for (const p of parts) Object.assign(p, await probe(p.file));
  assert.equal(parts[1].hasAudio, false);
  const out = join(dir, 'out.mp4');
  const r = spawnSync(ffmpeg, ['-hide_banner', ...concatArgs(parts, out)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const info = await probe(out);
  assert.ok(info.hasVideo && info.hasAudio);
  assert.ok(Math.abs(info.duration - 6.5) < 0.3, `duration ${info.duration}`);
  const head = spawnSync(ffmpeg, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
  assert.match(head, /1080x1920/);
});

test('voice-over, looped clip, captions, CTA banner and music', async () => {
  const { adArgs, chunkCaptions, captionsReady } = await import('../server/video.js');
  const { mkdirSync } = await import('node:fs');
  const audio = (name, secs, freq) => {
    const f = join(dir, name);
    assert.equal(spawnSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-c:a', 'libmp3lame', f]).status, 0);
    return f;
  };
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const hookClip = make('h2.mp4', '720x1280', 2, false);  // 2 s clip, 4 s voice → the clip loops
  const ctaClip = make('c2.mp4', '720x1280', 3, true);
  const parts = [
    { file: hookClip, duration: 2, hasAudio: false, seg: 4.35, vo: audio('vo1.mp3', 4, 300),
      captions: chunkCaptions('Still measuring rooms with a tape? 😩', 0.15, 4.2) },
    { file: ctaClip, duration: 3, hasAudio: true, seg: 2.8, vo: audio('vo2.mp3', 2, 350),
      captions: chunkCaptions("Order now, it's 680 ZMW: pay on delivery!", 0.15, 2.65), banner: 'PAIEMENT À LA LIVRAISON' },
  ];
  const out = join(dir, 'ad.mp4');
  const r = spawnSync(ffmpeg, ['-hide_banner', ...adArgs(parts, out, { music: audio('music.mp3', 3, 500), workDir: work })], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-1200));
  const info = await probe(out);
  assert.ok(info.hasAudio && info.hasVideo);
  assert.ok(Math.abs(info.duration - 7.15) < 0.3, `duration ${info.duration}`);
  assert.ok(captionsReady(), 'no font found for captions');
});

test('captions are split in short groups that cover the time', async () => {
  const { chunkCaptions, plain } = await import('../server/video.js');
  const c = chunkCaptions('Bado unapima vyumba kwa utepe? Kipimo kimoja kibaya ✅', 0, 6);
  assert.ok(c.length >= 2);
  assert.ok(c.every(g => g.text.split(' ').length <= 4 && !/✅/.test(g.text)));
  assert.equal(c[0].start, 0);
  assert.ok(Math.abs(c[c.length - 1].end - 6) < 1e-9);
  assert.equal(plain('Order now 🚚✨ today'), 'Order now today');
});

test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
