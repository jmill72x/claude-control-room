// The programs the T2 loops run, kept apart so the tests can check exactly what each is
// given without running any.
//
// - `runCatalogProgram(entry, { uid, label })`: a catalog entry's fixed program with
//   its fixed arguments, {uid} and {label} filled in (lib/heal.mjs, programArgs). For
//   `rerun-job` that is `/bin/launchctl kickstart gui/<uid>/<label>`: no `-k`, no
//   shell, no other argument. Only the heal runner calls it, and only on a tap.
// - `runMissedRuns(path)`: the machine's read-only `missed-runs --since boot --json`, the
//   path from config (checked at start like job-status: lib/program-check.mjs), run
//   as `/usr/bin/python3 -I <path> --since boot --json` in the short environment the
//   other timed programs get. It exits 1 when a job needs a look; that is an answer.
// - `runSelfRestart(entry, { uid, label })` (loop 3, lib/heal-restart.mjs): the catalog's
//   `/bin/launchctl kickstart -k gui/<uid>/<label>` on this server's own launchd label,
//   which must be the one launchd started this process as (XPC_SERVICE_NAME). launchd
//   kills this process while launchctl waits, and it ends the whole process group of a
//   job whose process exited, so launchctl starts in a group of its own (detached) and
//   lives to finish the request. It resolves only if launchctl exits 0 while this
//   process is still here, which normally never happens.
// - `createCheckoutReader({ gitRead, repo })` (loop 3): the checkout's HEAD, whether it
//   is fit to restart onto (`checkout`, Ultron's M1), and what changed in the server's
//   code (SERVER_PATHS) between two commits, through the lead's read-only git-read (config's
//   `toPush.gitRead`, checked at start), never git itself.
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { programArgs } from './heal.mjs';
import { PYTHON, pythonArgs, programEnv } from './program-check.mjs';
import { runGitRead, STATUS_ARGS } from '../collectors/to-push.mjs';

export const KICKSTART_TIMEOUT_MS = 10e3;
export const MISSED_RUNS_TIMEOUT_MS = 60e3;
export const MISSED_RUNS_MAX_BYTES = 1024 * 1024;
export const MISSED_RUNS_ARGS = Object.freeze(['--since', 'boot', '--json']);

const run = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, opts, (err, stdout) => {
    if (err && typeof err.code === 'number') return resolve({ code: err.code, stdout });
    if (err) return reject(err);
    resolve({ code: 0, stdout });
  });
});

export async function runCatalogProgram(entry, { uid, label }, { exec = run } = {}) {
  if (!entry?.program) throw new Error('this catalog entry runs no program');
  // Only this process's own launchd domain, whatever the caller passed (L4).
  if (uid !== process.getuid()) throw new Error("the uid is not this process's own");
  const args = programArgs(entry, { uid, label });
  const { code } = await exec(entry.program.file, args, { timeout: KICKSTART_TIMEOUT_MS, maxBuffer: 64 * 1024, env: programEnv() });
  if (code !== 0) {
    const err = new Error(`exited ${code}`);
    err.code = `exit-${code}`;
    throw err;
  }
}

export async function runMissedRuns(path, { exec = run } = {}) {
  if (typeof path !== 'string' || !path) throw new Error('no missed-runs path');
  const { code, stdout } = await exec(PYTHON, pythonArgs(path, [...MISSED_RUNS_ARGS]), { timeout: MISSED_RUNS_TIMEOUT_MS, maxBuffer: MISSED_RUNS_MAX_BYTES, env: programEnv() });
  if (code !== 0 && code !== 1) {
    const err = new Error(`exited ${code}`);
    err.code = `exit-${code}`;
    throw err;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    const err = new Error('not JSON');
    err.code = 'not-json';
    throw err;
  }
}

export const RESTART_TIMEOUT_MS = 10e3;

export async function runSelfRestart(entry, { uid, label }, { spawn = nodeSpawn, env = process.env, timeout = RESTART_TIMEOUT_MS, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  if (!entry?.program) throw new Error('this catalog entry runs no program');
  if (uid !== process.getuid()) throw new Error("the uid is not this process's own");
  // Only the job launchd started this process as, whatever the caller passed.
  if (typeof env.XPC_SERVICE_NAME !== 'string' || env.XPC_SERVICE_NAME !== label) {
    const err = new Error("not this process's own launchd job");
    err.code = 'not-self';
    throw err;
  }
  const args = programArgs(entry, { uid, label });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(entry.program.file, args, { detached: true, stdio: 'ignore', env: programEnv(env) });
    } catch (err) {
      reject(err);
      return;
    }
    let done = false;
    const end = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      // Its own group (detached), so the group's id is its pid.
      try { kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      const err = new Error('launchctl took too long');
      err.code = 'timeout';
      end(reject, err);
    }, timeout);
    child.on('error', err => end(reject, err));
    child.on('exit', (code, signal) => {
      if (code === 0) return end(resolve);
      const err = new Error(`exited ${code ?? signal}`);
      err.code = code === null ? `signal-${signal}` : `exit-${code}`;
      end(reject, err);
    });
  });
}

