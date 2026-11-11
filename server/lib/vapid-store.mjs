// Making the chat's VAPID key and putting it in the login Keychain, for
// bin/vapid-keygen (jarvis-os-chat-spec.md, §3). The private key never reaches
// argv, a file or the terminal: it goes to `security -i` on stdin, so `ps` can't
// see it either. Only the public key is printed; it is public by design.
import { spawn } from 'node:child_process';
import { newVapidKeys, vapidKeys } from './webpush.mjs';

export const KEYCHAIN_SERVICE = 'claude-control-room';
export const KEYCHAIN_ACCOUNT = 'vapid-private-key';
const SECURITY = '/usr/bin/security';

// Run `security` with argv and optional stdin; resolve { code, stderr } (stdout is
// dropped unread: it is never needed and must never be echoed).
export function runSecurity(args, input = null) {
  return new Promise(resolve => {
    const child = spawn(SECURITY, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', err => resolve({ code: 127, stderr: String(err.message) }));
    child.on('close', code => resolve({ code: code ?? 1, stderr }));
    child.stdin.end(input ?? '');
  });
}

// Whether the item exists (metadata only: no -w, so no key is read).
export async function keyExists({ run = runSecurity } = {}) {
  const r = await run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
  return r.code === 0;
}

// Make a key and store it. Refuses to replace an existing one unless asked: a new
// key orphans every device's subscription until each turns notifications on again.
// Answers { ok, publicKey } or { ok: false, error }; the error never holds the key.
export async function storeNewKey({ replace = false, run = runSecurity, make = newVapidKeys } = {}) {
  if (await keyExists({ run }) && !replace) {
    return { ok: false, exists: true, error: 'a VAPID key is already in the Keychain; run again with --replace to make a new one (each device then turns notifications on again)' };
  }
  const keys = make();
  if (vapidKeys(keys.privateKey).publicKey !== keys.publicKey) return { ok: false, error: 'the new key did not check out; nothing was stored' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(keys.privateKey)) return { ok: false, error: 'the new key is not 32 bytes of base64url; nothing was stored' };
  const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${keys.privateKey}\n`;
  const r = await run(['-i'], line);
  if (r.code !== 0) return { ok: false, error: `security could not store the key (exit ${r.code})` };
  if (!(await keyExists({ run }))) return { ok: false, error: 'the key was not found in the Keychain after storing it' };
  return { ok: true, publicKey: keys.publicKey };
}
