// The notifier's full line and back line (collectors/notifier.mjs; board 1e2d7926,
// Ultron's 11-19 M5): at 100% one full line to the devices and #jarvis, once per window;
// once every limit told full has reset, one back line to the devices and one "limit
// reset" event to the lead; the device debt of the back line; the kept state; and
// server.mjs's wiring read as source. The pieces are tested in limit-full.test.mjs.
// Every time is built in local time and every figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runNotifier, readLimitState, LIMIT_STATE } from '../collectors/notifier.mjs';
import { BACK_TEXT, DEVICE_RETRIES, DEVICE_RETRY_GAP_MS, OUT_MAX_MS, REPEAT_MS } from '../lib/limit-warnings.mjs';
import { entryAlert } from '../notify.mjs';

const at = (...parts) => new Date(...parts).getTime();
const iso = t => new Date(t).toISOString();
const W1 = at(2026, 10, 17, 17, 30), W2 = at(2026, 10, 17, 22, 30);
const WEEK = at(2026, 10, 23, 19, 0);
const S = 'Current session', A = 'Weekly · all models';
const KEY = (label, step, win) => `limit-step:${label}:${step}:${win}`;
const FULL_S = 'Jarvis is at the session limit until 5:30 pm';
const FULL_W = 'Jarvis is at the weekly limit until Mon Nov 23, 7:00 pm';

const snap = (limits, status = 'ok') => ({ crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] }, usage: { status, data: { limits } } });
const sess = (pct, reset = W1) => ({ label: S, pct, resetsAt: reset === null ? null : iso(reset) });
const all = (pct, reset = WEEK) => ({ label: A, pct, resetsAt: iso(reset) });

// A store, the entries sent, and a `send` that answers as `reply(entry)` says; the
// lead's reset hook counts its calls.
const harness = ({ initial = {}, reply = () => ({ sent: true, devices: { tried: 2, reached: 2, missed: [] } }), reset = async () => ({ status: 'made' }) } = {}) => {
  const store = { ...initial };
  const sent = [], logs = [];
  let resets = 0;
  return {
    store, sent, logs, resets: () => resets,
    run: (limits, now, extra = {}) => runNotifier({
      snapshot: Array.isArray(limits) ? snap(limits) : limits, config: {}, now,
      readSent: async () => store,
      writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
      send: async e => { sent.push(e); return reply(e); },
      limitReset: async () => { resets++; return reset(); },
      log: l => logs.push(l),
      ...extra
    })
  };
};
const backEntry = (only = null) => ({ keys: [], title: 'Control Room', message: BACK_TEXT, devices: true, devicesOnly: true, only });

test('at 100% the session is told once in its window: the full line, to the devices and #jarvis, its lower steps with it', async () => {
  const h = harness();
  let now = at(2026, 10, 17, 14, 0);
  const run = (pct, reset = W1) => { now += 5 * 60e3; return h.run([sess(pct, reset)], now); };
  await run(90);
  await run(100);
  assert.deepEqual(h.sent[1], { keys: [KEY(S, 100, W1), KEY(S, 80, W1), KEY(S, 95, W1)], title: 'Control Room', message: FULL_S, ntfyTitle: 'Jarvis at a usage limit', devices: true, feed: 'jarvis' });
  assert.deepEqual(h.store[LIMIT_STATE].out, { [S]: { win: W1, at: now } });
  await run(100);
  await run(100, W1 - 60e3);
  assert.equal(h.sent.length, 2, 'once a window, whichever minute is printed');
  // A jump from nothing to full is the one line.
  const j = harness();
  await j.run([sess(100)], now);
  assert.deepEqual(j.sent.map(e => e.message), [FULL_S]);
  assert.equal(h.resets() + j.resets(), 0, 'no event to the lead at the limit');
});

