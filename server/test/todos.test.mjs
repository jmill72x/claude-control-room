import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore } from '../todos.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-')), 'todos.json');

test('seeds on first read', async () => {
  const store = createTodoStore(tmp());
  const todos = await store.read();
  assert.ok(todos.length > 0);
  assert.ok(todos.every(t => ['idea', 'doing', 'done'].includes(t.lane)));
});

test('writes survive a reread', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'x', lane: 'idea', tag: 'Note' }]);
  assert.deepEqual(await createTodoStore(path).read(), [{ id: 1, text: 'x', lane: 'idea', tag: 'Note' }]);
});

test('rejects a non-array payload', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write({ nope: true }));
});

test('rejects an unknown lane', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write([{ id: 1, text: 'x', lane: 'nowhere' }]));
});
