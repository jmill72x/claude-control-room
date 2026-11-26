// A permission wait that is still held lives past the 30-minute lapse (lib/needs-you.mjs,
// confirmWaits; board e7427be1): the transcripts say each minute whether its thread wrote
// a request after the ask. Then the 11-26 sequence replayed: the lead's own Bash prompt
// opened at 18:31 and blocked him until 20:02, and the wait went blank at 19:01. Every
// session id, agent and time here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNeedsYou, createNeedsYouStore, confirmWaits, activeWaits, recordNeedsYou, noteAsks, keptSessions, isHeld,
  agentKey, waitKey, NEEDS_YOU_TTL_MS, PERMISSION_MAX_MS, HELD_FRESH_MS
} from '../lib/needs-you.mjs';
import { threadTimes, describeWait, approvalWaits } from '../lib/approval-wait.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const NOW = 1794380000000;
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const AGENT = 'invented-agent-0001';
const post = (event, extra = {}) => checkNeedsYou({ hook_event_name: event, session_id: SID, notification_type: event === 'Notification' ? 'permission_prompt' : null, ...extra }).value;
const threads = (main, agents = {}) => new Map([[SID, { main, agents: new Map(Object.entries(agents).map(([k, v]) => [agentKey(k), v])), types: new Map() }]]);
// One sessions pass a minute from `from` to `to`, the transcripts as `pass(t)` says.
function passes(store, from, to, pass) { const out = []; for (let t = from; t <= to; t += MIN) out.push({ t, ...store.confirm(pass(t), t) }); return out; }

test('the numbers: held for up to 12 h, a held mark good for 3 min', () => {
  assert.equal(PERMISSION_MAX_MS, 12 * HOUR);
  assert.equal(HELD_FRESH_MS, 3 * MIN);
  assert.equal(NEEDS_YOU_TTL_MS, 30 * MIN, 'the lapse itself is unchanged');
});

test('a wait with no ask known: held while the session\'s own transcript has no newer request, past the lapse; over once it has', () => {
  const store = createNeedsYouStore();
  store.record(post('Notification'), NOW);
  const last = NOW - 6e3;
  passes(store, NOW + MIN, NOW + 2 * HOUR, () => threads(last));
  assert.equal(store.size(NOW + 2 * HOUR), 1, 'two hours on, still open');
  // The prompt answered: a request after it.
  const r = store.confirm(threads(NOW + 2 * HOUR + 10e3), NOW + 2 * HOUR + MIN);
  assert.deepEqual(r, { ended: 1, held: 0, dropped: 0, open: 0 });
});

test('a wait whose transcript is not read lapses at 30 minutes as before; a held mark lapses 3 minutes after the last pass that saw it', () => {
  const store = createNeedsYouStore();
  store.record(post('Notification'), NOW);
  passes(store, NOW + MIN, NOW + 29 * MIN, () => new Map());
  assert.equal(store.size(NOW + NEEDS_YOU_TTL_MS - 1), 1);
  assert.equal(store.size(NOW + NEEDS_YOU_TTL_MS), 0);
  const held = createNeedsYouStore();
  held.record(post('Notification'), NOW);
  passes(held, NOW + MIN, NOW + 35 * MIN, () => threads(NOW - 1));
  // The transcripts stop saying (the pass fails, the file is unread): 3 minutes more.
  assert.equal(held.size(NOW + 35 * MIN + HELD_FRESH_MS - 1), 1);
  assert.equal(held.size(NOW + 35 * MIN + HELD_FRESH_MS), 0);
  // An unread main thread (undefined) is no word; -Infinity (read, no request) is held.
  const none = createNeedsYouStore();
  none.record(post('Notification'), NOW);
  assert.deepEqual(none.confirm(threads(undefined), NOW + MIN), { ended: 0, held: 0, dropped: 0, open: 1 });
  assert.equal(none.confirm(threads(-Infinity), NOW + MIN).held, 1);
});

test('held at most 12 hours, whatever the transcripts say', () => {
  const list = [{ sessionId: SID, kind: 'permission', since: NOW, heldAt: NOW + PERMISSION_MAX_MS - MIN }];
  assert.equal(activeWaits(list, NOW + PERMISSION_MAX_MS - 1).length, 1);
  assert.equal(activeWaits(list, NOW + PERMISSION_MAX_MS).length, 0);
  assert.equal(isHeld({ kind: 'idle', since: NOW, heldAt: NOW + 30 * MIN }, NOW + 31 * MIN), false, 'only a permission wait is held');
  assert.equal(isHeld({ kind: 'permission', since: NOW, heldAt: NOW + 30 * MIN }, NOW + 31 * MIN), true);
  const store = createNeedsYouStore();
  store.record(post('Notification'), NOW);
  passes(store, NOW + MIN, NOW + 13 * HOUR, () => threads(NOW - 1));
  assert.equal(store.size(NOW + 13 * HOUR), 0);
});

