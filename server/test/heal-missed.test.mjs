// Self-healing loop 2 (lib/heal-missed.mjs, lib/heal-programs.mjs, the catalog's program
// check in lib/heal.mjs): a run missed during a restart gets a card, and only a tap acts.
// A fake `launchctl print`, a fake program runner that records what it was given, a fake
// missed-runs report and a fake clock drive each case of the design's test plan
// (docs/design/2026-11-12-self-healing-loops.md, §7, "Loop 2"). Nothing here runs
// launchctl or missed-runs; every label, name and time is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMissedRunLoops, missedFromReport, localTime, inQuietHours, proposalPush, PAGE_PUSH, ACK_NOTE,
  SCAN_EVERY_MS, SCAN_RETRY_MS, RERUN, ACK
} from '../lib/heal-missed.mjs';
import { runCatalogProgram, runMissedRuns, MISSED_RUNS_ARGS } from '../lib/heal-programs.mjs';
import { createHealRunner } from '../lib/heal-runner.mjs';
import { createHealLedger } from '../lib/heal-ledger.mjs';
import {
  CATALOG, loadCatalog, programArgs, readHealConfig, withMissedRuns, buildLoopsView, WHY_WORDS, PROPOSAL_MS, SETTLE_MAX_MS, LAUNCHCTL, PROGRAM_ARGS
} from '../lib/heal.mjs';
import { ACK_AFTER_NEXT_MS } from '../lib/acks.mjs';
import { PYTHON } from '../lib/program-check.mjs';

const MIN = 60e3, H = 3600e3, DAY = 24 * H;
const UID = process.getuid();
// Friday 2026-11-06: the mini came back at 16:49, four minutes after the Friday job's fire.
const FIRE = new Date(2026, 10, 6, 16, 45).getTime();
const NOW = new Date(2026, 10, 6, 17, 0).getTime();
const SINCE = FIRE - 7 * DAY + 2 * MIN; // the Friday job's last run, a week before
const NEXT = FIRE + 7 * DAY;
const FRI = 'com.example.friday', BRIEF = 'com.example.brief', TOKEN = 'com.example.token';
const pad = n => String(n).padStart(2, '0');
const iso = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// What missed-runs --since boot --json said on 2026-11-06, in shape (invented labels).
function report11_05() {
  const job = (label, extra) => ({ label, interval: null, logs: ['/Users/example/Library/Logs/x.log'], evidence: 'log mtime', loaded: true, ...extra });
  return {
    now: iso(NOW), since: iso(new Date(2026, 10, 5, 15, 6).getTime()),
    outages: [{ start: iso(new Date(2026, 10, 5, 15, 7).getTime()), end: iso(new Date(2026, 10, 6, 16, 49).getTime()), kind: 'restart', reboot: iso(new Date(2026, 10, 5, 16, 6).getTime()) }],
    jobs: [
      job(FRI, { last_run: iso(SINCE), result: { due: 1, missed: [{ at: iso(FIRE), why: 'restart' }], unresolved: true } }),
      // Missed in the outage too, but both have run since: no card.
      job(BRIEF, { last_run: iso(NOW - 5 * MIN), result: { due: 2, missed: [{ at: iso(new Date(2026, 10, 6, 7, 30).getTime()), why: 'restart' }], unresolved: false } }),
      job(TOKEN, { last_run: iso(NOW - 2 * MIN), result: { due: 1, missed: [{ at: iso(new Date(2026, 10, 6, 9, 12).getTime()), why: 'restart' }], unresolved: false } }),
      // Listed for a look, but not a missed run of this kind.
      job('com.example.unloaded', { loaded: false, last_run: null, result: { due: 1, missed: [{ at: iso(FIRE), why: 'restart' }], unresolved: true } }),
      job('com.example.sleepy', { last_run: iso(SINCE), result: { due: 1, missed: [{ at: iso(FIRE), why: 'gap', uncertain: true }], unresolved: true } }),
      job('com.example.broken', { last_run: iso(SINCE), result: { due: 1, missed: [{ at: iso(FIRE), why: 'no run since' }], unresolved: true } }),
      job('com.example.interval', { interval: 180, last_run: iso(NOW - 2 * H), interval_result: { down: 25.7, skipped: 514, stale: true } }),
      // Missed, but config lists no heal target for it.
      job('com.example.stranger', { last_run: iso(SINCE), result: { due: 1, missed: [{ at: iso(FIRE), why: 'restart' }], unresolved: true } })
    ],
    skipped: [],
    needs_look: [FRI, 'com.example.unloaded', 'com.example.sleepy', 'com.example.broken', 'com.example.interval', 'com.example.stranger']
  };
}

const printed = ({ runs, exit = 0, state = 'not running' }) => [
  `gui/${UID}/x = {`, `\tstate = ${state}`, `\truns = ${runs}`, exit === null ? '\tlast terminating signal = Killed: 9' : `\tlast exit code = ${exit}`, '}'
].join('\n');

const everyTarget = {
  friday: { label: FRI, actions: ['rerun-job', 'ack-until-next-run'] },
  brief: { label: BRIEF, actions: ['ack-until-next-run'] },
  token: { label: TOKEN, actions: ['rerun-job', 'ack-until-next-run'] },
  unloaded: { label: 'com.example.unloaded', actions: ['rerun-job'] },
  sleepy: { label: 'com.example.sleepy', actions: ['rerun-job'] },
  broken: { label: 'com.example.broken', actions: ['rerun-job'] },
  interval: { label: 'com.example.interval', actions: ['rerun-job'] }
};
const settingsOf = (extra = {}) => readHealConfig({ heal: { enabled: true, targets: everyTarget, ...extra } });
const crons = (extra = {}) => [
  { name: 'friday', label: FRI, ok: true, state: 'ok', lastRunAt: SINCE, nextRunAt: NEXT, ...extra },
  { name: 'brief', label: BRIEF, ok: true, state: 'ok', lastRunAt: NOW - 5 * MIN, nextRunAt: NOW + 14 * H }
];

