// The ingest's own Unix socket (Ultron's M1 on the 2026-11-11 loopback guard). The
// loopback guard on the TCP port (lib/local-caller.mjs) tells a local program from the
// tailnet by the headers Tailscale Serve adds, which holds only while Serve proxies at
// the HTTP layer: a TCP forward, or any other forwarder on this machine, would make a
// tailnet request look local. A socket file needs no such inference. It sits in the
// owner's 0700 state folder (`~/.local/state/jarvis-os/ingest.sock`, or
// JARVIS_OS_INGEST_SOCKET), mode 0600, so only a process running as the owner can open
// it, the same trust as the files the collectors read. Before it listens, the folder is
// checked (this user's, 0700) and a stale socket file is removed only when nothing
// answers on it (lib/chat-listen.mjs); after, the socket file itself is checked (a
// socket, this user's, 0600) and its device and inode are kept. Any problem keeps the
// socket off and says why; a socket that failed its check is closed, which also removes
// it. While the server runs, the socket is watched (startIngestSocket): a close, an
// error, or a file at the path that is no longer the one bound (removed or replaced)
// turns it off and alerts once.
//
// Chosen over a per-install token (2026-11-12): a token is a secret to mint, keep in a
// 0600 file, compare in constant time, keep out of logs and rotate after a leak, and
// the hook would still post it to the TCP port. The socket has nothing to leak, and it
// takes the ingest off the port Serve shares.
import { createServer } from 'node:http';
import { lstatSync as fsLstatSync } from 'node:fs';
import { chmod as fsChmod, lstat as fsLstat } from 'node:fs/promises';
import { prepareSocketPath } from './chat-listen.mjs';

// The problems with the socket file: not there, not a socket, not this user's, or
// open to the group or the world. `lstat` so a symlink at the path is not followed.
export async function checkSocketFile(socketPath, { uid = process.getuid?.() ?? null, lstat = fsLstat } = {}) {
  let info;
  try {
    info = await lstat(socketPath);
  } catch {
    return [`the ingest socket ${socketPath} is not there`];
  }
  const problems = [];
  if (!info.isSocket()) problems.push(`${socketPath} is not a socket`);
  if (uid !== null && info.uid !== uid) problems.push(`the ingest socket ${socketPath} is not owned by this user`);
  if ((info.mode & 0o077) !== 0) problems.push(`the ingest socket ${socketPath} is mode ${(info.mode & 0o777).toString(8)}, not 0600`);
  return problems;
}

// Listen on the socket with `handler` (routes.mjs, createIngestHandler). Returns
// { server, problems, identity }: a server only when every check passed, and with it
// the socket file's `{ dev, ino }` (as BigInts, so a 64-bit inode compares exactly),
// which startIngestSocket checks the path against on each approval. `uid`, `lstat`
// and `chmod` are for the tests.
//
// The socket is bound under umask 077 (Ultron's 4-L1), so it is never open to others,
// even for the moment between the bind and the chmod; the umask is put back as soon
// as the listen settles. `umask` is for the tests.
export async function listenIngestSocket({ path, handler, uid, lstat, chmod = fsChmod, timeoutMs, onError = console.error, umask = m => process.umask(m) }) {
  const prepared = await prepareSocketPath(path, { uid, timeoutMs });
  if (!prepared.ok) return { server: null, problems: prepared.problems };
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      onError('ingest socket failed', err?.message ?? err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const before = umask(0o077);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    return { server: null, problems: [`the ingest socket did not start (${err?.code ?? err?.message ?? err})`] };
  } finally {
    umask(before);
  }
  let problems;
  let identity = null;
  try {
    await chmod(path, 0o600);
    problems = await checkSocketFile(path, { uid, lstat });
    if (!problems.length) {
      const info = await (lstat ?? fsLstat)(path, { bigint: true });
      identity = { dev: BigInt(info.dev), ino: BigInt(info.ino) };
    }
  } catch (err) {
    problems = [`the ingest socket's mode could not be set (${err?.code ?? err?.message ?? err})`];
  }
  if (problems.length) {
    await new Promise(resolve => server.close(resolve));
    return { server: null, problems, identity: null };
  }
  return { server, problems: [], identity };
}

