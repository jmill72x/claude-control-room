// Regression coverage for the invariant: a panel's staleness budget must
// always exceed the interval at which its collector runs. The `plan`
// collector runs hourly but had no DEFAULT_BUDGETS entry, so it fell back to
// FALLBACK_BUDGET (5 minutes) and was marked stale for 55 minutes of every
// hour despite holding perfectly good data. These tests exercise the real
// registry+cache wiring (not just cache.mjs in isolation) so they actually
// catch a regression in how registration informs the budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createRegistry } from '../collectors/registry.mjs';

const fakeTimers = () => ({
  setInterval: () => 0,
  clearInterval: () => {}
});

test('a collector on a long interval is not stale shortly after a successful write (the live plan bug)', async () => {
  const cache = createCache();
  const registry = createRegistry(cache, fakeTimers());
  const intervalMs = 60 * 60 * 1000; // plan's real interval: hourly
  registry.register('plan', async () => ({ tier: 'max' }), intervalMs);

  const writeTime = Date.now();
  await registry.runOnce('plan');

  // 10 minutes on: well past the old FALLBACK_BUDGET of 5 minutes, nowhere
  // near the hourly interval. Under the pre-fix code this reads 'stale' —
  // that is exactly the bug observed live.
  const tenMinutesLater = writeTime + 10 * 60 * 1000;
  const envelope = cache.get('plan', tenMinutesLater);
  assert.equal(envelope.status, 'ok');
  assert.deepEqual(envelope.data, { tier: 'max' });
});

test('a registered collector does go stale after ~2x its interval', async () => {
  const cache = createCache();
  const registry = createRegistry(cache, fakeTimers());
  const intervalMs = 60 * 60 * 1000;
  registry.register('plan', async () => ({ tier: 'max' }), intervalMs);

  const writeTime = Date.now();
  await registry.runOnce('plan');

  const justUnderTwoIntervals = writeTime + 2 * intervalMs - 1000;
  assert.equal(cache.get('plan', justUnderTwoIntervals).status, 'ok');

  const justOverTwoIntervals = writeTime + 2 * intervalMs + 1000;
  assert.equal(cache.get('plan', justOverTwoIntervals).status, 'stale');
});

test('an explicit budgets override passed to createCache still wins over the derived value', async () => {
  const cache = createCache({ budgets: { plan: 1000 } }); // 1 second, deliberately tiny
  const registry = createRegistry(cache, fakeTimers());
  const intervalMs = 60 * 60 * 1000; // derived would be 2 hours; override must win
  registry.register('plan', async () => ({ tier: 'max' }), intervalMs);

  const writeTime = Date.now();
  await registry.runOnce('plan');

  const justOverOneSecond = writeTime + 1500;
  assert.equal(cache.get('plan', justOverOneSecond).status, 'stale');
});

test('an ingest key with no registered collector still uses the default/fallback budget', () => {
  const cache = createCache();
  // ingestCredits is written by an HTTP POST, never registered with a
  // registry, so there is no derived budget for it — it must fall through to
  // DEFAULT_BUDGETS/FALLBACK_BUDGET exactly as before this change.
  const now = Date.now();
  cache.set('ingestCredits', { balance: 42 }, now);

  const justUnderFallback = now + 5 * 60 * 1000 - 1000;
  assert.equal(cache.get('ingestCredits', justUnderFallback).status, 'ok');

  const justOverFallback = now + 5 * 60 * 1000 + 1000;
  assert.equal(cache.get('ingestCredits', justOverFallback).status, 'stale');
});