// A fake `launchctl print`: each label's answers in turn (the last repeats); an Error throws.
function fakeLaunchd(script) {
  const calls = [];
  const fn = async label => {
    calls.push(label);
    const list = script[label];
    if (!list) throw new Error('Could not find service');
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

async function setup({
  script = { [FRI]: [printed({ runs: 5 })], [BRIEF]: [printed({ runs: 40 })] }, settings = settingsOf(), report = report11_05(),
  at = NOW, dir = null, programFails = null, autoScan = false
} = {}) {
  const own = dir === null;
  const home = dir ?? await mkdtemp(join(tmpdir(), 'heal-missed-'));
  const env = { dir: home, clock: { t: at }, logs: [], pushes: [], programs: [], acks: [], acked: [], killed: false, scans: 0 };
  env.launchd = fakeLaunchd(script);
  env.ledger = createHealLedger({ path: join(home, 'data', 'heals.json'), now: () => env.clock.t });
  const heal = createHealRunner({ settings, ledger: env.ledger, launchctlPrint: env.launchd, killed: () => env.killed, now: () => env.clock.t, log: () => {} });
  await heal.load();
  env.heal = heal;
  env.report = report;
  env.runner = createMissedRunLoops({
    settings,
    ledger: env.ledger,
    status: () => heal.status(),
    launchctlPrint: env.launchd,
    runProgram: async (entry, target) => {
      env.programs.push({ file: entry.program.file, args: programArgs(entry, target), outcomesThen: env.ledger.lines().map(l => l.outcome) });
      if (programFails) throw programFails;
    },
    missedRuns: async () => { env.scans++; if (env.report instanceof Error) throw env.report; return env.report; },
    addAck: async (made, now) => { env.acks.push({ made, now }); return [made]; },
    uid: UID,
    jobNames: { [FRI]: { name: 'Friday alert' }, [BRIEF]: { name: 'Morning brief' } },
    now: () => env.clock.t,
    log: l => env.logs.push(l),
    notify: async (message, opts) => { env.pushes.push({ message, ...opts }); return { sent: true }; },
    onAck: stored => env.acked.push(stored),
    autoScan
  });
  env.done = () => (own ? rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) : Promise.resolve());
  env.cards = () => env.runner.view().proposals;
  env.card = (name = 'Friday alert') => env.cards().find(p => p.name === name);
  return env;
}
const go = (env, ms) => { env.clock.t = ms; };
const outcomes = env => env.ledger.lines().map(l => l.outcome);

// ---- the pure parts ----

test('missed-runs times are local, and a date that rolls over is refused', () => {
  assert.equal(localTime('2026-11-06T16:45'), FIRE);
  assert.equal(localTime('2026-11-06T16:45:30'), FIRE + 30e3);
  for (const bad of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-11-31T10:00', '2026-11-06 16:45', '2026-11-06T25:00', '2026-11-06T16:61', '', null, 17, '2026-11-06T16:45Z']) assert.equal(localTime(bad), null, String(bad));
});

test('quiet hours run from 22:00 to 07:00 by the server clock', () => {
  const at = (h, m) => new Date(2026, 10, 6, h, m).getTime();
  assert.deepEqual([at(21, 59), at(22, 0), at(3, 0), at(6, 59), at(7, 0), at(12, 0)].map(inQuietHours), [false, true, true, true, false, false]);
});

test('the report: one instance per job missed in a restart or a sure gap and not run since, nothing else', () => {
  const r = report11_05();
  const gap = { label: 'com.example.napped', interval: null, loaded: true, last_run: iso(SINCE), result: { missed: [{ at: iso(FIRE - DAY), why: 'restart' }, { at: iso(FIRE), why: 'gap' }], unresolved: true } };
  // Flagged for its interval half, but its calendar half has run since: no card.
  const both = { label: 'com.example.both', interval: 300, loaded: true, last_run: iso(NOW - H), interval_result: { stale: true }, result: { missed: [{ at: iso(FIRE), why: 'restart' }], unresolved: false } };
  // Missed before its last run, then twice after: two count.
  const older = { label: 'com.example.older', interval: null, loaded: true, last_run: iso(FIRE - 3 * DAY), result: { missed: [{ at: iso(FIRE - 8 * DAY), why: 'restart' }, { at: iso(FIRE - DAY), why: 'restart' }, { at: iso(FIRE), why: 'restart' }], unresolved: true } };
  r.jobs.push(gap, { ...gap, label: 'com.example.napped' }, { label: 'not a label!', result: gap.result }, both, older);
  r.needs_look.push('com.example.napped', 'not a label!', 'com.example.both', 'com.example.older');
  const got = missedFromReport(r);
  assert.deepEqual(got.map(m => [m.label, m.why, m.missedAt, m.count]), [
    [FRI, 'restart', FIRE, 1], ['com.example.stranger', 'restart', FIRE, 1], ['com.example.napped', 'gap', FIRE, 2], ['com.example.older', 'restart', FIRE, 2]
  ]);
  assert.throws(() => missedFromReport({ jobs: [] }), /not a missed-runs report/);
  assert.throws(() => missedFromReport(null), /not a missed-runs report/);
  const notLooked = report11_05();
  notLooked.needs_look = [];
  assert.deepEqual(missedFromReport(notLooked), [], 'only what missed-runs itself flags');
});

test("the catalog's program is checked against its verbs, and fills in only the uid and the label", () => {
  const rerun = loadCatalog(CATALOG).get('rerun-job');
  assert.deepEqual(rerun.verbs, ['launchctl:print', 'launchctl:kickstart']);
  assert.equal(rerun.tier, 'T2');
  assert.equal(rerun.program.file, '/bin/launchctl');
  assert.deepEqual(programArgs(rerun, { uid: UID, label: FRI }), ['kickstart', `gui/${UID}/${FRI}`], 'no -k: a run that is going is never killed');
  assert.throws(() => programArgs(rerun, { uid: UID, label: 'a b' }), /not a launchd label/);
  assert.throws(() => programArgs(rerun, { uid: UID, label: '-k' }), /not a launchd label/);
  assert.throws(() => programArgs(rerun, { uid: -1, label: FRI }), /uid/);
  assert.equal(loadCatalog(CATALOG).get('ack-until-next-run').tier, 'T2');
  const entry = (extra = {}) => ({ id: 'x', class: 'missed-run', tier: 'T2', targetKind: 'job', verbs: ['launchctl:print', 'launchctl:kickstart'], settleMs: 60e3, program: { file: '/bin/launchctl', args: ['kickstart', 'gui/{uid}/{label}'] }, ...extra });
  assert.equal(loadCatalog([entry()]).get('x').program.args.length, 2);
  assert.deepEqual(PROGRAM_ARGS, { 'launchctl:kickstart': ['kickstart', 'gui/{uid}/{label}'] }, 'one reviewed list; loop 3 adds launchctl:kickstart-kill when it is reviewed');
  assert.throws(() => loadCatalog([entry({ program: undefined })]), /declares launchctl:kickstart but names no program/);
  assert.throws(() => loadCatalog([entry({ program: { file: '/bin/sh', args: ['kickstart', 'gui/{uid}/{label}'] } })]), /must be \/bin\/launchctl/);
  assert.throws(() => loadCatalog([entry({ program: { file: '/bin/launchctl', args: 'kickstart gui/{uid}/{label}' } })]), /list of arguments/);
  // Anything but the reviewed list, exactly (L1): a flag, a reorder, a missing or extra word, another blank, another subcommand.
  for (const args of [['kickstart', '-k', 'gui/{uid}/{label}'], ['gui/{uid}/{label}', 'kickstart'], ['kickstart'], ['kickstart', 'gui/{uid}/{label}', 'x'], ['kickstart', 'gui/{uid}/{path}'], ['bootout', 'gui/{uid}/{label}'], [], ['kickstart', 'gui/{uid}/{label} ']]) {
    assert.throws(() => loadCatalog([entry({ program: { file: '/bin/launchctl', args } })]), /not the reviewed list for launchctl:kickstart/, JSON.stringify(args));
  }
  assert.throws(() => loadCatalog([entry({ verbs: ['launchctl:print', 'launchctl:kickstart', 'launchctl:bootout'] })]), /exactly one launchctl write/);
  assert.throws(() => loadCatalog([entry({ verbs: ['launchctl:print', 'launchctl:bootout'], program: { file: '/bin/launchctl', args: ['bootout', 'gui/{uid}/{label}'] } })]), /no argument list is reviewed for launchctl:bootout/);
  assert.throws(() => loadCatalog([entry({ verbs: ['launchctl:print'], program: { file: '/bin/launchctl', args: ['kickstart', 'gui/{uid}/{label}'] } })]), /exactly one launchctl write/, 'a program with no write verb');
});

test('the programs: launchctl gets exactly the catalog arguments, missed-runs its read-only flags', async () => {
  const rerun = loadCatalog(CATALOG).get('rerun-job');
  const calls = [];
  const exec = code => async (file, args, opts) => { calls.push({ file, args, timeout: opts.timeout, envKeys: Object.keys(opts.env) }); return { code, stdout: '{"jobs":[],"needs_look":[]}' }; };
  await runCatalogProgram(rerun, { uid: UID, label: FRI }, { exec: exec(0) });
  assert.deepEqual([calls[0].file, calls[0].args], [LAUNCHCTL, ['kickstart', `gui/${UID}/${FRI}`]]);
  assert.ok(calls[0].timeout > 0);
  await assert.rejects(runCatalogProgram(rerun, { uid: UID, label: FRI }, { exec: exec(113) }), /exited 113/);
  await assert.rejects(runCatalogProgram(rerun, { uid: UID, label: 'x;y' }, { exec: exec(0) }), /not a launchd label/);
  assert.equal(calls.length, 2, 'a bad label never reaches the program');
  await assert.rejects(runCatalogProgram(loadCatalog(CATALOG).get('mark-quiet'), { uid: UID, label: FRI }, { exec: exec(0) }), /runs no program/);
  // Only this process's own domain (L4): another uid, root's included, never reaches launchctl.
  for (const other of [0, UID + 1, undefined, String(UID)]) {
    await assert.rejects(runCatalogProgram(rerun, { uid: other, label: FRI }, { exec: exec(0) }), /not this process's own/, String(other));
  }
  assert.equal(calls.length, 2);

  calls.length = 0;
  assert.deepEqual(await runMissedRuns('/opt/example/missed-runs', { exec: exec(1) }), { jobs: [], needs_look: [] }, 'exit 1 means a job needs a look: an answer');
  assert.deepEqual([calls[0].file, calls[0].args], [PYTHON, ['-I', '/opt/example/missed-runs', ...MISSED_RUNS_ARGS]]);
  assert.deepEqual(MISSED_RUNS_ARGS, ['--since', 'boot', '--json']);
  assert.ok(!calls[0].envKeys.some(k => /^(PYTHON|DYLD|NODE)/.test(k)));
  await assert.rejects(runMissedRuns('/opt/example/missed-runs', { exec: exec(2) }), /exited 2/);
  await assert.rejects(runMissedRuns('/opt/example/missed-runs', { exec: async () => ({ code: 0, stdout: 'Scheduled runs missed' }) }), /not JSON/);
});

// ---- the loop ----

test('replaying the 11-05 restart gives one card, for the Friday job, pushed once, counted and never named', async t => {
  const env = await setup();
  t.after(env.done);
  assert.equal(await env.runner.scan(), 1, 'only the Friday job, of the jobs config lists');
  await env.runner.pass(crons());
  const cards = env.cards();
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.deepEqual([c.name, c.class, c.tier, c.missedAt, c.why, c.fingerprint, c.actions, c.canAct, c.blocked, c.expiresAt, c.nextRunAt, c.state],
    ['Friday alert', 'missed-run', 'T2', FIRE, 'restart', WHY_WORDS.restart, [RERUN, ACK], true, null, NOW + PROPOSAL_MS, NEXT, 'waiting']);
  assert.match(c.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(env.pushes, [{ message: proposalPush(1), priority: 'default' }]);
  assert.ok(!/Friday|example/.test(env.pushes[0].message), 'a push counts, never names');
  assert.deepEqual(outcomes(env), ['proposed']);
  const open = env.runner.view().open;
  assert.deepEqual(open.map(o => [o.name, o.step, o.waiting, o.tier]), [['Friday alert', 'acting', true, 'T2']]);
  assert.ok(!JSON.stringify(env.runner.view()).includes('com.example'), 'no label reaches the page');
  // Another pass and another scan: the same card, no second push.
  go(env, NOW + 5 * MIN);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 1);
  assert.equal(env.cards()[0].id, c.id);
  assert.equal(env.pushes.length, 1);
  assert.deepEqual(env.programs, [], 'nothing ran without a tap');
});

test('Run it now: the line first, then exactly the catalog program, once; a second tap finds nothing; verified clean', async t => {
  const env = await setup({ script: { [FRI]: [printed({ runs: 5 }), printed({ runs: 5 }), printed({ runs: 6, state: 'running' }), printed({ runs: 6 })] } });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const id = env.card().id;
  go(env, NOW + MIN);
  const r = await env.runner.approve(id, RERUN, 'iPhone');
  assert.equal(r.status, 202, r.error);
  assert.equal(r.checkBy, NOW + MIN + SETTLE_MAX_MS);
  assert.equal(r.name, 'Friday alert');
  assert.equal(env.programs.length, 1);
  assert.deepEqual([env.programs[0].file, env.programs[0].args], ['/bin/launchctl', ['kickstart', `gui/${UID}/${FRI}`]]);
  assert.deepEqual(env.programs[0].outcomesThen, ['proposed', 'tapped'], 'the ledger has the tap before the program runs');
  const tapped = env.ledger.lines().find(l => l.outcome === 'tapped');
  assert.deepEqual([tapped.by, tapped.runs, tapped.tier, tapped.target, tapped.since], ['iPhone', [5, null], 'T2', 'friday', FIRE]);
  const again = await env.runner.approve(id, RERUN, 'iPhone');
  assert.equal(again.status, 404);
  assert.equal(env.programs.length, 1, 'a second tap runs nothing');
  assert.equal(env.cards().length, 0);
  assert.deepEqual(env.runner.view().open.map(o => [o.step, o.checkBy]), [['verifying', NOW + MIN + SETTLE_MAX_MS]]);
  // Still running at the next pass: nothing closes.
  go(env, NOW + 2 * MIN);
  await env.runner.pass(crons());
  assert.deepEqual(outcomes(env), ['proposed', 'tapped']);
  go(env, NOW + 3 * MIN);
  await env.runner.pass(crons());
  const healed = env.ledger.lines().at(-1);
  assert.deepEqual([healed.outcome, healed.why, healed.tier, healed.runs], ['healed', 'clean', 'T2', [5, 6]]);
  assert.deepEqual(env.pushes.map(p => p.priority), ['default'], 'no page for a run that healed');
  assert.equal(env.runner.view().open.length, 0);
  // Never offered again: a new scan finds the same instance spent.
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0);
  const v = buildLoopsView({ status: 'on', settings: settingsOf(), lines: env.ledger.lines(), jobNames: { [FRI]: { name: 'Friday alert' } }, now: env.clock.t });
  assert.deepEqual(v.recent.map(x => [x.name, x.words]), [['Friday alert', 'ran it again, clean']], 'the marks on the way are not listed');
});

for (const [name, script, wait, why] of [
  ['a run that ends with exit 1', [printed({ runs: 5 }), printed({ runs: 5 }), printed({ runs: 6, exit: 1 })], 2 * MIN, 'exit'],
  ['a run still going after 10 minutes', [printed({ runs: 5 }), printed({ runs: 5 }), printed({ runs: 6, state: 'running' })], SETTLE_MAX_MS + MIN, 'still-running'],
  ['a run that never started', [printed({ runs: 5 })], SETTLE_MAX_MS + MIN, 'flat'],
  ['a counter that went back', [printed({ runs: 5 }), printed({ runs: 5 }), printed({ runs: 1 })], 2 * MIN, 'reset']
]) {
  test(`T3 with a high push: ${name}`, async t => {
    const env = await setup({ script: { [FRI]: script } });
    t.after(env.done);
    await env.runner.scan();
    await env.runner.pass(crons());
    assert.equal((await env.runner.approve(env.card().id, RERUN, 'iPhone')).status, 202);
    go(env, NOW + wait - 2 * MIN);
    if (why !== 'exit' && why !== 'reset') {
      await env.runner.pass(crons());
      assert.equal(env.ledger.lines().at(-1).outcome, 'tapped', 'not before its 10 minutes');
    }
    go(env, NOW + wait);
    await env.runner.pass(crons());
    const last = env.ledger.lines().at(-1);
    assert.deepEqual([last.outcome, last.why, last.tier], ['escalated', why, 'T3']);
    assert.deepEqual(env.pushes.at(-1), { message: PAGE_PUSH, priority: 'high' });
    assert.ok(!/Friday|example/.test(PAGE_PUSH));
    assert.equal(env.runner.view().open.length, 0);
  });
}

test('a stale, reused or made-up id is refused, and so is an action the card does not offer', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal((await env.runner.approve('0'.repeat(32), RERUN, 'iPhone')).status, 404);
  assert.equal((await env.runner.approve('xyz', RERUN, 'iPhone')).status, 404);
  assert.equal((await env.runner.approve('constructor', RERUN, 'iPhone')).status, 404);
  const id = env.card().id;
  assert.equal((await env.runner.approve(id, 'mark-quiet', 'iPhone')).status, 400);
  assert.equal((await env.runner.approve(id, 'restart-everything', 'iPhone')).status, 400);
  assert.equal((await env.runner.decline(id, 'iPhone')).status, 200);
  assert.equal((await env.runner.approve(id, RERUN, 'iPhone')).status, 404, 'a declined card is gone');
  assert.equal((await env.runner.decline(id, 'iPhone')).status, 404);
  assert.deepEqual(env.programs, []);

  // A job whose config allows only the ack: its card offers only the ack.
  const brief = await setup({ settings: settingsOf({ targets: { brief: everyTarget.brief } }), report: { ...report11_05(), jobs: [{ label: BRIEF, loaded: true, last_run: iso(SINCE), result: { missed: [{ at: iso(FIRE), why: 'restart' }], unresolved: true } }], needs_look: [BRIEF] } });
  t.after(brief.done);
  await brief.runner.scan();
  await brief.runner.pass(crons());
  const b = brief.card('Morning brief');
  assert.deepEqual(b.actions, [ACK]);
  assert.equal((await brief.runner.approve(b.id, RERUN, 'iPhone')).status, 400);
  assert.deepEqual(brief.programs, []);
});

test('the tap reads launchd again: a run since, a run going, or launchd unreadable never runs it', async t => {
  const env = await setup({ script: { [FRI]: [printed({ runs: 5 }), printed({ runs: 6 })] } });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const ran = await env.runner.approve(env.card().id, RERUN, 'iPhone');
  assert.equal(ran.status, 409);
  assert.match(ran.error, /has run since/);
  assert.deepEqual(env.programs, []);
  assert.deepEqual(outcomes(env).slice(-1), ['cleared']);
  assert.equal(env.cards().length, 0);

  const going = await setup({ script: { [FRI]: [printed({ runs: 5 }), printed({ runs: 5, state: 'running' }), printed({ runs: 5 })] } });
  t.after(going.done);
  await going.runner.scan();
  await going.runner.pass(crons());
  const id = going.card().id;
  const busy = await going.runner.approve(id, RERUN, 'iPhone');
  assert.equal(busy.status, 409);
  assert.match(busy.error, /running now/);
  assert.equal(going.card().state, 'waiting', 'the card stays for another tap');
  assert.equal((await going.runner.approve(id, RERUN, 'iPhone')).status, 202);
  assert.equal(going.programs.length, 1);

  const blind = await setup({ script: { [FRI]: [printed({ runs: 5 }), new Error('launchd timed out')] } });
  t.after(blind.done);
  await blind.runner.scan();
  await blind.runner.pass(crons());
  const r = await blind.runner.approve(blind.card().id, RERUN, 'iPhone');
  assert.equal(r.status, 503);
  assert.deepEqual(blind.programs, [], "can't tell never acts");
  const last = blind.ledger.lines().at(-1);
  assert.deepEqual([last.outcome, last.why, last.tier], ['escalated', 'unreadable', 'T3']);
  assert.deepEqual(blind.pushes.at(-1), { message: PAGE_PUSH, priority: 'high' });
});

test('Ack until its next run acks the instance by heal until the next run plus 2 hours, and closes the card', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  go(env, NOW + MIN);
  const r = await env.runner.approve(env.card().id, ACK, 'iPad');
  assert.equal(r.status, 200, r.error);
  assert.equal(r.until, NEXT + ACK_AFTER_NEXT_MS);
  assert.equal(env.acks.length, 1);
  const a = env.acks[0].made;
  assert.deepEqual([a.key, a.kind, a.since, a.by, a.note, a.until, a.at], [`cron:launchd:${FRI}`, 'cron', SINCE, 'heal', ACK_NOTE, NEXT + ACK_AFTER_NEXT_MS, NOW + MIN]);
  assert.equal(env.acked.length, 1, 'the ack is noticed like any other');
  const line = env.ledger.lines().at(-1);
  assert.deepEqual([line.outcome, line.action, line.tier, line.by, line.until], ['acked', ACK, 'T2', 'iPad', NEXT + ACK_AFTER_NEXT_MS]);
  assert.deepEqual(env.programs, []);
  assert.equal(env.cards().length, 0);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0, 'never offered again');

  // With the instance or the next run unknown (no job-status overlay), no ack (L2): the
  // card stays, and the tap says to ack from the alert.
  for (const missing of [{ lastRunAt: undefined }, { nextRunAt: undefined }, { nextRunAt: null }]) {
    const blind = await setup();
    t.after(blind.done);
    await blind.runner.scan();
    await blind.runner.pass(crons(missing));
    const r = await blind.runner.approve(blind.card().id, ACK, 'iPad');
    assert.deepEqual([r.status, r.error], [409, "its next run isn't known; ack it from the alert"], JSON.stringify(missing));
    assert.deepEqual(blind.acks, []);
    assert.equal(blind.card().state, 'waiting');
    assert.deepEqual(outcomes(blind), ['proposed']);
  }
});

