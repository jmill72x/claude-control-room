import { basename, isAbsolute } from 'node:path';
import { taskLine as plainLine } from './agent-work.mjs';
import { cronOrder } from './parse-launchd.mjs';

// The health strip on the Orbit page (Orbit plan, Phase 2): a Jobs chip with
// the scheduled jobs' verdicts from job-status, and one chip per always-on
// service. This file holds the pure parts: the config block, parsing what
// job-status, ps and `launchctl print` say, and building what the page gets.
// The page gets an allowlist of the fields it shows, built field by field here:
// no launchd label, path, command line or process id reaches it. The process
// side is collectors/health.mjs.

const HOUR = 3600 * 1000;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A launchd label that may be handed to launchctl as one argument.
export const LAUNCHD_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A session's name as `claude -n <name>` takes it. It is matched against ps's
// output, which joins the arguments with spaces, so it may hold none.
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const KINDS = ['session', 'self', 'launchd', 'pi'];

// The block in config.json (gitignored: the real labels and paths live there):
//
//   "health": {
//     "jobStatus": "/absolute/path/to/job-status",
//     "services": [
//       { "kind": "session", "name": "Lead", "session": "Lead", "launcher": "com.example.lead" },
//       { "kind": "self", "name": "Control Room", "label": "com.example.control-room" },
//       { "kind": "launchd", "name": "Tunnel", "label": "com.example.tunnel" },
//       { "kind": "pi", "name": "Pi", "stateFile": "/abs/…/watch.state", "log": "/abs/…/watch.log",
//         "watchJob": "com.example.pi-watch" }
//     ]
//   }
//
// Every service may carry an `about` line for its details. The chips follow the
// list's order, after Jobs. A bad entry is left out and described in
// `problems`, which the server logs once at startup.
export function readHealthConfig(config) {
  const problems = [];
  const out = { jobStatus: null, services: [], problems };
  const raw = config?.health;
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    problems.push('health is not an object');
    return out;
  }
  if (raw.jobStatus !== undefined) {
    if (typeof raw.jobStatus === 'string' && isAbsolute(raw.jobStatus)) out.jobStatus = raw.jobStatus;
    else problems.push('health.jobStatus must be an absolute path');
  }
  if (raw.services !== undefined && !Array.isArray(raw.services)) problems.push('health.services is not a list');

  const names = new Set();
  const once = new Set();
  (Array.isArray(raw.services) ? raw.services : []).forEach((s, i) => {
    const where = `health.services[${i}]`;
    const name = text(s?.name, 40);
    if (!name) return problems.push(`${where} has no name`);
    if (names.has(name)) return problems.push(`${where}: ${JSON.stringify(name)} is listed twice`);
    if (!KINDS.includes(s.kind)) return problems.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    if (s.kind !== 'launchd' && once.has(s.kind)) return problems.push(`${where}: only one ${s.kind} service`);
    const label = key => (typeof s[key] === 'string' && LAUNCHD_LABEL.test(s[key]) ? s[key] : null);
    const path = key => (typeof s[key] === 'string' && isAbsolute(s[key]) ? s[key] : null);
    const about = text(s.about, 120);
    if (s.about !== undefined && !about) problems.push(`${where}: about must be a line of at most 120 characters`);
    const service = { key: `${s.kind}:${name}`, kind: s.kind, name, about };

    if (s.kind === 'session') {
      if (typeof s.session !== 'string' || !SESSION_NAME.test(s.session)) return problems.push(`${where}: session must be a name with no spaces`);
      service.session = s.session;
      service.launcher = label('launcher');
      if (s.launcher !== undefined && !service.launcher) problems.push(`${where}: launcher is not a launchd label`);
    } else if (s.kind === 'self' || s.kind === 'launchd') {
      service.label = label('label');
      if (!service.label) return problems.push(`${where}: label is not a launchd label`);
    } else {
      service.stateFile = path('stateFile');
      service.log = path('log');
      service.watchJob = label('watchJob');
      if (!service.stateFile || !service.log || !service.watchJob) {
        return problems.push(`${where}: stateFile and log must be absolute paths, and watchJob a launchd label`);
      }
    }
    names.add(name);
    once.add(s.kind);
    out.services.push(service);
  });
  return out;
}

