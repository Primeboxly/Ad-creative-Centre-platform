# Module 7: AI Captions & Visual Effects

Step 10 of a creative project (**✨ Visual studio**). It takes the **approved video edit** of Module 6 and adds animated captions, hook text, benefit overlays, price / offer / CTA graphics, effects and optional branding. The output is a **real MP4**.

## How it works

1. **Inputs (nothing typed again).** The Module 6 approval package holds the EDL, the render and the audio layers. Modules 3-5 add the brief, the production plan and the audio package (word timing, voice-over, music, mix). Every plan records the versions it was made from: brief, script, storyboard, audio package, video version and EDL hash. A plan made from other versions is blocked (`outdated`).
2. **AI Visual Director** (`server/vx-director.js`, one Claude call, cached by its inputs). It returns **decisions only**: style id, intensity, palette, caption grouping, keywords, hook text and template, benefit overlays, price / offer / CTA templates and effects, each from an allowlist.
   - Every text is checked against the script, storyboard texts, product information and brief.
   - Invented numbers, guarantees, free delivery, scarcity, reviews or rankings are dropped with a warning.
3. **Plan builder** (`server/vx-plan.js`, deterministic) builds the **Visual Enhancement Plan**:
   - **Captions** use the approved ElevenLabs word timestamps (`pkg.captions`). The written script words are matched to the spoken words, so "1,200 ZMW" is shown even though it is spoken as words, with the time of those spoken words. Nothing is transcribed and ElevenLabs is not called. If the timing was estimated, the plan says so and never calls it exact.
   - **Groups** follow the chosen mode: word, 2, 3, phrase (2-5), sentence or AI.
     - Groups break at sentence ends, pauses and segment changes.
     - Numbers stay with their currency, and the product name stays in one group.
     - Line width comes from the real width of the font and the safe zone.
   - **Keyword highlights** cover at most one span per group, limited by the intensity (12 % / 25 % / 35 % of groups). Prices and offers are always highlighted.
   - **Hook text** appears in the opening seconds, **benefit overlays** only during their segment, and the **CTA** from the spoken CTA to the end (at least 2 s).
   - **Price and offer** values come from the brief only. There is no crossed-out price, because the brief has no proven previous price.
   - **Placement:**
     - Each element is placed inside the platform safe zone.
     - The product box from Module 2 is mapped through the Module 6 crop, so text avoids the product.
     - Text blocks keep a gap between them.
     - Captions move for the moment a CTA or price graphic needs their place.
     - Footage that already has text (Module 2 detection) gets a panel behind the captions, benefit overlays are skipped there, and a warning is shown.
   - **Locked or edited** elements are kept by every rebuild and regeneration.
4. **Rendering** (`server/vx-ass.js`, `server/vx-render.js`). The plan becomes an **ASS subtitle script**, drawn by FFmpeg's **libass**:
   - fribidi + HarfBuzz shape Arabic and write it right to left
   - shapes are used for bands, accent lines and pointers
   - only allowlisted animations are used
   - the optional logo is added with FFmpeg `overlay`

   The approved EDL is rendered again by the Module 6 engine from the **cached clips**. The overlays are added in the **single final encode**, so a new overlay never re-encodes an already finished video. The footage's own sound never reaches the output.
5. **Quality control.** The Module 6 checks run first: size, fps, duration, frames, codec, a single approved audio track, voice not cut, black frames and loudness. Then a **measured visual check** draws the overlay script alone at 5 fps and reads it with `cropdetect`. It checks that:
   - each caption and overlay appears in its time window
   - text does not touch the frame edge
   - text stays inside the safe zone
   - libass found every requested font and every character
6. **Approval** of a Production render creates the **package for Module 8**: EDL, visual plan, timeline tracks, audio layers, render and ASS references, output, QC and approval. `GET /api/creative-projects/:id/enhanced-package`.

## Caption styles

The registry is in `server/vx-registry.js`. Team presets are stored in the `vx_caption_styles` table.

