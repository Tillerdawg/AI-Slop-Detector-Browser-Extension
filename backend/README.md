# Community-ratings backend (scaffold, not deployed)

This is a starting point for the optional future layer where users vote on
videos (SponsorBlock-style) and the extension shows the aggregated community
verdict alongside its local heuristic score. **Nothing here is deployed, and
the extension does not currently call it.** Set it up only if/when you want
to take this further.

## What's here

- `wrangler.toml` — Cloudflare Worker config, pointing at a D1 database.
- `schema.sql` — two tables: `votes` (one anonymous vote per video per
  client) and `rate_limit` (crude per-IP-hash throttling).
- `src/index.js` — the Worker itself: `GET /score/:videoId` and
  `POST /vote`.

## To actually deploy it

1. `npm install -g wrangler` (or `npx wrangler`), `wrangler login`.
2. `wrangler d1 create ai-slop-detector`, then paste the returned
   `database_id` into `wrangler.toml`.
3. `wrangler d1 execute ai-slop-detector --file=schema.sql --remote`.
4. Set an `IP_SALT` secret: `wrangler secret put IP_SALT` (any random string).
5. `wrangler deploy` from inside `backend/`.
6. Paste the resulting `https://ai-slop-detector-api.<you>.workers.dev` URL
   into the extension's Settings → "Community ratings" field (currently
   disabled/unused — see below).

## What's left to actually wire this up (not done yet)

This scaffold intentionally stops at "a working API you could deploy" and
does not modify the extension's behavior. To finish the integration:

1. Enable the `communityApiUrl` field in `src/options/options.html` (remove
   `disabled`) and persist it (already flows through `AISlop.storage`).
2. Add a `communityScore` provider in `src/background/background.js`:
   `fetch(communityApiUrl + '/score/' + videoId)`, merged into the result
   returned for `GET_SCORE` (e.g. average or override the heuristic score
   once N votes exist — worth tuning by feel).
3. Add vote buttons somewhere in the UI (the existing "mark channel as
   trusted/flagged" buttons in `src/content/panel.js` are local-only right
   now — you'd add separate video-level "vote AI / vote human" buttons that
   `POST` to `/vote` with a persisted random `clientId`, generated once via
   `crypto.randomUUID()` and stored in `chrome.storage.local`).
4. Decide on abuse mitigation beyond the crude rate limit here before
   opening this up publicly — e.g. Cloudflare Turnstile, or requiring a
   lightweight anonymous auth token minted per install.
5. Add a moderation/admin path (even just a manual D1 query) for obviously
   brigaded videos.

None of this is hard, it's just deliberately out of scope until you decide
you actually want a shared backend running (and are ready to operate it —
uptime, abuse, moderation) rather than the fully local MVP.
