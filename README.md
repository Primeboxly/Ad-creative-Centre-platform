# Ad creative Centre

The team's platform for COD video ads: one collection per product → upload the footage → tag each clip as **Hook**, **Body** or **CTA** → tick clips → the platform builds every hook × body × CTA combination as a ready-to-post vertical video (1080×1920, MP4). Claude writes the scripts (hook + body + CTA + post text + headline) in **English, Swahili and French**.

## Run on your PC

```
npm install
npm start          # http://localhost:3100
```

The first visit asks you to create the admin account. The admin adds the team in **Team**.

AI scripts need an Anthropic API key. Start the server with it:

```
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start
```

Without a key everything works except the **Generate** button (scripts can still be added by hand).

## What is where

| Page | What it does |
|---|---|
| Products | One card per product: number of hooks / bodies / CTAs, scripts, videos, winners |
| Product → Footage → Auto-split | Drop whole videos (your TikTok downloads). Each is cut by itself: first ~3 s → Hook, middle → Body, last ~3 s → CTA, moved onto a scene change when one is near (hook ends between 1.5 and 4 s, CTA starts 2 to 5 s before the end). Videos under 7 s give a hook + body only |
| Product → Footage | Three lanes (Hook, Body, CTA). Drop videos in a lane (mp4, mov, webm…, up to 500 MB each). Rename a clip, move it to another lane, delete it. Tick clips, then **Build N videos** at the bottom |
| Product → Scripts | **Generate** scripts with AI (language, how many, extra instructions) or add one by hand. Copy button for the editor / voice-over |
| Product → Creatives | The finished videos: play, rename, download, mark **Draft / Testing / Winner / Loser**, filter by status |
| Build bar (Footage) | Choose a **script** (one, or all scripts of a language: each is read over every clip combination), an ElevenLabs **voice**, **music** (none, one track, or a random track per video) and **captions**. With a voice, each part lasts as long as its words (the clip loops if needed) and the clips own sound is left out |
| ✨ Make music (Build bar, Music page) | ElevenLabs makes instrumental tracks (no voice, cleared for ads) from a short description. Made from the Build bar they belong to the product: **✨ AI music of this product** gives each video one of them. The TikTok sound is never put under a voice-over (it has the creator speaking) |
| Music | Shared music library: upload music, or a video to keep only its sound; listen, rename, delete. Auto-split adds each video's own sound here by itself (🎬). In the Build bar, **🎬 Music of the TikTok video** gives every ad the sound of the video its body clip (else hook, else CTA) was cut from; clips without a saved sound keep their own sound quietly under the voice. Under a voice the music plays at 13 %, under clip sound at 35 % |
| Team (admin) | Add members, change role, reset password, disable an account |

The **notes** under the product name (benefits, who buys it, price, offer) are what the AI works from: fill them in before generating. The line under them is the **CTA banner** written on top of the CTA part (empty = "PAY ON DELIVERY" in the script language).

Captions: the script words appear in groups of up to 4, timed over each part, emojis removed (they are not read aloud either).

Every part of a video is fitted into 9:16 (black bars when the clip is landscape or square) at 30 fps; a clip without sound gets silence. Videos are made one at a time in the background; the Creatives tab updates by itself.

## Online (Railway, like Primeboxly)

Railway builds the `Dockerfile`. On the service:

- **Volume** mounted at `/data`: the database **and all the videos** live there.
- Variables: `ANTHROPIC_API_KEY` (AI scripts), `ELEVENLABS_API_KEY` (voice-over; the key needs Text to Speech and Voices read access), and on the first start `ADMIN_EMAIL` + `ADMIN_PASSWORD` to create the admin (or create it on the first visit).
- `GET /healthz` → `{"ok":true}`.

Other settings: `PORT` (default 3100), `ACC_DATA` (data folder, default `./data`), `ACC_MODEL` (default `claude-opus-5-5`), `ELEVENLABS_MODEL` (default `eleven_v3`: English, French and Swahili), `ACC_FONT` (caption font file).

Each voice-over (voice + text) is made once and kept in `/data/voice`, so rebuilding with the same script does not use ElevenLabs characters again.

## Footage from TikTok

Download the videos you want to reuse, then drop them in the right lane. Videos taken from other people's accounts can get your ads rejected or reported for copyright: prefer your own phone footage, supplier videos, or UGC you paid for.

## Tests

```
npm test           # cutting, captions, and real ffmpeg renders (clips only, and voice + captions + banner + music)
```

`docs/written-creatives/` holds the scripts written by hand earlier (batch 1, 5 products).
