// Page cards that live as long as the channel holds the request (board 94b380fd): the
// window from the channel's hello (`permHoldMs`, less a minute, at most 12 hours; 10
// minutes when it doesn't say), the open and kept count bounds, and the cards that end
// with their channel (bye, a new channel process, a channel silent for 10 minutes).
// Every id and path is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChatStore, permissionWindow, PERMISSION_TTL_MS, PERMISSION_HOLD_MAX_MS, PERMISSION_HOLD_MARGIN_MS,
  OPEN_PERMISSIONS_MAX, PERMISSIONS_KEPT_MAX, CHANNEL_GONE_MS, CARD_REPLAY_MS
} from '../lib/chat-store.mjs';
import { createApprovals } from '../lib/approvals.mjs';
import { createSocketRouter, SESSION_HEADER } from '../lib/chat-socket.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const T0 = 1794380000000;

const storeAt = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hold-'));
  const clock = { t: T0 };
  const store = createChatStore({ dir, now: () => clock.t });
  await store.load();
  const closed = [];
  store.subscribe(e => { if (e.type === 'permission-closed') closed.push([e.request.requestId, e.request.state, e.request.ended]); });
  const open = (requestId, relayedAt = clock.t) => store.openPermission({ requestId, tool: 'Bash', description: 'd', inputPreview: '{"command":"ls"}', relayedAt });
  return { clock, store, closed, open, clean: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
};

test('the window: the channel\'s hold less a minute, at most 12 hours; anything that is no positive whole number is the old 10 minutes', () => {
  assert.equal(PERMISSION_TTL_MS, 10 * MIN);
  assert.equal(PERMISSION_HOLD_MAX_MS, 12 * HOUR);
  assert.equal(PERMISSION_HOLD_MARGIN_MS, MIN);
  for (const none of [undefined, null, 0, -1, 1.5, Number.NaN, Infinity, '43260000', [43260000], { ms: 1 }, true, 2 ** 53]) {
    assert.equal(permissionWindow(none), PERMISSION_TTL_MS, String(none));
  }
  assert.equal(permissionWindow(11 * MIN), 10 * MIN, 'channel 0.4.6\'s 11 minutes, if it said so');
  assert.equal(permissionWindow(12 * HOUR + MIN), 12 * HOUR);
  assert.equal(permissionWindow(12 * HOUR + MIN + 1), 12 * HOUR, 'never past 12 hours');
  assert.equal(permissionWindow(7 * 24 * HOUR), 12 * HOUR);
  assert.equal(permissionWindow(5 * MIN), 4 * MIN, 'a shorter hold is followed, not stretched');
  assert.equal(permissionWindow(30e3), 0, 'a hold under the margin leaves nothing to answer in');
});

test('store: a request keeps the window in force when it opened; it is answerable to the last millisecond and ends `timeout` after', async () => {
  const s = await storeAt();
  try {
    await s.open('abcde');
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).expiresAt, T0 + PERMISSION_TTL_MS, 'no word from the channel: 10 minutes');
    assert.equal(s.store.setPermissionHold(12 * HOUR + MIN), 12 * HOUR);
    await s.open('fghij');
    assert.equal(s.store.publicPermission(s.store.permission('fghij')).expiresAt, T0 + 12 * HOUR);
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).expiresAt, T0 + PERMISSION_TTL_MS, 'an open request keeps its own window');
    s.clock.t += PERMISSION_TTL_MS;
    assert.equal(s.store.permission('abcde').state, 'expired');
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).ended, 'timeout');
    s.clock.t = T0 + 12 * HOUR - 1;
    assert.equal(s.store.permission('fghij').state, 'open', 'still open a millisecond before 12 hours');
    assert.deepEqual(s.store.openPermissions().map(p => p.requestId), ['fghij']);
    s.clock.t += 1;
    assert.equal(s.store.permission('fghij').state, 'expired');
    assert.equal(s.store.permission('fghij').timedOut, true);
    assert.deepEqual(s.closed, [['abcde', 'expired', 'timeout'], ['fghij', 'expired', 'timeout']]);
    // Back to a channel that doesn't say: 10 minutes for the next one.
    assert.equal(s.store.setPermissionHold(undefined), PERMISSION_TTL_MS);
    await s.open('kmnop');
    assert.equal(s.store.publicPermission(s.store.permission('kmnop')).expiresAt, s.clock.t + PERMISSION_TTL_MS);
  } finally { await s.clean(); }
});

