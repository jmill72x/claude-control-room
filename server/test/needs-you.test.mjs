// "Jarvis is waiting on you" (lib/needs-you.mjs): the hook's JSON read down to three
// fields, the in-memory waits, what the page gets, the alert and the push. Every
// session id, agent and job here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNeedsYou, recordNeedsYou, activeWaits, needsYouView, needsYouAlerts, waitKey, createNeedsYouStore, needsYouLogLine,
  NEEDS_YOU_MAX, NEEDS_YOU_TTL_MS, NEEDS_YOU_ALERT_MS
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
  assert.deepEqual(checkNeedsYou(hook()), { ok: true, value: { event: 'Notification', sessionId: SID, kind: 'permission' } });
  assert.equal(checkNeedsYou(hook({ notification_type: 'idle_prompt' })).value.kind, 'idle');
  assert.equal(checkNeedsYou(hook({ notification_type: 'elicitation_dialog' })).value.kind, 'question');
  assert.equal(checkNeedsYou(hook({ notification_type: 'auth_success' })).value.kind, null, 'a notification nobody must answer opens nothing');
  assert.equal(checkNeedsYou(hook({ notification_type: undefined })).value.kind, null);
  assert.equal(checkNeedsYou(hook({ hook_event_name: 'PermissionRequest', notification_type: undefined, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })).value.kind, 'permission');
  for (const event of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.deepEqual(checkNeedsYou(hook({ hook_event_name: event })).value, { event, sessionId: SID, kind: null }, event);
  }
  const value = checkNeedsYou(hook()).value;
  assert.deepEqual(Object.keys(value).sort(), ['event', 'kind', 'sessionId'], 'no message, path, cwd or tool input survives the check');
  // The README's hook entry sends exactly these three fields, with notification_type
  // null for an event that has none (jq's `{a,b,c}` on a body without `c`).
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'SessionEnd', session_id: SID, notification_type: null }).value, { event: 'SessionEnd', sessionId: SID, kind: null });
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: 'idle_prompt' }).value, { event: 'Notification', sessionId: SID, kind: 'idle' });
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Stop', session_id: SID, notification_type: null }).value, { event: 'Stop', sessionId: SID, kind: null });
  assert.deepEqual(checkNeedsYou({ hook_event_name: 'Notification', session_id: SID, notification_type: null }).value, { event: 'Notification', sessionId: SID, kind: null }, 'a Notification with no type is accepted and opens nothing');
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
  assert.equal(store.record(checkNeedsYou(hook()).value, NOW), 1);
  assert.equal(store.record(checkNeedsYou(hook({ session_id: 'other', notification_type: 'idle_prompt' })).value, NOW + MIN), 2);
  assert.deepEqual(store.view(NOW + MIN).map(w => [w.who, w.kind]), [['Atlas', 'permission'], [null, 'idle']]);
  assert.equal(store.record(checkNeedsYou(hook({ hook_event_name: 'Stop' })).value, NOW + 2 * MIN), 1);
  assert.equal(store.size(NOW + 2 * MIN), 1);
  assert.equal(store.size(NOW + 2 * MIN + NEEDS_YOU_TTL_MS), 0);
  assert.equal(createNeedsYouStore().record(checkNeedsYou(hook()).value, NOW), 1, 'with no lookup, who is nobody');
  assert.equal(needsYouLogLine({ event: 'Notification', kind: 'permission' }, 2), 'needs-you: Notification (permission), 2 open');
  assert.equal(needsYouLogLine({ event: 'Stop', kind: null }, 0), 'needs-you: Stop, 0 open');
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
