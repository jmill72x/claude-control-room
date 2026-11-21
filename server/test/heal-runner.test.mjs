// Self-healing loop 1 (lib/heal-runner.mjs, lib/heal-ledger.mjs): the stale-log false
// "overdue". A fake `launchctl print` and a fake clock drive each case of the design's
// test plan (docs/design/2026-11-12-self-healing-loops.md, §7): the counter rising, the
// counter flat, launchd unreadable, a missed calendar fire, the kill switch, a target
// config doesn't list. Then the whole path on a scratch server of its own. Every label,
// name and figure here is invented; nothing here runs launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, readdir, mkdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, get, request } from 'node:http';
import { createHealRunner, isStaleLogCandidate, QUIET_WORDS } from '../lib/heal-runner.mjs';
import { createHealLedger } from '../lib/heal-ledger.mjs';
import { readHealConfig, CATALOG, SETTLE_MAX_MS, INTERVAL_MARGIN_MS, CALENDAR_GRACE_MS, PER_TARGET_DAY, judgeReadings, killFileThere, WHY_WORDS } from '../lib/heal.mjs';
import { createHealth } from '../collectors/health.mjs';
import { readHealthConfig } from '../lib/health.mjs';
import { buildCron } from '../lib/parse-launchd.mjs';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';
import { runNotifier } from '../collectors/notifier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60e3, H = 3600e3;
const NOW = new Date(2026, 10, 11, 23, 30).getTime();
const L = 'com.example.nas-mount';
const SINCE = NOW - 10 * H;

// `signal` adds a last terminating signal beside the exit line (Ultron's L6, 11-13).
const printed = ({ runs, exit = 0, interval = 180, state = 'not running', signal = null }) => [
  `gui/501/${L} = {`,
  '\tactive count = 0',
  `\tstate = ${state}`,
  '\tendpoints = {',
  '\t\truns = 999999',
  '\t}',
  `\truns = ${runs}`,
  exit === null ? '\tlast terminating signal = Killed: 9' : `\tlast exit code = ${exit}`,
  signal === null ? '' : `\tlast terminating signal = ${signal}`,
  interval ? `\trun interval = ${interval} seconds` : '',
  '}'
].join('\n');

// A fake `launchctl print`: each call takes the next answer for its label (the last one
// repeats); an Error is thrown. Every call is recorded.
function fakeLaunchd(script, onCall = () => {}) {
  const calls = [];
  const fn = async label => {
    calls.push(label);
    onCall(label);
    const list = script[label];
    if (!list) throw new Error('Could not find service');
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const settingsOf = (extra = {}) => readHealConfig({
  heal: { enabled: true, targets: { 'nas-mount': { label: L, actions: ['mark-quiet'] } }, ...extra }
});

const staleCronOf = (extra = {}) => ({
  name: 'nas-mount', label: L, schedule: 'Every 3 minutes', nextRunAt: null, dueAt: [], ok: false, state: 'failed',
  last: 'Overdue · log 10 h old', exit: null, lastRunAt: SINCE, staleLog: true, maxAgeHours: 0.15, ...extra
});
const staleCron = staleCronOf;
const okCron = label => ({ name: label.split('.').pop(), label, schedule: 'Daily', nextRunAt: NOW + H, dueAt: [], ok: true, state: 'ok', last: 'OK', lastRunAt: NOW - H });

async function setup({ script = { [L]: [printed({ runs: 147 }), printed({ runs: 149 })] }, settings = settingsOf(), killed = () => false, ledgerPath = null, onCall } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'heal-'));
  const clock = { t: NOW };
  const logs = [];
  const launchctlPrint = fakeLaunchd(script, onCall);
  const ledger = createHealLedger({ path: ledgerPath ?? join(dir, 'data', 'heals.json'), now: () => clock.t });
  const runner = createHealRunner({ settings, ledger, launchctlPrint, killed, jobNames: { [L]: { name: 'NAS mount' } }, now: () => clock.t, log: l => logs.push(l) });
  await runner.load();
  return { dir, clock, logs, launchctlPrint, ledger, runner, done: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
const at = (env, ms) => { env.clock.t = ms; };
const cronOf = (out, label = L) => out.find(c => c.label === label);

// ---- the cases ----

test('the 11-11 case: an old log, the counter rising, exit 0, reads quiet after two readings, with one ledger line', async t => {
  const env = await setup();
  t.after(env.done);
  // Pass 1: detected, first reading, the push held.
  let out = await env.runner.pass([staleCron(), okCron('com.example.other')]);
  assert.deepEqual(env.launchctlPrint.calls, [L]);
  assert.equal(cronOf(out).state, 'failed');
  assert.equal(cronOf(out).holdUntil, NOW + SETTLE_MAX_MS);
  assert.equal(env.runner.view().open.length, 1);
  assert.equal(env.runner.view().open[0].step, 'diagnosing');
  assert.equal(env.runner.view().open[0].nextCheckAt, NOW + 180e3 + INTERVAL_MARGIN_MS);
  // Before one interval and its margin: no second reading.
  at(env, NOW + 180e3 + INTERVAL_MARGIN_MS - 1);
  out = await env.runner.pass([staleCron({ lastRunAt: SINCE + 30e3 }), okCron('com.example.other')]);
  assert.equal(env.launchctlPrint.calls.length, 1);
  assert.equal(cronOf(out).state, 'failed');
  // The second reading: the counter rose and both exits were 0.
  at(env, NOW + 4 * MIN);
  out = await env.runner.pass([staleCron({ lastRunAt: SINCE - 20e3 }), okCron('com.example.other')]);
  assert.equal(env.launchctlPrint.calls.length, 2);
  const c = cronOf(out);
  assert.deepEqual([c.ok, c.state, c.last, c.exit, c.quietAt, c.holdUntil], [true, 'quiet', QUIET_WORDS, null, NOW + 4 * MIN, undefined]);
  assert.equal(out[out.length - 1].label, L, 'no longer sorted with the failures');
  assert.deepEqual(env.runner.quietOf(L, SINCE + 60e3), { at: NOW + 4 * MIN });
  assert.equal(env.runner.quietOf(L, SINCE + H), null, 'another instance is not quiet');
  const lines = env.ledger.lines();
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].outcome, lines[0].why, lines[0].tier, lines[0].action, lines[0].class, lines[0].target, lines[0].runs], ['healed', 'clean', 'T1', 'mark-quiet', 'stale-log', 'nas-mount', [147, 149]]);
  const v = env.runner.view();
  assert.deepEqual([v.status, v.open.length, v.quiet.length, v.quiet[0].name, v.recent[0].words], ['on', 0, 1, 'NAS mount', 'quiet, ran clean']);
  // The ledger is on disk, 0600.
  const file = join(env.dir, 'data', 'heals.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1);
  assert.deepEqual((await readdir(join(env.dir, 'data'))).filter(f => f.includes('.tmp-')), [], 'no temp file left');
});

