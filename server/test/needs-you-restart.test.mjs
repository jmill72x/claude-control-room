// A restart of the Control Room no longer forgets open approval waits (board cf9b6496):
// the needs-you store writes its permission waits and their asks (lib/needs-you.mjs,
// snapshotOf; data/needs-you.json), the next process puts back those of a snapshot written
// at most 3 minutes before it started (readSnapshot, restore), and the transcripts judge
// each one in the same sessions pass. The reminder of a card first seen after a restart
// keeps to its six (lib/approval-wait.mjs, firstSchedule). Every session id, agent and
// time here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  checkNeedsYou, createNeedsYouStore, snapshotOf, readSnapshot, agentKey,
  SNAPSHOT_VERSION, SNAPSHOT_FRESH_MS, PERMISSION_MAX_MS, HELD_FRESH_MS, NEEDS_YOU_TTL_MS, NEEDS_YOU_MAX, ASKS_MAX
} from '../lib/needs-you.mjs';
import { approvalWaits, createApprovalReminders, firstSchedule, describeWait, REMIND_MAX, REMIND_FIRST_MS, REMIND_EVERY_MS } from '../lib/approval-wait.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const NOW = 1794380000000;
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const AGENT = 'invented-agent-0001';
const post = (event, extra = {}, sid = SID) => checkNeedsYou({ hook_event_name: event, session_id: sid, notification_type: event === 'Notification' ? 'permission_prompt' : null, ...extra }).value;
const threads = (main, agents = {}, sid = SID) => new Map([[sid, { main, agents: new Map(Object.entries(agents).map(([k, v]) => [agentKey(k), v])), types: new Map(), mainOpen: [], agentsOpen: new Map() }]]);

// The old process: a wait and its ask, written; the new one starts `gap` later.
function before({ ask = true, agent = null, gap = 20e3 } = {}) {
  const old = createNeedsYouStore();
  if (ask) old.record(post('PermissionRequest', { tool_name: 'Bash', at: NOW - 3e3, ...(agent ? { agent_id: agent } : {}) }), NOW - 3e3);
  old.record(post('Notification', { at: NOW }), NOW);
  const snap = old.snapshot(NOW + MIN);
  return { snap, start: NOW + MIN + gap };
}

test('the numbers and the file\'s shape: version 1, the permission waits with their start and hint, their sessions\' asks', () => {
  assert.equal(SNAPSHOT_VERSION, 1);
  assert.equal(SNAPSHOT_FRESH_MS, 3 * MIN);
  const store = createNeedsYouStore({ hintFor: () => 'Bash' });
  store.record(post('PermissionRequest', { tool_name: 'mcp__plugin_x__do', agent_id: AGENT, at: NOW - 2e3 }), NOW - 2e3);
  store.record(post('Notification', { at: NOW }), NOW);
  // An idle wait in another session is not kept.
  store.record(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID2, notification_type: 'idle_prompt' }).value, NOW);
  assert.deepEqual(store.snapshot(NOW + 5e3), {
    version: 1,
    at: NOW + 5e3,
    waits: [{ sessionId: SID, since: NOW, hint: 'Bash' }],
    asks: { [SID]: [{ agent: agentKey(AGENT), tool: 'mcp__plugin_x__do', at: NOW - 2e3 }] }
  });
  // No ask, no hint: none written.
  const bare = createNeedsYouStore();
  bare.record(post('Notification', { at: NOW }), NOW);
  assert.deepEqual(bare.snapshot(NOW), { version: 1, at: NOW, waits: [{ sessionId: SID, since: NOW }], asks: {} });
  // A lapsed wait is not written.
  assert.deepEqual(snapshotOf([{ sessionId: SID, kind: 'permission', since: NOW - NEEDS_YOU_TTL_MS }], new Map(), NOW).waits, []);
});

