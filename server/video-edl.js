// Editing Decision List: built by code (never by the AI) from the approved Audio Production Package's synchronized
// storyboard, the director's decisions and the team's edits. All timeline positions are whole frames; every clip's
// source window is checked against its Module 2 scene. Problems the team must decide are reported, never hidden.
import { createHash } from 'node:crypto';
import { EDL_VERSION, FORMATS, DEFAULT_FPS, PACE, LIMITS, SPEED_RANGE, TRANSITIONS, FRAMINGS, MOTIONS, EDL_SCHEMA } from './video-schemas.js';
import { validate as checkSchema } from './schema.js';
import { selectScenes, extrasFor, cleanliness } from './video-select.js';

const r3 = x => Math.round(x * 1000) / 1000;
export const edlHash = edl => createHash('sha256').update(JSON.stringify({ t: edl.timeline, v: edl.tracks.video.map(({ reason, locked, source, ...c }) => c), a: edl.audio, k: [edl.tracks.voiceover?.key, edl.tracks.music?.key, edl.tracks.mix?.key] })).digest('hex');
const SAFE = { '9:16': { top: 0.1, bottom: 0.2, left: 0.06, right: 0.12 }, '4:5': { top: 0.06, bottom: 0.12, left: 0.05, right: 0.05 }, '1:1': { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 }, '16:9': { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 } };

// Framing. With a product position from Module 2 (product_box): the crop window is placed so the whole product (and the
// hand using it) stays inside; if it cannot fit, the whole frame is kept on a blurred background. Without a position,
// conservative: a big shape change with people or a wide action keeps the whole frame, otherwise a centre crop flagged
// for review. The team's manual framing always wins (applied later in the editor).
export function cropFor(scene, decision, outAspect) {
  const [ow, oh] = FORMATS[outAspect] || FORMATS['9:16'];
  const sa = scene?.width && scene?.height ? scene.width / scene.height : ow / oh, oa = ow / oh;
  const mismatch = Math.max(sa, oa) / Math.min(sa, oa);
  const d = scene?.details || {}, box = d.product_box?.present && d.product_box.w > 0 && d.product_box.h > 0 ? d.product_box : null;
  const cw = sa > oa ? oa / sa : 1, ch = sa > oa ? 1 : sa / oa; // crop window size, as fractions of the source frame
  const place = (c, size, len) => (size >= 1 ? 0.5 : Math.max(0, Math.min(1, (c - size / 2) / (1 - size))));
  if (box) {
    const bw = Math.min(1, box.w * 1.08), bh = Math.min(1, box.h * 1.08), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    if (bw <= cw + 0.001 && bh <= ch + 0.001) {
      // A small product can be shown closer (product focus), never cutting it.
      const room = Math.min(cw / bw, ch / bh);
      const wantFocus = decision?.framing === 'product_focus' || (room > 2.2 && mismatch > 1.2);
      const zoom = wantFocus ? r3(Math.min(1.35, Math.max(1, room * 0.75))) : 1;
      return { mode: wantFocus ? 'product_focus' : 'smart_crop', x: r3(place(cx, cw / zoom)), y: r3(place(cy, ch / zoom)), zoom, uncertain: false, basis: 'product position' };
    }
    return { mode: 'fit_background', x: 0.5, y: 0.5, zoom: 1, uncertain: false, basis: 'product wider than the crop: whole frame kept' };
  }
  const wide = /wide|full|left|right|both|group|people|person/i.test(`${d.composition || ''} ${d.human_interaction ? 'person' : ''}`);
  if (mismatch > 1.5 && wide && decision?.framing !== 'center_crop') return { mode: 'fit_background', x: 0.5, y: 0.5, zoom: 1, uncertain: false, basis: 'no product position: whole frame kept (conservative)' };
  const mode = ['center_crop', 'smart_crop', 'fit_background'].includes(decision?.framing) ? decision.framing : mismatch > 1.25 ? 'smart_crop' : 'center_crop';
  const hinted = /left|right|top|bottom|corner|off-cent|side/i.test(d.composition || '');
  const x = mode === 'center_crop' ? 0.5 : Number.isFinite(decision?.focus_x) && hinted ? decision.focus_x : 0.5;
  const y = mode === 'center_crop' ? 0.5 : Number.isFinite(decision?.focus_y) && hinted ? decision.focus_y : 0.5;
  return { mode, x: r3(x), y: r3(y), zoom: 1, uncertain: mode !== 'fit_background' && mismatch > 1.5, basis: hinted ? 'composition notes' : 'centre (no product position)' };
}

