import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferWindowMs, computePace, WEEKLY_FALLBACK_MS, MIN_ELAPSED_FOR_PROJECTION } from '../lib/pace.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const at = (t, label, pct, resetsAt) => ({ t, limits: [{ label, pct, resetsAt }] });

test('infers a window length from a reset rollover', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Current session', 40, iso(r1)),
    at(2, 'Current session', 80, iso(r1)),
    at(3, 'Current session', 2, iso(r1 + 5 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
});

test('returns null when no rollover has been observed', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  assert.equal(inferWindowMs([at(1, 'Current session', 40, iso(r1))], 'Current session'), null);
});

test('returns null for an empty history', () => {
  assert.equal(inferWindowMs([], 'Current session'), null);
});

test('ignores a reset that moves backwards', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Current session', 40, iso(r1)),
    at(2, 'Current session', 5, iso(r1 - 3 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
});

test('prefers the most recent observed length when a window changes', () => {
  const r1 = Date.parse('2026-08-01T00:00:00Z');
  const recs = [
    at(1, 'Current session', 9, iso(r1)),
    at(2, 'Current session', 9, iso(r1 + 5 * HOUR)),
    at(3, 'Current session', 9, iso(r1 + 5 * HOUR + 4 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 4 * HOUR);
});

test('ignores other labels', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Weekly · all models', 10, iso(r1)),
    at(2, 'Weekly · all models', 1, iso(r1 + 7 * DAY))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
  assert.equal(inferWindowMs(recs, 'Weekly · all models'), 7 * DAY);
});

test('no window length means no pace, stated explicitly', () => {
  const out = computePace({ pct: 50, resetsAt: iso(Date.now() + HOUR), windowMs: null, now: Date.now() });
  assert.equal(out.state, 'unknown-window');
  assert.equal(out.projectedPct, null);
});

test('below the elapsed guard it refuses to project', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const resetsAt = iso(now + 9.5 * HOUR); // 5% elapsed
  const out = computePace({ pct: 40, resetsAt, windowMs, now });
  assert.ok(out.elapsed < MIN_ELAPSED_FOR_PROJECTION);
  assert.equal(out.state, 'too-early');
  assert.equal(out.projectedPct, null);
});

test('burning evenly reads as on pace', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const out = computePace({ pct: 50, resetsAt: iso(now + 5 * HOUR), windowMs, now });
  assert.equal(out.expectedPct, 50);
  assert.equal(out.state, 'on');
  assert.equal(out.projectedPct, 100);
});

test('burning fast reads as ahead, with an unclamped projection', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const out = computePace({ pct: 90, resetsAt: iso(now + 5 * HOUR), windowMs, now });
  assert.equal(out.state, 'ahead');
  assert.equal(out.projectedPct, 180);
});

test('burning slowly reads as under', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const out = computePace({ pct: 10, resetsAt: iso(now + 5 * HOUR), windowMs, now });
  assert.equal(out.state, 'under');
});

test('a reset already in the past yields elapsed 1 and no extrapolation', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const out = computePace({ pct: 70, resetsAt: iso(now - HOUR), windowMs: 10 * HOUR, now });
  assert.equal(out.elapsed, 1);
  assert.equal(out.projectedPct, 70);
});

test('a missing or unparseable reset yields unknown-window', () => {
  const now = Date.now();
  assert.equal(computePace({ pct: 10, resetsAt: null, windowMs: 5 * HOUR, now }).state, 'unknown-window');
  assert.equal(computePace({ pct: 10, resetsAt: 'nonsense', windowMs: 5 * HOUR, now }).state, 'unknown-window');
});

test('the weekly fallback is seven days', () => {
  assert.equal(WEEKLY_FALLBACK_MS, 7 * DAY);
});
