// The health strip's pure parts (lib/health.mjs, Orbit plan Phase 2). Every
// label, path, name and figure here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readHealthConfig, claimedLabels, parseJobStatus, jobVerdict, overlayCrons, buildJobs, ANSWER_FRESH_MS,
  parseLaunchctlPrint, lastStop, parseEtime, findSession, sessionView, selfView, launchdView, piView, stampDown
} from '../lib/health.mjs';

const H = 3600e3;
const NOW = Date.parse('2026-10-21T15:00:00Z');

const SERVICES = [
  { kind: 'session', name: 'Lead', session: 'Lead', launcher: 'com.example.lead', about: "the lead's session" },
  { kind: 'self', name: 'Control Room', label: 'com.example.control-room' },
  { kind: 'launchd', name: 'Tunnel', label: 'com.example.tunnel' },
  { kind: 'launchd', name: 'Review page', label: 'com.example.review' },
  { kind: 'pi', name: 'NAS', stateFile: '/tmp/x/watch.state', log: '/tmp/x/watch.log', watchJob: 'com.example.nas-watch' }
];
const settings = () => readHealthConfig({ health: { jobStatus: '/opt/example/job-status', services: SERVICES } });

const job = (label, extra = {}) => ({
  label, state: 'not running', last_exit: 0, log_path: `/private/logs/${label}.log`, log_age_hours: 2,
  max_age_hours: 26, ok: true, reason: null, ...extra
});
const report = jobs => JSON.stringify({ generated_at: '2026-10-21T11:00:00-04:00', jobs });
const answerOf = (jobs, receivedAt = NOW) => ({ ...parseJobStatus(report(jobs)), receivedAt });

// ---- the config block ----

test('no health block is no services and no problems', () => {
  assert.deepEqual(readHealthConfig({}), { jobStatus: null, services: [], problems: [] });
});

test('a full block gives each service a key, in the order given', () => {
  const s = settings();
  assert.deepEqual(s.problems, []);
  assert.equal(s.jobStatus, '/opt/example/job-status');
  assert.deepEqual(s.services.map(x => x.key), ['session:Lead', 'self:Control Room', 'launchd:Tunnel', 'launchd:Review page', 'pi:NAS']);
  assert.equal(s.services[0].launcher, 'com.example.lead');
  assert.equal(s.services[4].watchJob, 'com.example.nas-watch');
});

test('each bad entry is left out and said, and the good ones stay', () => {
  const s = readHealthConfig({
    health: {
      jobStatus: 'relative/job-status',
      services: [
        { kind: 'launchd', name: 'Good', label: 'com.example.good' },
        { kind: 'launchd', name: 'Good', label: 'com.example.again' },
        { kind: 'launchd', name: 'Spaced', label: 'com.example.bad label' },
        { kind: 'cron', name: 'Odd' },
        { kind: 'session', name: 'Two words', session: 'Two words' },
        { kind: 'self', name: 'Me', label: 'com.example.me' },
        { kind: 'self', name: 'Me too', label: 'com.example.me2' },
        { kind: 'pi', name: 'NAS', stateFile: 'watch.state', log: '/x/watch.log', watchJob: 'com.example.w' },
        { kind: 'launchd', label: 'com.example.nameless' },
        { kind: 'launchd', name: 'Chatty', label: 'com.example.chatty', about: 'x'.repeat(121) }
      ]
    }
  });
  assert.equal(s.jobStatus, null);
  assert.deepEqual(s.services.map(x => x.name), ['Good', 'Me', 'Chatty']);
  assert.equal(s.services[2].about, null);
  assert.equal(s.problems.length, 9);
  assert.match(s.problems.join('\n'), /jobStatus must be an absolute path/);
  assert.match(s.problems.join('\n'), /only one self service/);
  assert.match(s.problems.join('\n'), /session must be a name with no spaces/);
});

test('the labels a service chip speaks for: its own, and the launcher, never the watch job', () => {
  assert.deepEqual([...claimedLabels(settings())].sort(),
    ['com.example.control-room', 'com.example.lead', 'com.example.review', 'com.example.tunnel']);
});

// ---- job-status's answer ----

test('job-status is read down to the fields used, and the rest is dropped', () => {
  const a = parseJobStatus(report([job('com.example.brief', { error: 'OSError', extra: 1 })]));
  assert.equal(a.generatedAt, Date.parse('2026-10-21T15:00:00Z'));
  assert.deepEqual(a.jobs, [{ label: 'com.example.brief', state: 'not running', lastExit: 0, logAgeHours: 2, maxAgeHours: 26, ok: true, reason: null }]);
});

