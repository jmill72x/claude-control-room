// "Jarvis is waiting on you" (lib/needs-you.mjs): the hook's JSON read down to three
// fields, the in-memory waits, what the page gets, the alert and the push. Every
// session id, agent and job here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNeedsYou, recordNeedsYou, activeWaits, needsYouView, needsYouAlerts, waitKey, createNeedsYouStore, needsYouLogLine,
  isStaleEvent, noteSeen, NEEDS_YOU_SEEN_MAX, NEEDS_YOU_MAX, NEEDS_YOU_TTL_MS, NEEDS_YOU_ALERT_MS,
  noteAsks, agentKey, ASKS_MAX, ASK_MOVED_ON_MS
} from '../lib/needs-you.mjs';
import { buildAlerts } from '../lib/alerts.mjs';
import { pushableFrom, observableSources } from '../lib/push-alerts.mjs';
import { runNotifier } from '../collectors/notifier.mjs';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';

const MIN = 60e3;
const NOW = 1794380000000;
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const hook = (extra = {}) => ({ session_id: SID, transcript_path: '/private/somewhere/x.jsonl', cwd: '/private/somewhere', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', ...extra });

test('the hook\'s JSON is read down to the event, the session and the kind of wait; nothing else is kept', () => {
  assert.deepEqual(checkNeedsYou(hook()), { ok: true, value: { event: 'Notification', sessionId: SID, kind: 'permission', at: null } });
  assert.equal(checkNeedsYou(hook({ notification_type: 'idle_prompt' })).value.kind, 'idle');
  assert.equal(checkNeedsYou(hook({ notification_type: 'elicitation_dialog' })).value.kind, 'question');
  assert.equal(checkNeedsYou(hook({ notification_type: 'auth_success' })).value.kind, null, 'a notification nobody must answer opens nothing');
  assert.equal(checkNeedsYou(hook({ notification_type: undefined })).value.kind, null);
  // A PermissionRequest names the ask and opens nothing itself (board 9fb32c4d): the
  // tool's name is read, its input never.
  assert.deepEqual(checkNeedsYou(hook({ hook_event_name: 'PermissionRequest', notification_type: undefined, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })).value, { event: 'PermissionRequest', sessionId: SID, kind: null, at: null, tool: 'Bash' });
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionEnd']) {
    assert.deepEqual(checkNeedsYou(hook({ hook_event_name: event })).value, { event, sessionId: SID, kind: null, at: null }, event);
  }
  const value = checkNeedsYou(hook()).value;
  assert.deepEqual(Object.keys(value).sort(), ['at', 'event', 'kind', 'sessionId'], 'no message, path, cwd or tool input survives the check');
  // The README's hook entry sends exactly these four fields, with notification_type
  // null for an event that has none (jq's `{a,b,c}` on a body without `c`), and `at`
  // from jq's `(now*1000|floor)`.
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'SessionEnd', session_id: SID, notification_type: null, at: NOW }).value, { event: 'SessionEnd', sessionId: SID, kind: null, at: NOW });
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: 'idle_prompt', at: NOW }).value, { event: 'Notification', sessionId: SID, kind: 'idle', at: NOW });
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Stop', session_id: SID, notification_type: null, at: NOW }).value, { event: 'Stop', sessionId: SID, kind: null, at: NOW });
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: null, at: NOW }).value, { event: 'Notification', sessionId: SID, kind: null, at: NOW }, 'a Notification with no type is accepted and opens nothing');
  // The 11-11 entry, with no `at`, still posts: its events are taken in arrival order.
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Stop', session_id: SID, notification_type: null }).value, { event: 'Stop', sessionId: SID, kind: null, at: null });
});

test('a bad hook body says what is wrong', () => {
  const bad = v => { const r = checkNeedsYou(v); assert.equal(r.ok, false, JSON.stringify(v)); return r.error; };
  assert.match(bad(null), /object/);
  assert.match(bad([]), /object/);
  assert.match(bad(hook({ hook_event_name: 'PreToolUse' })), /hook_event_name/);
  assert.match(bad(hook({ hook_event_name: undefined })), /hook_event_name/);
  assert.match(bad(hook({ session_id: undefined })), /session_id/);
  assert.match(bad(hook({ session_id: 'has space' })), /session_id/);
  assert.match(bad(hook({ session_id: 'x'.repeat(81) })), /session_id/);
  assert.match(bad(hook({ session_id: '../etc' })), /session_id/);
  assert.match(bad(hook({ notification_type: 'Permission Prompt' })), /notification_type/);
  assert.match(bad(hook({ notification_type: 7 })), /notification_type/);
  for (const at of [NOW + 0.5, -1, '1794380000000', Number.MAX_SAFE_INTEGER + 2, true, {}]) assert.match(bad(hook({ at })), /at must be/, String(at));
  assert.equal(checkNeedsYou(hook({ at: 0 })).value.at, 0);
});

const opening = (sid, kind = 'permission') => ({ event: 'Notification', sessionId: sid, kind });
const clearing = sid => ({ event: 'PostToolUse', sessionId: sid, kind: null });

test('an opening event adds the session\'s wait, a clearing one drops it, and a re-sent prompt keeps its since', () => {
  let list = recordNeedsYou([], opening(SID), NOW);
  assert.deepEqual(list, [{ sessionId: SID, kind: 'permission', since: NOW }]);
  list = recordNeedsYou(list, opening(SID), NOW + 2 * MIN);
  assert.equal(list[0].since, NOW, 'the same wait, said again');
  list = recordNeedsYou(list, opening(SID, 'idle'), NOW + 3 * MIN);
  assert.deepEqual(list, [{ sessionId: SID, kind: 'idle', since: NOW + 3 * MIN }], 'a different kind is a new wait');
  list = recordNeedsYou(list, opening('other'), NOW + 4 * MIN);
  assert.equal(list.length, 2);
  list = recordNeedsYou(list, clearing(SID), NOW + 5 * MIN);
  assert.deepEqual(list.map(w => w.sessionId), ['other']);
  list = recordNeedsYou(list, { event: 'Notification', sessionId: 'other', kind: null }, NOW + 6 * MIN);
  assert.deepEqual(list, [], 'a notification that opens nothing ends the wait it had: the session moved on');
  assert.deepEqual(recordNeedsYou(null, clearing('nobody'), NOW), [], 'a clear for a session with no wait is nothing');
});

