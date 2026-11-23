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

test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