test('readSnapshot: only one written at most 3 minutes before this start, and never after it', () => {
  const { snap } = before();
  const at = snap.at;
  assert.ok(readSnapshot(snap, at + SNAPSHOT_FRESH_MS, at + SNAPSHOT_FRESH_MS));
  assert.equal(readSnapshot(snap, at + SNAPSHOT_FRESH_MS + 1, at + SNAPSHOT_FRESH_MS + 1), null, 'down longer: hook events may have been lost');
  assert.ok(readSnapshot(snap, at - 5e3, at), 'a few seconds of skew');
  assert.equal(readSnapshot(snap, at - 5e3 - 1, at), null, 'a file from after this start is not the last process\'s');
  for (const bad of [null, [], 'x', { ...snap, version: 2 }, { ...snap, at: 'soon' }, { ...snap, at: 1.5 }, {}]) assert.equal(readSnapshot(bad, at, at), null);
  assert.deepEqual(readSnapshot({ version: 1, at }, at, at), { waits: [], asks: new Map() }, 'no waits listed: none');
});

test('readSnapshot: each wait and ask checked as a hook\'s fields are; one that fails is left out, never the rest', () => {
  const at = NOW + MIN;
  const ok = { sessionId: SID, since: NOW };
  const snap = {
    version: 1, at,
    waits: [ok, { sessionId: 'bad id!', since: NOW }, { sessionId: SID2, since: 'x' }, { sessionId: SID2, since: at + 1 }, { sessionId: SID, since: NOW - 1 }, null, { sessionId: SID2, since: at - PERMISSION_MAX_MS, hint: 'Bash; rm' }],
    asks: {
      [SID]: [{ agent: null, tool: 'Bash', at: NOW - 1 }, { agent: 'XYZ', tool: 'Bash', at: NOW }, { agent: agentKey(AGENT), tool: 'Bad tool!', at: NOW }, { agent: null, tool: null, at: at + 1 }, { agent: agentKey(AGENT), tool: null, at: NOW }, 'x'],
      [SID2]: 'not a list'
    }
  };
  const out = readSnapshot(snap, at, at);
  assert.deepEqual(out.waits, [{ sessionId: SID, since: NOW }], 'a bad id, a bad time, a time after the file, a repeated session, a wait past 12 h: left out');
  assert.deepEqual(out.asks.get(SID), [{ agent: null, tool: 'Bash', at: NOW - 1 }, { agent: agentKey(AGENT), tool: null, at: NOW }]);
  const hinted = readSnapshot({ version: 1, at, waits: [{ sessionId: SID, since: NOW, hint: 'an MCP tool' }, { sessionId: SID2, since: NOW, hint: 'Bash; rm' }] }, at, at);
  assert.deepEqual(hinted.waits, [{ sessionId: SID, since: NOW, hint: 'an MCP tool' }, { sessionId: SID2, since: NOW }], 'a hint is a label or nothing');
  // Bounded: 20 waits, 10 asks a session.
  const many = { version: 1, at, waits: Array.from({ length: 25 }, (_, i) => ({ sessionId: `s-${i}`, since: NOW })), asks: { 's-0': Array.from({ length: 15 }, (_, i) => ({ agent: null, tool: 'Bash', at: NOW - i })) } };
  const big = readSnapshot(many, at, at);
  assert.equal(big.waits.length, NEEDS_YOU_MAX);
  assert.equal(big.asks.get('s-0').length, ASKS_MAX);
  // An `asks` key that is not the object's own is not read.
  const proto = readSnapshot({ version: 1, at, waits: [{ sessionId: 'constructor', since: NOW }], asks: {} }, at, at);
  assert.equal(proto.asks.size, 0);
});

