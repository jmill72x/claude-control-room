// Limit warnings and a limit that is reset before its printed time (board b468ff61;
// NEXT.md section 11's follow-up f). On 2026-10-19 a weekly limit went from 93% to 0%
// eight and a half hours before the reset `/usage` printed. A told key that names its
// window used to be kept until that printed time, so a climb back to 90% in those
// hours would have warned nobody. Now any told key is forgotten once its limit is read
// under the mark: from this pass's reading alone, and never while the key is live.
// The rule for keys with no reset time is in limit-hardening.test.mjs. Every time is
// built in local time; every figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNotifier, LIMIT_STATE } from '../collectors/notifier.mjs';
import { prune } from '../lib/push-alerts.mjs';
import { RESET_BELOW_PCT, REPEAT_MS, limitWarnings } from '../lib/limit-warnings.mjs';

const at = (...parts) => new Date(...parts).getTime();
const iso = t => new Date(t).toISOString();
const T0 = at(2026, 9, 19, 10, 30);              // the telling
const WEEK_END = at(2026, 9, 19, 19, 0);         // the printed reset, 8.5 hours on
const W1 = at(2026, 9, 19, 14, 30);              // a session window's reset
const SESSION = 'Current session', WEEK = 'Weekly · all models', FABLE = 'Weekly · Fable';
const WEEK90 = `limit-step:${WEEK}:90:${WEEK_END}`;
const KEY80 = `limit-step:${SESSION}:80:${W1}`, KEY95 = `limit-step:${SESSION}:95:${W1}`;
const USAGE = new Set(['limit-step']);
const toldKeys = store => Object.keys(store).filter(k => k !== LIMIT_STATE);
const snapshot = (limits, status = 'ok') => ({ crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] }, usage: { status, data: { limits } } });
const harness = (initial = {}) => {
  const store = { ...initial };
  return { store, readSent: async () => store, writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); } };
};
const sender = (answer = () => ({ sent: true })) => {
  const calls = [];
  return { calls, send: async entry => { calls.push(entry); return answer(entry); } };
};

test('prune: a key that names its window is forgotten before that reset once its own limit is read under the mark', () => {
  const sent = { [KEY80]: T0, [KEY95]: T0 };
  const before = W1 - 3600e3;
  const session = pct => [{ label: SESSION, pct, resetsAt: iso(W1) }];
  assert.equal(RESET_BELOW_PCT, 40);
  assert.deepEqual(prune(sent, [], USAGE, before, session(39.9)), {}, 'both steps of the limit, together');
  assert.deepEqual(prune(sent, [], USAGE, before, session(0)), {});
  assert.deepEqual(prune(sent, [], USAGE, before, session(40)), sent, 'at the mark it is a dip, and a dip is one telling');
  assert.deepEqual(prune(sent, [], USAGE, before, session(79)), sent);
  // A session with no window running reads 0 with no reset time: that is a reset too.
  assert.deepEqual(prune(sent, [], USAGE, before, [{ label: SESSION, pct: 0, resetsAt: null }]), {});
  // The reading may print another reset by then (the new window's): the old keys go.
  assert.deepEqual(prune(sent, [], USAGE, before, [{ label: SESSION, pct: 4, resetsAt: iso(W1 + 5 * 3600e3) }]), {});
});

test('prune: each limit is judged by its own reading, and no reading forgets nothing', () => {
  const sent = { [KEY80]: T0, [WEEK90]: T0, [`limit-step:${FABLE}:90:${WEEK_END}`]: T0 };
  const before = W1 - 60e3;
  assert.deepEqual(prune(sent, [], USAGE, before, [{ label: WEEK, pct: 0 }, { label: SESSION, pct: 88 }, { label: FABLE, pct: 91 }]), { [KEY80]: T0, [`limit-step:${FABLE}:90:${WEEK_END}`]: T0 });
  assert.deepEqual(prune(sent, [], USAGE, before, [{ label: FABLE, pct: 3 }]), { [KEY80]: T0, [WEEK90]: T0 }, 'a limit missing from the reading keeps its key');
  for (const none of [null, undefined, [], 'x', [{ label: WEEK }], [{ label: WEEK, pct: '3' }], [{ label: WEEK, pct: null }], [{ label: WEEK, pct: NaN }]]) {
    assert.deepEqual(prune(sent, [], USAGE, before, none), sent, JSON.stringify(none) ?? 'undefined');
  }
  assert.deepEqual(prune(sent, [], USAGE, before), sent, 'and so without the readings at all');
});