test('with asks: each thread is judged on its own; a subagent that moved on drops its ask, the lead still held keeps the wait', () => {
  const store = createNeedsYouStore();
  store.record(post('PermissionRequest', { tool_name: 'Bash', at: NOW - 6e3 }), NOW - 6e3);
  store.record(post('PermissionRequest', { tool_name: 'Edit', agent_id: AGENT, at: NOW - 3e3 }), NOW - 3e3);
  store.record(post('Notification', { at: NOW }), NOW);
  // The subagent wrote a request after its ask; the lead did not.
  assert.deepEqual(store.confirm(threads(NOW - 7e3, { [AGENT]: NOW + 20e3 }), NOW + MIN), { ended: 0, held: 1, dropped: 1, open: 1 });
  // Then the lead too: the wait goes.
  assert.deepEqual(store.confirm(threads(NOW + 90e3, { [AGENT]: NOW + 20e3 }), NOW + 2 * MIN), { ended: 1, held: 0, dropped: 1, open: 0 });
  // A subagent's ask alone, its thread unread: no word; read and quiet: held.
  const sub = createNeedsYouStore();
  sub.record(post('PermissionRequest', { tool_name: 'Edit', agent_id: AGENT, at: NOW - 3e3 }), NOW - 3e3);
  sub.record(post('Notification', { at: NOW }), NOW);
  assert.deepEqual(sub.confirm(threads(NOW + 5 * MIN), NOW + 6 * MIN), { ended: 0, held: 0, dropped: 0, open: 1 }, 'the lead\'s own requests say nothing of the subagent');
  assert.equal(sub.confirm(threads(NOW + 5 * MIN, { [AGENT]: NOW - 4e3 }), NOW + 7 * MIN).held, 1);
});

test('the asks of a held wait outlive the lapse with it, so its answer still matches after an hour', () => {
  const store = createNeedsYouStore();
  store.record(post('PermissionRequest', { tool_name: 'Bash', at: NOW - 6e3 }), NOW - 6e3);
  store.record(post('Notification', { at: NOW }), NOW);
  passes(store, NOW + MIN, NOW + HOUR, () => threads(NOW - 7e3));
  // Another tool's call of the lead's thread that started before the ask is not its answer.
  const t = NOW + HOUR + 10e3;
  assert.equal(store.record(post('PostToolUse', { tool_name: 'Read', duration_ms: HOUR + 30e3, at: t }), t).open, 1);
  // The asked tool's own result is.
  assert.equal(store.record(post('PostToolUse', { tool_name: 'Bash', duration_ms: 1000, at: t + 1000 }), t + 1000).open, 0);
  // A session with no live permission wait keeps nothing past the lapse.
  assert.deepEqual([...keptSessions([{ sessionId: SID, kind: 'idle', since: NOW }], NOW)], []);
  const asks = new Map([[SID, [{ agent: null, tool: 'Bash', at: NOW, receivedAt: NOW }]]]);
  assert.equal(noteAsks(asks, { event: 'Stop', sessionId: 'other', at: null }, NOW + 31 * MIN).asks.size, 0);
  assert.equal(noteAsks(asks, { event: 'Stop', sessionId: 'other', at: null }, NOW + 31 * MIN, new Set([SID])).asks.size, 1);
  assert.equal(noteAsks(asks, { event: 'Stop', sessionId: 'other', at: null }, NOW + PERMISSION_MAX_MS, new Set([SID])).asks.size, 0);
});

test('a held wait keeps its session\'s order time: a late post older than the newest seen is still ignored after the lapse', () => {
  const store = createNeedsYouStore();
  store.record(post('Notification', { at: NOW }), NOW);
  passes(store, NOW + MIN, NOW + 40 * MIN, () => threads(NOW - 7e3));
  // Another session's post past the lapse prunes the order times; the held one's stays.
  store.record(checkNeedsYou({ hook_event_name: 'SessionEnd', session_id: 'b2b2b2b2-0000-4000-8000-000000000002', at: NOW + 40 * MIN }).value, NOW + 40 * MIN);
  const r = store.record(post('Stop', { at: NOW - 1000 }), NOW + 40 * MIN + 1);
  assert.deepEqual(r, { open: 1, stale: true });
});

