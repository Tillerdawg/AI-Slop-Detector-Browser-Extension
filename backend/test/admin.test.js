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
