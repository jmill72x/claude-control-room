import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferWindowMs, computePace, WEEKLY_FALLBACK_MS, MIN_ELAPSED_FOR_PROJECTION,
  MIN_PLAUSIBLE_WINDOW_MS, MAX_ROLLOVER_LATENESS_MS
} from '../lib/pace.mjs';

const MINUTE = 60000, HOUR = 3600000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const at = (t, label, pct, resetsAt) => ({ t, limits: [{ label, pct, resetsAt }] });

// Record timestamps and reset timestamps are read on the same clock — the
// window length is measured from the distance between them — so fixtures state
// both. A `t` of 1, 2, 3 would be 1970 against a 2026 reset: not a poll history.
test('infers a window length from a reset rollover', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(r1 - 10 * MINUTE, 'Current session', 40, iso(r1)),
    at(r1 - 5 * MINUTE, 'Current session', 80, iso(r1)),
    at(r1 + MINUTE, 'Current session', 2, iso(r1 + 5 * HOUR))
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
  const r2 = r1 + 5 * HOUR;
  const recs = [
    at(r1 - MINUTE, 'Current session', 9, iso(r1)),
    at(r1 + MINUTE, 'Current session', 9, iso(r2)),
    at(r2 + MINUTE, 'Current session', 9, iso(r2 + 4 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 4 * HOUR);
});

test('ignores other labels', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(r1 - MINUTE, 'Weekly · all models', 10, iso(r1)),
    at(r1 + MINUTE, 'Weekly · all models', 1, iso(r1 + 7 * DAY))
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

// --- A forward jump is not automatically one window length ---
//
// The shapes below are those of a real captured history. A session window is
// user-initiated, so after an idle spell the jump spans `idle + window`; the
// only jumps that measure a window are the ones seen promptly after the reset
// they supersede, because that lateness is exactly the error bound.

test('a jump first seen long after the reset it supersedes is rejected', () => {
  // The real sequence: a clean 5h rollover caught 33s after the old reset, then
  // the printed reset flaps by a minute for hours (none of which advances the
  // baseline), then at 11:39 the reset lands 520m ahead — 3.8h of idle plus the
  // same 5h window. That sighting is 3h50m late, so up to 3h50m of the 520m is
  // idle and the jump measures nothing.
  const base = Date.parse('2026-08-07T02:39:37Z');
  const recs = [
    at(base, 'Current session', 11, '2026-08-07T02:50:00Z'),
    at(Date.parse('2026-08-07T02:50:33Z'), 'Current session', 1, '2026-08-07T07:50:00Z'),
    at(Date.parse('2026-08-07T07:19:48Z'), 'Current session', 30, '2026-08-07T07:49:00Z'),
    at(Date.parse('2026-08-07T07:29:48Z'), 'Current session', 31, '2026-08-07T07:50:00Z'),
    at(Date.parse('2026-08-07T11:39:48Z'), 'Current session', 3, '2026-08-07T16:30:00Z')
  ];
  // Unguarded this returns 520 minutes. The only trustworthy observation here
  // is the clean 5h rollover.
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
});

test('an overnight poll gap over a baseline set mid-window fabricates a 14.5h window unless lateness is checked', () => {
  // Nothing is wrong with this history: the machine slept. The baseline was set
  // at 20:00 with the window ending at 22:30; by 07:00 the next window had long
  // since started and rolled. jump = 14.5h, of which 8.5h could be idle — so the
  // window could be anything from 6h to 14.5h. That is "unknown", not 14.5h.
  const t1 = Date.parse('2026-08-06T20:00:00Z');
  const recs = [
    at(t1, 'Current session', 60, '2026-08-06T22:30:00Z'),
    at(Date.parse('2026-08-07T07:00:00Z'), 'Current session', 5, '2026-08-07T13:00:00Z')
  ];
  // The old gap rule accepted this: an 11h gap is smaller than a 14.5h jump.
  assert.equal(inferWindowMs(recs, 'Current session'), null);
});

test('a three-day poll gap does not become a 74-hour window', () => {
  const recs = [
    at(Date.parse('2026-08-04T20:00:00Z'), 'Current session', 60, '2026-08-04T22:30:00Z'),
    at(Date.parse('2026-08-07T07:00:00Z'), 'Current session', 5, '2026-08-07T13:00:00Z')
  ];
  // The old gap rule accepted this too, yielding 4440 minutes.
  assert.equal(inferWindowMs(recs, 'Current session'), null);
});

test('the lateness tolerance is what decides, and it is the error bound', () => {
  // Same jump, same everything, seen either side of the tolerance. Inside it the
  // answer is the jump and the worst case error is the lateness; outside it the
  // idle share is unbounded and there is no answer to give.
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const seen = late => inferWindowMs([
    at(r1 - MINUTE, 'Current session', 80, iso(r1)),
    at(r1 + late, 'Current session', 3, iso(r1 + 5 * HOUR))
  ], 'Current session');
  assert.equal(seen(MAX_ROLLOVER_LATENESS_MS), 5 * HOUR);
  assert.equal(seen(MAX_ROLLOVER_LATENESS_MS + MINUTE), null);
});

test('the same history with the flap phase swapped still measures ~5h, not 8.67h', () => {
  // Identical to the captured sequence except that every flapping reset takes
  // the OTHER side of its pair — a coin flip in what `/usage` happened to print.
  // The rollover is now first caught at :49, so the baseline advances a minute
  // later when it "recovers", which under the old gap rule re-armed the 520m
  // jump and reproduced the original live bug exactly. Lateness does not care
  // which side of the flap was caught: both sightings that measure anything are
  // punctual, and both say five hours (299m — the flap's own minute).
  const recs = [
    at(Date.parse('2026-08-07T02:39:37Z'), 'Current session', 11, '2026-08-07T02:50:00Z'),
    at(Date.parse('2026-08-07T02:50:33Z'), 'Current session', 1, '2026-08-07T07:49:00Z'),
    at(Date.parse('2026-08-07T03:10:34Z'), 'Current session', 4, '2026-08-07T07:50:00Z'),
    at(Date.parse('2026-08-07T07:19:48Z'), 'Current session', 30, '2026-08-07T07:49:00Z'),
    at(Date.parse('2026-08-07T11:39:48Z'), 'Current session', 3, '2026-08-07T16:29:00Z'),
    at(Date.parse('2026-08-07T11:44:49Z'), 'Current session', 3, '2026-08-07T16:30:00Z'),
    at(Date.parse('2026-08-07T16:32:25Z'), 'Current session', 2, '2026-08-07T21:29:00Z')
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 299 * MINUTE);
  // And on the prefix, before the second clean rollover arrives to outvote it:
  // this is where the gap rule returned 519m — the original live 8.67h bug,
  // reproduced from nothing but a coin flip in the printed minute.
  assert.equal(inferWindowMs(recs.slice(0, 5), 'Current session'), 299 * MINUTE);
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

test('the plausibility floor is the only thing rejecting a punctual one-minute flap', () => {
  // This isolates MIN_PLAUSIBLE_WINDOW_MS, and nothing else in the module can
  // stand in for it. The live history has exactly this: a 44-second poll gap
  // (13:14:48 -> 13:15:32) across a one-minute change of the printed reset.
  // Polling is dense, the sighting is 32 SECONDS EARLY against the reset it
  // supersedes — as punctual as an observation can be, so the lateness rule
  // accepts it — and the jump is 60000ms. Delete the floor and this history
  // reports a one-minute window, which on a weekly limit then overrides the
  // correct 7-day fallback for as long as it is retained.
  const r = Date.parse('2026-08-07T16:29:00Z');
  const recs = [
    at(r - 106 * 1000, 'Current session', 40, '2026-08-07T16:28:00Z'),
    at(r - 76 * 1000, 'Current session', 41, '2026-08-07T16:28:00Z'),
    at(r - 32 * 1000, 'Current session', 42, '2026-08-07T16:29:00Z'), // +1m, 44s after the previous poll
    at(r + 12 * 1000, 'Current session', 43, '2026-08-07T16:29:00Z')
  ];
  const gap = recs[2].t - recs[1].t;
  assert.ok(gap < MINUTE, 'the discriminating case needs a sub-minute poll gap');
  assert.ok(Math.abs(recs[2].t - Date.parse('2026-08-07T16:28:00Z')) < MAX_ROLLOVER_LATENESS_MS,
    'the sighting must be punctual, so that only the floor can reject it');
  assert.equal(inferWindowMs(recs, 'Current session'), null);
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

test('a genuine window change is reported as soon as it is cleanly observed', () => {
  // Spec §4: "Inference is self-correcting: if Anthropic changes a window, the
  // next rollover reflects it." Ten punctual sightings of 5h, then three
  // punctual sightings of 3h. Preferring the most REPEATED length answers 5h
  // here and keeps answering it for days — a real change, misreported, by a
  // rule that was only ever standing in for filtering the lateness bound now
  // does properly. The most recent clean observation is the answer.
  const recs = [];
  let r = Date.parse('2026-08-01T05:00:00Z');
  recs.push(at(r - 5 * MINUTE, 'Current session', 90, iso(r)));
  for (let i = 0; i < 10; i++) {
    r += 5 * HOUR;
    recs.push(at(r - 5 * HOUR + MINUTE, 'Current session', 4, iso(r))); // seen 1m after the old reset
  }
  for (let i = 0; i < 3; i++) {
    r += 3 * HOUR;
    recs.push(at(r - 3 * HOUR + MINUTE, 'Current session', 4, iso(r)));
  }
  assert.equal(inferWindowMs(recs, 'Current session'), 3 * HOUR);
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
  const recs = [
    at(r1 - MINUTE, 'Current session', 40, iso(r1)),
    { t: r1 },
    at(r1 + MINUTE, 'Current session', 2, iso(r1 + 5 * HOUR))
  ];
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
