// Limit warnings, hardened after Ultron's read (his lows, board 0dcdb867): a told key
// with no reset time is forgotten at a real reset, a missed device's later tries are
// spaced by time, and a higher step takes over what the step under it owed. The first
// build's tests are in limit-warnings.test.mjs, push-alerts.test.mjs and
// notifier-limit.test.mjs. Every time is built in local time; every figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNotifier, readLimitState, LIMIT_STATE } from '../collectors/notifier.mjs';
import { prune } from '../lib/push-alerts.mjs';
import { resetLabels, RESET_BELOW_PCT, NO_RESET_KEEP_MS, DEVICE_RETRIES, DEVICE_RETRY_GAP_MS, REPEAT_MS, SESSION_STEPS, WEEKLY_STEPS } from '../lib/limit-warnings.mjs';

const at = (...parts) => new Date(...parts).getTime();
const iso = t => new Date(t).toISOString();
const T0 = at(2026, 10, 17, 9, 0);
const W1 = at(2026, 10, 17, 17, 30);
const SESSION = 'Current session', WEEK = 'Weekly · all models';
const NO_RESET_80 = `limit-step:${SESSION}:80:-`;
const KEY80 = `limit-step:${SESSION}:80:${W1}`, KEY95 = `limit-step:${SESSION}:95:${W1}`;
const USAGE = new Set(['limit-step']);
const toldKeys = store => Object.keys(store).filter(k => k !== LIMIT_STATE);
const snapshot = (limits, status = 'ok') => ({ crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] }, usage: { status, data: { limits } } });
const harness = (initial = {}) => {
  const store = { ...initial };
  return { store, readSent: async () => store, writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); } };
};
// A send that plays the server's: the alert leg lands unless `alertOk` is false, the
// device leg answers from a script, one answer a call (then "nothing to try").
const legs = script => {
  const calls = [];
  const send = async entry => {
    calls.push(entry);
    const { alertOk = true, ...answer } = script.shift() ?? { tried: 0, reached: 0, missed: [] };
    return entry.devicesOnly ? { sent: answer.reached > 0, devices: answer } : { sent: alertOk || answer.reached > 0, devices: answer };
  };
  return { calls, send };
};
const miss = (...ids) => ({ tried: ids.length, reached: 0, missed: ids });
const lands = { tried: 1, reached: 1, missed: [] };

// ---- (a) a key with no reset time, and the next window ----

test('the reset mark is under half the lowest step', () => {
  assert.equal(RESET_BELOW_PCT, 40);
  assert.ok(RESET_BELOW_PCT <= Math.min(...SESSION_STEPS, ...WEEKLY_STEPS) / 2);
});

test('resetLabels: the limits read under the mark now, by label; a reading that is no number says nothing', () => {
  const limits = [{ label: SESSION, pct: 39.9 }, { label: WEEK, pct: 40 }, { label: 'Weekly · A', pct: 0 }, { label: 'Weekly · B', pct: '3' }, { label: 'Weekly · C', pct: null }, { label: 'Weekly · D', pct: NaN }, { label: 'Weekly · E' }, null];
  assert.deepEqual([...resetLabels(limits)], [SESSION, 'Weekly · A']);
  for (const none of [null, undefined, 'x', 7, {}, []]) assert.deepEqual([...resetLabels(none)], []);
});

test('prune: a told key with no reset time is forgotten as soon as its own limit is read under the mark, and only then', () => {
  const sent = { [NO_RESET_80]: T0 };
  const soon = T0 + 60e3;
  const session = pct => [{ label: SESSION, pct }];
  assert.deepEqual(prune(sent, [], USAGE, soon, session(39)), {}, 'a real reset: the next window may warn');
  assert.deepEqual(prune(sent, [], USAGE, soon, session(0)), {});
  assert.deepEqual(prune(sent, [], USAGE, soon, session(40)), sent, 'at the mark it is a dip');
  assert.deepEqual(prune(sent, [], USAGE, soon, session(79)), sent);
  assert.deepEqual(prune(sent, [], USAGE, soon, [{ label: WEEK, pct: 3 }]), sent, 'another limit\'s reading says nothing of this one');
  assert.deepEqual(prune(sent, [], USAGE, soon, [{ label: SESSION, pct: 85 }, { label: WEEK, pct: 3 }]), sent);
  for (const none of [null, undefined, [], 'x', [{ label: SESSION }], [{ label: SESSION, pct: '3' }]]) assert.deepEqual(prune(sent, [], USAGE, soon, none), sent, 'no reading: kept its five hours');
  assert.deepEqual(prune(sent, [], USAGE, soon), sent, 'and so without the readings at all');
  assert.deepEqual(prune(sent, [], new Set(), soon, session(3)), sent, 'usage unread: kept, as any key is');
  assert.deepEqual(prune(sent, [{ key: NO_RESET_80 }], USAGE, soon, session(3)), sent, 'still raised: kept, as any alert is');
  // Each limit on its own, a weekly one too.
  const weekKey = `limit-step:${WEEK}:90:-`;
  const both = { [NO_RESET_80]: T0, [weekKey]: T0 };
  assert.deepEqual(prune(both, [], USAGE, soon, [{ label: WEEK, pct: 2 }, { label: SESSION, pct: 60 }]), { [NO_RESET_80]: T0 });
  assert.deepEqual(prune(both, [], USAGE, soon, [{ label: WEEK, pct: 2 }, { label: SESSION, pct: 2 }]), {});
});

