// The health strip's logic (src/lib/orbit/health.js): the chips and what each
// opens. Times are built from local dates, so the tests hold in any time zone.
// Every job, service and name is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthChips, healthDetail, when } from '../src/lib/orbit/health.js';

const at = (d, h, min = 0) => new Date(2026, 9, d, h, min).getTime(); // October 2026, local
const NOW = at(21, 15, 0); // Wed 10-21, 3:00 PM
const OK = { tone: 'ok', label: 'Updated just now' };

const jobs = (list, extra = {}) => ({ status: 'ok', error: null, list, ...extra });
const J = (name, state, extra = {}) => ({ name, schedule: 'Every day, 06:00', state, reason: null, ...extra });
const services = [
  { key: 'session:Lead', kind: 'session', name: 'Lead', about: 'its session', state: 'up', startedAt: at(19, 13, 30), count: 1, launcher: { state: 'not running', lastExit: 0 }, downSince: null },
  { key: 'self:Control Room', kind: 'self', name: 'Control Room', about: null, state: 'up', startedAt: at(21, 11, 31), runs: 8, lastStop: { signal: 15, name: 'Terminated' }, downSince: null },
  { key: 'launchd:Tunnel', kind: 'launchd', name: 'Tunnel', about: null, state: 'running', launchd: 'running', reason: null, downSince: null },
  { key: 'pi:NAS', kind: 'pi', name: 'NAS', about: 'the NAS', state: 'up', label: 'up', line: 'Every check passed.', checkedAt: NOW - 120e3, why: null, downSince: null }
];
const env = (data, extra = {}) => ({ data, status: 'ok', fetchedAt: NOW, error: null, ...extra });
const all = env({ jobs: jobs([J('Brief', 'ok'), J('Scan', 'new')]), services });

test('the chips: Jobs first, then each service in order, all well', () => {
  assert.deepEqual(healthChips(all, OK).map(c => [c.key, c.label, c.value, c.tone]), [
    ['jobs', 'Jobs', 'all OK', 'ok'],
    ['session:Lead', 'Lead', 'up', 'ok'],
    ['self:Control Room', 'Control Room', 'up', 'ok'],
    ['launchd:Tunnel', 'Tunnel', 'running', 'ok'],
    ['pi:NAS', 'NAS', 'up', 'ok']
  ]);
});

test('no chips from a server older than the strip, or before its first reading', () => {
  assert.deepEqual(healthChips(undefined, OK), []);
  assert.deepEqual(healthChips({ data: null, status: 'unavailable' }, OK), []);
});

test('the Jobs chip: failures counted, a first run still to come not a failure, and the two unknowns', () => {
  const chip = j => healthChips(env({ jobs: j, services: [] }), OK)[0];
  assert.deepEqual([chip(jobs([J('A', 'failed'), J('B', 'failed'), J('C', 'new')])).value, chip(jobs([J('A', 'failed')])).tone], ['2 failed', 'bad']);
  assert.deepEqual([chip(jobs([J('C', 'new')])).value, chip(jobs([J('C', 'new')])).tone], ['all OK', 'ok']);
  assert.deepEqual([chip({ status: 'unset', list: [] }).value, chip({ status: 'unset', list: [] }).tone], ['not set up', 'idle']);
  assert.deepEqual([chip({ status: 'error', error: 'timed out after 20 s', list: [] }).value, chip({ status: 'error', list: [] }).tone], ['unknown', 'idle']);
  assert.equal(chip(jobs([])).value, 'none');
});

