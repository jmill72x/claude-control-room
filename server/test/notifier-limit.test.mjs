// The notifier's limit warnings (lib/limit-warnings.mjs; collectors/notifier.mjs): the
// steps through runNotifier, entrySender's two legs, what a missed device is owed, the
// backstop caps, the kept state, and server.mjs's wiring read as source. The notifier's
// other tests are in notifier.test.mjs. Every time is built in local time and every
// figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runNotifier, entrySender, readLimitState, LIMIT_STATE } from '../collectors/notifier.mjs';
import { REPEAT_MS, DAILY_MAX, DEVICE_RETRIES, NO_RESET_KEEP_MS } from '../lib/limit-warnings.mjs';

// The told keys in a store, without the limit warnings' own entry.
const toldKeys = store => Object.keys(store).filter(k => k !== LIMIT_STATE);

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

// ---- limit warnings (lib/limit-warnings.mjs): 80% and 95% of the session, 90% of a week ----

const at = (...parts) => new Date(...parts).getTime();
const W1 = at(2026, 10, 17, 17, 30), W2 = at(2026, 10, 17, 22, 30);
const iso = t => new Date(t).toISOString();
const sessionAt = (pct, reset = W1) => base([{ label: 'Current session', pct, resetsAt: iso(reset) }]);
const cfg85 = { warnThreshold: 85 };

test('the session limit warns at 80% and again at 95%, once each per window; the next window warns anew', async () => {
  const h = harness();
  let now = at(2026, 10, 17, 14, 0);
  const run = (pct, reset = W1) => { now += 5 * 60e3; return runNotifier({ snapshot: sessionAt(pct, reset), config: cfg85, now, ...h }); };
  await run(79);
  assert.equal(h.sent.length, 0, 'under the first step');
  await run(80);
  assert.deepEqual(h.sent, [{ keys: [`limit-step:Current session:80:${W1}`], title: 'Control Room', message: 'Claude session at 80%, resets 5:30 pm', devices: true }]);
  await run(87);
  assert.equal(h.sent.length, 1, 'past the alert bar\'s 85%: its line is not pushed, and the step is already told');
  await run(94);
  assert.equal(h.sent.length, 1);
  await run(96);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].message, 'Claude session at 96%, resets 5:30 pm');
  assert.deepEqual(h.sent[1].keys, [`limit-step:Current session:95:${W1}`, `limit-step:Current session:80:${W1}`]);
  await run(100);
  await run(100);
  assert.equal(h.sent.length, 2, 'nothing more in this window');
  // The window rolls over: low again, then the same steps tell again.
  now = W1 + 60e3;
  await run(3, W2);
  assert.deepEqual(toldKeys(h.store), [], 'the old window\'s keys are forgotten once it has reset');
  await run(81, W2);
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].message, 'Claude session at 81%, resets 10:30 pm');
});

test('a reading that dips under a step and comes back, or a reset printed a minute apart, tells nothing twice', async () => {
  const h = harness();
  let now = at(2026, 10, 17, 14, 0);
  const run = (pct, reset = W1) => { now += 5 * 60e3; return runNotifier({ snapshot: sessionAt(pct, reset), config: cfg85, now, ...h }); };
  await run(82);
  await run(82, W1 - 60e3);
  await run(83, W1);
  assert.equal(h.sent.length, 1, 'one window, whichever minute was printed');
  await run(70);
  await run(84);
  assert.equal(h.sent.length, 1, 'a dip and a return');
  await run(96);
  await run(60);
  await run(97, W1 - 60e3);
  assert.equal(h.sent.length, 2, 'the same for the second step');
});

test('a jump past both steps is one message; a window that already warned at 100% warns again when the next one is high at its first reading', async () => {
  const h = harness();
  const now = at(2026, 10, 17, 14, 0);
  await runNotifier({ snapshot: sessionAt(70), config: cfg85, now, ...h });
  await runNotifier({ snapshot: sessionAt(97), config: cfg85, now: now + 5 * 60e3, ...h });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message, 'Claude session at 97%, resets 5:30 pm');
  assert.deepEqual(toldKeys(h.store).sort(), [`limit-step:Current session:80:${W1}`, `limit-step:Current session:95:${W1}`]);
  // No low reading in between (the poll was down across the reset).
  await runNotifier({ snapshot: sessionAt(85, W2), config: cfg85, now: W1 + 10 * 60e3, ...h });
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].message, 'Claude session at 85%, resets 10:30 pm');
});

