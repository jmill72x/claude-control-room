// The programs this server runs on a timer from paths in config.json
// (lib/program-check.mjs): how they are started, with what environment, and the
// check each path and the package it imports pass at startup. The tree below is
// invented, and so is every path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PYTHON, pythonArgs, programEnv, checkProgram, vetPrograms, PACKAGE, MAX_ENTRIES, MAX_DEPTH } from '../lib/program-check.mjs';

const ME = 501;
const DIR = 0o040000;
const FILE = 0o100000;
const FIFO = 0o010000;
const missing = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });

// A file system of { path: { uid, mode } }, with symlinks as { link: target }.
const fakeFs = entries => {
  const resolveLinks = path => {
    let at = path;
    for (let hops = 0; entries[at]?.link; hops++) {
      if (hops > 8) throw Object.assign(new Error('loop'), { code: 'ELOOP' });
      at = entries[at].link;
    }
    if (!entries[at]) throw missing();
    return at;
  };
  return {
    realpath: async path => resolveLinks(path),
    stat: async path => {
      const e = entries[resolveLinks(path)];
      const type = e.mode & 0o170000;
      return { uid: e.uid, mode: e.mode, isFile: () => type === FILE, isDirectory: () => type === DIR };
    },
    readdir: async path => {
      const dir = resolveLinks(path);
      return Object.keys(entries).filter(p => p !== '/' && dirname(p) === dir).map(p => p.slice(dir.length + 1));
    }
  };
};
const tree = (over = {}) => {
  const base = {
    '/': { uid: 0, mode: DIR | 0o755 },
    '/home': { uid: 0, mode: DIR | 0o755 },
    '/home/me': { uid: ME, mode: DIR | 0o750 },
    '/home/me/kit': { uid: ME, mode: DIR | 0o755 },
    '/home/me/kit/bin': { uid: ME, mode: DIR | 0o755 },
    '/home/me/kit/bin/job-status': { uid: ME, mode: FILE | 0o755 },
    '/home/me/kit/jarvis': { uid: ME, mode: DIR | 0o755 },
    '/home/me/kit/jarvis/__init__.py': { uid: ME, mode: FILE | 0o644 },
    '/home/me/kit/jarvis/status.py': { uid: ME, mode: FILE | 0o644 },
    '/home/me/kit/jarvis/secrets.py': { uid: ME, mode: FILE | 0o644 },
    ...over
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base;
};
const LAUNCHER = '/home/me/kit/bin/job-status';
const check = (entries, path = LAUNCHER) => checkProgram(path, { uid: ME, fs: fakeFs(entries) });
const problemOf = async (entries, path) => (await check(entries, path)).problem;

test('both programs start as /usr/bin/python3 -I <script> <args>', () => {
  assert.equal(PYTHON, '/usr/bin/python3');
  assert.deepEqual(pythonArgs('/home/me/kit/bin/job-status', ['--json', '--only', 'jobs']), ['-I', '/home/me/kit/bin/job-status', '--json', '--only', 'jobs']);
});

test("their environment is the short list git-read passes to git, plus xcrun_nocache, and nothing else of this service's", () => {
  const env = programEnv({
    HOME: '/home/me', PATH: '/usr/bin:/bin', TMPDIR: '/tmp/x', USER: 'me', LOGNAME: 'me', LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'UTF-8',
    DEVELOPER_DIR: '/elsewhere', SDKROOT: '/elsewhere/sdk', TOOLCHAINS: 'x', xcrun_db: '/tmp/forged', xcrun_nocache: '0',
    PYTHONPATH: '/evil', PYTHONSTARTUP: '/evil.py', GIT_DIR: '/x', NODE_OPTIONS: '--x', SOME_TOKEN: 'abc', EMPTY: undefined
  });
  assert.deepEqual(env, { HOME: '/home/me', PATH: '/usr/bin:/bin', TMPDIR: '/tmp/x', USER: 'me', LOGNAME: 'me', LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'UTF-8', xcrun_nocache: '1' });
  // By default, this process's own environment, filtered the same way.
  assert.deepEqual(programEnv(), programEnv(process.env));
});

test('a launcher and its package that only this user can change pass, and the real path comes back', async () => {
  assert.deepEqual(await check(tree()), { real: LAUNCHER, problem: null });
  // python3 reads the scripts, so they need no execute bit.
  assert.equal(await problemOf(tree({ [LAUNCHER]: { uid: ME, mode: FILE | 0o600 } })), null);
  assert.equal(await problemOf(tree({ '/home/me/kit/jarvis/status.py': { uid: ME, mode: FILE | 0o600 } })), null);
});

test("a launcher someone else owns is refused, root's included", async () => {
  for (const uid of [502, 0]) {
    assert.equal(await problemOf(tree({ [LAUNCHER]: { uid, mode: FILE | 0o755 } })), 'is not owned by the user this server runs as');
  }
});

test('a launcher its group or anyone may change is refused', async () => {
  for (const mode of [0o775, 0o757, 0o777, 0o620, 0o602]) {
    assert.equal(await problemOf(tree({ [LAUNCHER]: { uid: ME, mode: FILE | mode } })), 'can be changed by other users (group- or world-writable)', mode.toString(8));
  }
});

test('a launcher in a folder another user owns, or its group or anyone may change, is refused, however far up', async () => {
  for (const dir of ['/home/me/kit/bin', '/home/me/kit', '/home/me', '/home', '/']) {
    assert.equal(await problemOf(tree({ [dir]: { uid: 502, mode: DIR | 0o755 } })), 'is in a folder owned by another user', dir);
    for (const mode of [0o775, 0o757, 0o1777]) {
      assert.equal(await problemOf(tree({ [dir]: { uid: dir === '/' || dir === '/home' ? 0 : ME, mode: DIR | mode } })), 'is in a folder other users can change (group- or world-writable)', `${dir} ${mode.toString(8)}`);
    }
  }
});

test("a symlinked launcher is followed: the real file, its folders and its package are what's checked, and what runs", async () => {
  const linked = tree({ '/home/me/job-status': { link: LAUNCHER } });
  assert.deepEqual(await check(linked, '/home/me/job-status'), { real: LAUNCHER, problem: null });
  const intoShared = tree({
    '/home/me/job-status': { link: '/tmp/drop/bin/job-status' },
    '/tmp': { uid: 0, mode: DIR | 0o1777 },
    '/tmp/drop': { uid: ME, mode: DIR | 0o755 },
    '/tmp/drop/bin': { uid: ME, mode: DIR | 0o755 },
    '/tmp/drop/bin/job-status': { uid: ME, mode: FILE | 0o755 }
  });
  assert.equal(await problemOf(intoShared, '/home/me/job-status'), 'is in a folder other users can change (group- or world-writable)');
});

test('a launcher path that is missing, or names a folder, is refused', async () => {
  assert.equal(await problemOf(tree(), '/home/me/kit/bin/nowhere'), 'could not be checked (ENOENT)');
  assert.equal(await problemOf(tree(), '/home/me/kit/bin'), 'is not a regular file');
});

// ---- the package, ../jarvis beside the launcher's folder ----

test(`the package the launcher imports (../${PACKAGE}) must be there, and be this user's folder that no one else may change`, async () => {
  assert.equal(PACKAGE, 'jarvis');
  assert.equal(await problemOf(tree({ '/home/me/kit/jarvis': undefined, '/home/me/kit/jarvis/__init__.py': undefined, '/home/me/kit/jarvis/status.py': undefined, '/home/me/kit/jarvis/secrets.py': undefined })),
    'imports ../jarvis, which could not be checked (ENOENT)');
  assert.equal(await problemOf(tree({ '/home/me/kit/jarvis': { uid: 502, mode: DIR | 0o755 } })), 'imports ../jarvis, which is not owned by the user this server runs as');
  assert.equal(await problemOf(tree({ '/home/me/kit/jarvis': { uid: 0, mode: DIR | 0o755 } })), 'imports ../jarvis, which is not owned by the user this server runs as');
  for (const mode of [0o775, 0o757, 0o1777]) {
    assert.equal(await problemOf(tree({ '/home/me/kit/jarvis': { uid: ME, mode: DIR | mode } })), 'imports ../jarvis, which can be changed by other users (group- or world-writable)');
  }
  assert.equal(await problemOf(tree({ '/home/me/kit/jarvis': { uid: ME, mode: FILE | 0o644 } })), 'imports ../jarvis, which is not a folder');
});

test('every .py file in the package passes the same rule', async () => {
  for (const name of ['__init__.py', 'status.py', 'secrets.py']) {
    const at = `/home/me/kit/jarvis/${name}`;
    assert.equal(await problemOf(tree({ [at]: { uid: 502, mode: FILE | 0o644 } })), `imports ../jarvis/${name}, which is not owned by the user this server runs as`);
    assert.equal(await problemOf(tree({ [at]: { uid: ME, mode: FILE | 0o664 } })), `imports ../jarvis/${name}, which can be changed by other users (group- or world-writable)`);
    assert.equal(await problemOf(tree({ [at]: { uid: ME, mode: FILE | 0o646 } })), `imports ../jarvis/${name}, which can be changed by other users (group- or world-writable)`);
  }
  // A module symlinked from somewhere others can write is judged where it really is.
  const linked = tree({
    '/home/me/kit/jarvis/status.py': { link: '/tmp/status.py' },
    '/tmp': { uid: 0, mode: DIR | 0o1777 },
    '/tmp/status.py': { uid: ME, mode: FILE | 0o644 }
  });
  assert.equal(await problemOf(linked), 'imports ../jarvis/status.py, which is in a folder other users can change (group- or world-writable)');
});

test("the package's compiled copies (__pycache__) and any sub-package pass it too", async () => {
  const cache = {
    '/home/me/kit/jarvis/__pycache__': { uid: ME, mode: DIR | 0o755 },
    '/home/me/kit/jarvis/__pycache__/status.cpython-39.pyc': { uid: ME, mode: FILE | 0o644 }
  };
  assert.equal(await problemOf(tree(cache)), null);
  assert.equal(await problemOf(tree({ ...cache, '/home/me/kit/jarvis/__pycache__': { uid: ME, mode: DIR | 0o777 } })),
    'imports ../jarvis/__pycache__, which can be changed by other users (group- or world-writable)');
  assert.equal(await problemOf(tree({ ...cache, '/home/me/kit/jarvis/__pycache__/status.cpython-39.pyc': { uid: 502, mode: FILE | 0o644 } })),
    'imports ../jarvis/__pycache__/status.cpython-39.pyc, which is not owned by the user this server runs as');
  const sub = {
    '/home/me/kit/jarvis/tools': { uid: ME, mode: DIR | 0o755 },
    '/home/me/kit/jarvis/tools/__init__.py': { uid: ME, mode: FILE | 0o644 },
    '/home/me/kit/jarvis/tools/run.cpython-39-darwin.so': { uid: ME, mode: FILE | 0o755 }
  };
  assert.equal(await problemOf(tree(sub)), null);
  assert.equal(await problemOf(tree({ ...sub, '/home/me/kit/jarvis/tools/run.cpython-39-darwin.so': { uid: ME, mode: FILE | 0o775 } })),
    'imports ../jarvis/tools/run.cpython-39-darwin.so, which can be changed by other users (group- or world-writable)');
  // Something that is neither a file nor a folder has no place in it.
  assert.equal(await problemOf(tree({ '/home/me/kit/jarvis/pipe': { uid: ME, mode: FIFO | 0o644 } })),
    'imports ../jarvis/pipe, which is not a regular file or a folder');
});

test('a package too big or too deep to walk is refused, not walked', async () => {
  const big = {};
  for (let i = 0; i <= MAX_ENTRIES; i++) big[`/home/me/kit/jarvis/m${String(i).padStart(4, '0')}.py`] = { uid: ME, mode: FILE | 0o644 };
  assert.equal(await problemOf(tree(big)), `imports ../jarvis, which holds more than ${MAX_ENTRIES} entries to check`);
  const deep = {};
  let at = '/home/me/kit/jarvis';
  for (let i = 0; i < MAX_DEPTH; i++) { at += `/d${i}`; deep[at] = { uid: ME, mode: DIR | 0o755 }; }
  assert.match(await problemOf(tree(deep)), /^imports \.\.\/jarvis\/d0\/d1\/d2\/d3, which is nested too deep to check$/);
});

test('the real file system: a world-writable script, a folder and a missing path are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-program-'));
  const script = join(dir, 'job-status');
  writeFileSync(script, 'print(1)\n');
  chmodSync(script, 0o666);
  assert.equal((await checkProgram(script)).problem, 'can be changed by other users (group- or world-writable)');
  mkdirSync(join(dir, 'sub'));
  assert.equal((await checkProgram(join(dir, 'sub'))).problem, 'is not a regular file');
  assert.deepEqual(await checkProgram(join(dir, 'nowhere')), { real: null, problem: 'could not be checked (ENOENT)' });
});

