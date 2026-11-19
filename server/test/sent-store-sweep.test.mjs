// The notifier's file at start (lib/sent-store.mjs, sweep; board b468ff61): a write
// stopped between its temp file and the rename leaves that temp file, which nothing
// reads and which holds what the real file holds. The server removes those before its
// first write. The store's read and write are tested in sent-store.test.mjs. Every key
// and id here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, lstat, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSentStore, SWEEP_MIN_AGE_MS } from '../lib/sent-store.mjs';

// Every temp file here is made just now; the sweep leaves a recent one (the age and
// name rules are in sent-store-sweep-age.test.mjs), so these stores look from later.
const later = () => Date.now() + 2 * SWEEP_MIN_AGE_MS;

const scratch = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sent-sweep-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
};
const mode = async path => (await stat(path)).mode & 0o777;
const names = async dir => (await readdir(dir)).sort();
// A temp file as an interrupted write leaves it: whole or cut short, owner-only.
const leftover = (dir, name, text = '{"limit:a": 5, "limit-step-st') => writeFile(join(dir, name), text, { mode: 0o600 });

test('sweep: the temp files beside the file go, however many and whatever process wrote them, and it says how many', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  const store = createSentStore(path, { now: later });
  await store.write({ 'limit:a': 5 });
  await leftover(dir, 'notified.json.tmp-123-0a1b2c3d');
  await leftover(dir, `notified.json.tmp-${process.pid}-ffffffff`, '');
  await leftover(dir, 'notified.json.tmp-99999-00000000', '{}');
  await leftover(dir, 'notified.json.tmp-1-abcdef01');
  assert.equal(await store.sweep(), 4);
  assert.deepEqual(await names(dir), ['notified.json']);
  assert.deepEqual(await store.read(), { 'limit:a': 5 }, 'the file itself is as it was');
  assert.equal(await mode(path), 0o600);
  assert.equal(await store.sweep(), 0, 'and a second look finds nothing');
});

test('sweep: only that name pattern, in that folder: the file, its neighbours and other stores\' temp files stay', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  const store = createSentStore(path, { now: later });
  await writeFile(path, '{"limit:a": 5}', { mode: 0o600 });
  const keep = ['acks.json', 'acks.json.tmp-1-aaaaaaaa', 'notified.json.bak', 'notified.json.tmpx', 'notified.jsonx.tmp-1-aaaaaaaa', 'xnotified.json.tmp-1-aaaaaaaa', 'notified.tmp-1-aaaaaaaa', '.notified.json.tmp-1-aaaaaaaa', 'todos.json.tmp-7'];
  for (const name of keep) await leftover(dir, name);
  // A folder under the pattern's name is not a temp file: it and what it holds stay.
  await mkdir(join(dir, 'notified.json.tmp-2-f01de400'));
  await leftover(join(dir, 'notified.json.tmp-2-f01de400'), 'inside.json');
  // The same name one folder down is another folder's business.
  await mkdir(join(dir, 'deeper'));
  await leftover(join(dir, 'deeper'), 'notified.json.tmp-1-aaaaaaaa');
  await leftover(dir, 'notified.json.tmp-1-aaaaaaaa');
  assert.equal(await store.sweep(), 1);
  assert.deepEqual(await names(dir), [...keep, 'deeper', 'notified.json', 'notified.json.tmp-2-f01de400'].sort());
  assert.deepEqual(await names(join(dir, 'notified.json.tmp-2-f01de400')), ['inside.json']);
  assert.deepEqual(await names(join(dir, 'deeper')), ['notified.json.tmp-1-aaaaaaaa']);
  assert.equal(await readFile(path, 'utf8'), '{"limit:a": 5}');
});