// The socket at the server's start, tried a few times (Ultron's 4-M1): a socket that
// stays off after the hook swap would silence the PermissionDenied signal, and Allow
// would stay offered. So the first try is at once and the next ones INGEST_RETRY_MS
// apart (four tries over 30 s); each failed try logs its problems; after the last one
// the socket stays off, `onOff` hears it once (server.mjs: an alert to #pepper, fixed
// words, never a path), and the state says off, which caps the page's approvals at
// Deny-only unless the TCP route still takes needs-you posts (server.mjs, `ingestOk`).
//
// Once on, it is watched (Ultron's 11-12 low): the server's `close` or `error`, or a
// `check()` that finds the path no longer holds the socket file that was bound (gone,
// not a socket, or another device or inode), turns `on` off for good (a restart brings
// it back), logs why and sends the off alert, once per run with INGEST_LOST_ALERT's
// words. `check()` is a synchronous lstat, cheap enough for every approval (server.mjs,
// `ingestOk`): a socket file removed under a running server still listens, but no hook
// can reach it, and only the path says so.
//
// Returns the state at once: `on` turns true when a try succeeds; `done` settles after
// the last try; `lost` is the alert's promise once the socket is lost. `onOff(state,
// words)` hears the alert's words. `listen`, `sleep`, `lstatSync` are for the tests.
export const INGEST_TRIES = 4;
export const INGEST_RETRY_MS = 10e3;
export const INGEST_OFF_ALERT = 'The ingest socket did not start after 4 tries over 30 seconds, so the needs-you and PermissionDenied hooks reach nothing: no "waiting on you" signal, no classifier-block window. Allow on the page is held at Deny-only while it is off. The service log has the reason (ingest: lines); a restart retries.';
export const INGEST_LOST_ALERT = 'The ingest socket stopped while the server ran (it closed or failed, or its file was removed or replaced), so the needs-you and PermissionDenied hooks reach nothing: no "waiting on you" signal, no classifier-block window. Allow on the page is held at Deny-only while it is off. The service log has the reason (ingest: lines); a restart brings it back.';
export function startIngestSocket({
  path, handler,
  tries = INGEST_TRIES, retryMs = INGEST_RETRY_MS,
  listen = listenIngestSocket,
  sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }),
  log = console.log, logError = console.error,
  onOff = () => {},
  lstatSync = fsLstatSync
} = {}) {
  const state = { on: false, server: null, identity: null, tries: 0, problems: [], lost: null };
  // Called at most once a run: after the last failed try (the socket was never on), or
  // from `lose`, which runs only while it is on and turns it off for good.
  const alertOff = async words => {
    try { await onOff(state, words); } catch (err) { logError('ingest: the socket-off alert failed', err?.message ?? err); }
  };
  // Off for the rest of the run, said once.
  const lose = reason => {
    if (!state.on) return;
    state.on = false;
    state.problems = [reason];
    logError(`ingest: ${reason}; the ingest socket is off until a restart`);
    state.lost = alertOff(INGEST_LOST_ALERT);
  };
  // Whether the socket is on and its file is still the one bound. Never throws.
  state.check = () => {
    if (!state.on) return false;
    let info = null;
    try { info = lstatSync(path, { bigint: true }); } catch { info = null; }
    const id = state.identity;
    // isSocket too: a file system may hand a freed inode number to a new file.
    if (info && info.isSocket() && id && BigInt(info.dev) === id.dev && BigInt(info.ino) === id.ino) return true;
    lose(info ? 'the ingest socket file at the path is not the one bound (replaced)' : 'the ingest socket file was removed');
    return false;
  };
  state.done = (async () => {
    for (let k = 1; k <= tries; k++) {
      state.tries = k;
      let r;
      try { r = await listen({ path, handler }); } catch (err) { r = { server: null, problems: [`the ingest socket did not start (${err?.code ?? err?.message ?? err})`] }; }
      if (r.server) {
        state.on = true;
        state.server = r.server;
        state.identity = r.identity ?? null;
        state.problems = [];
        r.server.once('close', () => lose('the ingest socket closed'));
        r.server.on('error', err => lose(`the ingest socket failed (${err?.code ?? err?.message ?? err})`));
        if (k > 1) log(`ingest: the socket started on try ${k} of ${tries}`);
        return state;
      }
      state.problems = r.problems;
      const last = k === tries;
      for (const problem of r.problems) {
        logError(`ingest: ${problem}; ${last ? `the ingest socket stays off after ${tries} tries` : `trying again in ${Math.round(retryMs / 1000)} s (try ${k} of ${tries})`}`);
      }
      if (!last) await sleep(retryMs);
    }
    await alertOff(INGEST_OFF_ALERT);
    return state;
  })();
  return state;
}

