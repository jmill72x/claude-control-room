import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../collectors/sessions.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'ccr-sessions-'));
const missingPath = () => join(tmpdir(), `ccr-missing-${Math.random().toString(36).slice(2)}`);

// A directory with no read bit stats fine (stat only needs execute/search
// permission on the *parent*) but throws EACCES on readdir. Some environments
// (root, certain containers) don't enforce this, so detect it once and skip
// the permission tests explicitly rather than let them pass vacuously.
async function permissionsAreEnforced() {
  const dir = freshDir();
  chmodSync(dir, 0o311);
  try {
    await readdir(dir);
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(dir, 0o700);
  }
}

test('every root unreadable throws rather than reporting zero sessions', async () => {
  const roots = [
    { root: missingPath(), surface: 'Code' },
    { root: missingPath(), surface: 'Cowork' }
  ];
  await assert.rejects(() => collectSessions({ roots }), /no transcript root is readable/);
});

test('one readable root and one missing root returns normally, naming the missing one', async () => {
  const readable = freshDir();
  const missing = missingPath();
  const roots = [
    { root: readable, surface: 'Code' },
    { root: missing, surface: 'Cowork' }
  ];
  const out = await collectSessions({ roots });
  assert.deepEqual(out.transcripts, []);
  assert.deepEqual(out.coworkSessions, []);
  assert.deepEqual(out.unavailableRoots, [missing]);
});

test('a readable but genuinely empty root returns normally with no unavailable roots', async () => {
  const readable = freshDir();
  await mkdir(join(readable, 'nested'), { recursive: true });
  const roots = [{ root: readable, surface: 'Code' }];
  const out = await collectSessions({ roots });
  assert.deepEqual(out.transcripts, []);
  assert.deepEqual(out.unavailableRoots, []);
});

test('a root that stats fine but cannot be listed throws alone, and lands in unavailableRoots alongside a readable root', async t => {
  if (!(await permissionsAreEnforced())) {
    return t.skip('chmod does not restrict readdir in this environment (e.g. running as root)');
  }

  const blocked = freshDir();
  chmodSync(blocked, 0o311); // stat() succeeds; readdir() throws EACCES
  try {
    // stat() passing must not be mistaken for "readable" — the root is the
    // only one in the set, so this must throw, not silently report empty.
    await assert.rejects(
      () => collectSessions({ roots: [{ root: blocked, surface: 'Code' }] }),
      /no transcript root is readable/
    );

    const readable = freshDir();
    const out = await collectSessions({
      roots: [
        { root: readable, surface: 'Code' },
        { root: blocked, surface: 'Cowork' }
      ]
    });
    assert.deepEqual(out.unavailableRoots, [blocked]);
  } finally {
    chmodSync(blocked, 0o700); // restore so the temp dir can be cleaned up
  }
});

test('a readable root with one unreadable subdirectory keeps the readable sessions and names the bad subdirectory in unreadablePaths', async t => {
  if (!(await permissionsAreEnforced())) {
    return t.skip('chmod does not restrict readdir in this environment (e.g. running as root)');
  }

  const readable = freshDir();
  const goodTranscript = join(readable, 'session.jsonl');
  await writeFile(goodTranscript, JSON.stringify({
    sessionId: 's1',
    timestamp: '2026-08-05T12:00:00.000Z',
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } }
  }) + '\n');

  const badSub = join(readable, 'bad-project');
  await mkdir(badSub);
  chmodSync(badSub, 0o311);
  try {
    const out = await collectSessions({ roots: [{ root: readable, surface: 'Code' }] });
    assert.deepEqual(out.unavailableRoots, []);
    assert.deepEqual(out.unreadablePaths, [badSub]);
    // The readable part of the tree must still surface its sessions — a
    // failure one level down costs that project, not the whole panel.
    assert.equal(out.transcripts.length, 1);
  } finally {
    chmodSync(badSub, 0o700);
  }
});

test('a Cowork root with one unreadable subdirectory yields that path exactly once in unreadablePaths', async t => {
  if (!(await permissionsAreEnforced())) {
    return t.skip('chmod does not restrict readdir in this environment (e.g. running as root)');
  }

  // A Cowork surface walks the tree twice (once for .jsonl, once for
  // local_*.json), sharing one `failures` array — an unreadable subdirectory
  // is hit by readdir on both passes and must still be reported exactly once.
  const readable = freshDir();
  const badSub = join(readable, 'bad-project');
  await mkdir(badSub);
  chmodSync(badSub, 0o311);
  try {
    const out = await collectSessions({ roots: [{ root: readable, surface: 'Cowork' }] });
    assert.deepEqual(out.unavailableRoots, []);
    const occurrences = out.unreadablePaths.filter(p => p === badSub);
    assert.equal(occurrences.length, 1,
      `expected ${badSub} exactly once, got ${JSON.stringify(out.unreadablePaths)}`);
  } finally {
    chmodSync(badSub, 0o700);
  }
});

test('an unreadable file amid readable ones costs only that file, not the whole panel', async t => {
  if (!(await permissionsAreEnforced())) {
    return t.skip('chmod does not restrict readdir in this environment (e.g. running as root)');
  }

  const readable = freshDir();
  const record = JSON.stringify({
    sessionId: 's1',
    timestamp: '2026-08-05T12:00:00.000Z',
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 5 } }
  }) + '\n';
  const goodFile = join(readable, 'good.jsonl');
  const badFile = join(readable, 'bad.jsonl');
  await writeFile(goodFile, record);
  await writeFile(badFile, record);
  chmodSync(badFile, 0o000); // stat() still succeeds; readFile() throws EACCES
  try {
    const out = await collectSessions({ roots: [{ root: readable, surface: 'Code' }] });
    assert.deepEqual(out.unavailableRoots, []);
    // The good transcript must survive even though a sibling file couldn't
    // be read — that was the whole point of guarding readFile separately.
    assert.equal(out.transcripts.length, 1);
    assert.ok(out.unreadablePaths.includes(badFile));
  } finally {
    chmodSync(badFile, 0o600);
  }
});

test('a tree nested deeper than MAX_DEPTH reports the truncation point instead of returning silently empty', async () => {
  const readable = freshDir();
  let deep = readable;
  for (let i = 1; i <= 13; i++) deep = join(deep, `lvl${i}`);
  await mkdir(deep, { recursive: true });

  const out = await collectSessions({ roots: [{ root: readable, surface: 'Code' }] });
  assert.deepEqual(out.unavailableRoots, []);
  assert.ok(out.unreadablePaths.includes(deep),
    `expected the truncation point ${deep} in ${JSON.stringify(out.unreadablePaths)}`);
});
