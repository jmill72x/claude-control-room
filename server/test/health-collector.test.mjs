// The health collector (collectors/health.mjs): what it runs, what it does when
// a source fails, and that the page gets no label, path or command. Every
// label, path and name is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, closeSync, openSync, constants } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHealth, readStateToken, runJobStatus, runPs, JOB_STATUS_TIMEOUT_MS } from '../collectors/health.mjs';
import { readHealthConfig, findSession } from '../lib/health.mjs';

const NOW = Date.parse('2026-10-21T15:00:00Z');
const fresh = () => mkdtempSync(join(tmpdir(), 'ccr-health-'));

const SERVICES = [
  { kind: 'session', name: 'Lead', session: 'Lead', launcher: 'com.example.lead' },
  { kind: 'self', name: 'Control Room', label: 'com.example.control-room' },
  { kind: 'launchd', name: 'Tunnel', label: 'com.example.tunnel' },
  { kind: 'pi', name: 'NAS', stateFile: '/secret/place/watch.state', log: '/secret/place/watch.log', watchJob: 'com.example.nas-watch' }
];
const settingsWith = jobStatus => readHealthConfig({ health: { ...(jobStatus ? { jobStatus } : {}), services: SERVICES } });

const entry = (label, extra = {}) => ({ label, state: 'not running', last_exit: 0, log_age_hours: 0.05, max_age_hours: 26, ok: true, reason: null, ...extra });
const REPORT = JSON.stringify({
  generated_at: '2026-10-21T11:00:00-04:00',
  jobs: [
    entry('com.example.brief'),
    entry('com.example.lead', { max_age_hours: null }),
    entry('com.example.nas-watch', { max_age_hours: 0.25 }),
    entry('com.example.tunnel', { state: 'running', last_exit: null, max_age_hours: null }),
    entry('com.example.control-room', { state: 'running', last_exit: null, max_age_hours: null })
  ]
});
// `ps -o pid=,uid=,stat=,etime=,command=`, as the user the harness runs as (501).
const PS = '  77   501 Ss   1-02:00:00 claude -n Lead --channels plugin:chat\n  78   501 S       00:10 /bin/zsh -l\n';
const PRINT = '\tstate = running\n\truns = 3\n\tlast exit code = 1\n';

function harness(over = {}) {
  const calls = { jobStatus: [], ps: 0, print: [], token: [], log: [], logged: [] };
  const health = createHealth({
    settings: settingsWith('/secret/bin/job-status'),
    jobNames: { 'com.example.brief': { name: 'Morning brief' } },
    cache: { get: () => ({ data: [{ label: 'com.example.brief', schedule: 'Every day, 07:30' }] }) },
    startedAt: NOW - 3600e3,
    jobStatus: async path => { calls.jobStatus.push(path); return REPORT; },
    ps: async () => { calls.ps++; return PS; },
    launchctlPrint: async label => { calls.print.push(label); return PRINT; },
    readToken: async path => { calls.token.push(path); return 'UP'; },
    logMtime: async path => { calls.log.push(path); return NOW - 60e3; },
    log: line => calls.logged.push(line),
    now: () => NOW,
    uid: 501,
    ...over
  });
  return { health, calls };
}

test('one pass: job-status, ps and the state file, and the page gets names, states and times only', async () => {
  const { health, calls } = harness();
  const out = await health.collect();
  assert.deepEqual(calls.jobStatus, ['/secret/bin/job-status']);
  assert.equal(calls.ps, 1);
  assert.deepEqual(calls.print, ['com.example.control-room']);
  assert.deepEqual(out.jobs, {
    status: 'ok', error: null,
    list: [
      { name: 'Morning brief', schedule: 'Every day, 07:30', state: 'ok', reason: null },
      { name: 'nas-watch', schedule: null, state: 'ok', reason: null }
    ]
  });
  const by = Object.fromEntries(out.services.map(s => [s.key, s]));
  assert.deepEqual([by['session:Lead'].state, by['session:Lead'].startedAt], ['up', NOW - 26 * 3600e3]);
  assert.deepEqual(by['session:Lead'].launcher, { state: 'not running', lastExit: 0 });
  assert.deepEqual([by['self:Control Room'].runs, by['self:Control Room'].lastStop, by['self:Control Room'].startedAt], [3, { exit: 1 }, NOW - 3600e3]);
  assert.equal(by['launchd:Tunnel'].state, 'running');
  assert.deepEqual([by['pi:NAS'].state, by['pi:NAS'].label, by['pi:NAS'].checkedAt], ['up', 'up', NOW - 180e3]);
  assert.deepEqual(calls.log, [], "with job-status answering, the watch's log is not needed");
  const page = JSON.stringify(out);
  for (const secret of ['com.example', '/secret', 'job-status"', '--channels', '"77"', 'plugin:chat']) {
    assert.ok(!page.includes(secret), `the page gets no ${secret}`);
  }
});

