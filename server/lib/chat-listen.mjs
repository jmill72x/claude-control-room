// Where the chat's Unix sockets may go (jarvis-os-chat-spec.md §1.5, and the
// 2026-11-11 review, 9): the folder that holds a socket must be this user's and
// closed to everyone else (0700), whether it is the default under
// ~/.local/state/jarvis-os or an override from JARVIS_OS_SOCKET or
// JARVIS_OS_ADMIN_SOCKET; and a socket file is unlinked only when nothing answers
// on it, so a second server started by mistake never pulls the live one's socket
// out from under it. A problem here keeps the chat off; the rest of the dashboard
// runs as before.
import { stat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname } from 'node:path';

export const ANSWER_TIMEOUT_MS = 1000;

// The problems with the folder a socket would sit in: not there, not a folder,
// not ours, or open to the group or the world.
export async function checkSocketDir(socketPath, { uid = process.getuid?.() ?? null } = {}) {
  const dir = dirname(socketPath);
  let info;
  try {
    info = await stat(dir);
  } catch {
    return [`the socket folder ${dir} does not exist`];
  }
  const problems = [];
  if (!info.isDirectory()) problems.push(`the socket folder ${dir} is not a folder`);
  if (uid !== null && info.uid !== uid) problems.push(`the socket folder ${dir} is not owned by this user`);
  if ((info.mode & 0o077) !== 0) problems.push(`the socket folder ${dir} is mode ${(info.mode & 0o777).toString(8)}, not 0700`);
  return problems;
}

// Whether a server answers on the socket path now. A connection that opens means
// yes; ENOENT or ECONNREFUSED (a stale file nobody listens on) means no; any other
// failure, or no answer within the timeout, counts as yes, since unlinking on a
// doubt is the one thing this must never do.
export function socketAnswering(socketPath, timeoutMs = ANSWER_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const sock = connect(socketPath);
    const timer = setTimeout(() => done(true), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', err => done(!(err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED')));
  });
}

// Make the path ready to listen on: the folder checked, and a stale socket file
// removed. Returns { ok, problems }; with ok false nothing was unlinked.
export async function prepareSocketPath(socketPath, { uid, timeoutMs } = {}) {
  const problems = await checkSocketDir(socketPath, { uid });
  if (problems.length) return { ok: false, problems };
  if (await socketAnswering(socketPath, timeoutMs)) {
    return { ok: false, problems: [`a server is already answering on ${socketPath}; this one leaves it alone`] };
  }
  await unlink(socketPath).catch(() => {});
  return { ok: true, problems: [] };
}