test('a wait lapses after 30 minutes, and at most 20 are kept, the oldest going first', () => {
  assert.equal(NEEDS_YOU_TTL_MS, 30 * MIN);
  assert.equal(NEEDS_YOU_MAX, 20);
  const list = recordNeedsYou([], opening(SID), NOW);
  assert.equal(activeWaits(list, NOW + NEEDS_YOU_TTL_MS - 1).length, 1);
  assert.equal(activeWaits(list, NOW + NEEDS_YOU_TTL_MS).length, 0);
  assert.deepEqual(recordNeedsYou(list, opening('b'), NOW + NEEDS_YOU_TTL_MS).map(w => w.sessionId), ['b'], 'a write prunes');
  let many = [];
  for (let i = 0; i < 25; i++) many = recordNeedsYou(many, opening(`s${i}`), NOW + i);
  assert.equal(many.length, 20);
  assert.equal(many[0].sessionId, 's5');
  assert.deepEqual(activeWaits([{ sessionId: 'x', since: 'soon' }, null, { sessionId: 'y', kind: 'idle', since: NOW }], NOW).map(w => w.sessionId), ['y'], 'malformed entries are ignored');
});

test('the page gets who, kind, since and a key: never the session id', () => {
  const list = recordNeedsYou(recordNeedsYou([], opening(SID), NOW), opening('nobody', 'idle'), NOW + MIN);
  const whoFor = id => (id === SID ? 'Atlas' : null);
  const view = needsYouView(list, whoFor, NOW + 2 * MIN);
  assert.deepEqual(view, [
    { who: 'Atlas', kind: 'permission', since: NOW, key: waitKey(SID) },
    { who: null, kind: 'idle', since: NOW + MIN, key: waitKey('nobody') }
  ]);
  assert.match(waitKey(SID), /^needs-you:[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(view).includes(SID));
  assert.notEqual(waitKey(SID), waitKey('nobody'));
  assert.equal(waitKey(SID), waitKey(SID), 'stable, so the notifier dedups on it');
  assert.equal(needsYouView(list, () => { throw new Error('boom'); }, NOW)[0].who, null, 'a failing lookup is nobody, not a crash');
  assert.equal(needsYouView(list, () => '  Very long name that goes on and on and on past forty  ', NOW)[0].who.length, 40);
  assert.deepEqual(needsYouView(list, whoFor, NOW + NEEDS_YOU_TTL_MS + 2 * MIN), [], 'lapsed waits are gone');
});

test('a wait five minutes old is an alert, counted in words, never quoted, and always observable', () => {
  assert.equal(NEEDS_YOU_ALERT_MS, 5 * MIN);
  const waits = [
    { who: 'Atlas', kind: 'permission', since: NOW - 5 * MIN, key: 'needs-you:aaaaaaaaaaaa' },
    { who: null, kind: 'idle', since: NOW - 6 * MIN, key: 'needs-you:bbbbbbbbbbbb' },
    { who: 'Forge', kind: 'question', since: NOW - 4 * MIN - 59e3, key: 'needs-you:cccccccccccc' }
  ];
  const alerts = needsYouAlerts(waits, NOW);
  assert.deepEqual(alerts, [
    { text: 'Atlas is waiting on a permission', kind: 'needs-you', key: 'needs-you:aaaaaaaaaaaa', since: NOW - 5 * MIN },
    { text: 'A session is waiting on an answer', kind: 'needs-you', key: 'needs-you:bbbbbbbbbbbb', since: NOW - 6 * MIN }
  ]);
  assert.deepEqual(needsYouAlerts(null, NOW), []);
  // Through buildAlerts, as the route's list and as the notifier's envelope.
  const fromRoute = buildAlerts({ needsYou: waits }, { warnThreshold: 85 }, NOW);
  assert.deepEqual(fromRoute.map(a => a.key), ['needs-you:aaaaaaaaaaaa', 'needs-you:bbbbbbbbbbbb']);
  const fromNotifier = buildAlerts({ needsYou: { status: 'ok', data: waits } }, { warnThreshold: 85 }, NOW);
  assert.deepEqual(fromNotifier.map(a => a.key), fromRoute.map(a => a.key));
  assert.deepEqual(buildAlerts({ needsYou: { status: 'ok', data: undefined } }, { warnThreshold: 85 }, NOW), []);
  // The push: a count, with no name in it.
  const pushed = pushableFrom(alerts);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].message, '2 sessions are waiting on you — open the dashboard for detail');
  assert.deepEqual(pushed[0].keys, ['needs-you:aaaaaaaaaaaa', 'needs-you:bbbbbbbbbbbb']);
  assert.equal(pushableFrom(alerts.slice(0, 1))[0].message, '1 session is waiting on you — open the dashboard for detail');
  assert.ok(!JSON.stringify(pushed).includes('Atlas'));
  assert.ok(observableSources({}).has('needs-you'), 'in memory here, so a gone wait has cleared');
});

test('the store: record, view and size, in memory', () => {
  const store = createNeedsYouStore({ whoFor: id => (id === SID ? 'Atlas' : null) });
  assert.deepEqual(store.record(checkNeedsYou(hook()).value, NOW), { open: 1, stale: false });
  assert.equal(store.record(checkNeedsYou(hook({ session_id: 'other', notification_type: 'idle_prompt' })).value, NOW + MIN).open, 2);
  assert.deepEqual(store.view(NOW + MIN).map(w => [w.who, w.kind]), [['Atlas', 'permission'], [null, 'idle']]);
  assert.equal(store.record(checkNeedsYou(hook({ hook_event_name: 'Stop' })).value, NOW + 2 * MIN).open, 1);
  assert.equal(store.size(NOW + 2 * MIN), 1);
  assert.equal(store.size(NOW + 2 * MIN + NEEDS_YOU_TTL_MS), 0);
  assert.equal(createNeedsYouStore().record(checkNeedsYou(hook()).value, NOW).open, 1, 'with no lookup, who is nobody');
  assert.equal(needsYouLogLine({ event: 'Notification', kind: 'permission' }, 2), 'needs-you: Notification (permission), 2 open');
  assert.equal(needsYouLogLine({ event: 'Stop', kind: null }, 0), 'needs-you: Stop, 0 open');
  assert.equal(needsYouLogLine({ event: 'Notification', kind: 'idle' }, 0, true), 'needs-you: Notification (idle), older than the last event seen, ignored, 0 open');
});

