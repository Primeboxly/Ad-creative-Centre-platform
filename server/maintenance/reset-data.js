// One-time data reset: deletes every product, footage, scene, AI result and all data of the removed legacy features,
// keeps user accounts, sessions, settings and the Module 1 + Module 2 tables (empty).
//
// On Railway (no shell needed): set the service variable
//   ACC_RESET_DATA=dry-run                → the deploy logs show what WOULD be deleted, nothing changes
//   ACC_RESET_DATA=EXECUTE-2026-11-25     → backup of the database, then the deletion; runs once (a marker file remembers it)
// then remove the variable.  Locally: node server/maintenance/reset-data.js --dry-run | --execute
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { DATA_DIR, DB_FILE } from '../paths.js';
import { storage } from '../storage.js';

export const EXECUTE_TOKEN = 'EXECUTE-2026-11-25';
const BACKUPS = join(DATA_DIR, 'backups');
// Data tables emptied (children first). Accounts (users, sessions) are kept.
const DATA_TABLES = ['scene_angles', 'scene_tags', 'scene_analyses', 'footage_scenes', 'footage_jobs', 'footage_assets', 'ai_cache',
  'angles', 'analyses', 'ai_jobs', 'product_images', 'ai_usage', 'products'];
// Tables of the removed features (scripts, voice-over, music, ad maker, inspiration): dropped.
const LEGACY_TABLES = ['creatives', 'clips', 'raws', 'scripts', 'music', 'inspirations'];
const LEGACY_PRODUCT_COLUMNS = ['banner', 'music_style', 'link_amazon'];
// Folders on the volume: legacy ones are removed, the others emptied. Never: acc.db*, backups/.
const LEGACY_DIRS = ['clips', 'raw', 'voice', 'music', 'work', 'renders', 'thumbs'];
const EMPTY_DIRS = ['files', 'tmp', 'incoming', 'store'];

const tableExists = t => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t));
const count = t => (tableExists(t) ? db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n : null);
function folderSize(dir) {
  let files = 0, bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const s = folderSize(p); files += s.files; bytes += s.bytes; } else { files++; bytes += statSync(p).size; }
  }
  return { files, bytes };
}
const mb = b => `${(b / 1048576).toFixed(1)} MB`;

// What is there now (also the dry run).
export async function scope() {
  const tables = Object.fromEntries([...DATA_TABLES, ...LEGACY_TABLES, 'users', 'sessions'].map(t => [t, count(t)]));
  const folders = Object.fromEntries([...LEGACY_DIRS, ...EMPTY_DIRS].map(d => [d, folderSize(join(DATA_DIR, d))]));
  const productCols = db.prepare(`PRAGMA table_info(products)`).all().map(c => c.name).filter(c => LEGACY_PRODUCT_COLUMNS.includes(c));
  const bucket = storage.driver === 's3' ? await storage.listPrefix('footage/').then(l => ({ objects: l.length, bytes: l.reduce((s, o) => s + (o.size || 0), 0) })) : null;
  return { dataDir: DATA_DIR, storage: storage.describe(), tables, legacyColumns: productCols, folders, bucket };
}

export function describe(s) {
  const lines = [`Data folder: ${s.dataDir} · storage: ${s.storage}`, 'Rows to delete:'];
  for (const t of DATA_TABLES) if (s.tables[t] !== null) lines.push(`  ${t.padEnd(16)} ${s.tables[t]}`);
  lines.push('Legacy tables to drop (rows inside):');
  for (const t of LEGACY_TABLES) lines.push(`  ${t.padEnd(16)} ${s.tables[t] === null ? '(not there)' : s.tables[t]}`);
  lines.push(`Legacy product columns to drop: ${s.legacyColumns.join(', ') || 'none'}`);
  lines.push('Files on the volume to delete:');
  for (const [d, v] of Object.entries(s.folders)) lines.push(`  ${d.padEnd(10)} ${v.files} files, ${mb(v.bytes)}${LEGACY_DIRS.includes(d) ? ' (folder removed)' : ''}`);
  if (s.bucket) lines.push(`Bucket objects under footage/: ${s.bucket.objects}, ${mb(s.bucket.bytes)}`);
  lines.push(`Kept: users ${s.tables.users}, sessions ${s.tables.sessions}, all settings and variables.`);
  return lines.join('\n');
}

