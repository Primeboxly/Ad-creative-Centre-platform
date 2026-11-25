# Module 5: AI Voice-over & Background Music (AI Audio Director)

Turns the **approved** script & storyboard of Module 4 into a synchronized audio package: an ElevenLabs voice-over with
real timing, background music (AI, library, upload or none), a measured mix, and a storyboard re-timed on the real speech.

## Where and how

Creative project → **step 8 "🎙 Audio studio"**.

1. Pick the approved script (one per planned video and script version).
2. Click **🎙 Generate Voiceover & Music**. In the background, without asking anything:
   audio plan → voice → voice-over → real timing → duration check → music → mix → storyboard sync → checks.
   It stops only on a blocking error, a missing capability (no key, no voice for the language), a much-too-long voice-over
   (a shorter script is proposed, never applied silently) or a change to approved content.
3. Listen, adjust if needed (voice, settings, one segment, music, trim and fades, mix), then **✅ Approve Audio Production**.

Sections on the page: summary, voice-over (player, per-segment play and regenerate, previous takes, lock, voice settings),
background music (mode, track, trim and fades, library, upload), final mix (player, measured loudness, advanced settings),
storyboard on the real speech (planned vs real times, shots to review, proposals), checks, pronunciation, versions, approval.

## Files

| File | Role |
|---|---|
| `server/eleven.js` | The only place that talks to ElevenLabs: account, models, voices (paged), text-to-speech with timestamps, music, pronunciation dictionaries, retries, clear errors, usage log. |
| `server/audio-director.js` | AI Audio Director (Claude): checked Audio Production Plan (voice character and settings, pronunciation notes, voice ranking, music mood/style/energy/tempo/prompt, mix preferences), and shorter-script proposals. |
| `server/audio-text.js` | Spoken text: prices, currencies, numbers, %, units, URLs written as words in English, French or Swahili; team pronunciation rules. The script itself never changes. |
| `server/audio-voice.js` | Voice and model choice, voice-over generation (long scripts in linked chunks), timing mapped to segment ids, segment regeneration, duration rules. |
| `server/audio-media.js` | ffmpeg / ffprobe: duration, loudness (EBU R128), waveform peaks, music trim/loop/fades, splice, mix. |
| `server/audio-production.js` | Productions, versions, music library, music preparation, mix, storyboard sync, checks, approval, Audio Production Package, caption timing. |
| `server/audio-jobs.js` | Background jobs (statuses below), cancel, automatic retry, retry from the failed stage, restart recovery. |
| `server/audio-routes.js` | API. |
| `tests/helpers/fake-elevenlabs.mjs` | Local stand-in for ElevenLabs (same paths and shapes) for tests: no key, no paid call. |

## ElevenLabs capabilities used (from the official API reference)

| Need | Endpoint | Notes |
|---|---|---|
| Voices on the account | `GET /v2/voices` (paged, 100 per page) | Name, labels (gender, age, accent, use case), description, preview link, **verified languages** with accent and locale. |
| Models | `GET /v1/models` | Languages per model, max characters per request, style / speaker-boost support, cost multiplier. Cached 6 h. |
| Speech with timing | `POST /v1/text-to-speech/{voice}/with-timestamps` | Audio + character start/end times. `previous_text` / `next_text` / `previous_request_ids` keep a natural flow across chunks and regenerated segments. |
| Music | `POST /v1/music` | Prompt, length 3 s–10 min, `force_instrumental`. Tries `EL_MUSIC_MODEL`, then music_v2_5, music_v2, music_v1. |
| Pronunciation dictionaries | `POST /v1/pronunciation-dictionaries/add-from-rules` | Only for **phoneme** rules (IPA / CMU). Alias rules are applied in the text. |
| Credits | `GET /v1/user/subscription` | Checked before generating; shown in `/api/audio/account`. |

**Not stated in the documentation, so not assumed:** exact setting ranges per model (speed is kept to 0.7–1.2 by default,
change with `EL_SPEED_MIN` / `EL_SPEED_MAX`), which models always return timestamps (if none come back, timing is
**estimated** and must be accepted before approval), and commercial terms (they depend on your ElevenLabs plan).
Voice availability is never invented: only voices listed on the account are used; nothing is cloned.

## Voice choice

Order: the team's manual choice → preferred voice for the market (`country:language`, set by an admin from the voice
library) → preferred voice for the creative type → AI ranking (only voices that exist on the account) → best language
match. Limitations are written down (e.g. "no Zambian accent listed: closest voice used"). Settings come from the plan,
the team or defaults, and are clamped to what the chosen model supports. Presets can be saved.

## Timing and duration

