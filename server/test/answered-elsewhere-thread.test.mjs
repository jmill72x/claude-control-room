// A card is closed as answered somewhere else only when its own thread shows it answered
// (board 28644093): on 2026-11-26 a subagent's card, relayed at 17:30:15Z, was closed at
// the lead's 17:38:41 UserPromptSubmit while the run still waited. The pieces: which
// tool uses of a thread have no result yet (lib/parse-transcript.mjs, openTools), which
// thread a card is (lib/approval-wait.mjs, cardThread), whether that thread is past it
// (threadPast), and the close itself (lib/answered-elsewhere.mjs). Every id, session and
// time here is invented; no line is a copy of a real transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, OPEN_TOOLS_MAX, OPEN_TOOL_NAME_MAX } from '../lib/parse-transcript.mjs';
import { threadTimes, cardThread, threadPast, CARD_NEAR_MS, CARD_SKEW_MS } from '../lib/approval-wait.mjs';
import { agentKey } from '../lib/needs-you.mjs';
import { createAnsweredElsewhere, PASS_FRESH_MS } from '../lib/answered-elsewhere.mjs';
import { createChatStore } from '../lib/chat-store.mjs';

const MIN = 60e3;
const T0 = 1794380000000;
const iso = t => new Date(t).toISOString();
const LEAD = 'a1b2c3d4-0000-4000-8000-00000000000a';
const OTHER = 'a1b2c3d4-0000-4000-8000-00000000000b';
const AGENT = 'a0000000000000001';
const KEY = agentKey(AGENT);
const USAGE = { input_tokens: 1, output_tokens: 1 };

// Transcript lines: an assistant line with tool uses (one line per block, as Claude Code
// writes them), a tool's result, an interruption mark.
const use = (ts, msg, uses, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), sessionId: LEAD, requestId: `req-${msg}`, message: { id: msg, role: 'assistant', stop_reason: 'tool_use', content: uses.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} })), usage: USAGE, ...extra } });
const result = (ts, ...ids) => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: LEAD, message: { role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) } });
const interrupted = ts => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: LEAD, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
const parse = (...lines) => parseTranscript(lines.join('\n'), 'Code');