test('async posts out of order: an event older than the newest seen for its session changes nothing', () => {
  const store = createNeedsYouStore();
  const ev = (event, at, extra = {}) => checkNeedsYou(hook({ hook_event_name: event, at, ...extra })).value;
  // The prompt opens at t, the person answers, the clear runs at t+2 s and lands
  // first; the "waiting" post from t lands after it and must not reopen the card.
  assert.deepEqual(store.record(ev('PostToolUse', NOW + 2000), NOW + 2100), { open: 0, stale: false });
  assert.deepEqual(store.record(ev('Notification', NOW), NOW + 2200), { open: 0, stale: true });
  assert.deepEqual(store.view(NOW + 2200), [], 'no stale Waiting card');
  // A later prompt is newer than the clear, so it opens; the same `at` again is not older.
  assert.deepEqual(store.record(ev('Notification', NOW + 5000), NOW + 5100), { open: 1, stale: false });
  assert.deepEqual(store.record(ev('Notification', NOW + 5000), NOW + 5200), { open: 1, stale: false });
  // A clear older than that prompt is ignored too: the wait stays.
  assert.deepEqual(store.record(ev('Stop', NOW + 4000), NOW + 5300), { open: 1, stale: true });
  assert.equal(store.size(NOW + 5300), 1);
  // Order is per session: another session's older `at` is its own business.
  assert.deepEqual(store.record(ev('Notification', NOW + 1, { session_id: 'other', notification_type: 'idle_prompt' }), NOW + 5400), { open: 2, stale: false });
  // An event with no `at` (the 11-11 entry) can't be ordered, so it is taken, and
  // it leaves the newest `at` as it was.
  assert.deepEqual(store.record(ev('Stop', undefined), NOW + 5500), { open: 1, stale: false });
  assert.deepEqual(store.record(ev('Notification', NOW + 4500), NOW + 5600), { open: 1, stale: true }, 'still older than the prompt at +5 s');
});

test('the newest-seen times lapse with the waits and are capped', () => {
  const v = (sid, at) => ({ event: 'Stop', sessionId: sid, kind: null, at });
  let seen = noteSeen(new Map(), v(SID, NOW + 9000), NOW);
  assert.equal(isStaleEvent(seen, v(SID, NOW)), true);
  assert.equal(isStaleEvent(seen, v('other', NOW)), false);
  assert.equal(isStaleEvent(seen, { ...v(SID, null) }), false, 'no `at`, never stale');
  assert.equal(noteSeen(seen, v('x', null), NOW + NEEDS_YOU_TTL_MS - 1).has(SID), true);
  assert.equal(noteSeen(seen, v('x', null), NOW + NEEDS_YOU_TTL_MS).has(SID), false, 'gone with the 30 minutes a wait lives');
  assert.equal(noteSeen(seen, v(SID, null), NOW + MIN).get(SID).at, NOW + 9000, 'an event with no `at` leaves the newest as it was');
  assert.equal(NEEDS_YOU_SEEN_MAX, 200);
  seen = new Map();
  for (let i = 0; i < 205; i++) seen = noteSeen(seen, v(`s${i}`, NOW), NOW + i);
  assert.equal(seen.size, 200);
  assert.equal(seen.has('s4'), false);
  assert.equal(seen.has('s5'), true);
  // A session seen again moves to the back, so it is not the next to go.
  seen = noteSeen(seen, v('s5', NOW + 1), NOW + 300);
  seen = noteSeen(seen, v('new', NOW), NOW + 301);
  assert.equal(seen.has('s5'), true);
  assert.equal(seen.has('s6'), false);
});

// ---- which tool use ends a permission wait (board 9fb32c4d) ----

const AGENT = 'a0b1c2d3e4f5a6b7c'; // an invented subagent id
const post = (extra = {}) => checkNeedsYou({ hook_event_name: 'PostToolUse', session_id: SID, notification_type: null, agent_id: null, tool_name: 'Bash', duration_ms: 50, at: NOW, ...extra }).value;
const ask = (extra = {}) => checkNeedsYou({ hook_event_name: 'PermissionRequest', session_id: SID, notification_type: null, agent_id: null, tool_name: 'Bash', duration_ms: null, at: NOW, ...extra }).value;
const prompt = (at = NOW + 6000) => checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: 'permission_prompt', agent_id: null, tool_name: null, duration_ms: null, at }).value;

test('the newer entry\'s fields: agent_id kept only as a hash, tool_name and duration_ms; nulls are absent; bad ones say what is wrong', () => {
  const v = post({ agent_id: AGENT, tool_input: { command: 'secret' }, tool_response: 'secret', tool_use_id: 'toolu_x' });
  assert.deepEqual(v, { event: 'PostToolUse', sessionId: SID, kind: null, at: NOW, agent: agentKey(AGENT), tool: 'Bash', ms: 50 });
  assert.match(v.agent, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(v).includes(AGENT) && !JSON.stringify(v).includes('secret'));
  assert.deepEqual(post(), { event: 'PostToolUse', sessionId: SID, kind: null, at: NOW, tool: 'Bash', ms: 50 }, 'the session\'s own thread: no agent');
  assert.deepEqual(prompt(NOW), { event: 'Notification', sessionId: SID, kind: 'permission', at: NOW }, 'jq\'s nulls are no fields');
  assert.equal(checkNeedsYou({ hook_event_name: 'PostToolUseFailure', session_id: SID, tool_name: 'Read', duration_ms: 0 }).value.ms, 0);
  // An odd value is read as absent, never a 400 (Ultron's L2): the post still counts, and
  // without the field it falls back to clearing as before.
  const read = extra => { const r = checkNeedsYou({ hook_event_name: 'PostToolUse', session_id: SID, at: NOW, ...extra }); assert.equal(r.ok, true, JSON.stringify(extra)); return r.value; };
  const bare = { event: 'PostToolUse', sessionId: SID, kind: null, at: NOW };
  for (const agent_id of ['', 7, {}, ['x'], true]) assert.deepEqual(read({ agent_id }), bare, JSON.stringify(agent_id));
  for (const agent_id of ['x'.repeat(201), 'odd id: with/marks', 'a'.repeat(5000)]) assert.equal(read({ agent_id }).agent, agentKey(agent_id), 'any non-empty id is hashed, whatever its form');
  for (const tool_name of ['a b', '', 7, 'x'.repeat(201), 'Bash\n']) assert.deepEqual(read({ tool_name }), bare, JSON.stringify(tool_name));
  const longMcp = `mcp__plugin_${'x'.repeat(60)}__${'y'.repeat(40)}`;
  assert.ok(longMcp.length > 80);
  assert.equal(read({ tool_name: longMcp }).tool, longMcp, 'a long MCP name is a name');
  assert.equal(read({ tool_name: 'x'.repeat(200) }).tool.length, 200);
  for (const duration_ms of [-1, 1.5, '50', true, Number.MAX_SAFE_INTEGER + 2]) assert.deepEqual(read({ duration_ms }), bare, JSON.stringify(duration_ms));
  // A permission wait with an ask: a post whose tool name was odd is toolless, so it
  // clears as the older entries do (the fallback), rather than being lost.
  const st = createNeedsYouStore();
  st.record(ask(), NOW);
  st.record(prompt(), NOW + 6000);
  assert.deepEqual(st.record(read({ tool_name: 'x'.repeat(300), at: NOW + 7000 }), NOW + 7000), { open: 0, stale: false });
  assert.equal(agentKey(AGENT), agentKey(AGENT));
  assert.notEqual(agentKey(AGENT), agentKey('other'));
  assert.equal(needsYouLogLine(post({ agent_id: AGENT }), 1), 'needs-you: PostToolUse (Bash, a subagent), 1 open');
  assert.equal(needsYouLogLine(ask(), 0), 'needs-you: PermissionRequest (Bash), 0 open');
  assert.equal(needsYouLogLine(checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: AGENT }).value, 0), 'needs-you: SubagentStop (a subagent), 0 open');
});

