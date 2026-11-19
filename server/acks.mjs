// The ack file: server/data/acks.json (gitignored, beside notified.json), a JSON
// list written whole on each change. Reads prune expired entries; writes prune
// them too and keep at most ACK_MAX. One write at a time, in order. Each write goes
// to a temp file beside it, mode 0600, then takes the file's place by rename, so a
// crash mid-write leaves the old list, never half of a new one, and the file is
// only ever the service user's to read (the 2026-11-10 security review).
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { activeAcks, addAck, removeAck } from './lib/acks.mjs';

export function createAckStore(path) {
  let queue = Promise.resolve();
  const serial = fn => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  async function load() {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  let writes = 0;
  async function persist(list) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${++writes}`;
    try {
      await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return list;
  }

  // What the last un-ack of each key took away, so a re-ack of the same failure counts
  // as a renewal (lib/acks.mjs, addAck; Ultron's 11-12 low). In memory only, and dropped
  // once that ack would have run out: kept in the file, an older server reading it (a
  // rollback) would take it for a live ack. So the count survives an un-ack, not a restart.
  const removed = new Map();
  const forgetLapsed = now => { for (const [k, a] of removed) if (!(a.until > now)) removed.delete(k); };

  return {
    read: async (now = Date.now()) => activeAcks(await load(), now),
    add: (ack, now = Date.now()) => serial(async () => {
      forgetLapsed(now);
      const list = await persist(addAck(await load(), ack, now, { removed: removed.get(ack.key) ?? null }));
      removed.delete(ack.key);
      return list;
    }),
    remove: (key, now = Date.now()) => serial(async () => {
      forgetLapsed(now);
      const list = await load();
      const gone = activeAcks(list, now).find(a => a.key === key);
      const kept = await persist(removeAck(list, key, now));
      if (gone) removed.set(key, gone);
      return kept;
    })
  };
}