test('while quiet, each interval checks again; a flat counter lifts the quiet and that instance is never healed again', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 149 }), printed({ runs: 151 }), printed({ runs: 151 }), printed({ runs: 160 })] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 8 * MIN);
  let out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'quiet', 'the counter rose again');
  assert.equal(cronOf(out).quietAt, NOW + 8 * MIN);
  at(env, NOW + 12 * MIN);
  out = await env.runner.pass([staleCron()]);
  assert.deepEqual([cronOf(out).ok, cronOf(out).state, cronOf(out).holdUntil], [false, 'failed', undefined], 'red, and no hold: it pushes');
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['healed', 'clean'], ['relapsed', 'flat']]);
  // The counter rises later, but this instance had its one attempt.
  at(env, NOW + 20 * MIN);
  out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'failed');
  assert.equal(env.launchctlPrint.calls.length, 4);
});

test('a real stall: the counter flat stays red, pushes once its hold is gone, and the ledger says why', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 147 })] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  const out = await env.runner.pass([staleCron()]);
  assert.deepEqual([cronOf(out).state, cronOf(out).holdUntil], ['failed', undefined]);
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why, l.runs]), [['escalated', 'flat', [147, 147]]]);
  assert.equal(env.runner.view().recent[0].why, "launchd's run counter didn't move");
  assert.ok(env.logs.some(l => l === 'heal: mark-quiet escalated for nas-mount (flat)'));
  // The same instance had its one attempt: no new loop, no reading.
  at(env, NOW + 10 * MIN);
  const again = await env.runner.pass([staleCron({ lastRunAt: SINCE + 60e3 })]);
  assert.deepEqual([cronOf(again).holdUntil, env.launchctlPrint.calls.length, env.ledger.lines().length], [undefined, 2, 1]);
  // A new instance (the log was written, then went old again) gets a loop of its own.
  at(env, NOW + 30 * MIN);
  const fresh = await env.runner.pass([staleCron({ lastRunAt: NOW + 20 * MIN })]);
  assert.equal(env.launchctlPrint.calls.length, 3);
  assert.equal(cronOf(fresh).holdUntil, NOW + 30 * MIN + SETTLE_MAX_MS);
});

test('a crash loop raises the counter but not with exit 0: red', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 155, exit: 1 })] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  const out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['exit']);
});

test('a job ended by a signal has no exit code: red, said as the signal', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 148, exit: null })] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['signal']);
});

// L6 (Ultron, 11-13): a signal on record fails the check at either reading, even beside
// a last exit of 0.
test('a last terminating signal beside an exit of 0 is red, at the first reading or the second', async t => {
  const first = await setup({ script: { [L]: [printed({ runs: 147, signal: 'Terminated: 15' })] } });
  t.after(first.done);
  assert.equal(cronOf(await first.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(first.ledger.lines().map(l => [l.outcome, l.why]), [['escalated', 'signal']]);
  const second = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 148, signal: 'Killed: 9' })] } });
  t.after(second.done);
  await second.runner.pass([staleCron()]);
  at(second, NOW + 4 * MIN);
  assert.equal(cronOf(await second.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(second.ledger.lines().map(l => [l.outcome, l.why]), [['escalated', 'signal']]);
  assert.equal(judgeReadings({ runs: 1, lastExit: 0, lastSignal: 9 }, { runs: 2, lastExit: 0, lastSignal: null }), 'signal');
  assert.equal(judgeReadings({ runs: 1, lastExit: 0, lastSignal: null }, { runs: 2, lastExit: 0, lastSignal: 15 }), 'signal');
  assert.equal(judgeReadings({ runs: 1, lastExit: 0, lastSignal: null }, { runs: 2, lastExit: 0, lastSignal: null }), 'clean');
  assert.equal(judgeReadings({ runs: 1, lastExit: 0 }, { runs: 2, lastExit: 0 }), 'clean', 'no signal line at all');
});

test('a counter that went back (the job was loaded again) proves nothing: red', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 2 })] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['reset']);
});

test("launchd unreadable: escalated at once, red, no hold, so the push goes now", async t => {
  for (const [answer, why] of [[new Error('Could not find service'), 'unreadable'], ['garbage with no counter', 'unreadable'], [printed({ runs: 147, exit: 3 }), 'exit']]) {
    const env = await setup({ script: { [L]: [answer] } });
    const out = await env.runner.pass([staleCron()]);
    assert.deepEqual([cronOf(out).state, cronOf(out).holdUntil], ['failed', undefined]);
    assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['escalated', why]]);
    assert.deepEqual(env.runner.view().open, []);
    await env.done();
  }
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), new Error('timed out')] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['unreadable']);
});

test('a calendar job: the second reading comes after its next due time; a missed fire (counter flat) stays red', async t => {
  const due = NOW + 30 * MIN;
  const cal = extra => staleCron({ schedule: 'Daily, 00:00', nextRunAt: due, ...extra });
  const env = await setup({ script: { [L]: [printed({ runs: 4, interval: null }), printed({ runs: 4, interval: null })] } });
  t.after(env.done);
  await env.runner.pass([cal()]);
  assert.equal(env.runner.view().open[0].nextCheckAt, due + CALENDAR_GRACE_MS);
  at(env, due + CALENDAR_GRACE_MS - 1);
  await env.runner.pass([cal()]);
  assert.equal(env.launchctlPrint.calls.length, 1);
  at(env, due + CALENDAR_GRACE_MS);
  const out = await env.runner.pass([cal({ nextRunAt: due + 24 * H })]);
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['escalated', 'flat']]);
});

test('a calendar job that did run at its due time reads quiet; its re-check waits for the next due time', async t => {
  const due = NOW + 30 * MIN;
  const cal = extra => staleCron({ schedule: 'Daily, 00:00', nextRunAt: due, ...extra });
  const env = await setup({ script: { [L]: [printed({ runs: 4, interval: null }), printed({ runs: 5, interval: null })] } });
  t.after(env.done);
  await env.runner.pass([cal()]);
  at(env, due + CALENDAR_GRACE_MS);
  const out = await env.runner.pass([cal({ nextRunAt: due + 24 * H })]);
  assert.equal(cronOf(out).state, 'quiet');
  assert.equal(env.runner.view().quiet.length, 1);
  at(env, due + 2 * H);
  await env.runner.pass([cal({ nextRunAt: due + 24 * H })]);
  assert.equal(env.launchctlPrint.calls.length, 2, 'no re-check before the next due time');
});

test('a calendar job whose schedule is gone by the second reading is left red, not quiet', async t => {
  const due = NOW + 30 * MIN;
  const env = await setup({ script: { [L]: [printed({ runs: 4, interval: null }), printed({ runs: 5, interval: null })] } });
  t.after(env.done);
  await env.runner.pass([staleCron({ nextRunAt: due })]);
  at(env, due + CALENDAR_GRACE_MS);
  const out = await env.runner.pass([staleCron({ nextRunAt: null })]);
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['escalated', 'no-schedule']]);
});

test('no interval and no due time: no schedule to check against, so red', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 4, interval: null })] } });
  t.after(env.done);
  const out = await env.runner.pass([staleCron({ nextRunAt: null })]);
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['no-schedule']);
});

test("a target config doesn't list is never read and stays red, with no loop", async t => {
  const env = await setup({ settings: readHealConfig({ heal: { enabled: true, targets: { other: { label: 'com.example.other', actions: ['mark-quiet'] } } } }) });
  t.after(env.done);
  const out = await env.runner.pass([staleCron()]);
  assert.deepEqual(env.launchctlPrint.calls, []);
  assert.deepEqual([cronOf(out).state, cronOf(out).holdUntil], ['failed', undefined]);
  assert.deepEqual(env.runner.view().open, []);
  assert.deepEqual(env.ledger.lines(), []);
});