// The labels a service chip speaks for, which the Jobs chip leaves out. The Pi
// watch is a scheduled job like any other and stays in Jobs.
export function claimedLabels(settings) {
  const out = new Set();
  for (const s of settings?.services ?? []) {
    if (s.label) out.add(s.label);
    if (s.launcher) out.add(s.launcher);
  }
  return out;
}

// ---- job-status --json --only jobs ----

const MAX_JOBS = 200;

// Its JSON, down to the fields used here. Anything else it says (an `error`
// field, a future addition) is dropped. Throws when the whole answer is
// unusable: not JSON, no list, no time, or the one entry it gives when the
// LaunchAgents folder itself can't be listed.
export function parseJobStatus(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { throw new Error('job-status printed something other than JSON'); }
  if (!isObject(d) || !Array.isArray(d.jobs)) throw new Error('job-status gave no list of jobs');
  const generatedAt = Date.parse(d.generated_at);
  if (!Number.isFinite(generatedAt)) throw new Error('job-status gave no time');
  const jobs = [];
  for (const j of d.jobs.slice(0, MAX_JOBS)) {
    if (!isObject(j)) continue;
    if (j.label === null) throw new Error(`job-status: ${plainLine(j.reason) ?? 'the jobs could not be listed'}`);
    if (typeof j.label !== 'string' || !LAUNCHD_LABEL.test(j.label)) continue;
    jobs.push({
      label: j.label,
      state: plainLine(j.state)?.slice(0, 40) ?? null,
      lastExit: Number.isInteger(j.last_exit) ? j.last_exit : null,
      logAgeHours: finite(j.log_age_hours),
      maxAgeHours: finite(j.max_age_hours),
      ok: j.ok === true,
      reason: plainLine(j.reason)
    });
  }
  return { generatedAt, jobs };
}

// One job's verdict. A job that is OK but has never exited and never written
// its log hasn't had its first run, which is not a failure. `lastRunAt` is when
// its log was last written, which is when it last ran as far as anyone can tell.
export function jobVerdict(entry, generatedAt) {
  const lastRunAt = entry.logAgeHours !== null && Number.isFinite(generatedAt)
    ? Math.round(generatedAt - entry.logAgeHours * HOUR)
    : null;
  if (!entry.ok) return { state: 'failed', reason: entry.reason ?? 'not OK, with no reason given', lastRunAt };
  const neverRan = entry.lastExit === null && entry.logAgeHours === null;
  return { state: neverRan ? 'new' : 'ok', reason: null, lastRunAt };
}

// The crons panel's short word for a failed job, which the mod and the classic
// page show as they always have.
function failedWord(entry) {
  if (entry.lastExit !== null && entry.lastExit !== 0) return `Failed · ${entry.lastExit}`;
  if (entry.state === 'not loaded') return 'Not loaded';
  if (entry.logAgeHours !== null && entry.maxAgeHours !== null && entry.logAgeHours > entry.maxAgeHours) {
    return `Overdue · log ${Math.round(entry.logAgeHours)} h old`;
  }
  return 'Failed';
}

// How long an answer stands in for launchd's own verdict: three polls. After
// that, the crons panel falls back to `launchctl list`, as before Phase 2.
export const ANSWER_FRESH_MS = 3 * 60 * 1000;

// One verdict everywhere (Orbit plan, Phase 2): the crons panel keeps its shape
// for the mod, the classic page and the alerts, but a job that job-status
// knows takes its verdict from there, plus `lastRunAt` for the Scheduled lane.
export function overlayCrons(crons, answer, now) {
  if (!Array.isArray(crons) || !answer || !(now - answer.receivedAt <= ANSWER_FRESH_MS)) return crons;
  const byLabel = new Map(answer.jobs.map(j => [j.label, j]));
  return crons.map(c => {
    const entry = byLabel.get(c?.label);
    if (!entry) return c;
    const v = jobVerdict(entry, answer.generatedAt);
    const state = v.state === 'new' ? 'never' : v.state;
    const last = state === 'failed' ? failedWord(entry) : state === 'never' ? 'Not yet run' : 'OK';
    return { ...c, ok: state !== 'failed', state, last, lastRunAt: v.lastRunAt };
  }).sort(cronOrder);
}

