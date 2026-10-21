// The board's optional fields from the Orbit plan: `title`, `ask` and `owner`,
// which writers send, and `doneAt`, which the server keeps. Every test runs
// against a throwaway store in a temp directory, and the HTTP tests against their
// own server on a random port, never the live board on :8322. All items are
// invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore, InvalidBoardError, revisionOf } from '../todos.mjs';
import { createHandler } from '../routes.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-fields-')), 'todos.json');
const onDisk = path => JSON.parse(readFileSync(path, 'utf8'));
const byId = (list, id) => list.find(t => t.id === id);

const FULL = [
  {
    id: 'a', text: 'Renew the domain before it lapses next month', title: 'Renew the domain', lane: 'idea', tag: 'Ops',
    priority: 'P1', owner: 'builder',
    ask: { what: 'Pay the renewal invoice', why: 'The site goes dark if it lapses', kind: 'do', time: '09:30' }
  },
  { id: 'b', text: 'Pick a theme for the site', lane: 'doing', ask: { what: 'Choose one of the two drafts', kind: 'decide' } },
  { id: 'c', text: 'Shipped the thing', lane: 'done', doneAt: '2026-10-19T14:05:00.000Z' }
];

// ---- the checks ----

test('title, ask, owner and doneAt round-trip through the store exactly as sent', async () => {
  const path = tmp();
  const written = await createTodoStore(path).write(FULL);
  assert.deepEqual(written, FULL);
  assert.deepEqual(await createTodoStore(path).read(), FULL);
  assert.deepEqual(onDisk(path), FULL);
});

test('absent, null and empty mean none, and such items still save', async () => {
  const path = tmp();
  const list = [
    { id: 1, text: 'no fields at all', lane: 'idea' },
    { id: 2, text: 'empty ones', lane: 'idea', title: '', owner: '', ask: null },
    { id: 3, text: 'null ones', lane: 'doing', title: null, owner: null, ask: { what: 'x', kind: 'do', why: '', time: '' } }
  ];
  assert.deepEqual(await createTodoStore(path).write(list), list);
});

const BAD = [
  ['title', { title: 'x'.repeat(121) }, /title must be text of at most 120 characters/],
  ['title', { title: 7 }, /title must be text/],
  ['ask', { ask: 'call the bank' }, /ask must be an object/],
  ['ask', { ask: { what: '', kind: 'do' } }, /ask\.what must be text of 1 to 500 characters/],
  ['ask', { ask: { what: 'x'.repeat(501), kind: 'do' } }, /ask\.what must be text of 1 to 500 characters/],
  ['ask', { ask: { what: 'x', why: 'y'.repeat(301), kind: 'do' } }, /ask\.why must be text of at most 300 characters/],
  ['ask', { ask: { what: 'x', kind: 'maybe' } }, /ask\.kind must be "decide" or "do"/],
  ['ask', { ask: { what: 'x' } }, /ask\.kind must be "decide" or "do"/],
  ['ask', { ask: { what: 'x', kind: 'do', time: '9:30' } }, /ask\.time must be a 24-hour HH:MM time/],
  ['ask', { ask: { what: 'x', kind: 'do', time: '24:00' } }, /ask\.time must be a 24-hour HH:MM time/],
  ['ask', { ask: { what: 'x', kind: 'do', time: '12:60' } }, /ask\.time must be a 24-hour HH:MM time/],
  ['ask', { ask: { what: 'x', kind: 'do', when: 'soon' } }, /ask\.when is not a field ask takes/],
  ['owner', { owner: 'Has Caps' }, /owner must be an agent key/],
  ['owner', { owner: '../etc' }, /owner must be an agent key/],
  ['owner', { owner: 3 }, /owner must be an agent key/],
  ['doneAt', { lane: 'done', doneAt: 'yesterday' }, /doneAt must be an ISO 8601 date and time/],
  ['doneAt', { lane: 'done', doneAt: '2026-10-19' }, /doneAt must be an ISO 8601 date and time/],
  ['doneAt', { lane: 'done', doneAt: '2026-02-30T10:00:00Z' }, /doneAt must be an ISO 8601 date and time/]
];

test('a bad field is refused by item and by name, and nothing is written', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write(FULL);
  const before = readFileSync(path, 'utf8');
  for (const [field, extra, message] of BAD) {
    await assert.rejects(
      () => store.write([...FULL, { id: 'x9', text: 'invented', lane: 'idea', ...extra }]),
      err => err instanceof InvalidBoardError && message.test(err.message) && err.message.startsWith('item "x9": '),
      `${field} ${JSON.stringify(extra)} must be refused`
    );
  }
  assert.equal(readFileSync(path, 'utf8'), before);
});

// ---- doneAt ----