test('a reason is one plain line, and an entry with an unusable label is skipped', () => {
  const a = parseJobStatus(report([
    job('com.example.a', { ok: false, reason: 'last exit code 3;\nlog\u0007 old' }),
    job('com example b'),
    job(42),
    'not an entry'
  ]));
  assert.deepEqual(a.jobs.map(j => j.label), ['com.example.a']);
  assert.equal(a.jobs[0].reason, 'last exit code 3; log old');
});

test('an answer that is not usable throws, naming what was wrong', () => {
  assert.throws(() => parseJobStatus('{"generated'), /other than JSON/);
  assert.throws(() => parseJobStatus(JSON.stringify({ generated_at: '2026-10-21T11:00:00-04:00' })), /no list of jobs/);
  assert.throws(() => parseJobStatus(JSON.stringify({ jobs: [] })), /no time/);
  assert.throws(() => parseJobStatus(report([{ label: null, ok: false, reason: 'could not list the LaunchAgents folder' }])),
    /^Error: job-status: could not list the LaunchAgents folder$/);
});

test("a job's verdict: OK, not run yet, or failed with its reason, and when it last ran", () => {
  const at = NOW;
  const parse = e => parseJobStatus(report([e])).jobs[0];
  assert.deepEqual(jobVerdict(parse(job('a')), at), { state: 'ok', reason: null, lastRunAt: at - 2 * H });
  assert.deepEqual(jobVerdict(parse(job('b', { last_exit: null, log_age_hours: null })), at), { state: 'new', reason: null, lastRunAt: null });
  // A log, but no exit since launchd loaded it: it has run before.
  assert.equal(jobVerdict(parse(job('c', { last_exit: null })), at).state, 'ok');
  assert.deepEqual(jobVerdict(parse(job('d', { ok: false, last_exit: 1, reason: 'last exit code 1' })), at),
    { state: 'failed', reason: 'last exit code 1', lastRunAt: at - 2 * H });
});

// ---- one verdict everywhere: the crons panel ----

const cron = (label, extra = {}) => ({ name: label.split('.').pop(), label, schedule: 'Every day, 06:00', nextRunAt: NOW + H, dueAt: [], ok: true, state: 'ok', last: 'OK', ...extra });

test("the crons panel takes job-status's verdict, keeps its shape, and puts failures first", () => {
  const crons = [cron('com.example.a'), cron('com.example.b', { nextRunAt: NOW + 2 * H }), cron('com.example.c'), cron('com.example.d'), cron('com.other.e', { ok: false, state: 'failed', last: 'Failed · 9' })];
  const answer = answerOf([
    job('com.example.a', { ok: false, last_exit: 2, reason: 'last exit code 2' }),
    job('com.example.b', { ok: false, log_age_hours: 30.4, reason: 'log last written 30.4 h ago, more than the 26 h expected' }),
    job('com.example.c', { last_exit: null, log_age_hours: null }),
    job('com.example.d', { ok: false, state: 'not loaded', last_exit: null, log_age_hours: null, reason: 'not loaded in launchd' })
  ]);
  const out = overlayCrons(crons, answer, NOW);
  const by = Object.fromEntries(out.map(c => [c.label, c]));
  assert.deepEqual([by['com.example.a'].ok, by['com.example.a'].state, by['com.example.a'].last], [false, 'failed', 'Failed · 2']);
  assert.equal(by['com.example.b'].last, 'Overdue · log 30 h old');
  assert.deepEqual([by['com.example.c'].ok, by['com.example.c'].state, by['com.example.c'].last], [true, 'never', 'Not yet run']);
  assert.equal(by['com.example.d'].last, 'Not loaded');
  assert.deepEqual(by['com.other.e'], crons[4], 'a job job-status does not cover keeps launchd\'s verdict');
  assert.equal(by['com.example.a'].lastRunAt, NOW - 2 * H);
  assert.equal(by['com.example.a'].schedule, 'Every day, 06:00');
  assert.deepEqual(out.map(c => c.ok), [false, false, false, false, true], 'failed first');
});

test('with no answer, or one older than three polls, the crons panel is left as launchd has it', () => {
  const crons = [cron('com.example.a')];
  const failing = [job('com.example.a', { ok: false, last_exit: 1, reason: 'last exit code 1' })];
  assert.equal(overlayCrons(crons, null, NOW), crons);
  assert.equal(overlayCrons(crons, answerOf(failing, NOW - ANSWER_FRESH_MS - 1), NOW), crons);
  assert.equal(overlayCrons(crons, answerOf(failing, NOW - ANSWER_FRESH_MS), NOW)[0].ok, false);
});

// ---- the Jobs chip ----