test('after the reset: one back line to the devices alone and one reset event to the lead; then nothing more', async () => {
  const h = harness();
  await h.run([sess(100)], at(2026, 10, 17, 16, 0));
  assert.deepEqual((await h.run([sess(100)], at(2026, 10, 17, 17, 0))).back, undefined);
  const out = await h.run([sess(2, W2)], W1 + 2 * 60e3);
  assert.equal(out.back, 1);
  assert.deepEqual(h.sent.slice(1), [backEntry()]);
  assert.equal(h.resets(), 1);
  assert.deepEqual(h.logs, ['push: back under the limit; the line went to 2 of 2 devices, the lead\'s event: made']);
  assert.deepEqual([h.store[LIMIT_STATE].out, h.store[LIMIT_STATE].back], [{}, null], 'nobody out, nothing owed');
  await h.run([sess(5, W2)], W1 + 7 * 60e3);
  await h.run([sess(30, W2)], W1 + 12 * 60e3);
  assert.equal(h.sent.length, 2);
  assert.equal(h.resets(), 1);
});

test('the back line waits for every limit told full: the session resets while the week is full, then the week resets', async () => {
  const h = harness();
  const t = at(2026, 10, 17, 16, 0);
  await h.run([sess(100), all(100)], t);
  assert.deepEqual(h.sent.map(e => [e.message, e.feed]), [[FULL_S, 'jarvis'], [FULL_W, 'jarvis']]);
  await h.run([sess(1, W2), all(100)], W1 + 60e3);
  assert.equal(h.sent.length, 2, 'the session is back, but the week is not');
  assert.deepEqual(Object.keys(h.store[LIMIT_STATE].out).sort(), [S, A], 'while the week reads full, the session waits out with it (L1)');
  assert.equal(h.resets(), 0);
  await h.run([sess(1, W2), all(0, at(2026, 10, 30, 19, 0))], WEEK + 60e3);
  assert.deepEqual(h.sent.at(-1), backEntry());
  assert.equal(h.resets(), 1);
});

test('a dip under 100% inside the window is not back and tells nothing; an early reset under 40% is back', async () => {
  const h = harness();
  const t = at(2026, 10, 17, 15, 0);
  await h.run([sess(100)], t);
  await h.run([sess(99)], t + 5 * 60e3);
  await h.run([sess(100)], t + 10 * 60e3);
  await h.run([sess(45)], t + 15 * 60e3);
  assert.equal(h.sent.length, 1);
  assert.equal(h.resets(), 0);
  await h.run([sess(12)], t + 20 * 60e3);
  assert.deepEqual(h.sent.at(-1), backEntry());
  assert.equal(h.resets(), 1);
});

test('a limit read full now keeps the lead out even when its own full line was not told (L1); the reset waits for it', async () => {
  // The week's full line fails to send while the session resets in the same pass.
  const h = harness({ reply: e => (e.feed === 'jarvis' && e.message === FULL_W ? { sent: false } : { sent: true, devices: { tried: 1, reached: 1, missed: [] } }) });
  await h.run([sess(100), all(50)], at(2026, 10, 17, 16, 0));
  await h.run([sess(1, W2), all(100)], W1 + 60e3);
  assert.ok(!h.sent.some(e => e.message === BACK_TEXT), 'no back line while the week reads 100%');
  assert.equal(h.resets(), 0);
  assert.deepEqual(Object.keys(h.store[LIMIT_STATE].out), [S], 'the session stays out with it');
  await h.run([sess(1, W2), all(100)], W1 + 6 * 60e3);
  assert.equal(h.resets(), 0);
  // The week is read under its full step again: everyone is back.
  await h.run([sess(1, W2), all(2, at(2026, 10, 30, 19, 0))], WEEK + 60e3);
  assert.deepEqual(h.sent.at(-1), backEntry());
  assert.equal(h.resets(), 1);
  assert.equal(h.store[LIMIT_STATE], undefined, 'nobody out, and the tellings are days old: nothing kept');
  // A model's own week at 100% keeps nobody out.
  const m = harness();
  await m.run([sess(100)], at(2026, 10, 17, 16, 0));
  await m.run([sess(1, W2), { label: 'Weekly · Fable', pct: 100, resetsAt: iso(WEEK) }], W1 + 60e3);
  assert.equal(m.resets(), 1);
});

