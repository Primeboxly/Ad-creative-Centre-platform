import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Everything that must survive a restart (database + videos): ACC_DATA, else the Railway volume, else ./data
export const DATA_DIR = resolve(process.env.ACC_DATA || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data'));
export const DB_FILE = join(DATA_DIR, 'acc.db');
export const CLIPS_DIR = join(DATA_DIR, 'clips');       // uploaded footage
export const RENDERS_DIR = join(DATA_DIR, 'renders');   // finished ad videos
export const THUMBS_DIR = join(DATA_DIR, 'thumbs');     // one picture per clip / creative
export const TMP_DIR = join(DATA_DIR, 'tmp');           // uploads in progress

for (const d of [DATA_DIR, CLIPS_DIR, RENDERS_DIR, THUMBS_DIR, TMP_DIR]) mkdirSync(d, { recursive: true });
