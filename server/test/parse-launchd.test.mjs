import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchctlList, nextRun, buildCron } from '../lib/parse-launchd.mjs';

test('parses labels, pids and exit statuses', () => {
  const text = [
    'PID\tStatus\tLabel',
    '30571\t0\tcom.example.tunnel.host',
    '-\t0\tnet.example.nightly-draft',
    '31880\t-15\tnet.example.review-server'
  ].join('\n');
  const map = parseLaunchctlList(text);
  assert.equal(map.get('com.example.tunnel.host').pid, 30571);
  assert.equal(map.get('net.example.nightly-draft').pid, null);
  assert.equal(map.get('net.example.review-server').status, -15);
});

test('nextRun finds today when the time is still ahead', () => {
  const now = Date.parse('2026-08-05T01:00:00');
  const next = nextRun({ Hour: 2, Minute: 0 }, now);
  const DAY = 24 * 3600 * 1000;
  assert.equal(new Date(next).getHours(), 2);
  assert.ok(next > now);
  // A mutant that unconditionally rolls to tomorrow would also land on hour 2
  // and still be in the future, so pin the elapsed time too: later today is
  // under a day away, tomorrow is not.
  assert.ok(next - now < DAY, 'expected later today, not a full day away');
});

test('nextRun rolls to tomorrow when the time has passed', () => {
  const now = Date.parse('2026-08-05T03:00:00');
  const next = nextRun({ Hour: 2, Minute: 0 }, now);
  assert.ok(next - now > 20 * 3600 * 1000);
});

test('nextRun honours a weekday', () => {
  const now = Date.parse('2026-08-05T13:00:00'); // Wednesday
  const next = nextRun({ Hour: 7, Minute: 0, Weekday: 1 }, now);
  assert.equal(new Date(next).getDay(), 1);
});

test('nextRun rolls a full week when today is the scheduled weekday but the time already passed', () => {
  const now = Date.parse('2026-08-05T13:00:00'); // Wednesday, getDay() === 3
  const next = nextRun({ Hour: 7, Minute: 0, Weekday: 3 }, now);
  const DAY = 24 * 3600 * 1000;
  // Weekday alone can't distinguish correct from buggy here: dropping the
  // "already passed today" guard also returns a Wednesday (today's, at
  // 07:00) which is a moment that has already gone by. Assert on the
  // elapsed delta, which the two outcomes actually disagree on.
  assert.ok(next > now, 'must not return a time already in the past');
  assert.ok(next - now > 6 * DAY, 'should roll a full week, not stay on today');
});

test('nextRun returns null when there is no calendar entry', () => {
  assert.equal(nextRun(null, Date.now()), null);
});

test('a non-zero exit status marks the cron failing', () => {
  const now = Date.parse('2026-08-05T01:00:00');
  const cron = buildCron({
    label: 'net.example.thing',
    plist: { StartCalendarInterval: { Hour: 2, Minute: 0 } },
    statusRow: { pid: null, status: -15 }
  }, now);
  assert.equal(cron.ok, false);
  assert.equal(cron.schedule, 'Every day, 02:00');
  assert.match(cron.last, /-15/);
});

test('a zero exit status is healthy and names the job readably', () => {
  const cron = buildCron({
    label: 'net.example.nightly-draft',
    plist: { StartCalendarInterval: { Hour: 12, Minute: 0, Weekday: 3 } },
    statusRow: { pid: null, status: 0 }
  }, Date.parse('2026-08-05T01:00:00'));
  assert.equal(cron.ok, true);
  assert.equal(cron.name, 'nightly-draft');
  assert.equal(cron.last, 'OK');
});

test('a running job with no exit status is healthy', () => {
  const cron = buildCron({
    label: 'com.example.daemon',
    plist: { StartInterval: 3600 },
    statusRow: { pid: 1234, status: null }
  }, Date.now());
  assert.equal(cron.ok, true);
  assert.equal(cron.schedule, 'Every hour');
});

test('a job absent from launchctl list (no statusRow at all) is treated as healthy', () => {
  // Task 8 does map.get(label) against jobs parsed from launchctl list; a
  // label with no matching row yields undefined, not an object with a null
  // status field. That's a distinct shape from the case above and nothing
  // else exercises it.
  const cron = buildCron({
    label: 'com.example.no-status',
    plist: { StartInterval: 3600 }
  }, Date.now());
  assert.equal(cron.ok, true);
  assert.equal(cron.last, 'OK');
});