// Cut times inside a window, placed between spoken words near the ideal rhythm (cuts land on the voice, not mid-word).
function cutTimes(start, end, n, words, minLen) {
  if (n <= 1) return [];
  const gaps = words.filter((w, i) => i < words.length - 1 && w.end > start + minLen && w.end < end - minLen).map((w, i, arr) => (w.end + (words[words.indexOf(w) + 1]?.start ?? w.end)) / 2);
  const cuts = [];
  for (let k = 1; k < n; k++) {
    const ideal = start + ((end - start) * k) / n;
    const prev = cuts.at(-1) ?? start;
    const near = gaps.filter(g => g > prev + minLen && g < end - minLen * (n - k) && Math.abs(g - ideal) <= Math.min(0.6, (end - start) / n / 2)).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    cuts.push(near ?? ideal);
  }
  return cuts;
}

// Pieces of one shot: [{ scene, from, len }] using non-overlapping source intervals (global tracker `taken`).
function plan({ seconds, primary, extras, pace, role, firstOffset, shotStart, taken, closing }) {
  const p = PACE[pace] || PACE.dynamic;
  const max = role === 'demonstration' || role === 'features' ? p.max * 1.4 : p.max; // demonstrations may run longer
  const want = seconds > max ? Math.max(2, Math.round(seconds / p.ideal)) : 1;
  const free = (sc, len, map) => {
    const busy = (map.get(sc.id) || []).sort((a, b) => a[0] - b[0]);
    let t = sc.id === primary.id ? Math.max(sc.start, Math.min(shotStart + firstOffset, sc.end - len)) : sc.start;
    for (let guard = 0; guard < 20; guard++) {
      const hit = busy.find(([a, b]) => t < b - 0.01 && t + len > a + 0.01);
      if (!hit) break;
      t = hit[1];
    }
    return t + len <= sc.end + 0.001 ? t : null;
  };
  for (let n = Math.min(want, 6); n >= 1; n--) {
    const L = seconds / n;
    if (n > 1 && L < p.min) continue;
    // The closing shot keeps the strongest scene last, long enough for the CTA graphics of Module 7.
    // (closing: other angles first, the strongest closing scene always last)
    const order = closing && n > 1 ? [...Array.from({ length: n - 1 }, (_, k) => (extras.length ? extras[k % extras.length] : primary)), primary] : [primary, ...extras];
    const local = new Map([...taken].map(([k, v]) => [k, [...v]]));
    const pieces = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const sc = order[i % order.length];
      const t = free(sc, L, local);
      if (t === null) { ok = false; break; } // does not fit: try fewer pieces, then variable lengths below
      const from = t ?? Math.max(sc.start, Math.min(shotStart, sc.end));
      pieces.push({ scene: sc, from, len: L });
      local.set(sc.id, [...(local.get(sc.id) || []), [from, from + L]]);
    }
    if (ok) { for (const [k, v] of local) taken.set(k, v); return pieces; }
  }
  // Equal pieces did not fit: fill the window with variable lengths from the free parts of the relevant scenes
  // (closing: the main closing scene last, as long as possible up to the CTA moment).
  const freeSpan = (sc, map) => {
    const busy = (map.get(sc.id) || []).slice().sort((a, b) => a[0] - b[0]);
    let best = [0, 0], t = sc.start;
    for (const [a, b] of [...busy, [sc.end, sc.end]]) { if (a - t > best[1] - best[0]) best = [t, Math.min(a, sc.end)]; t = Math.max(t, b); }
    return best;
  };
  const local = new Map([...taken].map(([k, v]) => [k, [...v]]));
  const take = (sc, len) => { const [a] = freeSpan(sc, local); local.set(sc.id, [...(local.get(sc.id) || []), [a, a + len]]); return { scene: sc, from: a, len }; };
  let rem = seconds;
  const head = [], tail = [];
  if (closing) { const [a, b] = freeSpan(primary, local); const len = Math.min(b - a, rem, Math.max(p.ideal, 2.5, rem - p.max * 4)); if (len >= p.min * 0.8) { tail.push(take(primary, len)); rem -= len; } }
  const srcs = closing ? extras : [primary, ...extras];
  for (let pass = 0; pass < 3 && rem > 0.01 && head.length < 8; pass++) {
    let added = false;
    for (const sc of srcs) {
      if (rem <= 0.01 || head.length >= 8) break;
      const [a, b] = freeSpan(sc, local), avail = b - a;
      if (avail < Math.min(p.min * 0.8, rem)) continue;
      const len = Math.min(avail, rem <= max ? rem : Math.max(p.min, Math.min(p.ideal, rem - p.min)));
      head.push(take(sc, len)); rem -= len; added = true;
    }
    if (!added) break;
  }
  const pieces = [...head, ...tail];
  if (pieces.length) {
    // Anything left goes to the pieces that still have footage after them, then to the last one (a short hold at worst).
    for (const pc of pieces) { if (rem <= 0.01) break; const after = pc.scene.end - (pc.from + pc.len); const busyAfter = (local.get(pc.scene.id) || []).some(([a]) => a >= pc.from + pc.len - 0.01 && a < pc.from + pc.len + 0.01 && a !== pc.from); const add = busyAfter ? 0 : Math.min(after, rem); pc.len += add; rem -= add; }
    if (rem > 0.01) pieces.at(-1).len += rem;
    for (const [k, v] of local) taken.set(k, v);
    return pieces;
  }
  return [{ scene: primary, from: Math.max(primary.start, Math.min(shotStart, primary.end)), len: seconds }];
}

