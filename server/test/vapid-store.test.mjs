// bin/vapid-keygen's logic (lib/vapid-store.mjs) against a fake `security`: the key
// goes on stdin, never argv; an existing key is kept unless --replace; only exit 44
// means "absent"; the stored key is read back and checked; every call names the
// login Keychain's file; failures say so without the key. The real Keychain is never
// touched here: every `security` call goes through the injected `run`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { storeNewKey, keyExists, readStoredKey, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, LOGIN_KEYCHAIN, NOT_FOUND } from '../lib/vapid-store.mjs';
import { vapidKeys, newVapidKeys } from '../lib/webpush.mjs';

const KC = '/Users/someone/Library/Keychains/login.keychain-db';

// A fake `security`: `find` answers `findCode` (or 0/44 by whether it holds a key),
// a `-w` read prints what it holds (or `readBack`), `-i` stores the key from the line.
const fakeSecurity = ({ exists = false, addCode = 0, storesIt = true, findCode = null, readCode = null, readBack = null } = {}) => {
  const calls = [];
  let held = exists ? newVapidKeys().privateKey : null;
  const run = async (args, input = null, opts = {}) => {
    calls.push({ args, input, opts });
    if (args[0] === 'find-generic-password') {
      if (args.includes('-w')) {
        if (readCode !== null) return { code: readCode, stderr: '' };
        const v = readBack ?? held;
        return v ? { code: 0, stderr: '', stdout: `${v}\n` } : { code: NOT_FOUND, stderr: '' };
      }
      if (findCode !== null) return { code: findCode, stderr: '' };
      return { code: held ? 0 : NOT_FOUND, stderr: '' };
    }
    if (args[0] === '-i') {
      if (addCode === 0 && storesIt) held = / -w (\S+) /.exec(input)[1];
      return { code: addCode, stderr: '' };
    }
    return { code: 1, stderr: 'unexpected' };
  };
  return { run, calls, held: () => held };
};

test('the login Keychain is named by its file under the home folder', () => {
  assert.equal(LOGIN_KEYCHAIN, join(homedir(), 'Library', 'Keychains', 'login.keychain-db'));
  assert.equal(NOT_FOUND, 44);
});