test("a target whose actions don't include mark-quiet, and an action turned off, are left alone", async t => {
  const none = await setup({ settings: readHealConfig({ heal: { enabled: true, targets: { 'nas-mount': { label: L, actions: [] } } } }) });
  t.after(none.done);
  assert.equal(cronOf(await none.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(none.launchctlPrint.calls, []);
  const off = await setup({ settings: settingsOf({ off: ['mark-quiet'] }) });
  t.after(off.done);
  assert.equal(cronOf(await off.runner.pass([staleCron()])).state, 'failed');
  assert.deepEqual(off.launchctlPrint.calls, []);
  assert.deepEqual(off.runner.view().held, [{ name: 'NAS mount', why: 'mark-quiet is off in config.json' }]);
});

test('off unless enabled: nothing read, nothing held, and the view says why', async t => {
  const env = await setup({ settings: readHealConfig({ heal: { targets: { 'nas-mount': { label: L, actions: ['mark-quiet'] } } } }) });
  t.after(env.done);
  const crons = [staleCron()];
  assert.equal(await env.runner.pass(crons), crons);
  assert.deepEqual(env.launchctlPrint.calls, []);
  const v = env.runner.view();
  assert.deepEqual([v.status, v.why, v.held], ['unset', 'heal.enabled is not true in config.json', []]);
});

test('the kill switch: nothing read or marked, the alert stays red and pushes, and the target shows held', async t => {
  const env = await setup({ killed: () => true });
  t.after(env.done);
  const crons = [staleCron()];
  const out = await env.runner.pass(crons);
  assert.equal(out, crons);
  assert.deepEqual(env.launchctlPrint.calls, []);
  const v = env.runner.view();
  assert.equal(v.status, 'killed');
  assert.deepEqual(v.held, [{ name: 'NAS mount', why: 'the kill switch is on (the heal-off file is there)' }]);
  assert.equal(env.runner.quietOf(L, SINCE), null);
});

test('the kill switch lifts a quiet mark at once, and checks again right before each reading and the mark', async t => {
  let killed = false;
  const env = await setup({ killed: () => killed, script: { [L]: [printed({ runs: 147 }), printed({ runs: 149 }), printed({ runs: 151 }), printed({ runs: 153 })] } });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'quiet');
  killed = true;
  assert.equal(env.runner.quietOf(L, SINCE), null, 'the Jobs list goes red at once, before the next crons pass');
  assert.deepEqual(env.runner.view().quiet, []);
  assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'failed');
  assert.equal(env.runner.quietOf(L, SINCE), null);
  // The file goes: the same instance is checked again from the start (no comeback), and
  // reads quiet only after two new readings.
  killed = false;
  at(env, NOW + 6 * MIN);
  let out = await env.runner.pass([staleCron()]);
  assert.deepEqual([cronOf(out).state, cronOf(out).holdUntil], ['failed', NOW + 6 * MIN + SETTLE_MAX_MS]);
  at(env, NOW + 10 * MIN);
  out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'quiet');
  assert.deepEqual(env.ledger.lines().map(l => l.outcome), ['healed', 'healed']);
  // Turned on before a pass: nothing is read.
  const env2 = await setup({ killed: () => env2.clock.t >= NOW + 4 * MIN });
  t.after(env2.done);
  await env2.runner.pass([staleCron()]);
  at(env2, NOW + 4 * MIN);
  assert.equal(cronOf(await env2.runner.pass([staleCron()])).state, 'failed');
  assert.equal(env2.launchctlPrint.calls.length, 1, 'the second reading never ran');
  // Turned on during a pass, by a reading: each check after it stops the pass.
  const L2 = 'com.example.tm-nightly';
  const twoTargets = readHealConfig({ heal: { enabled: true, targets: { 'nas-mount': { label: L, actions: ['mark-quiet'] }, nightly: { label: L2, actions: ['mark-quiet'] } } } });
  const two = () => [staleCron(), staleCron({ name: 'tm-nightly', label: L2 })];
  const midPass = async (script, killAt) => {
    let flag = false;
    const e = await setup({ settings: twoTargets, script, killed: () => flag, onCall: () => { if (e.clock.t >= killAt) flag = true; } });
    t.after(e.done);
    e.unkill = () => { flag = false; };
    return e;
  };
  // (a) during the second reading: no ledger line and no mark.
  const a = await midPass({ [L]: [printed({ runs: 1 }), printed({ runs: 3 })] }, NOW + 4 * MIN);
  await a.runner.pass([staleCron()]);
  at(a, NOW + 4 * MIN);
  assert.equal(cronOf(await a.runner.pass([staleCron()])).state, 'failed');
  a.unkill();
  assert.deepEqual([a.ledger.lines(), a.runner.view().quiet], [[], []]);
  // (b) during the first job's second reading (flat, so it closes): the second job is not read.
  const b = await midPass({ [L]: [printed({ runs: 1 }), printed({ runs: 1 })], [L2]: [printed({ runs: 7 }), printed({ runs: 9 })] }, NOW + 4 * MIN);
  await b.runner.pass(two());
  at(b, NOW + 4 * MIN);
  await b.runner.pass(two());
  assert.deepEqual(b.launchctlPrint.calls, [L, L2, L]);
  // (c) during the first job's first reading: the second job's first reading never runs.
  const c = await midPass({ [L]: [printed({ runs: 1 })], [L2]: [printed({ runs: 7 })] }, NOW);
  await c.runner.pass(two());
  assert.deepEqual(c.launchctlPrint.calls, [L]);
  // A kill check that throws counts as killed.
  const env3 = await setup({ killed: () => { throw new Error('EACCES'); } });
  t.after(env3.done);
  await env3.runner.pass([staleCron()]);
  assert.equal(env3.runner.view().status, 'killed');
  assert.deepEqual(env3.launchctlPrint.calls, []);
});

test('an acked instance opens no loop', async t => {
  const env = await setup();
  t.after(env.done);
  const out = await env.runner.pass([staleCron()], { acked: c => c.label === L });
  assert.deepEqual(env.launchctlPrint.calls, []);
  assert.equal(cronOf(out).holdUntil, undefined);
});

test("the log was written while checking: the loop closes as cleared; a quiet one just ends", async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 2 * MIN);
  await env.runner.pass([okCron(L)]);
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['cleared', 'log-written']]);
  assert.deepEqual(env.runner.view().open, []);
});

test('rate limits: a target healed 3 times in a day is left red; one that comes back within the hour too', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(dir, 'heals.json');
  const old = i => ({ at: NOW - (i + 2) * H, class: 'stale-log', action: 'mark-quiet', tier: 'T1', target: 'nas-mount', detectedAt: NOW - (i + 2) * H, outcome: 'healed', why: 'clean', runs: [1, 2], since: NOW - (20 + i * 3) * H });
  await writeFile(path, JSON.stringify(Array.from({ length: PER_TARGET_DAY }, (_, i) => old(i))));
  const env = await setup({ ledgerPath: path });
  t.after(env.done);
  const out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env.launchctlPrint.calls, []);
  assert.equal(env.ledger.lines().at(-1).why, 'cap-target');
  // A quiet loop ends (its log was written), and the job goes stale again within the hour.
  const env2 = await setup({ script: { [L]: [printed({ runs: 1 }), printed({ runs: 3 })] } });
  t.after(env2.done);
  await env2.runner.pass([staleCron()]);
  at(env2, NOW + 4 * MIN);
  await env2.runner.pass([staleCron()]);
  at(env2, NOW + 3 * H);
  await env2.runner.pass([okCron(L)]);
  at(env2, NOW + 3 * H + 30 * MIN);
  const back = await env2.runner.pass([staleCron({ lastRunAt: NOW + 3 * H - 15 * MIN })]);
  assert.equal(cronOf(back).state, 'failed');
  assert.deepEqual(env2.ledger.lines().map(l => [l.outcome, l.why]), [['healed', 'clean'], ['escalated', 'came-back']]);
});

