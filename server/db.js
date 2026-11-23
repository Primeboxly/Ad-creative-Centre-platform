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
`);

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
