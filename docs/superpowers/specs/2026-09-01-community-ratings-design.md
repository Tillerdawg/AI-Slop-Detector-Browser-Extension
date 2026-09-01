# Community ratings (crowd-sourced votes) — design

Status: approved, ready for implementation planning
Date: 2026-09-01

## Summary

Wire up the `backend/` community-ratings scaffold (Cloudflare Worker + D1)
end-to-end: deploy it live, add human verification and moderation on top of
the existing crude rate limit, and integrate it into the extension so a
video's shown label blends the local heuristic score with community votes.

## Goals

- Let people vote 👍 human / 🤖 AI on a video from the watch-page panel.
- Blend community votes into the shown score/label, weighted by vote count,
  capped so a handful of votes can't flip a label alone.
- Gate voting behind one-time (well, monthly) human verification via
  Cloudflare Turnstile, done in an MV3-safe way.
- Give the operator (you) a way to suppress a brigaded video's community
  score without shelling into D1 by hand.
- Deploy the Worker for real, under your Cloudflare account.

## Non-goals

- No accounts/identity — votes stay anonymous, tied only to a random
  per-install `clientId`.
- No thumbnail-level voting UI (panel-only, per design discussion) — future
  work if it turns out to be wanted.
- No admin *UI* — moderation is a couple of authenticated HTTP endpoints,
  operated via curl or a simple script.

## Architecture

```
panel.js (vote buttons)
   -> background.js (message bus)
      -> Worker: POST /vote, GET /score/:videoId, POST /verify
         -> D1: votes, blocklist, rate_limit tables

options.js + sandbox iframe (Turnstile widget)
   -> background.js (VERIFY_TURNSTILE)
      -> Worker: POST /verify -> signed vote-token
```

Community score merges into the existing heuristic pipeline as a late
blending step in `background.js`, calling a new pure function in
`heuristics.js`. It does not touch the heuristic scorer's signal loop.

## Backend (Worker + D1)

### New/changed endpoints

- `POST /verify { turnstileToken, clientId }` — verifies against
  Cloudflare's siteverify API using a `TURNSTILE_SECRET_KEY` secret. On
  success, mints a stateless signed vote-token:
  `base64url(JSON{clientId, exp}) + '.' + HMAC-SHA256(...)`, signed with a
  new `VOTE_TOKEN_SECRET` secret. ~30-day expiry. No DB row — the signature
  is the proof, so verification stays cheap and stateless.
- `POST /vote` — unchanged body shape (`{videoId, channelId, vote,
  clientId}`), but now also requires a valid `x-vote-token` header
  (signature + expiry checked). The existing per-IP-hash rate limit stays
  as a second, cheap layer on top.
- `GET /score/:videoId` — checks the new `blocklist` table first; a
  blocklisted video returns `{ videoId, blocked: true, communityScore: null
  }` instead of vote data.
- `POST /admin/blocklist { videoId, reason }` and `DELETE
  /admin/blocklist/:videoId` — gated by an `x-admin-token` header checked
  against a new `ADMIN_TOKEN` secret. Lets the operator suppress a
  brigaded video's community score.
- Voting on a blocklisted video: `POST /vote` returns 403.

### Schema changes

