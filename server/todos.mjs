import { readFile, writeFile, mkdir, rename, unlink, readdir, realpath } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { AGENT_KEY } from './lib/roster.mjs';

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
  if (!none(t.owner) && (typeof t.owner !== 'string' || !AGENT_KEY.test(t.owner))) {
    throw bad('owner must be an agent key (lowercase letters, digits and hyphens), or empty for none');
  }
  if (!none(t.doneAt) && !isInstant(t.doneAt)) {
    throw bad(`doneAt must be an ISO 8601 date and time, such as 2026-10-21T13:05:00.000Z (got ${JSON.stringify(t.doneAt)})`);
  }
  if (t.ask === undefined || t.ask === null) return;
  const ask = t.ask;
  if (typeof ask !== 'object' || Array.isArray(ask)) throw bad('ask must be an object with what, kind and optionally why and time, or null for none');
  for (const key of Object.keys(ask)) if (!ASK_FIELDS.has(key)) throw bad(`ask.${key} is not a field ask takes (what, why, kind, time)`);
  if (typeof ask.what !== 'string' || ask.what.trim() === '' || chars(ask.what) > 500) throw bad('ask.what must be text of 1 to 500 characters');
  if (!none(ask.why) && (typeof ask.why !== 'string' || chars(ask.why) > 300)) throw bad('ask.why must be text of at most 300 characters');
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
const asidePrefix = path => `${basename(path)}.corrupt-`;
// A history copy is named for the UTC millisecond it was made: ISO 8601 with
// the separators dropped, todos-yyyymmddThhmmssSSSZ.json. Every name is the
// same width, so sorting the names sorts the copies by time and pruning needs
// nothing but the names.
const stamp = ms => new Date(ms).toISOString().replace(/[-:.]/g, '');
const COPY = /^todos-\d{8}T\d{9}Z\.json$/;
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
export function createTodoStore(path, { historyDir = join(dirname(path), 'todos-history'), keep = 20 } = {}) {
  const keepCopy = async () => {
    let raw;
    try {
      raw = await readFile(path);
    } catch (err) {
      if (err.code === 'ENOENT') return; // the first write: there is no board to keep yet
      throw err;
    }
    await mkdir(historyDir, { recursive: true });
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
        await writeFile(join(historyDir, `todos-${stamp(t)}.json`), raw, { flag: 'wx' });
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
  let queue = Promise.resolve();
  const serial = fn => {
    const run = queue.then(fn, fn);
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
  const currentRevision = async () => {
    try {
      return revisionOf(await readFile(path));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };

  // The write itself. Only ever called from inside serial().
  const writeUnlocked = async todos => {
    if (!Array.isArray(todos)) throw new InvalidBoardError('todos must be an array');
    for (const t of todos) {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new InvalidBoardError('every item must be an object');
      if (!LANES.has(t.lane)) throw new InvalidBoardError(`unknown lane: ${t.lane}`);
      if (t.priority != null && !PRIORITIES.has(t.priority)) throw new InvalidBoardError(`unknown priority: ${t.priority}`);
      if (t.due != null && t.due !== '' && !isDueDate(t.due)) {
        throw new InvalidBoardError(`item ${JSON.stringify(t.id)}: due must be a date written YYYY-MM-DD, or empty for none (got ${JSON.stringify(t.due)})`);
      }
      checkFields(t);
    }
    const unified = stampDone(unifyTags(todos), await readPrevious(), Date.now());
    await mkdir(dirname(path), { recursive: true });
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
      await writeFile(tmp, text);
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
    return { todos: unified, revision: revisionOf(text) };
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
          await writeFile(candidate, raw, { flag: 'wx' });
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

    async write(todos) {
      return (await serial(() => writeUnlocked(todos))).todos;
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
      return Promise.all(names.filter(f => COPY.test(f)).sort().reverse().map(async file => {
        try {
          const list = JSON.parse(await readFile(join(historyDir, file), 'utf8'));
          if (!Array.isArray(list)) throw new Error('the file does not contain a list');
          return { file, items: list.length };
        } catch (err) {
          return { file, items: null, error: err.message };
        }
      }));
    },

    // Put a copy back. It goes through write(), so it is checked like any
    // other write, and the board it replaces is kept first: a restore can be
    // undone the same way.
    async restore(file) {
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
      try {
        const written = await store.write(JSON.parse(await readFile(target, 'utf8')));
        return { file: basename(target), items: written.length };
      } catch (err) {
        throw new Error(`${basename(target)} was not restored: ${err.message}`);
      }
    }
  };
  return store;
}
