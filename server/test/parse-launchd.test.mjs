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

test('a job absent from launchctl list (no statusRow at all) is healthy but is not claimed to have succeeded', () => {
  // Task 8 does map.get(label) against jobs parsed from launchctl list; a
  // label with no matching row yields undefined, not an object with a null
  // status field. That's a distinct shape from the case above and nothing
  // else exercises it.
  const cron = buildCron({
    label: 'com.example.no-status',
    plist: { StartInterval: 3600 }
  }, Date.now());
  assert.equal(cron.ok, true, 'never-run is not a failure, so it must not alert');
  assert.equal(cron.state, 'never');
  assert.equal(cron.last, 'Not yet run', '"OK" would claim a completed run that never happened');
});

test('a loaded job with a null exit status is pending, not a confirmed success', () => {
  const cron = buildCron({
    label: 'com.example.daemon',
    plist: { StartInterval: 3600 },
    statusRow: { pid: 1234, status: null }
  }, Date.now());
  assert.equal(cron.state, 'never');
  assert.equal(cron.last, 'Not yet run');
});

test('a completed zero exit is reported as OK, distinctly from never-run', () => {
  const cron = buildCron({
    label: 'com.example.done',
    plist: { StartInterval: 3600 },
    statusRow: { pid: null, status: 0 }
  }, Date.now());
  assert.equal(cron.state, 'ok');
  assert.equal(cron.last, 'OK');
});

test('a minute-only calendar is hourly, not midnight (T1)', () => {
  // {Minute: 30} means every hour at :30. Defaulting Hour to 0 produced a
  // countdown up to 24 hours wrong and a schedule line the job does not keep.
  const now = Date.parse('2026-08-05T09:05:00');
  const next = nextRun({ Minute: 30 }, now);
  assert.equal(new Date(next).getHours(), 9);
  assert.equal(new Date(next).getMinutes(), 30);
  assert.ok(next - now < 3600000, 'must be within the hour, not tomorrow morning');
});

test('a minute-only calendar rolls into the next hour once the minute has passed', () => {
  const now = Date.parse('2026-08-05T09:45:00');
  const next = nextRun({ Minute: 30 }, now);
  assert.equal(new Date(next).getHours(), 10);
  assert.equal(new Date(next).getMinutes(), 30);
});

test('an hour-only calendar fires within that hour, not at some invented minute', () => {
  const now = Date.parse('2026-08-05T09:05:00');
  const next = nextRun({ Hour: 14 }, now);
  assert.equal(new Date(next).getHours(), 14);
  assert.equal(new Date(next).getMinutes(), 0);
});

test('a weekday plus a bare minute stays on that weekday and repeats hourly', () => {
  const now = Date.parse('2026-08-05T13:10:00'); // Wednesday
  const next = nextRun({ Minute: 15, Weekday: 3 }, now);
  assert.equal(new Date(next).getDay(), 3);
  assert.equal(new Date(next).getMinutes(), 15);
  assert.ok(next - now < 3600000, 'the next :15 today, not next Wednesday');
});

test('a calendar with no usable key returns null rather than a guessed midnight', () => {
  assert.equal(nextRun({}, Date.parse('2026-08-05T09:05:00')), null);
});

test('a day-of-month calendar lands on that day', () => {
  const now = Date.parse('2026-08-05T09:05:00');
  const next = nextRun({ Day: 20, Hour: 6, Minute: 0 }, now);
  const d = new Date(next);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 6);
});