// The Jobs chip: every job job-status reports that no service chip speaks for.
// Failed first, then in job-status's own order (by label), so related jobs
// stay together. `status` is ok, unset (no path in config) or error.
export function buildJobs({ settings, answer, error = null, crons = [], jobNames = {} }) {
  if (!settings?.jobStatus) return { status: 'unset', error: null, list: [] };
  if (!answer) return { status: 'error', error: error ?? 'no answer yet', list: [] };
  const claimed = claimedLabels(settings);
  const schedules = new Map((Array.isArray(crons) ? crons : []).map(c => [c?.label, c?.schedule]));
  const list = answer.jobs.filter(j => !claimed.has(j.label)).map(j => {
    const v = jobVerdict(j, answer.generatedAt);
    return {
      name: jobNames?.[j.label]?.name ?? (j.label.split('.').pop() || j.label),
      schedule: typeof schedules.get(j.label) === 'string' ? schedules.get(j.label) : null,
      state: v.state,
      reason: v.reason
    };
  });
  const failedFirst = list.map((j, i) => [j, i]).sort((a, b) =>
    (a[0].state === 'failed' ? 0 : 1) - (b[0].state === 'failed' ? 0 : 1) || a[1] - b[1]);
  return { status: 'ok', error: null, list: failedFirst.map(([j]) => j) };
}

// ---- launchctl print, for this server's own job ----

const PRINTED = /^\t(state|runs|last exit code|last terminating signal) = (.*)$/gm;
const leadingInt = v => {
  const m = /^-?\d+/.exec(String(v ?? '').trim());
  return m ? Number(m[0]) : null;
};

// Only top-level lines (one tab in) count; nested blocks have state lines of
// their own. The rest of the output, which includes the job's environment, is
// never kept. "last exit code = (never exited)" reads as null, and launchctl
// prints a signal line instead of an exit line when a signal ended the job.
export function parseLaunchctlPrint(raw) {
  const found = {};
  for (const m of String(raw ?? '').matchAll(PRINTED)) if (!(m[1] in found)) found[m[1]] = m[2].trim();
  const signal = /:\s*(\d+)\s*$/.exec(found['last terminating signal'] ?? '');
  return {
    state: found.state ?? null,
    runs: leadingInt(found.runs),
    lastExit: leadingInt(found['last exit code']),
    lastSignal: signal ? Number(signal[1]) : null
  };
}

const SIGNALS = { 1: 'Hangup', 2: 'Interrupt', 3: 'Quit', 6: 'Abort', 9: 'Killed', 10: 'Bus error', 11: 'Segmentation fault', 13: 'Broken pipe', 15: 'Terminated' };

// How the previous run of this server ended: a signal (a restart by hand sends
// 15), an exit code (the watchdog exits with 1), or nothing on record.
export function lastStop(printed) {
  if (printed?.lastSignal !== null && printed?.lastSignal !== undefined) {
    return { signal: printed.lastSignal, name: SIGNALS[printed.lastSignal] ?? null };
  }
  if (printed?.lastExit !== null && printed?.lastExit !== undefined) return { exit: printed.lastExit };
  return null;
}

// ---- ps, for the lead agent's session ----

// ps's elapsed time, [[dd-]hh:]mm:ss, in ms.
export function parseEtime(value) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, sec] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
}