test('11-12: a subagent\'s PostToolUse in the same session no longer clears the lead\'s permission wait; the asked tool\'s does', () => {
  const store = createNeedsYouStore();
  // The lead asks for Bash at t; the Notification comes 6 s later.
  assert.deepEqual(store.record(ask(), NOW + 50), { open: 0, stale: false }, 'an ask opens nothing');
  assert.deepEqual(store.record(prompt(), NOW + 6017), { open: 1, stale: false });
  // 279 ms later a background subagent's Bash ends (it ran 1.65 s): the wait stays.
  assert.deepEqual(store.record(post({ agent_id: AGENT, duration_ms: 1650, at: NOW + 6296 }), NOW + 6300), { open: 1, stale: false });
  // The lead's own calls that were already running when it asked are not the answer either.
  store.record(post({ tool_name: 'Bash', duration_ms: 9000, at: NOW + 7000 }), NOW + 7000);
  store.record(post({ tool_name: 'Read', duration_ms: 20, at: NOW + 7100 }), NOW + 7100);
  assert.equal(store.size(NOW + 7100), 1);
  // Five minutes on it is an alert (this is what never fired on 11-12).
  assert.equal(needsYouAlerts(store.view(NOW + 6017 + NEEDS_YOU_ALERT_MS), NOW + 6017 + NEEDS_YOU_ALERT_MS).length, 1);
  // Seventeen minutes on the prompt is allowed and the lead's Bash runs: that ends it.
  const answered = NOW + 17 * MIN;
  assert.deepEqual(store.record(post({ duration_ms: 1200, at: answered + 1200 }), answered + 1300), { open: 0, stale: false });
});

test('asks: matched by thread and tool, the oldest first; a call started before the ask is not its answer; one started 10 s after any ask of its thread ends it', () => {
  const asks0 = new Map();
  let r = noteAsks(asks0, ask(), NOW);
  assert.deepEqual([r.before, r.after], [0, 1]);
  assert.deepEqual(r.asks.get(SID), [{ agent: null, tool: 'Bash', at: NOW, receivedAt: NOW }]);
  r = noteAsks(r.asks, ask({ agent_id: AGENT, tool_name: 'Write', at: NOW + 1 }), NOW + 1);
  r = noteAsks(r.asks, ask({ at: NOW + 2 }), NOW + 2);
  assert.equal(r.after, 3);
  const at = r.asks;
  // Another thread's Bash, or the same thread's other tool started soon after: nothing.
  assert.equal(noteAsks(at, post({ agent_id: 'someone-else', at: NOW + 5000, duration_ms: 10 }), NOW + 5000).after, 3);
  assert.equal(noteAsks(at, post({ tool_name: 'Read', at: NOW + 5000, duration_ms: 10 }), NOW + 5000).after, 3);
  // Same thread and tool, started before the ask: a call that was already running.
  assert.equal(noteAsks(at, post({ at: NOW + 3000, duration_ms: 3001 }), NOW + 3000).after, 3);
  // Started at the ask's own millisecond: it may be the answer.
  r = noteAsks(at, post({ at: NOW + 3000, duration_ms: 3000 }), NOW + 3000);
  assert.equal(r.after, 2);
  assert.deepEqual(r.asks.get(SID).map(a => a.at), [NOW + 1, NOW + 2], 'the oldest of the two Bash asks went');
  // A post with no duration can't be placed in time: the tool alone matches.
  assert.equal(noteAsks(at, post({ duration_ms: null, at: NOW - 60e3 }), NOW).after, 2);
  // The thread moved on: the same thread's Read started 10 s after both its asks ends them; 1 ms less does not.
  assert.equal(noteAsks(at, post({ tool_name: 'Read', at: NOW + 2 + ASK_MOVED_ON_MS + 10, duration_ms: 10 }), NOW + 20e3).after, 1);
  assert.equal(noteAsks(at, post({ tool_name: 'Read', at: NOW + 2 + ASK_MOVED_ON_MS + 9, duration_ms: 10 }), NOW + 20e3).after, 2, 'only the older ask is 10 s past');
  assert.equal(noteAsks(at, post({ tool_name: 'Read', at: NOW + ASK_MOVED_ON_MS - 1 + 10, duration_ms: 10 }), NOW + 20e3).after, 3);
  assert.equal(noteAsks(at, post({ tool_name: 'Read', at: NOW + 60e3, duration_ms: null }), NOW + 60e3).after, 3, 'no duration, no "moved on"');
  // The subagent's Write answer.
  assert.equal(noteAsks(at, post({ agent_id: AGENT, tool_name: 'Write', at: NOW + 9000, duration_ms: 5 }), NOW + 9000).after, 2);
  // PostToolUseFailure answers like PostToolUse (the asked command failed).
  assert.equal(noteAsks(at, { ...post({ at: NOW + 9000, duration_ms: 5 }), event: 'PostToolUseFailure' }, NOW + 9000).after, 2);
  // A post that names no tool (the older entry) answers nothing, even with a run time
  // that would say its thread moved on.
  assert.equal(noteAsks(at, checkNeedsYou({ hook_event_name: 'PostToolUse', session_id: SID, at: NOW + 9000 }).value, NOW + 9000).after, 3);
  assert.equal(noteAsks(at, checkNeedsYou({ hook_event_name: 'PostToolUse', session_id: SID, duration_ms: 5, at: NOW + 60e3 }).value, NOW + 60e3).after, 3);
  // Stop and UserPromptSubmit end the session's own thread's asks made before them, never a subagent's.
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const e = checkNeedsYou({ hook_event_name: event, session_id: SID, at: NOW + 9000 }).value;
    assert.deepEqual(noteAsks(at, e, NOW + 9000).asks.get(SID).map(a => a.tool), ['Write'], event);
    assert.equal(noteAsks(at, { ...e, at: NOW + 1 }, NOW + 9000).after, 2, `${event}: an ask made after it stays`);
  }
  // SubagentStop ends that subagent's asks made before it.
  const stop = checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: AGENT, at: NOW + 9000 }).value;
  assert.deepEqual(noteAsks(at, stop, NOW + 9000).asks.get(SID).map(a => a.tool), ['Bash', 'Bash']);
  assert.equal(noteAsks(at, { ...stop, at: NOW }, NOW + 9000).after, 3, 'its ask came after');
  assert.equal(noteAsks(at, checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'someone-else', at: NOW + 9000 }).value, NOW + 9000).after, 3);
  assert.equal(noteAsks(at, checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, at: NOW + 9000 }).value, NOW + 9000).after, 3, 'no agent named: nothing');
  assert.equal(noteAsks(at, checkNeedsYou({ hook_event_name: 'SessionEnd', session_id: SID, at: NOW + 9000 }).value, NOW + 9000).after, 0);
  // Another session's events are its own.
  assert.equal(noteAsks(at, post({ session_id: 'other', at: NOW + 9000, duration_ms: 5 }), NOW + 9000).asks.get(SID).length, 3);
  // Asks lapse with the 30 minutes a wait lives, and at most ASKS_MAX a session are kept.
  assert.equal(noteAsks(at, post({ session_id: 'other' }), NOW + NEEDS_YOU_TTL_MS - 1).asks.get(SID).length, 3);
  assert.equal(noteAsks(at, post({ session_id: 'other' }), NOW + NEEDS_YOU_TTL_MS).asks.get(SID).length, 2, 'the one received first lapsed');
  assert.equal(noteAsks(at, post({ session_id: 'other' }), NOW + NEEDS_YOU_TTL_MS + 2).asks.has(SID), false);
  let many = new Map();
  for (let i = 0; i < ASKS_MAX + 3; i++) many = noteAsks(many, ask({ at: NOW + i }), NOW + i).asks;
  assert.equal(many.get(SID).length, ASKS_MAX);
  assert.equal(many.get(SID)[0].at, NOW + 3);
  // At most NEEDS_YOU_SEEN_MAX sessions, the one asked longest ago going first.
  let wide = new Map();
  for (let i = 0; i < NEEDS_YOU_SEEN_MAX + 2; i++) wide = noteAsks(wide, ask({ session_id: `s${i}` }), NOW).asks;
  assert.equal(wide.size, NEEDS_YOU_SEEN_MAX);
  assert.equal(wide.has('s1'), false);
  assert.equal(wide.has('s2'), true);
  // A session asked again moves to the back, so it is not the next to go.
  wide = noteAsks(wide, ask({ session_id: 's2' }), NOW).asks;
  wide = noteAsks(wide, ask({ session_id: 'fresh' }), NOW).asks;
  assert.equal(wide.has('s2'), true);
  assert.equal(wide.has('s3'), false);
  assert.equal(noteAsks(null, ask(), NOW).after, 1, 'no map yet');
});