test('a service chip says down, not running, a warning by name, or unknown', () => {
  const chip = s => healthChips(env({ jobs: jobs([]), services: [s] }), OK)[1];
  assert.deepEqual([chip({ ...services[0], state: 'down' }).value, chip({ ...services[0], state: 'down' }).tone], ['down', 'bad']);
  assert.deepEqual([chip({ ...services[0], state: 'unknown' }).value, chip({ ...services[0], state: 'unknown' }).tone], ['unknown', 'idle']);
  assert.deepEqual([chip({ ...services[2], state: 'down' }).value, chip({ ...services[2], state: 'down' }).tone], ['not running', 'bad']);
  assert.deepEqual([chip({ ...services[3], state: 'warning', label: 'Kuma down' }).value, chip({ ...services[3], state: 'warning', label: 'Kuma down' }).tone], ['Kuma down', 'bad']);
  assert.deepEqual([chip({ ...services[3], state: 'down', label: 'degraded' }).value], ['degraded']);
  assert.deepEqual([chip({ ...services[3], state: 'unknown', label: null }).value, chip({ ...services[3], state: 'unknown', label: null }).tone], ['unknown', 'idle']);
});

test("this server's chip says what the page sees, since it can't report itself down", () => {
  const chip = fresh => healthChips(all, fresh)[2];
  assert.deepEqual([chip(OK).value, chip(OK).tone], ['up', 'ok']);
  assert.deepEqual([chip({ tone: 'stale' }).value, chip({ tone: 'stale' }).tone], ['not current', 'idle']);
  assert.deepEqual([chip({ tone: 'down' }).value, chip({ tone: 'down' }).tone], ['no answer', 'bad']);
  assert.equal(chip({ tone: 'waiting' }).value, '…');
});

test('the Jobs details: a count with what is wrong, each job with its schedule, and a failure with its reason', () => {
  const d = healthDetail(env({ jobs: jobs([J('Brief', 'failed', { reason: 'last exit code 1' }), J('Scan', 'new', { schedule: null }), J('Sync', 'ok')]), services }), 'jobs', OK, NOW);
  assert.equal(d.title, 'Scheduled jobs');
  assert.equal(d.note, "3 jobs · 1 failed · 1 hasn't had its first run yet");
  assert.deepEqual(d.rows, [
    { name: 'Brief', when: 'Every day, 06:00', state: 'failed: last exit code 1', tone: 'bad' },
    { name: 'Scan', when: 'no schedule', state: 'not run yet', tone: 'idle' },
    { name: 'Sync', when: 'Every day, 06:00', state: 'OK', tone: 'ok' }
  ]);
  assert.equal(healthDetail(env({ jobs: jobs([J('A', 'new'), J('B', 'new')]), services }), 'jobs', OK, NOW).note, "2 jobs · 2 haven't had their first run yet");
  assert.equal(healthDetail(env({ jobs: { status: 'error', error: 'timed out after 20 s', list: [] }, services }), 'jobs', OK, NOW).note, 'Unknown: job-status timed out after 20 s.');
  assert.equal(healthDetail(env({ jobs: { status: 'unset', list: [] }, services }), 'jobs', OK, NOW).note, 'Not set up: config.json names no job-status.');
});

test("the lead's details: its session since when, and the launcher's state as a detail, not a verdict", () => {
  const d = healthDetail(all, 'session:Lead', OK, NOW);
  assert.equal(d.title, 'Lead');
  assert.equal(d.note, 'its session · judged by its session alone');
  assert.deepEqual(d.rows, [
    { name: 'Session', when: 'running since Mon 1:30 PM', state: 'up', tone: 'ok' },
    { name: 'Launcher', when: 'starts the session, then exits', state: 'not running · exit 0', tone: 'idle' }
  ]);
  const down = healthDetail(env({ jobs: jobs([]), services: [{ ...services[0], state: 'down', downSince: at(21, 14, 50), launcher: null }] }), 'session:Lead', OK, NOW);
  assert.deepEqual(down.rows, [{ name: 'Session', when: 'none running since 2:50 PM', state: 'down', tone: 'bad' }]);
  const two = healthDetail(env({ jobs: jobs([]), services: [{ ...services[0], count: 2 }] }), 'session:Lead', OK, NOW);
  assert.match(two.rows[0].when, / · 2 sessions have this name$/);
});

