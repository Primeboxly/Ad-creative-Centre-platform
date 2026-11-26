# Module 6: AI Video Editing Engine

Turns the approved Creative Brief, script & storyboard, analysed silent footage and the approved Audio Production
Package (Module 5) into a real, synchronized MP4 creative, with a timeline the team can adjust, versions, quality
control and an approval that hands everything to Module 7.

## How to use it

Creative project → **step 9 "🎬 Video editing"**:

1. Choose the approved audio of the planned video (the newest one is selected).
2. Click **🎬 Generate Video Creative**. In the background, without asking anything, it:
   checks the approved inputs and their versions → AI editing plan → the Editing Decision List (EDL) → clips cut on the
   real voice timing → framing → transitions → approved audio → MP4 render → quality check → thumbnail → the preview appears.
3. Watch it. If needed, click a clip in the timeline and replace it, trim it, change its length, framing, motion or
   transition; change the voice or music level; then **▶ Render preview** again (only the changed clips are re-made).
4. Click **Render Standard** (or High), then **✅ Approve Video Edit**.

Sections: creative summary, AI editing plan, video preview (player, size, quality, render version, quality check,
download, earlier renders), timeline (video, voice with waveform, music, reserved captions and effects tracks, playhead),
clip inspector, audio mix, advanced settings (pace, default framing, view the EDL), checks, versions, approval.

## Files

| File | Role |
|---|---|
| `server/video-schemas.js` | EDL schema (version 1.0), output formats, quality presets, pace guidelines, limits, statuses. |
| `server/video-director.js` | AI Video Editing Director: creative decisions only (pace, framing and focus, motion, transitions, extra relevant scenes for long segments, opening trim). Checked and clamped. |
| `server/video-edl.js` | Builds the EDL with code (never the AI), frame-exact, and validates it (scene bounds, gaps, overlaps, totals, transitions, speed, holds, repetition, framing, resolution, watermarks, embedded text, product visibility, voice coverage). |
| `server/video-render.js` | FFmpeg engine: source choice, frame-accurate trim, normalisation, crop/scale/fit, motion, holds, fades, crossfades, assembly, audio, MP4, thumbnail, quality control. |
| `server/video-production.js` | Edits, input loading and version checks, EDL versions, team edits, compare, approval, package for Module 7, page state. |
| `server/video-jobs.js` | Background render jobs (statuses, progress, cancel, retries, time limit, disk check, temp cleanup, restart recovery, usage). |
| `server/video-routes.js` | API. |
| Changed | `server/db.js` (new tables only), `server/index.js` (mount + worker), `server/footage-media.js` (exports the ffmpeg path), `public/app.js` + `public/style.css` (step 9; the scene picker now accepts any scene list). |
| Tests | `tests/video.test.mjs` |
| Docs | this file, `docs/module-6-schemas.json`, `docs/module-6-example-edl.json` |

Nothing of Modules 1-5 was rebuilt; no legacy editing code was brought back.

## Inputs (nothing typed again)

From the approved Audio Production Package and the data it points to: project, planned video, Creative Brief version,
product, angle, creative type, language, platform, target duration, aspect ratio, resolution, pace, approved script and
storyboard version, synchronized storyboard (real speech windows), voice-over file and timing, music file, mix file and
settings, caption word timing, overlay suggestions; eligible scenes (Module 2 analysis, the brief's footage list,
excluded and not-silent scenes removed).

**Version checks before any work:** the script must still be the approved one (else "approved again" → outdated), the
audio must be the latest approved audio of that production, the package must belong to that script version and use a
supported schema, and its files must exist. An outdated edit is kept but can no longer be rendered; the newest audio
gets its own edit. Voice-over or music turned off in the brief → that track is simply absent.

## AI Video Editing Director

