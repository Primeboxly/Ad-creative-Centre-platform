import express from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { db, tx } from './db.js';
import { ROOT, TMP_DIR, FILES_DIR } from './paths.js';
import { HttpError } from './errors.js';
import { checkPassword, hashPassword, createSession, cookieOpts, requireAuth, requireAdmin } from './auth.js';
import { LANGUAGES, aiReady, aiMock } from './ai.js';
import { safeGet, extractProduct } from './fetchpage.js';
import { setMarkets, strategyState, startAnalysis, startAngles, startOneAngle, addCustomAngle, updateAngle, saveSelection, aiReadPage } from './strategy.js';
import { mountFootage } from './footage-routes.js';
import { startFootageWorker, deleteProductFootage } from './footage.js';
import { resetFromEnv } from './maintenance/reset-data.js';

const app = express();
const PORT = Number(process.env.PORT) || 3100;
const PROD = process.env.NODE_ENV === 'production';
const removeFile = (dir, name) => { if (name) rmSync(join(dir, name), { force: true }); };

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

app.get('/api/me', (req, res) => res.json({ user: req.user, languages: LANGUAGES, ai: aiReady() || aiMock() }));

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

// Last change on a product: created, footage uploaded, or marketing angles written.
const LAST_ACTIVITY = `MAX(products.created_at, IFNULL((SELECT MAX(created_at) FROM footage_assets WHERE product_id = products.id), ''),
  IFNULL((SELECT MAX(created_at) FROM angles WHERE product_id = products.id), ''))`;

// Sidebar: counts and the 6 most recently active products.
app.get('/api/sidebar', (req, res) => {
  const one = sql => db.prepare(sql).get().n;
  res.json({
    products: one(`SELECT COUNT(*) n FROM products`),
    team: one(`SELECT COUNT(*) n FROM users WHERE active = 1`),
    processing: one(`SELECT COUNT(*) n FROM footage_assets WHERE status IN ('uploaded','queued','storing','metadata','scenes','analyzing','matching')`),
    recent: db.prepare(`SELECT id, name, image FROM products ORDER BY ${LAST_ACTIVITY} DESC LIMIT 6`).all(),
  });
});

// Dashboard: real totals across all products (no sample data).
app.get('/api/dashboard', (req, res) => {
  const one = sql => db.prepare(sql).get().n;
  res.json({
    products: one(`SELECT COUNT(*) n FROM products`),
    analysed: one(`SELECT COUNT(DISTINCT product_id) n FROM analyses WHERE status = 'done'`),
    angles: one(`SELECT COUNT(*) n FROM angles`),
    selected: one(`SELECT COUNT(*) n FROM angles WHERE selected = 1`),
    videos: one(`SELECT COUNT(*) n FROM footage_assets`),
    processing: one(`SELECT COUNT(*) n FROM footage_assets WHERE status IN ('uploaded','queued','storing','metadata','scenes','analyzing','matching')`),
    scenes: one(`SELECT COUNT(*) n FROM footage_scenes`),
    analysed_scenes: one(`SELECT COUNT(*) n FROM footage_scenes WHERE status = 'analyzed'`),
    favorites: one(`SELECT COUNT(*) n FROM footage_scenes WHERE favorite = 1`),
  });
});

app.get('/api/products', (req, res) => {
  res.json(db.prepare(`
    SELECT products.*,
      (SELECT COUNT(*) FROM footage_assets WHERE product_id = products.id) videos,
      (SELECT COUNT(*) FROM footage_scenes WHERE product_id = products.id) scenes,
      (SELECT COUNT(*) FROM angles WHERE product_id = products.id) angles,
      (SELECT COUNT(*) FROM angles WHERE product_id = products.id AND selected = 1) selected_angles,
      (SELECT status FROM analyses WHERE product_id = products.id ORDER BY id DESC LIMIT 1) analysis_status,
      ${LAST_ACTIVITY} last_activity
    FROM products ORDER BY last_activity DESC`).all().map(withMarkets));
});

app.post('/api/products', (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) throw new HttpError(400, 'Product name is required');
  const id = db.prepare(`INSERT INTO products (name, notes, created_by) VALUES (?,?,?)`).run(name, str(req.body?.notes, 4000), req.user.id).lastInsertRowid;
  res.status(201).json({ id });
});