- ElevenLabs character times → words, sentences and every script segment id (in order). The file's duration is read with ffprobe.
- Source is recorded: `provider` (exact), `provider_partial` (one segment regenerated without timing), `estimated` (no timing returned: must be accepted).
- Duration (lead-in + speech vs target): **fits** (≤ +5 %) → kept; **slightly long** (≤ +20 %) → one regeneration at a slightly faster natural speed (can be turned off); **much too long** → a shorter script is proposed. It is sent to step 7 as a new draft only if you click it, and must be approved there. Audio is never cut.

## Music

Modes: ✨ AI (ElevenLabs Music, instrumental, prompt from the plan: no vocals, no artist or song names), 📚 library,
⬆ upload (you must confirm you own or licensed it), 🔇 none. If AI music fails (plan without music, error), a library
track with the same mood is used, else the video continues without music: a warning says so; nothing blocks.
The original file is always kept; the version used is trimmed or looped to the video length with fades.
Same prompt and length reuse the saved track (no new cost). Tracks can be renamed, marked favourite, filtered and deleted
when no audio version uses them. Licence and provenance are stored with each track.

## Mix

Voice and music levels are **measured** (EBU R128) and set: voice to −16 LUFS, music 12 LU under the voice (AI plan:
low / medium / high), music lowered while the voice speaks (side-chain ducking), fades, then the whole mix is measured
again and brought exactly to −14 LUFS with a true-peak limiter at −1.5 dBTP. A mix peaking above −0.5 dBTP is blocked.
The footage's own audio is never used. Voice, music and mix stay separate files.

## Storyboard synchronization

Each segment's window starts where its speech really starts (plus the lead-in). Its shots share the window in proportion
to their planned length, capped by each scene's real length. Shots that change by more than 30 % are marked **review**;
if footage is too short, a proposal is made (add an unused scene, or a visual hold). Nothing is replaced silently.
Checks: no gap or overlap, positive durations, scenes still usable, shots end with the audio.

## Statuses

Draft, Preparing Audio Plan, Selecting Voice, Generating Voiceover, Analyzing Voiceover Timing, Validating Duration,
Preparing Music, Generating Music, Mixing Audio, Synchronizing Storyboard, Ready for Review, Approved, Failed, Cancelled.
One job at a time per production; cancel stops ffmpeg too; temporary errors are retried; **Retry** restarts from the
failed stage only; after a server restart running jobs go back to the queue.

## Versions and approval

The newest unfrozen version is the working draft. Save, restore (as a new draft), compare (voice, settings, duration,
music, mix, timeline, with both voice-overs to listen to). Approval freezes the version and stores the package; any edit
after approval makes a new draft. If the script is changed and approved again in step 7, the old audio is marked
**outdated** and cannot be regenerated; the new script gets its own audio.

## Audio Production Package (hand-off to Modules 6-8)

`schema_version` 1.0 (schema: `GET /api/audio/package-schema`): production, project and planned video; brief, script,
storyboard and audio version ids; audio plan; voice (id, name, model, settings, source, limitations); voice-over (file,
duration, format, timing source, spoken text, segments with times); music (track, processed file, trim/loop/fades,
licence, provider); mix (file, settings, gains, measured loudness, lead-in); synchronized storyboard; final duration;
caption timing (words, sentences, segments on the final timeline, confidence); `original_footage_audio: "excluded"`;
checks; approval. Modules 6-8 read it with `GET /api/creative-projects/:id/audio-package?variation=N`, which also
re-checks that the files and scenes still exist.

## Database (new tables only)

`el_cache`, `el_voices`, `voice_favorites`, `voice_preferences`, `voice_presets`, `pronunciation_rules`, `music_assets`,
`au_productions`, `au_voiceovers`, `au_voice_segments`, `au_versions`, `au_jobs`, `au_approvals`, `audio_usage`.
Files: `audio/p{project}/prod{production}/…` (voice-overs, prepared music, mixes), `music/…` (library),
`audio/voice-previews/…`, `audio/samples/…`, on the volume or S3, always served by the server after sign-in.

## API (behind sign-in)

