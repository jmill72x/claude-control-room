import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNotifier } from '../collectors/notifier.mjs';

const okUsage = limits => ({ status: 'ok', data: { limits } });
const base = limits => ({
  crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] },
  usage: okUsage(limits)
});
const harness = (initial = {}) => {
  const store = { ...initial };
  const sent = [];
  return {
    store, sent,
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { sent.push(msg); return { sent: true }; }
  };
};

test('a newly-appeared alert is sent once', async () => {
  const h = harness();
  const snap = base([{ label: 'Weekly · X', pct: 90 }]);
  const first = await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(first.sent, 1);
  assert.equal(h.sent.length, 1);

  const second = await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(second.sent, 0);
  assert.equal(h.sent.length, 1);
});

test('a moving percentage does not re-send', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 86 }]), config: cfg, now: Date.now(), ...h });
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 91 }]), config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 1);
});

test('a cleared condition that returns sends again', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 90 }]), config: cfg, now: Date.now(), ...h });
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 10 }]), config: cfg, now: Date.now(), ...h });
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 90 }]), config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 2);
});

test('nothing is pushed from a panel that is not ok', async () => {
  const h = harness();
  const snap = {
    crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] },
    usage: { status: 'stale', data: { limits: [{ label: 'Weekly · X', pct: 90 }] } }
  };
  const out = await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(out.sent, 0);
  assert.equal(h.sent.length, 0);
});

test('a failed send is not recorded as notified, so it retries next run', async () => {
  const store = {};
  const attempts = [];
  const h = {
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { attempts.push(msg); return { sent: false, reason: 'network down' }; }
  };
  const snap = base([{ label: 'Weekly · X', pct: 90 }]);
  await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(attempts.length, 2, 'a push that never landed must be retried');
  assert.deepEqual(store, {});
});

test('a throwing send does not escape', async () => {
  const h = harness();
  h.send = async () => { throw new Error('boom'); };
  const snap = base([{ label: 'Weekly · X', pct: 90 }]);
  await assert.doesNotReject(() => runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h }));
});

test('cron alerts are counted, and each key deduped separately', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  const two = {
    crons: { status: 'ok', data: [{ name: 'a', label: 'l:a', ok: false }, { name: 'b', label: 'l:b', ok: false }] },
    ingestCrons: { status: 'ok', data: [] }, usage: okUsage([])
  };
  await runNotifier({ snapshot: two, config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /2 scheduled jobs failed/);

  const three = {
    crons: { status: 'ok', data: [
      { name: 'a', label: 'l:a', ok: false }, { name: 'b', label: 'l:b', ok: false }, { name: 'c', label: 'l:c', ok: false }
    ] },
    ingestCrons: { status: 'ok', data: [] }, usage: okUsage([])
  };
  await runNotifier({ snapshot: three, config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 2, 'a third failing job is new and must notify');
});