test('the wait with asks: it ends with the session\'s last ask; Stop leaves a subagent\'s ask waiting; SubagentStop, a denied prompt\'s next call and SessionEnd end it', () => {
  const fresh = () => createNeedsYouStore();
  // Two asks (the lead's Bash, a subagent's Write): the lead's answer leaves the wait open.
  let s = fresh();
  s.record(ask(), NOW);
  s.record(ask({ agent_id: AGENT, tool_name: 'Write' }), NOW + 10);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(post({ at: NOW + 20e3, duration_ms: 100 }), NOW + 20e3).open, 1);
  assert.equal(s.record(post({ agent_id: AGENT, tool_name: 'Write', at: NOW + 30e3, duration_ms: 100 }), NOW + 30e3).open, 0);
  // The lead's turn ends while a subagent's prompt waits: the wait stays (Stop did clear it before).
  s = fresh();
  s.record(ask({ agent_id: AGENT }), NOW);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'Stop', session_id: SID, at: NOW + 7000 }).value, NOW + 7000).open, 1);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'UserPromptSubmit', session_id: SID, at: NOW + 8000 }).value, NOW + 8000).open, 1);
  // ...and the lead's own work goes on beside it.
  assert.equal(s.record(post({ at: NOW + 60e3, duration_ms: 100 }), NOW + 60e3).open, 1);
  // The subagent ends (denied, it reported and stopped): the wait goes.
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: AGENT, at: NOW + 70e3 }).value, NOW + 70e3).open, 0);
  // The lead's prompt denied: no PostToolUse; its next call, started over 10 s later, ends the wait.
  s = fresh();
  s.record(ask(), NOW);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(post({ tool_name: 'Read', at: NOW + 9000, duration_ms: 5 }), NOW + 9000).open, 1);
  assert.equal(s.record(post({ tool_name: 'Read', at: NOW + 40e3, duration_ms: 5 }), NOW + 40e3).open, 0);
  // Or its turn ends.
  s = fresh();
  s.record(ask(), NOW);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'Stop', session_id: SID, at: NOW + 9000 }).value, NOW + 9000).open, 0);
  // SessionEnd ends it all.
  s = fresh();
  s.record(ask({ agent_id: AGENT }), NOW);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'SessionEnd', session_id: SID, at: NOW + 9000 }).value, NOW + 9000).open, 0);
  // A SubagentStop says nothing of a wait whose ask is the lead's, or of one with no ask known.
  s = fresh();
  s.record(ask(), NOW);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: AGENT, at: NOW + 9000 }).value, NOW + 9000).open, 1);
  s = fresh();
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: AGENT, at: NOW + 9000 }).value, NOW + 9000).open, 1);
});

