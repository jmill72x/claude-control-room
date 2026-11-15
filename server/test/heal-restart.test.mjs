// Self-healing loop 3 (lib/heal-restart.mjs, the catalog's restart entry in lib/heal.mjs,
// runSelfRestart and createCheckoutReader in lib/heal-programs.mjs, the first pass in
// collectors/registry.mjs): a merge that changes server/ gets a Restart card, only a tap
// acts, and the new process checks the restart it comes from. A fake git, a fake
// program runner, a fake clock and timers drive each case of the design's test plan
// (docs/design/2026-11-12-self-healing-loops.md, §7, "Loop 3"); a "process" is a new
// loop on the same ledger file. One test reads a scratch git repo with invented
// commits. Nothing here runs launchctl or touches :8322; every label is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import {
  createRestartLoop, restartPush, RESTART_PAGE, RESTART, CLASS, KICK_DELAY_MS, NO_RESTART_MS, VERIFY_MS, CHECK_EVERY_MS
} from '../lib/heal-restart.mjs';
import { runSelfRestart, createCheckoutReader, SERVER_PATHS, RESTART_TIMEOUT_MS, parseCheckoutStatus, MAIN_BRANCH } from '../lib/heal-programs.mjs';
import { parseLaunchdPid } from '../lib/health.mjs';
import { createHealRunner } from '../lib/heal-runner.mjs';
import { createHealLedger } from '../lib/heal-ledger.mjs';
import { createMissedRunLoops } from '../lib/heal-missed.mjs';
import {
  CATALOG, loadCatalog, programArgs, readHealConfig, withLoopParts, buildLoopsView, PROGRAM_ARGS, VERB_FLOORS, LAUNCHCTL,
  RESTARTS_PER_DAY, PER_DAY, WHY_WORDS, outcomeWords, shortCommit
} from '../lib/heal.mjs';
import { createRegistry } from '../collectors/registry.mjs';
import { createCache } from '../cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const UID = process.getuid();
const LABEL = 'com.example.control-room';
// Sunday 2026-11-15, 10:00 local: out of quiet hours in either time zone the tests run in.
const NOW = new Date(2026, 10, 15, 10, 0).getTime();
const SELF_PID = 4321;
const START = 'a1'.repeat(20), H2 = 'b2'.repeat(20), H3 = 'c3'.repeat(20), H4 = 'd4'.repeat(20);

const settingsOf = (heal = {}) => readHealConfig({ heal: { enabled: true, targets: { 'control-room': { label: LABEL, actions: [RESTART] } }, ...heal } });

// A fake checkout: `head` is HEAD now; `changes[to]` what changed under server/ from START.
function fakeGit(env) {
  return {
    async head() {
      env.gitCalls.push('head');
      const gate = env.headGates.shift();
      if (gate) await gate;
      if (env.headFails) throw Object.assign(new Error('nope'), { code: 'exit-3' });
      return env.head;
    },
    // The checkout's state as the loop needs it (M1): HEAD and why it isn't fit, if it isn't.
    async checkout(from) {
      env.gitCalls.push('checkout');
      env.checkoutFrom.push(from);
      const gate = env.headGates.shift();
      if (gate) await gate;
      if (env.headFails || env.checkoutFails) throw Object.assign(new Error('nope'), { code: 'exit-3' });
      return { head: env.head, why: env.why };
    },
    async changed(from, to) {
      env.gitCalls.push(`changed ${String(from).slice(0, 2)}..${String(to).slice(0, 2)}`);
      if (env.changedFails) throw Object.assign(new Error('nope'), { code: 'exit-3' });
      return env.changes[to] ?? { files: 1, merges: 1 };
    }
  };
}

