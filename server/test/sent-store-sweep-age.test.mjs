// The sweep's two guards (lib/sent-store.mjs; Ultron's 11-18 low b on board b468ff61,
// follow-up board 41c18bc0): a temp file changed in the last minute stays, since it may
// be a write still under way, and only the exact name `write` makes
// (`<name>.tmp-<pid>-<8 hex>`) is swept. The sweep's other rules are in
// sent-store-sweep.test.mjs. Every name and time here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, symlink, utimes, lutimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSentStore, SWEEP_MIN_AGE_MS } from '../lib/sent-store.mjs';

const scratch = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sent-sweep-age-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
};
const names = async dir => (await readdir(dir)).sort();
const NOW = Date.UTC(2026, 10, 18, 15, 0);
const at = ms => new Date(ms);
// A temp file whose last change was `age` ms before NOW.
const aged = async (dir, name, age) => {
  await writeFile(join(dir, name), '{}', { mode: 0o600 });
  await utimes(join(dir, name), at(NOW - age), at(NOW - age));
};

test('sweep: a temp file changed in the last minute stays; one a minute old or more goes', async t => {
  const dir = await scratch(t);
  assert.equal(SWEEP_MIN_AGE_MS, 60e3);
  await aged(dir, 'notified.json.tmp-1-00000001', 0);
  await aged(dir, 'notified.json.tmp-1-00000002', SWEEP_MIN_AGE_MS - 1000);
  await aged(dir, 'notified.json.tmp-1-00000003', SWEEP_MIN_AGE_MS);
  await aged(dir, 'notified.json.tmp-1-00000004', 3600e3);
  // A time ahead of the clock (a clock set back) is not old.
  await aged(dir, 'notified.json.tmp-1-00000005', -3600e3);
  const store = createSentStore(join(dir, 'notified.json'), { now: () => NOW });
  assert.equal(await store.sweep(), 2);
  assert.deepEqual(await names(dir), ['notified.json.tmp-1-00000001', 'notified.json.tmp-1-00000002', 'notified.json.tmp-1-00000005']);
  // A start a minute later finds them stale.
  assert.equal(await createSentStore(join(dir, 'notified.json'), { now: () => NOW + 2 * 3600e3 }).sweep(), 3);
  assert.deepEqual(await names(dir), []);
});

test('sweep: with the real clock, a temp file made just now stays', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'notified.json.tmp-7-abcdef01'), '{}', { mode: 0o600 });
  assert.equal(await createSentStore(join(dir, 'notified.json')).sweep(), 0);
  assert.deepEqual(await names(dir), ['notified.json.tmp-7-abcdef01']);
});

test('sweep: a link is judged by its own time, never its target\'s', async t => {
  const dir = await scratch(t);
  const elsewhere = await scratch(t);
  const fresh = join(elsewhere, 'fresh.txt'), old = join(elsewhere, 'old.txt');
  await writeFile(fresh, 'x');
  await utimes(fresh, at(NOW), at(NOW));
  await writeFile(old, 'x');
  await utimes(old, at(NOW - 3600e3), at(NOW - 3600e3));
  // An old link to a fresh file goes; a fresh link to an old file stays.
  await symlink(fresh, join(dir, 'notified.json.tmp-1-0000000a'));
  await lutimes(join(dir, 'notified.json.tmp-1-0000000a'), at(NOW - 3600e3), at(NOW - 3600e3));
  await symlink(old, join(dir, 'notified.json.tmp-1-0000000b'));
  await lutimes(join(dir, 'notified.json.tmp-1-0000000b'), at(NOW), at(NOW));
  assert.equal(await createSentStore(join(dir, 'notified.json'), { now: () => NOW }).sweep(), 1);
  assert.deepEqual(await names(dir), ['notified.json.tmp-1-0000000b']);
  assert.deepEqual(await names(elsewhere), ['fresh.txt', 'old.txt']);
});

test('sweep: only the shape write makes, <pid>-<8 lower-case hex>; any other .tmp- name stays, however old', async t => {
  const dir = await scratch(t);
  const odd = [
    'notified.json.tmp-', 'notified.json.tmp-1', 'notified.json.tmp-1-', 'notified.json.tmp--0a1b2c3d',
    'notified.json.tmp-1-0a1b2c3', 'notified.json.tmp-1-0a1b2c3d4', 'notified.json.tmp-1-0A1B2C3D',
    'notified.json.tmp-1-0a1b2c3g', 'notified.json.tmp-x-0a1b2c3d', 'notified.json.tmp-1-0a1b2c3d.bak',
    'notified.json.tmp-1-0a1b2c3d-2', 'notified.json.tmp-+1-0a1b2c3d', 'notified.json.tmp- 1-0a1b2c3d',
    'notified.json.tmp-1-aa', 'notified.json.tmp-folder'
  ];
  for (const name of odd) await aged(dir, name, 3600e3);
  await aged(dir, 'notified.json.tmp-123-0a1b2c3d', 3600e3);
  await aged(dir, 'notified.json.tmp-4294967295-ffffffff', 3600e3);
  assert.equal(await createSentStore(join(dir, 'notified.json'), { now: () => NOW }).sweep(), 2);
  assert.deepEqual(await names(dir), [...odd].sort());
});