test('vetPrograms keeps the real path of each program that passes, leaves out each that fails and says which', async () => {
  const run = async over => {
    const health = { jobStatus: '/home/me/job-status' };
    const toPush = { gitRead: '/home/me/kit/bin/git-read' };
    const unset = { jobStatus: null };
    const fs = fakeFs(tree({ '/home/me/job-status': { link: LAUNCHER }, '/home/me/kit/bin/git-read': { uid: ME, mode: FILE | 0o755 }, ...over }));
    const problems = await vetPrograms([
      ['health.jobStatus', health, 'jobStatus'],
      ['toPush.gitRead', toPush, 'gitRead'],
      ['health.jobStatus', unset, 'jobStatus']
    ], { uid: ME, fs });
    return { problems, jobStatus: health.jobStatus, gitRead: toPush.gitRead, unset: unset.jobStatus };
  };
  // All good: each keeps its real path, the symlink replaced by the file that was checked.
  assert.deepEqual(await run({}), { problems: [], jobStatus: LAUNCHER, gitRead: '/home/me/kit/bin/git-read', unset: null });
  // A bad launcher leaves out that one program.
  assert.deepEqual(await run({ '/home/me/kit/bin/git-read': { uid: ME, mode: FILE | 0o777 } }), {
    problems: ['toPush.gitRead can be changed by other users (group- or world-writable), so it is left out'],
    jobStatus: LAUNCHER, gitRead: null, unset: null
  });
  // Both launchers import the one package, so a bad module there leaves out both.
  assert.deepEqual(await run({ '/home/me/kit/jarvis/git_read.py': { uid: ME, mode: FILE | 0o666 } }), {
    problems: [
      'health.jobStatus imports ../jarvis/git_read.py, which can be changed by other users (group- or world-writable), so it is left out',
      'toPush.gitRead imports ../jarvis/git_read.py, which can be changed by other users (group- or world-writable), so it is left out'
    ],
    jobStatus: null, gitRead: null, unset: null
  });
});