test("this server's details: started when, restarts since launchd loaded it, and how the last run ended", () => {
  const d = healthDetail(all, 'self:Control Room', OK, NOW);
  assert.deepEqual(d.rows, [
    { name: 'Server', when: 'started 11:31 AM', state: 'up', tone: 'ok' },
    { name: 'Restarts', when: 'since launchd loaded it', state: '7', tone: 'idle' },
    { name: 'Last stop', when: 'how the run before this one ended', state: 'signal 15 (Terminated)', tone: 'idle' }
  ]);
  assert.match(d.note, /can't report itself down/);
  const bare = healthDetail(env({ jobs: jobs([]), services: [{ ...services[1], runs: null, lastStop: null }] }), 'self:Control Room', { tone: 'down' }, NOW);
  assert.deepEqual(bare.rows.map(r => r.state), ['no answer', 'unknown', 'none on record']);
  const exited = healthDetail(env({ jobs: jobs([]), services: [{ ...services[1], lastStop: { exit: 1 } }] }), 'self:Control Room', OK, NOW);
  assert.equal(exited.rows[2].state, 'exit 1');
});

test("a KeepAlive job's details: running, not running since when, or unknown with the reason", () => {
  const one = s => healthDetail(env({ jobs: jobs([]), services: [s] }), 'launchd:Tunnel', OK, NOW).rows;
  assert.deepEqual(one(services[2]), [{ name: 'launchd', when: 'its KeepAlive job', state: 'running', tone: 'ok' }]);
  assert.deepEqual(one({ ...services[2], state: 'down', launchd: 'not loaded', downSince: at(21, 14, 0) }),
    [{ name: 'launchd', when: 'not running since 2:00 PM', state: 'not loaded', tone: 'bad' }]);
  assert.deepEqual(one({ ...services[2], state: 'unknown', launchd: null, reason: 'job-status timed out after 20 s' }),
    [{ name: 'launchd', when: 'job-status timed out after 20 s', state: 'unknown', tone: 'idle' }]);
  assert.match(healthDetail(all, 'launchd:Tunnel', OK, NOW).note, /proves the process, not the connection/);
});

test("the NAS's details: the watch's word and when it last ran, or why it doesn't count", () => {
  assert.deepEqual(healthDetail(all, 'pi:NAS', OK, NOW).rows, [
    { name: 'State', when: 'Every check passed.', state: 'up', tone: 'ok' },
    { name: 'Watch', when: 'last ran 2 min ago', state: 'current', tone: 'idle' }
  ]);
  const unknown = healthDetail(env({ jobs: jobs([]), services: [{ ...services[3], state: 'unknown', label: null, line: null, why: 'the watch is not OK: last exit code 1', checkedAt: null }] }), 'pi:NAS', OK, NOW);
  assert.deepEqual(unknown.rows, [
    { name: 'State', when: 'the watch is not OK: last exit code 1', state: 'unknown', tone: 'idle' },
    { name: 'Watch', when: 'no run on record', state: 'not current', tone: 'idle' }
  ]);
  const warn = healthDetail(env({ jobs: jobs([]), services: [{ ...services[3], state: 'warning', label: 'no SSH', line: 'Up, but the SSH probe failed.' }] }), 'pi:NAS', OK, NOW);
  assert.deepEqual([warn.rows[0].state, warn.rows[0].tone], ['no SSH', 'bad']);
});

test("an old reading says how old, and a key that names nothing opens nothing", () => {
  const stale = { ...all, status: 'stale', fetchedAt: NOW - 5 * 60e3 };
  assert.match(healthDetail(stale, 'jobs', OK, NOW).note, /^Reading from 5 min ago · 2 jobs/);
  assert.equal(healthDetail(all, 'launchd:Gone', OK, NOW), null);
  assert.equal(healthDetail(all, null, OK, NOW), null);
  assert.equal(healthDetail(undefined, 'jobs', OK, NOW), null);
});

test('a moment: the time today, the weekday this week, the date before that', () => {
  assert.equal(when(at(21, 9, 5), NOW), '9:05 AM');
  assert.equal(when(at(19, 13, 30), NOW), 'Mon 1:30 PM');
  assert.equal(when(at(2, 13, 30), NOW), '10-02 1:30 PM');
  assert.equal(when(null, NOW), '—');
});