// Until 2026-11-18 a key that named its window was kept to the printed reset whatever
// was read meanwhile. A reading under the mark now forgets it too (an early reset;
// limit-early-reset.test.mjs has that rule). What stays true is here: a dip keeps it.
test('prune: a key that names its window is kept until that reset through any reading at or over the mark', () => {
  const sent = { [KEY80]: T0, [KEY95]: T0 };
  for (const pct of [RESET_BELOW_PCT, 60, 79, 100]) assert.deepEqual(prune(sent, [], USAGE, W1 - 1, [{ label: SESSION, pct }]), sent, String(pct));
  assert.deepEqual(prune(sent, [], USAGE, W1 - 1, [{ label: WEEK, pct: 0 }]), sent, 'another limit\'s reading is not this one\'s');
  assert.deepEqual(prune(sent, [], USAGE, W1, [{ label: SESSION, pct: 60 }]), {});
});

test('with no reset time, the next window still warns: a low reading between the two forgets the key, and what it owed', async () => {
  const h = harness();
  const { calls, send } = legs([miss('aa'), lands]);
  const run = (pct, now) => runNotifier({ snapshot: snapshot([{ label: SESSION, pct, resetsAt: null }]), config: {}, now, ...h, send });
  assert.equal((await run(82, T0)).sent, 1);
  assert.deepEqual(Object.keys(h.store[LIMIT_STATE].owed), [NO_RESET_80]);
  // An hour on the window has reset; two hours on the new one is high. Both inside
  // the five hours the key would have been kept.
  await run(3, T0 + 3600e3);
  assert.deepEqual(toldKeys(h.store), [], 'forgotten at the reset');
  assert.deepEqual(h.store[LIMIT_STATE].owed, {}, 'and its debt with it');
  const next = await run(81, T0 + 2 * 3600e3);
  assert.equal(next.sent, 1, 'the new window\'s warning is told');
  assert.ok(2 * 3600e3 < NO_RESET_KEEP_MS);
  assert.deepEqual(calls.map(c => [c.message, c.devicesOnly]), [['Claude session at 82%', undefined], ['Claude session at 81%', undefined]]);
});

test('a low reading from a panel that is not current forgets nothing', async () => {
  const h = harness({ [NO_RESET_80]: T0 });
  await runNotifier({ snapshot: snapshot([{ label: SESSION, pct: 3, resetsAt: null }], 'stale'), config: {}, now: T0 + 60e3, ...h, send: async () => ({ sent: true }) });
  assert.deepEqual(toldKeys(h.store), [NO_RESET_80]);
});

// ---- (b) a missed device's later tries, by time ----

const sessionAt = pct => snapshot([{ label: SESSION, pct, resetsAt: iso(W1) }]);
const T = at(2026, 10, 17, 14, 0);

test('a missed device is tried again no sooner than four minutes after the try before, however many passes come between', async () => {
  assert.equal(DEVICE_RETRY_GAP_MS, 4 * 60e3);
  assert.ok(DEVICE_RETRY_GAP_MS < 5 * 60e3, 'under the notifier\'s own five minutes, so each of its ticks may try');
  const h = harness();
  const { calls, send } = legs([miss('aa'), miss('aa'), lands]);
  const run = now => runNotifier({ snapshot: sessionAt(81), config: {}, now, ...h, send });
  await run(T);
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 0, missed: ['aa'], at: T } });
  // A pass ten seconds later (one follows each usage poll), and one a millisecond short.
  for (const soon of [T + 10e3, T + DEVICE_RETRY_GAP_MS - 1]) {
    const out = await run(soon);
    assert.deepEqual([out.sent, out.skipped, out.retried], [0, 1, undefined]);
  }
  assert.equal(calls.length, 1, 'no try yet');
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 0, missed: ['aa'], at: T } }, 'and a pass that leaves it uses up none of its tries');
  const second = await run(T + DEVICE_RETRY_GAP_MS);
  assert.deepEqual([second.retried, second.skipped], [1, 0]);
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 1, missed: ['aa'], at: T + DEVICE_RETRY_GAP_MS } }, 'the gap runs from this try now');
  await run(T + DEVICE_RETRY_GAP_MS + 1e3);
  await run(T + 2 * DEVICE_RETRY_GAP_MS - 1);
  assert.equal(calls.length, 2);
  await run(T + 2 * DEVICE_RETRY_GAP_MS);
  assert.equal(calls.length, 3);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {}, 'it landed');
});

