# Module 1: Product Analysis & Marketing Angle Generator

Workflow on each product page, tab **🧠 Strategy**:

**Product → Analysis → Marketing angles → Continue**

1. **Product**: name, product page URL, description, pictures, selling price, promotional offer, target country, target language.
   **Import from the product page** reads the link (JSON-LD, meta tags, visible text, pictures; the AI cleans the text when the key is set). The team ticks the pictures to keep and corrects everything before saving.
2. **Analysis** (AI, from the description and up to 4 pictures): category, summary, features, benefits, problems solved, audiences, pain points, motivations, objections with answers, USPs, emotional triggers, market notes for the target country, and **missing info** (what the AI could not know: nothing is invented).
3. **Marketing angles**: 8-12 distinct angles (name, description, audience, pain point, main message, emotional trigger, 3 hooks in the target language, recommended creative types, why it could work). Select one or many, edit, add a custom angle, regenerate one or all (selected and edited angles are kept).
4. **Continue**: the saved angles, kept with the product for the next modules (scripts, storyboards, editing), and matched with the footage scenes (Module 2).

A new product opens directly on this tab (the product tab is called **🎯 Marketing angles**).

## How it runs

- AI work runs in the background (`ai_jobs`); the page shows progress and updates every 2 s. The analysis starts the angles by itself when it finishes.
- One run at a time per product: starting the same work twice answers 409.
- Every answer must match its JSON schema (`server/strategy.js`, checked by `server/schema.js`); a wrong answer is retried once, then the run fails with the reason and a **Try again** button.
- Every AI call is logged in `ai_usage` (kind, tokens, time, error). Admins: `GET /api/ai-usage` (last 30 days by kind + last 20 errors).
- A server restart marks running work as failed ("try again").
- Import only fetches public internet addresses (private, local and cloud-metadata addresses are refused), 3 MB pages, 8 MB pictures, 15 s timeout, 5 redirects checked one by one.

## Database changes (additive only, applied automatically on start)

- `products`: new columns `description`, `price`, `offer`, `country`, `language` (default `en`).
- New tables: `product_images`, `analyses`, `angles`, `ai_jobs`, `ai_usage`.
- Nothing is removed or renamed; old databases keep working.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/import-url` `{url}` | read a product page |
| POST | `/api/products/:id/images` (files) · `/images/from-urls` `{urls}` | add pictures |
| POST · DELETE | `/api/product-images/:id/main` · `/api/product-images/:id` | main picture · remove |
| GET | `/api/products/:id/strategy` | analysis, angles, pictures, running jobs |
| POST | `/api/products/:id/analyze` | start the analysis (then the angles) |
| POST | `/api/products/:id/angles/generate` | regenerate all angles |
| POST | `/api/angles/:id/regenerate` | regenerate one angle |
| POST · PATCH · DELETE | `/api/products/:id/angles` · `/api/angles/:id` | custom angle · edit/select · delete |
| POST | `/api/products/:id/angles/selection` `{ids}` | save the selection |
| GET | `/api/ai-usage` (admin) | AI usage and errors |

## Environment variables

Nothing new is required. Uses the existing `ANTHROPIC_API_KEY` (and `ACC_MODEL`, default `claude-opus-5-5`).
Optional, for tests only: `ACC_AI_MOCK=1` (example answers, no AI call), `ACC_AI_MOCK_DELAY=4000` (simulated wait in ms). **Never set these on Railway.**

## Deploy

`git push` to `main`: Railway builds the Dockerfile; the database changes apply on start. Then open a product → **Strategy** → **Save & analyse with AI** to check the real AI answers.

## Next modules (prepared)

Selected angles are stored per product (`angles.selected`) with their hooks and creative types, ready for footage analysis, storyboards and automated editing.
