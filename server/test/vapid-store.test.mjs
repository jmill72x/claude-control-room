// bin/vapid-keygen's logic (lib/vapid-store.mjs) against a fake `security`: the key
// goes on stdin, never argv; an existing key is kept unless --replace; failures say
// so without the key. The real Keychain is never touched here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storeNewKey, keyExists, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from '../lib/vapid-store.mjs';
import { vapidKeys } from '../lib/webpush.mjs';

const fakeSecurity = ({ exists = false, addCode = 0, storesIt = true } = {}) => {
  const calls = [];
  let stored = exists;
  const run = async (args, input = null) => {
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') return { code: stored ? 0 : 44, stderr: '' };
    if (args[0] === '-i') { if (addCode === 0 && storesIt) stored = true; return { code: addCode, stderr: '' }; }
    return { code: 1, stderr: 'unexpected' };
  };
  return { run, calls };
};

test('a new key goes to security on stdin with the service and account; argv never holds it; only the public key comes back', async () => {
  const f = fakeSecurity();
  const r = await storeNewKey({ run: f.run });
  assert.equal(r.ok, true);
  const add = f.calls.find(c => c.args[0] === '-i');
  assert.deepEqual(add.args, ['-i']);
  const m = /^add-generic-password -U -s (\S+) -a (\S+) -w ([A-Za-z0-9_-]{43})\n$/.exec(add.input);
  assert.ok(m, add.input.replace(/-w \S+/, '-w <key>'));
  assert.equal(m[1], KEYCHAIN_SERVICE);
  assert.equal(m[2], KEYCHAIN_ACCOUNT);
  assert.equal(vapidKeys(m[3]).publicKey, r.publicKey, 'the stored key is the pair of the public key shown');
  for (const c of f.calls) assert.ok(!c.args.join(' ').includes(m[3]), 'never on argv');
  assert.ok(!JSON.stringify(r).includes(m[3]), 'never in the answer');
  for (const c of f.calls.filter(c => c.args[0] === 'find-generic-password')) assert.ok(!c.args.includes('-w'), 'existence is checked without reading the key');
});

test('an existing key is kept unless --replace', async () => {
  const f = fakeSecurity({ exists: true });
  const r = await storeNewKey({ run: f.run });
  assert.equal(r.ok, false);
  assert.match(r.error, /--replace/);
  assert.equal(f.calls.filter(c => c.args[0] === '-i').length, 0);
  const g = fakeSecurity({ exists: true });
  assert.equal((await storeNewKey({ run: g.run, replace: true })).ok, true);
});

test('a failed store, or one that left no item, is a failure without the key', async () => {
  const f = fakeSecurity({ addCode: 45 });
  const r = await storeNewKey({ run: f.run });
  assert.deepEqual(r, { ok: false, error: 'security could not store the key (exit 45)' });
  const g = fakeSecurity({ storesIt: false });
  assert.match((await storeNewKey({ run: g.run })).error, /not found in the Keychain after/);
  assert.equal(await keyExists({ run: fakeSecurity().run }), false);
});

test('bin/vapid-keygen refuses unknown arguments before touching anything', () => {
  const bin = fileURLToPath(new URL('../../bin/vapid-keygen', import.meta.url));
  const r = spawnSync(process.execPath, [bin, '--print'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