Input: product, creative type, angles, platform, format, brief pace, music energy, hook, segments with their real times
and text, every shot with its scene's description, product visibility, composition, camera, categories, watermark and
on-screen text flags (text from Module 2 analysis: **no video is sent to the AI again**), plus unused usable scenes.
Output (schema in `docs/module-6-schemas.json`): pace and reason, opening trim, transition and framing strategy, per shot
framing + focus point + motion + transition + up to 2 extra relevant scenes, warnings, summary. Shot ids and scene ids
outside the given lists are dropped; numbers are clamped; the brief's pace wins unless it is "AI recommended". The answer
is cached by its input (same input = no new AI call). Test mode (`ACC_AI_MOCK=1`) gives deterministic decisions.

## Editing Decision List

Single source of truth for rendering. Timeline positions are **whole frames** at the output frame rate (seconds are
derived), so cuts never drift; source times are seconds to the millisecond. Each clip has: id, order, asset, scene,
source key, script segment, narrative role, source start/end, timeline start/end, start frame and frame count, speed,
crop (mode, focus x/y, zoom, uncertain flag), position, scale, motion, hold, transition in, reason, lock, origin.
Tracks: video, voiceover, music, mix, reserved captions (word timing source), reserved overlays (timed suggestions from
the storyboard), reserved effects. Plus audio levels (`footage_audio: "excluded"`), safe area, segments, director notes,
validation. Example: `docs/module-6-example-edl.json`. Hash of the EDL = render reuse key.

## Synchronisation method

The windows come from Module 5's synchronized storyboard: each spoken segment starts where its speech really starts
(lead-in included) and lasts until the next segment starts; the last one ends with the approved audio (CTA hold included).
Each storyboard shot becomes one or more clips: when a shot is longer than the pace's maximum, it is split (extra relevant
scenes chosen by the director first, then other non-overlapping parts of the same scene), so a 7 s demonstration can show
several relevant clips. Frame boundaries are rounded once, from the absolute times, so errors never add up. The audio is
never stretched or cut: the timeline length is the approved audio length.

Pace guidelines (seconds, change with `VD_*_SHOT`): slow 4 (max 6), balanced 2.8 (4.5), dynamic 2 (3.2), fast 1.4 (2.4).

## Footage trimming and insufficient footage

Source windows always stay inside the Module 2 scene. If a scene is too short for its window, in order: start earlier
in the scene, play slightly slower (not below 0.85×, flagged for review), hold the last frame (at most 0.6 s, flagged);
beyond that the clip is **blocking** ("missing footage") and nothing is rendered. Replacements are never silent: the
team chooses with "Replace clip"; locked clips are kept when the timeline is regenerated.

## FFmpeg rendering

