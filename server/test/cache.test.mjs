import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';

test('a key never written is unavailable', () => {
  const c = createCache();
  const e = c.get('usage', Date.now());
  assert.equal(e.status, 'unavailable');
  assert.equal(e.data, null);
});

test('a fresh write is ok', () => {
  const c = createCache();
  const now = Date.now();
  c.set('usage', { pct: 5 }, now);
  assert.equal(c.get('usage', now).status, 'ok');
});

test('data older than its staleness budget goes stale but keeps its data', () => {
  const c = createCache({ budgets: { usage: 1000 } });
  const now = Date.now();
  c.set('usage', { pct: 5 }, now);
  const e = c.get('usage', now + 5000);
  assert.equal(e.status, 'stale');
  assert.deepEqual(e.data, { pct: 5 });
});

test('a failure after a good write keeps the old data and marks it stale', () => {
  const c = createCache();
  const now = Date.now();
  c.set('usage', { pct: 5 }, now);
  c.fail('usage', new Error('parse blew up'), now);
  const e = c.get('usage', now);
  assert.equal(e.status, 'stale');
  assert.deepEqual(e.data, { pct: 5 });
  assert.match(e.error, /parse blew up/);
});

test('a failure with no previous data is unavailable, never zeros', () => {
  const c = createCache();
  const now = Date.now();
  c.fail('usage', new Error('nope'), now);
  const e = c.get('usage', now);
  assert.equal(e.status, 'unavailable');
  assert.equal(e.data, null);
});

test('one key failing does not affect another', () => {
  const c = createCache();
  const now = Date.now();
  c.set('crons', [{ name: 'a' }], now);
  c.fail('usage', new Error('boom'), now);
  assert.equal(c.get('crons', now).status, 'ok');
});

test('snapshot returns an envelope per written key, and omits never-written keys rather than fabricating them', () => {
  const c = createCache({ budgets: { usage: 1000 } });
  const now = Date.now();
  c.set('usage', { pct: 5 }, now - 5000); // older than the 1000ms budget -> stale
  c.set('crons', [{ name: 'a' }], now); // fresh -> ok
  // 'sessions' is never written and must not appear in the snapshot at all.
  const snap = c.snapshot(now);
  assert.deepEqual(Object.keys(snap).sort(), ['crons', 'usage']);
  assert.equal(snap.usage.status, 'stale');
  assert.deepEqual(snap.usage.data, { pct: 5 });
  assert.equal(snap.crons.status, 'ok');
  assert.deepEqual(snap.crons.data, [{ name: 'a' }]);
});