test('the Jobs list: every unclaimed job, named from config, with its schedule, failures first, and no label', () => {
  const answer = answerOf([
    job('com.example.lead', { last_exit: 0, max_age_hours: null }),
    job('com.example.alpha'),
    job('com.example.beta', { ok: false, last_exit: 1, reason: 'last exit code 1' }),
    job('com.example.gamma', { last_exit: null, log_age_hours: null }),
    job('com.example.nas-watch', { max_age_hours: 0.25 }),
    job('com.example.tunnel', { state: 'running', max_age_hours: null })
  ]);
  const jobs = buildJobs({
    settings: settings(), answer,
    crons: [cron('com.example.alpha', { schedule: 'Mondays, 05:30' })],
    jobNames: { 'com.example.alpha': { name: 'Alpha report' } }
  });
  assert.equal(jobs.status, 'ok');
  assert.deepEqual(jobs.list, [
    { name: 'beta', schedule: null, state: 'failed', reason: 'last exit code 1' },
    { name: 'Alpha report', schedule: 'Mondays, 05:30', state: 'ok', reason: null },
    { name: 'gamma', schedule: null, state: 'new', reason: null },
    { name: 'nas-watch', schedule: null, state: 'ok', reason: null }
  ]);
  assert.ok(!JSON.stringify(jobs).includes('com.example'), 'no label reaches the page');
});

test('the Jobs chip without a path is not set up, and without an answer it says why', () => {
  assert.deepEqual(buildJobs({ settings: readHealthConfig({}), answer: null }), { status: 'unset', error: null, list: [] });
  assert.deepEqual(buildJobs({ settings: settings(), answer: null, error: 'timed out after 20 s' }),
    { status: 'error', error: 'timed out after 20 s', list: [] });
});

// ---- launchctl print, for this server ----

const PRINTED = [
  'gui/501/com.example.control-room = {',
  '\tactive count = 1',
  '\tpath = /Users/example/Library/LaunchAgents/com.example.control-room.plist',
  '\ttype = LaunchAgent',
  '\tendpoints = {',
  '\t\tstate = active',
  '\t\truns = 99',
  '\t}',
  '\tstate = running',
  '',
  '\tprogram = /opt/homebrew/bin/node',
  '\tenvironment = {',
  '\t\tSECRETISH => not-a-real-value',
  '\t}',
  '\truns = 8',
  '\tpid = 4242',
  '\tlast terminating signal = Terminated: 15',
  '}'
].join('\n');

test('launchctl print: top-level state, runs and how the last run ended, and nothing else', () => {
  const p = parseLaunchctlPrint(PRINTED);
  assert.deepEqual(p, { state: 'running', runs: 8, lastExit: null, lastSignal: 15 });
  assert.deepEqual(parseLaunchctlPrint('\tstate = not running\n\truns = 1\n\tlast exit code = (never exited)\n'),
    { state: 'not running', runs: 1, lastExit: null, lastSignal: null });
  assert.deepEqual(parseLaunchctlPrint('\tlast exit code = 1: Operation not permitted\n').lastExit, 1);
  assert.deepEqual(parseLaunchctlPrint(''), { state: null, runs: null, lastExit: null, lastSignal: null });
});

test('the last stop: a signal by name, else an exit code, else nothing', () => {
  assert.deepEqual(lastStop({ lastSignal: 15, lastExit: null }), { signal: 15, name: 'Terminated' });
  assert.deepEqual(lastStop({ lastSignal: 31, lastExit: null }), { signal: 31, name: null });
  assert.deepEqual(lastStop({ lastSignal: null, lastExit: 1 }), { exit: 1 });
  assert.equal(lastStop({ lastSignal: null, lastExit: null }), null);
});

// ---- ps, for the lead's session ----

test("ps's elapsed time", () => {
  assert.equal(parseEtime('07:28'), (7 * 60 + 28) * 1000);
  assert.equal(parseEtime('01:02:03'), 3723 * 1000);
  assert.equal(parseEtime('2-22:07:28'), ((2 * 24 + 22) * 3600 + 7 * 60 + 28) * 1000);
  assert.equal(parseEtime('soon'), null);
  assert.equal(parseEtime(undefined), null);
});

test('a session is the claude process started with its name, however the name is passed', () => {
  const ps = [
    '  101 2-00:00:00 claude -n Lead --channels plugin:chat --add-dir /tmp',
    '  102    05:00 /usr/local/bin/claude --name Lead',
    '  103    01:00 /Users/example/.local/share/claude/versions/9.9.9 --name=Lead -p',
    '  104    09:00 claude -n Leader',
    '  105    09:00 grep -n Lead notes.txt',
    '  106    09:00 node claude -n Lead',
    '  107    09:00 claude --resume abc',
    'garbage line'
  ].join('\n');
  const found = findSession(ps, 'Lead', NOW);
  assert.equal(found.count, 3);
  assert.equal(found.startedAt, NOW - 2 * 24 * H);
  assert.deepEqual(findSession(ps, 'Nobody', NOW), { count: 0, startedAt: null });
});

// ---- the services, as the page gets them ----

const svc = i => settings().services[i];