// Build the EDL. ctx: { edit, pkg, pp, scenes (Map), usable (Set), director, prev (EDL, for locked clips), settings }
export function buildEdl({ edit, pkg, pp, scenes, usable, director, prev = null, settings = {} }) {
  const fps = DEFAULT_FPS, aspect = pp.format?.aspect_ratio || '9:16', [W, H] = FORMATS[aspect] || FORMATS['9:16'];
  const sync = pkg.synchronized_storyboard, pace = director?.pace || (PACE[pp.editing_pace] ? pp.editing_pace : 'dynamic');
  const totalFrames = Math.round(sync.final_duration * fps);
  const F = t => Math.round(t * fps);
  const dec = new Map((director?.shots || []).map(s => [s.shot_id, s]));
  const lockedPrev = (prev?.tracks.video || []).filter(c => c.locked);
  const words = pkg.captions?.words || [];
  const mode = settings.selection === 'storyboard' ? 'storyboard' : 'improve';
  const sel = selectScenes({ sync, pp, scenes, usable, mode, lockedShots: new Set(lockedPrev.map(c => c.shot_id)), outShort: Math.min(W, H) });
  const taken = new Map(), placed = [];
  const clips = [];
  sync.shots.forEach((shot, si) => {
    const startF = si === 0 ? 0 : F(shot.timeline_start), endF = si === sync.shots.length - 1 ? totalFrames : F(shot.timeline_end);
    const frames = endF - startF;
    if (frames <= 0) return;
    const s = sel.shots[si], scene = s.scene;
    const d = dec.get(shot.id) || {};
    const role = sync.segments.find(w => w.id === shot.segment_id)?.role || '';
    const closing = si === sync.shots.length - 1;
    // Locked clips of the previous version that belong to this shot are kept as they were (only retimed to the shot).
    const keep = lockedPrev.filter(c => c.shot_id === shot.id);
    if (keep.length) {
      const tot = keep.reduce((a, c) => a + c.frames, 0) || 1;
      let at = startF;
      keep.forEach((c, i) => { const fr = i === keep.length - 1 ? endF - at : Math.round((c.frames / tot) * frames); clips.push({ ...c, start_frame: at, frames: fr, _shot: shot }); at += fr; taken.set(c.scene_id, [...(taken.get(c.scene_id) || []), [c.source_start, c.source_end]]); });
      return;
    }
    if (!scene) { clips.push({ missing: true, id: `c${clips.length + 1}`, shot_id: shot.id, scene_id: shot.scene_id, segment_id: shot.segment_id, role, start_frame: startF, frames, _shot: shot }); return; }
    const text = pp.voiceover.segments.find(x => x.id === shot.segment_id)?.text || '';
    const directorExtras = (d.extra_scene_ids || []).filter(id => usable.has(id));
    const extras = extrasFor({ shotSel: s, text, pool: sel.pool, used: placed, ph: sel.ph, outShort: Math.min(W, H), preferred: directorExtras });
    const pieces = plan({ seconds: frames / fps, primary: scene, extras, pace, role, firstOffset: si === 0 ? director?.opening?.start_offset || 0 : 0, shotStart: s.changed ? scene.start : shot.source_start, taken, closing });
    // Cut frames: between spoken words close to the rhythm, the closing clip at least 2.5 s when possible.
    const cuts = cutTimes(startF / fps, endF / fps, pieces.length, words, (PACE[pace] || PACE.dynamic).min * 0.8);
    if (closing && pieces.length > 1) { const lastStart = Math.min(cuts.at(-1), endF / fps - 2.5); if (lastStart > (cuts.at(-2) ?? startF / fps) + 0.8) cuts[cuts.length - 1] = lastStart; }
    const bounds = [startF, ...cuts.map(F), endF];
    // A cut moved to a word gap must not stretch a piece into frames used elsewhere: keep each piece inside its free part.
    for (let i = 0; i < pieces.length - 1; i++) {
      const pc = pieces[i], end = pc.from + pc.len;
      const nextBusy = Math.min(pc.scene.end, ...(taken.get(pc.scene.id) || []).filter(([a0]) => a0 >= end - 0.01 && Math.abs(a0 - pc.from) > 0.001).map(([a0]) => a0));
      const maxF = bounds[i] + Math.floor((nextBusy - pc.from) * fps);
      if (bounds[i + 1] > maxF) bounds[i + 1] = Math.max(bounds[i] + 1, maxF);
    }
    pieces.forEach((pc, i) => {
      const at = bounds[i], fr = bounds[i + 1] - bounds[i];
      placed.push({ scene: pc.scene, start: pc.from, end: pc.from + pc.len, order: clips.length });
      const isPrimary = pc.scene.id === scene.id;
      const reason = isPrimary
        ? (s.changed ? s.reason : pieces.length > 1 && i ? `Another part of the same scene keeps the ${pace} rhythm` : `Storyboard choice${d.reason ? `: ${d.reason}` : ''}`)
        : `Another relevant angle on the same idea (${pace} rhythm, cut between words)`;
      clips.push({ id: '', shot_id: shot.id, scene: pc.scene, segment_id: shot.segment_id, role, from: pc.from, start_frame: at, frames: fr, speed: 1,
        crop: cropFor(pc.scene, isPrimary && !s.changed ? d : {}, aspect), motion: i === 0 && MOTIONS.includes(d.motion) ? d.motion : 'none',
        transition_in: { type: i === 0 && TRANSITIONS.includes(d.transition_in) ? d.transition_in : 'hard_cut', duration: LIMITS.transition },
        reason, source: isPrimary ? (s.changed ? 'engine' : 'storyboard') : 'engine', locked: false, storyboard_scene_id: isPrimary && s.changed ? s.original : undefined,
        closing: closing && i === pieces.length - 1 ? true : undefined, clean: cleanliness(pc.scene).class });
    });
  });
  // Source windows: inside the scene; if the scene is too short use (in this order) an earlier start, a slightly slower
  // speed, a short hold of the last frame; otherwise the clip is reported as missing footage (blocking).
  const out = finishClips(clips, scenes, fps);
  const edl = finish({ edit, pkg, pp, out, fps, aspect, W, H, totalFrames, pace, settings, director });
  edl.selection = { mode, changes: sel.changes };
  const last = out.at(-1);
  edl.closing = last && !last.missing ? { clip_id: last.id, start: last.timeline_start, end: last.timeline_end, cta_zone: { bottom: edl.safe_area.bottom, note: 'Reserved for the CTA graphics of Module 7' } } : null;
  return edl;
}
function finishClips(clips, scenes, fps) {
  const out = clips.map((c, i) => {
    const id = c.id || `c${i + 1}`;
    if (c.missing) return { ...c, id };
    if (c.asset_id && !c.scene) { const sc = scenes.get(c.scene_id); c.scene = sc; } // kept locked clip
    const sc = c.scene;
    if (!sc) return { id, missing: true, shot_id: c.shot_id, scene_id: c.scene_id, segment_id: c.segment_id, role: c.role, start_frame: c.start_frame, frames: c.frames };
    const need = c.frames / fps;
    let speed = c.locked ? c.speed : 1, hold = 0, from = c.locked ? c.source_start : c.from;
    if (from + need * speed > sc.end + 0.0005) from = Math.max(sc.start, sc.end - need * speed);
    let avail = sc.end - from;
    if (avail + 0.0005 < need * speed) {
      const slow = avail / need;
      if (slow >= SPEED_RANGE[0]) speed = r3(slow);
      else { speed = SPEED_RANGE[0]; hold = r3(need - avail / speed); }
    }
    const srcLen = Math.min(avail, (need - hold) * speed);
    return { id, order: i + 1, shot_id: c.shot_id, asset_id: sc.asset_id, scene_id: sc.id, source_key: sc.proxy_key || '', segment_id: c.segment_id, role: c.role,
      source_start: r3(from), source_end: r3(from + srcLen), timeline_start: r3(c.start_frame / fps), timeline_end: r3((c.start_frame + c.frames) / fps), start_frame: c.start_frame, frames: c.frames,
      speed: r3(speed), crop: c.crop, position: { x: 0.5, y: 0.5 }, scale: 1, motion: c.motion, hold, transition_in: c.transition_in, reason: c.reason, locked: !!c.locked, source: c.source,
      ...(c.closing ? { closing: true } : {}), clean: c.clean || cleanliness(sc).class, ...(c.storyboard_scene_id ? { storyboard_scene_id: c.storyboard_scene_id } : {}) };
  });
  return out;
}