test('prune: only the reading\'s own percent counts, never a figure from its history', () => {
  const sent = { [WEEK90]: T0 };
  // The row as the usage panel sends it: the percent now, and what the history store
  // adds beside it (the last window's high, the sparkline's points, the pace).
  const row = { label: WEEK, pct: 62, resetsAt: iso(WEEK_END), lastWindowPct: 3, sparkline: [0, 2, 5, 62], pace: { state: 'under', projectedPct: 12 }, history: [{ pct: 0 }] };
  assert.deepEqual(prune(sent, [], USAGE, T0 + 3600e3, [row]), sent);
  assert.deepEqual(prune(sent, [], USAGE, T0 + 3600e3, [{ ...row, pct: 12 }]), {}, 'the same row, read low now');
});

test('prune: a key that is live now is never forgotten, whatever else the reading holds', () => {
  const sent = { [KEY80]: T0, [KEY95]: T0 };
  const before = W1 - 60e3;
  // Two rows under one label, should the panel ever send them: one low, one high.
  const limits = [{ label: SESSION, pct: 3, resetsAt: iso(W1) }, { label: SESSION, pct: 97, resetsAt: iso(W1) }];
  const live = limitWarnings(limits, before);
  assert.deepEqual(live.map(w => w.key), [KEY95]);
  assert.deepEqual(prune(sent, live, USAGE, before, limits), { [KEY95]: T0 }, 'the live step stays; the one under it is not live and goes');
  assert.deepEqual(prune(sent, [{ key: KEY80 }, { key: KEY95 }], USAGE, before, limits), sent);
});

test('prune: with the usage panel unread, or without a clock, the rule is not in play', () => {
  const sent = { [WEEK90]: T0 };
  const low = [{ label: WEEK, pct: 0 }];
  assert.deepEqual(prune(sent, [], new Set(), T0 + 60e3, low), sent, 'usage not observable: kept, as any key is');
  // The event ledger calls prune without a time: a key lives while its alert does.
  assert.deepEqual(prune(sent, [{ key: WEEK90 }], USAGE, null, low), sent);
  assert.deepEqual(prune(sent, [], USAGE, null, [{ label: WEEK, pct: 95 }]), {});
});

test('the 2026-10-19 case: told at 93%, reset to 0% hours before the printed time, and the climb back to 90% is told', async () => {
  const h = harness();
  const { calls, send } = sender();
  const run = (pct, now) => runNotifier({ snapshot: snapshot([{ label: WEEK, pct, resetsAt: iso(WEEK_END) }]), config: {}, now, ...h, send });
  assert.equal((await run(93, T0)).sent, 1);
  assert.deepEqual(toldKeys(h.store), [WEEK90]);
  // Five minutes on the limit reads 0%, and the printed reset has not moved.
  const low = await run(0, T0 + 5 * 60e3);
  assert.deepEqual([low.alerts, low.sent], [0, 0]);
  assert.deepEqual(toldKeys(h.store), [], 'forgotten at the reading, not at 7:00 pm');
  // Six hours later, still before that printed time, it is high again.
  const later = T0 + 6 * 3600e3;
  assert.ok(later < WEEK_END);
  const again = await run(91, later);
  assert.equal(again.sent, 1, 'the second window\'s warning goes out');
  assert.deepEqual(calls.map(c => c.message), ['Claude week (all models) at 93%, resets 7:00 pm', 'Claude week (all models) at 91%, resets 7:00 pm']);
  assert.deepEqual(toldKeys(h.store), [WEEK90]);
  assert.equal((await run(92, later + 5 * 60e3)).sent, 0, 'and once: the key is told again');
});

