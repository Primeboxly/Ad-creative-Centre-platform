// Writes ad scripts (hook + body + CTA) and ad copy with Claude.
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './errors.js';

export const LANGUAGES = { en: 'English', sw: 'Swahili', fr: 'French' };
const MODEL = process.env.ACC_MODEL || 'claude-opus-5-5';

let client;
const getClient = () => (client ??= new Anthropic());

const SYSTEM = `You write short vertical video ads (Facebook/Instagram Reels, TikTok) for a cash-on-delivery (COD) e-commerce business selling in African countries.

Each script has three parts that will be laid over separate video clips:
- hook: the first 2-3 seconds. One punchy spoken line that stops the scroll (a problem, a surprising result, a bold claim the product can keep, or a question about a situation, never about the viewer's health or personal attributes).
- body: 10-20 seconds of voiceover. Show the problem, then how the product solves it, with 2-3 concrete benefits. Simple everyday words, short sentences, the way people really talk.
- cta: 3-5 seconds. Order now, pay cash on delivery, fast delivery. Use the price only if the product notes give one.

Also write primary_text (the post text under the video: 4-7 short lines, emojis allowed, ✅ bullets, ends with a COD call to action) and a headline (max 40 characters).

Rules: write everything in the requested language, natural for people in East/Southern/West Africa (not a word-for-word translation). Never promise cures or medical results, never ask "do you have <condition>", no get-rich claims, no fake reviews or fake numbers. Do not use brand names unless they are in the product name. Each script must use a different angle (for example: problem/solution, testimonial "I tried it", gift, comparison with the old way, demonstration, price/value).`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scripts'],
  properties: {
    scripts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'hook', 'body', 'cta', 'primary_text', 'headline'],
        properties: {
          angle: { type: 'string', description: 'Short name of the angle, in English' },
          hook: { type: 'string' },
          body: { type: 'string' },
          cta: { type: 'string' },
          primary_text: { type: 'string' },
          headline: { type: 'string' },
        },
      },
    },
  },
};

export const aiReady = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// The BSS style (docs/style-bss-watch.md): one continuous voice-over of a 23-27 s montage ad.
const BSS_STYLE = `Write in the "BSS" style: one warm, persuasive voice reads the whole script without a break, over a fast montage of close-up shots.
- Total 55-70 words (about 23-27 seconds read aloud). Hook + body + cta must read as ONE flowing text.
- hook (8-14 words): a question or problem about finding the right gift or solution, e.g. "Struggling to find the perfect gift that will leave her speechless?"
- body (35-45 words): first dismiss the usual option ("Skip the generic presents and surprise her with…"), then 2-3 concrete details of the product as sensory phrases, then the feeling it gives ("she'll fall in love with it", "feel special every time she wears it"), then occasions or uses ("birthdays, anniversaries, or just to show how much she means to you").
- cta (10-15 words): order now and pay cash on delivery, with a soft urgency (limited stock) if it fits; no "tap the link".
- Short, natural spoken sentences; words that sound good read aloud; no lists, no emojis in hook/body/cta.`;

export async function writeScripts({ product, notes, language, count, extra, style = 'classic' }) {
  if (!LANGUAGES[language]) throw new HttpError(400, 'Unknown language');
  const n = Math.min(Math.max(Number(count) || 3, 1), 6);
  const user = `Product: ${product}
Product notes (benefits, audience, price, offer): ${notes || '(none: work from the product name)'}
${extra ? `Extra instructions from the team: ${extra}\n` : ''}${style === 'bss' ? `\n${BSS_STYLE}\n` : ''}
Write ${n} different scripts in ${LANGUAGES[language]}.`;

  let res;
  try {
    res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: user }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI key is wrong or missing (ANTHROPIC_API_KEY).');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI is busy. Try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new HttpError(502, 'AI error: ' + e.message);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new HttpError(422, 'The AI declined to write ads for this product. Change the notes and try again.');
  if (res.stop_reason === 'max_tokens') throw new HttpError(502, 'The AI answer was cut. Ask for fewer scripts.');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return JSON.parse(text).scripts.slice(0, n);
  } catch {
    throw new HttpError(502, 'The AI answer could not be read. Try again.');
  }
}

// ---------- Structured calls (Module 1 and later) ----------
// One Claude call that must answer JSON matching `schema` (checked with server/schema.js; one retry when it doesn't).
// content: the user message (string or content blocks: text + images). Every call is logged in ai_usage.
// ACC_AI_MOCK=1 answers with mock(…) instead of calling Claude (tests and local runs without a key).
export const aiMock = () => process.env.ACC_AI_MOCK === '1';

export async function callJson({ kind, system, content, schema, productId = null, userId = null, effort = 'medium', maxTokens = 32000, mock }) {
  const { validate, forApi } = await import('./schema.js');
  const { db } = await import('./db.js');
  const log = (ok, usage, ms, error = '') => db.prepare(`INSERT INTO ai_usage (kind, product_id, model, input_tokens, output_tokens, ms, ok, error, user_id) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kind, productId, aiMock() ? 'mock' : MODEL, usage?.input_tokens || 0, usage?.output_tokens || 0, ms, ok ? 1 : 0, String(error).slice(0, 500), userId);
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
        model: MODEL,
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
    const errs = validate(schema, data);
    if (errs.length) { lastError = errs.slice(0, 3).join('; '); log(false, res.usage, ms, lastError); continue; }
    log(true, res.usage, ms);
    return data;
  }
  throw new HttpError(502, `The AI answer was not in the right form (${lastError}). Try again.`);
}

// A whole script → { hook, body, cta }: the first sentence opens the video, the last one ends it, the rest is the middle.
// (Videos are always built in these three parts; the team only writes one text.)
export function splitScript(text) {
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+["'”»]?|[^.!?…]+$/g)?.map(x => x.trim()).filter(Boolean) || [];
  if (sentences.length < 3) return { hook: sentences[0] || '', body: sentences[1] || '', cta: sentences[2] || '' };
  return { hook: sentences[0], body: sentences.slice(1, -1).join(' '), cta: sentences[sentences.length - 1] };
}
