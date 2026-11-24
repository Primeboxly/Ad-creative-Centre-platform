// Module 1: product analysis and marketing angles.
// Work runs in the background as ai_jobs (one at a time per product and kind), so the page can show progress
// and the same work is never started twice.
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { db, tx } from './db.js';
import { FILES_DIR } from './paths.js';
import { HttpError } from './errors.js';
import { callJson, LANGUAGES } from './ai.js';

// ---------- Schemas (checked on every answer) ----------
const str = { type: 'string' };
const strList = (min = 1, max = 12) => ({ type: 'array', items: str, minItems: min, maxItems: max });

export const ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['category', 'summary', 'features', 'benefits', 'problems_solved', 'audiences', 'pain_points', 'motivations', 'objections', 'usps', 'emotional_triggers', 'market_notes', 'missing_info'],
  properties: {
    category: str,
    summary: { type: 'string', minLength: 10 },
    features: strList(1, 15),
    benefits: strList(1, 12),
    problems_solved: strList(1, 10),
    audiences: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: str, description: str } } },
    pain_points: strList(1, 12),
    motivations: strList(1, 10),
    objections: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['objection', 'answer'], properties: { objection: str, answer: str } } },
    usps: strList(1, 10),
    emotional_triggers: strList(1, 10),
    market_notes: str,
    missing_info: { type: 'array', items: str, maxItems: 10 },
  },
};

const ANGLE = {
  type: 'object', additionalProperties: false,
  required: ['name', 'description', 'audience', 'pain_point', 'message', 'emotion', 'hooks', 'creative_types', 'why'],
  properties: {
    name: { type: 'string', minLength: 2 }, description: str, audience: str, pain_point: str, message: str, emotion: str,
    hooks: { type: 'array', items: str, minItems: 3, maxItems: 3 },
    creative_types: strList(1, 5),
    why: str,
  },
};
export const ANGLES_SCHEMA = { type: 'object', additionalProperties: false, required: ['angles'], properties: { angles: { type: 'array', items: ANGLE, minItems: 8, maxItems: 12 } } };
export const ONE_ANGLE_SCHEMA = { type: 'object', additionalProperties: false, required: ['angle'], properties: { angle: ANGLE } };
export const IMPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'description', 'price', 'currency', 'offer'],
  properties: { name: str, description: str, price: str, currency: str, offer: str },
};

const CREATIVE_TYPES = 'UGC testimonial, problem/solution demo, unboxing, before/after, comparison with the usual way, gift/occasion story, close-up product showcase, street interview, lifestyle montage, expert/explainer';

// ---------- Rules shared by every prompt ----------
const RULES = `You are a senior performance-marketing strategist for cash-on-delivery (COD) e-commerce in Africa (social ads on Facebook, Instagram and TikTok).
Hard rules:
- Use ONLY what the product information and pictures show. Never invent specifications, materials, sizes, certifications, numbers, ratings, customer reviews or testimonials.
- If something is not given, do not assume it: list it under missing_info (analysis) or keep the wording general.
- No medical, health or income claims the product cannot prove; no "do you have <condition>?" wording (ad platform rules).
- Adapt to the target country and market: how people there shop (COD, trust in delivery, price sensitivity), everyday situations, occasions and culture. Do not stereotype.
- Write in clear, simple English for the team, except where a field asks for the target language.`;

// ---------- Product context sent to the AI ----------
export function productContext(p) {
  const { MARKETS } = productContext;
  const country = MARKETS?.[p.country]?.name || p.country || 'not set';
  let markets = [];
  try { markets = JSON.parse(p.markets || '[]'); } catch {}
  const lines = [
    `Product name: ${p.name}`,
    `Target country: ${country}`,
    `Target language: ${LANGUAGES[p.language] || p.language || 'English'}`,
    p.price ? `Selling price: ${p.price}` : 'Selling price: not given',
    p.offer ? `Promotional offer: ${p.offer}` : 'Promotional offer: none given',
    markets.length ? `Markets and prices: ${markets.map(m => `${m.code}${m.price ? ' ' + m.price : ''}`).join(', ')}` : '',
    'Payment: cash on delivery.',
    p.link_product ? `Product page: ${p.link_product}` : '',
    '',
    'Product description:',
    p.description || '(none)',
    p.notes ? `\nTeam notes:\n${p.notes}` : '',
  ];
  return lines.filter(l => l !== '').join('\n');
}
export const setMarkets = m => { productContext.MARKETS = m; };

