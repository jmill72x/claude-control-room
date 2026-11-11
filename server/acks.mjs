// The ack file: server/data/acks.json (gitignored, beside notified.json), a JSON
// list written whole on each change. Reads prune expired entries; writes prune
// them too and keep at most ACK_MAX. One write at a time, in order.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

  async function persist(list) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(list, null, 2));
    return list;
  }

  return {
    read: async (now = Date.now()) => activeAcks(await load(), now),
    add: (ack, now = Date.now()) => serial(async () => persist(addAck(await load(), ack, now))),
    remove: (key, now = Date.now()) => serial(async () => persist(removeAck(await load(), key, now)))
  };
}