test('openTools: the newest response\'s tool uses that have no result yet, each with its line\'s time', () => {
  assert.deepEqual(parse(use(T0, 'm1', [['u1', 'Bash']])).openTools, [{ name: 'Bash', at: T0 }]);
  assert.deepEqual(parse(use(T0, 'm1', [['u1', 'Bash']]), result(T0 + 5e3, 'u1')).openTools, [], 'its result came');
  // Parallel calls are lines of one response: one with a result, one still open.
  const two = parse(use(T0, 'm1', [['u1', 'Bash']]), use(T0 + 1e3, 'm1', [['u2', 'Read']]), result(T0 + 2e3, 'u2'));
  assert.deepEqual(two.openTools, [{ name: 'Bash', at: T0 }]);
  // A new response clears the old one's: the next request goes only once every result is in.
  assert.deepEqual(parse(use(T0, 'm1', [['u1', 'Bash']]), use(T0 + 9e3, 'm2', [['u3', 'Edit']])).openTools, [{ name: 'Edit', at: T0 + 9e3 }]);
  assert.deepEqual(parse(use(T0, 'm1', [['u1', 'Bash']]), JSON.stringify({ type: 'assistant', timestamp: iso(T0 + 9e3), message: { id: 'm2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: USAGE } })).openTools, [], 'a final answer is a new response');
  // A stopped run (the interruption mark) has none open.
  const stopped = parse(use(T0, 'm1', [['u1', 'Bash']]), interrupted(T0 + 3e3));
  assert.deepEqual(stopped.openTools, []);
  assert.equal(stopped.stoppedAt, T0 + 3e3, 'the stop is still noted');
  // A line with no message id adds to the open ones without clearing them.
  assert.deepEqual(parse(use(T0, 'm1', [['u1', 'Bash']]), JSON.stringify({ type: 'assistant', timestamp: iso(T0 + 1e3), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u9', name: 'Grep' }] } })).openTools.map(u => u.name), ['Bash', 'Grep']);
  // Odd blocks are skipped: no id, no name, an empty name, no time on the line.
  const odd = parse(JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { id: 'm1', content: [{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', id: 'u1' }, { type: 'tool_use', id: 'u2', name: '' }, null, { type: 'text' }] } }), JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'u3', name: 'Bash' }] } }));
  assert.deepEqual(odd.openTools, []);
  // A result for another id, or no content, leaves them.
  assert.deepEqual(parse(use(T0, 'm1', [['u1', 'Bash']]), result(T0 + 1e3, 'u7'), JSON.stringify({ type: 'user', timestamp: iso(T0 + 2e3), message: { role: 'user', content: 'a typed line' } })).openTools.length, 1);
});

test('openTools: bounded, and a long name is cut', () => {
  assert.equal(OPEN_TOOLS_MAX, 20);
  const many = Array.from({ length: 25 }, (_, i) => [`u${i}`, `T${i}`]);
  const out = parse(use(T0, 'm1', many)).openTools;
  assert.equal(out.length, 20);
  assert.equal(out[0].name, 'T5', 'the oldest go first');
  assert.equal(parse(use(T0, 'm1', [['u1', 'x'.repeat(300)]])).openTools[0].name.length, OPEN_TOOL_NAME_MAX);
  // A tool use written again under its id is one, not two.
  assert.equal(parse(use(T0, 'm1', [['u1', 'Bash']]), use(T0 + 1, 'm1', [['u1', 'Bash']])).openTools.length, 1);
});

// The sessions pass's view of a lead session: his own thread and one subagent.
const view = ({ main = T0 - 3e3, mainOpen = [], agent = T0 - 2e3, agentOpen = [], sid = LEAD } = {}) => new Map([[sid, { main, agents: new Map([[KEY, agent]]), types: new Map([[KEY, 'vision']]), mainOpen, agentsOpen: new Map([[KEY, agentOpen]]) }]]);

test('threadTimes: each thread\'s open tool uses, the newest file\'s when a session has two', () => {
  const lead = { sessionId: LEAD, subagent: false, filePath: `/p/${LEAD}.jsonl`, records: [{ ts: T0 }], openTools: [{ name: 'Bash', at: T0 + 1 }] };
  const older = { sessionId: LEAD, subagent: false, filePath: '/p/older.jsonl', records: [{ ts: T0 - MIN }], openTools: [{ name: 'Edit', at: T0 - MIN }] };
  const sub = { sessionId: LEAD, subagent: true, filePath: `/p/${LEAD}/subagents/agent-${AGENT}.jsonl`, records: [{ ts: T0 }], openTools: [{ name: 'Edit', at: T0 + 2 }, { name: 3, at: 1 }, null] };
  const t = threadTimes([lead, older, sub]).get(LEAD);
  assert.deepEqual(t.mainOpen, [{ name: 'Bash', at: T0 + 1 }]);
  assert.deepEqual(threadTimes([older, lead]).get(LEAD).mainOpen, [{ name: 'Bash', at: T0 + 1 }], 'whatever the order');
  assert.deepEqual(t.agentsOpen.get(KEY), [{ name: 'Edit', at: T0 + 2 }], 'odd entries left out');
  assert.deepEqual(threadTimes([{ ...lead, openTools: undefined }]).get(LEAD).mainOpen, [], 'a parse with none: none open');
  assert.equal(threadTimes([sub]).get(LEAD).mainOpen, undefined, 'the session\'s own file not read: not known');
  // Two files for one thread: the newer one's open uses, whatever the order.
  const subOld = { ...sub, records: [{ ts: T0 - MIN }], openTools: [{ name: 'Grep', at: T0 - MIN }] };
  assert.deepEqual(threadTimes([sub, subOld]).get(LEAD).agentsOpen.get(KEY), [{ name: 'Edit', at: T0 + 2 }]);
});

test('cardThread: the thread whose newest response has an open tool use of the card\'s tool, written just before the card', () => {
  assert.equal(CARD_NEAR_MS, 2 * MIN);
  assert.equal(CARD_SKEW_MS, 5e3);
  const sub = view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] });
  assert.deepEqual(cardThread(sub, [LEAD], 'Bash', T0), { sessionId: LEAD, agent: KEY, name: 'Bash', toolAt: T0 - 1e3 });
  const own = view({ mainOpen: [{ name: 'Bash', at: T0 - 1e3 }] });
  assert.deepEqual(cardThread(own, [LEAD], 'Bash', T0), { sessionId: LEAD, agent: null, name: 'Bash', toolAt: T0 - 1e3 });
  // The window: 2 minutes before the card to 5 s after, both ends in.
  assert.ok(cardThread(view({ agentOpen: [{ name: 'Bash', at: T0 - CARD_NEAR_MS }], agent: T0 - CARD_NEAR_MS - 1 }), [LEAD], 'Bash', T0));
  assert.equal(cardThread(view({ agentOpen: [{ name: 'Bash', at: T0 - CARD_NEAR_MS - 1 }], agent: T0 - CARD_NEAR_MS - 2 }), [LEAD], 'Bash', T0), null);
  assert.ok(cardThread(view({ agentOpen: [{ name: 'Bash', at: T0 + CARD_SKEW_MS }] }), [LEAD], 'Bash', T0));
  assert.equal(cardThread(view({ agentOpen: [{ name: 'Bash', at: T0 + CARD_SKEW_MS + 1 }] }), [LEAD], 'Bash', T0), null);
  // The nearest wins; on a tie the session's own thread.
  const both = view({ mainOpen: [{ name: 'Bash', at: T0 - 30e3 }], main: T0 - 31e3, agentOpen: [{ name: 'Bash', at: T0 - 2e3 }] });
  assert.equal(cardThread(both, [LEAD], 'Bash', T0).agent, KEY);
  const tie = view({ mainOpen: [{ name: 'Bash', at: T0 - 2e3 }], agentOpen: [{ name: 'Bash', at: T0 - 2e3 }] });
  assert.equal(cardThread(tie, [LEAD], 'Bash', T0).agent, null);
  // Another tool, another session, a thread that wrote a request after its tool use: not it.
  assert.equal(cardThread(sub, [LEAD], 'Edit', T0), null);
  assert.equal(cardThread(sub, [OTHER], 'Bash', T0), null);
  assert.equal(cardThread(view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }], agent: T0 - 500 }), [LEAD], 'Bash', T0), null);
  // Nothing to go on: no answer.
  for (const [threads, sessions, tool, at] of [[null, [LEAD], 'Bash', T0], [sub, null, 'Bash', T0], [sub, [LEAD], '', T0], [sub, [LEAD], null, T0], [sub, [LEAD], 'Bash', Number.NaN], [new Map([[LEAD, null]]), [LEAD], 'Bash', T0]]) {
    assert.equal(cardThread(threads, sessions, tool, at), null);
  }
  // A thread whose open list is not known is skipped, not a crash.
  assert.equal(cardThread(new Map([[LEAD, { main: 1, agents: new Map(), mainOpen: undefined, agentsOpen: new Map() }]]), [LEAD], 'Bash', T0), null);
});

test('threadPast: the tool use has its result, the thread wrote a request after it, or it stopped; not read is no word', () => {
  const ref = { sessionId: LEAD, agent: KEY, name: 'Bash', toolAt: T0 - 1e3 };
  assert.equal(threadPast(view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }), ref), false, 'still at it');
  assert.equal(threadPast(view({ agentOpen: [] }), ref), true, 'its result came');
  assert.equal(threadPast(view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }], agent: T0 }), ref), true, 'a request after it');
  assert.equal(threadPast(view({ agentOpen: [{ name: 'Bash', at: T0 + 9e3 }] }), ref), false, 'a parallel call of the same tool still open keeps it');
  assert.equal(threadPast(view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }), ref, new Map([[KEY, T0 - 1e3]])), true, 'stopped at or after it');
  assert.equal(threadPast(view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }), ref, new Map([[KEY, T0 - 2e3]])), false, 'a stop before it is an older run\'s');
  assert.equal(threadPast(view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }), ref, new Map([['someone', T0]])), false);
  const own = { ...ref, agent: null };
  assert.equal(threadPast(view({ mainOpen: [{ name: 'Bash', at: T0 - 1e3 }] }), own, new Map([[KEY, T0]])), false, 'a subagent\'s stop says nothing of the lead\'s own thread');
  assert.equal(threadPast(view({ mainOpen: [] }), own), true);
  assert.equal(threadPast(view({ main: -Infinity, mainOpen: [] }), own), true, 'read, no request: judged on its open uses');
  // Not read this pass: no word.
  const unread = view();
  unread.get(LEAD).main = undefined;
  assert.equal(threadPast(unread, own), null);
  assert.equal(threadPast(view(), { ...ref, agent: 'b'.repeat(16) }), null);
  assert.equal(threadPast(new Map([[LEAD, { main: T0 - 5e3, agents: new Map(), mainOpen: undefined, agentsOpen: new Map() }]]), own), null);
  assert.equal(threadPast(view({ sid: OTHER }), own), null);
  assert.equal(threadPast(null, own), null);
  assert.equal(threadPast(view(), null), null);
});

