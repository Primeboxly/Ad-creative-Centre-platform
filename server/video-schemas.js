// Module 6 vocabulary: Editing Decision List (EDL) schema, output formats, quality presets, editing pace guidelines.
// The EDL is the single source of truth for rendering. Timeline times are whole frames at the output frame rate
// (seconds are derived from frames, so cuts never drift); source times are seconds with millisecond precision.
export const EDL_VERSION = '1.0';
const num = (n, d) => { const r = process.env[n]; const v = Number(r); return r !== undefined && r !== '' && Number.isFinite(v) ? v : d; };

export const FORMATS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
export const FPS_ALLOWED = [24, 25, 30, 60];
export const DEFAULT_FPS = FPS_ALLOWED.includes(num('VD_FPS', 30)) ? num('VD_FPS', 30) : 30;
// Preview: smaller and fast, for review. Standard: normal production. High: approved outputs.
export const QUALITY = {
  preview: { scale: 0.5, preset: process.env.VD_PREVIEW_PRESET || 'veryfast', crf: num('VD_PREVIEW_CRF', 28), clip_crf: 23, audio_kbps: 128, label: 'Preview' },
  standard: { scale: 1, preset: process.env.VD_STANDARD_PRESET || 'medium', crf: num('VD_STANDARD_CRF', 21), clip_crf: 17, audio_kbps: 192, label: 'Standard' },
  high: { scale: 1, preset: process.env.VD_HIGH_PRESET || 'slow', crf: num('VD_HIGH_CRF', 18), clip_crf: 15, audio_kbps: 256, label: 'High' },
};
export const outputSize = (aspect, quality = 'standard') => {
  const [w, h] = FORMATS[aspect] || FORMATS['9:16'];
  const s = QUALITY[quality]?.scale || 1;
  return [Math.round((w * s) / 2) * 2, Math.round((h * s) / 2) * 2];
};
// Shot length guidelines per pace (seconds): ideal and maximum before a cut is added inside a long segment.
export const PACE = {
  slow: { ideal: num('VD_SLOW_SHOT', 4), max: 6, min: 1.2, label: 'Slow' },
  balanced: { ideal: num('VD_BALANCED_SHOT', 2.8), max: 4.5, min: 0.9, label: 'Balanced' },
  dynamic: { ideal: num('VD_DYNAMIC_SHOT', 2), max: 3.2, min: 0.7, label: 'Dynamic' },
  fast: { ideal: num('VD_FAST_SHOT', 1.4), max: 2.4, min: 0.5, label: 'Fast' },
};
export const TRANSITIONS = ['hard_cut', 'crossfade', 'fade_in', 'fade_out', 'dip_to_black'];
export const FRAMINGS = ['smart_crop', 'center_crop', 'fit_background', 'product_focus', 'manual'];
export const MOTIONS = ['none', 'zoom_in', 'zoom_out'];
export const SPEED_RANGE = [num('VD_SPEED_MIN', 0.85), num('VD_SPEED_MAX', 1.15)];
export const LIMITS = {
  maxHold: num('VD_MAX_HOLD', 0.6),          // longest allowed freeze at the end of a too-short clip (s)
  maxSceneUses: num('VD_MAX_SCENE_USES', 2),  // a scene appears at most this many times
  transition: num('VD_TRANSITION', 0.4),       // crossfade / dip length (s)
  frameTolerance: num('VD_FRAME_TOLERANCE', 3),
  minFreeDiskMb: num('VD_MIN_FREE_MB', 100), // always kept free on the disk, on top of what the render itself needs
  renderTimeout: num('VD_RENDER_TIMEOUT', 1800), // seconds per job
  ffThreads: num('VD_FF_THREADS', 2),
};
export const STATUSES = ['draft', 'queued', 'validating_inputs', 'preparing_plan', 'resolving_footage', 'preparing_video', 'preparing_audio', 'building_timeline', 'rendering',
  'quality_checking', 'uploading', 'ready', 'approved', 'failed', 'cancelled'];

const S = { type: 'string' }, N = { type: 'number' }, I = { type: 'integer' }, B = { type: 'boolean' };
const obj = (p, r = Object.keys(p)) => ({ type: 'object', required: r, properties: p });
const CLIP = obj({
  id: S, order: I, asset_id: I, scene_id: I, source_key: S, segment_id: S, role: S,
  source_start: N, source_end: N, timeline_start: N, timeline_end: N, start_frame: I, frames: I, speed: N,
  crop: obj({ mode: { type: 'string', enum: FRAMINGS }, x: N, y: N, zoom: N, uncertain: B }),
  position: obj({ x: N, y: N }), scale: N, motion: { type: 'string', enum: MOTIONS }, hold: N,
  transition_in: obj({ type: { type: 'string', enum: TRANSITIONS }, duration: N }),
  reason: S, locked: B, source: S,
});
export const EDL_SCHEMA = obj({
  schema_version: S, edit_id: I, project_id: I, variation_index: I, brief: obj({ id: I, version: I }), script_version: obj({ id: I, number: I }),
  storyboard_version: obj({ id: I, number: I }), audio_package: obj({ id: I, version_id: I, schema_version: S }),
  timeline: obj({ duration: N, frames: I, fps: I, aspect_ratio: S, width: I, height: I, pace: S }),
  tracks: obj({
    video: { type: 'array', items: CLIP, minItems: 1 },
    voiceover: { type: ['object', 'null'] }, music: { type: ['object', 'null'] }, mix: { type: ['object', 'null'] },
    captions: obj({ reserved: B, source: S }), overlays: obj({ reserved: B, suggestions: { type: 'array' } }), effects: obj({ reserved: B }),
  }),
  audio: obj({ voice_gain_db: N, music_gain_db: N, uses_package_mix: B, footage_audio: S }),
  safe_area: obj({ top: N, bottom: N, left: N, right: N }),
  segments: { type: 'array' }, validation: { type: 'object' },
});