test('each weekly limit warns once at 90%, on its own, and not at the alert bar\'s 85%', async () => {
  const h = harness();
  let now = at(2026, 10, 17, 14, 0);
  const reset = iso(at(2026, 10, 23, 19, 0));
  const run = (all, model) => { now += 5 * 60e3; return runNotifier({ snapshot: base([{ label: 'Weekly · all models', pct: all, resetsAt: reset }, { label: 'Weekly · Fable', pct: model, resetsAt: reset }]), config: cfg85, now, ...h }); };
  await run(86, 89);
  assert.equal(h.sent.length, 0);
  await run(86, 90);
  assert.deepEqual(h.sent.map(e => e.message), ['Claude week (Fable) at 90%, resets Mon 7:00 pm']);
  await run(91, 93);
  assert.deepEqual(h.sent.map(e => e.message).slice(1), ['Claude week (all models) at 91%, resets Mon 7:00 pm']);
  await run(99, 100);
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent.every(e => e.devices === true));
});

test('a limit warning is raised only from a current usage panel, and a stale one forgets nothing', async () => {
  const h = harness();
  const now = at(2026, 10, 17, 14, 0);
  const stale = { ...sessionAt(96), usage: { status: 'stale', data: sessionAt(96).usage.data } };
  assert.equal((await runNotifier({ snapshot: stale, config: cfg85, now, ...h })).sent, 0);
  await runNotifier({ snapshot: sessionAt(96), config: cfg85, now, ...h });
  assert.equal(h.sent.length, 1);
  // Past the reset with the panel stale: the key stays, so nothing repeats when it reads again.
  await runNotifier({ snapshot: stale, config: cfg85, now: W1 + 60e3, ...h });
  assert.equal(toldKeys(h.store).length, 2);
});

test('a limit warning that fails to send is tried again on the next run', async () => {
  const h = harness();
  const now = at(2026, 10, 17, 14, 0);
  let ok = false;
  const send = async e => { h.sent.push(e); return { sent: ok }; };
  await runNotifier({ snapshot: sessionAt(81), config: cfg85, now, ...h, send });
  assert.deepEqual(Object.keys(h.store), [], 'nothing told, nothing kept');
  ok = true;
  await runNotifier({ snapshot: sessionAt(82), config: cfg85, now: now + 5 * 60e3, ...h, send });
  await runNotifier({ snapshot: sessionAt(83), config: cfg85, now: now + 10 * 60e3, ...h, send });
  assert.equal(h.sent.length, 2, 'once failed, once sent, then no more');
});

test('entrySender: a limit warning goes to the devices and as an alert; anything else only as an alert', async () => {
  const calls = [];
  const alert = async e => { calls.push(['alert', e.message]); return { sent: true, ntfy: { sent: false }, discord: { sent: true } }; };
  const devices = async (body, opts) => { calls.push(['devices', body, opts]); return { tried: 2, reached: 2, missed: [] }; };
  const send = entrySender({ alert, devices });
  const warning = { keys: ['k'], title: 'Control Room', message: 'Claude session at 80%, resets 5:30 pm', devices: true };
  assert.deepEqual(await send(warning), { sent: true, ntfy: { sent: false }, discord: { sent: true }, devices: { tried: 2, reached: 2, missed: [] } });
  assert.deepEqual(calls, [['devices', warning.message, { only: null }], ['alert', warning.message]], 'the devices first, all of them');
  calls.length = 0;
  const plain = { keys: ['c'], title: 'Control Room', message: '1 job failed — open the dashboard for detail' };
  assert.deepEqual(await send(plain), { sent: true, ntfy: { sent: false }, discord: { sent: true } });
  assert.deepEqual(calls, [['alert', plain.message]]);
});