test('passes seconds apart never use up the three tries: they span at least twelve minutes', async () => {
  const h = harness();
  const { calls, send } = legs([miss('aa'), miss('aa'), miss('aa'), miss('aa')]);
  const tries = [];
  for (let now = T; now <= T + 20 * 60e3; now += 15e3) {
    const before = calls.length;
    await runNotifier({ snapshot: sessionAt(81), config: {}, now, ...h, send, log: () => {} });
    if (calls.length > before) tries.push(now - T);
  }
  assert.deepEqual(tries, [0, 1, 2, 3].map(n => n * DEVICE_RETRY_GAP_MS), 'the telling, then three tries four minutes apart');
  assert.equal(tries.length - 1, DEVICE_RETRIES);
});

test('a debt\'s time is read strictly: a number not ahead of now, else 0, long ago, so a try is due', async () => {
  const debt = at => ({ [LIMIT_STATE]: { told: [], owed: { [KEY80]: { passes: 0, missed: ['aa'], ...(at === undefined ? {} : { at }) } } } });
  const read = at => readLimitState(debt(at)[LIMIT_STATE], T).owed[KEY80].at;
  assert.deepEqual([read(T - 5), read(T), read(0)], [T - 5, T, 0]);
  for (const odd of [undefined, null, T + 1, String(T - 5), 'x', NaN, Infinity, {}]) assert.equal(read(odd), 0, String(odd));
  // A file the version before this wrote (no time), and one from a clock since set back.
  for (const stored of [undefined, T + 3600e3]) {
    const h = harness({ [KEY80]: T - 60e3, ...debt(stored) });
    const { calls, send } = legs([miss('aa')]);
    const out = await runNotifier({ snapshot: sessionAt(81), config: {}, now: T, ...h, send });
    assert.equal(out.retried, 1, String(stored));
    assert.deepEqual(calls.map(c => [c.devicesOnly, c.only]), [[true, ['aa']]]);
    assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 1, missed: ['aa'], at: T } });
  }
});

// ---- (d) a higher step takes over what the step under it owed ----

test('when the higher step is told, what the lower step still owed is dropped: no later try says less than was already said', async () => {
  const h = harness();
  const { calls, send } = legs([miss('aa'), lands]);
  const run = (pct, now) => runNotifier({ snapshot: sessionAt(pct), config: {}, now, ...h, send });
  await run(81, T);
  assert.deepEqual(Object.keys(h.store[LIMIT_STATE].owed), [KEY80]);
  // A minute later, inside the gap, the session passes 95%: told whole, to every device.
  const up = await run(96, T + 60e3);
  assert.equal(up.sent, 1);
  assert.deepEqual(calls[1].keys, [KEY95, KEY80]);
  assert.equal(calls[1].devicesOnly, undefined);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {}, 'every device took the 95% line, so nothing is owed');
  // Back under 95%, the 80% line is live again and long told: nothing more goes out.
  const dip = await run(90, T + REPEAT_MS);
  assert.deepEqual([dip.sent, dip.skipped, dip.retried], [0, 1, undefined]);
  assert.equal(calls.length, 2);
});

test('the higher step owes on its own when it misses a device too; one that was not told leaves the lower step\'s debt alone', async () => {
  const h = harness();
  const { calls, send } = legs([miss('aa'), { alertOk: false, ...miss('aa', 'bb') }, miss('bb')]);
  const run = (pct, now) => runNotifier({ snapshot: sessionAt(pct), config: {}, now, ...h, send });
  await run(81, T);
  // The 95% telling lands nowhere: it is not told, and stays to be told whole.
  assert.equal((await run(96, T + 60e3)).sent, 0);
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY80]: { passes: 0, missed: ['aa'], at: T } });
  assert.deepEqual(toldKeys(h.store), [KEY80]);
  assert.equal((await run(96, T + 120e3)).sent, 1);
  assert.deepEqual(h.store[LIMIT_STATE].owed, { [KEY95]: { passes: 0, missed: ['bb'], at: T + 120e3 } });
  assert.deepEqual(calls.map(c => c.devicesOnly), [undefined, undefined, undefined]);
});
