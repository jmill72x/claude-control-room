// Web Push for the chat (lib/chat-push.mjs and the /api/push routes): which events
// push, to which devices, the 10 s rule, what is said, deleting a gone
// subscription, alerting on a 403, and the routes. A fake fetch records each push
// and the test decrypts it as the device would. Last, one end to end over a real
// loopback "push service". Every name and message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { makeChatEnv, openStream } from './helpers/chat-env.mjs';
import { createPushService, readPushConfig, payloadFor, BODIES, CHAT_QUIET_MS, CHAT_REPEAT_MS, OFFLINE_AFTER_MS, APPROVAL_REPEAT_MS, SEND_CONCURRENCY, SEND_QUEUE_MAX } from '../lib/chat-push.mjs';
import { notificationOrigin } from '../lib/chat-routes.mjs';
import { vapidKeys, newVapidKeys, decrypt, verifyVapidJwt, b64u } from '../lib/webpush.mjs';

const SEC = 1e3, MIN = 60e3;
const ORIGIN = 'https://mini.example.ts.net';

const receiver = (endpoint = `https://web.push.apple.com/${randomBytes(6).toString('hex')}`) => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  const auth = b64u(randomBytes(16));
  return { priv: e.getPrivateKey(), auth, sub: { endpoint, expirationTime: null, keys: { p256dh: b64u(e.getPublicKey()), auth } } };
};

// A chat env with a push service whose fetch the test controls, and manual timers.
async function pushEnv({ status = () => 201, vapid = true, fetchImpl = null, testHosts = null, config = {}, sendConcurrency, sendQueueMax } = {}) {
  const holder = { svc: null };
  const lazy = { on: () => holder.svc?.on() ?? false, publicKey: () => holder.svc?.publicKey() ?? null, testHosts };
  const env = await makeChatEnv({ routes: { push: lazy, config } });
  const sent = [];
  const timers = [];
  const logs = [];
  const events = [];
  const keys = vapid ? { ...vapidKeys(newVapidKeys().privateKey), subject: 'mailto:owner@example.com' } : null;
  holder.svc = createPushService({
    devices: env.devices, store: env.store, socket: env.socket, lastStream: id => env.routes.lastStream(id), vapid: keys,
    now: env.now, log: l => logs.push(l), onEvent: e => events.push(e), testHosts, startedAt: env.clock.t,
    fetchImpl: fetchImpl ?? (async (url, init) => { sent.push({ url, init }); return { status: status(url), arrayBuffer: async () => new ArrayBuffer(0) }; }),
    setTimer: (fn, ms) => { const t = { fn, at: env.clock.t + ms, done: false }; timers.push(t); return t; },
    clearTimer: t => { t.done = true; },
    checkMs: 3600e3, sendConcurrency, sendQueueMax
  });
  const advance = async ms => {
    env.clock.t += ms;
    for (const t of timers) if (!t.done && t.at <= env.clock.t) { t.done = true; t.fn(); }
    await holder.svc.idle();
  };
  const device = async (name, r = receiver()) => {
    const d = await env.pair(name);
    const res = await env.call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: d.cookie, origin: `http://127.0.0.1:${env.port}` }, body: r.sub });
    assert.equal(res.status, 200, res.text);
    return { ...d, r };
  };
  const opened = (d, s) => sent.filter(x => x.url === d.r.sub.endpoint).map(x => ({ ...JSON.parse(decrypt({ body: x.init.body, uaPrivate: d.r.priv, authSecret: d.r.auth })), headers: x.init.headers }));
  const jarvis = text => env.store.append({ from: 'jarvis', kind: 'chat', text, clientId: `r${randomBytes(4).toString('hex')}` });
  const close = async () => { holder.svc.stop(); await env.close(); };
  return { env, svc: holder.svc, sent, logs, events, keys, timers, advance, device, opened, jarvis, close };
}

test('config: push.subject must be a mailto: address', () => {
  assert.deepEqual(readPushConfig({}), { subject: null, problems: [] });
  assert.deepEqual(readPushConfig({ push: { subject: ' mailto:owner@example.com ' } }), { subject: 'mailto:owner@example.com', problems: [] });
  for (const bad of ['owner@example.com', 'mailto:', 'mailto:owner@localhost', 'https://example.com', 'mailto:a b@example.com', 7]) {
    assert.equal(readPushConfig({ push: { subject: bad } }).subject, null, String(bad));
  }
  assert.match(readPushConfig({ push: 'yes' }).problems[0], /object/);
});

