// lastWindowPct: where each limit's previous window ended, for the faint arc on
// the Orbit page's rings. Times are absolute (UTC), so nothing here depends on the
// time zone. Every reading is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastWindowPct, buildUsagePanel } from '../lib/usage-panel.mjs';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const R1 = Date.UTC(2026, 9, 19, 0, 0); // a reset
const iso = t => (t === null ? null : new Date(t).toISOString());
const reading = (t, pct, resetsAt, label = 'Weekly · all models') => ({ t, limits: [{ label, pct, resetsAt: iso(resetsAt) }] });
const limit = (label, pct, resetsAt) => ({ label, pct, resetsAt: iso(resetsAt) });

// Every five minutes from `from` to `to`.
const polls = (from, to, pct, resetsAt, label) => {
  const out = [];
  for (let t = from; t <= to; t += 5 * MIN) out.push(reading(t, pct, resetsAt, label));
  return out;
};

test('weekly: the last reading of the window before this one, taken just before its reset', () => {
  const history = [
    ...polls(R1 - 6 * HOUR, R1 - 10 * MIN, 90, R1),
    reading(R1 - 3 * MIN, 93, R1),
    ...polls(R1 + 2 * MIN, R1 + 2 * DAY, 2, R1 + 7 * DAY)
  ];
  assert.equal(lastWindowPct(history, limit('Weekly · all models', 2, R1 + 7 * DAY), R1 + 2 * DAY), 93);
});

test('a session that lapsed: no reset now, so the last window is the one that ended most recently', () => {
  const S = 'Current session';
  const history = [
    ...polls(R1 - 4 * HOUR, R1 - 2 * MIN, 22, R1, S),
    ...polls(R1 + 3 * MIN, R1 + 3 * HOUR, 0, null, S)
  ];
  assert.equal(lastWindowPct(history, limit(S, 0, null), R1 + 3 * HOUR), 22);
});

test('a session started after an idle spell: the window before the idle spell', () => {
  const S = 'Current session';
  const now = R1 + 4 * HOUR;
  const history = [
    ...polls(R1 - 2 * HOUR, R1 - 2 * MIN, 40, R1, S),
    ...polls(R1 + 3 * MIN, R1 + 3 * HOUR, 0, null, S),
    ...polls(R1 + 3 * HOUR + 5 * MIN, now, 1, R1 + 8 * HOUR, S)
  ];
  assert.equal(lastWindowPct(history, limit(S, 1, R1 + 8 * HOUR), now), 40);
});

test('left out when the history does not reach back to an earlier window', () => {
  const history = polls(R1 + 2 * MIN, R1 + DAY, 5, R1 + 7 * DAY);
  assert.equal(lastWindowPct(history, limit('Weekly · all models', 5, R1 + 7 * DAY), R1 + DAY), null);
  assert.equal(lastWindowPct([], limit('Weekly · all models', 5, R1 + 7 * DAY), R1 + DAY), null);
});

test('the printed reset flapping by a minute is the same window, not an earlier one', () => {
  // Near the end of a window, where a flapped reading would also pass as fresh.
  const R = R1 + 7 * DAY;
  const history = [];
  for (let t = R - DAY, i = 0; t <= R - 5 * MIN; t += 5 * MIN, i++) history.push(reading(t, 10, i % 2 ? R - MIN : R));
  assert.equal(lastWindowPct(history, limit('Weekly · all models', 10, R), R - 5 * MIN), null);
});

test('left out when the earlier window\'s last reading was taken long before its reset (the server was down)', () => {
  const history = [
    ...polls(R1 - 2 * DAY, R1 - 6 * HOUR, 70, R1),
    ...polls(R1 + 2 * MIN, R1 + DAY, 3, R1 + 7 * DAY)
  ];
  assert.equal(lastWindowPct(history, limit('Weekly · all models', 3, R1 + 7 * DAY), R1 + DAY), null);
});

test('weekly: left out when a whole week went unread between the two windows', () => {
  const history = [
    ...polls(R1 - HOUR, R1 - 2 * MIN, 50, R1),
    ...polls(R1 + 7 * DAY + 2 * MIN, R1 + 8 * DAY, 4, R1 + 14 * DAY)
  ];
  assert.equal(lastWindowPct(history, limit('Weekly · all models', 4, R1 + 14 * DAY), R1 + 8 * DAY), null);
});

test('left out when the newest window with a reset has not ended yet', () => {
  const S = 'Current session';
  const history = [...polls(R1 - HOUR, R1 - 30 * MIN, 12, R1, S), reading(R1 - 25 * MIN, 0, null, S)];
  assert.equal(lastWindowPct(history, limit(S, 0, null), R1 - 25 * MIN), null);
});

test('each limit reads only its own readings', () => {
  const history = [
    { t: R1 - 2 * MIN, limits: [{ label: 'Weekly · Fable', pct: 73, resetsAt: iso(R1) }, { label: 'Weekly · all models', pct: 93, resetsAt: iso(R1) }] },
    { t: R1 + 5 * MIN, limits: [{ label: 'Weekly · Fable', pct: 0, resetsAt: iso(R1 + 7 * DAY) }, { label: 'Weekly · all models', pct: 2, resetsAt: iso(R1 + 7 * DAY) }] }
  ];
  assert.equal(lastWindowPct(history, limit('Weekly · Fable', 0, R1 + 7 * DAY), R1 + HOUR), 73);
  assert.equal(lastWindowPct(history, limit('Weekly · all models', 2, R1 + 7 * DAY), R1 + HOUR), 93);
});

test('the usage panel carries lastWindowPct only where it is known', () => {
  const now = R1 + DAY;
  const history = [
    reading(R1 - 3 * MIN, 93, R1),
    ...polls(R1 + 2 * MIN, now, 2, R1 + 7 * DAY)
  ];
  const panel = buildUsagePanel({
    parsed: { limits: [limit('Weekly · all models', 2, R1 + 7 * DAY), limit('Current session', 1, now + HOUR)] },
    records: history,
    now
  });
  assert.equal(panel.limits[0].lastWindowPct, 93);
  assert.equal('lastWindowPct' in panel.limits[1], false);
});
