// createdAt on every board item (board 17924110): stamped by the server when an item
// is added, kept when it is edited, and null ("unknown") for items made before it
// existed, never guessed. Every test runs against a throwaway store in a temp
// directory, and the HTTP tests against their own server on a random port, never the
// live board on :8322. All items are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createTodoStore, stampCreated, InvalidBoardError } from '../todos.mjs';
import { createHandler } from '../routes.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-created-')), 'todos.json');
const onDisk = path => JSON.parse(readFileSync(path, 'utf8'));
const byId = (list, id) => list.find(t => t.id === id);
const MADE = '2026-11-01T12:00:00.000Z';
const NOW = Date.parse('2026-11-25T15:00:00.000Z');

const pinned = async (ms, fn) => {
  const real = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = real; }
};

// ---- the rule, as a function ----

test('stampCreated: new items get the time, items on the board keep theirs, items from before get null', () => {
  const previous = [
    { id: 'old', text: 'made before createdAt', lane: 'idea' },
    { id: 'kept', text: 'made', lane: 'idea', createdAt: MADE },
    { id: 'unknown', text: 'already unknown', lane: 'idea', createdAt: null }
  ];
  const next = [
    { id: 'old', text: 'edited', lane: 'doing' },
    { id: 'kept', text: 'edited, and the writer tries a date of its own', lane: 'idea', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'unknown', text: 'still unknown', lane: 'idea', createdAt: '2026-11-20T00:00:00.000Z' },
    { id: 'new', text: 'added now', lane: 'idea' }
  ];
  const out = stampCreated(next, previous, NOW);
  assert.equal(byId(out, 'old').createdAt, null, 'made before it existed: unknown, not guessed');
  assert.equal(byId(out, 'kept').createdAt, MADE, 'a writer cannot change it');
  assert.equal(byId(out, 'unknown').createdAt, null, 'unknown stays unknown, even when a writer sends a date');
  assert.equal(byId(out, 'new').createdAt, new Date(NOW).toISOString());
});

test('stampCreated: a new item that brings a createdAt (an instant or null) keeps it; unknownWhenNew marks the rest null', () => {
  const next = [
    { id: 'a', text: 'a', lane: 'idea', createdAt: MADE },
    { id: 'b', text: 'b', lane: 'idea', createdAt: null },
    { id: 'c', text: 'c', lane: 'idea' }
  ];
  const out = stampCreated(next, [], NOW);
  assert.deepEqual(out.map(t => t.createdAt), [MADE, null, new Date(NOW).toISOString()]);
  const restoring = stampCreated(next, [], NOW, { unknownWhenNew: true });
  assert.deepEqual(restoring.map(t => t.createdAt), [MADE, null, null]);
});

test('stampCreated returns an unchanged item as the same object', () => {
  const item = { id: 1, text: 'x', lane: 'idea', createdAt: MADE };
  assert.equal(stampCreated([item], [item], NOW)[0], item);
});

// ---- through the store ----

test('the store stamps an added item with the write\'s time, and an edit keeps it', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await pinned(NOW, () => store.write([{ id: 1, text: 'first', lane: 'idea' }]));
  assert.equal(byId(onDisk(path), 1).createdAt, new Date(NOW).toISOString());
  // A writer that rebuilds its items from text, lane and tag (it drops the field), and
  // one that sends a different date: both keep the original.
  await pinned(NOW + 60_000, () => store.write([{ id: 1, text: 'edited', lane: 'doing' }]));
  await pinned(NOW + 120_000, () => store.write([{ id: 1, text: 'edited again', lane: 'done', createdAt: MADE }]));
  assert.equal(byId(onDisk(path), 1).createdAt, new Date(NOW).toISOString());
});

test('the first write after the change backfills every item already on the board as null, and it stays null', async () => {
  const path = tmp();
  // A board as it was before createdAt existed: no item has the key.
  writeFileSync(path, JSON.stringify([
    { id: 'a', text: 'old idea', lane: 'idea' },
    { id: 'b', text: 'old done', lane: 'done', doneAt: '2026-10-25T10:00:00.000Z' }
  ]));
  const store = createTodoStore(path);
  const current = await store.read();
  const written = await pinned(NOW, () => store.write([...current, { id: 'c', text: 'new', lane: 'idea' }]));
  assert.deepEqual(written.map(t => [t.id, t.createdAt]), [['a', null], ['b', null], ['c', new Date(NOW).toISOString()]]);
  await store.write(written.map(t => ({ ...t, text: `${t.text}!` })));
  assert.deepEqual(onDisk(path).map(t => t.createdAt), [null, null, new Date(NOW).toISOString()]);
});

test('a createdAt that is not an instant or null is refused, naming the item, and nothing is written', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 'k', text: 'k', lane: 'idea', createdAt: MADE }]);
  const before = readFileSync(path, 'utf8');
  for (const bad of ['2026-11-01', 'unknown', '', 0, true, {}]) {
    await assert.rejects(
      () => store.write([{ id: 'x', text: 'x', lane: 'idea', createdAt: bad }]),
      err => err instanceof InvalidBoardError && /item "x": createdAt must be an ISO 8601 date and time, or null/.test(err.message),
      `createdAt ${JSON.stringify(bad)} must be refused`
    );
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a restore marks an item it brings back with no createdAt as unknown, not as made at the restore', async () => {
  const path = tmp();
  const history = join(dirname(path), 'todos-history');
  mkdirSync(history, { recursive: true });
  // A copy saved before createdAt existed, and a board since then without its item.
  const copy = 'todos-20261020T120000000Z.json';
  writeFileSync(join(history, copy), JSON.stringify([{ id: 'gone', text: 'deleted since', lane: 'idea' }, { id: 'here', text: 'still here', lane: 'idea' }]));
  const store = createTodoStore(path);
  await pinned(NOW, () => store.write([{ id: 'here', text: 'still here', lane: 'idea' }]));
  await store.restore(copy);
  const board = onDisk(path);
  assert.equal(byId(board, 'gone').createdAt, null);
  assert.equal(byId(board, 'here').createdAt, new Date(NOW).toISOString(), 'an item on the board keeps its own');
});

// ---- over HTTP, as Jarvis's board-write and the page write ----

const serve = async path => {
  const server = createServer(createHandler({ cache: null, todos: createTodoStore(path), config: {}, log: () => {} }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/todos`;
  const put = (list, headers = {}) => fetch(base, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(list)
  });
  return { base, put, close: () => new Promise(r => server.close(r)) };
};

test('over HTTP: GET, add one, PUT with If-Match: the new item is stamped, the others keep theirs, and the answer says so', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify([{ id: 'a', text: 'a', lane: 'idea', createdAt: MADE }]));
  const s = await serve(path);
  try {
    const got = await fetch(s.base);
    const list = await got.json();
    const t0 = Date.now();
    const res = await s.put([...list, { id: 'b', text: 'b', lane: 'idea', tag: 'Ops', priority: 'P1' }], { 'If-Match': got.headers.get('etag') });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.equal(byId(answer, 'a').createdAt, MADE);
    assert.ok(Date.parse(byId(answer, 'b').createdAt) >= t0);
    assert.deepEqual(await (await fetch(s.base)).json(), answer, 'the GET after reads back what the PUT answered');
  } finally { await s.close(); }
});
