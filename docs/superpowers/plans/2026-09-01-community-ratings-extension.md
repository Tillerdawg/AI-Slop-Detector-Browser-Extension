# Community Ratings — Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on:** [2026-09-01-community-ratings-backend.md](2026-09-01-community-ratings-backend.md).
> Tasks 1-5 here are independently buildable/lintable without a live
> backend. Tasks 6-7's manual verification needs a deployed Worker (or a
> local `wrangler dev` instance) and a real Turnstile site key — use
> Cloudflare's documented always-passes test site key
> `1x00000000000000000000AA` if the real backend isn't deployed yet.

**Goal:** Wire the extension's UI and background logic to the
community-ratings backend: blended scoring, MV3-safe Turnstile
verification, and vote buttons on the watch-page panel.

**Architecture:** `heuristics.js` gains a pure `blendCommunityScore()`
function. `background.js` fetches/caches community data and calls it when
serving `GET_SCORE`. A sandboxed page hosts the Turnstile widget (MV3
forbids remote script in normal extension pages) and hands a token back to
`options.js` via `postMessage`. `panel.js` renders vote buttons; `content.js`
wires their clicks to background messages, following the same pattern
already used for the trust/flag override buttons.

**Tech Stack:** Vanilla JS (no build tooling beyond the existing
`build/build.js` static copy), Cloudflare Turnstile, `chrome.permissions`
(MV3 optional host permissions), `chrome.sandbox` pages.

**Spec:** [docs/superpowers/specs/2026-09-01-community-ratings-design.md](../specs/2026-09-01-community-ratings-design.md)

## Global Constraints

- No new dependencies — this project ships zero npm runtime dependencies;
  keep it that way.
