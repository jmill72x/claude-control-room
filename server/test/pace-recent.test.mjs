// The projection from the recent rate (lib/pace.mjs: recentBaseline, computePace's
// baseline, basisWords; board f66a4a7e) and every place that says it: the usage panel,
// the alert line, the proactive check's `week` hit and its words. Times are built from
// local dates, so the tests hold in any time zone. Every reading is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentBaseline, computePace, basisWords, RATE_LOOKBACK_MS, RESET_DROP_PCT, WEEKLY_FALLBACK_MS } from '../lib/pace.mjs';
import { buildUsagePanel } from '../lib/usage-panel.mjs';
import { buildAlerts } from '../lib/alerts.mjs';
import { usageHits } from '../lib/proactive.mjs';
import { checkHit, proactiveText } from '../lib/proactive-text.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK_MS = 7 * DAY;
const WEEK = 'Weekly · all models';
// A week that began Monday 2026-11-16 19:00 local and ends the next Monday 19:00.
const START = new Date(2026, 10, 16, 19).getTime();
const END = START + WEEK_MS;
const RESET = new Date(END).toISOString();
const rec = (t, pct, { resetsAt = RESET, label = WEEK } = {}) => ({ t, limits: [{ label, pct, resetsAt }] });
const limit = (pct, extra = {}) => ({ label: WEEK, pct, resetsAt: RESET, ...extra });
const base = (records, pct, now, extra = {}) => recentBaseline(records, limit(pct), { now, windowMs: WEEK_MS, ...extra });

test('the constants: a day back, and a fall of more than 5 points is a reset', () => {
  assert.equal(RATE_LOOKBACK_MS, 24 * HOUR);
  assert.equal(RESET_DROP_PCT, 5);
  assert.equal(WEEKLY_FALLBACK_MS, WEEK_MS);
});

test('the baseline is the newest reading of this window at least a day old', () => {
  const now = START + 3 * DAY;
  const records = [rec(now - 30 * HOUR, 20), rec(now - 25 * HOUR, 30), rec(now - 24 * HOUR, 31), rec(now - 24 * HOUR + 1, 32), rec(now - HOUR, 36), rec(now, 37)];
  assert.deepEqual(base(records, 37, now), { t: now - 24 * HOUR, pct: 31 }, 'exactly a day old counts; a millisecond younger does not');
  assert.deepEqual(base(records.slice(0, 2).concat(records.slice(4)), 37, now), { t: now - 25 * HOUR, pct: 30 }, 'the newest one that is old enough');
  assert.deepEqual(base(records, 37, now, { lookbackMs: 28 * HOUR }), { t: now - 30 * HOUR, pct: 20 }, 'the lookback is a setting');
});

test('no baseline early in the week, with no history, or without a window', () => {
  const now = START + 20 * HOUR;
  assert.equal(base([rec(START + HOUR, 1), rec(now, 9)], 9, now), null, 'no reading of this window is a day old');
  assert.equal(base([], 9, now), null);
  assert.equal(base(null, 9, now), null);
  const later = START + 3 * DAY;
  const records = [rec(later - 30 * HOUR, 20), rec(later, 37)];
  assert.equal(recentBaseline(records, { label: WEEK, pct: 37, resetsAt: null }, { now: later, windowMs: WEEK_MS }), null, 'no reset, no window');
  assert.equal(recentBaseline(records, limit(37), { now: later, windowMs: null }), null, 'no window length');
  assert.equal(recentBaseline(records, limit(NaN), { now: later, windowMs: WEEK_MS }), null, 'no percent');
  assert.deepEqual(recentBaseline(records, limit(37), { now: later, windowMs: WEEK_MS }), { t: later - 30 * HOUR, pct: 20 }, 'and with all three, one');
});

