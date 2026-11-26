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
