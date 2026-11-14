// Face ID step-up (war room slice 2, docs/design/2026-11-13-war-room-stop.md §4): a
// WebAuthn platform passkey per approver device, asked for before a Stop and nothing
// else. Verified here with node:crypto alone: ES256 only, attestation "none", no CBOR
// reader. The browser hands over the credential's public key as SPKI
// (AuthenticatorAttestationResponse.getPublicKey()); the authenticator data must
// carry the same key's x and y as COSE byte strings, so the key the page sends is the
// one the authenticator made.
//
// Registration: an approver device asks for options, makes the passkey (Face ID),
// and posts it; the server keeps it pending and answers a 6-letter code. Nothing is
// trusted until the code is confirmed on the machine (`bin/chat-pair passkey <CODE>`,
// the admin socket), the same confirm a first pairing takes, and only at a terminal:
// chat-pair refuses without a TTY, shows the device name and set-up time, and the
// server wants that name typed back (Ultron's medium, 11-13: any same-user process
// can reach the admin socket, so the confirm needs a person reading it). One pending
// at a time, 10 minutes, 3 wrong codes end it; a made passkey waiting for its code
// blocks a new set-up until it is confirmed or expires. A device's passkey goes with
// its revoke and with its approver mark (deviceEvent below).
//
// An assertion answers a challenge the server issued for one device and one purpose
// ("stop:<row id>"), used once, for 2 minutes. It must say the user was verified (UV),
// come from the page's own https origin, not cross-origin, name this device's
// credential, and its signature must check against the stored key. A sign count that
// moves must move up.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig } from 'node:crypto';
import { newCode } from './chat-devices.mjs';

export const REGISTER_TTL_MS = 10 * 60e3;
export const REGISTER_ATTEMPTS = 3;
export const CHALLENGE_TTL_MS = 2 * 60e3;
export const CHALLENGES_PER_DEVICE = 5;
export const B64URL_MAX = 4096;
// At most one "passkey made, waiting for its code" alert per device in this window.
export const PENDING_ALERT_MS = 10 * 60e3;
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = buf => createHash('sha256').update(buf).digest();
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
// A base64url field from the page, or null: bounded, and only the url alphabet.
export function b64(v, max = B64URL_MAX) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return Buffer.from(v, 'base64url');
}

async function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// clientDataJSON, checked for its type, challenge and origin; a reason or null.
export function clientDataProblem(buf, { type, challenge, origin }) {
  let d;
  try { d = JSON.parse(buf.toString('utf8')); } catch { return 'client data is not JSON'; }
  if (!isObject(d)) return 'client data is not an object';
  if (d.type !== type) return `client data is not ${type}`;
  if (typeof d.challenge !== 'string' || !same(d.challenge, challenge)) return 'the challenge does not match';
  if (typeof d.origin !== 'string' || d.origin !== origin) return 'the origin does not match';
  if (d.crossOrigin === true) return 'a cross-origin frame may not step up';
  return null;
}

// The fixed head of authenticator data: rpIdHash (32), flags (1), signCount (4).
export function authDataProblem(buf, rpId) {
  if (buf.length < 37) return { problem: 'authenticator data is too short' };
  if (!sha256(Buffer.from(rpId)).equals(buf.subarray(0, 32))) return { problem: 'the passkey is for another site' };
  const flags = buf[32];
  if (!(flags & FLAG_UP)) return { problem: 'the user was not present' };
  if (!(flags & FLAG_UV)) return { problem: 'the user was not verified (Face ID or the passcode)' };
  return { problem: null, flags, signCount: buf.readUInt32BE(33) };
}

