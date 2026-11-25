# Module 3: Creative Types & Settings (Creative Projects → Creative Brief)

A creative project sets up an ad from an existing product (Module 1) and its analysed footage (Module 2), and ends with a
saved, versioned **Creative Brief**: the single source of truth for Modules 4-9. Nothing is generated here (no script,
voice, music, captions, editing or video), and no media is copied.

## Where

Sidebar **🎬 Creative projects** (list with search and filters: product, country, creative type, status) → **+ New creative project** → choose a product → 6 steps:

**Product → Marketing angles → Footage → Creative type → Settings → Review & save**

- Steps can be visited in any order; every change is **saved automatically** as a draft (also **💾 Save draft**).
- Each step shows its blocking problems (⛔) and warnings (⚠); the step bar shows "N to fix".
- **✅ Save Creative Brief** is the last action (disabled while a blocking problem exists). There is no Generate button yet.
- Projects can be **duplicated** (settings, angles and scene choices copied, never media) and **deleted** (products and footage are not touched).
- Also: a Creative projects tile on the dashboard and on each product's overview (opens the list filtered on that product).

### 1. Product
Read-only summary from Module 1 (picture, country, language, price, offer, analysis, angles, videos, analysed and production-ready scenes). Without analysed footage: a clear message and a link to the product's Footage library.

### 2. Marketing angles
The product's angle cards (Module 1 design) with description, selling message, suggested hooks and **number of relevant scenes** (scenes matched to the angle with a score ≥ 50). The angles chosen in Module 1 are pre-selected. **＋ Add a custom angle** saves it on the product (Module 1 API). Angles are never regenerated here.

### 3. Footage
- **Automatic Selection**: every production-ready scene (the future AI Creative Director picks per angle, quality and type).
- **Favorites Only**: only the scenes marked ★ in Module 2.
- **Manual Selection**: pick scenes on their thumbnails (preview plays the silent copy).
In every mode a scene can be left out for this project. **Eligible** = analysed, not excluded in Module 2, from a video whose silent copy was checked by ffprobe. Scenes picked earlier that become unavailable are reported and never used.

### 4. Creative type
Cards for the 9 types + **✨ AI Recommended**, with their narrative structure, the number of matching scenes (or "⚠ No unboxing or packaging scenes"), "Needs a real offer", "AI recommends" and their rules. Several types can be chosen.

| id | Type | Structure |
|---|---|---|
| `problem_solution` | Problem – Solution | Hook → Problem → Solution → Product Benefits → CTA |
| `demonstration` | Product Demonstration | Hook → Product Introduction → How It Works → Demonstration → CTA |
| `ugc` | UGC Style | Natural Hook → Product Presentation → Product Experience → Benefits → CTA (never fake testimonials) |
| `direct_response` | Direct Response | Strong Hook → Pain Point or Need → Benefits → Offer → CTA |
| `features_benefits` | Features & Benefits | Hook → Product Introduction → Key Features → Customer Benefits → CTA |
| `storytelling` | Storytelling | Story Hook → Situation → Problem → Product Discovery → Solution → CTA |
| `unboxing` | Unboxing | Package Introduction → Product Reveal → Features → Demonstration → CTA |
| `offer` | Offer Creative | Hook → Product Value → Promotional Offer → CTA (real offer required) |
| `before_after` | Before & After | Initial Situation → Product Application → Supported Result → CTA (only supported results) |

All types live in one registry: `server/creative-types.js` (id, name, description, structure with the purpose of each part, recommended scene categories, the footage it needs, default settings, rules). Adding a type = adding one entry.

### 5. Settings
- **Target market**: country, language, regional variant/dialect, currency, selling price, promotional offer, inherited from the product and marked "from the product"; a project-only change is marked, with a link back to the product's value. The product itself never changes.
  **Confirmed conditions**: cash on delivery, free delivery, limited stock, guarantee. Only confirmed ones may appear in the CTA, the custom hook or the offer (checked).
- **Platform**: Facebook, Instagram, Facebook + Instagram, TikTok, YouTube Shorts, YouTube, Other, with suggested defaults (format, duration, pace) to apply in one click.
- **Duration**: 15 / 20 / 30 / 45 / 60 s or custom (limits `CREATIVE_MIN_DURATION`, `CREATIVE_MAX_DURATION`).
- **Aspect ratio**: 9:16, 1:1, 4:5, 16:9 with visual previews; output 1080p or 720p (1080×1920, 1080×1080, 1080×1350, 1920×1080…).
- **Style**: tone, editing pace, hook styles (several) + optional custom hook, all with **AI Recommended**; CTA suggestions (cash-on-delivery ones only when confirmed) or your own CTA.
- **Production preferences** (collapsible): AI voice-over, background music, captions, text overlays, sound effects, price display, CTA screen. Original footage sound: always off.
- **Variations**: 1 / 3 / 5 / 10 / custom (max `CREATIVE_MAX_VARIATIONS`) and strategies (different hooks, angles, creative types, footage, scripts, editing styles, full variations).
  The count is the **total number of videos**. Combinations = angles × types (when those strategies are on); the total is split evenly, shown in a table you can edit (the sum must equal the total), with an explanation. Hooks, footage sets, scripts and editing styles rotate per video according to the strategies.

### AI recommendations
On the angles, type, settings and review steps: **✨ Get recommendations** → best angles, creative types, duration, pace, tone, hook styles and footage categories, each with a one-line reason. **Apply** each one, or **Apply all**.
The AI receives the product analysis, the angles with their relevant-scene counts, the footage categories really available and the matching-scene count of every type. Afterwards, types without matching footage (or Offer without an offer) are removed anyway. Same inputs → cached answer, no new AI call (cache key = hash of the inputs).

