import { readFile, writeFile, mkdir, rename, unlink, readdir, realpath } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const LANES = new Set(['idea', 'doing', 'done']);
// Priority is optional: absent or null means "not set", and the UI renders
// that as a dashed placeholder rather than inventing a rank. Anything else
// must be one of these four, so a typo can never sort as if it were P0.
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
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

  return {
    async read() {
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
          await this.write(SEED);
          return SEED;
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
      return parsed;
    },

    async write(todos) {
      if (!Array.isArray(todos)) throw new Error('todos must be an array');
      for (const t of todos) {
        if (!LANES.has(t.lane)) throw new Error(`unknown lane: ${t.lane}`);
        if (t.priority != null && !PRIORITIES.has(t.priority)) throw new Error(`unknown priority: ${t.priority}`);
      }
      const unified = unifyTags(todos);
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
      try {
        await writeFile(tmp, JSON.stringify(unified, null, 2));
        // The copy is the last step before the rename, so it holds the board
        // this rename replaces. Only a second write renaming in between can
        // make them differ: both then keep the same board, and the one renamed
        // first is replaced an instant later without a copy; closing that
        // would take a lock. If no copy can be made, the board is left alone:
        // replacing it with nothing kept is the unrecoverable write this
        // exists to prevent, and a refused write says so out loud where a
        // skipped copy would say nothing until the copy was needed.
        await keepCopy().catch(err => {
          throw new Error(`could not keep a copy of the board before replacing it, so it was not replaced: ${err.message}`);
        });
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      await prune();
      return unified;
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
        const written = await this.write(JSON.parse(await readFile(target, 'utf8')));
        return { file: basename(target), items: written.length };
      } catch (err) {
        throw new Error(`${basename(target)} was not restored: ${err.message}`);
      }
    }
  };
}