// The credential id and the P-256 key in a registration's authenticator data: the id
// is read from the attested credential data (AAGUID 16, length 2, id), and the key is
// checked by finding COSE's x (-2) and y (-3) as 32-byte strings after it (0x21 0x58
// 0x20 x, 0x22 0x58 0x20 y). A reason or null.
export function attestedProblem(authData, credentialId, spkiDer) {
  if (!(authData[32] & FLAG_AT)) return 'no attested credential in the authenticator data';
  if (authData.length < 55) return 'attested credential data is too short';
  const idLen = authData.readUInt16BE(53);
  const id = authData.subarray(55, 55 + idLen);
  if (id.length !== idLen || !id.equals(credentialId)) return 'the credential id does not match the authenticator data';
  let jwk;
  try {
    const key = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return 'only ES256 (P-256) passkeys are accepted';
    jwk = key.export({ format: 'jwk' });
  } catch { return 'the public key is not a key'; }
  const cose = authData.subarray(55 + idLen);
  const x = Buffer.concat([Buffer.from([0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url')]);
  const y = Buffer.concat([Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')]);
  if (cose.indexOf(x) < 0 || cose.indexOf(y) < 0) return 'the public key is not the one in the authenticator data';
  return null;
}

export function createStepUp({ path, now = () => Date.now(), onEvent = () => {}, rpName = 'Jarvis OS' }) {
  let creds = [];            // { deviceId, credId, spki, rpId, signCount, createdAt, confirmedBy }
  let pending = null;        // { deviceId, deviceName, challenge, rpId, origin, at, cred, code, attempts }
  const challenges = new Map(); // challenge -> { deviceId, purpose, rpId, origin, at }
  const alertedAt = new Map();  // device id -> when its last passkey-pending alert went
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  const persist = () => writeJson(path, creds);

  async function load() {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      creds = Array.isArray(raw) ? raw.filter(c => isObject(c) && typeof c.deviceId === 'string' && typeof c.credId === 'string' && typeof c.spki === 'string' && typeof c.rpId === 'string') : [];
    } catch { creds = []; }
    return creds.length;
  }
  const credOf = deviceId => creds.find(c => c.deviceId === deviceId) ?? null;
  const has = deviceId => credOf(deviceId) !== null;
  const sweep = at => { for (const [k, c] of challenges) if (at - c.at > CHALLENGE_TTL_MS) challenges.delete(k); };
  const live = at => (pending && at - pending.at < REGISTER_TTL_MS && pending.attempts < REGISTER_ATTEMPTS ? pending : null);

  // Step 1, on an approver device: the creation options. A newer ask replaces an
  // unconfirmed one from the same device; another device's waits it out.
  function registerOptions(device, origin) {
    const at = now();
    const p = live(at);
    if (p && p.deviceId !== device.id) return { ok: false, status: 409, error: 'another device is setting up Face ID; confirm or wait 10 minutes' };
    // A made passkey waits for its code: no second one over it (Ultron's L2).
    if (p && p.cred) return { ok: false, status: 409, error: 'a Face ID set-up from this device is waiting for its code at the Mac mini; confirm it there or wait 10 minutes' };
    const rpId = new URL(origin).hostname;
    const challenge = randomBytes(32).toString('base64url');
    pending = { deviceId: device.id, deviceName: device.name, challenge, rpId, origin, at, cred: null, code: null, attempts: 0 };
    return {
      ok: true,
      options: {
        challenge, timeout: REGISTER_TTL_MS, attestation: 'none',
        rp: { id: rpId, name: rpName },
        user: { id: Buffer.from(device.id).toString('base64url'), name: device.name, displayName: device.name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        excludeCredentials: has(device.id) ? [{ type: 'public-key', id: credOf(device.id).credId }] : []
      }
    };
  }

  // Step 2: the made passkey, checked, kept pending behind a code.
  function register(device, body, origin) {
    const at = now();
    const p = live(at);
    if (!p || p.deviceId !== device.id || p.cred) return { ok: false, status: 409, error: 'no Face ID set-up is waiting for this device; start again' };
    if (origin !== p.origin) return { ok: false, status: 403, error: 'the set-up must finish on the page that started it' };
    const clientData = b64(body?.clientDataJSON), authData = b64(body?.authenticatorData), spki = b64(body?.publicKey), credId = b64(body?.credentialId, 1400);
    if (!clientData || !authData || !spki || !credId) return { ok: false, status: 400, error: 'the passkey fields are missing or malformed' };
    const why = clientDataProblem(clientData, { type: 'webauthn.create', challenge: p.challenge, origin: p.origin })
      ?? authDataProblem(authData, p.rpId).problem
      ?? attestedProblem(authData, credId, spki);
    if (why) { pending = null; return { ok: false, status: 400, error: why }; }
    p.cred = { deviceId: device.id, credId: credId.toString('base64url'), spki: spki.toString('base64url'), rpId: p.rpId, signCount: authData.readUInt32BE(33), createdAt: at };
    p.code = newCode();
    const last = alertedAt.get(device.id);
    if (last === undefined || at - last >= PENDING_ALERT_MS) {
      alertedAt.set(device.id, at);
      onEvent({ kind: 'passkey-pending', device: { id: device.id, name: device.name } });
    }
    return { ok: true, code: p.code, expiresAt: p.at + REGISTER_TTL_MS };
  }

  // Step 3, on the machine only (admin socket): the code makes the passkey count.
  function confirm(code, { by = 'chat-pair on this machine', isApprover = () => false, name } = {}) {
    return serial(async () => {
      const p = live(now());
      if (!p || !p.cred) { pending = null; return { ok: false, status: 404, error: 'no Face ID set-up is waiting' }; }
      // The device name typed back at the terminal (chat-pair shows it): a wrong one
      // counts as a wrong try.
      if (typeof name !== 'string' || name.trim().toLowerCase() !== p.deviceName.toLowerCase()) {
        p.attempts++;
        if (p.attempts >= REGISTER_ATTEMPTS) { pending = null; onEvent({ kind: 'passkey-failed', by }); return { ok: false, status: 429, error: 'too many wrong tries; set up Face ID again' }; }
        return { ok: false, status: 400, error: 'the device name typed does not match the set-up' };
      }
      if (typeof code !== 'string' || !same(code.trim().toUpperCase(), p.code)) {
        p.attempts++;
        if (p.attempts >= REGISTER_ATTEMPTS) { pending = null; onEvent({ kind: 'passkey-failed', by }); return { ok: false, status: 429, error: 'too many wrong codes; set up Face ID again' }; }
        return { ok: false, status: 400, error: 'wrong code' };
      }
      // The device must still be an approver now, not only when it asked.
      if (!isApprover(p.deviceId)) { pending = null; return { ok: false, status: 403, error: 'that device is no longer a paired approver' }; }
      creds = creds.filter(c => c.deviceId !== p.deviceId);
      creds.push({ ...p.cred, confirmedBy: by });
      pending = null;
      await persist();
      onEvent({ kind: 'passkey-added', device: { id: p.deviceId, name: p.deviceName }, by });
      return { ok: true, name: p.deviceName };
    });
  }

  // A challenge for one device and one purpose; null when the device has no passkey.
  function challenge(deviceId, purpose, origin) {
    const at = now();
    sweep(at);
    const c = credOf(deviceId);
    if (!c) return { ok: false, status: 403, error: 'set up Face ID on this device first' };
    if (new URL(origin).hostname !== c.rpId) return { ok: false, status: 403, error: 'this page is not where Face ID was set up' };
    const mine = [...challenges].filter(([, v]) => v.deviceId === deviceId);
    // Oldest first out, so a page that keeps asking holds at most a few.
    while (mine.length >= CHALLENGES_PER_DEVICE) challenges.delete(mine.shift()[0]);
    const value = randomBytes(32).toString('base64url');
    challenges.set(value, { deviceId, purpose, origin, at });
    return { ok: true, publicKey: { challenge: value, rpId: c.rpId, timeout: CHALLENGE_TTL_MS, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: c.credId }] } };
  }

  // An assertion for one device and one purpose. The challenge it answers is spent
  // whatever the outcome.
  function verifyAssertion(deviceId, purpose, body, origin) {
    return serial(async () => {
      const at = now();
      sweep(at);
      const clientData = b64(body?.clientDataJSON), authData = b64(body?.authenticatorData), sig = b64(body?.signature, 512), credId = b64(body?.credentialId, 1400);
      if (!clientData || !authData || !sig || !credId) return { ok: false, status: 400, error: 'the Face ID answer is missing or malformed' };
      let sent;
      try { sent = JSON.parse(clientData.toString('utf8'))?.challenge; } catch { sent = null; }
      const ch = typeof sent === 'string' ? challenges.get(sent) : undefined;
      if (typeof sent === 'string') challenges.delete(sent);
      if (!ch || at - ch.at > CHALLENGE_TTL_MS) return { ok: false, status: 403, error: 'the Face ID check expired; try again' };
      if (ch.deviceId !== deviceId || ch.purpose !== purpose) return { ok: false, status: 403, error: 'the Face ID check was for something else' };
      const c = credOf(deviceId);
      if (!c) return { ok: false, status: 403, error: 'set up Face ID on this device first' };
      if (!credId.equals(Buffer.from(c.credId, 'base64url'))) return { ok: false, status: 403, error: 'that passkey is not this device\'s' };
      const why = clientDataProblem(clientData, { type: 'webauthn.get', challenge: sent, origin }) ?? (origin === ch.origin ? null : 'the origin does not match');
      if (why) return { ok: false, status: 403, error: why };
      const head = authDataProblem(authData, c.rpId);
      if (head.problem) return { ok: false, status: 403, error: head.problem };
      let good = false;
      try {
        const key = createPublicKey({ key: Buffer.from(c.spki, 'base64url'), format: 'der', type: 'spki' });
        good = verifySig('sha256', Buffer.concat([authData, sha256(clientData)]), { key, dsaEncoding: 'der' }, sig);
      } catch { good = false; }
      if (!good) return { ok: false, status: 403, error: 'the Face ID signature does not check' };
      // A counter that moves must move up (a cloned key repeats one); passkeys that
      // sync keep it at 0, which is allowed.
      if ((head.signCount !== 0 || c.signCount !== 0) && head.signCount <= c.signCount) return { ok: false, status: 403, error: 'the passkey\'s counter went backwards' };
      if (head.signCount !== c.signCount) { c.signCount = head.signCount; await persist(); }
      return { ok: true };
    });
  }

  // A revoked device's passkey goes, and any set-up it had waiting.
  function forget(deviceId) {
    return serial(async () => {
      if (pending?.deviceId === deviceId) pending = null;
      for (const [k, v] of challenges) if (v.deviceId === deviceId) challenges.delete(k);
      const before = creds.length;
      creds = creds.filter(c => c.deviceId !== deviceId);
      if (creds.length !== before) await persist();
      return before - creds.length;
    });
  }

  // For the page: until when this device's made passkey waits for its code, or null; never the code.
  const pendingFor = deviceId => { const p = live(now()); return p && p.deviceId === deviceId && p.cred ? p.at + REGISTER_TTL_MS : null; };
  // For chat-pair at the terminal: which device and when; never the code.
  const pendingInfo = () => { const p = live(now()); return p && p.cred ? { name: p.deviceName, at: p.at, expiresAt: p.at + REGISTER_TTL_MS } : null; };
  return { load, has, registerOptions, register, confirm, challenge, verifyAssertion, forget, pendingFor, pendingInfo };
}

// The device store's events that end a passkey: a revoke, and the approver mark taken
// off (Ultron's L4: a passkey belongs only to an approver). server.mjs calls this
// from the device store's onEvent; null when the event ends nothing.
export function deviceEvent(stepUp, event) {
  const id = event?.device?.id;
  if (typeof id !== 'string') return null;
  if (event.kind === 'revoked' || (event.kind === 'approver-changed' && event.on === false)) return stepUp.forget(id);
  return null;
}