test('an ack that cannot be saved writes its line and pages', async t => {
  const env = await setup();
  t.after(env.done);
  const failing = createMissedRunLoops({
    settings: settingsOf(), ledger: env.ledger, status: () => env.heal.status(), launchctlPrint: env.launchd, runProgram: async () => {},
    missedRuns: async () => report11_05(),
    addAck: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); },
    notify: async (m, o) => { env.pushes.push({ message: m, ...o }); }, now: () => env.clock.t, log: () => {}, autoScan: false
  });
  await failing.scan();
  await failing.pass(crons());
  const r = await failing.approve(failing.view().proposals[0].id, ACK, 'iPad');
  assert.equal(r.status, 500);
  assert.deepEqual(outcomes(env), ['proposed', 'acked', 'escalated']);
  assert.equal(env.ledger.lines().at(-1).why, 'ack-failed');
  assert.deepEqual(env.pushes.at(-1), { message: PAGE_PUSH, priority: 'high' });
});

test('Not now closes the card for good, across a restart too', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const r = await env.runner.decline(env.card().id, 'iPhone');
  assert.deepEqual([r.status, r.action, r.name], [200, 'not-now', 'Friday alert']);
  assert.deepEqual(outcomes(env), ['proposed', 'declined']);
  assert.equal(env.ledger.lines().at(-1).by, 'iPhone');
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0);
  const again = await setup({ dir: env.dir, at: NOW + H });
  await again.runner.scan();
  await again.runner.pass(crons());
  assert.equal(again.cards().length, 0, 'a restart reads the ledger');
  assert.deepEqual(again.pushes, []);
});

