// The approval reminder push (lib/chat-push.mjs, approvalReminder; board e7427be1) and
// the approval push's own log line: to every paired device, urgent, in one fixed shape
// that names no tool, the approval's Topic, a tap to the Chat; a body in any other shape
// is never sent. A fake fetch records each push and the test decrypts it as the device
// would. Every name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { makeChatEnv, openStream } from './helpers/chat-env.mjs';
import { createPushService, payloadFor, BODIES } from '../lib/chat-push.mjs';
import { vapidKeys, newVapidKeys, decrypt, b64u } from '../lib/webpush.mjs';
import { REMINDER_TAIL } from '../lib/approval-wait.mjs';

const ORIGIN = 'https://mini.example.ts.net';
const BODY = `Inventlead has waited 10 min on an approval card. ${REMINDER_TAIL}`;

const receiver = () => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  const auth = b64u(randomBytes(16));
  return { priv: e.getPrivateKey(), auth, sub: { endpoint: `https://web.push.apple.com/${randomBytes(6).toString('hex')}`, expirationTime: null, keys: { p256dh: b64u(e.getPublicKey()), auth } } };
};

// A chat env with a push service whose fetch the test controls (chat-push.test.mjs's, cut down).
async function pushEnv({ status = () => 201, vapid = true } = {}) {
  const holder = { svc: null };
  const lazy = { on: () => holder.svc?.on() ?? false, publicKey: () => holder.svc?.publicKey() ?? null, testHosts: null };
  const env = await makeChatEnv({ routes: { push: lazy, config: {} } });
  const sent = [];
  const logs = [];
  const keys = vapid ? { ...vapidKeys(newVapidKeys().privateKey), subject: 'mailto:owner@example.com' } : null;
  holder.svc = createPushService({
    devices: env.devices, store: env.store, socket: env.socket, lastStream: id => env.routes.lastStream(id), vapid: keys,
    now: env.now, log: l => logs.push(l), startedAt: env.clock.t,
    fetchImpl: async (url, init) => { sent.push({ url, init }); return { status: status(url), arrayBuffer: async () => new ArrayBuffer(0) }; },
    setTimer: () => ({}), clearTimer: () => {}, checkMs: 3600e3
  });
  const device = async name => {
    const r = receiver();
    const d = await env.pair(name);
    const res = await env.call({ method: 'POST', path: '/api/push/subscription', headers: { cookie: d.cookie, origin: `http://127.0.0.1:${env.port}` }, body: r.sub });
    assert.equal(res.status, 200, res.text);
    return { ...d, r };
  };
  const opened = d => sent.filter(x => x.url === d.r.sub.endpoint).map(x => ({ ...JSON.parse(decrypt({ body: x.init.body, uaPrivate: d.r.priv, authSecret: d.r.auth })), headers: x.init.headers }));
  const close = async () => { holder.svc.stop(); await env.close(); };
  return { env, svc: holder.svc, sent, logs, device, opened, close };
}

test('the reminder\'s payload: titled Jarvis, its body only in the fixed shape, a tap to the Chat', () => {
  assert.deepEqual(payloadFor('reminder', ORIGIN, BODY), { web_push: 8030, notification: { title: 'Jarvis', body: BODY, navigate: `${ORIGIN}/#chat`, app_badge: 1 } });
  for (const bad of ['rm -rf the secret folder', `${BODY}\nmore`, null, 7]) assert.equal(payloadFor('reminder', ORIGIN, bad).notification.body, BODIES.approval, String(bad));
});

test('a reminder goes to every device at once, urgent, under the approval\'s Topic, even one that is looking, and says how many it reached', async () => {
  const t = await pushEnv();
  try {
    const phone = await t.device('phone');
    const pad = await t.device('pad');
    const s = await openStream({ port: t.env.port, headers: { cookie: phone.cookie } });
    assert.deepEqual(await t.svc.approvalReminder(BODY), { tried: 2, reached: 2 });
    for (const d of [phone, pad]) {
      const got = t.opened(d);
      assert.equal(got.length, 1);
      assert.equal(got[0].notification.body, BODY);
      assert.equal(got[0].headers.Urgency, 'high');
      assert.equal(got[0].headers.Topic, 'jos-approval');
    }
    await s.close();
  } finally { await t.close(); }
});

test('a reminder not in the fixed shape is not sent; with push off, or a refused send, it reaches none', async () => {
  const t = await pushEnv();
  try {
    await t.device('phone');
    for (const bad of ['rm -rf the secret folder', `${BODY} and the secret folder`, '', null, { toString: () => BODY }]) {
      assert.deepEqual(await t.svc.approvalReminder(bad), { tried: 0, reached: 0 });
    }
    assert.equal(t.sent.length, 0);
    assert.equal(t.logs.filter(l => l === 'push: an approval reminder that is not in the fixed shape was not sent').length, 5);
    for (const l of t.logs) assert.ok(!l.includes('secret'));
  } finally { await t.close(); }
  const off = await pushEnv({ vapid: false });
  try { assert.deepEqual(await off.svc.approvalReminder(BODY), { tried: 0, reached: 0 }); } finally { await off.close(); }
  const refused = await pushEnv({ status: () => 500 });
  try {
    await refused.device('phone');
    assert.deepEqual(await refused.svc.approvalReminder(BODY), { tried: 1, reached: 0 });
  } finally { await refused.close(); }
});

test('an approval push that lands says so in the log, by device name; one that fails does not', async () => {
  const t = await pushEnv();
  try {
    await t.device('phone');
    await t.env.store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'rm -rf the secret folder', inputPreview: 'secret' });
    await t.svc.idle();
    assert.deepEqual(t.logs.filter(l => l.includes('approval push')), ['push: an approval push went to phone']);
  } finally { await t.close(); }
  const bad = await pushEnv({ status: () => 500 });
  try {
    await bad.device('phone');
    await bad.env.store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'd', inputPreview: '' });
    await bad.svc.idle();
    assert.equal(bad.logs.filter(l => l.startsWith('push: an approval push went')).length, 0);
    assert.ok(bad.logs.some(l => l.startsWith('push: a approval push to phone failed')));
  } finally { await bad.close(); }
});
