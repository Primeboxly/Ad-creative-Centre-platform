// Where footage files live for good.
// - S3-compatible object storage (Railway Bucket, Cloudflare R2, Backblaze B2, AWS S3…) when its settings are given;
// - otherwise the server's persistent volume (DATA_DIR/store), which also survives deploys on Railway.
// Files are addressed by a key like "footage/p3/a12/original.mp4". The rest of the app never touches paths directly.
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, renameSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from './paths.js';

const env = (...names) => names.map(n => process.env[n]).find(v => v && String(v).trim()) || '';
const S3 = {
  endpoint: env('S3_ENDPOINT', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL', 'ENDPOINT'),
  bucket: env('S3_BUCKET', 'AWS_S3_BUCKET_NAME', 'BUCKET'),
  accessKeyId: env('S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'ACCESS_KEY_ID'),
  secretAccessKey: env('S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY', 'SECRET_ACCESS_KEY'),
  region: env('S3_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'REGION') || 'auto',
  pathStyle: env('S3_FORCE_PATH_STYLE') === '1',
};
const useS3 = Boolean(S3.bucket && S3.accessKeyId && S3.secretAccessKey);
export const STORE_DIR = join(DATA_DIR, 'store');
mkdirSync(STORE_DIR, { recursive: true });

// A key never leaves the store folder (no "..", no absolute paths).
function localPath(key) {
  const k = String(key).replace(/\\/g, '/');
  if (!/^[\w./-]+$/.test(k) || k.split('/').some(p => p === '..' || p === '')) throw new Error('Bad storage key');
  const p = normalize(join(STORE_DIR, k));
  if (!p.startsWith(normalize(STORE_DIR))) throw new Error('Bad storage key');
  return p;
}

let s3, sdk, presign;
async function client() {
  if (s3) return s3;
  sdk = await import('@aws-sdk/client-s3');
  ({ getSignedUrl: presign } = await import('@aws-sdk/s3-request-presigner'));
  s3 = new sdk.S3Client({
    region: S3.region,
    ...(S3.endpoint ? { endpoint: S3.endpoint } : {}),
    forcePathStyle: S3.pathStyle,
    // Extra checksums only when the provider asks for them: several S3-compatible services (R2, B2…) refuse the new default.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey },
  });
  return s3;
}

export const storage = {
  driver: useS3 ? 's3' : 'volume',
  describe: () => (useS3 ? `S3 bucket "${S3.bucket}"${S3.endpoint ? ` at ${new URL(S3.endpoint).host}` : ''}` : `server volume (${STORE_DIR})`),

  // Store a local file under `key`. `move` (volume only) moves instead of copying.
  async put(key, file, contentType = 'application/octet-stream', { move = false } = {}) {
    if (!useS3) {
      const dest = localPath(key);
      mkdirSync(dirname(dest), { recursive: true });
      if (move) { try { renameSync(file, dest); return; } catch { /* other disk: copy */ } }
      copyFileSync(file, dest);
      if (move) rmSync(file, { force: true });
      return;
    }
    const c = await client();
    // Bodies over ~100 MB go up in parts (Upload handles retries of each part).
    const { Upload } = await import('@aws-sdk/lib-storage').catch(() => ({}));
    if (Upload && statSync(file).size > 64 * 1024 * 1024) {
      await new Upload({ client: c, params: { Bucket: S3.bucket, Key: key, Body: createReadStream(file), ContentType: contentType } }).done();
    } else {
      await c.send(new sdk.PutObjectCommand({ Bucket: S3.bucket, Key: key, Body: createReadStream(file), ContentType: contentType, ContentLength: statSync(file).size }));
    }
    if (move) rmSync(file, { force: true });
  },

  // A local file with the content of `key` (volume: the stored file itself; S3: downloaded to `dest`).
  async toLocal(key, dest) {
    if (!useS3) { const p = localPath(key); if (!existsSync(p)) throw new Error('Stored file is missing: ' + key); return p; }
    const c = await client();
    const r = await c.send(new sdk.GetObjectCommand({ Bucket: S3.bucket, Key: key }));
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(r.Body, createWriteStream(dest));
    return dest;
  },

  async exists(key) {
    if (!useS3) return existsSync(localPath(key));
    const c = await client();
    try { await c.send(new sdk.HeadObjectCommand({ Bucket: S3.bucket, Key: key })); return true; } catch { return false; }
  },

  async remove(key) {
    if (!key) return;
    if (!useS3) { rmSync(localPath(key), { force: true }); return; }
    const c = await client();
    await c.send(new sdk.DeleteObjectCommand({ Bucket: S3.bucket, Key: key })).catch(e => console.error('S3 delete', key, e.message));
  },

  // Every stored object under a prefix: [{ key, size }] (used by the data reset to show and delete footage files).
  async listPrefix(prefix) {
    if (!useS3) {
      const out = [], walk = (dir, rel) => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
          else out.push({ key: rel + e.name, size: statSync(join(dir, e.name)).size });
        }
      };
      walk(localPath(prefix.replace(/\/$/, '')), prefix);
      return out;
    }
    const c = await client();
    const out = [];
    let token;
    do {
      const r = await c.send(new sdk.ListObjectsV2Command({ Bucket: S3.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size || 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  },

  // Delete ALL footage files (data reset only).
  async removeAllUnder(prefix) {
    if (prefix !== 'footage/') throw new Error('Refusing to delete ' + prefix);
    if (!useS3) { rmSync(localPath('footage'), { recursive: true, force: true }); return; }
    const c = await client();
    const keys = (await this.listPrefix(prefix)).map(o => ({ Key: o.key }));
    for (let i = 0; i < keys.length; i += 1000) await c.send(new sdk.DeleteObjectsCommand({ Bucket: S3.bucket, Delete: { Objects: keys.slice(i, i + 1000) } }));
  },

  // Delete everything under a folder-like prefix (e.g. one video's original, preview and pictures).
  async removePrefix(prefix) {
    if (!/^footage\/p\d+\/a\d+\/$/.test(prefix)) throw new Error('Refusing to delete ' + prefix);
    if (!useS3) { rmSync(localPath(prefix.slice(0, -1)), { recursive: true, force: true }); return; }
    const c = await client();
    let token;
    do {
      const r = await c.send(new sdk.ListObjectsV2Command({ Bucket: S3.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (r.Contents || []).map(o => ({ Key: o.Key }));
      if (keys.length) await c.send(new sdk.DeleteObjectsCommand({ Bucket: S3.bucket, Delete: { Objects: keys } }));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  },

  // Send the file to the browser: volume → streamed by Express (with Range support for video seeking);
  // S3 → a short-lived signed link (the bucket stays private).
  async serve(res, key, { type, download, maxAge = 600 } = {}) {
    if (!useS3) {
      const p = localPath(key);
      if (!existsSync(p)) return res.status(404).json({ error: 'File not found' });
      return download ? res.download(p, download) : res.sendFile(p, { headers: { 'Cache-Control': 'private, max-age=600', ...(type ? { 'Content-Type': type } : {}) } });
    }
    const c = await client();
    const url = await presign(c, new sdk.GetObjectCommand({
      Bucket: S3.bucket, Key: key,
      ...(download ? { ResponseContentDisposition: `attachment; filename="${download.replace(/[^\w.\- ]+/g, '_')}"` } : {}),
    }), { expiresIn: maxAge });
    res.set('Cache-Control', 'private, max-age=' + Math.max(0, maxAge - 60));
    res.redirect(302, url);
  },
};
