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

test('POST /vote rejects a malformed or oversized videoId', async () => {
  const { mf } = await makeTestWorker();
  const { token } = await mintVoteToken('client-1', 'test-vote-token-secret');
  for (const videoId of ['', 'has spaces', 'bad/slash', 'x'.repeat(33), 42, null]) {
    const res = await postVote(mf, { videoId, vote: 'ai', clientId: 'client-1' }, token);
    assert.equal(res.status, 400, `expected 400 for videoId ${JSON.stringify(videoId)}`);
  }
  await mf.dispose();
});

test('POST /vote rejects an oversized clientId or channelId', async () => {
  const { mf } = await makeTestWorker();
  const bigClientId = 'x'.repeat(129);
  const { token } = await mintVoteToken(bigClientId, 'test-vote-token-secret');

  const badClient = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: bigClientId }, token);
  assert.equal(badClient.status, 400);

  const { token: goodToken } = await mintVoteToken('client-1', 'test-vote-token-secret');
  const badChannel = await postVote(
    mf,
    { videoId: 'vid-1', channelId: 'c'.repeat(65), vote: 'ai', clientId: 'client-1' },
    goodToken
  );
  assert.equal(badChannel.status, 400);

  await mf.dispose();
});

test('POST /vote returns 500 JSON when VOTE_TOKEN_SECRET is not configured', async () => {
  const { mf } = await makeTestWorker(undefined, ['VOTE_TOKEN_SECRET']);
  const { token } = await mintVoteToken('client-1', 'test-vote-token-secret');
  const res = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: 'client-1' }, token);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { error: 'server misconfigured' });
  await mf.dispose();
});

test('POST /vote rejected before the token check does not consume rate-limit budget', async () => {
  const { mf, db } = await makeTestWorker();

  for (let i = 0; i < 5; i++) {
    const res = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: 'client-1' });
    assert.equal(res.status, 401);
  }
  const afterRejects = await db.prepare('SELECT COUNT(*) AS n FROM rate_limit').first();
  assert.equal(afterRejects.n, 0);

  const { token } = await mintVoteToken('client-1', 'test-vote-token-secret');
  const ok = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: 'client-1' }, token);
  assert.equal(ok.status, 200);
  const afterAccept = await db.prepare('SELECT SUM(count) AS n FROM rate_limit').first();
  assert.equal(afterAccept.n, 1);

  await mf.dispose();
});