// The TCP route's transition (routes.mjs, `ingest.tcp: "legacy"`): each post to the
// needs-you route there is reported here, whether the route took it or the loopback
// guard refused it. The log gets a line on the first post to a route and then at most
// one an hour, with the counts since the last line: how many the route took, how many
// carried a proxy header (and were refused, Serve or another proxy) and how many were
// refused otherwise. Posts held inside the hour are written when the hour ends, so a
// trailing post is never left unreported (Ultron's 4-M2). The alert, for a post the
// route took, goes out at most once a day. Fixed words: the route's path is one of
// routes.mjs's own, never the caller's.
export const LEGACY_LOG_EVERY_MS = 60 * 60e3;
export const LEGACY_ALERT_EVERY_MS = 24 * 60 * 60e3;
export const LEGACY_ALERT = 'Something on this machine, or a forwarder, posted to the old TCP ingest (needs-you). If it is a Claude Code hook, move it to the ingest socket; if nothing here should post there, set ingest.tcp to "off" in config (README, "What the ingest endpoints require")';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const legacyLogLine = (path, seen, first) =>
  `ingest: ${plural(seen.count, 'post', 'posts')} to ${path} over TCP, the old route, ${first ? 'the first since the start' : 'since the last such line'}` +
  ` (${seen.taken} taken, ${seen.proxied} with a proxy header, refused, ${seen.count - seen.taken - seen.proxied} refused otherwise)` +
  `; move the hooks to the ingest socket (README, "What the ingest endpoints require")`;

// `setTimer(fn, ms)` schedules the end of an hour's line (unref'd, so it never keeps
// the process up).
export function createLegacyNotice({
  log = console.log,
  alert = null,
  clock = () => Date.now(),
  logEveryMs = LEGACY_LOG_EVERY_MS,
  alertEveryMs = LEGACY_ALERT_EVERY_MS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  onError = () => {}
} = {}) {
  const routes = new Map(); // path -> { loggedAt, count, taken, proxied, timer }
  let alertedAt = null;
  const write = (path, seen, now) => {
    log(legacyLogLine(path, seen, seen.loggedAt === null));
    seen.loggedAt = now;
    seen.count = 0;
    seen.taken = 0;
    seen.proxied = 0;
    seen.timer = false;
  };
  // The hour's end: the posts held since the line written at `since`, if any. A timer
  // that outlived its hour (a post after the hour already wrote the line) finds a
  // newer line and does nothing, so it can't write the next hour's line early.
  const flush = (path, since) => {
    const seen = routes.get(path);
    if (!seen || seen.loggedAt !== since) return;
    seen.timer = false;
    if (seen.count > 0) write(path, seen, clock());
  };
  // `taken`: the route took it (it passed the loopback guard); `proxied`: it carried
  // a header a proxy adds (lib/local-caller.mjs, PROXY_HEADERS).
  return function notice(path, { taken = true, proxied = false } = {}) {
    const now = clock();
    const seen = routes.get(path) ?? { loggedAt: null, count: 0, taken: 0, proxied: 0, timer: false };
    seen.count += 1;
    if (taken) seen.taken += 1;
    else if (proxied) seen.proxied += 1;
    routes.set(path, seen);
    if (seen.loggedAt === null || now - seen.loggedAt >= logEveryMs) write(path, seen, now);
    else if (!seen.timer) {
      seen.timer = true;
      const since = seen.loggedAt;
      setTimer(() => flush(path, since), since + logEveryMs - now);
    }
    if (taken && alert && (alertedAt === null || now - alertedAt >= alertEveryMs)) {
      alertedAt = now;
      Promise.resolve().then(() => alert(LEGACY_ALERT)).catch(onError);
    }
  };
}
