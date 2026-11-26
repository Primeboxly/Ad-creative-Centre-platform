// Editing Decision List: built by code (never by the AI) from the approved Audio Production Package's synchronized
// storyboard, the director's decisions and the team's edits. All timeline positions are whole frames; every clip's
// source window is checked against its Module 2 scene. Problems the team must decide are reported, never hidden.
import { createHash } from 'node:crypto';
import { EDL_VERSION, FORMATS, DEFAULT_FPS, PACE, LIMITS, SPEED_RANGE, TRANSITIONS, FRAMINGS, MOTIONS, EDL_SCHEMA } from './video-schemas.js';
import { validate as checkSchema } from './schema.js';

const r3 = x => Math.round(x * 1000) / 1000;
export const edlHash = edl => createHash('sha256').update(JSON.stringify({ t: edl.timeline, v: edl.tracks.video.map(({ reason, locked, source, ...c }) => c), a: edl.audio, k: [edl.tracks.voiceover?.key, edl.tracks.music?.key, edl.tracks.mix?.key] })).digest('hex');
const SAFE = { '9:16': { top: 0.1, bottom: 0.2, left: 0.06, right: 0.12 }, '4:5': { top: 0.06, bottom: 0.12, left: 0.05, right: 0.05 }, '1:1': { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 }, '16:9': { top: 0.05, bottom: 0.1, left: 0.05, right: 0.05 } };

// Where to crop: the director's focus when the composition gives a hint, else the centre (and the crop is flagged uncertain
// when the source shape differs a lot from the output: something important could be cut).
function cropFor(scene, decision, outAspect) {
  const [ow, oh] = FORMATS[outAspect] || FORMATS['9:16'];
  const sa = scene?.width && scene?.height ? scene.width / scene.height : ow / oh, oa = ow / oh;
  const mismatch = Math.max(sa, oa) / Math.min(sa, oa);
  const mode = FRAMINGS.includes(decision?.framing) ? decision.framing : mismatch > 1.25 ? 'smart_crop' : 'center_crop';
  const hinted = /left|right|top|bottom|corner|off-cent|side/i.test(scene?.details?.composition || '');
  const x = mode === 'center_crop' ? 0.5 : Number.isFinite(decision?.focus_x) ? decision.focus_x : 0.5;
  const y = mode === 'center_crop' ? 0.5 : Number.isFinite(decision?.focus_y) ? decision.focus_y : 0.5;
  return { mode, x: r3(x), y: r3(y), zoom: mode === 'product_focus' ? 1.15 : 1, uncertain: mode !== 'fit_background' && mismatch > 1.5 && !hinted && mode !== 'manual' };
}

// Split one storyboard shot into several clips when it is long for the pace: extra relevant scenes first, then other
// non-overlapping parts of the same scene. Returns [{ scene, from, len }] (source seconds) covering `seconds` of timeline.
function plan(shot, seconds, scene, extras, pace, uses, firstOffset = 0) {
  const p = PACE[pace] || PACE.dynamic;
  const want = seconds > p.max ? Math.max(2, Math.round(seconds / p.ideal)) : 1;
  const sources = [scene, ...extras.filter(e => (uses.get(e.id) || 0) < LIMITS.maxSceneUses)];
  for (let n = Math.min(want, 6); n >= 1; n--) {
    const L = seconds / n;
    if (n > 1 && L < p.min) continue;
    const cursor = new Map(), pieces = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const sc = sources[i % sources.length];
      const startAt = cursor.has(sc.id) ? cursor.get(sc.id) : sc.id === scene.id ? Math.max(sc.start, Math.min(shot.source_start + (i === 0 ? firstOffset : 0), sc.end)) : sc.start;
      if (n > 1 && startAt + L > sc.end + 0.001) { ok = false; break; }
      pieces.push({ scene: sc, from: startAt, len: L });
      cursor.set(sc.id, startAt + L);
    }
    if (ok) return pieces;
  }
  return [{ scene, from: Math.max(scene.start, Math.min(shot.source_start, scene.end)), len: seconds }];
}

