import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from '../src/index.js';

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
  assert.equal(timingSafeEqual('', ''), true);
});
