import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  parseJobStatus, overlayCrons, buildJobs, jobVerdict, parseLaunchctlPrint, findSession,
  sessionView, selfView, launchdView, piView, stampDown, PI_LOG_FRESH_MS
} from '../lib/health.mjs';

const exec = promisify(execFile);

// job-status makes one `launchctl print` per job, one after another, each with
// a 10 s timeout of its own, so 19 jobs could take minutes. This bounds the
// whole call (the 2026-10-21 security review); it answers in about 0.1 s.
export const JOB_STATUS_TIMEOUT_MS = 20 * 1000;

// What runs, every minute: job-status in its narrow mode (only `launchctl
// print` per job and a read of each plist: no network, Keychain, tmux or
// board), and ps. `launchctl print` for this server's own job runs once, at
// the first pass that gets an answer.
export const runJobStatus = (path, timeout = JOB_STATUS_TIMEOUT_MS) =>
  exec(path, ['--json', '--only', 'jobs'], { timeout, maxBuffer: 1024 * 1024 }).then(r => r.stdout);
export const runPs = () =>
  exec('/bin/ps', ['-axww', '-o', 'pid=,etime=,command='], {
    timeout: 10000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }
  }).then(r => r.stdout);
export const runLaunchctlPrint = label =>
  exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 10000, maxBuffer: 1024 * 1024 }).then(r => r.stdout);

// The Pi watch's state file holds one short token. It is opened without
// following a symlink or waiting on a FIFO, and read only when it is a small
// regular file. Its age means nothing (it is written only on a change).
const STATE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_STATE_BYTES = 64;
export async function readStateToken(path) {
  const handle = await open(path, STATE_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('not a small regular file');
    return (await handle.readFile('latin1')).trim();
  } finally {
    await handle.close().catch(() => {});
  }
}
const mtimeOf = async path => (await stat(path)).mtimeMs;

// What the page may hear about a failed job-status call: fixed words. An
// error's own text names the path it ran.
function whyFailed(err) {
  if (err?.killed) return `timed out after ${JOB_STATUS_TIMEOUT_MS / 1000} s`;
  if (err?.signal) return `was ended by ${err.signal}`;
  if (err?.code === 'ENOENT') return 'is not at the path in config.json';
  if (err?.code === 'EACCES') return 'is not allowed to run';
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed too much';
  if (Number.isInteger(err?.code)) return `exited with code ${err.code}`;
  // parseJobStatus's own messages, which are fixed text.
  if (err instanceof Error && err.message.startsWith('job-status ')) return err.message.slice('job-status '.length);
  if (err instanceof Error && err.message.startsWith('job-status: ')) return err.message.slice('job-status: '.length);
  return 'could not be run';
}

// The health collector. `overlay` gives the crons panel job-status's verdicts
// (lib/health.mjs, overlayCrons); `collect` builds the `health` panel.
export function createHealth({
  settings,
  jobNames = {},
  cache = null,
  startedAt = Date.now(),
  jobStatus = runJobStatus,
  ps = runPs,
  launchctlPrint = runLaunchctlPrint,
  readToken = readStateToken,
  logMtime = mtimeOf,
  log = console.error,
  now = () => Date.now()
}) {
  let answer = null;
  let printed = null;
  let downSince = new Map();
  let lastProblem = null;
  // A failure is logged once, when it starts or changes, not every minute.
  const note = problem => {
    if (problem && problem !== lastProblem) log(`health: ${problem}`);
    lastProblem = problem;
  };

  async function askJobStatus(at) {
    if (!settings.jobStatus) {
      answer = null;
      return null;
    }
    try {
      answer = { ...parseJobStatus(await jobStatus(settings.jobStatus)), receivedAt: at };
      note(null);
      return null;
    } catch (err) {
      // No answer this pass is no answer: the Jobs chip says unknown, and the
      // crons panel falls back to launchd's own verdict at once.
      answer = null;
      const why = whyFailed(err);
      // The service log gets the error's first line too, which can name the path.
      const detail = err?.message && !err.message.startsWith('job-status') ? ` (${String(err.message).split('\n')[0].slice(0, 200)})` : '';
      note(`job-status ${why}${detail}`);
      return why;
    }
  }

  // The watch's reading counts only while the watch itself is OK: job-status's
  // verdict on its job when job-status answered, otherwise its log's age alone.
  async function readPi(service, byLabel, at) {
    let token = null;
    let why = null;
    try { token = await readToken(service.stateFile); } catch { why = "the watch's state file could not be read"; }
    let fresh = false;
    let checkedAt = null;
    if (answer) {
      const entry = byLabel.get(service.watchJob);
      if (!entry) why ??= 'job-status does not list the watch';
      else {
        fresh = entry.ok;
        checkedAt = jobVerdict(entry, answer.generatedAt).lastRunAt;
        if (!fresh) why ??= `the watch is not OK: ${entry.reason ?? 'no reason given'}`;
      }
    } else {
      try {
        checkedAt = Math.round(await logMtime(service.log));
        fresh = at - checkedAt <= PI_LOG_FRESH_MS;
        if (!fresh) why ??= "the watch's log is more than 15 minutes old";
      } catch {
        why ??= "the watch's log could not be read";
      }
    }
    return { token, fresh, checkedAt, why };
  }

  return {
    overlay: (crons, at = now()) => overlayCrons(crons, answer, at),

    async collect() {
      const at = now();
      const error = await askJobStatus(at);
      const unanswered = !settings.jobStatus ? 'job-status is not set up' : error ? `job-status ${error}` : null;
      const byLabel = new Map((answer?.jobs ?? []).map(j => [j.label, j]));
      const crons = cache?.get('crons', at)?.data;
      const jobs = buildJobs({ settings, answer, error, crons, jobNames });

      const views = [];
      for (const service of settings.services) {
        if (service.kind === 'session') {
          let found = null;
          try { found = findSession(await ps(), service.session, at); } catch { found = null; }
          views.push(sessionView(service, found, service.launcher ? byLabel.get(service.launcher) ?? null : null));
        } else if (service.kind === 'self') {
          if (!printed) {
            try { printed = parseLaunchctlPrint(await launchctlPrint(service.label)); } catch { printed = null; }
          }
          views.push(selfView(service, startedAt, printed));
        } else if (service.kind === 'launchd') {
          views.push(launchdView(service, byLabel.get(service.label) ?? null, answer ? null : unanswered));
        } else {
          views.push(piView(service, await readPi(service, byLabel, at)));
        }
      }
      const stamped = stampDown(views, downSince, at);
      downSince = stamped.downSince;
      return { jobs, services: stamped.views };
    }
  };
}