test('no ask known, or the older entry: cleared as before; an idle or question wait is the session\'s own, so a subagent\'s call leaves it', () => {
  // The older entry sends no tool: any PostToolUse clears, as it did.
  let s = createNeedsYouStore();
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'PostToolUse', session_id: SID, notification_type: null, at: NOW + 6100 }).value, NOW + 6100).open, 0);
  // The newer entry but no ask seen (a restart between ask and prompt): any call clears, as before.
  s = createNeedsYouStore();
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(post({ agent_id: AGENT, at: NOW + 6100 }), NOW + 6100).open, 0);
  // Even with the newer entry and asks, a post that names no tool clears.
  s = createNeedsYouStore();
  s.record(ask(), NOW);
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'PostToolUse', session_id: SID, at: NOW + 6100 }).value, NOW + 6100).open, 0);
  // Idle: a subagent's call is not the session coming back; its own thread's call is.
  for (const type of ['idle_prompt', 'elicitation_dialog']) {
    s = createNeedsYouStore();
    s.record(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: type, at: NOW }).value, NOW);
    assert.equal(s.record(post({ agent_id: AGENT, at: NOW + 100 }), NOW + 100).open, 1, type);
    assert.equal(s.record(checkNeedsYou({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: AGENT, at: NOW + 150 }).value, NOW + 150).open, 1, type);
    assert.equal(s.record(post({ at: NOW + 200 }), NOW + 200).open, 0, type);
  }
  // Idle while a subagent's ask is open: the subagent's answer ends the ask, not the idle wait.
  s = createNeedsYouStore();
  s.record(ask({ agent_id: AGENT }), NOW);
  s.record(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: 'idle_prompt', at: NOW + 100 }).value, NOW + 100);
  assert.equal(s.record(post({ agent_id: AGENT, at: NOW + 9000, duration_ms: 10 }), NOW + 9000).open, 1, 'still idle');
  // A wait with none of these: Stop clears as before.
  s = createNeedsYouStore();
  s.record(prompt(), NOW + 6000);
  assert.equal(s.record(checkNeedsYou({ hook_event_name: 'Stop', session_id: SID, at: NOW + 6100 }).value, NOW + 6100).open, 0);
  // A clear for a session with no wait is nothing.
  assert.deepEqual(recordNeedsYou([], post(), NOW, { before: 1, after: 0 }), []);
  assert.deepEqual(recordNeedsYou([], ask(), NOW), [], 'an ask is no wait');
});

test('out of order with asks: a subagent\'s newer post never makes the Notification stale; a late answer still ends the wait; an ask is never stale', () => {
  let s = createNeedsYouStore();
  s.record(ask({ agent_id: AGENT }), NOW);
  // The lead's thread works on; a subagent's post from after the prompt lands first.
  assert.equal(s.record(post({ agent_id: 'someone-else', at: NOW + 6500 }), NOW + 6500).stale, false);
  assert.deepEqual(s.record(prompt(NOW + 6000), NOW + 6600), { open: 1, stale: false }, 'a subagent\'s post is checked, never noted');
  // A subagent's post older than the session's newest is stale, and changes no wait.
  assert.deepEqual(s.record(post({ agent_id: 'someone-else', at: NOW + 5000 }), NOW + 6700), { open: 1, stale: true });
  // The asked tool's answer lands after a newer event of the session's own thread: it is
  // older than that, but it answers the last ask, so the wait goes and it is not ignored.
  s.record(checkNeedsYou({ hook_event_name: 'UserPromptSubmit', session_id: SID, at: NOW + 50e3 }).value, NOW + 50e3);
  assert.equal(s.size(NOW + 50e3), 1, 'the subagent\'s ask still waits');
  assert.deepEqual(s.record(post({ agent_id: AGENT, at: NOW + 40e3, duration_ms: 10 }), NOW + 50e3), { open: 0, stale: false });
  // An ask arriving after a newer post of its own thread is still noted.
  s = createNeedsYouStore();
  s.record(post({ tool_name: 'Read', at: NOW + 200 }), NOW + 200);
  s.record(ask({ at: NOW }), NOW + 250);
  s.record(prompt(NOW + 6000), NOW + 6000);
  assert.equal(s.record(post({ agent_id: AGENT, at: NOW + 6100 }), NOW + 6100).open, 1, 'the ask is known, so a subagent\'s post doesn\'t clear');
  assert.equal(isStaleEvent(new Map([[SID, { at: NOW + 9, receivedAt: NOW }]]), ask()), false);
  assert.equal(noteSeen(new Map(), ask(), NOW).size, 0, 'nor noted');
  assert.equal(noteSeen(new Map(), post({ agent_id: AGENT }), NOW).size, 0);
  assert.equal(noteSeen(new Map(), post(), NOW).get(SID).at, NOW, 'the session\'s own thread is noted');
  assert.equal(isStaleEvent(new Map([[SID, { at: NOW + 9, receivedAt: NOW }]]), post({ agent_id: AGENT })), true, 'a subagent\'s old post is checked');
});

// ---- the route ----

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, hdrs) => { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const call = async (handler, method, url, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method, url,
    headers: { host: '127.0.0.1:8322', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    on(evt, fn) { if (evt === 'data' && body !== undefined) fn(Buffer.from(raw)); if (evt === 'end') fn(); return req; },
    socket: { remoteAddress: '127.0.0.1' },
    unpipe() {}, pause() {}
  };
  const res = mockRes();
  await handler(req, res);
  return res;
};
const deps = () => {
  const cache = createCache();
  const todos = { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) };
  const logged = [];
  const store = createNeedsYouStore({ whoFor: id => (id === SID ? 'Atlas' : null) });
  return { cache, todos, config: { warnThreshold: 85, showAlertBanner: true, present: true }, needsYou: store, log: line => logged.push(line), logged, store };
};

test('POST /api/ingest/needs-you records a wait the dashboard then lists, with no id or path anywhere in the answer', async () => {
  const d = deps();
  const h = createHandler(d);
  assert.deepEqual(JSON.parse((await call(h, 'GET', '/api/dashboard')).body).needsYou, [], 'the field is there before any hook posts');
  const res = await call(h, 'POST', '/api/ingest/needs-you', hook());
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true, open: 1 });
  assert.deepEqual(d.logged, ['needs-you: Notification (permission), 1 open']);
  const body = (await call(h, 'GET', '/api/dashboard')).body;
  const p = JSON.parse(body);
  assert.equal(p.needsYou.length, 1);
  assert.equal(p.needsYou[0].who, 'Atlas');
  assert.equal(p.needsYou[0].kind, 'permission');
  assert.ok(Number.isFinite(p.needsYou[0].since));
  assert.match(p.needsYou[0].key, /^needs-you:[0-9a-f]{12}$/);
  assert.ok(!body.includes(SID) && !body.includes('/private/somewhere') && !body.includes('needs your permission'));
  assert.deepEqual(p.alerts, [], 'not yet five minutes');
  const cleared = await call(h, 'POST', '/api/ingest/needs-you', hook({ hook_event_name: 'PostToolUse' }));
  assert.deepEqual(JSON.parse(cleared.body), { ok: true, open: 0 });
  assert.deepEqual(JSON.parse((await call(h, 'GET', '/api/dashboard')).body).needsYou, []);
  // A "waiting" post that lands after the clear that followed it is answered, logged
  // and ignored.
  const late = await call(h, 'POST', '/api/ingest/needs-you', hook({ hook_event_name: 'Stop', at: Date.now() }));
  assert.deepEqual(JSON.parse(late.body), { ok: true, open: 0 });
  const stale = await call(h, 'POST', '/api/ingest/needs-you', hook({ at: Date.now() - 3000 }));
  assert.equal(stale.statusCode, 200);
  assert.deepEqual(JSON.parse(stale.body), { ok: true, open: 0, stale: true });
  assert.equal(d.logged.at(-1), 'needs-you: Notification (permission), older than the last event seen, ignored, 0 open');
  assert.deepEqual(JSON.parse((await call(h, 'GET', '/api/dashboard')).body).needsYou, []);
});

