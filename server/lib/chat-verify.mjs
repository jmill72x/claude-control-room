// Who may say hello (Ultron's channel-fixes review, finding 1, and his final read of
// jos/events, 2026-11-11): after a bye always, and on every hello without a valid
// session token once `chat.channelServer` is set.
// The channel says bye on SIGINT, SIGTERM and SIGHUP, which any process running as the
// owner can send; without a check, that process could then say hello and take the
// channel's place with nothing louder than the quiet "channel restarted" notice. So the
// hello that follows a bye must come from a pid that:
//   (a) is alive (listed by ps);
//   (b) runs exactly `node <chat.channelServer>` (an absolute path in config, the released
//       channel's server.mjs; the executable's base name must be `node`, and nothing else
//       may follow the path);
//   (c) descends, within 8 parent hops, from the pid in `launch.json` (`{"pid": N}`,
//       written by the lead's launcher; a regular file, never a symlink, owned by this
//       user, no group or world bits).
// After a bye, also (d) the process must have started no earlier than 2 s before the bye
// (ps's lstart), and the socket refuses the pid that said bye itself: a pid is only
// declared, and the dying channel's own pid, stopped with SIGSTOP, passes (a)-(c).
// Any failure, a ps error or a missing setting fails closed: the socket refuses the hello
// (409) and alerts it as a takeover (lib/chat-socket.mjs). Reasons are fixed words.
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, basename } from 'node:path';

export const PS_TIMEOUT_MS = 2000;
export const MAX_HOPS = 8;
export const LAUNCH_MAX_BYTES = 4096;
const SAFE_PATH = /^\/[A-Za-z0-9._\/-]{1,500}$/;

// config.chat.channelServer: the absolute path of the released channel's server.mjs.
export function readChannelServer(config) {
  const raw = config?.chat?.channelServer;
  if (raw === undefined || raw === null) {
    return { path: null, problems: config?.chat ? ['chat.channelServer is not set, so a channel that says bye can\'t come back until it is (every hello after a bye is refused and alerted)'] : [] };
  }
  if (typeof raw !== 'string' || !isAbsolute(raw) || !SAFE_PATH.test(raw) || !raw.endsWith('/server.mjs')) {
    return { path: null, problems: ['chat.channelServer must be the absolute path of the channel\'s server.mjs (letters, digits, . _ - and /); every hello after a bye is refused until it is'] };
  }
  return { path: raw, problems: [] };
}

// ps's table of every process: pid -> { ppid, startedAt, command }. A fixed argv, no
// shell, the C locale (so lstart's day and month names are English) and this process's
// TZ, if one is set, so ps and parseLstart read the same local time.
export const PS_ARGS = Object.freeze(['-axww', '-o', 'pid=,ppid=,lstart=,command=']);
export function runPs({ timeoutMs = PS_TIMEOUT_MS } = {}) {
  const env = { LC_ALL: 'C', PATH: '/usr/bin:/bin', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) };
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', [...PS_ARGS], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout) => {
      if (err) return reject(new Error('ps failed'));
      resolve(stdout);
    });
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LSTART = /^\s*(\d+)\s+(\d+)\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s(.*)$/;

// lstart's fields (`Wed Nov 11 09:14:03 2026`, the C locale) as epoch ms in local time,
// or null when they don't make a real moment (a wrong weekday included).
export function parseLstart(day, mon, date, hh, mm, ss, year) {
  const month = MONTHS.indexOf(mon);
  if (month < 0) return null;
  const d = new Date(Number(year), month, Number(date), Number(hh), Number(mm), Number(ss));
  if (d.getDate() !== Number(date) || d.getHours() !== Number(hh) || DAYS[d.getDay()] !== day) return null;
  return d.getTime();
}

export function parsePs(text) {
  const table = new Map();
  for (const line of String(text).split('\n')) {
    const m = LSTART.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), startedAt: parseLstart(m[3], m[4], m[5], m[6], m[7], m[8], m[9]), command: m[10].trim() });
  }
  return table;
}

// `{"pid": N}` from the launcher's file: opened without following a symlink, a regular
// file of this user's with no group or world bits, small, a whole pid above 1.
export async function readLaunchPid(path, { uid = process.getuid?.() ?? null } = {}) {
  let handle;
  try {
    // O_NONBLOCK: a FIFO planted at the path must not hang the hello on open.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return { pid: null, reason: err?.code === 'ELOOP' ? 'launch.json is a symlink' : 'launch.json could not be opened' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { pid: null, reason: 'launch.json is not a regular file' };
    if (uid !== null && info.uid !== uid) return { pid: null, reason: 'launch.json is not this user\'s' };
    if ((info.mode & 0o077) !== 0) return { pid: null, reason: 'launch.json is readable or writable by others' };
    if (info.size > LAUNCH_MAX_BYTES) return { pid: null, reason: 'launch.json is too big' };
    let parsed;
    try { parsed = JSON.parse(await handle.readFile('utf8')); } catch { return { pid: null, reason: 'launch.json is not JSON' }; }
    const pid = parsed?.pid;
    if (!Number.isInteger(pid) || pid <= 1) return { pid: null, reason: 'launch.json holds no pid' };
    return { pid, reason: null };
  } finally {
    await handle.close();
  }
}

// Whether a ps command line is exactly `node <server>`.
export function isChannelCommand(command, server) {
  if (typeof command !== 'string' || typeof server !== 'string') return false;
  const suffix = ` ${server}`;
  if (!command.endsWith(suffix)) return false;
  const exe = command.slice(0, -suffix.length);
  return exe.length > 0 && !/\s/.test(exe) && basename(exe) === 'node';
}

// verify(pid, { notBefore }) -> { ok: true } | { ok: false, reason }. With `notBefore`
// (after a bye), the process must have started at or after it.
export function createChannelVerifier({ channelServer, launchPath, ps = runPs, readLaunch = p => readLaunchPid(p) }) {
  return async function verify(pid, { notBefore = null } = {}) {
    if (!channelServer) return { ok: false, reason: 'chat.channelServer is not set' };
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'the hello named no pid' };
    let table;
    try { table = parsePs(await ps()); } catch { return { ok: false, reason: 'ps failed' }; }
    const self = table.get(pid);
    if (!self) return { ok: false, reason: 'no such process' };
    if (!isChannelCommand(self.command, channelServer)) return { ok: false, reason: 'the process is not the released channel' };
    if (notBefore !== null && !(Number.isFinite(self.startedAt) && self.startedAt >= notBefore)) return { ok: false, reason: 'the process started before the bye' };
    const launch = await readLaunch(launchPath).catch(() => ({ pid: null, reason: 'launch.json could not be read' }));
    if (!launch?.pid) return { ok: false, reason: launch?.reason ?? 'launch.json holds no pid' };
    let at = self.ppid;
    for (let hop = 0; hop < MAX_HOPS && at > 1; hop++) {
      if (at === launch.pid) return { ok: true };
      const parent = table.get(at);
      if (!parent) break;
      at = parent.ppid;
    }
    return { ok: false, reason: 'the process does not descend from the lead\'s launch' };
  };
}
