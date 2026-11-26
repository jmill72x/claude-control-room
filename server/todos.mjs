import { readFile, writeFile, mkdir, rename, unlink, readdir, realpath, stat, link } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, join, basename, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { AGENT_KEY } from './lib/roster.mjs';
import { UNSAFE_CHARS, UNSAFE_SAYS } from './lib/text.mjs';
import { hasHiddenChars } from './lib/hidden-chars.mjs';

const LANES = new Set(['idea', 'doing', 'done']);
// Priority is optional: absent or null means "not set", and the UI renders
// that as a dashed placeholder rather than inventing a rank. Anything else
// must be one of these four, so a typo can never sort as if it were P0.
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
// A due date is optional too: absent, null or '' means none. Anything else
// must be a real calendar date written YYYY-MM-DD, a plain local date on the
// mini's clock with no time of day. It is stored exactly as sent, never
// normalised, so what Jarvis wrote is what Jarvis reads back.
const DUE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isDueDate = v => {
  const m = typeof v === 'string' && DUE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};

// Raised when a write carries an item the board cannot hold (an unknown
// lane, a priority outside P0-P3, a malformed due date). Nothing is written,
// and the route answers 400 with the message rather than a 500.
export class InvalidBoardError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_BOARD';
  }
}

// The optional fields from the Orbit plan. Each is checked on every write, a bad
// one is refused with the item and the field named, and a good one is stored as
// sent. Lengths count characters, not UTF-16 units, so an emoji counts once.
const chars = s => [...s].length;
// A tag is a short name shown as a chip on the page and in the mod: at most TAG_MAX
// characters once trimmed (the page trims, and unifyTags below), with none of the
// shared hidden characters (lib/hidden-chars.mjs's line set: board e6178bb9, Ultron
// 11-18; the title's UNSAFE_CHARS let a soft hyphen or a tag character make a
// look-alike area). The page's New item form (board 14a66582) checks it by this same
// set before it is sent (web/src/lib/orbit/board.js). Titles keep UNSAFE_CHARS, which
// allows the emoji joiner.
export const TAG_MAX = 40;
const none = v => v === undefined || v === null || v === '';
const ASK_KINDS = new Set(['decide', 'do']);
const ASK_FIELDS = new Set(['what', 'why', 'kind', 'time']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// A date and a time with its offset, as toISOString() writes it or with an
// offset such as -04:00. A bare date is refused: Done is ordered by this.
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
export const isInstant = v => {
  const m = typeof v === 'string' && ISO_INSTANT.exec(v);
  return Boolean(m) && isDueDate(m[1]) && Number.isFinite(Date.parse(v));
};


function checkFields(t) {
  const bad = message => new InvalidBoardError(`item ${JSON.stringify(t.id)}: ${message}`);
  if (!none(t.title) && (typeof t.title !== 'string' || chars(t.title) > 120)) {
    throw bad('title must be text of at most 120 characters, or empty for none');
  }
  if (typeof t.title === 'string' && UNSAFE_CHARS.test(t.title)) throw bad(`title ${UNSAFE_SAYS}`);
  if (!none(t.owner) && (typeof t.owner !== 'string' || !AGENT_KEY.test(t.owner))) {
    throw bad('owner must be an agent key (lowercase letters, digits and hyphens), or empty for none');
  }
  if (!none(t.doneAt) && !isInstant(t.doneAt)) {
    throw bad(`doneAt must be an ISO 8601 date and time, such as 2026-10-21T13:05:00.000Z (got ${JSON.stringify(t.doneAt)})`);
  }
  // createdAt (board 17924110): null is "unknown", the mark every item made before the
  // server stamped it carries. Left out, the server fills it in (stampCreated).
  if (t.createdAt !== undefined && t.createdAt !== null && !isInstant(t.createdAt)) {
    throw bad(`createdAt must be an ISO 8601 date and time, or null for unknown (got ${JSON.stringify(t.createdAt)})`);
  }
  if (t.restoredAt !== undefined && !isInstant(t.restoredAt)) {
    throw bad(`restoredAt must be an ISO 8601 date and time, or left out (got ${JSON.stringify(t.restoredAt)})`);
  }
  // archivedAt lives only in the archive file: an item that carries one on the live
  // board was copied from the archive by hand, and bringing one back is the archive's
  // own route (POST /api/todos/archive/restore), which takes it off.
  if (t.archivedAt !== undefined) throw bad('archivedAt is kept only in the archive; bring an item back with POST /api/todos/archive/restore');
  if (t.ask === undefined || t.ask === null) return;
  const ask = t.ask;
  if (typeof ask !== 'object' || Array.isArray(ask)) throw bad('ask must be an object with what, kind and optionally why and time, or null for none');
  for (const key of Object.keys(ask)) if (!ASK_FIELDS.has(key)) throw bad(`ask.${key} is not a field ask takes (what, why, kind, time)`);
  if (typeof ask.what !== 'string' || ask.what.trim() === '' || chars(ask.what) > 500) throw bad('ask.what must be text of 1 to 500 characters');
  if (UNSAFE_CHARS.test(ask.what)) throw bad(`ask.what ${UNSAFE_SAYS}`);
  if (!none(ask.why) && (typeof ask.why !== 'string' || chars(ask.why) > 300)) throw bad('ask.why must be text of at most 300 characters');
  if (typeof ask.why === 'string' && UNSAFE_CHARS.test(ask.why)) throw bad(`ask.why ${UNSAFE_SAYS}`);
  if (!ASK_KINDS.has(ask.kind)) throw bad('ask.kind must be "decide" or "do"');
  if (!none(ask.time) && !(typeof ask.time === 'string' && HHMM.test(ask.time))) throw bad('ask.time must be a 24-hour HH:MM time, or empty for none');
}

// When each item was finished, kept by the server: the writers never have to.
// It is worked out against the board this write replaces:
//   - an item that enters Done without a doneAt gets this write's time;
//   - an item still in Done that arrives without one gets its old value back,
//     so a writer that rebuilds its items from text, lane and tag can't wipe it;
//   - an item outside Done carries none, so one that leaves Done loses it.
// A doneAt a writer sends with a Done item is kept as sent. Items finished
// before this existed have none, and keep having none while they stay in Done.
export function stampDone(todos, previous, now = Date.now()) {
  const before = new Map();
  for (const t of Array.isArray(previous) ? previous : []) {
    if (t && typeof t === 'object' && !Array.isArray(t)) before.set(t.id, t);
  }
  const at = new Date(now).toISOString();
  return todos.map(t => {
    if (t.lane === 'done' && typeof t.doneAt === 'string' && t.doneAt !== '') return t;
    const { doneAt: _dropped, ...rest } = t;
    if (t.lane !== 'done') return 'doneAt' in t ? rest : t;
    const old = before.get(t.id);
    if (old?.lane !== 'done') return { ...rest, doneAt: at };
    return isInstant(old.doneAt) ? { ...rest, doneAt: old.doneAt } : rest;
  });
}

// When each item was made (board 17924110), kept by the server like doneAt, so the
// morning brief can tell an old P1 from a new one. Worked out against the board this
// write replaces:
//   - an item already on it keeps the createdAt it had there, whatever the writer
//     sends, so an edit (or a writer that rebuilds its items) can't change or wipe it;
//   - an item that was on it with no createdAt at all was made before this existed:
//     it gets null, "unknown", and keeps it. Its date is never guessed;
//   - an item new to the board gets this write's time, unless it brings a createdAt
//     of its own (an instant, or null): a restore from todos-history/ or an item
//     back from the archive keeps the date it was made, or its "unknown".
// `unknownWhenNew` (restore-todos.mjs) marks a new item that brings none as unknown
// rather than as made now: an old copy's items were not made at the restore.
export function stampCreated(todos, previous, now = Date.now(), { unknownWhenNew = false } = {}) {
  const before = new Map();
  for (const t of Array.isArray(previous) ? previous : []) {
    if (t && typeof t === 'object' && !Array.isArray(t)) before.set(t.id, t);
  }
  const at = new Date(now).toISOString();
  const known = v => v === null || isInstant(v);
  return todos.map(t => {
    const old = before.get(t.id);
    if (old) {
      const kept = known(old.createdAt) ? old.createdAt : null;
      return t.createdAt === kept ? t : { ...t, createdAt: kept };
    }
    if (known(t.createdAt)) return t;
    return { ...t, createdAt: unknownWhenNew ? null : at };
  });
}

// restoredAt: when an item last came back from the archive. Carried like createdAt
// (an item on the board keeps the one it had; a new one keeps what it brings), so the
// next archive move counts its days from its return, not from its old doneAt.
function carryRestored(todos, previous) {
  const before = new Map();
  for (const t of Array.isArray(previous) ? previous : []) {
    if (t && typeof t === 'object' && !Array.isArray(t)) before.set(t.id, t);
  }
  return todos.map(t => {
    const old = before.get(t.id);
    if (!old) return t;
    const { restoredAt: _sent, ...rest } = t;
    if (isInstant(old.restoredAt)) return t.restoredAt === old.restoredAt ? t : { ...rest, restoredAt: old.restoredAt };
    return 'restoredAt' in t ? rest : t;
  });
}

// ---- the done-lane archive (board 17924110) ----
//
// Every PUT carries every item, so the Done lane, which only grows, is most of every
// save (64% of the 632 KB board on 2026-11-25). With `board.archiveDays` set in
// config, the server moves Done items finished more than that many days ago into an
// archive file beside the other runtime data, under the same lock as every PUT, and
// nothing is ever deleted: each item lives in exactly one of the two files, an archived
// one is read at GET /api/todos/archive, and POST /api/todos/archive/restore brings it
// back.

export const DAY_MS = 24 * 60 * 60 * 1000;
// A Done item with no doneAt has been in Done since before the server began stamping
// doneAt (Orbit Phase 1, live 2026-10-21: stampDone stamps every item that enters
// Done). Its real date is unknown, so the archive counts its days from the end of that
// day, the latest it can have been finished: it is never archived sooner than a dated
// item of 2026-10-21 would be, and its doneAt stays absent in the archive (never made up).
export const UNDATED_DONE = Date.parse('2026-10-22T00:00:00.000Z');
// The move waits for the board to have been quiet this long, so it never lands between
// a writer's PUT and the GET that checks it (Jarvis's board-write reads back every
// write; a move in between would show it items missing).
export const ARCHIVE_QUIET_MS = 2 * 60 * 1000;

const instantMs = v => (isInstant(v) ? Date.parse(v) : null);
// The moment a Done item's days in Done are counted from: its doneAt (or UNDATED_DONE),
// or its return from the archive if that is later.
export function archiveClock(t) {
  const done = instantMs(t?.doneAt) ?? UNDATED_DONE;
  const back = instantMs(t?.restoredAt);
  return back !== null && back > done ? back : done;
}

// The items a move would take: Done ones whose clock is at least `days` whole days old.
export function pickArchivable(list, { days, now = Date.now() }) {
  if (!Number.isInteger(days) || days < 1) return [];
  const cutoff = now - days * DAY_MS;
  return (Array.isArray(list) ? list : []).filter(t => t && t.lane === 'done' && archiveClock(t) <= cutoff);
}

// Raised for a request the archive can't carry out. `status` is the HTTP answer.
//   ARCHIVED     a write brings back an id that is in the archive (409);
//   NOT_ARCHIVED a restore names an id the archive doesn't hold (404);
//   ON_BOARD     a restore names an id that is on the board already (409);
//   UNREADABLE   the archive file can't be read or parsed (500): nothing is moved.
export class ArchiveError extends Error {
  constructor(code, message, ids = []) {
    super(message);
    this.code = code;
    this.ids = ids;
    this.status = { ARCHIVED: 409, NOT_ARCHIVED: 404, ON_BOARD: 409, TOO_BIG: 409, NEEDS_FORCE: 409, UNREADABLE: 500, BOARD_UNREADABLE: 500 }[code] ?? 500;
  }
}
//   TOO_BIG          bringing items back would leave a board too big to save (Ultron L4);
//   NEEDS_FORCE      a restore of the pre-archive copy, asked without --force (Ultron M1);
//   BOARD_UNREADABLE the board can't be read or parsed, so nothing is brought back (L2).
const idList = ids => ids.map(id => JSON.stringify(id)).join(', ');

// The board's PUT cap (routes.mjs answers 413 past it; defined here so the store can
// check against it without importing the routes). Every PUT carries every item.
export const BOARD_MAX_BODY = 1024 * 1024;
// Bringing items back from the archive (a restore, Bring back, --unarchive-all) is
// refused when the board would be within this much of the cap: past it, every save
// from every writer fails, so a bring-back must leave room for the next edits.
export const RESTORE_HEADROOM = 128 * 1024;
const bodyBytes = list => Buffer.byteLength(JSON.stringify(list));
// A createdAt, restoredAt or doneAt more than this far ahead of the server's clock is
// refused (Ultron L3): a far-future doneAt would keep an item out of the archive for
// ever, and a future createdAt would read as new to the morning brief.
export const FUTURE_SLACK_MS = 5 * 60 * 1000;
// Past this, the archive file is said in the log on each move: it is read whole on
// every move and bring-back.
export const ARCHIVE_WARN_BYTES = 10 * 1024 * 1024;

// The order the archive is read in (GET /api/todos/archive, the page): newest finished
// first; undated items after the dated ones, the last archived first.
export function archiveOrder(list) {
  const done = t => instantMs(t?.doneAt);
  return (Array.isArray(list) ? list : []).map((t, i) => ({ t, i })).sort((a, b) => {
    const da = done(a.t), db = done(b.t);
    if (da !== null && db !== null) return db - da || b.i - a.i;
    if (da !== null) return -1;
    if (db !== null) return 1;
    return b.i - a.i;
  }).map(x => x.t);
}

// Refuses a createdAt, restoredAt or doneAt more than FUTURE_SLACK_MS ahead of `now`
// that this write brings (one already on the board as it is passes, so a board saved
// before this check can still be saved).
function checkClock(todos, previous, now) {
  const before = new Map();
  for (const t of Array.isArray(previous) ? previous : []) {
    if (t && typeof t === 'object' && !Array.isArray(t)) before.set(t.id, t);
  }
  const limit = now + FUTURE_SLACK_MS;
  for (const t of todos) {
    for (const field of ['createdAt', 'restoredAt', 'doneAt']) {
      const v = t[field];
      if (!isInstant(v) || Date.parse(v) <= limit || before.get(t.id)?.[field] === v) continue;
      throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: ${field} is more than 5 minutes ahead of the server's clock (got ${v})`);
    }
  }
}

// ---- the lock shared by every process that writes the board (Ultron L1) ----
//
// The server and restore-todos.mjs are two processes writing the same two files (the
// board and its archive), and the store's queue orders only one process's writes. So
// every write, in either process, first takes `<board>.lock`: its pid, time and token
// are written to a temp file of its own, which is then link()ed to the lock's name, so
// the lock appears whole or not at all and is never seen empty (Ultron's re-read L-A:
// a created-but-unwritten lock read as stale). A second writer waits for it (polling,
// up to LOCK_WAIT_MS) and then gives up with an error that names the holder, writing
// nothing. Only the holder (its token) removes it. A lock whose pid is not running (a
// crash) is broken at once; one older than LOCK_STALE_MS is broken whatever its pid (a
// write takes milliseconds, and a pid can be reused after a crash). Every lock broken or
// put back is logged (L-B).
export const LOCK_WAIT_MS = 10 * 1000;
export const LOCK_STALE_MS = 60 * 1000;
const LOCK_POLL_MS = 20;
const pause = ms => new Promise(r => setTimeout(r, ms));
const running = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, someone else's
  }
};
// A lock that can't be read as pid, time and token is never one this code wrote (it
// links whole files), so it is a hand-made or damaged file, or one an older version was
// still writing. It is broken only once its file is LOCK_PARTIAL_GRACE_MS old, so even
// a writer that creates first and writes after is never broken mid-write (L-A).
export const LOCK_PARTIAL_GRACE_MS = 5 * 1000;
const readLock = async lockPath => {
  try {
    const [raw, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    const m = /^(\d+) (\d+) (\S+)\n?$/.exec(raw);
    return m
      ? { raw, pid: Number(m[1]), at: Number(m[2]), token: m[3], whole: true, mtimeMs: info.mtimeMs }
      : { raw, pid: null, at: null, token: null, whole: false, mtimeMs: info.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};
const isStale = (held, now) => (held.whole
  ? held.pid <= 0 || !running(held.pid) || now - held.at > LOCK_STALE_MS
  : now - held.mtimeMs > LOCK_PARTIAL_GRACE_MS);

const lockWords = held => `pid ${Number.isInteger(held?.pid) ? held.pid : 'unknown'}, taken ${Number.isFinite(held?.at) ? new Date(held.at).toISOString() : 'at an unknown time'}`;

export async function acquireBoardLock(lockPath, { waitMs = LOCK_WAIT_MS, log = line => console.error(line) } = {}) {
  const token = randomBytes(8).toString('hex');
  const until = performance.now() + waitMs;
  const name = basename(lockPath);
  let madeFolder = false;
  for (;;) {
    // Whole in a temp file first, then linked: link() fails with EEXIST while another
    // lock is there, and never replaces it.
    const fresh = `${lockPath}.new-${process.pid}-${token}`;
    try {
      await writeFile(fresh, `${process.pid} ${Date.now()} ${token}\n`, { flag: 'wx', mode: 0o600 });
      try {
        await link(fresh, lockPath);
        return token;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      } finally {
        await unlink(fresh).catch(() => {});
      }
    } catch (err) {
      // The board's folder isn't there yet (its first write): made, then tried again.
      if (err.code === 'ENOENT' && !madeFolder) {
        await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
        madeFolder = true;
        continue;
      }
      throw new Error(`could not take the board's lock (${err.code ?? err.message}), so nothing was written`);
    }
    const held = await readLock(lockPath);
    if (held && isStale(held, Date.now())) {
      // Moved aside first (a rename is atomic), then checked: if what moved is not the
      // lock judged stale (another writer broke it and took a new one in between), it
      // is put back with link(), which never replaces a lock taken since.
      const aside = `${lockPath}.stale-${process.pid}-${token}`;
      try {
        await rename(lockPath, aside);
        const moved = await readFile(aside, 'utf8').catch(() => null);
        if (moved !== held.raw) {
          const back = await link(aside, lockPath).then(() => true, () => false);
          log(`board: ${back ? 'put back' : 'could not put back'} a lock ${name} taken since the stale one was judged (${lockWords(await readLock(back ? lockPath : aside).catch(() => null))})`);
        } else {
          log(`board: broke a stale lock ${name} (${held.whole ? `${lockWords(held)}; ${running(held.pid) ? `held over ${LOCK_STALE_MS / 1000} s` : 'that process is gone'}` : `not a whole lock, unchanged for over ${LOCK_PARTIAL_GRACE_MS / 1000} s`})`);
        }
        await unlink(aside).catch(() => {});
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      continue;
    }
    if (performance.now() >= until) {
      const err = new Error(`the board is being written by another process (pid ${held?.pid ?? 'unknown'}, lock ${basename(lockPath)}); nothing was written, try again`);
      err.code = 'BOARD_LOCKED';
      throw err;
    }
    await pause(LOCK_POLL_MS);
  }
}

export async function releaseBoardLock(lockPath, token) {
  const held = await readLock(lockPath).catch(() => null);
  if (held?.token === token) await unlink(lockPath).catch(() => {});
}

const asidePrefix = path => `${basename(path)}.corrupt-`;
// A history copy is named for the UTC millisecond it was made: ISO 8601 with
// the separators dropped, todos-yyyymmddThhmmssSSSZ.json. Every name is the
// same width, so sorting the names sorts the copies by time and pruning needs
// nothing but the names.
const stamp = ms => new Date(ms).toISOString().replace(/[-:.]/g, '');
const COPY = /^todos-\d{8}T\d{9}Z\.json$/;
// The copy kept before the first archive move: a name of its own, so prune() never
// counts it and it outlives the rolling 20. Listed and restored like the others.
const PINNED = /^todos-pre-archive-\d{8}T\d{9}Z\.json$/;
const copyStamp = name => name.slice(name.lastIndexOf('-') + 1);
// Numbers every temp file this process writes (see write()). Module-wide, not
// per store, because two stores in one process can share a path.
let tmpSeq = 0;
// A board's revision is a hash of the bytes on disk, so it needs no state of
// its own: it survives a restart, a restore-todos.mjs run changes it like any
// other write, and two servers reading one file agree on it. A board that does
// not exist yet has the revision null.
export const revisionOf = raw => createHash('sha256').update(raw).digest('hex').slice(0, 16);

// Raised by save() when the caller's revision is not the board's. It carries
// the board's current revision so the route can hand it back.
export class StaleRevisionError extends Error {
  constructor(expected, current) {
    super(`the board changed since revision ${expected} was read (it is now ${current ?? 'empty'}); re-read it and apply the change again`);
    this.code = 'STALE_REVISION';
    this.expected = expected;
    this.current = current;
  }
}

const SEED = [
  { id: 1, text: 'Route bulk transcript cleanup to Haiku — Sonnet is overkill', lane: 'idea', tag: 'Usage' },
  { id: 2, text: 'Cron: weekly digest of all Cowork project status', lane: 'idea', tag: 'Crons' },
  { id: 3, text: 'Rewrite the nightly-sync cron so it retries on 429', lane: 'doing', tag: 'Crons' }
];

// The page prints every tag in uppercase, so `Pi` and `pi` look identical on
// screen while being two different strings on disk — and the grouping that
// case-folds them only hides the fork, it does not close it. Unify on write:
// within one list, tags that differ only by case take the casing already in
// the majority (ties to the first seen), so a new item typed in lowercase
// joins the group it visibly belongs to. Distinct tags are never touched, and
// an item with no tag stays without one.
export function unifyTags(todos) {
  const tally = new Map(); // folded -> Map(casing -> count), insertion-ordered
  for (const t of todos) {
    if (typeof t.tag !== 'string') continue;
    const tag = t.tag.trim();
    if (!tag) continue;
    const folded = tag.toLowerCase();
    if (!tally.has(folded)) tally.set(folded, new Map());
    const casings = tally.get(folded);
    casings.set(tag, (casings.get(tag) ?? 0) + 1);
  }
  const canonical = new Map();
  for (const [folded, casings] of tally) {
    let best = null, bestCount = 0;
    for (const [casing, count] of casings) {
      if (count > bestCount) { best = casing; bestCount = count; }
    }
    canonical.set(folded, best);
  }
  return todos.map(t => {
    if (typeof t.tag !== 'string') return t;
    const tag = t.tag.trim();
    return { ...t, tag: tag ? canonical.get(tag.toLowerCase()) : tag };
  });
}

// Every PUT replaces the whole board, and nothing used to keep the one it
// replaced: a single bad write was enough to lose the board outright, as it
// did on 2026-10-07. Each write now copies the board it is about to replace
// into `historyDir` first and keeps the newest `keep` copies, so a bad write
// is one command to undo (restore-todos.mjs).
//
// The archive (board 17924110) is a second file, `archivePath`, written only from
// inside the same queue as the board, so a move, a restore and a PUT never interleave.
// It defaults to data/todos-archive.json beside the board, where the other runtime
// data lives (gitignored), and is written 0600.
export function createTodoStore(path, {
  historyDir = join(dirname(path), 'todos-history'),
  keep = 20,
  archivePath = join(dirname(path), 'data', 'todos-archive.json'),
  lockPath = `${path}.lock`,
  lockWaitMs = LOCK_WAIT_MS,
  maxBytes = BOARD_MAX_BODY,
  log = line => console.error(line)
} = {}) {
  const keepCopy = async (prefix = 'todos-') => {
    let raw;
    try {
      raw = await readFile(path);
    } catch (err) {
      if (err.code === 'ENOENT') return; // the first write: there is no board to keep yet
      throw err;
    }
    // 0700 and 0600 (Ultron L8): the copies are the board. A mode applies only to what
    // this creates; a folder or file made before keeps its mode until changed by hand.
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
    // Exclusive create (`wx`), so one copy can never replace another. Two
    // writes in the same millisecond want the same name; the later one moves
    // to the next free millisecond rather than taking a suffix, which keeps
    // one name format and keeps a later copy sorting later. A `-1` would not:
    // `-` sorts before the `.` of `.json`, so it would list as the older one.
    // Each EEXIST is a name already taken, so the walk passes at most as many
    // names as the directory holds. Date.now() rather than new Date(), so a
    // test can pin the clock.
    for (let t = Date.now(); ; t++) {
      try {
        await writeFile(join(historyDir, `${prefix}${stamp(t)}.json`), raw, { flag: 'wx', mode: 0o600 });
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  };

  // Best-effort, and only once the board is written: a copy that cannot be
  // deleted now is retried by the next write's prune, and must not fail a
  // write that already landed. Only names this store makes are counted, so
  // nothing else in the directory is ever deleted.
  const prune = async () => {
    const names = (await readdir(historyDir).catch(() => [])).filter(f => COPY.test(f)).sort();
    const surplus = names.slice(0, Math.max(0, names.length - keep));
    await Promise.all(surplus.map(f => unlink(join(historyDir, f)).catch(() => {})));
  };

  // Every write in this process goes through one queue, so the revision check
  // in save() and the rename that follows it cannot interleave with another
  // write: a check that passed is still true when the board is replaced. A
  // failed write does not jam the queue.
  // Each write also holds the board's lock file for its length (acquireBoardLock,
  // above), so the server and restore-todos.mjs never write the board or the archive
  // at the same time.
  let queue = Promise.resolve();
  const locked = async fn => {
    const token = await acquireBoardLock(lockPath, { waitMs: lockWaitMs, log });
    try {
      return await fn();
    } finally {
      await releaseBoardLock(lockPath, token);
    }
  };
  const serial = fn => {
    const task = () => locked(fn);
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  // The board a write is about to replace, for stampDone(). A board that isn't
  // there yet, or can't be parsed, has no items to carry a doneAt over from; a
  // board that can't be read at all is refused by keepCopy() before the rename.
  const readPrevious = async () => {
    try {
      const list = JSON.parse(await readFile(path, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  // The board for a bring-back, read strictly (Ultron L2): readPrevious() answers [] for
  // a board it can't parse, and adding the archive's items to [] would write a board of
  // only those items over the real one. Missing or unreadable, nothing is brought back.
  const readBoardStrict = async () => {
    try {
      const list = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(list)) throw new Error('the file does not contain a list');
      return list;
    } catch (err) {
      throw new ArchiveError('BOARD_UNREADABLE', `the board could not be read (${err.code ?? err.message}), so nothing was brought back from the archive`);
    }
  };
  const currentRevision = async () => {
    try {
      return revisionOf(await readFile(path));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };

  // The archive as a list. No file yet is an empty archive; a file that can't be read
  // or parsed is an error, so a move or a restore never writes over it.
  const readArchive = async () => {
    let raw;
    try {
      raw = await readFile(archivePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { list: [], exists: false };
      throw new ArchiveError('UNREADABLE', `could not read the board's archive: ${err.message}`);
    }
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error('the file does not contain a list');
      return { list, exists: true, bytes: Buffer.byteLength(raw) };
    } catch (err) {
      throw new ArchiveError('UNREADABLE', `the board's archive could not be parsed (${err.message}); nothing was moved`);
    }
  };
  // Write-then-rename, as for the board, and 0600: the archive holds board content.
  // Answers the bytes written.
  const writeArchive = async list => {
    await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
    const tmp = `${archivePath}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
    const text = JSON.stringify(list, null, 2);
    try {
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, archivePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return Buffer.byteLength(text);
  };
  // What the panel and the PUT's archived-id check need, kept in memory (Ultron L5) and
  // read again only when the file's time or length changed: a write here, or one by
  // restore-todos.mjs in its own process. { items, bytes, ids } or, unreadable, a throw.
  let summary = null;
  const archiveSummary = async () => {
    let info;
    try {
      info = await stat(archivePath);
    } catch (err) {
      if (err.code === 'ENOENT') return { items: 0, bytes: 0, ids: new Set() };
      throw new ArchiveError('UNREADABLE', `could not read the board's archive: ${err.message}`);
    }
    // Whole milliseconds (a file time set back by hand keeps no finer part); every
    // write of the archive is a rename, so a new inode tells two writes in one ms apart.
    const key = `${Math.floor(info.mtimeMs)}:${info.size}:${info.ino}`;
    if (summary?.key === key) return summary;
    const { list } = await readArchive();
    summary = { key, items: list.length, bytes: info.size, ids: new Set(list.map(t => t?.id)) };
    return summary;
  };

  const validate = todos => {
    if (!Array.isArray(todos)) throw new InvalidBoardError('todos must be an array');
    for (const [i, t] of todos.entries()) {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new InvalidBoardError('every item must be an object');
      // The fields every reader takes for granted (the page, the mod, the morning
      // brief): an id to find the item by, its text, and a tag that is text when
      // there is one. A bad id names the item by its place in the list.
      if (!((typeof t.id === 'string' && t.id !== '') || (typeof t.id === 'number' && Number.isFinite(t.id)))) {
        throw new InvalidBoardError(`item ${i + 1}: id must be non-empty text or a number`);
      }
      if (typeof t.text !== 'string') throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: text must be text`);
      if (t.tag !== undefined && typeof t.tag !== 'string') throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: tag must be text, or left out`);
      if (typeof t.tag === 'string' && chars(t.tag.trim()) > TAG_MAX) throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: tag must be at most ${TAG_MAX} characters`);
      if (typeof t.tag === 'string' && hasHiddenChars(t.tag)) throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: tag ${UNSAFE_SAYS}`);
      if (!LANES.has(t.lane)) throw new InvalidBoardError(`unknown lane: ${t.lane}`);
      if (t.priority != null && !PRIORITIES.has(t.priority)) throw new InvalidBoardError(`unknown priority: ${t.priority}`);
      if (t.due != null && t.due !== '' && !isDueDate(t.due)) {
        throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: due must be a date written YYYY-MM-DD, or empty for none (got ${JSON.stringify(t.due)})`);
      }
      checkFields(t);
    }
  };

  // The write itself. Only ever called from inside serial().
  //   reclaim    an item that is in the archive may come back with this write (a
  //              restore from todos-history/, the archive's own restore route): it is
  //              stamped restoredAt and taken out of the archive once the board is
  //              written. Without it, such a write is refused (ArchiveError ARCHIVED):
  //              it can only come from a copy of the board read before the move.
  //   restoring  an item new to the board with no createdAt gets null, not now.
  const writeUnlocked = async (todos, { reclaim = false, restoring = false } = {}) => {
    validate(todos);
    const previous = await readPrevious();
    const now = Date.now();
    // Only ids the board doesn't hold can be coming back from the archive, so the
    // archive is read only for a write that adds something. One that can't be read
    // doesn't block the write: a stale copy is caught by its revision first, and a
    // broken archive must never stop the board from saving.
    checkClock(todos, previous, now);
    const onBoard = new Set(previous.map(t => t?.id));
    const fresh = todos.filter(t => !onBoard.has(t.id)).map(t => t.id);
    let back = [];
    let archived = new Map();
    if (fresh.length > 0) {
      const ids = await archiveSummary().then(a => a.ids, () => new Set());
      back = fresh.filter(id => ids.has(id));
      if (back.length > 0) archived = await readArchive().then(a => new Map(a.list.map(t => [t?.id, t])), () => new Map());
      if (back.length > 0 && !reclaim) {
        throw new ArchiveError('ARCHIVED',
          `${back.length === 1 ? 'item' : 'items'} ${idList(back)} ${back.length === 1 ? 'is' : 'are'} in the archive, so this copy of the board was read before the archive move: re-read the board, or bring ${back.length === 1 ? 'it' : 'them'} back with POST /api/todos/archive/restore`,
          back);
      }
    }
    const returning = new Set(back);
    const at = new Date(now).toISOString();
    // For an item coming back, the archive's copy is the one it replaces: it keeps the
    // createdAt the archive kept (a copy made before createdAt existed brings none), and
    // an undated Done item stays undated rather than being stamped as finished now.
    const prior = returning.size === 0 ? previous : [...previous, ...back.map(id => archived.get(id))];
    const stamped = stampCreated(carryRestored(stampDone(unifyTags(todos), prior, now), prior), prior, now, { unknownWhenNew: restoring });
    const unified = returning.size === 0 ? stamped : stamped.map(t => (returning.has(t.id) ? { ...t, restoredAt: at } : t));
    // A write that brings items back must leave the board savable (Ultron L4).
    if (returning.size > 0 && bodyBytes(unified) > maxBytes - RESTORE_HEADROOM) {
      throw new ArchiveError('TOO_BIG',
        `bringing ${returning.size} item${returning.size === 1 ? '' : 's'} back would make the board ${Math.round(bodyBytes(unified) / 1024)} KB, within ${RESTORE_HEADROOM / 1024} KB of its ${Math.round(maxBytes / 1024)} KB save limit, so nothing was written: bring fewer back, or raise the limit first`,
        back);
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash or a full disk part-way through a direct
    // writeFile leaves exactly the truncated JSON that used to trigger the
    // seed-over-the-top path above. A rename within one directory is atomic,
    // so what is on disk is always a complete list — the old one or the new.
    // Each write needs a temp file of its own for that to hold. pid + time
    // alone was shared by two writes in the same millisecond: both wrote
    // into the one file, the first rename could put a torn list in place,
    // and the second found its temp file gone. The counter tells apart the
    // writes of one process, the pid tells apart processes (the server and
    // restore-todos.mjs), so no two live writers can share a name.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
    const text = JSON.stringify(unified, null, 2);
    try {
      await writeFile(tmp, text, { mode: 0o600 }); // the board, 0600 from its next write (L8)
      // The copy is the last step before the rename, so it holds the board
      // this rename replaces. Only a second write renaming in between can
      // make them differ: both then keep the same board, and the one renamed
      // first is replaced an instant later without a copy. Within this
      // process serial() rules that out; a second process (restore-todos.mjs)
      // writing at the same instant still could. If no copy can be made, the
      // board is left alone: replacing it with nothing kept is the
      // unrecoverable write this exists to prevent, and a refused write says
      // so out loud where a skipped copy would say nothing until the copy was
      // needed.
      await keepCopy().catch(err => {
        throw new Error(`could not keep a copy of the board before replacing it, so it was not replaced: ${err.message}`);
      });
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await prune();
    // The board is written first: a crash here leaves the item in both files, never in
    // neither. The next move or restore tolerates that (it is on the board, so a PUT
    // keeps it, and the archive's copy is replaced when it is moved again).
    if (returning.size > 0) {
      const { list } = await readArchive();
      await writeArchive(list.filter(t => !returning.has(t?.id)));
    }
    return { todos: unified, revision: revisionOf(text), returned: back };
  };

  // The archive move. In the queue, so it sees the board as the last write left it and
  // the next PUT sees the board it wrote: a writer holding the old revision gets a 409.
  const archiveUnlocked = async ({ days, now }) => {
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      if (err.code === 'ENOENT') return { moved: 0, held: 'no board yet' };
      throw err;
    }
    if (now - info.mtimeMs < ARCHIVE_QUIET_MS) return { moved: 0, held: 'the board was written in the last two minutes' };
    let raw;
    let board;
    try {
      raw = await readFile(path, 'utf8');
      board = JSON.parse(raw);
      if (!Array.isArray(board)) throw new Error('the file does not contain a list');
    } catch (err) {
      throw new Error(`the board could not be read, so nothing was archived: ${err.message}`);
    }
    const going = pickArchivable(board, { days, now });
    if (going.length === 0) return { moved: 0 };
    const archive = await readArchive();
    const ids = new Set(going.map(t => t.id));
    const stay = board.filter(t => !ids.has(t.id));
    // Checked before either file is touched, so a board the PUT rules refuse (a hand
    // edit, say) leaves both files exactly as they were.
    validate(stay);
    // Before the first move, a copy of the whole board under a name prune() never
    // removes (todos-pre-archive-*.json), so the board as it was before any archive can
    // always be put back with restore-todos.mjs, however many saves come after.
    if (!archive.exists) await keepCopy('todos-pre-archive-');
    const at = new Date(now).toISOString();
    const moved = going.map(t => ({ ...t, ...('createdAt' in t ? {} : { createdAt: null }), archivedAt: at }));
    // Archive first, then the board: a crash between leaves an item in both, never
    // lost. One already in the archive (that crash's leftover) is replaced by the copy
    // on the board, which is the newer.
    const archiveBytes = await writeArchive([...archive.list.filter(t => !ids.has(t?.id)), ...moved]);
    const written = await writeUnlocked(stay);
    return {
      moved: moved.length,
      ids: moved.map(t => t.id),
      first: !archive.exists,
      before: Buffer.byteLength(raw),
      after: Buffer.byteLength(JSON.stringify(written.todos, null, 2)),
      archived: archive.list.filter(t => !ids.has(t?.id)).length + moved.length,
      archiveBytes,
      revision: written.revision
    };
  };

  // Reads the board and its revision from one read of the file.
  const load = async () => {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      // Only a file that genuinely is not there gets seeded. The old blanket
      // catch also swallowed EACCES and every parse failure, and answered by
      // WRITING the seed over the user's backlog — destroying real work and
      // replacing it with three invented items that look exactly like real
      // ones.
      if (err.code === 'ENOENT') {
        // A corrupt file that was just renamed aside also leaves nothing at
        // `path` — indistinguishable from a genuine first run by ENOENT
        // alone. Seeding here would bury the backlog we just went out of
        // our way to preserve under three invented items, with nothing on
        // screen ever saying so. Only seed when no aside is on record.
        const siblings = await readdir(dirname(path)).catch(() => []);
        const asides = siblings.filter(f => f.startsWith(asidePrefix(path))).sort();
        if (asides.length > 0) {
          const latest = asides[asides.length - 1];
          throw new Error(
            `the to-do list is missing, but a previously corrupted version was set aside as ${latest} — ` +
            `nothing has replaced it, so the list is not being reseeded over it`
          );
        }
        // An archive means there was a board: seeding would put three invented items
        // in its place. restore-todos.mjs puts a copy back.
        const archived = await stat(archivePath).then(() => true, () => false);
        if (archived) {
          throw new Error('the to-do list is missing, but its archive is still there, so the list is not being reseeded: put a copy back with restore-todos.mjs');
        }
        return serial(() => writeUnlocked(SEED));
      }
      throw new Error(`could not read the to-do list: ${err.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('the file does not contain a list');
    } catch (err) {
      // Preserve the damaged file — it is the only copy of the backlog — and
      // report the problem rather than papering over it. Date.now() alone is
      // not collision-proof: two corruptions landing in the same millisecond
      // produce the same aside name, and plain rename() silently replaces
      // whatever already sits there — the second "preserve" destroying the
      // first. A random suffix, written with an exclusive create (refuses to
      // overwrite an existing file), makes the name unique and makes
      // clobbering an already-preserved aside impossible rather than just
      // unlikely.
      let aside = null;
      for (let attempt = 0; attempt < 5 && !aside; attempt++) {
        const candidate = join(dirname(path), `${asidePrefix(path)}${Date.now()}-${randomBytes(4).toString('hex')}`);
        try {
          await writeFile(candidate, raw, { flag: 'wx', mode: 0o600 });
          aside = candidate;
        } catch (writeErr) {
          if (writeErr.code !== 'EEXIST') break; // nothing more we can do
        }
      }
      if (aside) await unlink(path).catch(() => {});
      throw new Error(
        aside
          ? `the to-do list could not be parsed (${err.message}); the file has been kept as ${basename(aside)}`
          : `the to-do list could not be parsed (${err.message}); it could not be preserved either`
      );
    }
    return { todos: parsed, revision: revisionOf(raw) };
  };

  const store = {
    // The board and its revision, both from one read of the file, so a write
    // landing in between can never pair an old list with a new revision.
    async readState() {
      return load();
    },

    // A write that says which revision it was made from. With `ifMatch` set
    // (a revision, or a list of them), the board is replaced only if it is
    // still at that revision; otherwise StaleRevisionError, and nothing is
    // written. Without it, this is a plain write: that is how curl, Jarvis's
    // GET-modify-PUT and the Claude Code mod write, and they keep working.
    async save(todos, { ifMatch = null } = {}) {
      return serial(async () => {
        if (ifMatch !== null) {
          const wanted = Array.isArray(ifMatch) ? ifMatch : [ifMatch];
          const current = await currentRevision();
          if (!wanted.includes(current)) throw new StaleRevisionError(wanted[0], current);
        }
        return writeUnlocked(todos);
      });
    },

    async read() {
      return (await load()).todos;
    },

    // The board file's length in bytes, for the `board` panel that warns before
    // it reaches the PUT cap; 0 before the first write.
    async size() {
      try {
        return (await stat(path)).size;
      } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
      }
    },

    async write(todos) {
      return (await serial(() => writeUnlocked(todos))).todos;
    },

    // Move Done items finished at least `days` days ago into the archive (above). A
    // board written in the last ARCHIVE_QUIET_MS is left for the next run ({ held }).
    async archiveDone({ days, now = Date.now() }) {
      if (!Number.isInteger(days) || days < 1) throw new Error('archiveDone needs a whole number of days, 1 or more');
      return serial(() => archiveUnlocked({ days, now }));
    },

    // A page of the archived items, newest finished first (archiveOrder), each with
    // its archivedAt: { total, offset, items }. Without a limit, all of them.
    async archived({ offset = 0, limit = Infinity } = {}) {
      const all = archiveOrder((await readArchive()).list);
      return { total: all.length, offset, items: all.slice(offset, offset + limit) };
    },

    // The archive file's length in bytes and its item count, for the board panel,
    // from memory while the file is unchanged.
    async archiveSize() {
      const { items, bytes } = await archiveSummary();
      return { items, bytes };
    },

    // Bring archived items back to the board, as they were (a Done item comes back to
    // Done), stamped restoredAt so the next move counts their days from now. In the
    // queue like a PUT. Every id must be in the archive and none on the board, or
    // nothing is written.
    async unarchive(ids) {
      if (!Array.isArray(ids) || ids.length === 0) throw new InvalidBoardError('ids must be a list of one or more item ids');
      return serial(async () => {
        const { list } = await readArchive();
        const byId = new Map(list.map(t => [t?.id, t]));
        const missing = ids.filter(id => !byId.has(id));
        if (missing.length > 0) throw new ArchiveError('NOT_ARCHIVED', `the archive holds no item ${idList(missing)}`, missing);
        const board = await readBoardStrict();
        const onBoard = new Set(board.map(t => t?.id));
        const already = ids.filter(id => onBoard.has(id));
        if (already.length > 0) throw new ArchiveError('ON_BOARD', `item ${idList(already)} is on the board already`, already);
        const back = [...new Set(ids)].map(id => {
          const { archivedAt: _a, ...item } = byId.get(id);
          return item;
        });
        return writeUnlocked([...board, ...back], { reclaim: true });
      });
    },

    // Every archived item back on the board, merged into the board as it is now (Ultron
    // M1: the way back that loses nothing; restoring the pre-archive copy would drop
    // every change since). Each comes back as it was, stamped restoredAt, at the end of
    // the board; an item on the board already (a crash's leftover in both files) keeps
    // the board's copy, the newer, and leaves the archive. Refused, writing nothing,
    // when the board can't be read or would be too big to save.
    async unarchiveAll() {
      return serial(async () => {
        const { list } = await readArchive();
        const board = await readBoardStrict();
        const onBoard = new Set(board.map(t => t?.id));
        const seen = new Set();
        const back = [];
        let already = 0;
        for (const t of list) {
          if (onBoard.has(t?.id)) { already += 1; continue; }
          if (seen.has(t?.id)) continue;
          seen.add(t?.id);
          const { archivedAt: _a, ...item } = t;
          back.push(item);
        }
        if (back.length === 0 && already === 0) return { returned: [], alreadyOnBoard: 0, todos: board, revision: null };
        const written = back.length > 0 ? await writeUnlocked([...board, ...back], { reclaim: true }) : null;
        if (already > 0) {
          const { list: left } = await readArchive();
          await writeArchive(left.filter(t => !onBoard.has(t?.id)));
        }
        return { returned: written?.returned ?? [], alreadyOnBoard: already, todos: written?.todos ?? board, revision: written?.revision ?? null };
      });
    },

    // The copies on record, newest first, each with its item count — or, for
    // a copy that does not parse as a list, the reason, so a damaged copy is
    // listed rather than hidden behind the good ones.
    async copies() {
      let names;
      try {
        names = await readdir(historyDir);
      } catch (err) {
        if (err.code === 'ENOENT') return []; // no write has replaced a board yet
        throw new Error(`could not read the board's history: ${err.message}`);
      }
      // Newest first by the time in the name, so the pre-archive copy sits among the
      // rolling ones at the moment it was made, marked `pinned` (never pruned).
      const listed = names.filter(f => COPY.test(f) || PINNED.test(f))
        .sort((a, b) => copyStamp(b).localeCompare(copyStamp(a)) || b.localeCompare(a));
      return Promise.all(listed.map(async file => {
        const pinned = PINNED.test(file) ? { pinned: true } : {};
        try {
          const list = JSON.parse(await readFile(join(historyDir, file), 'utf8'));
          if (!Array.isArray(list)) throw new Error('the file does not contain a list');
          return { file, items: list.length, ...pinned };
        } catch (err) {
          return { file, items: null, error: err.message, ...pinned };
        }
      }));
    },

    // Put a copy back. It goes through the same write as a PUT, so it is checked like
    // any other write, and the board it replaces is kept first: a restore can be undone
    // the same way. An item the copy holds that has since been archived comes back
    // to the board and leaves the archive (stamped restoredAt), so each item stays in
    // one file; an item the copy holds with no createdAt is marked unknown, not new.
    // The copy taken before the first archive move (todos-pre-archive-*) is restored only
    // with `force` (Ultron M1): it is the board as it was then, so every item added
    // since leaves the board. Asked without it, nothing is written and the error says
    // how many current items the copy lacks; --unarchive-all is the way back that keeps
    // them. With it, the answer carries that count as `lacking`.
    async restore(file, { force = false } = {}) {
      // A relative name resolves against historyDir, so a name from copies()
      // works as it is. Both sides are compared as real paths: macOS paths
      // are case-insensitive and /var is a symlink to /private/var, so two
      // spellings of one file must not read as two places, and a symlink that
      // leads out of historyDir must read as outside it.
      const asked = resolve(historyDir, file);
      let target;
      try {
        target = await realpath(asked);
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`no such copy: ${asked}`);
        throw err;
      }
      const home = await realpath(historyDir).catch(() => null);
      if (dirname(target) !== home) throw new Error(`refusing ${file}: only a copy in ${historyDir} can be restored`);
      const pinned = PINNED.test(basename(target));
      try {
        const list = JSON.parse(await readFile(target, 'utf8'));
        return await serial(async () => {
          let lacking = null;
          if (pinned) {
            const inCopy = new Set((Array.isArray(list) ? list : []).map(t => t?.id));
            const current = await readPrevious();
            lacking = current.filter(t => !inCopy.has(t?.id)).length;
            if (!force) {
              throw new ArchiveError('NEEDS_FORCE',
                `it is the board from before the first archive move, and the board now has ${lacking} item${lacking === 1 ? '' : 's'} it lacks, which would leave the board (kept in todos-history first). To bring archived items back without losing anything, use --unarchive-all; to restore this copy anyway, add --force`);
            }
          }
          const written = await writeUnlocked(list, { reclaim: true, restoring: true });
          const back = written.returned.length;
          return { file: basename(target), items: written.todos.length, ...(back > 0 ? { unarchived: back } : {}), ...(pinned ? { lacking } : {}) };
        });
      } catch (err) {
        const wrapped = new Error(`${basename(target)} was not restored: ${err.message}`);
        wrapped.code = err.code;
        throw wrapped;
      }
    }
  };
  return store;
}
