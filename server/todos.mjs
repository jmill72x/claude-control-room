import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

const LANES = new Set(['idea', 'doing', 'done']);
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
        // report the problem rather than papering over it.
        const aside = join(dirname(path), `${basename(path)}.corrupt-${Date.now()}`);
        try { await rename(path, aside); } catch { /* nothing more we can do */ }
        throw new Error(
          `the to-do list could not be parsed (${err.message}); the file has been kept as ${basename(aside)}`
        );
      }
      return parsed;
    },

    async write(todos) {
      if (!Array.isArray(todos)) throw new Error('todos must be an array');
      for (const t of todos) {
        if (!LANES.has(t.lane)) throw new Error(`unknown lane: ${t.lane}`);
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
