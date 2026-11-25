// Module 4 schemas: what the AI must answer (checked by server/schema.js, one retry when wrong) and the versioned
// documents stored for each plan version (strategy, hooks, script, storyboard) and the production plan for Modules 5-8.
export const SB_SCHEMA_VERSION = '1.0';
export const ROLES = {
  hook: 'Hook', problem: 'Problem', intro: 'Product Introduction', solution: 'Solution', demonstration: 'Demonstration',
  feature: 'Feature', benefit: 'Benefit', objection: 'Objection Handling', offer: 'Offer', cta: 'CTA', supporting: 'Supporting Visual',
};
export const HOOK_KINDS = ['question', 'problem', 'curiosity', 'benefit', 'demonstration', 'offer', 'story', 'direct_response'];
export const TRANSITIONS = ['hard_cut', 'smooth_cut', 'fade', 'crossfade'];
export const MOTIONS = ['none', 'subtle_zoom_in', 'subtle_zoom_out', 'reframe'];
export const CROPS = ['none', 'product_focus', 'center', 'top', 'bottom'];
export const AWARENESS = ['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware'];

const S = { type: 'string' }, I = { type: 'integer' }, N = { type: 'number' }, B = { type: 'boolean' };
const arr = (items, max) => ({ type: 'array', items, ...(max ? { maxItems: max } : {}) });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const en = values => ({ type: 'string', enum: values });

// ---------- AI answers ----------
export const AI_STRATEGY = obj({
  main_message: S, primary_pain_point: S, main_benefit: S, awareness_level: en(AWARENESS), emotional_approach: S,
  hook_strategy: S, narrative: arr(obj({ role: en(Object.keys(ROLES)), purpose: S }), 10), selling_approach: S,
  visual_approach: S, cta_strategy: S,
  missing_visuals: arr(obj({ need: S, alternative: S }), 6),
  claims_to_avoid: arr(S, 8),
});
const HOOK = obj({
  style: en(HOOK_KINDS), text: S, visual_opening: S, on_screen_text: S, scene_ids: arr(I, 3), est_seconds: N,
  angle_relevance: I, explanation: S,
});
export const AI_HOOKS = obj({ hooks: arr(HOOK, 5), recommended: I });
export const AI_ONE_HOOK = obj({ hook: HOOK });
const SEGMENT = obj({
  role: en(Object.keys(ROLES)), text: S, on_screen_text: S, visual_intent: S, scene_categories: arr(S, 4),
  features: arr(S, 4), benefits: arr(S, 4), emotion: S, transition: en(TRANSITIONS), keep: S,
});
export const AI_SCRIPT = obj({ language: S, segments: arr(SEGMENT, 14), notes: S });
export const AI_SEGMENT = obj({ segment: SEGMENT });
export const AI_STORYBOARD = obj({
  segments: arr(obj({
    segment_id: S,
    shots: arr(obj({ scene_id: I, reason: S, confidence: I, crop: en(CROPS), motion: en(MOTIONS), transition: en(TRANSITIONS), edit_notes: S, text_emphasis: B }), 3),
    missing: S,
  }), 20),
});

// ---------- Stored documents (one set per version) ----------
export const STRATEGY_DOC = obj({ ...AI_STRATEGY.properties, source: S, rev: I }, [...AI_STRATEGY.required, 'source', 'rev']);
export const HOOKS_DOC = obj({
  items: arr(obj({ id: S, ...HOOK.properties, source: S, locked: B }, ['id', ...HOOK.required, 'source', 'locked'])),
  selected: { type: ['string', 'null'] }, auto: B,
});
export const SCRIPT_DOC = obj({
  schema_version: S, language: S, dialect: S, tone: S, target_seconds: N, est_seconds: N, diff_seconds: N, words: I,
  structure: arr(S), hook_id: { type: ['string', 'null'] },
  segments: arr(obj({
    id: S, order: I, role: S, text: S, on_screen_text: S, visual_intent: S, scene_categories: arr(S), features: arr(S), benefits: arr(S),
    emotion: S, transition: S, est_start: N, est_end: N, est_duration: N, words: I, locked: B, source: S,
  })),
});
export const STORYBOARD_DOC = obj({
  schema_version: S, total_seconds: N, pace: S, aspect: S,
  shots: arr(obj({
    id: S, order: I, segment_id: S, role: S, scene_id: I, asset_id: I, source_key: S, source_start: N, source_end: N, source_duration: N,
    timeline_start: N, timeline_end: N, duration: N, voiceover: S, on_screen_text: S, visual_description: S, reason: S, confidence: I,
    crop: S, motion: S, transition: S, speed: N, edit_notes: S, text_emphasis: B, alternatives: arr(I), warnings: arr(S), locked: B, source: S,
  })),
  missing: arr(obj({ segment_id: S, need: S, alternative: S })),
});
