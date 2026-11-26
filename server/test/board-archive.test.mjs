// The done-lane archive (board 17924110): Done items finished at least N days ago move
// from the board into data/todos-archive.json, on the server and in the board's own
// queue; they stay readable, can be brought back, and nothing is ever deleted. Every
// test runs against a throwaway store in a temp directory, and the HTTP tests against
// their own server on a random port, never the live board on :8322. All items are
// invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  createTodoStore, pickArchivable, archiveClock, ArchiveError, UNDATED_DONE, DAY_MS, ARCHIVE_QUIET_MS, revisionOf
} from '../todos.mjs';
import { createHandler } from '../routes.mjs';
import {
  readBoardArchiveConfig, createArchiveSweeper, archiveLogLine, ARCHIVE_DAYS_MAX, RESTORE_MAX_IDS
} from '../lib/board-archive.mjs';
import { preview, previewLines } from '../archive-preview.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-archive-')), 'todos.json');
const archiveOf = path => join(dirname(path), 'data', 'todos-archive.json');
const onDisk = path => JSON.parse(readFileSync(path, 'utf8'));
const ids = list => list.map(t => t.id);
const iso = ms => new Date(ms).toISOString();
// The move's clock: far enough past the real one that the board's last write is
// outside the quiet window, as an hourly run would find it.
const LATER = () => Date.now() + ARCHIVE_QUIET_MS + 60_000;
const MADE = '2026-11-01T12:00:00.000Z';

// A board with one of each: old done, recent done, undated done, and open items.
const board = now => [
  { id: 'idea', text: 'an open idea', lane: 'idea', tag: 'Ops', createdAt: MADE },
  { id: 'doing', text: 'in hand', lane: 'doing', tag: 'Ops', createdAt: MADE },
  { id: 'old', text: 'finished 20 days ago', lane: 'done', tag: 'Ops', doneAt: iso(now - 20 * DAY_MS), createdAt: MADE },
  { id: 'recent', text: 'finished 3 days ago', lane: 'done', tag: 'Ops', doneAt: iso(now - 3 * DAY_MS), createdAt: MADE },
  { id: 'undated', text: 'finished before doneAt existed', lane: 'done', tag: 'Ops' }
];
// Writes a board straight to disk, as it would sit after earlier saves.
const seed = (path, list) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2));
};

// ---- which items go ----

test('pickArchivable takes Done items at least N days old and nothing else', () => {
  const now = Date.parse('2026-11-25T12:00:00.000Z');
  const list = board(now);
  assert.deepEqual(ids(pickArchivable(list, { days: 14, now })), ['old', 'undated']);
  assert.deepEqual(ids(pickArchivable(list, { days: 3, now })), ['old', 'recent', 'undated'], 'exactly N days old goes');
  assert.deepEqual(ids(pickArchivable(list, { days: 21, now })), ['undated'], 'undated counts from the end of 2026-10-21');
  assert.deepEqual(ids(pickArchivable(list, { days: 40, now })), [], 'and is never taken sooner than that');
  for (const days of [0, -1, 1.5, null, '14']) assert.deepEqual(pickArchivable(list, { days, now }), [], `days ${days}`);
  const open = [{ id: 'x', text: 'x', lane: 'idea', doneAt: iso(now - 90 * DAY_MS) }];
  assert.deepEqual(pickArchivable(open, { days: 1, now }), [], 'an open item never goes, whatever it carries');
});

test('archiveClock: doneAt, else the end of 2026-10-21; a later return from the archive wins', () => {
  assert.equal(archiveClock({ doneAt: MADE }), Date.parse(MADE));
  assert.equal(archiveClock({}), UNDATED_DONE);
  assert.equal(UNDATED_DONE, Date.parse('2026-10-22T00:00:00.000Z'));
  assert.equal(archiveClock({ doneAt: MADE, restoredAt: '2026-11-20T00:00:00.000Z' }), Date.parse('2026-11-20T00:00:00.000Z'));
  assert.equal(archiveClock({ doneAt: '2026-11-20T00:00:00.000Z', restoredAt: MADE }), Date.parse('2026-11-20T00:00:00.000Z'));
  assert.equal(archiveClock({ restoredAt: '2026-11-20T00:00:00.000Z' }), Date.parse('2026-11-20T00:00:00.000Z'));
});

// ---- the move ----

