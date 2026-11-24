// The chat's login 403s, counted (board 261d8525, Ultron's 11-23 L1 on eae9efd): since
// the verdict route checks the login before its anonymous count, a caller that is not
// the owner left no trace at all. Now each chat route's login refusals are logged like
// the ingest's (lib/refusal-counts.mjs): the first at once, the rest counted, at most
// one line an hour per route, in fixed words. Never a push or an event, and never a
// value: no path as it came, no login, cookie, address or body. Every login here is an
// example.com one; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../lib/chat-store.mjs';
import { createDeviceStore, COOKIE_NAME, PAIR_COOKIE_NAME } from '../lib/chat-devices.mjs';
import { createApprovals } from '../lib/approvals.mjs';
import { createChatRoutes, chatRouteName, loginRefusalFirstLine, LOGIN_REFUSAL_REASON, LOGIN_REFUSAL_WORDS } from '../lib/chat-routes.mjs';
import { REFUSAL_LOG_EVERY_MS as HOUR, REFUSAL_MAX_KEYS } from '../lib/refusal-counts.mjs';
import { createAgentStop } from '../lib/agent-stop.mjs';
import { createRecover } from '../lib/jarvis-recover.mjs';
import { createHealTaps } from '../lib/heal-routes.mjs';

const OWNER = 'owner@example.com';
const STRANGER = 'someone-else@example.com';
// Words that must never reach a line: an id in a path, a body's text, a cookie's value.
const MARK = 'zq7canary';