// Up to 4 product pictures, as image blocks (main picture first).
const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function pictureBlocks(p) {
  const files = [p.image, ...db.prepare(`SELECT file FROM product_images WHERE product_id = ? ORDER BY id`).all(p.id).map(r => r.file)]
    .filter((f, i, all) => f && all.indexOf(f) === i).slice(0, 4);
  const blocks = [];
  for (const f of files) {
    const path = join(FILES_DIR, f), type = MEDIA[extname(f).toLowerCase()];
    if (!type || !existsSync(path)) continue;
    const buf = readFileSync(path);
    if (buf.length > 4.5 * 1024 * 1024) continue; // the API limit is 5 MB per picture
    blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } });
  }
  return blocks;
}

const productOr404 = id => {
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  if (!p) throw new HttpError(404, 'Product not found');
  return p;
};

// ---------- Jobs ----------
const running = (pid, kinds) => db.prepare(`SELECT * FROM ai_jobs WHERE product_id = ? AND status = 'running' AND kind IN (${kinds.map(() => '?').join(',')})`).get(pid, ...kinds);

// after(): runs right when the job is marked done, in the same moment (so a chained job never leaves a gap).
function startJob(pid, kind, userId, targetId, work, after) {
  // analysis and full angle runs exclude each other; single-angle rewrites only exclude the same angle and full runs.
  const blockers = kind === 'angle' ? ['analysis', 'angles'] : ['analysis', 'angles'];
  const busy = running(pid, blockers) || (kind === 'angle' && db.prepare(`SELECT 1 FROM ai_jobs WHERE kind = 'angle' AND target_id = ? AND status = 'running'`).get(targetId));
  if (busy) throw new HttpError(409, 'The AI is already working on this. Wait for it to finish.');
  const jobId = db.prepare(`INSERT INTO ai_jobs (product_id, kind, target_id, created_by) VALUES (?,?,?,?)`).run(pid, kind, targetId ?? null, userId).lastInsertRowid;
  Promise.resolve().then(work).then(
    () => {
      db.prepare(`UPDATE ai_jobs SET status = 'done', finished_at = datetime('now') WHERE id = ?`).run(jobId);
      try { after?.(); } catch (e) { console.error(`After job ${jobId}:`, e.message); }
    },
    e => {
      console.error(`AI job ${jobId} (${kind}):`, e.message);
      db.prepare(`UPDATE ai_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run(String(e.message).slice(0, 500), jobId);
    });
  return jobId;
}

// ---------- Analysis ----------
export function startAnalysis(pid, userId, { thenAngles = true } = {}) {
  const p = productOr404(pid);
  if (!p.description.trim() && !p.notes.trim() && !db.prepare(`SELECT 1 FROM product_images WHERE product_id = ?`).get(pid) && !p.image)
    throw new HttpError(400, 'Add a description or pictures first, so the AI has something to analyse');
  const analysisId = db.prepare(`INSERT INTO analyses (product_id, created_by) VALUES (?,?)`).run(pid, userId).lastInsertRowid;
  return startJob(pid, 'analysis', userId, null, async () => {
    try {
      const data = await callJson({
        kind: 'analysis', productId: pid, userId, schema: ANALYSIS_SCHEMA, effort: 'high',
        system: RULES,
        content: [...pictureBlocks(p), { type: 'text', text: `${productContext(p)}

Analyse this product for advertising in the target country. Fill every field of the schema:
category; summary (2-3 sentences); features (what it has, as shown or described); benefits (what the customer gets); problems_solved;
audiences (who buys it there and why); pain_points; motivations (why they would buy now); objections (with an honest answer each,
COD and delivery included where relevant); usps (what makes it different, only if supported); emotional_triggers;
market_notes (what matters for selling it in the target country: price perception, occasions, trust, wording);
missing_info (facts the team should check or add, e.g. size, battery life, warranty).` }],
        mock: () => mockAnalysis(p),
      });
      db.prepare(`UPDATE analyses SET status = 'done', data = ?, model = ?, finished_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(data), process.env.ACC_AI_MOCK === '1' ? 'mock' : (process.env.ACC_MODEL || 'claude-opus-5-5'), analysisId);
    } catch (e) {
      db.prepare(`UPDATE analyses SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run(String(e.message).slice(0, 500), analysisId);
      throw e;
    }
  // Chain: the angles start right after the analysis, as a job of their own (so they show their own progress).
  }, thenAngles ? () => startAngles(pid, userId) : undefined);
}

export const latestAnalysis = pid => {
  const a = db.prepare(`SELECT * FROM analyses WHERE product_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1`).get(pid);
  return a ? { ...a, data: JSON.parse(a.data) } : null;
};

// ---------- Angles ----------
const angleRow = a => ({ ...a, hooks: JSON.parse(a.hooks || '[]'), creative_types: JSON.parse(a.creative_types || '[]'), selected: !!a.selected, custom: !!a.custom });
export const listAngles = pid => db.prepare(`SELECT * FROM angles WHERE product_id = ? ORDER BY position, id`).all(pid).map(angleRow);

const angleSummary = a => `- ${a.name}: ${a.message || a.description}`;

// Regenerate all: the selected and the team's own angles stay; the other AI angles are replaced.
export function startAngles(pid, userId) {
  const p = productOr404(pid);
  const analysis = latestAnalysis(pid);
  if (!analysis) throw new HttpError(400, 'Analyse the product first');
  return startJob(pid, 'angles', userId, null, async () => {
    const keep = listAngles(pid).filter(a => a.selected || a.custom);
    const data = await callJson({
      kind: 'angles', productId: pid, userId, schema: ANGLES_SCHEMA, effort: 'high',
      system: RULES,
      content: `${productContext(p)}

Product analysis (JSON):
${JSON.stringify(analysis.data)}

${keep.length ? `The team already keeps these angles; do not repeat them:\n${keep.map(angleSummary).join('\n')}\n` : ''}
Write ${keep.length >= 4 ? '8' : '8 to 12'} DISTINCT marketing angles for COD video ads in the target country.
Distinct means a different selling message, not the same idea reworded (e.g. gift, problem/solution, price/value, status/pride, convenience, safety, comparison with the usual way, social proof without inventing reviews, urgency/occasion).
For each angle: name (2-5 words); description (1-2 sentences); audience; pain_point; message (the one main selling message);
emotion (the emotional trigger); hooks: exactly 3 scroll-stopping opening lines in ${LANGUAGES[p.language] || 'English'}, spoken style, under 15 words each;
creative_types: 1-3 from this list: ${CREATIVE_TYPES}; why: why this angle could work in this market.`,
      mock: () => mockAngles(p, 9),
    });
    tx(() => {
      db.prepare(`DELETE FROM angles WHERE product_id = ? AND selected = 0 AND custom = 0`).run(pid);
      let pos = keep.length;
      for (const a of data.angles) insertAngle(pid, analysis.id, a, userId, ++pos, 0);
    });
  });
}

function insertAngle(pid, analysisId, a, userId, position, custom) {
  return db.prepare(`INSERT INTO angles (product_id, analysis_id, name, description, audience, pain_point, message, emotion, hooks, creative_types, why, custom, position, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pid, analysisId, a.name, a.description || '', a.audience || '', a.pain_point || '', a.message || '', a.emotion || '',
    JSON.stringify((a.hooks || []).slice(0, 3)), JSON.stringify(a.creative_types || []), a.why || '', custom, position, userId).lastInsertRowid;
}

// One angle rewritten into a new, different one (its place and selection stay).
export function startOneAngle(angleId, userId) {
  const a = db.prepare(`SELECT * FROM angles WHERE id = ?`).get(angleId);
  if (!a) throw new HttpError(404, 'Angle not found');
  const p = productOr404(a.product_id);
  const analysis = latestAnalysis(p.id);
  if (!analysis) throw new HttpError(400, 'Analyse the product first');
  return startJob(p.id, 'angle', userId, angleId, async () => {
    const others = listAngles(p.id).filter(x => x.id !== angleId);
    const data = await callJson({
      kind: 'angle', productId: p.id, userId, schema: ONE_ANGLE_SCHEMA, effort: 'medium',
      system: RULES,
      content: `${productContext(p)}

Product analysis (JSON):
${JSON.stringify(analysis.data)}

Angles the team already has (yours must be clearly different from all of them):
${others.map(angleSummary).join('\n') || '(none)'}

The angle to replace was: ${a.name}: ${a.message}
Write ONE new marketing angle with a different selling message. hooks: exactly 3 opening lines in ${LANGUAGES[p.language] || 'English'};
creative_types: 1-3 from: ${CREATIVE_TYPES}.`,
      mock: () => ({ angle: mockAngles(p, 1, Date.now() % 97).angles[0] }),
    });
    const n = data.angle;
    db.prepare(`UPDATE angles SET name = ?, description = ?, audience = ?, pain_point = ?, message = ?, emotion = ?, hooks = ?, creative_types = ?, why = ?,
      custom = 0, analysis_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(n.name, n.description, n.audience, n.pain_point, n.message, n.emotion, JSON.stringify(n.hooks.slice(0, 3)), JSON.stringify(n.creative_types), n.why, analysis.id, angleId);
  });
}

export function addCustomAngle(pid, a, userId) {
  productOr404(pid);
  if (!String(a.name || '').trim()) throw new HttpError(400, 'Give the angle a name');
  const pos = (db.prepare(`SELECT MAX(position) m FROM angles WHERE product_id = ?`).get(pid).m || 0) + 1;
  return insertAngle(pid, latestAnalysis(pid)?.id ?? null, cleanAngle(a), userId, pos, 1);
}

export function cleanAngle(a) {
  const s = (v, n = 2000) => String(v ?? '').trim().slice(0, n);
  const list = (v, n) => (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => s(x, 300)).filter(Boolean).slice(0, n);
  return { name: s(a.name, 120), description: s(a.description), audience: s(a.audience, 500), pain_point: s(a.pain_point, 500), message: s(a.message, 500),
    emotion: s(a.emotion, 200), hooks: list(a.hooks, 3), creative_types: list(a.creative_types, 5), why: s(a.why) };
}

export function updateAngle(id, body) {
  const a = db.prepare(`SELECT * FROM angles WHERE id = ?`).get(id);
  if (!a) throw new HttpError(404, 'Angle not found');
  if (body.selected !== undefined && Object.keys(body).length === 1) {
    db.prepare(`UPDATE angles SET selected = ?, updated_at = datetime('now') WHERE id = ?`).run(body.selected ? 1 : 0, id);
    return;
  }
  const merged = cleanAngle({ ...angleRow(a), ...body });
  if (!merged.name) throw new HttpError(400, 'Give the angle a name');
  db.prepare(`UPDATE angles SET name = ?, description = ?, audience = ?, pain_point = ?, message = ?, emotion = ?, hooks = ?, creative_types = ?, why = ?,
    custom = 1, selected = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(merged.name, merged.description, merged.audience, merged.pain_point, merged.message, merged.emotion, JSON.stringify(merged.hooks),
      JSON.stringify(merged.creative_types), merged.why, body.selected !== undefined ? (body.selected ? 1 : 0) : a.selected, id);
}

// Save the selection: exactly these angles are selected for the product.
export function saveSelection(pid, ids) {
  productOr404(pid);
  const set = new Set((ids || []).map(Number));
  tx(() => {
    for (const a of db.prepare(`SELECT id FROM angles WHERE product_id = ?`).all(pid))
      db.prepare(`UPDATE angles SET selected = ? WHERE id = ?`).run(set.has(a.id) ? 1 : 0, a.id);
  });
  return set.size;
}

// Everything the Strategy tab needs, including running jobs for progress.
export function strategyState(pid) {
  const lastAnalysis = db.prepare(`SELECT id, status, error, created_at, finished_at FROM analyses WHERE product_id = ? ORDER BY id DESC LIMIT 1`).get(pid) || null;
  return {
    analysis: latestAnalysis(pid),
    lastAnalysis,
    angles: listAngles(pid),
    jobs: db.prepare(`SELECT id, kind, target_id, status, error, created_at, finished_at FROM ai_jobs WHERE product_id = ? AND (status = 'running' OR finished_at > datetime('now', '-10 minutes')) ORDER BY id DESC`).all(pid),
    images: db.prepare(`SELECT * FROM product_images WHERE product_id = ? ORDER BY id`).all(pid),
  };
}

// ---------- Import: let the AI read the page text (only what it says) ----------
export async function aiReadPage(page, userId) {
  return callJson({
    kind: 'import', userId, schema: IMPORT_SCHEMA, effort: 'low', maxTokens: 4000,
    system: 'You extract product information from a web page. Use only what the page says. Leave a field empty ("") when the page does not say it. Never invent.',
    content: `Page title/name: ${page.name}\nMeta description: ${page.description}\nPrice found: ${page.price} ${page.currency}\n\nVisible page text:\n${page.text}\n\n` +
      'Return: name (the product name, short and clean, without shop name or SEO words); description (a clean product description of 3-8 sentences from the page: what it is, features, specs, what is in the box); price (number only, as on the page); currency (ISO code if clear); offer (a promotion if the page shows one, e.g. "Buy 2 get 1 free").',
    mock: () => ({ name: page.name || 'Imported product', description: page.description || 'Description from the page.', price: page.price || '', currency: page.currency || '', offer: '' }),
  });
}

// ---------- Mock answers (ACC_AI_MOCK=1) ----------
function mockAnalysis(p) {
  return {
    category: 'Fashion accessories', summary: `${p.name} is analysed in test mode. These answers are examples, not real AI output.`,
    features: ['Feature from the description'], benefits: ['Looks elegant every day'], problems_solved: ['Hard to find a nice gift'],
    audiences: [{ name: 'Gift buyers', description: 'People looking for a present' }, { name: 'Style lovers', description: 'People who like elegant accessories' }],
    pain_points: ['Fear of buying something that looks cheap'], motivations: ['Upcoming birthdays and anniversaries'],
    objections: [{ objection: 'Will it look like the pictures?', answer: 'Pay only when you receive it and see it.' }],
    usps: ['Pay cash on delivery'], emotional_triggers: ['Pride', 'Love'], market_notes: 'COD builds trust; keep the price visible.', missing_info: ['Exact size'],
  };
}
function mockAngles(p, n, seed = 0) {
  const names = ['Perfect gift', 'Everyday elegance', 'Price of luxury, for less', 'Pay when you see it', 'Stand out at events', 'Treat yourself', 'Better than the usual', 'Matching sets', 'Last-minute present', 'Office confidence', 'Holiday season', 'Show your love'];
  return { angles: Array.from({ length: n }, (_, i) => {
    const name = names[(i + seed) % names.length];
    return { name, description: `Test angle about ${name.toLowerCase()}.`, audience: 'Women 25-45', pain_point: 'Hard to find the right gift', message: `${name} with ${p.name}`,
      emotion: 'Love', hooks: [`Hook 1 for ${name}`, `Hook 2 for ${name}`, `Hook 3 for ${name}`], creative_types: ['UGC testimonial'], why: 'Test mode.' };
  }) };
}