test('a new key goes to security on stdin with the service, account and keychain; argv never holds it; only the public key comes back', async () => {
  const f = fakeSecurity();
  const r = await storeNewKey({ run: f.run, keychain: KC });
  assert.equal(r.ok, true, r.error);
  const add = f.calls.find(c => c.args[0] === '-i');
  assert.deepEqual(add.args, ['-i']);
  const m = /^add-generic-password -U -s (\S+) -a (\S+) -w ([A-Za-z0-9_-]{43}) (\S+)\n$/.exec(add.input);
  assert.ok(m, add.input.replace(/-w \S+/, '-w <key>'));
  assert.equal(m[1], KEYCHAIN_SERVICE);
  assert.equal(m[2], KEYCHAIN_ACCOUNT);
  assert.equal(m[4], KC, 'the keychain is named on the store');
  assert.equal(vapidKeys(m[3]).publicKey, r.publicKey, 'the stored key is the pair of the public key shown');
  for (const c of f.calls) assert.ok(!c.args.join(' ').includes(m[3]), 'never on argv');
  assert.ok(!JSON.stringify(r).includes(m[3]), 'never in the answer');
  const finds = f.calls.filter(c => c.args[0] === 'find-generic-password');
  for (const c of finds) {
    assert.equal(c.args.at(-1), KC, 'every lookup names the keychain');
    assert.deepEqual(c.args.slice(0, 5), ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
  }
  assert.ok(!finds[0].args.includes('-w'), 'existence is checked without reading the key');
  const reads = finds.filter(c => c.args.includes('-w'));
  assert.equal(reads.length, 1, 'read back once after storing');
  assert.equal(reads[0].opts.capture, true, 'the read takes stdout into memory');
  assert.ok(f.calls.indexOf(reads[0]) > f.calls.indexOf(add), 'the read comes after the store');
});

test('the default keychain is the login Keychain file', async () => {
  const f = fakeSecurity();
  assert.equal((await storeNewKey({ run: f.run })).ok, true);
  assert.ok(f.calls.filter(c => c.args[0] === 'find-generic-password').every(c => c.args.at(-1) === LOGIN_KEYCHAIN));
  assert.ok(f.calls.find(c => c.args[0] === '-i').input.endsWith(` ${LOGIN_KEYCHAIN}\n`));
});

test('a keychain path security -i could split, or a relative one, is refused before any call', async () => {
  for (const bad of ['/Users/a b/login.keychain-db', 'login.keychain-db', '/x/"y"', '/x\\y', '', null]) {
    const f = fakeSecurity();
    const r = await storeNewKey({ run: f.run, keychain: bad });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /keychain path/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(readStoredKey({ run: f.run, keychain: bad }), /keychain path/);
  }
});

test('an existing key is kept unless --replace', async () => {
  const f = fakeSecurity({ exists: true });
  const r = await storeNewKey({ run: f.run, keychain: KC });
  assert.equal(r.ok, false);
  assert.match(r.error, /--replace/);
  assert.equal(f.calls.filter(c => c.args[0] === '-i').length, 0);
  const g = fakeSecurity({ exists: true });
  assert.equal((await storeNewKey({ run: g.run, replace: true, keychain: KC })).ok, true);
});

test('only exit 44 means absent: any other failure of the lookup stops before a key is made or stored', async () => {
  assert.equal(await keyExists({ run: fakeSecurity().run, keychain: KC }), false);
  assert.equal(await keyExists({ run: fakeSecurity({ exists: true }).run, keychain: KC }), true);
  for (const code of [1, 36, 45, 51, 127]) {
    const f = fakeSecurity({ findCode: code });
    await assert.rejects(keyExists({ run: f.run, keychain: KC }), new RegExp(`exit ${code}\\)`));
    let made = 0;
    const r = await storeNewKey({ run: f.run, keychain: KC, replace: true, make: () => { made++; return newVapidKeys(); } });
    assert.equal(r.ok, false);
    assert.equal(r.error, `security could not look for the key (exit ${code}); nothing was stored`);
    assert.equal(made, 0, 'no key made');
    assert.equal(f.calls.filter(c => c.args[0] === '-i').length, 0, 'nothing stored');
  }
});

test('a failed store, or one that left no item, is a failure without the key', async () => {
  const f = fakeSecurity({ addCode: 45 });
  const r = await storeNewKey({ run: f.run, keychain: KC });
  assert.deepEqual(r, { ok: false, error: 'security could not store the key (exit 45)' });
  const g = fakeSecurity({ storesIt: false });
  assert.match((await storeNewKey({ run: g.run, keychain: KC })).error, /not found in the Keychain after/);
});

test('the read-back must hold the new key: a different key, junk, or a failed read is a loud failure', async () => {
  const other = newVapidKeys().privateKey;
  const f = fakeSecurity({ readBack: other });
  const r = await storeNewKey({ run: f.run, keychain: KC });
  assert.equal(r.ok, false);
  assert.match(r.error, /^MISMATCH: the key read back from the Keychain is not the one just made/);
  assert.ok(!r.error.includes(other) && !r.error.includes(f.held()), 'no key in the error');
  assert.equal('publicKey' in r, false);
  const j = fakeSecurity({ readBack: 'not-a-key' });
  assert.match((await storeNewKey({ run: j.run, keychain: KC })).error, /^MISMATCH/);
  const e = fakeSecurity({ readCode: 51 });
  const er = await storeNewKey({ run: e.run, keychain: KC });
  assert.equal(er.ok, false);
  assert.match(er.error, /stored, but security then could not read the key \(exit 51\)/);
});

test('readStoredKey: the key trimmed, null on exit 44 or empty, an error on anything else', async () => {
  const priv = newVapidKeys().privateKey;
  const at = code => async () => ({ code, stderr: '', stdout: code === 0 ? ` ${priv}\n` : '' });
  assert.equal(await readStoredKey({ run: at(0), keychain: KC }), priv);
  assert.equal(await readStoredKey({ run: at(44), keychain: KC }), null);
  assert.equal(await readStoredKey({ run: async () => ({ code: 0, stderr: '', stdout: '\n' }), keychain: KC }), null);
  await assert.rejects(readStoredKey({ run: at(36), keychain: KC }), /could not read the key \(exit 36\)/);
});

test('bin/vapid-keygen refuses unknown arguments before touching anything', () => {
  const bin = fileURLToPath(new URL('../../bin/vapid-keygen', import.meta.url));
  const r = spawnSync(process.execPath, [bin, '--print'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
