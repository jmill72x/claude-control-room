import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsagePanel, seriesRangeMs, decimate, MAX_SERIES_POINTS } from '../lib/usage-panel.mjs';

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

// --- Fix round 2: tolerate the records the store deliberately admits ---

test('a record with no limits array costs that record, not the whole panel', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const records = [
    { t: now - 2 * 3600000 }, // the store admits any object with a finite t
    { t: now - 1 * 3600000, limits: [{ label: 'Current session', pct: 12, resetsAt: null }] }
  ];
  const parsed = { limits: [{ label: 'Current session', pct: 12, resetsAt: null }] };
  // Unfixed this throws, the registry catches it, and limits, pace, sparklines
  // and drivers all go unavailable until the file is hand-edited.
  const out = buildUsagePanel({ parsed, records, now });
  assert.equal(out.limits[0].series.length, 1);
  assert.equal(out.limits[0].series[0].pct, 12);
});

test('a record whose limits is not an array is skipped rather than throwing', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const records = [{ t: now - 3600000, limits: 'nonsense' }];
  const parsed = { limits: [{ label: 'Current session', pct: 5, resetsAt: null }] };
  assert.equal(buildUsagePanel({ parsed, records, now }).limits[0].series.length, 0);
});

// --- Fix round 2: the history store's health reaches the panel ---

test('the history status is carried onto the panel so the UI can say "unavailable", not "empty"', () => {
  const now = Date.now();
  const parsed = { limits: [{ label: 'Current session', pct: 5, resetsAt: null }] };
  const status = { ok: false, readError: 'EACCES', writeError: null };
  assert.deepEqual(buildUsagePanel({ parsed, records: [], now, historyStatus: status }).history, status);
});

// --- Fix round 2: server-side decimation ---

const point = (t, pct) => ({ t, pct });

test('a series shorter than the cap is passed through untouched', () => {
  const series = Array.from({ length: 10 }, (_, i) => point(i, i));
  assert.equal(decimate(series), series);
});

test('a full 30-day series is capped and still ends on the newest reading', () => {
  // One poll every five minutes for 30 days: what steady state actually looks like.
  const series = Array.from({ length: 8641 }, (_, i) => point(i * 300000, i % 100));
  const out = decimate(series);
  assert.ok(out.length <= MAX_SERIES_POINTS, `expected <= ${MAX_SERIES_POINTS}, got ${out.length}`);
  assert.deepEqual(out[out.length - 1], series[series.length - 1]);
  assert.deepEqual(out[0], series[0]);
});

test('decimation keeps real readings, in order, and never invents one', () => {
  const series = Array.from({ length: 5000 }, (_, i) => point(i * 1000, (i * 7) % 101));
  const out = decimate(series);
  const known = new Set(series.map(p => `${p.t}:${p.pct}`));
  for (const p of out) assert.ok(known.has(`${p.t}:${p.pct}`), 'every point must be one that was recorded');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t, 'points stay in time order');
});

test('a spike survives decimation rather than being averaged away', () => {
  const series = Array.from({ length: 5000 }, (_, i) => point(i * 1000, 10));
  series[2500] = point(2500 * 1000, 97);
  const out = decimate(series);
  assert.ok(out.some(p => p.pct === 97), 'the peak is the whole reason to look at the line');
});

test('buildUsagePanel decimates the series it emits', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const records = Array.from({ length: 3000 }, (_, i) => ({
    t: now - (3000 - i) * 60000,
    limits: [{ label: 'Current session', pct: i % 100, resetsAt: null }]
  }));
  const parsed = { limits: [{ label: 'Current session', pct: 50, resetsAt: null }] };
  const out = buildUsagePanel({ parsed, records, now });
  assert.ok(out.limits[0].series.length <= MAX_SERIES_POINTS);
  assert.equal(out.limits[0].series[out.limits[0].series.length - 1].t, now - 60000);
});
