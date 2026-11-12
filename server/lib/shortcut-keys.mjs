// Shortcut keys (docs/design/2026-11-12-jarvis-os-shortcuts.md): what an iPhone
// Shortcut holds so it can send into the chat. A key is not a paired device: it lives
// in its own file (`server/data/chat/shortcut-keys.json`, 0600, only the sha256 of each
// key), it travels in an `Authorization: Bearer` header and never as a cookie, and the
// only routes that take one are the two under `/api/shortcut/` that send (a message, a
// presence event). It can't read the thread, open a stream, answer a permission, pair
// or approve anything: those routes take the device cookie, which a key is not.
//
// Pairing never shows, types or copies a key. A paired device makes a one-time code on
// the page (6 letters, 10 minutes, one at a time: a new one replaces the last), or
// `bin/chat-pair shortcut-code <name>` does on the machine. The Shortcut sends that
// code once and gets its key in the answer, which it saves to a file on the phone;
// only the key's hash stays here. Three wrong codes end the code. At most 4 active
// keys; a revoked or expired one keeps its row. A key's name is plain ASCII, 22 characters at
// most, with no brackets or commas: a message's `device` is that name plus
// " (Shortcut…)", cut at 40 UTF-16 units by the store, and the lead reads that mark, so
// no name may push it out or imitate it. Each key remembers the device that made its
// code; revoking that device revokes the keys it made.
//
// A keys file that can't be parsed is never written over: it is set aside under
// another name (or, when only some entries are bad, copied aside) and logged; a file
// that can't be read or set aside makes `load` throw, and the caller keeps Shortcut
// keys off.
//
// Each key remembers the addresses it was used from (what the proxy reported, at most
// 4): the first use from one it has not seen is reported, so a key copied to another
// machine shows up. It is a tripwire, not a lock: a phone can reach the proxy over
// either of its tailnet addresses, so pinning one would break it.
//
// A key that is not used for 30 days stops working (KEY_IDLE_DAYS). A use is a message
// or a presence report the key made: `used` records it, and only that moves the clock,
// so a phone in daily use never meets the limit, and no refused or repeated request
// keeps a key alive unseen. A key with no last use on file (never used, or made before
// this rule) counts from when it was made. Nothing is stored for it: whether a key has
// expired is worked out from those two times on every look. An expired key can't send,
// holds none of the 4 places and keeps its row, and the only way back is a new code and
// a new key. It can still be revoked, and a device revoke takes it too: a revoke is on
// file, so it holds whatever the clock or the build later says.
import { readFile, writeFile, rename, unlink, copyFile, chmod } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { newCode, cleanName, PAIR_CODE_TTL_MS, PAIR_ATTEMPTS } from './chat-devices.mjs';
import { oneLine } from './chat-events.mjs';