test('quiet hours: a card made at night waits without a push and without expiring, then pushes at 07:00', async t => {
  const night = new Date(2026, 10, 6, 23, 10).getTime();
  const env = await setup({ at: night });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 1);
  assert.equal(env.card().expiresAt, null, 'no clock runs before the push');
  assert.equal(env.card().canAct, true, 'a tap at night still works');
  for (const [h, d] of [[1, 7], [6, 7]]) {
    go(env, new Date(2026, 10, d, h, 59).getTime());
    await env.runner.pass(crons());
  }
  assert.deepEqual(env.pushes, []);
  assert.equal(env.cards().length, 1, 'not expired in the night');
  const seven = new Date(2026, 10, 7, 7, 0).getTime();
  go(env, seven);
  await env.runner.pass(crons());
  assert.deepEqual(env.pushes, [{ message: proposalPush(1), priority: 'default' }]);
  assert.equal(env.card().expiresAt, seven + PROPOSAL_MS);
  go(env, seven + PROPOSAL_MS - 1);
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 1);
  go(env, seven + PROPOSAL_MS);
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0);
  const last = env.ledger.lines().at(-1);
  assert.deepEqual([last.outcome, last.why], ['expired', 'no-tap']);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0, 'an expired card is not made again');
  assert.equal(env.pushes.length, 1);
});

