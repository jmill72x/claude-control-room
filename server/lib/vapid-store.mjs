// Making the chat's VAPID key and putting it in the login Keychain, for
// bin/vapid-keygen (jarvis-os-chat-spec.md, §3), and reading it back. The private
// key never reaches argv, a file or the terminal: it goes to `security -i` on stdin,
// so `ps` can't see it either, and a read takes it from security's stdout into
// memory only. Only the public key is printed; it is public by design.
//
// Every call names the login Keychain's file: `security` given no keychain searches
// the user's list, and given one that doesn't exist it writes to the login Keychain
// anyway. That was seen in a manual probe during development, not by the tests: it
// left a stray item (service zz-test, account zz-test), deleted on 2026-11-11 with
// the owner's OK. So the path is spelled out and checked, and tests must only ever
// call `security` through the injected fake `run`, never the real one.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newVapidKeys, vapidKeys } from './webpush.mjs';

export const KEYCHAIN_SERVICE = 'claude-control-room';
export const KEYCHAIN_ACCOUNT = 'vapid-private-key';
export const LOGIN_KEYCHAIN = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
// security's errSecItemNotFound: the one exit that means "no such item".
export const NOT_FOUND = 44;
const SECURITY = '/usr/bin/security';
// An absolute path `security -i` reads as one word: no space, quote or backslash.
const KEYCHAIN_PATH = /^\/[^\s"'\\]+$/;

// Run `security` with argv and optional stdin; resolve { code, stderr }, plus
// `stdout` only when asked (`capture`, for a read with -w). Otherwise stdout is
// dropped unread. Whatever comes back is never logged or printed.
export function runSecurity(args, input = null, { capture = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(SECURITY, args, { stdio: ['pipe', capture ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    const out = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderr += c; });
    if (capture) child.stdout.on('data', c => out.push(c));
    child.on('error', err => resolve({ code: 127, stderr: String(err.message) }));
    child.on('close', code => resolve({ code: code ?? 1, stderr, ...(capture ? { stdout: Buffer.concat(out).toString('utf8') } : {}) }));
    child.stdin.end(input ?? '');
  });
}

const ITEM = ['-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT];
const checkPath = keychain => {
  if (typeof keychain !== 'string' || !KEYCHAIN_PATH.test(keychain)) throw new Error('the keychain path must be absolute, with no spaces or quotes');
};

// Whether the item exists (metadata only: no -w, so no key is read). Only exit 44
// means absent; any other failure throws, so a locked or unreadable Keychain is
// never taken for an empty one (and a key never silently made over it).
export async function keyExists({ run = runSecurity, keychain = LOGIN_KEYCHAIN } = {}) {
  checkPath(keychain);
  const r = await run(['find-generic-password', ...ITEM, keychain]);
  if (r.code === 0) return true;
  if (r.code === NOT_FOUND) return false;
  throw new Error(`security could not look for the key (exit ${r.code})`);
}

// The stored private key, read with -w into memory; null when the item is absent
// (exit 44), an error on any other failure. Never logged.
export async function readStoredKey({ run = runSecurity, keychain = LOGIN_KEYCHAIN } = {}) {
  checkPath(keychain);
  const r = await run(['find-generic-password', ...ITEM, '-w', keychain], null, { capture: true });
  if (r.code === NOT_FOUND) return null;
  if (r.code !== 0) throw new Error(`security could not read the key (exit ${r.code})`);
  const v = String(r.stdout ?? '').trim();
  return v || null;
}

// Make a key and store it. Refuses to replace an existing one unless asked: a new
// key orphans every device's subscription until each turns notifications on again.
// After storing, the item is read back and its public key compared with the new
// one, so what the server will read is proven to be the key whose public half is
// shown. Answers { ok, publicKey } or { ok: false, error }; the error never holds
// the key.
export async function storeNewKey({ replace = false, run = runSecurity, make = newVapidKeys, keychain = LOGIN_KEYCHAIN } = {}) {
  let exists;
  try { exists = await keyExists({ run, keychain }); } catch (err) { return { ok: false, error: `${err.message}; nothing was stored` }; }
  if (exists && !replace) {
    return { ok: false, exists: true, error: 'a VAPID key is already in the Keychain; run again with --replace to make a new one (each device then turns notifications on again)' };
  }
  const keys = make();
  if (vapidKeys(keys.privateKey).publicKey !== keys.publicKey) return { ok: false, error: 'the new key did not check out; nothing was stored' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(keys.privateKey)) return { ok: false, error: 'the new key is not 32 bytes of base64url; nothing was stored' };
  const line = `add-generic-password -U ${ITEM.join(' ')} -w ${keys.privateKey} ${keychain}\n`;
  const r = await run(['-i'], line);
  if (r.code !== 0) return { ok: false, error: `security could not store the key (exit ${r.code})` };
  let back;
  try { back = await readStoredKey({ run, keychain }); } catch (err) { return { ok: false, error: `the key was stored, but ${err.message.replace(/^security/, 'security then')}; check the Keychain item and run again with --replace` }; }
  if (!back) return { ok: false, error: 'the key was not found in the Keychain after storing it' };
  let backPublic = null;
  try { backPublic = vapidKeys(back).publicKey; } catch { backPublic = null; }
  if (backPublic !== keys.publicKey) {
    return { ok: false, error: 'MISMATCH: the key read back from the Keychain is not the one just made, so the server would sign with a different key; check the Keychain item and run again with --replace' };
  }
  return { ok: true, publicKey: keys.publicKey };
}