test('the payload is declarative Web Push with one of three generic bodies and a navigate to #chat', () => {
  assert.deepEqual(payloadFor('chat', ORIGIN), { web_push: 8030, notification: { title: 'Jarvis', body: 'New message', navigate: `${ORIGIN}/#chat`, app_badge: 1 } });
  assert.equal(payloadFor('approval', null).notification.navigate, '/#chat');
  assert.equal(payloadFor('offline', 'https://x.example/evil').notification.navigate, '/#chat', 'only a bare origin is used');
  assert.equal(payloadFor('chat', 'https://x.example:8443').notification.navigate, 'https://x.example:8443/#chat');
  for (const bad of ['http://x.example', 'https://x.example?a=1', 'https://x.example#x', 'https://x_y.example', 'https://u@x.example', 'javascript:alert(1)//', 'https://x.example\n', 'https://X.example', 'https://-x.example', 'https://x.example:', 'https://x.example:123456', 'HTTPS://x.example']) {
    assert.equal(payloadFor('chat', bad).notification.navigate, '/#chat', bad);
  }
  assert.equal(payloadFor('approval', ORIGIN).notification.body, 'Jarvis needs an approval');
  assert.equal(payloadFor('offline', ORIGIN).notification.body, 'Jarvis is offline');
});

test('where a tap goes: only an https origin whose host is in allowedHosts is kept, normalised; anything else is null', () => {
  const hosts = new Set(['mini.example.ts.net', 'alt.example.ts.net:8443', 'port.example.ts.net:443']);
  assert.equal(notificationOrigin('https://mini.example.ts.net', hosts), 'https://mini.example.ts.net');
  assert.equal(notificationOrigin('https://MINI.Example.ts.net:443', hosts), 'https://mini.example.ts.net', 'case and the default port are normalised away');
  assert.equal(notificationOrigin('https://alt.example.ts.net:8443', hosts), 'https://alt.example.ts.net:8443');
  assert.equal(notificationOrigin('https://port.example.ts.net', hosts), 'https://port.example.ts.net', 'a name listed with :443 matches the bare origin');
  for (const bad of ['http://mini.example.ts.net', 'https://alt.example.ts.net', 'https://mini.example.ts.net:8443', 'https://evil.example', 'https://user:pw@mini.example.ts.net', 'null', '', 'not a url', 'wss://mini.example.ts.net', null, undefined, 42]) {
    assert.equal(notificationOrigin(bad, hosts), null, String(bad));
  }
  assert.equal(notificationOrigin('https://mini.example.ts.net', new Set()), null, 'no allowedHosts, no origin');
});

test('subscribe stores the Serve name\'s https origin and pushes navigate there; a loopback or unlisted page stores null', async () => {
  const t = await pushEnv({ config: { allowedHosts: ['mini.example.ts.net'] } });
  try {
    const host = 'mini.example.ts.net';
    const subscribe = async (d, r, origin, hostHeader) => t.env.call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: d.cookie, origin, host: hostHeader }, body: r.sub });
    const phone = await t.env.pair('phone');
    const pr = receiver();
    assert.equal((await subscribe(phone, pr, ORIGIN, host)).status, 200);
    const pad = await t.env.pair('pad');
    const qr = receiver();
    assert.equal((await subscribe(pad, qr, 'https://other.example.ts.net', 'other.example.ts.net')).status, 200, 'the guard lets a same-origin write through');
    const laptop = await t.env.pair('laptop');
    const lr = receiver();
    assert.equal((await subscribe(laptop, lr, `http://127.0.0.1:${t.env.port}`, `127.0.0.1:${t.env.port}`)).status, 200);
    const onDisk = JSON.parse(await readFile(join(t.env.dir, 'devices.json'), 'utf8'));
    const originOf = id => onDisk.find(d => d.id === id).push.origin;
    assert.equal(originOf(phone.id), ORIGIN);
    assert.equal(originOf(pad.id), null);
    assert.equal(originOf(laptop.id), null);
    await t.jarvis('hello');
    await t.svc.idle();
    const nav = (d, r) => t.opened({ ...d, r })[0].notification.navigate;
    assert.equal(nav(phone, pr), `${ORIGIN}/#chat`);
    assert.equal(nav(pad, qr), '/#chat');
    assert.equal(nav(laptop, lr), '/#chat');
  } finally { await t.close(); }
});

