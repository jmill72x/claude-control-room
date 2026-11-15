// The two programs loop 2 runs (lib/heal-missed.mjs), kept apart so the tests can
// check exactly what each is given without running either.
//
// - `runCatalogProgram(entry, { uid, label })`: a catalog entry's fixed program with
//   its fixed arguments, {uid} and {label} filled in (lib/heal.mjs, programArgs). For
//   `rerun-job` that is `/bin/launchctl kickstart gui/<uid>/<label>`: no `-k`, no
//   shell, no other argument. Only the heal runner calls it, and only on a tap.
// - `runMissedRuns(path)`: the machine's read-only `missed-runs --since boot --json`, the
//   path from config (checked at start like job-status: lib/program-check.mjs), run
//   as `/usr/bin/python3 -I <path> --since boot --json` in the short environment the
//   other timed programs get. It exits 1 when a job needs a look; that is an answer.
import { execFile } from 'node:child_process';
import { programArgs } from './heal.mjs';
import { PYTHON, pythonArgs, programEnv } from './program-check.mjs';

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
