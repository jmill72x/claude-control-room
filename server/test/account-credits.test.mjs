import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountCredits, MAX_CACHE_AGE_MS } from '../lib/account-credits.mjs';
import { collectAccountCredits } from '../collectors/account-credits.mjs';

const NOW = Date.parse('2026-09-28T15:00:00Z');
const bucket = over => ({ utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null, ...over });
// Shape of `cachedUsageUtilization` in ~/.claude.json as captured on this
// machine 2026-09-28, trimmed to the fields that matter.
const state = over => ({
  cachedUsageUtilization: {
    fetchedAtMs: NOW - 2 * 60000,
    accountUuid: 'must-never-leave-the-parser',
    utilization: {
      five_hour: bucket({ utilization: 15, resets_at: '2026-09-28T17:50:00Z' }),
      iguana_necktie: bucket({ resets_at: '2026-11-05T07:59:00+00:00', limit_dollars: 250, used_dollars: 0, remaining_dollars: 250 }),
      omelette_promotional: null,
      extra_usage: { is_enabled: false },
      spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, balance: null, enabled: false }
    },
    ...over
  }
});

test('a dollar-limited bucket is reported as a grant, with the cloud-session codename labelled', () => {
  const out = parseAccountCredits(state(), NOW);
  assert.deepEqual(out.grants, [{
    id: 'iguana_necktie', label: 'Cloud session credits',
    limit: 250, used: 0, remaining: 250, expiresAt: '2026-11-05T07:59:00+00:00'
  }]);
});

test('percentage-only buckets and empty buckets are not grants', () => {
  const out = parseAccountCredits(state(), NOW);
  assert.ok(!out.grants.some(g => g.id === 'five_hour' || g.id === 'omelette_promotional'));
});

test('an unrecognised dollar bucket is still shown, under a neutral label rather than an invented one', () => {
  const s = state();
  s.cachedUsageUtilization.utilization.copper_kite = bucket({ limit_dollars: 40, used_dollars: 10, remaining_dollars: 30 });
  const g = parseAccountCredits(s, NOW).grants.find(x => x.id === 'copper_kite');
  assert.equal(g.label, 'Included credit');
  assert.equal(g.remaining, 30);
});

test('a promotional bucket that carries dollars is labelled as promotional', () => {
  const s = state();
  s.cachedUsageUtilization.utilization.omelette_promotional = bucket({ limit_dollars: 50, used_dollars: 5, remaining_dollars: 45, resets_at: '2026-10-01T00:00:00Z' });
  assert.equal(parseAccountCredits(s, NOW).grants.find(g => g.id === 'omelette_promotional').label, 'Promotional credit');
});

test('usage-credit balance: null stays unknown, minor units are converted, plain numbers pass through', () => {
  assert.equal(parseAccountCredits(state(), NOW).usageCredits.balance, null);
  const minor = state(); minor.cachedUsageUtilization.utilization.spend.balance = { amount_minor: 1250, currency: 'USD', exponent: 2 };
  assert.equal(parseAccountCredits(minor, NOW).usageCredits.balance, 12.5);
  const plain = state(); plain.cachedUsageUtilization.utilization.spend.balance = 7;
  assert.equal(parseAccountCredits(plain, NOW).usageCredits.balance, 7);
});

test('the account id and every other field are dropped at the parse boundary', () => {
  const out = parseAccountCredits(state(), NOW);
  assert.ok(!JSON.stringify(out).includes('must-never-leave-the-parser'));
  assert.deepEqual(Object.keys(out).sort(), ['asOf', 'grants', 'usageCredits']);
});

test('a cache older than the budget is refused, so a dead poll never passes for a current balance', () => {
  const old = state({ fetchedAtMs: NOW - MAX_CACHE_AGE_MS - 1 });
  assert.throws(() => parseAccountCredits(old, NOW), /older than/);
});

test('a missing cache is an error, never an empty set of grants', () => {
  assert.throws(() => parseAccountCredits({}, NOW), /no cached usage/);
  assert.throws(() => parseAccountCredits(null, NOW), /no cached usage/);
});

test('the collector reads the state file through its seam and returns the parsed credits', async () => {
  const out = await collectAccountCredits({ read: async () => JSON.stringify(state()), now: () => NOW });
  assert.equal(out.grants[0].label, 'Cloud session credits');
});