- Match the existing codebase's testing convention exactly: `heuristics.js`
  is the *only* module with automated tests (it's pure, no browser APIs).
  Everything else (`storage.js`, `background.js`, `panel.js`, `options.js`,
  the sandbox page) is verified by `npm run lint` (syntax check) plus
  manual verification in a loaded unpacked extension — do not invent new
  test infrastructure for these files.
- Follow the existing `AISlop.<module>` namespace-attachment pattern in
  every new/modified `src/lib`, `src/content`, `src/options`,
  `src/background` file (see `src/lib/constants.js`'s header comment for
  why — classic scripts, no ESM).
- `communityApiUrl` and `turnstileSiteKey` are user-pasted, per-install
  settings (same pattern as the existing `youtubeApiKey` field) — never
  hardcode a URL or site key in source.
- Firefox's MV3 `sandbox`/`content_security_policy.sandbox` support is
  less mature than Chrome's and may behave differently. Task 5 flags this
  explicitly — verify the Turnstile flow in Firefox during Task 6, and if
  it doesn't work there, that's a documented known limitation, not a
  blocker for the Chrome build.

---

### Task 1: `blendCommunityScore()` in the scoring engine

**Files:**
- Modify: `src/lib/heuristics.js`
- Test: `test/heuristics.test.js`

**Interfaces:**
- Produces: `AISlop.heuristics.blendCommunityScore(result, community, opts)`
  — `result` is a `scoreVideo()` output; `community` is
  `{aiVotes, humanVotes, total, communityScore} | null` (matches the
  backend's `GET /score/:videoId` response shape); `opts.strictness` is
  `'lenient'|'balanced'|'strict'`. Returns a new result object (does not
  mutate `result`), with `communityVotes: {ai, human, total}` and
  `communityBlendWeight` added, and `score`/`band`/`reasons` updated when
  blending applies. Used by `background.js` in Task 3.

- [ ] **Step 1: Write the failing test**

Append to `test/heuristics.test.js` (before the final summary/exit lines,
following the file's existing `assert(...)` style — read the file first
to match its exact pattern of numbered comment blocks):

```js
// N. blendCommunityScore: no community data is a no-op.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' });
  const blended = heuristics.blendCommunityScore(base, null);
  assert(blended.score === base.score, 'blendCommunityScore(result, null) should not change the score');
  assert(blended.communityVotes === undefined, 'no communityVotes field when there is no community data');
}

// N+1. blendCommunityScore: zero total votes is a no-op.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' });
  const blended = heuristics.blendCommunityScore(base, { aiVotes: 0, humanVotes: 0, total: 0, communityScore: null });
  assert(blended.score === base.score, 'zero votes should not change the score');
}

// N+2. blendCommunityScore: a manual override always bypasses blending.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' }, { override: { trusted: true } });
  const blended = heuristics.blendCommunityScore(base, { aiVotes: 20, humanVotes: 0, total: 20, communityScore: 100 });
  assert(blended.score === 0 && blended.band === 'human', 'a manual override must not be perturbed by community votes');
}

// N+3. blendCommunityScore: weight ramps with vote count and caps at 0.5.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' }); // score 0, no signals fired
  const fewVotes = heuristics.blendCommunityScore(base, { aiVotes: 1, humanVotes: 0, total: 1, communityScore: 100 });
  const manyVotes = heuristics.blendCommunityScore(base, { aiVotes: 20, humanVotes: 0, total: 20, communityScore: 100 });
  assert(fewVotes.communityBlendWeight < manyVotes.communityBlendWeight, 'more votes should mean more blend weight');
  assert(manyVotes.communityBlendWeight === 0.5, 'blend weight caps at 0.5 regardless of vote count');
  assert(fewVotes.score < manyVotes.score, 'more AI votes at higher weight should pull the score up further');
}

// N+4. blendCommunityScore: exposes raw counts and a human-readable reason.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' });
  const blended = heuristics.blendCommunityScore(base, { aiVotes: 3, humanVotes: 7, total: 10, communityScore: 30 });
  assert(blended.communityVotes.ai === 3 && blended.communityVotes.human === 7 && blended.communityVotes.total === 10, 'raw vote counts should be exposed');
  assert(blended.reasons.some((r) => r.includes('Community')), 'a community-vote reason should be appended');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `TypeError: heuristics.blendCommunityScore is not a
function`.

- [ ] **Step 3: Implement `blendCommunityScore`**

In `src/lib/heuristics.js`, add this function above the final
`AISlop.heuristics = { ... }` export line:

```js
  /**
   * Blends a video's heuristic score with its community vote counts.
   * Pure -- no network access, consistent with the rest of this file.
   * @param {object} result scoreVideo() output
   * @param {{aiVotes:number, humanVotes:number, total:number, communityScore:number|null}|null} community
   * @param {object} [opts]
   * @param {string} [opts.strictness]
   * @returns {object} a new result object; does not mutate `result`
   */
  function blendCommunityScore(result, community, opts) {
    if (!result || result.overridden) return result;
    if (!community || !community.total) return result;
    opts = opts || {};

    const weight = Math.min(0.5, community.total / 10);
    const blendedScore = Math.round(result.score * (1 - weight) + community.communityScore * weight);

    const strictness = opts.strictness || 'balanced';
    const bands = (C.STRICTNESS_BANDS && C.STRICTNESS_BANDS[strictness]) || C.STRICTNESS_BANDS.balanced;
    let band = 'human';
    for (const b of bands) {
      if (blendedScore >= b.min) {
        band = b.id;
        break;
      }
    }

    const communityVotes = { ai: community.aiVotes || 0, human: community.humanVotes || 0, total: community.total };
    const reasons = result.reasons.concat([
      `Community: ${communityVotes.human} of ${communityVotes.total} votes say human-made, ${communityVotes.ai} say AI-generated`,
    ]);

    return Object.assign({}, result, {
      score: blendedScore,
      band,
      reasons,
      communityVotes,
      communityBlendWeight: weight,
    });
  }
```

Update the export line at the bottom of the file:

```js
  AISlop.heuristics = { scoreVideo, quickScoreFromTitle, blendCommunityScore, median, daysBetween };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add src/lib/heuristics.js test/heuristics.test.js
git commit -m "Add blendCommunityScore to the scoring engine"
```

---

### Task 2: Storage + constants for votes, vote-token, and community cache

**Files:**
- Modify: `src/lib/constants.js`
- Modify: `src/lib/storage.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by `background.js` in Task 3 and `options.js` in Task 6):
  - `AISlop.constants.MESSAGE_TYPES.VERIFY_TURNSTILE`,
    `.SET_COMMUNITY_VOTE`
  - `AISlop.constants.STORAGE_KEYS.VOTE_TOKEN`, `.CLIENT_ID`,
    `.COMMUNITY_CACHE`
  - `AISlop.constants.CACHE_TTL_MS.COMMUNITY`
  - `AISlop.constants.DEFAULT_SETTINGS.turnstileSiteKey` (string, default `''`)
  - `AISlop.storage.getVoteToken(): Promise<{token, expiresAt}|null>`
  - `AISlop.storage.setVoteToken(voteToken): Promise<void>`
  - `AISlop.storage.getClientId(): Promise<string>` (lazily generates and
    persists a UUID on first call)
  - `AISlop.storage.getVotes(): Promise<Record<videoId, 'ai'|'human'>>`
  - `AISlop.storage.setMyVote(videoId, vote): Promise<Record<videoId, 'ai'|'human'>>`
  - `AISlop.storage.getCommunityCacheEntry(videoId): Promise<object|null>`
  - `AISlop.storage.setCommunityCacheEntry(videoId, value): Promise<void>`
  - `AISlop.storage.clearCommunityCacheEntry(videoId): Promise<void>`

- [ ] **Step 1: Add constants**

In `src/lib/constants.js`, update `STORAGE_KEYS`:

```js
  const STORAGE_KEYS = {
    SETTINGS: 'aislop_settings',
    SCORE_CACHE: 'aislop_score_cache', // per-video score cache
    CHANNEL_CACHE: 'aislop_channel_cache', // per-channel upload-cadence cache
    OVERRIDES: 'aislop_overrides', // user's manual trust/flag list, keyed by videoId
    VOTES: 'aislop_votes', // local-only record of the user's own community vote per videoId
    VOTE_TOKEN: 'aislop_vote_token', // signed {token, expiresAt} from the community backend's /verify
    CLIENT_ID: 'aislop_client_id', // random per-install UUID, sent with votes/verification
    COMMUNITY_CACHE: 'aislop_community_cache', // per-video community vote-count cache (short TTL)
  };
```

Update `DEFAULT_SETTINGS`:

```js
    communityApiUrl: '', // optional community-ratings backend base URL (empty = disabled)
    turnstileSiteKey: '', // Turnstile site key for the community-ratings "verify you're human" flow
```

Update `CACHE_TTL_MS`:

```js
  const CACHE_TTL_MS = {
    SCORE: 12 * 60 * 60 * 1000, // 12h - per-video score
    CHANNEL: 24 * 60 * 60 * 1000, // 24h - per-channel upload cadence
    COMMUNITY: 10 * 60 * 1000, // 10min - community vote counts (kept short so votes don't go stale for hours)
  };
```

Update `MESSAGE_TYPES`:

```js
    SET_COMMUNITY_VOTE: 'AISLOP_SET_COMMUNITY_VOTE', // content -> background: cast/change a community vote
    VERIFY_TURNSTILE: 'AISLOP_VERIFY_TURNSTILE', // options -> background: exchange a Turnstile token for a vote-token
```

- [ ] **Step 2: Add storage helpers**

In `src/lib/storage.js`, add near the top with the other `MAX_*_ENTRIES`
constants:

```js
  const MAX_COMMUNITY_ENTRIES = 2000;
```

Add these functions after `setOverride`:

```js
  async function getVoteToken() {
    const stored = await get(C.STORAGE_KEYS.VOTE_TOKEN);
    return stored[C.STORAGE_KEYS.VOTE_TOKEN] || null;
  }

  async function setVoteToken(voteToken) {
    await set({ [C.STORAGE_KEYS.VOTE_TOKEN]: voteToken });
  }

  async function getClientId() {
    const stored = await get(C.STORAGE_KEYS.CLIENT_ID);
    let clientId = stored[C.STORAGE_KEYS.CLIENT_ID];
    if (!clientId) {
      clientId = crypto.randomUUID();
      await set({ [C.STORAGE_KEYS.CLIENT_ID]: clientId });
    }
    return clientId;
  }

  async function getVotes() {
    const stored = await get(C.STORAGE_KEYS.VOTES);
    return stored[C.STORAGE_KEYS.VOTES] || {};
  }

  async function setMyVote(videoId, vote) {
    const votes = await getVotes();
    votes[videoId] = vote;
    await set({ [C.STORAGE_KEYS.VOTES]: votes });
    return votes;
  }

  async function getCommunityCacheEntry(videoId) {
    const stored = await get(C.STORAGE_KEYS.COMMUNITY_CACHE);
    const map = stored[C.STORAGE_KEYS.COMMUNITY_CACHE] || {};
    const entry = map[videoId];
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    return null;
  }

  async function setCommunityCacheEntry(videoId, value) {
    const stored = await get(C.STORAGE_KEYS.COMMUNITY_CACHE);
    let map = stored[C.STORAGE_KEYS.COMMUNITY_CACHE] || {};
    map[videoId] = { value, expiresAt: Date.now() + C.CACHE_TTL_MS.COMMUNITY };
    map = pruneMap(map, null, MAX_COMMUNITY_ENTRIES);
    await set({ [C.STORAGE_KEYS.COMMUNITY_CACHE]: map });
  }

  async function clearCommunityCacheEntry(videoId) {
    const stored = await get(C.STORAGE_KEYS.COMMUNITY_CACHE);
    const map = stored[C.STORAGE_KEYS.COMMUNITY_CACHE] || {};
    delete map[videoId];
    await set({ [C.STORAGE_KEYS.COMMUNITY_CACHE]: map });
  }
```

Update `clearCaches` so "Clear cached scores" in Settings also drops stale
community counts:

```js
  async function clearCaches() {
    await remove([C.STORAGE_KEYS.SCORE_CACHE, C.STORAGE_KEYS.CHANNEL_CACHE, C.STORAGE_KEYS.COMMUNITY_CACHE]);
  }
```

Update the `AISlop.storage = { ... }` export at the bottom:

```js
  AISlop.storage = {
    get,
    set,
    remove,
    getSettings,
    setSettings,
    getScoreCacheEntry,
    setScoreCacheEntry,
    getChannelCacheEntry,
    setChannelCacheEntry,
    getOverrides,
    setOverride,
    getVoteToken,
    setVoteToken,
    getClientId,
    getVotes,
    setMyVote,
    getCommunityCacheEntry,
    setCommunityCacheEntry,
    clearCommunityCacheEntry,
    clearCaches,
    cacheStats,
  };
```

- [ ] **Step 3: Verify**

Run: `npm run lint`
Expected: no output (all files pass `node --check`).

Run: `npm test`
Expected: still PASS (unrelated to this task's changes, confirms nothing
broke).

- [ ] **Step 4: Commit**

```bash
git add src/lib/constants.js src/lib/storage.js
git commit -m "Add storage/constants for vote-token, client id, and community cache"
```

---

### Task 3: background.js wiring

**Files:**
- Modify: `src/background/background.js`

**Interfaces:**
- Consumes: `AISlop.heuristics.blendCommunityScore` (Task 1);
  `AISlop.storage.{getVoteToken,setVoteToken,getClientId,getVotes,setMyVote,getCommunityCacheEntry,setCommunityCacheEntry,clearCommunityCacheEntry}`
  (Task 2); `AISlop.constants.MESSAGE_TYPES.{SET_COMMUNITY_VOTE,VERIFY_TURNSTILE}`
  (Task 2).
- Produces: `GET_SCORE` responses now include `communityVotes`,
  `communityVerified`, `myVote` when `settings.communityApiUrl` is set.
  New message handlers for `SET_COMMUNITY_VOTE` and `VERIFY_TURNSTILE`,
  consumed by `content.js` (Task 7) and `options.js` (Task 6) respectively.

- [ ] **Step 1: Add `getCommunityScore` and `finalizeScorePayload`**

In `src/background/background.js`, add this function after
`getChannelData`:

```js
  async function getCommunityScore(videoId, communityApiUrl) {
    if (!communityApiUrl) return null;
    const cached = await AISlop.storage.getCommunityCacheEntry(videoId);
    if (cached) return cached;
    let data = null;
    try {
      const res = await fetch(communityApiUrl.replace(/\/$/, '') + '/score/' + encodeURIComponent(videoId));
      if (res.ok) data = await res.json();
    } catch (e) {
      data = null;
    }
    if (data) await AISlop.storage.setCommunityCacheEntry(videoId, data);
    return data;
  }

  async function finalizeScorePayload(payload, videoId, settings) {
    if (!settings.communityApiUrl) return payload;
    const community = await getCommunityScore(videoId, settings.communityApiUrl);
    const blended = AISlop.heuristics.blendCommunityScore(payload, community, { strictness: settings.strictness });
    const voteToken = await AISlop.storage.getVoteToken();
    const communityVerified = !!(voteToken && voteToken.expiresAt > Date.now());
    const myVote = (await AISlop.storage.getVotes())[videoId] || null;
    return Object.assign({}, blended, { communityVerified, myVote });
  }
```

- [ ] **Step 2: Route `GET_SCORE` responses through `finalizeScorePayload`**

Replace the existing `case M.GET_SCORE:` block in `handleMessage`:

```js
      case M.GET_SCORE: {
        const settings = await AISlop.storage.getSettings();
        if (!settings.enabled) return { disabled: true };
        if (!message.forceRefresh) {
          const cached = await AISlop.storage.getScoreCacheEntry(message.videoId);
          if (cached) return finalizeScorePayload(cached, message.videoId, settings);
        }
        const result = await computeFullScore(message.signals || {}, settings);
        const payload = Object.assign({}, result, {
          videoId: message.videoId,
          channelId: message.signals && message.signals.channelId,
          channelTitle: message.signals && message.signals.channelTitle,
          title: message.signals && message.signals.title,
          computedAt: Date.now(),
        });
        await AISlop.storage.setScoreCacheEntry(message.videoId, payload);
        return finalizeScorePayload(payload, message.videoId, settings);
      }
```

- [ ] **Step 3: Add `SET_COMMUNITY_VOTE` and `VERIFY_TURNSTILE` handlers**

Add these `case` blocks to `handleMessage`, after `case M.SET_OVERRIDE:`:

```js
      case M.SET_COMMUNITY_VOTE: {
        const settings = await AISlop.storage.getSettings();
        if (!settings.communityApiUrl) return { error: 'community_disabled' };
        const voteToken = await AISlop.storage.getVoteToken();
        if (!voteToken || voteToken.expiresAt <= Date.now()) return { error: 'not_verified' };
        const clientId = await AISlop.storage.getClientId();
        let res;
        try {
          res = await fetch(settings.communityApiUrl.replace(/\/$/, '') + '/vote', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-vote-token': voteToken.token },
            body: JSON.stringify({
              videoId: message.videoId,
              channelId: message.channelId,
              vote: message.vote,
              clientId,
            }),
          });
        } catch (e) {
          return { error: 'network_error' };
        }
        if (!res.ok) return { error: 'vote_failed', status: res.status };
        await AISlop.storage.setMyVote(message.videoId, message.vote);
        await AISlop.storage.clearCommunityCacheEntry(message.videoId);
        return { ok: true };
      }

      case M.VERIFY_TURNSTILE: {
        const settings = await AISlop.storage.getSettings();
        if (!settings.communityApiUrl) return { error: 'community_disabled' };
        const clientId = await AISlop.storage.getClientId();
        let res;
        try {
          res = await fetch(settings.communityApiUrl.replace(/\/$/, '') + '/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ turnstileToken: message.turnstileToken, clientId }),
          });
        } catch (e) {
          return { error: 'network_error' };
        }
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !body.voteToken) return { error: 'verify_failed' };
        await AISlop.storage.setVoteToken({ token: body.voteToken, expiresAt: body.expiresAt });
        return { ok: true, expiresAt: body.expiresAt };
      }
```

- [ ] **Step 4: Verify**

Run: `npm run lint`
Expected: no output.

Run: `npm run build`
Expected: `Built chrome -> dist/chrome` / `Built firefox -> dist/firefox`,
no errors.

Manual smoke check (regression, since `communityApiUrl` is empty by
default so none of this new code should activate yet):
1. Load `dist/chrome` unpacked in Chrome (`chrome://extensions` → Developer
   mode → Load unpacked).
2. Open a YouTube watch page. Confirm the existing detail panel still
   appears with a label and reasons, unchanged from before this task.
3. Open the background service worker's console (`chrome://extensions` →
   "service worker" link under this extension) and confirm no errors were
   logged.

