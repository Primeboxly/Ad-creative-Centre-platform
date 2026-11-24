# Module 2: Footage Library & AI Scene Analysis

On each product page, tab **🎞 Footage**, there are now three sub-tabs:

- **🎬 Original videos**: upload (drag and drop, up to 20 at a time, MP4 / MOV / WebM), preview, rename, delete, download the original, search, filter by status, follow progress, cancel, retry, see the processing log and the AI cost of each video. **✂️** also sends a video to the current ad maker.
- **✨ AI scenes**: every scene of every video, with a thumbnail (hover = it plays just those seconds), time range, AI description, categories, quality score, flags (watermark, text on screen, staged, low quality, look-alike) and matching marketing angles.
  Filters: search, video, category, marketing angle, quality, length, format, analysis status, favourites, excluded. Sort by quality, video order, length or angle match.
  ★ marks a favourite; 🚫 excludes a scene from future ads. Click a scene to open the **inspector**.
- **✂️ Clips for the ad maker**: the existing clip library used by "Create ads" (unchanged).

**Scene inspector**: the player loops the scene inside the whole video (timeline bar). You can split at the current time, set start/end, merge with the next scene, re-analyse, favourite, exclude, and edit the description, the short "matching" line, categories, tags, ad placements and linked angles (with a score). Edits change only the scene's times and data: **the original video is never modified**.

## How a video is processed (background jobs)

`Uploaded → Queued → Saving the original → Extracting metadata → Detecting scenes → Analyzing scenes → Matching marketing angles → Completed` (or `Failed` / `Cancelled`).

1. **Upload checks**: extension (.mp4 .mov .webm), the file's first bytes (a renamed text file is refused), size limit (`FOOTAGE_MAX_MB`), SHA-256 fingerprint: the same file twice in a product is refused as a duplicate.
2. **Saving**: the original is stored for good (S3 bucket, or the Railway volume).
3. **Metadata** (ffmpeg): duration, resolution, aspect ratio, frame rate, size, bitrate, sound, video/audio codec, rotation, orientation, thumbnail. A light **preview copy** (H.264 MP4, max 1280 px) is made only when needed (not MP4/H.264, very large or heavy files); the original stays as uploaded.
4. **Scenes** (ffmpeg scene-change detection): scenes shorter than `FOOTAGE_MIN_SCENE` are merged with a neighbour, scenes longer than `FOOTAGE_MAX_SCENE` are cut into equal parts. Scenes are **time ranges** (no video file per scene). For each scene: thumbnail, measured sharpness / brightness / contrast / movement, a picture fingerprint (to find duplicates and look-alikes, never deleted, only flagged), and a measured quality score.
5. **AI analysis** (Claude, multimodal): `FOOTAGE_FRAMES_PER_SCENE` frames per scene (start → end, longest side `FOOTAGE_FRAME_SIZE` px) plus the measurements, several scenes per call. Returns checked JSON: description, matching line, objects, product visible, features shown, benefits shown, human interaction, place, camera movement, composition, text on screen, watermark, footage type (real-customer style / staged / synthetic), relevance to the product, quality parts + score + note, 1-4 categories, tags, ad placements with a fit %, and marketing angles with a score and reason.
   Rules given to the AI: only what is visible; no invented features; no identification of people and no guesses about sensitive attributes; staged or synthetic footage is never a customer testimonial.
   Final quality = 55 % AI judgment + 45 % measured picture quality (−10 with a watermark).
6. **Angle matching**: done in the same call. When angles are added or edited later, the Scenes tab shows **"Marketing angles changed → Re-match scenes"**: a cheap text-only job (no pictures) re-links the scenes.

Jobs are stored in the database (`footage_jobs`): progress, attempts, errors and a log. Temporary problems (AI busy, network, ffmpeg stopped by memory) are retried automatically (up to `FOOTAGE_MAX_ATTEMPTS`, with a growing wait). After a restart, running jobs go back to the queue and **continue from the last finished stage** (already stored / measured / analysed parts are skipped). Retrying never creates duplicate scenes. Cancel stops ffmpeg at once. `FOOTAGE_CONCURRENCY` videos are processed at the same time (default 1); video work runs in separate ffmpeg processes so the site stays fast.

## Costs

- AI answers are **cached** by file fingerprint + scene times + settings + product + angles: retries, merges back to earlier times and re-uploads in the same state cost nothing.
- Only a few small frames per scene are sent, never the whole video.
- Every call is logged in `ai_usage` with tokens and an estimated cost (`cost_usd`), linked to the video (`ref = asset:<id>`). Each video card shows its AI cost; the header shows the product total.
- **Estimate (Claude Opus 5.5, $4 / $20 per million tokens, effort medium, 3 frames of 768 px)**: about **$0.02-0.03 per scene**, about **$0.20-0.25 per 30 s TikTok** (≈ 8-9 scenes). Re-matching angles: about $0.01 per 20 scenes. Cheaper options if you want them later: `FOOTAGE_AI_EFFORT=low`, `FOOTAGE_FRAMES_PER_SCENE=2`, or `FOOTAGE_AI_MODEL=claude-sonnet-5-5` (half the price).

## Database changes (additive only, applied automatically on start)

New tables: `footage_assets`, `footage_scenes`, `scene_analyses`, `scene_tags` (categories + tags, AI or team), `scene_angles` (scene ↔ angle with score), `footage_jobs`, `ai_cache`.
New columns: `ai_usage.ref`, `ai_usage.cost_usd`, `footage_jobs.options`. Nothing is removed or renamed.