test('a Jarvis message pushes "New message" to each subscribed device with no stream, and never its text', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    const pad = await t.device('pad');
    await t.env.pair('laptop'); // paired, never subscribed: nothing goes to it
    await t.jarvis('the secret plan for the launch');
    await t.svc.idle();
    assert.equal(t.sent.length, 2);
    for (const d of [phone, pad]) {
      const [p] = t.opened(d);
      assert.deepEqual({ ...p, headers: undefined }, { web_push: 8030, notification: { title: 'Jarvis', body: 'New message', navigate: '/#chat', app_badge: 1 }, headers: undefined }, 'a loopback http page is no origin for a tap');
      assert.equal(p.headers.Urgency, 'normal');
      assert.equal(p.headers.Topic, 'jos-chat');
      assert.equal(p.headers.TTL, '3600');
      const jwt = /vapid t=([^,]+),/.exec(p.headers.Authorization)[1];
      assert.equal(verifyVapidJwt(jwt, t.keys.publicKey).aud, 'https://web.push.apple.com');
    }
    for (const x of t.sent) assert.ok(!x.init.body.toString('latin1').includes('secret'), 'the wire carries ciphertext only');
  } finally { await t.close(); }
});

test('only the lead\'s chat messages push: notices, the owner\'s messages, verdicts and edits never do', async () => {
  const t = await pushEnv();
  try {
    await t.device('phone');
    await t.env.store.append({ from: 'system', kind: 'notice', text: "Jarvis's channel restarted 09:15" });
    await t.env.store.append({ from: 'jarvis', kind: 'notice', text: 'a notice from the lead' });
    await t.env.store.append({ from: 'jeff', kind: 'chat', text: 'hi', clientId: 'c1', state: 'queued' });
    await t.svc.idle();
    assert.equal(t.sent.length, 0);
    const m = await t.jarvis('one');
    await t.svc.idle();
    assert.equal(t.sent.length, 1);
    await t.advance(2 * CHAT_REPEAT_MS);
    await t.env.store.edit(m.id, 'one, edited');
    await t.svc.idle();
    assert.equal(t.sent.length, 1, 'an edit does not push');
  } finally { await t.close(); }
});

test('the 10 s rule: an open stream means no push; one closed under 10 s ago is re-checked at 10 s; a stream reopened since the message means none', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    const pad = await t.device('pad');
    // The phone is looking: its stream is open. The pad has never streamed.
    const s = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    assert.equal(s.status, 200);
    await t.jarvis('a');
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 0, 'an open stream: no push');
    assert.equal(t.opened(pad).length, 1);
    // The phone goes to the background; a message 3 s later waits for the 10 s.
    await s.close();
    await new Promise(r => setTimeout(r, 20));
    t.env.clock.t += 3 * SEC;
    await t.jarvis('b');
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 0, 'closed 3 s ago: not yet');
    await t.advance(6 * SEC);
    assert.equal(t.opened(phone).length, 0, 'still inside 10 s');
    await t.advance(1 * SEC + 1);
    assert.equal(t.opened(phone).length, 1, 'pushed once the 10 s were up');
    // Again, but the phone comes back before the 10 s: no push for that message.
    const s2 = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    await s2.close();
    await new Promise(r => setTimeout(r, 20));
    await t.advance(2 * CHAT_REPEAT_MS);
    const s3 = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    await s3.close();
    await new Promise(r => setTimeout(r, 20));
    t.env.clock.t += 2 * SEC;
    await t.jarvis('c');
    await t.svc.idle();
    const s4 = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    t.env.clock.t += 1 * SEC;
    await s4.close();
    await new Promise(r => setTimeout(r, 20));
    await t.advance(CHAT_QUIET_MS + SEC);
    assert.equal(t.opened(phone).length, 1, 'the phone saw it: no push');
  } finally { await t.close(); }
});

