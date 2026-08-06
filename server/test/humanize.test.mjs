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