async function setup({ at = NOW, dir = null, head = START, changes = {}, self = { label: LABEL, launchd: true }, settings = settingsOf(), start = true, git = true, firstPass = null, catalogEntries = CATALOG } = {}) {
  const home = dir ?? await mkdtemp(join(tmpdir(), 'heal-restart-'));
  const env = {
    dir: home, clock: { t: at }, head, changes, logs: [], pushes: [], programs: [], gitCalls: [], timers: [], killed: false,
    headFails: false, changedFails: false, headGates: [], programFails: null, programAnswer: null,
    why: null, checkoutFrom: [], pid: SELF_PID, printFails: false, failing: [], prints: []
  };
  env.firstPass = firstPass ?? Promise.resolve({ failed: [] });
  env.ledger = createHealLedger({ path: join(home, 'data', 'heals.json'), now: () => env.clock.t });
  env.heal = createHealRunner({ settings, ledger: env.ledger, launchctlPrint: async () => { throw new Error('no launchd here'); }, killed: () => env.killed, now: () => env.clock.t, log: () => {} });
  await env.heal.load();
  env.loop = createRestartLoop({
    settings,
    ledger: env.ledger,
    status: () => env.heal.status(),
    git: git ? fakeGit(env) : null,
    launchctlPrint: async label => {
      env.prints.push(label);
      if (env.printFails) throw new Error('Could not find service');
      return [`gui/${UID}/${label} = {`, '\tstate = running', '\t\tpid = 1', `\tpid = ${env.pid}`, '}'].join('\n');
    },
    failingNow: () => env.failing,
    runProgram: async (entry, target) => {
      env.programs.push({ file: entry.program.file, args: programArgs(entry, target), outcomesThen: env.ledger.lines().filter(l => l.outcome !== 'proposed').map(l => l.outcome) });
      if (env.programFails) throw env.programFails;
      if (env.programAnswer) return env.programAnswer;
    },
    self: { pid: SELF_PID, ...self },
    firstPass: () => env.firstPass,
    uid: UID,
    catalogEntries,
    startedAt: at,
    now: () => env.clock.t,
    log: l => env.logs.push(l),
    notify: async (m, o) => { env.pushes.push([m, o?.priority]); },
    defer: (fn, ms) => { const t = { fn, at: env.clock.t + ms, ms, done: false }; env.timers.push(t); return t; }
  });
  // The loop's lines but the push marks (`proposed`), which env.proposed() lists.
  env.lines = () => env.ledger.lines().filter(l => l.class === CLASS && l.outcome !== 'proposed');
  env.proposed = () => env.ledger.lines().filter(l => l.class === CLASS && l.outcome === 'proposed');
  env.outcomes = () => env.lines().map(l => [l.outcome, l.why]);
  // Runs the timers that are due by now, in time order, awaiting each.
  env.runDue = async () => {
    for (;;) {
      const due = env.timers.filter(t => !t.done && t.at <= env.clock.t).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.done = true;
      await due.fn();
    }
  };
  env.card = () => env.loop.view().proposals[0] ?? null;
  if (start) await env.loop.start();
  env.done = async () => { if (dir === null) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  return env;
}

// One tap that lands: the card, the tap, the deferred restart.
async function tapThrough(env, { by = 'iPhone' } = {}) {
  const id = env.card().id;
  const r = await env.loop.approve(id, RESTART, by);
  assert.equal(r.status, 202, JSON.stringify(r));
  env.clock.t += KICK_DELAY_MS;
  await env.runDue();
  return r;
}

// ---- the catalog, the config and the programs ----

test('the catalog: restart-control-room is T2, its own verb, and its program is the reviewed -k list', () => {
  const e = loadCatalog(CATALOG).get(RESTART);
  assert.deepEqual([e.tier, e.floor, e.targetKind, e.class], ['T2', 'T2', 'self', CLASS]);
  assert.deepEqual(e.verbs, ['git:read', 'launchctl:print', 'launchctl:kickstart-kill']);
  assert.equal(VERB_FLOORS['launchctl:kickstart-kill'], 'T2');
  assert.equal(VERB_FLOORS['git:read'], 'T0');
  assert.deepEqual([e.program.file, e.program.args], [LAUNCHCTL, ['kickstart', '-k', 'gui/{uid}/{label}']]);
  assert.deepEqual(PROGRAM_ARGS['launchctl:kickstart-kill'], ['kickstart', '-k', 'gui/{uid}/{label}']);
  assert.deepEqual(programArgs(e, { uid: UID, label: LABEL }), ['kickstart', '-k', `gui/${UID}/${LABEL}`]);
  const entry = (extra = {}) => ({ id: 'x', class: CLASS, tier: 'T2', targetKind: 'self', verbs: ['launchctl:kickstart-kill'], settleMs: 60e3, program: { file: LAUNCHCTL, args: ['kickstart', '-k', 'gui/{uid}/{label}'] }, ...extra });
  assert.equal(loadCatalog([entry()]).get('x').floor, 'T2');
  assert.throws(() => loadCatalog([entry({ tier: 'T1' })]), /tier T1 is below its verbs' floor of T2/);
  assert.throws(() => loadCatalog([entry({ tier: 'T0', verbs: ['git:read', 'launchctl:kickstart-kill'] })]), /below its verbs' floor of T2/);
  // -k only as its own verb: the plain kickstart list on kickstart-kill, and -k on kickstart, are both refused.
  assert.throws(() => loadCatalog([entry({ program: { file: LAUNCHCTL, args: ['kickstart', 'gui/{uid}/{label}'] } })]), /not the reviewed list for launchctl:kickstart-kill/);
  assert.throws(() => loadCatalog([entry({ verbs: ['launchctl:kickstart'] })]), /not the reviewed list for launchctl:kickstart$/);
  for (const args of [['kickstart', '-kp', 'gui/{uid}/{label}'], ['-k', 'kickstart', 'gui/{uid}/{label}'], ['kickstart', '-k', '-p', 'gui/{uid}/{label}'], ['kickstart', '-k', 'system/{label}']]) {
    assert.throws(() => loadCatalog([entry({ program: { file: LAUNCHCTL, args } })]), /not the reviewed list/, JSON.stringify(args));
  }
  assert.throws(() => loadCatalog([entry({ program: undefined })]), /declares launchctl:kickstart-kill but names no program/);
  assert.throws(() => loadCatalog([entry({ targetKind: 'host' })]), /unknown target kind/);
});

test("config: a target listing restart-control-room is the server's own job, alone, and only one may be", () => {
  const s = readHealConfig({ heal: { enabled: true, targets: {
    'control-room': { label: LABEL, actions: [RESTART, 'rerun-job'] },
    again: { label: 'com.example.another', actions: [RESTART] },
    friday: { label: 'com.example.friday', actions: ['rerun-job', 'nope'] }
  } } });
  assert.deepEqual([...s.targets.values()].map(t => [t.id, t.kind, [...t.actions]]), [
    ['control-room', 'self', [RESTART]],
    ['friday', 'job', ['rerun-job']]
  ]);
  assert.deepEqual(s.problems, [
    'heal.targets.control-room: "rerun-job" is not a catalog action for the Control Room itself',
    'heal.targets.again: only one target may be the Control Room itself',
    'heal.targets.friday: "nope" is not a catalog action for a job'
  ]);
});

test('a self target is invisible to loops 1 and 2: no reading, no card', async () => {
  const settings = settingsOf();
  const reads = [];
  const missed = createMissedRunLoops({
    settings, ledger: { lines: () => [], append: async () => {} }, status: () => ({ status: 'on' }),
    launchctlPrint: async l => { reads.push(l); return '\truns = 1\n\tlast exit code = 0'; }, runProgram: async () => {}, uid: UID,
    missedRuns: async () => ({ jobs: [{ label: LABEL, loaded: true, last_run: null, result: { unresolved: true, missed: [{ at: '2026-11-15T09:00', why: 'restart' }] } }], needs_look: [LABEL] }),
    addAck: async () => [], now: () => NOW, log: () => {}, autoScan: false
  });
  assert.equal(await missed.scan(), 0, 'a missed run of the server itself offers nothing');
  await missed.pass([]);
  assert.deepEqual([reads, missed.view().proposals], [[], []]);
});

test('runSelfRestart: launchctl in its own group, the catalog arguments, the short environment; only the own job', async () => {
  const entry = loadCatalog(CATALOG).get(RESTART);
  const spawned = [];
  const fakeSpawn = (code, { exit = true } = {}) => (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = sig => spawned.push(['child.kill', sig]);
    spawned.push({ file, args, opts });
    if (exit) setImmediate(() => child.emit('exit', code, null));
    return child;
  };
  const env = { XPC_SERVICE_NAME: LABEL, HOME: '/home/example', PATH: '/usr/bin', NODE_OPTIONS: '--x', SOME_TOKEN: 'abc' };
  await runSelfRestart(entry, { uid: UID, label: LABEL }, { spawn: fakeSpawn(0), env });
  assert.deepEqual([spawned[0].file, spawned[0].args], [LAUNCHCTL, ['kickstart', '-k', `gui/${UID}/${LABEL}`]]);
  assert.equal(spawned[0].opts.detached, true, 'its own process group, so the kill of this job leaves it running');
  assert.equal(spawned[0].opts.stdio, 'ignore');
  assert.deepEqual(Object.keys(spawned[0].opts.env).sort(), ['HOME', 'PATH', 'xcrun_nocache']);
  await assert.rejects(runSelfRestart(entry, { uid: UID, label: LABEL }, { spawn: fakeSpawn(5), env }), err => err.code === 'exit-5');
  spawned.length = 0;
  // Not the job launchd started this process as: refused before anything runs.
  for (const e2 of [{ ...env, XPC_SERVICE_NAME: 'com.example.other' }, { HOME: '/h' }, { ...env, XPC_SERVICE_NAME: `${LABEL} ` }]) {
    await assert.rejects(runSelfRestart(entry, { uid: UID, label: LABEL }, { spawn: fakeSpawn(0), env: e2 }), err => err.code === 'not-self');
  }
  await assert.rejects(runSelfRestart(entry, { uid: UID + 1, label: LABEL }, { spawn: fakeSpawn(0), env }), /not this process's own/);
  await assert.rejects(runSelfRestart(loadCatalog(CATALOG).get('mark-quiet'), { uid: UID, label: LABEL }, { spawn: fakeSpawn(0), env }), /runs no program/);
  assert.equal(spawned.length, 0);
  // A launchctl that never answers is ended (its group) and reported, never waited on for good.
  const kills = [];
  await assert.rejects(runSelfRestart(entry, { uid: UID, label: LABEL }, { spawn: fakeSpawn(0, { exit: false }), env, timeout: 30, kill: (pid, sig) => kills.push([pid, sig]) }), err => err.code === 'timeout');
  assert.deepEqual(kills, [[-4242, 'SIGKILL']]);
  assert.ok(RESTART_TIMEOUT_MS >= 5e3);
});

test("createCheckoutReader: git-read's rev-list and diff on server/ only, full hashes in, counts out", async () => {
  const asked = [];
  const answers = [];
  const run = async (gitRead, repo, { args }) => { asked.push([gitRead, repo, args]); return answers.shift(); };
  const c = createCheckoutReader({ gitRead: '/opt/example/git-read', repo: '/home/example/repo', run });
  answers.push(`${H2}\n`);
  assert.equal(await c.head(), H2);
  assert.deepEqual(asked[0], ['/opt/example/git-read', '/home/example/repo', ['rev-list', '--max-count=1', 'HEAD']]);
  answers.push('server/a.mjs\nserver/lib/b.mjs\n\n', '2\n');
  assert.deepEqual(await c.changed(START, H2), { files: 2, merges: 2 });
  assert.deepEqual(asked[1][2], ['diff', '--name-only', START, H2, '--', 'server']);
  assert.deepEqual(asked[2][2], ['rev-list', '--first-parent', '--count', `${START}..${H2}`, '--', 'server']);
  assert.deepEqual(SERVER_PATHS, ['server']);
  answers.push('', '0\n');
  assert.deepEqual(await c.changed(START, H3), { files: 0, merges: 0 });
  const before = asked.length;
  for (const [from, to] of [['abc', H2], [START, 'HEAD'], [START, `${H2}\n`], [`--output=/tmp/x`, H2], [START, undefined]]) {
    await assert.rejects(c.changed(from, to), err => err.code === 'not-a-commit', String(from));
  }
  assert.equal(asked.length, before, 'nothing but two full hashes reaches git-read');
  for (const out of ['HEAD\n', '', `${H2.slice(0, 39)}\n`, `${H2}${H3}\n`, `[redacted: x]\n`]) {
    answers.push(out);
    await assert.rejects(c.head(), err => err.code === 'not-a-commit', JSON.stringify(out));
  }
  answers.push('', 'many\n');
  await assert.rejects(c.changed(START, H2), err => err.code === 'not-a-count');
});

test('the checkout reader on a scratch repo: merges of web/ or docs/ only change nothing under server/', { skip: !existsSync('/usr/bin/git') }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-restart-git-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.test', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.test', xcrun_nocache: '1' };
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { env, encoding: 'utf8' });
  const commitOn = async (branch, path, text) => {
    git('checkout', '-q', '-b', branch, 'main');
    await mkdir(join(dir, dirname(path)), { recursive: true });
    await writeFile(join(dir, path), text);
    git('add', path);
    git('commit', '-q', '-m', `${branch}: ${path}`);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch);
    return git('rev-parse', 'HEAD').trim();
  };
  git('init', '-q', '-b', 'main');
  for (const f of ['server/server.mjs', 'web/index.html', 'docs/a.md']) {
    await mkdir(join(dir, dirname(f)), { recursive: true });
    await writeFile(join(dir, f), 'one\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  const start = git('rev-parse', 'HEAD').trim();
  // The reader as the server builds it, with a runner that is plain git in place of git-read.
  const reader = createCheckoutReader({ gitRead: 'git-read', repo: dir, run: async (_, repo, { args }) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { env, encoding: 'utf8' }) });
  assert.equal(await reader.head(), start);
  const web = await commitOn('jos/web', 'web/index.html', 'two\n');
  const docs = await commitOn('jos/docs', 'docs/a.md', 'two\n');
  assert.deepEqual(await reader.changed(start, docs), { files: 0, merges: 0 }, 'web/ and docs/ merges: no restart due');
  const s1 = await commitOn('jos/s1', 'server/lib/x.mjs', 'x\n');
  assert.deepEqual(await reader.changed(start, s1), { files: 1, merges: 1 });
  assert.deepEqual(await reader.changed(web, s1), { files: 1, merges: 1 });
  const s2 = await commitOn('jos/s2', 'server/server.mjs', 'two\n');
  assert.equal(await reader.head(), s2);
  assert.deepEqual(await reader.changed(start, s2), { files: 2, merges: 2 }, 'two merges touch server/: "2 merges"');
  // A merge that takes a server/ change back leaves nothing to restart for.
  const back = await commitOn('jos/back', 'server/server.mjs', 'one\n');
  git('rm', '-q', 'server/lib/x.mjs');
  git('commit', '-q', '-m', 'drop x');
  const undone = git('rev-parse', 'HEAD').trim();
  assert.notEqual(back, undone);
  assert.equal((await reader.changed(start, undone)).files, 0);

  // Fit to restart onto (M1): main, clean, and descended from the running commit.
  assert.deepEqual(await reader.checkout(s2), { head: undone, why: null });
  assert.deepEqual(await reader.checkout(undone), { head: undone, why: null }, 'HEAD is the running commit');
  await writeFile(join(dir, 'server/server.mjs'), 'edited\n');
  assert.equal((await reader.checkout(start)).why, 'dirty-tree', 'a tracked change not committed');
  git('add', 'server/server.mjs');
  assert.equal((await reader.checkout(start)).why, 'dirty-tree', 'a staged change');
  git('checkout', '-q', '--', '.');
  git('reset', '-q', 'HEAD', '--', '.');
  git('checkout', '-q', '--', '.');
  await writeFile(join(dir, 'new-untracked.txt'), 'x\n');
  assert.equal((await reader.checkout(start)).why, null, 'untracked files never count');
  git('checkout', '-q', '-b', 'jos/feature');
  assert.equal((await reader.checkout(start)).why, 'not-main', 'a feature branch');
  git('checkout', '-q', '--detach');
  assert.equal((await reader.checkout(start)).why, 'not-main', 'a detached HEAD (as in a rebase)');
  git('checkout', '-q', 'main');
  // A conflicted merge: the same line changed on both sides.
  git('checkout', '-q', '-b', 'jos/left');
  await writeFile(join(dir, 'server/server.mjs'), 'left\n');
  git('commit', '-q', '-am', 'left');
  git('checkout', '-q', 'main');
  await writeFile(join(dir, 'server/server.mjs'), 'right\n');
  git('commit', '-q', '-am', 'right');
  const right = git('rev-parse', 'HEAD').trim();
  try { git('merge', '-q', 'jos/left'); } catch { /* the conflict is the point */ }
  assert.deepEqual(await reader.checkout(start), { head: right, why: 'dirty-tree' }, 'unmerged entries');
  git('merge', '--abort');
  assert.equal((await reader.checkout(start)).why, null);
  // A reset to an older commit: the running commit is no longer an ancestor.
  git('reset', '-q', '--hard', web);
  assert.deepEqual(await reader.checkout(right), { head: web, why: 'not-ancestor' });
});

test('parseCheckoutStatus and checkout(): the fields, the order of the reasons, and full hashes only', async () => {
  const st = lines => [`# branch.oid ${H2}`, '# branch.head main', ...lines].join('\n');
  assert.deepEqual(parseCheckoutStatus(st([])), { head: H2, branch: 'main', entries: 0, partial: false });
  assert.deepEqual(parseCheckoutStatus(st(['1 .M N... 100644 100644 100644 a b server/x.mjs', '2 R. N... 1 2 3 a b R100 y\tz', 'u UU N... 1 2 3 4 a b c w', '? untracked', '! ignored'])).entries, 3);
  assert.equal(parseCheckoutStatus(st(['[git-read: output cut at 200000 characters]'])).partial, true);
  assert.equal(parseCheckoutStatus('# branch.oid (initial)\n# branch.head (detached)').branch, '(detached)');
  const asked = [];
  const answers = [];
  const c = createCheckoutReader({ gitRead: 'g', repo: '/r', run: async (_, __, { args }) => { asked.push(args); return answers.shift(); } });
  answers.push(st([]), '0\n');
  assert.deepEqual(await c.checkout(START), { head: H2, why: null });
  assert.deepEqual(asked, [['status', '--porcelain=v2', '--branch', '--untracked-files=no'], ['rev-list', '--count', `${H2}..${START}`]]);
  answers.push(st([]), '2\n');
  assert.equal((await c.checkout(START)).why, 'not-ancestor');
  answers.push(st([]));
  assert.deepEqual(await c.checkout(H2), { head: H2, why: null }, 'on the running commit: no ancestry read');
  answers.push(st(['1 M. N... x']));
  assert.equal((await c.checkout(START)).why, 'dirty-tree');
  answers.push(st(['[git-read: output cut]']));
  assert.equal((await c.checkout(START)).why, 'dirty-tree', 'cut output is not clean');
  answers.push([`# branch.oid ${H2}`, '# branch.head jos/x', '1 M. N... x'].join('\n'));
  assert.equal((await c.checkout(START)).why, 'not-main', 'the branch first');
  answers.push([`# branch.oid ${H2}`, '# branch.head mainline'].join('\n'));
  assert.equal((await c.checkout(START)).why, 'not-main');
  answers.push(['# branch.oid (initial)', '# branch.head main'].join('\n'));
  await assert.rejects(c.checkout(START), err => err.code === 'not-a-commit');
  answers.push(st([]), 'x\n');
  await assert.rejects(c.checkout(START), err => err.code === 'not-a-count');
  const n = asked.length;
  await assert.rejects(c.checkout('HEAD'), err => err.code === 'not-a-commit');
  assert.equal(asked.length, n);
  assert.equal(MAIN_BRANCH, 'main');
});

// ---- detect ----

test('a merge that touches only web/ or docs/ opens no card; one that touches server/ opens one, pushed once', async t => {
  const env = await setup({ changes: { [H2]: { files: 0, merges: 0 } } });
  t.after(env.done);
  assert.ok(env.logs.some(l => l === `heal: ${RESTART} watches the checkout from ${START.slice(0, 7)}`), env.logs.join('\n'));
  await env.loop.pass();
  assert.equal(env.card(), null, 'HEAD on the start commit');
  env.head = H2;
  await env.loop.pass();
  assert.equal(env.card(), null, 'web/docs only');
  assert.deepEqual(env.pushes, []);
  env.head = H3;
  env.changes[H3] = { files: 3, merges: 2 };
  await env.loop.pass();
  const c = env.card();
  assert.deepEqual([c.name, c.class, c.tier, c.merges, c.from, c.to, c.actions, c.state, c.canAct, c.expiresAt], ['Control Room', CLASS, 'T2', 2, START.slice(0, 7), H3.slice(0, 7), [RESTART], 'waiting', true, null]);
  assert.deepEqual(env.pushes, [[restartPush(2), 'default']]);
  assert.equal(restartPush(1), 'A Control Room restart waits for your tap (1 merge since it started): Needs you on the Control Room.');
  // Another merge: the same card, its count and commit brought up to date, no second push.
  env.head = H4;
  env.changes[H4] = { files: 4, merges: 3 };
  env.clock.t += CHECK_EVERY_MS;
  await env.loop.pass();
  assert.deepEqual([env.card().id, env.card().merges, env.card().to], [c.id, 3, H4.slice(0, 7)]);
  assert.equal(env.pushes.length, 1);
  // Pushed once per card, past the hourly cap too.
  env.clock.t += 2 * HOUR;
  await env.loop.pass();
  assert.equal(env.pushes.length, 1, 'one push a card');
  assert.deepEqual(env.loop.view().open.map(o => [o.class, o.step, o.waiting]), [[CLASS, 'acting', true]]);
  // HEAD back on the running commit: the card closes as cleared.
  env.head = START;
  await env.loop.pass();
  assert.equal(env.card(), null);
  assert.deepEqual(env.outcomes(), [['cleared', 'back-on-start']]);
  assert.equal(CHECK_EVERY_MS, 5 * MIN);
  // A server/ change taken back by a later merge: the open card closes as cleared too.
  env.head = H3;
  await env.loop.pass();
  assert.ok(env.card());
  env.head = H2;
  await env.loop.pass();
  assert.equal(env.card(), null);
  assert.deepEqual(env.outcomes().at(-1), ['cleared', 'no-server-change']);
  assert.equal(env.lines().at(-1).expected, H2);
});

test('a card made at night waits for the morning to push', async t => {
  const night = new Date(2026, 10, 15, 23, 30).getTime();
  const env = await setup({ at: night, head: START });
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  assert.ok(env.card());
  assert.deepEqual(env.pushes, []);
  env.clock.t = new Date(2026, 10, 16, 6, 55).getTime();
  await env.loop.pass();
  assert.deepEqual(env.pushes, []);
  env.clock.t = new Date(2026, 10, 16, 7, 0).getTime();
  await env.loop.pass();
  assert.deepEqual(env.pushes.length, 1);
});

test("no card unless this process is the target's launchd job, git-read is set up and HEAD was read at start", async t => {
  for (const [self, why] of [[{ label: 'com.example.other', launchd: true }, 'another label'], [{ label: LABEL, launchd: false }, 'not under launchd'], [{ label: null, launchd: true }, 'no service name']]) {
    const env = await setup({ self });
    t.after(env.done);
    assert.ok(env.logs.some(l => /is not running as the launchd job heal\.targets\.control-room names/.test(l)), why);
    env.head = H2;
    await env.loop.pass();
    assert.equal(env.card(), null, why);
    assert.deepEqual(env.gitCalls, ['head'], `${why}: only the start read`);
  }
  const noGit = await setup({ git: false });
  t.after(noGit.done);
  assert.ok(noGit.logs.some(l => /needs toPush\.gitRead/.test(l)));
  await noGit.loop.pass();
  assert.equal(noGit.card(), null);
  const unread = await setup({ start: false });
  t.after(unread.done);
  unread.headFails = true;
  await unread.loop.start();
  assert.ok(unread.logs.some(l => /could not be read at start \(exit-3\); no restart cards/.test(l)));
  unread.headFails = false;
  unread.head = H2;
  await unread.loop.pass();
  assert.equal(unread.card(), null, 'a HEAD read later is not the commit this process runs');
  const off = await setup({ settings: settingsOf({ off: [RESTART] }) });
  t.after(off.done);
  off.head = H2;
  await off.loop.pass();
  assert.equal(off.card(), null, 'heal.off');
});

test('an unreadable HEAD or diff makes no card and is logged once', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  env.headFails = true;
  await env.loop.pass();
  await env.loop.pass();
  assert.equal(env.card(), null);
  assert.equal(env.logs.filter(l => /the checkout could not be read/.test(l)).length, 1);
  env.headFails = false;
  env.changedFails = true;
  await env.loop.pass();
  assert.equal(env.card(), null);
  assert.ok(env.logs.some(l => /what changed in the checkout could not be read/.test(l)));
});

