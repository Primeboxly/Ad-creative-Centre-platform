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
| Team (admin) | Add members, change role, reset password, disable an account |

The **notes** under the product name (benefits, who buys it, price, offer) are what the AI works from: fill them in before generating.

Every part of a video is fitted into 9:16 (black bars when the clip is landscape or square) at 30 fps; a clip without sound gets silence. Videos are made one at a time in the background; the Creatives tab updates by itself.

## Online (Railway, like Primeboxly)

Railway builds the `Dockerfile`. On the service:

- **Volume** mounted at `/data`: the database **and all the videos** live there.
- Variables: `ANTHROPIC_API_KEY` (AI scripts), and on the first start `ADMIN_EMAIL` + `ADMIN_PASSWORD` to create the admin (or create it on the first visit).
- `GET /healthz` → `{"ok":true}`.

Other settings: `PORT` (default 3100), `ACC_DATA` (data folder, default `./data`), `ACC_MODEL` (default `claude-opus-5-5`).

## Footage from TikTok

Download the videos you want to reuse, then drop them in the right lane. Videos taken from other people's accounts can get your ads rejected or reported for copyright: prefer your own phone footage, supplier videos, or UGC you paid for.

## Tests

```
npm test           # builds a real hook + body + CTA video with ffmpeg and checks it
```

`docs/written-creatives/` holds the scripts written by hand earlier (batch 1, 5 products).