test('a move takes the old Done items off the board into the archive, whole, and keeps everything else', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  const result = await store.archiveDone({ days: 14, now });
  assert.equal(result.moved, 2);
  assert.deepEqual(result.ids, ['old', 'undated']);
  assert.equal(result.first, true);
  assert.ok(result.after < result.before);
  assert.deepEqual(ids(onDisk(path)), ['idea', 'doing', 'recent']);
  const archived = onDisk(archiveOf(path));
  assert.deepEqual(ids(archived), ['old', 'undated']);
  // Each archived item is the board's item as it was, plus archivedAt; an undated one
  // keeps no doneAt (none is made up), and one from before createdAt gets null.
  const [old, undated] = archived;
  assert.deepEqual(old, { ...board(now)[2], archivedAt: iso(now) });
  assert.equal('doneAt' in undated, false);
  assert.equal(undated.createdAt, null);
  assert.equal(undated.archivedAt, iso(now));
  // Nothing is lost: every id is in exactly one of the two files.
  assert.deepEqual([...ids(onDisk(path)), ...ids(archived)].sort(), ids(board(now)).sort());
  assert.equal(statSync(archiveOf(path)).mode & 0o777, 0o600, 'the archive holds board content: 0600');
  assert.equal(result.revision, revisionOf(readFileSync(path)));
});

test('before the first move a pinned copy of the whole board is kept, never pruned, listed and restorable', async () => {
  const path = tmp();
  const now = LATER();
  const before = board(now);
  seed(path, before);
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const history = join(dirname(path), 'todos-history');
  const pinnedName = readdirSync(history).find(f => f.startsWith('todos-pre-archive-'));
  assert.match(pinnedName, /^todos-pre-archive-\d{8}T\d{9}Z\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(join(history, pinnedName), 'utf8')), before, 'the board exactly as it was');
  // A second move makes no second pinned copy.
  seed(path, [...onDisk(path), { id: 'old2', text: 'also old', lane: 'done', doneAt: iso(now - 30 * DAY_MS), createdAt: MADE }]);
  utimesSync(path, new Date(now - ARCHIVE_QUIET_MS - 1000), new Date(now - ARCHIVE_QUIET_MS - 1000));
  assert.equal((await store.archiveDone({ days: 14, now })).first, false);
  assert.equal(readdirSync(history).filter(f => f.startsWith('todos-pre-archive-')).length, 1);
  // 25 more saves push every rolling copy out, but not the pinned one.
  for (let n = 0; n < 25; n++) await store.write([...onDisk(path).filter(t => t.id !== `n${n - 1}`), { id: `n${n}`, text: `${n}`, lane: 'idea' }]);
  assert.ok(existsSync(join(history, pinnedName)));
  const listed = await store.copies();
  assert.equal(listed.length, 21);
  assert.deepEqual(listed.find(c => c.file === pinnedName), { file: pinnedName, items: before.length, pinned: true });
});

test('a board written in the last two minutes is left for the next run', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  const now = Date.now();
  // On disk first, so the undated item is one from before (a write of a new undated
  // Done item would stamp it), then a save just now.
  seed(path, board(now));
  await store.write(board(now));
  const held = await store.archiveDone({ days: 14, now });
  assert.equal(held.moved, 0);
  assert.match(held.held, /written in the last two minutes/);
  assert.equal(existsSync(archiveOf(path)), false);
  // Counted from the file's own time, so a slow write can't make this flaky.
  assert.equal((await store.archiveDone({ days: 14, now: statSync(path).mtimeMs + ARCHIVE_QUIET_MS - 5 })).moved, 0, 'just inside the window');
  assert.equal((await store.archiveDone({ days: 14, now: statSync(path).mtimeMs + ARCHIVE_QUIET_MS + 1 })).moved, 2);
});

test('nothing old enough: no write at all, so the revision stays and no copy is made', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now).filter(t => t.id !== 'old' && t.id !== 'undated'));
  const rev = revisionOf(readFileSync(path));
  const store = createTodoStore(path);
  assert.deepEqual(await store.archiveDone({ days: 14, now }), { moved: 0 });
  assert.equal(revisionOf(readFileSync(path)), rev);
  assert.equal(existsSync(join(dirname(path), 'todos-history')), false);
  assert.equal(existsSync(archiveOf(path)), false);
});