test('a run of the job in the meantime closes its card as cleared', async t => {
  const env = await setup({ script: { [FRI]: [printed({ runs: 5 }), printed({ runs: 6 })] } });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 1);
  go(env, NOW + MIN);
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0);
  assert.deepEqual(env.ledger.lines().at(-1).why, 'ran-since');
});

test('the kill switch: nothing is read, no tap acts, and the cards stay with their buttons off', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const id = env.card().id;
  env.killed = true;
  const reads = env.launchd.calls.length;
  go(env, NOW + 3 * H);
  await env.runner.pass(crons());
  assert.equal(env.launchd.calls.length, reads, 'no reading while killed');
  assert.equal(await env.runner.scan(), null);
  assert.equal(env.scans, 1, 'no scan while killed');
  const c = env.card();
  assert.deepEqual([c.canAct, c.state], [false, 'waiting']);
  assert.match(c.blocked, /kill switch/);
  for (const action of [RERUN, ACK]) {
    const r = await env.runner.approve(id, action, 'iPhone');
    assert.equal(r.status, 503);
    assert.match(r.error, /kill switch/);
  }
  assert.deepEqual([env.programs, env.acks], [[], []]);
  // Off again: the card is past its 2 hours, so the next pass expires it.
  env.killed = false;
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0);
  assert.equal(env.ledger.lines().at(-1).outcome, 'expired');
});

