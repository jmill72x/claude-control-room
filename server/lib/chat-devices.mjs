// Paired devices and the pairing flow (jarvis-os-chat-spec.md, §2.2). A device is
// a browser that holds the `__Host-jos` cookie: 32 random bytes, of which only the
// sha256 is kept in `server/data/chat/devices.json`. Pairing: the new device asks
// for a code (6 letters, 10 minutes, 3 attempts, one pending at a time) and a short
// pairing cookie; a device already paired, or `bin/chat-pair` on the machine over the
// admin socket, approves the code; the new device then collects its cookie. At most
// 4 active devices; a revoked one keeps its row with `revokedAt`.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = '__Host-jos';
export const PAIR_COOKIE_NAME = '__Host-jos-pair';
export const COOKIE_MAX_AGE_S = 34560000; // 400 days
export const PAIR_CODE_TTL_MS = 10 * 60e3;
export const PAIR_ATTEMPTS = 3;
export const DEVICES_MAX = 4;
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L or O: read aloud, typed on a phone
const NAME_MAX = 40;

const sha256 = v => createHash('sha256').update(v).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const newToken = () => randomBytes(32).toString('base64url');
export function newCode() {
  const bytes = randomBytes(6);
  return [...bytes].map(b => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}
export const cleanName = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

// The cookie header's value, and how to read ours back out of a Cookie header.
export const cookieHeader = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearCookieHeader = name => `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

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

export function createDeviceStore({ path, now = () => Date.now(), onEvent = () => {} }) {
  let devices = [];
  let pending = null; // { code, name, tokenSha256, createdAt, attempts }
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

  async function load() {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      devices = Array.isArray(raw) ? raw.filter(d => isObject(d) && typeof d.id === 'string' && typeof d.tokenSha256 === 'string') : [];
    } catch {
      devices = [];
    }
    return devices.length;
  }
  const persist = () => writeJson(path, devices);
  const active = () => devices.filter(d => !d.revokedAt);

  // The device a request's cookie names, or null. `lastSeenAt` moves at most once a minute.
  function authenticate(cookieHeader) {
    const token = readCookie(cookieHeader, COOKIE_NAME);
    if (!token || token.length > 128) return null;
    const hash = sha256(token);
    const d = active().find(x => same(x.tokenSha256, hash));
    if (!d) return null;
    const at = now();
    if (!d.lastSeenAt || at - d.lastSeenAt > 60e3) { d.lastSeenAt = at; serial(persist); }
    return { id: d.id, name: d.name, login: d.login ?? null };
  }

  // Step 1: a new device asks to pair. One pending at a time; a stale one is replaced.
  function start(name) {
    return serial(async () => {
      const clean = cleanName(name);
      if (!clean) return { ok: false, status: 400, error: 'name must be a short line' };
      if (active().length >= DEVICES_MAX) return { ok: false, status: 409, error: `at most ${DEVICES_MAX} devices can be paired; revoke one first` };
      if (pending && now() - pending.createdAt < PAIR_CODE_TTL_MS && pending.attempts < PAIR_ATTEMPTS) {
        return { ok: false, status: 409, error: 'a pairing is already pending; approve it or wait 10 minutes' };
      }
      const pairToken = newToken();
      pending = { code: newCode(), name: clean, pairSha256: sha256(pairToken), createdAt: now(), attempts: 0, approved: false, token: null };
      return { ok: true, code: pending.code, name: clean, pairToken, expiresAt: pending.createdAt + PAIR_CODE_TTL_MS };
    });
  }

  // Step 2: a paired device (or the machine's owner) approves the code. The new
  // device's cookie value is minted here and handed over at step 3.
  function approve(code, { by = 'a paired device', login = null } = {}) {
    return serial(async () => {
      if (!pending || now() - pending.createdAt >= PAIR_CODE_TTL_MS) { pending = null; return { ok: false, status: 404, error: 'no pairing is pending' }; }
      if (pending.attempts >= PAIR_ATTEMPTS) { pending = null; return { ok: false, status: 429, error: 'too many wrong codes; start the pairing again' }; }
      if (pending.approved) return { ok: false, status: 409, error: 'already approved; the device collects its cookie next' };
      if (typeof code !== 'string' || !same(code.trim().toUpperCase(), pending.code)) {
        pending.attempts++;
        if (pending.attempts >= PAIR_ATTEMPTS) { pending = null; onEvent({ kind: 'pairing-failed', by }); return { ok: false, status: 429, error: 'too many wrong codes; start the pairing again' }; }
        return { ok: false, status: 400, error: 'wrong code' };
      }
      pending.approved = true;
      pending.token = newToken();
      pending.login = login;
      pending.by = by;
      return { ok: true, name: pending.name };
    });
  }

  // Step 3: the new device, holding its pairing cookie, collects the real one.
  function status(pairCookieHeader) {
    return serial(async () => {
      const pairToken = readCookie(pairCookieHeader, PAIR_COOKIE_NAME);
      if (!pending || !pairToken || !same(sha256(pairToken), pending.pairSha256)) return { ok: true, state: 'none' };
      if (now() - pending.createdAt >= PAIR_CODE_TTL_MS) { pending = null; return { ok: true, state: 'expired' }; }
      if (!pending.approved) return { ok: true, state: 'pending', expiresAt: pending.createdAt + PAIR_CODE_TTL_MS };
      const device = { id: randomBytes(8).toString('hex'), name: pending.name, createdAt: now(), lastSeenAt: now(), login: pending.login, tokenSha256: sha256(pending.token), revokedAt: null };
      devices.push(device);
      await persist();
      const token = pending.token;
      const by = pending.by;
      pending = null;
      onEvent({ kind: 'paired', device: { id: device.id, name: device.name }, by });
      return { ok: true, state: 'paired', token, device: { id: device.id, name: device.name } };
    });
  }

  function revoke(id, by) {
    return serial(async () => {
      const d = devices.find(x => x.id === id && !x.revokedAt);
      if (!d) return { ok: false, status: 404, error: 'no such device' };
      d.revokedAt = now();
      // An approved pairing not yet collected goes too: whichever device asked for
      // it, a revoke must never leave a cookie waiting to be picked up.
      if (pending?.approved) pending = null;
      await persist();
      onEvent({ kind: 'revoked', device: { id: d.id, name: d.name }, by });
      return { ok: true };
    });
  }

  const list = () => devices.map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null, revokedAt: d.revokedAt ?? null }));
  // Whether a device is still paired: what an open stream re-checks on every ping.
  const isActive = id => active().some(d => d.id === id);

  return { load, authenticate, start, approve, status, revoke, list, isActive, pendingCode: () => (pending && !pending.approved ? pending.code : null) };
}