test('restarts: each new run re-checks the same instance from scratch, and never runs into the daily cap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(dir, 'heals.json');
  for (let run = 0; run < PER_TARGET_DAY + 2; run++) {
    const start = NOW + run * 30 * MIN;
    const env = await setup({ ledgerPath: path, script: { [L]: [printed({ runs: 10 * run }), printed({ runs: 10 * run + 2 })] } });
    at(env, start);
    const first = await env.runner.pass([staleCron()]);
    assert.equal(cronOf(first).state, 'failed', `run ${run}: red until checked again`);
    at(env, start + 4 * MIN);
    assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'quiet', `run ${run}: quiet again`);
    await env.done();
  }
  assert.equal(JSON.parse(await readFile(path, 'utf8')).length, PER_TARGET_DAY + 2);
});

// L1 (Ultron, 11-13): one attempt per instance holds across a restart, rebuilt from the
// ledger at load.
test('L1: after a restart, an instance that escalated or relapsed is not tried again that day; another one is', async t => {
  for (const outcome of ['escalated', 'relapsed']) {
    const dir = await mkdtemp(join(tmpdir(), 'heal-l1-'));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const path = join(dir, 'heals.json');
    const line = { at: NOW - 2 * H, class: 'stale-log', action: 'mark-quiet', tier: 'T1', target: 'nas-mount', detectedAt: NOW - 2 * H, outcome, why: 'flat', runs: [1, 1], since: SINCE };
    // Another action's line on the same target is not this loop's past.
    const other = { ...line, at: NOW - H, action: 'rerun-job', class: 'missed-run', tier: 'T2', outcome: 'escalated', since: SINCE + 7 * H };
    await writeFile(path, JSON.stringify([line, other]));
    const env = await setup({ ledgerPath: path });
    t.after(env.done);
    assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'failed', outcome);
    assert.deepEqual(env.launchctlPrint.calls, [], `${outcome}: no second attempt for the same instance`);
    assert.equal(env.ledger.lines().length, 2, 'and no new line');
    assert.equal(cronOf(await env.runner.pass([staleCron({ lastRunAt: SINCE + 30e3 })])).holdUntil, undefined, 'the same instance within the tolerance');
    assert.deepEqual(env.launchctlPrint.calls, []);
    // The other action's instance is not closed for this loop.
    await env.runner.pass([staleCron({ lastRunAt: SINCE + 7 * H })]);
    assert.deepEqual(env.launchctlPrint.calls, [L], `${outcome}: another instance is tried`);
    // A day after that line, the record has gone. (The log is 32 h old by then: a daily
    // job's allowance, 26 h, keeps it under the quiet ceiling, 104 h.)
    const env2 = await setup({ ledgerPath: path });
    t.after(env2.done);
    at(env2, NOW - 2 * H + 24 * H + MIN);
    await env2.runner.pass([staleCron({ maxAgeHours: 26 })]);
    assert.deepEqual(env2.launchctlPrint.calls, [L], `${outcome}: tried again a day on`);
  }
  // A line stamped ahead of this clock (a clock that went back) still closes its instance.
  const dir = await mkdtemp(join(tmpdir(), 'heal-l1c-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(dir, 'heals.json');
  await writeFile(path, JSON.stringify([{ at: NOW + 2 * H, class: 'stale-log', action: 'mark-quiet', tier: 'T1', target: 'nas-mount', detectedAt: NOW + 2 * H, outcome: 'escalated', why: 'flat', runs: [1, 1], since: SINCE }]));
  const ahead = await setup({ ledgerPath: path });
  t.after(ahead.done);
  await ahead.runner.pass([staleCron()]);
  assert.deepEqual(ahead.launchctlPrint.calls, [], 'closed, though stamped ahead');
});

test('L1: after a restart, a target whose last line is a heal holds another instance off for the hour; the same one is checked again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-l1b-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(dir, 'heals.json');
  const healed = { at: NOW - 5 * H, class: 'stale-log', action: 'mark-quiet', tier: 'T1', target: 'nas-mount', detectedAt: NOW - 5 * H, outcome: 'healed', why: 'clean', runs: [1, 3], since: SINCE };
  await writeFile(path, JSON.stringify([healed]));
  // The same instance: re-checked from scratch, and quiet again.
  const same = await setup({ ledgerPath: path });
  t.after(same.done);
  await same.runner.pass([staleCron()]);
  at(same, NOW + 4 * MIN);
  assert.equal(cronOf(await same.runner.pass([staleCron()])).state, 'quiet');
  // Another instance within the hour of the restart: held off, as a comeback.
  await writeFile(path, JSON.stringify([healed]));
  const other = await setup({ ledgerPath: path });
  t.after(other.done);
  at(other, NOW + 30 * MIN);
  assert.equal(cronOf(await other.runner.pass([staleCron({ lastRunAt: NOW - 20 * MIN })])).state, 'failed');
  assert.deepEqual(other.launchctlPrint.calls, []);
  assert.deepEqual(other.ledger.lines().map(l => [l.outcome, l.why]), [['healed', 'clean'], ['escalated', 'came-back']]);
  // An hour after the restart: another instance is healed as usual.
  await writeFile(path, JSON.stringify([healed]));
  const later = await setup({ ledgerPath: path });
  t.after(later.done);
  at(later, NOW + H + MIN);
  await later.runner.pass([staleCron({ lastRunAt: NOW })]);
  at(later, NOW + H + 5 * MIN);
  assert.equal(cronOf(await later.runner.pass([staleCron({ lastRunAt: NOW })])).state, 'quiet');
  // A target whose last line is not a heal (it relapsed since) holds nothing off.
  await writeFile(path, JSON.stringify([healed, { ...healed, at: NOW - 4 * H, outcome: 'relapsed', why: 'flat' }]));
  const relapsed = await setup({ ledgerPath: path });
  t.after(relapsed.done);
  at(relapsed, NOW + 30 * MIN);
  await relapsed.runner.pass([staleCron({ lastRunAt: NOW - 20 * MIN })]);
  assert.deepEqual(relapsed.launchctlPrint.calls, [L]);
});