test('an archive that cannot be parsed stops the move, and both files stay as they were', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  mkdirSync(dirname(archiveOf(path)), { recursive: true });
  writeFileSync(archiveOf(path), '[{"id": "x", "te');
  const boardBefore = readFileSync(path, 'utf8');
  const store = createTodoStore(path);
  await assert.rejects(() => store.archiveDone({ days: 14, now }), err => err instanceof ArchiveError && err.code === 'UNREADABLE');
  assert.equal(readFileSync(path, 'utf8'), boardBefore);
  assert.equal(readFileSync(archiveOf(path), 'utf8'), '[{"id": "x", "te');
  // The board still saves, adds included: a broken archive never blocks it.
  await store.write([...onDisk(path), { id: 'add', text: 'added', lane: 'idea' }]);
  assert.ok(onDisk(path).some(t => t.id === 'add'));
});

test('a board the PUT rules would refuse is not archived from: both files stay as they were', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, [...board(now), { id: 'bad', text: 'hand-edited', lane: 'idea', priority: 'P9' }]);
  const before = readFileSync(path, 'utf8');
  const store = createTodoStore(path);
  await assert.rejects(() => store.archiveDone({ days: 14, now }), /unknown priority/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(existsSync(archiveOf(path)), false);
});

test('an item left in both files by a crash does not block a save, and the next move replaces the archive\'s copy', async () => {
  const path = tmp();
  const now = LATER();
  const list = board(now);
  seed(path, list);
  mkdirSync(dirname(archiveOf(path)), { recursive: true });
  writeFileSync(archiveOf(path), JSON.stringify([{ ...list[2], text: 'stale copy', archivedAt: iso(now - DAY_MS) }]));
  const store = createTodoStore(path);
  await store.write(list.map(t => ({ ...t })));
  utimesSync(path, new Date(now - ARCHIVE_QUIET_MS - 1000), new Date(now - ARCHIVE_QUIET_MS - 1000));
  await store.archiveDone({ days: 14, now });
  const archived = onDisk(archiveOf(path));
  assert.deepEqual(ids(archived).sort(), ['old', 'undated']);
  assert.equal(archived.find(t => t.id === 'old').text, 'finished 20 days ago', 'the board\'s copy, the newer, is the one kept');
});

// ---- a write that would bring archived items back ----

test('a save that brings back an archived id is refused (ARCHIVED), naming it, and nothing is written', async () => {
  const path = tmp();
  const now = LATER();
  const before = board(now);
  seed(path, before);
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const afterMove = readFileSync(path, 'utf8');
  // A copy read before the move, saved with no revision (curl, an old script).
  await assert.rejects(() => store.save(before), err => err instanceof ArchiveError && err.code === 'ARCHIVED' && err.ids.join() === 'old,undated');
  assert.equal(readFileSync(path, 'utf8'), afterMove);
  assert.deepEqual(ids(onDisk(archiveOf(path))), ['old', 'undated'], 'the archive is untouched');
});

test('a save of the board as it is now, with an item added, lands: only archived ids are refused', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const saved = await store.save([...onDisk(path), { id: 'new', text: 'new', lane: 'idea' }]);
  assert.deepEqual(ids(saved.todos), ['idea', 'doing', 'recent', 'new']);
});

// ---- bringing an item back ----

test('unarchive puts an item back as it was, stamped restoredAt, and takes it out of the archive', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const t0 = Date.now();
  const back = await store.unarchive(['old']);
  assert.deepEqual(back.returned, ['old']);
  const item = back.todos.find(t => t.id === 'old');
  const { restoredAt, ...rest } = item;
  assert.deepEqual(rest, board(now)[2], 'every field as it was archived, archivedAt off');
  assert.ok(Date.parse(restoredAt) >= t0);
  assert.deepEqual(ids(onDisk(archiveOf(path))), ['undated']);
  assert.equal(back.revision, revisionOf(readFileSync(path)));
  // The next move counts its days from its return, so it stays for 14 more days.
  utimesSync(path, new Date(now - ARCHIVE_QUIET_MS - 1000), new Date(now - ARCHIVE_QUIET_MS - 1000));
  const soon = Date.parse(restoredAt) + 13 * DAY_MS;
  assert.deepEqual((await store.archiveDone({ days: 14, now: soon })).ids, ['recent'], 'old was back less than 14 days');
  utimesSync(path, new Date(now - ARCHIVE_QUIET_MS - 1000), new Date(now - ARCHIVE_QUIET_MS - 1000));
  assert.deepEqual((await store.archiveDone({ days: 14, now: Date.parse(restoredAt) + 14 * DAY_MS })).ids, ['old']);
});