test('an item that enters Done gets the write\'s time, and so does a new item added straight to Done', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 'a', text: 'a', lane: 'doing' }]);
  const t0 = Date.now();
  const written = await store.write([{ id: 'a', text: 'a', lane: 'done' }, { id: 'n', text: 'new', lane: 'done' }]);
  const t1 = Date.now();
  for (const id of ['a', 'n']) {
    const at = byId(written, id).doneAt;
    assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(at) >= t0 && Date.parse(at) <= t1, `${id}: ${at}`);
  }
  assert.deepEqual(onDisk(path), written);
});

test('an item still in Done keeps its doneAt when a writer drops it, and keeps one a writer sends', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 'c', text: 'c', lane: 'done', doneAt: '2026-10-19T14:05:00.000Z' }]);
  // A writer that rebuilds its items from text, lane and tag alone.
  assert.equal(byId(await store.write([{ id: 'c', text: 'c', lane: 'done' }]), 'c').doneAt, '2026-10-19T14:05:00.000Z');
  assert.equal(byId(await store.write([{ id: 'c', text: 'c', lane: 'done', doneAt: null }]), 'c').doneAt, '2026-10-19T14:05:00.000Z');
  assert.equal(byId(await store.write([{ id: 'c', text: 'c', lane: 'done', doneAt: '' }]), 'c').doneAt, '2026-10-19T14:05:00.000Z');
  assert.equal(byId(await store.write([{ id: 'c', text: 'c', lane: 'done', doneAt: '2026-10-18T09:00:00-04:00' }]), 'c').doneAt, '2026-10-18T09:00:00-04:00');
});

test('an item that leaves Done loses its doneAt, and an item outside Done never carries one', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 'c', text: 'c', lane: 'done', doneAt: '2026-10-19T14:05:00.000Z' }]);
  const reopened = await store.write([{ id: 'c', text: 'c', lane: 'idea', doneAt: '2026-10-19T14:05:00.000Z' }]);
  assert.equal('doneAt' in byId(reopened, 'c'), false);
  assert.equal('doneAt' in byId(onDisk(path), 'c'), false);
  // Finished again later: a new stamp, not the old one.
  const again = await store.write([{ id: 'c', text: 'c', lane: 'done' }]);
  assert.notEqual(byId(again, 'c').doneAt, '2026-10-19T14:05:00.000Z');
});

test('an item finished before doneAt existed stays without one while it stays in Done', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify([{ id: 'old', text: 'finished long ago', lane: 'done' }]));
  const written = await createTodoStore(path).write([{ id: 'old', text: 'finished long ago, reworded', lane: 'done' }]);
  assert.equal('doneAt' in byId(written, 'old'), false);
});

test('a restore follows the doneAt rules too', async () => {
  const path = tmp();
  // An old board, from before doneAt: c and e both done, neither stamped.
  writeFileSync(path, JSON.stringify([{ id: 'c', text: 'c', lane: 'done' }, { id: 'e', text: 'e', lane: 'done' }]));
  const store = createTodoStore(path);
  // Today: c is done with a stamp, e was reopened. This write keeps the old board as a copy.
  await store.write([{ id: 'c', text: 'c', lane: 'done', doneAt: '2026-10-19T14:05:00.000Z' }, { id: 'e', text: 'e', lane: 'doing' }]);
  const [copy] = await store.copies();
  const t0 = Date.now();
  await store.restore(copy.file);
  const restored = onDisk(path);
  // c never left Done, so its stamp comes back; e enters Done again, so it is stamped now.
  assert.equal(byId(restored, 'c').doneAt, '2026-10-19T14:05:00.000Z');
  assert.ok(Date.parse(byId(restored, 'e').doneAt) >= t0);
});

// ---- over HTTP, on a server of its own ----

