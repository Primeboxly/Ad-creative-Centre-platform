import express from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { db, tx } from './db.js';
import { ROOT, CLIPS_DIR, RAW_DIR, RENDERS_DIR, THUMBS_DIR, TMP_DIR, MUSIC_DIR, FILES_DIR } from './paths.js';
import { HttpError } from './errors.js';
import { checkPassword, hashPassword, createSession, cookieOpts, requireAuth, requireAdmin } from './auth.js';
import { probe, thumbnail, thumbOf, queueRenders, resumeRenders, removeFile, captionsReady, extractAudio } from './video.js';
import { ttsReady, listVoices, composeMusic } from './tts.js';
import { writeScripts, LANGUAGES, aiReady } from './ai.js';
import { queueSplits, resumeSplits, rawName } from './split.js';

const app = express();
const PORT = Number(process.env.PORT) || 3100;
const PROD = process.env.NODE_ENV === 'production';
const KINDS = ['hook', 'body', 'cta'];
const STATUSES = ['draft', 'testing', 'winner', 'loser'];
const MAX_COMBOS = 100;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '1mb' }));
// no-cache: the browser checks for a newer page/script on every load (after each deploy everyone gets the new version).
app.use(express.static(join(ROOT, 'public'), { setHeaders: res => res.set('Cache-Control', 'no-cache') }));

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

app.get('/api/me', (req, res) => res.json({ user: req.user, languages: LANGUAGES, ai: aiReady(), tts: ttsReady(), captions: captionsReady(), statuses: STATUSES }));

// ElevenLabs voices of the account (for the Build bar).
app.get('/api/voices', async (req, res) => res.json(await listVoices()));

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

// Countries we sell in (COD). Prices are typed per product in its market's currency.
const MARKETS = {
  ZM: { name: 'Zambia', currency: 'ZMW' }, ZW: { name: 'Zimbabwe', currency: 'USD' }, KE: { name: 'Kenya', currency: 'KES' },
  TZ: { name: 'Tanzania', currency: 'TZS' }, UG: { name: 'Uganda', currency: 'UGX' }, RW: { name: 'Rwanda', currency: 'RWF' },
  MW: { name: 'Malawi', currency: 'MWK' }, MZ: { name: 'Mozambique', currency: 'MZN' }, BW: { name: 'Botswana', currency: 'BWP' },
  NA: { name: 'Namibia', currency: 'NAD' }, NG: { name: 'Nigeria', currency: 'NGN' }, GH: { name: 'Ghana', currency: 'GHS' },
  CI: { name: "Côte d'Ivoire", currency: 'XOF' }, SN: { name: 'Senegal', currency: 'XOF' }, CM: { name: 'Cameroon', currency: 'XAF' },
  CD: { name: 'DR Congo', currency: 'CDF' }, MA: { name: 'Morocco', currency: 'MAD' },
};
const STATUSES_P = ['idea', 'testing', 'scaling', 'paused'];
const marketsOf = p => { try { return JSON.parse(p.markets || '[]'); } catch { return []; } };
const withMarkets = p => ({ ...p, markets: marketsOf(p) });
const cleanUrl = v => {
  const s = str(v, 500);
  if (!s) return '';
  const u = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try { return new URL(u).href; } catch { throw new HttpError(400, `Not a valid link: ${s}`); }
};

app.get('/api/markets', (req, res) => res.json(MARKETS));

