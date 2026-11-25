# Module 4: AI Script & Storyboard Generator (AI Creative Director)

Turns a saved **Creative Brief** (Module 3) and the analysed, silent footage (Module 2) into a creative strategy, hooks,
a timed script and a footage-based storyboard, reviewed, versioned and **approved** as a production plan for Modules 5-8.
No audio, music, captions, editing or video is produced here, and no footage is copied or cut.

## Where and how

Creative project → step **7 📝 Script & storyboard** (after "Review & save"; the Review step also has a "Script & storyboard →" button).

**Open project → ✨ Generate Script & Storyboard → review → ✅ Approve Script & Storyboard.**

- Choose the **planned video** (variation) of the brief: each one has its own plan (angle, creative type, hook style and editing style from the variation plan). Bulk generation is Module 9.
- The one button runs everything in the background (the page stays usable, with progress and **Cancel**): strategy → 5 hooks → best hook chosen automatically → script (shortened/expanded automatically when outside ±12 % of the target) → footage matching → storyboard → checks. Nothing is asked in between.
- Everything is optional to edit afterwards:
  - **Creative strategy**: view, edit or regenerate.
  - **Hooks**: 5 cards. Pick one or let the AI choose; edit, regenerate one, or ask for new hooks.
  - **Script**: full text, word count, estimated duration vs target (and the difference), structure. You can:
    - edit the whole script, or one segment (text, role, on-screen text);
    - add, remove or reorder segments;
    - rewrite one segment with an optional instruction;
    - find footage again for one segment;
    - lock a segment, copy the script, or regenerate the whole script.
  - **Visual storyboard**: a timeline bar coloured by role, then one card per shot. Each card shows the real thumbnail (hover plays the silent copy), timeline and source times, voice-over, on-screen text, description, match score, reasons, editing suggestions (transition, motion, crop), warnings and alternative scenes. You can:
    - replace a scene (from the alternatives or a searchable picker of the brief's scenes);
    - trim inside the scene, or move a shot within its segment;
    - add, remove, lock or regenerate a shot;
    - regenerate the whole storyboard while keeping the script.
  - **Checks**: blocking problems and warnings.
  - **Versions**: save, restore, duplicate, compare, approve. The approved production plan can be viewed.
- **Locks**: locked segments, hooks and shots are never overwritten by a regeneration.
- A newer Creative Brief is signalled; each plan stays tied to the brief version it was made from.

## AI Creative Director (architecture)

| File | Role |
|---|---|
| `server/sb-director.js` | Builds the context from the frozen brief + the chosen planned video, and makes the AI calls: strategy, hooks, one hook, script (with word budget and duration fix), one segment, shot choices. Prompt version `sb-v1`. |
| `server/sb-matching.js` | Scene matching and ranking (no AI, no video analysis): which brief scenes fit a segment. |
| `server/sb-duration.js` | Duration estimate: per-language speaking rate, dialect, tone, pauses; word budget; segment times. |
| `server/sb-plan.js` | Plans, versions, storyboard assembly on the timeline, team edits with locks, validation, compare, approval, production plan. |
| `server/sb-jobs.js` | Background jobs: one-button run and targeted regenerations, progress, cancel, retries, restart recovery, one job per plan. |
| `server/sb-schemas.js` | JSON schemas: AI answers and stored documents. |
| `server/sb-routes.js` | API. |

Every AI answer is structured JSON checked against its schema (one automatic retry on a wrong answer). Scene ids from the AI are checked against the candidates the AI was given, and invented ids are ignored. Brief texts, product descriptions and footage descriptions are passed as data: the prompt tells the model never to follow instructions inside them. Rules in every prompt:
- only facts from the brief, nothing invented;
- conditions (cash on delivery, free delivery, stock, guarantee) only when confirmed;
- price and offer exactly as given;
- no fake testimonials;
- visuals only from the available footage, with missing visuals named together with an alternative the footage supports.

## Scene matching method

For each script segment, all scenes allowed by the brief (and still production-ready: analysed, silent, not excluded) are scored from their Module 2 metadata:
- **Meaning first (60 %)**: the scene's categories vs the categories the segment needs (or the usual ones for its role: hook → close-up/showcase, demonstration → demonstration/hands…), plus shared words between the voice-over, visual intent, features and benefits and the scene's description, action line, tags, features and benefits shown.
- Angle relevance 12 %, quality 13 %, scene length vs shot length 7 %, orientation vs format 8 %.
- Penalties: watermark, text in the footage, low quality, "not about the product", already used in this ad, look-alike of a used scene, used by other planned videos.

The top 6 candidates of each segment (never the whole library) go to the AI, which chooses 1-3 shots per segment and suggests crop, motion, transition and notes. Then the storyboard is laid out on the voice-over timeline:
- the segment's time is shared between its shots without going beyond each scene's length;
- extra relevant scenes are added when the scenes are too short;
- repeated scenes are swapped for unused relevant ones when possible;
- a segment with no relevant scene gets **no** shot: a missing-footage note and a blocking error instead of an unrelated scene.

Source times always stay inside the scene, and the timeline has no gaps.

## Duration intelligence

Speaking rates (words per second):
- English 2.6, French 2.7, Swahili 2.1;
- × dialect factor (e.g. Tanzanian Swahili 0.97);
- × tone factor (energetic 1.08 … emotional and premium 0.9);
- plus pauses: comma 0.15 s, sentence end 0.3 s, between segments 0.25 s.

Configurable with `SB_SPEECH_RATES` / `SB_DIALECT_FACTORS` (JSON) and `SB_DURATION_TOLERANCE` (default 0.12). Shown: words, estimated seconds, target, difference. These times are **provisional**: Module 5's real voice-over durations replace them.

## Validation

**Blocking**:
- the brief is unusable;
- no script, empty segment, no CTA segment, script more than 1.5× the target;
- unconfirmed claims (cash on delivery, free delivery, limited stock, guarantee, a promotion without an offer) in spoken or on-screen text;
- a price different from the brief;
- scenes that are missing, belong to another product, are not allowed by the brief, or are no longer usable (excluded, not analysed, not silent);
- wrong source video, source times outside the scene;
- non-positive durations, timeline gaps or overlaps, storyboard length different from the script;
- a segment without footage;
- original audio not excluded.

**Warnings**:
- no strategy, script not starting with a hook, missing parts of the creative type's structure;
- possibly wrong language;
- estimate outside ±12 % of the target;
- testimonial-like wording;
- a scene shorter than its shot (hold), speed changes;
- weak visual match, low quality, watermark, text in the footage, cropping for the format;
- repeated scenes, missing footage.

Approval is refused while a blocking problem exists.

## Versions and approval

- Each plan has versions. The newest unfrozen version is the working draft (all edits and regenerations go there).
- **Save as a version** freezes the draft and continues on a copy. **Restore** and **Duplicate** make a new draft from any version, and the history is kept. **Compare** shows changes to the strategy, hook, script segments and shots between two versions.
- **Approve** freezes the version, records who approved it and when (`sb_approvals`), and stores the **production plan**. Editing afterwards creates a new draft, and the approved version never changes.
- References kept: plan ↔ Creative Brief version and planned video; version ↔ strategy revision; approval ↔ version and brief.

## Production plan (hand-off to Modules 5-8)

`GET /api/creative-projects/:id/production-plan?variation=N` (or `approvedProductionPlan()` in code). It contains:
- brief, plan and version references, product, creative type, angles, target market (with confirmed conditions), platform, format, tone, pace, CTA;
- **timing**, marked provisional;
- strategy and chosen hook;
- **voice-over** segments (text, role, estimated times, emotion; language, dialect, tone);
- **music** (on/off, mood, pace) and **captions** (on/off, language);
- **text overlays** (text, shot, times);
- **shots** (scene, source video key of the silent copy, source and timeline times, crop, motion, transition, speed, notes);
- production preferences, and footage audio: excluded.

Example: `docs/module-4-example-production-plan.json`.

## Schemas and examples

- `docs/module-4-schemas.json` (also `GET /api/sb/schemas`): strategy, hooks, **script**, **storyboard** documents (schema version 1.0).
- Examples (test mode, so the texts are placeholders): `docs/module-4-example-script.json` (strategy + hooks + script), `docs/module-4-example-storyboard.json`.

## Database (new tables only)

| Table | What |
|---|---|
| `sb_plans` | project, brief, brief version, planned video, status (draft · generating strategy/hooks/script · matching footage · generating storyboard · validating · ready · approved · failed), approved version |
| `sb_versions` | number, parent, label, frozen, approved, strategy (+ revision), hooks, script, storyboard, validation (JSON documents checked by schema) |
| `sb_version_scenes` | version ↔ shot ↔ Module 2 scene (foreign key) |
| `sb_jobs` | kind (full, strategy, hooks, hook, script, segment, match, shot, storyboard), target, status, stage, progress, attempts, error, log |
| `sb_approvals` | version, brief, production plan, who, when |

Segments, shots, hook suggestions and matching results live inside the versioned JSON documents (one consistent snapshot per version), and each shot's scene is also linked relationally. Running jobs go back to the queue after a restart.

## API

| | |
|---|---|
| `GET /api/creative-projects/:id/sb` | plans of a project |
| `POST /api/creative-projects/:id/sb/generate` `{ variation, force? }` | one-button run (creates the plan) |
| `GET/PATCH /api/sb-plans/:id` | full state · edits (`strategy`, `hook_select`, `hook_edit`, `hook_auto`, `segment`, `add_segment`, `remove_segment`, `segment_order`, `script_text`, `shot`, `add_shot`, `remove_shot`, `move_shot`) |
| `POST /api/sb-plans/:id/jobs` `{ kind, target, instruction? }` · `/cancel` · `/validate` | targeted regeneration · cancel · check again |
| `POST /api/sb-plans/:id/versions` · `/versions/:vid/restore` · `/versions/:vid/duplicate` · `GET /compare?a=&b=` | versions |
| `POST /api/sb-plans/:id/approve` · `GET /api/sb-plans/:id/production-plan` | approval · production plan |

Access: every team member can view; only the project's author or an admin can generate, edit or approve.

## Settings (optional Railway variables)

`SB_CONCURRENCY` (1), `SB_MAX_ATTEMPTS` (2), `SB_MAX_DURATION_FIXES` (2), `SB_DURATION_TOLERANCE` (0.12), `SB_SPEECH_RATES`, `SB_DIALECT_FACTORS` (JSON). Nothing is required: the existing `ANTHROPIC_API_KEY` (Claude Opus 5.5) is used.

## AI costs (Claude Opus 5.5, $4 / $20 per million tokens)

| Action | Calls | Estimate |
|---|---|---|
| One-button run | strategy, hooks, script (+ up to 2 duration fixes), shot choices | **≈ $0.30-0.60** per planned video |
| Regenerate strategy / all hooks / one hook | 1 | ≈ $0.05-0.10 / $0.05-0.10 / $0.02-0.04 |
| Regenerate script / storyboard | 1-3 / 1 | ≈ $0.10-0.25 / $0.05-0.10 |
| Rewrite one segment | 1 | ≈ $0.02-0.05 |
| Find footage for a segment, regenerate a shot, any manual edit | 0 | free (ranking only) |

Identical inputs are answered from the cache (`ai_cache`, key = hash of prompt version + inputs) unless you ask to regenerate. Every call is logged in `ai_usage` with tokens and cost (`ref sbplan:<id>`), and the page shows the plan's total.

## Tests

- `npm test`: **26/26**. Six are new for Module 4:
  - durations per language, tone and pauses;
  - the full run (schemas, roles, contiguous script and timeline, real scenes of the product, sources inside scenes);
  - invented scene ids ignored, too-short scenes completed, no unrelated footage forced;
  - locks surviving regeneration, targeted regeneration leaving the rest unchanged, invalid scene and trim refused, permissions;
  - claims, prices and excluded footage blocking; approval freezing, the production plan, a new draft after approval, compare;
  - refusals without AI, without a brief, or with a job already running; separate plans per planned video.
- API run (37 checks): every regeneration kind, locks, segment add/remove/reorder, trims, versions, approval, production plan, permissions, cancel, duplicate requests.
- Browser (test mode): generation with progress and cancel, hooks, script editor, storyboard with thumbnails, alternatives, approval, no errors. Temporary test data deleted afterwards; no real project or footage touched.

## Known limits

- Real AI outputs were tested in test mode only (the key is on Railway): check the first real scripts (language quality, length, footage choices).
- Language detection is a simple word check (a warning, never blocking).
- Matching uses words and categories from the scene analysis (no embeddings, no new dependency). It is fast and free, and the AI then chooses among the top candidates.
- Estimated timing is provisional until Module 5's voice-over.