test('a wait older than five minutes is an alert on the dashboard and a counted push', async () => {
  const d = deps();
  const h = createHandler(d);
  d.store.record(checkNeedsYou(hook()).value, Date.now() - 6 * MIN);
  const p = JSON.parse((await call(h, 'GET', '/api/dashboard')).body);
  assert.deepEqual(p.alerts.map(a => [a.kind, a.text]), [['needs-you', 'Atlas is waiting on a permission']]);
  const sent = [];
  let notified = {};
  const out = await runNotifier({
    snapshot: { ...d.cache.snapshot(Date.now()), needsYou: { status: 'ok', data: d.store.view(Date.now()), fetchedAt: Date.now(), error: null } },
    config: d.config, now: Date.now(), readSent: async () => notified, writeSent: async n => { notified = n; },
    send: async e => { sent.push(e.message); return { sent: true }; }
  });
  assert.equal(out.sent, 1);
  assert.deepEqual(sent, ['1 session is waiting on you — open the dashboard for detail']);
  // Cleared: the key is forgotten, so a later wait pushes again.
  d.store.record(checkNeedsYou(hook({ hook_event_name: 'Stop' })).value, Date.now());
  await runNotifier({
    snapshot: { ...d.cache.snapshot(Date.now()), needsYou: { status: 'ok', data: d.store.view(Date.now()), fetchedAt: Date.now(), error: null } },
    config: d.config, now: Date.now(), readSent: async () => notified, writeSent: async n => { notified = n; },
    send: async e => { sent.push(e.message); return { sent: true }; }
  });
  assert.deepEqual(notified, {});
});

test('the ingest keeps the board\'s guards and says what is wrong; without a store it is not set up', async () => {
  const d = deps();
  const h = createHandler(d);
  assert.equal((await call(h, 'POST', '/api/ingest/needs-you', hook(), { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await call(h, 'POST', '/api/ingest/needs-you', hook(), { 'content-type': 'text/plain' })).statusCode, 415);
  const bad = await call(h, 'POST', '/api/ingest/needs-you', hook({ hook_event_name: 'PreToolUse' }));
  assert.equal(bad.statusCode, 400);
  assert.match(JSON.parse(bad.body).error, /hook_event_name/);
  assert.equal((await call(h, 'POST', '/api/ingest/needs-you', '{"session_id":"' + 'x'.repeat(300 * 1024) + '"}')).statusCode, 413);
  assert.equal((await call(h, 'GET', '/api/ingest/needs-you')).statusCode, 404);
  assert.equal(d.store.size(Date.now()), 0);
  assert.deepEqual(d.logged, []);
  const own = await call(h, 'POST', '/api/ingest/needs-you', hook(), { origin: 'http://127.0.0.1:8322' });
  assert.equal(own.statusCode, 200);
  const bare = createHandler({ cache: d.cache, todos: d.todos, config: d.config });
  assert.equal((await call(bare, 'POST', '/api/ingest/needs-you', hook())).statusCode, 503);
  assert.deepEqual(JSON.parse((await call(bare, 'GET', '/api/dashboard')).body).needsYou, []);
});

// ---- the README's hook entry ----

test('the README\'s hook entry: every command sends `at`, ends in `|| true`, and its body passes the check', async () => {
  const { readFile } = await import('node:fs/promises');
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('### A session waiting on you'));
  const entry = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
  // PermissionRequest is shown merged (Ultron's M2): the exact-command hook's synchronous
  // Bash entry first, exactly as its own section gives it, then this section's.
  const exactSection = readme.slice(readme.indexOf('**The exact-command hook.**'));
  const exactEntry = JSON.parse(exactSection.match(/```json\n([\s\S]*?)\n```/)[1]).hooks.PermissionRequest;
  assert.equal(entry.hooks.PermissionRequest.length, 2);
  assert.deepEqual(entry.hooks.PermissionRequest[0], exactEntry[0], 'the Bash entry first, unchanged');
  assert.equal(entry.hooks.PermissionRequest[0].hooks[0].async, undefined, 'and synchronous');
  const ours = Object.fromEntries(Object.entries(entry.hooks).map(([event, list]) => [event, list.filter(g => !g.hooks.some(h => h.command.includes('/api/ingest/exact-command')))]));
  const commands = Object.values(ours).flatMap(list => list.flatMap(m => m.hooks.map(h => h.command)));
  assert.deepEqual(Object.keys(entry.hooks), ['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionEnd']);
  assert.equal(commands.length, 8);
  for (const c of commands) {
    assert.match(c, /^\/usr\/bin\/jq -c '\{hook_event_name,session_id,notification_type,agent_id,tool_name,duration_ms,at:\(now\*1000\|floor\)\}' \| \/usr\/bin\/curl -q -s -m [13] --noproxy '\*' --unix-socket "\$HOME\/\.local\/state\/jarvis-os\/ingest\.sock" -X POST http:\/\/localhost\/api\/ingest\/needs-you /, c);
    assert.match(c, / >\/dev\/null \|\| true$/, c);
  }
  // Every event the entry hooks is one the server takes, and all but SessionEnd are async
  // (the PermissionRequest one above all: it must never decide a prompt).
  for (const [event, list] of Object.entries(ours)) {
    assert.equal(list.length, 1, event);
    assert.equal(checkNeedsYou({ hook_event_name: event, session_id: SID }).ok, true, event);
    assert.equal(list[0].hooks[0].async === true, event !== 'SessionEnd', event);
  }
  assert.equal(ours.PermissionRequest[0].matcher, undefined, 'every tool');
  // Where macOS's jq is there, the filter itself: the hook's JSON in, a body the
  // check takes out, with `at` in milliseconds now.
  const { existsSync } = await import('node:fs');
  if (!existsSync('/usr/bin/jq')) return;
  const { execFileSync } = await import('node:child_process');
  const filter = commands[0].match(/^\/usr\/bin\/jq -c '([^']+)'/)[1];
  const before = Date.now();
  const out = JSON.parse(execFileSync('/usr/bin/jq', ['-c', filter], { input: JSON.stringify(hook()) }).toString());
  assert.deepEqual(Object.keys(out).sort(), ['agent_id', 'at', 'duration_ms', 'hook_event_name', 'notification_type', 'session_id', 'tool_name']);
  const checked = checkNeedsYou(out);
  assert.equal(checked.ok, true, checked.error);
  assert.ok(checked.value.at >= before - 1000 && checked.value.at <= Date.now() + 1000, 'milliseconds, not seconds');
  assert.deepEqual(Object.keys(checked.value).sort(), ['at', 'event', 'kind', 'sessionId'], 'jq\'s nulls are no fields');
  // A subagent's PostToolUse as Claude Code 2.1.330 sends it (invented values): its
  // thread, tool and run time get through; its input, response and id don't.
  const sent = { session_id: SID, transcript_path: '/private/somewhere/x.jsonl', cwd: '/private/somewhere', permission_mode: 'auto', agent_id: AGENT, agent_type: 'general-purpose', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'secret stuff' }, tool_response: { stdout: 'secret out' }, tool_use_id: 'toolu_invented', duration_ms: 1650 };
  const sub = JSON.parse(execFileSync('/usr/bin/jq', ['-c', filter], { input: JSON.stringify(sent) }).toString());
  assert.ok(!JSON.stringify(sub).includes('secret') && !JSON.stringify(sub).includes('/private'));
  const v = checkNeedsYou(sub).value;
  assert.deepEqual({ ...v, at: 0 }, { event: 'PostToolUse', sessionId: SID, kind: null, at: 0, agent: agentKey(AGENT), tool: 'Bash', ms: 1650 });
});

