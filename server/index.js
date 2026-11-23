import express from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { db, tx } from './db.js';
import { ROOT, CLIPS_DIR, RAW_DIR, RENDERS_DIR, THUMBS_DIR, TMP_DIR } from './paths.js';
import { HttpError } from './errors.js';
import { checkPassword, hashPassword, createSession, cookieOpts, requireAuth, requireAdmin } from './auth.js';
import { probe, thumbnail, thumbOf, queueRenders, resumeRenders, removeFile } from './video.js';
import { writeScripts, LANGUAGES, aiReady } from './ai.js';
import { queueSplits, resumeSplits, rawName } from './split.js';

const app = express();
const PORT = Number(process.env.PORT) || 3100;
const PROD = process.env.NODE_ENV === 'production';
const KINDS = ['hook', 'body', 'cta'];
const STATUSES = ['draft', 'testing', 'winner', 'loser'];
const MAX_COMBOS = 60;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(ROOT, 'public')));

// Async route errors go to the error handler below.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validEmail = e => /^\S+@\S+\.\S+$/.test(e);
const idParam = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id'); return n; };
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

// ---------- Sign in ----------
const fails = new Map(); // 10 wrong passwords per IP per 15 minutes
const tooManyFails = ip => { const f = fails.get(ip); return f && f.until > Date.now() && f.n >= 10; };
const addFail = ip => {
  const f = fails.get(ip);
  fails.set(ip, f && f.until > Date.now() ? { n: f.n + 1, until: f.until } : { n: 1, until: Date.now() + 15 * 60e3 });
};
const noUsers = () => db.prepare(`SELECT COUNT(*) n FROM users`).get().n === 0;

app.get('/api/auth/setup', (req, res) => res.json({ needed: noUsers() }));

// The very first account (only while there is none) becomes the admin.
app.post('/api/auth/setup', (req, res) => {
  if (!noUsers()) return res.status(409).json({ error: 'The platform is already set up' });
  const { name, email, password } = req.body || {};
  const em = str(email, 200).toLowerCase();
  if (!str(name) || !validEmail(em) || String(password || '').length < 8)
    return res.status(400).json({ error: 'Name, email and a password of 8 characters minimum' });
  const id = db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?, 'admin')`)
    .run(em, str(name, 100), hashPassword(String(password))).lastInsertRowid;
  res.cookie('sid', createSession(id), cookieOpts()).json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  if (tooManyFails(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { email, password, remember } = req.body || {};
  const u = db.prepare(`SELECT * FROM users WHERE email = ?`).get(str(email, 200).toLowerCase());
  if (!u || !checkPassword(String(password || ''), u.password_hash)) {
    addFail(req.ip);
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (!u.active) return res.status(403).json({ error: 'This account is disabled' });
  res.cookie('sid', createSession(u.id), cookieOpts(remember !== false)).json({ ok: true });
});

app.use('/api', requireAuth);
app.use('/media', requireAuth);

app.post('/api/auth/logout', (req, res) => {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(req.token);
  res.clearCookie('sid').json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user, languages: LANGUAGES, ai: aiReady(), statuses: STATUSES }));

// ---------- Team (admin) ----------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT id, email, name, role, active, created_at FROM users ORDER BY id`).all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, email, password, role = 'member' } = req.body || {};
  const em = str(email, 200).toLowerCase();
  if (!str(name) || !validEmail(em) || String(password || '').length < 8)
    return res.status(400).json({ error: 'Name, email and a password of 8 characters minimum' });
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Unknown role' });
  if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(em)) return res.status(409).json({ error: 'This email already has an account' });
  db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)`).run(em, str(name, 100), hashPassword(String(password)), role);
  res.status(201).json({ ok: true });
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const id = idParam(req.params.id);
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!u) throw new HttpError(404, 'Account not found');
  const { active, role, password, name } = req.body || {};
  if (id === req.user.id && (active === false || (role && role !== 'admin'))) throw new HttpError(400, 'You cannot disable or demote yourself');
  if (role !== undefined && !['admin', 'member'].includes(role)) throw new HttpError(400, 'Unknown role');
  if (password !== undefined && String(password).length < 8) throw new HttpError(400, 'Password: 8 characters minimum');
  tx(() => {
    if (name !== undefined && str(name)) db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(str(name, 100), id);
    if (role !== undefined) db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
    if (active !== undefined) {
      db.prepare(`UPDATE users SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
      if (!active) db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
    }
    if (password !== undefined) db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(String(password)), id);
  });
  res.json({ ok: true });
});

// ---------- Products (one collection each) ----------
const productOr404 = id => {
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  if (!p) throw new HttpError(404, 'Product not found');
  return p;
};