test('the kill switch between the tap and the program: nothing runs', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const id = env.card().id;
  // The kill comes while the tap waits for launchd's answer.
  const slow = createMissedRunLoops({
    settings: settingsOf(), ledger: env.ledger, status: () => env.heal.status(),
    launchctlPrint: async label => { if (env.killNext) env.killed = true; return env.launchd(label); },
    runProgram: async () => { env.programs.push('ran'); }, missedRuns: async () => report11_05(), addAck: async () => [],
    now: () => env.clock.t, log: () => {}, autoScan: false
  });
  await slow.scan();
  await slow.pass(crons());
  env.killNext = true;
  const r = await slow.approve(slow.view().proposals[0].id, RERUN, 'iPhone');
  assert.equal(r.status, 503);
  assert.deepEqual(env.programs, []);
  assert.equal(slow.view().proposals[0].state, 'waiting');
  assert.ok(id);
});

test('heal.enabled off: no scan, no cards, no taps', async t => {
  const env = await setup({ settings: readHealConfig({ heal: { enabled: false, targets: everyTarget } }) });
  t.after(env.done);
  assert.equal(await env.runner.scan(), null);
  await env.runner.pass(crons());
  assert.deepEqual([env.scans, env.cards(), env.launchd.calls], [0, [], []]);
  for (const r of [await env.runner.approve('a'.repeat(32), RERUN, 'iPhone'), await env.runner.decline('a'.repeat(32), 'iPhone')]) {
    assert.equal(r.status, 503);
    assert.match(r.error, /not set up on this server/);
  }
});

test('targets and actions come from config: an unlisted job gets no card, and an action turned off is not offered', async t => {
  const env = await setup({ settings: settingsOf({ off: ['rerun-job'] }) });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.deepEqual(env.cards().map(c => [c.name, c.actions]), [['Friday alert', [ACK]]]);
  assert.ok(!env.cards().some(c => c.name === 'stranger'));
  assert.equal((await env.runner.approve(env.card().id, RERUN, 'iPhone')).status, 400);
  const none = await setup({ settings: settingsOf({ off: ['rerun-job', 'ack-until-next-run'] }) });
  t.after(none.done);
  assert.equal(await none.runner.scan(), 0, 'nothing left to offer, so no card');
});

test('rate limits: 3 T2 actions per target and 20 in all in 24 hours, and no run within an hour of a heal of that target', async t => {
  const seed = async lines => {
    const dir = await mkdtemp(join(tmpdir(), 'heal-missed-'));
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'heals.json'), JSON.stringify(lines));
    const env = await setup({ dir });
    t.after(() => rm(dir, { recursive: true, force: true }));
    await env.runner.scan();
    await env.runner.pass(crons());
    return env;
  };
  const line = (target, i, extra = {}) => ({ at: NOW - (i + 1) * H, class: 'missed-run', action: RERUN, tier: 'T2', target, since: FIRE - (i + 1) * DAY, outcome: 'tapped', why: 'tapped', ...extra });
  const three = await seed([0, 1, 2].map(i => line('friday', i)));
  for (const action of [RERUN, ACK]) {
    const r = await three.runner.approve(three.card().id, action, 'iPhone');
    assert.equal(r.status, 429);
    assert.match(r.error, /3 times in 24 hours/);
  }
  assert.equal(three.card().state, 'waiting', 'the card stays');
  assert.deepEqual(three.programs, []);
  const old = await seed([0, 1, 2].map(i => line('friday', i, { at: NOW - DAY - (i + 1) * H })));
  assert.equal((await old.runner.approve(old.card().id, RERUN, 'iPhone')).status, 202, 'a day on, the count is clear');
  const day = await seed(Array.from({ length: 20 }, (_, i) => line(`t${i}`, i % 20, { at: NOW - (i + 1) * 30 * MIN, outcome: i % 2 ? 'acked' : 'tapped' })));
  assert.match((await day.runner.approve(day.card().id, ACK, 'iPhone')).error, /20 heals are used/);
  const back = await seed([line('friday', 0, { at: NOW - 30 * MIN, outcome: 'healed', class: 'stale-log', action: 'mark-quiet', tier: 'T1' })]);
  assert.match((await back.runner.approve(back.card().id, RERUN, 'iPhone')).error, /came back within an hour/);
  assert.equal((await back.runner.approve(back.card().id, ACK, 'iPhone')).status, 200, 'the ack is no heal');
});

test('two taps at once run the program once', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const id = env.card().id;
  const [a, b] = await Promise.all([env.runner.approve(id, RERUN, 'iPhone'), env.runner.approve(id, ACK, 'iPad')]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.equal(env.programs.length, 1);
  assert.deepEqual(env.acks, []);
});

