// The board's revision check (NEXT.md §8.1): a tab that read the board before
// someone else saved must not write its old copy back. Every test here runs
// against a throwaway store in a temp directory, and the HTTP tests against
// their own server on a random port, never the live board on :8322.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore, revisionOf, StaleRevisionError } from '../todos.mjs';
import { createHandler, parseIfMatch } from '../routes.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-rev-')), 'todos.json');
const A = [{ id: 1, text: 'a', lane: 'idea' }];
const B = [{ id: 1, text: 'a', lane: 'idea' }, { id: 2, text: 'b', lane: 'doing' }];
const C = [{ id: 3, text: 'c', lane: 'done' }];

// ---- the store ----

test('the revision is the hash of the file on disk, and changes with every write', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  const first = await store.save(A);
  assert.equal(first.revision, revisionOf(readFileSync(path)));
  const second = await store.save(B);
  assert.notEqual(second.revision, first.revision);
  assert.equal((await store.readState()).revision, second.revision);
});

test('readState returns the list and the revision of the same read', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write(A);
  const { todos, revision } = await store.readState();
  assert.deepEqual(todos, A);
  assert.equal(revision, revisionOf(readFileSync(path)));
});

test('a write made by another process (a restore, an edit by hand) changes the revision', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  const { revision } = await store.save(A);
  writeFileSync(path, JSON.stringify(C));
  await assert.rejects(() => store.save(B, { ifMatch: revision }), StaleRevisionError);
});

test('a save at the current revision lands', async () => {
  const store = createTodoStore(tmp());
  const { revision } = await store.save(A);
  const saved = await store.save(B, { ifMatch: revision });
  assert.deepEqual(saved.todos, B);
  assert.deepEqual(await store.read(), B);
});

test('a save from an older revision is refused and leaves the board alone', async () => {
  const store = createTodoStore(tmp());
  const old = (await store.save(A)).revision;
  const current = (await store.save(B)).revision; // Jarvis's write, after the tab read
  await assert.rejects(
    () => store.save(C, { ifMatch: old }),
    err => err instanceof StaleRevisionError && err.current === current && err.expected === old
  );
  assert.deepEqual(await store.read(), B);
});

test('a refused save keeps no history copy, since nothing was replaced', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  const old = (await store.save(A)).revision;
  await store.save(B);
  const before = (await store.copies()).length;
  await assert.rejects(() => store.save(C, { ifMatch: old }));
  assert.equal((await store.copies()).length, before);
});

test('a save without a revision still writes, whatever the board holds (curl, Jarvis, the mod)', async () => {
  const store = createTodoStore(tmp());
  await store.save(A);
  await store.save(B);
  const saved = await store.save(C);
  assert.deepEqual(saved.todos, C);
});

test('two saves from the same revision at once: exactly one lands', async () => {
  const store = createTodoStore(tmp());
  const { revision } = await store.save(A);
  const results = await Promise.allSettled([
    store.save(B, { ifMatch: revision }),
    store.save(C, { ifMatch: revision })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  const winner = results.find(r => r.status === 'fulfilled').value.todos;
  assert.deepEqual(await store.read(), winner);
});

test('a failed write does not jam the queue for the next one', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.save([{ id: 1, lane: 'nowhere' }]));
  assert.deepEqual((await store.save(A)).todos, A);
});

// ---- the If-Match header ----

test('parseIfMatch reads absent, *, strong, weak and listed tags', () => {
  assert.equal(parseIfMatch(undefined), null);
  assert.equal(parseIfMatch(''), null);
  assert.equal(parseIfMatch('*'), 'any');
  assert.deepEqual(parseIfMatch('"abc"'), ['abc']);
  assert.deepEqual(parseIfMatch('W/"abc"'), ['abc']);
  assert.deepEqual(parseIfMatch('"a", W/"b"'), ['a', 'b']);
  // Asked for a check but named nothing usable: it must not read as "no check".
  assert.deepEqual(parseIfMatch('abc'), ['']);
});

// ---- over HTTP, on a server of its own ----

const serve = async path => {
  const todos = createTodoStore(path);
  const handler = createHandler({ cache: null, todos, config: {} });
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/todos`;
  const put = (list, headers = {}) => fetch(base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(list)
  });
  return { base, put, close: () => new Promise(r => server.close(r)), origin: `http://127.0.0.1:${server.address().port}` };
};

test('GET sends the board as a bare list with its revision as an ETag, never cached', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    const res = await fetch(s.base);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), A);
    assert.equal(res.headers.get('etag'), `"${revisionOf(readFileSync(path))}"`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { await s.close(); }
});

test('the stale tab: a PUT with an old ETag gets 409 and the board is untouched', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    const tabTag = (await fetch(s.base)).headers.get('etag'); // the iPad tab opened this morning
    const jarvis = await s.put(B); // Jarvis's GET-modify-PUT: no header at all
    assert.equal(jarvis.status, 200);
    const tab = await s.put(C, { 'If-Match': tabTag, Origin: s.origin });
    assert.equal(tab.status, 409);
    const body = await tab.json();
    assert.match(body.error, /changed/);
    assert.equal(`"${body.revision}"`, jarvis.headers.get('etag'));
    assert.equal(tab.headers.get('etag'), jarvis.headers.get('etag'));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), B);
  } finally { await s.close(); }
});

test('a PUT with the current ETag lands and answers with the next one', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    const tag = (await fetch(s.base)).headers.get('etag');
    const res = await s.put(B, { 'If-Match': tag, Origin: s.origin });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), B);
    const next = res.headers.get('etag');
    assert.notEqual(next, tag);
    assert.equal(next, (await fetch(s.base)).headers.get('etag'));
    // and that tag works for the save after it
    assert.equal((await s.put(C, { 'If-Match': next, Origin: s.origin })).status, 200);
  } finally { await s.close(); }
});

test('Jarvis\'s block, unchanged: GET, modify, PUT the bare list with no revision header', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    const list = await (await fetch(s.base)).json();
    list.push({ id: 9, text: 'from jarvis', lane: 'idea', tag: 'Bug', priority: 'P2' });
    const res = await s.put(list);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 2);
  } finally { await s.close(); }
});

test('a browser PUT with no revision (a page from before this change) is refused with 428', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    const res = await s.put(C, { Origin: s.origin });
    assert.equal(res.status, 428);
    assert.match((await res.json()).error, /reload/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), A);
  } finally { await s.close(); }
});

test('If-Match: * is accepted as "no particular revision"', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    assert.equal((await s.put(B, { 'If-Match': '*', Origin: s.origin })).status, 200);
  } finally { await s.close(); }
});

test('a malformed If-Match is a 409, not a write', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(A));
  const s = await serve(path);
  try {
    assert.equal((await s.put(B, { 'If-Match': 'garbage' })).status, 409);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), A);
  } finally { await s.close(); }
});
