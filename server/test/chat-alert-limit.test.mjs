// The chat's alert rate limit (lib/chat-alert-limit.mjs): a refused channel and a
// takeover push at most once per kind per 10 minutes, with a count of the ones held
// back. A fake clock and fake timers; nothing is pushed anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertLimiter, CHAT_ALERT_WINDOW_MS, LIMITED_KINDS, heldSuffix, heldSummary } from '../lib/chat-alert-limit.mjs';

const MIN = 60e3;
const T0 = 1794380000000;

const harness = () => {
  const h = { now: T0, sent: [], timers: [], errors: [] };
  h.limiter = createAlertLimiter({
    send: async m => { if (h.failNext) { h.failNext = false; throw new Error('ntfy down'); } h.sent.push(m); },
    clock: () => h.now,
    setTimer: (fn, ms) => { h.timers.push({ fn, at: h.now + ms }); },
    onError: e => h.errors.push(e.message)
  });
  // Run every timer due by now, as the event loop would.
  h.tick = async to => {
    h.now = to;
    const due = h.timers.filter(t => t.at <= to);
    h.timers = h.timers.filter(t => t.at > to);
    for (const t of due) await t.fn();
  };
  return h;
};

test('the window, the kinds and the words', () => {
  assert.equal(CHAT_ALERT_WINDOW_MS, 10 * MIN);
  assert.deepEqual(Object.keys(LIMITED_KINDS).sort(), ['client-refused', 'client-replaced']);
  assert.equal(heldSuffix(3), ' (and 3 more held back in the last 10 minutes)');
  assert.equal(heldSummary('client-refused', 2), '2 more refused second chat channels held back in the last 10 minutes');
  assert.equal(heldSummary('client-replaced', 1), '1 more chat channel takeovers held back in the last 10 minutes');
});

test('a refused channel pushes once per 10 minutes; the rest are counted and the count goes out when the window ends', async () => {
  const h = harness();
  assert.deepEqual(await h.limiter.alert('client-refused', 'refused'), { sent: true, held: 0 });
  h.now = T0 + MIN;
  assert.deepEqual(await h.limiter.alert('client-refused', 'refused'), { sent: false, held: 1 });
  h.now = T0 + 9 * MIN;
  assert.deepEqual(await h.limiter.alert('client-refused', 'refused'), { sent: false, held: 2 });
  assert.equal(h.limiter.held('client-refused'), 2);
  assert.deepEqual(h.sent, ['refused']);
  assert.equal(h.timers.length, 1, 'one end-of-window timer, not one per hold');
  assert.equal(h.timers[0].at, T0 + CHAT_ALERT_WINDOW_MS, 'set for the end of the window that began with the push');
  await h.tick(T0 + 10 * MIN - 1);
  assert.deepEqual(h.sent, ['refused'], 'not before the window ends');
  await h.tick(T0 + 10 * MIN);
  assert.deepEqual(h.sent, ['refused', '2 more refused second chat channels held back in the last 10 minutes']);
  assert.equal(h.limiter.held('client-refused'), 0);
  // The count was that window's push: the next refusal within 10 minutes of it waits.
  h.now = T0 + 15 * MIN;
  assert.deepEqual(await h.limiter.alert('client-refused', 'refused'), { sent: false, held: 1 });
  h.now = T0 + 20 * MIN;
  assert.deepEqual(await h.limiter.alert('client-refused', 'refused again'), { sent: true, held: 0 }, 'a push, carrying the count, as the window ended');
  assert.equal(h.sent.at(-1), 'refused again (and 1 more held back in the last 10 minutes)');
  // The timer set at +15 for +20 finds a new window and pushes nothing early.
  h.now = T0 + 20 * MIN + 1;
  assert.deepEqual(await h.limiter.alert('client-refused', 'refused'), { sent: false, held: 1 });
  const before = h.sent.length;
  await h.tick(T0 + 20 * MIN + 2);
  assert.equal(h.sent.length, before, 'a timer that outlived its window does nothing');
  await h.tick(T0 + 30 * MIN + 1);
  assert.equal(h.sent.at(-1), '1 more refused second chat channels held back in the last 10 minutes');
});

test('each limited kind has its own window, and the other kinds are never held', async () => {
  const h = harness();
  await h.limiter.alert('client-refused', 'refused');
  assert.deepEqual(await h.limiter.alert('client-replaced', 'taken over'), { sent: true, held: 0 }, 'not held by a refusal');
  assert.deepEqual(await h.limiter.alert('client-replaced', 'taken over'), { sent: false, held: 1 });
  for (let i = 0; i < 3; i++) assert.deepEqual(await h.limiter.alert('paired', `paired ${i}`), { sent: true, held: 0 });
  assert.deepEqual(h.sent, ['refused', 'taken over', 'paired 0', 'paired 1', 'paired 2']);
  assert.equal(h.limiter.held('paired'), 0);
  await h.tick(T0 + 10 * MIN);
  assert.deepEqual(h.sent.slice(5), ['1 more chat channel takeovers held back in the last 10 minutes'], 'no count for a kind with none held');
});

test('a window with nothing held ends quietly, and a later event pushes as the first', async () => {
  const h = harness();
  await h.limiter.alert('client-replaced', 'taken over');
  assert.equal(h.timers.length, 0, 'no timer until something is held');
  h.now = T0 + 10 * MIN;
  assert.deepEqual(await h.limiter.alert('client-replaced', 'taken over'), { sent: true, held: 0 }, 'exactly 10 minutes on is a new window');
  assert.deepEqual(h.sent, ['taken over', 'taken over']);
  await h.limiter.flushNow('client-replaced');
  await h.limiter.flushNow('never-seen');
  assert.equal(h.sent.length, 2);
});

test('a failed push throws to the caller; a failed timed count goes to onError', async () => {
  const h = harness();
  h.failNext = true;
  await assert.rejects(h.limiter.alert('client-refused', 'refused'), /ntfy down/);
  h.now = T0 + MIN;
  assert.equal((await h.limiter.alert('client-refused', 'refused')).sent, false, 'the failed push still began the window');
  h.failNext = true;
  await h.tick(T0 + 10 * MIN);
  assert.deepEqual(h.errors, ['ntfy down']);
});

test('the default timer is unref\'d, so a held count never keeps the process up', async () => {
  const refTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  // A short window, so a ref'd timer (the bug) would still let the run end.
  const limiter = createAlertLimiter({ send: async () => {}, windowMs: 300 });
  await limiter.alert('client-refused', 'a');
  const before = refTimers();
  await limiter.alert('client-refused', 'b');
  assert.equal(limiter.held('client-refused'), 1);
  assert.equal(refTimers(), before, 'the end-of-window timer holds no ref on the loop');
});