export async function execute() {
  // 1. Backup of the whole database first (a consistent copy, even while the site runs).
  mkdirSync(BACKUPS, { recursive: true });
  const backup = join(BACKUPS, `acc-before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  const before = await scope();
  // 2. Stop footage work, then delete the rows and drop the legacy tables in one transaction.
  db.exec(`UPDATE footage_jobs SET status = 'cancelled' WHERE status IN ('queued','running')`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const t of LEGACY_TABLES) if (tableExists(t)) db.exec(`DROP TABLE "${t}"`);
    for (const t of DATA_TABLES) if (tableExists(t)) db.exec(`DELETE FROM "${t}"`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${DATA_TABLES.map(t => `'${t}'`).join(',')})`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); db.exec('PRAGMA foreign_keys = ON'); throw e; }
  for (const c of before.legacyColumns) {
    try { db.exec(`ALTER TABLE products DROP COLUMN ${c}`); } catch (e) { console.error(`Could not drop products.${c}:`, e.message); }
  }
  db.exec('PRAGMA foreign_keys = ON');
  // 3. Files: volume folders, then the bucket.
  for (const d of LEGACY_DIRS) rmSync(join(DATA_DIR, d), { recursive: true, force: true });
  for (const d of EMPTY_DIRS) { rmSync(join(DATA_DIR, d), { recursive: true, force: true }); mkdirSync(join(DATA_DIR, d), { recursive: true }); }
  if (storage.driver === 's3') await storage.removeAllUnder('footage/');
  db.exec('VACUUM');
  // 4. Checks: nothing left, no broken links between tables, database healthy.
  const after = await scope();
  const left = DATA_TABLES.filter(t => after.tables[t]);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  const integrity = db.prepare('PRAGMA integrity_check').get();
  return { backup, before, after, left, fk, integrity: Object.values(integrity)[0] };
}

// Called once at server start (before the footage worker): follows ACC_RESET_DATA.
export async function resetFromEnv() {
  const mode = String(process.env.ACC_RESET_DATA || '').trim();
  if (!mode) return;
  if (mode === 'dry-run') { console.log('[reset] DRY RUN, nothing is changed.\n' + describe(await scope())); return; }
  if (mode !== EXECUTE_TOKEN) { console.log(`[reset] ACC_RESET_DATA="${mode}" is not understood: use dry-run or ${EXECUTE_TOKEN}. Nothing changed.`); return; }
  const marker = join(BACKUPS, `reset-done-${EXECUTE_TOKEN}.json`);
  if (existsSync(marker)) { console.log(`[reset] Already done (${marker}). Remove the ACC_RESET_DATA variable.`); return; }
  console.log('[reset] Starting. Scope:\n' + describe(await scope()));
  const r = await execute();
  mkdirSync(BACKUPS, { recursive: true });
  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), backup: r.backup, before: r.before, after: r.after }, null, 2));
  console.log(`[reset] DONE. Database backup: ${r.backup}\n[reset] Rows left in data tables: ${r.left.length ? r.left.join(', ') : 'none'} · broken links: ${r.fk.length} · integrity: ${r.integrity}\n` + describe(r.after));
}

// Command line (local): node server/maintenance/reset-data.js --dry-run | --execute
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/maintenance/reset-data.js')) {
  const s = await scope();
  console.log(`Database: ${DB_FILE}\n` + describe(s));
  if (process.argv.includes('--execute')) {
    const r = await execute();
    console.log(`\nDONE. Backup: ${r.backup}\nRows left: ${r.left.join(', ') || 'none'} · broken links: ${r.fk.length} · integrity: ${r.integrity}`);
  } else console.log('\n(dry run: add --execute to delete)');
}