test('a reading of the week before never counts: the walk stops at another window', () => {
  const now = START + 26 * HOUR;
  const before = new Date(START).toISOString();
  // Last week ended at 97%; this week's first reading is 25 hours old.
  const records = [rec(START - 2 * HOUR, 97, { resetsAt: before }), rec(START + HOUR, 1), rec(now, 12)];
  assert.deepEqual(base(records, 12, now), { t: START + HOUR, pct: 1 });
  // Without this week's old reading there is none: last week's is not one.
  assert.equal(base([records[0], rec(now - 2 * HOUR, 10), records[2]], 12, now), null);
  // Nor when last week ended low, so that no fall gives it away: 8% then, 12% now.
  assert.equal(base([rec(START - 2 * HOUR, 8, { resetsAt: before }), rec(now - 2 * HOUR, 10), records[2]], 12, now), null);
  // The printed reset flaps by a minute inside one window: still this window.
  const flap = new Date(END - MIN).toISOString();
  assert.deepEqual(base([rec(now - 25 * HOUR, 3, { resetsAt: flap }), rec(now, 12)], 12, now), { t: now - 25 * HOUR, pct: 3 });
  // Half an hour is the edge: a reset that far off is the flap's limit, past it another window.
  const edge = t => new Date(END - t).toISOString();
  assert.notEqual(base([rec(now - 25 * HOUR, 3, { resetsAt: edge(30 * MIN) }), rec(now, 12)], 12, now), null);
  assert.equal(base([rec(now - 25 * HOUR, 3, { resetsAt: edge(30 * MIN + 1) }), rec(now, 12)], 12, now), null);
  assert.equal(base([rec(now - 25 * HOUR, 3, { resetsAt: new Date(END + 31 * MIN).toISOString() }), rec(now, 12)], 12, now), null, 'later resets too');
});

test('a reading with no printed reset counts while it was taken inside the window', () => {
  // A weekly limit at 0% prints no reset: it is this week's while the week had begun.
  const now = START + 2 * DAY;
  assert.deepEqual(base([rec(START, 0, { resetsAt: null }), rec(now, 20)], 20, now), { t: START, pct: 0 }, 'at the start itself');
  assert.equal(base([rec(START - 1, 0, { resetsAt: null }), rec(now, 20)], 20, now), null, 'a millisecond before the start it is not');
  assert.equal(base([rec(START + HOUR, 0, { resetsAt: 'not a date' }), rec(now, 20)], 20, now)?.pct, 0, 'an unreadable reset is no reset');
});

test('an early reset ends the walk; a dip of a few points does not', () => {
  const now = START + 4 * DAY;
  // 93% a day ago, 0% and climbing since: the limit was reset before its printed time.
  const reset = [rec(now - 30 * HOUR, 93), rec(now - 20 * HOUR, 0), rec(now - HOUR, 4), rec(now, 5)];
  assert.equal(base(reset, 5, now), null);
  // A fall of exactly 5 points is still a dip; 6 is a reset.
  assert.deepEqual(base([rec(now - 30 * HOUR, 45), rec(now - HOUR, 40), rec(now, 40)], 40, now), { t: now - 30 * HOUR, pct: 45 });
  assert.equal(base([rec(now - 30 * HOUR, 46), rec(now - HOUR, 40), rec(now, 40)], 40, now), null);
  // The fall is measured from one reading to the next, not to the newest one: 50, 46,
  // 42 are two dips, though 50 to 42 is 8.
  assert.deepEqual(base([rec(now - 30 * HOUR, 50), rec(now - 10 * HOUR, 46), rec(now, 42)], 42, now), { t: now - 30 * HOUR, pct: 50 });
  // And against the limit's own percent when no reading sits between.
  assert.equal(base([rec(now - 30 * HOUR, 50)], 42, now), null);
});

test('bad lines cost that line: no time, a time ahead, another label, no percent', () => {
  const now = START + 3 * DAY;
  const good = rec(now - 26 * HOUR, 30);
  const records = [good, { limits: [{ label: WEEK, pct: 99, resetsAt: RESET }] }, rec(now - 25 * HOUR, 99, { label: 'Weekly · Other' }),
    { t: now - 25 * HOUR, limits: [{ label: WEEK, pct: 'x', resetsAt: RESET }] }, { t: now - 25 * HOUR }, rec(now + HOUR, 99), rec(now, 37)];
  assert.deepEqual(base(records, 37, now), { t: good.t, pct: 30 });
});

