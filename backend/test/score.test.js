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
