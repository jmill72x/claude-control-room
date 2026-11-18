// The notifier's file (lib/sent-store.mjs): read leniently, written whole through a
// temp file and a rename, owner-only. Every key and id here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, lstat, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSentStore } from '../lib/sent-store.mjs';

const scratch = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sent-store-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
};
const mode = async path => (await stat(path)).mode & 0o777;

test('read: the object in the file; {} when it is missing, not JSON, or not an object', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  const store = createSentStore(path);
  assert.deepEqual(await store.read(), {}, 'no file yet');
  for (const [text, want] of [['{"limit:a": 5}', { 'limit:a': 5 }], ['{"limit:a"', {}], ['', {}], ['null', {}], ['7', {}], ['"abc"', {}], ['[1, 2]', {}], ['{}', {}]]) {
    await writeFile(path, text);
    assert.deepEqual(await store.read(), want, text);
  }
});

test('write: the whole value as JSON, in a folder made when missing, and read back the same', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'data', 'deeper', 'notified.json');
  const store = createSentStore(path);
  const value = { 'limit-step:Current session:80:-': 1794380000000, 'limit-step-state': { told: [], owed: { k: { passes: 0, missed: ['aa'], at: 5 } } } };
  await store.write(value);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(value, null, 2));
  assert.deepEqual(await store.read(), value);
  await store.write({});
  assert.deepEqual(await store.read(), {}, 'a later write replaces it whole');
  assert.deepEqual(await readdir(join(dir, 'data', 'deeper')), ['notified.json'], 'no temp file is left');
});

test('write: owner-only from the first write, and a file that was readable by others ends owner-only', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  const store = createSentStore(path);
  await store.write({ a: 1 });
  assert.equal(await mode(path), 0o600);
  await rm(path);
  await writeFile(path, '{"old": 1}');
  await chmod(path, 0o644);
  await store.write({ a: 2 });
  assert.equal(await mode(path), 0o600);
  assert.deepEqual(await store.read(), { a: 2 });
});

test('write: through a temp file beside it and a rename, never into the file itself', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  await writeFile(path, '{"old": 1}');
  const before = (await stat(path)).ino;
  // A reader that opened the old file keeps the old file, whole.
  const names = [];
  const store = createSentStore(path, { suffix: () => { names.push('x'); return `t${names.length}`; } });
  await store.write({ a: 1 });
  assert.notEqual((await stat(path)).ino, before, 'a new file took its place');
  assert.equal(names.length, 1, 'one temp name a write');
  // The temp file's name: the file's own, the process, the suffix. One in its way
  // (a link planted under the name) is never written through, and the old file stands.
  const elsewhere = join(dir, 'elsewhere.txt');
  await writeFile(elsewhere, 'left alone');
  await symlink(elsewhere, `${path}.tmp-${process.pid}-t2`);
  await assert.rejects(store.write({ a: 2 }), { code: 'EEXIST' });
  assert.equal(await readFile(elsewhere, 'utf8'), 'left alone');
  assert.deepEqual(await store.read(), { a: 1 });
});

test('write: a failure throws, leaves the old file whole and no temp file behind', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  // A folder with something in it where the file should be: the rename can't replace it.
  await mkdir(path);
  await writeFile(join(path, 'in the way'), 'x');
  const store = createSentStore(path);
  await assert.rejects(store.write({ a: 1 }));
  assert.deepEqual((await readdir(dir)).sort(), ['notified.json'], 'the temp file was taken away');
  assert.ok((await lstat(path)).isDirectory());
  assert.deepEqual(await store.read(), {}, 'and a read of it is empty, not a throw');
  // Without a suffix of its own the temp name is random: two stores on one path never share it.
  const other = join(dir, 'other.json');
  await Promise.all([createSentStore(other).write({ n: 1 }), createSentStore(other).write({ n: 2 })]);
  assert.ok([1, 2].includes((await createSentStore(other).read()).n));
  assert.deepEqual((await readdir(dir)).sort(), ['notified.json', 'other.json']);
});

test('server.mjs keeps the notifier\'s file through the sent store, and writes it no other way', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /\nconst sentStore = createSentStore\(join\(HERE, 'data', 'notified\.json'\)\);\n/);
  assert.match(src, /\n {4}readSent: sentStore\.read,\n {4}writeSent: sentStore\.write,\n/);
  assert.equal(src.match(/notified\.json/g).length, 1, 'named once: nothing else opens it');
});