test('a restart neither pushes a card twice nor loses a run it started', async t => {
  const env = await setup();
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.equal(env.pushes.length, 1);
  const b = await setup({ dir: env.dir, at: NOW + 20 * MIN });
  await b.runner.scan();
  await b.runner.pass(crons());
  assert.equal(b.cards().length, 1, 'the card again, under a new id');
  assert.notEqual(b.card().id, env.card().id);
  assert.equal(b.card().expiresAt, NOW + PROPOSAL_MS, 'its 2 hours run from the first push');
  assert.deepEqual(b.pushes, []);
  assert.equal((await b.runner.approve(env.card().id, RERUN, 'iPhone')).status, 404, "the old process's id means nothing now");

  // A run started, then the server restarted within its 10 minutes: checked again.
  assert.equal((await b.runner.approve(b.card().id, RERUN, 'iPhone')).status, 202);
  const c = await setup({ dir: env.dir, at: NOW + 23 * MIN, script: { [FRI]: [printed({ runs: 6 })] } });
  await c.runner.scan();
  await c.runner.pass(crons());
  assert.deepEqual([c.cards().length, c.programs.length], [0, 0], 'never run twice, never offered again');
  assert.deepEqual(outcomes(c).slice(-2), ['tapped', 'healed']);

  // The same, but the server came back after the 10 minutes: nobody saw it end.
  const d0 = await setup();
  t.after(d0.done);
  await d0.runner.scan();
  await d0.runner.pass(crons());
  assert.equal((await d0.runner.approve(d0.card().id, RERUN, 'iPhone')).status, 202);
  const d = await setup({ dir: d0.dir, at: NOW + SETTLE_MAX_MS + MIN });
  await d.runner.pass(crons());
  const last = d.ledger.lines().at(-1);
  assert.deepEqual([last.outcome, last.why, last.tier], ['escalated', 'unverified', 'T3']);
  assert.deepEqual(d.pushes, [{ message: PAGE_PUSH, priority: 'high' }]);
});

test('launchd unreadable at the first reading: no card until it reads, said once', async t => {
  const env = await setup({ script: { [FRI]: [new Error('x'), new Error('x'), printed({ runs: 5 })] } });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 0);
  assert.equal(env.logs.filter(l => /couldn't be read for friday/.test(l)).length, 1);
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 1);
});

test('the scan runs at the first pass, then daily; a failed read retries in 10 minutes', async t => {
  const env = await setup({ autoScan: true });
  t.after(env.done);
  env.report = new Error('missed-runs timed out');
  await env.runner.pass(crons());
  await env.runner.scanning();
  assert.equal(env.scans, 1);
  go(env, NOW + SCAN_RETRY_MS - 1);
  await env.runner.pass(crons());
  assert.equal(env.scans, 1);
  env.report = report11_05();
  go(env, NOW + SCAN_RETRY_MS);
  await env.runner.pass(crons());
  await env.runner.scanning();
  assert.equal(env.scans, 2);
  await env.runner.pass(crons());
  assert.equal(env.cards().length, 1);
  go(env, NOW + SCAN_RETRY_MS + SCAN_EVERY_MS - 1);
  await env.runner.pass(crons());
  assert.equal(env.scans, 2);
  go(env, NOW + SCAN_RETRY_MS + SCAN_EVERY_MS);
  await env.runner.pass(crons());
  await env.runner.scanning();
  assert.equal(env.scans, 3);
  assert.ok(env.logs.some(l => /missed-runs could not be read/.test(l)));
});

test("loop 2's view joins loop 1's: open loops together, cards as proposals", () => {
  const settings = settingsOf();
  const base = buildLoopsView({ status: 'on', settings, now: NOW, open: [{ target: 'friday', class: 'stale-log', action: 'mark-quiet', tier: 'T1', step: 'diagnosing', detectedAt: NOW }] });
  const v = withMissedRuns(base, { open: [{ name: 'Friday alert', step: 'acting', waiting: true }], proposals: [{ id: 'a'.repeat(32) }] });
  assert.deepEqual(v.open.map(o => o.step), ['diagnosing', 'acting']);
  assert.equal(v.proposals.length, 1);
  assert.deepEqual(withMissedRuns(base, null).proposals, []);
  const lines = [
    { at: NOW - H, class: 'missed-run', action: RERUN, tier: 'T2', target: 'friday', since: FIRE, outcome: 'proposed' },
    { at: NOW - H, class: 'missed-run', action: RERUN, tier: 'T2', target: 'friday', since: FIRE, outcome: 'tapped' },
    { at: NOW - 50 * MIN, class: 'missed-run', action: RERUN, tier: 'T3', target: 'friday', since: FIRE, outcome: 'escalated', why: 'exit' },
    { at: NOW - 40 * MIN, class: 'missed-run', action: ACK, tier: 'T2', target: 'brief', since: FIRE, outcome: 'acked', why: 'acked' },
    { at: NOW - 30 * MIN, class: 'missed-run', action: ACK, tier: 'T2', target: 'token', since: FIRE, outcome: 'declined', why: 'not-now' }
  ];
  const r = buildLoopsView({ status: 'on', settings, now: NOW, lines }).recent;
  assert.deepEqual(r.map(x => [x.outcome, x.words, x.classLabel]), [
    ['declined', 'not now', 'missed run'], ['acked', 'acked until its next run', 'missed run'], ['escalated', 'ran it again: it needs a look', 'missed run']
  ]);
});

test("a ledger that can't be written: the card still closes for this run, and the instance isn't offered again", async t => {
  const env = await setup();
  t.after(env.done);
  // The ledger writes the card's push mark, then refuses every line after.
  let writes = 0;
  const flaky = { load: () => env.ledger.load(), lines: () => env.ledger.lines(), append: async l => { if (++writes > 1) throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); return env.ledger.append(l); } };
  const runner = createMissedRunLoops({
    settings: settingsOf(), ledger: flaky, status: () => env.heal.status(), launchctlPrint: env.launchd, runProgram: async () => { env.programs.push('ran'); },
    missedRuns: async () => report11_05(), addAck: async () => [], notify: async () => {}, now: () => env.clock.t, log: l => env.logs.push(l), autoScan: false
  });
  await runner.scan();
  await runner.pass(crons());
  const id = runner.view().proposals[0].id;
  assert.equal((await runner.decline(id, 'iPhone')).status, 200);
  assert.ok(env.logs.some(l => /ledger line could not be written/.test(l)));
  assert.deepEqual(outcomes(env), ['proposed'], 'the declined line never landed');
  await runner.scan();
  await runner.pass(crons());
  assert.deepEqual(runner.view().proposals, [], 'not offered again in this run');
  // And Run it now refuses outright when its line can't be written: nothing runs.
  const env2 = await setup();
  t.after(env2.done);
  const refuse = { load: () => env2.ledger.load(), lines: () => env2.ledger.lines(), append: async l => { if (l.outcome === 'tapped') throw new Error('disk'); return env2.ledger.append(l); } };
  const r2 = createMissedRunLoops({
    settings: settingsOf(), ledger: refuse, status: () => env2.heal.status(), launchctlPrint: env2.launchd, runProgram: async () => { env2.programs.push('ran'); },
    missedRuns: async () => report11_05(), addAck: async () => [], notify: async () => {}, now: () => env2.clock.t, log: () => {}, autoScan: false
  });
  await r2.scan();
  await r2.pass(crons());
  const res = await r2.approve(r2.view().proposals[0].id, RERUN, 'iPhone');
  assert.equal(res.status, 503);
  assert.deepEqual(env2.programs, [], "a run the ledger can't record doesn't happen");
  assert.equal(r2.view().proposals[0].state, 'waiting', 'the card stays for another try');
});

