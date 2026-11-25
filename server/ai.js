// Claude: one checked JSON answer per call (callJson), with usage and cost logged. Used by Module 1 and Module 2.
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './errors.js';

export const LANGUAGES = { en: 'English', sw: 'Swahili', fr: 'French' };
const MODEL = process.env.ACC_MODEL || 'claude-opus-5-5';

let client;
const getClient = () => (client ??= new Anthropic());


export const aiReady = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);


// ---------- Structured calls (Module 1 and later) ----------
// One Claude call that must answer JSON matching `schema` (checked with server/schema.js; one retry when it doesn't).
// content: the user message (string or content blocks: text + images). Every call is logged in ai_usage.
// ACC_AI_MOCK=1 answers with mock(…) instead of calling Claude (tests and local runs without a key).
export const aiMock = () => process.env.ACC_AI_MOCK === '1';

// Price per million tokens (input, output) in US dollars, to estimate what each call cost.
export const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-2': [8, 40] };
export const costOf = (model, inTok, outTok) => { const p = PRICES[model] || PRICES['claude-opus-5-5']; return (inTok * p[0] + outTok * p[1]) / 1e6; };

export async function callJson({ kind, system, content, schema, productId = null, userId = null, effort = 'medium', maxTokens = 32000, mock, ref = '', model = MODEL }) {
  const { validate, forApi, trimLists } = await import('./schema.js');
  const { db } = await import('./db.js');
  const log = (ok, usage, ms, error = '') => {
    const inTok = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0), outTok = usage?.output_tokens || 0;
    db.prepare(`INSERT INTO ai_usage (kind, product_id, model, input_tokens, output_tokens, ms, ok, error, user_id, ref, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(kind, productId, aiMock() ? 'mock' : model, inTok, outTok, ms, ok ? 1 : 0, String(error).slice(0, 500), userId, ref, aiMock() ? 0 : costOf(model, inTok, outTok));
  };
  if (aiMock() && mock) {
    if (process.env.ACC_AI_MOCK_DELAY) await new Promise(r => setTimeout(r, Number(process.env.ACC_AI_MOCK_DELAY)));
    const data = mock();
    const errs = validate(schema, data);
    log(!errs.length, null, 0, errs.join('; '));
    if (errs.length) throw new HttpError(502, 'Mock answer does not match the schema: ' + errs.slice(0, 3).join('; '));
    return data;
  }
  if (!aiReady()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    let res;
    try {
      res = await getClient().beta.messages.stream({
        model,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        output_config: { effort, format: { type: 'json_schema', schema: forApi(schema) } },
        messages: [{ role: 'user', content }],
      }).finalMessage();
    } catch (e) {
      log(false, null, Date.now() - t0, e.message);
      if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI key is wrong or missing (ANTHROPIC_API_KEY).');
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI is busy. Try again in a minute.');
      if (e instanceof Anthropic.APIError) throw new HttpError(502, 'AI error: ' + e.message);
      throw e;
    }
    const ms = Date.now() - t0;
    if (res.stop_reason === 'refusal') { log(false, res.usage, ms, 'refusal'); throw new HttpError(422, 'The AI declined this request. Check the product information and try again.'); }
    if (res.stop_reason === 'max_tokens') { log(false, res.usage, ms, 'max_tokens'); throw new HttpError(502, 'The AI answer was too long and got cut. Try again.'); }
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let data;
    try { data = JSON.parse(text); } catch { lastError = 'not JSON'; log(false, res.usage, ms, lastError); continue; }
    const errs = validate(schema, trimLists(schema, data));
    if (errs.length) { lastError = errs.slice(0, 3).join('; '); log(false, res.usage, ms, lastError); continue; }
    log(true, res.usage, ms);
    return data;
  }
  throw new HttpError(502, `The AI answer was not in the right form (${lastError}). Try again.`);
}