// Common tail: transitions checked, audio tracks, reserved Module 7 tracks, validation.
export function finish({ edit, pkg, pp, out, fps, aspect, W, H, totalFrames, pace, settings, director }) {
  const sync = pkg.synchronized_storyboard;
  const edl = {
    schema_version: EDL_VERSION, edit_id: edit.id, project_id: edit.project_id, variation_index: edit.variation_index,
    brief: { id: pkg.brief.id, version: pkg.brief.version }, script_version: pkg.script_version, storyboard_version: pkg.storyboard_version,
    audio_package: { id: edit.au_approval_id, version_id: pkg.audio_version.id, schema_version: pkg.schema_version },
    timeline: { duration: r3(totalFrames / fps), frames: totalFrames, fps, aspect_ratio: aspect, width: W, height: H, pace },
    tracks: {
      video: out,
      voiceover: pkg.voiceover && pp.production?.voiceover !== false ? { key: pkg.voiceover.storage_key, start: pkg.mix?.lead_in ?? 0, duration: pkg.voiceover.duration, speech_end: r3((pkg.mix?.lead_in ?? 0) + pkg.voiceover.duration), segments: pkg.voiceover.segments.map(s => ({ segment_id: s.segment_id, start: r3(s.start + (pkg.mix?.lead_in ?? 0)), end: r3(s.end + (pkg.mix?.lead_in ?? 0)) })) } : null,
      music: pkg.music && pp.production?.music !== false ? { key: pkg.music.processed_key, name: pkg.music.name, fade_in: pkg.music.processing?.fade_in ?? 0, fade_out: pkg.music.processing?.fade_out ?? 0 } : null,
      mix: pkg.mix ? { key: pkg.mix.key, config: pkg.mix.config, measured: pkg.mix.measured?.mix || null } : null,
      captions: { reserved: true, source: 'audio package captions (word timing)' },
      overlays: { reserved: true, suggestions: (pp.text_overlays || []).map(o => { const sh = sync.shots.find(s => s.id === o.shot_id); return { shot_id: o.shot_id, segment_id: o.segment_id, text: o.text, start: sh?.timeline_start ?? o.start, end: sh?.timeline_end ?? o.end, emphasis: !!o.emphasis }; }) },
      effects: { reserved: true },
    },
    audio: { voice_gain_db: Number(settings.voice_gain_db) || 0, music_gain_db: Number(settings.music_gain_db) || 0, uses_package_mix: !Number(settings.voice_gain_db) && !Number(settings.music_gain_db), footage_audio: 'excluded' },
    safe_area: SAFE[aspect] || SAFE['9:16'],
    segments: sync.segments.map(w => ({ id: w.id, role: w.role, start: w.start, end: w.end, speech_start: w.speech_start, speech_end: w.speech_end })),
    director: director ? { pace: director.pace, pace_reason: director.pace_reason, transition_strategy: director.transition_strategy, framing_strategy: director.framing_strategy, opening: director.opening, summary: director.summary, warnings: director.warnings } : null,
    validation: {},
  };
  return edl;
}

