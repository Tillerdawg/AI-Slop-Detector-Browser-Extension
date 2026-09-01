# AI Slop Detector for YouTube

I built this because I kept clicking into YouTube videos that turned out to
be a soulless TTS voiceover pasted over stock footage, wrapped in a
clickbait title. This extension looks at a video's public metadata and
gives you a heads-up before you click, for Chrome and Firefox.

Everything happens locally in your browser. No server, no account, no data
leaving your machine beyond the two requests described under Privacy below.
It just reads what's already on YouTube's page, plus, if you let it, the
channel's public RSS feed for a fuller picture.

## What it actually detects (and what it doesn't)

There's no audio or video analysis here. A browser extension can't listen
to every video's soundtrack in real time, so instead it weighs a handful of
metadata signals against each other:

- **YouTube's own "altered or synthetic content" disclosure**, when a
  creator has self-labeled a video. The strongest signal, when it's there.
- **Upload cadence.** Channels pumping out many videos a day, pulled from
  the channel's public RSS feed (or the YouTube Data API if you add a key).
- **Channel age vs. output volume.** A young channel putting out an
  unusual amount of content (Data API only).
- **Title patterns.** Clickbait phrasing, content-mill titling, ALL-CAPS
  spam.
- **Description patterns.** AI-tool boilerplate, stock-footage credits,
  a suspiciously thin description on a long video.
- **Template uniformity** across a channel's recent upload titles.

Every one of these signals is optional. If there isn't enough data to check
one, it's simply left out of the weighting rather than counted as a strike
against the video. Under the hood, all this produces a 0-100 likelihood
score, but you never actually see that number. It's only there to sort the
video into one of four bands: 🛑 Likely AI-Generated, ⚠️ Likely
AI-Assisted, ❓ Mixed/Uncertain, or ✅ Likely Human-Made. What you actually
see is that label plus a plain-English list of reasons behind it, things
like "Title uses clickbait / content-mill phrasing," or, on the flip side,
"Description doesn't reference AI-generation tools or stock-footage
sources." No raw number, no confidence percentage. Take it as a strong
hint, not a verdict.

## Install (development / unpacked)

```
npm run build:all   # generates icons + builds dist/chrome and dist/firefox
```

Icon generation needs Python 3 and Pillow (`pip3 install pillow`, or `pip
install pillow` on Windows). It runs through `build/run-python.js`, which
tries `python3` first and falls back to `python`, so it works either way.
The PNGs are already checked into `icons/`, so you'll only need this if
you're changing the icon design.

**Chrome / Edge / Brave:**
1. Go to `chrome://extensions` and turn on "Developer mode".
2. Click "Load unpacked" and pick `dist/chrome`.

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on" and pick any file inside `dist/firefox`
   (`manifest.json` works fine). Temporary add-ons disappear when Firefox
   restarts; for something that sticks around, you'd sign it through
   [addons.mozilla.org](https://addons.mozilla.org).

On Windows, `npm run build` also zips each build into `dist/chrome.zip` and
`dist/firefox.zip` via PowerShell, which will come in handy for a store
submission later.

## Using it

On a **watch page**, a card shows up near the title with the video's label
(say, "✅ Likely Human-Made"), a "Why?" toggle that lists the reasons for
it, and two buttons to manually mark that video as human-made or AI slop.
Your own call always overrides the heuristic, and it only applies to that
one video, not the whole channel.

Scroll through a feed or search results and small badges appear on
**thumbnails** once they scroll into view. Hover one for the same label and
reasons. You'll see an instant, title-only guess first, which upgrades once
the fuller check (channel upload cadence, etc.) comes back.

Click the icon on a watch page for the **toolbar popup**, which shows the
same label and reasons plus a few quick on/off toggles.

The **options page** (right-click the icon → Options, or "More settings…"
from the popup) has per-surface toggles, a sensitivity dial
(lenient/balanced/strict), a spot for your own YouTube Data API key, your
list of video overrides, and a button to clear the cache.

## Project structure

```
src/
  lib/         shared code: constants, the scoring engine, storage, RSS/Data API fetchers
  background/  MV3 service worker (Chrome) / background page (Firefox), handles network fetching
  content/     injected into youtube.com, reads page data and renders badges/panel
  popup/       toolbar popup
  options/     settings page
build/build.js generates dist/chrome and dist/firefox from src/ plus per-browser manifest bits
icons/generate_icons.py  regenerates icons/*.png
test/heuristics.test.js  Node-runnable unit tests for the scoring engine
backend/       scaffold for a community-ratings service, not wired up yet -- see backend/README.md
```

The scoring engine (`src/lib/heuristics.js`) is pure and side-effect-free.
It just takes a plain data object and hands back a result, so it's reused
as-is for the instant title-only pass, the fuller network-backed pass, and
could be lifted server-side later without touching the logic.

## Development

```
npm run lint    # node --check every src/*.js file
npm test        # scoring-engine unit tests
npm run build   # rebuild dist/ after any src/ change
```

After editing anything in `src/`, run `npm run build` and hit reload on the
extension in `chrome://extensions` or `about:debugging`.

## Privacy

The full policy (for the Chrome Web Store / Firefox AMO listings, or
anyone curious) is at
[claude.ai/code/artifact/485476ad-2f8e-4c41-a9bd-7da88fe9c66e](https://claude.ai/code/artifact/485476ad-2f8e-4c41-a9bd-7da88fe9c66e).
The short version: no telemetry, no accounts. Here's every network request
this extension makes:
- `GET https://www.youtube.com/feeds/videos.xml?channel_id=...` for upload
  cadence, throttled and cached for 24 hours per channel.
- `GET https://www.googleapis.com/youtube/v3/...`, and only if you've
  pasted your own API key into Settings.
- If you've configured a community-ratings backend URL in Settings:
  `GET <your backend URL>/score/:videoId` and
  `POST <your backend URL>/vote` — both opt-in, off by default, and only
  ever sent to the URL you typed in yourself.

## Known limitations (the honest version)

There's no audio analysis, so a well-produced AI voiceover on a varied,
non-templated channel can still slip through. This catches patterns, not
the voice itself.

Thumbnail scanning can't always pull a channel ID out of the DOM (newer
`/@handle` URLs don't expose it directly), so some thumbnails only get the
instant title-only pass instead of the fuller channel-cadence check. The
watch page always gets the full check, since a channel ID is always present
there.

YouTube's page structure shifts periodically, so the disclosure detector
and DOM selectors in `constants.js` and `scanner.js` are written
defensively, with multiple candidate matches and a graceful fallback to
"unknown." They'll probably still need occasional updates.

At the end of the day, this is a heuristic aid for your own judgment, not a
fact-checker.

## Community ratings

Optional and off by default. Point Settings → Community ratings at a
deployed backend (see `backend/README.md`) to enable SponsorBlock-style
voting: with a backend URL configured, vote 👍 human / 🤖 AI on
individual videos directly from the watch-page panel — no sign-in and no
verification step. Community votes blend into the shown score, weighted
by vote count, and are shown alongside the local heuristic's own reasons
-- never replacing your own manual trust/flag override.

## License

[MIT](LICENSE)