## Storage

- **With S3 settings** (recommended for big libraries): originals, previews and pictures go to the bucket; the browser gets **10-minute signed links**, the bucket stays private. Works with Railway Buckets, Cloudflare R2, Backblaze B2, AWS S3, MinIO.
- **Without S3 settings**: files go to the Railway volume (`/data/store`), which is permanent (it survives deploys and restarts, like the clips and ads today). Uploads wait in `/data/incoming` until stored.

## Settings (Railway → service → Variables)

| Variable | Needed? | Default | What |
|---|---|---|---|
| `S3_BUCKET` | for S3 | | bucket name |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | for S3 | | bucket keys |
| `S3_ENDPOINT` | for S3 (not AWS) | | e.g. `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION` | optional | `auto` | e.g. `us-east-1` for AWS |
| `S3_FORCE_PATH_STYLE` | optional | off | `1` for MinIO and some providers |
| `FOOTAGE_MAX_MB` | optional | `1024` | largest video |
| `FOOTAGE_CONCURRENCY` | optional | `1` | videos processed at once (1-4; more needs more memory) |
| `FOOTAGE_MIN_SCENE` / `FOOTAGE_MAX_SCENE` | optional | `1.2` / `8` | scene length limits (seconds) |
| `FOOTAGE_SCENE_THRESHOLD` | optional | `0.3` | picture change that starts a new scene (lower = more scenes) |
| `FOOTAGE_FRAMES_PER_SCENE` / `FOOTAGE_FRAME_SIZE` | optional | `3` / `768` | frames sent to the AI |
| `FOOTAGE_AI_BATCH` | optional | `6` | scenes per AI call |
| `FOOTAGE_AI_MODEL` / `FOOTAGE_AI_EFFORT` | optional | `claude-opus-5-5` / `medium` | AI used for scenes |
| `FOOTAGE_MAX_ATTEMPTS` | optional | `3` | automatic tries for temporary errors |

The S3 names `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_REGION` are also understood.
`ANTHROPIC_API_KEY` (already set) is used for the analysis. No new service is required: the worker runs inside the web service.

**Why no separate worker service**: the database is SQLite on the service's volume, and a Railway volume belongs to one service only. The worker therefore runs in the same service, in the background, with video work in separate ffmpeg processes. If the app later moves to Postgres + S3, `server/footage.js` can run as its own service.

## API (all behind sign-in)

| | |
|---|---|
| `GET /api/footage/config` | limits, formats, categories, placements, cost estimate |
| `POST /api/products/:id/footage` | upload (`files`, up to 20) → `{ added, duplicates, rejected }` |
| `GET /api/products/:id/footage` | videos with status, progress, scene counts, AI cost, last job; angles; stale count |
| `PATCH /api/footage/:id` · `DELETE /api/footage/:id` | rename · delete (files too) |
| `POST /api/footage/:id/retry` · `/cancel` · `/to-clips` · `GET /api/footage/:id/jobs` | retry · cancel · send to ad maker · logs |
| `GET /media/footage/:id/preview` · `/original` · `/thumb` · `GET /media/scene/:id/thumb` | media (volume or signed S3 link) |
| `GET /api/products/:id/scenes` · `GET/PATCH /api/scenes/:id` | scenes · one scene · edit |
| `POST /api/scenes/:id/split` `{at}` · `/merge` · `/trim` `{start,end}` · `/reanalyze` | non-destructive edits |
| `POST /api/products/:id/scenes/rematch` | re-link scenes to the current angles |
| `GET /api/angles/:id/scenes` | best scenes for an angle |
| `POST /api/products/:id/scenes/search` | filter scenes, or rank them for a script `sentence` |
| `POST /api/products/:id/footage/plan` `{ slots: [{ placement, duration, sentence? }], angleId? }` | timeline proposal (scene + exact seconds per slot, no repeats, look-alikes avoided) |
| `GET /api/scenes/:id/source` | stored video + exact timestamps of a scene |

## For the next modules (`server/footage-services.js`)

`scenesForAngle`, `scenesForSentence` / `sentenceFit` (word match, free), `selectScenes` (quality, length, category, placement, angle, favourites), `sceneSource` (exact timestamps), `planTimeline` (structured timeline that avoids repeats and look-alikes). No editing or rendering is done in this module.

## Tests

`npm test`: 28 tests. New: `tests/footage.test.mjs` (scene planning, metadata reading incl. rotated phone video, fingerprints, scores, file checks, a real generated video with a scene change) and `tests/storage-s3.test.mjs` (the S3 path against a local fake S3: upload, download, signed link, delete).
Checked by hand with generated MP4 (vertical, 4 scenes, sound), MOV (MPEG-4, horizontal → preview copy) and WebM (VP9, square → preview copy) videos in AI test mode: upload of several files, refused fake video, refused duplicate, metadata, scenes at the right seconds, analysis, categories, scores, angle links, filters, favourites, split / merge (cached answer reused), cancel, retry without duplicates, server restart in the middle of an analysis (continued), angle change → re-match, delete (files removed), the other product tabs.

## Known limits

- The real AI analysis was tested in test mode only (no key on the development machine): check the first real videos.
- "Matching with script sentences" is a simple word match for now (free); a later module can use the AI for it.
- Camera stability is judged by the AI from the frames (the measured "movement" is picture change, not shake).
- Videos already cut into clips before this module are not imported into the library automatically (upload them again, or keep using them in the ad maker).
- Team members share all products (as before): every signed-in member of the team can see every product's footage; people outside the team cannot.
