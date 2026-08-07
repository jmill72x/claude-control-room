import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferWindowMs, computePace, WEEKLY_FALLBACK_MS, MIN_ELAPSED_FOR_PROJECTION, MIN_PLAUSIBLE_WINDOW_MS
} from '../lib/pace.mjs';

const MINUTE = 60000, HOUR = 3600000, DAY = 24 * HOUR;
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

test('a backward blip does not lower the baseline for a later recovery', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Current session', 40, iso(r1)),
    at(2, 'Current session', 45, iso(r1 - 3 * HOUR)), // backward blip, correctly skipped
    at(3, 'Current session', 50, iso(r1))              // recovers to the original value
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
});

// --- Fix round 2: a forward jump is not automatically one window length ---
//
// Numbers below are taken from a real captured history. A session window is
// user-initiated, so after an idle spell the jump spans `idle + window`.

test('a jump straddled by a poll gap larger than itself is rejected', () => {
  // The real sequence: a clean 5h rollover at 02:50, then the printed reset
  // flaps by a minute for hours (none of which advances the baseline), then at
  // 11:39 the reset lands 520m ahead — 3.8h of idle plus the same 5h window.
  // The gap straddling that jump, measured from the reading that set the
  // baseline, is 529m: we may have slept through a whole window, so 520m is
  // not evidence of one. The raw poll-to-poll gap there was 230m.
  const base = Date.parse('2026-08-07T02:39:37Z');
  const recs = [
    at(base, 'Current session', 11, '2026-08-07T02:50:00Z'),
    at(Date.parse('2026-08-07T02:50:33Z'), 'Current session', 1, '2026-08-07T07:50:00Z'),
    at(Date.parse('2026-08-07T07:19:48Z'), 'Current session', 30, '2026-08-07T07:49:00Z'),
    at(Date.parse('2026-08-07T07:29:48Z'), 'Current session', 31, '2026-08-07T07:50:00Z'),
    at(Date.parse('2026-08-07T11:39:48Z'), 'Current session', 3, '2026-08-07T16:30:00Z')
  ];
  // Unfixed this returns 520 minutes. The only trustworthy observation here is
  // the clean 5h rollover.
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
});

test('a one-minute jump from the printed-reset flap is rejected outright', () => {
  // A rollover first caught at the LOW side of the flap: the baseline advances
  // to 07:49, and the recovery to 07:50 looks like a forward jump of exactly
  // one minute. No real window is one minute long.
  const recs = [
    at(Date.parse('2026-08-07T07:44:00Z'), 'Current session', 30, '2026-08-07T07:49:00Z'),
    at(Date.parse('2026-08-07T07:49:30Z'), 'Current session', 31, '2026-08-07T07:50:00Z')
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
  assert.ok(MIN_PLAUSIBLE_WINDOW_MS > MINUTE);
});

test('a clean rollover infers, and the flap right after it does not overwrite the good value', () => {
  const t0 = Date.parse('2026-08-07T02:39:00Z');
  const recs = [
    at(t0, 'Current session', 11, '2026-08-07T02:50:00Z'),
    at(t0 + 11 * MINUTE, 'Current session', 1, '2026-08-07T07:50:00Z'), // clean 5h rollover
    at(t0 + 16 * MINUTE, 'Current session', 2, '2026-08-07T07:49:00Z'), // flap down
    at(t0 + 21 * MINUTE, 'Current session', 3, '2026-08-07T07:50:00Z'), // flap back up
    at(t0 + 26 * MINUTE, 'Current session', 4, '2026-08-07T07:49:00Z')
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
});

test('a length observed twice beats a different single more-recent sighting', () => {
  const t0 = Date.parse('2026-08-01T00:00:00Z');
  const r = Date.parse('2026-08-01T05:00:00Z');
  const recs = [
    at(t0, 'Current session', 9, iso(r)),
    at(t0 + 5 * MINUTE, 'Current session', 1, iso(r + 5 * HOUR)),   // 5h
    at(t0 + 10 * MINUTE, 'Current session', 1, iso(r + 10 * HOUR)), // 5h again
    at(t0 + 15 * MINUTE, 'Current session', 1, iso(r + 17 * HOUR))  // 7h, once
  ];
  // Most-recent-wins would answer 7h. Two sightings of 5h outweigh one of 7h.
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
});

test('a jump is rejected when the record carries no usable timestamp to prove we were watching', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    { limits: [{ label: 'Current session', pct: 40, resetsAt: iso(r1) }] },
    { limits: [{ label: 'Current session', pct: 2, resetsAt: iso(r1 + 5 * HOUR) }] }
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
});

test('a record with no limits array does not throw', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [at(1, 'Current session', 40, iso(r1)), { t: 2 }, at(3, 'Current session', 2, iso(r1 + 5 * HOUR))];
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
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

test('a reset already in the past reports the window as ended rather than projecting to it', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const out = computePace({ pct: 70, resetsAt: iso(now - HOUR), windowMs: 10 * HOUR, now });
  assert.equal(out.elapsed, 1);
  assert.equal(out.state, 'window-ended');
  // "projected 70% by reset" would forecast a deadline that has already passed,
  // contradicting the 00:00 countdown printed beside it.
  assert.equal(out.projectedPct, null);
});

test('a reset exactly at now is already ended, not a 100%-elapsed projection', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  assert.equal(computePace({ pct: 70, resetsAt: iso(now), windowMs: 10 * HOUR, now }).state, 'window-ended');
});

test('a missing or unparseable reset yields unknown-window', () => {
  const now = Date.now();
  assert.equal(computePace({ pct: 10, resetsAt: null, windowMs: 5 * HOUR, now }).state, 'unknown-window');
  assert.equal(computePace({ pct: 10, resetsAt: 'nonsense', windowMs: 5 * HOUR, now }).state, 'unknown-window');
});

test('the weekly fallback is seven days', () => {
  assert.equal(WEEKLY_FALLBACK_MS, 7 * DAY);
});