// The Claude Code processes started with this session name (`-n <name>`,
// `--name <name>` or `--name=<name>`), from `ps -o pid=,uid=,stat=,etime=,command=`.
// Only `uid`'s own processes count (the user this server runs as), and only live
// ones: a stopped (T) or zombie (Z) process can't be the lead at work, so it is left
// out (the 2026-10-21 security review). Only the count and the oldest one's start
// leave this function. Without a uid to count by, it throws, and the collector then
// reads the lead as unknown rather than down.
export function findSession(raw, name, now, uid) {
  if (!Number.isInteger(uid)) throw new TypeError('findSession needs the uid whose processes count');
  let count = 0;
  let startedAt = null;
  for (const line of String(raw ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const [, , owner, state, etime, command] = m;
    if (Number(owner) !== uid || /^[TZ]/.test(state)) continue;
    const argv = command.trim().split(/\s+/);
    if (basename(argv[0]) !== 'claude' && !argv[0].includes('/claude/versions/')) continue;
    const named = argv.some((w, i) => i > 0 &&
      (((w === '-n' || w === '--name') && argv[i + 1] === name) || w === `--name=${name}`));
    if (!named) continue;
    count++;
    const age = parseEtime(etime);
    if (age !== null) startedAt = Math.min(startedAt ?? Infinity, Math.round((now - age) / 1000) * 1000);
  }
  return { count, startedAt };
}

// ---- the Pi watch's state file ----

// Its tokens, as the watch's own README defines them, with what each means.
// Only these labels and lines reach the page, never the file's own bytes.
export const PI_TOKENS = {
  UP: { state: 'up', label: 'up', line: 'Every check passed.' },
  DOWN: { state: 'down', label: 'down', line: 'No answer on the LAN or the tailnet. A planned poweroff looks the same.' },
  DEGRADED: { state: 'down', label: 'degraded', line: "Up, but its disk array or systemd isn't healthy." },
  KUMA_DOWN: { state: 'warning', label: 'Kuma down', line: "Up, but Uptime Kuma doesn't answer, so the Pi's own monitoring is blind." },
  NO_SSH: { state: 'warning', label: 'no SSH', line: "Up, but the SSH health probe failed, so the mirror's state is unknown." },
  TM_STALE: { state: 'warning', label: 'backup late', line: "Up and healthy, but the mini hasn't written a Time Machine backup in 48 h." }
};

// The watch counts only while its log is at most 15 minutes old, three of its
// 5-minute runs (the contract's fallback when job-status doesn't answer).
export const PI_LOG_FRESH_MS = 15 * 60 * 1000;

// ---- the services, as the page gets them ----

// `found` is findSession's answer, or null when ps couldn't be run.
export function sessionView(service, found, launcherEntry) {
  const state = !found ? 'unknown' : found.count > 0 ? 'up' : 'down';
  return {
    key: service.key, kind: 'session', name: service.name, about: service.about,
    state,
    startedAt: found?.count > 0 ? found.startedAt : null,
    count: found ? found.count : null,
    launcher: launcherEntry ? { state: launcherEntry.state, lastExit: launcherEntry.lastExit } : null
  };
}

export function selfView(service, startedAt, printed) {
  return {
    key: service.key, kind: 'self', name: service.name, about: service.about,
    state: 'up',
    startedAt,
    runs: printed?.runs ?? null,
    lastStop: printed ? lastStop(printed) : null
  };
}

// A KeepAlive job is judged by launchd's state alone: running or not. That
// proves the process, not that it does its job, so the chip says "running".
export function launchdView(service, entry, unanswered) {
  let state, reason = null;
  if (unanswered) [state, reason] = ['unknown', unanswered];
  else if (!entry) [state, reason] = ['unknown', 'job-status does not list it'];
  else if (entry.state === 'running') state = 'running';
  else if (entry.state) state = 'down';
  else [state, reason] = ['unknown', entry.reason ?? 'launchd gave no state'];
  return {
    key: service.key, kind: 'launchd', name: service.name, about: service.about,
    state, launchd: entry?.state ?? null, reason
  };
}

// `reading` is { token, fresh, checkedAt, why } from the collector.
export function piView(service, reading) {
  const known = Object.hasOwn(PI_TOKENS, reading?.token ?? '') ? PI_TOKENS[reading.token] : null;
  let state, why = reading?.why ?? null;
  if (!known) [state, why] = ['unknown', why ?? "the watch's state file holds no known state"];
  else if (!reading.fresh) state = 'unknown';
  else state = known.state;
  return {
    key: service.key, kind: 'pi', name: service.name, about: service.about,
    state,
    label: known && reading.fresh ? known.label : null,
    line: known && reading.fresh ? known.line : null,
    checkedAt: reading?.checkedAt ?? null,
    why: state === 'unknown' ? why : null
  };
}

// When each service was first seen down, kept from pass to pass. Unknown
// keeps what was there, since it says nothing either way; anything else clears it.
export function stampDown(views, previous, now) {
  const next = new Map();
  const out = views.map(v => {
    const since = previous.get(v.key) ?? null;
    if (v.state === 'down') next.set(v.key, since ?? now);
    else if (v.state === 'unknown' && since !== null) next.set(v.key, since);
    return { ...v, downSince: v.state === 'down' ? next.get(v.key) : null };
  });
  return { views: out, downSince: next };
}
