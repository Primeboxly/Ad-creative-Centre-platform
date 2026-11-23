// Auto-split: where the cuts go, and a real 15 s video with scene changes cut into hook + body + CTA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';

const dir = mkdtempSync(join(tmpdir(), 'acc-split-'));
process.env.ACC_DATA = join(dir, 'data');
const { planCuts, sceneChanges } = await import('../server/split.js');
const { db } = await import('../server/db.js');

test('no scene changes: 3 s hook, 3 s CTA, the rest is body', () => {
  assert.deepEqual(planCuts(20), [
    { kind: 'hook', start: 0, end: 3 }, { kind: 'body', start: 3, end: 17 }, { kind: 'cta', start: 17, end: 20 }]);
});

test('cuts move to the nearest scene change in range', () => {
  const parts = planCuts(20, [0.5, 2.4, 9, 16.2]);
  assert.equal(parts[0].end, 2.4);     // hook ends on the scene change at 2.4 s
  assert.equal(parts[2].start, 16.2);  // CTA starts on the scene change at 16.2 s
  assert.equal(parts[1].start, 2.4);
  assert.equal(parts[1].end, 16.2);
});

test('scene changes out of range are ignored', () => {
  const parts = planCuts(20, [0.4, 6, 12]);
  assert.equal(parts[0].end, 3);
  assert.equal(parts[2].start, 17);
});

test('short videos', () => {
  assert.deepEqual(planCuts(2), [{ kind: 'hook', start: 0, end: 2 }]);
  assert.deepEqual(planCuts(5).map(p => p.kind), ['hook', 'body']);
  assert.equal(planCuts(5)[0].end, 2.5);
  assert.deepEqual(planCuts(0), []);
});

test('finds real scene changes in a video', async () => {
  // 3 different pictures of 2 s, 11 s and 2 s: changes at 2 s and 13 s.
  const f = join(dir, 'full.mp4');
  const r = spawnSync(ffmpeg, ['-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=360x640:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=25:duration=11',
    '-f', 'lavfi', '-i', 'color=c=blue:size=360x640:rate=25:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const scenes = await sceneChanges(f);
  const parts = planCuts(15, scenes);
  assert.ok(Math.abs(parts[0].end - 2) < 0.2, `hook ends at ${parts[0].end}, scenes ${scenes}`);
  assert.ok(Math.abs(parts[2].start - 13) < 0.2, `CTA starts at ${parts[2].start}, scenes ${scenes}`);
});

test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