// Build the EDL. ctx: { edit, pkg, pp, scenes (Map), usable (Set), director, prev (EDL, for locked clips), settings }
export function buildEdl({ edit, pkg, pp, scenes, usable, director, prev = null, settings = {} }) {
  const fps = DEFAULT_FPS, aspect = pp.format?.aspect_ratio || '9:16', [W, H] = FORMATS[aspect] || FORMATS['9:16'];
  const sync = pkg.synchronized_storyboard, pace = director?.pace || (PACE[pp.editing_pace] ? pp.editing_pace : 'dynamic');
  const totalFrames = Math.round(sync.final_duration * fps);
  const F = t => Math.round(t * fps);
  const dec = new Map((director?.shots || []).map(s => [s.shot_id, s]));
  const lockedPrev = new Map((prev?.tracks.video || []).filter(c => c.locked).map(c => [c.id, c]));
  const uses = new Map(), notes = [];
  const clips = [];
  sync.shots.forEach((shot, si) => {
    const startF = si === 0 ? 0 : F(shot.timeline_start), endF = si === sync.shots.length - 1 ? totalFrames : F(shot.timeline_end);
    const frames = endF - startF;
    if (frames <= 0) return;
    const scene = scenes.get(shot.scene_id);
    const d = dec.get(shot.id) || {};
    const role = sync.segments.find(w => w.id === shot.segment_id)?.role || '';
    // Locked clips of the previous version that belong to this shot are kept as they were (only retimed to the shot).
    const keep = [...lockedPrev.values()].filter(c => c.shot_id === shot.id);
    if (keep.length) {
      const tot = keep.reduce((a, c) => a + c.frames, 0) || 1;
      let at = startF;
      keep.forEach((c, i) => { const fr = i === keep.length - 1 ? endF - at : Math.round((c.frames / tot) * frames); clips.push({ ...c, start_frame: at, frames: fr, _shot: shot }); at += fr; uses.set(c.scene_id, (uses.get(c.scene_id) || 0) + 1); });
      return;
    }
    if (!scene) { clips.push({ missing: true, id: `c${clips.length + 1}`, shot_id: shot.id, scene_id: shot.scene_id, segment_id: shot.segment_id, role, start_frame: startF, frames, _shot: shot }); return; }
    const extras = (d.extra_scene_ids || []).map(id => scenes.get(id)).filter(sc => sc && usable.has(sc.id) && sc.id !== scene.id);
    const pieces = plan(shot, frames / fps, scene, extras, pace, uses, si === 0 ? director?.opening?.start_offset || 0 : 0);
    let at = startF;
    pieces.forEach((pc, i) => {
      const fr = i === pieces.length - 1 ? endF - at : Math.round(pc.len * fps);
      uses.set(pc.scene.id, (uses.get(pc.scene.id) || 0) + 1);
      clips.push({ id: '', shot_id: shot.id, scene: pc.scene, segment_id: shot.segment_id, role, from: pc.from, start_frame: at, frames: fr, speed: 1,
        crop: cropFor(pc.scene, pc.scene.id === scene.id ? d : { framing: d.framing }, aspect), motion: i === 0 && MOTIONS.includes(d.motion) ? d.motion : 'none',
        transition_in: { type: i === 0 && TRANSITIONS.includes(d.transition_in) ? d.transition_in : 'hard_cut', duration: LIMITS.transition },
        reason: pc.scene.id === scene.id ? (pieces.length > 1 && i ? `Another part of the same scene keeps the ${pace} rhythm` : `Storyboard choice${d.reason ? `: ${d.reason}` : ''}`) : `Extra relevant scene for a long segment (${pace} pace)`,
        source: pc.scene.id === scene.id ? 'storyboard' : 'director', locked: false });
      at += fr;
    });
  });
  // Source windows: inside the scene; if the scene is too short use (in this order) an earlier start, a slightly slower
  // speed, a short hold of the last frame; otherwise the clip is reported as missing footage (blocking).
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
      speed: r3(speed), crop: c.crop, position: { x: 0.5, y: 0.5 }, scale: 1, motion: c.motion, hold, transition_in: c.transition_in, reason: c.reason, locked: !!c.locked, source: c.source };
  });
  return finish({ edit, pkg, pp, out, fps, aspect, W, H, totalFrames, pace, settings, notes, director });
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
      if (cover > 1.6) W('low_res', `Clip ${c.order}: footage is ${sc.width}×${sc.height}, enlarged ${cover.toFixed(1)}× for ${ow}×${oh}: it may look soft.`, c.id);
    }
    if (sc.details?.product_visible === false) W('visibility', `Clip ${c.order}: the product is not visible in this scene (Module 2 analysis).`, c.id);
    if (sc.details?.watermark?.present) W('watermark', `Clip ${c.order}: a watermark or handle was seen (${sc.details.watermark.text || 'logo'}). It is not removed: use footage you are allowed to use commercially.`, c.id);
    if ((sc.details?.text_overlays || []).length) W('embedded_text', `Clip ${c.order}: the footage has text on it ("${sc.details.text_overlays.slice(0, 2).join('", "')}").`, c.id);
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