test('entrySender: landing on the devices or as an alert counts as sent, and neither half\'s failure skips the other', async () => {
  const warning = { keys: ['k'], title: 'Control Room', message: 'Claude session at 80%, resets 5:30 pm', devices: true };
  const down = async () => ({ sent: false, reason: 'down' });
  const up = async () => ({ sent: true });
  const logs = [];
  const log = l => logs.push(l);
  const reach = (tried, reached, missed = []) => async () => ({ tried, reached, missed });
  const NONE = { tried: 0, reached: 0, missed: [] };
  assert.equal((await entrySender({ alert: down, devices: reach(1, 1), log })(warning)).sent, true, 'the devices alone');
  assert.equal((await entrySender({ alert: up, devices: reach(1, 0, ['aa']), log })(warning)).sent, true, 'the alert alone');
  assert.deepEqual(await entrySender({ alert: down, devices: reach(2, 0, ['aa', 'bb']), log })(warning), { sent: false, reason: 'down', devices: { tried: 2, reached: 0, missed: ['aa', 'bb'] } });
  // With the chat off there is no device push at all.
  assert.deepEqual(await entrySender({ alert: up, devices: null, log })(warning), { sent: true, devices: NONE });
  assert.deepEqual(await entrySender({ alert: down, log })(warning), { sent: false, reason: 'down', devices: NONE });
  // A device push that throws is logged and the alert still goes; an alert that throws
  // does not undo a push that landed.
  let alerted = 0;
  const out = await entrySender({ alert: async () => { alerted++; return { sent: true }; }, devices: async () => { throw new Error('boom'); }, log })(warning);
  assert.deepEqual(out, { sent: true, devices: { ...NONE, failed: true } }, 'and the leg says it failed, so it is tried again');
  assert.equal(alerted, 1);
  assert.deepEqual(logs, ['push: a limit warning failed (boom)']);
  const thrown = await entrySender({ alert: async () => { throw new Error('poster gone'); }, devices: reach(1, 1), log })(warning);
  assert.deepEqual(thrown, { sent: true, reason: 'poster gone', devices: { tried: 1, reached: 1, missed: [] } });
  assert.equal((await entrySender({ alert: async () => { throw new Error('poster gone'); }, devices: reach(1, 0, ['aa']), log })(warning)).sent, false);
  // An odd answer from the devices is no device, and only ids are taken as missed.
  for (const odd of ['many', 3, null, undefined, { tried: 'x', reached: -1, missed: 'aa' }, { tried: 1.5, reached: 2.5 }]) {
    assert.deepEqual(await entrySender({ alert: down, devices: async () => odd, log })(warning), { sent: false, reason: 'down', devices: NONE }, JSON.stringify(odd));
  }
  assert.deepEqual((await entrySender({ alert: up, devices: async () => ({ tried: 3, reached: 1, missed: ['aa', 7, '', 'rm -rf', null, 'b0'] }), log })(warning)).devices, { tried: 3, reached: 1, missed: ['aa', 'b0'] });
});

// server.mjs can't run in a test, so its wiring is read as source: the notifier sends
// through entrySender with the device push, which is set once the chat's push service
// exists.
test('server.mjs sends every notifier entry through entrySender, with the push service\'s limitWarning for the devices', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /send: entrySender\(\{ alert: entry => sendAlert\(\{ topic, title: entry\.title, message: entry\.message \}\), devices: limitPush \}\),/);
  assert.match(src, /\n {2}limitPush = body => push\.limitWarning\(body\);\n/);
  assert.equal(src.match(/limitPush = /g).length, 2, 'null until the chat is on, then set once');
});