test('store: a request 11 hours old can still be allowed or denied here; the verdict is written as before', async () => {
  const s = await storeAt();
  try {
    s.store.setPermissionHold(12 * HOUR + MIN);
    await s.open('abcde');
    await s.open('fghij');
    s.clock.t += 11 * HOUR;
    const a = await s.store.answerPermission('abcde', 'allow', 'phone');
    assert.equal(a.ok, true);
    assert.equal(a.request.state, 'allowed');
    const d = await s.store.answerPermission('fghij', 'deny', 'phone');
    assert.equal(d.request.state, 'denied');
    const verdicts = s.store.list(0).filter(m => m.kind === 'verdict').map(m => [m.meta.requestId, m.meta.behavior, m.meta.answeredAt]);
    assert.deepEqual(verdicts, [['abcde', 'allow', s.clock.t], ['fghij', 'deny', s.clock.t]]);
  } finally { await s.clean(); }
});

test('store: a timed-out card is replayed for 50 minutes after its own window ends, whatever that window was', async () => {
  const s = await storeAt();
  try {
    s.store.setPermissionHold(3 * HOUR + MIN);
    await s.open('abcde');
    s.clock.t += 3 * HOUR - 1;
    assert.deepEqual(s.store.cardPermissions().map(p => [p.requestId, p.state]), [['abcde', 'open']]);
    s.clock.t += 1;
    assert.deepEqual(s.store.cardPermissions().map(p => [p.requestId, p.state]), [['abcde', 'expired']]);
    s.clock.t += CARD_REPLAY_MS - 1;
    assert.equal(s.store.cardPermissions().length, 1);
    s.clock.t += 1;
    assert.deepEqual(s.store.cardPermissions(), []);
  } finally { await s.clean(); }
});

test('store: past OPEN_PERMISSIONS_MAX open requests the oldest open one ends `crowded`; closed, late and repeated ones are not counted', async () => {
  const s = await storeAt();
  try {
    assert.equal(OPEN_PERMISSIONS_MAX, 50);
    s.store.setPermissionHold(12 * HOUR + MIN);
    await s.open('answered');
    await s.store.answerPermission('answered', 'deny', 'phone');
    await s.store.openPermission({ requestId: 'late1', tool: 'Bash', description: 'd', inputPreview: '{}', relayedAt: T0 - 3 * MIN });
    for (let i = 0; i < OPEN_PERMISSIONS_MAX; i++) await s.open(`r${i}`);
    await s.open('r0'); // a repeated id: `repeat`, never open
    assert.equal(s.store.permission('r0').state, 'repeat');
    assert.equal(s.store.openPermissions().length, OPEN_PERMISSIONS_MAX);
    assert.deepEqual(s.closed, [['answered', 'denied', undefined]], 'nothing crowded out yet');
    await s.open('one-more');
    assert.equal(s.store.openPermissions().length, OPEN_PERMISSIONS_MAX);
    assert.deepEqual(s.closed.slice(1), [['r0', 'expired', 'crowded']], 'the oldest open one, not the closed, late or repeated');
    assert.equal(s.store.openPermissions().at(-1).requestId, 'one-more');
    const crowded = s.store.publicPermission(s.store.openPermissions()[0]);
    assert.equal(crowded.requestId, 'r1');
    assert.equal((await s.store.answerPermission('r1', 'deny', 'phone')).ok, true, 'the next oldest is still answerable');
    assert.equal(s.store.cardPermissions().some(p => p.state === 'expired'), false, 'a crowded-out card is not replayed');
  } finally { await s.clean(); }
});

test('store: at most PERMISSIONS_KEPT_MAX requests are kept; the oldest closed ones go first and the open ones stay', async () => {
  const s = await storeAt();
  try {
    assert.equal(PERMISSIONS_KEPT_MAX, 500);
    s.store.setPermissionHold(12 * HOUR + MIN);
    const n = PERMISSIONS_KEPT_MAX + OPEN_PERMISSIONS_MAX + 30;
    for (let i = 0; i < n; i++) await s.open(`r${i}`);
    assert.equal(s.store.openPermissions().length, OPEN_PERMISSIONS_MAX);
    assert.equal(s.store.permission('r0'), null, 'the oldest is gone');
    const kept = [];
    for (let i = 0; i < n; i++) if (s.store.permission(`r${i}`)) kept.push(i);
    assert.equal(kept.length, PERMISSIONS_KEPT_MAX);
    assert.equal(kept[0], n - PERMISSIONS_KEPT_MAX, 'the newest are kept');
    for (let i = n - OPEN_PERMISSIONS_MAX; i < n; i++) assert.equal(s.store.permission(`r${i}`).state, 'open');
  } finally { await s.clean(); }
});