// Sidebar: counts, the 6 most recently active products, and what is being made right now.
app.get('/api/sidebar', (req, res) => {
  const one = sql => db.prepare(sql).get().n;
  res.json({
    products: one(`SELECT COUNT(*) n FROM products`),
    music: one(`SELECT COUNT(*) n FROM music`),
    team: one(`SELECT COUNT(*) n FROM users WHERE active = 1`),
    making: one(`SELECT COUNT(*) n FROM creatives WHERE render IN ('queued','rendering')`),
    cutting: one(`SELECT COUNT(*) n FROM raws WHERE status IN ('queued','splitting')`),
    ready: one(`SELECT COUNT(*) n FROM creatives WHERE render = 'ready'`),
    recent: db.prepare(`
      SELECT p.id, p.name, p.image,
        (SELECT id FROM clips WHERE product_id = p.id ORDER BY kind = 'hook' DESC, id LIMIT 1) cover_clip,
        (SELECT COUNT(*) FROM creatives WHERE product_id = p.id AND render IN ('queued','rendering')) making,
        MAX(p.created_at, IFNULL((SELECT MAX(created_at) FROM creatives WHERE product_id = p.id), ''),
          IFNULL((SELECT MAX(created_at) FROM clips WHERE product_id = p.id), '')) last_activity
      FROM products p ORDER BY last_activity DESC LIMIT 6`).all(),
  });
});