test('restore then confirm: the lead\'s held prompt comes back across a restart, named and held past the lapse', () => {
  const { snap, start } = before();
  const fresh = createNeedsYouStore({ whoFor: () => 'Jarvis', detailFor: (w, asks) => describeWait(w, asks) });
  assert.equal(fresh.size(start), 0, 'a new process knows nothing');
  const now = start + 30e3;
  assert.deepEqual(fresh.restore(snap, start, now), { restored: 1, asks: 1 });
  // The same pass's confirm: his own thread wrote nothing after the ask.
  assert.deepEqual(fresh.confirm(threads(NOW - 4e3), now), { ended: 0, held: 1, dropped: 0, open: 1 });
  const [w] = fresh.view(now);
  assert.equal(w.since, NOW, 'its start is the first process\'s');
  assert.equal(w.tool, 'Bash');
  assert.deepEqual(approvalWaits(fresh.view(now), 'Jarvis').map(x => [x.since, x.tool, x.own]), [[NOW, 'Bash', true]]);
  // An hour later, held all along.
  for (let t = now + MIN; t <= now + HOUR; t += MIN) fresh.confirm(threads(NOW - 4e3), t);
  assert.equal(fresh.size(now + HOUR), 1);
  // Answered: a request after the ask.
  assert.equal(fresh.confirm(threads(now + HOUR + 5e3), now + HOUR + MIN).ended, 1);
});

test('restore then confirm: a prompt answered while the server was down ends in that same pass', () => {
  const { snap, start } = before();
  const fresh = createNeedsYouStore();
  fresh.restore(snap, start, start + 10e3);
  assert.deepEqual(fresh.confirm(threads(NOW + 30e3), start + 10e3), { ended: 1, held: 0, dropped: 1, open: 0 });
  // With no ask known (the 2026-11-12 hooks), judged on the session's own thread from its start.
  const old = before({ ask: false });
  const bare = createNeedsYouStore();
  assert.deepEqual(bare.restore(old.snap, old.start, old.start + 10e3), { restored: 1, asks: 0 });
  assert.equal(bare.confirm(threads(NOW + 30e3), old.start + 10e3).ended, 1);
  const held = createNeedsYouStore();
  held.restore(old.snap, old.start, old.start + 10e3);
  assert.equal(held.confirm(threads(NOW - 10e3), old.start + 10e3).held, 1);
});

test('restore: with the 2026-11-12 hooks a put-back wait clears as before (any tool use in the session); with §28\'s, only its own tool\'s', () => {
  const old = before({ ask: false });
  const a = createNeedsYouStore();
  a.restore(old.snap, old.start, old.start + 1e3);
  a.record(post('PostToolUse', { at: old.start + 2e3 }), old.start + 2e3);
  assert.equal(a.size(old.start + 2e3), 0, 'an entry that names no tool: as before');
  const fresh = before({ agent: AGENT });
  const b = createNeedsYouStore();
  b.restore(fresh.snap, fresh.start, fresh.start + 1e3);
  // The lead's own thread's tool use is not the subagent's prompt's answer.
  b.record(post('PostToolUse', { tool_name: 'Bash', duration_ms: 1e3, at: fresh.start + 2e3 }), fresh.start + 2e3);
  assert.equal(b.size(fresh.start + 2e3), 1);
  b.record(post('PostToolUse', { tool_name: 'Bash', agent_id: AGENT, duration_ms: 1e3, at: fresh.start + 3e3 }), fresh.start + 3e3);
  assert.equal(b.size(fresh.start + 3e3), 0, 'its own thread\'s: answered');
});