const call = ({ port, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

// `mode`: the approvals' mode. `gates`: the stop, restart and heal routes too, each the
// real router with stubs behind it (their refusals come before any of those is used).
async function setup(t, { mode = 'on', gates = false } = {}) {
  const env = { clock: { t: 1794380000000 }, lines: [], events: [], timers: [] };
  env.dir = await mkdtemp(join(tmpdir(), 'chat-login-'));
  const now = () => env.clock.t;
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  env.devices = createDeviceStore({ path: join(env.dir, 'devices.json'), now });
  await env.devices.load();
  const approvals = createApprovals({ mode, now, exists: () => false });
  const stepUp = { pendingFor: () => null, has: () => false };
  const extra = gates ? {
    agentStop: createAgentStop({ stepUp, liveRuns: () => [], socket: { stopsOk: () => true }, store: env.store, now, onEvent: e => env.events.push(e), log: l => env.lines.push(l) }),
    recover: createRecover({ home: env.dir, dir: join(env.dir, 'chat'), stepUp, enabled: true, now, onEvent: e => env.events.push(e), log: l => env.lines.push(l), spawn: () => { throw new Error('no run in this test'); } }),
    healTaps: createHealTaps({ loops: null, now, onEvent: e => env.events.push(e), log: l => env.lines.push(l) })
  } : {};
  // A sub-router as the chat passes its checks to one (read aloud, stops, heals,
  // restarts): its own paths, the chat's requireDevice.
  const speech = { owns: p => p === '/api/chat/speech' || p.startsWith('/api/chat/speech/'), handle: async (req, res, path, { requireDevice }) => { requireDevice(req); res.writeHead(204); res.end(); }, info: () => null };
  env.routes = createChatRoutes({
    store: env.store, devices: env.devices, socket: { status: () => ({ channelConnected: true, lastHeartbeatAt: null, helloAt: null }) },
    config: { chat: { login: OWNER } }, now, onEvent: e => env.events.push(e), log: l => env.lines.push(l), approvals, speech, ...extra,
    setTimer: (fn, ms) => { env.timers.push({ at: env.clock.t + ms, fn }); }
  });
  // The hour moves on: every timer due by then runs.
  env.advance = ms => {
    env.clock.t += ms;
    const due = env.timers.filter(x => x.at <= env.clock.t);
    env.timers = env.timers.filter(x => x.at > env.clock.t);
    for (const x of due) x.fn();
  };
  env.srv = createServer((q, s) => env.routes.handler(q, s));
  await new Promise(r => env.srv.listen(0, '127.0.0.1', r));
  env.port = env.srv.address().port;
  t.after(async () => {
    extra.recover?.stop();
    await new Promise(r => { env.srv.close(r); env.srv.closeAllConnections(); });
    await rm(env.dir, { recursive: true, force: true });
  });
  env.call = o => call({ port: env.port, ...o });
  const s = await env.devices.start('phone');
  await env.devices.approve(s.code, { by: 'test' });
  env.cookie = `${COOKIE_NAME}=${(await env.devices.status(`${PAIR_COOKIE_NAME}=${s.pairToken}`)).token}`;
  return env;
}

test('chatRouteName: a route\'s fixed name, an id as a placeholder, anything else in fixed words', () => {
  assert.equal(chatRouteName('POST', '/api/pair/start'), 'POST /api/pair/start');
  assert.equal(chatRouteName('GET', '/api/chat/messages'), 'GET /api/chat/messages');
  assert.equal(chatRouteName('POST', `/api/chat/permission/${MARK}`), 'POST /api/chat/permission/:id');
  assert.equal(chatRouteName('DELETE', `/api/devices/${MARK}`), 'DELETE /api/devices/:id');
  assert.equal(chatRouteName('GET', `/api/chat/attachments/${MARK}`), 'GET /api/chat/attachments/:id');
  assert.equal(chatRouteName('POST', `/api/chat/speech/${MARK}`), 'POST /api/chat/speech/:id');
  assert.equal(chatRouteName('POST', `/api/agents/${MARK}/stop/challenge`), 'POST /api/agents/:run/stop/challenge');
  assert.equal(chatRouteName('POST', `/api/loops/${MARK}/decline`), 'POST /api/loops/:card/decline');
  assert.equal(chatRouteName('POST', '/api/recover'), 'POST /api/recover');
  // A path that is no route, one with more segments than a shape, an odd method.
  assert.equal(chatRouteName('POST', `/api/chat/${MARK}`), 'POST another chat route');
  assert.equal(chatRouteName('POST', `/api/chat/permission/a/${MARK}`), 'POST another chat route');
  assert.equal(chatRouteName(`BREW ${MARK}`, '/api/chat/status'), 'OTHER /api/chat/status');
  // The words.
  assert.equal(loginRefusalFirstLine('GET /api/chat/status'), 'chat: refused a request to GET /api/chat/status that did not come as the owner through the tailnet (the login check; later ones are counted, one line an hour)');
  assert.equal(LOGIN_REFUSAL_WORDS.count('GET /api/chat/status', LOGIN_REFUSAL_REASON, 1, 2), 'chat: refused 1 more request to GET /api/chat/status that did not come as the owner through the tailnet since the last such line (2 since the start)');
  assert.equal(LOGIN_REFUSAL_WORDS.other(3, 3, true, 20), 'chat: refused 3 requests to other routes that did not come as the owner through the tailnet past the first (3 since the start; the log names 20 routes at most)');
});

test('a login 403 on any chat route is logged once at once, then counted, one line an hour per route; never a push, an event or a value', async t => {
  const env = await setup(t);
  const stranger = { 'tailscale-user-login': STRANGER, cookie: `${env.cookie}; x=${MARK}`, 'x-forwarded-for': '100.64.0.99' };
  const verdict = () => env.call({ method: 'POST', path: `/api/chat/permission/${MARK}`, headers: stranger, body: { behavior: 'deny', shown: MARK } });
  // Five verdict probes from another login: each the login's 403, one line.
  for (let i = 0; i < 5; i++) {
    const r = await verdict();
    assert.equal(r.status, 403);
    assert.match(r.text, /did not come as the owner/);
  }
  assert.deepEqual(env.lines, [loginRefusalFirstLine('POST /api/chat/permission/:id')]);
  assert.equal(env.timers.length, 1, 'one timer for the hour, however many');
  // Another route is its own: no login header at all, a page's read; and a sub-router's
  // route, its path made up.
  assert.equal((await env.call({ path: '/api/chat/messages' })).status, 403);
  assert.equal((await env.call({ method: 'POST', path: `/api/chat/speech/${MARK}`, headers: { 'tailscale-user-login': '' } })).status, 403);
  assert.equal((await env.call({ method: 'POST', path: '/api/pair/start', headers: stranger, body: { name: MARK } })).status, 403);
  assert.deepEqual(env.lines.slice(1), [
    loginRefusalFirstLine('GET /api/chat/messages'),
    loginRefusalFirstLine('POST /api/chat/speech/:id'),
    loginRefusalFirstLine('POST /api/pair/start')
  ]);
  // The owner's own refusals are not the login's: no line here (a device not paired is
  // a 401, a verdict on no request is the device's own refusal, logged as before).
  const before = env.lines.length;
  assert.equal((await env.call({ path: '/api/chat/messages', headers: { 'tailscale-user-login': OWNER } })).status, 401);
  assert.equal((await env.call({ path: '/api/chat/messages', headers: { 'tailscale-user-login': ` ${OWNER.toUpperCase()} `, cookie: env.cookie } })).status, 200);
  assert.equal(env.lines.length, before);
  // The hour's end: the four held verdict probes in one line with the count; the routes
  // refused once have nothing held and write nothing.
  env.advance(HOUR);
  assert.deepEqual(env.lines.slice(before), [LOGIN_REFUSAL_WORDS.count('POST /api/chat/permission/:id', LOGIN_REFUSAL_REASON, 4, 5)]);
  // A quiet hour writes nothing; the next one after it is written at once, with its count.
  env.advance(HOUR);
  assert.equal(env.lines.length, before + 1);
  assert.equal((await verdict()).status, 403);
  assert.deepEqual(env.lines.slice(before + 1), [LOGIN_REFUSAL_WORDS.count('POST /api/chat/permission/:id', LOGIN_REFUSAL_REASON, 1, 6)]);
  // Never a push or an event, and no line carries a value from the requests.
  assert.deepEqual(env.events, []);
  for (const l of env.lines) {
    for (const v of [MARK, STRANGER, 'someone', '100.64', COOKIE_NAME, 'example.com']) assert.ok(!l.includes(v), `${v} in: ${l}`);
  }
});

test('the login lines are bounded: past the route cap, refusals are counted together in one "other" line', async t => {
  const env = await setup(t);
  // Chat routes and a sub-router's, each refused once by the login: past the cap.
  const asks = [
    ['GET', '/api/chat/messages'], ['POST', '/api/chat/messages', {}], ['POST', '/api/chat/attachments'], ['GET', `/api/chat/attachments/${'a'.repeat(32)}`],
    ['GET', '/api/chat/search'], ['GET', '/api/push/key'], ['POST', '/api/push/subscription', {}], ['DELETE', '/api/push/subscription'],
    ['GET', '/api/chat/status'], ['POST', `/api/chat/permission/${MARK}`, {}], ['GET', '/api/devices'], ['DELETE', `/api/devices/${'b'.repeat(16)}`],
    ['POST', '/api/pair/start', {}], ['POST', '/api/pair/approve', {}], ['GET', '/api/pair/status']
  ];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) for (const path of ['/api/chat/speech', `/api/chat/speech/${MARK}`]) asks.push([method, path]);
  let sent = 0;
  for (const [method, path, body] of asks) {
    const r = await env.call({ method, path, body, headers: { 'tailscale-user-login': STRANGER } });
    assert.equal(r.status, 403, `${method} ${path}: ${r.text}`);
    sent++;
  }
  const named = env.lines.filter(l => l.startsWith('chat: refused a request to '));
  assert.ok(sent > REFUSAL_MAX_KEYS);
  assert.equal(named.length, REFUSAL_MAX_KEYS, 'one first line per route up to the cap');
  const other = env.lines.filter(l => l.includes('to other routes'));
  assert.deepEqual(other, [LOGIN_REFUSAL_WORDS.other(1, 1, true, REFUSAL_MAX_KEYS)], 'the first past the cap is written at once, the rest held');
  env.advance(HOUR);
  assert.equal(env.lines.at(-1), LOGIN_REFUSAL_WORDS.other(sent - REFUSAL_MAX_KEYS - 1, sent - REFUSAL_MAX_KEYS, false, REFUSAL_MAX_KEYS));
  assert.ok(env.lines.every(l => !l.includes(MARK)));
});

// Ultron's 11-23 N1 on b534aa2: the write guard's 415 and cross-origin 403, the
// approvals-off 403 and the Shortcut key's 403 came before the login on the verdict,
// stop, restart and heal routes (and the write guard on every chat write), so a probe
// from anyone but the owner there was answered by them and counted nowhere. Now the
// login comes first: such a probe gets the login's 403 and its line.
const RUN = 'c'.repeat(16);
const CARD = 'd'.repeat(32);
const ELSEWHERE = 'https://elsewhere.example.com';
// Each a request that breaks one rule that used to come before the login.
const BREAKS = [
  ['POST', `/api/chat/permission/${MARK}`, { 'Content-Type': 'text/plain' }, 'POST /api/chat/permission/:id'],
  ['POST', '/api/pair/start', { 'Content-Type': 'text/plain' }, 'POST /api/pair/start'],
  ['POST', '/api/pair/approve', { origin: ELSEWHERE }, 'POST /api/pair/approve'],
  ['POST', '/api/chat/messages', { 'Content-Type': 'text/plain' }, 'POST /api/chat/messages'],
  ['POST', '/api/chat/attachments', { origin: ELSEWHERE }, 'POST /api/chat/attachments'],
  ['DELETE', `/api/devices/${'b'.repeat(16)}`, { origin: ELSEWHERE }, 'DELETE /api/devices/:id'],
  ['POST', '/api/push/subscription', { 'Content-Type': 'text/plain' }, 'POST /api/push/subscription'],
  ['DELETE', '/api/push/subscription', { origin: ELSEWHERE }, 'DELETE /api/push/subscription'],
  ['POST', `/api/agents/${RUN}/stop`, { authorization: `Bearer ${MARK}` }, 'POST /api/agents/:run/stop'],
  ['POST', `/api/agents/${RUN}/stop/challenge`, { 'Content-Type': 'text/plain' }, 'POST /api/agents/:run/stop/challenge'],
  ['GET', '/api/stepup/status', { authorization: `Bearer ${MARK}` }, 'GET /api/stepup/status'],
  ['POST', '/api/stepup/register/options', { 'Content-Type': 'text/plain' }, 'POST /api/stepup/register/options'],
  ['GET', '/api/recover/status', { authorization: `Bearer ${MARK}` }, 'GET /api/recover/status'],
  ['POST', '/api/recover/challenge', { 'Content-Type': 'text/plain' }, 'POST /api/recover/challenge'],
  ['POST', '/api/recover', { authorization: `Bearer ${MARK}` }, 'POST /api/recover'],
  ['POST', `/api/loops/${CARD}/approve`, { 'Content-Type': 'text/plain' }, 'POST /api/loops/:card/approve'],
  ['POST', `/api/loops/${CARD}/decline`, { authorization: `Bearer ${MARK}` }, 'POST /api/loops/:card/decline']
];

test('N1: a caller that is not the owner meets the login before any write rule or key check, on every chat write and the stop, restart and heal routes; counted, never an event', async t => {
  const env = await setup(t, { gates: true });
  for (const login of [STRANGER, undefined]) {
    for (const [method, path, breaks] of BREAKS) {
      const headers = { ...(login ? { 'tailscale-user-login': login } : {}), cookie: env.cookie, ...breaks };
      const r = await env.call({ method, path, headers, body: method === 'GET' ? undefined : { x: MARK } });
      assert.equal(r.status, 403, `${login} ${method} ${path}: ${r.text}`);
      assert.match(r.text, /did not come as the owner/, `${login} ${method} ${path}`);
    }
  }
  // One first line per route, in the order sent; the second round only counted.
  assert.deepEqual(env.lines, BREAKS.map(([, , , route]) => loginRefusalFirstLine(route)));
  // Neither the restart's nor a heal's key refusal is alerted for anyone but the owner.
  assert.deepEqual(env.events, []);
  env.advance(HOUR);
  assert.deepEqual(env.lines.slice(BREAKS.length), BREAKS.map(([, , , route]) => LOGIN_REFUSAL_WORDS.count(route, LOGIN_REFUSAL_REASON, 1, 2)));
  assert.ok(env.lines.every(l => !l.includes(MARK) && !l.includes('example.com')));
});

test('N1: the owner\'s own requests meet the same rules as before: the 415, the cross-origin 403, the key\'s 403 and its alerts; no login line', async t => {
  const env = await setup(t, { gates: true });
  const owner = { 'tailscale-user-login': OWNER, cookie: env.cookie };
  const expect = [
    ['POST', `/api/chat/permission/${MARK}`, { 'Content-Type': 'text/plain' }, 415, /Content-Type must be application\/json/],
    ['POST', `/api/chat/permission/${MARK}`, { origin: ELSEWHERE }, 403, /cross-origin write refused/],
    ['POST', '/api/pair/start', { 'Content-Type': 'text/plain', cookie: '' }, 415, /Content-Type/],
    ['POST', '/api/chat/messages', { 'Content-Type': 'text/plain' }, 415, /Content-Type/],
    ['POST', '/api/chat/attachments', { origin: ELSEWHERE }, 403, /cross-origin write refused/],
    ['DELETE', `/api/devices/${'b'.repeat(16)}`, { origin: ELSEWHERE }, 403, /cross-origin write refused/],
    ['POST', `/api/agents/${RUN}/stop`, { authorization: `Bearer ${MARK}` }, 403, /a Shortcut key can never stop/],
    ['POST', `/api/agents/${RUN}/stop/challenge`, { 'Content-Type': 'text/plain' }, 415, /Content-Type/],
    ['GET', '/api/stepup/status', { authorization: `Bearer ${MARK}` }, 403, /a Shortcut key can never stop/],
    ['GET', '/api/recover/status', { authorization: `Bearer ${MARK}` }, 403, /a Shortcut key can never restart Jarvis/],
    ['POST', '/api/recover/challenge', { 'Content-Type': 'text/plain' }, 415, /Content-Type/],
    ['POST', '/api/recover', { authorization: `Bearer ${MARK}` }, 403, /a Shortcut key can never restart Jarvis/],
    ['POST', `/api/loops/${CARD}/approve`, { 'Content-Type': 'text/plain' }, 415, /Content-Type/],
    ['POST', `/api/loops/${CARD}/decline`, { authorization: `Bearer ${MARK}` }, 403, /a Shortcut key can never answer a heal/]
  ];
  for (const [method, path, breaks, status, words] of expect) {
    const r = await env.call({ method, path, headers: { ...owner, ...breaks }, body: method === 'GET' ? undefined : { x: MARK } });
    assert.equal(r.status, status, `${method} ${path}: ${r.text}`);
    assert.match(r.text, words, `${method} ${path}`);
  }
  // The key's refusals on the restart's POST and a heal are alerted, as before (the
  // status read never is); nothing else.
  assert.deepEqual(env.events.map(e => `${e.kind}:${e.why}`), ['recover-refused:key', 'heal-tap-refused:key']);
  assert.ok(!env.lines.some(l => l.includes(LOGIN_REFUSAL_REASON)), env.lines.join('\n'));
});

test('N1: with approvals off, the owner still hears so, and anyone else gets the login\'s 403, counted', async t => {
  const env = await setup(t, { mode: 'off' });
  const verdict = headers => env.call({ method: 'POST', path: `/api/chat/permission/${MARK}`, headers, body: { behavior: 'deny', shown: MARK } });
  const mine = await verdict({ 'tailscale-user-login': OWNER, cookie: env.cookie });
  assert.equal(mine.status, 403);
  assert.match(mine.text, /approvals are off on this server/);
  assert.deepEqual(env.lines, []);
  for (const headers of [{ 'tailscale-user-login': STRANGER, cookie: env.cookie }, {}]) {
    const r = await verdict(headers);
    assert.equal(r.status, 403);
    assert.match(r.text, /did not come as the owner/);
  }
  assert.deepEqual(env.lines, [loginRefusalFirstLine('POST /api/chat/permission/:id')]);
  env.advance(HOUR);
  assert.equal(env.lines.at(-1), LOGIN_REFUSAL_WORDS.count('POST /api/chat/permission/:id', LOGIN_REFUSAL_REASON, 1, 2));
  assert.deepEqual(env.events, []);
});

test('N1: the stop and restart routes refuse to run without the login check, as the heal routes do', async () => {
  const stepUp = { pendingFor: () => null, has: () => false };
  const stop = createAgentStop({ stepUp, liveRuns: () => [], socket: { stopsOk: () => true }, store: null, log: () => {} });
  const ctx = { requireDevice: () => ({ id: 'x', name: 'x', approver: true }), notifyHosts: new Set() };
  await assert.rejects(stop.handle({ method: 'POST', headers: { 'content-type': 'application/json' } }, {}, `/api/agents/${RUN}/stop`, ctx), /the stop routes need the login check/);
  await assert.rejects(stop.handle({ method: 'GET', headers: {} }, {}, '/api/stepup/status', ctx), /the stop routes need the login check/);
  const dir = await mkdtemp(join(tmpdir(), 'chat-login-gate-'));
  const rec = createRecover({ home: dir, dir: join(dir, 'chat'), stepUp, enabled: true, log: () => {} });
  try {
    await assert.rejects(rec.handle({ method: 'GET', headers: {} }, {}, '/api/recover/status', ctx), /the restart routes need the login check/);
    await assert.rejects(rec.handle({ method: 'POST', headers: { 'content-type': 'application/json' } }, {}, '/api/recover', ctx), /the restart routes need the login check/);
  } finally { rec.stop(); await rm(dir, { recursive: true, force: true }); }
});
