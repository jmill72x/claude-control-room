// The Orbit page's helpers (src/lib/orbit/page.js): times, token figures, the
// tab in the address, the "Updated" line and the agents' colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, headerDate, compactTokens, parseRoute, routeHash, freshness, STALE_AFTER_MS, agentColors, initialOf } from '../src/lib/orbit/page.js';

const at = (d, h, min = 0) => new Date(2026, 9, d, h, min).getTime();

test('times read 9:05 AM, with noon and midnight as 12, and on the hour as 8 PM when short', () => {
  assert.equal(clock(at(21, 9, 5)), '9:05 AM');
  assert.equal(clock(at(21, 12, 0)), '12:00 PM');
  assert.equal(clock(at(21, 0, 30)), '12:30 AM');
  assert.equal(clock(at(21, 20, 0), { short: true }), '8 PM');
  assert.equal(clock(at(21, 19, 59), { short: true }), '7:59 PM');
  assert.equal(clock(NaN), '—');
  assert.equal(headerDate(at(21, 9, 5)), 'Wed 10-21 · 9:05 AM');
});

test('token figures to two or three significant digits', () => {
  assert.equal(compactTokens(950), '950');
  assert.equal(compactTokens(1200), '1.2K');
  assert.equal(compactTokens(1e6), '1M');
  assert.equal(compactTokens(58_400_000), '58M');
  assert.equal(compactTokens(445e6), '445M');
  assert.equal(compactTokens(4.2e9), '4.2B');
  assert.equal(compactTokens(null), '—');
});

test('the tab lives in the address, and an item id survives the round trip', () => {
  assert.deepEqual(parseRoute(''), { tab: 'overview', item: null });
  assert.deepEqual(parseRoute('#overview'), { tab: 'overview', item: null });
  assert.deepEqual(parseRoute('#board'), { tab: 'board', item: null });
  assert.deepEqual(parseRoute('#nowhere'), { tab: 'overview', item: null });
  for (const id of ['72e9717d-8d7c-458f-8f90-d92d9f52d693', 'a/b c', 'café#1', '50%off', '42']) {
    assert.equal(parseRoute(routeHash({ tab: 'board', item: id })).item, id);
  }
  assert.equal(routeHash({ tab: 'board' }), '#board');
  assert.equal(routeHash({ tab: 'overview', item: 'x' }), '#overview');
  assert.deepEqual(parseRoute('#board/%E0%A4%A'), { tab: 'board', item: null });
});

test('Updated: the age in plain words, amber past 3 minutes, red when the last poll failed', () => {
  const now = at(21, 9, 0);
  assert.deepEqual(freshness({ serverTime: now - 2000, receivedAt: now - 1000, now }), { tone: 'ok', label: 'Updated just now' });
  assert.deepEqual(freshness({ serverTime: now - 12_000, receivedAt: now - 1000, now }), { tone: 'ok', label: 'Updated 12 s ago' });
  assert.deepEqual(freshness({ serverTime: now - 1000, receivedAt: now - STALE_AFTER_MS - 60_000, now }), { tone: 'stale', label: 'Updated 4 min ago · not current' });
  assert.equal(freshness({ serverTime: now - STALE_AFTER_MS, receivedAt: now - STALE_AFTER_MS, now }).tone, 'ok');
  assert.deepEqual(freshness({ serverTime: now - 120_000, receivedAt: now - 120_000, error: 'HTTP 502', now }), { tone: 'down', label: "Can't reach the server · last update 2 min ago" });
  assert.deepEqual(freshness({ error: 'Failed to fetch', now }), { tone: 'down', label: "Can't reach the server" });
  assert.deepEqual(freshness({ now }), { tone: 'waiting', label: 'Loading…' });
});

test('agents take the design\'s colours by roster place, and an unknown one is grey', () => {
  assert.deepEqual(agentColors(0), { night: '#5EDCF0', day: '#0E7490' });
  assert.deepEqual(agentColors(5), { night: '#FF9F6E', day: '#C2410C' });
  assert.deepEqual(agentColors(8), agentColors(0));
  assert.deepEqual(agentColors(-1), { night: '#A9B4CB', day: '#4E5872' });
  assert.equal(initialOf('builder'), 'B');
  assert.equal(initialOf(''), '?');
});
