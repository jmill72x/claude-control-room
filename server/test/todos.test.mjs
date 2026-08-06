import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

test('a corrupt file is preserved and reported, never silently reseeded (I6)', async () => {
  const path = tmp();
  const real = [{ id: 1, text: 'months of real backlog', lane: 'doing', tag: 'Note' }];
  await createTodoStore(path).write(real);
  // Exactly what a crash mid-write used to leave behind.
  writeFileSync(path, JSON.stringify(real).slice(0, -6));

  await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);

  const kept = readdirSync(dirname(path)).filter(f => f.includes('.corrupt-'));
  assert.equal(kept.length, 1, 'the damaged file must be kept, not overwritten with seed items');
  assert.match(readFileSync(join(dirname(path), kept[0]), 'utf8'), /real backlog/);
});

test('a file holding valid JSON that is not a list is preserved too', async () => {
  const path = tmp();
  writeFileSync(path, '{"lane":"idea"}');
  await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);
  assert.equal(readdirSync(dirname(path)).filter(f => f.includes('.corrupt-')).length, 1);
});

test('an unreadable file is reported, not treated as a first run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-'));
  // A directory where a file is expected: readFile fails with EISDIR, which is
  // not ENOENT and so must never seed.
  const path = join(dir, 'todos.json');
  mkdirSync(path);
  await assert.rejects(() => createTodoStore(path).read(), /could not read/);
});

test('a write leaves no temp file behind and is never partially visible', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'x', lane: 'idea' }]);
  await store.write([{ id: 2, text: 'y', lane: 'done' }]);
  const leftovers = readdirSync(dirname(path)).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].id, 2);
});

test('a rejected write leaves the previous list intact on disk', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'keep me', lane: 'idea' }]);
  await assert.rejects(() => store.write([{ id: 2, text: 'bad', lane: 'nowhere' }]));
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].text, 'keep me');
});