// L2 (Ultron, 11-13): a loop's candidate that drops while its run is unchanged did not
// clear: the job still fails, for another reason.
test('L2: a candidate that turns into another failure on the same run closes as escalated or relapsed, never cleared', async t => {
  const notStale = (extra = {}) => staleCron({ staleLog: false, last: 'Exit 1', exit: 1, ...extra });
  // Checking: escalated, and not tried again once it reads as stale-log only.
  const env = await setup();
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + MIN);
  await env.runner.pass([notStale()]);
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['escalated', 'not-stale-log']]);
  at(env, NOW + 10 * MIN);
  await env.runner.pass([staleCron()]);
  assert.equal(env.launchctlPrint.calls.length, 1, 'that instance had its one attempt');
  // Quiet: relapsed, and the quiet mark is lifted.
  const q = await setup();
  t.after(q.done);
  await q.runner.pass([staleCron()]);
  at(q, NOW + 4 * MIN);
  assert.equal(cronOf(await q.runner.pass([staleCron()])).state, 'quiet');
  at(q, NOW + 5 * MIN);
  const out = await q.runner.pass([notStale()]);
  assert.equal(cronOf(out).state, 'failed');
  assert.equal(q.runner.quietOf(L, SINCE), null);
  assert.deepEqual(q.ledger.lines().map(l => [l.outcome, l.why]), [['healed', 'clean'], ['relapsed', 'not-stale-log']]);
  // A new run (another since) or a job that reads ok again is still a clear-up.
  const c = await setup();
  t.after(c.done);
  await c.runner.pass([staleCron()]);
  at(c, NOW + MIN);
  await c.runner.pass([notStale({ lastRunAt: SINCE + H })]);
  assert.deepEqual(c.ledger.lines().map(l => [l.outcome, l.why]), [['cleared', 'log-written']]);
  const ok = await setup();
  t.after(ok.done);
  await ok.runner.pass([staleCron()]);
  at(ok, NOW + MIN);
  await ok.runner.pass([{ ...staleCron(), ok: true, state: 'ok', staleLog: false }]);
  assert.deepEqual(ok.ledger.lines().map(l => [l.outcome, l.why]), [['cleared', 'log-written']]);
});

test("a ledger that can't be read keeps heals off; one that can't be written leaves the alert red", async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const bad = join(dir, 'heals.json');
  await writeFile(bad, '{"not": "a list"}');
  const env = await setup({ ledgerPath: bad });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  assert.deepEqual(env.launchctlPrint.calls, []);
  assert.deepEqual([env.runner.view().status, env.runner.view().why], ['off', "the heal ledger couldn't be read at start"]);
  assert.equal(await readFile(bad, 'utf8'), '{"not": "a list"}', 'never written over');
  // A folder where the ledger's own folder should be: every write fails.
  const blocked = join(dir, 'blocked');
  await mkdir(blocked);
  await chmod(blocked, 0o500);
  t.after(() => chmod(blocked, 0o700).catch(() => {}));
  const env2 = await setup({ ledgerPath: join(blocked, 'sub', 'heals.json') });
  t.after(env2.done);
  await env2.runner.pass([staleCron()]);
  at(env2, NOW + 4 * MIN);
  const out = await env2.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'failed', 'a heal the ledger cannot record does not happen');
  assert.equal(env2.runner.quietOf(L, SINCE), null);
  assert.deepEqual(env2.ledger.lines(), [], 'a line that never reached the disk is not kept');
  assert.ok(env2.logs.some(l => l.startsWith('heal: the ledger line could not be written')));
});

// L3 (Ultron, 11-13): the kill file is read by lstat; only "no such file" means off.
test('L3: the kill file counts when it is a file, a folder or a dangling link, and when it cannot be read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-kill-'));
  t.after(async () => { await chmod(join(dir, 'locked'), 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  assert.equal(killFileThere(join(dir, 'heal-off')), false, 'absent');
  await writeFile(join(dir, 'heal-off'), '');
  assert.equal(killFileThere(join(dir, 'heal-off')), true, 'a file');
  await mkdir(join(dir, 'as-folder'));
  assert.equal(killFileThere(join(dir, 'as-folder')), true, 'a folder');
  await symlink(join(dir, 'gone'), join(dir, 'dangling'));
  assert.equal(killFileThere(join(dir, 'dangling')), true, 'a link whose target is gone (existsSync says no)');
  await writeFile(join(dir, 'plain'), '');
  assert.equal(killFileThere(join(dir, 'plain', 'heal-off')), true, 'a file where the folder should be (ENOTDIR)');
  await mkdir(join(dir, 'locked'));
  await chmod(join(dir, 'locked'), 0o000);
  assert.equal(killFileThere(join(dir, 'locked', 'heal-off')), true, 'a folder that cannot be searched (EACCES)');
  const err = code => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(killFileThere('x', err('ENOENT')), false);
  assert.equal(killFileThere('x', err('EIO')), true);
  assert.equal(killFileThere('x', () => ({})), true);
});

test('a refused catalog keeps heals off and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-cat-'));
  const launchctlPrint = fakeLaunchd({ [L]: [printed({ runs: 1 })] });
  const runner = createHealRunner({
    settings: settingsOf(), ledger: createHealLedger({ path: join(dir, 'h.json') }), launchctlPrint, now: () => NOW, log: () => {},
    catalogEntries: [{ ...CATALOG[0], tier: 'T0' }]
  });
  await runner.load();
  await runner.pass([staleCron()]);
  assert.deepEqual(launchctlPrint.calls, []);
  assert.match(runner.catalogProblem(), /below its verbs' floor of T1/);
  assert.equal(runner.view().status, 'off');
  await rm(dir, { recursive: true, force: true });
});

test('only a failed, stale-log-only entry with a known instance is a candidate', () => {
  assert.equal(isStaleLogCandidate(staleCron()), true);
  assert.equal(isStaleLogCandidate(staleCron({ staleLog: undefined })), false);
  assert.equal(isStaleLogCandidate(staleCron({ state: 'ok', ok: true })), false);
  assert.equal(isStaleLogCandidate(staleCron({ ok: true })), false);
  assert.equal(isStaleLogCandidate(staleCron({ lastRunAt: null })), false);
  assert.equal(isStaleLogCandidate(staleCron({ label: undefined })), false);
});

// ---- the whole path, on a scratch server of its own ----