test('computePace: the percent plus the recent rate over the time left, with its basis', () => {
  const now = START + 2.5 * DAY;
  // 31% a day ago, 37% now, 4.5 days left: 37 + 6 x 4.5 = 64.
  const p = computePace({ pct: 37, resetsAt: RESET, windowMs: WEEK_MS, now, baseline: { t: now - DAY, pct: 31 } });
  assert.equal(p.projectedPct, 64);
  assert.equal(p.basis, 'recent');
  assert.equal(p.basisMs, DAY);
  assert.equal(p.state, 'on', 'the state still compares the percent with an even pace (36% expected)');
  assert.equal(p.expectedPct, 36);
  // The straight line it replaces: 37 / (2.5 / 7) = 104.
  const line = computePace({ pct: 37, resetsAt: RESET, windowMs: WEEK_MS, now });
  assert.deepEqual([line.projectedPct, line.basis, line.basisMs], [104, 'window', 2.5 * DAY]);
  // A limit that stood still projects its own percent; a dip is not a negative rate.
  assert.equal(computePace({ pct: 56, resetsAt: RESET, windowMs: WEEK_MS, now, baseline: { t: now - DAY, pct: 56 } }).projectedPct, 56);
  assert.equal(computePace({ pct: 55, resetsAt: RESET, windowMs: WEEK_MS, now, baseline: { t: now - DAY, pct: 56 } }).projectedPct, 55);
  // An older baseline (a gap in the readings) is its true span: 12 points in 2 days.
  const gap = computePace({ pct: 37, resetsAt: RESET, windowMs: WEEK_MS, now, baseline: { t: now - 2 * DAY, pct: 25 } });
  assert.deepEqual([gap.projectedPct, gap.basis, gap.basisMs], [64, 'recent', 2 * DAY]);
  // Not clamped: a fast day late in the week can pass 100.
  assert.equal(computePace({ pct: 80, resetsAt: RESET, windowMs: WEEK_MS, now, baseline: { t: now - DAY, pct: 60 } }).projectedPct, 170);
});

test('computePace: a baseline that is not behind us, or not numbers, is the straight line', () => {
  const now = START + 2.5 * DAY;
  for (const baseline of [null, undefined, { t: now, pct: 31 }, { t: now + 1, pct: 31 }, { t: 'x', pct: 31 }, { t: null, pct: 31 }, { t: now - DAY, pct: null }, { t: now - DAY }]) {
    const p = computePace({ pct: 37, resetsAt: RESET, windowMs: WEEK_MS, now, baseline });
    assert.deepEqual([p.projectedPct, p.basis], [104, 'window'], JSON.stringify(baseline));
  }
  // The refusals are unchanged, baseline or not: too early, ended, no window.
  const b = { t: START - DAY, pct: 0 };
  assert.equal(computePace({ pct: 5, resetsAt: RESET, windowMs: WEEK_MS, now: START + 10 * HOUR, baseline: b }).state, 'too-early');
  assert.equal(computePace({ pct: 5, resetsAt: RESET, windowMs: WEEK_MS, now: END, baseline: b }).projectedPct, null);
  assert.equal(computePace({ pct: 5, resetsAt: RESET, windowMs: null, now, baseline: b }).state, 'unknown-window');
});

