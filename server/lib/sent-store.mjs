// The notifier's file (server/data/notified.json): the keys it has told, and under one
// reserved name what it keeps about limit warnings (collectors/notifier.mjs), which
// holds paired-device ids for a few passes.
//
// Written whole on every pass, through a temp file beside it and a rename, so a crash
// or a full disk mid-write leaves the old file and never half of a new one: a file
// that can't be parsed reads as empty, and every live alert would be told again. The
// temp file is made 0600 and must not exist yet (`wx`: a link planted under its name
// is never written through), so the file is the owner's alone from the first write.
//
// A write cut short between the two (the process killed, the machine switched off)
// leaves its temp file behind: nothing reads it, and it holds what the real file
// holds. `sweep` removes those at start.
import { readFile, writeFile, rename, unlink, mkdir, readdir, lstat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// A temp file changed this recently is left by the sweep (Ultron's 11-18 low b): it may
// be a write still under way (an old process not yet gone in a restart), and one that
// really was cut short is just as stale a start later.
export const SWEEP_MIN_AGE_MS = 60e3;
// The temp name `write` makes: the process id and 4 random bytes as 8 hex digits.
const TEMP_TAIL = /^\d+-[0-9a-f]{8}$/;

// `suffix` names the temp file's random part (tests give their own); `now` is the clock
// the sweep judges a file's age by.
export function createSentStore(path, { suffix = () => randomBytes(4).toString('hex'), now = Date.now } = {}) {
  return {
    // What the file holds; {} when it is missing, unreadable or not an object.
    async read() {
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    },
    async write(next) {
      const tmp = `${path}.tmp-${process.pid}-${suffix()}`;
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
    // Removes the temp files an interrupted write left beside the file
    // (`<name>.tmp-<pid>-<8 hex>`, the shape `write` makes), and says how many went.
    // For the server's start, before its first write: one found then is stale,
    // whatever process id its name carries (a restarted server can be given the old
    // one's), unless it changed in the last SWEEP_MIN_AGE_MS (by `lstat`, so a link's
    // own time, never its target's; a time ahead of the clock counts as recent). Only
    // names of exactly that shape, in the file's own folder: the file itself, its
    // neighbours and any other `.tmp-` name stay. `unlink` removes a link and never
    // follows it, and can't remove a folder, which is left as it is. It never throws:
    // a folder that is missing or can't be listed is 0, and a file that won't go is
    // not counted.
    async sweep() {
      const dir = dirname(path), prefix = `${basename(path)}.tmp-`;
      let names;
      try { names = await readdir(dir); } catch { return 0; }
      let removed = 0;
      for (const name of names) {
        if (!name.startsWith(prefix) || !TEMP_TAIL.test(name.slice(prefix.length))) continue;
        const file = join(dir, name);
        try {
          if (now() - (await lstat(file)).mtimeMs < SWEEP_MIN_AGE_MS) continue;
          await unlink(file);
          removed++;
        } catch { /* gone already, a folder, or not ours to remove */ }
      }
      return removed;
    }
  };
}
