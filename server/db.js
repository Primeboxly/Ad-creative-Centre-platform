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

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