const listen = handler => new Promise(resolve => {
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const fetchJson = (port, path) => new Promise((resolve, reject) => {
  get({ host: '127.0.0.1', port, path, agent: false }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject);
});

test('end to end: job-status says overdue, launchd says it ran, and the page, the Jobs list and the notifier agree', async t => {
  const env = await setup();
  t.after(env.done);
  const statusJson = () => JSON.stringify({
    generated_at: new Date(env.clock.t).toISOString(),
    jobs: [{ label: L, state: 'not running', last_exit: 0, log_path: '/x/nas.log', log_age_hours: (env.clock.t - SINCE) / H, max_age_hours: 0.15, ok: false, reason: `log last written ${((env.clock.t - SINCE) / H).toFixed(1)} h ago, more than the 0.15 h expected` }]
  });
  const health = createHealth({
    settings: readHealthConfig({ health: { jobStatus: '/opt/example/job-status', services: [] } }),
    jobNames: { [L]: { name: 'NAS mount' } }, jobStatus: async () => statusJson(), now: () => env.clock.t, log: () => {},
    quietOf: (label, since) => env.runner.quietOf(label, since)
  });
  const cache = createCache();
  const config = { showAlertBanner: true, present: true };
  const server = await listen(createHandler({ cache, todos: { read: async () => [] }, config, loops: () => env.runner.view() }));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const sentStore = {};
  const pushes = [], events = [];
  const pass = async () => {
    cache.set('health', await health.collect(), env.clock.t);
    const base = [buildCron({ label: L, plist: { StartInterval: 180 }, statusRow: { pid: null, status: 0 } }, env.clock.t)];
    cache.set('crons', await env.runner.pass(health.overlay(base, env.clock.t)), env.clock.t);
    return runNotifier({
      snapshot: cache.snapshot(env.clock.t), config, now: env.clock.t,
      readSent: async () => sentStore, writeSent: async next => { Object.keys(sentStore).forEach(k => delete sentStore[k]); Object.assign(sentStore, next); },
      send: async e => { pushes.push(e); return { sent: true }; },
      events: async alerts => { events.push(...alerts.map(a => a.key)); return {}; }
    });
  };

  const first = await pass();
  assert.equal(first.held, 1);
  let loops = await fetchJson(port, '/api/loops');
  assert.equal(loops.status, 200);
  assert.deepEqual([loops.body.status, loops.body.open.length, loops.body.open[0].name], ['on', 1, 'NAS mount']);
  at(env, NOW + 4 * MIN);
  await pass();
  at(env, NOW + 5 * MIN);
  const after = await pass();
  assert.deepEqual([after.alerts, after.sent], [0, 0]);
  assert.deepEqual([pushes, events], [[], []], 'no push and no Jarvis wake');
  const dash = await fetchJson(port, '/api/dashboard');
  const c = dash.body.crons.data.find(x => x.label === L);
  assert.deepEqual([c.state, c.ok], ['quiet', true]);
  assert.deepEqual(dash.body.alerts, []);
  assert.equal(dash.body.loops.quiet[0].name, 'NAS mount');
  assert.deepEqual(dash.body.health.data.jobs.list.map(j => [j.name, j.state]), [['NAS mount', 'quiet']]);
  loops = await fetchJson(port, '/api/loops');
  assert.deepEqual([loops.body.recent.length, loops.body.recent[0].outcome], [1, 'healed']);
  assert.ok(!JSON.stringify(loops.body).includes('com.example'), 'no label on the page');
  assert.equal(env.ledger.lines().length, 1);
});

test('end to end: a real stall pushes once its hold is over, and wakes Jarvis then', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147 }), printed({ runs: 147 })] } });
  t.after(env.done);
  const crons = () => [staleCron({ lastRunAt: SINCE })];
  const sentStore = {};
  const pushes = [], events = [];
  const notify = snapshotCrons => runNotifier({
    snapshot: { crons: { status: 'ok', data: snapshotCrons }, ingestCrons: { status: 'ok', data: [] } }, config: {}, now: env.clock.t,
    readSent: async () => sentStore, writeSent: async next => Object.assign(sentStore, next),
    send: async e => { pushes.push(e); return { sent: true }; },
    events: async alerts => { events.push(...alerts.map(a => a.key)); return {}; }
  });
  await notify(await env.runner.pass(crons()));
  assert.equal(pushes.length, 0);
  at(env, NOW + 4 * MIN);
  await notify(await env.runner.pass(crons()));
  assert.equal(pushes.length, 1, 'escalated: the hold ends with the loop');
  assert.deepEqual(events, ['cron:launchd:' + L]);
});

test('end to end: with no second reading by then, the hold ends after 10 minutes and the alert pushes', async t => {
  const env = await setup({ script: { [L]: [printed({ runs: 147, interval: 3600 })] } });
  t.after(env.done);
  let out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).holdUntil, NOW + SETTLE_MAX_MS);
  at(env, NOW + SETTLE_MAX_MS);
  out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).holdUntil, undefined);
  assert.equal(env.runner.view().open.length, 1, 'still checking, but no longer holding');
});

// ---- the quiet ceiling (board 08469021, Ultron's M1) ----

// Quiet at NOW + 4 min (two readings, the counter rising), its log SINCE (10 h old).
async function quietEnv(t, runs = [147, 149, 151, 153, 155], extra = {}) {
  const env = await setup({ script: { [L]: runs.map(r => printed({ runs: r })) }, ...extra });
  t.after(env.done);
  await env.runner.pass([staleCron()]);
  at(env, NOW + 4 * MIN);
  assert.equal(cronOf(await env.runner.pass([staleCron()])).state, 'quiet');
  return env;
}

test('the quiet ceiling: a quiet mark ends once the log is a day old (a 3-minute job), as escalated, red, unheld, never quiet again', async t => {
  const env = await quietEnv(t);
  assert.equal(env.runner.view().quiet[0].endsBy, SINCE + 24 * H, 'the page can say when');
  // Exactly at the ceiling: still quiet (the re-check reads, and the counter rose).
  at(env, SINCE + 24 * H);
  let out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'quiet');
  const reads = env.launchctlPrint.calls.length;
  // One millisecond past it: lifted, without a reading.
  at(env, SINCE + 24 * H + 1);
  out = await env.runner.pass([staleCron()]);
  assert.deepEqual([cronOf(out).ok, cronOf(out).state, cronOf(out).last, cronOf(out).holdUntil], [false, 'failed', 'Overdue · log 10 h old', undefined]);
  assert.equal(env.launchctlPrint.calls.length, reads, 'no launchd read to end a quiet');
  assert.equal(env.runner.quietOf(L, SINCE), null, 'the Jobs list reads it failed again');
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why]), [['healed', 'clean'], ['escalated', 'log-ceiling']]);
  const v = env.runner.view();
  assert.deepEqual([v.quiet.length, v.open.length, v.recent[0].outcome, v.recent[0].why], [0, 0, 'escalated', WHY_WORDS['log-ceiling']]);
  assert.ok(env.logs.some(l => l.includes('escalated for nas-mount (log-ceiling)')));
  // The same instance later: no loop, no read, no second line.
  at(env, SINCE + 30 * H);
  out = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'failed');
  assert.equal(env.launchctlPrint.calls.length, reads);
  assert.equal(env.ledger.lines().length, 2);
  // Another instance (the log was written, then went stale again) starts afresh.
  at(env, SINCE + 31 * H);
  await env.runner.pass([staleCron({ lastRunAt: SINCE + 30.5 * H })]);
  assert.equal(env.launchctlPrint.calls.length, reads + 1, 'a new instance is read');
});

test("the quiet ceiling scales with job-status's allowance: a daily job (26 h) stays quiet to 104 h", async t => {
  const daily = { maxAgeHours: 26 };
  const env = await setup({ script: { [L]: [147, 149, 151, 153].map(r => printed({ runs: r })) } });
  t.after(env.done);
  await env.runner.pass([staleCron(daily)]);
  at(env, NOW + 4 * MIN);
  await env.runner.pass([staleCron(daily)]);
  assert.equal(env.runner.view().quiet[0].endsBy, SINCE + 104 * H);
  at(env, SINCE + 104 * H);
  assert.equal(cronOf(await env.runner.pass([staleCron(daily)])).state, 'quiet', 'past 24 h, not past 4 x 26 h');
  at(env, SINCE + 104 * H + 1);
  assert.equal(cronOf(await env.runner.pass([staleCron(daily)])).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['clean', 'log-ceiling']);
  // The allowance read each pass: a job whose allowance shrank (its plist changed) ends sooner.
  const env2 = await setup({ script: { [L]: [147, 149, 151].map(r => printed({ runs: r })) } });
  t.after(env2.done);
  await env2.runner.pass([staleCron(daily)]);
  at(env2, NOW + 4 * MIN);
  await env2.runner.pass([staleCron(daily)]);
  at(env2, SINCE + 25 * H);
  assert.equal(cronOf(await env2.runner.pass([staleCron({ maxAgeHours: 0.15 })])).state, 'failed');
});