test('M1: a pass while the program runs makes no second card, and a second tap has nothing to run', async t => {
  const env = await setup();
  t.after(env.done);
  let release;
  const gate = new Promise(r => { release = r; });
  const runner = createMissedRunLoops({
    settings: settingsOf(), ledger: env.ledger, status: () => env.heal.status(), launchctlPrint: env.launchd,
    runProgram: async () => { env.programs.push('ran'); await gate; },
    missedRuns: async () => report11_05(), addAck: async () => [], notify: async () => {}, now: () => env.clock.t, log: () => {}, autoScan: false
  });
  await runner.scan();
  await runner.pass(crons());
  const id = runner.view().proposals[0].id;
  const tap = runner.approve(id, RERUN, 'iPhone');
  // Let the tap reach the program, then pass and scan while it runs.
  while (env.programs.length === 0) await new Promise(r => setImmediate(r));
  go(env, NOW + MIN);
  await runner.scan();
  await runner.pass(crons());
  assert.deepEqual(runner.view().proposals, [], 'no second card for the same instance');
  assert.deepEqual(runner.view().open.map(o => o.step), ['verifying'], 'in flight as a run being checked');
  release();
  assert.equal((await tap).status, 202);
  await runner.scan();
  await runner.pass(crons());
  assert.deepEqual(runner.view().proposals, []);
  assert.equal(env.programs.length, 1);
  // A restart that finds the tapped line (even with the run past its check) offers no card either.
  const later = await setup({ dir: env.dir, at: NOW + 2 * H });
  await later.runner.scan();
  await later.runner.pass(crons());
  assert.deepEqual(later.cards(), []);
});

test('M1: a card tapped while the pass reads launchd is left to the tap', async t => {
  const env = await setup();
  t.after(env.done);
  let holdRead = null;
  const runner = createMissedRunLoops({
    settings: settingsOf(), ledger: env.ledger, status: () => env.heal.status(),
    launchctlPrint: async label => { if (holdRead) await holdRead; return printed({ runs: 5 }); },
    runProgram: async () => { env.programs.push('ran'); }, missedRuns: async () => report11_05(), addAck: async () => [], notify: async () => {},
    now: () => env.clock.t, log: () => {}, autoScan: false
  });
  await runner.scan();
  await runner.pass(crons());
  const id = runner.view().proposals[0].id;
  // The pass holds on its read of the card; a decline lands meanwhile.
  let release;
  holdRead = new Promise(r => { release = r; });
  go(env, NOW + 3 * H); // past the card's 2 hours: the pass would expire it
  const pass = runner.pass(crons());
  await new Promise(r => setImmediate(r));
  holdRead = null;
  const declined = runner.decline(id, 'iPhone');
  release();
  await pass;
  assert.equal((await declined).status, 200);
  assert.deepEqual(outcomes(env).filter(o => o !== 'proposed'), ['declined'], 'one closing line: the tap, not an expiry on top');
});

test('M1, each guard alone: a run in flight with its line hidden, and a tapped line with no run in flight, each make no card', async t => {
  // A ledger that hides its tapped lines: only `verifying` stands between the pass and a second card.
  const env = await setup();
  t.after(env.done);
  let release;
  const gate = new Promise(r => { release = r; });
  const hiding = { load: () => env.ledger.load(), lines: () => env.ledger.lines().filter(l => l.outcome !== 'tapped'), append: l => env.ledger.append(l) };
  const a = createMissedRunLoops({
    settings: settingsOf(), ledger: hiding, status: () => env.heal.status(), launchctlPrint: env.launchd, runProgram: async () => { env.programs.push('ran'); await gate; },
    missedRuns: async () => report11_05(), addAck: async () => [], notify: async () => {}, now: () => env.clock.t, log: () => {}, autoScan: false
  });
  await a.scan();
  await a.pass(crons());
  const tap = a.approve(a.view().proposals[0].id, RERUN, 'iPhone');
  while (env.programs.length === 0) await new Promise(r => setImmediate(r));
  await a.pass(crons());
  assert.deepEqual(a.view().proposals, [], 'verifying alone holds');
  release();
  await tap;

  // A tapped line for the instance with nothing in flight here: the line alone holds.
  const env2 = await setup();
  t.after(env2.done);
  await env2.runner.pass(crons()); // the first pass, with nothing found yet
  await env2.ledger.append({ at: NOW, class: 'missed-run', action: RERUN, tier: 'T2', target: 'friday', since: FIRE, outcome: 'tapped', why: 'tapped', runs: [5, null] });
  await env2.runner.scan();
  await env2.runner.pass(crons());
  assert.deepEqual(env2.cards(), [], 'the tapped line alone holds');
});

test('a program that fails to start: T3 with a page, nothing left in flight, no card again', async t => {
  const env = await setup({ programFails: Object.assign(new Error('exited 5'), { code: 'exit-5' }) });
  t.after(env.done);
  await env.runner.scan();
  await env.runner.pass(crons());
  const r = await env.runner.approve(env.card().id, RERUN, 'iPhone');
  assert.equal(r.status, 502);
  const last = env.ledger.lines().at(-1);
  assert.deepEqual([last.outcome, last.why, last.tier], ['escalated', 'start-failed', 'T3']);
  assert.deepEqual(env.pushes.at(-1), { message: PAGE_PUSH, priority: 'high' });
  assert.deepEqual(env.runner.view().open, [], 'nothing left being checked');
  await env.runner.scan();
  await env.runner.pass(crons());
  assert.deepEqual(env.cards(), []);
});
