import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff, backoffDelay } from '../src/lib/backoff.ts';

test('backoff schedule 1,2,4,8,16,30,30', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map((a) => backoffDelay(a)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(backoffDelay(-1), 1000);
  assert.equal(backoffDelay(Number.NaN), 1000);
});

test('Backoff object advances and resets', () => {
  const b = new Backoff();
  assert.deepEqual([b.next(), b.next(), b.next()], [1000, 2000, 4000]);
  b.reset();
  assert.equal(b.next(), 1000);
});
