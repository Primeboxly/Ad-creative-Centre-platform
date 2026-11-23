// BSS style: shot plan, caption groups, subtitles file, word timings, and a real render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';

const dir = mkdtempSync(join(tmpdir(), 'acc-bss-'));
process.env.ACC_DATA = join(dir, 'data');
const { planShots, captionGroups, buildAss, renderBss } = await import('../server/bss.js');
const { wordTimes, evenWordTimes } = await import('../server/tts.js');
const { probe } = await import('../server/video.js');
const { db } = await import('../server/db.js');

const clip = (file, duration) => ({ file, duration });

test('shots: hook, ~2 s body shots cycling through the bodies, then the CTA', () => {
  const shots = planShots({ hook: [clip('h', 5)], body: [clip('b1', 6), clip('b2', 6), clip('b3', 6)], cta: [clip('c', 5)] },
    { hookEnd: 3, ctaStart: 19, total: 23 }, 3);
  assert.equal(shots[0].file, 'h');
  assert.equal(shots[shots.length - 1].file, 'c');
  const body = shots.slice(1, -1);
  assert.ok(body.length >= 7 && body.length <= 8, `${body.length} body shots`);
  assert.ok(body.every(s => s.dur > 1.5 && s.dur < 2.6));
  assert.ok(new Set(body.map(s => s.file)).size === 3, 'uses all bodies');
  assert.ok(Math.abs(shots.reduce((t, s) => t + s.dur, 0) - 23) < 0.01, 'covers the whole ad');
  assert.ok(shots.every(s => s.offset >= 0 && (s.loop || s.offset + s.dur <= 6 + 1e-6)));
});

test('shots: short clips loop, missing parts borrow the bodies', () => {
  const shots = planShots({ hook: [], body: [clip('b', 1)], cta: [] }, { hookEnd: 2.5, ctaStart: 8, total: 11 });
  assert.ok(shots.every(s => s.file === 'b' && s.loop));
});

test('caption groups: up to 3 words, cut at sentence ends, longest word is the key', () => {
  const g = captionGroups(evenWordTimes('Looking for a gift? Skip ordinary presents today.', 5));
  // "Skip ordinary presents" is over 18 letters, so it is split.
  assert.deepEqual(g.map(x => x.words.map(w => w.w).join(' ')), ['Looking for a', 'gift?', 'Skip ordinary', 'presents today.']);
  assert.equal(g[0].key.w, 'Looking');
  assert.equal(g[2].key.w, 'ordinary');
  assert.ok(g.every((x, i) => !g[i + 1] || x.end === g[i + 1].start));
});

test('subtitles file: yellow key word, no punctuation, arrows during the CTA', () => {
  const ass = buildAss(captionGroups(evenWordTimes("She'll love this gift!", 2)), { width: 1080, height: 1350, ctaStart: 1, total: 2.2, fontName: 'Arial' });
  assert.match(ass, /PlayResY: 1350/);
  assert.match(ass, /\\c&H00E6FF&.*She'll/);
  assert.doesNotMatch(ass, /gift!/);
  assert.equal((ass.match(/\\p1/g) || []).length, 2 * 2); // 2 arrows × 2 bounces
});

test('word times from ElevenLabs character times, with or without spaces', () => {
  const chars = 'Hi you'.split('');
  const a = { characters: chars, character_start_times_seconds: chars.map((_, i) => i / 10), character_end_times_seconds: chars.map((_, i) => (i + 1) / 10) };
  assert.deepEqual(wordTimes('Hi you', a).map(w => [w.w, w.start, w.end]), [['Hi', 0, 0.2], ['you', 0.3, 0.6]]);
  const noSpace = { characters: ['H', 'i', 'y', 'o', 'u'], character_start_times_seconds: [0, .1, .2, .3, .4], character_end_times_seconds: [.1, .2, .3, .4, .5] };
  assert.deepEqual(wordTimes('Hi you', noSpace).map(w => w.w), ['Hi', 'you']);
  assert.equal(wordTimes('Hi you there', noSpace), null);
});

test('a real BSS render: 4:5, voice length + lead + tail', async () => {
  const mk = (name, color, secs) => {
    const f = join(dir, name);
    assert.equal(spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30:duration=${secs}`, '-vf', `hue=h=${color}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]).status, 0);
    return clip(f, secs);
  };
  const voice = join(dir, 'v.mp3');
  spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=f=200:d=9', voice]);
  const script = { language: 'en', hook: 'Looking for a gift?', body: 'This watch shines with crystals and a gold finish she will love.', cta: 'Order now, pay on delivery.' };
  const text = [script.hook, script.body, script.cta].join(' ');
  const out = join(dir, 'bss.mp4');
  const total = await renderBss({ clips: { hook: [mk('h.mp4', 0, 3)], body: [mk('b1.mp4', 90, 4), mk('b2.mp4', 180, 2)], cta: [mk('c.mp4', 270, 3)] },
    script, voice: { file: voice, words: evenWordTimes(text, 9) }, format: '4x5', workDir: join(dir, 'w'), out });
  const info = await probe(out);
  assert.ok(info.hasVideo && info.hasAudio);
  assert.ok(Math.abs(info.duration - total) < 0.3 && Math.abs(total - 10.15) < 0.2, `duration ${info.duration}, total ${total}`);
  assert.match(spawnSync(ffmpeg, ['-i', out], { encoding: 'utf8' }).stderr, /1080x1350/);
});

test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