test('the lead: up with its start, down when ps has no such process, unknown when ps failed', () => {
  const launcher = { label: 'com.example.lead', state: 'not running', lastExit: 0, logAgeHours: 1, maxAgeHours: null, ok: true, reason: null };
  const up = sessionView(svc(0), { count: 1, startedAt: NOW - H }, launcher);
  assert.deepEqual(up, {
    key: 'session:Lead', kind: 'session', name: 'Lead', about: "the lead's session",
    state: 'up', startedAt: NOW - H, count: 1, launcher: { state: 'not running', lastExit: 0 }
  });
  assert.equal(sessionView(svc(0), { count: 0, startedAt: null }, null).state, 'down');
  const unknown = sessionView(svc(0), null, null);
  assert.deepEqual([unknown.state, unknown.count, unknown.launcher], ['unknown', null, null]);
});

test('this server: up, with its start, run count and how the run before it ended', () => {
  assert.deepEqual(selfView(svc(1), NOW - 60e3, { state: 'running', runs: 8, lastExit: null, lastSignal: 15 }), {
    key: 'self:Control Room', kind: 'self', name: 'Control Room', about: null,
    state: 'up', startedAt: NOW - 60e3, runs: 8, lastStop: { signal: 15, name: 'Terminated' }
  });
  assert.deepEqual([selfView(svc(1), NOW, null).runs, selfView(svc(1), NOW, null).lastStop], [null, null]);
});

test("a KeepAlive job: running, down with launchd's word, or unknown with the reason", () => {
  const e = (state, reason = null) => ({ label: 'com.example.tunnel', state, lastExit: null, logAgeHours: null, maxAgeHours: null, ok: state === 'running', reason });
  assert.equal(launchdView(svc(2), e('running'), null).state, 'running');
  assert.deepEqual([launchdView(svc(2), e('not running'), null).state, launchdView(svc(2), e('not running'), null).launchd], ['down', 'not running']);
  assert.equal(launchdView(svc(2), e('not loaded'), null).state, 'down');
  assert.deepEqual([launchdView(svc(2), e(null, 'launchctl print failed (TimeoutExpired)'), null).state, launchdView(svc(2), e(null, 'launchctl print failed (TimeoutExpired)'), null).reason],
    ['unknown', 'launchctl print failed (TimeoutExpired)']);
  assert.equal(launchdView(svc(2), null, null).reason, 'job-status does not list it');
  assert.deepEqual([launchdView(svc(2), e('running'), 'job-status timed out after 20 s').state, launchdView(svc(2), null, 'job-status timed out after 20 s').reason],
    ['unknown', 'job-status timed out after 20 s']);
  assert.ok(!JSON.stringify(launchdView(svc(2), e('running'), null)).includes('com.example'), 'no label reaches the page');
});

test("the NAS: each token as the contract says, and only while the watch is fresh", () => {
  const read = (token, fresh = true, why = null) => piView(svc(4), { token, fresh, checkedAt: NOW - 120e3, why });
  assert.deepEqual([read('UP').state, read('UP').label], ['up', 'up']);
  assert.deepEqual([read('DOWN').state, read('DEGRADED').state, read('DEGRADED').label], ['down', 'down', 'degraded']);
  assert.deepEqual(['KUMA_DOWN', 'NO_SSH', 'TM_STALE'].map(t => [read(t).state, read(t).label]),
    [['warning', 'Kuma down'], ['warning', 'no SSH'], ['warning', 'backup late']]);
  const stale = read('DOWN', false, "the watch's log is more than 15 minutes old");
  assert.deepEqual([stale.state, stale.label, stale.line, stale.why], ['unknown', null, null, "the watch's log is more than 15 minutes old"]);
  for (const junk of ['INIT', 'up', '', null, 'toString', '__proto__']) {
    const v = read(junk);
    assert.equal(v.state, 'unknown', String(junk));
    assert.equal(v.why, "the watch's state file holds no known state");
  }
  assert.equal(read('UP').checkedAt, NOW - 120e3);
});

test('down since: set when first seen down, kept through unknown, cleared when back', () => {
  const v = state => [{ key: 'launchd:Tunnel', state }];
  let s = stampDown(v('down'), new Map(), 1000);
  assert.equal(s.views[0].downSince, 1000);
  s = stampDown(v('down'), s.downSince, 2000);
  assert.equal(s.views[0].downSince, 1000);
  s = stampDown(v('unknown'), s.downSince, 3000);
  assert.equal(s.views[0].downSince, null, 'not shown as down while unknown');
  s = stampDown(v('down'), s.downSince, 4000);
  assert.equal(s.views[0].downSince, 1000, 'but still counted from when it went down');
  s = stampDown(v('running'), s.downSince, 5000);
  assert.equal(s.views[0].downSince, null);
  assert.equal(s.downSince.size, 0);
});