test('a reading with no reset time inside the told window is not back until the mark or the told reset (L2)', async () => {
  const h = harness();
  const t = at(2026, 10, 17, 15, 0);
  await h.run([sess(100)], t);
  await h.run([sess(70, null)], t + 5 * 60e3);
  assert.equal(h.resets(), 0);
  await h.run([sess(70, null)], W1);
  assert.equal(h.resets(), 1, 'the told reset has passed');
});

test('only a current panel can say the limit is back; a stale one keeps the lead out', async () => {
  const h = harness();
  await h.run([sess(100)], at(2026, 10, 17, 16, 0));
  await h.run(snap([sess(2, W2)], 'stale'), W1 + 60e3);
  assert.equal(h.sent.length, 1);
  assert.ok(h.store[LIMIT_STATE].out[S]);
  await h.run([sess(2, W2)], W1 + 6 * 60e3);
  assert.equal(h.resets(), 1);
});

test('a full line that landed nowhere keeps nobody out: no back line follows it, and it is told again whole', async () => {
  let ok = false;
  const h = harness({ reply: () => ({ sent: ok, devices: { tried: 0, reached: 0, missed: [] } }) });
  await h.run([sess(100)], at(2026, 10, 17, 16, 0));
  assert.equal(h.store[LIMIT_STATE], undefined);
  await h.run([sess(2, W2)], W1 + 60e3);
  assert.equal(h.sent.length, 1);
  assert.equal(h.resets(), 0);
  ok = true;
  await h.run([sess(100, W2)], W1 + 2 * 60 * 60e3);
  assert.equal(h.sent.at(-1).message, 'Jarvis is at the session limit until 10:30 pm');
});

test('the full line keeps the backstop: after its 95% it may go at once, and its key changing tells it once in 30 minutes', async () => {
  const h = harness();
  const t = at(2026, 10, 17, 16, 0);
  await h.run([sess(96)], t);
  assert.equal((await h.run([sess(100)], t + 60e3)).sent, 1, 'a higher step goes at once');
  assert.equal((await h.run([sess(100, W1 + 20 * 60e3)], t + 2 * 60e3)).capped, 1, 'a moved reset is a new key, held by the cap');
  assert.equal((await h.run([sess(100, W1 + 20 * 60e3)], t + 60e3 + REPEAT_MS)).sent, 1);
});

test('a device the back line missed is tried again alone, spaced, up to three times; a new full line drops the debt', async () => {
  const replies = [];
  const h = harness({ reply: () => replies.shift() ?? { sent: true, devices: { tried: 2, reached: 2, missed: [] } } });
  const t = at(2026, 10, 17, 16, 0);
  await h.run([sess(100)], t);
  replies.push({ sent: true, devices: { tried: 2, reached: 1, missed: ['ab12'] } });
  const back = W1 + 60e3;
  await h.run([sess(2, W2)], back);
  assert.deepEqual(h.store[LIMIT_STATE].back, { passes: 0, missed: ['ab12'], at: back });
  await h.run([sess(2, W2)], back + DEVICE_RETRY_GAP_MS - 1);
  assert.equal(h.sent.length, 2, 'too soon');
  for (let i = 1; i <= DEVICE_RETRIES; i++) {
    replies.push({ sent: false, devices: { tried: 1, reached: 0, missed: ['ab12'] } });
    const r = await h.run([sess(2, W2)], back + i * DEVICE_RETRY_GAP_MS);
    assert.equal(r.retried, 1);
    assert.deepEqual(h.sent.at(-1), backEntry(['ab12']));
  }
  assert.equal(h.store[LIMIT_STATE].back, null, 'three more tries and no more');
  assert.ok(h.logs.includes(`push: a limit warning did not reach every device in ${DEVICE_RETRIES} more tries; no more are made`));
  assert.equal(h.resets(), 1, 'the event is not repeated with the devices');
  // A debt, then the limit full again: the full line takes over and the debt is gone.
  const g = harness({ reply: () => replies.shift() ?? { sent: true, devices: { tried: 1, reached: 1, missed: [] } } });
  await g.run([sess(100)], t);
  replies.push({ sent: true, devices: { tried: 1, reached: 0, missed: ['cd34'] } });
  await g.run([sess(2, W2)], back);
  assert.ok(g.store[LIMIT_STATE].back);
  await g.run([sess(100, W2)], back + 60e3);
  assert.equal(g.store[LIMIT_STATE].back, null);
  assert.deepEqual(g.store[LIMIT_STATE].out, { [S]: { win: W2, at: back + 60e3 } });
  await g.run([sess(100, W2)], back + 2 * DEVICE_RETRY_GAP_MS);
  assert.equal(g.sent.filter(e => e.message === BACK_TEXT).length, 1);
});