// ---- the close, over the real chat store ----

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'elsewhere-'));
  const clock = { t: T0 };
  const store = createChatStore({ dir, now: () => clock.t });
  await store.load();
  // Channel 0.4.11 holds a request 12 h (and 3 min): the page's card lasts as long.
  store.setPermissionHold(12 * 3600e3 + 3 * MIN);
  const logs = [];
  const ae = createAnsweredElsewhere({ store, isLeadSession: id => id === LEAD, now: () => clock.t, log: l => logs.push(l) });
  const open = (requestId, tool = 'Bash') => store.openPermission({ requestId, tool, description: 'd', inputPreview: '{"command":"ls"}', relayedAt: clock.t });
  const state = id => store.permission(id).state;
  return { dir, clock, store, ae, logs, open, state, clean: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
const pass = (s, threads, extra = {}) => s.ae.pass({ threads, sessions: [LEAD], readAt: s.clock.t, ...extra });

test('board 28644093 replayed: a subagent\'s card stays open through the lead\'s next turns and closes once its own thread is past it', async () => {
  const s = await setup();
  try {
    // 17:30:15 the subagent's tool use, its card relayed a second later.
    const toolAt = s.clock.t;
    s.clock.t += 1e3;
    await s.open('nkfaq');
    // The next sessions pass sees the subagent stopped at it.
    s.clock.t += 40e3;
    const waiting = view({ main: toolAt - 9e3, agent: toolAt - 1e3, agentOpen: [{ name: 'Bash', at: toolAt }] });
    assert.equal(pass(s, waiting), 0);
    // 17:38:41 the lead's own thread moves on: his next prompt, then his turn's end.
    s.clock.t += 8 * MIN;
    assert.equal(s.ae.note({ event: 'UserPromptSubmit', sessionId: LEAD, at: s.clock.t }), 0);
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t + 1 }), 0);
    assert.equal(s.state('nkfaq'), 'open', 'the subagent still waits: its card stays');
    assert.match(s.logs.at(-1), /^chat: 1 permission card kept open at the lead's Stop: a subagent's, and its thread has not moved past it: nkfaq$/);
    s.clock.t += MIN;
    assert.equal(pass(s, waiting), 0, 'still waiting');
    // A pass that did not read the subagent's file this time says nothing of it.
    s.clock.t += MIN;
    const unread = view({ main: toolAt - 9e3 });
    unread.get(LEAD).agents.delete(KEY);
    unread.get(LEAD).agentsOpen.delete(KEY);
    assert.equal(pass(s, unread), 0);
    assert.equal(s.state('nkfaq'), 'open');
    // Answered in the terminal: the tool use gets its result.
    s.clock.t += MIN;
    assert.equal(pass(s, view({ main: toolAt - 9e3, agent: toolAt - 1e3, agentOpen: [] })), 1);
    assert.equal(s.state('nkfaq'), 'elsewhere');
    assert.equal(s.store.permission('nkfaq').closedBy, 'its own thread');
    assert.match(s.logs.at(-1), /^chat: 1 permission card closed, answered somewhere else or no longer asked \(its own thread moved past it\): nkfaq$/);
    assert.deepEqual(s.ae.size(), { refs: 0, deferred: 0 });
  } finally { await s.clean(); }
});

