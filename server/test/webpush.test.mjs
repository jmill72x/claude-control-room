// Web Push on node:crypto (lib/webpush.mjs): RFC 8291 Appendix A to the byte, the
// VAPID JWT verified with the derived public key, a round trip through a test
// receiver, the endpoint rule, and what a send puts on the wire. Keys here are the
// RFC's published test keys or made fresh; nothing is sent off this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, sign } from 'node:crypto';
import { encrypt, decrypt, vapidKeys, newVapidKeys, vapidJwt, verifyVapidJwt, checkSubscription, checkEndpoint, sendPush, fromB64u, b64u, JWT_TTL_S } from '../lib/webpush.mjs';

const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

const receiver = () => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { pub: b64u(e.getPublicKey()), priv: e.getPrivateKey(), auth: b64u(randomBytes(16)) };
};

test('RFC 8291 Appendix A: the exact body, byte for byte, and it decrypts back', () => {
  const body = encrypt({ plaintext: Buffer.from(RFC.plaintext), uaPublic: RFC.uaPublic, authSecret: RFC.auth, salt: fromB64u(RFC.salt), asPrivate: RFC.asPrivate });
  assert.equal(b64u(body), RFC.body);
  assert.equal(body.length, 144);
  assert.equal(b64u(body.subarray(0, 86)), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'the 86-octet header');
  assert.equal(decrypt({ body: fromB64u(RFC.body), uaPrivate: RFC.uaPrivate, authSecret: RFC.auth }).toString(), RFC.plaintext);
  assert.equal(vapidKeys(RFC.asPrivate).publicKey, RFC.asPublic, 'the public key derives from the private one');
});

test('a fresh push round-trips through a test receiver; a wrong auth secret or a flipped byte fails', () => {
  const r = receiver();
  const text = JSON.stringify({ web_push: 8030, notification: { title: 'Jarvis', body: 'New message' } });
  const body = encrypt({ plaintext: Buffer.from(text), uaPublic: r.pub, authSecret: r.auth });
  assert.equal(decrypt({ body, uaPrivate: r.priv, authSecret: r.auth }).toString(), text);
  assert.notEqual(b64u(encrypt({ plaintext: Buffer.from(text), uaPublic: r.pub, authSecret: r.auth })), b64u(body), 'a new salt and key each time');
  assert.throws(() => decrypt({ body, uaPrivate: r.priv, authSecret: b64u(randomBytes(16)) }));
  const bad = Buffer.from(body);
  bad[bad.length - 20] ^= 1;
  assert.throws(() => decrypt({ body: bad, uaPrivate: r.priv, authSecret: r.auth }));
  assert.throws(() => encrypt({ plaintext: Buffer.alloc(4096), uaPublic: r.pub, authSecret: r.auth }), /one record/);
});

