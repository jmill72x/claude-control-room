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

async function setup(t) {
  const env = { clock: { t: 1794380000000 }, lines: [], events: [], timers: [] };
  env.dir = await mkdtemp(join(tmpdir(), 'chat-login-'));
  const now = () => env.clock.t;
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  env.devices = createDeviceStore({ path: join(env.dir, 'devices.json'), now });
  await env.devices.load();
  const approvals = createApprovals({ mode: 'on', now, exists: () => false });
  // A sub-router as the chat passes its checks to one (read aloud, stops, heals,
  // restarts): its own paths, the chat's requireDevice.
  const speech = { owns: p => p === '/api/chat/speech' || p.startsWith('/api/chat/speech/'), handle: async (req, res, path, { requireDevice }) => { requireDevice(req); res.writeHead(204); res.end(); }, info: () => null };
  env.routes = createChatRoutes({
    store: env.store, devices: env.devices, socket: { status: () => ({ channelConnected: true, lastHeartbeatAt: null, helloAt: null }) },
    config: { chat: { login: OWNER } }, now, onEvent: e => env.events.push(e), log: l => env.lines.push(l), approvals, speech,
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