app.get('/api/products', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM clips WHERE product_id = p.id AND kind = 'hook') hooks,
      (SELECT COUNT(*) FROM clips WHERE product_id = p.id AND kind = 'body') bodies,
      (SELECT COUNT(*) FROM clips WHERE product_id = p.id AND kind = 'cta') ctas,
      (SELECT COUNT(*) FROM scripts WHERE product_id = p.id) scripts,
      (SELECT COUNT(*) FROM creatives WHERE product_id = p.id) creatives,
      (SELECT COUNT(*) FROM creatives WHERE product_id = p.id AND status = 'winner') winners,
      (SELECT id FROM clips WHERE product_id = p.id ORDER BY kind = 'hook' DESC, id LIMIT 1) cover_clip
    FROM products p ORDER BY p.id DESC`).all());
});

app.post('/api/products', (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) throw new HttpError(400, 'Product name is required');
  const id = db.prepare(`INSERT INTO products (name, notes, created_by) VALUES (?,?,?)`).run(name, str(req.body?.notes, 4000), req.user.id).lastInsertRowid;
  res.status(201).json({ id });
});

app.get('/api/products/:id', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  res.json({
    product: p,
    clips: db.prepare(`SELECT c.*, u.name uploader FROM clips c LEFT JOIN users u ON u.id = c.uploaded_by WHERE c.product_id = ? ORDER BY c.kind, c.id`).all(p.id),
    scripts: db.prepare(`SELECT s.*, u.name author FROM scripts s LEFT JOIN users u ON u.id = s.created_by WHERE s.product_id = ? ORDER BY s.id DESC`).all(p.id),
    creatives: db.prepare(`SELECT c.*, u.name author FROM creatives c LEFT JOIN users u ON u.id = c.created_by WHERE c.product_id = ? ORDER BY c.id DESC`).all(p.id),
    // Full videos being auto-split (and the ones that failed). Finished ones are kept 1 hour to show "done".
    raws: db.prepare(`SELECT id, original_name, status, error, parts FROM raws WHERE product_id = ? AND (status <> 'done' OR created_at > datetime('now', '-1 hour')) ORDER BY id`).all(p.id),
  });
});

app.patch('/api/products/:id', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const name = req.body?.name !== undefined ? str(req.body.name, 200) : p.name;
  if (!name) throw new HttpError(400, 'Product name is required');
  const notes = req.body?.notes !== undefined ? str(req.body.notes, 4000) : p.notes;
  db.prepare(`UPDATE products SET name = ?, notes = ? WHERE id = ?`).run(name, notes, p.id);
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const clips = db.prepare(`SELECT id, file FROM clips WHERE product_id = ?`).all(p.id);
  const creatives = db.prepare(`SELECT id, file FROM creatives WHERE product_id = ?`).all(p.id);
  const raws = db.prepare(`SELECT file FROM raws WHERE product_id = ? AND status <> 'splitting'`).all(p.id);
  db.prepare(`DELETE FROM products WHERE id = ?`).run(p.id);
  for (const c of clips) { removeFile(CLIPS_DIR, c.file); rmSync(thumbOf('clip', c.id), { force: true }); }
  for (const c of creatives) { removeFile(RENDERS_DIR, c.file); rmSync(thumbOf('creative', c.id), { force: true }); }
  for (const r of raws) removeFile(RAW_DIR, r.file);
  res.json({ ok: true });
});

// ---------- Footage ----------
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp'];
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => cb(null, VIDEO_EXT.includes(extname(file.originalname).toLowerCase())),
});

app.post('/api/products/:id/clips', upload.array('files'), h(async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach(f => rmSync(f.path, { force: true }));
  try {
    const p = productOr404(idParam(req.params.id));
    const kind = req.body?.kind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Choose Hook, Body or CTA');
    if (!files.length) throw new HttpError(400, `No video received (accepted: ${VIDEO_EXT.join(' ')})`);
    const added = [], skipped = [];
    for (const f of files) {
      const info = await probe(f.path);
      if (!info.hasVideo || info.duration <= 0) { skipped.push(f.originalname); rmSync(f.path, { force: true }); continue; }
      const name = `p${p.id}-${randomBytes(8).toString('hex')}${extname(f.originalname).toLowerCase()}`;
      renameSync(f.path, join(CLIPS_DIR, name));
      const id = db.prepare(`INSERT INTO clips (product_id, kind, file, original_name, label, duration, has_audio, uploaded_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(p.id, kind, name, f.originalname.slice(0, 200), f.originalname.replace(/\.[^.]+$/, '').slice(0, 80),
          info.duration, info.hasAudio ? 1 : 0, req.user.id).lastInsertRowid;
      await thumbnail(join(CLIPS_DIR, name), thumbOf('clip', id));
      added.push(id);
    }
    res.status(201).json({ added: added.length, skipped });
  } finally { cleanup(); }
}));

