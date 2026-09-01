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
