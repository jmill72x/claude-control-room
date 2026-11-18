// The log line for an early reset (Ultron's 11-18 low a, board 41c18bc0): when a limit
// read under RESET_BELOW_PCT makes prune forget told warnings that would otherwise
// have stayed, the notifier logs one line for that limit, naming its label and nothing
// else, so the log says why its next warning came before the printed reset. The rule
// itself is in limit-early-reset.test.mjs. Every time is local; every figure invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNotifier } from '../collectors/notifier.mjs';
import { prune } from '../lib/push-alerts.mjs';
import { NO_RESET_KEEP_MS } from '../lib/limit-warnings.mjs';

const at = (...parts) => new Date(...parts).getTime();
const iso = t => new Date(t).toISOString();
const T0 = at(2026, 9, 19, 10, 30);
const WEEK_END = at(2026, 9, 19, 19, 0);
const W1 = at(2026, 9, 19, 14, 30);
const SESSION = 'Current session', WEEK = 'Weekly · all models';
const WEEK90 = `limit-step:${WEEK}:90:${WEEK_END}`;
const KEY80 = `limit-step:${SESSION}:80:${W1}`, KEY95 = `limit-step:${SESSION}:95:${W1}`;
const USAGE = new Set(['limit-step']);
const recorder = () => { const seen = []; return { seen, onReset: label => seen.push(label) }; };

test('prune names each limit whose told keys the reset rule forgot, once a limit, and only those', () => {
  const r = recorder();
  const sent = { [KEY80]: T0, [KEY95]: T0, [WEEK90]: T0, 'limit:x': T0 };
  const out = prune(sent, [], USAGE, W1 - 60e3, [{ label: SESSION, pct: 3 }, { label: WEEK, pct: 2 }], r.onReset);
  assert.deepEqual(out, { 'limit:x': T0 });
  assert.deepEqual(r.seen.sort(), [SESSION, WEEK].sort(), 'two steps of one limit are one name');
});

test('prune names no limit whose keys were going anyway, were kept, or are live', () => {
  const low = [{ label: SESSION, pct: 3 }];
  const sent = { [KEY80]: T0 };
  // The window is over: the key goes by the window rule, not the reset rule.
  const over = recorder();
  assert.deepEqual(prune(sent, [], USAGE, W1, low, over.onReset), {});
  assert.deepEqual(over.seen, []);
  // A key with no reset in it, past its fixed keep: also not the reset rule's doing.
  const noReset = recorder();
  const bare = `limit-step:${SESSION}:80:-`;
  assert.deepEqual(prune({ [bare]: T0 }, [], USAGE, T0 + NO_RESET_KEEP_MS, low, noReset.onReset), {});
  assert.deepEqual(noReset.seen, []);
  // Inside its keep, the same key is the reset rule's.
  const inKeep = recorder();
  assert.deepEqual(prune({ [bare]: T0 }, [], USAGE, T0 + NO_RESET_KEEP_MS - 1, low, inKeep.onReset), {});
  assert.deepEqual(inKeep.seen, [SESSION]);
  // Read at or over the mark, live, or with the panel unread: kept, and no name.
  for (const [why, args] of [
    ['over the mark', [sent, [], USAGE, T0, [{ label: SESSION, pct: 40 }]]],
    ['live', [sent, [{ key: KEY80 }], USAGE, T0, low]],
    ['usage unread', [sent, [], new Set(), T0, low]],
    ['no clock', [sent, [{ key: KEY80 }], USAGE, null, low]]
  ]) {
    const r = recorder();
    prune(...args, r.onReset);
    assert.deepEqual(r.seen, [], why);
  }
  // Without a callback nothing is called, and the answer is the same.
  assert.deepEqual(prune(sent, [], USAGE, T0, low), {});
  assert.deepEqual(prune(sent, [], USAGE, T0, low, 'not a function'), {});
});

const snapshot = limits => ({ crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] }, usage: { status: 'ok', data: { limits } } });
const harness = (initial = {}) => {
  const store = { ...initial };
  return { store, readSent: async () => store, writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); } };
};

test('the notifier logs one line a limit for an early reset, with the label alone, and only on the pass that forgets', async () => {
  const lines = [];
  const h = harness();
  const run = (limits, now) => runNotifier({ snapshot: snapshot(limits), config: {}, now, ...h, send: async () => ({ sent: true }), log: l => lines.push(l) });
  await run([{ label: SESSION, pct: 96, resetsAt: iso(W1) }, { label: WEEK, pct: 93, resetsAt: iso(WEEK_END) }], T0);
  assert.deepEqual(lines, [], 'telling logs nothing here');
  await run([{ label: SESSION, pct: 2, resetsAt: iso(W1) }, { label: WEEK, pct: 93, resetsAt: iso(WEEK_END) }], T0 + 60e3);
  assert.deepEqual(lines, ['push: Current session read under 40%; its told warnings are forgotten']);
  await run([{ label: SESSION, pct: 1, resetsAt: iso(W1) }, { label: WEEK, pct: 93, resetsAt: iso(WEEK_END) }], T0 + 120e3);
  assert.equal(lines.length, 1, 'nothing left to forget, nothing said');
});

test('the logged label is one line, cut short, with an invisible character shown as a mark', async () => {
  const lines = [];
  // (A line break can't be in a told key at all: keyParts' pattern stops at one.)
  const label = `Week${String.fromCodePoint(0x202e)}desrever ${'x'.repeat(200)}`;
  const key = `limit-step:${label}:90:${WEEK_END}`;
  const h = harness({ [key]: T0 });
  await runNotifier({ snapshot: snapshot([{ label, pct: 1, resetsAt: iso(WEEK_END) }]), config: {}, now: T0 + 60e3, ...h, send: async () => ({ sent: true }), log: l => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(String.fromCodePoint(0x202e)), 'no real direction character');
  assert.ok(lines[0].includes('⟦U+202E⟧'), 'it is shown');
  assert.ok(lines[0].includes(' more cut'), 'and the label is cut');
  assert.ok(lines[0].length < 160, `short: ${lines[0].length}`);
  assert.ok(lines[0].endsWith(' read under 40%; its told warnings are forgotten'));
});
