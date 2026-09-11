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
  assert.match(h.sent[0].message, /2 items need attention/);

  const three = {
    crons: { status: 'ok', data: [
      { name: 'a', label: 'l:a', ok: false }, { name: 'b', label: 'l:b', ok: false }, { name: 'c', label: 'l:c', ok: false }
    ] },
    ingestCrons: { status: 'ok', data: [] }, usage: okUsage([])
  };
  await runNotifier({ snapshot: three, config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 2, 'a third failing job is new and must notify');
});

// --- Critical fix: a restart (or any run) that cannot yet see a source must
// not treat that source's alerts as cleared. registry.startAll() fires every
// collector at once, so the notifier's first run can land before the slow
// `/usage` collector (which shells out to `claude`) has written anything.

test('a snapshot where usage has not been observed yet leaves a previously-notified limit key in place and pushes nothing new for it', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };

  const withUsage = base([{ label: 'Weekly · X', pct: 90 }]);
  await runNotifier({ snapshot: withUsage, config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(Object.keys(h.store), ['limit:Weekly · X']);

  // Cold start: the usage collector has not written to the cache yet, so its
  // cache entry does not exist at all (not even as 'stale').
  const cold = { crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] } };
  const out = await runNotifier({ snapshot: cold, config: cfg, now: Date.now(), ...h });
  assert.equal(out.sent, 0, 'usage is unobserved, so nothing should push');
  assert.equal(h.sent.length, 1, 'no new push must occur while usage is unobserved');
  assert.deepEqual(Object.keys(h.store), ['limit:Weekly · X'], 'the previously-notified key must survive a run that cannot observe it');
});

test('the full restart sequence — notify, cold-start with an incomplete cache, then a fully populated cache — does not wipe the notified set or re-push', async () => {
  const store = {};
  const sent = [];
  const readSent = async () => store;
  const writeSent = async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); };
  const send = async msg => { sent.push(msg); return { sent: true }; };
  const cfg = { warnThreshold: 85 };

  const full = {
    crons: { status: 'ok', data: [{ name: 'nightly', label: 'net.example.nightly', ok: false }] },
    ingestCrons: { status: 'ok', data: [] },
    usage: okUsage([{ label: 'Weekly · X', pct: 90 }])
  };
  await runNotifier({ snapshot: full, config: cfg, now: Date.now(), readSent, writeSent, send });
  assert.deepEqual(Object.keys(store).sort(), ['cron:launchd:net.example.nightly', 'limit:Weekly · X']);
  assert.equal(sent.length, 2, 'the disclosed limit and the counted cron push separately');

  // Restart: registry.startAll() runs every collector at once, so the first
  // notifier tick after a restart can see crons before usage has landed.
  const coldStart = {
    crons: { status: 'ok', data: [{ name: 'nightly', label: 'net.example.nightly', ok: false }] },
    ingestCrons: { status: 'ok', data: [] }
    // usage: absent — the collector has not run yet on this process lifetime
  };
  await runNotifier({ snapshot: coldStart, config: cfg, now: Date.now(), readSent, writeSent, send });
  assert.deepEqual(Object.keys(store).sort(), ['cron:launchd:net.example.nightly', 'limit:Weekly · X'],
    'a cold start must not wipe keys belonging to a source it cannot observe');
  assert.equal(sent.length, 2, 'nothing should be pushed while usage remains unobserved');

  // Usage catches up on its own timer tick; the reading is unchanged.
  await runNotifier({ snapshot: full, config: cfg, now: Date.now(), readSent, writeSent, send });
  assert.equal(sent.length, 2, 'the same, still-live conditions must not re-push once usage becomes observable again');
});

test('a promo-expiry alert still pushes when every panel is stale, because credits are config-backed rather than panel-backed', async () => {
  const h = harness();
  const now = Date.parse('2026-09-01T00:00:00Z');
  const cfg = { warnThreshold: 85, credits: { promoExpiresOn: '2026-09-19' } };
  const snap = {
    crons: { status: 'stale', data: [] },
    ingestCrons: { status: 'stale', data: [] },
    usage: { status: 'stale', data: { limits: [] } }
  };
  const out = await runNotifier({ snapshot: snap, config: cfg, now, ...h });
  assert.equal(out.sent, 1);
  assert.match(h.sent[0].message, /Promotional credit expires/);
});

// The dormant bug behind todo push-ingest-observability: an ingest-fed cron
// alert was forgotten on every poster gap (panel absent or >5min stale) because
// launchd being readable made the whole `cron` kind look observable, so the
// same failing job re-pushed every time the poster came back.
test('an ingested cron alert survives a poster gap without re-pushing when the poster returns', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  const failing = [{ name: 'cloud-job', label: 'cloud:job', ok: false }];
  const posterUp = { crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: failing }, usage: okUsage([]) };
  const posterGap = { crons: { status: 'ok', data: [] }, ingestCrons: { status: 'stale', data: failing }, usage: okUsage([]) };
  const posterGone = { crons: { status: 'ok', data: [] }, usage: okUsage([]) };

  await runNotifier({ snapshot: posterUp, config: cfg, now: 1, ...h });
  assert.equal(h.sent.length, 1, 'first sighting pushes');
  await runNotifier({ snapshot: posterGap, config: cfg, now: 2, ...h });
  await runNotifier({ snapshot: posterGone, config: cfg, now: 3, ...h });
  await runNotifier({ snapshot: posterUp, config: cfg, now: 4, ...h });
  assert.equal(h.sent.length, 1, 'the same still-failing job must not re-push after the poster gap');
});

test('a launchd cron key is still forgotten when launchd is readable and the job recovered, even during a poster gap', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  const failing = { crons: { status: 'ok', data: [{ name: 'a', label: 'l:a', ok: false }] }, usage: okUsage([]) };
  const recovered = { crons: { status: 'ok', data: [{ name: 'a', label: 'l:a', ok: true }] }, usage: okUsage([]) };
  await runNotifier({ snapshot: failing, config: cfg, now: 1, ...h });
  await runNotifier({ snapshot: recovered, config: cfg, now: 2, ...h });
  assert.deepEqual(Object.keys(h.store), [], 'a cleared launchd job is forgotten so a later failure notifies again');
});
