import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTestWorker } from './testWorker.js';
import { verifyVoteToken } from '../src/index.js';

async function startMockTurnstile(handler, status = 200) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(status, { 'content-type': 'application/json' });
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

test('POST /verify rejects an oversized clientId', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'good-token', clientId: 'x'.repeat(129) }),
  });
  assert.equal(res.status, 400);
  await mf.dispose();
});

test('POST /verify reports 502, not a failed CAPTCHA, when Turnstile returns a non-2xx', async () => {
  const mock = await startMockTurnstile(() => ({ 'error-codes': ['internal-error'] }), 500);
  const { mf } = await makeTestWorker({ TURNSTILE_VERIFY_URL: mock.url });

  const res = await mf.dispatchFetch('http://localhost/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'good-token', clientId: 'client-123' }),
  });
  assert.equal(res.status, 502);

  await mf.dispose();
  mock.server.close();
});

test('POST /verify returns 500 JSON when VOTE_TOKEN_SECRET is not configured', async () => {
  const { mf } = await makeTestWorker(undefined, ['VOTE_TOKEN_SECRET']);
  const res = await mf.dispatchFetch('http://localhost/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'good-token', clientId: 'client-123' }),
  });
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { error: 'server misconfigured' });
  await mf.dispose();
});

test('POST /verify is rate limited per IP', async () => {
  const { mf } = await makeTestWorker();
  const send = () =>
    mf.dispatchFetch('http://localhost/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({}),
    });

  // The rate limit is 20 per window; the first 20 get as far as body validation.
  for (let i = 0; i < 20; i++) {
    assert.equal((await send()).status, 400);
  }
  assert.equal((await send()).status, 429);
  await mf.dispose();
});