test('a back line with nothing to reach still makes the event; a send or an event that throws is logged and the lead is not kept out', async () => {
  const none = harness({ reply: e => (e.devicesOnly ? { sent: false, devices: { tried: 0, reached: 0, missed: [] } } : { sent: true }) });
  await none.run([sess(100)], at(2026, 10, 17, 16, 0));
  await none.run([sess(2, W2)], W1 + 60e3);
  assert.equal(none.resets(), 1);
  assert.equal(none.store[LIMIT_STATE].back, null, 'nothing owed');
  assert.deepEqual(none.logs, ['push: back under the limit; the line went to 0 of 0 devices, the lead\'s event: made']);
  const broken = harness({ reply: e => { if (e.devicesOnly) throw new Error('down'); return { sent: true }; }, reset: async () => { throw new Error('store full'); } });
  await broken.run([sess(100)], at(2026, 10, 17, 16, 0));
  await broken.run([sess(2, W2)], W1 + 60e3);
  assert.deepEqual(broken.logs, [
    'events: the limit-reset event failed (store full)',
    'push: back under the limit; the line went to 0 of 0 devices (the push failed), the lead\'s event: failed'
  ]);
  assert.deepEqual(broken.store[LIMIT_STATE].out, {});
  assert.deepEqual(broken.store[LIMIT_STATE].back, { passes: 0, missed: null, at: W1 + 60e3 }, 'a throw is owed to every device');
  // With no hook (the chat off) the line still goes.
  const bare = harness();
  await bare.run([sess(100)], at(2026, 10, 17, 16, 0));
  await bare.run([sess(2, W2)], W1 + 60e3, { limitReset: null });
  assert.equal(bare.sent.at(-1).message, BACK_TEXT);
  assert.ok(bare.logs[0].endsWith('the lead\'s event: none'));
});

test('the back line\'s log says what was reached and what the lead\'s event answered; a debt alone keeps the state', async () => {
  const t = at(2026, 10, 17, 16, 0);
  // Told full before a restart, the telling a day gone: only `out` was kept.
  const initial = { [LIMIT_STATE]: { told: [], owed: {}, out: { [S]: { win: W1, at: t - 25 * 3600e3 } } } };
  const h = harness({ initial, reply: () => ({ sent: true, devices: { tried: 2, reached: 1, missed: ['ab12'] } }), reset: async () => ({ status: 'held' }) });
  await h.run([sess(2, W2)], W1 + 60e3);
  assert.deepEqual(h.logs, ['push: back under the limit; the line went to 1 of 2 devices, the lead\'s event: held']);
  assert.deepEqual(h.store[LIMIT_STATE], { told: [], owed: {}, out: {}, back: { passes: 0, missed: ['ab12'], at: W1 + 60e3 } });
  const odd = harness({ initial: structuredClone(initial), reset: async () => undefined });
  await odd.run([sess(2, W2)], W1 + 60e3);
  assert.ok(odd.logs[0].endsWith('the lead\'s event: unknown'));
  assert.equal(odd.store[LIMIT_STATE], undefined, 'nothing owed and nobody out: no entry');
});

