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
