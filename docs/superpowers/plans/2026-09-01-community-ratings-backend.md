# Community Ratings — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Task 6 (deploy) needs a human.** It requires interactive `wrangler login`
> (browser OAuth) and creating a Turnstile widget in the Cloudflare
> dashboard — no subagent can complete those steps. Route Task 6 back to
> the user/interactive session rather than dispatching it.

**Goal:** Turn `backend/`'s community-ratings scaffold into a deployed
Cloudflare Worker with Turnstile-gated voting and basic moderation.

**Architecture:** One Worker (`backend/src/index.js`) fronting a D1
database. New endpoints (`/verify`, `/admin/blocklist`) layer on top of the
existing `/score` and `/vote`. Vote-tokens are stateless HMAC-signed
strings (no session table) so `/vote` stays a single fast D1 round-trip.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Web Crypto (`crypto.subtle`
HMAC-SHA256), `node --test` + [Miniflare](https://miniflare.dev) v3 for
tests.

**Spec:** [docs/superpowers/specs/2026-09-01-community-ratings-design.md](../specs/2026-09-01-community-ratings-design.md)

## Global Constraints

- Miniflare pinned to `3.20250718.3` (the current stable v3 release — npm's
  `latest` tag point to a `5.x` alpha; do not install `latest`).
- `backend/package.json`/`miniflare` devDependency is scoped to `backend/`
  only. The root project stays dependency-free; do not touch root
  `package.json`.
- Test files use ESM (`backend/package.json` sets `"type": "module"`) and
  Node's built-in `node:test` — no test framework dependency.
- All new endpoints keep the existing `access-control-allow-origin: '*'`
  CORS pattern used by `/score` and `/vote` today.
- Secrets (`IP_SALT`, `TURNSTILE_SECRET_KEY`, `VOTE_TOKEN_SECRET`,
  `ADMIN_TOKEN`) are set via `wrangler secret put`, never written to
  `wrangler.toml` or committed.

---

### Task 1: Vote-token crypto helpers

**Files:**
- Modify: `backend/src/index.js`
- Create: `backend/package.json`
- Test: `backend/test/helpers.test.js`

**Interfaces:**
- Produces (named exports from `backend/src/index.js`, used by later
  tasks and their tests):
  - `base64UrlEncode(bytes: Uint8Array): string`
  - `base64UrlDecode(str: string): Uint8Array`
  - `timingSafeEqual(a: string, b: string): boolean`
  - `hmacSign(payload: string, secret: string): Promise<string>`
  - `mintVoteToken(clientId: string, secret: string): Promise<{token: string, expiresAt: number}>`
  - `verifyVoteToken(token: string, clientId: string, secret: string): Promise<boolean>`

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "ai-slop-detector-backend",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/test/helpers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64UrlEncode,
  base64UrlDecode,
  hmacSign,
  mintVoteToken,
  verifyVoteToken,
  timingSafeEqual,
} from '../src/index.js';

test('base64UrlEncode/base64UrlDecode round-trips arbitrary bytes', () => {
  const original = new TextEncoder().encode('hello world! ünïcödé');
  const encoded = base64UrlEncode(original);
  assert.ok(!encoded.includes('+') && !encoded.includes('/') && !encoded.includes('='));
  const decoded = base64UrlDecode(encoded);
  assert.deepEqual([...decoded], [...original]);
});

test('mintVoteToken + verifyVoteToken round-trip for the same clientId', async () => {
  const { token, expiresAt } = await mintVoteToken('client-123', 'test-secret');
  assert.ok(expiresAt > Date.now());
  const valid = await verifyVoteToken(token, 'client-123', 'test-secret');
  assert.equal(valid, true);
});

test('verifyVoteToken rejects a token minted for a different clientId', async () => {
  const { token } = await mintVoteToken('client-123', 'test-secret');
  const valid = await verifyVoteToken(token, 'someone-else', 'test-secret');
  assert.equal(valid, false);
});

test('verifyVoteToken rejects a tampered signature', async () => {
  const { token } = await mintVoteToken('client-123', 'test-secret');
  const [payload] = token.split('.');
  const tampered = `${payload}.not-the-real-signature`;
  const valid = await verifyVoteToken(tampered, 'client-123', 'test-secret');
  assert.equal(valid, false);
});