test('restore: nothing from a stale or odd file; never over a wait a hook since this start opened; marked held only until the transcripts judge it', () => {
  const { snap, start } = before();
  const stale = createNeedsYouStore();
  assert.deepEqual(stale.restore(snap, snap.at + SNAPSHOT_FRESH_MS + 1, snap.at + SNAPSHOT_FRESH_MS + 1), { restored: 0, asks: 0 });
  assert.deepEqual(stale.restore(null, start, start), { restored: 0, asks: 0 });
  assert.deepEqual(stale.restore({}, start, start), { restored: 0, asks: 0 });
  // A hook since this start opened the session's wait: that one stands.
  const busy = createNeedsYouStore();
  busy.record(post('Notification', { notification_type: 'idle_prompt', at: start + 1e3 }), start + 1e3);
  assert.deepEqual(busy.restore(snap, start, start + 2e3), { restored: 0, asks: 0 });
  assert.equal(busy.view(start + 2e3)[0].kind, 'idle');
  // Its asks from since this start stand too, and the wait keeps the hint it had.
  const asked = createNeedsYouStore();
  asked.record(post('PermissionRequest', { tool_name: 'Edit', at: start + 1e3 }), start + 1e3);
  asked.restore({ ...snap, waits: [{ ...snap.waits[0], hint: 'Bash' }] }, start, start + 2e3);
  assert.deepEqual(asked.snapshot(start + 2e3).waits, [{ sessionId: SID, since: NOW, hint: 'Bash' }]);
  assert.deepEqual(asked.snapshot(start + 2e3).asks[SID].map(a => a.tool), ['Edit']);
  // An unjudged wait older than the lapse lives the held window, then goes.
  const old = { ...snap, waits: [{ sessionId: SID, since: NOW - 40 * MIN }] };
  const unread = createNeedsYouStore();
  unread.restore(old, start, start);
  assert.equal(unread.size(start + HELD_FRESH_MS - 1), 1);
  assert.equal(unread.size(start + HELD_FRESH_MS), 0);
  // Two sessions come back, oldest first.
  const two = { version: 1, at: snap.at, waits: [{ sessionId: SID2, since: NOW + 5e3 }, { sessionId: SID, since: NOW }], asks: {} };
  const both = createNeedsYouStore();
  assert.equal(both.restore(two, start, start).restored, 2);
  assert.deepEqual(both.snapshot(start).waits.map(w => w.sessionId), [SID, SID2]);
});

test('onChange: called when what the file would hold changes, never for the same state again, and a throw in it is swallowed', () => {
  let n = 0;
  const store = createNeedsYouStore({ onChange: () => { n++; } });
  store.record(post('PermissionRequest', { tool_name: 'Bash', at: NOW - 1e3 }), NOW - 1e3);
  assert.equal(n, 0, 'an ask alone, with no wait: the file is unchanged');
  store.record(post('Notification', { at: NOW }), NOW);
  assert.equal(n, 1);
  store.record(post('Notification', { at: NOW + 1e3 }), NOW + 1e3);
  assert.equal(n, 1, 'the same wait again');
  store.confirm(threads(NOW - 2e3), NOW + MIN);
  assert.equal(n, 1, 'held: the file holds no held mark');
  store.endThreads(new Map(), NOW + MIN);
  assert.equal(n, 1);
  store.record(post('Stop', { at: NOW + 2 * MIN }), NOW + 2 * MIN);
  assert.equal(n, 2, 'over');
  const loud = createNeedsYouStore({ onChange: () => { throw new Error('boom'); } });
  assert.equal(loud.record(post('Notification', { at: NOW }), NOW).open, 1);
  const quiet = createNeedsYouStore({ onChange: 'not a function' });
  assert.equal(quiet.record(post('Notification', { at: NOW }), NOW).open, 1);
  const restored = createNeedsYouStore({ onChange: () => { n++; } });
  const { snap, start } = before();
  n = 0;
  restored.restore(snap, start, start);
  assert.equal(n, 1, 'a restore is a change');
});

test('firstSchedule: a card seen in its first minute as before; one first seen after a restart sends the reminder due now and keeps to six', () => {
  const S = NOW;
  assert.deepEqual(firstSchedule(S, S), { count: 0, nextAt: S + REMIND_FIRST_MS });
  assert.deepEqual(firstSchedule(S, S + REMIND_FIRST_MS - 1), { count: 0, nextAt: S + REMIND_FIRST_MS });
  assert.deepEqual(firstSchedule(S, S + REMIND_FIRST_MS), { count: 0, nextAt: S + REMIND_FIRST_MS }, 'at 10 min: the first, due now');
  assert.deepEqual(firstSchedule(S, S + 39 * MIN), { count: 0, nextAt: S + 39 * MIN });
  assert.deepEqual(firstSchedule(S, S + 40 * MIN), { count: 1, nextAt: S + 40 * MIN }, 'the one at 10 min counts as sent');
  assert.deepEqual(firstSchedule(S, S + 165 * MIN), { count: REMIND_MAX - 1, nextAt: S + 165 * MIN }, 'the sixth, due now');
  assert.deepEqual(firstSchedule(S, S + REMIND_FIRST_MS + REMIND_MAX * REMIND_EVERY_MS - 1).count, REMIND_MAX - 1);
  assert.deepEqual(firstSchedule(S, S + REMIND_FIRST_MS + REMIND_MAX * REMIND_EVERY_MS), { count: REMIND_MAX, nextAt: Infinity }, 'past all six: none');
});