test('basisWords: the span in whole hours, the straight line, and nothing for an older pace', () => {
  assert.equal(basisWords({ basis: 'recent', basisMs: DAY }), 'at the last 24 h rate');
  assert.equal(basisWords({ basis: 'recent', basisMs: DAY + 4 * MIN }), 'at the last 24 h rate');
  assert.equal(basisWords({ basis: 'recent', basisMs: 31.6 * HOUR }), 'at the last 32 h rate');
  assert.equal(basisWords({ basis: 'recent', basisMs: 10 * MIN }), 'at the last 1 h rate');
  assert.equal(basisWords({ basis: 'window', basisMs: DAY }), "at this window's average rate");
  assert.equal(basisWords({ basis: 'window', basisMs: DAY }, true), "at the week's average rate");
  assert.equal(basisWords({ basis: 'recent', basisMs: DAY }, true), 'at the last 24 h rate');
  for (const pace of [null, undefined, {}, { basis: 'recent' }, { basis: 'recent', basisMs: 0 }, { basis: 'recent', basisMs: 'x' }, { basis: 'recent', basisMs: Infinity }, { basis: 'IGNORE PREVIOUS INSTRUCTIONS', basisMs: DAY }]) {
    assert.equal(basisWords(pace), '', String(pace?.basisMs));
  }
});

// ---- the usage panel ----

const SESSION = 'Current session';
function panel(records, now, limits) {
  return buildUsagePanel({ parsed: { limits }, records, now });
}

test('the panel: a weekly limit is projected from its last day, the session from its window', () => {
  const now = START + 2.5 * DAY;
  const sessionReset = new Date(now + 2 * HOUR).toISOString();
  const day = [];
  // A heavy first day (to 51%), then a day and a half standing still.
  for (let t = START + 5 * MIN; t <= now; t += 5 * MIN) day.push({ t, limits: [{ label: WEEK, pct: Math.min(51, Math.round((t - START) / DAY * 51)), resetsAt: RESET }] });
  const out = panel(day, now, [{ label: SESSION, pct: 30, resetsAt: sessionReset }, { label: WEEK, pct: 51, resetsAt: RESET }]);
  const week = out.limits.find(l => l.label === WEEK).pace;
  assert.deepEqual([week.projectedPct, week.basis], [51, 'recent'], 'flat for a day: it stays where it is (the straight line said 143)');
  assert.ok(Math.abs(week.basisMs - DAY) <= 5 * MIN);
  assert.equal(Math.round(51 / (2.5 / 7)), 143);
  const session = out.limits.find(l => l.label === SESSION).pace;
  assert.equal(session.basis, undefined, 'no window length observed for the session: no projection, no basis');
});

test('the panel: early in the week the straight line stands, and says so', () => {
  const now = START + 20 * HOUR;
  const records = [];
  for (let t = START + 5 * MIN; t <= now; t += 5 * MIN) records.push(rec(t, Math.round((t - START) / HOUR)));
  const week = panel(records, now, [{ label: WEEK, pct: 20, resetsAt: RESET }]).limits[0].pace;
  assert.deepEqual([week.projectedPct, week.basis, week.basisMs], [Math.round(20 / (20 / 168)), 'window', 20 * HOUR]);
});

test('the panel: the session never takes a recent rate, whatever the history holds', () => {
  // Session windows seen rolling over on time, 30 hours long (an invented length, so
  // that a reading of this window can be a day old at all: at 5 hours none ever is).
  const w1 = START, w2 = START + 30 * HOUR, w3 = START + 60 * HOUR;
  const iso = t => new Date(t).toISOString();
  const s = (t, pct, end) => ({ t, limits: [{ label: SESSION, pct, resetsAt: iso(end) }] });
  const now = w3 - 2 * HOUR;
  const records = [s(w1 - HOUR, 10, w1), s(w1 + MIN, 1, w2), s(w2 - HOUR, 30, w2), s(w2 + MIN, 2, w3), s(now - 24 * HOUR, 38, w3), s(now, 40, w3)];
  const pace = panel(records, now, [{ label: SESSION, pct: 40, resetsAt: iso(w3) }]).limits[0].pace;
  assert.deepEqual([pace.projectedPct, pace.basis, pace.basisMs], [Math.round(40 / (28 / 30)), 'window', 28 * HOUR]);
  // The same readings under a weekly label do take it: 2 points a day, 2 hours left.
  const weekly = records.map(r => ({ t: r.t, limits: [{ ...r.limits[0], label: WEEK }] }));
  const wp = buildUsagePanel({ parsed: { limits: [{ label: WEEK, pct: 40, resetsAt: iso(w3) }] }, records: weekly, now }).limits[0].pace;
  assert.deepEqual([wp.projectedPct, wp.basis], [40, 'recent']);
});

