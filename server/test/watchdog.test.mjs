import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdog } from '../lib/watchdog.mjs';

// On 2026-10-02 the server was found alive for four days, collectors still
// ticking, but holding no listening socket: every request hung and the page
// on the phone was blank. Nothing was logged. launchd's KeepAlive only helps
// if the process exits, so the server probes itself and exits when it is deaf.
const probes = results => {
  let i = 0;
  return async () => { const r = results[i++]; if (r instanceof Error) throw r; return r; };
};

test('three consecutive failed self-checks declare the server dead, once', async () => {
  const dead = [];
  const w = createWatchdog({ probe: probes([new Error('timeout'), new Error('ECONNREFUSED'), new Error('timeout'), new Error('timeout')]), onDead: r => dead.push(r) });
  for (let i = 0; i < 4; i++) await w.tick();
  assert.equal(dead.length, 1);
  assert.match(dead[0], /3 consecutive/);
});

test('a single failure followed by a success never triggers a restart', async () => {
  const dead = [];
  const w = createWatchdog({ probe: probes([new Error('blip'), true, new Error('blip'), new Error('blip'), true]), onDead: r => dead.push(r) });
  for (let i = 0; i < 5; i++) await w.tick();
  assert.deepEqual(dead, []);
});

test('a probe that answers but not with ok counts as a failure', async () => {
  const dead = [];
  const w = createWatchdog({ probe: probes([false, false, false]), onDead: r => dead.push(r) });
  for (let i = 0; i < 3; i++) await w.tick();
  assert.equal(dead.length, 1);
});

test('a probe that never settles is cut off by the timeout and counts as a failure', async () => {
  const dead = [];
  const w = createWatchdog({ probe: () => new Promise(() => {}), onDead: r => dead.push(r), timeoutMs: 10 });
  for (let i = 0; i < 3; i++) await w.tick();
  assert.equal(dead.length, 1);
});
