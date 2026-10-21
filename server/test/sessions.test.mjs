import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { appendFile, mkdir, readdir, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../collectors/sessions.mjs';
import { parseTranscriptFile } from '../lib/parse-transcript.mjs';

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

// The cache the server keeps between passes: a pass reads only the transcripts
// that changed since the last one. Synthetic lines and invented ids throughout.
const usageRecord = (id, seconds, usage) => JSON.stringify({
  type: 'assistant', timestamp: new Date(Date.now() - 3600_000 + seconds * 1000).toISOString(), sessionId: 'sess-c',
  cwd: '/Users/example/Projects/demo', requestId: `req_${id}`,
  message: { id: `msg_${id}`, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text' }], usage }
}) + '\n';
const countingReader = (fail = () => false) => {
  const reads = [];
  return {
    reads,
    readTranscript: async (file, surface) => {
      reads.push(file);
      if (fail(file)) throw new Error('EIO: i/o error, read');
      return parseTranscriptFile(file, surface);
    }
  };
};
const tokensOf = out => out.transcripts.flatMap(t => t.records).reduce((a, r) => a + r.tokens, 0);

test('with a cache, a transcript that has not changed is not read again, and one that has is', async () => {
  const root = freshDir();
  const a = join(root, 'a.jsonl');
  const b = join(root, 'b.jsonl');
  await writeFile(a, usageRecord('A1', 0, { input_tokens: 10, output_tokens: 5 }));
  await writeFile(b, usageRecord('B1', 1, { input_tokens: 100, output_tokens: 50 }));
  const roots = [{ root, surface: 'Code' }];
  const cache = new Map();
  const { reads, readTranscript } = countingReader();

  const first = await collectSessions({ roots, cache, readTranscript });
  assert.equal(tokensOf(first), 165);
  assert.deepEqual([...reads].sort(), [a, b].sort());

  reads.length = 0;
  const second = await collectSessions({ roots, cache, readTranscript });
  assert.deepEqual(reads, [], 'nothing changed, so nothing is read');
  assert.equal(tokensOf(second), 165);
  assert.deepEqual(second.transcripts.map(t => t.filePath).sort(), [a, b].sort());

  await appendFile(a, usageRecord('A2', 2, { input_tokens: 1, output_tokens: 2 }));
  reads.length = 0;
  const third = await collectSessions({ roots, cache, readTranscript });
  assert.deepEqual(reads, [a], 'only the file that grew is read again');
  assert.equal(tokensOf(third), 168);

  // The same size with a new mtime is a change too.
  const later = new Date(Date.now() + 60_000);
  await utimes(b, later, later);
  reads.length = 0;
  await collectSessions({ roots, cache, readTranscript });
  assert.deepEqual(reads, [b]);

  await unlink(b);
  const fifth = await collectSessions({ roots, cache, readTranscript });
  assert.equal(cache.has(b), false, 'a file that is gone is forgotten');
  assert.equal(tokensOf(fifth), 18);
});

test('without a cache, every pass reads every transcript, as before', async () => {
  const root = freshDir();
  await writeFile(join(root, 'a.jsonl'), usageRecord('A1', 0, { input_tokens: 1, output_tokens: 1 }));
  const roots = [{ root, surface: 'Code' }];
  const { reads, readTranscript } = countingReader();
  await collectSessions({ roots, readTranscript });
  await collectSessions({ roots, readTranscript });
  assert.equal(reads.length, 2);
});

test('a transcript that fails to read is not kept, so every pass tries it again and reports it', async () => {
  const root = freshDir();
  const good = join(root, 'good.jsonl');
  const bad = join(root, 'bad.jsonl');
  await writeFile(good, usageRecord('G1', 0, { input_tokens: 2, output_tokens: 2 }));
  await writeFile(bad, usageRecord('X1', 1, { input_tokens: 9, output_tokens: 9 }));
  const roots = [{ root, surface: 'Code' }];
  const cache = new Map();
  const { reads, readTranscript } = countingReader(file => file === bad);

  const first = await collectSessions({ roots, cache, readTranscript });
  assert.ok(first.unreadablePaths.includes(bad));
  assert.equal(cache.has(bad), false);
  assert.equal(tokensOf(first), 4);

  reads.length = 0;
  const second = await collectSessions({ roots, cache, readTranscript });
  assert.deepEqual(reads, [bad], 'the good file is kept; the bad one is tried again');
  assert.ok(second.unreadablePaths.includes(bad), 'and reported again');
});

test('a transcript with a line too long to read is reported, and its other lines still count', async () => {
  const root = freshDir();
  const file = join(root, 'long.jsonl');
  await writeFile(file, usageRecord('L1', 0, { input_tokens: 4, output_tokens: 4 }) + 'x'.repeat(5000) + '\n'
    + usageRecord('L2', 1, { input_tokens: 5, output_tokens: 5 }));
  const roots = [{ root, surface: 'Code' }];
  const cache = new Map();
  const readTranscript = (f, surface) => parseTranscriptFile(f, surface, { maxLineBytes: 1000 });
  for (const pass of ['first', 'cached']) {
    const out = await collectSessions({ roots, cache, readTranscript });
    assert.ok(out.unreadablePaths.includes(file), `${pass} pass names the file`);
    assert.equal(tokensOf(out), 18, `${pass} pass`);
  }
});

test('a pass that cannot list one root keeps the cache for it, so its files are not all read again', async () => {
  const here = freshDir();
  const away = freshDir();
  const kept = join(here, 'kept.jsonl');
  await writeFile(kept, usageRecord('K1', 0, { input_tokens: 3, output_tokens: 3 }));
  await writeFile(join(away, 'other.jsonl'), usageRecord('O1', 1, { input_tokens: 1, output_tokens: 1 }));
  const roots = [{ root: here, surface: 'Code' }, { root: away, surface: 'Cowork' }];
  const cache = new Map();
  const { reads, readTranscript } = countingReader();
  await collectSessions({ roots, cache, readTranscript });

  const moved = `${here}-moved`;
  await rename(here, moved);
  const gap = await collectSessions({ roots, cache, readTranscript });
  assert.deepEqual(gap.unavailableRoots, [here]);
  assert.equal(cache.has(kept), true, 'an unlisted root is not a deleted one');

  await rename(moved, here);
  reads.length = 0;
  const back = await collectSessions({ roots, cache, readTranscript });
  assert.deepEqual(reads, [], 'nothing changed while the root was away');
  assert.equal(tokensOf(back), 8);
});

// The agent views (Orbit plan, Phase 3) read each subagent's .meta.json, the
// file Claude Code writes beside its transcript, and the names top-level
// sessions carry. Invented agent types, briefs and names throughout.
const metaLine = (id, sessionId, seconds) => JSON.stringify({
  type: 'assistant', timestamp: new Date(Date.now() - 3600_000 + seconds * 1000).toISOString(), sessionId,
  cwd: '/Users/example/Projects/demo', requestId: `req_${id}`,
  message: { id: `msg_${id}`, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text' }], usage: { input_tokens: 4, output_tokens: 6 } }
}) + '\n';
async function sessionWithSubagents(root) {
  const project = join(root, '-Users-example-Projects-demo');
  const subagents = join(project, 'sess-m', 'subagents');
  await mkdir(subagents, { recursive: true });
  await writeFile(join(project, 'sess-m.jsonl'),
    JSON.stringify({ type: 'agent-name', agentName: 'Lead', sessionId: 'sess-m' }) + '\n' + metaLine('P', 'sess-m', 0));
  await writeFile(join(subagents, 'agent-a1.jsonl'), metaLine('A', 'sess-m', 10));
  await writeFile(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'builder', description: 'Build the thing', toolUseId: 't1', finished: true }));
  await writeFile(join(subagents, 'agent-a2.jsonl'), metaLine('B', 'sess-m', 20));
  return { project, subagents };
}

test("a subagent's meta file comes with its transcript, and a top-level transcript has none", async () => {
  const root = freshDir();
  await sessionWithSubagents(root);
  const out = await collectSessions({ roots: [{ root, surface: 'Code' }] });
  const byName = Object.fromEntries(out.transcripts.map(t => [t.filePath.split('/').pop(), t]));
  assert.deepEqual(byName['agent-a1.jsonl'].meta, { agentType: 'builder', description: 'Build the thing' });
  assert.equal(byName['agent-a1.jsonl'].subagent, true);
  assert.equal(byName['agent-a2.jsonl'].meta, null, 'no meta file is no meta, not a failure');
  assert.equal(byName['agent-a2.jsonl'].subagent, true);
  assert.equal(byName['sess-m.jsonl'].meta, null);
  assert.equal(byName['sess-m.jsonl'].subagent, false);
  assert.deepEqual(out.unreadablePaths, []);
});

test('a meta file that does not parse is reported, its transcript still counts, and it is tried again next pass', async () => {
  const root = freshDir();
  const { subagents } = await sessionWithSubagents(root);
  const broken = join(subagents, 'agent-a2.meta.json');
  await writeFile(broken, '{"agentType": "builder", ');
  const cache = new Map();
  const reads = [];
  const readMeta = async file => { reads.push(file); return (await import('../collectors/sessions.mjs')).readSubagentMeta(file); };
  const first = await collectSessions({ roots: [{ root, surface: 'Code' }], cache, readMeta });
  assert.deepEqual(first.unreadablePaths, [broken]);
  const a2 = first.transcripts.find(t => t.filePath.endsWith('agent-a2.jsonl'));
  assert.equal(a2.meta, null);
  assert.equal(a2.records.length, 1, 'the transcript itself was read');
  reads.length = 0;
  const second = await collectSessions({ roots: [{ root, surface: 'Code' }], cache, readMeta });
  assert.deepEqual(second.unreadablePaths, [broken], 'reported again, not hidden by the cache');
  assert.equal(reads.filter(f => f.endsWith('agent-a2.jsonl')).length, 1, 'the broken one is tried again');
  assert.equal(reads.filter(f => f.endsWith('agent-a1.jsonl')).length, 0, 'an unchanged one is not');
});

test('a meta file is read only when its transcript is', async () => {
  const root = freshDir();
  const { subagents } = await sessionWithSubagents(root);
  const cache = new Map();
  const reads = [];
  const readMeta = async file => { reads.push(file); return { agentType: 'builder', description: 'x' }; };
  await collectSessions({ roots: [{ root, surface: 'Code' }], cache, readMeta });
  assert.equal(reads.length, 2, 'the two subagents, never the top-level transcript');
  reads.length = 0;
  await collectSessions({ roots: [{ root, surface: 'Code' }], cache, readMeta });
  assert.deepEqual(reads, []);
  await appendFile(join(subagents, 'agent-a1.jsonl'), metaLine('A2', 'sess-m', 30));
  await collectSessions({ roots: [{ root, surface: 'Code' }], cache, readMeta });
  assert.deepEqual(reads, [join(subagents, 'agent-a1.jsonl')]);
});

test("sessions' names are kept even for a session with no usage, and never taken from a subagent", async () => {
  const root = freshDir();
  const { project, subagents } = await sessionWithSubagents(root);
  await writeFile(join(project, 'sess-q.jsonl'), JSON.stringify({ type: 'agent-name', agentName: 'Quiet', sessionId: 'sess-q' }) + '\n');
  await writeFile(join(subagents, 'agent-a3.jsonl'),
    JSON.stringify({ type: 'agent-name', agentName: 'Not a session name', sessionId: 'sess-m' }) + '\n' + metaLine('C', 'sess-m', 40));
  // A subagent whose session has no top-level file, so no read order can let a
  // parent's own name cover for it.
  const orphan = join(project, 'sess-z', 'subagents');
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, 'agent-z1.jsonl'),
    JSON.stringify({ type: 'agent-name', agentName: 'Orphan', sessionId: 'sess-z' }) + '\n' + metaLine('Z', 'sess-z', 50));
  const cache = new Map();
  for (let pass = 0; pass < 2; pass++) {
    const out = await collectSessions({ roots: [{ root, surface: 'Code' }], cache });
    assert.ok(out.sessionNames instanceof Map);
    assert.deepEqual([...out.sessionNames].sort(), [['sess-m', 'Lead'], ['sess-q', 'Quiet']], `pass ${pass + 1}`);
    assert.ok(!out.transcripts.some(t => t.sessionId === 'sess-q'), 'a session with no usage is still not a transcript');
  }
});
