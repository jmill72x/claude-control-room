import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRenewalDate } from '../lib/renewal.mjs';

// `now` is always built from local wall-clock components (never a bare
// 'YYYY-MM-DD' string, which V8 parses as UTC and can print as the previous
// day west of Greenwich) so these assertions hold under any TZ the test
// runner happens to execute in — verified by running this file under
// TZ=Asia/Tokyo and TZ=UTC as well as the local zone.
const local = (y, m, d) => new Date(y, m - 1, d);

test('an anchor still in the future is the answer, unchanged', () => {
  // A naive `while (anchor < now) anchor.setMonth(...)` never even enters the
  // loop here, so this alone doesn't distinguish naive from correct — but it
  // pins the "no-op" behaviour so a refactor can't break it silently.
  const result = nextRenewalDate('2026-09-04', 'monthly', local(2026, 8, 6));
  assert.equal(result, '2026-09-04');
});

test('a passed anchor rolls forward to the next monthly anniversary', () => {
  // Naive: new Date('2026-06-04'); while (d < now) d.setMonth(d.getMonth()+1).
  // That happens to land on 2026-09-04 too for a day-4 anchor, so this case
  // is mostly a sanity check that rolling actually occurs at all.
  const result = nextRenewalDate('2026-06-04', 'monthly', local(2026, 8, 6));
  assert.equal(result, '2026-09-04');
});

test('a same-day anchor is itself the next renewal (on-or-after, not strictly after)', () => {
  const result = nextRenewalDate('2026-08-06', 'monthly', local(2026, 8, 6));
  assert.equal(result, '2026-08-06');
});

test('a 31st anchor renders 30 April, not 1 May', () => {
  // Naive: new Date('2026-03-31').setMonth(3) overflows April (30 days) into
  // 1 May, because JS Date silently rolls extra days into the next month.
  const result = nextRenewalDate('2026-03-31', 'monthly', local(2026, 4, 1));
  assert.equal(result, '2026-04-30');
});

test('a 31 January anchor survives a non-leap February as the 28th', () => {
  // Naive setMonth(1) overflow: Jan 31 -> Mar 3 in a non-leap year, skipping
  // February's renewal entirely.
  const result = nextRenewalDate('2026-01-31', 'monthly', local(2026, 2, 1));
  assert.equal(result, '2026-02-28');
  assert.equal(2026 % 4 === 0, false, 'sanity: 2026 is not a leap year');
});

test('a 31 January anchor survives a leap February as the 29th', () => {
  const result = nextRenewalDate('2024-01-31', 'monthly', local(2024, 2, 1));
  assert.equal(result, '2024-02-29');
});

test('a 30th anchor also clamps into a non-leap February as the 28th', () => {
  const result = nextRenewalDate('2026-01-30', 'monthly', local(2026, 2, 1));
  assert.equal(result, '2026-02-28');
});

test('a 29th anchor clamps into a non-leap February as the 28th', () => {
  const result = nextRenewalDate('2025-01-29', 'monthly', local(2025, 2, 1));
  assert.equal(result, '2025-02-28');
});

test('a 29 February anchor survives into the following non-leap year at the 28th', () => {
  const result = nextRenewalDate('2024-02-29', 'monthly', local(2025, 2, 1));
  assert.equal(result, '2025-02-28');
});

test('a clamped February renewal still rolls forward once it too has passed', () => {
  // Jan 31 anchor: Feb candidate clamps to the 28th (2026). If today is
  // already 1 March, the Feb-28 candidate is in the past and must roll to
  // March 31st, not get stuck repeating February.
  const result = nextRenewalDate('2026-01-31', 'monthly', local(2026, 3, 1));
  assert.equal(result, '2026-03-31');
});

test('cycle "30d" advances in fixed 30-day blocks, not to the calendar anniversary', () => {
  // Naive monthly-anniversary math would answer 2026-08-01 here (one month
  // on from July 1st, well before "today"). The correct 30-day-block answer
  // is later than that, and land on the on-or-after boundary at day 60, not 30.
  const result = nextRenewalDate('2026-07-01', '30d', local(2026, 8, 6));
  assert.equal(result, '2026-08-30');
});

test('cycle "30d" on the anchor day itself returns the anchor', () => {
  const result = nextRenewalDate('2026-08-06', '30d', local(2026, 8, 6));
  assert.equal(result, '2026-08-06');
});

test('cycle defaults to monthly when absent', () => {
  const withCycle = nextRenewalDate('2026-06-04', 'monthly', local(2026, 8, 6));
  const withoutCycle = nextRenewalDate('2026-06-04', undefined, local(2026, 8, 6));
  assert.equal(withoutCycle, withCycle);
});

test('an absent anchor is unknown, never guessed', () => {
  assert.equal(nextRenewalDate(undefined, 'monthly', local(2026, 8, 6)), null);
  assert.equal(nextRenewalDate(null, 'monthly', local(2026, 8, 6)), null);
  assert.equal(nextRenewalDate('', 'monthly', local(2026, 8, 6)), null);
});

test('an unparseable anchor is unknown, never guessed', () => {
  assert.equal(nextRenewalDate('not-a-date', 'monthly', local(2026, 8, 6)), null);
  assert.equal(nextRenewalDate('2026/09/04', 'monthly', local(2026, 8, 6)), null);
  assert.equal(nextRenewalDate('2026-13-04', 'monthly', local(2026, 8, 6)), null, 'month 13 does not exist');
  assert.equal(nextRenewalDate('2026-02-30', 'monthly', local(2026, 8, 6)), null, 'Feb 30 is not a real date');
});

test('accepts a numeric epoch ms as "now", not only a Date object', () => {
  const result = nextRenewalDate('2026-09-04', 'monthly', local(2026, 8, 6).getTime());
  assert.equal(result, '2026-09-04');
});
