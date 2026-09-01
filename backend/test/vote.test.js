import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestWorker } from './testWorker.js';

async function postVote(mf, body) {
  return mf.dispatchFetch('http://localhost/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /vote records a vote and returns updated counts', async () => {
  const { mf } = await makeTestWorker();
  const res = await postVote(mf, { videoId: 'vid-1', channelId: 'chan-1', vote: 'human', clientId: 'client-1' });
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
  const res = await postVote(mf, { videoId: 'vid-bad', vote: 'ai', clientId: 'client-1' });
  assert.equal(res.status, 403);
  await mf.dispose();
});

test('POST /vote rejects a malformed or oversized videoId', async () => {
  const { mf } = await makeTestWorker();
  for (const videoId of ['', 'has spaces', 'bad/slash', 'x'.repeat(33), 42, null]) {
    const res = await postVote(mf, { videoId, vote: 'ai', clientId: 'client-1' });
    assert.equal(res.status, 400, `expected 400 for videoId ${JSON.stringify(videoId)}`);
  }
  await mf.dispose();
});

test('POST /vote rejects an oversized clientId or channelId', async () => {
  const { mf } = await makeTestWorker();

  const badClient = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: 'x'.repeat(129) });
  assert.equal(badClient.status, 400);

  const badChannel = await postVote(mf, {
    videoId: 'vid-1',
    channelId: 'c'.repeat(65),
    vote: 'ai',
    clientId: 'client-1',
  });
  assert.equal(badChannel.status, 400);

  await mf.dispose();
});

test('POST /vote consumes per-IP-hash rate-limit budget', async () => {
  // With no human-verification step, the rate limit is one of only two
  // things standing between the endpoint and casual vote-stuffing, so
  // assert it actually counts.
  const { mf, db } = await makeTestWorker();
  for (let i = 0; i < 3; i++) {
    const res = await postVote(mf, { videoId: 'vid-1', vote: 'ai', clientId: `client-${i}` });
    assert.equal(res.status, 200);
  }
  const row = await db.prepare('SELECT SUM(count) AS n FROM rate_limit').first();
  assert.equal(row.n, 3);
  await mf.dispose();
});