test('the lead\'s own card closes at his turn\'s end as before, and a pass closes it sooner once his thread is past it', async () => {
  const s = await setup();
  try {
    await s.open('abcde');
    s.clock.t += 30e3;
    pass(s, view({ mainOpen: [{ name: 'Bash', at: T0 - 1e3 }], main: T0 - 2e3 }));
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 1);
    assert.equal(s.state('abcde'), 'elsewhere');
    assert.equal(s.store.permission('abcde').closedBy, 'Stop');
    await s.open('fghij');
    s.clock.t += 30e3;
    pass(s, view({ mainOpen: [{ name: 'Bash', at: s.clock.t - 31e3 }], main: s.clock.t - 32e3 }));
    assert.equal(s.state('fghij'), 'open');
    s.clock.t += MIN;
    assert.equal(pass(s, view({ mainOpen: [], main: s.clock.t - 10e3 })), 1, 'a request after it: answered');
    assert.equal(s.state('fghij'), 'elsewhere');
  } finally { await s.clean(); }
});

test('a card no pass has judged yet: the lead\'s turn defers its close to the next pass, which says whose it is', async () => {
  const s = await setup();
  try {
    pass(s, view(), { readAt: s.clock.t - 1 });
    // Two cards relayed after that pass: one the lead's own, one a subagent's.
    await s.open('owncd');
    await s.open('subcd', 'Edit');
    s.clock.t += 5e3;
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 0, 'nothing closed yet');
    assert.deepEqual(s.ae.size(), { refs: 0, deferred: 2 });
    s.clock.t += 50e3;
    const threads = view({ main: T0 - 2e3, mainOpen: [{ name: 'Bash', at: T0 - 1e3 }], agentOpen: [{ name: 'Edit', at: T0 - 1e3 }] });
    // A pass that began reading before the cards were relayed can't judge them.
    assert.equal(pass(s, threads, { readAt: T0 }), 0);
    assert.deepEqual(s.ae.size(), { refs: 0, deferred: 2 });
    assert.equal(pass(s, threads), 1, 'the lead\'s own one closes as his Stop said');
    assert.equal(s.state('owncd'), 'elsewhere');
    assert.equal(s.store.permission('owncd').closedBy, 'Stop');
    assert.equal(s.state('subcd'), 'open', 'the subagent\'s one stays');
    assert.match(s.logs.join('\n'), /kept open after the lead's turn: a subagent's, and its thread has not moved past it: subcd/);
    assert.deepEqual(s.ae.size(), { refs: 1, deferred: 0 });
  } finally { await s.clean(); }
});

