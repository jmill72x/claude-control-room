// Restart Jarvis from the page (board 98a30b15, P0; Ultron's M8, after the outages of
// 2026-11-19 and 11-20). When the lead is down, the page offers "Restart Jarvis"; one
// tap and Face ID (the passkey a Stop uses, lib/stepup.mjs), and this server runs ONE
// fixed program: the lead's recovery script, the same line the run sheet gives,
//
//   cd ~/Projects && ~/Projects/.worktrees/jarvis-release/bin/jarvis-recover
//
// as /bin/bash with that file, from ~/Projects. Nothing in the request names what runs,
// where, or with what arguments: the request body is only the Face ID answer. The
// script fixes what has stopped the lead before, restarts him (its jarvis-start
// --restart), and ends with one line, "OK: ...", "OK, degraded: ..." or "NOT OK: ...";
// that line is the run's result, shown on the page's card, logged, and alerted.
//
//   GET  /api/recover/status     what the card needs: on, the passkey, the run going or
//                                the last one, and why a new one can't start now
//   POST /api/recover/challenge  a Face ID challenge for a restart
//   POST /api/recover            the Face ID answer; the run starts (202)
//
// Every route: no Authorization header (a Shortcut key never restarts anything), a paired
// device by its cookie and the owner's login header, an approver device; the two POSTs
// also the write guard and the page's own https Origin (the approvals rule). A run also
// needs config's `recover.enabled` true, no kill file (`recover-off` beside the sockets),
// no run going, at most RUNS_PER_HOUR started in the last hour and RUNS_PER_DAY in the
// last day (counted from the ledger, which a restart of this server keeps), and a Face ID
// answer to a challenge issued for this device and this purpose.
//
// How it runs, and why:
//   - Without a terminal. stdin is /dev/null, so the script's Keychain step (`[ -t 0 ]`)
//     never asks for a password: when the login Keychain can't be reached it ends at once
//     with "NOT OK: ... Run: security unlock-keychain ...". This server is a LaunchAgent
//     in the owner's login session, where the Keychain is reachable, as it is for the
//     watch's starts.
//   - In a process group of its own (detached) and writing to a file, never a pipe: a
//     restart of this server (launchd ends the job's group) must not end a recovery half
//     way, and a pipe's reader gone would end the script on its next line (SIGPIPE).
//   - With a fixed environment (RECOVER_ENV_KEYS and this PATH, the restart job's), not
//     this server's: a tmux server the script starts would hand it to the lead's session.
//   - Never killed. After NO_ANSWER_MS the card says there was no answer and a new run
//     may start; jarvis-start's own lock keeps two restarts from overlapping.
//   - Whether or not the health strip says he is down (Ultron's Q1, 11-20): a wrong "up"
//     must not block the one way back, and Face ID and the caps make each run
//     deliberate. The status says what health and the stop flag show (`jarvis`), so the
//     sheet can say "Jarvis looks up; this ends his current turn" or "Jarvis was stopped
//     on purpose; this restart clears that" (jarvis-recover's step 4 removes the flag),
//     and `recover-asked` records both.
//
// Agent runs a restart would stop (board d8f27c49, after 2026-11-20 16:14, when a tap
// on Restart Jarvis ended two runs in the middle of their work). A restart ends the
// lead's session, and with it every subagent run inside it. The status lists those runs
// (`agents`), from the live agents panel (lib/live-agents.mjs, the sessions collector's
// minute pass: the source the Overview's pane, the Stop buttons and the idle wake-up
// read), and the page says so before Face ID with Cancel as its default. The server
// holds the line too, so a page whose status is old can't skip the warning: while runs
// are live, both POSTs must name each of them in `stopRuns` (their ids, as the status
// gave them), else the answer is 409 with the runs, and no Face ID is asked or used.
// When the panel isn't current, nobody can say no run is going, so `stopRuns` must also
// hold UNSEEN, the page's word for "I said the runs can't be seen". A run started in the
// panel's last minute is not seen yet: the panel reads the transcripts once a minute.
//
// A refusal that means more than a slip of the finger (a Shortcut key from the owner's
// login, a paired device that is not an approver, a Face ID answer that fails) is
// alerted as `recover-refused`, at most once per 10 minutes (lib/chat-alert-limit.mjs,
// like `heal-tap-refused`; Ultron's L4): a burst of them is how a stolen device cookie
// would show. The status read is never alerted: every page reads it.
//
// The ledger (data/chat/recover.json, 0600) keeps the last KEEP_RUNS runs: who asked, when,
// the pid, the exit and the cleaned last line. A run is written there BEFORE the script
// starts, so a crash in between is seen. The script's whole output is kept in
// data/chat/recover/ (0600, the last KEEP_OUTS); the script's own log is
// ~/Library/Logs/jarvis-recover.log. The last line shown is one line, hidden characters
// marked, at most LINE_MAX code points, and withheld if it looks like a credential.
import { spawn as nodeSpawn } from 'node:child_process';
import { open, readFile, writeFile, rename, unlink, readdir, mkdir, access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { json, readBody, guardWrite, HttpError } from '../routes.mjs';
import { verdictOriginProblem } from './approvals.mjs';
import { oneLine } from './chat-events.mjs';
import { secretShapes } from './secret-shape.mjs';
import { RECOVER_COMMAND, RECOVER_LINE } from './recover-command.mjs';

// The one line, as the run sheet and every Jarvis-down alert give it (lib/recover-command.mjs).
export { RECOVER_COMMAND, RECOVER_LINE };
// The script, under the owner's home; run by this shell, from ~/Projects.
export const SCRIPT_PARTS = Object.freeze(['Projects', '.worktrees', 'jarvis-release', 'bin', 'jarvis-recover']);
export const SHELL = '/bin/bash';
export const PURPOSE = 'recover:jarvis';
export const RUNS_PER_HOUR = 3;
export const RUNS_PER_DAY = 8;
export const HOUR_MS = 3600e3;
export const DAY_MS = 24 * HOUR_MS;
export const NO_ANSWER_MS = 45 * 60e3;
export const WATCH_MS = 5e3;
export const LINE_MAX = 300;
export const OUT_TAIL_BYTES = 64 * 1024;
export const KEEP_RUNS = 20;
export const KEEP_OUTS = 5;
export const KILL_FILE = 'recover-off';
export const ROUTES = Object.freeze({ status: '/api/recover/status', challenge: '/api/recover/challenge', run: '/api/recover' });
// The variables the script gets from this server's own environment, besides HOME and
// PATH (set here) and LANG (kept, or en_US.UTF-8). xcrun_nocache is the watch job's.
export const RECOVER_ENV_KEYS = Object.freeze(['USER', 'LOGNAME', 'SHELL', 'TMPDIR']);
export const NO_ANSWER_LINE = 'No answer from jarvis-recover after 45 minutes; see ~/Library/Logs/jarvis-recover.log';
// A run the ledger still has as `starting` when this server starts: the server stopped
// between writing it down and recording the script's pid, so the script may have run
// and is not watched. Closed like a run with no answer (Ultron's L2, 11-20).
export const CRASHED_START_LINE = 'The Control Room restarted while starting jarvis-recover; it may have run; see ~/Library/Logs/jarvis-recover.log';
// The stop flag jarvis-start leaves after a deliberate stop (c1e78ff5), under the home.
export const STOP_FLAG_PARTS = Object.freeze(['.local', 'state', 'jarvis', 'jarvis-stopped']);
// The word a confirm sends in `stopRuns` when the page said the runs can't be seen.
export const UNSEEN = 'unseen';
// At most this many entries in a confirm's `stopRuns`; more is not a confirm.
export const STOP_RUNS_MAX = 64;
const RUN_HASH = /^[a-f0-9]{16}$/;
const HEALTH_WORDS = new Set(['up', 'down', 'unknown']);
const NO_STORE = { 'Cache-Control': 'no-store' };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const VERDICTS = new Set(['starting', 'running', 'ok', 'degraded', 'not-ok', 'unknown']);
const RUN_ID = /^[a-f0-9]{16}$/;

// Config's `recover`: { "enabled": true } turns the button on. Anything else keeps it off.
export function readRecoverConfig(config) {
  const problems = [];
  const raw = config?.recover;
  if (raw === undefined || raw === null) return { on: false, state: 'unset', problems };
  if (!isObject(raw)) { problems.push('recover is not an object; Restart Jarvis from the page stays off'); return { on: false, state: 'off', problems }; }
  for (const k of Object.keys(raw)) if (k !== 'enabled') problems.push(`recover.${k} is not a setting (only "enabled"); it is ignored`);
  if (raw.enabled === true) return { on: true, state: 'on', problems };
  if (raw.enabled !== false && raw.enabled !== undefined) problems.push('recover.enabled must be true or false; Restart Jarvis from the page stays off');
  return { on: false, state: 'off', problems };
}

// The program: always this shell, this file, this folder.
export function recoverProgram(home) {
  return { file: SHELL, args: [join(home, ...SCRIPT_PARTS)], cwd: join(home, 'Projects') };
}

// The script's environment, built here: never this server's whole one.
export function recoverEnv(home, base = process.env) {
  const env = {
    HOME: home,
    PATH: `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: typeof base?.LANG === 'string' && base.LANG ? base.LANG : 'en_US.UTF-8',
    xcrun_nocache: '1'
  };
  for (const k of RECOVER_ENV_KEYS) if (typeof base?.[k] === 'string' && base[k] !== '') env[k] = base[k];
  return env;
}

// The last line with any text in it, its trailing spaces off; '' when there is none.
export function lastLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim() !== '');
  return lines.length ? lines[lines.length - 1] : '';
}

// A line as it may be shown, logged and alerted: withheld when it looks like a
// credential (the pattern's name, never the match), else one line of at most LINE_MAX.
export function cleanLine(line) {
  const shapes = secretShapes(line);
  if (shapes.length) return `(the last line was withheld: it looked like ${shapes.join(', ')}; see ~/Library/Logs/jarvis-recover.log)`;
  return oneLine(String(line ?? '').trim(), LINE_MAX);
}

// The run's result from its last line and how it ended. The script's own words decide
// first; with no verdict line, an exit of 0 is "unknown" and anything else "not-ok".
export function verdictOf(line, exit = null, signal = null) {
  const l = String(line ?? '');
  if (l.startsWith('NOT OK:')) return 'not-ok';
  if (signal) return 'not-ok';
  if (l.startsWith('OK, degraded:')) return exit === null || exit === 0 ? 'degraded' : 'not-ok';
  if (l.startsWith('OK:')) return exit === null || exit === 0 ? 'ok' : 'not-ok';
  if (exit !== null && exit !== 0) return 'not-ok';
  return 'unknown';
}

// What the page may see of a run: never the pid or the output's file.
export const publicRun = r => (r ? { id: r.id, by: r.by, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, verdict: r.verdict, line: r.line ?? '', exit: r.exit ?? null } : null);

// What the health panel (collectors/health.mjs: `{ services }`, as cache.get gives it)
// says of the lead's session: 'up', 'down' or 'unknown'. The lead is the `session`
// service named like the roster's lead, else the only `session` there is (the page's
// leadService, web/src/lib/orbit/runbook.js). A panel that isn't current says 'unknown'.
export function leadHealth(panel, leadName) {
  if (panel?.status !== 'ok') return 'unknown';
  const sessions = (Array.isArray(panel?.data?.services) ? panel.data.services : []).filter(s => s?.kind === 'session');
  let lead = typeof leadName === 'string' && leadName !== '' ? sessions.find(s => s.name === leadName) : null;
  if (!lead && sessions.length === 1) lead = sessions[0];
  return lead && HEALTH_WORDS.has(lead.state) ? lead.state : 'unknown';
}

// The agent runs a restart of the lead would stop: the live agents panel's subagent runs
// in the session named as the lead's (the roster's first agent). A `claude -p --agent`
// run is a process of its own, and a subagent of another session lives in that session:
// a restart of the lead stops neither. `panel` is the cache's `sessions` entry
// ({ status, data }); `known` is false unless it is current, and its runs, if any, are
// still listed (they may be going). A list over the panel's bound (`more`) is not known
// either. Each run: its id (the panel's hash), the agent's roster name (or the
// subagent's type), and when it last wrote.
//
// Nor is a read that missed something (Ultron's M1 on d8f27c49, board 54b191ec): a
// transcript or .meta.json that could not be read (`unreadablePaths`), or a root that
// could not be listed (`unavailableRoots`), may be the lead's or a run's, and the list
// would come back short with nothing to say so; a panel without both lists can't show
// it was whole. Nor is a list with a live subagent in no named session (`unplaced`, Ultron's
// M1 on this fix): the lead's current session before its name line is read puts his runs
// there, so they would drop out of his list; a panel that doesn't count them can't say.
const missedSome = data => !Array.isArray(data?.unreadablePaths) || !Array.isArray(data?.unavailableRoots)
  || data.unreadablePaths.length > 0 || data.unavailableRoots.length > 0;
export function runsAtRisk(panel, roster) {
  const live = panel?.data?.liveAgents;
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const lead = agents[0] ?? null;
  const rows = isObject(live) && Array.isArray(live.runs) ? live.runs : null;
  const known = panel?.status === 'ok' && rows !== null && lead !== null && !(Number.isFinite(live.more) && live.more > 0)
    && !missedSome(panel.data) && live.unplaced === 0;
  const runs = [];
  if (rows === null || lead === null) return { known: false, runs };
  for (const r of rows) {
    if (!isObject(r) || r.direct === true || r.session !== lead.name || typeof r.id !== 'string' || !RUN_HASH.test(r.id)) continue;
    const agent = typeof r.agent === 'string' ? agents.find(a => a.key === r.agent) : null;
    const name = agent?.name ?? (typeof r.type === 'string' && r.type !== '' ? r.type : 'subagent');
    runs.push({ id: r.id, name, last: Number.isFinite(r.last) ? r.last : Number.isFinite(r.start) ? r.start : null });
  }
  return { known, runs };
}

// The confirm a POST must carry for these runs: every run's id, and UNSEEN when the list
// isn't known. `sent` is the body's `stopRuns`; anything but an array of strings is none.
// Returns the ids missing from it ([] when the restart may go).
export function missingConfirm(atRisk, sent) {
  const have = new Set(Array.isArray(sent) && sent.length <= STOP_RUNS_MAX ? sent.filter(v => typeof v === 'string') : []);
  const need = (atRisk?.runs ?? []).map(r => r.id);
  if (atRisk?.known !== true) need.push(UNSEEN);
  return need.filter(id => !have.has(id));
}

const defaultIsAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

async function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// `home` is the owner's home; `dir` the chat's folder (the ledger and the outputs go in
// it). `stepUp` is lib/stepup.mjs's. `enabled` is config's switch, `killed()` the kill file.
export function createRecover({
  home, dir, stepUp, enabled = false, killed = () => false,
  now = () => Date.now(), spawn = nodeSpawn, isAlive = defaultIsAlive, exists = path => access(path, constants.R_OK).then(() => true, () => false),
  onEvent = () => {}, log: logLine = console.log, watchMs = WATCH_MS, setTimer = setTimeout, clearTimer = clearTimeout,
  setRepeat = setInterval, clearRepeat = clearInterval, env = process.env,
  health = () => 'unknown', stopped = null, liveAgents = () => null, roster = null
}) {
  const ledgerPath = join(dir, 'recover.json');
  const outDir = join(dir, 'recover');
  const program = recoverProgram(home);
  const log = line => logLine(oneLine(line));
  // What health and the stop flag show now (Q1). Neither can fail a request.
  const stopFlag = join(home, ...STOP_FLAG_PARTS);
  const isStopped = stopped ?? (() => existsSync(stopFlag));
  function jarvisNow() {
    let h = 'unknown', s = false;
    try { const v = health(); if (HEALTH_WORDS.has(v)) h = v; } catch { h = 'unknown'; }
    try { s = isStopped() === true; } catch { s = false; }
    return { health: h, stopped: s };
  }
  // The agent runs a restart would stop, now. It can't fail a request: a broken read is
  // "not known", which asks for the confirm.
  function agentsNow() {
    try { return runsAtRisk(liveAgents(), roster); } catch { return { known: false, runs: [] }; }
  }
  let runs = [];          // oldest first
  let current = null;     // the run going now (starting or running), or null
  const timers = new Set();
  const repeats = new Set();
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  const persist = () => serial(() => writeJson(ledgerPath, runs.slice(-KEEP_RUNS)));

  const later = (fn, ms) => { const t = setTimer(() => { timers.delete(t); fn(); }, ms); t?.unref?.(); timers.add(t); return t; };
  const every = (fn, ms) => { const t = setRepeat(fn, ms); t?.unref?.(); repeats.add(t); return t; };
  const outPath = r => join(outDir, `run-${r.startedAt}-${r.id}.out`);

  async function readTail(path) {
    let fh;
    try {
      fh = await open(path, 'r');
      const { size } = await fh.stat();
      const len = Math.min(size, OUT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    } catch { return ''; } finally { await fh?.close().catch(() => {}); }
  }

  // Only the newest KEEP_OUTS outputs stay (their names sort by start time).
  async function sweepOuts() {
    let names;
    try { names = (await readdir(outDir)).filter(n => /^run-\d+-[a-f0-9]{16}\.out$/.test(n)).sort(); } catch { return; }
    for (const n of names.slice(0, Math.max(0, names.length - KEEP_OUTS))) await unlink(join(outDir, n)).catch(() => {});
  }

  // A run's end: its last line, its verdict, the ledger, the log and the alert. A run
  // closed with no answer (NO_ANSWER_MS) is still brought up to date when it ends.
  async function finish(r, { exit = null, signal = null, line = null } = {}) {
    if (r.finishedAt !== null && !r.noAnswer) return;
    const raw = line ?? lastLine(await readTail(outPath(r)));
    r.line = raw === '' ? (signal ? `jarvis-recover was stopped (${signal}) before its last line` : 'jarvis-recover printed nothing') : cleanLine(raw);
    r.exit = Number.isInteger(exit) ? exit : null;
    r.verdict = verdictOf(raw, r.exit, signal);
    r.finishedAt = now();
    delete r.noAnswer;
    if (current === r) current = null;
    await persist().catch(err => log(`recover: the ledger could not be written (${err?.code ?? err?.name ?? 'error'})`));
    log(`recover: run ${r.id} ended (${signal ? signal : r.exit === null ? 'exit unknown' : `exit ${r.exit}`}): ${r.line}`);
    onEvent({ kind: 'recover-done', device: r.by, verdict: r.verdict, line: r.line });
    sweepOuts().catch(() => {});
  }

  function noAnswerLater(r) {
    const left = r.startedAt + NO_ANSWER_MS - now();
    later(() => {
      if (r.finishedAt !== null || current !== r) return;
      r.finishedAt = now();
      r.verdict = 'unknown';
      r.line = NO_ANSWER_LINE;
      r.noAnswer = true;
      current = null;
      persist().catch(() => {});
      log(`recover: run ${r.id} has not ended after ${NO_ANSWER_MS / 60e3} minutes; a new run may start`);
      onEvent({ kind: 'recover-done', device: r.by, verdict: 'unknown', line: r.line });
    }, Math.max(0, left));
  }

  // A run this server didn't start, or started before a restart: watched by its pid.
  function watchPid(r) {
    const t = every(() => {
      if (isAlive(r.pid)) return;
      clearRepeat(t);
      repeats.delete(t);
      finish(r).catch(() => {});
    }, watchMs);
  }

  async function load() {
    try {
      const raw = JSON.parse(await readFile(ledgerPath, 'utf8'));
      runs = Array.isArray(raw) ? raw.filter(r => isObject(r) && typeof r.id === 'string' && RUN_ID.test(r.id) && Number.isFinite(r.startedAt) && VERDICTS.has(r.verdict)).map(r => ({ ...r, finishedAt: Number.isFinite(r.finishedAt) ? r.finishedAt : null })) : [];
    } catch { runs = []; }
    // A run the last process left going: watched to its end, or closed now.
    for (const r of runs.filter(x => x.verdict === 'starting' || x.verdict === 'running')) {
      if (r.verdict === 'running' && isAlive(r.pid) && now() - r.startedAt < NO_ANSWER_MS) {
        current = r;
        noAnswerLater(r);
        watchPid(r);
        log(`recover: run ${r.id} (pid ${r.pid}) is still going after this server's restart; watching it`);
      } else if (r.verdict === 'running') {
        await finish(r);
      } else {
        // Still `starting`: the script may have run, unwatched (L2). Closed like a run
        // with no answer, never as NOT OK: nothing here knows how it went.
        r.finishedAt = now();
        r.verdict = 'unknown';
        r.line = CRASHED_START_LINE;
        await persist().catch(err => log(`recover: the ledger could not be written (${err?.code ?? err?.name ?? 'error'})`));
        log(`recover: run ${r.id} was still starting when this server stopped; it may have run (see ~/Library/Logs/jarvis-recover.log)`);
        onEvent({ kind: 'recover-done', device: r.by, verdict: r.verdict, line: r.line });
      }
    }
    return runs.length;
  }

  // Why a run can't start now, or null. `nextAt` is when the caps let one start.
  function blocked(at = now()) {
    if (!enabled) return { why: 'Restart Jarvis from the page is off (config recover.enabled)', status: 403, nextAt: null };
    let off = false;
    try { off = killed() === true; } catch { off = false; }
    if (off) return { why: `Restart Jarvis from the page is off: the kill file ${KILL_FILE} is there`, status: 503, nextAt: null };
    if (current) return { why: `a restart is already going (asked from ${current.by} at ${new Date(current.startedAt).toISOString().slice(11, 16)} UTC)`, status: 409, nextAt: null };
    const hour = runs.filter(r => at - r.startedAt < HOUR_MS);
    const day = runs.filter(r => at - r.startedAt < DAY_MS);
    if (hour.length >= RUNS_PER_HOUR) return { why: `${RUNS_PER_HOUR} restarts in the last hour already; paste the command in a terminal, or wait`, status: 429, nextAt: hour[0].startedAt + HOUR_MS };
    if (day.length >= RUNS_PER_DAY) return { why: `${RUNS_PER_DAY} restarts in the last day already; paste the command in a terminal, or wait`, status: 429, nextAt: day[0].startedAt + DAY_MS };
    return null;
  }

  // Starts the one program. The run is the current one before any await, so two taps
  // at once start one run; it is in the ledger before the script starts.
  async function start(by, stops = null) {
    const no = blocked();
    if (no) return { ok: false, status: no.status, error: no.why };
    const seen = jarvisNow();
    const stopping = Array.isArray(stops?.runs) ? stops.runs.map(x => x.name) : [];
    const r = { id: randomBytes(8).toString('hex'), by, startedAt: now(), finishedAt: null, verdict: 'starting', line: '', exit: null, pid: null, health: seen.health, stopped: seen.stopped };
    current = r;
    runs.push(r);
    if (runs.length > KEEP_RUNS) runs = runs.slice(-KEEP_RUNS);
    const fail = async (status, error) => {
      await finish(r, { line: `NOT OK: ${error}` });
      return { ok: false, status, error };
    };
    if (!(await exists(program.args[0]))) return fail(503, 'the recovery script is not there (~/Projects/.worktrees/jarvis-release/bin/jarvis-recover); paste the run sheet\'s line in a terminal');
    let fh;
    try {
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      await persist();
      fh = await open(outPath(r), 'wx', 0o600);
    } catch (err) {
      await fh?.close().catch(() => {});
      return fail(503, `the run could not be set up (${err?.code ?? err?.name ?? 'error'})`);
    }
    let child;
    try {
      child = spawn(program.file, program.args, { cwd: program.cwd, env: recoverEnv(home, env), stdio: ['ignore', fh.fd, fh.fd], detached: true });
    } catch (err) {
      await fh.close().catch(() => {});
      return fail(503, `jarvis-recover could not be started (${err?.code ?? err?.name ?? 'error'})`);
    }
    await fh.close().catch(() => {});
    let ended = false;
    child.on('error', err => { if (ended) return; ended = true; finish(r, { line: `NOT OK: jarvis-recover could not be started (${err?.code ?? err?.name ?? 'error'})` }).catch(() => {}); });
    child.on('exit', (code, signal) => { if (ended) return; ended = true; finish(r, { exit: code, signal }).catch(() => {}); });
    child.unref?.();
    r.pid = Number.isInteger(child.pid) ? child.pid : null;
    if (!ended) r.verdict = 'running';
    await persist().catch(err => log(`recover: the ledger could not be written (${err?.code ?? err?.name ?? 'error'})`));
    noAnswerLater(r);
    log(`recover: ${by} asked for a Jarvis restart (Face ID passed; health said ${seen.health}${seen.stopped ? ', the stop flag was there' : ''}${stopping.length ? `; it stops ${stopping.length} agent run${stopping.length === 1 ? '' : 's'}: ${stopping.join(', ')}` : ''}${stops && stops.known !== true ? '; the live agent runs could not be seen' : ''}); run ${r.id} started jarvis-recover${r.pid ? ` (pid ${r.pid})` : ''}`);
    onEvent({ kind: 'recover-asked', device: by, health: seen.health, stopped: seen.stopped, ...(stops ? { agentRuns: stopping, agentsKnown: stops.known === true } : {}) });
    return { ok: true, run: r };
  }

  // The newest finished run, and the one going.
  function view(at = now()) {
    const last = [...runs].reverse().find(r => r.finishedAt !== null) ?? null;
    const no = blocked(at);
    return { on: enabled, running: publicRun(current), last: publicRun(last), blocked: no ? no.why : null, nextAt: no?.nextAt ?? null, command: RECOVER_COMMAND, jarvis: jarvisNow(), agents: agentsNow() };
  }

  // ---- the routes (served by the chat's router) ----
  const owns = path => path === ROUTES.status || path === ROUTES.challenge || path === ROUTES.run;

  // `write`: the two POSTs, whose refusals are alerted (`recover-refused`, L4). A key's
  // refusal is alerted only from the owner's login (requireLogin, as for a heal tap):
  // anyone else is refused by the login check, unalerted.
  function gate(req, { requireDevice, requireLogin, notifyHosts }, write) {
    if (write) guardWrite(req);
    if (req.headers?.authorization !== undefined) {
      if (write && typeof requireLogin === 'function') {
        requireLogin(req);
        onEvent({ kind: 'recover-refused', why: 'key' });
      }
      throw new HttpError(403, 'a Shortcut key can never restart Jarvis');
    }
    const device = requireDevice(req);
    if (write) {
      const problem = verdictOriginProblem(req.headers, notifyHosts);
      if (problem) throw new HttpError(403, problem.replace('a verdict', 'a restart'));
    }
    if (device.approver !== true) {
      if (write) onEvent({ kind: 'recover-refused', why: 'not-approver', device: device.name });
      throw new HttpError(403, 'only an approver device can restart Jarvis');
    }
    return { device, origin: write ? new URL(req.headers.origin).origin : null };
  }

  async function handle(req, res, path, ctx) {
    if (path === ROUTES.status) {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only');
      const { device } = gate(req, ctx, false);
      const until = stepUp.pendingFor(device.id);
      return json(res, 200, { ...view(), passkey: stepUp.has(device.id), pending: until !== null, pendingUntil: until }, NO_STORE);
    }
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const { device, origin } = gate(req, ctx, true);
    // Asked before Face ID, so a refused restart never asks for it.
    const no = blocked();
    if (no) throw new HttpError(no.status, no.why);
    const body = await readBody(req);
    // The agent runs it would stop must each be named in the confirm (board d8f27c49):
    // checked before Face ID is asked or used, and again just before the run starts.
    const unconfirmed = () => {
      const atRisk = agentsNow();
      const missing = missingConfirm(atRisk, isObject(body) ? body.stopRuns : null);
      return missing.length ? atRisk : null;
    };
    const runsRefusal = atRisk => {
      const n = atRisk.runs.length;
      log(`recover: a restart from ${device.name} waits for a confirm: ${atRisk.known ? `${n} agent run${n === 1 ? '' : 's'} would stop` : 'the live agent runs could not be seen'}`);
      return json(res, 409, { error: atRisk.known ? `${n} agent run${n === 1 ? ' is' : 's are'} going; restarting stops ${n === 1 ? 'it' : 'them'}. Confirm to restart anyway.` : 'The Control Room can\'t see whether agent runs are going; restarting stops any that are. Confirm to restart anyway.', agents: atRisk }, NO_STORE);
    };
    const before = unconfirmed();
    if (before) return runsRefusal(before);
    if (path === ROUTES.challenge) {
      const r = stepUp.challenge(device.id, PURPOSE, origin);
      if (!r.ok) throw new HttpError(r.status, r.error);
      return json(res, 200, { publicKey: r.publicKey }, NO_STORE);
    }
    const v = await stepUp.verifyAssertion(device.id, PURPOSE, isObject(body) ? body : null, origin);
    if (!v.ok) {
      log(`recover: a restart from ${device.name} was refused (${v.error})`);
      onEvent({ kind: 'recover-refused', why: 'face-id', device: device.name, error: v.error });
      throw new HttpError(v.status, v.error);
    }
    // A run may have started while Face ID was up; nothing awaits between this and start's claim.
    const after = unconfirmed();
    if (after) return runsRefusal(after);
    const s = await start(device.name, agentsNow());
    if (!s.ok) { log(`recover: a restart from ${device.name} did not start (${s.error})`); throw new HttpError(s.status, s.error); }
    return json(res, 202, { ok: true, run: publicRun(s.run), note: 'Restarting Jarvis: the Mac mini runs jarvis-recover. It takes a minute or two; the result shows here.' }, NO_STORE);
  }

  const stop = () => { for (const t of timers) clearTimer(t); timers.clear(); for (const t of repeats) clearRepeat(t); repeats.clear(); };
  return { load, start, view, blocked, owns, handle, stop, idle: () => queue, program };
}
