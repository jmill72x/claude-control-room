import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown, formatShort, formatRelative, formatSchedule } from '../lib/humanize.mjs';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test('countdown shows H:MM:SS above an hour', () => {
  assert.equal(formatCountdown(HOUR + 42 * MIN + 9000), '1:42:09');
});

test('countdown shows MM:SS below an hour', () => {
  assert.equal(formatCountdown(9 * MIN + 5000), '09:05');
});

test('countdown clamps negatives to zero', () => {
  assert.equal(formatCountdown(-5000), '00:00');
});

test('short form picks the two largest units', () => {
  assert.equal(formatShort(2 * DAY + 4 * HOUR), '2d 4h');
  assert.equal(formatShort(10 * HOUR + 50 * MIN), '10h 50m');
  assert.equal(formatShort(23 * MIN), '23m');
});

test('relative time reads naturally', () => {
  assert.equal(formatRelative(4 * MIN), '4m ago');
  assert.equal(formatRelative(3 * HOUR), '3h ago');
  assert.equal(formatRelative(2 * DAY), '2d ago');
});

test('schedule renders calendar intervals', () => {
  assert.equal(formatSchedule({ Hour: 2, Minute: 0 }, null), 'Every day, 02:00');
  assert.equal(formatSchedule({ Hour: 12, Minute: 0, Weekday: 3 }, null), 'Wednesdays, 12:00');
});

test('a partially specified calendar is not filled in with zeros (T1)', () => {
  // launchd treats an omitted key as a wildcard: {Minute: 30} is hourly at :30.
  // "Every day, 00:30" would state a schedule the job does not keep.
  assert.equal(formatSchedule({ Minute: 30 }, null), 'Every hour at :30');
  assert.equal(formatSchedule({ Minute: 5, Weekday: 1 }, null), 'Mondays, every hour at :05');
  assert.equal(formatSchedule({ Hour: 3 }, null), 'Every day, 03:00–03:59, every minute');
  assert.equal(formatSchedule({ Weekday: 2 }, null), 'Tuesdays, every minute');
  assert.equal(formatSchedule({}, null), 'Every minute');
});

test('schedule renders second intervals', () => {
  assert.equal(formatSchedule(null, 3600), 'Every hour');
  assert.equal(formatSchedule(null, 300), 'Every 5 minutes');
});

test('schedule falls back rather than inventing', () => {
  assert.equal(formatSchedule(null, null), 'On demand');
});

// launchd accepts an ARRAY of calendar dictionaries (run at 08:00 and 20:00).
// An array is an object, so it fell into the single-dictionary path with every
// key undefined and rendered as "Every minute" — a schedule the job never keeps.
test('an array-form calendar lists each entry rather than collapsing to "Every minute"', () => {
  assert.equal(
    formatSchedule([{ Hour: 8, Minute: 0 }, { Hour: 20, Minute: 0 }], null),
    'Every day, 08:00 · Every day, 20:00'
  );
  assert.equal(formatSchedule([{ Weekday: 1, Hour: 9, Minute: 30 }], null), 'Mondays, 09:30');
  assert.equal(formatSchedule([], null), 'On demand', 'an empty array specifies no schedule at all');
});

// Day and Month were ignored, so a job for the 1st of each month read "Every
// day, 06:00", once per calendar entry (2026-10-21). The next run was right;
// only the words were wrong.
test('a day of the month is said, and a month too', () => {
  assert.equal(formatSchedule({ Day: 1, Hour: 6, Minute: 0 }, null), '1st of each month, 06:00');
  assert.equal(formatSchedule({ Month: 1, Day: 1, Hour: 6, Minute: 30 }, null), '1st of Jan, 06:30');
  assert.equal(formatSchedule({ Month: 2, Hour: 6, Minute: 0 }, null), 'Every day in Feb, 06:00');
  assert.equal(formatSchedule({ Month: 3, Weekday: 1, Hour: 9, Minute: 0 }, null), 'Mondays in Mar, 09:00');
  assert.equal(formatSchedule({ Day: 15, Minute: 5 }, null), '15th of each month, every hour at :05');
  assert.equal(formatSchedule({ Day: 2, Hour: 3 }, null), '2nd of each month, 03:00–03:59, every minute');
  assert.equal(formatSchedule({ Day: 23 }, null), '23rd of each month, every minute');
  assert.equal(formatSchedule({ Weekday: 5, Day: 13, Hour: 9, Minute: 0 }, null), 'Fridays on the 13th of each month, 09:00');
});

test('ordinals: 11th to 13th, 21st, 22nd and 31st', () => {
  const phrase = d => formatSchedule({ Day: d, Hour: 0, Minute: 0 }, null).split(' ')[0];
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(phrase),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
});

test('entries that differ only in their month share one phrase, months in order', () => {
  const quarterly = [10, 1, 7, 4].map(Month => ({ Day: 1, Hour: 6, Minute: 30, Month }));
  assert.equal(formatSchedule(quarterly, null), '1st of Jan, Apr, Jul and Oct, 06:30');
  const rest = [2, 3, 5, 6, 8, 9, 11, 12].map(Month => ({ Day: 1, Hour: 6, Minute: 0, Month }));
  assert.equal(formatSchedule(rest, null), '1st of Feb, Mar, May, Jun, Aug, Sep, Nov and Dec, 06:00');
  // A monthless entry covers every month, so it never joins the group.
  assert.equal(formatSchedule([{ Day: 1, Hour: 6, Minute: 0 }, { Day: 1, Hour: 6, Minute: 0, Month: 3 }], null),
    '1st of each month, 06:00 · 1st of Mar, 06:00');
  // Two entries that say the same thing are said once.
  assert.equal(formatSchedule([{ Hour: 8, Minute: 0 }, { Hour: 8, Minute: 0 }], null), 'Every day, 08:00');
  // Different times stay apart.
  assert.equal(formatSchedule([{ Day: 1, Hour: 6, Minute: 0, Month: 1 }, { Day: 1, Hour: 7, Minute: 0, Month: 2 }], null),
    '1st of Jan, 06:00 · 1st of Feb, 07:00');
});

test('entries that differ only in their weekday share one phrase: a run of days, or a list', () => {
  const weekdays = [1, 2, 3, 4, 5].map(Weekday => ({ Weekday, Hour: 7, Minute: 30 }));
  assert.equal(formatSchedule(weekdays, null), 'Mondays to Fridays, 07:30');
  assert.equal(formatSchedule([{ Weekday: 4, Hour: 9, Minute: 0 }, { Weekday: 1, Hour: 9, Minute: 0 }], null), 'Mondays and Thursdays, 09:00');
  assert.equal(formatSchedule([0, 2, 4].map(Weekday => ({ Weekday, Hour: 9, Minute: 0 })), null), 'Sundays, Tuesdays and Thursdays, 09:00');
  // Different times stay apart, and an entry with both keys keeps its own.
  assert.equal(formatSchedule([{ Weekday: 2, Hour: 16, Minute: 45 }, { Weekday: 5, Hour: 16, Minute: 45 }, { Weekday: 0, Hour: 11, Minute: 45 }], null),
    'Tuesdays and Fridays, 16:45 · Sundays, 11:45');
  assert.equal(formatSchedule([{ Weekday: 1, Month: 3, Hour: 9, Minute: 0 }, { Weekday: 2, Month: 3, Hour: 9, Minute: 0 }], null),
    'Mondays in Mar, 09:00 · Tuesdays in Mar, 09:00');
});