const serve = async path => {
  const server = createServer(createHandler({ cache: null, todos: createTodoStore(path), config: {} }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/todos`;
  const put = (list, headers = {}) => fetch(base, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(list)
  });
  return { base, origin, put, close: () => new Promise(r => server.close(r)) };
};

test('over HTTP: the new fields round-trip, and a bad kind is a 400 that names it, with the board untouched', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify([{ id: 'b', text: 'b', lane: 'doing' }]));
  const s = await serve(path);
  try {
    const tag = (await fetch(s.base)).headers.get('etag');
    const res = await s.put(FULL, { 'If-Match': tag, Origin: s.origin });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), FULL);
    assert.deepEqual(await (await fetch(s.base)).json(), FULL);
    const before = readFileSync(path, 'utf8');
    const bad = await s.put([{ id: 'q', text: 'q', lane: 'idea', ask: { what: 'x', kind: 'later' } }]);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /^item "q": ask\.kind must be "decide" or "do"/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { await s.close(); }
});

test('over HTTP: when the server adds doneAt, the answer carries it and the ETag of what was written', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify([{ id: 'a', text: 'a', lane: 'doing', title: 'A' }]));
  const s = await serve(path);
  try {
    const tag = (await fetch(s.base)).headers.get('etag');
    const sent = [{ id: 'a', text: 'a', lane: 'done', title: 'A' }];
    const res = await s.put(sent, { 'If-Match': tag, Origin: s.origin });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.ok(answer[0].doneAt, 'the answer carries the doneAt the server added');
    const next = res.headers.get('etag');
    assert.equal(next, `"${revisionOf(readFileSync(path))}"`);
    assert.notEqual(next, `"${revisionOf(JSON.stringify(sent, null, 2))}"`);
    assert.equal((await fetch(s.base)).headers.get('etag'), next);
    // The page's next save, made from the answer, lands.
    assert.equal((await s.put(answer, { 'If-Match': next, Origin: s.origin })).status, 200);
  } finally { await s.close(); }
});

test('over HTTP, with the new fields on the board: a stale If-Match is 409, a browser PUT without one 428, and curl still writes', async () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify(FULL));
  const s = await serve(path);
  try {
    const before = readFileSync(path, 'utf8');
    const stale = await s.put(FULL, { 'If-Match': '"0000000000000000"', Origin: s.origin });
    assert.equal(stale.status, 409);
    const old = await s.put(FULL, { Origin: s.origin });
    assert.equal(old.status, 428);
    assert.equal(readFileSync(path, 'utf8'), before);
    const curl = await s.put([...FULL, { id: 'd', text: 'from curl', lane: 'idea', title: 'From curl' }]);
    assert.equal(curl.status, 200);
    assert.equal(byId(onDisk(path), 'd').title, 'From curl');
  } finally { await s.close(); }
});

// ---- the hardening from the 2026-10-21 security review ----
// Every item on the live board and in its 20 copies passed these on 2026-10-21,
// so no write that works today is refused by them.

const refused = async (list, pattern) => {
  const path = tmp();
  writeFileSync(path, JSON.stringify([{ id: 'keep', text: 'kept', lane: 'idea', tag: 'Ops' }]));
  const store = createTodoStore(path);
  await assert.rejects(() => store.write(list), err => err instanceof InvalidBoardError && pattern.test(err.message));
  assert.deepEqual(onDisk(path), [{ id: 'keep', text: 'kept', lane: 'idea', tag: 'Ops' }], 'nothing was written');
};

test('an id must be text or a number', async () => {
  for (const id of [undefined, '', null, true, { n: 1 }, [1]]) {
    await refused([{ ...(id === undefined ? {} : { id }), text: 'x', lane: 'idea', tag: 'Ops' }], /item 1: id must be non-empty text or a number/);
  }
  const path = tmp();
  const ok = await createTodoStore(path).write([{ id: 7, text: 'a', lane: 'idea', tag: 'Ops' }, { id: 'i-8', text: 'b', lane: 'idea' }]);
  assert.equal(ok.length, 2);
});

test('text must be text, and a tag text or left out', async () => {
  for (const text of [undefined, null, 5, { s: 'x' }]) {
    await refused([{ id: 'a', ...(text === undefined ? {} : { text }), lane: 'idea' }], /item "a": text must be text/);
  }
  for (const tag of [null, 5, ['Ops']]) {
    await refused([{ id: 'a', text: 'x', lane: 'idea', tag }], /item "a": tag must be text, or left out/);
  }
  const ok = await createTodoStore(tmp()).write([{ id: 'a', text: '', lane: 'idea', tag: '' }, { id: 'b', text: 'no tag', lane: 'idea' }]);
  assert.equal(ok.length, 2, 'an empty text or tag, and no tag at all, are still fine');
});

test('a title or an ask may not hold control characters or ones that reorder text', async () => {
  const bad = ['\u0000', '\u0007', '\t', '\n', '\u001b', '\u007f', '\u0085', '\u009f', '\u202a', '\u202e', '\u2066', '\u2069'];
  for (const ch of bad) {
    await refused([{ id: 'a', text: 'x', lane: 'idea', title: `Pay${ch}the bill` }], /item "a": title must not hold control characters/);
    await refused([{ id: 'a', text: 'x', lane: 'idea', ask: { what: `Pay${ch}the bill`, kind: 'do' } }], /item "a": ask\.what must not hold control characters/);
    await refused([{ id: 'a', text: 'x', lane: 'idea', ask: { what: 'Pay', why: `It${ch}lapses`, kind: 'do' } }], /item "a": ask\.why must not hold control characters/);
  }
  const fine = { id: 'a', text: 'Line one\nline two', lane: 'idea', title: 'Pay the bill — today 🙂 (ünïcode)', ask: { what: 'Pay it, then file the receipt', why: 'It lapses on the 3rd', kind: 'do' } };
  assert.equal((await createTodoStore(tmp()).write([fine])).length, 1, "ordinary punctuation, accents and emoji are fine, and text keeps its newlines");
});

test("size() is the board file's length in bytes, and 0 before there is one", async () => {
  const path = tmp();
  const store = createTodoStore(path);
  assert.equal(await store.size(), 0);
  await store.write([{ id: 'a', text: 'héllo', lane: 'idea', tag: 'Ops' }]);
  assert.equal(await store.size(), Buffer.byteLength(readFileSync(path)));
});