test('entrySender: a later try for the devices is the devices alone, those named, and no second alert', async () => {
  const calls = [];
  const alert = async e => { calls.push(['alert', e.message]); return { sent: true }; };
  const devices = async (body, opts) => { calls.push(['devices', body, opts]); return { tried: 1, reached: 1, missed: [] }; };
  const warning = { keys: ['k'], title: 'Control Room', message: 'Claude session at 82%, resets 5:30 pm', devices: true };
  assert.deepEqual(await entrySender({ alert, devices })({ ...warning, devicesOnly: true, only: ['aa'] }), { sent: true, devices: { tried: 1, reached: 1, missed: [] } });
  assert.deepEqual(calls, [['devices', warning.message, { only: ['aa'] }]]);
  calls.length = 0;
  await entrySender({ alert, devices })({ ...warning, devicesOnly: true, only: null });
  await entrySender({ alert, devices })({ ...warning, devicesOnly: true, only: 'aa' });
  assert.deepEqual(calls.map(c => c[2]), [{ only: null }, { only: null }], 'no list is every device');
  assert.deepEqual(await entrySender({ alert, devices: async () => ({ tried: 1, reached: 0, missed: ['aa'] }) })({ ...warning, devicesOnly: true, only: ['aa'] }), { sent: false, devices: { tried: 1, reached: 0, missed: ['aa'] } });
  assert.deepEqual(await entrySender({ alert, devices: null })({ ...warning, devicesOnly: true }), { sent: false, devices: { tried: 0, reached: 0, missed: [] } });
  assert.equal(calls.filter(c => c[0] === 'alert').length, 0, 'never an alert');
});

// ---- the device leg on its own (Ultron, 11-17): a warning #pepper took is still owed to a device it missed ----

// A send that plays the server's: the alert leg lands or not, the device leg answers
// from a script, one answer per call.
const legs = ({ alertOk = true, script }) => {
  const calls = [];
  const send = async entry => {
    calls.push(entry);
    const answer = script.shift() ?? { tried: 0, reached: 0, missed: [] };
    if (answer === 'throw') throw new Error('boom');
    return entry.devicesOnly ? { sent: answer.reached > 0, devices: answer } : { sent: alertOk || answer.reached > 0, devices: answer };
  };
  return { calls, send };
};
const passes = (h, send, logs = []) => {
  let now = at(2026, 10, 17, 14, 0);
  return { run: (pct, reset = W1) => { now += 5 * 60e3; return runNotifier({ snapshot: sessionAt(pct, reset), config: cfg85, now, ...h, send, log: l => logs.push(l) }); }, at: t => { now = t; } };
};
const KEY80 = `limit-step:Current session:80:${W1}`;

test('a warning the alert took but a device missed: that device alone is tried again, with no second alert, until it lands', async () => {
  const h = harness();
  const { calls, send } = legs({ script: [{ tried: 2, reached: 1, missed: ['aa'] }, { tried: 1, reached: 0, missed: ['aa'] }, { tried: 1, reached: 1, missed: [] }] });
  const logs = [];
  const p = passes(h, send, logs);
  const first = await p.run(81);
  assert.equal(first.sent, 1);
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 0, missed: ['aa'] } });
  const second = await p.run(82);
  assert.deepEqual([second.sent, second.retried, second.skipped, second.capped], [0, 1, 0, undefined]);
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 1, missed: ['aa'] } });
  const third = await p.run(83);
  assert.equal(third.retried, 1);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {}, 'it landed');
  const fourth = await p.run(84);
  assert.deepEqual([fourth.retried, fourth.skipped], [undefined, 1]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map(c => [c.devicesOnly, c.only, c.message]), [[true, ['aa'], 'Claude session at 82%, resets 5:30 pm'], [true, ['aa'], 'Claude session at 83%, resets 5:30 pm']]);
  assert.equal(calls[0].devicesOnly, undefined);
  assert.equal(h.store[LIMIT_STATE].told.length, 1, 'a later try is not a telling');
  assert.deepEqual(logs, [], 'nothing to say when it lands');
});

test('a device that keeps missing is tried on three later passes and no more; the list narrows as devices land', async () => {
  assert.equal(DEVICE_RETRIES, 3);
  const h = harness();
  const logs = [];
  const miss = ids => ({ tried: ids.length, reached: 0, missed: ids });
  const { calls, send } = legs({ script: [miss(['aa', 'bb']), { tried: 2, reached: 1, missed: ['bb'] }, miss(['bb']), miss(['bb']), miss(['bb'])] });
  const p = passes(h, send, logs);
  await p.run(81);
  await p.run(81);
  assert.deepEqual(h.store[LIMIT_STATE].owed[KEY80], { passes: 1, missed: ['bb'] });
  await p.run(81);
  assert.deepEqual(h.store[LIMIT_STATE].owed[KEY80], { passes: 2, missed: ['bb'] });
  assert.deepEqual(logs, []);
  await p.run(81);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {});
  assert.deepEqual(logs, ['push: a limit warning did not reach every device in 3 more tries; no more are made']);
  await p.run(81);
  await p.run(81);
  assert.equal(calls.length, 4, 'one telling and three later tries');
  assert.deepEqual(calls.slice(1).map(c => c.only), [['aa', 'bb'], ['bb'], ['bb']]);
});