test('sweep: a link under the name is removed, and what it points at is never touched', async t => {
  const dir = await scratch(t);
  const elsewhere = await scratch(t);
  const target = join(elsewhere, 'precious.txt');
  await writeFile(target, 'keep me');
  const path = join(dir, 'notified.json');
  await symlink(target, join(dir, 'notified.json.tmp-1-aaaaaaaa'));
  await symlink(join(elsewhere, 'nothing-there'), join(dir, 'notified.json.tmp-2-bbbbbbbb'));
  await symlink(elsewhere, join(dir, 'notified.json.tmp-3-cccccccc'));
  assert.equal(await createSentStore(path, { now: later }).sweep(), 3);
  assert.deepEqual(await names(dir), []);
  assert.equal(await readFile(target, 'utf8'), 'keep me');
  assert.deepEqual(await names(elsewhere), ['precious.txt']);
});

test('sweep: never throws and makes nothing: a missing folder, a folder that can\'t be listed, a temp file that can\'t be removed', async t => {
  const dir = await scratch(t);
  assert.equal(await createSentStore(join(dir, 'data', 'notified.json')).sweep(), 0);
  assert.deepEqual(await names(dir), [], 'the data folder is made by the first write, not by the sweep');
  // The file's "folder" is a file.
  await writeFile(join(dir, 'plain'), 'x');
  assert.equal(await createSentStore(join(dir, 'plain', 'notified.json')).sweep(), 0);
  // A folder that may not be changed: the temp file stays, and that is not an error.
  const locked = join(dir, 'locked');
  await mkdir(locked);
  await leftover(locked, 'notified.json.tmp-1-aaaaaaaa');
  await chmod(locked, 0o500);
  t.after(() => chmod(locked, 0o700).catch(() => {}));
  const store = createSentStore(join(locked, 'notified.json'), { now: later });
  if (process.getuid?.() !== 0) {
    assert.equal(await store.sweep(), 0, 'counted only when it went');
    assert.deepEqual(await names(locked), ['notified.json.tmp-1-aaaaaaaa']);
  }
  await chmod(locked, 0o700);
  assert.equal(await store.sweep(), 1);
});

test('after a sweep the next write is as ever: owner-only, through a new temp file, nothing left beside it', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'notified.json');
  // The file as an old version left it, readable by others, and a cut-short write.
  await writeFile(path, '{"limit:a": 5}', { mode: 0o644 });
  await chmod(path, 0o644);
  await leftover(dir, 'notified.json.tmp-123-0a1b2c3d');
  const store = createSentStore(path, { suffix: () => '0a1b2c3d', now: later });
  assert.equal(await store.sweep(), 1);
  assert.equal(await mode(path), 0o644, 'the sweep does not rewrite the file');
  await store.write({ 'limit:b': 7 });
  assert.equal(await mode(path), 0o600);
  assert.equal((await lstat(path)).isFile(), true);
  assert.deepEqual(await names(dir), ['notified.json']);
  assert.deepEqual(await store.read(), { 'limit:b': 7 });
});

// server.mjs can't run in a test, so its wiring is read: the sweep comes straight
// after the store is made, is awaited, and so runs before any collector can write.
test('server.mjs sweeps once at start, before the notifier is registered and before the collectors start', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /\nconst sentStore = createSentStore\([^\n]*\);\nconst staleSentTemps = await sentStore\.sweep\(\);\n/);
  // Once for this file (the proactive check sweeps its own file, data/proactive.json:
  // test/proactive-routes.test.mjs).
  assert.equal(src.match(/\bsentStore\.sweep\(/g).length, 1, 'once');
  const sweep = src.indexOf('await sentStore.sweep()');
  assert.ok(sweep < src.indexOf("registry.register('notifier'"), 'before the notifier exists');
  assert.ok(sweep < src.indexOf('registry.startAll()'), 'before any collector runs');
  // The log line gives a count and never a file's name or contents.
  const line = src.split('\n').find(l => l.includes('staleSentTemps') && l.includes('console.log'));
  assert.match(line, /^if \(staleSentTemps > 0\) console\.log\(`notifier: removed \$\{staleSentTemps\} temp file/);
});
