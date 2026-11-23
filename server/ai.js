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

export async function writeScripts({ product, notes, language, count, extra }) {
  if (!LANGUAGES[language]) throw new HttpError(400, 'Unknown language');
  const n = Math.min(Math.max(Number(count) || 3, 1), 6);
  const user = `Product: ${product}
Product notes (benefits, audience, price, offer): ${notes || '(none: work from the product name)'}
${extra ? `Extra instructions from the team: ${extra}\n` : ''}
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