test('nothing is owed when there was nothing to try, when every device took it, or when a subscription was gone', async () => {
  for (const answer of [{ tried: 0, reached: 0, missed: [] }, { tried: 2, reached: 2, missed: [] }, { tried: 2, reached: 1, missed: [] }]) {
    const h = harness();
    const { calls, send } = legs({ script: [answer] });
    const p = passes(h, send);
    await p.run(81);
    await p.run(82);
    assert.equal(calls.length, 1, JSON.stringify(answer));
    assert.deepEqual(h.store[LIMIT_STATE].owed, {});
  }
});

test('a device push that threw is owed to every device; a later try that throws counts as a try and keeps the list', async () => {
  const h = harness();
  const { calls, send } = legs({ script: [{ tried: 0, reached: 0, missed: [], failed: true }, { tried: 2, reached: 1, missed: ['bb'] }, 'throw', { tried: 1, reached: 1, missed: [] }] });
  const p = passes(h, send);
  await p.run(81);
  assert.deepEqual(h.store[LIMIT_STATE].owed[KEY80], { passes: 0, missed: null });
  const second = await p.run(81);
  assert.equal(second.retried, 1);
  assert.deepEqual(h.store[LIMIT_STATE].owed[KEY80], { passes: 1, missed: ['bb'] });
  const third = await p.run(81);
  assert.equal(third.retried, 1);
  assert.deepEqual(h.store[LIMIT_STATE].owed[KEY80], { passes: 2, missed: ['bb'] }, 'the throw was a try, and the list stands');
  await p.run(81);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {}, 'the third landed');
  assert.deepEqual(calls.slice(1).map(c => c.only), [null, ['bb'], ['bb']]);
});

test('a warning nothing took is told again whole on the next pass, and owes nothing meanwhile', async () => {
  const h = harness();
  const { calls, send } = legs({ alertOk: false, script: [{ tried: 1, reached: 0, missed: ['aa'] }, { tried: 1, reached: 1, missed: [] }] });
  const p = passes(h, send);
  assert.equal((await p.run(81)).sent, 0);
  assert.deepEqual(Object.keys(h.store), []);
  assert.equal((await p.run(82)).sent, 1);
  assert.deepEqual(calls.map(c => c.devicesOnly), [undefined, undefined]);
});

test('what is owed ends with its window: after the reset nothing is tried, and the next step owes on its own', async () => {
  const h = harness();
  const miss = { tried: 1, reached: 0, missed: ['aa'] };
  const { calls, send } = legs({ script: [miss, miss, miss] });
  const p = passes(h, send);
  await p.run(81);
  await p.run(96);
  assert.deepEqual(Object.keys(h.store[LIMIT_STATE].owed).sort(), [KEY80, `limit-step:Current session:95:${W1}`], 'the 95% telling is new and whole');
  assert.equal(calls[1].devicesOnly, undefined);
  p.at(W1 + 60e3);
  await p.run(4, W2);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {});
  assert.equal(calls.length, 2);
});