test('the quiet ceiling: a log already past it opens no loop, reads nothing, and says so once, across a day and a restart', async t => {
  const old = { lastRunAt: NOW - 25 * H };
  const dir = await mkdtemp(join(tmpdir(), 'heal-ceil-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const ledgerPath = join(dir, 'heals.json');
  const env = await setup({ ledgerPath });
  t.after(env.done);
  let out = await env.runner.pass([staleCron(old)]);
  assert.deepEqual([cronOf(out).state, cronOf(out).holdUntil], ['failed', undefined], 'red, and no hold: it pushes now');
  assert.deepEqual(env.launchctlPrint.calls, []);
  assert.deepEqual(env.ledger.lines().map(l => [l.outcome, l.why, l.since]), [['escalated', 'log-ceiling', NOW - 25 * H]]);
  assert.equal(env.runner.view().open.length, 0);
  // A day and more on, the one-attempt record has gone, but the ledger line holds.
  at(env, NOW + 25 * H);
  await env.runner.pass([staleCron(old)]);
  assert.deepEqual(env.launchctlPrint.calls, []);
  assert.equal(env.ledger.lines().length, 1, 'no second line for the instance');
  // A restart: the quiet marks live in memory, the ceiling on the log's own clock.
  const env2 = await setup({ ledgerPath });
  t.after(env2.done);
  at(env2, NOW + 26 * H);
  await env2.runner.pass([staleCron(old)]);
  assert.deepEqual(env2.launchctlPrint.calls, []);
  assert.equal(env2.ledger.lines().length, 1);
  // Another instance of the same job, past it as well, gets a line of its own.
  at(env2, NOW + 27 * H);
  await env2.runner.pass([staleCron({ lastRunAt: NOW + H })]);
  assert.deepEqual(env2.ledger.lines().map(l => [l.why, l.since]), [['log-ceiling', NOW - 25 * H], ['log-ceiling', NOW + H]]);
  assert.deepEqual(env2.launchctlPrint.calls, []);
});

test('the quiet ceiling: a restart does not start the clock again; the same instance re-checked past it is left red', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-ceil-r-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const ledgerPath = join(dir, 'heals.json');
  await quietEnv(t, undefined, { ledgerPath });
  const env2 = await setup({ ledgerPath, script: { [L]: [printed({ runs: 200 }), printed({ runs: 202 })] } });
  t.after(env2.done);
  at(env2, SINCE + 24 * H + MIN);
  const out = await env2.runner.pass([staleCron()]);
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env2.launchctlPrint.calls, []);
  assert.deepEqual(env2.ledger.lines().map(l => [l.outcome, l.why]), [['healed', 'clean'], ['escalated', 'log-ceiling']]);
});

test('the quiet ceiling ends a quiet mark under an ack too (the ack keeps back the push, not the mark), and a checking loop', async t => {
  const env = await quietEnv(t);
  at(env, SINCE + 24 * H + 1);
  const out = await env.runner.pass([staleCron()], { acked: () => true });
  assert.equal(cronOf(out).state, 'failed');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['clean', 'log-ceiling']);
  // A loop still checking (its second reading not yet due) that crosses it.
  const env2 = await setup({ script: { [L]: [printed({ runs: 147, interval: 3600 })] } });
  t.after(env2.done);
  at(env2, SINCE + 24 * H - MIN);
  await env2.runner.pass([staleCron()]);
  assert.equal(env2.runner.view().open.length, 1);
  at(env2, SINCE + 24 * H + 1);
  await env2.runner.pass([staleCron()]);
  assert.deepEqual([env2.runner.view().open.length, env2.ledger.lines().map(l => [l.outcome, l.why])], [0, [['escalated', 'log-ceiling']]]);
  // It was never quiet, so another instance within the hour is no comeback: it is read.
  at(env2, SINCE + 24 * H + 10 * MIN);
  await env2.runner.pass([staleCron({ lastRunAt: SINCE + 24 * H + 5 * MIN })]);
  assert.equal(env2.launchctlPrint.calls.length, 2);
});

test('end to end: the quiet ceiling pushes an alert and wakes the lead, once', async t => {
  const env = await setup({ script: { [L]: [147, 149, 151, 153].map(r => printed({ runs: r })) } });
  t.after(env.done);
  // The row as the overlay would give it at this clock: its words follow the log's age (L4).
  const staleCron = () => staleCronOf({ last: `Overdue · log ${Math.round((env.clock.t - SINCE) / H)} h old` });
  const sentStore = {};
  const pushes = [], events = [];
  const notify = snapshotCrons => runNotifier({
    snapshot: { crons: { status: 'ok', data: snapshotCrons }, ingestCrons: { status: 'ok', data: [] } }, config: {}, now: env.clock.t,
    readSent: async () => sentStore, writeSent: async next => { Object.keys(sentStore).forEach(k => delete sentStore[k]); Object.assign(sentStore, next); },
    send: async e => { pushes.push(e); return { sent: true }; },
    events: async alerts => { events.push(...alerts.map(a => a.key)); return {}; }
  });
  await notify(await env.runner.pass([staleCron()]));
  at(env, NOW + 4 * MIN);
  await notify(await env.runner.pass([staleCron()]));
  at(env, NOW + 8 * MIN);
  await notify(await env.runner.pass([staleCron()]));
  assert.deepEqual([pushes, events], [[], []], 'quiet: no push, no wake');
  at(env, SINCE + 24 * H + MIN);
  const lifted = await env.runner.pass([staleCron()]);
  assert.equal(cronOf(lifted).last, 'Overdue · log 24 h old');
  await notify(lifted);
  assert.equal(pushes.length, 1, 'the quiet ended: pushed');
  assert.equal(pushes[0].message, '1 job failed — open the dashboard for detail');
  assert.deepEqual(events, ['cron:launchd:' + L]);
  at(env, SINCE + 24 * H + 2 * MIN);
  await notify(await env.runner.pass([staleCron()]));
  assert.equal(pushes.length, 1, 'once');
});

