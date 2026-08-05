import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchctlList, nextRun, buildCron } from '../lib/parse-launchd.mjs';

test('parses labels, pids and exit statuses', () => {
  const text = [
    'PID\tStatus\tLabel',
    '30571\t0\tcom.cloudflare.cloudflared.mini',
    '-\t0\tnet.milleradvisorypartners.linkedin-draft',
    '31880\t-15\tnet.milleradvisorypartners.linkedin-review'
  ].join('\n');
  const map = parseLaunchctlList(text);
  assert.equal(map.get('com.cloudflare.cloudflared.mini').pid, 30571);
  assert.equal(map.get('net.milleradvisorypartners.linkedin-draft').pid, null);
  assert.equal(map.get('net.milleradvisorypartners.linkedin-review').status, -15);
});

test('nextRun finds today when the time is still ahead', () => {
  const now = Date.parse('2026-08-05T01:00:00');
  const next = nextRun({ Hour: 2, Minute: 0 }, now);
  assert.equal(new Date(next).getHours(), 2);
  assert.ok(next > now);
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
    label: 'net.milleradvisorypartners.linkedin-draft',
    plist: { StartCalendarInterval: { Hour: 12, Minute: 0, Weekday: 3 } },
    statusRow: { pid: null, status: 0 }
  }, Date.parse('2026-08-05T01:00:00'));
  assert.equal(cron.ok, true);
  assert.equal(cron.name, 'linkedin-draft');
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
