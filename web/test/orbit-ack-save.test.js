// Acknowledge + Save on the strip (board e7427be1's scope add, 11-26: "Acknowledge
// doesn't actually do anything"): a saved alert leaves at once, before the reload; a later
// instance shows again; a save with no answer fails in words, never sits on "Saving…".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideSaved, savedId } from '../src/lib/orbit/acks.js';
import { ack, ACK_TIMEOUT_MS } from '../src/orbit/ackApi.js';

const a = { key: 'local:jarvis-down:aaaaaaaaaaaa', kind: 'local', since: 5 };
const b = { key: 'cron:launchd:com.example.tuesday', kind: 'cron', since: 7 };

test('a saved alert leaves the strip at once; another instance of it shows', () => {
  assert.deepEqual(hideSaved([a, b], new Set([savedId(a)])), [b]);
  assert.deepEqual(hideSaved([{ ...a, since: 9 }, b], new Set([savedId(a)])), [{ ...a, since: 9 }, b]);
  assert.deepEqual(hideSaved([a, b], new Set()), [a, b]);
  assert.deepEqual(hideSaved(null, new Set([savedId(a)])), []);
  assert.equal(savedId({ key: 'k' }), 'k@');
});

test('ack: the list on a 200, the server\'s words on a refusal, and a fixed line when nothing answers', async () => {
  assert.equal(ACK_TIMEOUT_MS, 15e3);
  const ok = await ack({ key: a.key }, { fetchImpl: async (url, init) => { assert.equal(url, '/api/acks'); assert.equal(init.method, 'POST'); return { ok: true, json: async () => [{ key: a.key }] }; } });
  assert.deepEqual(ok, [{ key: a.key }]);
  await assert.rejects(ack({ key: a.key }, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'cross-origin write refused' }) }) }), /cross-origin write refused/);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  // Raced, so a save with no timeout fails here rather than hanging the run.
  const raced = Promise.race([ack({ key: a.key }, { fetchImpl: hang, timeoutMs: 20 }), new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting')), 500))]);
  await assert.rejects(raced, /no answer from the server in 0 s/);
  await assert.rejects(ack({ key: a.key }, { fetchImpl: async () => { throw new TypeError('Load failed'); } }), /did not reach the server \(Load failed\)/);
});
