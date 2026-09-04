import { readFile, writeFile, mkdir, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const LANES = new Set(['idea', 'doing', 'done']);
// Priority is optional: absent or null means "not set", and the UI renders
// that as a dashed placeholder rather than inventing a rank. Anything else
// must be one of these four, so a typo can never sort as if it were P0.
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const asidePrefix = path => `${basename(path)}.corrupt-`;
const SEED = [
  { id: 1, text: 'Route bulk transcript cleanup to Haiku — Sonnet is overkill', lane: 'idea', tag: 'Usage' },
  { id: 2, text: 'Cron: weekly digest of all Cowork project status', lane: 'idea', tag: 'Crons' },
  { id: 3, text: 'Rewrite the nightly-sync cron so it retries on 429', lane: 'doing', tag: 'Crons' }
];

export function createTodoStore(path) {
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
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash or a full disk part-way through a direct
      // writeFile leaves exactly the truncated JSON that used to trigger the
      // seed-over-the-top path above. A rename within one directory is atomic,
      // so what is on disk is always a complete list — the old one or the new.
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmp, JSON.stringify(todos, null, 2));
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      return todos;
    }
  };
}
