import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './paths.js';

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
-- One product = one collection: its information, analysis, marketing angles and footage.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',        -- benefits, audience, price, offer: given to the AI
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Columns added after the first version (kept separate so old databases get them too).
const addColumn = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
// Product page: picture, links, markets and status.
addColumn('products', 'image', "TEXT NOT NULL DEFAULT ''");          // main picture (file in /files)
addColumn('products', 'link_product', "TEXT NOT NULL DEFAULT ''");   // our product / landing page
addColumn('products', 'link_alibaba', "TEXT NOT NULL DEFAULT ''");   // where we found it: Alibaba / 1688 / Amazon
addColumn('products', 'markets', "TEXT NOT NULL DEFAULT '[]'");      // JSON [{ code, price }]
addColumn('products', 'status', "TEXT NOT NULL DEFAULT 'testing'"); // idea | testing | scaling | paused

// ---------- Module 1: product analysis & marketing angles (additive only) ----------
addColumn('products', 'description', "TEXT NOT NULL DEFAULT ''");   // product description (typed or imported)
addColumn('products', 'price', "TEXT NOT NULL DEFAULT ''");         // selling price as typed, e.g. "780 ZMW" (optional)
addColumn('products', 'offer', "TEXT NOT NULL DEFAULT ''");         // promotional offer, e.g. "Buy 2, get the 3rd free" (optional)
addColumn('products', 'country', "TEXT NOT NULL DEFAULT ''");       // target country code (ZM, ZW…)
addColumn('products', 'language', "TEXT NOT NULL DEFAULT 'en'");    // target language (en, sw, fr)
db.exec(`
-- Product pictures (uploaded or imported from the product page). products.image stays the main picture.
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- AI product analysis: one row per run, the latest 'done' one is the current analysis.
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  data TEXT NOT NULL DEFAULT '{}',     -- JSON (server/strategy.js ANALYSIS_SCHEMA)
  error TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
-- Marketing angles of a product (AI-made or custom). selected = kept for the next modules (scripts, storyboards).
CREATE TABLE IF NOT EXISTS angles (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  analysis_id INTEGER REFERENCES analyses(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  pain_point TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  emotion TEXT NOT NULL DEFAULT '',
  hooks TEXT NOT NULL DEFAULT '[]',          -- JSON array of 3 hook lines (target language)
  creative_types TEXT NOT NULL DEFAULT '[]', -- JSON array
  why TEXT NOT NULL DEFAULT '',
  selected INTEGER NOT NULL DEFAULT 0,
  custom INTEGER NOT NULL DEFAULT 0,          -- 1 = written or edited by the team
  position INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_angles_product ON angles(product_id, position);
-- Background AI work, so the same work is never started twice and the page can show progress.
CREATE TABLE IF NOT EXISTS ai_jobs (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- analysis | angles | angle
  target_id INTEGER,                   -- angle id for 'angle'
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  error TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_product ON ai_jobs(product_id, status);
-- Every AI call: tokens, time, success or error.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                  -- import | analysis | angles | angle | scenes | scene-match
  product_id INTEGER,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// A restart stops background work: mark it failed so it can be started again.
db.exec(`UPDATE ai_jobs SET status = 'failed', error = 'Stopped by a server restart: try again', finished_at = datetime('now') WHERE status = 'running';
  UPDATE analyses SET status = 'failed', error = 'Stopped by a server restart: try again', finished_at = datetime('now') WHERE status = 'running';`);

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- Module 2: footage library & AI scene analysis (new tables only; nothing above changes) ----------
db.exec(`
-- One uploaded video (the original is kept as uploaded; scenes point into it by time).
CREATE TABLE IF NOT EXISTS footage_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- numbers are never reused (AI costs and files are linked by number)
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  incoming TEXT NOT NULL DEFAULT '',         -- local file waiting to be stored (cleared once stored)
  storage_key TEXT NOT NULL DEFAULT '',      -- the original video
  proxy_key TEXT NOT NULL DEFAULT '',        -- light preview copy ('' = the original plays well as it is)
  thumb_key TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  fps REAL NOT NULL DEFAULT 0,
  vcodec TEXT NOT NULL DEFAULT '',
  acodec TEXT NOT NULL DEFAULT '',
  has_audio INTEGER NOT NULL DEFAULT 0,
  rotation INTEGER NOT NULL DEFAULT 0,
  orientation TEXT NOT NULL DEFAULT '',      -- vertical | horizontal | square
  aspect TEXT NOT NULL DEFAULT '',           -- 9:16, 16:9, 1:1, 4:5…
  bitrate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',   -- uploaded|queued|metadata|scenes|analyzing|matching|completed|failed|cancelled
  progress REAL NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  meta_done INTEGER NOT NULL DEFAULT 0,
  scenes_done INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fa_product ON footage_assets(product_id);
CREATE INDEX IF NOT EXISTS idx_fa_hash ON footage_assets(product_id, sha256);
-- A scene = a time range of one video (no file is cut).
CREATE TABLE IF NOT EXISTS footage_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES footage_assets(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  start REAL NOT NULL,
  end REAL NOT NULL,
  duration REAL NOT NULL,
  thumb_key TEXT NOT NULL DEFAULT '',
  phash TEXT NOT NULL DEFAULT '',            -- 64-bit picture fingerprint (hex), for look-alike scenes
  sharpness REAL NOT NULL DEFAULT 0,         -- measured on frames
  brightness REAL NOT NULL DEFAULT 0,
  contrast REAL NOT NULL DEFAULT 0,
  motion REAL NOT NULL DEFAULT 0,
  tech_score INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',       -- auto | split | merge | trim
  excluded INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER,                       -- same picture as this scene
  similar_to INTEGER,                         -- looks like this scene
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | analyzed | failed
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fs_asset ON footage_scenes(asset_id, start);
CREATE INDEX IF NOT EXISTS idx_fs_product ON footage_scenes(product_id);
-- What the AI saw in a scene (one row per scene; replaced on re-analysis).
CREATE TABLE IF NOT EXISTS scene_analyses (
  scene_id INTEGER PRIMARY KEY REFERENCES footage_scenes(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  semantic TEXT NOT NULL DEFAULT '',          -- short text to match with script sentences later
  data TEXT NOT NULL DEFAULT '{}',            -- JSON: objects, features, benefits, human, environment, camera, composition, text overlays, watermark
  relevance INTEGER NOT NULL DEFAULT 0,       -- 0-100: how much the scene is about this product
  ai_quality INTEGER NOT NULL DEFAULT 0,
  quality INTEGER NOT NULL DEFAULT 0,         -- final 0-100 (measured + AI)
  quality_note TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '[]',           -- JSON: watermark, text_overlay, low_quality, irrelevant, staged…
  placements TEXT NOT NULL DEFAULT '[]',      -- JSON: where in an ad it fits
  angles_hash TEXT NOT NULL DEFAULT '',       -- marketing angles at the time of matching
  edited INTEGER NOT NULL DEFAULT 0,          -- 1 = the team changed something
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Categories (kind 'category') and free tags (kind 'tag'); source ai or user.
CREATE TABLE IF NOT EXISTS scene_tags (
  id INTEGER PRIMARY KEY,
  scene_id INTEGER NOT NULL REFERENCES footage_scenes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('category','tag')),
  tag TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai',
  UNIQUE (scene_id, kind, tag)
);
CREATE INDEX IF NOT EXISTS idx_st_tag ON scene_tags(kind, tag);
-- Which marketing angles a scene supports, and how much (0-100).
CREATE TABLE IF NOT EXISTS scene_angles (
  scene_id INTEGER NOT NULL REFERENCES footage_scenes(id) ON DELETE CASCADE,
  angle_id INTEGER NOT NULL REFERENCES angles(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ai',
  PRIMARY KEY (scene_id, angle_id)
);
CREATE INDEX IF NOT EXISTS idx_sa_angle ON scene_angles(angle_id, score);
-- Background work on footage (survives restarts: running jobs go back to the queue).
CREATE TABLE IF NOT EXISTS footage_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER REFERENCES footage_assets(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- process | analyze | match
  status TEXT NOT NULL DEFAULT 'queued',      -- queued | running | completed | failed | cancelled
  stage TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  run_after TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fj_status ON footage_jobs(status, run_after);
-- AI answers kept by a key made of the file fingerprint, scene times and settings: the same footage is not paid twice.
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
addColumn('ai_usage', 'ref', "TEXT NOT NULL DEFAULT ''");        // e.g. "asset:12"
addColumn('ai_usage', 'cost_usd', 'REAL NOT NULL DEFAULT 0');      // estimated from tokens and the model's price
// A restart stops footage work: it goes back to the queue and continues where it stopped.
db.exec(`UPDATE footage_jobs SET status = 'queued', run_after = datetime('now') WHERE status = 'running';`);
addColumn('footage_jobs', 'options', "TEXT NOT NULL DEFAULT '{}'"); // e.g. {"force":true} = ignore cached AI answers
addColumn('footage_assets', 'silent', 'INTEGER NOT NULL DEFAULT 0');  // 1 = the working copy (proxy_key) was checked by ffprobe: no audio stream

// ---------- Module 3: creative projects & Creative Brief (new tables only) ----------
db.exec(`
-- A creative project: one product + its settings, worked on step by step (draft), until a Creative Brief is saved.
CREATE TABLE IF NOT EXISTS creative_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),  -- ready = a Creative Brief is saved and matches the settings
  settings TEXT NOT NULL DEFAULT '{}',        -- JSON: creative settings (types, market, platform, duration, format, tone, production, variations…)
  recommendations TEXT NOT NULL DEFAULT '',   -- JSON: last AI recommendations
  reco_key TEXT NOT NULL DEFAULT '',          -- what they were made from (unchanged = no new AI call)
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cp_product ON creative_projects(product_id);
-- Marketing angles chosen for a project (references to Module 1 angles).
CREATE TABLE IF NOT EXISTS creative_project_angles (
  project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  angle_id INTEGER NOT NULL REFERENCES angles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, angle_id)
);
-- Scenes picked (manual mode: include) or left out (any mode: exclude) for a project (references to Module 2 scenes).
CREATE TABLE IF NOT EXISTS creative_project_scenes (
  project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  scene_id INTEGER NOT NULL REFERENCES footage_scenes(id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK (choice IN ('include','exclude')),
  PRIMARY KEY (project_id, scene_id)
);
-- The variation plan of a project: how many videos, which strategies, how they are distributed.
CREATE TABLE IF NOT EXISTS creative_variation_plans (
  project_id INTEGER PRIMARY KEY REFERENCES creative_projects(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  strategies TEXT NOT NULL DEFAULT '[]',     -- JSON array of strategy ids
  distribution TEXT NOT NULL DEFAULT '',     -- JSON: the team's own distribution ('' = automatic)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Saved Creative Briefs (versioned, never changed after saving): the single source of truth for the next modules.
CREATE TABLE IF NOT EXISTS creative_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  brief TEXT NOT NULL,                       -- JSON (see server/creative-brief.js)
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, version)
);`);

// ---------- Module 4: AI script & storyboard (new tables only) ----------
db.exec(`
-- One script & storyboard plan per creative project, Creative Brief version and planned video (variation).
CREATE TABLE IF NOT EXISTS sb_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  brief_id INTEGER NOT NULL REFERENCES creative_briefs(id) ON DELETE CASCADE,
  brief_version INTEGER NOT NULL,
  variation_index INTEGER NOT NULL DEFAULT 1,       -- which planned video of the brief
  status TEXT NOT NULL DEFAULT 'draft',             -- draft|generating_strategy|generating_hooks|generating_script|matching_footage|generating_storyboard|validating|ready|approved|failed
  error TEXT NOT NULL DEFAULT '',
  approved_version_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, brief_id, variation_index)
);
-- Versions of a plan. The newest unfrozen one is the working draft; frozen versions never change.
-- strategy / hooks / script / storyboard are JSON documents checked against server/sb-schemas.js.
CREATE TABLE IF NOT EXISTS sb_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES sb_plans(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  parent_id INTEGER,                                 -- the version it was made from
  label TEXT NOT NULL DEFAULT '',
  frozen INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL DEFAULT '',
  strategy_rev INTEGER NOT NULL DEFAULT 0,           -- bumps each time the strategy changes
  hooks TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL DEFAULT '',
  storyboard TEXT NOT NULL DEFAULT '',
  validation TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plan_id, number)
);
-- Footage used by each version's shots (keeps the links to Module 2 scenes checkable).
CREATE TABLE IF NOT EXISTS sb_version_scenes (
  version_id INTEGER NOT NULL REFERENCES sb_versions(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL,
  scene_id INTEGER NOT NULL REFERENCES footage_scenes(id) ON DELETE CASCADE,
  PRIMARY KEY (version_id, shot_id)
);
CREATE INDEX IF NOT EXISTS idx_sbvs_scene ON sb_version_scenes(scene_id);
-- Generation work (in the background, survives restarts).
CREATE TABLE IF NOT EXISTS sb_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES sb_plans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                -- full|strategy|hooks|hook|script|segment|storyboard|shot|match
  target TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',             -- queued|running|completed|failed|cancelled
  stage TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  error TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sbj_status ON sb_jobs(status, id);
-- Approvals: who approved which version, and the production plan handed to Modules 5-8.
CREATE TABLE IF NOT EXISTS sb_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES sb_plans(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES sb_versions(id) ON DELETE CASCADE,
  brief_id INTEGER NOT NULL REFERENCES creative_briefs(id) ON DELETE CASCADE,
  production_plan TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// A restart stops generation: running work goes back to the queue.
db.exec(`UPDATE sb_jobs SET status = 'queued' WHERE status = 'running';`);

// ---------- Module 5: AI voice-over & background music (new tables only) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS el_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT (datetime('now')));
-- Voices of the connected ElevenLabs account (refreshed on request; available = still on the account).
CREATE TABLE IF NOT EXISTS el_voices (
  voice_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '{}', languages TEXT NOT NULL DEFAULT '[]', preview_url TEXT NOT NULL DEFAULT '', preview_key TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]', available INTEGER NOT NULL DEFAULT 1, fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS voice_favorites (voice_id TEXT PRIMARY KEY REFERENCES el_voices(voice_id) ON DELETE CASCADE, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
-- Preferred voice for a market (country:language) or a creative type.
CREATE TABLE IF NOT EXISTS voice_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK (scope IN ('market','type')), scope_key TEXT NOT NULL,
  voice_id TEXT NOT NULL REFERENCES el_voices(voice_id) ON DELETE CASCADE, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, scope_key)
);
CREATE TABLE IF NOT EXISTS voice_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, voice_id TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
  market TEXT NOT NULL DEFAULT '', creative_type TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- How to say a word: alias (text replacement) or phoneme (ElevenLabs pronunciation dictionary). product_id NULL = everywhere.
CREATE TABLE IF NOT EXISTS pronunciation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER REFERENCES products(id) ON DELETE CASCADE, language TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL, spoken TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'alias' CHECK (type IN ('alias','phoneme')), alphabet TEXT NOT NULL DEFAULT 'ipa',
  case_sensitive INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Music library (AI generated or uploaded; reused across creatives).
CREATE TABLE IF NOT EXISTS music_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('ai','upload')),
  prompt TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0, mood TEXT NOT NULL DEFAULT '', energy INTEGER NOT NULL DEFAULT 0, style TEXT NOT NULL DEFAULT '',
  tempo INTEGER, storage_key TEXT NOT NULL, format TEXT NOT NULL DEFAULT '', sample_rate INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '{}', license TEXT NOT NULL DEFAULT '{}', favorite INTEGER NOT NULL DEFAULT 0, cache_key TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One audio production per approved script and storyboard version (Module 4).
CREATE TABLE IF NOT EXISTS au_productions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  sb_plan_id INTEGER NOT NULL REFERENCES sb_plans(id) ON DELETE CASCADE, sb_version_id INTEGER NOT NULL REFERENCES sb_versions(id) ON DELETE CASCADE,
  brief_id INTEGER NOT NULL REFERENCES creative_briefs(id) ON DELETE CASCADE, variation_index INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', error TEXT NOT NULL DEFAULT '', approved_version_id INTEGER,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sb_version_id)
);
-- Generated voice-overs (never changed; a regeneration makes a new one). Alignment and timings are stored with it.
CREATE TABLE IF NOT EXISTS au_voiceovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, production_id INTEGER NOT NULL REFERENCES au_productions(id) ON DELETE CASCADE, parent_id INTEGER,
  sb_version_id INTEGER NOT NULL, script_hash TEXT NOT NULL, voice_id TEXT NOT NULL, voice_name TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}', language TEXT NOT NULL DEFAULT '', speech TEXT NOT NULL DEFAULT '{}',
  storage_key TEXT NOT NULL, duration REAL NOT NULL DEFAULT 0, sample_rate INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT '',
  alignment TEXT NOT NULL DEFAULT '', words TEXT NOT NULL DEFAULT '[]', sentences TEXT NOT NULL DEFAULT '[]', alignment_source TEXT NOT NULL DEFAULT 'estimated',
  characters INTEGER NOT NULL DEFAULT 0, request_ids TEXT NOT NULL DEFAULT '[]', cache_key TEXT NOT NULL DEFAULT '', loudness TEXT NOT NULL DEFAULT '{}',
  peaks TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auvo_cache ON au_voiceovers(cache_key);
-- Actual timing of every script segment in a voice-over.
CREATE TABLE IF NOT EXISTS au_voice_segments (
  voiceover_id INTEGER NOT NULL REFERENCES au_voiceovers(id) ON DELETE CASCADE, segment_id TEXT NOT NULL, ord INTEGER NOT NULL,
  start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL, speech_text TEXT NOT NULL, regenerated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (voiceover_id, segment_id)
);
-- Versions of an audio production: plan, voice choice, voice-over, music, mix, synchronized storyboard, checks.
CREATE TABLE IF NOT EXISTS au_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, production_id INTEGER NOT NULL REFERENCES au_productions(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, parent_id INTEGER, label TEXT NOT NULL DEFAULT '', frozen INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT '', voiceover_id INTEGER REFERENCES au_voiceovers(id) ON DELETE SET NULL,
  music TEXT NOT NULL DEFAULT '', mix TEXT NOT NULL DEFAULT '', sync TEXT NOT NULL DEFAULT '', validation TEXT NOT NULL DEFAULT '',
  accept TEXT NOT NULL DEFAULT '{}', locked TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (production_id, number)
);
CREATE TABLE IF NOT EXISTS au_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, production_id INTEGER NOT NULL REFERENCES au_productions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  error TEXT NOT NULL DEFAULT '', failed_stage TEXT NOT NULL DEFAULT '', log TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auj_status ON au_jobs(status, id);
CREATE TABLE IF NOT EXISTS au_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, production_id INTEGER NOT NULL REFERENCES au_productions(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES au_versions(id) ON DELETE CASCADE, package TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id), approved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Every ElevenLabs call: characters (speech) or seconds (music), the cost header when the provider gives one.
CREATE TABLE IF NOT EXISTS audio_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, kind TEXT NOT NULL, characters INTEGER NOT NULL DEFAULT 0, seconds REAL NOT NULL DEFAULT 0,
  provider_cost REAL, request_id TEXT NOT NULL DEFAULT '', production_id INTEGER, user_id INTEGER, ok INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
db.exec(`UPDATE au_jobs SET status = 'queued' WHERE status = 'running';`);

// ---------- Module 6: AI video editing engine (new tables only) ----------
db.exec(`
-- One video edit per approved Audio Production Package (Module 5) of a planned video.
CREATE TABLE IF NOT EXISTS vd_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL, variation_index INTEGER NOT NULL DEFAULT 1, brief_id INTEGER NOT NULL, sb_plan_id INTEGER NOT NULL,
  sb_version_id INTEGER NOT NULL, au_production_id INTEGER NOT NULL REFERENCES au_productions(id) ON DELETE CASCADE,
  au_approval_id INTEGER NOT NULL REFERENCES au_approvals(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft', error TEXT NOT NULL DEFAULT '', approved_version_id INTEGER, approved_render_id INTEGER,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (au_approval_id)
);
-- Versions of the editing plan: AI director decisions, the Editing Decision List (EDL), output settings, checks.
CREATE TABLE IF NOT EXISTS vd_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, edit_id INTEGER NOT NULL REFERENCES vd_edits(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, parent_id INTEGER, label TEXT NOT NULL DEFAULT '', frozen INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
  director TEXT NOT NULL DEFAULT '', edl TEXT NOT NULL DEFAULT '', edl_hash TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
  validation TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (edit_id, number)
);
-- Clips of each version (also inside the EDL JSON): kept as rows so scene use can be checked and queried.
CREATE TABLE IF NOT EXISTS vd_clips (
  version_id INTEGER NOT NULL REFERENCES vd_versions(id) ON DELETE CASCADE, clip_id TEXT NOT NULL, ord INTEGER NOT NULL,
  scene_id INTEGER NOT NULL, asset_id INTEGER NOT NULL, segment_id TEXT NOT NULL DEFAULT '', timeline_start REAL NOT NULL, timeline_end REAL NOT NULL,
  source_start REAL NOT NULL, source_end REAL NOT NULL, PRIMARY KEY (version_id, clip_id)
);
CREATE INDEX IF NOT EXISTS idx_vdclips_scene ON vd_clips(scene_id);
-- Rendered videos (preview / standard / high). Same EDL + same settings = same render (reused, never made twice).
CREATE TABLE IF NOT EXISTS vd_renders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, edit_id INTEGER NOT NULL REFERENCES vd_edits(id) ON DELETE CASCADE, version_id INTEGER NOT NULL REFERENCES vd_versions(id) ON DELETE CASCADE,
  quality TEXT NOT NULL, edl_hash TEXT NOT NULL, config_hash TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', storage_key TEXT NOT NULL DEFAULT '', thumb_key TEXT NOT NULL DEFAULT '', audio_key TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, fps REAL NOT NULL DEFAULT 0,
  vcodec TEXT NOT NULL DEFAULT '', acodec TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, qc TEXT NOT NULL DEFAULT '', qc_ok INTEGER NOT NULL DEFAULT 0,
  render_seconds REAL NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vdr_hash ON vd_renders(edl_hash, config_hash);
-- Normalized clip cache (re-used by later renders while the clip, source and quality stay the same).
CREATE TABLE IF NOT EXISTS vd_clip_cache (hash TEXT PRIMARY KEY, storage_key TEXT NOT NULL, frames INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER, used_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS vd_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, edit_id INTEGER NOT NULL REFERENCES vd_edits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  error TEXT NOT NULL DEFAULT '', failed_stage TEXT NOT NULL DEFAULT '', log TEXT NOT NULL DEFAULT '', render_id INTEGER,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vdj_status ON vd_jobs(status, id);
CREATE TABLE IF NOT EXISTS vd_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, edit_id INTEGER NOT NULL REFERENCES vd_edits(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES vd_versions(id) ON DELETE CASCADE, render_id INTEGER NOT NULL REFERENCES vd_renders(id) ON DELETE CASCADE,
  package TEXT NOT NULL, approved_by INTEGER REFERENCES users(id), approved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Render usage: wall time, CPU time of ffmpeg, output size, temporary disk used (no invented costs).
CREATE TABLE IF NOT EXISTS vd_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, edit_id INTEGER, render_id INTEGER, job_id INTEGER, quality TEXT NOT NULL DEFAULT '', clips INTEGER NOT NULL DEFAULT 0,
  clips_cached INTEGER NOT NULL DEFAULT 0, wall_seconds REAL NOT NULL DEFAULT 0, cpu_seconds REAL NOT NULL DEFAULT 0, output_bytes INTEGER NOT NULL DEFAULT 0,
  temp_bytes INTEGER NOT NULL DEFAULT 0, peak_rss_mb REAL NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '',
  user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// A restart stops rendering: running work goes back to the queue (it starts again from the start of its stage).
db.exec(`UPDATE vd_jobs SET status = 'queued' WHERE status = 'running';`);
// ---------- Module 7: AI Captions & Visual Effects ----------
db.exec(`
-- Reusable brand kits (optional) and team caption presets; safe-zone presets updated by admins (code defaults otherwise).
CREATE TABLE IF NOT EXISTS vx_brand_kits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, logo_key TEXT NOT NULL DEFAULT '', logo_ratio REAL NOT NULL DEFAULT 1,
  primary_color TEXT NOT NULL DEFAULT '', secondary_color TEXT NOT NULL DEFAULT '', accent_color TEXT NOT NULL DEFAULT '',
  fonts TEXT NOT NULL DEFAULT '[]', caption_style TEXT NOT NULL DEFAULT '', cta_style TEXT NOT NULL DEFAULT '', logo_position TEXT NOT NULL DEFAULT 'top_right',
  logo_visible INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vx_caption_styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, base TEXT NOT NULL, config TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vx_safe_zones (key TEXT PRIMARY KEY, config TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
-- One visual enhancement per approved video edit (Module 6 approval) of a planned video.
CREATE TABLE IF NOT EXISTS vx_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL, variation_index INTEGER NOT NULL DEFAULT 1, vd_edit_id INTEGER NOT NULL REFERENCES vd_edits(id) ON DELETE CASCADE,
  vd_approval_id INTEGER NOT NULL REFERENCES vd_approvals(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'draft', error TEXT NOT NULL DEFAULT '',
  approved_version_id INTEGER, approved_render_id INTEGER, created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (vd_approval_id)
);
-- Versions of the Visual Enhancement Plan (director decisions, plan, settings, checks). Approved versions are frozen.
CREATE TABLE IF NOT EXISTS vx_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vx_id INTEGER NOT NULL REFERENCES vx_projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, parent_id INTEGER, label TEXT NOT NULL DEFAULT '', frozen INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
  director TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '', plan_hash TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
  validation TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (vx_id, number)
);
-- Timeline elements and caption words of each version (also inside the plan JSON), as rows for queries and Module 8.
CREATE TABLE IF NOT EXISTS vx_elements (
  version_id INTEGER NOT NULL REFERENCES vx_versions(id) ON DELETE CASCADE, element_id TEXT NOT NULL, type TEXT NOT NULL, track TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', start REAL NOT NULL, end REAL NOT NULL, layer INTEGER NOT NULL DEFAULT 0, template TEXT NOT NULL DEFAULT '',
  animation TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0,
  segment_id TEXT, clip_id TEXT, PRIMARY KEY (version_id, element_id)
);
CREATE TABLE IF NOT EXISTS vx_caption_words (
  version_id INTEGER NOT NULL REFERENCES vx_versions(id) ON DELETE CASCADE, element_id TEXT NOT NULL, idx INTEGER NOT NULL,
  word TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, highlight TEXT NOT NULL DEFAULT '', timing TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, element_id, idx)
);
CREATE TABLE IF NOT EXISTS vx_renders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vx_id INTEGER NOT NULL REFERENCES vx_projects(id) ON DELETE CASCADE, version_id INTEGER NOT NULL REFERENCES vx_versions(id) ON DELETE CASCADE,
  quality TEXT NOT NULL, plan_hash TEXT NOT NULL, edl_hash TEXT NOT NULL DEFAULT '', config_hash TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', storage_key TEXT NOT NULL DEFAULT '', thumb_key TEXT NOT NULL DEFAULT '', ass_key TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, fps REAL NOT NULL DEFAULT 0,
  vcodec TEXT NOT NULL DEFAULT '', acodec TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, qc TEXT NOT NULL DEFAULT '', qc_ok INTEGER NOT NULL DEFAULT 0,
  render_seconds REAL NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vxr_hash ON vx_renders(plan_hash, config_hash);
CREATE TABLE IF NOT EXISTS vx_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vx_id INTEGER NOT NULL REFERENCES vx_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  error TEXT NOT NULL DEFAULT '', failed_stage TEXT NOT NULL DEFAULT '', log TEXT NOT NULL DEFAULT '', render_id INTEGER,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vxj_status ON vx_jobs(status, id);
CREATE TABLE IF NOT EXISTS vx_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vx_id INTEGER NOT NULL REFERENCES vx_projects(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES vx_versions(id) ON DELETE CASCADE, render_id INTEGER NOT NULL REFERENCES vx_renders(id) ON DELETE CASCADE,
  package TEXT NOT NULL, approved_by INTEGER REFERENCES users(id), approved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vx_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vx_id INTEGER, render_id INTEGER, job_id INTEGER, quality TEXT NOT NULL DEFAULT '', wall_seconds REAL NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0, peak_rss_mb REAL NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '',
  user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
db.exec(`UPDATE vx_jobs SET status = 'queued' WHERE status = 'running';`);