test('the kept state is read strictly: anything not in shape is dropped, and with nothing to keep the file holds no entry', async () => {
  const now = at(2026, 10, 17, 14, 0);
  assert.deepEqual(readLimitState(undefined, now), { told: [], owed: {} });
  for (const junk of [null, 7, 'x', [], { told: 'x', owed: [] }, { told: {}, owed: 'x' }, { owed: 7 }, { owed: [{ passes: 0 }] }]) assert.deepEqual(readLimitState(junk, now), { told: [], owed: {} });
  const read = readLimitState({
    told: [
      { at: now - 60e3, label: 'Current session', step: 80, extra: 'x' }, { at: now, label: 'A', step: 90 },
      { at: now + 1, label: 'Current session', step: 80 }, { at: now - 24 * 3600e3, label: 'Current session', step: 80 },
      { at: 'x', label: 'Current session', step: 80 }, { at: String(now - 60e3), label: 'Current session', step: 80 }, { at: now, label: 7, step: 80 }, { at: now, label: 'Current session', step: 80.5 }, null
    ],
    owed: {
      [KEY80]: { passes: 1, missed: ['aa', 'rm -rf', 7] }, 'limit-step:Weekly · A:90:-': { passes: 0, missed: 'aa' },
      'cron:launchd:x': { passes: 0, missed: ['aa'] }, [`limit-step:B:80:${W1}`]: { passes: 3, missed: ['aa'] },
      [`limit-step:C:80:${W1}`]: { passes: -1, missed: [] }, [`limit-step:D:80:${W1}`]: { passes: 1.5 }, [`limit-step:E:80:${W1}`]: null
    }
  }, now);
  assert.deepEqual(read.told, [{ at: now - 60e3, label: 'Current session', step: 80 }, { at: now, label: 'A', step: 90 }]);
  assert.deepEqual(read.owed, { [KEY80]: { passes: 1, missed: ['aa'] }, 'limit-step:Weekly · A:90:-': { passes: 0, missed: null } });
  // Through a pass: a day-old telling and a debt with no told key are gone, and so is the entry.
  const h = harness({ [LIMIT_STATE]: { told: [{ at: now - 24 * 3600e3, label: 'Current session', step: 80 }], owed: { [KEY80]: { passes: 0, missed: ['aa'] } } } });
  await runNotifier({ snapshot: sessionAt(10), config: cfg85, now, ...h });
  assert.deepEqual(Object.keys(h.store), []);
  // A debt whose key is still told is kept on its own, its telling a day past: a
  // weekly window outlasts the list of tellings.
  const weekKey = `limit-step:Weekly · all models:90:${at(2026, 10, 23, 19, 0)}`;
  const owing = harness({ [weekKey]: now - 25 * 3600e3, [LIMIT_STATE]: { told: [{ at: now - 25 * 3600e3, label: 'Weekly · all models', step: 90 }], owed: { [weekKey]: { passes: 1, missed: ['aa'] } } } });
  await runNotifier({ snapshot: sessionAt(10), config: cfg85, now, ...owing });
  assert.deepEqual(owing.store[LIMIT_STATE], { told: [], owed: { [weekKey]: { passes: 1, missed: ['aa'] } } });
});

// ---- the backstop caps (Ultron, 11-17) ----

test('the backstop: a limit whose key keeps changing is told once in 30 minutes, unless its step rises', async () => {
  assert.equal(REPEAT_MS, 30 * 60e3);
  const h = harness();
  let now = at(2026, 10, 17, 9, 0);
  // A reset time that moves 20 minutes with every reading: each is a new key.
  let reset = at(2026, 10, 17, 17, 0);
  const run = (pct, step = 5 * 60e3) => { now += step; reset += 20 * 60e3; return runNotifier({ snapshot: sessionAt(pct, reset), config: cfg85, now, ...h }); };
  assert.equal((await run(81)).sent, 1);
  for (let i = 0; i < 5; i++) {
    const out = await run(82);
    assert.deepEqual([out.sent, out.capped], [0, 1], `pass ${i}`);
  }
  assert.equal(h.sent.length, 1, '25 minutes on');
  assert.equal((await run(83)).sent, 1, 'at 30 minutes');
  assert.equal((await run(84)).capped, 1);
  const risen = await run(96);
  assert.deepEqual([risen.sent, risen.capped], [1, undefined], 'the next step is told at once');
  assert.equal((await run(97)).capped, 1, 'and then holds like any other');
  assert.equal(h.sent.length, 3);
  // Put off, not dropped: a warning that was over the cap is told on the first pass
  // with room, under the same key.
  const steady = harness();
  const t0 = at(2026, 10, 17, 9, 0);
  const early = at(2026, 10, 17, 13, 0), later = at(2026, 10, 17, 13, 40);
  await runNotifier({ snapshot: sessionAt(81, early), config: cfg85, now: t0, ...steady });
  for (const min of [5, 10, 25]) assert.equal((await runNotifier({ snapshot: sessionAt(82, later), config: cfg85, now: t0 + min * 60e3, ...steady })).capped, 1);
  assert.deepEqual(toldKeys(steady.store), [`limit-step:Current session:80:${early}`], 'the waiting one is not marked told');
  assert.equal((await runNotifier({ snapshot: sessionAt(83, later), config: cfg85, now: t0 + 30 * 60e3, ...steady })).sent, 1);
  assert.equal(steady.sent[1].message, 'Claude session at 83%, resets 1:40 pm');
  // Another limit has its own half hour.
  const week = await runNotifier({ snapshot: base([{ label: 'Weekly · all models', pct: 91, resetsAt: iso(at(2026, 10, 23, 19, 0)) }]), config: cfg85, now: now + 60e3, ...h });
  assert.equal(week.sent, 1);
});

