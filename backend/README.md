# Community-ratings backend

Cloudflare Worker + D1 backing the extension's optional community-ratings
layer: anonymous SponsorBlock-style voting on whether a video is AI slop,
gated by Cloudflare Turnstile so votes require a human, with a simple
moderation path for brigaded videos.

## Endpoints

- `GET /score/:videoId` — aggregated vote counts and `communityScore` (0-100,
  share of AI votes) for a video. Returns `{ blocked: true, communityScore:
  null, ... }` for a blocklisted video instead of its vote data.
- `POST /verify { turnstileToken, clientId }` — verifies a completed
  Turnstile challenge against Cloudflare's siteverify API, then mints a
  signed, stateless vote-token (HMAC, ~30 day expiry) tied to that
  `clientId`. No DB row: the signature itself is the proof. Rate-limited
  like `/vote`.
- `POST /vote { videoId, channelId, vote, clientId }`, header
  `x-vote-token: <token from /verify>` — records one vote per
  `(videoId, clientId)` (a later vote from the same pair overwrites the
  earlier one). Requires a valid, unexpired vote-token in addition to the
  existing per-IP-hash rate limit. Returns 403 for a blocklisted video.
- `POST /admin/blocklist { videoId, reason }`, header
  `x-admin-token: <ADMIN_TOKEN secret>` — suppress a video's community
  score (e.g. after a brigading incident).
- `DELETE /admin/blocklist/:videoId`, header `x-admin-token` — un-suppress
  a video.

`clientId` is a random UUID generated once per install
(`crypto.randomUUID()`), never tied to any identity.

`videoId` must match `^[A-Za-z0-9_-]{1,32}$`; `channelId` and `reason` are
capped at 64 and 500 characters respectively; `clientId` is capped at 128
characters. Requests violating these get a 400, not silently truncated or
stored as-is.

**All four secrets below must actually be set.** The admin/moderation
endpoints refuse every request (401) if `ADMIN_TOKEN` is unset — they do
not fail open — and `/verify`/`/vote` return a `server misconfigured` 500
rather than a cryptic crash if `VOTE_TOKEN_SECRET` is unset. Still, don't
skip any of the four `wrangler secret put` calls below.

## What's here

- `wrangler.toml` — Worker config, pointing at a D1 database.
- `schema.sql` — `votes` (one vote per video per client), `rate_limit`
  (per-IP-hash throttling), and `blocklist` (moderation) tables.
- `src/index.js` — the Worker.
- `test/` — `node --test`-based test suite. Pure vote-token crypto helpers
  are tested directly (no Worker runtime needed); the HTTP endpoints are
  tested end-to-end against a real D1 binding via
  [Miniflare](https://miniflare.dev). Run with `npm test` from inside
  `backend/`.

## Deploying

1. In the Cloudflare dashboard, create a Turnstile widget (Turnstile →
   Add site). Note the **site key** (goes into the extension's Settings →
   Turnstile site key field) and **secret key** (→ `TURNSTILE_SECRET_KEY`
   below).
2. `npm install -g wrangler` (or use `npx wrangler`), then `wrangler
   login`.
3. `wrangler d1 create ai-slop-detector`, then paste the returned
   `database_id` into `wrangler.toml`.
4. `wrangler d1 execute ai-slop-detector --file=schema.sql --remote`.
5. Set four secrets:
   ```
   wrangler secret put IP_SALT               # any random string
   wrangler secret put TURNSTILE_SECRET_KEY   # from step 1
   wrangler secret put VOTE_TOKEN_SECRET      # any random string, keep it private
   wrangler secret put ADMIN_TOKEN            # any random string; authenticates moderation calls
   ```
6. `wrangler deploy` from inside `backend/`.
7. Paste the resulting `https://ai-slop-detector-api.<you>.workers.dev` URL
   into the extension's Settings → Community ratings → Backend URL field,
   and the Turnstile site key from step 1 into the field next to it.

## Moderating a brigaded video

```
curl -X POST https://<your-worker-url>/admin/blocklist \
  -H "content-type: application/json" \
  -H "x-admin-token: <your ADMIN_TOKEN>" \
  -d '{"videoId": "dQw4w9WgXcQ", "reason": "brigaded"}'
```

Remove it again with:

```
curl -X DELETE https://<your-worker-url>/admin/blocklist/dQw4w9WgXcQ \
  -H "x-admin-token: <your ADMIN_TOKEN>"
```

## Abuse resistance

Three layers: a per-IP-hash rate limit (crude, cheap), one vote per
`(videoId, clientId)` via a DB primary key, and a Turnstile-gated signed
vote-token required on every vote. None of this defeats a sufficiently
motivated attacker running many browser profiles through Turnstile by
hand — it raises the cost of casual vote-stuffing, not the ceiling. The
blocklist is the backstop for whatever gets through anyway.