test('the kill switch: nothing is read, the card stays with its buttons off, and a tap is refused', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  env.killed = true;
  const calls = env.gitCalls.length;
  env.head = H3;
  await env.loop.pass();
  assert.equal(env.gitCalls.length, calls, 'no read while killed');
  const c = env.card();
  assert.deepEqual([c.canAct, c.to], [false, H2.slice(0, 7)]);
  assert.match(c.blocked, /kill switch/);
  const r = await env.loop.approve(c.id, RESTART, 'iPhone');
  assert.equal(r.status, 503);
  assert.equal(env.gitCalls.length, calls, 'a refused tap reads nothing');
  assert.deepEqual(env.programs, []);
});

test('the kill switch during the tap\'s read: refused, the card given back, and Not now waits for the tap', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  const id = env.card().id;
  let open;
  env.headGates.push(new Promise(r => { open = r; }));
  const tap = env.loop.approve(id, RESTART, 'iPhone');
  assert.equal((await env.loop.decline(id, 'iPad')).status, 409, 'a card being answered can not be declined');
  env.killed = true;
  open();
  const r = await tap;
  assert.equal(r.status, 503);
  assert.equal(env.card().state, 'waiting');
  assert.deepEqual([env.lines(), env.timers], [[], []]);
});

// ---- act ----

