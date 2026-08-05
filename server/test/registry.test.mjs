import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createRegistry } from '../collectors/registry.mjs';

const fakeTimers = () => {
  const jobs = [];
  return {
    jobs,
    setInterval: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    clearInterval: () => {}
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

test('one collector throwing leaves the others intact', async () => {
  const cache = createCache();
  const r = createRegistry(cache, fakeTimers());
  r.register('usage', async () => { throw new Error('bad'); }, 1000);
  r.register('crons', async () => [{ name: 'nightly' }], 1000);
  await Promise.all([r.runOnce('usage'), r.runOnce('crons')]);
  assert.equal(cache.get('crons', Date.now()).status, 'ok');
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

test('an overlapping run is skipped rather than stacked', async () => {
  const cache = createCache();
  const r = createRegistry(createCache(), fakeTimers());
  let started = 0;
  r.register('slow', async () => { started++; await new Promise(res => setTimeout(res, 20)); return 1; }, 1000);
  await Promise.all([r.runOnce('slow'), r.runOnce('slow')]);
  assert.equal(started, 1);
});