test('a card no thread is at (a pass found none) closes at the lead\'s turn as before; SessionEnd closes a subagent\'s too', async () => {
  const s = await setup();
  try {
    await s.open('subcd');
    await s.open('subce');
    s.clock.t += 30e3;
    // Each card is judged on its own: two Bash cards at one moment both take the subagent's.
    pass(s, view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }], main: T0 - 5 * MIN }));
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 0);
    assert.equal(s.state('subcd'), 'open');
    assert.equal(s.ae.note({ event: 'SessionEnd', sessionId: LEAD, at: s.clock.t + 1 }), 2);
    assert.equal(s.state('subcd'), 'elsewhere');
    assert.equal(s.state('subce'), 'elsewhere');
    assert.deepEqual(s.ae.size(), { refs: 0, deferred: 0 });
    // A card no thread is at.
    await s.open('alone', 'Write');
    s.clock.t += 30e3;
    pass(s, view({ agentOpen: [{ name: 'Bash', at: T0 }] }));
    assert.equal(s.ae.note({ event: 'UserPromptSubmit', sessionId: LEAD, at: s.clock.t }), 1);
    assert.equal(s.state('alone'), 'elsewhere');
  } finally { await s.clean(); }
});

test('with no sessions pass for 3 minutes, the lead\'s turn closes an unjudged card at once, and a deferred close goes at the next hook event', async () => {
  const s = await setup();
  try {
    assert.equal(PASS_FRESH_MS, 3 * MIN);
    await s.open('first');
    s.clock.t += 1e3;
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 1, 'no pass ever: closed as before');
    pass(s, view(), { readAt: s.clock.t });
    await s.open('secnd');
    s.clock.t += 10e3;
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 0, 'deferred');
    s.clock.t += PASS_FRESH_MS;
    await s.open('third');
    s.clock.t += 1e3;
    assert.equal(s.ae.note({ event: 'UserPromptSubmit', sessionId: LEAD, at: s.clock.t }), 2, 'the deferred one, and the new one at once');
    assert.equal(s.store.permission('secnd').closedBy, 'Stop');
    assert.equal(s.store.permission('third').closedBy, 'UserPromptSubmit');
    assert.match(s.logs.join('\n'), /the lead's session moved on: Stop; no sessions pass said whose it was\): secnd/);
  } finally { await s.clean(); }
});