app.get('/api/products', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM clips WHERE product_id = p.id AND kind = 'hook') hooks,
      (SELECT COUNT(*) FROM clips WHERE product_id = p.id AND kind = 'body') bodies,
      (SELECT COUNT(*) FROM clips WHERE product_id = p.id AND kind = 'cta') ctas,
      (SELECT COUNT(*) FROM scripts WHERE product_id = p.id) scripts,
      (SELECT COUNT(*) FROM creatives WHERE product_id = p.id) creatives,
      (SELECT COUNT(*) FROM creatives WHERE product_id = p.id AND status = 'winner') winners,
      (SELECT COUNT(*) FROM inspirations WHERE product_id = p.id) inspirations,
      (SELECT id FROM clips WHERE product_id = p.id ORDER BY kind = 'hook' DESC, id LIMIT 1) cover_clip,
      MAX(p.created_at, IFNULL((SELECT MAX(created_at) FROM creatives WHERE product_id = p.id), ''),
        IFNULL((SELECT MAX(created_at) FROM clips WHERE product_id = p.id), '')) last_activity
    FROM products p ORDER BY last_activity DESC`).all().map(withMarkets));
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
    product: withMarkets(p),
    clips: db.prepare(`SELECT c.*, u.name uploader FROM clips c LEFT JOIN users u ON u.id = c.uploaded_by WHERE c.product_id = ? ORDER BY c.kind, c.id`).all(p.id),
    scripts: db.prepare(`SELECT s.*, u.name author FROM scripts s LEFT JOIN users u ON u.id = s.created_by WHERE s.product_id = ? ORDER BY s.id DESC`).all(p.id),
    creatives: db.prepare(`SELECT c.*, u.name author FROM creatives c LEFT JOIN users u ON u.id = c.created_by WHERE c.product_id = ? ORDER BY c.id DESC`).all(p.id),
    inspirations: db.prepare(`SELECT i.*, u.name author FROM inspirations i LEFT JOIN users u ON u.id = i.created_by WHERE i.product_id = ? ORDER BY i.id DESC`).all(p.id),
    // Full videos being auto-split (and the ones that failed). Finished ones are kept 1 hour to show "done".
    raws: db.prepare(`SELECT id, original_name, status, error, parts FROM raws WHERE product_id = ? AND (status <> 'done' OR created_at > datetime('now', '-1 hour')) ORDER BY id`).all(p.id),
    author: db.prepare(`SELECT name FROM users WHERE id = ?`).get(p.created_by)?.name || '',
  });
});

app.patch('/api/products/:id', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, 200) : p.name;
  if (!name) throw new HttpError(400, 'Product name is required');
  const keep = (k, fn) => (b[k] !== undefined ? fn(b[k]) : p[k]);
  const status = keep('status', v => { if (!STATUSES_P.includes(v)) throw new HttpError(400, 'Unknown status'); return v; });
  const markets = b.markets !== undefined ? JSON.stringify((Array.isArray(b.markets) ? b.markets : [])
    .filter(m => MARKETS[m?.code]).map(m => ({ code: m.code, price: str(m.price, 20) }))
    .filter((m, i, all) => all.findIndex(x => x.code === m.code) === i)) : p.markets;
  db.prepare(`UPDATE products SET name = ?, notes = ?, banner = ?, status = ?, markets = ?, link_product = ?, link_alibaba = ?, link_amazon = ? WHERE id = ?`)
    .run(name, keep('notes', v => str(v, 4000)), keep('banner', v => str(v, 60)), status, markets,
      keep('link_product', cleanUrl), keep('link_alibaba', cleanUrl), keep('link_amazon', cleanUrl), p.id);
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const clips = db.prepare(`SELECT id, file FROM clips WHERE product_id = ?`).all(p.id);
  const creatives = db.prepare(`SELECT id, file FROM creatives WHERE product_id = ?`).all(p.id);
  const raws = db.prepare(`SELECT file FROM raws WHERE product_id = ? AND status <> 'splitting'`).all(p.id);
  const insp = db.prepare(`SELECT id, file FROM inspirations WHERE product_id = ?`).all(p.id);
  db.prepare(`DELETE FROM products WHERE id = ?`).run(p.id);
  for (const c of clips) { removeFile(CLIPS_DIR, c.file); rmSync(thumbOf('clip', c.id), { force: true }); }
  for (const c of creatives) { removeFile(RENDERS_DIR, c.file); rmSync(thumbOf('creative', c.id), { force: true }); }
  for (const r of raws) removeFile(RAW_DIR, r.file);
  for (const i of insp) { removeFile(FILES_DIR, i.file); rmSync(thumbOf('insp', i.id), { force: true }); }
  if (p.image) removeFile(FILES_DIR, p.image);
  res.json({ ok: true });
});

// ---------- Product picture and inspiration files ----------
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const mediaUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 300 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, [...IMAGE_EXT, ...VIDEO_EXT].includes(extname(file.originalname).toLowerCase())),
});

app.post('/api/products/:id/image', mediaUpload.single('file'), (req, res) => {
  const f = req.file;
  try {
    const p = productOr404(idParam(req.params.id));
    if (!f || !IMAGE_EXT.includes(extname(f.originalname).toLowerCase())) throw new HttpError(400, `Send a picture (${IMAGE_EXT.join(' ')})`);
    const name = `product-${p.id}-${randomBytes(6).toString('hex')}${extname(f.originalname).toLowerCase()}`;
    renameSync(f.path, join(FILES_DIR, name));
    db.prepare(`UPDATE products SET image = ? WHERE id = ?`).run(name, p.id);
    if (p.image) removeFile(FILES_DIR, p.image);
    res.json({ ok: true });
  } finally { if (f) rmSync(f.path, { force: true }); }
});

app.post('/api/products/:id/inspiration', mediaUpload.array('files'), async (req, res) => {
  const files = req.files || [];
  try {
    const p = productOr404(idParam(req.params.id));
    if (!files.length) throw new HttpError(400, 'Send videos or pictures');
    const added = [];
    for (const f of files) {
      const ext = extname(f.originalname).toLowerCase();
      const kind = IMAGE_EXT.includes(ext) ? 'image' : 'video';
      const info = kind === 'video' ? await probe(f.path) : null;
      if (kind === 'video' && !info.hasVideo) continue;
      const name = `insp-${p.id}-${randomBytes(6).toString('hex')}${ext}`;
      renameSync(f.path, join(FILES_DIR, name));
      const id = db.prepare(`INSERT INTO inspirations (product_id, file, kind, name, duration, created_by) VALUES (?,?,?,?,?,?)`)
        .run(p.id, name, kind, f.originalname.replace(/\.[^.]+$/, '').slice(0, 120), info?.duration || 0, req.user.id).lastInsertRowid;
      if (kind === 'video') await thumbnail(join(FILES_DIR, name), thumbOf('insp', id));
      added.push(id);
    }
    res.status(201).json({ added: added.length });
  } finally { files.forEach(f => rmSync(f.path, { force: true })); }
});

const inspOr404 = id => {
  const i = db.prepare(`SELECT * FROM inspirations WHERE id = ?`).get(id);
  if (!i) throw new HttpError(404, 'Inspiration not found');
  return i;
};
app.patch('/api/inspirations/:id', (req, res) => {
  const i = inspOr404(idParam(req.params.id));
  db.prepare(`UPDATE inspirations SET name = ?, note = ? WHERE id = ?`)
    .run(req.body?.name !== undefined ? str(req.body.name, 120) : i.name, req.body?.note !== undefined ? str(req.body.note, 2000) : i.note, i.id);
  res.json({ ok: true });
});
app.delete('/api/inspirations/:id', (req, res) => {
  const i = inspOr404(idParam(req.params.id));
  db.prepare(`DELETE FROM inspirations WHERE id = ?`).run(i.id);
  removeFile(FILES_DIR, i.file);
  rmSync(thumbOf('insp', i.id), { force: true });
  res.json({ ok: true });
});
app.get('/media/product/:id/image', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  if (!p.image) throw new HttpError(404, 'No picture');
  res.sendFile(join(FILES_DIR, p.image), { headers: { 'Cache-Control': 'private, max-age=3600' } });
});
app.get('/media/inspiration/:id', (req, res) => res.sendFile(join(FILES_DIR, inspOr404(idParam(req.params.id)).file)));

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
const insertScript = (pid, uid, lang, s, style = 'classic') => db.prepare(`
  INSERT INTO scripts (product_id, language, angle, hook, body, cta, primary_text, headline, created_by, style) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  .run(pid, lang, str(s.angle, 80), str(s.hook), str(s.body, 4000), str(s.cta), str(s.primary_text, 4000), str(s.headline, 200), uid, style).lastInsertRowid;

