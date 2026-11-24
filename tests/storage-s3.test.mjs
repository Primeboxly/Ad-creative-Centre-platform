// The S3 storage path (Railway Bucket, R2, B2, AWS) against a tiny fake S3 server on this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake S3 (path-style): PUT, GET, HEAD, DELETE, list (GET ?list-type=2) and multi-delete (POST ?delete).
const objects = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, bucket, ...rest] = u.pathname.split('/');
  const key = decodeURIComponent(rest.join('/'));
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (bucket !== 'acc-test') { res.statusCode = 404; return res.end(); }
    if (req.method === 'PUT') { objects.set(key, body); res.setHeader('ETag', '"x"'); return res.end(); }
    if (req.method === 'POST' && u.searchParams.has('delete')) {
      for (const m of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(m[1]);
      res.setHeader('Content-Type', 'application/xml');
      return res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
    }
    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix));
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>acc-test</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map(k => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('')}</ListBucketResult>`);
    }
    if (!objects.has(key)) { res.statusCode = 404; res.setHeader('Content-Type', 'application/xml'); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
    if (req.method === 'HEAD') { res.setHeader('Content-Length', objects.get(key).length); return res.end(); }
    if (req.method === 'GET') { res.setHeader('Content-Length', objects.get(key).length); return res.end(objects.get(key)); }
    if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
    res.statusCode = 400; res.end();
  });
});

test('S3 storage: put, exists, download, signed link, delete one, delete a video folder', async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'acc-s3-'));
  Object.assign(process.env, {
    ACC_DATA: dir, S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_BUCKET: 'acc-test', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
    S3_REGION: 'us-east-1', S3_FORCE_PATH_STYLE: '1',
  });
  const { storage } = await import('../server/storage.js');
  assert.equal(storage.driver, 's3');
  const src = join(dir, 'in.bin');
  writeFileSync(src, 'video-bytes-123');
  await storage.put('footage/p1/a2/original.mp4', src, 'video/mp4');
  await storage.put('footage/p1/a2/thumb.jpg', src, 'image/jpeg');
  await storage.put('footage/p1/a3/original.mp4', src, 'video/mp4');
  assert.equal(await storage.exists('footage/p1/a2/original.mp4'), true);
  assert.equal(await storage.exists('footage/p1/a2/nope.mp4'), false);
  const local = await storage.toLocal('footage/p1/a2/original.mp4', join(dir, 'dl', 'x.mp4'));
  assert.equal(readFileSync(local, 'utf8'), 'video-bytes-123');
  // serve() answers with a redirect to a signed, short-lived link
  let redirected = '';
  await storage.serve({ set() {}, redirect: (code, url) => { redirected = url; assert.equal(code, 302); } }, 'footage/p1/a2/original.mp4');
  assert.match(redirected, /X-Amz-Signature=/); assert.match(redirected, /X-Amz-Expires=600/);
  await storage.remove('footage/p1/a2/thumb.jpg');
  assert.equal(objects.has('footage/p1/a2/thumb.jpg'), false);
  await storage.removePrefix('footage/p1/a2/');
  assert.deepEqual([...objects.keys()], ['footage/p1/a3/original.mp4']);
  await assert.rejects(() => storage.removePrefix('footage/'), /Refusing/);
  server.close();
});
