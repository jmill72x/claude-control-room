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
import { readFile, writeFile, rename, unlink, mkdir, readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// `suffix` names the temp file's random part (tests give their own).
export function createSentStore(path, { suffix = () => randomBytes(4).toString('hex') } = {}) {
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
    // (`<name>.tmp-…`), and says how many went. For the server's start, before its
    // first write: every one found then is stale, whatever process id its name
    // carries (a restarted server can be given the old one's). Only names of exactly
    // that pattern, in the file's own folder: the file itself and its neighbours stay.
    // `unlink` removes a link and never follows it, and can't remove a folder, which
    // is left as it is. It never throws: a folder that is missing or can't be listed
    // is 0, and a file that won't go is not counted.
    async sweep() {
      const dir = dirname(path), prefix = `${basename(path)}.tmp-`;
      let names;
      try { names = await readdir(dir); } catch { return 0; }
      let removed = 0;
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        try { await unlink(join(dir, name)); removed++; } catch { /* gone already, a folder, or not ours to remove */ }
      }
      return removed;
    }
  };
}
