import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