test('verifyVoteToken rejects an expired token', async () => {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ clientId: 'client-123', exp: Date.now() - 1000 }))
  );
  const sig = await hmacSign(payload, 'test-secret');
  const expiredToken = `${payload}.${sig}`;
  const valid = await verifyVoteToken(expiredToken, 'client-123', 'test-secret');
  assert.equal(valid, false);
});

test('verifyVoteToken rejects a token signed with the wrong secret', async () => {
  const { token } = await mintVoteToken('client-123', 'test-secret');
  const valid = await verifyVoteToken(token, 'client-123', 'a-different-secret');
  assert.equal(valid, false);
});

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
  assert.equal(timingSafeEqual('', ''), true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `SyntaxError` / import error, since `base64UrlEncode` etc.
aren't exported from `src/index.js` yet.

- [ ] **Step 4: Implement the helpers**

In `backend/src/index.js`, add near the top (after the existing
`RATE_LIMIT_*` constants, before `handleGetScore`):

```js
const VOTE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- base64url + HMAC vote-token helpers -----------------------------------

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(sig));
}

async function mintVoteToken(clientId, secret) {
  const exp = Date.now() + VOTE_TOKEN_TTL_MS;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ clientId, exp })));
  const sig = await hmacSign(payload, secret);
  return { token: `${payload}.${sig}`, expiresAt: exp };
}

async function verifyVoteToken(token, clientId, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expectedSig = await hmacSign(payload, secret);
  if (!timingSafeEqual(sig, expectedSig)) return false;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch (e) {
    return false;
  }
  if (!parsed || parsed.clientId !== clientId) return false;
  if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return false;
  return true;
}
```

At the bottom of the file, after the existing `export default { ... }`,
add:

```js
export { base64UrlEncode, base64UrlDecode, hmacSign, mintVoteToken, verifyVoteToken, timingSafeEqual };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/src/index.js backend/test/helpers.test.js
git commit -m "Add vote-token crypto helpers for community-ratings backend"
```

---

### Task 2: Test harness + blocklist table + blocklist-aware GET /score

**Files:**
- Modify: `backend/schema.sql`
- Modify: `backend/src/index.js`
- Modify: `backend/package.json`
- Create: `backend/test/testWorker.js`
- Test: `backend/test/score.test.js`

**Interfaces:**
- Consumes: none from Task 1 directly (this task's new code doesn't call
  the crypto helpers).
- Produces:
  - `makeTestWorker(bindings?): Promise<{mf: Miniflare, db: D1Database}>`
    (`backend/test/testWorker.js`) — used by every subsequent test file.
  - `isBlocklisted(env, videoId): Promise<boolean>` (internal to
    `index.js`, not exported — later tasks call it directly within the
    same file).

- [ ] **Step 1: Install the test harness dependency**

```bash
cd backend && npm install --save-dev miniflare@3.20250718.3
```

This updates `backend/package.json` and creates `backend/package-lock.json`.

- [ ] **Step 2: Create the shared Miniflare test harness**

Create `backend/test/testWorker.js`:

```js
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(ROOT, '..', 'src', 'index.js');
const SCHEMA_PATH = path.join(ROOT, '..', 'schema.sql');

const DEFAULT_BINDINGS = {
  IP_SALT: 'test-ip-salt',
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
  VOTE_TOKEN_SECRET: 'test-vote-token-secret',
  ADMIN_TOKEN: 'test-admin-token',
};

// D1's .exec() splits on newlines and chokes on comment-only lines, so
// schema.sql (which has both) can't be applied with a single .exec() call.
// Strip `--` comment lines, then run each `;`-separated statement via
// .prepare().run() instead.
function splitStatements(sql) {
  const noComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return noComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function makeTestWorker(bindings) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_PATH,
    d1Databases: ['DB'],
    bindings: Object.assign({}, DEFAULT_BINDINGS, bindings || {}),
  });
  const db = await mf.getD1Database('DB');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  for (const statement of splitStatements(schema)) {
    await db.prepare(statement).run();
  }
  return { mf, db };
}
```

- [ ] **Step 3: Write the failing test**

Create `backend/test/score.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestWorker } from './testWorker.js';

test('GET /score/:videoId returns zero counts for a video with no votes', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/score/vid-empty');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, {
    videoId: 'vid-empty',
    blocked: false,
    aiVotes: 0,
    humanVotes: 0,
    total: 0,
    communityScore: null,
  });
  await mf.dispose();
});

test('GET /score/:videoId aggregates votes and computes communityScore', async () => {
  const { mf, db } = await makeTestWorker();
  const now = Date.now();
  for (const [vote, clientId] of [['ai', 'client-a'], ['human', 'client-b'], ['ai', 'client-c']]) {
    await db
      .prepare('INSERT INTO votes (video_id, channel_id, vote, client_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('vid-1', 'chan-1', vote, clientId, now)
      .run();
  }

  const res = await mf.dispatchFetch('http://localhost/score/vid-1');
  const body = await res.json();
  assert.equal(body.aiVotes, 2);
  assert.equal(body.humanVotes, 1);
  assert.equal(body.total, 3);
  assert.equal(body.communityScore, 67); // round(2/3 * 100)
  await mf.dispose();
});

test('GET /score/:videoId suppresses vote data for a blocklisted video', async () => {
  const { mf, db } = await makeTestWorker();
  await db
    .prepare('INSERT INTO votes (video_id, channel_id, vote, client_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('vid-bad', 'chan-1', 'ai', 'client-a', Date.now())
    .run();
  await db
    .prepare('INSERT INTO blocklist (video_id, reason, created_at) VALUES (?, ?, ?)')
    .bind('vid-bad', 'brigaded', Date.now())
    .run();

  const res = await mf.dispatchFetch('http://localhost/score/vid-bad');
  const body = await res.json();
  assert.equal(body.blocked, true);
  assert.equal(body.communityScore, null);
  assert.equal(body.total, 0);
  await mf.dispose();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: first two tests PASS (harness works against the existing,
already-implemented `/score` endpoint); the third FAILS — `blocklist`
table doesn't exist yet, so `db.prepare('INSERT INTO blocklist ...')`
throws.

- [ ] **Step 5: Add the blocklist table**

Append to `backend/schema.sql`:

```sql

-- Operator-maintained list of videos whose community score is suppressed
-- (e.g. after a brigading incident). Checked by GET /score and POST /vote.
CREATE TABLE IF NOT EXISTS blocklist (
  video_id   TEXT PRIMARY KEY,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
```

- [ ] **Step 6: Wire the blocklist check into `handleGetScore`**

In `backend/src/index.js`, add this function above `handleGetScore`:

```js
async function isBlocklisted(env, videoId) {
  const row = await env.DB.prepare('SELECT video_id FROM blocklist WHERE video_id = ?').bind(videoId).first();
  return !!row;
}
```

Replace the existing `handleGetScore` function body:

```js
async function handleGetScore(env, videoId) {
  if (await isBlocklisted(env, videoId)) {
    return json({ videoId, blocked: true, aiVotes: 0, humanVotes: 0, total: 0, communityScore: null });
  }
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN vote = 'ai' THEN 1 ELSE 0 END) AS ai_votes,
       SUM(CASE WHEN vote = 'human' THEN 1 ELSE 0 END) AS human_votes
     FROM votes WHERE video_id = ?`
  )
    .bind(videoId)
    .first();
  const aiVotes = (row && row.ai_votes) || 0;
  const humanVotes = (row && row.human_votes) || 0;
  const total = aiVotes + humanVotes;
  return json({
    videoId,
    blocked: false,
    aiVotes,
    humanVotes,
    total,
    communityScore: total > 0 ? Math.round((aiVotes / total) * 100) : null,
  });
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all tests in `score.test.js`)

- [ ] **Step 8: Commit**

```bash
git add backend/schema.sql backend/src/index.js backend/package.json backend/package-lock.json backend/test/testWorker.js backend/test/score.test.js
git commit -m "Add blocklist table and Miniflare-based test harness for the backend"
```

---

### Task 3: POST /verify (Turnstile verification + vote-token minting)

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/test/verify.test.js`

**Interfaces:**
- Consumes: `mintVoteToken`, `verifyVoteToken` (Task 1); `makeTestWorker`
  (Task 2).
- Produces: `POST /verify` route, live in the router built out in Task 5.

- [ ] **Step 1: Write the failing test**

Create `backend/test/verify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTestWorker } from './testWorker.js';
import { verifyVoteToken } from '../src/index.js';

async function startMockTurnstile(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(parsed)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}` };
}