| id | Look |
|---|---|
| hormozi | Montserrat Black, uppercase, yellow highlight with scale, pop-in, 1-3 words |
| modern_bold | Poppins ExtraBold, orange highlight, slide-up, phrases |
| karaoke | Poppins Bold, the spoken word lights up (one event per real word time) |
| minimal | Poppins Medium on a soft panel, fade, sentences |
| luxury | Playfair Display, ivory and gold, slow fades |
| dynamic_pop | Anton, uppercase, red highlight with scale, controlled bounce |
| social_ugc | Poppins SemiBold, dark text on a white panel |
| custom:N | Team preset, saved from the Caption studio |
| AI recommended | The Visual Director's choice |

**Animations:** static, fade, slide_up, slide_in, pop, bounce (controlled), scale_emphasis, word_reveal, karaoke, plus a slow 2-cycle pulse on the CTA. There are no flashes.

**Intensity:** Minimal, Balanced (default, `VX_DEFAULT_INTENSITY`), Dynamic, or AI recommended.

## Fonts and languages

The fonts are bundled in `server/fonts` under the SIL Open Font License, free for commercial use; the licences are in `server/fonts/licenses`:

- Montserrat
- Poppins
- Playfair Display
- Anton
- Cairo (Arabic and Latin)

Text in Arabic letters (Arabic, Moroccan Darija) automatically uses Cairo. Tested on real MP4s:

- English
- French accents (é, à, è)
- Arabic / Darija: joined letters, right to left, mixed with numbers and Latin, the highlight on the right word

Swahili and Kinyarwanda use the Latin fonts.

## Safe zones

Presets are kept for Instagram / Facebook Reels, Facebook / Instagram Feed, TikTok, YouTube Shorts, YouTube Ads and generic 9:16, 1:1, 4:5 and 16:9.

- **Meta Reels:** 14 % top, 35 % bottom, 6 % sides, as widely cited. This could not be confirmed on a Meta page, so the preset is marked "guide".
- **Other presets:** conservative approximations, also marked "guide".

Admins can update every preset (`PUT /api/safe-zones/:key`). The editor shows the guide over the preview; it is never in the video.

## Database (created automatically at start)

| Table | Content |
|---|---|
| `vx_projects` | One visual enhancement per approved video edit |
| `vx_versions` | Versions: director decisions, plan, settings, checks, frozen / approved |
| `vx_elements` | Timeline elements of each version, as rows |
| `vx_caption_words` | Caption words of each version |
| `vx_renders` | Renders |
| `vx_jobs` | Background jobs |
| `vx_approvals` | Approvals |
| `vx_usage` | Render time, size and memory |
| `vx_brand_kits` | Brand kits |
| `vx_caption_styles` | Team caption presets |
| `vx_safe_zones` | Admin updates to the safe-zone presets |

Templates (hook, benefit, price, CTA, effects) are versioned code registries.

## Settings (optional environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `VX_CONCURRENCY` | 1 | Visual renders at once |
| `VX_MAX_ATTEMPTS` | 2 | Automatic retries of temporary errors |
| `VX_RENDER_TIMEOUT` | 1800 | Seconds per job |
| `VX_DEFAULT_INTENSITY` | balanced | Default intensity |
| `VX_MIN_FONT`, `VX_MIN_CAPTION`, `VX_MAX_CAPTION`, `VX_MIN_OVERLAY`, `VX_CTA_MIN`, `VX_CTA_IDEAL` | see `vx-registry.js` | Readability limits |
| `VX_WORKER=0` | | Web-only instance |

No new paid service and no new npm dependency. The Docker image already has Debian's ffmpeg with libass, and the fonts are inside `server/`.

## Measured (this PC; Railway's CPU is slower)

On the luxury-watch test creative, 20 s at 9:16, with the 10 clips reused from the cache:

| Render | Size | Time | File |
|---|---|---|---|
| Preview | 540×960 | 2.6 s | |
| Production | 1080×1920 | 23.6 s | 8.3 MB |

Changing the style or colours makes no AI call and no ElevenLabs call.