test('restoredAt is the server\'s: an edit keeps it, a writer cannot add or change it', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const { todos } = await store.unarchive(['old']);
  const stamp = todos.find(t => t.id === 'old').restoredAt;
  const edited = await store.write(todos.map(t => {
    const { restoredAt: _r, ...rest } = t;
    return t.id === 'recent' ? { ...rest, restoredAt: iso(now) } : rest;
  }));
  assert.equal(edited.find(t => t.id === 'old').restoredAt, stamp);
  assert.equal('restoredAt' in edited.find(t => t.id === 'recent'), false);
});

test('unarchive refuses an id the archive does not hold (404) or one already on the board (409), writing nothing', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const boardBefore = readFileSync(path, 'utf8');
  const archiveBefore = readFileSync(archiveOf(path), 'utf8');
  await assert.rejects(() => store.unarchive(['old', 'nope']), err => err.code === 'NOT_ARCHIVED' && err.status === 404 && err.ids.join() === 'nope');
  // A crash's leftover: in both files. Bringing it back would make two.
  const list = onDisk(path);
  writeFileSync(path, JSON.stringify([...list, JSON.parse(archiveBefore)[0]].map(({ archivedAt: _a, ...t }) => t), null, 2));
  const both = readFileSync(path, 'utf8');
  await assert.rejects(() => store.unarchive(['old']), err => err.code === 'ON_BOARD' && err.status === 409);
  assert.equal(readFileSync(path, 'utf8'), both);
  assert.equal(readFileSync(archiveOf(path), 'utf8'), archiveBefore);
  writeFileSync(path, boardBefore);
});

test('a restore from todos-history brings archived items back once: off the archive, onto the board', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const pinnedName = (await store.copies()).find(c => c.pinned).file;
  const result = await store.restore(pinnedName, { force: true });
  assert.equal(result.unarchived, 2);
  assert.deepEqual(ids(onDisk(path)), ids(board(now)));
  assert.deepEqual(onDisk(archiveOf(path)), [], 'each item in one file only');
  assert.ok(onDisk(path).filter(t => t.id === 'old' || t.id === 'undated').every(t => typeof t.restoredAt === 'string'));
  assert.equal(onDisk(path).find(t => t.id === 'undated').createdAt, null, 'the archive kept its unknown; the restore keeps it');
  assert.equal('doneAt' in onDisk(path).find(t => t.id === 'undated'), false, 'an undated item is not stamped as finished at the restore');
  assert.equal(onDisk(path).find(t => t.id === 'old').doneAt, board(now)[2].doneAt);
});

test('an item brought back keeps the archive\'s createdAt and doneAt, even from a copy that has neither', async () => {
  const path = tmp();
  const now = LATER();
  const list = board(now);
  seed(path, list);
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  // A copy of 'old' with no createdAt or doneAt, as a hand-made or very old copy might be.
  const history = join(dirname(path), 'todos-history');
  const copy = 'todos-20261001T000000000Z.json';
  writeFileSync(join(history, copy), JSON.stringify([...onDisk(path), { id: 'old', text: 'finished 20 days ago', lane: 'done', tag: 'Ops' }]));
  await store.restore(copy);
  const back = onDisk(path).find(t => t.id === 'old');
  assert.equal(back.createdAt, MADE);
  assert.equal(back.doneAt, list[2].doneAt);
  const unarchived = await store.unarchive(['undated']);
  assert.equal('doneAt' in unarchived.todos.find(t => t.id === 'undated'), false);
});

test('the board is never reseeded over an archive: a missing board with an archive beside it is an error', async () => {
  const path = tmp();
  mkdirSync(dirname(archiveOf(path)), { recursive: true });
  writeFileSync(archiveOf(path), '[]');
  await assert.rejects(() => createTodoStore(path).read(), /its archive is still there/);
  assert.equal(existsSync(path), false);
});

test('archivedAt on the live board is refused: only the archive carries it', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write([{ id: 'a', text: 'a', lane: 'done', archivedAt: MADE }]), /archivedAt is kept only in the archive/);
});

// ---- over HTTP, on a server of its own ----

