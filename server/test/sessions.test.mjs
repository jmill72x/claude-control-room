import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../collectors/sessions.mjs';

const freshDir = () => mkdtempSync(join(tmpdir(), 'ccr-sessions-'));
const missingPath = () => join(tmpdir(), `ccr-missing-${Math.random().toString(36).slice(2)}`);

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
