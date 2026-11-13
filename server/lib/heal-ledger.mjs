// The heal ledger (design §5.6): one line per closed loop in data/heals.json, 0600,
// written to a temp file and renamed into place, keeping the last 30 days. The runner
// counts its rate limits from it, and the page's Loops panel lists its recent lines.
//
// A file that exists but can't be read as a list is never written over: `load` throws,
// and the runner keeps every heal off for the run (a ledger that can't count can't
// enforce the limits).
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { keptLines } from './heal.mjs';

export function createHealLedger({ path, now = () => Date.now() }) {
  let lines = [];
  let queue = Promise.resolve();
  const serial = fn => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function save() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    // The temp file is made 0600, and the rename keeps its mode.
    try {
      await writeFile(tmp, JSON.stringify(lines, null, 1), { mode: 0o600 });
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  return {
    // The lines on file; 0 when there is no file yet. Throws when the file is there
    // but isn't a list.
    async load() {
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') { lines = []; return 0; }
        throw err;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('the heal ledger is not a list');
      lines = keptLines(parsed, now());
      return lines.length;
    },
    lines: () => lines,
    // One closed loop. The line is kept in memory only once it is on disk.
    append(line) {
      return serial(async () => {
        const before = lines;
        lines = keptLines([...lines, line], now());
        try {
          await save();
        } catch (err) {
          lines = before;
          throw err;
        }
      });
    }
  };
}