export const KEYS_MAX = 4;
// A message's `device` is cut at 40 UTF-16 units, and the key's name goes there with a
// suffix of at most 18 (" (Shortcut, share)"). An ASCII name of 22 at most is 22 units,
// so the suffix always survives whole.
export const KEY_NAME_MAX = 22;
// Letters, digits, spaces and . _ ' - only (the events module's plain-name shape, less
// the brackets, so a name can't look like the mark).
export const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,21}$/;
export const isKeyName = v => typeof v === 'string' && KEY_NAME.test(v);
export const KEY_NAME_WORDS = "name must be plain: letters, digits, spaces and . _ ' - only, 22 at most";
// What a key whose stored name is not plain (a file edited by hand) is called.
export const UNNAMED = 'unnamed key';
export const KEY_PREFIX = 'jsk_';
export const ADDRS_MAX = 4;
// How long a key lives without a use. A fixed rule, not a setting: like the other limits
// here, config can switch Shortcut keys on or off and nothing else.
export const KEY_IDLE_DAYS = 30;
export const KEY_IDLE_MS = KEY_IDLE_DAYS * 24 * 3600e3;
const KEY_SHAPE = /^jsk_[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY_MS = 60e3;

const sha256 = v => createHash('sha256').update(v).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const newSecret = () => randomBytes(32).toString('base64url');

// A time read back from the file: a positive number of milliseconds, or null.
const time = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
// When a key stops working unless it is used first: KEY_IDLE_MS after its last use, or
// after it was made when no last use is on file. Null when the row has neither time.
export function keyExpiresAt(k) {
  const from = time(k?.lastUsedAt) ?? time(k?.createdAt);
  return from === null ? null : from + KEY_IDLE_MS;
}
// Expired at `at`: the idle time has run out, or the row has no time to count from (a
// key that can't be shown to be fresh is not). Written so anything unreadable is expired.
export function keyExpired(k, at) {
  const until = keyExpiresAt(k);
  return until === null || !(at < until);
}

// A key's name as given: one clean line (the device rule), a phone keyboard's curly
// apostrophe made a plain one, then it must be a plain name or it is refused ('').
// Never cut to fit: a name that was cut is not the name that was asked for.
const CURLY = [String.fromCodePoint(0x2018), String.fromCodePoint(0x2019)];
export function cleanKeyName(v) {
  let name = cleanName(v);
  for (const q of CURLY) name = name.replaceAll(q, "'");
  return isKeyName(name) ? name : '';
}

// The key in an Authorization header, or null: `Bearer jsk_…`, nothing else.
export function readBearer(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  return m && KEY_SHAPE.test(m[1]) ? m[1] : null;
}

// The one address the proxy says a request came from, or null: X-Forwarded-For holding
// exactly one IP. Anything else (absent, a list, not an address) is "unknown" and is
// neither remembered nor reported.
export function proxyAddress(headers) {
  const raw = headers?.['x-forwarded-for'];
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return isIP(v) ? v.toLowerCase() : null;
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

export function createShortcutKeys({ path, now = () => Date.now(), onEvent = () => {}, log = console.log }) {
  let keys = [];
  let pending = null; // { code, name, createdAt, attempts, by, byId }: a code waiting for its Shortcut
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

  const validRow = k => isObject(k) && typeof k.id === 'string' && typeof k.keySha256 === 'string';
  // A file that is there but is not a list of keys is set aside, never written over;
  // one with some bad entries is copied aside and the good ones kept. Missing is empty.
  // Anything that can't be read or set aside throws.
  async function load() {
    let text;
    try { text = await readFile(path, 'utf8'); } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      keys = [];
      return 0;
    }
    let raw = null;
    try { raw = JSON.parse(text); } catch { raw = null; }
    const aside = `${path}.corrupt-${now()}`;
    if (!Array.isArray(raw)) {
      await rename(path, aside);
      log(`shortcut: the keys file was not a list of keys; it was set aside as ${basename(aside)} and no key is known`);
      keys = [];
      return 0;
    }
    keys = raw.filter(validRow);
    if (keys.length !== raw.length) {
      await copyFile(path, aside);
      await chmod(aside, 0o600);
      log(`shortcut: ${raw.length - keys.length} of ${raw.length} entries in the keys file could not be read; a copy of the file was kept as ${basename(aside)}`);
    }
    return keys.length;
  }
  const persist = () => writeJson(path, keys);
  // A write nothing waits for (a use, a new address). A failed one is logged: a last
  // use that never reached the file would let the key expire early after a restart.
  const saveSoon = () => { serial(persist).catch(err => log(`shortcut: the keys file could not be written (${err?.code ?? err?.name ?? 'error'}); a key's last use may be lost at the next restart`)); };
  // The keys that work: not revoked, and used (or made) within the idle limit.
  const active = () => { const at = now(); return keys.filter(k => !k.revokedAt && !keyExpired(k, at)); };
  const fresh = () => pending !== null && now() - pending.createdAt < PAIR_CODE_TTL_MS;

  // Step 1, on the page (a paired device) or on the machine: a code for one new key,
  // with the key's name. A code still waiting is replaced, so the newest one shown
  // is always the one that works.
  // `by` is the maker's name for the alerts; `byId` its device id (null from the machine).
  function mint(name, { by = 'a paired device', byId = null } = {}) {
    return serial(async () => {
      const clean = cleanKeyName(name);
      if (!clean) return { ok: false, status: 400, error: KEY_NAME_WORDS };
      if (active().length >= KEYS_MAX) return { ok: false, status: 409, error: `at most ${KEYS_MAX} Shortcut keys can be active; revoke one first` };
      pending = { code: newCode(), name: clean, createdAt: now(), attempts: 0, by, byId: typeof byId === 'string' ? byId : null };
      onEvent({ kind: 'shortcut-code-made', name: clean, by });
      return { ok: true, code: pending.code, name: clean, expiresAt: pending.createdAt + PAIR_CODE_TTL_MS };
    });
  }

  // Step 2, from the Shortcut: the code, once. The key is minted here and handed over
  // in the answer; only its hash is kept. A wrong code counts, and the third ends the
  // code whoever sent it.
  function claim(code, { addr = null } = {}) {
    return serial(async () => {
      if (!fresh()) { pending = null; return { ok: false, status: 404, error: 'no Shortcut code is waiting' }; }
      if (typeof code !== 'string' || !same(code.trim().toUpperCase(), pending.code)) {
        pending.attempts++;
        if (pending.attempts >= PAIR_ATTEMPTS) { const { by } = pending; pending = null; onEvent({ kind: 'shortcut-pairing-failed', by }); return { ok: false, status: 429, error: 'too many wrong codes; make a new code' }; }
        return { ok: false, status: 400, error: 'wrong code' };
      }
      const { name, by, byId } = pending;
      pending = null;
      // Checked again here: the file may have gained a key since the code was made.
      if (active().length >= KEYS_MAX) return { ok: false, status: 409, error: `at most ${KEYS_MAX} Shortcut keys can be active; revoke one first` };
      const key = KEY_PREFIX + newSecret();
      const row = { id: randomBytes(8).toString('hex'), name, createdAt: now(), lastUsedAt: null, uses: 0, keySha256: sha256(key), revokedAt: null, addrs: addr ? [addr] : [], madeBy: by, madeById: byId };
      keys.push(row);
      await persist();
      onEvent({ kind: 'shortcut-paired', key: { id: row.id, name: row.name }, by });
      return { ok: true, key, id: row.id, name: row.name };
    });
  }

  // The key a request's Authorization header names: `{ key, expired }`. `key` is the
  // key, or null when the header names none that works (missing, wrong, revoked or
  // expired). `expired` is then the key it did match when that key's idle time has run
  // out, so the route can say why; only a holder of the real key ever learns that. A
  // look is not a use: it never moves the idle clock (`used` does). The file is written
  // at once for a new address.
  function check(header, { addr = null } = {}) {
    const none = { key: null, expired: null };
    const secret = readBearer(header);
    if (!secret) return none;
    const hash = sha256(secret);
    const row = keys.find(k => !k.revokedAt && same(k.keySha256, hash));
    if (!row) return none;
    // A name that is not plain (a file edited by hand) never reaches a message's device.
    const named = { id: row.id, name: isKeyName(row.name) ? row.name : UNNAMED };
    if (keyExpired(row, now())) return { key: null, expired: named };
    if (!Array.isArray(row.addrs)) row.addrs = [];
    if (addr !== null && !row.addrs.includes(addr)) {
      // Remembered while there is room; past that it is reported each time (the
      // alert limiter holds repeats back), never silently accepted as known.
      if (row.addrs.length < ADDRS_MAX) row.addrs.push(addr);
      // The address goes to the service log only; the pushed words leave it out.
      log(oneLine(`shortcut: the key ${row.name} was used from ${addr}, an address it had not used before`));
      onEvent({ kind: 'shortcut-new-address', key: { id: row.id, name: row.name }, addr });
      saveSoon();
    }
    return { key: named, expired: null };
  }
  // The same look as a plain answer, the key or null, so a caller that only asks "does
  // this key work" can't take an expired one for a yes.
  const authenticate = (header, opts) => check(header, opts).key;

  // A use: the key made a message or a presence report (lib/shortcut-routes.mjs calls
  // this then, and at no other time). It counts, and it is what the idle expiry runs
  // from. The file is written at most once a minute for it; a last use that reads as
  // later than now (the clock was set back) is written over.
  function used(id) {
    const at = now();
    const row = active().find(k => k.id === id);
    if (!row) return false;
    row.uses = (Number.isInteger(row.uses) ? row.uses : 0) + 1;
    // How long since the last use on file (since forever when there is none).
    const since = at - (time(row.lastUsedAt) ?? 0);
    if (since > TOUCH_EVERY_MS || since < 0) {
      row.lastUsedAt = at;
      saveSoon();
    }
    return true;
  }

  // Revoke one key, by id or by exact name. An expired key can be revoked like any
  // other that is not revoked yet: expiry is worked out from the clock, a revoke is
  // written down, so only a revoke outlives a clock set back or an older build. An id
  // means that row, working or expired. A name means the working key of that name when
  // there is one (a phone paired again after its key expired keeps the name), and an
  // expired one only when no working key has it.
  function revoke(which, by) {
    return serial(async () => {
      const at = now();
      const open = typeof which === 'string' ? keys.filter(k => !k.revokedAt && (k.id === which || k.name === which)) : [];
      const first = open.filter(k => k.id === which || !keyExpired(k, at));
      const named = first.length > 0 ? first : open;
      if (named.length === 0) return { ok: false, status: 404, error: 'no such active Shortcut key' };
      if (named.length > 1) return { ok: false, status: 409, error: 'more than one active Shortcut key has that name; use its id' };
      const row = named[0];
      row.revokedAt = now();
      // A code not yet used goes too: a revoke must never leave a key waiting to be
      // picked up.
      pending = null;
      await persist();
      onEvent({ kind: 'shortcut-revoked', key: { id: row.id, name: row.name }, by });
      return { ok: true, key: { id: row.id, name: row.name } };
    });
  }

  // A paired device was revoked: every key whose code it made and that is not revoked
  // yet goes with it, expired ones too (so none of them can come back, whatever the
  // clock or the build), and so does a code it made that is still waiting. Answers the
  // keys revoked.
  function revokeMadeBy(deviceId, by) {
    return serial(async () => {
      if (typeof deviceId !== 'string' || deviceId === '') return [];
      if (pending?.byId === deviceId) pending = null;
      const rows = keys.filter(k => !k.revokedAt && k.madeById === deviceId);
      if (rows.length === 0) return [];
      for (const row of rows) row.revokedAt = now();
      pending = null;
      await persist();
      for (const row of rows) onEvent({ kind: 'shortcut-revoked', key: { id: row.id, name: row.name }, by });
      return rows.map(row => ({ id: row.id, name: row.name }));
    });
  }

  // What the page and the machine may see of the keys: never a hash or an address.
  // `madeBy` is the name of the device that made the key's code (or chat-pair's words).
  // `expiresAt` is when the key stops working unless it is used first (null once
  // revoked, or with no time on file), and `expired` whether that has passed, by this
  // machine's clock.
  const list = () => {
    const at = now();
    return keys.map(k => ({
      id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null, uses: Number.isInteger(k.uses) ? k.uses : 0,
      revokedAt: k.revokedAt ?? null, madeBy: typeof k.madeBy === 'string' ? k.madeBy : null,
      expiresAt: k.revokedAt ? null : keyExpiresAt(k), expired: !k.revokedAt && keyExpired(k, at)
    }));
  };

  // Whether a code is waiting for its Shortcut, and for which name (never the code).
  const waiting = () => (fresh() ? { name: pending.name, expiresAt: pending.createdAt + PAIR_CODE_TTL_MS } : null);

  return { load, mint, claim, check, authenticate, used, revoke, revokeMadeBy, list, waiting };
}
