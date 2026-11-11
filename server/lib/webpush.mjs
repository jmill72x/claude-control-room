// Web Push with no dependencies, on node:crypto (jarvis-os-chat-spec.md, §3):
// RFC 8291 message encryption (aes128gcm, one record) and RFC 8292 VAPID (an ES256
// JWT naming the push service's origin). The encryption reproduces RFC 8291's
// Appendix A exactly (test/webpush.test.mjs).
//
// What may be pushed to: only Apple's push service, a host ending in
// `.push.apple.com` over HTTPS on its default port. A subscription naming anything
// else is refused when it is stored, which is also the guard against this server
// being made to call an address of someone's choosing. Redirects are never followed.
import { createECDH, createHmac, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

export const PUSH_HOST_SUFFIX = '.push.apple.com';
export const RECORD_SIZE = 4096;
export const JWT_TTL_S = 12 * 3600;      // RFC 8292 allows at most 24 h
export const JWT_MAX_TTL_S = 24 * 3600;
export const PUSH_TTL_S = 3600;
export const SEND_TIMEOUT_MS = 10e3;
export const ENDPOINT_MAX = 1024;

export const b64u = buf => Buffer.from(buf).toString('base64url');
export const fromB64u = s => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('not base64url');
  return Buffer.from(s.replace(/=+$/, ''), 'base64url');
};
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const CURVE = 'prime256v1';

// ---- the keys ----

// The VAPID key pair from its private half (32 bytes, base64url, as the Keychain
// holds it): the public key is derived, so config carries no key at all.
export function vapidKeys(privateB64u) {
  const d = fromB64u(String(privateB64u ?? '').trim());
  if (d.length !== 32) throw new Error('the VAPID private key must be 32 bytes, base64url');
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(d); // throws for a scalar that is no key on the curve
  const pub = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  return { publicKey: b64u(pub), privateKey: createPrivateKey({ key: jwk, format: 'jwk' }) };
}

// A new key pair, for bin/vapid-keygen: the private half as the Keychain stores it.
export function newVapidKeys() {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  let d = ecdh.getPrivateKey();
  if (d.length < 32) d = Buffer.concat([Buffer.alloc(32 - d.length), d]);
  return { privateKey: b64u(d), publicKey: b64u(ecdh.getPublicKey()) };
}

// ---- RFC 8292: the VAPID JWT ----