- `GET /api/audio/config`, `GET /api/audio/account`, `GET /api/audio/package-schema`
- Voices: `POST /api/audio/voices/sync`, `GET /api/audio/voices?q&language&gender&age&accent&use_case&favorites`, `POST /api/audio/voices/:id/favorite`, `PUT /api/audio/voice-preferences` (admin), `POST|DELETE /api/audio/voice-presets`, `GET /api/audio/voices/:id/preview`, `POST /api/audio/voices/:id/sample` (paid, max 200 characters, cached)
- Pronunciation: `GET|POST /api/audio/pronunciation`, `DELETE /api/audio/pronunciation/:id`
- Music: `GET /api/audio/music`, `POST /api/audio/music/upload`, `PATCH|DELETE /api/audio/music/:id`, `GET /api/audio/music/:id/file`
- Productions: `GET /api/creative-projects/:id/audio`, `POST …/audio/open`, `POST …/audio/generate`, `GET|PATCH /api/audio-productions/:id`, `POST …/jobs` (kind: full, plan, voice, voiceover, segment, music, mix, sync, shorten; `from` stage), `POST …/retry`, `POST …/cancel`, `POST …/validate`, `POST …/versions`, `POST …/versions/:vid/restore`, `GET …/compare`, `POST …/approve`, `GET …/package`, `GET …/captions`, `POST …/shorter/accept`, `GET …/media/voiceover|music|mix` (`?download=1`)
- For Modules 6-8: `GET /api/creative-projects/:id/audio-package?variation=N`

## Settings (Railway → Variables)

Required: **`ELEVENLABS_API_KEY`** (already there). All others are optional:

| Variable | Default | Meaning |
|---|---|---|
| `EL_TTS_MODEL` | automatic | Force a voice model (e.g. `eleven_multilingual_v2`) when it supports the language. |
| `EL_MUSIC_MODEL` | automatic | Force a music model. |
| `EL_SPEED_MIN` / `EL_SPEED_MAX` | 0.7 / 1.2 | Allowed speech speed. |
| `EL_MAX_RETRIES` | 3 | Retries on temporary ElevenLabs errors. |
| `AU_MAX_CHARS` | 0 (no limit) | Budget: refuse a voice-over longer than this many characters. |
| `AU_FIT_TOLERANCE` / `AU_LONG_TOLERANCE` | 0.05 / 0.2 | "Fits" and "slightly long" limits. |
| `AU_CTA_HOLD` | 1 | Seconds kept after the last word. |
| `AU_VOICE_LUFS`, `AU_MUSIC_REL_DB`, `AU_FINAL_LUFS`, `AU_TRUE_PEAK`, `AU_LEAD_IN` | −16, −12, −14, −1.5, 0.25 | Mix targets. |
| `AU_CONCURRENCY`, `AU_MAX_ATTEMPTS` | 1, 2 | Jobs at once, attempts per job. |
| `AU_MUSIC_MAX_MB` | 50 | Max upload size for music. |

## Manual steps (simple)

1. ElevenLabs → **Developers → API keys**: the key in `ELEVENLABS_API_KEY` needs these permissions:
   **Text to Speech**, **Voices (read)**, **Music Generation**, **User (read)** (for credits), and **Pronunciation
   Dictionaries (write)** only if you add phoneme rules. If a permission is missing, the page says which one.
2. Add the voices you want to use to your ElevenLabs account (Voice Library → "Add to my voices"), then click
   **↻ Refresh from ElevenLabs** in the voice picker. Only voices on the account can be used.
3. Music: AI music needs a plan that includes Music. Without it, the platform uses your library or continues without music.
4. Commercial use of generated voices and music follows **your ElevenLabs plan**; uploaded music must be yours or licensed.

## Costs

ElevenLabs bills **credits** (about one per character for speech, depending on the model; music by length, per your plan).
The platform logs real characters, music seconds and the provider's `character-cost` header per call (`audio_usage`),
shows them on the page, and never invents a price. Saving: same text + voice + settings reuse the saved voice-over;
same music prompt + length reuse the track; single-segment regeneration sends only that segment; voice lists, models and
previews are cached. The AI Audio Director (Claude) costs a few tenths of a cent per plan (cached by input).

## Tests

`npm test` → 37 tests (11 for this module), all with the fake ElevenLabs server and test-mode AI, real ffmpeg audio:
models by language (Swahili → v3 only), voice paging and language fit, wrong key message, speech text in en/fr/sw,
duration rules, full one-button run (timing mapped to segments, music licence, mix loudness and peak, sync contiguity),
cache reuse with no new paid call, segment regeneration, missing timing → estimated and must be accepted, AI music
refused → library fallback, mixing balance, package schema and approval, outdated after a new script approval, cancel,
music in use cannot be deleted. **Paid ElevenLabs calls during development: 0.** Browser check done on a temporary
copy with the fake server (deleted afterwards).

## Known limits

- Real ElevenLabs output (voice quality, actual timing, music) could not be heard here: no paid call was made. Listen to the first creatives.
- Number words are built for English, French and Swahili; other languages keep digits (ElevenLabs reads them itself).
- When the voice-over is much shorter than the target, the extra time goes to the final CTA screen; the page proposes an extra scene if the footage is too short.
- Previously deleted legacy audio code was not brought back; this is a new implementation.