const serve = async (path, { archiveDays = 14 } = {}) => {
  const lines = [];
  const store = createTodoStore(path);
  const server = createServer(createHandler({ cache: null, todos: store, config: {}, archiveDays, log: l => lines.push(l) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/todos`;
  const put = (list, headers = {}) => fetch(base, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(list)
  });
  const restore = (body, headers = {}) => fetch(`${base}/archive/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  return { store, base, origin, put, restore, lines, close: () => new Promise(r => server.close(r)) };
};

test('over HTTP: the move changes the ETag, so a tab or board-write holding the old one gets 409 and brings nothing back', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const s = await serve(path);
  try {
    const got = await fetch(s.base);
    const tag = got.headers.get('etag');
    const copy = await got.json();
    await s.store.archiveDone({ days: 14, now }); // lands between the GET and the PUT
    const afterMove = readFileSync(path, 'utf8');
    // The page and the mod (Origin, If-Match), and board-write (If-Match, no Origin).
    for (const headers of [{ 'If-Match': tag, Origin: s.origin }, { 'If-Match': tag }]) {
      const res = await s.put(copy.map(t => (t.id === 'idea' ? { ...t, text: 'edited' } : t)), headers);
      assert.equal(res.status, 409);
      assert.equal(readFileSync(path, 'utf8'), afterMove, 'nothing written');
    }
    // board-write's rerun: a fresh GET has no archived id, so its check sees no drop.
    const again = await fetch(s.base);
    const fresh = await again.json();
    assert.deepEqual(ids(fresh), ['idea', 'doing', 'recent']);
    const res = await s.put(fresh.map(t => (t.id === 'idea' ? { ...t, text: 'edited' } : t)), { 'If-Match': again.headers.get('etag') });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).length, fresh.length, 'board-write\'s read-back count matches');
  } finally { await s.close(); }
});

test('over HTTP: a PUT with no If-Match from a copy read before the move is a 409 that names the archived ids', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const s = await serve(path);
  try {
    const copy = await (await fetch(s.base)).json();
    await s.store.archiveDone({ days: 14, now });
    const res = await s.put(copy);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body.archived, ['old', 'undated']);
    assert.match(body.error, /in the archive/);
    assert.equal(res.headers.get('etag'), `"${revisionOf(readFileSync(path))}"`);
    assert.deepEqual(ids(onDisk(path)), ['idea', 'doing', 'recent']);
  } finally { await s.close(); }
});

test('over HTTP: GET /api/todos/archive answers the setting and the items; a restore answers the board and its ETag', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const s = await serve(path);
  try {
    const empty = await fetch(`${s.base}/archive`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await empty.json(), { days: 14, total: 0, offset: 0, items: [] });
    await s.store.archiveDone({ days: 14, now });
    const listed = await (await fetch(`${s.base}/archive`)).json();
    assert.deepEqual(ids(listed.items), ['old', 'undated'], 'newest finished first, undated last');
    assert.equal(listed.total, 2);
    const res = await s.restore({ ids: ['undated'] }, { Origin: s.origin });
    assert.equal(res.status, 200);
    const answer = await res.json();
    assert.deepEqual(ids(answer), ['idea', 'doing', 'recent', 'undated']);
    assert.equal(res.headers.get('etag'), (await fetch(s.base)).headers.get('etag'));
    assert.deepEqual(ids((await (await fetch(`${s.base}/archive`)).json()).items), ['old']);
    assert.deepEqual(s.lines, ['board: 1 item brought back from the archive']);
  } finally { await s.close(); }
});