// Deterministic checks of an EDL against the scenes (Map id → scene) and usable set. Returns { errors, warnings, valid }.
export function validateEdl(edl, { scenes, usable, outSize = null }) {
  const errors = [], warnings = [];
  const E = (code, message, clip = null) => errors.push({ code, message, clip }), W = (code, message, clip = null) => warnings.push({ code, message, clip });
  const fps = edl.timeline.fps;
  let at = 0;
  const uses = new Map();
  for (const [i, c] of edl.tracks.video.entries()) {
    if (c.missing) { E('missing_footage', `Clip ${i + 1} (${c.role || c.segment_id}): its scene is gone or unusable and no relevant replacement was found. Add footage or choose another scene.`, c.id); at = c.start_frame + c.frames; continue; }
    if (c.start_frame !== at) E(at < c.start_frame ? 'gap' : 'overlap', `Clip ${c.order}: ${at < c.start_frame ? 'gap' : 'overlap'} at frame ${at}.`, c.id);
    if (!(c.frames > 0)) E('duration', `Clip ${c.order}: duration must be positive.`, c.id);
    at = c.start_frame + c.frames;
    const sc = scenes.get(c.scene_id);
    if (!sc) { E('scene_gone', `Clip ${c.order}: scene ${c.scene_id} no longer exists.`, c.id); continue; }
    if (!usable.has(sc.id)) E('scene_unusable', `Clip ${c.order}: scene ${sc.id} is excluded, not silent or not allowed by the brief.`, c.id);
    if (sc.asset_id !== c.asset_id) E('asset', `Clip ${c.order}: footage reference does not match its scene.`, c.id);
    if (c.source_start < sc.start - 0.002 || c.source_end > sc.end + 0.002 || c.source_end <= c.source_start) E('source_range', `Clip ${c.order}: source ${c.source_start}-${c.source_end} s is outside scene ${sc.id} (${sc.start}-${sc.end} s).`, c.id);
    if (c.speed < SPEED_RANGE[0] - 0.001 || c.speed > SPEED_RANGE[1] + 0.001) E('speed', `Clip ${c.order}: speed ${c.speed} is outside ${SPEED_RANGE.join('-')}.`, c.id);
    else if (Math.abs(c.speed - 1) > 0.01) W('speed', `Clip ${c.order}: played at ${c.speed}× because the scene is short: check it does not misrepresent the product.`, c.id);
    if (c.hold > LIMITS.maxHold + 0.001) E('hold', `Clip ${c.order}: the scene is ${c.hold} s too short (a frozen frame that long would look broken). Choose a longer scene or another one.`, c.id);
    else if (c.hold > 0) W('hold', `Clip ${c.order}: last frame held ${c.hold} s (scene a little short).`, c.id);
    const t = c.transition_in?.type;
    if (t === 'crossfade') {
      const prev = edl.tracks.video[i - 1];
      const handle = (c.transition_in.duration || 0) * c.speed;
      if (!prev) E('transition', `Clip ${c.order}: a crossfade needs a clip before it.`, c.id);
      else if (c.source_start - handle < sc.start - 0.002) W('transition', `Clip ${c.order}: not enough footage before the cut for a crossfade: a hard cut will be used.`, c.id);
      if (c.frames / fps < (c.transition_in.duration || 0) * 1.5) W('transition', `Clip ${c.order}: too short for a ${c.transition_in.duration} s crossfade: a hard cut will be used.`, c.id);
    }
    uses.set(sc.id, (uses.get(sc.id) || 0) + 1);
    if (c.crop?.uncertain) W('crop', `Clip ${c.order}: ${sc.orientation} footage cropped to ${edl.timeline.aspect_ratio} without a known product position: check the framing.`, c.id);
    const [ow, oh] = outSize || [edl.timeline.width, edl.timeline.height];
    if (sc.width && sc.height) {
      const cover = Math.max(ow / sc.width, oh / sc.height) * (c.crop?.zoom || 1);
      if (cover > 1.25) W('low_res', `Clip ${c.order}: footage is ${sc.width}×${sc.height}; it must be enlarged ${cover.toFixed(1)}× for ${ow}×${oh}. Enlarging adds no detail: it will look softer (upload a higher-resolution source for production).`, c.id);
    }
    if (sc.details?.product_visible === false) W('visibility', `Clip ${c.order}: the product is not visible in this scene (Module 2 analysis).`, c.id);
    const cl = cleanliness(sc);
    if (cl.class === 'review') W('watermark', `Clip ${c.order}: ${cl.reasons.join(', ')}. Not removed: use footage you are allowed to use commercially (needs manual review).`, c.id);
    else if (cl.class !== 'clean') W(cl.class === 'graphics' ? 'graphics' : 'embedded_text', `Clip ${c.order}: ${cl.label.toLowerCase()} (${cl.reasons.join(', ')}${sc.details?.text_overlays?.length ? `: "${sc.details.text_overlays.slice(0, 2).join('", "')}"` : ''}).`, c.id);
  }
  if (at !== edl.timeline.frames) E('total', `Clips end at frame ${at}, the timeline has ${edl.timeline.frames} frames.`);
  for (const [id, n] of uses) if (n > LIMITS.maxSceneUses) W('repetition', `Scene ${id} is used ${n} times.`);
  if (!edl.tracks.video.length) E('empty', 'No clip in the timeline.');
  const vo = edl.tracks.voiceover;
  if (vo && vo.speech_end > edl.timeline.duration + 0.01) E('voice_cut', `The voice-over ends at ${vo.speech_end} s, after the video (${edl.timeline.duration} s).`);
  const schemaErr = checkSchema(EDL_SCHEMA, { ...edl, tracks: { ...edl.tracks, video: edl.tracks.video.filter(c => !c.missing) } });
  if (schemaErr.length && !errors.some(e => e.code === 'missing_footage')) E('schema', 'EDL does not match its schema: ' + schemaErr.slice(0, 3).join('; '));
  return { errors, warnings, valid: !errors.length, checked_at: new Date().toISOString() };
}

// Re-lay clips after a team edit (order or duration change inside one segment): keeps every segment's window fixed,
// so the picture stays on the voice. Returns the new clip list (start frames recomputed).
export function relayout(edl) {
  let at = 0;
  edl.tracks.video.forEach((c, i) => { c.order = i + 1; c.start_frame = at; at += c.frames; c.timeline_start = r3(c.start_frame / edl.timeline.fps); c.timeline_end = r3((c.start_frame + c.frames) / edl.timeline.fps); });
  return edl;
}
