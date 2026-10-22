// The To push collector (collectors/to-push.mjs): what it runs, how a run is
// bounded, what a failure looks like on the page and in the log. git-read is a
// Python script run as /usr/bin/python3 -I, so it is stood in for by small
// invented Python scripts; every path, repo and branch is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createToPush, runGitRead, whyNotRead, STATUS_ARGS, GIT_READ_TIMEOUT_MS
} from '../collectors/to-push.mjs';
import { readToPushConfig } from '../lib/to-push.mjs';
import { programEnv } from '../lib/program-check.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'ccr-topush-'));
const script = (dir, lines, name = 'git-read') => {
  const path = join(dir, name);
  writeFileSync(path, ['#!/usr/bin/python3', ...lines].join('\n') + '\n');
  chmodSync(path, 0o644);
  return path;
};
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const gone = async pid => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 20));
  return !alive(pid);
};

// ---- one run ----

test('git-read is asked for the status of one repo, untracked files left out', async () => {
  const dir = fresh();
  const out = await runGitRead(script(dir, ['import sys', 'print("\\n".join(sys.argv[1:]))']), '/home/example/projects/garden-app');
  assert.deepEqual(out.trim().split('\n'), ['/home/example/projects/garden-app', 'status', '--porcelain=v2', '--branch', '--untracked-files=no']);
  assert.deepEqual(STATUS_ARGS, ['status', '--porcelain=v2', '--branch', '--untracked-files=no']);
});

test("git-read gets only HOME, PATH, TMPDIR, USER, LOGNAME, LANG and LC_* from this service's environment, plus xcrun_nocache", async () => {
  const env = programEnv({
    HOME: '/home/example', PATH: '/usr/bin:/bin', TMPDIR: '/tmp/x', USER: 'example', LOGNAME: 'example', LANG: 'C', LC_ALL: 'C',
    PYTHONPATH: '/evil', PYTHONSTARTUP: '/evil.py', GIT_DIR: '/elsewhere', GIT_CONFIG_GLOBAL: '/evil.gitconfig', NODE_OPTIONS: '--x', SOME_TOKEN: 'abc',
    DEVELOPER_DIR: '/elsewhere', TOOLCHAINS: 'x', xcrun_db: '/tmp/forged'
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'TMPDIR', 'USER', 'xcrun_nocache']);
  const dir = fresh();
  const dump = ['import os', 'for k, v in sorted(os.environ.items()): print(k + "=" + v)'];
  const seen = await runGitRead(script(dir, dump), '/home/example/projects/garden-app', { env });
  assert.match(seen, /^HOME=\/home\/example$/m);
  assert.match(seen, /^xcrun_nocache=1$/m);
  assert.doesNotMatch(seen, /PYTHONPATH|PYTHONSTARTUP|GIT_DIR|GIT_CONFIG_GLOBAL|NODE_OPTIONS|SOME_TOKEN|DEVELOPER_DIR|TOOLCHAINS|xcrun_db/);
  // By default it is this process's own environment, filtered the same way.
  process.env.CCR_TOPUSH_TEST = 'not for git-read';
  try {
    const plain = await runGitRead(script(dir, dump, 'env-default'), '/r');
    assert.doesNotMatch(plain, /CCR_TOPUSH_TEST/);
    assert.match(plain, /^xcrun_nocache=1$/m);
  } finally {
    delete process.env.CCR_TOPUSH_TEST;
  }
});

test('a run that hangs is killed at its time limit, git and all: SIGKILL to its whole process group', async () => {
  const dir = fresh();
  const pidFile = join(dir, 'child.pid');
  // The script starts a child of its own (as git-read starts git) and waits,
  // both ignoring SIGTERM, so only SIGKILL ends them.
  const path = script(dir, [
    'import signal, subprocess',
    'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
    "child = subprocess.Popen(['/bin/sleep', '30'])",
    `open(${JSON.stringify(pidFile)}, 'w').write(str(child.pid))`,
    'child.wait()'
  ]);
  assert.equal(GIT_READ_TIMEOUT_MS, 10000);
  const started = Date.now();
  await assert.rejects(runGitRead(path, '/home/example/projects/garden-app', { timeout: 400 }), err => err.timedOut === true);
  assert.ok(Date.now() - started < 2000, 'stopped at its limit');
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(await gone(pid), "the script's own child was killed too");
});