test('VAPID: the JWT verifies with the derived public key and carries aud, sub and an exp within 24 h', () => {
  const keys = newVapidKeys();
  const v = vapidKeys(keys.privateKey);
  assert.equal(v.publicKey, keys.publicKey);
  assert.equal(fromB64u(v.publicKey).length, 65);
  const now = 1794380000000;
  const jwt = vapidJwt({ audience: 'https://web.push.apple.com', subject: 'mailto:owner@example.com', privateKey: v.privateKey, now });
  const head = JSON.parse(fromB64u(jwt.split('.')[0]).toString());
  assert.deepEqual(head, { typ: 'JWT', alg: 'ES256' });
  const claims = verifyVapidJwt(jwt, v.publicKey);
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: Math.floor(now / 1000) + JWT_TTL_S, sub: 'mailto:owner@example.com' });
  assert.ok(claims.exp - now / 1000 <= 24 * 3600);
  assert.equal(fromB64u(jwt.split('.')[2]).length, 64, 'a raw r||s signature, as JWS wants');
  assert.equal(verifyVapidJwt(jwt, newVapidKeys().publicKey), null, 'another key does not verify it');
  const parts = jwt.split('.');
  const forged = `${parts[0]}.${b64u(JSON.stringify({ ...claims, aud: 'https://evil.example' }))}.${parts[2]}`;
  assert.equal(verifyVapidJwt(forged, v.publicKey), null, 'changed claims do not verify');
  assert.throws(() => vapidJwt({ audience: 'x', subject: 's', privateKey: v.privateKey, ttlS: 24 * 3600 + 1 }), /24 hours/);
  const otherHead = b64u(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
  const sig = sign('sha256', Buffer.from(`${otherHead}.${parts[1]}`), { key: v.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(verifyVapidJwt(`${otherHead}.${parts[1]}.${b64u(sig)}`, v.publicKey), null, 'only ES256 is accepted');
  assert.throws(() => vapidKeys('AAAA'), /32 bytes/);
  assert.throws(() => vapidKeys(b64u(Buffer.alloc(32))));
});

test('egress: only https on the default port to a host under .push.apple.com, never with credentials', () => {
  const ok = u => checkEndpoint(u).ok;
  assert.ok(ok('https://web.push.apple.com/QGuQyavXutnMH8hQ1mMUIIFfkd'));
  assert.ok(ok('https://api.push.apple.com/x'));
  assert.ok(ok('https://WEB.PUSH.APPLE.COM/x'));
  for (const bad of [
    'http://web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'https://push.apple.com/x', 'https://.push.apple.com/x',
    'https://web.push.apple.com.evil.example/x', 'https://evilpush.apple.com/x', 'https://web.push.apple.com./x',
    'https://user:pw@web.push.apple.com/x', 'https://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x',
    'http://127.0.0.1:9999/x', 'https://localhost/x', 'file:///etc/passwd', 'not a url', ''
  ]) assert.equal(ok(bad), false, bad);
  // The scratch override: loopback over http, only for the named host:port.
  const testHosts = new Set(['127.0.0.1:9999']);
  assert.ok(checkEndpoint('http://127.0.0.1:9999/push/a', { testHosts }).ok);
  assert.equal(checkEndpoint('http://127.0.0.1:9998/push/a', { testHosts }).ok, false);
  assert.equal(checkEndpoint('http://localhost:9999/push/a', { testHosts: new Set(['localhost:9999']) }).ok, false, 'a loopback address, never a name');
});

test('a subscription is checked whole: endpoint, a P-256 point and a 16-byte secret', () => {
  const r = receiver();
  const good = { endpoint: 'https://web.push.apple.com/abc', expirationTime: null, keys: { p256dh: r.pub, auth: r.auth } };
  const c = checkSubscription(good);
  assert.ok(c.ok);
  assert.deepEqual(c.subscription, { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: r.pub, auth: r.auth } }, 'nothing else is kept');
  assert.equal(checkSubscription({ ...good, endpoint: 'https://fcm.googleapis.com/x' }).ok, false);
  assert.equal(checkSubscription({ ...good, endpoint: `https://web.push.apple.com/${'a'.repeat(1100)}` }).ok, false);
  assert.equal(checkSubscription({ ...good, keys: { ...good.keys, auth: b64u(randomBytes(15)) } }).ok, false);
  assert.equal(checkSubscription({ ...good, keys: { ...good.keys, p256dh: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])) } }).ok, false, 'not on the curve');
  assert.equal(checkSubscription({ ...good, keys: { ...good.keys, p256dh: 'not base64!' } }).ok, false);
  assert.equal(checkSubscription({ endpoint: good.endpoint }).ok, false);
  assert.equal(checkSubscription(null).ok, false);
  assert.equal(checkSubscription([]).ok, false);
});

test('a send: the headers, the JWT for the endpoint\'s origin, an encrypted body; outcomes by status; no redirects; never throws', async () => {
  const r = receiver();
  const keys = vapidKeys(newVapidKeys().privateKey);
  const vapid = { ...keys, subject: 'mailto:owner@example.com' };
  const subscription = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: r.pub, auth: r.auth } };
  let seen;
  const fetchImpl = status => async (url, init) => { seen = { url, init }; return { status, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const now = 1794380000000;
  const out = await sendPush({ subscription, payload: { hello: 1 }, vapid, urgency: 'high', topic: 'jos-approval', now, fetchImpl: fetchImpl(201) });
  assert.deepEqual(out, { status: 201, outcome: 'sent' });
  assert.equal(seen.url, 'https://web.push.apple.com/abc');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'manual');
  const h = seen.init.headers;
  assert.equal(h.TTL, '3600');
  assert.equal(h.Urgency, 'high');
  assert.equal(h.Topic, 'jos-approval');
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(h.Authorization);
  assert.ok(m, h.Authorization);
  assert.equal(m[2], keys.publicKey);
  assert.deepEqual(verifyVapidJwt(m[1], keys.publicKey), { aud: 'https://web.push.apple.com', exp: Math.floor(now / 1000) + JWT_TTL_S, sub: 'mailto:owner@example.com' });
  assert.deepEqual(JSON.parse(decrypt({ body: seen.init.body, uaPrivate: r.priv, authSecret: r.auth })), { hello: 1 });
  await sendPush({ subscription, payload: 'x', vapid, now, fetchImpl: fetchImpl(201) });
  assert.equal(seen.init.headers.Urgency, 'normal');
  assert.ok(!('Topic' in seen.init.headers));
  for (const [status, outcome] of [[404, 'gone'], [410, 'gone'], [403, 'forbidden'], [400, 'failed'], [500, 'failed'], [301, 'failed']]) {
    assert.deepEqual(await sendPush({ subscription, payload: 'x', vapid, fetchImpl: fetchImpl(status) }), { status, outcome }, String(status));
  }
  assert.deepEqual(await sendPush({ subscription, payload: 'x', vapid, fetchImpl: async () => { throw new Error('https://web.push.apple.com/abc refused'); } }), { status: 0, outcome: 'failed' });
  let called = false;
  const refused = await sendPush({ subscription: { ...subscription, endpoint: 'https://evil.example/x' }, payload: 'x', vapid, fetchImpl: async () => { called = true; } });
  assert.deepEqual(refused, { status: 0, outcome: 'refused' });
  assert.equal(called, false, 'a stored endpoint is checked again before any request');
});
