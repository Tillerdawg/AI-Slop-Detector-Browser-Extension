# AI Slop Detector for YouTube

A Chrome + Firefox extension that estimates whether a YouTube video is likely
AI-generated (soulless TTS voiceover over stock footage, content-mill
titles) and shows a rating **before you click**.

Everything runs locally in your browser. There's no server and no account —
scores come from a heuristic engine reading public metadata YouTube's own
page already contains, plus (optionally) its public per-channel RSS feed.

## What it actually detects (and what it doesn't)

There is no audio/video analysis here — a browser extension can't cheaply
listen to every video's soundtrack in real time. Instead it combines several
weighted signals from metadata:

- **YouTube's own "altered or synthetic content" disclosure**, when a
  creator has self-labeled a video (strongest signal, when present).
- **Upload cadence** — channels pumping out many videos/day, fetched from
  the channel's public RSS feed (or the YouTube Data API if you add a key).
- **Channel age vs. output volume** — young channels with unusually high
  output (Data API only).
- **Title patterns** — clickbait/content-mill phrasing, ALL-CAPS spam.
- **Description patterns** — AI-tool boilerplate, stock-footage credits,
  thin descriptions on long videos with no chapters.
- **Template uniformity** across a channel's recent upload titles.

Each signal is optional — if data for it isn't available, it's simply left
out of the weighted average rather than assumed to be zero. The result is a
0–100 score, a confidence level, and a plain-English list of reasons, not a
verdict of fact. Treat it as a strong hint, not a certainty.

## Install (development / unpacked)

```
npm run build:all   # generates icons + builds dist/chrome and dist/firefox
```

(`npm run icons` needs Python 3 + Pillow: `pip3 install pillow` (or `pip
install pillow` on Windows). It runs via `build/run-python.js`, which tries
`python3` then falls back to `python`, so it works whichever your platform
provides. The PNGs are already checked into `icons/`, so you only need to
re-run this if you change the icon design.)

**Chrome / Edge / Brave:**
1. Go to `chrome://extensions`, enable "Developer mode".
2. "Load unpacked" → select `dist/chrome`.

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on" → select any file inside `dist/firefox` (e.g. `manifest.json`).
   (Temporary add-ons are removed when Firefox restarts; for a persistent
   install you'd sign it via [addons.mozilla.org](https://addons.mozilla.org).)

`dist/chrome.zip` / `dist/firefox.zip` are also produced (Windows only, via
PowerShell `Compress-Archive`) — handy for store-upload flows later.

## Using it

- **Watch page**: a card appears near the title with the rating, a "Why?"
  breakdown, and buttons to manually mark that *channel* as trusted or
  flagged (your own local override, always wins over the heuristic).
- **Thumbnails** (home/search/recommended): a small badge appears in the
  corner once scrolled into view; hover it for the breakdown. An instant
  title-only estimate shows first, then upgrades once the fuller check
  (channel cadence, etc.) resolves.
- **Toolbar popup**: click the icon on a watch page for the same rating, plus
  quick on/off toggles.
- **Options page** (right-click icon → Options, or "More settings…" in the
  popup): per-surface toggles, sensitivity (lenient/balanced/strict),
  optional YouTube Data API key, channel override list, and a cache clearer.

## Project structure

```
src/
  lib/         shared code (constants, scoring engine, storage, RSS/Data API fetchers)
  background/  MV3 service worker (Chrome) / background page (Firefox) — does the network fetching
  content/     injected into youtube.com — reads page data, renders badges/panel
  popup/       toolbar popup
  options/     settings page
build/build.js generates dist/chrome and dist/firefox from src/ + per-browser manifest bits
icons/generate_icons.py  regenerates icons/*.png
test/heuristics.test.js  Node-runnable unit tests for the scoring engine
backend/       scaffold for the (not yet wired up) community-ratings service — see backend/README.md
```

The scoring engine (`src/lib/heuristics.js`) is pure and side-effect-free —
it takes a plain data object and returns a score, so it's reused identically
for the instant title-only pass and the fuller network-backed pass, and could
be reused server-side later without changes.

## Development

```
npm run lint    # node --check every src/*.js file
npm test        # scoring-engine unit tests
npm run build   # rebuild dist/ after any src/ change
```

After editing `src/`, re-run `npm run build` and click the reload icon on
`chrome://extensions` / `about:debugging` for the loaded extension.

## Privacy

No telemetry, no accounts. Network requests this extension makes:
- `GET https://www.youtube.com/feeds/videos.xml?channel_id=...` (upload
  cadence; throttled + cached 24h/channel).
- `GET https://www.googleapis.com/youtube/v3/...` — **only** if you paste in
  your own API key in Settings.

## Known limitations / honest caveats

- No audio analysis, so a well-produced AI voiceover with a varied,
  non-templated channel can still slip through — this catches *patterns*,
  not the voice itself.
- Thumbnail scanning can't always resolve a channel ID from the DOM (new
  `/@handle` URLs don't expose it directly), so some thumbnails only get the
  instant title-only pass rather than the fuller channel-cadence check. The
  watch page always gets the full check (channel ID is always present there).
- YouTube's internal page structure changes periodically; the disclosure
  detector and DOM selectors in `constants.js` / `scanner.js` are written
  defensively (multiple candidate matches, graceful fallback to "unknown")
  but may need occasional updates.
- This is a heuristic aid for your own judgment, not a fact-checker.

## Roadmap: community ratings

`backend/` has a scaffold (Cloudflare Worker + D1) for an optional future
layer where users vote on videos SponsorBlock-style, aggregated and shown
alongside the local heuristic score. It's **not deployed or wired into the
extension** — see `backend/README.md` for what's there and what's left to do.