test("this server's launchctl print runs once it has answered, and again only until it does", async () => {
  let fail = true;
  const { health, calls } = harness({ launchctlPrint: async label => { calls.print.push(label); if (fail) throw new Error('113'); return PRINT; } });
  const first = await health.collect();
  assert.equal(first.services[1].runs, null);
  fail = false;
  await health.collect();
  await health.collect();
  assert.equal(calls.print.length, 2);
  assert.equal((await health.collect()).services[1].runs, 3);
});

test('no job-status path: Jobs is not set up, the KeepAlive jobs are unknown, and the NAS falls back to its log', async () => {
  const { health, calls } = harness({ settings: settingsWith(null) });
  const out = await health.collect();
  assert.deepEqual(calls.jobStatus, []);
  assert.equal(out.jobs.status, 'unset');
  const by = Object.fromEntries(out.services.map(s => [s.key, s]));
  assert.deepEqual([by['launchd:Tunnel'].state, by['launchd:Tunnel'].reason], ['unknown', 'job-status is not set up']);
  assert.deepEqual(calls.log, ['/secret/place/watch.log']);
  assert.deepEqual([by['pi:NAS'].state, by['pi:NAS'].checkedAt], ['up', NOW - 60e3]);
  assert.equal(by['session:Lead'].launcher, null);
});

test("without job-status, a log older than 15 minutes makes the NAS unknown", async () => {
  const { health } = harness({ settings: settingsWith(null), logMtime: async () => NOW - 16 * 60e3, readToken: async () => 'DOWN' });
  const pi = (await health.collect()).services[3];
  assert.deepEqual([pi.state, pi.label, pi.why], ['unknown', null, "the watch's log is more than 15 minutes old"]);
  const { health: h2 } = harness({ settings: settingsWith(null), logMtime: async () => NOW - 15 * 60e3, readToken: async () => 'DOWN' });
  assert.equal((await h2.collect()).services[3].state, 'down');
});

test("with job-status answering, the NAS counts only while the watch's own job is OK", async () => {
  const report = JSON.parse(REPORT);
  report.jobs[2] = entry('com.example.nas-watch', { ok: false, last_exit: 1, reason: 'last exit code 1' });
  const { health, calls } = harness({ jobStatus: async () => JSON.stringify(report), readToken: async () => 'DOWN' });
  const out = await health.collect();
  const pi = out.services[3];
  assert.deepEqual([pi.state, pi.why], ['unknown', 'the watch is not OK: last exit code 1']);
  assert.deepEqual(calls.log, [], 'the log is not consulted when job-status answered');
  assert.equal(out.jobs.list[0].state, 'failed', 'and the watch shows as a failed job');
  report.jobs.splice(2, 1);
  const { health: h2 } = harness({ jobStatus: async () => JSON.stringify(report) });
  assert.equal((await h2.collect()).services[3].why, 'job-status does not list the watch');
});

test('an unreadable state file is unknown, said plainly', async () => {
  const { health } = harness({ readToken: async () => { throw new Error('ENOENT: /secret/place/watch.state'); } });
  const pi = (await health.collect()).services[3];
  assert.deepEqual([pi.state, pi.why], ['unknown', "the watch's state file could not be read"]);
});

