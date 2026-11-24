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
