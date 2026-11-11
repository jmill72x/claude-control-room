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

  return {
    read: async (now = Date.now()) => activeAcks(await load(), now),
    add: (ack, now = Date.now()) => serial(async () => persist(addAck(await load(), ack, now))),
    remove: (key, now = Date.now()) => serial(async () => persist(removeAck(await load(), key, now)))
  };
}