test('a re-sent prompt keeps the wait\'s start and its held mark; the hint is taken when the wait opens', () => {
  let list = recordNeedsYou([], { ...post('Notification'), hint: 'Bash' }, NOW);
  assert.equal(list[0].hint, 'Bash');
  list = [{ ...list[0], heldAt: NOW + 40 * MIN }];
  list = recordNeedsYou(list, { ...post('Notification'), hint: 'Edit' }, NOW + 41 * MIN);
  assert.deepEqual(list, [{ sessionId: SID, kind: 'permission', since: NOW, heldAt: NOW + 40 * MIN, hint: 'Bash' }]);
  const store = createNeedsYouStore({ hintFor: (sid, now) => (sid === SID && now === NOW ? 'Bash' : null), whoFor: () => 'Inventlead', detailFor: (w, asks) => describeWait(w, asks) });
  store.record(post('Notification'), NOW);
  assert.deepEqual(store.view(NOW), [{ who: 'Inventlead', kind: 'permission', since: NOW, key: waitKey(SID), tool: 'Bash', run: null }]);
  const thrower = createNeedsYouStore({ hintFor: () => { throw new Error('x'); }, detailFor: () => { throw new Error('y'); } });
  thrower.record(post('Notification'), NOW);
  assert.deepEqual(thrower.view(NOW)[0], { who: null, kind: 'permission', since: NOW, key: waitKey(SID), tool: null, run: null });
  // An idle wait carries no tool or run.
  const idle = createNeedsYouStore({ detailFor: () => ({ tool: 'Bash', run: 'x' }) });
  idle.record({ ...post('Notification'), kind: 'idle' }, NOW);
  assert.deepEqual(Object.keys(idle.view(NOW)[0]).sort(), ['key', 'kind', 'since', 'who']);
});

test('confirmWaits leaves idle waits, other sessions and malformed thread maps alone', () => {
  const list = [{ sessionId: SID, kind: 'idle', since: NOW }, { sessionId: 'other', kind: 'permission', since: NOW }];
  const r = confirmWaits(list, new Map(), threads(NOW + MIN), NOW + 2 * MIN);
  assert.deepEqual(r.list, list);
  assert.equal(confirmWaits(list, new Map(), null, NOW).list.length, 2);
  assert.equal(confirmWaits(list, null, new Map([['other', 'x']]), NOW).list.length, 2);
});

// The 11-26 sequence (log lines and transcript times, re-timed): the lead's Bash request
// written at 18:31:21.5, the channel's card at 18:31:22, the Notification at 18:31:28,
// a SessionEnd of other sessions every 5 minutes, the lead's own SessionEnd at 20:02:21.
test('11-26 replayed: the lead\'s prompt stays a wait, named, from 18:31 to 20:02, where it lapsed at 19:01 before', () => {
  const T = h => Date.UTC(2026, 10, 26, ...h);
  const store = createNeedsYouStore({ whoFor: id => (id === SID ? 'Inventlead' : null), hintFor: () => 'Bash', detailFor: (w, a) => describeWait(w, a) });
  const request = T([18, 31, 21, 500]);
  const tx = () => threadTimes([{ sessionId: SID, subagent: false, filePath: '/p/x.jsonl', records: [{ ts: request }] }]);
  store.record(post('Notification', { at: T([18, 31, 28]) }), T([18, 31, 28]));
  for (let t = T([18, 32, 0]); t < T([20, 2, 21]); t += MIN) {
    store.confirm(tx(), t);
    if ((t / MIN) % 5 === 0) store.record(checkNeedsYou({ hook_event_name: 'SessionEnd', session_id: 'b2b2b2b2-0000-4000-8000-000000000002', at: t }).value, t);
    assert.equal(store.size(t), 1, new Date(t).toISOString());
  }
  const waits = approvalWaits(store.view(T([19, 41, 34])), 'Inventlead');
  assert.deepEqual(waits, [{ key: waitKey(SID), who: 'Inventlead', run: null, tool: 'Bash', since: T([18, 31, 28]), own: true }]);
  store.record(post('SessionEnd', { at: T([20, 2, 21]) }), T([20, 2, 21]));
  assert.equal(store.size(T([20, 2, 21])), 0);
  // Without the passes (the transcripts not read), the old lapse.
  const old = createNeedsYouStore();
  old.record(post('Notification', { at: T([18, 31, 28]) }), T([18, 31, 28]));
  assert.equal(old.size(T([19, 1, 33])), 0);
});