- [ ] **Step 5: Commit**

```bash
git add src/background/background.js
git commit -m "Wire background.js to the community-ratings backend"
```

---

### Task 4: Sandboxed Turnstile page

**Files:**
- Create: `src/sandbox/turnstile-sandbox.html`
- Create: `src/sandbox/turnstile-sandbox.js`

**Interfaces:**
- Produces: a page that, given a `?sitekey=` query param, renders the
  Turnstile widget and on completion does
  `window.parent.postMessage({source: 'aislop-turnstile', turnstileToken}, '*')`
  (or `{source: 'aislop-turnstile', error: 'turnstile_error'}` on failure).
  Consumed by `options.js` in Task 6.

- [ ] **Step 1: Create the sandbox HTML**

Create `src/sandbox/turnstile-sandbox.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Verify you're human</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body style="margin: 0; display: flex; align-items: center; justify-content: center;">
  <div id="turnstile-widget"></div>
  <script src="turnstile-sandbox.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create the sandbox script**

Create `src/sandbox/turnstile-sandbox.js`:

```js
/**
 * Runs inside a sandboxed extension page (see manifest `sandbox.pages`).
 * MV3 forbids remote script in normal extension pages, so the Turnstile
 * widget -- which loads its own script from challenges.cloudflare.com --
 * has to live here instead, communicating with options.js only via
 * postMessage (sandboxed pages get no chrome.* API access).
 */