test('the pass: no transcripts or no session of the lead\'s is no pass; another session\'s threads are not his; a closed card is forgotten', async () => {
  const s = await setup();
  try {
    await s.open('abcde');
    s.clock.t += 30e3;
    const threads = view({ sid: OTHER, agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] });
    assert.equal(s.ae.pass({ threads: null, sessions: [LEAD] }), 0);
    assert.equal(s.ae.pass({ threads, sessions: [] }), 0);
    assert.equal(s.ae.pass({ threads }), 0);
    assert.deepEqual(s.ae.size(), { refs: 0, deferred: 0 }, 'no pass, no judgement');
    assert.equal(pass(s, threads), 0);
    assert.deepEqual(s.ae.size(), { refs: 1, deferred: 0 }, 'judged: no thread of the lead\'s is at it');
    assert.equal(s.ae.note({ event: 'Stop', sessionId: OTHER, at: s.clock.t }), 0, 'another session\'s turn says nothing');
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 1);
    s.clock.t += MIN;
    pass(s, threads);
    assert.deepEqual(s.ae.size(), { refs: 0, deferred: 0 });
  } finally { await s.clean(); }
});

test('the pass forgets a card answered here: its thread, and a close that waited for a pass', async () => {
  const s = await setup();
  try {
    pass(s, view(), { readAt: s.clock.t - 1 });
    await s.open('judgd');
    await s.open('waitd');
    s.clock.t += 30e3;
    pass(s, view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }), { readAt: T0 + 1 });
    assert.deepEqual(s.ae.size(), { refs: 2, deferred: 0 });
    await s.store.answerPermission('judgd', 'deny', 'phone');
    s.clock.t += MIN;
    pass(s, view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }));
    assert.deepEqual(s.ae.size(), { refs: 1, deferred: 0 }, 'the answered one is let go');
    // A close deferred for a card answered here before the next pass.
    await s.open('later');
    s.clock.t += 5e3;
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 0);
    assert.deepEqual(s.ae.size(), { refs: 1, deferred: 1 });
    await s.store.answerPermission('later', 'allow', 'phone');
    s.clock.t += 30e3;
    pass(s, view({ agentOpen: [{ name: 'Bash', at: T0 - 1e3 }] }));
    assert.deepEqual(s.ae.size(), { refs: 1, deferred: 0 });
  } finally { await s.clean(); }
});

test('store: closablePermissions lists the open and timed-out requests as copies; closePermissionsElsewhere with ids closes only those', async () => {
  const s = await setup();
  try {
    await s.open('abcde');
    await s.open('fghij');
    await s.open('kmnop');
    await s.store.answerPermission('kmnop', 'deny', 'phone');
    const list = s.store.closablePermissions();
    assert.deepEqual(list, [{ requestId: 'abcde', tool: 'Bash', relayedAt: T0 }, { requestId: 'fghij', tool: 'Bash', relayedAt: T0 }]);
    list[0].relayedAt = 0;
    assert.equal(s.store.permission('abcde').relayedAt, T0, 'a copy');
    s.clock.t += 1;
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: s.clock.t, ids: new Set(['fghij', 'kmnop']) }), ['fghij']);
    assert.equal(s.state('abcde'), 'open');
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: s.clock.t, ids: ['abcde'] }), [], 'ids that are no Set close nothing');
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: s.clock.t, ids: new Set() }), []);
  } finally { await s.clean(); }
});