test('L1 (11-21): a quiet mark ended by the ceiling counts for the comeback rule, in memory and after a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-ceil-cb-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const ledgerPath = join(dir, 'heals.json');
  const env = await quietEnv(t, [147, 149, 151, 153, 155], { ledgerPath });
  const end = SINCE + 24 * H + 1;
  at(env, end);
  await env.runner.pass([staleCron()]);
  const reads = env.launchctlPrint.calls.length;
  // Another instance (the log written 10 minutes after the quiet ended) within the hour.
  const next = { lastRunAt: end + 10 * MIN };
  at(env, end + 30 * MIN);
  const out = await env.runner.pass([staleCron(next)]);
  assert.equal(cronOf(out).state, 'failed');
  assert.equal(env.launchctlPrint.calls.length, reads, 'a comeback is not read');
  assert.deepEqual(env.ledger.lines().map(l => l.why), ['clean', 'log-ceiling', 'came-back']);
  // After a restart, the ledger's ceiling line says when the quiet ended.
  const lines = env.ledger.lines().slice(0, 2);
  await writeFile(join(dir, 'restart.json'), JSON.stringify(lines));
  const env2 = await setup({ ledgerPath: join(dir, 'restart.json') });
  t.after(env2.done);
  at(env2, end + 30 * MIN);
  await env2.runner.pass([staleCron(next)]);
  assert.deepEqual(env2.launchctlPrint.calls, [], 'still a comeback after a restart');
  assert.deepEqual(env2.ledger.lines().map(l => l.why), ['clean', 'log-ceiling', 'came-back']);
  // An hour on, that instance is closed (its came-back line), but a later one is read.
  at(env2, end + 2 * H);
  await env2.runner.pass([staleCron({ lastRunAt: end + 90 * MIN })]);
  assert.deepEqual(env2.launchctlPrint.calls, [L]);
  // A ceiling line with no heal of its instance before it (a log already past it at first
  // sight) ended no quiet: no comeback hold.
  await writeFile(join(dir, 'never-quiet.json'), JSON.stringify([{ ...lines[1], at: end }]));
  const env3 = await setup({ ledgerPath: join(dir, 'never-quiet.json') });
  t.after(env3.done);
  at(env3, end + 30 * MIN);
  await env3.runner.pass([staleCron(next)]);
  assert.deepEqual(env3.launchctlPrint.calls, [L]);
});

// ---- guards on the wiring ----

test('the runner reads launchd only through `launchctl print`, and server.mjs wires it so', async () => {
  const healthSrc = await readFile(join(HERE, '..', 'collectors', 'health.mjs'), 'utf8');
  assert.ok(/export const runLaunchctlPrint = label =>\s*exec\('\/bin\/launchctl', \['print', `gui\/\$\{process\.getuid\(\)\}\/\$\{label\}`\]/.test(healthSrc), 'runLaunchctlPrint runs launchctl print and nothing else');
  const server = (await readFile(join(HERE, '..', 'server.mjs'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const wired = [
    [/const healLedger = createHealLedger\(\{ path: join\(HERE, 'data', 'heals\.json'\) \}\);/, 'one ledger, in data/'],
    [/createHealRunner\(\{\s*settings: healSettings,\s*ledger: healLedger,\s*launchctlPrint: runLaunchctlPrint,/, 'the runner gets runLaunchctlPrint'],
    [/killed:\s*\(\)\s*=>\s*killFileThere\(healOffPath\)/, 'the kill switch is the file, read by lstat (L3)'],
    [/const healOffPath = join\(homedir\(\), '\.local', 'state', 'jarvis-os', 'heal-off'\)/, 'the kill switch path'],
    [/out = await heal\.pass\(overlaid,/, 'the crons pass goes through the runner'],
    [/return out;\s*\}, 60 \* 1000\);/, 'and the panel goes out as the runner left it'],
    [/loops:\s*\(\)\s*=>\s*withLoopParts\(heal\.view\(\), \[missed\.view\(\), restartLoop\.view\(\)\]\)/, 'the routes get the view'],
    [/quietOf:\s*\(label, since\)\s*=>\s*heal\.quietOf\(label, since\)/, 'the Jobs list gets the quiet marks'],
    [/eventKnown:\s*key\s*=>\s*Boolean\(events\?\.knows\(key\)\)/, 'the heal hold asks the events ledger (L4)'],
    [/ackNotice\(stored, Date\.now\(\), \{ via: 'heal-card' \}\)/, "a heal card's ack notice says it came from a heal card"]
  ];
  for (const [re, what] of wired) assert.ok(re.test(server), what);
  for (const f of ['heal.mjs', 'heal-runner.mjs', 'heal-ledger.mjs', 'heal-missed.mjs', 'heal-routes.mjs', 'heal-restart.mjs']) {
    const src = await readFile(join(HERE, '..', 'lib', f), 'utf8');
    assert.ok(!/child_process|execFile|spawn\(/.test(src), `${f} runs no program itself`);
    // heal.mjs's two launchctl writes are `kickstart gui/{uid}/{label}` and loop 3's
    // `kickstart -k gui/{uid}/{label}`: the reviewed lists in PROGRAM_ARGS and the
    // catalog's programs, which must equal them.
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/'launchctl:[a-z-]+'/g, '')
      .replaceAll("Object.freeze(['kickstart', 'gui/{uid}/{label}'])", '').replaceAll("Object.freeze(['kickstart', '-k', 'gui/{uid}/{label}'])", '');
    assert.ok(!/kickstart|bootstrap|bootout|launchctl (load|unload)/.test(code), `${f} names no launchctl write outside the floor table and the catalog's program`);
  }
});

// L5 (Ultron, 11-13): a view that throws leaves the dashboard up.
test('L5: a loops view that throws: /api/dashboard and /api/loops still answer 200, the panel says off, the log says it once a spell', async t => {
  const cache = createCache();
  const logs = [];
  let fail = true;
  const loops = () => {
    if (fail) throw Object.assign(new Error('boom /Users/someone/secret'), { code: 'EBOOM' });
    return { status: 'on', why: null, open: [], quiet: [], held: [], recent: [], weeks: [], generatedAt: NOW };
  };
  const server = await listen(createHandler({ cache, todos: { read: async () => [] }, config: { present: true }, loops, log: l => logs.push(l) }));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const dash = await fetchJson(port, '/api/dashboard');
  assert.equal(dash.status, 200);
  assert.deepEqual([dash.body.loops.status, dash.body.loops.open, dash.body.loops.recent], ['off', [], []]);
  assert.match(dash.body.loops.why, /view failed/);
  const res = await fetchJson(port, '/api/loops');
  assert.deepEqual([res.status, res.body.status], [200, 'off']);
  assert.deepEqual(logs, ['loops: the view failed (EBOOM); the dashboard goes on without it'], 'once, by its code, never its message');
  fail = false;
  assert.equal((await fetchJson(port, '/api/loops')).body.status, 'on');
  fail = true;
  await fetchJson(port, '/api/loops');
  assert.equal(logs.length, 2, 'a new spell is said again');
});

test('GET /api/loops without a runner says not set up; nothing else on the path answers 200', async t => {
  const cache = createCache();
  const server = await listen(createHandler({ cache, todos: { read: async () => [] }, config: { present: true } }));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const res = await fetchJson(port, '/api/loops');
  assert.deepEqual([res.status, res.body.status, res.body.open, res.body.recent], [200, 'unset', [], []]);
  const dash = await fetchJson(port, '/api/dashboard');
  assert.equal(dash.body.loops.status, 'unset');
  const post = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/loops', method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, r => {
      r.resume();
      r.on('end', () => resolve(r.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.notEqual(post, 200, 'the loops are read-only');
});

test('a ledger write that fails at the rename leaves no temp file and keeps nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-ren-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(dir, 'heals.json');
  await mkdir(path);
  const ledger = createHealLedger({ path, now: () => NOW });
  await assert.rejects(ledger.append({ at: NOW, class: 'stale-log', action: 'mark-quiet', tier: 'T1', target: 'x', outcome: 'healed' }));
  assert.deepEqual(ledger.lines(), []);
  assert.deepEqual((await readdir(dir)).sort(), ['heals.json']);
});