test('the time limit holds even when something outside the group keeps the output open', async () => {
  const dir = fresh();
  const pidFile = join(dir, 'escaped.pid');
  // A grandchild in a session of its own holds stdout open after the script exits 0.
  const path = script(dir, [
    'import subprocess',
    "held = subprocess.Popen(['/bin/sleep', '3'], start_new_session=True)",
    `open(${JSON.stringify(pidFile)}, 'w').write(str(held.pid))`
  ]);
  const started = Date.now();
  try {
    await assert.rejects(runGitRead(path, '/home/example/projects/garden-app', { timeout: 400 }), err => err.timedOut === true);
    assert.ok(Date.now() - started < 1500, 'settled at the limit, not when the output closed');
  } finally {
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20));
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('more output than an answer can be is refused, and the run is stopped', async () => {
  const dir = fresh();
  await assert.rejects(runGitRead(script(dir, ['import sys', 'sys.stdout.write("y\\n" * 2500)']), '/r', { maxBytes: 1024 }), err => err.tooBig === true);
});

test("a refusal comes back with git-read's exit code and what it printed on stderr", async () => {
  const dir = fresh();
  const path = script(dir, ['import sys', 'sys.stderr.write("git-read: refused: the repo must be under /secret/root\\n")', 'sys.exit(2)']);
  await assert.rejects(runGitRead(path, '/r'), err => err.exitCode === 2 && /secret\/root/.test(err.stderr));
});

test('a git-read that is missing or unreadable is said as such, not as python3 failing to open it', async () => {
  const dir = fresh();
  // python3 would exit 2 for a missing script, which is git-read's own word for a refusal.
  await assert.rejects(runGitRead(join(dir, 'nowhere'), '/r'), err => err.code === 'ENOENT');
  const locked = script(dir, ['print("# branch.head main")'], 'locked');
  chmodSync(locked, 0o000);
  await assert.rejects(runGitRead(locked, '/r'), err => err.code === 'EACCES');
});

test('git-read runs as /usr/bin/python3 -I, so no user site-packages or script folder counts', async () => {
  const dir = fresh();
  const out = await runGitRead(script(dir, [
    'import json, os, sys',
    'here = os.path.dirname(os.path.realpath(__file__))',
    'print(json.dumps({"isolated": sys.flags.isolated, "noUserSite": sys.flags.no_user_site, "here": here in [os.path.realpath(p) for p in sys.path if p]}))'
  ]), '/r');
  assert.deepEqual(JSON.parse(out), { isolated: 1, noUserSite: 1, here: false });
});

test('each kind of failure has fixed words for the page', () => {
  assert.equal(whyNotRead(Object.assign(new Error('x /secret'), { timedOut: true })), 'timed out after 10 s');
  assert.equal(whyNotRead(Object.assign(new Error('x'), { tooBig: true })), 'printed too much');
  assert.equal(whyNotRead(Object.assign(new Error('spawn /secret/git-read ENOENT'), { code: 'ENOENT' })), 'git-read is not at the path in config.json');
  assert.equal(whyNotRead(Object.assign(new Error('x'), { code: 'EACCES' })), 'git-read is not allowed to run');
  assert.equal(whyNotRead(Object.assign(new Error('x'), { exitCode: 2 })), 'git-read refused it (not a repo folder it may read)');
  assert.equal(whyNotRead(Object.assign(new Error('x'), { exitCode: 3 })), 'git could not start, or took too long');
  assert.equal(whyNotRead(Object.assign(new Error('x'), { exitCode: 128 })), 'git-read exited with code 128');
  assert.equal(whyNotRead(Object.assign(new Error('x'), { exitCode: null, signal: 'SIGTERM' })), 'was ended by SIGTERM');
  assert.equal(whyNotRead(new Error('git-read gave no branch line')), 'gave no branch line');
  assert.equal(whyNotRead(new Error('something about /secret/path')), 'could not be read');
});

// ---- a pass ----

const REPOS = [
  { path: '/secret/projects/garden-app', owner: 'builder' },
  { path: '/secret/projects/notes-site', owner: 'writer' },
  { path: '/secret/projects/tools' }
];
const settingsWith = (gitRead = '/secret/bin/git-read', repos = REPOS) =>
  readToPushConfig({ toPush: { gitRead, repos } }, ['builder', 'writer']);
const STATUS = {
  'garden-app': '# branch.oid 0123abcd\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n1 M. N... a b c d e src/x.js\n',
  'notes-site': '# branch.oid 4567ef01\n# branch.head build/v2\n',
  tools: '# branch.oid 89ab2345\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'
};

function harness(over = {}) {
  const calls = [];
  const logged = [];
  let t = 1000;
  const toPush = createToPush({
    settings: settingsWith(),
    run: async (gitRead, path) => {
      calls.push([gitRead, path]);
      return STATUS[path.split('/').pop()];
    },
    log: line => logged.push(line),
    now: () => (t += 10),
    ...over
  });
  return { toPush, calls, logged };
}

test('no git-read or no repos: not set up, and nothing runs', async () => {
  for (const settings of [settingsWith(null), settingsWith('/secret/bin/git-read', [])]) {
    const calls = [];
    const out = await createToPush({ settings, run: async (...a) => { calls.push(a); return ''; } }).collect();
    assert.deepEqual(out, { configured: false, repos: [] });
    assert.equal(calls.length, 0);
  }
});

test('one pass reads each repo in turn, and the page gets names, owners, branches and counts only', async () => {
  const { toPush, calls } = harness();
  const out = await toPush.collect();
  assert.deepEqual(calls.map(c => c[1]), REPOS.map(r => r.path));
  assert.ok(calls.every(c => c[0] === '/secret/bin/git-read'));
  assert.equal(out.configured, true);
  assert.deepEqual(out.repos.map(r => [r.name, r.owner, r.state, r.branch, r.upstream, r.staged, r.ahead]), [
    ['garden-app', 'builder', 'ok', 'main', true, 1, 2],
    ['notes-site', 'writer', 'ok', 'build/v2', false, 0, null],
    ['tools', null, 'ok', 'main', true, 0, 0]
  ]);
  const sent = JSON.stringify(out);
  assert.ok(!sent.includes('/secret') && !sent.includes('0123abcd') && !sent.includes('src/x.js'));
});

test("one repo's failure is said in fixed words, logged once with git-read's first line, and the others still read", async () => {
  let fail = true;
  const { toPush, logged } = harness({
    run: async (gitRead, path) => {
      if (fail && path.endsWith('notes-site')) throw Object.assign(new Error(`git-read ended with 2`), { exitCode: 2, stderr: 'git-read: refused: the repo must be under /secret/root\nmore\n' });
      return STATUS[path.split('/').pop()];
    }
  });
  const first = await toPush.collect();
  assert.deepEqual(first.repos[1], { name: 'notes-site', owner: 'writer', state: 'error', why: 'git-read refused it (not a repo folder it may read)', checkedAt: first.repos[1].checkedAt });
  assert.equal(first.repos[0].state, 'ok');
  assert.equal(first.repos[2].state, 'ok');
  assert.ok(!JSON.stringify(first).includes('/secret'));
  await toPush.collect();
  assert.deepEqual(logged, ['to-push: notes-site: git-read refused it (not a repo folder it may read) (git-read: refused: the repo must be under /secret/root)']);
  // Recovered, then failing again: said again.
  fail = false;
  await toPush.collect();
  fail = true;
  await toPush.collect();
  assert.equal(logged.length, 2);
});

test('an answer with no branch line is a failure for that repo, not the pass', async () => {
  const { toPush } = harness({ run: async (g, path) => (path.endsWith('tools') ? 'nonsense\n' : STATUS[path.split('/').pop()]) });
  const out = await toPush.collect();
  assert.equal(out.repos[2].state, 'error');
  assert.equal(out.repos[2].why, 'gave no branch line');
  assert.equal(out.repos[0].state, 'ok');
});