test('POST /verify mints a vote token when Turnstile approves', async () => {
  const mock = await startMockTurnstile(() => ({ success: true }));
  const { mf } = await makeTestWorker({ TURNSTILE_VERIFY_URL: mock.url });

  const res = await mf.dispatchFetch('http://localhost/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'good-token', clientId: 'client-123' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.voteToken);
  assert.ok(body.expiresAt > Date.now());

  const valid = await verifyVoteToken(body.voteToken, 'client-123', 'test-vote-token-secret');
  assert.equal(valid, true);

  await mf.dispose();
  mock.server.close();
});

test('POST /verify rejects when Turnstile denies', async () => {
  const mock = await startMockTurnstile(() => ({ success: false }));
  const { mf } = await makeTestWorker({ TURNSTILE_VERIFY_URL: mock.url });

  const res = await mf.dispatchFetch('http://localhost/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'bad-token', clientId: 'client-123' }),
  });
  assert.equal(res.status, 403);

  await mf.dispose();
  mock.server.close();
});

test('POST /verify requires turnstileToken and clientId', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  await mf.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `/verify` returns 404 (route doesn't exist yet).

- [ ] **Step 3: Implement `handleVerify` and wire the route**

In `backend/src/index.js`, add near the top (with the other constants):

```js
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
```

Add this function above the `export default` block:

```js
async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }
  const { turnstileToken, clientId } = body || {};
  if (!turnstileToken || !clientId) {
    return json({ error: 'turnstileToken and clientId are required' }, 400);
  }

  const verifyUrl = env.TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY_URL;
  let verifyResult;
  try {
    const resp = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: turnstileToken }),
    });
    verifyResult = await resp.json();
  } catch (e) {
    return json({ error: 'turnstile verification unreachable' }, 502);
  }
  if (!verifyResult || !verifyResult.success) {
    return json({ error: 'turnstile verification failed' }, 403);
  }

  const { token, expiresAt } = await mintVoteToken(clientId, env.VOTE_TOKEN_SECRET || '');
  return json({ voteToken: token, expiresAt });
}
```

In the `export default { async fetch(request, env) { ... } }` block, add
this branch (right after the existing `/score/` branch):

```js
    if (request.method === 'POST' && url.pathname === '/verify') {
      return handleVerify(request, env);
    }
```

Also update the `OPTIONS` preflight response's `access-control-allow-methods`
to include `PUT`... actually no PUT is used; leave `GET, POST, OPTIONS` as
is for now (DELETE gets added in Task 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/test/verify.test.js
git commit -m "Add POST /verify: Turnstile-gated vote-token minting"
```

---

### Task 4: Require a valid vote-token on POST /vote; reject blocklisted videos

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/test/vote.test.js`

**Interfaces:**
- Consumes: `mintVoteToken`, `verifyVoteToken` (Task 1); `isBlocklisted`
  (Task 2, same file); `makeTestWorker` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `backend/test/vote.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestWorker } from './testWorker.js';
import { mintVoteToken } from '../src/index.js';

async function postVote(mf, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-vote-token'] = token;
  return mf.dispatchFetch('http://localhost/vote', { method: 'POST', headers, body: JSON.stringify(body) });
}

test('POST /vote rejects a request with no vote token', async () => {
  const { mf } = await makeTestWorker();
  const res = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: 'client-1' });
  assert.equal(res.status, 401);
  await mf.dispose();
});

test('POST /vote rejects a vote token minted for a different clientId', async () => {
  const { mf } = await makeTestWorker();
  const { token } = await mintVoteToken('someone-else', 'test-vote-token-secret');
  const res = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: 'client-1' }, token);
  assert.equal(res.status, 401);
  await mf.dispose();
});

test('POST /vote records a vote and returns updated counts with a valid token', async () => {
  const { mf } = await makeTestWorker();
  const { token } = await mintVoteToken('client-1', 'test-vote-token-secret');
  const res = await postVote(
    mf,
    { videoId: 'vid-1', channelId: 'chan-1', vote: 'human', clientId: 'client-1' },
    token
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.humanVotes, 1);
  assert.equal(body.total, 1);
  await mf.dispose();
});

test('POST /vote rejects voting on a blocklisted video', async () => {
  const { mf, db } = await makeTestWorker();
  await db
    .prepare('INSERT INTO blocklist (video_id, reason, created_at) VALUES (?, ?, ?)')
    .bind('vid-bad', 'brigaded', Date.now())
    .run();
  const { token } = await mintVoteToken('client-1', 'test-vote-token-secret');
  const res = await postVote(mf, { videoId: 'vid-bad', vote: 'ai', clientId: 'client-1' }, token);
  assert.equal(res.status, 403);
  await mf.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — today `/vote` has no vote-token check, so the first two
tests (expecting 401) fail; the blocklist test also fails (expecting 403,
gets 200).

- [ ] **Step 3: Update `handlePostVote`**

Replace the existing `handlePostVote` function body in
`backend/src/index.js`:

```js
async function handlePostVote(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const allowed = await checkRateLimit(env, ip);
  if (!allowed) return json({ error: 'rate limited' }, 429);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }
  const { videoId, channelId, vote, clientId } = body || {};
  if (!videoId || !clientId || (vote !== 'ai' && vote !== 'human')) {
    return json({ error: 'videoId, clientId, and vote ("ai"|"human") are required' }, 400);
  }

  const voteToken = request.headers.get('x-vote-token');
  const validToken = await verifyVoteToken(voteToken, clientId, env.VOTE_TOKEN_SECRET || '');
  if (!validToken) return json({ error: 'not verified' }, 401);

  if (await isBlocklisted(env, videoId)) {
    return json({ error: 'video is blocklisted' }, 403);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO votes (video_id, channel_id, vote, client_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(video_id, client_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`
    )
      .bind(videoId, channelId || null, vote, clientId, Date.now())
      .run();
  } catch (e) {
    return json({ error: 'write failed' }, 500);
  }
  return handleGetScore(env, videoId);
}
```

(Only the two new blocks — the vote-token check and the blocklist check —
are new; the rest is unchanged from the existing implementation.)

Also update the OPTIONS preflight headers to allow the new request header:

```js
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, x-vote-token, x-admin-token',
        },
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/test/vote.test.js
git commit -m "Require a valid vote-token on POST /vote; reject blocklisted videos"
```

---

### Task 5: Admin blocklist endpoints

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/test/admin.test.js`

**Interfaces:**
- Consumes: `timingSafeEqual` (Task 1), `makeTestWorker` (Task 2).
- Produces: `POST /admin/blocklist`, `DELETE /admin/blocklist/:videoId`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/admin.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestWorker } from './testWorker.js';

test('POST /admin/blocklist requires a valid admin token', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/admin/blocklist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'wrong' },
    body: JSON.stringify({ videoId: 'vid-1', reason: 'brigaded' }),
  });
  assert.equal(res.status, 401);
  await mf.dispose();
});

test('POST /admin/blocklist adds a video, then GET /score reflects it', async () => {
  const { mf } = await makeTestWorker();
  const addRes = await mf.dispatchFetch('http://localhost/admin/blocklist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
    body: JSON.stringify({ videoId: 'vid-1', reason: 'brigaded' }),
  });
  assert.equal(addRes.status, 200);

  const scoreRes = await mf.dispatchFetch('http://localhost/score/vid-1');
  const scoreBody = await scoreRes.json();
  assert.equal(scoreBody.blocked, true);
  await mf.dispose();
});

test('DELETE /admin/blocklist/:videoId removes a video from the blocklist', async () => {
  const { mf, db } = await makeTestWorker();
  await db
    .prepare('INSERT INTO blocklist (video_id, reason, created_at) VALUES (?, ?, ?)')
    .bind('vid-1', 'brigaded', Date.now())
    .run();

  const delRes = await mf.dispatchFetch('http://localhost/admin/blocklist/vid-1', {
    method: 'DELETE',
    headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(delRes.status, 200);

  const scoreRes = await mf.dispatchFetch('http://localhost/score/vid-1');
  const scoreBody = await scoreRes.json();
  assert.equal(scoreBody.blocked, false);
  await mf.dispose();
});

test('DELETE /admin/blocklist/:videoId requires a valid admin token', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/admin/blocklist/vid-1', {
    method: 'DELETE',
    headers: { 'x-admin-token': 'wrong' },
  });
  assert.equal(res.status, 401);
  await mf.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — both `/admin/blocklist` routes return 404.

- [ ] **Step 3: Implement the admin handlers and wire the routes**

Add these functions to `backend/src/index.js`, above the `export default`
block:

```js
function checkAdmin(request, env) {
  const token = request.headers.get('x-admin-token') || '';
  return timingSafeEqual(token, env.ADMIN_TOKEN || '');
}

async function handleAddBlocklist(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }
  const { videoId, reason } = body || {};
  if (!videoId) return json({ error: 'videoId is required' }, 400);
  await env.DB.prepare(
    `INSERT INTO blocklist (video_id, reason, created_at) VALUES (?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`
  )
    .bind(videoId, reason || null, Date.now())
    .run();
  return json({ ok: true, videoId });
}

async function handleRemoveBlocklist(request, env, videoId) {
  if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  await env.DB.prepare('DELETE FROM blocklist WHERE video_id = ?').bind(videoId).run();
  return json({ ok: true, videoId });
}
```

In the router (`export default { async fetch(request, env) { ... } }`),
add these two branches after the `/verify` branch:

```js
    if (request.method === 'POST' && url.pathname === '/admin/blocklist') {
      return handleAddBlocklist(request, env);
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/admin/blocklist/')) {
      return handleRemoveBlocklist(request, env, decodeURIComponent(url.pathname.slice('/admin/blocklist/'.length)));
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all test files — run the full suite: `cd backend && npm test`)

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/test/admin.test.js
git commit -m "Add admin blocklist endpoints for moderating brigaded videos"
```

---

### Task 6: Update docs and deploy (human-in-the-loop)

**This task cannot be completed by an autonomous subagent.** `wrangler
login` opens an interactive browser OAuth flow, and creating a Turnstile
widget requires clicking through the Cloudflare dashboard. Hand this task
to the user or run it in the interactive session.

**Files:**
- Modify: `backend/README.md`

- [ ] **Step 1: Rewrite `backend/README.md`**

Replace the full contents of `backend/README.md` with:

```markdown
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
  `clientId`. No DB row: the signature itself is the proof.
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
```

- [ ] **Step 2: Deploy following the README's steps**

Follow "Deploying" steps 1-7 above, interactively, using your own
Cloudflare account.

- [ ] **Step 3: Verify the live deployment**

```bash
curl https://<your-worker-url>/score/nonexistent-video
```

Expected: `{"videoId":"nonexistent-video","blocked":false,"aiVotes":0,"humanVotes":0,"total":0,"communityScore":null}`

```bash
curl -X POST https://<your-worker-url>/admin/blocklist \
  -H "content-type: application/json" \
  -H "x-admin-token: <your ADMIN_TOKEN>" \
  -d '{"videoId": "smoke-test", "reason": "testing"}'
curl https://<your-worker-url>/score/smoke-test
```

Expected second call: `"blocked":true`. Then remove it:

```bash
curl -X DELETE https://<your-worker-url>/admin/blocklist/smoke-test \
  -H "x-admin-token: <your ADMIN_TOKEN>"
```

- [ ] **Step 4: Commit the README update**

```bash
git add backend/README.md
git commit -m "Document deployed community-ratings backend endpoints and moderation"
```
