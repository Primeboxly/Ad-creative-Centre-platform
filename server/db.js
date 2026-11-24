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
-- One collection per product: its footage, scripts and finished creatives.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',        -- benefits, audience, price, offer: given to the AI
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A clip is one piece of footage, tagged as a hook, a body or a call to action.
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hook','body','cta')),
  file TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  has_audio INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clips_product ON clips(product_id, kind);
-- A full video uploaded to be auto-split into hook + body + CTA clips (deleted once split).
CREATE TABLE IF NOT EXISTS raws (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','splitting','done','failed')),
  error TEXT NOT NULL DEFAULT '',
  parts INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- AI (or hand) written scripts: hook + body + CTA in one language.
CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  angle TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL,
  body TEXT NOT NULL,
  cta TEXT NOT NULL,
  primary_text TEXT NOT NULL DEFAULT '',  -- ad copy for the post
  headline TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A finished ad video = hook clip + body clip + CTA clip, rendered to 1080x1920.
CREATE TABLE IF NOT EXISTS creatives (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  hook_clip INTEGER REFERENCES clips(id) ON DELETE SET NULL,
  body_clip INTEGER REFERENCES clips(id) ON DELETE SET NULL,
  cta_clip INTEGER REFERENCES clips(id) ON DELETE SET NULL,
  script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  render TEXT NOT NULL DEFAULT 'queued' CHECK (render IN ('queued','rendering','ready','failed')),
  error TEXT NOT NULL DEFAULT '',
  file TEXT,
  duration REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','testing','winner','loser')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_creatives_product ON creatives(product_id);
-- Background music tracks, shared by all products.
CREATE TABLE IF NOT EXISTS music (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Columns added after the first version (kept separate so old databases get them too).
const addColumn = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addColumn('products', 'banner', "TEXT NOT NULL DEFAULT ''");       // CTA banner text, e.g. "PAY ON DELIVERY · 680 ZMW"
addColumn('creatives', 'voice_id', "TEXT NOT NULL DEFAULT ''");    // ElevenLabs voice reading the script ('' = none)
addColumn('creatives', 'voice_name', "TEXT NOT NULL DEFAULT ''");
addColumn('creatives', 'music_id', 'INTEGER REFERENCES music(id) ON DELETE SET NULL');
addColumn('creatives', 'captions', 'INTEGER NOT NULL DEFAULT 0');
addColumn('music', 'from_video', "TEXT NOT NULL DEFAULT ''");      // the video this sound was taken from ('' = uploaded music)
addColumn('clips', 'music_id', 'INTEGER REFERENCES music(id) ON DELETE SET NULL'); // sound of the video the clip was cut from
addColumn('creatives', 'clip_sound', 'INTEGER NOT NULL DEFAULT 0'); // keep the clips' own sound under the voice
addColumn('music', 'product_id', 'INTEGER REFERENCES products(id) ON DELETE SET NULL'); // AI music made for this product
addColumn('music', 'prompt', "TEXT NOT NULL DEFAULT ''");          // the description it was made from (AI music)
addColumn('products', 'music_style', "TEXT NOT NULL DEFAULT ''");  // last music description used for the product
addColumn('creatives', 'style', "TEXT NOT NULL DEFAULT 'classic'"); // 'classic' (hook+body+CTA clips) or 'bss' (montage, docs/style-bss-watch.md)
addColumn('creatives', 'format', "TEXT NOT NULL DEFAULT '9x16'");   // '9x16' or '4x5'
addColumn('creatives', 'body_pool', "TEXT NOT NULL DEFAULT ''");    // bss: ids of all the body clips the montage uses (JSON)
addColumn('scripts', 'style', "TEXT NOT NULL DEFAULT 'classic'");   // how the AI wrote it
// Product page: picture, links, markets and status.
addColumn('products', 'image', "TEXT NOT NULL DEFAULT ''");          // file in /files ( = first clip picture)
addColumn('products', 'link_product', "TEXT NOT NULL DEFAULT ''");   // our product / landing page
addColumn('products', 'link_alibaba', "TEXT NOT NULL DEFAULT ''");   // Alibaba / 1688 supplier
addColumn('products', 'link_amazon', "TEXT NOT NULL DEFAULT ''");     // old: now kept in link_alibaba (see below)
// Alibaba, 1688 and Amazon are one "where we found the product" link (link_alibaba): move old Amazon links there.
db.exec(`UPDATE products SET link_alibaba = link_amazon, link_amazon = '' WHERE link_alibaba = '' AND link_amazon <> ''`);
addColumn('products', 'markets', "TEXT NOT NULL DEFAULT '[]'");      // JSON [{ code, price }]
addColumn('products', 'status', "TEXT NOT NULL DEFAULT 'testing'"); // idea | testing | scaling | paused
db.exec(`
-- Inspiration: ads or pictures the team likes for this product (to copy the style).
CREATE TABLE IF NOT EXISTS inspirations (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video','image')),
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

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
  kind TEXT NOT NULL,                  -- import | analysis | angles | angle | scripts
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
