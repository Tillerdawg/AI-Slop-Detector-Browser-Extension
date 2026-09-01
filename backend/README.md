# Community-ratings backend

Cloudflare Worker + D1 backing the extension's optional community-ratings
layer: anonymous SponsorBlock-style voting on whether a video is AI slop,
with a simple moderation path for brigaded videos.

## Endpoints

- `GET /score/:videoId` — aggregated vote counts and `communityScore` (0-100,
  share of AI votes) for a video. Returns `{ blocked: true, communityScore:
  null, ... }` for a blocklisted video instead of its vote data.
- `POST /vote { videoId, channelId, vote, clientId }` — records one vote per
  `(videoId, clientId)` (a later vote from the same pair overwrites the
  earlier one), subject to the per-IP-hash rate limit. Returns 403 for a
  blocklisted video.
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

**Both secrets below must actually be set.** The admin/moderation
endpoints refuse every request (401) if `ADMIN_TOKEN` is unset — they do
not fail open — so don't skip either `wrangler secret put` call below.

## What's here

- `wrangler.toml` — Worker config, pointing at a D1 database.
- `schema.sql` — `votes` (one vote per video per client), `rate_limit`
  (per-IP-hash throttling), and `blocklist` (moderation) tables.
- `src/index.js` — the Worker.
- `test/` — `node --test`-based test suite. Pure helpers are tested
  directly (no Worker runtime needed); the HTTP endpoints are tested
  end-to-end against a real D1 binding via
  [Miniflare](https://miniflare.dev). Run with `npm test` from inside
  `backend/`.

## Deploying

1. `npm install -g wrangler` (or use `npx wrangler`), then `wrangler
   login`.
2. `wrangler d1 create ai-slop-detector`, then paste the returned
   `database_id` into `wrangler.toml`.
3. `wrangler d1 execute ai-slop-detector --file=schema.sql --remote`.
4. Set two secrets:
   ```
   wrangler secret put IP_SALT      # any random string
   wrangler secret put ADMIN_TOKEN  # any random string; authenticates moderation calls
   ```
5. `wrangler deploy` from inside `backend/`.
6. Paste the resulting `https://ai-slop-detector-api.<you>.workers.dev` URL
   into the extension's Settings → Community ratings → Backend URL field.

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

Two layers: a per-IP-hash rate limit (crude, cheap — 20 requests/minute)
and one vote per `(videoId, clientId)` via a DB primary key. There is no
human-verification step: Cloudflare Turnstile can't run inside Chrome's
MV3 sandboxed-extension-page model (its script needs `allow-same-origin`
frame access, which the extension sandbox permanently forbids), so it was
dropped rather than shipped broken. Neither remaining layer defeats a
motivated attacker — rotating a `clientId` is trivial, and IPs are
cheap — they raise the cost of casual vote-stuffing, not the ceiling. The
blocklist is the backstop for whatever gets through anyway.