test('the lead is out across a restart: `out` is kept in the file and read strictly', async () => {
  const t = at(2026, 10, 17, 16, 0);
  const first = harness();
  await first.run([sess(100)], t);
  const second = harness({ initial: structuredClone(first.store) });
  await second.run([sess(2, W2)], W1 + 60e3);
  assert.equal(second.resets(), 1);
  const read = readLimitState({
    out: {
      [S]: { win: W1, at: t, extra: 'x' }, [A]: { win: null, at: t },
      'Weekly · Fable': { win: W1, at: t }, 'Monthly spend': { win: W1, at: t }, 'Current sessions': { win: W1, at: t },
      [`${S} `]: { win: 'soon', at: t }
    },
    back: { passes: 1, missed: ['ab12', 'not hex!'], at: t }
  }, t);
  assert.deepEqual(read.out, { [S]: { win: W1, at: t }, [A]: { win: null, at: t } });
  assert.deepEqual(read.back, { passes: 1, missed: ['ab12'], at: t });
  for (const bad of [{ win: 'x', at: t }, { win: W1, at: t + 1 }, { win: W1, at: 'x' }, { win: W1 }, { at: t }, null, 7]) {
    assert.deepEqual(readLimitState({ out: { [S]: bad } }, t).out, {}, JSON.stringify(bad));
  }
  for (const bad of [{ passes: DEVICE_RETRIES }, { passes: -1 }, { passes: 0.5 }, 'x', null]) assert.equal(readLimitState({ back: bad }, t).back, null, JSON.stringify(bad));
  assert.deepEqual(readLimitState({ back: { passes: 0, missed: 'x', at: t + 5 } }, t).back, { passes: 0, missed: null, at: 0 }, 'no list is every device; a time ahead is long ago');
});

test('a limit kept out more than eight days is dropped with a log line and no back line', async () => {
  const t = at(2026, 10, 10, 16, 0);
  const h = harness({ initial: { [LIMIT_STATE]: { told: [], owed: {}, out: { [A]: { win: null, at: t } } } } });
  await h.run([all(100, null)], t + OUT_MAX_MS - 60e3);
  assert.ok(h.store[LIMIT_STATE].out[A], 'kept till then');
  await h.run([all(100, null)], t + OUT_MAX_MS);
  assert.deepEqual(h.logs, ['push: Weekly · all models was told full more than eight days ago and never read reset; no back line for it']);
  assert.equal(h.resets(), 0);
  assert.ok(!h.sent.some(e => e.message === BACK_TEXT));
  // Dropped even while a limit reads full (L1's hold keeps only the limits still in time),
  // so the line is logged once.
  await h.run([all(100, null)], t + OUT_MAX_MS + 5 * 60e3);
  assert.equal(h.logs.length, 1);
  assert.equal(h.store[LIMIT_STATE], undefined);
});

test('server.mjs passes each entry\'s feed to the alert and the events\' limitReset to the notifier', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /alert: entryAlert\(\{ topic \}\)/);
  // entryAlert keeps the entry's feed (and its ntfy title: test/notify.test.mjs).
  const seen = [];
  await entryAlert({ topic: 't', send: async a => { seen.push(a); return { sent: true }; } })({ title: 'Control Room', message: 'm', feed: 'jarvis' });
  assert.deepEqual(seen, [{ topic: 't', title: 'Control Room', message: 'm', ntfyTitle: null, feed: 'jarvis' }]);
  assert.match(src, /\n {4}limitReset: events && \(\(\) => events\.limitReset\(\)\)\n/);
});