test('a tap: the verifying line with the expected commit first, then the answer, then -k a few seconds later', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  env.changes[H2] = { files: 2, merges: 2 };
  await env.loop.pass();
  const id = env.card().id;
  const r = await env.loop.approve(id, RESTART, 'iPhone');
  assert.deepEqual(r, { status: 202, ok: true, name: 'Control Room', action: RESTART, card: CLASS, from: START.slice(0, 7), to: H2.slice(0, 7), checkBy: NOW + VERIFY_MS });
  const [line] = env.lines();
  assert.deepEqual([line.outcome, line.tier, line.expected, line.from, line.by, line.merges, line.target], ['verifying', 'T2', H2, START, 'iPhone', 2, 'control-room']);
  assert.match(line.ref, /^[0-9a-f]{16}$/);
  assert.deepEqual(env.programs, [], 'the answer goes out before the restart');
  assert.deepEqual(env.timers.filter(x => !x.done).map(x => x.ms), [KICK_DELAY_MS]);
  assert.ok(KICK_DELAY_MS >= 1e3);
  assert.deepEqual([env.card().state, env.card().canAct], ['restarting', false]);
  assert.deepEqual(env.loop.view().open.map(o => [o.step, o.restarting]), [['acting', true]]);
  env.clock.t += KICK_DELAY_MS;
  await env.runDue();
  assert.deepEqual(env.programs.map(p => [p.file, p.args, p.outcomesThen]), [[LAUNCHCTL, ['kickstart', '-k', `gui/${UID}/${LABEL}`], ['verifying']]]);
  // A second tap, from any device, finds the card taken; a pass makes no new one.
  assert.equal((await env.loop.approve(id, RESTART, 'iPad')).status, 409);
  await env.loop.pass();
  assert.equal(env.loop.view().proposals.length, 1);
  assert.equal(env.programs.length, 1);
  const reads = env.gitCalls.length;
  await env.loop.pass();
  assert.equal(env.gitCalls.length, reads, 'nothing is read while a restart is going');
});

test('two passes at once make one card and one push', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  let a, b;
  env.headGates.push(new Promise(r => { a = r; }), new Promise(r => { b = r; }));
  const one = env.loop.pass();
  const two = env.loop.pass();
  a(); b();
  await Promise.all([one, two]);
  assert.deepEqual(env.gitCalls.filter(c => c === 'head' || c === 'checkout'), ['head', 'checkout'], 'the start read and one pass');
  assert.equal(env.pushes.length, 1);
});

test('two taps at once, or a pass during the tap, restart once (the card is taken before anything waits)', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  const id = env.card().id;
  const gate = () => { let open; env.headGates.push(new Promise(r => { open = r; })); return () => open(); };
  const openTap = gate(), openPass = gate();
  const first = env.loop.approve(id, RESTART, 'iPhone');
  const second = env.loop.approve(id, RESTART, 'iPad');
  const pass = env.loop.pass();
  openPass();
  await pass;
  openTap();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.status, b.status], [202, 409]);
  assert.equal(env.lines().filter(l => l.outcome === 'verifying').length, 1);
  // A pass that reads while a tap holds the card leaves it alone, even when HEAD is back.
  const env2 = await setup();
  t.after(env2.done);
  env2.head = H2;
  await env2.loop.pass();
  const id2 = env2.card().id;
  let openTap2, openPass2;
  env2.headGates.push(new Promise(r => { openTap2 = r; }), new Promise(r => { openPass2 = r; }));
  env2.head = START;
  const tap = env2.loop.approve(id2, RESTART, 'iPhone');
  const p2 = env2.loop.pass();
  openPass2();
  await p2;
  assert.deepEqual(env2.outcomes(), [], 'the pass closed nothing while the tap held the card');
  openTap2();
  const r2 = await tap;
  assert.equal(r2.status, 409, 'the tap read HEAD back on the start commit');
  assert.deepEqual(env2.outcomes(), [['cleared', 'back-on-start']], 'one close, by the tap');
});