test('a burst from the lead pushes once a minute per device while it stays away', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    for (const x of ['a', 'b', 'c']) { await t.jarvis(x); t.env.clock.t += SEC; }
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 1);
    await t.advance(CHAT_REPEAT_MS);
    await t.jarvis('d');
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 2, 'a minute later, another');
    // Looked in (a stream opened and closed) after the last push: the next one goes at once.
    const s = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    t.env.clock.t += SEC;
    await s.close();
    await new Promise(r => setTimeout(r, 20));
    t.env.clock.t += CHAT_QUIET_MS;
    await t.jarvis('e');
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 3);
  } finally { await t.close(); }
});

test('a permission request pushes "Jarvis needs an approval", urgent, to every device, even one that is looking', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    const pad = await t.device('pad');
    const s = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    await t.env.store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'rm -rf the secret folder', inputPreview: 'secret' });
    await t.svc.idle();
    for (const d of [phone, pad]) {
      const got = t.opened(d);
      assert.equal(got.length, 1);
      for (const p of got) {
        assert.equal(p.notification.body, 'Jarvis needs an approval');
        assert.equal(p.headers.Urgency, 'high');
        assert.equal(p.headers.Topic, 'jos-approval');
        assert.ok(!JSON.stringify(p).includes('Bash') && !JSON.stringify(p).includes('secret'));
      }
    }
    await s.close();
  } finally { await t.close(); }
});