Installed: FFmpeg 6.1 (development: ffmpeg-static; Railway: Debian's ffmpeg from the Dockerfile) with libx264, AAC,
xfade, zoompan, crop, scale, boxblur, blackdetect, freezedetect, silencedetect, ebur128. Commands are argument arrays
built from validated numbers and allowlisted words (no shell, nothing written by the AI is executed).

1. **Source**: the verified silent copy (Module 2); for Standard/High, the original's **picture only** when the silent
   copy (max 1280 px) would be upscaled. Every source is opened with `-map 0:v:0 -an`.
2. **Clip**: `-ss` before `-i` with re-encoding (frame-accurate: decodes from the previous keyframe and drops frames up to
   the exact time; stream copy is never used for cutting), speed, constant output fps (handles variable frame rate and
   rotation), framing, motion, hold, fades, exact frame count, H.264 yuv420p. Cached per clip (same source, window,
   framing and quality = reused).
3. **Timeline**: no crossfade → the identical clips are joined by stream copy (one encode only); with crossfades → one
   pass with `xfade` (the incoming clip gets a handle of extra footage before the cut, so the total length never changes).
4. **Audio**: the approved Module 5 mix as it is; if the team changed voice/music levels, a new mix is made from the same
   approved voice and music files (measured loudness, ducking, limiter). ElevenLabs is never called.
5. **MP4**: H.264 + AAC 48 kHz, `+faststart` (plays while downloading), exact duration; thumbnail from the hook.

Quality presets: Preview (half size, veryfast, CRF 28), Standard (1080 wide, medium, CRF 21), High (slow, CRF 18).

## Reframing

Output sizes: 9:16 1080×1920, 1:1 1080×1080, 4:5 1080×1350, 16:9 1920×1080 (preview: half). Framing: Smart crop
(around the director's focus point), Center crop, Fit with background (whole frame on a blurred copy: nothing cut),
Product focus (tighter, ×1.15), Manual (team's focus and zoom). Proportions are always kept (scale with
`force_original_aspect_ratio`, then crop or pad; never stretched). Module 2 gives composition as text only, not object
coordinates: when the source shape differs a lot from the output and the composition gives no position, the crop is
flagged "check the framing". Safe areas for captions are stored for Module 7.

## Quality control

Measured (blocking if wrong): file decodes, video stream, size, frame rate, duration and frame count (±3 frames,
`VD_FRAME_TOLERANCE`), H.264/yuv420p, exactly one audio track when audio is on (none when off), audio = video length (no
drift), voice-over not cut, black frames not planned by a fade, true peak (clipping). Measured warnings: short dark
moments, long frozen pictures, silence while the voice should speak, peak above −1 dBTP. Review hints (from analysis, not
measurements): repeated scenes, product not visible, uncertain framing, low resolution, watermarks, text in the footage,
speed changes, holds. The AI's own remarks are labelled "AI estimate". No quality score or performance promise is made.
Watermarks are reported, never removed.

## Jobs

Statuses: Draft, Queued, Validating Inputs, Preparing Editing Plan, Resolving Footage, Preparing Video Assets, Preparing
Audio Assets, Building Timeline, Rendering, Quality Checking, Uploading Output, Ready for Review, Approved, Failed, Cancelled.
Progress = real stages + clip count + FFmpeg's own clock. One job per edit (a second click returns the same job), global
limit `VD_CONCURRENCY` (1), cancel kills FFmpeg, temporary errors retried once automatically, **Retry** for failed jobs
(prepared clips are reused from the cache), time limit `VD_RENDER_TIMEOUT` (30 min),
a disk check (the render's estimated need + `VD_MIN_FREE_MB`), an isolated temporary folder per job deleted after success, failure or cancel, leftovers removed at start, running jobs
re-queued after a restart. Usage per render: wall time, output size, temporary size, clips reused, server memory.

## Database (new tables only)

`vd_edits`, `vd_versions`, `vd_clips`, `vd_renders`, `vd_clip_cache`, `vd_jobs`, `vd_approvals`, `vd_usage`.
Files: `video/p{project}/e{edit}/r{render}-{quality}.mp4` and `.jpg`, clip cache `video/cache/p{project}/…`. Originals
are never changed or copied. Files are served only by the server to signed-in users (as for Modules 2 and 5).

## API (behind sign-in)

`GET /api/video/config`, `GET /api/video/schemas`, `GET /api/creative-projects/:id/video`, `POST …/video/open`,
`POST …/video/generate`, `GET|PATCH /api/video-edits/:id`, `POST …/jobs` (kind full|plan|render, quality),
`POST …/retry`, `POST …/cancel`, `POST …/validate`, `POST …/versions`, `POST …/versions/:vid/restore`, `GET …/compare`,
`GET …/edl`, `POST …/approve` (render_id), `GET …/package`, `GET /api/video-renders/:id/video|thumb` (`?download=1`),
for Module 7: `GET /api/creative-projects/:id/video-package?variation=N`.

## Settings (Railway → Variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `VD_CONCURRENCY` | 1 | Renders at the same time (keep 1 unless the server has 4+ CPUs). |
| `VD_FF_THREADS` | 2 | CPU threads per FFmpeg command. |
| `VD_RENDER_TIMEOUT` | 1800 | Seconds before a job is stopped. |
| `VD_MIN_FREE_MB` | 100 | Disk always kept free, on top of what each render needs (about 5× its output size). |
| `VD_FPS` | 30 | Output frame rate (24, 25, 30 or 60). |
| `VD_PREVIEW_CRF`, `VD_STANDARD_CRF`, `VD_HIGH_CRF` | 28, 21, 18 | Quality (lower = better and bigger). |
| `VD_PREVIEW_PRESET`, `VD_STANDARD_PRESET`, `VD_HIGH_PRESET` | veryfast, medium, slow | Encoding speed. |
| `VD_SLOW_SHOT`, `VD_BALANCED_SHOT`, `VD_DYNAMIC_SHOT`, `VD_FAST_SHOT` | 4, 2.8, 2, 1.4 | Ideal shot length per pace. |
| `VD_MAX_HOLD`, `VD_MAX_SCENE_USES`, `VD_TRANSITION` | 0.6, 2, 0.4 | Freeze limit, repetition warning, transition length. |
| `VD_SPEED_MIN`, `VD_SPEED_MAX` | 0.85, 1.15 | Allowed playback speed. |
| `VD_FRAME_TOLERANCE` | 3 | Frames of tolerance in the quality check. |
| `VD_WORKER` | (on) | `0` = this instance does not render. |

## Railway

Rendering runs in the same Railway service as the website, in a background loop (never inside a web request), because
the database (SQLite) and the files live on that service's volume and a Railway volume cannot be shared with a second
service. CPU only, no GPU needed. Recommended service size: **2 vCPU and 2 GB RAM** at least (FFmpeg uses roughly
300-700 MB for a 1080×1920 render with 2 threads). Temporary disk: about 50-300 MB per render (on the volume, `/data/tmp`,
cleaned after each job). Persistent storage: the volume (or S3 if configured), about 1-2 MB per preview, 5-15 MB per
Standard/High render of 15-30 s, plus the clip cache. No new variable is required.

## Measured performance (this development PC, 15 s 9:16 ad, 8 clips, test footage)

| Render | Time | Size |
|---|---|---|
| Preview 540×960, first time (plan + 8 clips + audio + QC) | 3.1-3.8 s | 1.1 MB |
| Preview after changing one clip (7 clips from the cache) | 1.7 s | 1.1 MB |
| Standard 1080×1920 | 14.4 s | 7.6 MB |

Real footage is heavier than test patterns: expect a few times longer on Railway's shared CPUs.

## Tests (`npm test`: 46 passing, 9 for this module)

Real footage generated with FFmpeg (1080×1920 H.264 30 fps **with a sound track**, 1280×720 MPEG-4 25 fps **with a sound
track**, 640×640 variable frame rate), the real chain of Modules 3-5 in test mode (fake ElevenLabs, test-mode AI):
one-button run and EDL schema; frames contiguous and equal to the audio; sources inside scenes; clips start at the real
speech; several clips for one segment; real MP4 checked (540×960, 30 fps, H.264/AAC, one audio track, duration, frames,
thumbnail); no ElevenLabs call; second click = same job; same timeline = render reused; replace/trim/length/order rules;
crossfade keeps the length; music level re-mix without regeneration; originals with sound render with **no sound** when
audio is off; 16:9 from vertical at 1920×1080 with fit-with-background; corrupted and truncated files caught; too-long
holds blocking; missing source file → clear failure; upload failure → automatic retry succeeds; disk guard; cancel and
cleanup; crash leftovers removed; preview approval refused, Standard approved, package for Module 7; edit after approval →
new draft; new audio approval → edit outdated. Browser check on a temporary copy: generate, play, playhead, clip edit,
updated render, Standard render, approval (all temporary data deleted afterwards).

Not tested: High quality to the end (cancelled in the test on purpose), real customer footage, Railway's own CPU speed,
a full disk for real (simulated with the limit), a true server crash in the middle of a render (simulated).

## Known limits

- Module 2 gives the product position as text, not coordinates: smart crops away from the centre come from the AI's
  reading of that text and are flagged for review when uncertain.
- Product images with motion (as filler) are not used: only video footage.
- The clip cache is not pruned automatically yet (it is small: previews ~100-300 KB per clip).
- Waveform is shown for the voice-over only.
- Captions, text overlays, effects, final export workflow and bulk generation are Modules 7-9.

## Editing quality update (2026-11-26)

Targeted improvements after reviewing the first creatives. Module 6 was not rebuilt; no script, voice-over or music is
regenerated.

**New file** `server/video-select.js` (scene choice), changes in `video-edl.js` (cutting, cropping), `video-director.js`
(prompt `vd-v2`), `video-production.js` (checks, undo), `video-jobs.js`, `video-routes.js`, `video-schemas.js`,
Module 2 `footage-ai.js` / `footage.js` (analysis `scene-v2`), `public/app.js`, `public/style.css`.

### What changed

- **Scene choice ("Improve automatically", default; "Follow the storyboard scenes exactly" in Advanced settings).**
  Every storyboard shot is scored: same idea as the approved scene (categories + words of the description and spoken
  line), role fit (opening, body, closing), picture quality, angle relevance, clean footage, variety. The approved scene
  wins ties. A *weak* approved scene (packaging the hook does not talk about, footage with text/graphics/watermark,
  product not visible, a closing too weak or too short) may be replaced by any clean scene that fits the role. A swap
  never brings footage that is less clean. Every swap is listed on the page with its reason and a **Keep storyboard
  scene** button (it puts the approved scene back and locks the clip). Locked clips are never changed.
- **Opening**: product close-ups, attractive product shots, clear demonstrations, movement, high quality and product
  visible score higher; packaging/unboxing is penalised unless the hook mentions the box.
- **Closing**: attractive showcase, close-up, product in use, stable picture with space (composition notes), clean
  footage; the closing clip is the strongest one and lasts at least 2.5 s when possible; it is marked in the EDL
  (`closing`, CTA zone) for Module 7.
- **Variety**: look-alike detection from Module 2's picture fingerprints (duplicates / similar scenes, Hamming distance)
  plus continuous parts of one shot; penalties for repeating a scene, for look-alikes nearby (also against the next
  shot), for the same source video twice in a row and the same camera style; used source intervals are tracked so the
  same frames are never shown twice.
- **Rhythm**: dynamic ≈ 1.5-3 s per shot (ideal 2.2), fast 0.9-2.2, balanced 1.5-4.2, slow 2-6; demonstrations may run
  up to 40 % longer. Long spoken segments get several clips (other relevant angles first, then other parts of the same
  scene, with variable lengths when needed). **Cuts are placed between spoken words** (word timing of the voice-over).
- **Clean footage**: classes *clean*, *embedded text* (captions, promo text), *graphic overlays* (arrows, emojis,
  stickers, banners), *needs manual review* (watermark). Module 2's analysis now also detects added captions, promo text,
  arrows/stickers and graphics separately, and the product position. Scenes analysed before keep working from their
  on-screen text (emoji/arrow and promo words detected) and the page offers **Re-analyse them** (AI, one analysis per
  scene). Clean footage is preferred everywhere; if more than 30 % of the clips are not clean, the page recommends
  uploading clean, authorized footage. Watermarks are never removed.
- **Cropping**: with a product position, the crop is placed so the whole product (and the hand using it) stays in, a
  small product can be shown closer, a product wider than the crop keeps the whole frame on a blurred background;
  without a position, people or wide actions keep the whole frame and other crops are centred and flagged for review.
  The framing basis is shown per clip; manual framing still wins.
- **Quality**: labels now say *Preview (review only)* 540×960 / 540×540 / 540×675 / 960×540 and *Production*
  1080×1920 / 1080×1080 / 1080×1350 / 1920×1080 (*Production High* = same size, better encoding). Production reads the
  original picture when the silent copy is smaller. Clips enlarged more than 1.25× are flagged ("enlarging adds no
  detail").
- **Duration**: blocking check that the timeline equals the approved audio length (Module 5 duration rules), and that
  the voice ends at least 0.3 s before the end (CTA not cut); a warning explains when the video is longer than the
  target because the real voice-over needed it. Output duration is still measured after rendering.

### Before / after (measured)

Same approved script, voice-over and music (20 s, 9:16, dynamic), test footage reproducing the reported problems
(storyboard opening on a packaging box, look-alike close-ups from one video, re-posted promo footage with captions,
emojis and arrows, a watermarked clip at the end). "Before" = the previous engine (exact copy of the deployed version),
"after" = this version. Test-mode AI; real FFmpeg renders.

| | Before | After |
|---|---|---|
| Render | **failed**: closing shot 4 s for a 9.8 s CTA moment (5 s frozen frame) | 20.000 s, 600/600 frames, quality check passed |
| Opening | packaging box (clean but weak) | hand closing the clasp, close-up (clean, product visible) |
| Closing | watermarked promo clip, 9.8 s | clean lifestyle shot, 2.5 s, after 3 other relevant angles |
| Clips with captions/graphics/watermark | 3 of 7 | 1 of 11 (no clean alternative for that line: warning shown) |
| Look-alike clips side by side | 1 | 0 |
| Same frames shown twice | 1 | 0 |
| Shot lengths | 1.5-9.8 s | 1.4-2.5 s (9 of 10 body shots 1.5-3 s) |
| Cuts inside a spoken word | 0 of 6 | 0 of 10 |
| Crops placed on the product position | 0 | 8 (2 wide shots kept whole on a blurred background, 0 uncertain) |
| Clip start vs real speech | ≤ 0.013 s | ≤ 0.013 s |
| Render time (preview) | — | 5-7 s |

The real luxury watch creatives on Railway were not re-rendered from here (no access to the production server):
open them in step 9 after this update and click **↻ Regenerate timeline**, then **Render preview**.

## Final refinements before Module 7 (2026-11-26)

- **Stronger repetition penalties**: reusing a scene −1.0 nearby / −0.6 further away (was −0.6 / −0.35); look-alikes
  (duplicate/similar picture fingerprint, same action filmed again in the same video) −1.3 × similarity nearby / −0.7
  further away (was −0.6 / −0.3); look-alike of the next storyboard shot −1.0 (was −0.5). Two neighbouring scenes of one
  video count only 0.25 (a scene cut usually means a new shot).
- **Clean footage only when there is enough**: if the clean scenes (no captions, promo text, emojis, stickers, graphics
  or watermarks; product visible) cover the whole video and there are at least 5 of them (or one per shot), footage with
  overlays is not used at all, also not as an extra angle; storyboard scenes with overlays are replaced by the same idea
  when possible, otherwise by the clean scene that fits best, and the swap is listed. With too little clean footage the
  previous behaviour stays (cleanest first, warning to upload clean footage).
- **Closing**: clean product close-up or showcase first (lifestyle/people scenes score lower), stable picture, room
  for text; the closing clip is still the last and lasts at least 2.5 s.
- **Room for Module 7 text** in the opening and the closing: scenes with free space above/below the product score higher
  (from the product position, or the composition notes); their crops do not zoom in and place the product slightly above
  the middle (centre at 42 % of the height) when it still fits whole. The free room is stored on those clips
  (`overlay_room`) and shown on the page.
- **Exact aspect ratios**: sizes are `a×k` by `b×k` with the reduced ratio a:b and an even k: preview 9:16 540×960, 1:1
  540×540, **4:5 544×680** (was 540×676), 16:9 960×540; production 1080×1920, 1080×1080, 1080×1350, 1920×1080.

Same luxury-watch test case (20 s), previous update → now: clips with overlays 1 of 11 → **0 of 10**; closing
lifestyle dinner shot → **clean side-view showcase on a plain background**; look-alike neighbours 0 → 0; same frames
twice 0 → 0; shots 1.4-2.5 s → 1.5-2.5 s; 20.000 s rendered, 600/600 frames, quality check passed, cuts between words
0/9 inside a word. Scenes are reused (different frames) because only 6 clean scenes exist for 10 clips.
