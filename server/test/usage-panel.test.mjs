import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsagePanel, seriesRangeMs } from '../lib/usage-panel.mjs';

const DAY = 24 * 3600 * 1000;

test('the session limit gets a 24h series range and weekly gets 30d', () => {
  assert.equal(seriesRangeMs('Current session'), DAY);
  assert.equal(seriesRangeMs('Weekly · all models'), 30 * DAY);
});

test('an unrecognised label falls back to the 30d range rather than an empty one', () => {
  assert.equal(seriesRangeMs('Something Unexpected'), 30 * DAY);
});

test('only Weekly-prefixed labels get the seven-day pace fallback; Current session never does', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const soon = new Date(now + 3600000).toISOString();
  const parsed = {
    limits: [
      { label: 'Current session', pct: 10, resetsAt: soon },
      { label: 'Weekly · all models', pct: 20, resetsAt: soon }
    ]
  };
  const out = buildUsagePanel({ parsed, records: [], now });
  const session = out.limits.find(l => l.label === 'Current session');
  const weekly = out.limits.find(l => l.label === 'Weekly · all models');
  // No observed window and no fallback available for the session label:
  // computePace has nothing to work with.
  assert.equal(session.pace.state, 'unknown-window');
  // The weekly label gets the seven-day fallback window, so computePace can
  // actually place it relative to expected progress.
  assert.notEqual(weekly.pace.state, 'unknown-window');
});

test('a limit with resetsAt: null yields unknown-window rather than a fabricated window', () => {
  const now = Date.now();
  const parsed = { limits: [{ label: 'Weekly · Fable', pct: 0, resetsAt: null }] };
  const out = buildUsagePanel({ parsed, records: [], now });
  assert.equal(out.limits[0].pace.state, 'unknown-window');
});

test('a limit absent from some history records produces a series containing only the points that carry it', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const records = [
    // This record predates the "Weekly · all models" limit appearing at all
    // (e.g. a plan change) — it must not contribute a point to that series.
    { t: now - 2 * 3600000, limits: [{ label: 'Current session', pct: 5, resetsAt: null }] },
    { t: now - 1 * 3600000, limits: [
      { label: 'Current session', pct: 10, resetsAt: null },
      { label: 'Weekly · all models', pct: 20, resetsAt: null }
    ] }
  ];
  const parsed = { limits: [{ label: 'Weekly · all models', pct: 20, resetsAt: null }] };
  const out = buildUsagePanel({ parsed, records, now });
  const weekly = out.limits[0];
  assert.equal(weekly.series.length, 1);
  assert.equal(weekly.series[0].t, now - 1 * 3600000);
  assert.equal(weekly.series[0].pct, 20);
});