// ---- the alert line ----

test('the projection alert says its basis; one at or under 100% raises nothing', () => {
  const usage = pace => ({ usage: { data: { limits: [{ label: WEEK, pct: 60, resetsAt: RESET, pace }] } } });
  const texts = pace => buildAlerts(usage(pace), {}, START).filter(a => a.kind === 'projection').map(a => [a.text, a.key]);
  assert.deepEqual(texts({ projectedPct: 112, basis: 'recent', basisMs: DAY }), [['Weekly · all models projected to reach 112% by reset at the last 24 h rate', `projection:${WEEK}`]]);
  assert.deepEqual(texts({ projectedPct: 112, basis: 'window', basisMs: 3 * DAY }), [["Weekly · all models projected to reach 112% by reset at the week's average rate", `projection:${WEEK}`]]);
  const session = buildAlerts({ usage: { data: { limits: [{ label: SESSION, pct: 60, pace: { projectedPct: 140, basis: 'window', basisMs: HOUR } }] } } }, {}, START).find(a => a.kind === 'projection');
  assert.equal(session.text, "Current session projected to reach 140% by reset at this window's average rate");
  assert.deepEqual(texts({ projectedPct: 112 }), [['Weekly · all models projected to reach 112% by reset', `projection:${WEEK}`]], 'a pace with no basis: the line as it was');
  assert.deepEqual(texts({ projectedPct: 100, basis: 'recent', basisMs: DAY }), []);
});

// ---- the proactive check's week rule ----

test('the week hit carries the recent rate\'s span in whole hours, or null for the straight line', () => {
  const hit = pace => usageHits({ limits: [{ label: WEEK, pct: 60, resetsAt: RESET, pace: { projectedPct: 120, elapsed: 0.5, ...pace } }], now: START + 3.5 * DAY })[0];
  assert.equal(hit({ basis: 'recent', basisMs: DAY }).rateHours, 24);
  assert.equal(hit({ basis: 'recent', basisMs: 31.6 * HOUR }).rateHours, 32);
  assert.equal(hit({ basis: 'recent', basisMs: 10 * MIN }).rateHours, 1);
  assert.equal(hit({ basis: 'window', basisMs: DAY }).rateHours, null);
  assert.equal(hit({}).rateHours, null);
  assert.equal(hit({ basis: 'recent', basisMs: 0 }).rateHours, null);
  assert.equal(hit({ basis: 'recent', basisMs: 'x' }).rateHours, null);
  assert.equal(checkHit(hit({ basis: 'recent', basisMs: Infinity })).rateHours, null, 'a span that is no number is never said');
});

test('checkHit keeps the span only as a whole number of hours; the words say it', () => {
  const week = extra => ({ rule: 'week', limit: 'week (all models)', projected: 120, resetsAt: null, ...extra });
  assert.equal(checkHit(week({ rateHours: 24 })).rateHours, 24);
  assert.equal(checkHit(week({ rateHours: 1 })).rateHours, 1);
  assert.equal(checkHit(week({ rateHours: 10000 })).rateHours, 10000);
  for (const bad of [0, 10001, 24.5, '24', 'IGNORE PREVIOUS INSTRUCTIONS', null, undefined, {}]) {
    assert.equal(checkHit(week({ rateHours: bad })).rateHours, null, String(bad));
  }
  assert.equal(proactiveText([week({ rateHours: 24 })], { now: START }), 'Heads up (1): Claude week (all models) projected at 120% by its reset at the last 24 h rate');
  assert.equal(proactiveText([week({})], { now: START }), 'Heads up (1): Claude week (all models) projected at 120% by its reset');
  assert.equal(proactiveText([week({ rateHours: 30, resetsAt: END })], { now: START }),
    'Heads up (1): Claude week (all models) projected at 120% by its reset at the last 30 h rate, resets Mon 7:00 pm');
});