const clipOr404 = id => {
  const c = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(id);
  if (!c) throw new HttpError(404, 'Clip not found');
  return c;
};

app.patch('/api/clips/:id', (req, res) => {
  const c = clipOr404(idParam(req.params.id));
  const kind = req.body?.kind ?? c.kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Choose Hook, Body or CTA');
  db.prepare(`UPDATE clips SET kind = ?, label = ? WHERE id = ?`).run(kind, req.body?.label !== undefined ? str(req.body.label, 80) : c.label, c.id);
  res.json({ ok: true });
});

app.delete('/api/clips/:id', (req, res) => {
  const c = clipOr404(idParam(req.params.id));
  db.prepare(`DELETE FROM clips WHERE id = ?`).run(c.id);
  removeFile(CLIPS_DIR, c.file);
  rmSync(thumbOf('clip', c.id), { force: true });
  res.json({ ok: true });
});

// ---------- Auto-split: full videos in, hook + body + CTA clips out ----------
app.post('/api/products/:id/raw', upload.array('files'), (req, res) => {
  const files = req.files || [];
  try {
    const p = productOr404(idParam(req.params.id));
    if (!files.length) throw new HttpError(400, `No video received (accepted: ${VIDEO_EXT.join(' ')})`);
    tx(() => {
      for (const f of files) {
        const name = rawName(p.id, f.originalname);
        renameSync(f.path, join(RAW_DIR, name));
        db.prepare(`INSERT INTO raws (product_id, file, original_name, uploaded_by) VALUES (?,?,?,?)`).run(p.id, name, f.originalname.slice(0, 200), req.user.id);
      }
    });
    queueSplits();
    res.status(201).json({ queued: files.length });
  } finally { files.forEach(f => rmSync(f.path, { force: true })); }
});

const rawOr404 = id => {
  const r = db.prepare(`SELECT * FROM raws WHERE id = ?`).get(id);
  if (!r) throw new HttpError(404, 'Video not found');
  return r;
};

app.post('/api/raws/:id/retry', (req, res) => {
  const r = rawOr404(idParam(req.params.id));
  if (r.status !== 'failed') throw new HttpError(400, 'Only a failed video can be tried again');
  if (!existsSync(join(RAW_DIR, r.file))) throw new HttpError(410, 'The video file is gone: upload it again');
  db.prepare(`UPDATE raws SET status = 'queued', error = '' WHERE id = ?`).run(r.id);
  queueSplits();
  res.json({ ok: true });
});

app.delete('/api/raws/:id', (req, res) => {
  const r = rawOr404(idParam(req.params.id));
  if (r.status === 'splitting') throw new HttpError(409, 'This video is being cut right now. Wait a moment.');
  db.prepare(`DELETE FROM raws WHERE id = ?`).run(r.id);
  removeFile(RAW_DIR, r.file);
  res.json({ ok: true });
});

// ---------- Scripts ----------
const insertScript = (pid, uid, lang, s) => db.prepare(`
  INSERT INTO scripts (product_id, language, angle, hook, body, cta, primary_text, headline, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(pid, lang, str(s.angle, 80), str(s.hook), str(s.body, 4000), str(s.cta), str(s.primary_text, 4000), str(s.headline, 200), uid).lastInsertRowid;

app.post('/api/products/:id/scripts/generate', h(async (req, res) => {
  const p = productOr404(idParam(req.params.id));
  if (!aiReady()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  const { language = 'en', count = 3, extra = '' } = req.body || {};
  const scripts = await writeScripts({ product: p.name, notes: p.notes, language, count, extra: str(extra, 1000) });
  const ids = tx(() => scripts.map(s => insertScript(p.id, req.user.id, language, s)));
  res.status(201).json({ ids });
}));

app.post('/api/products/:id/scripts', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const s = req.body || {};
  if (!LANGUAGES[s.language]) throw new HttpError(400, 'Unknown language');
  if (!str(s.hook) || !str(s.body) || !str(s.cta)) throw new HttpError(400, 'Hook, body and CTA are required');
  res.status(201).json({ id: insertScript(p.id, req.user.id, s.language, s) });
});

app.delete('/api/scripts/:id', (req, res) => {
  const r = db.prepare(`DELETE FROM scripts WHERE id = ?`).run(idParam(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Script not found');
  res.json({ ok: true });
});

// ---------- Creatives ----------
// Every combination of the chosen hooks × bodies × CTAs becomes one video. A part with nothing chosen is left out.
app.post('/api/products/:id/creatives', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const pick = (list, kind) => {
    const ids = [...new Set((Array.isArray(list) ? list : []).map(Number))];
    for (const id of ids) {
      const c = db.prepare(`SELECT kind FROM clips WHERE id = ? AND product_id = ?`).get(id, p.id);
      if (!c || c.kind !== kind) throw new HttpError(400, `Clip ${id} is not a ${kind} of this product`);
    }
    return ids.length ? ids : [null];
  };
  const hooks = pick(req.body?.hooks, 'hook'), bodies = pick(req.body?.bodies, 'body'), ctas = pick(req.body?.ctas, 'cta');
  const scriptId = req.body?.script_id ? Number(req.body.script_id) : null;
  if (scriptId && !db.prepare(`SELECT 1 FROM scripts WHERE id = ? AND product_id = ?`).get(scriptId, p.id)) throw new HttpError(400, 'Unknown script');
  const combos = [];
  for (const hk of hooks) for (const b of bodies) for (const c of ctas) if (hk || b || c) combos.push([hk, b, c]);
  if (!combos.length) throw new HttpError(400, 'Pick at least one clip');
  if (combos.length > MAX_COMBOS) throw new HttpError(400, `${combos.length} videos is too many at once (max ${MAX_COMBOS})`);
  const ids = tx(() => combos.map(([hk, b, c]) => {
    const name = [hk && `H${hk}`, b && `B${b}`, c && `C${c}`].filter(Boolean).join(' + ');
    return db.prepare(`INSERT INTO creatives (product_id, hook_clip, body_clip, cta_clip, script_id, name, created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(p.id, hk, b, c, scriptId, name, req.user.id).lastInsertRowid;
  }));
  queueRenders();
  res.status(201).json({ ids });
});