test('the backstop: at most 12 tellings of one limit in any 24 hours; one over waits for room', async () => {
  assert.equal(DAILY_MAX, 12);
  const h = harness();
  let now = at(2026, 10, 17, 0, 0);
  let reset = at(2026, 10, 18, 12, 0);
  const run = (step = 31 * 60e3) => { now += step; reset += 20 * 60e3; return runNotifier({ snapshot: sessionAt(81, reset), config: cfg85, now, ...h }); };
  for (let i = 0; i < 12; i++) assert.equal((await run()).sent, 1, `telling ${i + 1}`);
  const first = now - 11 * 31 * 60e3;
  for (let i = 0; i < 3; i++) assert.deepEqual([(await run()).capped, h.sent.length], [1, 12]);
  // A weekly limit is counted on its own.
  assert.equal((await runNotifier({ snapshot: base([{ label: 'Weekly · all models', pct: 91, resetsAt: iso(at(2026, 10, 23, 19, 0)) }]), config: cfg85, now: now + 1, ...h })).sent, 1);
  // The first telling is 24 hours old: room for one more.
  now = first + 24 * 3600e3 - 60e3 - 31 * 60e3;
  assert.equal((await run()).capped, 1, 'a minute short of 24 hours');
  now = first + 24 * 3600e3 - 31 * 60e3;
  assert.equal((await run()).sent, 1);
  assert.equal(h.store[LIMIT_STATE].told.filter(t => t.label === 'Current session').length, 12, 'the list holds only the last 24 hours');
});

test('a warning with no reset time is kept for five hours once told: a reading that comes and goes is one telling', async () => {
  assert.equal(NO_RESET_KEEP_MS, 5 * 3600e3);
  const h = harness();
  const t0 = at(2026, 10, 17, 9, 0);
  const run = (pct, now) => runNotifier({ snapshot: base([{ label: 'Current session', pct, resetsAt: null }]), config: cfg85, now, ...h });
  assert.equal((await run(82, t0)).sent, 1);
  await run(10, t0 + 40 * 60e3);
  assert.deepEqual(toldKeys(h.store), ['limit-step:Current session:80:-'], 'kept though it cleared');
  assert.equal((await run(83, t0 + 45 * 60e3)).sent, 0);
  await run(10, t0 + NO_RESET_KEEP_MS - 1);
  assert.deepEqual(toldKeys(h.store), ['limit-step:Current session:80:-']);
  await run(10, t0 + NO_RESET_KEEP_MS);
  assert.deepEqual(toldKeys(h.store), [], 'five hours on, it is forgotten');
  assert.equal((await run(84, t0 + NO_RESET_KEEP_MS + 60e3)).sent, 1);
});

test('server.mjs runs a notifier pass right after each usage poll', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /registry\.register\('usage', async \(\) => \{[^]*?\n\}, 5 \* 60 \* 1000, \{ then: 'notifier' \}\);/);
  assert.match(src, /registry\.register\('notifier', async \(\) => \{/);
});
