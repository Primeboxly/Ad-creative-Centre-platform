import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Everything that must survive a restart (database + files): ACC_DATA, else the Railway volume, else ./data
export const DATA_DIR = resolve(process.env.ACC_DATA || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data'));
export const DB_FILE = join(DATA_DIR, 'acc.db');
export const FILES_DIR = join(DATA_DIR, 'files');       // product pictures
export const TMP_DIR = join(DATA_DIR, 'tmp');           // uploads in progress and work files of background jobs
// Footage (originals, silent previews, pictures) lives in server/storage.js: DATA_DIR/store or an S3 bucket.

for (const d of [DATA_DIR, FILES_DIR, TMP_DIR]) mkdirSync(d, { recursive: true });