// What loop 3 asks git-read, after the repo. A change needs a restart when it is code
// the server runs: `server/`, and the two page files lib/chat-speech.mjs loads once
// `chat.speech` is on (board 2703904f; test/chat-speech.test.mjs holds the server to
// exactly those two). They count whether speech is on or not: a restart then is
// harmless, and the card can't know what config will say at the next start. The page
// itself (web/dist) is read from disk on every request. Fixed paths, after `--`, with
// no glob characters, so git reads each as itself; nothing from a caller or a file
// reaches these arguments but two full hashes.
const COMMIT = /^[0-9a-f]{40}$/;
export const SERVER_PATHS = Object.freeze(['server', 'web/src/lib/orbit/speech.js', 'web/src/lib/orbit/markdown.js']);
export const headArgs = () => ['rev-list', '--max-count=1', 'HEAD'];
export const filesArgs = (from, to) => ['diff', '--name-only', from, to, '--', ...SERVER_PATHS];
export const mergesArgs = (from, to) => ['rev-list', '--first-parent', '--count', `${from}..${to}`, '--', ...SERVER_PATHS];
// Commits in `from` that HEAD doesn't have: 0 when the running commit is HEAD's ancestor.
export const behindArgs = (head, from) => ['rev-list', '--count', `${head}..${from}`];
// The branch a restart may load from.
export const MAIN_BRANCH = 'main';

// What `git status --porcelain=v2 --branch --untracked-files=no` says, for a restart:
// HEAD's commit, the branch (git's "(detached)" during a rebase or on a bare commit),
// and how many tracked entries are changed, renamed or unmerged. Output git-read cut
// short counts as changed: it can't be read whole.
export function parseCheckoutStatus(raw) {
  let head = null, branch = null, entries = 0, partial = false;
  for (const line of String(raw ?? '').split('\n')) {
    if (line.startsWith('# branch.oid ')) head = line.slice('# branch.oid '.length).trim();
    else if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) entries++;
    else if (line.startsWith('[git-read: output cut')) partial = true;
  }
  return { head, branch, entries, partial };
}

const notCommit = what => Object.assign(new Error(`${what} is not a commit`), { code: 'not-a-commit' });

export function createCheckoutReader({ gitRead, repo, run = runGitRead }) {
  const read = args => run(gitRead, repo, { args });
  return {
    // The checkout's HEAD, a full hash.
    async head() {
      const out = String(await read(headArgs())).trim();
      if (!COMMIT.test(out)) throw notCommit('HEAD');
      return out;
    },
    // Whether HEAD is fit to restart onto (M1): `{ head, why }`, `why` null when it is on
    // main, has no tracked change or conflict, and descends from `from` (the running
    // commit); else 'not-main', 'dirty-tree' or 'not-ancestor', in that order.
    async checkout(from) {
      if (!COMMIT.test(from ?? '')) throw notCommit('from');
      const st = parseCheckoutStatus(await read([...STATUS_ARGS]));
      if (!COMMIT.test(st.head ?? '')) throw notCommit('HEAD');
      if (st.branch !== MAIN_BRANCH) return { head: st.head, why: 'not-main' };
      if (st.entries > 0 || st.partial) return { head: st.head, why: 'dirty-tree' };
      if (st.head !== from) {
        const behind = String(await read(behindArgs(st.head, from))).trim();
        if (!/^\d{1,9}$/.test(behind)) throw Object.assign(new Error('not a count'), { code: 'not-a-count' });
        if (behind !== '0') return { head: st.head, why: 'not-ancestor' };
      }
      return { head: st.head, why: null };
    },
    // Between two full hashes: how many of the server's files (SERVER_PATHS) differ, and
    // how many commits on the first-parent line (the merges on main) touch them.
    async changed(from, to) {
      if (!COMMIT.test(from ?? '')) throw notCommit('from');
      if (!COMMIT.test(to ?? '')) throw notCommit('to');
      const files = String(await read(filesArgs(from, to))).split('\n').filter(l => l.trim() !== '').length;
      const count = String(await read(mergesArgs(from, to))).trim();
      if (!/^\d{1,9}$/.test(count)) throw Object.assign(new Error('not a count'), { code: 'not-a-count' });
      return { files, merges: Number(count) };
    }
  };
}