test('store: an open request older than every closed one is kept when the bound drops the old ones', async () => {
  const s = await storeAt();
  try {
    s.store.setPermissionHold(12 * HOUR + MIN);
    await s.open('keeper');
    for (let i = 0; i < PERMISSIONS_KEPT_MAX + 10; i++) {
      await s.open(`r${i}`);
      await s.store.answerPermission(`r${i}`, 'deny', 'phone');
    }
    assert.equal(s.store.permission('keeper')?.state, 'open');
    assert.equal(s.store.permission('r0'), null);
    assert.equal(s.store.permission(`r${PERMISSIONS_KEPT_MAX + 9}`).state, 'denied');
  } finally { await s.clean(); }
});

test('store: a channel silent for CHANNEL_GONE_MS ends the open requests `channel`; they are neither replayed nor closed elsewhere; a store never told of a channel has no such rule', async () => {
  const s = await storeAt();
  try {
    assert.equal(CHANNEL_GONE_MS, 10 * MIN);
    s.store.setPermissionHold(12 * HOUR + MIN);
    await s.open('nochan');
    s.clock.t += 2 * HOUR;
    assert.equal(s.store.permission('nochan').state, 'open', 'no channel was ever noted: nothing is gone');
    s.store.noteChannelAlive(s.clock.t);
    await s.open('abcde');
    s.clock.t += CHANNEL_GONE_MS - 1;
    assert.equal(s.store.permission('abcde').state, 'open');
    s.store.noteChannelAlive(s.clock.t);
    s.clock.t += CHANNEL_GONE_MS - 1;
    assert.equal(s.store.permission('abcde').state, 'open', 'a beat restarts the count');
    s.clock.t += 1;
    assert.equal(s.store.permission('abcde').state, 'expired');
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).ended, 'channel');
    assert.equal(s.store.permission('nochan').state, 'expired', 'every open request goes with its channel');
    assert.equal(s.store.permission('abcde').timedOut, undefined);
    assert.deepEqual(s.store.cardPermissions(), []);
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: s.clock.t + 1 }), []);
    assert.equal((await s.store.answerPermission('abcde', 'allow', 'phone')).status, 409);
  } finally { await s.clean(); }
});

test('store: a new channel session ends the open requests `channel`; an id from the old session is a fresh request in the new one', async () => {
  const s = await storeAt();
  try {
    await s.open('abcde');
    s.store.newPermissionSession();
    assert.deepEqual(s.closed, [['abcde', 'expired', 'channel']]);
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).ended, 'channel');
    await s.open('abcde');
    assert.equal(s.store.permission('abcde').state, 'open');
    await s.open('abcde');
    assert.equal(s.store.permission('abcde').state, 'repeat', 'seen twice in one session');
    assert.equal('ended' in s.store.publicPermission(s.store.permission('abcde')), false, 'only an expired request says how it ended');
  } finally { await s.clean(); }
});

// ---- the channel's socket ----