app.get('/api/products/:id', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const one = sql => db.prepare(sql).get(p.id).n;
  res.json({
    product: withMarkets(p),
    counts: {
      videos: one(`SELECT COUNT(*) n FROM footage_assets WHERE product_id = ?`),
      scenes: one(`SELECT COUNT(*) n FROM footage_scenes WHERE product_id = ?`),
      analysed_scenes: one(`SELECT COUNT(*) n FROM footage_scenes WHERE product_id = ? AND status = 'analyzed'`),
      favorites: one(`SELECT COUNT(*) n FROM footage_scenes WHERE product_id = ? AND favorite = 1`),
      angles: one(`SELECT COUNT(*) n FROM angles WHERE product_id = ?`),
      selected_angles: one(`SELECT COUNT(*) n FROM angles WHERE product_id = ? AND selected = 1`),
      analysed: one(`SELECT COUNT(*) n FROM analyses WHERE product_id = ? AND status = 'done'`),
    },
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
  const country = keep('country', v => { const c = str(v, 2).toUpperCase(); if (c && !MARKETS[c]) throw new HttpError(400, 'Unknown country'); return c; });
  const language = keep('language', v => { if (!LANGUAGES[v]) throw new HttpError(400, 'Unknown language'); return v; });
  db.prepare(`UPDATE products SET name = ?, notes = ?, status = ?, markets = ?, link_product = ?, link_alibaba = ?,
      description = ?, price = ?, offer = ?, country = ?, language = ? WHERE id = ?`)
    .run(name, keep('notes', v => str(v, 4000)), status, markets,
      keep('link_product', cleanUrl), keep('link_alibaba', cleanUrl),
      keep('description', v => str(v, 8000)), keep('price', v => str(v, 40)), keep('offer', v => str(v, 200)), country, language, p.id);
  res.json({ ok: true });
});

// ---------- Module 1: product import, pictures, analysis and marketing angles ----------
setMarkets(MARKETS);

// Read a product page: name, description, price, pictures (the team checks and corrects before saving).
const importing = new Set(); // one import at a time per user
app.post('/api/import-url', async (req, res) => {
  const url = str(req.body?.url, 1000);
  if (!url) throw new HttpError(400, 'Paste the product page link');
  if (importing.has(req.user.id)) throw new HttpError(409, 'An import is already running');
  importing.add(req.user.id);
  try {
    const page = await safeGet(url);
    if (!/html|xml|text/i.test(page.type)) throw new HttpError(400, 'This link is not a web page');
    const found = extractProduct(page.body.toString('utf8'), page.url);
    let ai = null, warning = '';
    if (aiReady() || aiMock()) {
      try { ai = await aiReadPage(found, req.user.id); } catch (e) { warning = `The AI could not read the page (${e.message}); basic information only.`; }
    }
    const pick = (a, b) => (a && String(a).trim()) || b || '';
    res.json({
      url: page.url,
      name: pick(ai?.name, found.name).slice(0, 200),
      description: pick(ai?.description, found.description).slice(0, 8000),
      price: [pick(ai?.price, found.price), pick(ai?.currency, found.currency)].filter(Boolean).join(' '),
      offer: ai?.offer || '',
      images: found.images,
      warning: warning || (!found.name && !found.description ? 'Little product information was found on this page: complete it by hand.' : ''),
    });
  } finally { importing.delete(req.user.id); }
});

// Pictures: upload, or download from links (e.g. the ones found by the import).
const savePicture = (pid, file, sourceUrl = '') => {
  const id = db.prepare(`INSERT INTO product_images (product_id, file, source_url) VALUES (?,?,?)`).run(pid, file, sourceUrl).lastInsertRowid;
  const p = db.prepare(`SELECT image FROM products WHERE id = ?`).get(pid);
  if (!p.image) db.prepare(`UPDATE products SET image = ? WHERE id = ?`).run(file, pid); // the first picture becomes the main one
  return id;
};
app.post('/api/products/:id/images', (req, res, next) => mediaUpload.array('files')(req, res, next), (req, res) => {
  const files = req.files || [];
  try {
    const p = productOr404(idParam(req.params.id));
    const ok = files.filter(f => IMAGE_EXT.includes(extname(f.originalname).toLowerCase()));
    if (!ok.length) throw new HttpError(400, `Send pictures (${IMAGE_EXT.join(' ')})`);
    for (const f of ok) {
      const name = `product-${p.id}-${randomBytes(6).toString('hex')}${extname(f.originalname).toLowerCase()}`;
      renameSync(f.path, join(FILES_DIR, name));
      savePicture(p.id, name);
    }
    res.status(201).json({ added: ok.length });
  } finally { files.forEach(f => rmSync(f.path, { force: true })); }
});
app.post('/api/products/:id/images/from-urls', async (req, res) => {
  const p = productOr404(idParam(req.params.id));
  const urls = (Array.isArray(req.body?.urls) ? req.body.urls : []).map(u => str(u, 1000)).filter(Boolean).slice(0, 12);
  if (!urls.length) throw new HttpError(400, 'No picture chosen');
  const added = [], failed = [];
  for (const u of urls) {
    try {
      const r = await safeGet(u, { accept: 'image/*', maxBytes: 8 * 1024 * 1024 });
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[r.type.split(';')[0].trim().toLowerCase()];
      if (!ext) throw new Error('not a picture');
      const name = `product-${p.id}-${randomBytes(6).toString('hex')}${ext}`;
      writeFileSync(join(FILES_DIR, name), r.body);
      added.push(savePicture(p.id, name, u));
    } catch (e) { failed.push(u); }
  }
  res.status(201).json({ added: added.length, failed });
});
app.post('/api/product-images/:id/main', (req, res) => {
  const im = db.prepare(`SELECT * FROM product_images WHERE id = ?`).get(idParam(req.params.id));
  if (!im) throw new HttpError(404, 'Picture not found');
  db.prepare(`UPDATE products SET image = ? WHERE id = ?`).run(im.file, im.product_id);
  res.json({ ok: true });
});
app.delete('/api/product-images/:id', (req, res) => {
  const im = db.prepare(`SELECT * FROM product_images WHERE id = ?`).get(idParam(req.params.id));
  if (!im) throw new HttpError(404, 'Picture not found');
  db.prepare(`DELETE FROM product_images WHERE id = ?`).run(im.id);
  const p = db.prepare(`SELECT image FROM products WHERE id = ?`).get(im.product_id);
  if (p?.image === im.file) {
    const next = db.prepare(`SELECT file FROM product_images WHERE product_id = ? ORDER BY id LIMIT 1`).get(im.product_id);
    db.prepare(`UPDATE products SET image = ? WHERE id = ?`).run(next?.file || '', im.product_id);
  }
  removeFile(FILES_DIR, im.file);
  res.json({ ok: true });
});
app.get('/media/product-image/:id', (req, res) => {
  const im = db.prepare(`SELECT file FROM product_images WHERE id = ?`).get(idParam(req.params.id));
  if (!im) throw new HttpError(404, 'Picture not found');
  res.sendFile(join(FILES_DIR, im.file), { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

// Strategy: analysis, angles and running AI work of a product.
app.get('/api/products/:id/strategy', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  res.json({ ...strategyState(p.id), ai: aiReady() || aiMock(), mock: aiMock() });
});
app.post('/api/products/:id/analyze', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  if (!aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  res.status(202).json({ job: startAnalysis(p.id, req.user.id, { thenAngles: req.body?.then_angles !== false }) });
});
app.post('/api/products/:id/angles/generate', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  if (!aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  res.status(202).json({ job: startAngles(p.id, req.user.id) });
});
app.post('/api/angles/:id/regenerate', (req, res) => {
  if (!aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  res.status(202).json({ job: startOneAngle(idParam(req.params.id), req.user.id) });
});
app.post('/api/products/:id/angles', (req, res) => {
  res.status(201).json({ id: addCustomAngle(idParam(req.params.id), req.body || {}, req.user.id) });
});
app.patch('/api/angles/:id', (req, res) => { updateAngle(idParam(req.params.id), req.body || {}); res.json({ ok: true }); });
app.delete('/api/angles/:id', (req, res) => {
  const r = db.prepare(`DELETE FROM angles WHERE id = ?`).run(idParam(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Angle not found');
  res.json({ ok: true });
});
app.post('/api/products/:id/angles/selection', (req, res) => {
  res.json({ selected: saveSelection(idParam(req.params.id), req.body?.ids) });
});

// AI usage (admin): calls, tokens, errors over the last 30 days.
app.get('/api/ai-usage', requireAdmin, (req, res) => {
  res.json({
    byKind: db.prepare(`SELECT kind, COUNT(*) calls, SUM(ok) ok, SUM(1 - ok) failed, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, ROUND(AVG(ms)) avg_ms
      FROM ai_usage WHERE created_at > datetime('now', '-30 days') GROUP BY kind ORDER BY calls DESC`).all(),
    lastErrors: db.prepare(`SELECT kind, product_id, error, created_at FROM ai_usage WHERE ok = 0 ORDER BY id DESC LIMIT 20`).all(),
  });
});

app.delete('/api/products/:id', requireAdmin, h(async (req, res) => {
  const p = productOr404(idParam(req.params.id));
  await deleteProductFootage(p.id); // footage library: stored videos, previews and pictures
  const pimgs = db.prepare(`SELECT file FROM product_images WHERE product_id = ?`).all(p.id);
  db.prepare(`DELETE FROM products WHERE id = ?`).run(p.id); // analyses, angles, AI jobs and pictures go with it
  for (const f of new Set([p.image, ...pimgs.map(x => x.file)].filter(Boolean))) removeFile(FILES_DIR, f);
  res.json({ ok: true });
}));

// ---------- Product pictures ----------
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const mediaUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, IMAGE_EXT.includes(extname(file.originalname).toLowerCase())),
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
app.get('/media/product/:id/image', (req, res) => {
  const p = productOr404(idParam(req.params.id));
  if (!p.image) throw new HttpError(404, 'No picture');
  res.sendFile(join(FILES_DIR, p.image), { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

// ---------- Footage library & AI scene analysis (Module 2) ----------
mountFootage(app, { h, idParam, str, productOr404 });

// ---------- Errors ----------
app.use((err, req, res, next) => {
  res.set('Cache-Control', 'no-store'); // never let a browser keep an error
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A file is too big' : err.message });
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

// One-time data reset when the ACC_RESET_DATA variable asks for it (see server/maintenance/reset-data.js).
await resetFromEnv().catch(e => console.error('[reset] FAILED, nothing more was changed after the error:', e));
startFootageWorker();
app.listen(PORT, () => console.log(`Ad creative Centre on http://localhost:${PORT}`));