test('a dip that stays over the mark is still one telling', async () => {
  const h = harness();
  const { calls, send } = sender();
  const run = (pct, now) => runNotifier({ snapshot: snapshot([{ label: WEEK, pct, resetsAt: iso(WEEK_END) }]), config: {}, now, ...h, send });
  await run(93, T0);
  await run(RESET_BELOW_PCT, T0 + 5 * 60e3);
  assert.deepEqual(toldKeys(h.store), [WEEK90], 'kept through the dip');
  assert.equal((await run(91, T0 + 6 * 3600e3)).sent, 0);
  assert.equal(calls.length, 1);
});

test('a low reading from a panel that is not current forgets nothing, and neither does a failed one', async () => {
  for (const status of ['stale', 'unavailable']) {
    const h = harness({ [WEEK90]: T0, [KEY80]: T0 });
    await runNotifier({ snapshot: snapshot([{ label: WEEK, pct: 0, resetsAt: iso(WEEK_END) }, { label: SESSION, pct: 0, resetsAt: null }], status), config: {}, now: T0 + 60e3, ...h, send: async () => ({ sent: true }) });
    assert.deepEqual(toldKeys(h.store).sort(), [KEY80, WEEK90].sort(), status);
  }
});

test('what a forgotten key still owed a device goes with it, and the new telling starts its own count', async () => {
  const h = harness();
  const script = [{ sent: true, devices: { tried: 1, reached: 0, missed: ['aa'] } }, { sent: true, devices: { tried: 1, reached: 1, missed: [] } }];
  const { calls, send } = sender(() => script.shift() ?? { sent: true, devices: { tried: 0, reached: 0, missed: [] } });
  const run = (pct, now) => runNotifier({ snapshot: snapshot([{ label: SESSION, pct, resetsAt: iso(W1) }]), config: {}, now, ...h, send });
  await run(82, T0);
  assert.deepEqual(Object.keys(h.store[LIMIT_STATE].owed), [KEY80]);
  await run(2, T0 + 60e3);
  assert.deepEqual(toldKeys(h.store), []);
  assert.deepEqual(h.store[LIMIT_STATE].owed, {}, 'no later try for a warning about a window that is over');
  const next = await run(83, T0 + REPEAT_MS);
  assert.deepEqual([next.sent, next.retried], [1, undefined]);
  assert.deepEqual(calls.map(c => [c.message, c.devicesOnly]), [['Claude session at 82%, resets 2:30 pm', undefined], ['Claude session at 83%, resets 2:30 pm', undefined]]);
});

test('the backstop still holds after an early reset: a climb back inside 30 minutes waits for its room, and is told then', async () => {
  const h = harness();
  const { calls, send } = sender();
  const run = (pct, now) => runNotifier({ snapshot: snapshot([{ label: SESSION, pct, resetsAt: iso(W1) }]), config: {}, now, ...h, send });
  await run(81, T0);
  await run(1, T0 + 5 * 60e3);
  const soon = await run(84, T0 + REPEAT_MS - 1);
  assert.deepEqual([soon.sent, soon.capped], [0, 1], 'one telling per limit in 30 minutes unless its step rises');
  assert.deepEqual(toldKeys(h.store), [], 'put off, not marked told');
  assert.equal((await run(84, T0 + REPEAT_MS)).sent, 1);
  assert.equal(calls.length, 2);
  // A higher step is never held by that cap.
  const h2 = harness();
  const two = sender();
  const run2 = (pct, now) => runNotifier({ snapshot: snapshot([{ label: SESSION, pct, resetsAt: iso(W1) }]), config: {}, now, ...h2, send: two.send });
  await run2(81, T0);
  await run2(1, T0 + 5 * 60e3);
  assert.equal((await run2(96, T0 + 10 * 60e3)).sent, 1);
  assert.deepEqual(toldKeys(h2.store).sort(), [KEY80, KEY95].sort());
});