const call = ({ socketPath, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({ socketPath, method, path, headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

async function socketAt(hello = {}) {
  const env = { clock: { t: T0 }, logs: [] };
  env.dir = await mkdtemp(join(tmpdir(), 'hold-'));
  const now = () => env.clock.t;
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  env.approvals = createApprovals({ mode: 'on', killPath: '/k/approvals-off', exists: () => false, now, onEvent: () => {}, home: '/home/owner', realpath: () => null, isLead: () => true, isLink: () => false, isExecutable: () => false });
  env.socket = createSocketRouter({ store: env.store, now, onEvent: () => {}, log: l => env.logs.push(l), pingMs: 60, approvals: env.approvals, verifyRestart: async () => ({ ok: true }) });
  env.sockPath = join(env.dir, 'c.sock');
  env.server = createServer((q, r) => env.socket.handler(q, r));
  await new Promise(r => env.server.listen(env.sockPath, r));
  env.hello = async (body, token = null) => {
    const h = await call({ socketPath: env.sockPath, method: 'POST', path: '/v1/hello', body: { relay: 'allow', ...body }, headers: token ? { [SESSION_HEADER]: token } : {} });
    env.token = h.json?.token ?? env.token;
    return h;
  };
  env.unix = o => call({ socketPath: env.sockPath, ...o, headers: { [SESSION_HEADER]: env.token, ...(o.headers ?? {}) } });
  env.open = id => env.unix({ method: 'POST', path: '/v1/permission-request', body: { requestId: id, tool: 'Read', description: 'd', inputPreview: '{"file_path":"/home/owner/Projects/app/a"}', relayedAt: env.clock.t } });
  env.expiresAt = id => env.store.publicPermission(env.store.permission(id)).expiresAt;
  env.close = async () => { env.server.closeAllConnections?.(); await new Promise(r => env.server.close(r)); await rm(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  await env.hello({ pid: 1, ...hello });
  return env;
}

test('socket: a hello\'s permHoldMs sets the page\'s window, logged; a hello without it is the old 10 minutes', async () => {
  const env = await socketAt({ permHoldMs: 12 * HOUR + MIN });
  try {
    assert.ok(env.logs.includes('chat: the page can answer a permission request for 720 min (the channel holds one that long, less a minute)'), env.logs.join('\n'));
    assert.equal((await env.open('abcde')).status, 200);
    assert.equal(env.expiresAt('abcde'), T0 + 12 * HOUR);
    // The holder's own re-hello without the field: later requests get 10 minutes, the open one keeps its own.
    await env.hello({ pid: 1 }, env.token);
    assert.ok(env.logs.includes('chat: the page can answer a permission request for 10 min (the channel does not say how long it holds one)'));
    assert.equal(env.store.permission('abcde').state, 'open');
    assert.equal((await env.open('fghij')).status, 200);
    assert.equal(env.expiresAt('fghij'), T0 + PERMISSION_TTL_MS);
    assert.equal(env.expiresAt('abcde'), T0 + 12 * HOUR);
  } finally { await env.close(); }
});

test('socket: heartbeats and the channel\'s own requests keep its cards alive for hours; the bye ends them `channel`', async () => {
  const env = await socketAt({ permHoldMs: 12 * HOUR + MIN });
  try {
    assert.equal((await env.open('abcde')).status, 200);
    for (let i = 0; i < 30; i++) {
      env.clock.t += 9 * MIN;
      assert.equal((await env.unix({ method: 'POST', path: '/v1/heartbeat', body: {} })).status, 200);
    }
    assert.equal(env.store.permission('abcde').state, 'open', '4.5 hours of heartbeats: still open');
    env.clock.t += 9 * MIN;
    assert.equal((await env.open('fghij')).status, 200, 'a request from the channel counts as a beat');
    env.clock.t += 9 * MIN;
    assert.equal(env.store.permission('abcde').state, 'open');
    assert.equal((await env.unix({ method: 'POST', path: '/v1/bye', body: {} })).status, 200);
    for (const id of ['abcde', 'fghij']) {
      assert.equal(env.store.permission(id).state, 'expired', id);
      assert.equal(env.store.publicPermission(env.store.permission(id)).ended, 'channel');
    }
  } finally { await env.close(); }
});

test('socket: the holder\'s own re-hello is a sign of life too', async () => {
  const env = await socketAt({ permHoldMs: 12 * HOUR + MIN });
  try {
    assert.equal((await env.open('abcde')).status, 200);
    env.clock.t += 9 * MIN;
    assert.equal((await env.hello({ pid: 1, permHoldMs: 12 * HOUR + MIN }, env.token)).status, 200);
    env.clock.t += 9 * MIN;
    assert.equal(env.store.permission('abcde').state, 'open');
  } finally { await env.close(); }
});

test('socket: a channel that stops beating without a bye takes its cards with it after 10 minutes', async () => {
  const env = await socketAt({ permHoldMs: 12 * HOUR + MIN });
  try {
    assert.equal((await env.open('abcde')).status, 200);
    env.clock.t += CHANNEL_GONE_MS - 1;
    assert.equal(env.store.permission('abcde').state, 'open');
    env.clock.t += 1;
    assert.equal(env.store.permission('abcde').state, 'expired');
    assert.equal(env.store.publicPermission(env.store.permission('abcde')).ended, 'channel');
  } finally { await env.close(); }
});