test("the tap checks again: HEAD back, nothing under server/, git unreadable, ledger unwritable, off, not offered", async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  env.head = START;
  assert.equal((await env.loop.approve(env.card().id, RESTART, 'iPhone')).status, 409);
  assert.equal(env.card(), null);
  env.head = H3;
  await env.loop.pass();
  env.changes[H3] = { files: 0, merges: 1 };
  const nothing = await env.loop.approve(env.card().id, RESTART, 'iPhone');
  assert.deepEqual([nothing.status, env.card()], [409, null]);
  assert.deepEqual(env.outcomes(), [['cleared', 'back-on-start'], ['cleared', 'no-server-change']]);
  env.head = H4;
  await env.loop.pass();
  const id = env.card().id;
  env.headFails = true;
  assert.equal((await env.loop.approve(id, RESTART, 'iPhone')).status, 503);
  assert.equal(env.card().state, 'waiting', 'a read that failed gives the card back');
  env.headFails = false;
  assert.equal((await env.loop.approve(id, 'rerun-job', 'iPhone')).status, 400);
  assert.equal((await env.loop.approve('f'.repeat(32), RESTART, 'iPhone')).status, 404);
  assert.equal((await env.loop.approve('__proto__', RESTART, 'iPhone')).status, 404);
  // The ledger can't be written: nothing restarts, and the card is given back.
  const real = env.ledger.append;
  env.ledger.append = async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); };
  assert.equal((await env.loop.approve(id, RESTART, 'iPhone')).status, 503);
  env.ledger.append = real;
  assert.equal(env.card().state, 'waiting');
  assert.deepEqual(env.timers.filter(x => !x.done), [], 'no restart is scheduled');
  assert.deepEqual(env.programs, []);
});

test('the kill switch between the tap and the restart: no restart, no page, and the card may come back', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  assert.equal((await env.loop.approve(env.card().id, RESTART, 'iPhone')).status, 202);
  env.killed = true;
  env.clock.t += KICK_DELAY_MS;
  await env.runDue();
  assert.deepEqual(env.programs, []);
  assert.deepEqual(env.outcomes(), [['verifying', 'tapped'], ['cleared', 'heals-off']]);
  assert.equal(env.pushes.length, 1, 'only the card push');
  env.killed = false;
  await env.loop.pass();
  assert.ok(env.card(), 'no attempt was made on that HEAD');
});

test('launchctl fails, or answers while this process stays: T3 with a page, and that HEAD is never offered again', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  env.programFails = Object.assign(new Error('exited 5'), { code: 'exit-5' });
  await tapThrough(env);
  assert.deepEqual(env.outcomes(), [['verifying', 'tapped'], ['escalated', 'restart-failed']]);
  assert.equal(env.lines()[1].tier, 'T3');
  assert.deepEqual(env.pushes.at(-1), [RESTART_PAGE, 'high']);
  assert.equal(env.lines()[1].ref, env.lines()[0].ref);
  await env.loop.pass();
  assert.equal(env.card(), null, 'one attempt per instance');
  env.head = H3;
  env.programFails = null;
  await env.loop.pass();
  assert.ok(env.card(), 'a new HEAD is a new instance');
  await tapThrough(env);
  assert.equal(env.programs.length, 2);
  assert.deepEqual(env.outcomes().at(-1), ['verifying', 'tapped']);
  env.clock.t += NO_RESTART_MS - 1;
  await env.runDue();
  assert.deepEqual(env.outcomes().at(-1), ['verifying', 'tapped'], 'still waiting to be killed');
  env.clock.t += 1;
  await env.runDue();
  assert.deepEqual(env.outcomes().at(-1), ['escalated', 'no-restart']);
  assert.deepEqual(env.pushes.at(-1), [RESTART_PAGE, 'high']);
  // A program refused for not-self reads as such.
  const ns = await setup();
  t.after(ns.done);
  ns.head = H2;
  await ns.loop.pass();
  ns.programFails = Object.assign(new Error('x'), { code: 'not-self' });
  await tapThrough(ns);
  assert.deepEqual(ns.outcomes().at(-1), ['escalated', 'not-self']);
});

test('Not now parks the card until HEAD moves', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  const id = env.card().id;
  assert.equal((await env.loop.decline('f'.repeat(32), 'iPhone')).status, 404, 'another id');
  assert.ok(env.card());
  assert.deepEqual(await env.loop.decline(id, 'iPhone'), { status: 200, ok: true, name: 'Control Room', action: 'not-now', card: CLASS });
  assert.equal((await env.loop.decline(id, 'iPhone')).status, 404);
  assert.deepEqual(env.outcomes(), [['declined', 'not-now']]);
  assert.equal(env.lines()[0].by, 'iPhone');
  await env.loop.pass();
  assert.equal(env.card(), null);
  env.head = H3;
  await env.loop.pass();
  assert.ok(env.card());
  assert.ok(env.loop.has(env.card().id));
  assert.ok(!env.loop.has(id));
});

test(`at most ${RESTARTS_PER_DAY} restarts in 24 hours, and the day's ${PER_DAY} T2 actions across the loops`, async t => {
  const env = await setup();
  t.after(env.done);
  for (let i = 0; i < RESTARTS_PER_DAY; i++) await env.ledger.append({ at: NOW - HOUR * (i + 1), class: CLASS, action: RESTART, tier: 'T2', target: 'control-room', since: 1, outcome: 'verifying', why: 'tapped', ref: `${i}`.repeat(16) });
  env.head = H2;
  await env.loop.pass();
  const r = await env.loop.approve(env.card().id, RESTART, 'iPhone');
  assert.deepEqual([r.status, r.error], [429, `not now: ${WHY_WORDS['cap-restarts']}`]);
  assert.equal(env.card().state, 'waiting');
  env.clock.t = NOW + DAY - HOUR * RESTARTS_PER_DAY + 1;
  assert.equal((await env.loop.approve(env.card().id, RESTART, 'iPhone')).status, 202, 'the oldest left the 24 hours');
  const day = await setup();
  t.after(day.done);
  for (let i = 0; i < PER_DAY; i++) await day.ledger.append({ at: NOW - MIN * (i + 1), class: 'missed-run', action: 'rerun-job', tier: 'T2', target: `j${i}`, since: 1, outcome: i % 2 ? 'tapped' : 'acked', why: 'x' });
  day.head = H2;
  await day.loop.pass();
  assert.equal((await day.loop.approve(day.card().id, RESTART, 'iPhone')).status, 429);
});

// ---- verify, in the new process ----

