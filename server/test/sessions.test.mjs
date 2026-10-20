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

// T8: the Cowork branch had one catch around readFile AND JSON.parse, so an
// EACCES on a session file was swallowed as if it were malformed JSON and
// reported nowhere — a project silently missing from the panel with the page
// still claiming a complete picture.
test('an unreadable Cowork session file is named in unreadablePaths, not swallowed', async t => {
  if (!(await permissionsAreEnforced())) {
    return t.skip('chmod does not restrict readdir in this environment (e.g. running as root)');
  }

  const readable = freshDir();
  const good = join(readable, 'local_good.json');
  const bad = join(readable, 'local_bad.json');
  await writeFile(good, JSON.stringify({ sessionId: 'c1', cwd: '/Users/example/CoworkSpace/live', lastActivityAt: Date.now() }));
  await writeFile(bad, JSON.stringify({ sessionId: 'c2', cwd: '/Users/example/CoworkSpace/hidden' }));
  chmodSync(bad, 0o000);
  try {
    const out = await collectSessions({ roots: [{ root: readable, surface: 'Cowork' }] });
    assert.equal(out.coworkSessions.length, 1, 'the readable session must survive');
    assert.ok(out.unreadablePaths.includes(bad),
      `expected ${bad} in ${JSON.stringify(out.unreadablePaths)}`);
  } finally {
    chmodSync(bad, 0o600);
  }
});

test('a malformed Cowork session file is also recorded rather than silently dropped', async () => {
  const readable = freshDir();
  const broken = join(readable, 'local_broken.json');
  await writeFile(broken, '{"sessionId": "c3", trunc');
  const out = await collectSessions({ roots: [{ root: readable, surface: 'Cowork' }] });
  assert.deepEqual(out.coworkSessions, []);
  assert.ok(out.unreadablePaths.includes(broken));
});

// A forked subagent's transcript opens with a copy of the parent's line that
// launched it (seen 2026-10-16). Synthetic lines, no real transcript content.
test('a request copied into a subagent transcript is counted once across the files', async () => {
  const root = freshDir();
  const project = join(root, '-Users-example-Projects-demo');
  const subagents = join(project, 'sess-1', 'subagents');
  await mkdir(subagents, { recursive: true });
  const start = Date.now() - 3600_000;
  const at = seconds => new Date(start + seconds * 1000).toISOString();
  const usage = { input_tokens: 3, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000 };
  const line = (id, seconds, block, u = usage) => JSON.stringify({
    type: 'assistant', timestamp: at(seconds), sessionId: 'sess-1', cwd: '/Users/example/Projects/demo', requestId: `req_${id}`,
    message: { id: `msg_${id}`, model: 'claude-opus-5', role: 'assistant', content: [{ type: block }], usage: u }
  });
  await writeFile(join(project, 'sess-1.jsonl'), [line('P', 0, 'thinking'), line('P', 0, 'text'), line('P', 12, 'tool_use')].join('\n') + '\n');
  await writeFile(join(subagents, 'agent-a.jsonl'), [line('P', 12, 'tool_use'), line('S', 20, 'text', { input_tokens: 7, output_tokens: 8 })].join('\n') + '\n');
  await writeFile(join(subagents, 'agent-b.jsonl'), line('P', 12, 'tool_use') + '\n');

  const out = await collectSessions({ roots: [{ root, surface: 'Code' }] });
  const tokens = out.transcripts.flatMap(t => t.records).reduce((a, r) => a + r.tokens, 0);
  assert.equal(tokens, 1203 + 15);
  const names = out.transcripts.map(t => t.filePath.slice(root.length)).sort();
  assert.deepEqual(names, ['/-Users-example-Projects-demo/sess-1.jsonl', '/-Users-example-Projects-demo/sess-1/subagents/agent-a.jsonl'],
    'a file whose only request was a copy is not listed');
  const sub = out.transcripts.find(t => t.filePath.endsWith('agent-a.jsonl'));
  assert.equal(sub.lastTs, Date.parse(at(20)), 'lastTs comes from the records kept');
});