// ---- the classifier-block hook (approvals, decision 3) ----

test('a PermissionDenied post is read down to the session, the tool name and the reason, opens and clears no wait, and goes to the approvals gate', async () => {
  const denied = (extra = {}) => ({ hook_event_name: 'PermissionDenied', session_id: SID, permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/build' }, tool_use_id: 'toolu_x', reason: '[Irreversible Local Destruction]', at: 1794380000000, ...extra });
  assert.deepEqual(checkNeedsYou(denied()).value, { event: 'PermissionDenied', sessionId: SID, kind: null, at: 1794380000000, tool: 'Bash', reason: '[Irreversible Local Destruction]' });
  assert.equal(checkNeedsYou(denied({ tool_name: 'a b' })).value.tool, null, 'an odd tool name is dropped');
  assert.equal(checkNeedsYou(denied({ reason: 'x'.repeat(1000) })).value.reason.length, 300);
  assert.equal(checkNeedsYou(denied({ reason: 7 })).value.reason, null);
  const d = deps();
  const blocks = [];
  const h = createHandler({ ...d, onBlock: v => { blocks.push(v); return true; } });
  await call(h, 'POST', '/api/ingest/needs-you', hook());
  const res = await call(h, 'POST', '/api/ingest/needs-you', denied());
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true, block: true });
  assert.equal(blocks.length, 1);
  assert.ok(!JSON.stringify(blocks).includes('rm -rf'), 'the tool input never reaches the gate');
  assert.equal(JSON.parse((await call(h, 'GET', '/api/dashboard')).body).needsYou.length, 1, 'the open wait is untouched');
  assert.equal(d.logged.at(-1), 'needs-you: PermissionDenied (Bash), page approvals are Deny only for 15 minutes');
  const none = createHandler(d);
  assert.deepEqual(JSON.parse((await call(none, 'POST', '/api/ingest/needs-you', denied())).body), { ok: true, block: false });
  const remote = await call(h, 'POST', '/api/ingest/needs-you', denied(), { 'x-forwarded-for': '100.64.0.9' });
  assert.equal(remote.statusCode, 403, 'the TCP transition route is loopback only');
});

test('the README\'s PermissionDenied hook entry: async, filtered by jq to five fields, ends in `|| true`, and its body passes the check', async () => {
  const { readFile } = await import('node:fs/promises');
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('### Approvals as buttons'));
  const entry = JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(Object.keys(entry.hooks), ['PermissionDenied']);
  const [h] = entry.hooks.PermissionDenied[0].hooks;
  assert.equal(h.async, true, 'it can never decide anything');
  assert.match(h.command, /^\/usr\/bin\/jq -c '\{hook_event_name,session_id,tool_name,reason,at:\(now\*1000\|floor\)\}' \| \/usr\/bin\/curl -q -s -m 3 --noproxy '\*' --unix-socket "\$HOME\/\.local\/state\/jarvis-os\/ingest\.sock" -X POST http:\/\/localhost\/api\/ingest\/needs-you /);
  assert.match(h.command, / >\/dev\/null \|\| true$/);
  const { existsSync } = await import('node:fs');
  if (!existsSync('/usr/bin/jq')) return;
  const { execFileSync } = await import('node:child_process');
  const filter = h.command.match(/^\/usr\/bin\/jq -c '([^']+)'/)[1];
  const out = JSON.parse(execFileSync('/usr/bin/jq', ['-c', filter], { input: JSON.stringify({ hook_event_name: 'PermissionDenied', session_id: SID, tool_name: 'Bash', tool_input: { command: 'secret stuff' }, reason: '[Data Exfiltration]', transcript_path: '/x' }) }).toString());
  assert.deepEqual(Object.keys(out).sort(), ['at', 'hook_event_name', 'reason', 'session_id', 'tool_name']);
  assert.equal(checkNeedsYou(out).ok, true);
});

test('the TCP handler\'s needs-you route hands each event to onMoved as the ingest socket does (lib/answered-elsewhere.mjs closes the cards)', async () => {
  const d = deps();
  const moved = [];
  const h = createHandler({ ...d, onMoved: v => { moved.push(v); return 0; } });
  const res = await call(h, 'POST', '/api/ingest/needs-you', { hook_event_name: 'Stop', session_id: SID, at: 1794380000000 });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(moved, [{ event: 'Stop', sessionId: SID, kind: null, at: 1794380000000 }]);
});
