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

test('admin endpoints fail closed when ADMIN_TOKEN is not configured', async () => {
  const { mf } = await makeTestWorker(undefined, ['ADMIN_TOKEN']);

  const noHeader = await mf.dispatchFetch('http://localhost/admin/blocklist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoId: 'vid-1', reason: 'brigaded' }),
  });
  assert.equal(noHeader.status, 401);

  const emptyHeader = await mf.dispatchFetch('http://localhost/admin/blocklist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': '' },
    body: JSON.stringify({ videoId: 'vid-1', reason: 'brigaded' }),
  });
  assert.equal(emptyHeader.status, 401);

  const guessedHeader = await mf.dispatchFetch('http://localhost/admin/blocklist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'anything' },
    body: JSON.stringify({ videoId: 'vid-1', reason: 'brigaded' }),
  });
  assert.equal(guessedHeader.status, 401);

  const del = await mf.dispatchFetch('http://localhost/admin/blocklist/vid-1', { method: 'DELETE' });
  assert.equal(del.status, 401);

  await mf.dispose();
});

test('POST /admin/blocklist rejects a malformed or oversized videoId', async () => {
  const { mf } = await makeTestWorker();
  for (const videoId of ['', 'has spaces', 'bad/slash', 'x'.repeat(33), 42]) {
    const res = await mf.dispatchFetch('http://localhost/admin/blocklist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
      body: JSON.stringify({ videoId }),
    });
    assert.equal(res.status, 400, `expected 400 for videoId ${JSON.stringify(videoId)}`);
  }
  await mf.dispose();
});

test('POST /admin/blocklist rejects an oversized reason', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/admin/blocklist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' },
    body: JSON.stringify({ videoId: 'vid-1', reason: 'x'.repeat(501) }),
  });
  assert.equal(res.status, 400);
  await mf.dispose();
});

test('DELETE /admin/blocklist/ with an empty videoId returns 400', async () => {
  const { mf } = await makeTestWorker();
  const res = await mf.dispatchFetch('http://localhost/admin/blocklist/', {
    method: 'DELETE',
    headers: { 'x-admin-token': 'test-admin-token' },
  });
  assert.equal(res.status, 400);
  await mf.dispose();
});