(function () {
  function getSiteKey() {
    const params = new URLSearchParams(window.location.search);
    return params.get('sitekey') || '';
  }

  function post(data) {
    window.parent.postMessage(Object.assign({ source: 'aislop-turnstile' }, data), '*');
  }

  function render() {
    const siteKey = getSiteKey();
    if (!siteKey) {
      post({ error: 'missing_sitekey' });
      return;
    }
    if (typeof window.turnstile === 'undefined') {
      setTimeout(render, 200);
      return;
    }
    window.turnstile.render('#turnstile-widget', {
      sitekey: siteKey,
      callback: (token) => post({ turnstileToken: token }),
      'error-callback': () => post({ error: 'turnstile_error' }),
    });
  }

  render();
})();
```

- [ ] **Step 3: Manual verification**

This page can't be verified by itself yet (it needs manifest sandbox
permissions from Task 5, and a parent page from Task 6, to actually load
in the extension). Skip verification here; Task 6's manual check covers
it end-to-end. Cloudflare's documented always-passes test site key is
`1x00000000000000000000AA` — use it if you don't have a real one yet.

- [ ] **Step 4: Commit**

```bash
git add src/sandbox/turnstile-sandbox.html src/sandbox/turnstile-sandbox.js
git commit -m "Add sandboxed Turnstile verification page"
```

---

### Task 5: Manifest changes (sandbox, CSP, optional host permissions)

**Files:**
- Modify: `build/build.js`

**Interfaces:**
- Produces: `dist/chrome/manifest.json` and `dist/firefox/manifest.json`
  gain `sandbox.pages`, `content_security_policy.sandbox`, and
  `optional_host_permissions`.

- [ ] **Step 1: Update `baseManifest()`**

In `build/build.js`, in the `baseManifest()` function, add the following
right after the `content_scripts: [...]` entry (still inside the returned
object, before the closing `};`):

```js
    // Community-ratings opt-in: Turnstile verification runs in a sandboxed
    // page (MV3 forbids remote script in normal extension pages), and the
    // user-pasted backend URL gets its own origin permission requested at
    // save-time via chrome.permissions.request() rather than a static grant.
    sandbox: { pages: ['sandbox/turnstile-sandbox.html'] },
    content_security_policy: {
      sandbox:
        "sandbox allow-scripts allow-popups; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; child-src https://challenges.cloudflare.com;",
    },
    optional_host_permissions: ['https://*/*'],
