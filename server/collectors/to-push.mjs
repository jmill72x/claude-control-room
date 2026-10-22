import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseStatus, repoView } from '../lib/to-push.mjs';
import { PYTHON, pythonArgs, programEnv } from '../lib/program-check.mjs';

// The To push collector (Orbit plan, Phase 4). Every 5 minutes, for each repo
// in config, one after another:
//
//   /usr/bin/python3 -I <toPush.gitRead> <repo> status --porcelain=v2 --branch --untracked-files=no
//
// git-read is the lead's hardened read-only git runner, a Python script started
// in isolated mode (lib/program-check.mjs): it reads only repos under its own
// root, runs /usr/bin/git with no hooks, pager, fsmonitor, optional locks, or
// global or system config, and redacts secret-shaped text from what git prints.
// Untracked files never count, so git isn't asked to list them. Only the counts
// and the branch name are kept (lib/to-push.mjs).

export const GIT_READ_TIMEOUT_MS = 10 * 1000;
// git-read cuts what git prints at 200,000 characters; anything near this is
// not an answer to read.
export const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
export const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '--untracked-files=no'];

const failure = (message, extra) => Object.assign(new Error(message), extra);

// One run. The child gets its own process group, so on a timeout SIGKILL ends
// git-read and the git it started, not only the script. The time limit covers
// the whole run, and the promise settles at it even if something still holds
// the output open. Its environment is the short list in lib/program-check.mjs,
// so nothing else of this service's (a PYTHON* variable, a GIT_* one, what moves
// xcrun's shim) reaches python3, git-read or git. python3 would report a missing
// script as its exit code 2, git-read's own word for a refusal, so the path is
// looked at first and a missing or unreadable one fails as such (ENOENT, EACCES).
export async function runGitRead(gitRead, repo, { timeout = GIT_READ_TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES, env = programEnv() } = {}) {
  await access(gitRead, constants.R_OK);
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(PYTHON, pythonArgs(gitRead, [repo, ...STATUS_ARGS]), { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      rejectPromise(err);
      return;
    }
    const out = [];
    const errs = [];
    let size = 0;
    let errSize = 0;
    let settled = false;
    const stderr = () => Buffer.concat(errs).toString('utf8');
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const stop = extra => {
      killGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(rejectPromise, failure(extra.message, { ...extra, stderr: stderr() }));
    };
    const timer = setTimeout(() => stop({ message: 'git-read timed out', timedOut: true }), timeout);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return stop({ message: 'git-read printed too much', tooBig: true });
      out.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (errSize >= MAX_STDERR_BYTES) return;
      errs.push(chunk);
      errSize += chunk.length;
    });
    child.on('error', err => settle(rejectPromise, err));
    child.on('close', (code, signal) => {
      if (code === 0) return settle(resolvePromise, Buffer.concat(out).toString('utf8'));
      settle(rejectPromise, failure(`git-read ended with ${code ?? signal}`, { exitCode: code, signal, stderr: stderr() }));
    });
  });
}

// What the page may hear about a repo that wasn't read: fixed words. The error's
// own text, and what git-read printed on stderr, can name the path.
export function whyNotRead(err) {
  if (err?.timedOut) return `timed out after ${GIT_READ_TIMEOUT_MS / 1000} s`;
  if (err?.tooBig) return 'printed too much';
  if (err?.code === 'ENOENT') return 'git-read is not at the path in config.json';
  if (err?.code === 'EACCES') return 'git-read is not allowed to run';
  if (err?.exitCode === 2) return 'git-read refused it (not a repo folder it may read)';
  if (err?.exitCode === 3) return 'git could not start, or took too long';
  if (Number.isInteger(err?.exitCode)) return `git-read exited with code ${err.exitCode}`;
  if (err?.signal) return `was ended by ${err.signal}`;
  if (err instanceof Error && err.message === 'git-read gave no branch line') return 'gave no branch line';
  return 'could not be read';
}

export function createToPush({ settings, run = runGitRead, log = console.error, now = () => Date.now() }) {
  // A repo's failure is logged once, when it starts or changes, not every pass.
  const lastProblem = new Map();
  const note = (name, problem) => {
    if (problem && problem !== lastProblem.get(name)) log(`to-push: ${name}: ${problem}`);
    if (problem) lastProblem.set(name, problem);
    else lastProblem.delete(name);
  };

  return {
    async collect() {
      if (!settings.gitRead || settings.repos.length === 0) return { configured: false, repos: [] };
      const repos = [];
      for (const repo of settings.repos) {
        const at = now();
        try {
          repos.push(repoView(repo, parseStatus(await run(settings.gitRead, repo.path)), at));
          note(repo.name, null);
        } catch (err) {
          const why = whyNotRead(err);
          // The service log also gets the first line git-read printed on
          // stderr, which can name the path; the page never does.
          const said = String(err?.stderr ?? '').trim().split('\n')[0].slice(0, 200);
          note(repo.name, said ? `${why} (${said})` : why);
          repos.push(repoView(repo, null, at, why));
        }
      }
      return { configured: true, repos };
    }
  };
}