### 6. Review & save
Blocking problems and warnings (each with a link to its step), the recommendations, a full configuration summary, the brief preview (JSON) and the saved versions.

## Validation

**Blocking** (the brief cannot be saved; drafts are always saved): product missing; no angle; no eligible footage, or no scene left in the chosen mode; no creative type, or AI Recommended without recommendations; unknown type; Offer Creative without an offer; invalid language; duration outside the limits; unsupported aspect ratio; variation count outside the limits; distribution not equal to the total; an unconfirmed claim in the CTA, custom hook or offer (cash on delivery, free delivery, limited stock, guarantee, promotion without an offer).

**Warnings**: the footage does not support a chosen type; an angle with fewer than 2 relevant scenes; too few distinct scenes for the number of videos (look-alikes counted once); scenes whose orientation needs cropping for the chosen format; no price (or price display on without a price); no offer; no country; no CTA; several videos without a strategy; combinations that get no video; picked scenes no longer available.

## Creative Brief

- Schema version **1.0**: `docs/module-3-brief-schema.json` (also `GET /api/creative/brief-schema`). Every saved brief is checked against it.
- Example: `docs/module-3-example-brief.json` (test data, shortened lists).
- Contents: project, product snapshot (with its analysis), angle snapshots (with relevant-scene counts), creative types with their structures, footage mode and scene references (ids, times, silent copy key, quality, categories, angle scores, never the files), target market (with confirmed conditions), platform, format (duration, ratio, resolution, width × height), style (tone, pace, hooks: preference and resolved value, custom hook, CTA), production preferences (original audio: excluded), variation plan (count, strategies, distribution, one entry per planned video), AI recommendations, validation results, timestamps.
- **Versioned and frozen**: each save is a new version; later product or project changes never change a saved brief. Editing a project after saving turns it back into a draft until the next save.
- For Modules 4-9 (`server/creative-brief.js`): `getBrief(projectId, version?)` and `revalidateBrief(brief)` (checks the product, angles and scenes still exist and are usable, before any generation).

## Database (additive, applied automatically on start)

New tables: `creative_projects` (product, name, status draft/ready, settings JSON, recommendations + their cache key, author, dates), `creative_project_angles` (project ↔ angle), `creative_project_scenes` (project ↔ scene: include/exclude), `creative_variation_plans` (count, strategies, own distribution), `creative_briefs` (versioned brief JSON, schema version, author). Foreign keys with cascade: deleting a product, angle or scene removes the links; deleting a project removes its links and briefs. Creative types are kept in code (registry), not in the database.

## Access

Every signed-in team member sees all projects (as for products). Only the project's author or an admin can change it, save its brief or delete it; others see it read-only and can duplicate it. Angles and scenes must belong to the project's product.

## API

| | |
|---|---|
| `GET /api/creative/registry` | types, platforms, durations, limits, formats, tones, paces, hooks, CTAs, production, strategies, dialects |
| `GET/POST /api/creative-projects` | list (`?product=&country=&type=&status=&q=`) · create `{ product_id, name? }` |
| `GET/PATCH/DELETE /api/creative-projects/:id` | full state (+ validation, plan) · save `{ name, settings, angle_ids, scenes:{include,exclude}, variations:{count,strategies,distribution} }` · delete |
| `POST /api/creative-projects/:id/duplicate` | copy |
| `POST /api/creative-projects/:id/recommendations` | AI recommendations `{ force? }` |
| `GET /api/creative-projects/:id/brief/preview` | brief as it would be saved now |
| `POST /api/creative-projects/:id/brief` | save a new version (422 with the validation when blocked) |
| `GET /api/creative-projects/:id/brief?version=` · `/brief/check` | read a brief · re-check it before generation |

## Settings (optional Railway variables)

`CREATIVE_MIN_DURATION` (6), `CREATIVE_MAX_DURATION` (180), `CREATIVE_MAX_VARIATIONS` (50). Nothing else is needed: the existing `ANTHROPIC_API_KEY` is used.

## AI cost

One recommendation = one text call (no pictures), effort low: about 3-6k input tokens and 1-2k output tokens with Claude Opus 5.5 ≈ **$0.03-0.06**. Repeated with the same inputs: free (cached). Logged in `ai_usage` (kind `creative-reco`, ref `project:<id>`).

## Tests

- `npm test`: 20/20 (7 new for Module 3: inherited settings, footage modes and exclusions, ownership of angles and scenes, claims, offer, limits, variation plan and custom distribution, brief blocking/versions/frozen snapshot/schema/revalidation, permissions and duplicate without media, recommendations supported by footage and cached).
- In the browser with test data (AI in test mode): list and filters, new project from a product, angles pre-selected, recommendations + Apply all, type cards with footage support, manual scene selection, settings inherited from the product, platform/duration/format/style/CTA/production, variations 5 = 2+1+1+1 over 2 angles × 2 types, wrong distribution blocked then fixed, brief v1 saved with warnings, view-only for a team member, dashboard and product tiles, Modules 1 and 2 still working, no browser errors. Test data removed afterwards.

## Known limits

- The real AI recommendations were tested in test mode only (the key is on Railway): check the first real ones.
- "Different footage / scripts / editing styles" are recorded per planned video for Modules 4-9; nothing is generated here.
- The automatic footage selection inside a video (which scene for which part) is the job of the future AI Creative Director (Module 6); here the brief lists the eligible scenes.
