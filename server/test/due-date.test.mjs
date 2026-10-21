// The optional due date on a board item (`due`, YYYY-MM-DD). Every test runs
// against a throwaway store in a temp directory, and the HTTP tests against
// their own server on a random port, never the live board on :8322.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore, isDueDate, InvalidBoardError } from '../todos.mjs';
import { createHandler } from '../routes.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-due-')), 'todos.json');
const DATED = [
  { id: 'a', text: 'renew the domain', lane: 'idea', tag: 'MAP', priority: 'P1', due: '2026-10-21' },
  { id: 'b', text: 'no date', lane: 'doing', tag: 'Pi' },
  { id: 'c', text: 'cleared', lane: 'idea', due: '' },
  { id: 'd', text: 'null', lane: 'done', doneAt: '2026-10-01T12:00:00.000Z', due: null }
];

// ---- the date check ----

test('isDueDate takes real calendar dates written YYYY-MM-DD and nothing else', () => {
  for (const ok of ['2026-10-21', '2028-02-29', '2026-12-31', '2027-01-01']) assert.ok(isDueDate(ok), ok);
  for (const bad of [
    '2026-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '2026-04-31', // not on the calendar
    '2026-1-5', '10/21/2026', '2026-10-21T00:00:00Z', ' 2026-10-21', '2026-10-21 ', 'tomorrow',
    20261021, true, {}, ['2026-10-21']
  ]) assert.equal(isDueDate(bad), false, JSON.stringify(bad));
});

// ---- the store ----

test('due round-trips through the store unchanged, and items without it still save', async () => {
  const path = tmp();
  await createTodoStore(path).write(DATED);
  assert.deepEqual(await createTodoStore(path).read(), DATED);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DATED);
});

test('a malformed due date is refused, by name, and nothing is written', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write(DATED);
  const before = readFileSync(path, 'utf8');
  for (const bad of ['2026-02-30', '10-21', '2026/10/21', 0, false]) {
    await assert.rejects(
      () => store.write([...DATED, { id: 'x', text: 'x', lane: 'idea', due: bad }]),
      err => err instanceof InvalidBoardError && /due must be a date written YYYY-MM-DD/.test(err.message) && /"x"/.test(err.message),
      `due ${JSON.stringify(bad)} must be refused`
    );
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

// ---- over HTTP, on a server of its own ----

const serve = async path => {
  const handler = createHandler({ cache: null, todos: createTodoStore(path), config: {} });
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/todos`;
  const put = (list, headers = {}) => fetch(base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(list)
  });
  return { base, put, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
};

test('due round-trips over HTTP: PUT with If-Match, then GET returns it as sent', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify([{ id: 'b', text: 'no date', lane: 'doing', tag: 'Pi' }]));
  const s = await serve(path);
  try {
    const tag = (await fetch(s.base)).headers.get('etag');
    const res = await s.put(DATED, { 'If-Match': tag, Origin: s.origin }); // as the page sends it
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), DATED);
    const got = await fetch(s.base);
    assert.deepEqual(await got.json(), DATED);
    assert.equal(got.headers.get('etag'), res.headers.get('etag'));
  } finally { await s.close(); }
});

test('a plain PUT without due (Jarvis, curl, the mod) still lands', async () => {
  const s = await serve(tmp());
  try {
    const list = [{ id: 1, text: 'old shape', lane: 'idea', tag: 'Note', priority: 'P2' }];
    const res = await s.put(list);
    assert.equal(res.status, 200);
    assert.deepEqual(await (await fetch(s.base)).json(), list);
  } finally { await s.close(); }
});

test('a malformed due date over HTTP is a 400 naming the field, and the board is untouched', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(DATED));
  const before = readFileSync(path, 'utf8');
  const s = await serve(path);
  try {
    const res = await s.put([{ id: 'x', text: 'x', lane: 'idea', due: '21/10/2026' }]);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /due must be a date written YYYY-MM-DD/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { await s.close(); }
});

test('an unknown lane over HTTP is now a 400 too, not a 500', async () => {
  const s = await serve(tmp());
  try {
    const res = await s.put([{ id: 'x', text: 'x', lane: 'nowhere' }]);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /unknown lane/);
  } finally { await s.close(); }
});