Add to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS blocklist (
  video_id   TEXT PRIMARY KEY,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
```

`votes` and `rate_limit` are unchanged.

### Secrets

Four `wrangler secret put` values: `IP_SALT` (existing), plus new
`TURNSTILE_SECRET_KEY`, `VOTE_TOKEN_SECRET`, `ADMIN_TOKEN`.

## Human verification (MV3-safe Turnstile)

MV3 extension pages (options.html, popup.html) cannot load remote script —
the CSP forbids it outright, not just by convention. Cloudflare Turnstile's
widget requires loading `challenges.cloudflare.com`'s script, so it cannot
run directly inside `options.html`.

The sanctioned MV3 pattern (per Chrome's own guidance for embedding
CAPTCHAs) is a **sandbox page**: an iframe with its own relaxed CSP that
forfeits all `chrome.*` API access, communicating with the rest of the
extension only via `postMessage`.

Concretely:

- `src/sandbox/turnstile-sandbox.html` + `.js` — loads Turnstile's script,
  renders the widget, and on completion does
  `window.parent.postMessage({turnstileToken}, extensionOrigin)`.
- `manifest.json` gains `sandbox.pages: ["sandbox/turnstile-sandbox.html"]`
  and a `content_security_policy.sandbox` string permitting
  `challenges.cloudflare.com` for `script-src`/`frame-src`.
- `options.html` embeds the sandbox page in a hidden `<iframe>`, shown when
  the user clicks "Verify you're human."
- `options.js` listens for the `postMessage`, relays the token to
  `background.js` via a new `VERIFY_TURNSTILE` message, which calls
  `POST /verify` and stores the returned vote-token.
- Settings shows verification status: "Verified — expires in N days" or a
  re-verify prompt once expired.

## Extension-side changes

### `src/lib/constants.js`

- New `STORAGE_KEYS`: `VOTE_TOKEN`, `CLIENT_ID`, `COMMUNITY_CACHE`. (`VOTES`
  already exists, scaffolded for exactly this.)
- New `MESSAGE_TYPES`: `VERIFY_TURNSTILE`, `SET_COMMUNITY_VOTE`.
- New `CACHE_TTL_MS.COMMUNITY = 10 * 60 * 1000` (10 min — much shorter than
  the 12h score cache, so vote counts don't go stale for half a day).

### `src/lib/storage.js`

- `getVoteToken` / `setVoteToken` — the `{token, expiresAt}` pair.
- `getClientId` — lazily generates and persists a `crypto.randomUUID()` on
  first use.
- `getCommunityCacheEntry` / `setCommunityCacheEntry` — same TTL-map
  pattern already used for score/channel caches, keyed by videoId.
- Reuse existing `getOverrides`-style helpers for the local `VOTES` map
  (the user's own past vote per video), already scaffolded in
  `STORAGE_KEYS.VOTES`.

### `src/lib/heuristics.js`

New pure function, no network access, consistent with the file's existing
constraint:

```js
function blendCommunityScore(result, community, opts) {
  // result: output of scoreVideo()
  // community: { aiVotes, humanVotes, total, communityScore } | null
  // returns a new result object; does not mutate the input
}
```

- Returns `result` unchanged if `result.overridden` is true (manual
  trust/flag override always wins) or `community` is null/`total === 0`.
- `weight = Math.min(0.5, community.total / 10)` — ramps to a 50%-max
  blend by 10 votes. A couple of votes barely move the label; it can never
  fully override the heuristic regardless of vote count.
- `blendedScore = Math.round(result.score * (1 - weight) + community.communityScore * weight)`
- Re-derives `band` by re-running `blendedScore` through the same
  `STRICTNESS_BANDS` lookup used in `scoreVideo`.
- Appends a reason string, e.g. `"Community: 12 of 15 votes say
  AI-generated"`.
- Exposes raw counts on the result (`communityVotes: {ai, human, total}`)
  so the panel can render them regardless of blend weight.

### `src/background/background.js`

- `computeFullScore` is unchanged — heuristic scoring and its 12h cache
  stay exactly as they are today.
- `GET_SCORE` handler: after getting the (cached-or-computed) heuristic
  result, separately fetches community data if `settings.communityApiUrl`
  is set, via a new `getCommunityScore(videoId, communityApiUrl)` helper
  that checks `COMMUNITY_CACHE` (10 min TTL) before hitting
  `GET /score/:videoId`. Failure (network error, Worker down) is caught
  and treated as "no community data" — same fail-open pattern already used
  for RSS fetch failures in `getChannelData`. Blending happens on every
  serve (cache hit or miss on the heuristic side), so community freshness
  is decoupled from the heuristic cache.
- New `SET_COMMUNITY_VOTE` handler: reads the stored vote-token and
  `clientId`, `POST`s to `/vote` with `x-vote-token` header. No token (not
  verified, or expired) → returns `{error: 'not_verified'}` without
  hitting the network. Records the successful vote locally in the `VOTES`
  map.
- New `VERIFY_TURNSTILE` handler: calls `POST /verify`, stores the
  returned vote-token via `storage.setVoteToken`.

### `src/content/panel.js`

- Vote buttons (👍 human / 🤖 AI) added next to the existing trust/flag
  override buttons, shown only when `settings.communityApiUrl` is set.
- Shows the community line ("12 👍 / 3 🤖") whenever `communityVotes.total
  > 0`, independent of blend weight.
- Shows "you voted: human" (from local `VOTES` storage) with a way to
  change it.
- Clicking without a valid vote-token shows "Verify you're human in
  Settings to vote" instead of silently failing.

### `src/options/options.html` / `options.js`

- Remove `disabled` from the `communityApiUrl` field; on save, requests
  the specific origin via `chrome.permissions.request()` (MV3 optional
  host permissions) rather than statically widening `host_permissions` —
  consistent with this extension's existing minimal-permissions posture.
- New "Community ratings" section: verification status, "Verify you're
  human" button, hidden Turnstile sandbox iframe.

### `manifest.json` (`build/build.js`)

- `sandbox.pages` + `content_security_policy.sandbox` for the Turnstile
  iframe (see above).
- No static `host_permissions` addition — handled via optional permissions
  requested at save-time.

## Error handling

| Failure | Behavior |
|---|---|
| Community fetch fails (network/Worker down) | Blending skipped; heuristic-only result still returned |
| Vote attempt, no/expired vote-token | Background returns `not_verified`; panel shows verify prompt |
| Vote on a blocklisted video | Worker returns 403 |
| Turnstile verification fails | Inline error in options page, widget resets |
| `/verify` succeeds but token storage fails | Treated as not-verified next time; no crash |

## Testing

- `test/heuristics.test.js` gets new cases for `blendCommunityScore`:
  weight ramp at various vote counts, cap at 10+ votes, override bypass,
  null/zero-vote no-op.
- New `backend/test/` directory, using `miniflare`'s Node API (added as a
  `backend/package.json` devDependency, scoped to `backend/` only — the
  root project stays zero-dependency) to instantiate the real Worker
  against an in-memory D1 binding and exercise `/verify`, `/vote`,
  `/score/:videoId`, and the `/admin/blocklist` endpoints end-to-end,
  including the rate-limit and blocklist paths. Run via `npm test` inside
  `backend/`, separate from the root `npm test`.

## Deployment

Needs your Cloudflare account, so this is a walked-through interactive
step rather than something run unattended:

1. Create a Turnstile widget in the Cloudflare dashboard → sitekey (goes
   into `turnstile-sandbox.html`) + secret key (→ `TURNSTILE_SECRET_KEY`).
2. `wrangler login`.
3. `wrangler d1 create ai-slop-detector`, paste `database_id` into
   `wrangler.toml`.
4. `wrangler d1 execute ai-slop-detector --file=schema.sql --remote`
   (updated schema, including `blocklist`).
5. `wrangler secret put IP_SALT` / `TURNSTILE_SECRET_KEY` /
   `VOTE_TOKEN_SECRET` / `ADMIN_TOKEN`.
6. `wrangler deploy` from inside `backend/`.
7. Paste the resulting Worker URL into the extension's Settings →
   Community ratings field.

## Open questions / tuning knobs (deliberately left to feel, per existing
project style)

- Blend weight ramp (`total / 10`, capped at 0.5) — may want adjusting
  once there's real vote volume.
- Vote-token expiry (30 days) — trade-off between re-verification
  friction and token theft/reuse window.