// The first process taps; the second starts on the same ledger, its HEAD read at start.
async function restartedOnto(t, head, { firstPass, lag = 5e3, killed = false, settings, catalogEntries, failing = [] } = {}) {
  const one = await setup({ dir: await mkdtemp(join(tmpdir(), 'heal-restart-chain-')) });
  t.after(() => rm(one.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  one.head = H2;
  one.failing = failing;
  await one.loop.pass();
  await tapThrough(one);
  const two = await setup({ dir: one.dir, at: one.clock.t + lag, head, start: false, firstPass, settings, ...(catalogEntries ? { catalogEntries } : {}) });
  two.killed = killed;
  return { one, two };
}

test('the new process closes the loop as healed: back on the expected commit, first pass clean', async t => {
  let pass;
  const { one, two } = await restartedOnto(t, H2, { firstPass: new Promise(r => { pass = r; }) });
  const started = two.loop.start();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(two.outcomes(), [['verifying', 'tapped']], 'waits for the first pass');
  assert.deepEqual(two.loop.view().open.map(o => [o.step, o.restarted, o.checkBy]), [['verifying', true, one.lines()[0].at + VERIFY_MS]]);
  two.head = H3;
  await two.loop.pass();
  assert.equal(two.card(), null, 'no restart is offered while one is being checked');
  pass({ failed: [] });
  await started;
  const last = two.lines().at(-1);
  assert.deepEqual([last.outcome, last.why, last.tier, last.from, last.expected, last.got, last.ref], ['healed', 'restarted', 'T2', START, H2, H2, one.lines()[0].ref]);
  assert.deepEqual(two.pushes, [], 'a heal that works pushes nothing');
  assert.deepEqual(two.loop.view().open, [], 'the check is over');
  assert.ok(two.logs.some(l => l === `heal: ${RESTART}: back on ${H2.slice(0, 7)}; waiting for the first pass`));
  // The Loops panel: the old and new short hashes, in words.
  const view = withLoopParts(two.heal.view(), [{ open: [{ name: 'Friday alert' }], proposals: [{ id: 'x' }] }, two.loop.view()]);
  assert.deepEqual([view.open.map(o => o.name), view.proposals.map(p => p.id)], [['Friday alert'], ['x']], 'every part, in order');
  const both = withLoopParts({ open: [] }, [{ open: [{ name: 'a' }], proposals: [{ id: '1' }] }, { open: [{ name: 'b' }], proposals: [{ id: '2' }] }, null]);
  assert.deepEqual([both.open.map(o => o.name), both.proposals.map(p => p.id)], [['a', 'b'], ['1', '2']]);
  assert.deepEqual(view.weeks, [], 'a restart is not counted as a failure that keeps happening');
  const rec = view.recent.find(r => r.class === CLASS);
  assert.deepEqual([rec.name, rec.words, rec.from, rec.to, rec.classLabel], ['Control Room', 'restarted on the new commit', START.slice(0, 7), H2.slice(0, 7), 'restart due']);
  assert.ok(!JSON.stringify(view).includes(LABEL) && !JSON.stringify(view).includes(H2), 'no label or full hash on the page');
  // Restarting again finds the line closed: nothing to check, nothing paged.
  const three = await setup({ dir: one.dir, at: two.clock.t + MIN, head: H2 });
  t.after(three.done);
  assert.deepEqual(three.outcomes().length, two.outcomes().length);
  // And now the next merge is offered as usual.
  three.head = H3;
  await three.loop.pass();
  assert.ok(three.card());
});

test('the new process pages: another commit, an unclean or slow first pass, too late, HEAD unreadable', async t => {
  const wrong = (await restartedOnto(t, H3)).two;
  await wrong.loop.start();
  assert.deepEqual(wrong.outcomes().at(-1), ['escalated', 'wrong-commit']);
  assert.deepEqual([wrong.lines().at(-1).got, wrong.lines().at(-1).tier], [H3, 'T3']);
  const shown = wrong.heal.view().recent.find(r => r.class === CLASS);
  assert.deepEqual([shown.from, shown.to], [START.slice(0, 7), H3.slice(0, 7)], 'the commit it came back on, not the one expected');
  assert.deepEqual(wrong.pushes, [[RESTART_PAGE, 'high']]);

  const dirty = (await restartedOnto(t, H2, { firstPass: Promise.resolve({ failed: ['usage', 'bad name!', 'crons'] }) })).two;
  await dirty.loop.start();
  assert.deepEqual(dirty.outcomes().at(-1), ['escalated', 'first-pass']);
  assert.deepEqual(dirty.lines().at(-1).failed, ['usage', 'crons']);
  assert.equal(dirty.pushes.length, 1);

  const slow = (await restartedOnto(t, H2, { firstPass: new Promise(() => {}) })).two;
  const going = slow.loop.start();
  await new Promise(r => setImmediate(r));
  const wait = slow.timers.find(x => !x.done);
  assert.equal(wait.at, slow.lines()[0].at + VERIFY_MS, 'the wait ends 10 minutes after the tap');
  slow.clock.t = wait.at;
  await slow.runDue();
  await going;
  assert.deepEqual(slow.outcomes().at(-1), ['escalated', 'slow-start']);

  const late = (await restartedOnto(t, H2, { lag: VERIFY_MS + 1 })).two;
  await late.loop.start();
  assert.deepEqual(late.outcomes().at(-1), ['escalated', 'not-checked']);

  const broke = (await restartedOnto(t, H2, { firstPass: { then: (_, reject) => reject(new Error('x')) } })).two;
  await broke.loop.start();
  assert.deepEqual([broke.outcomes().at(-1), broke.lines().at(-1).failed], [['escalated', 'first-pass'], ['unknown']]);

  const blind = (await restartedOnto(t, H2)).two;
  blind.headFails = true;
  await blind.loop.start();
  assert.deepEqual(blind.outcomes().at(-1), ['escalated', 'git-unreadable']);
  assert.equal(blind.pushes.length, 1);
  // The page is sent after the line, so a process that dies between them never pages twice.
  const order = (await restartedOnto(t, H3)).two;
  const seen = [];
  const realAppend = order.ledger.append;
  order.ledger.append = async line => { seen.push(`line ${line.outcome}`); return realAppend(line); };
  const realNotify = order.pushes.push.bind(order.pushes);
  order.pushes.push = (...x) => { seen.push('page'); return realNotify(...x); };
  await order.loop.start();
  assert.deepEqual(seen, ['line escalated', 'page']);
});

test("the restart is checked while the kill switch is on, and not while heals aren't set up", async t => {
  const killed = (await restartedOnto(t, H2, { killed: true })).two;
  await killed.loop.start();
  assert.deepEqual(killed.outcomes().at(-1), ['healed', 'restarted']);
  // Heals that can't run can't check it: one page, and the line is closed (L4).
  const unset = (await restartedOnto(t, H2, { settings: readHealConfig({}) })).two;
  await unset.loop.start();
  assert.deepEqual(unset.outcomes().at(-1), ['escalated', 'heals-off-unchecked']);
  assert.ok(unset.logs.some(l => /a restart can't be checked: heals are unset/.test(l)));
  assert.deepEqual(unset.pushes, [[RESTART_PAGE, 'high']]);
  const again = await setup({ dir: unset.dir, at: unset.clock.t + MIN, head: H2, settings: readHealConfig({}) });
  assert.deepEqual(again.pushes, [], 'once: the next start finds it closed');
  // A refused catalog is the same: the loop can't check it, so it says so once.
  const refusedCat = (await restartedOnto(t, H2, { catalogEntries: CATALOG.filter(e => e.id !== RESTART) })).two;
  await refusedCat.loop.start();
  assert.deepEqual(refusedCat.outcomes().at(-1), ['escalated', 'heals-off-unchecked']);
  assert.equal(refusedCat.pushes.length, 1);
});

test('an older open verifying line is closed as never checked, and the newest is checked', async t => {
  const env = await setup({ start: false, head: H2 });
  t.after(env.done);
  const line = (at, ref, expected) => ({ at, class: CLASS, action: RESTART, tier: 'T2', target: 'control-room', since: 1, outcome: 'verifying', why: 'tapped', ref, from: START, expected });
  await env.ledger.append(line(NOW - DAY / 2, '1'.repeat(16), H3));
  await env.ledger.append(line(NOW - 5e3, '2'.repeat(16), H2));
  await env.loop.start();
  assert.deepEqual(env.outcomes(), [['verifying', 'tapped'], ['verifying', 'tapped'], ['escalated', 'not-checked'], ['healed', 'restarted']]);
  assert.equal(env.lines()[2].ref, '1'.repeat(16));
  assert.equal(env.pushes.length, 1);
});

test('a HEAD that keeps changing costs cards, never restarts: each needs a tap, and the day holds 3', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-restart-loop-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const heads = ['e5', 'f6', '17', '28', '39'].map(h => h.repeat(20));
  let at = NOW, from = START, restarts = 0, refused = 0;
  for (const head of heads) {
    const p = await setup({ dir, at, head: from });
    p.head = head;
    await p.loop.pass();
    assert.ok(p.card(), `a card for ${head.slice(0, 2)}`);
    // Without a tap, nothing restarts however many passes run.
    for (let i = 0; i < 3; i++) { p.clock.t += CHECK_EVERY_MS; await p.loop.pass(); }
    assert.deepEqual(p.programs, []);
    const r = await p.loop.approve(p.card().id, RESTART, 'iPhone');
    if (r.status === 429) { refused++; break; }
    p.clock.t += KICK_DELAY_MS;
    await p.runDue();
    restarts += p.programs.length;
    at = p.clock.t + 5e3;
    const next = await setup({ dir, at, head });
    assert.deepEqual(next.outcomes().at(-1), ['healed', 'restarted']);
    assert.deepEqual(next.programs, [], 'the new process never restarts on its own');
    at = next.clock.t;
    from = head;
  }
  assert.deepEqual([restarts, refused], [RESTARTS_PER_DAY, 1]);
});

// ---- the page's words, and the first pass ----

test("the view and the ledger's words: no label, no path, short hashes only", async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  const text = JSON.stringify(env.loop.view());
  assert.ok(!text.includes(LABEL) && !text.includes(H2) && !text.includes(START), text);
  assert.equal(outcomeWords(RESTART, 'cleared'), 'not restarted');
  assert.equal(outcomeWords(RESTART, 'escalated'), 'restart: it needs a look');
  for (const k of ['restarted', 'wrong-commit', 'first-pass', 'slow-start', 'not-checked', 'git-unreadable', 'no-restart', 'restart-failed', 'not-self', 'heals-off', 'back-on-start', 'no-server-change', 'cap-restarts']) {
    assert.equal(typeof WHY_WORDS[k], 'string', k);
  }
  assert.equal(shortCommit(H2), H2.slice(0, 7));
  for (const bad of ['abc', H2.toUpperCase(), `${H2}0`, null, 42]) assert.equal(shortCommit(bad), null, String(bad));
  const v = buildLoopsView({ status: 'on', lines: [{ at: NOW, class: CLASS, action: RESTART, tier: 'T2', target: 'control-room', outcome: 'healed', why: 'restarted', from: 'x', got: H2 }], settings: settingsOf(), now: NOW });
  assert.equal(v.recent[0].from, undefined, 'a malformed commit shows nothing');
});

test("the registry's first pass: every collector's first run, and which failed", async () => {
  const timers = { setInterval: () => 0, clearInterval: () => {} };
  const r = createRegistry(createCache(), timers);
  let finish;
  r.register('slow', () => new Promise(res => { finish = res; }), 1000);
  r.register('bad', async () => { throw new Error('x'); }, 1000);
  r.register('good', async () => 1, 1000);
  let result = null;
  r.whenFirstPass().then(v => { result = v; });
  r.startAll();
  await new Promise(res => setImmediate(res));
  assert.equal(result, null, 'one still running');
  await r.runOnce('good');
  await new Promise(res => setImmediate(res));
  assert.equal(result, null, 'a second run of another is not the slow one');
  finish(2);
  await new Promise(res => setImmediate(res));
  assert.deepEqual(result, { failed: ['bad'] });
  const empty = createRegistry(createCache(), timers);
  empty.startAll();
  assert.deepEqual(await empty.whenFirstPass(), { failed: [] });
});

// ---- the wiring ----

test('server.mjs: loop 3 shares the ledger and the switch, reads git through git-read, and restarts only its own job', async () => {
  const src = (await readFile(join(HERE, '..', 'server.mjs'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const wired = [
    [/createRestartLoop\(\{\s*settings: healSettings,\s*ledger: healLedger,\s*status: \(\) => heal\.status\(\),/, 'one ledger, one switch'],
    [/git: toPushSettings\.gitRead \? createCheckoutReader\(\{ gitRead: toPushSettings\.gitRead, repo: join\(HERE, '\.\.'\) \}\) : null,/, 'the vetted git-read, on its own checkout'],
    [/runProgram: \(entry, target\) => runSelfRestart\(entry, target\),/, 'the self-restart program'],
    [/self: \{ label: process\.env\.XPC_SERVICE_NAME \?\? null, launchd: process\.ppid === 1, pid: process\.pid \},/, 'what launchd says this process is'],
    [/launchctlPrint: runLaunchctlPrint,\s*runProgram: \(entry, target\) => runSelfRestart/, "launchd's record, read with the health strip's own launchctl print"],
    [/failingNow: \(\) => Object\.entries\(cache\.snapshot\(\)\)\.filter\(\(\[, v\]\) => v\.error\)\.map\(\(\[k\]\) => k\),/, 'the collectors failing now'],
    [/firstPass: \(\) => registry\.whenFirstPass\(\),/, "the registry's first pass"],
    [/await heal\.load\(\);\s*restartLoop\.start\(\)\.catch\(/, 'started after the ledger is read, not awaited'],
    [/setInterval\(\(\) => \{ restartLoop\.pass\(\)\.catch\([^\n]*\}, RESTART_CHECK_MS\)\.unref\(\);/, 'every 5 minutes'],
    [/loops: \{ missed, restart: restartLoop \}/, 'its taps go through the chat']
  ];
  for (const [re, what] of wired) assert.ok(re.test(src), what);
  // vetPrograms runs before the loop is made, so the path it gets is the checked one.
  assert.ok(src.indexOf("['toPush.gitRead', toPushSettings, 'gitRead']") < src.indexOf('createRestartLoop({'));
  const programs = await readFile(join(HERE, '..', 'lib', 'heal-programs.mjs'), 'utf8');
  assert.ok(/spawn\(entry\.program\.file, args, \{ detached: true, stdio: 'ignore', env: programEnv\(env\) \}\)/.test(programs), 'launchctl in its own group, the short environment');
});

// ---- Ultron's 11-15 review: M1 and the lows ----

test('M1: a checkout unfit to run (a branch, changes, a reset) shows the card blocked, unpushed and untappable', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  env.why = 'not-main';
  await env.loop.pass();
  assert.deepEqual(env.checkoutFrom.at(-1), START, 'checked against the running commit');
  let c = env.card();
  assert.deepEqual([c.canAct, c.blocked, c.pushWait, c.announcedAt], [false, WHY_WORDS['not-main'], 'blocked', null]);
  assert.equal(c.canDecline, true, 'Not now stays on while blocked (Jeff, option b)');
  assert.deepEqual(env.pushes, [], 'a card that can not be tapped is not pushed');
  // A tap anyway (an old page): refused with the reason, the card given back, nothing written.
  env.why = 'dirty-tree';
  const r = await env.loop.approve(c.id, RESTART, 'iPhone');
  assert.deepEqual([r.status, r.error], [409, `not restarted: ${WHY_WORDS['dirty-tree']}`]);
  assert.deepEqual([env.card().state, env.card().blocked, env.lines(), env.timers], ['waiting', WHY_WORDS['dirty-tree'], [], []]);
  env.why = 'not-ancestor';
  await env.loop.pass();
  assert.equal(env.card().blocked, WHY_WORDS['not-ancestor']);
  // Fit again: the button comes on, and the card is pushed then.
  env.why = null;
  await env.loop.pass();
  c = env.card();
  assert.deepEqual([c.canAct, c.blocked, c.pushWait], [true, null, null]);
  assert.equal(env.pushes.length, 1);
  assert.deepEqual(env.proposed().map(l => l.expected), [H2]);
});

test('M1 and L1 at the restart: unfit or moved in the 3 s means no restart, and the card comes back', async t => {
  for (const [change, why] of [[e => { e.why = 'dirty-tree'; }, 'dirty-tree'], [e => { e.head = H3; }, 'moved'], [e => { e.headFails = true; }, 'git-unreadable']]) {
    const env = await setup();
    t.after(env.done);
    env.head = H2;
    await env.loop.pass();
    assert.equal((await env.loop.approve(env.card().id, RESTART, 'iPhone')).status, 202);
    change(env);
    env.clock.t += KICK_DELAY_MS;
    await env.runDue();
    assert.deepEqual(env.programs, [], why);
    assert.deepEqual(env.outcomes().at(-1), ['cleared', why]);
    assert.equal(env.lines().at(-1).ref, env.lines()[0].ref);
    assert.deepEqual(env.pushes.length, 1, 'no page: nothing was restarted');
    env.headFails = false;
    env.why = null;
    await env.loop.pass();
    assert.ok(env.card(), `${why}: the card comes back`);
    assert.equal(env.card().to, env.head.slice(0, 7));
  }
});

test('L5: a tap on a card whose HEAD has moved is answered "it moved", with the card brought up to date', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  const id = env.card().id;
  env.head = H3;
  env.changes[H3] = { files: 4, merges: 3 };
  const r = await env.loop.approve(id, RESTART, 'iPhone');
  assert.equal(r.status, 409);
  assert.match(r.error, /^it moved/);
  assert.deepEqual([env.card().state, env.card().to, env.card().merges], ['waiting', H3.slice(0, 7), 3]);
  assert.deepEqual(env.lines(), []);
  assert.equal((await env.loop.approve(id, RESTART, 'iPhone')).status, 202, 'the second look restarts onto what it showed');
  assert.equal(env.lines()[0].expected, H3);
});

test("L9: launchd's record of the job must name this process, else no restart", async t => {
  assert.equal(parseLaunchdPid('x = {\n\tstate = running\n\t\tpid = 1\n\tpid = 4321\n}'), 4321);
  for (const raw of ['\t\tpid = 4321', 'pid = 4321', '\tpid = x', '', null]) assert.equal(parseLaunchdPid(raw), null, String(raw));
  for (const [set, what] of [[e => { e.pid = SELF_PID + 1; }, 'another pid'], [e => { e.printFails = true; }, 'unreadable']]) {
    const env = await setup();
    t.after(env.done);
    env.head = H2;
    await env.loop.pass();
    set(env);
    const r = await env.loop.approve(env.card().id, RESTART, 'iPhone');
    assert.deepEqual([r.status, r.error], [409, `not restarted: ${WHY_WORDS['not-own-pid']}`], what);
    assert.deepEqual([env.card().state, env.lines(), env.timers], ['waiting', [], []]);
    assert.deepEqual(env.prints, [LABEL]);
  }
});

test('L3: collectors already failing at the tap go in the line, and only a new failure pages', async t => {
  const same = (await restartedOnto(t, H2, { failing: ['usage', 'not a name!'], firstPass: Promise.resolve({ failed: ['usage'] }) })).two;
  const tapLine = same.lines()[0];
  assert.deepEqual(tapLine.failing, ['usage']);
  await same.loop.start();
  assert.deepEqual(same.outcomes().at(-1), ['healed', 'restarted']);
  assert.deepEqual(same.lines().at(-1).failed, ['usage'], 'still failing, named');
  assert.deepEqual(same.pushes, []);
  const rec = same.heal.view().recent.find(r => r.class === CLASS);
  assert.deepEqual(rec.failed, ['usage'], 'the Loops panel names them');
  const fresh = (await restartedOnto(t, H2, { failing: ['usage'], firstPass: Promise.resolve({ failed: ['usage', 'crons'] }) })).two;
  await fresh.loop.start();
  assert.deepEqual(fresh.outcomes().at(-1), ['escalated', 'first-pass']);
  assert.deepEqual(fresh.lines().at(-1).failed, ['usage', 'crons']);
  assert.equal(fresh.pushes.length, 1);
});

test('L2: the first pass is judged on its raw list; only the ledger gets the clean names', async t => {
  for (const [failed, names] of [['usage', ['unknown']], [['bad name!'], ['unknown']], [[{ x: 1 }, 'crons'], ['crons']], [undefined, ['unknown']]]) {
    const two = (await restartedOnto(t, H2, { firstPass: Promise.resolve({ failed }) })).two;
    await two.loop.start();
    assert.deepEqual(two.outcomes().at(-1), ['escalated', 'first-pass'], JSON.stringify(failed));
    assert.deepEqual(two.lines().at(-1).failed, names, JSON.stringify(failed));
  }
});

test('M1 in the new process: back on the expected commit but unfit is a page', async t => {
  const two = (await restartedOnto(t, H2)).two;
  two.why = 'dirty-tree';
  await two.loop.start();
  assert.deepEqual(two.outcomes().at(-1), ['escalated', 'dirty-tree']);
  assert.deepEqual(two.checkoutFrom, [H2], 'checked against its own commit');
  assert.equal(two.pushes.length, 1);
  // An unreadable checkout there is a page too.
  const blind = (await restartedOnto(t, H2)).two;
  blind.checkoutFails = true;
  await blind.loop.start();
  assert.deepEqual(blind.outcomes().at(-1), ['escalated', 'git-unreadable']);
  assert.equal(blind.lines().at(-1).got, H2);
});

test('L7: several open lines, however they close, send one page', async t => {
  const env = await setup({ start: false, head: H3 });
  t.after(env.done);
  const line = (at, ref) => ({ at, class: CLASS, action: RESTART, tier: 'T2', target: 'control-room', since: 1, outcome: 'verifying', why: 'tapped', ref, from: START, expected: H2 });
  for (const [i, ago] of [DAY / 2, DAY / 3, 5e3].entries()) await env.ledger.append(line(NOW - ago, String(i).repeat(16)));
  await env.loop.start();
  assert.deepEqual(env.outcomes().slice(3), [['escalated', 'not-checked'], ['escalated', 'not-checked'], ['escalated', 'wrong-commit']]);
  assert.deepEqual(env.pushes, [[RESTART_PAGE, 'high']]);
});

test('L8: a launchctl that times out leaves the tap open; the minute decides', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  env.programFails = Object.assign(new Error('launchctl took too long'), { code: 'timeout' });
  await tapThrough(env);
  assert.deepEqual(env.outcomes(), [['verifying', 'tapped']], 'not closed: it may still be restarting this process');
  assert.ok(env.logs.some(l => /launchctl took too long/.test(l)));
  env.clock.t += NO_RESTART_MS;
  await env.runDue();
  assert.deepEqual(env.outcomes().at(-1), ['escalated', 'no-restart']);
  assert.equal(env.pushes.at(-1)[1], 'high');
  // And nothing in the server catches SIGTERM, so launchd's stop ends it at once.
  const src = [await readFile(join(HERE, '..', 'server.mjs'), 'utf8')];
  for (const dir of ['lib', 'collectors']) {
    const { readdir } = await import('node:fs/promises');
    for (const f of await readdir(join(HERE, '..', dir))) if (f.endsWith('.mjs')) src.push(await readFile(join(HERE, '..', dir, f), 'utf8'));
  }
  assert.ok(!src.some(s => /process\.(on|once|addListener|prependListener)\(\s*['"]SIG(TERM|INT|HUP)/.test(s)), 'no signal handler');
});

test('L6: restart pushes are capped at 1 an hour and 3 a day, across cards and restarts', async t => {
  const env = await setup();
  t.after(env.done);
  const card = async head => {
    env.head = head;
    await env.loop.pass();
    const c = env.card();
    await env.loop.decline(c.id, 'iPhone');
    return c;
  };
  const a = await card(H2);
  assert.equal(env.pushes.length, 1);
  env.clock.t += 30 * MIN;
  env.head = H3;
  await env.loop.pass();
  assert.deepEqual([env.pushes.length, env.card().pushWait], [1, 'cap'], 'one an hour');
  env.clock.t += 30 * MIN;
  await env.loop.pass();
  assert.equal(env.pushes.length, 2, 'the hour is up: the same card pushes now');
  await env.loop.decline(env.card().id, 'iPhone');
  for (const h of [H4, 'e5'.repeat(20), 'f6'.repeat(20)]) { env.clock.t += HOUR; await card(h); }
  assert.equal(env.pushes.length, 3, 'three a day');
  assert.equal(env.proposed().length, 3);
  // A new process counts the same marks.
  const next = await setup({ dir: env.dir, at: env.clock.t + HOUR, head: START });
  next.head = '17'.repeat(20);
  await next.loop.pass();
  assert.deepEqual([next.pushes.length, next.card().pushWait], [0, 'cap']);
  next.clock.t = a.proposedAt + DAY + 1;
  await next.loop.pass();
  assert.equal(next.pushes.length, 1, 'a day after the first');
});

test("the old process's page also goes out after its line (a failed launchctl)", async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  await env.loop.pass();
  const seen = [];
  const realAppend = env.ledger.append;
  env.ledger.append = async line => { seen.push(`line ${line.outcome}`); return realAppend(line); };
  const realPush = env.pushes.push.bind(env.pushes);
  env.pushes.push = (...x) => { seen.push('page'); return realPush(...x); };
  env.programFails = Object.assign(new Error('exited 5'), { code: 'exit-5' });
  await tapThrough(env);
  assert.deepEqual(seen, ['line verifying', 'line escalated', 'page']);
});

test('option b: a blocked card can be declined, and stays parked until HEAD moves', async t => {
  const env = await setup();
  t.after(env.done);
  env.head = H2;
  env.why = 'dirty-tree';
  await env.loop.pass();
  const c = env.card();
  assert.deepEqual([c.canAct, c.canDecline], [false, true]);
  assert.deepEqual(await env.loop.decline(c.id, 'iPhone'), { status: 200, ok: true, name: 'Control Room', action: 'not-now', card: CLASS });
  assert.deepEqual(env.outcomes(), [['declined', 'not-now']]);
  env.why = null;
  await env.loop.pass();
  assert.equal(env.card(), null, 'fit again on the same HEAD: still parked');
});