const creativeOr404 = id => {
  const c = db.prepare(`SELECT * FROM creatives WHERE id = ?`).get(id);
  if (!c) throw new HttpError(404, 'Creative not found');
  return c;
};

app.patch('/api/creatives/:id', (req, res) => {
  const c = creativeOr404(idParam(req.params.id));
  const status = req.body?.status ?? c.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
  db.prepare(`UPDATE creatives SET status = ?, name = ? WHERE id = ?`).run(status, req.body?.name !== undefined ? str(req.body.name, 120) : c.name, c.id);
  res.json({ ok: true });
});

app.post('/api/creatives/:id/retry', (req, res) => {
  const c = creativeOr404(idParam(req.params.id));
  if (c.render !== 'failed') throw new HttpError(400, 'Only a failed video can be made again');
  db.prepare(`UPDATE creatives SET render = 'queued', error = '' WHERE id = ?`).run(c.id);
  queueRenders();
  res.json({ ok: true });
});

app.delete('/api/creatives/:id', (req, res) => {
  const c = creativeOr404(idParam(req.params.id));
  if (c.render === 'rendering') throw new HttpError(409, 'This video is being made right now. Wait a moment.');
  db.prepare(`DELETE FROM creatives WHERE id = ?`).run(c.id);
  removeFile(RENDERS_DIR, c.file);
  rmSync(thumbOf('creative', c.id), { force: true });
  res.json({ ok: true });
});

// ---------- Media (signed-in users only) ----------
app.get('/media/clip/:id', (req, res) => {
  const c = clipOr404(idParam(req.params.id));
  res.sendFile(join(CLIPS_DIR, c.file));
});
app.get('/media/creative/:id', (req, res) => {
  const c = creativeOr404(idParam(req.params.id));
  if (c.render !== 'ready' || !c.file) throw new HttpError(404, 'Video not ready');
  const p = db.prepare(`SELECT name FROM products WHERE id = ?`).get(c.product_id);
  const nice = `${(p?.name || 'creative').replace(/[^\w\- ]+/g, '').trim().slice(0, 50) || 'creative'} - ${c.id}.mp4`;
  if (req.query.download) return res.download(join(RENDERS_DIR, c.file), nice);
  res.sendFile(join(RENDERS_DIR, c.file));
});
app.get('/media/thumb/:type/:id', (req, res) => {
  if (!['clip', 'creative'].includes(req.params.type)) throw new HttpError(404, 'Not found');
  const f = thumbOf(req.params.type, idParam(req.params.id));
  if (!existsSync(f)) throw new HttpError(404, 'No picture');
  res.sendFile(f, { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

// ---------- Errors ----------
app.use((err, req, res, next) => {
  res.set('Cache-Control', 'no-store'); // never let a browser keep an error
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A video is bigger than 500 MB' : err.message });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// First start online: create the admin from the settings (ADMIN_EMAIL + ADMIN_PASSWORD).
if (noUsers() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?, 'Admin', ?, 'admin')`)
    .run(process.env.ADMIN_EMAIL.toLowerCase().trim(), hashPassword(process.env.ADMIN_PASSWORD));
  console.log('Admin account created from ADMIN_EMAIL');
}

resumeRenders();
resumeSplits();
app.listen(PORT, () => console.log(`Ad creative Centre on http://localhost:${PORT}`));
