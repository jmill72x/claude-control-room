import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../history.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ccr-hist-'));
const rec = (t, pct) => ({ t, limits: [{ label: 'Current session', pct, resetsAt: null }] });

test('append writes a JSONL line and recent reads it back', async () => {
  // now is pinned near the synthetic timestamps below: the default 30-day
  // retention window is measured against real wall-clock time otherwise,
  // and these near-epoch fixture values would be trimmed away immediately.
  const h = createHistory({ dir: dir(), now: () => 100_000 });
  await h.append(rec(1000, 5));
  assert.deepEqual(h.recent(0), [rec(1000, 5)]);
});

test('recent filters by cutoff', async () => {
  const h = createHistory({ dir: dir(), now: () => 100_000 });
  await h.append(rec(1000, 5));
  await h.append(rec(5000, 9));
  assert.equal(h.recent(2000).length, 1);
  assert.equal(h.recent(2000)[0].pct ?? h.recent(2000)[0].limits[0].pct, 9);
});

test('records are stored in the month file their own timestamp belongs to', async () => {
  const d = dir();
  const h = createHistory({ dir: d });
  const jan = Date.parse('2026-01-15T12:00:00Z');
  const feb = Date.parse('2026-02-02T12:00:00Z');
  await h.append(rec(jan, 1));
  await h.append(rec(feb, 2));
  assert.match(h.monthFile(jan), /2026-01\.jsonl$/);
  assert.match(h.monthFile(feb), /2026-02\.jsonl$/);
  assert.equal(readFileSync(h.monthFile(jan), 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(h.monthFile(feb), 'utf8').trim().split('\n').length, 1);
});

test('warm reads the current and previous month files from disk', async () => {
  const d = dir();
  const now = Date.parse('2026-02-10T00:00:00Z');
  const h1 = createHistory({ dir: d, now: () => now });
  await h1.append(rec(Date.parse('2026-01-20T00:00:00Z'), 1));
  await h1.append(rec(Date.parse('2026-02-05T00:00:00Z'), 2));

  const h2 = createHistory({ dir: d, now: () => now, retentionMs: 365 * 24 * 3600 * 1000 });
  await h2.warm();
  assert.equal(h2.recent(0).length, 2);
});

test('warm skips corrupt lines rather than throwing', async () => {
  const d = dir();
  const now = Date.parse('2026-02-10T00:00:00Z');
  const h = createHistory({ dir: d, now: () => now });
  mkdirSync(d, { recursive: true });
  writeFileSync(h.monthFile(now), `${JSON.stringify(rec(Date.parse('2026-02-01T00:00:00Z'), 7))}\nnot json\n{"truncated":\n`);
  await h.warm();
  assert.equal(h.recent(0).length, 1);
});

test('warm on an empty directory yields no records and does not throw', async () => {
  const h = createHistory({ dir: dir() });
  await h.warm();
  assert.deepEqual(h.recent(0), []);
});

test('the in-memory window is trimmed to the retention period', async () => {
  const now = Date.parse('2026-02-10T00:00:00Z');
  const h = createHistory({ dir: dir(), now: () => now, retentionMs: 24 * 3600 * 1000 });
  await h.append(rec(now - 48 * 3600 * 1000, 1));
  await h.append(rec(now - 1 * 3600 * 1000, 2));
  assert.equal(h.recent(0).length, 1);
});

test('records are returned in ascending timestamp order regardless of append order', async () => {
  const h = createHistory({ dir: dir(), now: () => 100_000 });
  await h.append(rec(5000, 2));
  await h.append(rec(1000, 1));
  assert.deepEqual(h.recent(0).map(r => r.t), [1000, 5000]);
});

// --- Fix round 1: warm() month walk-back and append() timestamp validation ---
//
// All timestamps below are built with the local `new Date(y, m, d, ...)` form
// rather than `Date.parse('...Z')`. That keeps construction and the
// implementation's own local getFullYear()/getMonth() reads on the same side of
// any UTC offset in every run, so these tests are exact under any TZ rather than
// merely "far enough from a boundary to probably be safe."

test('warm() when now is March 31 loads February, not March twice (setMonth overflow)', async () => {
  const d = dir();
  const now = new Date(2026, 2, 31, 12, 0, 0).getTime(); // local March 31 2026, noon
  const h1 = createHistory({ dir: d, now: () => now });
  const febTime = new Date(2026, 1, 15, 12, 0, 0).getTime(); // local February 15 2026, noon
  await h1.append(rec(febTime, 1));

  const h2 = createHistory({ dir: d, now: () => now, retentionMs: 365 * 24 * 3600 * 1000 });
  await h2.warm();
  // Unfixed: prev.setMonth(prev.getMonth() - 1) on day 31 overflows Feb's 28 days
  // forward into March, so warm() loads March twice and February never -- this
  // record is invisible. Fixed: warm() must load February.
  assert.equal(h2.recent(0).length, 1);
});

test('warm() with now() in January reaches back into December, crossing the year boundary', async () => {
  const d = dir();
  const now = new Date(2026, 0, 15, 12, 0, 0).getTime(); // local January 15 2026, noon
  const h1 = createHistory({ dir: d, now: () => now });
  const decTime = new Date(2025, 11, 20, 12, 0, 0).getTime(); // local December 20 2025, noon
  const novTime = new Date(2025, 10, 5, 12, 0, 0).getTime(); // local November 5 2025, noon
  await h1.append(rec(decTime, 1));
  await h1.append(rec(novTime, 2));

  // January 15 minus one month lands on December 20 without any setMonth overflow
  // (December has 31 days, so day 15 never overflows) -- a plain "current +
  // previous month" window already gets December right by luck. It never reaches
  // November at all, though, no matter how much retention is configured, because
  // the unfixed warm() always loads exactly two files. 75 days of retention here
  // requires reaching November, so this only passes once the walk-back is driven
  // by retentionMs rather than a fixed count.
  const h2 = createHistory({ dir: d, now: () => now, retentionMs: 75 * 24 * 3600 * 1000 });
  await h2.warm();
  assert.equal(h2.recent(0).length, 2);
});

test('warm() with 90 days of retention loads a record three months back', async () => {
  const d = dir();
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime(); // local June 15 2026, noon
  const h1 = createHistory({ dir: d, now: () => now });
  const marchTime = new Date(2026, 2, 25, 12, 0, 0).getTime(); // local March 25 2026, noon (well inside the 90-day retention cutoff of ~March 17)
  await h1.append(rec(marchTime, 1));

  const h2 = createHistory({ dir: d, now: () => now, retentionMs: 90 * 24 * 3600 * 1000 });
  await h2.warm();
  assert.equal(h2.recent(0).length, 1);
});

test('append rejects a record with a missing t and writes no file', async () => {
  const d = dir();
  const h = createHistory({ dir: d });
  await assert.rejects(() => h.append({ limits: [] }), TypeError);
  assert.deepEqual(readdirSync(d), []);
});

test('append rejects a record with a non-numeric t and writes no file', async () => {
  const d = dir();
  const h = createHistory({ dir: d });
  await assert.rejects(() => h.append({ t: 'not-a-number', limits: [] }), TypeError);
  assert.deepEqual(readdirSync(d), []);
});

test('warm skips a syntactically valid line whose t is missing or non-numeric', async () => {
  const d = dir();
  const now = new Date(2026, 1, 10, 12, 0, 0).getTime(); // local February 10 2026, noon
  const h = createHistory({ dir: d, now: () => now });
  mkdirSync(d, { recursive: true });
  const goodTime = new Date(2026, 1, 1, 12, 0, 0).getTime(); // local February 1 2026, noon
  const lines = [
    JSON.stringify(rec(goodTime, 7)),
    JSON.stringify({ limits: [] }), // missing t
    JSON.stringify({ t: 'nope', limits: [] }) // non-numeric t
  ].join('\n');
  writeFileSync(h.monthFile(now), `${lines}\n`);
  await h.warm();
  assert.equal(h.recent(0).length, 1);
});
