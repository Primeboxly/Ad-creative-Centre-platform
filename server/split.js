// Auto-split: a full video (a TikTok you downloaded) is cut into a Hook, a Body and a CTA clip.
// Cuts land on scene changes when there is one near the right place, else on fixed times.
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { db } from './db.js';
import { CLIPS_DIR, RAW_DIR } from './paths.js';
import { run, probe, thumbnail, thumbOf } from './video.js';

export const HOOK = { min: 1.5, ideal: 3, max: 4 };  // seconds
export const CTA = { min: 2, ideal: 3, max: 5 };

// Times (seconds) where the picture changes a lot.
export async function sceneChanges(file, threshold = 0.3) {
  const { err } = await run(['-i', file, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  return [...err.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1])).filter(Number.isFinite);
}

// The scene change closest to `ideal` inside [lo, hi], else `ideal`.
const pick = (scenes, lo, hi, ideal) => {
  const inside = scenes.filter(t => t >= lo && t <= hi);
  return inside.length ? inside.reduce((a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a)) : ideal;
};

// Where to cut a video of `d` seconds. Returns the parts to make: [{ kind, start, end }].
// Short videos (< 7 s) give a hook + a body only; very short ones (< 3 s) are one hook.
export function planCuts(d, scenes = []) {
  if (!(d > 0)) return [];
  if (d < 3) return [{ kind: 'hook', start: 0, end: d }];
  if (d < 7) {
    const h = pick(scenes, HOOK.min, d - 1.5, Math.min(HOOK.ideal, d / 2));
    return [{ kind: 'hook', start: 0, end: h }, { kind: 'body', start: h, end: d }];
  }
  const h = pick(scenes, HOOK.min, HOOK.max, HOOK.ideal);
  const c = pick(scenes, d - CTA.max, d - CTA.min, d - CTA.ideal);
  return [{ kind: 'hook', start: 0, end: h }, { kind: 'body', start: h, end: c }, { kind: 'cta', start: c, end: d }];
}

async function cut(src, start, end, hasAudio, out) {
  const r = await run(['-y', '-ss', start.toFixed(3), '-i', src, '-t', (end - start).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', out]);
  if (r.code !== 0 || !existsSync(out)) throw new Error('ffmpeg failed: ' + r.err.trim().split('\n').slice(-2).join(' '));
}

// ---------- Queue: one raw video at a time, in the background ----------
let busy = false;
export function queueSplits() { if (!busy) next(); }

async function next() {
  const raw = db.prepare(`SELECT * FROM raws WHERE status = 'queued' ORDER BY id LIMIT 1`).get();
  if (!raw) { busy = false; return; }
  busy = true;
  db.prepare(`UPDATE raws SET status = 'splitting', error = '' WHERE id = ?`).run(raw.id);
  const src = join(RAW_DIR, raw.file);
  const made = [], ids = [];
  try {
    const info = await probe(src);
    if (!info.hasVideo || !(info.duration > 0)) throw new Error('Not a readable video');
    const parts = planCuts(info.duration, await sceneChanges(src));
    const base = raw.original_name.replace(/\.[^.]+$/, '').slice(0, 60);
    for (const p of parts) {
      const name = `p${raw.product_id}-${randomBytes(8).toString('hex')}.mp4`;
      await cut(src, p.start, p.end, info.hasAudio, join(CLIPS_DIR, name));
      made.push(name);
      const id = db.prepare(`INSERT INTO clips (product_id, kind, file, original_name, label, duration, has_audio, uploaded_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(raw.product_id, p.kind, name, raw.original_name, `${base} · ${p.kind}`, p.end - p.start, info.hasAudio ? 1 : 0, raw.uploaded_by).lastInsertRowid;
      ids.push(id);
      await thumbnail(join(CLIPS_DIR, name), thumbOf('clip', id));
    }
    db.prepare(`UPDATE raws SET status = 'done', parts = ? WHERE id = ?`).run(parts.length, raw.id);
    rmSync(src, { force: true });
  } catch (e) {
    console.error(`Raw ${raw.id}:`, e.message);
    // Undo the parts already made, so a retry does not give duplicates.
    for (const id of ids) { db.prepare(`DELETE FROM clips WHERE id = ?`).run(id); rmSync(thumbOf('clip', id), { force: true }); }
    for (const f of made) rmSync(join(CLIPS_DIR, f), { force: true });
    db.prepare(`UPDATE raws SET status = 'failed', error = ? WHERE id = ?`).run(e.message.slice(0, 500), raw.id);
  }
  next();
}

export function resumeSplits() {
  db.prepare(`UPDATE raws SET status = 'queued' WHERE status = 'splitting'`).run();
  queueSplits();
}

export const rawName = (pid, original) => `p${pid}-raw-${randomBytes(8).toString('hex')}${extname(original).toLowerCase()}`;