test('a job-status failure: Jobs says why in fixed words, the crons keep launchd, and the log hears it once', async () => {
  const timeout = Object.assign(new Error('Command failed: /secret/bin/job-status --json --only jobs'), { killed: true, signal: 'SIGTERM', code: null });
  const { health, calls } = harness({ jobStatus: async () => { throw timeout; } });
  const crons = [{ label: 'com.example.brief', ok: true, state: 'ok', last: 'OK', nextRunAt: null }];
  const out = await health.collect();
  assert.deepEqual(out.jobs, { status: 'error', error: 'timed out after 20 s', list: [] });
  assert.deepEqual(out.services.find(s => s.kind === 'launchd').reason, 'job-status timed out after 20 s');
  assert.equal(health.overlay(crons, NOW), crons);
  assert.ok(!JSON.stringify(out).includes('/secret'), 'the path stays in the service log');
  await health.collect();
  assert.equal(calls.logged.length, 1, 'logged when it starts, not every minute');
  assert.match(calls.logged[0], /^health: job-status timed out after 20 s \(Command failed: \/secret\/bin\/job-status/);
});

test('a failure after a good answer drops that answer at once: no old verdicts stand in', async () => {
  let fail = false;
  const { health } = harness({ jobStatus: async () => { if (fail) throw Object.assign(new Error('x'), { code: 1 }); return REPORT; } });
  const crons = [{ label: 'com.example.brief', ok: false, state: 'failed', last: 'Failed · 3', nextRunAt: null }];
  await health.collect();
  assert.equal(health.overlay(crons, NOW)[0].ok, true, 'the good answer counts');
  fail = true;
  const out = await health.collect();
  assert.equal(out.jobs.status, 'error');
  assert.equal(health.overlay(crons, NOW), crons, "launchd's own verdict again");
  assert.equal(out.services.find(s => s.kind === 'launchd').state, 'unknown');
});

test('each kind of job-status failure has its own fixed words', async () => {
  const cases = [
    [Object.assign(new Error('spawn /secret ENOENT'), { code: 'ENOENT' }), 'is not at the path in config.json'],
    [Object.assign(new Error('spawn /secret EACCES'), { code: 'EACCES' }), 'is not allowed to run'],
    [Object.assign(new Error('Command failed'), { code: 2 }), 'exited with code 2'],
    [Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'printed too much'],
    [Object.assign(new Error('x'), { signal: 'SIGKILL', killed: false }), 'was ended by SIGKILL'],
    [new Error('something odd'), 'could not be run']
  ];
  for (const [err, words] of cases) {
    const { health } = harness({ jobStatus: async () => { throw err; } });
    assert.equal((await health.collect()).jobs.error, words);
  }
  const { health } = harness({ jobStatus: async () => 'not json' });
  assert.equal((await health.collect()).jobs.error, 'printed something other than JSON');
});

test("after a good answer, the crons panel takes job-status's verdict", async () => {
  const report = JSON.parse(REPORT);
  report.jobs[0] = entry('com.example.brief', { ok: false, last_exit: 7, reason: 'last exit code 7' });
  const { health } = harness({ jobStatus: async () => JSON.stringify(report) });
  await health.collect();
  const [brief] = health.overlay([{ label: 'com.example.brief', ok: true, state: 'ok', last: 'OK', nextRunAt: null }], NOW);
  assert.deepEqual([brief.ok, brief.state, brief.last], [false, 'failed', 'Failed · 7']);
});

test('ps failing makes the lead unknown, and a session gone makes it down, counted from the first pass that saw it', async () => {
  let ps = async () => { throw new Error('ps failed'); };
  let at = NOW;
  const { health } = harness({ ps: () => ps(), now: () => at });
  assert.equal((await health.collect()).services[0].state, 'unknown');
  ps = async () => '  78   501 S       00:10 /bin/zsh -l\n';
  at = NOW + 60e3;
  const down = (await health.collect()).services[0];
  assert.deepEqual([down.state, down.downSince], ['down', NOW + 60e3]);
  at = NOW + 120e3;
  assert.equal((await health.collect()).services[0].downSince, NOW + 60e3);
});

// ---- the real process and file reads ----

// job-status is a Python script, so the stand-ins below are too.
const pyScript = (dir, lines, name = 'job-status') => {
  const path = join(dir, name);
  writeFileSync(path, ['#!/usr/bin/python3', ...lines].join('\n') + '\n');
  chmodSync(path, 0o644);
  return path;
};

test('the whole job-status call is bounded: a script that ignores SIGTERM is killed with SIGKILL at the limit', async () => {
  const script = pyScript(fresh(), ['import signal, time', 'signal.signal(signal.SIGTERM, signal.SIG_IGN)', 'time.sleep(6)']);
  assert.equal(JOB_STATUS_TIMEOUT_MS, 20000);
  const started = Date.now();
  await assert.rejects(runJobStatus(script, 1000), err => err.killed === true && err.signal === 'SIGKILL');
  assert.ok(Date.now() - started < 3000, 'stopped at its timeout, not when the script ended');
});

test('job-status runs as /usr/bin/python3 -I <path> --json --only jobs: no PYTHON* variable, user site-packages or script folder counts', async () => {
  const dir = fresh();
  const planted = join(dir, 'planted');
  const script = pyScript(dir, [
    'import json, os, sys',
    'here = os.path.dirname(os.path.realpath(__file__))',
    'paths = [os.path.realpath(p) for p in sys.path if p]',
    'print(json.dumps({"argv": sys.argv[1:], "isolated": sys.flags.isolated, "noUserSite": sys.flags.no_user_site,',
    '  "ignoreEnv": sys.flags.ignore_environment, "here": here in paths, "planted": any(p.endswith("/planted") for p in paths)}))'
  ]);
  const saved = process.env.PYTHONPATH;
  process.env.PYTHONPATH = planted;
  try {
    const seen = JSON.parse(await runJobStatus(script));
    assert.deepEqual(seen, { argv: ['--json', '--only', 'jobs'], isolated: 1, noUserSite: 1, ignoreEnv: 1, here: false, planted: false });
  } finally {
    if (saved === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = saved;
  }
});

test("job-status gets the short environment git-read gets, plus xcrun_nocache, and nothing else of this service's", async () => {
  const script = pyScript(fresh(), ['import json, os', 'print(json.dumps(dict(os.environ)))']);
  const saved = { ...process.env };
  Object.assign(process.env, { CCR_JOBSTATUS_TEST: 'not for job-status', xcrun_db: '/tmp/forged', TOOLCHAINS: 'elsewhere' });
  try {
    const seen = JSON.parse(await runJobStatus(script));
    assert.equal(seen.xcrun_nocache, '1');
    assert.equal(seen.HOME, process.env.HOME);
    for (const leaked of ['CCR_JOBSTATUS_TEST', 'xcrun_db', 'TOOLCHAINS']) assert.ok(!(leaked in seen), `${leaked} reached job-status`);
  } finally {
    for (const k of ['CCR_JOBSTATUS_TEST', 'xcrun_db', 'TOOLCHAINS']) {
      if (k in saved) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

test('a missing or unreadable job-status is said as such, not as python3 failing to open it', async () => {
  const dir = fresh();
  await assert.rejects(runJobStatus(join(dir, 'nowhere')), err => err.code === 'ENOENT');
  const locked = pyScript(dir, ['print("{}")'], 'locked');
  chmodSync(locked, 0o000);
  await assert.rejects(runJobStatus(locked), err => err.code === 'EACCES');
});

test("the lead is counted by this server's own uid", async () => {
  const { health } = harness({ uid: 502 });
  assert.equal((await health.collect()).services[0].state, 'down', "uid 501's session is not uid 502's");
  const { health: mine } = harness({ uid: undefined, ps: async () => `  77 ${process.getuid()} Ss   01:00 claude -n Lead\n` });
  assert.equal((await mine.collect()).services[0].state, 'up', 'by default, the uid this process runs as');
});

const waitFor = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.fail(what);
};

test('with the real ps: a process started as `claude -n <name>` counts, and not while it is stopped', async () => {
  const name = `ccr-test-${process.pid}`;
  // node, shown to ps as `claude -e … -- -n <name>` through argv0.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', '-n', name], { argv0: 'claude', stdio: 'ignore' });
  const count = async uid => findSession(await runPs(), name, Date.now(), uid).count;
  try {
    await waitFor(async () => (await count(process.getuid())) === 1, 'ps never listed it');
    assert.equal(await count(process.getuid() + 1), 0, "another uid's processes don't count");
    process.kill(child.pid, 'SIGSTOP');
    await waitFor(async () => (await count(process.getuid())) === 0, 'a stopped process still counted');
    process.kill(child.pid, 'SIGCONT');
    await waitFor(async () => (await count(process.getuid())) === 1, 'it never counted again after SIGCONT');
  } finally {
    child.kill('SIGKILL');
  }
});

test("the state file's token is read from a small regular file, and nothing else is opened for reading", async () => {
  const dir = fresh();
  const file = join(dir, 'watch.state');
  writeFileSync(file, 'TM_STALE');
  assert.equal(await readStateToken(file), 'TM_STALE');
  writeFileSync(file, '  UP\n');
  assert.equal(await readStateToken(file), 'UP');
  writeFileSync(file, 'X'.repeat(65));
  await assert.rejects(readStateToken(file), /not a small regular file/);
  const link = join(dir, 'link.state');
  writeFileSync(file, 'UP');
  await symlink(file, link);
  await assert.rejects(readStateToken(link), err => err.code === 'ELOOP');
  const fifo = join(dir, 'fifo.state');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  const release = () => { try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* no reader */ } };
  const timer = setTimeout(release, 2000);
  const started = Date.now();
  try {
    await assert.rejects(readStateToken(fifo), /not a small regular file/);
    assert.ok(Date.now() - started < 1000, 'a FIFO is not waited on');
  } finally {
    clearTimeout(timer);
    release();
  }
});
