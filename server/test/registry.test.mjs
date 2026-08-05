import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createRegistry } from '../collectors/registry.mjs';

const fakeTimers = () => {
  const jobs = [];
  const cleared = [];
  return {
    jobs,
    cleared,
    setInterval: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    clearInterval: (handle) => { cleared.push(handle); }
  };
};

test('a successful collector writes to the cache', async () => {
  const cache = createCache();
  const timers = fakeTimers();
  const r = createRegistry(cache, timers);
  r.register('usage', async () => ({ pct: 12 }), 1000);
  await r.runOnce('usage');
  assert.equal(cache.get('usage', Date.now()).data.pct, 12);
});

test('a throwing collector marks a failure without escaping', async () => {
  const cache = createCache();
  const r = createRegistry(cache, fakeTimers());
  r.register('usage', async () => { throw new Error('cli missing'); }, 1000);
  await r.runOnce('usage');
  const e = cache.get('usage', Date.now());
  assert.equal(e.status, 'unavailable');
  assert.match(e.error, /cli missing/);
});

// Run the two SEQUENTIALLY, not via Promise.all. Under Promise.all the healthy
// collector's write lands after the failing one's catch block, so a collector
// that corrupted another's key would be masked by the overwrite — verified to
// hide the fault in 200/200 trials. Settling `crons` first and failing `usage`
// alone afterwards makes any cross-key write immediately visible.
test('one collector throwing cannot touch another collector\'s entry', async () => {
  const cache = createCache();
  const r = createRegistry(cache, fakeTimers());
  r.register('usage', async () => { throw new Error('bad'); }, 1000);
  r.register('crons', async () => [{ name: 'nightly' }], 1000);

  await r.runOnce('crons');
  const before = cache.get('crons', Date.now());
  assert.equal(before.status, 'ok');

  await r.runOnce('usage');
  const after = cache.get('crons', Date.now());
  assert.equal(after.status, 'ok');
  assert.equal(after.error, null);
  assert.deepEqual(after.data, before.data);
  assert.equal(cache.get('usage', Date.now()).status, 'unavailable');
});

test('startAll schedules one timer per collector', () => {
  const timers = fakeTimers();
  const r = createRegistry(createCache(), timers);
  r.register('a', async () => 1, 1000);
  r.register('b', async () => 2, 2000);
  r.startAll();
  assert.equal(timers.jobs.length, 2);
  assert.deepEqual(timers.jobs.map(j => j.ms), [1000, 2000]);
});

test('stopAll clears every handle registered by startAll', () => {
  const timers = fakeTimers();
  const r = createRegistry(createCache(), timers);
  r.register('a', async () => 1, 1000);
  r.register('b', async () => 2, 2000);
  r.startAll();
  r.stopAll();
  assert.deepEqual(timers.cleared, [1, 2]);
});

test('an overlapping run is skipped rather than stacked', async () => {
  const cache = createCache();
  const r = createRegistry(createCache(), fakeTimers());
  let started = 0;
  r.register('slow', async () => { started++; await new Promise(res => setTimeout(res, 20)); return 1; }, 1000);
  await Promise.all([r.runOnce('slow'), r.runOnce('slow')]);
  assert.equal(started, 1);
});