test('over HTTP: the restore route keeps the board\'s guards and checks its body', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const s = await serve(path, { archiveDays: null });
  try {
    await s.store.archiveDone({ days: 14, now });
    assert.deepEqual((await (await fetch(`${s.base}/archive`)).json()).days, null, 'off still reads the archive');
    const before = readFileSync(path, 'utf8');
    assert.equal((await s.restore({ ids: ['old'] }, { Origin: 'http://evil.example' })).status, 403);
    const plain = await fetch(`${s.base}/archive/restore`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"ids":["old"]}' });
    assert.equal(plain.status, 415);
    for (const body of [{}, { ids: [] }, { ids: 'old' }, { ids: [null] }, { ids: [''] }, { ids: Array.from({ length: RESTORE_MAX_IDS + 1 }, (_, i) => `x${i}`) }]) {
      assert.equal((await s.restore(body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    const missing = await s.restore({ ids: ['nope'] });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /the archive holds no item "nope"/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { await s.close(); }
});

// ---- the setting and the timer ----

test('readBoardArchiveConfig: off unless board.archiveDays is a whole number of days from 1 to 365', () => {
  assert.deepEqual(readBoardArchiveConfig({}), { on: false, state: 'unset', days: null, problems: [] });
  assert.deepEqual(readBoardArchiveConfig({ board: { archiveDays: null } }), { on: false, state: 'off', days: null, problems: [] });
  assert.deepEqual(readBoardArchiveConfig({ board: { archiveDays: 14 } }), { on: true, state: 'on', days: 14, problems: [] });
  assert.equal(readBoardArchiveConfig({ board: { archiveDays: ARCHIVE_DAYS_MAX } }).on, true);
  for (const bad of [0, -3, 1.5, '14', true, ARCHIVE_DAYS_MAX + 1]) {
    const read = readBoardArchiveConfig({ board: { archiveDays: bad } });
    assert.equal(read.on, false, JSON.stringify(bad));
    assert.match(read.problems[0], /board\.archiveDays must be a whole number of days from 1 to 365/);
  }
  assert.match(readBoardArchiveConfig({ board: 14 }).problems[0], /board is not an object/);
  const extra = readBoardArchiveConfig({ board: { archiveDays: 7, keepDays: 3 } });
  assert.equal(extra.on, true);
  assert.match(extra.problems[0], /board\.keepDays is not a setting/);
});

test('the sweeper runs after its first wait and then hourly, logs only a move, and a failure once per spell', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
  const outcomes = [{ moved: 0 }, { moved: 3, before: 600 * 1024, after: 400 * 1024, archived: 3, first: true }, 'fail', 'fail', { moved: 0, held: 'busy' }];
  const store = {
    async archiveDone({ days }) {
      assert.equal(days, 14);
      const next = outcomes.shift();
      if (next === 'fail') throw new Error('disk full at /some/path');
      return next;
    }
  };
  const lines = [];
  const sweeper = createArchiveSweeper({ store, days: 14, log: l => lines.push(l), now: () => 1000, setTimer, clearTimer: () => {}, firstMs: 5, everyMs: 50 });
  sweeper.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5);
  for (let i = 0; i < 5; i++) await timers[i].fn();
  assert.deepEqual(timers.map(t => t.ms), [5, 50, 50, 50, 50, 50]);
  assert.deepEqual(lines, [
    'board: archived 3 done items finished 14 or more days ago (board file 600 KB -> 400 KB; the archive holds 3); the board before this first move is kept in todos-history/ as todos-pre-archive-*.json',
    'board: the archive move failed, nothing was moved (disk full at /some/path)',
    'board: the archive move works again'
  ]);
  assert.deepEqual(sweeper.status(), { on: true, days: 14, last: { at: 1000, moved: 0, held: 'busy' } });
  sweeper.stop();
});

test('the sweeper\'s status never carries an error\'s words (the dashboard payload reaches every device)', async () => {
  const store = { async archiveDone() { throw new Error('EACCES: /Users/someone/secret/path'); } };
  const sweeper = createArchiveSweeper({ store, days: 7, log: () => {}, now: () => 5 });
  await sweeper.run();
  assert.deepEqual(sweeper.status(), { on: true, days: 7, last: { at: 5, moved: 0, failed: true } });
});

test('archiveLogLine counts and sizes only', () => {
  assert.equal(archiveLogLine({ moved: 1, before: 2048, after: 1024, archived: 9, first: false }, 7),
    'board: archived 1 done item finished 7 or more days ago (board file 2 KB -> 1 KB; the archive holds 9)');
});

// ---- the preview ----

test('the preview counts what a move would take and the save body before and after, without writing', () => {
  const now = Date.parse('2026-11-25T12:00:00.000Z');
  const list = board(now);
  const p = preview(list, { days: 14, now });
  assert.equal(p.items, 5);
  assert.equal(p.done, 3);
  assert.equal(p.moving, 2);
  assert.equal(p.undated, 1);
  assert.equal(p.before, Buffer.byteLength(JSON.stringify(list)));
  assert.equal(p.after, Buffer.byteLength(JSON.stringify(list.filter(t => t.id !== 'old' && t.id !== 'undated'))));
  assert.equal(p.cap, 1024 * 1024);
  const lines = previewLines(p, 14);
  assert.match(lines[0], /^2 of 3 done items are 14 or more days old \(1 of them finished before doneAt existed\)$/);
  assert.match(lines[1], /^save body \d+ KB \(0% of the limit\) -> \d+ KB \(0%\); 3 items stay on the board$/);
});