```

`copyDir(SRC, outDir)` already copies the whole `src/` tree wholesale, so
`src/sandbox/*` needs no separate entry to be included in the build output
— only the manifest declaration above is new.

- [ ] **Step 2: Build and inspect**

Run: `npm run build`

Read `dist/chrome/manifest.json` and confirm it contains the `sandbox`,
`content_security_policy`, and `optional_host_permissions` keys exactly as
written above, and that `dist/chrome/sandbox/turnstile-sandbox.html` and
`.js` exist.

- [ ] **Step 3: Manual verification (Chrome)**

1. Load `dist/chrome` unpacked (`chrome://extensions` → Developer mode →
   Load unpacked, or Reload if already loaded).
2. On the extensions page, confirm there are **no manifest errors or
   warnings** shown for this extension. (An invalid CSP string here would
   surface as a load error, not a silent failure.)

- [ ] **Step 4: Note the Firefox caveat**

Firefox's MV3 `sandbox` page support differs from Chrome's and may not
accept the same `content_security_policy.sandbox` syntax. Load
`dist/firefox` in `about:debugging#/runtime/this-firefox` and check for
manifest warnings; if the sandbox page fails to load there, that's a
known limitation to note in the root `README.md` (Task 8) rather than
something to solve in this task.

- [ ] **Step 5: Commit**

```bash
git add build/build.js
git commit -m "Add manifest sandbox/CSP/optional host permissions for community ratings"
```

---

### Task 6: Options page — community settings + verify flow

**Files:**
- Modify: `src/options/options.html`
- Modify: `src/options/options.js`

**Interfaces:**
- Consumes: `AISlop.storage.getVoteToken` (Task 2);
  `AISlop.constants.MESSAGE_TYPES.VERIFY_TURNSTILE` (Task 2); the sandbox
  page from Task 4; `chrome.permissions.request` (native API).
- Produces: a working "Verify you're human" flow that stores a vote-token
  usable by Task 7's vote buttons.

- [ ] **Step 1: Replace the "coming soon" card in `options.html`**

Replace the existing `<section class="card"><h2>Community ratings (coming
soon)</h2>...</section>` block with:

```html
    <section class="card">
      <h2>Community ratings</h2>
      <p class="hint">
        Optionally layer in crowd-sourced votes (SponsorBlock-style) on top of the local heuristic, backed by a
        small hosted service you (or someone you trust) runs. Leave the URL blank to keep everything fully local.
      </p>
      <label class="row">
        Backend URL
        <input type="text" id="communityApiUrl" placeholder="https://your-worker.workers.dev" style="width: 100%; max-width: 360px;" />
      </label>
      <label class="row">
        Turnstile site key
        <input type="text" id="turnstileSiteKey" placeholder="0x4AAAAAAA…" style="width: 100%; max-width: 360px;" />
      </label>
      <div class="row">
        <button id="verifyHuman" type="button">Verify you're human</button>
        <span id="verifyStatus" class="hint">Not verified</span>
      </div>
      <iframe id="turnstileFrame" hidden style="border: 0; width: 300px; height: 70px;"></iframe>
    </section>
```

- [ ] **Step 2: Wire it up in `options.js`**

Add `const api = AISlop.browserApi;` near the top of the IIFE (after
`const AISlop = window.AISlop;`).

Add these entries to the `els` object:

```js
    communityApiUrl: document.getElementById('communityApiUrl'),
    turnstileSiteKey: document.getElementById('turnstileSiteKey'),
    verifyHuman: document.getElementById('verifyHuman'),
    verifyStatus: document.getElementById('verifyStatus'),
    turnstileFrame: document.getElementById('turnstileFrame'),
```

In `loadSettings`, add:

```js
    els.communityApiUrl.value = s.communityApiUrl || '';
    els.turnstileSiteKey.value = s.turnstileSiteKey || '';
```

Add these event listeners near the other `els.*.addEventListener` calls:

```js
  els.communityApiUrl.addEventListener('change', async () => {
    const url = els.communityApiUrl.value.trim();
    if (url) {
      try {
        const origin = new URL(url).origin + '/*';
        await api.permissions.request({ origins: [origin] });
      } catch (e) {
        // Invalid URL, or the user declined the permission prompt -- still
        // save the typed value so they can fix/retry; community features
        // simply won't work until the permission is actually granted.
      }
    }
    save({ communityApiUrl: url });
  });
  els.turnstileSiteKey.addEventListener('change', () => save({ turnstileSiteKey: els.turnstileSiteKey.value.trim() }));
```

Add the verify flow at the end of the file, before the final
`loadSettings(); renderOverrides(); renderCacheStats();` calls:

```js
  async function refreshVerifyStatus() {
    const token = await AISlop.storage.getVoteToken();
    if (token && token.expiresAt > Date.now()) {
      const days = Math.ceil((token.expiresAt - Date.now()) / 86400000);
      els.verifyStatus.textContent = `✅ Verified — expires in ${days} day${days === 1 ? '' : 's'}`;
    } else {
      els.verifyStatus.textContent = 'Not verified';
    }
  }

  els.verifyHuman.addEventListener('click', () => {
    const siteKey = els.turnstileSiteKey.value.trim();
    if (!siteKey) {
      els.verifyStatus.textContent = 'Set a Turnstile site key above first.';
      return;
    }
    els.turnstileFrame.src = '../sandbox/turnstile-sandbox.html?sitekey=' + encodeURIComponent(siteKey);
    els.turnstileFrame.hidden = false;
  });

  window.addEventListener('message', async (event) => {
    if (!event.data || event.data.source !== 'aislop-turnstile') return;
    if (event.source !== els.turnstileFrame.contentWindow) return;
    if (event.data.error) {
      els.verifyStatus.textContent = '❌ Verification failed, try again';
      return;
    }
    els.verifyStatus.textContent = 'Verifying…';
    const result = await api.runtime.sendMessage({
      type: AISlop.constants.MESSAGE_TYPES.VERIFY_TURNSTILE,
      turnstileToken: event.data.turnstileToken,
    });
    els.turnstileFrame.hidden = true;
    els.turnstileFrame.src = 'about:blank';
    if (result && result.ok) {
      await refreshVerifyStatus();
    } else {
      els.verifyStatus.textContent = '❌ Verification failed, try again';
    }
  });

  refreshVerifyStatus();
```

No `options.html` script tag changes are needed beyond what's already
there — `options.js` doesn't call into `heuristics.js`.

- [ ] **Step 3: Verify**

Run: `npm run lint`
Expected: no output.

Run: `npm run build`

Manual verification:
1. Load `dist/chrome` unpacked, open Settings (right-click the icon →
   Options).
2. Paste any URL into "Backend URL" (e.g. your deployed Worker URL from
   the backend plan, or `https://example.com` if not deployed yet) and
   tab away. Confirm a Chrome permission prompt appears (or check
   `chrome://extensions` → this extension → "Site access" afterward) and
   that the value persists after reloading the Settings page.
3. Paste `1x00000000000000000000AA` (Cloudflare's always-passes test site
   key) into "Turnstile site key" and tab away.
4. Click "Verify you're human." Confirm the Turnstile widget renders in
   the iframe and auto-completes (test key), and that "Verify Status"
   flips to "✅ Verified — expires in 30 days" — this requires your
   Backend URL to point at a real, reachable `/verify` endpoint (deployed
   from the backend plan, or `wrangler dev` locally with
   `TURNSTILE_SECRET_KEY` set to Cloudflare's matching dummy secret,
   `1x0000000000000000000000000000000AA`, which always approves). If no
   backend is reachable yet, confirm instead that the widget renders and
   passes, and that the status shows "❌ Verification failed, try again"
   (the expected result of a network error reaching `/verify`) rather than
   silently doing nothing.

- [ ] **Step 4: Commit**

```bash
git add src/options/options.html src/options/options.js
git commit -m "Add community ratings settings UI and Turnstile verify flow"
```

---

### Task 7: Vote buttons on the watch-page panel

**Files:**
- Modify: `src/content/panel.js`
- Modify: `src/content/content.js`
- Modify: `src/content/styles.css`

**Interfaces:**
- Consumes: `result.communityVotes`, `result.communityVerified`,
  `result.myVote` (Task 3's `finalizeScorePayload` output);
  `AISlop.constants.MESSAGE_TYPES.SET_COMMUNITY_VOTE` (Task 2).
- Produces: `AISlop.panel.renderWatchPanel(result, handlers, settings)` —
  note the new third parameter; `handlers.onVote(vote: 'ai'|'human')` is a
  new handler content.js must supply.

- [ ] **Step 1: Add the community section to `panel.js`**

Change the `renderWatchPanel` function signature:

```js
  function renderWatchPanel(result, handlers, settings) {
    handlers = handlers || {};
    settings = settings || {};
```

Add this block in `renderWatchPanel`, right after `body.appendChild(actions);`
and before the `note` paragraph is built:

```js
    if (settings.communityApiUrl) {
      const communityBox = document.createElement('div');
      communityBox.className = 'aislop-panel__community';

      const counts = result.communityVotes || { ai: 0, human: 0, total: 0 };
      if (counts.total > 0) {
        const countsP = document.createElement('p');
        countsP.className = 'aislop-panel__community-counts';
        countsP.textContent = `Community: ${counts.human} \u{1F44D} human, ${counts.ai} \u{1F916} AI`;
        communityBox.appendChild(countsP);
      }

      const voteRow = document.createElement('div');
      voteRow.className = 'aislop-panel__community-actions';

      const myVote = result.myVote || null;

      const voteHumanBtn = document.createElement('button');
      voteHumanBtn.type = 'button';
      voteHumanBtn.textContent = myVote === 'human' ? '\u{1F44D} Voted human' : '\u{1F44D} Vote human';
      voteHumanBtn.disabled = myVote === 'human';
      voteHumanBtn.addEventListener('click', () => handlers.onVote && handlers.onVote('human'));

      const voteAiBtn = document.createElement('button');
      voteAiBtn.type = 'button';
      voteAiBtn.textContent = myVote === 'ai' ? '\u{1F916} Voted AI' : '\u{1F916} Vote AI';
      voteAiBtn.disabled = myVote === 'ai';
      voteAiBtn.addEventListener('click', () => handlers.onVote && handlers.onVote('ai'));

      voteRow.appendChild(voteHumanBtn);
      voteRow.appendChild(voteAiBtn);
      communityBox.appendChild(voteRow);

      if (result.communityVerified === false) {
        const verifyNote = document.createElement('p');
        verifyNote.className = 'aislop-panel__community-note';
        verifyNote.textContent = "Verify you're human in Settings to vote.";
        communityBox.appendChild(verifyNote);
      }

      body.appendChild(communityBox);
    }
```

- [ ] **Step 2: Add matching styles**

Append to `src/content/styles.css`:

```css
.aislop-panel__community {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid currentColor;
  opacity: 0.9;
}

.aislop-panel__community-counts {
  margin: 0 0 6px;
  font-size: 12px;
}

.aislop-panel__community-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.aislop-panel__community-actions button {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid currentColor;
  background: none;
  color: inherit;
  cursor: pointer;
}

.aislop-panel__community-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.aislop-panel__community-note {
  margin: 6px 0 0;
  font-size: 11px;
  opacity: 0.75;
}
```

- [ ] **Step 3: Wire clicks through `content.js`**

In `src/content/content.js`, add this function after `applyOverride`:

```js
  async function applyVote(signals, vote) {
    if (!signals.videoId) return;
    await api.runtime.sendMessage({
      type: C.MESSAGE_TYPES.SET_COMMUNITY_VOTE,
      videoId: signals.videoId,
      channelId: signals.channelId,
      vote,
    });
    await refreshWatchPanel(true);
  }
```

Update `applyResult` to pass the new handler and `settings`:

```js
  function applyResult(signals, result) {
    lastResult = result;
    lastSignals = signals;
    if (settings.showOnWatchPage) {
      AISlop.panel.renderWatchPanel(
        result,
        {
          onMarkTrusted: () => applyOverride(signals, { trusted: true, videoTitle: signals.title }),
          onMarkFlagged: () => applyOverride(signals, { flagged: true, videoTitle: signals.title }),
          onClearOverride: () => applyOverride(signals, null),
          onVote: (vote) => applyVote(signals, vote),
        },
        settings
      );
    } else {
      AISlop.panel.removePanel();
    }
  }
```

- [ ] **Step 4: Manual verification**

Requires a deployed backend (from the backend plan) and a completed
verification in Settings (Task 6).

1. Load `dist/chrome` unpacked, verify in Settings using a real or test
   Turnstile site key, with Backend URL pointed at the live Worker.
2. Open a YouTube watch page. Confirm the panel's "Why?" section now
   shows a "Vote human" / "Vote AI" row.
3. Click "Vote human." Confirm the button becomes disabled and reads
   "Voted human," and (after the panel refresh) a "Community: 1 👍 human,
   0 🤖 AI" line appears.
4. Reload the page. Confirm the vote state persists (the button still
   shows "Voted human").
5. On a fresh profile / with `communityApiUrl` cleared in Settings,
   confirm the community section doesn't render at all (no vote buttons,
   no error) — this is the default-off regression check.

- [ ] **Step 5: Commit**

```bash
git add src/content/panel.js src/content/content.js src/content/styles.css
git commit -m "Add community vote buttons to the watch-page panel"
```

---

### Task 8: Update root README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Roadmap: community ratings" section**

Replace the existing `## Roadmap: community ratings` section (and its
content) with:

```markdown
## Community ratings

Optional and off by default. Point Settings → Community ratings at a
deployed backend (see `backend/README.md`) and a Cloudflare Turnstile
site key to enable SponsorBlock-style voting: verify you're human once
(good for ~30 days), then vote 👍 human / 🤖 AI on individual videos from
the watch-page panel. Community votes blend into the shown score,
weighted by vote count, and are shown alongside the local heuristic's own
reasons -- never replacing your own manual trust/flag override.

Note for Firefox users: the human-verification step's sandboxed Turnstile
widget was built and tested primarily against Chrome; if it doesn't load
in Firefox, that's a known limitation (Firefox's MV3 sandbox-page support
differs from Chrome's) -- the rest of the extension, including local
heuristics, is unaffected.
```

- [ ] **Step 2: Update the "What network requests" list under Privacy**

In the `## Privacy` section, add a bullet after the existing two:

```markdown
- If you've configured a community-ratings backend URL in Settings:
  `GET <your backend URL>/score/:videoId`, `POST <your backend URL>/vote`,
  and `POST <your backend URL>/verify` — all opt-in, off by default, and
  only ever sent to the URL you typed in yourself.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the wired-up community ratings feature in the README"
```