export function vapidJwt({ audience, subject, privateKey, now = Date.now(), ttlS = JWT_TTL_S }) {
  if (!(ttlS > 0 && ttlS <= JWT_MAX_TTL_S)) throw new Error('the JWT must expire within 24 hours');
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + ttlS, sub: subject }));
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(sig)}`;
}

// A JWT checked against a public key (base64url, uncompressed): the claims, or null.
export function verifyVapidJwt(token, publicB64u) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const pub = fromB64u(publicB64u);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(parts[2]));
  if (!ok) return null;
  const header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
  if (header.alg !== 'ES256') return null;
  return JSON.parse(fromB64u(parts[1]).toString('utf8'));
}

// ---- RFC 8291: the message ----

function deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  return { cek, nonce };
}

// The body for one push: salt, record size, the sender's public key, then one
// record (the plaintext, the 0x02 delimiter, AES-128-GCM). `salt` and `asPrivate`
// are for the RFC's test vector; a real push makes both fresh.
export function encrypt({ plaintext, uaPublic, authSecret, salt = randomBytes(16), asPrivate = null }) {
  const ua = Buffer.isBuffer(uaPublic) ? uaPublic : fromB64u(uaPublic);
  const auth = Buffer.isBuffer(authSecret) ? authSecret : fromB64u(authSecret);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (auth.length !== 16) throw new Error('auth must be 16 bytes');
  const ecdh = createECDH(CURVE);
  if (asPrivate) ecdh.setPrivateKey(Buffer.isBuffer(asPrivate) ? asPrivate : fromB64u(asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(ua);
  const { cek, nonce } = deriveKeys({ ecdhSecret, authSecret: auth, uaPublic: ua, asPublic, salt });
  const body = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (body.length + 16 > RECORD_SIZE) throw new Error('the payload is too long for one record');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

// The receiver's side, for the tests and the scratch push service: the plaintext.
export function decrypt({ body, uaPrivate, authSecret }) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idLen = buf[20];
  const asPublic = buf.subarray(21, 21 + idLen);
  const ct = buf.subarray(21 + idLen);
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.isBuffer(uaPrivate) ? uaPrivate : fromB64u(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const { cek, nonce } = deriveKeys({ ecdhSecret, authSecret: Buffer.isBuffer(authSecret) ? authSecret : fromB64u(authSecret), uaPublic, asPublic, salt });
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('no last-record delimiter');
  return plain.subarray(0, end);
}

// ---- subscriptions ----

// A subscription as the page sends it (PushSubscription.toJSON()), checked: the
// endpoint is Apple's push service over HTTPS, and the keys are a P-256 point and a
// 16-byte secret. `testHosts` (a Set of loopback host:port) exists for the scratch
// end-to-end check alone, which runs a fake push service over http on 127.0.0.1;
// server.mjs never passes it. Returns `{ ok, subscription }` or `{ ok: false, error }`.
export function checkSubscription(raw, { testHosts = null } = {}) {
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(raw) || !isObject(raw.keys)) return { ok: false, error: 'a subscription needs an endpoint and keys' };
  const endpoint = raw.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) return { ok: false, error: 'the endpoint must be a URL of at most 1024 characters' };
  const where = checkEndpoint(endpoint, { testHosts });
  if (!where.ok) return where;
  let p256dh, auth;
  try { p256dh = fromB64u(raw.keys.p256dh); auth = fromB64u(raw.keys.auth); } catch { return { ok: false, error: 'the keys must be base64url' }; }
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return { ok: false, error: 'the keys are not a P-256 point and a 16-byte secret' };
  try { const e = createECDH(CURVE); e.generateKeys(); e.computeSecret(p256dh); } catch { return { ok: false, error: 'p256dh is not a point on P-256' }; }
  return { ok: true, subscription: { endpoint: where.url, keys: { p256dh: b64u(p256dh), auth: b64u(auth) } } };
}

export function checkEndpoint(endpoint, { testHosts = null } = {}) {
  let u;
  try { u = new URL(endpoint); } catch { return { ok: false, error: 'the endpoint is not a URL' }; }
  if (u.username || u.password) return { ok: false, error: 'the endpoint may not carry credentials' };
  if (testHosts && testHosts.has(u.host) && u.protocol === 'http:' && u.hostname === '127.0.0.1') return { ok: true, url: u.href };
  if (u.protocol !== 'https:') return { ok: false, error: 'the endpoint must be https' };
  if (u.port !== '') return { ok: false, error: 'the endpoint must use the default port' };
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(PUSH_HOST_SUFFIX) || host.length <= PUSH_HOST_SUFFIX.length) return { ok: false, error: 'notifications go through Apple\'s push service only' };
  return { ok: true, url: u.href };
}

// ---- sending ----

// One push. Answers `{ status, outcome }`: `sent` (2xx), `gone` (404 or 410: the
// subscription is dead; delete it), `forbidden` (403: the key or the JWT was
// refused; alert), `failed` (any other answer, a timeout or no network). Never
// throws, and never puts the endpoint, the payload or the JWT in its answer.
export async function sendPush({ subscription, payload, vapid, urgency = 'normal', topic = null, ttl = PUSH_TTL_S, now = Date.now(), fetchImpl = fetch, testHosts = null }) {
  const where = checkEndpoint(subscription?.endpoint, { testHosts });
  if (!where.ok) return { status: 0, outcome: 'refused' };
  let body;
  try {
    body = encrypt({ plaintext: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), uaPublic: subscription.keys.p256dh, authSecret: subscription.keys.auth });
  } catch { return { status: 0, outcome: 'refused' }; }
  const audience = new URL(where.url).origin;
  const jwt = vapidJwt({ audience, subject: vapid.subject, privateKey: vapid.privateKey, now });
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`
  };
  if (topic) headers.Topic = topic;
  try {
    const res = await fetchImpl(where.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    try { await res.arrayBuffer?.(); } catch { /* the body is not ours to read */ }
    const status = res.status;
    if (status >= 200 && status < 300) return { status, outcome: 'sent' };
    if (status === 404 || status === 410) return { status, outcome: 'gone' };
    if (status === 403) return { status, outcome: 'forbidden' };
    return { status, outcome: 'failed' };
  } catch {
    return { status: 0, outcome: 'failed' };
  }
}