app.post('/api/products/:id/scripts/generate', h(async (req, res) => {
  const p = productOr404(idParam(req.params.id));
  if (!aiReady()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  const { language = 'en', count = 3, extra = '' } = req.body || {};
  const style = req.body?.style === 'bss' ? 'bss' : 'classic';
  const scripts = await writeScripts({ product: p.name, notes: p.notes, language, count, extra: str(extra, 1000), style });
  const ids = tx(() => scripts.map(s => insertScript(p.id, req.user.id, language, s, style)));
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
  // Scripts: each chosen script is read over every clip combination (none = clips only).
  const rawScripts = Array.isArray(req.body?.script_ids) ? req.body.script_ids : req.body?.script_id ? [req.body.script_id] : [];
  const scriptIds = [...new Set(rawScripts.map(Number).filter(Boolean))];
  for (const sid of scriptIds) if (!db.prepare(`SELECT 1 FROM scripts WHERE id = ? AND product_id = ?`).get(sid, p.id)) throw new HttpError(400, 'Unknown script');
  const voiceId = str(req.body?.voice_id, 100), voiceName = str(req.body?.voice_name, 100);
  if (voiceId && !scriptIds.length) throw new HttpError(400, 'Choose a script for the voice to read');
  if (voiceId && !ttsReady()) throw new HttpError(503, 'Voice-over is not set up: add ELEVENLABS_API_KEY to the server settings.');
  const captions = req.body?.captions && scriptIds.length ? 1 : 0;
  // Music: 'none', 'product' (a different AI track made for this product per video), 'video' (the sound of the
  // TikTok the body/hook clip came from), 'random' (a different library track per video) or one track id.
  const tracks = db.prepare(`SELECT id FROM music`).all().map(m => m.id);
  const productTracks = db.prepare(`SELECT id FROM music WHERE product_id = ?`).all(p.id).map(m => m.id);
  const musicChoice = String(req.body?.music ?? 'none');
  if (!['none', 'random', 'video', 'product'].includes(musicChoice) && !tracks.includes(Number(musicChoice))) throw new HttpError(400, 'Unknown music track');
  if (musicChoice === 'random' && !tracks.length) throw new HttpError(400, 'The music library is empty: add tracks in Music first');
  if (musicChoice === 'product' && !productTracks.length) throw new HttpError(400, 'No AI music for this product yet: click "✨ Make music" first');
  // A TikTok's sound has its creator speaking in it: never under our own voice-over.
  if (musicChoice === 'video' && voiceId) throw new HttpError(400, 'The TikTok sound has the creator\'s voice in it: with a voice-over choose AI music, a library track or no music');
  const clipMusic = id => (id ? db.prepare(`SELECT music_id FROM clips WHERE id = ?`).get(id)?.music_id : null) || null;
  const bags = {};
  const pickFrom = (key, list) => {
    if (!bags[key]?.length) bags[key] = [...list].sort(() => Math.random() - 0.5);
    return bags[key].pop();
  };
  const musicFor = (hk, b, c) => {
    if (musicChoice === 'none') return null;
    if (musicChoice === 'video') return clipMusic(b) || clipMusic(hk) || clipMusic(c);
    if (musicChoice === 'product') return pickFrom('product', productTracks);
    if (musicChoice === 'random') return pickFrom('all', tracks);
    return Number(musicChoice);
  };
  // Style: 'classic' = every hook × body × CTA; 'bss' = every hook × CTA, the body is a montage of all ticked bodies.
  const style = req.body?.style === 'bss' ? 'bss' : 'classic';
  const format = ['4x5', '9x16'].includes(req.body?.format) ? req.body.format : style === 'bss' ? '4x5' : '9x16';
  if (style === 'bss' && (!scriptIds.length || !voiceId)) throw new HttpError(400, 'The BSS style needs a script and a voice');
  const bodyPool = style === 'bss' ? JSON.stringify(bodies.filter(Boolean)) : '';
  const combos = [];
  for (const hk of hooks) for (const b of style === 'bss' ? [null] : bodies) for (const c of ctas)
    if (hk || b || c || (style === 'bss' && bodyPool !== '[]'))
      for (const sid of scriptIds.length ? scriptIds : [null]) combos.push([hk, b, c, sid]);
  if (!combos.length) throw new HttpError(400, 'Pick at least one clip');
  if (combos.length > MAX_COMBOS) throw new HttpError(400, `${combos.length} videos is too many at once (max ${MAX_COMBOS})`);
  const ids = tx(() => combos.map(([hk, b, c, sid]) => {
    const name = [style === 'bss' && 'BSS', hk && `H${hk}`, b && `B${b}`, c && `C${c}`, sid && `S${sid}`].filter(Boolean).join(' + ');
    const music = musicFor(hk, b ?? bodies.find(Boolean) ?? null, c);
    const clipSound = 0; // clips' own sound never goes under a voice-over (it often has someone speaking)
    return db.prepare(`INSERT INTO creatives (product_id, hook_clip, body_clip, cta_clip, script_id, name, created_by, voice_id, voice_name, music_id,
      captions, clip_sound, style, format, body_pool) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, hk, b, c, sid, name, req.user.id, sid ? voiceId : '', sid ? voiceName : '', music,
        style === 'bss' ? 1 : captions, clipSound, style, format, bodyPool).lastInsertRowid;
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

// ---------- Music library (shared by all products) ----------
// Music files, or videos (their sound is taken as the track: e.g. the TikTok whose music you want).
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac'];
const audioUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 300 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => cb(null, [...AUDIO_EXT, ...VIDEO_EXT].includes(extname(file.originalname).toLowerCase())),
});

app.get('/api/music', (req, res) => {
  res.json(db.prepare(`SELECT m.*, u.name uploader, (SELECT COUNT(*) FROM creatives WHERE music_id = m.id) used FROM music m LEFT JOIN users u ON u.id = m.uploaded_by ORDER BY m.id DESC`).all());
});

app.post('/api/music', audioUpload.array('files'), async (req, res) => {
  const files = req.files || [];
  try {
    if (!files.length) throw new HttpError(400, `No music received (accepted: ${[...AUDIO_EXT, ...VIDEO_EXT].join(' ')})`);
    const added = [], skipped = [];
    for (const f of files) {
      const info = await probe(f.path);
      if (!info.hasAudio || info.duration <= 0) { skipped.push(f.originalname); continue; }
      const base = f.originalname.replace(/\.[^.]+$/, '').slice(0, 100);
      let name;
      if (info.hasVideo) { // a video: keep only its sound
        name = `music-${randomBytes(8).toString('hex')}.m4a`;
        await extractAudio(f.path, join(MUSIC_DIR, name));
      } else {
        name = `music-${randomBytes(8).toString('hex')}${extname(f.originalname).toLowerCase()}`;
        renameSync(f.path, join(MUSIC_DIR, name));
      }
      db.prepare(`INSERT INTO music (name, file, duration, uploaded_by, from_video) VALUES (?,?,?,?,?)`)
        .run(info.hasVideo ? `🎬 ${base}` : base, name, info.duration, req.user.id, info.hasVideo ? f.originalname.slice(0, 200) : '');
      added.push(name);
    }
    res.status(201).json({ added: added.length, skipped });
  } finally { files.forEach(f => rmSync(f.path, { force: true })); }
});

// AI music (ElevenLabs): 1-3 instrumental tracks from a description, optionally made for one product.
app.post('/api/music/generate', async (req, res) => {
  const prompt = str(req.body?.prompt, 400);
  if (prompt.length < 3) throw new HttpError(400, 'Describe the music (e.g. "elegant luxury pop, soft piano, confident")');
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 3);
  const seconds = Math.min(Math.max(Number(req.body?.seconds) || 30, 10), 120);
  const pid = req.body?.product_id ? Number(req.body.product_id) : null;
  if (pid) productOr404(pid);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const audio = await composeMusic(prompt, seconds);
    const name = `music-${randomBytes(8).toString('hex')}.mp3`;
    writeFileSync(join(MUSIC_DIR, name), audio);
    const info = await probe(join(MUSIC_DIR, name));
    ids.push(db.prepare(`INSERT INTO music (name, file, duration, uploaded_by, product_id, prompt) VALUES (?,?,?,?,?,?)`)
      .run(`✨ ${prompt.slice(0, 60)}${count > 1 ? ` #${i + 1}` : ''}`, name, info.duration || seconds, req.user.id, pid, prompt).lastInsertRowid);
  }
  if (pid) db.prepare(`UPDATE products SET music_style = ? WHERE id = ?`).run(prompt, pid);
  res.status(201).json({ ids });
});

app.patch('/api/music/:id', (req, res) => {
  const name = str(req.body?.name, 100);
  if (!name) throw new HttpError(400, 'Name is required');
  const r = db.prepare(`UPDATE music SET name = ? WHERE id = ?`).run(name, idParam(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Track not found');
  res.json({ ok: true });
});

app.delete('/api/music/:id', (req, res) => {
  const m = db.prepare(`SELECT * FROM music WHERE id = ?`).get(idParam(req.params.id));
  if (!m) throw new HttpError(404, 'Track not found');
  if (db.prepare(`SELECT 1 FROM creatives WHERE music_id = ? AND render IN ('queued','rendering')`).get(m.id))
    throw new HttpError(409, 'Videos waiting to be made use this track. Try again when they are done.');
  db.prepare(`DELETE FROM music WHERE id = ?`).run(m.id);
  removeFile(MUSIC_DIR, m.file);
  res.json({ ok: true });
});

// ---------- Media (signed-in users only) ----------
app.get('/media/music/:id', (req, res) => {
  const m = db.prepare(`SELECT file FROM music WHERE id = ?`).get(idParam(req.params.id));
  if (!m) throw new HttpError(404, 'Track not found');
  res.sendFile(join(MUSIC_DIR, m.file));
});
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
  if (!['clip', 'creative', 'insp'].includes(req.params.type)) throw new HttpError(404, 'Not found');
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