test('approval pushes: at most one per device each 15 s; one held is pushed at the window\'s end while a request is open', async () => {
  const t = await pushEnv();
  try {
    assert.equal(APPROVAL_REPEAT_MS, 15e3);
    const phone = await t.device('phone');
    const pad = await t.device('pad');
    const count = () => [t.opened(phone).length, t.opened(pad).length];
    await t.env.store.openPermission({ requestId: 'aaaaa', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.advance(3 * SEC);
    for (const id of ['bbbbb', 'ccccc', 'ddddd']) await t.env.store.openPermission({ requestId: id, tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.deepEqual(count(), [1, 1], 'a burst inside the window is held');
    await t.advance(APPROVAL_REPEAT_MS - 3 * SEC - 1);
    assert.deepEqual(count(), [1, 1], 'not before the 15 s are up');
    await t.advance(1);
    assert.deepEqual(count(), [2, 2], 'one more at the window\'s end, requests being open');
    await t.advance(5 * APPROVAL_REPEAT_MS);
    assert.deepEqual(count(), [2, 2], 'and only one: nothing repeats on its own');
    await t.env.store.openPermission({ requestId: 'eeeee', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.deepEqual(count(), [3, 3], 'a request after the window pushes at once');
    await t.env.store.openPermission({ requestId: 'fffff', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.advance(APPROVAL_REPEAT_MS);
    assert.deepEqual(count(), [4, 4], 'and a second window holds and sends the same way');
    await t.env.store.openPermission({ requestId: 'ggggg', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.ok(t.timers.some(x => !x.done), 'one held');
    t.svc.stop();
    assert.ok(t.timers.every(x => x.done), 'stop clears the held approvals');
  } finally { await t.close(); }
});

test('approval pushes: one held while every request is answered by the window\'s end is never sent', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    await t.env.store.openPermission({ requestId: 'aaaaa', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.env.store.openPermission({ requestId: 'bbbbb', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 1);
    for (const id of ['aaaaa', 'bbbbb']) assert.equal((await t.env.store.answerPermission(id, 'allow', 'phone')).ok, true);
    await t.advance(APPROVAL_REPEAT_MS);
    assert.equal(t.opened(phone).length, 1);
    // A device revoked while its push was held gets nothing either.
    await t.env.store.openPermission({ requestId: 'ccccc', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 2);
    await t.env.store.openPermission({ requestId: 'ddddd', tool: 'Bash', description: 'x', inputPreview: '' });
    assert.equal((await t.env.devices.revoke(phone.id, 'test')).ok, true);
    await t.advance(APPROVAL_REPEAT_MS);
    assert.equal(t.opened(phone).length, 2);
  } finally { await t.close(); }
});

test('sends are bounded: at most N in flight, a queue of at most M, and one past that is dropped and logged', async () => {
  assert.equal(SEND_CONCURRENCY, 4);
  assert.equal(SEND_QUEUE_MAX, 16);
  const gates = [];
  let inFlight = 0, most = 0, done = 0;
  const fetchImpl = async () => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(r => gates.push(r));
    inFlight--; done++;
    return { status: 201, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const t = await pushEnv({ fetchImpl, sendConcurrency: 1, sendQueueMax: 2 });
  try {
    for (const name of ['phone', 'pad', 'laptop', 'desk']) await t.device(name);
    await t.env.store.openPermission({ requestId: 'aaaaa', tool: 'Bash', description: 'x', inputPreview: '' });
    for (let i = 0; i < 20 && gates.length === 0; i++) await new Promise(r => setImmediate(r));
    assert.equal(inFlight, 1, 'one in flight');
    const dropped = t.logs.filter(l => /pushes are waiting; a approval push to \S+ was dropped/.test(l));
    assert.equal(dropped.length, 1, 'one in flight, two waiting, the fourth dropped');
    while (done < 3) {
      while (gates.length) gates.shift()();
      await new Promise(r => setImmediate(r));
    }
    await t.svc.idle();
    assert.equal(done, 3);
    assert.equal(most, 1, 'never two at once');
  } finally { await t.close(); }
});

test('sends are bounded: a limit of 2 runs two at once and sends the rest after, dropping none', async () => {
  const gates = [];
  let inFlight = 0, most = 0;
  const fetchImpl = async () => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(r => gates.push(r));
    inFlight--;
    return { status: 201, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const t = await pushEnv({ fetchImpl, sendConcurrency: 2 });
  try {
    for (const name of ['phone', 'pad', 'laptop', 'desk']) await t.device(name);
    await t.env.store.openPermission({ requestId: 'aaaaa', tool: 'Bash', description: 'x', inputPreview: '' });
    for (let i = 0; i < 20 && gates.length < 2; i++) await new Promise(r => setImmediate(r));
    assert.equal(inFlight, 2);
    let rounds = 0;
    while (rounds++ < 50 && (gates.length || inFlight)) { while (gates.length) gates.shift()(); await new Promise(r => setImmediate(r)); }
    await t.svc.idle();
    assert.equal(most, 2);
    assert.equal(t.logs.filter(l => /dropped/.test(l)).length, 0);
  } finally { await t.close(); }
});

test('offline: one push after 5 minutes without a heartbeat, none before, none again until the channel has come back', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    t.env.channel.connected = false;
    t.env.channel.lastHeartbeatAt = t.env.clock.t;
    t.env.clock.t += OFFLINE_AFTER_MS - SEC;
    t.svc.checkOffline();
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 0);
    t.env.clock.t += SEC;
    t.svc.checkOffline();
    await t.svc.idle();
    const [p] = t.opened(phone);
    assert.equal(p.notification.body, 'Jarvis is offline');
    assert.equal(p.headers.Urgency, 'normal');
    t.env.clock.t += 30 * MIN;
    t.svc.checkOffline();
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 1, 'once');
    t.env.channel.connected = true;
    t.svc.checkOffline();
    t.env.channel.connected = false;
    t.env.channel.lastHeartbeatAt = t.env.clock.t;
    t.env.clock.t += OFFLINE_AFTER_MS;
    t.svc.checkOffline();
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 2, 'a new outage, a new push');
  } finally { await t.close(); }
});

test('offline with no heartbeat ever counts from the server\'s start', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    t.env.channel.connected = false;
    t.env.channel.lastHeartbeatAt = null;
    t.env.clock.t += OFFLINE_AFTER_MS - SEC;
    t.svc.checkOffline();
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 0);
    t.env.clock.t += SEC;
    t.svc.checkOffline();
    await t.svc.idle();
    assert.equal(t.opened(phone).length, 1);
  } finally { await t.close(); }
});

test('a 404 or a 410 deletes that device\'s subscription; a 403 alerts and keeps it; a 500 only logs', async () => {
  const codes = new Map();
  const t = await pushEnv({ status: url => codes.get(url) ?? 201 });
  try {
    const a = await t.device('phone');
    const b = await t.device('pad');
    const c = await t.device('laptop');
    const d = await t.device('desk');
    codes.set(a.r.sub.endpoint, 410);
    codes.set(b.r.sub.endpoint, 404);
    codes.set(c.r.sub.endpoint, 403);
    codes.set(d.r.sub.endpoint, 500);
    await t.env.store.openPermission({ requestId: 'kkkkk', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.equal(t.env.devices.hasPush(a.id), false);
    assert.equal(t.env.devices.hasPush(b.id), false);
    assert.equal(t.env.devices.hasPush(c.id), true);
    assert.equal(t.env.devices.hasPush(d.id), true);
    assert.deepEqual(t.events, [{ kind: 'push-forbidden', device: 'laptop' }]);
    assert.ok(t.logs.some(l => /phone's subscription is gone \(410\)/.test(l)));
    assert.ok(t.logs.some(l => /pad's subscription is gone \(404\)/.test(l)));
    assert.ok(t.logs.some(l => /failed \(500\)/.test(l)));
    for (const l of t.logs) assert.ok(!l.includes('push.apple.com'), 'no endpoint in the log');
    t.sent.length = 0;
    await t.advance(APPROVAL_REPEAT_MS);
    await t.env.store.openPermission({ requestId: 'lllll', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.equal(t.sent.length, 2, 'the deleted ones get nothing more');
  } finally { await t.close(); }
});

test('a gone answer for an old subscription leaves the fresh one the page sent meanwhile', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const t = await pushEnv({ fetchImpl: async () => { await gate; return { status: 410, arrayBuffer: async () => new ArrayBuffer(0) }; } });
  try {
    const phone = await t.device('phone');
    await t.env.store.openPermission({ requestId: 'mmmmm', tool: 'Bash', description: 'x', inputPreview: '' });
    const fresh = receiver();
    assert.equal((await t.env.call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: phone.cookie }, body: fresh.sub })).status, 200);
    release();
    await t.svc.idle();
    assert.equal(t.env.devices.hasPush(phone.id), true);
    assert.equal(t.env.devices.pushTargets()[0].push.endpoint, fresh.sub.endpoint);
  } finally { await t.close(); }
});

test('routes: the key, subscribe and unsubscribe need the cookie and the guards; other push services are refused; a revoke drops the subscription', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.env.pair('phone');
    const r = receiver();
    const call = opts => t.env.call(opts);
    assert.equal((await call({ path: '/api/push/key' })).status, 401);
    const key = await call({ path: '/api/push/key', headers: { cookie: phone.cookie } });
    assert.equal(key.status, 200);
    assert.deepEqual(key.json, { key: t.keys.publicKey, subscribed: false });
    assert.equal(key.headers['cache-control'], 'no-store');
    const post = (body, headers = {}) => call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: phone.cookie, ...headers }, body });
    assert.equal((await call({ method: 'POST', path: '/api/push/subscription', body: r.sub })).status, 401);
    assert.equal((await post(r.sub, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: phone.cookie, 'content-type': 'text/plain' }, body: Buffer.from(JSON.stringify(r.sub)) })).status, 415);
    const fcm = await post({ ...r.sub, endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
    assert.equal(fcm.status, 400);
    assert.match(fcm.json.error, /Apple's push service only/);
    assert.equal((await post({ ...r.sub, endpoint: 'http://127.0.0.1:9/x' })).status, 400, 'no loopback without the test override');
    assert.equal(t.env.devices.hasPush(phone.id), false);
    assert.equal((await post(r.sub)).status, 200);
    assert.deepEqual((await call({ path: '/api/push/key', headers: { cookie: phone.cookie } })).json.subscribed, true);
    assert.equal((await call({ path: '/api/devices', headers: { cookie: phone.cookie } })).json.devices[0].push, true);
    assert.equal((await call({ method: 'DELETE', path: '/api/push/subscription', headers: { cookie: phone.cookie, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call({ method: 'DELETE', path: '/api/push/subscription', headers: { cookie: phone.cookie } })).status, 200);
    assert.equal(t.env.devices.hasPush(phone.id), false);
    // A revoke drops it too, for good.
    assert.equal((await post(r.sub)).status, 200);
    const pad = await t.env.pair('pad');
    assert.equal((await call({ method: 'DELETE', path: `/api/devices/${phone.id}`, headers: { cookie: pad.cookie } })).status, 200);
    assert.equal(t.env.devices.pushTargets().length, 0);
    const onDisk = JSON.parse(await readFile(join(t.env.dir, 'devices.json'), 'utf8'));
    assert.equal(onDisk.find(d => d.id === phone.id).push, null, 'the revoked row keeps no subscription on disk');
    await t.env.store.openPermission({ requestId: 'nnnnn', tool: 'Bash', description: 'x', inputPreview: '' });
    await t.svc.idle();
    assert.equal(t.sent.length, 0);
  } finally { await t.close(); }
});

test('one endpoint belongs to one device: subscribing it on another moves it there', async () => {
  const t = await pushEnv();
  try {
    const r = receiver();
    const a = await t.device('phone', r);
    const b = await t.device('pad', r);
    assert.equal(t.env.devices.hasPush(a.id), false);
    assert.equal(t.env.devices.hasPush(b.id), true);
  } finally { await t.close(); }
});

test('with no VAPID key the routes say notifications are not set up, and nothing is sent', async () => {
  const t = await pushEnv({ vapid: false });
  try {
    const phone = await t.env.pair('phone');
    const key = await t.env.call({ path: '/api/push/key', headers: { cookie: phone.cookie } });
    assert.equal(key.status, 503);
    assert.match(key.json.error, /not set up/);
    assert.equal((await t.env.call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: phone.cookie }, body: receiver().sub })).status, 503);
  } finally { await t.close(); }
});

test('end to end: a loopback push service (the test-only host override) receives a push and decrypts it', async () => {
  const got = [];
  const fake = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${fake.address().port}`;
  const t = await pushEnv({ fetchImpl: fetch, testHosts: new Set([host]) });
  try {
    const r = receiver(`http://${host}/push/device-1`);
    const phone = await t.device('phone', r);
    await t.jarvis('hello from the lead');
    await t.svc.idle();
    assert.equal(got.length, 1);
    assert.equal(got[0].path, '/push/device-1');
    assert.equal(got[0].headers['content-encoding'], 'aes128gcm');
    assert.equal(got[0].headers.ttl, '3600');
    assert.equal(got[0].headers.topic, 'jos-chat');
    const jwt = /^vapid t=([^,]+), k=/.exec(got[0].headers.authorization)[1];
    assert.equal(verifyVapidJwt(jwt, t.keys.publicKey).aud, `http://${host}`);
    const payload = JSON.parse(decrypt({ body: got[0].body, uaPrivate: r.priv, authSecret: r.auth }));
    assert.equal(payload.notification.body, 'New message');
    assert.ok(phone.id);
  } finally {
    await t.close();
    await new Promise(r => fake.close(r));
  }
});

void BODIES;

test('the VAPID key: read from the Keychain item, derived, and each missing piece is a reason to log', async () => {
  const { loadVapid, readVapidKey } = await import('../lib/chat-push.mjs');
  const priv = newVapidKeys().privateKey;
  const ok = await loadVapid({ config: { push: { subject: 'mailto:owner@example.com' } }, read: async () => priv });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.vapid.publicKey, vapidKeys(priv).publicKey);
  assert.equal(ok.vapid.subject, 'mailto:owner@example.com');
  assert.match((await loadVapid({ config: {}, read: async () => priv })).problems[0], /push\.subject/);
  assert.match((await loadVapid({ config: { push: { subject: 'mailto:owner@example.com' } }, read: async () => null })).problems[0], /vapid-keygen/);
  const bad = await loadVapid({ config: { push: { subject: 'mailto:owner@example.com' } }, read: async () => 'AAAA' });
  assert.equal(bad.vapid, null);
  assert.ok(!bad.problems[0].includes('AAAA'), 'the key never reaches the log');
  // Through the injected `run` only: never the real Keychain.
  const calls = [];
  const fake = (code, stdout = '') => async (args, input, opts) => { calls.push({ args, opts }); return { code, stderr: '', stdout }; };
  assert.equal(await readVapidKey({ run: fake(0, ` ${priv}\n`), keychain: '/k/login.keychain-db' }), priv);
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'claude-control-room', '-a', 'vapid-private-key', '-w', '/k/login.keychain-db']);
  assert.equal(calls[0].opts.capture, true);
  assert.equal(await readVapidKey({ run: fake(44), keychain: '/k/login.keychain-db' }), null);
  assert.equal(await readVapidKey({ run: fake(0, '\n'), keychain: '/k/login.keychain-db' }), null);
  await assert.rejects(readVapidKey({ run: fake(36), keychain: '/k/login.keychain-db' }), /exit 36/);
  const locked = await loadVapid({ config: { push: { subject: 'mailto:owner@example.com' } }, read: () => readVapidKey({ run: fake(36), keychain: '/k/login.keychain-db' }) });
  assert.equal(locked.vapid, null);
  assert.match(locked.problems[0], /^the Keychain could not be read \(security could not read the key \(exit 36\)\)/);
});