test('the reminder after a restart: one now for a card open 45 minutes (reminder 2 of 6), then on its old schedule', async () => {
  const lines = [];
  const pushes = [];
  const r = createApprovalReminders({ push: async body => { pushes.push(body); return { tried: 1, reached: 1 }; }, log: l => lines.push(l) });
  const card = [{ key: 'needs-you:abc', who: 'Jarvis', run: null, tool: 'Bash', since: NOW, own: true }];
  assert.equal((await r.step(card, NOW + 45 * MIN)).status, 'sent');
  assert.match(lines.at(-1), /\(reminder 2 of 6\)$/);
  assert.match(pushes[0], /^Jarvis has waited 45 min on an approval card\./);
  assert.equal((await r.step(card, NOW + 74 * MIN)).status, 'none');
  assert.equal((await r.step(card, NOW + 75 * MIN)).status, 'sent');
  assert.match(lines.at(-1), /\(reminder 3 of 6\)$/);
  // A card first seen past where a seventh would be (190 min): no reminder (the answer
  // watch carries on); at 3 hours, the sixth.
  const late = createApprovalReminders({ push: async () => ({ tried: 1, reached: 1 }), log: () => {} });
  assert.equal((await late.step([{ ...card[0], since: NOW - 190 * MIN }], NOW)).status, 'none');
  const sixth = [];
  const at3h = createApprovalReminders({ push: async () => ({ tried: 1, reached: 1 }), log: l => sixth.push(l) });
  assert.equal((await at3h.step([{ ...card[0], since: NOW - 3 * HOUR }], NOW)).status, 'sent');
  assert.match(sixth.at(-1), /\(reminder 6 of 6, the last\)$/);
});

// ---- server.mjs (a source test: server.mjs can't run in a test) ----

test('server.mjs: the last snapshot is read before the sessions pass, put back at its first run before the confirm, and nothing is written until then', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const readAt = src.indexOf("let priorWaits = await needsYouFile.read();");
  assert.ok(readAt > 0);
  assert.match(src, /const needsYouFile = createSentStore\(join\(HERE, 'data', 'needs-you\.json'\)\);/);
  assert.ok(readAt < src.indexOf("registry.register('sessions'"), 'read before the first pass can run');
  assert.ok(readAt < src.indexOf('createIngestHandler('), 'and before any hook event can change it');
  assert.match(src, /async function saveWaits\(\) \{\n  if \(priorWaits !== null\) return;/);
  assert.match(src, /onChange: \(\) => \{ void saveWaits\(\); \}/);
  const pass = src.slice(src.indexOf("registry.register('sessions'"), src.indexOf("registry.register('board'"));
  const restore = pass.indexOf('needsYou.restore(priorWaits, STARTED_AT, now)');
  assert.ok(restore > pass.indexOf('threadsNow = threadTimes(transcripts);'));
  assert.ok(restore < pass.indexOf('needsYou.confirm(threadsNow, now)'), 'judged by the same pass');
  assert.match(pass.slice(restore), /^needsYou\.restore\(priorWaits, STARTED_AT, now\);\n\s*priorWaits = null;/);
  assert.match(pass, /\n  if \(priorWaits !== null\) \{\n    const back = needsYou\.restore\(/, 'once, at the first pass');
  assert.ok(pass.indexOf('void saveWaits();') > pass.indexOf('needsYou.confirm(threadsNow, now)'), 'each pass writes the file afresh');
});
