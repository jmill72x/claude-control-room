// Ultron's conditions on the done-lane archive (board 17924110, his 2026-11-25 vet):
// the way back that loses nothing (M1), one lock for every process that writes the
// board (L1), strict board reads for a bring-back (L2), no instants far ahead of the
// clock (L3), no bring-back past the save limit (L4), the archive's size kept in memory
// and read a page at a time (L5), fixed words for an unreadable file (L6), and 0600
// files in 0700 folders (L8). Every test runs against throwaway files in a temp
// directory and its own server on a random port, never the live board on :8322. All
// items are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTodoStore, ArchiveError, InvalidBoardError, DAY_MS, ARCHIVE_QUIET_MS, RESTORE_HEADROOM, FUTURE_SLACK_MS,
  ARCHIVE_WARN_BYTES, LOCK_STALE_MS, LOCK_PARTIAL_GRACE_MS, acquireBoardLock, releaseBoardLock
} from '../todos.mjs';
import { createHandler } from '../routes.mjs';
import { createArchiveSweeper } from '../lib/board-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-archive-safe-')), 'todos.json');
const archiveOf = path => join(dirname(path), 'data', 'todos-archive.json');
const lockOf = path => `${path}.lock`;
const onDisk = path => JSON.parse(readFileSync(path, 'utf8'));
const ids = list => list.map(t => t.id);
const iso = ms => new Date(ms).toISOString();
const LATER = () => Date.now() + ARCHIVE_QUIET_MS + 60_000;
const MADE = '2026-11-01T12:00:00.000Z';
const mode = p => statSync(p).mode & 0o777;
const board = now => [
  { id: 'idea', text: 'an open idea', lane: 'idea', tag: 'Ops', createdAt: MADE },
  { id: 'old', text: 'finished 20 days ago', lane: 'done', tag: 'Ops', doneAt: iso(now - 20 * DAY_MS), createdAt: MADE },
  { id: 'old2', text: 'finished 30 days ago', lane: 'done', tag: 'Ops', doneAt: iso(now - 30 * DAY_MS), createdAt: MADE },
  { id: 'recent', text: 'finished 3 days ago', lane: 'done', tag: 'Ops', doneAt: iso(now - 3 * DAY_MS), createdAt: MADE }
];
const seed = (path, list) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2));
};
const quiet = (path, now) => utimesSync(path, new Date(now - ARCHIVE_QUIET_MS - 1000), new Date(now - ARCHIVE_QUIET_MS - 1000));
// A child node run outside the test runner: NODE_TEST_CONTEXT, which node --test sets,
// would make it a test child that reports to the runner instead of writing stdout.
const childEnv = () => {
  const { NODE_TEST_CONTEXT: _t, ...env } = process.env;
  return env;
};
// A pid that is certainly not running: a child that has already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

// ---- M1: the way back that keeps every change ----

test('unarchiveAll merges every archived item into the board as it is now: nothing made since is lost', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  // Work after the move: an edit and a new item.
  await store.write([...onDisk(path).map(t => (t.id === 'idea' ? { ...t, text: 'edited since' } : t)), { id: 'since', text: 'added since', lane: 'idea' }]);
  const t0 = Date.now();
  const result = await store.unarchiveAll();
  assert.deepEqual(result.returned.sort(), ['old', 'old2']);
  assert.equal(result.alreadyOnBoard, 0);
  const after = onDisk(path);
  assert.deepEqual(ids(after), ['idea', 'recent', 'since', 'old', 'old2']);
  assert.equal(after.find(t => t.id === 'idea').text, 'edited since');
  for (const id of ['old', 'old2']) {
    const t = after.find(x => x.id === id);
    assert.ok(Date.parse(t.restoredAt) >= t0);
    assert.equal('archivedAt' in t, false);
    assert.equal(t.createdAt, MADE);
  }
  assert.deepEqual(onDisk(archiveOf(path)), []);
  assert.equal(result.revision !== null, true);
});

test('unarchiveAll: an empty archive writes nothing; a crash leftover keeps the board\'s copy and leaves the archive', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  const before = readFileSync(path, 'utf8');
  assert.deepEqual((await store.unarchiveAll()).returned, []);
  assert.equal(readFileSync(path, 'utf8'), before);
  mkdirSync(dirname(archiveOf(path)), { recursive: true });
  writeFileSync(archiveOf(path), JSON.stringify([{ ...board(now)[1], text: 'stale copy', archivedAt: iso(now) }]));
  const result = await store.unarchiveAll();
  assert.deepEqual(result.returned, []);
  assert.equal(result.alreadyOnBoard, 1);
  assert.equal(onDisk(path).find(t => t.id === 'old').text, 'finished 20 days ago');
  assert.deepEqual(onDisk(archiveOf(path)), []);
});

test('restoring the pre-archive copy needs force, and says how many current items it lacks', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  await store.write([...onDisk(path), { id: 'since1', text: 'new', lane: 'idea' }, { id: 'since2', text: 'new', lane: 'idea' }]);
  const pinned = (await store.copies()).find(c => c.pinned).file;
  const before = readFileSync(path, 'utf8');
  await assert.rejects(() => store.restore(pinned), err => err.code === 'NEEDS_FORCE' && /has 2 items it lacks/.test(err.message) && /--unarchive-all/.test(err.message));
  assert.equal(readFileSync(path, 'utf8'), before, 'nothing written');
  const done = await store.restore(pinned, { force: true });
  assert.equal(done.lacking, 2);
  assert.equal(done.unarchived, 2);
  assert.deepEqual(ids(onDisk(path)), ids(board(now)));
});

test('an ordinary history copy needs no force', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'a', lane: 'idea' }]);
  await store.write([{ id: 2, text: 'b', lane: 'idea' }]);
  const [copy] = await store.copies();
  const done = await store.restore(copy.file);
  assert.equal('lacking' in done, false);
});

// ---- L1: one lock for every process ----

test('a write waits for a lock another live process holds, then gives up naming it, writing nothing', async () => {
  const path = tmp();
  const store = createTodoStore(path, { lockWaitMs: 150 });
  await store.write([{ id: 1, text: 'a', lane: 'idea' }]);
  const before = readFileSync(path, 'utf8');
  // This process's own pid is running, and the lock is fresh: held, not stale.
  writeFileSync(lockOf(path), `${process.pid} ${Date.now()} someoneelse\n`);
  await assert.rejects(() => store.write([{ id: 2, text: 'b', lane: 'idea' }]), err => err.code === 'BOARD_LOCKED' && new RegExp(`pid ${process.pid}`).test(err.message));
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(existsSync(lockOf(path)), 'another holder\'s lock is never removed');
});

test('a lock left by a process that is gone, or held past the stale age, is broken and the write lands', async () => {
  const path = tmp();
  const store = createTodoStore(path, { lockWaitMs: 150 });
  writeFileSync(lockOf(path), `${deadPid()} ${Date.now()} crashed\n`);
  await store.write([{ id: 1, text: 'a', lane: 'idea' }]);
  assert.equal(existsSync(lockOf(path)), false, 'released after the write');
  writeFileSync(lockOf(path), `${process.pid} ${Date.now() - LOCK_STALE_MS - 1000} reused\n`);
  await store.write([{ id: 2, text: 'b', lane: 'idea' }]);
  assert.deepEqual(ids(onDisk(path)), [2]);
  writeFileSync(lockOf(path), 'garbage');
  const longAgo = (Date.now() - 60 * 1000) / 1000;
  utimesSync(lockOf(path), longAgo, longAgo);
  await store.write([{ id: 3, text: 'c', lane: 'idea' }]);
  assert.deepEqual(ids(onDisk(path)), [3]);
  assert.deepEqual(readdirSync(dirname(path)).filter(f => f.includes('.lock')), [], 'no lock or stale file left behind');
});

test('a lock is never seen empty or half written: a reader polling it during many contended writes sees whole locks only', async () => {
  const path = tmp();
  const logs = [];
  const a = createTodoStore(path, { log: l => logs.push(l) });
  const b = createTodoStore(path, { log: l => logs.push(l) });
  await a.write([{ id: 0, text: 'start', lane: 'idea' }]);
  let polling = true;
  const seen = new Set();
  const poll = (async () => {
    while (polling) {
      try { seen.add(/^\d+ \d+ [0-9a-f]{16}\n$/.test(readFileSync(lockOf(path), 'utf8')) ? 'whole' : 'partial'); } catch { /* not held */ }
      await new Promise(r => setImmediate(r));
    }
  })();
  await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).write([{ id: i, text: `w${i}`, lane: 'idea' }])));
  polling = false;
  await poll;
  assert.equal(seen.has('partial'), false, 'never empty or partial');
  assert.ok(seen.has('whole'), 'the poller did see the lock held');
  assert.deepEqual(logs, [], 'no lock was ever judged stale');
  assert.deepEqual(readdirSync(dirname(path)).filter(f => f.includes('.lock')), [], 'no lock or temp file left');
});

test('an empty or partial lock is waited for while it is fresh, and broken once it is 5 s old', async () => {
  const path = tmp();
  const logs = [];
  const store = createTodoStore(path, { lockWaitMs: 150, log: l => logs.push(l) });
  for (const partial of ['', `${process.pid}`, `${process.pid} ${Date.now()}`]) {
    writeFileSync(lockOf(path), partial);
    await assert.rejects(() => store.write([{ id: 1, text: 'a', lane: 'idea' }]), err => err.code === 'BOARD_LOCKED', JSON.stringify(partial));
  }
  assert.deepEqual(logs, []);
  const old = (Date.now() - LOCK_PARTIAL_GRACE_MS - 1000) / 1000;
  utimesSync(lockOf(path), old, old);
  await store.write([{ id: 1, text: 'a', lane: 'idea' }]);
  assert.match(logs[0], /^board: broke a stale lock todos\.json\.lock \(not a whole lock, unchanged for over 5 s\)$/);
});

test('a lock past 60 s is broken even under a live pid, and the break is logged; a younger one is waited for', async () => {
  const path = tmp();
  const logs = [];
  const store = createTodoStore(path, { lockWaitMs: 150, log: l => logs.push(l) });
  assert.equal(LOCK_STALE_MS, 60 * 1000);
  writeFileSync(lockOf(path), `${process.pid} ${Date.now() - 30 * 1000} younger\n`);
  await assert.rejects(() => store.write([{ id: 1, text: 'a', lane: 'idea' }]), err => err.code === 'BOARD_LOCKED');
  assert.deepEqual(logs, []);
  writeFileSync(lockOf(path), `${process.pid} ${Date.now() - 61 * 1000} older\n`);
  await store.write([{ id: 1, text: 'a', lane: 'idea' }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^board: broke a stale lock todos\\.json\\.lock \\(pid ${process.pid}, taken \\S+; held over 60 s\\)$`));
  const dead = deadPid();
  writeFileSync(lockOf(path), `${dead} ${Date.now()} crashed\n`);
  await store.write([{ id: 2, text: 'b', lane: 'idea' }]);
  assert.match(logs[1], new RegExp(`^board: broke a stale lock todos\\.json\\.lock \\(pid ${dead}, .*that process is gone\\)$`));
});

test('the lock is released after a refused write too', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await assert.rejects(() => store.write([{ id: 1, text: 'a', lane: 'nowhere' }]));
  assert.equal(existsSync(lockOf(path)), false);
});

test('release removes only its own lock', async () => {
  const path = tmp();
  const token = await acquireBoardLock(lockOf(path));
  await releaseBoardLock(lockOf(path), 'not-mine');
  assert.ok(existsSync(lockOf(path)));
  await releaseBoardLock(lockOf(path), token);
  assert.equal(existsSync(lockOf(path)), false);
});

test('two stores on one board (the server and restore-todos) never interleave: each item ends in exactly one file', async () => {
  for (let round = 0; round < 5; round++) {
    const path = tmp();
    const now = LATER();
    seed(path, board(now));
    const server = createTodoStore(path);
    const script = createTodoStore(path);
    await server.archiveDone({ days: 14, now });
    seed(path, [...onDisk(path), { id: `x${round}`, text: 'old too', lane: 'done', doneAt: iso(now - 40 * DAY_MS), createdAt: MADE }]);
    quiet(path, now);
    // The third is a save as the page, the mod and board-write make one: with the
    // revision it read, so it lands only if nothing else wrote first (a plain write of a
    // stale copy would drop items by design, which is not what this checks).
    const { todos: read, revision } = await server.readState();
    await Promise.all([server.archiveDone({ days: 14, now }), script.unarchiveAll(), server.save(read, { ifMatch: revision })].map(p => p.catch(e => e)));
    const live = ids(onDisk(path));
    const archived = ids(onDisk(archiveOf(path)));
    const all = [...live, ...archived].sort();
    assert.deepEqual(all, [...new Set(all)], `no item in both files (round ${round}): ${JSON.stringify({ live, archived })}`);
    for (const id of ['idea', 'old', 'old2', 'recent']) assert.ok(all.includes(id), `${id} is somewhere (round ${round})`);
  }
});

test('a lock held by another real process makes this one wait until it is let go', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'a', lane: 'idea' }]);
  const todosUrl = new URL('../todos.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquireBoardLock, releaseBoardLock } = await import(${JSON.stringify(todosUrl)});
    const t = await acquireBoardLock(${JSON.stringify(lockOf(path))});
    process.stdout.write('held\\n');
    setTimeout(async () => { await releaseBoardLock(${JSON.stringify(lockOf(path))}, t); process.exit(0); }, 400);
  `], { stdio: ['ignore', 'pipe', 'inherit'], env: childEnv() });
  const exited = new Promise(r => child.once('exit', r));
  await new Promise(r => child.stdout.once('data', r));
  const t0 = Date.now();
  await store.write([{ id: 2, text: 'b', lane: 'idea' }]);
  assert.ok(Date.now() - t0 >= 250, `the write waited for the other process (${Date.now() - t0} ms)`);
  assert.deepEqual(ids(onDisk(path)), [2]);
  await exited;
});

// ---- L2: a bring-back reads the board strictly ----

test('unarchive and unarchiveAll refuse a board that cannot be parsed, and write neither file', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  writeFileSync(path, '[{"id": "idea", "te');
  const archiveBefore = readFileSync(archiveOf(path), 'utf8');
  for (const run of [() => store.unarchive(['old']), () => store.unarchiveAll()]) {
    await assert.rejects(run, err => err instanceof ArchiveError && err.code === 'BOARD_UNREADABLE');
    assert.equal(readFileSync(path, 'utf8'), '[{"id": "idea", "te');
    assert.equal(readFileSync(archiveOf(path), 'utf8'), archiveBefore);
  }
});

// ---- L3: nothing far ahead of the clock ----

test('a createdAt, restoredAt or doneAt more than 5 minutes ahead is refused; one already on the board passes', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  const ahead = iso(Date.now() + FUTURE_SLACK_MS + 60_000);
  const near = iso(Date.now() + FUTURE_SLACK_MS - 60_000);
  for (const field of ['createdAt', 'restoredAt', 'doneAt']) {
    await assert.rejects(
      () => store.write([{ id: field, text: 'x', lane: 'done', [field]: ahead }]),
      err => err instanceof InvalidBoardError && new RegExp(`item "${field}": ${field} is more than 5 minutes ahead`).test(err.message),
      field
    );
  }
  await store.write([{ id: 'n', text: 'n', lane: 'done', doneAt: near, createdAt: near }]);
  // A board saved before the check, holding a future doneAt, still saves.
  seed(path, [{ id: 'f', text: 'f', lane: 'done', doneAt: ahead, createdAt: MADE }]);
  await store.write([{ id: 'f', text: 'edited', lane: 'done', doneAt: ahead, createdAt: MADE }]);
  assert.equal(onDisk(path)[0].text, 'edited');
});

// ---- L4: no bring-back past the save limit ----

test('a bring-back that would leave the board within the headroom of the limit is refused, writing nothing', async () => {
  const path = tmp();
  const now = LATER();
  const big = 'x'.repeat(4000);
  seed(path, [...board(now), ...Array.from({ length: 30 }, (_, i) => ({ id: `big${i}`, text: big, lane: 'done', doneAt: iso(now - 40 * DAY_MS), createdAt: MADE }))]);
  // A limit just over what the board holds after the move, so bringing all back can't fit.
  const store = createTodoStore(path, { maxBytes: RESTORE_HEADROOM + 20 * 1024 });
  await store.archiveDone({ days: 14, now });
  const boardBefore = readFileSync(path, 'utf8');
  const archiveBefore = readFileSync(archiveOf(path), 'utf8');
  await assert.rejects(() => store.unarchiveAll(), err => err.code === 'TOO_BIG' && /save limit/.test(err.message));
  await assert.rejects(() => store.unarchive(Array.from({ length: 10 }, (_, i) => `big${i}`)), err => err.code === 'TOO_BIG');
  assert.equal(readFileSync(path, 'utf8'), boardBefore);
  assert.equal(readFileSync(archiveOf(path), 'utf8'), archiveBefore);
  await store.unarchive(['old']); // a small one still fits
  assert.ok(onDisk(path).some(t => t.id === 'old'));
});

// ---- L5: in memory, a page at a time ----

test('the archive\'s count and size come from memory until the file changes', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const store = createTodoStore(path);
  await store.archiveDone({ days: 14, now });
  const first = await store.archiveSize();
  assert.equal(first.items, 2);
  assert.equal(first.bytes, statSync(archiveOf(path)).size);
  // Same length and time, unparseable: still answered from memory, so not re-read.
  const info = statSync(archiveOf(path));
  writeFileSync(archiveOf(path), 'x'.repeat(info.size));
  // Seconds as numbers: a Date rounds the file's sub-millisecond part to the nearest ms.
  utimesSync(archiveOf(path), info.atimeMs / 1000, info.mtimeMs / 1000);
  assert.deepEqual(await store.archiveSize(), first);
  utimesSync(archiveOf(path), info.atimeMs / 1000, (info.mtimeMs + 5000) / 1000);
  await assert.rejects(() => store.archiveSize(), err => err.code === 'UNREADABLE');
});

test('the sweeper says when the archive file is past 10 MB', async () => {
  const lines = [];
  const store = { async archiveDone() { return { moved: 1, before: 2048, after: 1024, archived: 5, archiveBytes: ARCHIVE_WARN_BYTES + 1024 * 1024 }; } };
  await createArchiveSweeper({ store, days: 14, log: l => lines.push(l), now: () => 1 }).run();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^board: the archive file is 11 MB, over 10 MB; it is read whole on every move and bring-back$/);
  const quietLines = [];
  const small = { async archiveDone() { return { moved: 1, before: 2048, after: 1024, archived: 5, archiveBytes: 1024 }; } };
  await createArchiveSweeper({ store: small, days: 14, log: l => quietLines.push(l), now: () => 1 }).run();
  assert.equal(quietLines.length, 1);
});

const serve = async (path, opts = {}) => {
  const lines = [];
  const store = createTodoStore(path, opts);
  const server = createServer(createHandler({ cache: null, todos: store, config: {}, archiveDays: 14, log: l => lines.push(l) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/todos`;
  const restore = body => fetch(`${base}/archive/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { store, base, restore, lines, close: () => new Promise(r => server.close(r)) };
};

test('over HTTP: the archive is read a page at a time, newest finished first, with its total', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const s = await serve(path);
  try {
    await s.store.archiveDone({ days: 14, now });
    const page = await (await fetch(`${s.base}/archive?offset=0&limit=1`)).json();
    assert.deepEqual({ total: page.total, offset: page.offset, ids: ids(page.items) }, { total: 2, offset: 0, ids: ['old'] });
    const next = await (await fetch(`${s.base}/archive?offset=1&limit=1`)).json();
    assert.deepEqual(ids(next.items), ['old2']);
    for (const q of ['offset=-1', 'offset=1.5', 'limit=0', 'limit=201', 'limit=x']) {
      assert.equal((await fetch(`${s.base}/archive?${q}`)).status, 400, q);
    }
  } finally { await s.close(); }
});

// ---- L6: fixed words for a file that can't be read ----

test('over HTTP: an unreadable archive or board is answered in fixed words, the detail only in the log', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, board(now));
  const s = await serve(path);
  try {
    await s.store.archiveDone({ days: 14, now });
    writeFileSync(archiveOf(path), '[{"id": "old", "te');
    const res = await fetch(`${s.base}/archive`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "the board's archive could not be read; the server log says why" });
    const back = await s.restore({ ids: ['old'] });
    assert.equal(back.status, 500);
    assert.equal((await back.json()).error, "the board's archive could not be read; the server log says why");
    assert.equal(s.lines.length, 2);
    assert.match(s.lines[0], /^board: the board's archive could not be parsed/);
    writeFileSync(archiveOf(path), '[]');
    writeFileSync(path, 'not a board');
    writeFileSync(archiveOf(path), JSON.stringify([{ ...board(now)[1], archivedAt: iso(now) }]));
    const board500 = await s.restore({ ids: ['old'] });
    assert.equal(board500.status, 500);
    assert.equal((await board500.json()).error, 'the board could not be read, so nothing was brought back; the server log says why');
  } finally { await s.close(); }
});

test('over HTTP: a bring-back past the limit is a 409 that says so; a held lock is a 503', async () => {
  const path = tmp();
  const now = LATER();
  seed(path, [...board(now), ...Array.from({ length: 30 }, (_, i) => ({ id: `big${i}`, text: 'x'.repeat(4000), lane: 'done', doneAt: iso(now - 40 * DAY_MS), createdAt: MADE }))]);
  const s = await serve(path, { maxBytes: RESTORE_HEADROOM + 20 * 1024, lockWaitMs: 100 });
  try {
    await s.store.archiveDone({ days: 14, now });
    const res = await s.restore({ ids: Array.from({ length: 10 }, (_, i) => `big${i}`) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /save limit/);
    writeFileSync(lockOf(path), `${process.pid} ${Date.now()} other\n`);
    const locked = await fetch(s.base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(onDisk(path)) });
    assert.equal(locked.status, 503);
    assert.match((await locked.json()).error, /being written by another process/);
  } finally { await s.close(); }
});

// ---- L8: 0600 files in 0700 folders ----

test('the board, its history copies, the pinned copy and a corrupt aside are written 0600, new folders 0700', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ccr-archive-modes-')), 'fresh', 'todos.json');
  const now = LATER();
  const store = createTodoStore(path);
  await store.write(board(now));
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dirname(path)), 0o700);
  quiet(path, now);
  seed(path, board(now));
  quiet(path, now);
  await store.archiveDone({ days: 14, now });
  const history = join(dirname(path), 'todos-history');
  assert.equal(mode(history), 0o700);
  const names = readdirSync(history);
  assert.ok(names.some(f => f.startsWith('todos-pre-archive-')));
  for (const f of names) assert.equal(mode(join(history, f)), 0o600, f);
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dirname(archiveOf(path))), 0o700);
  writeFileSync(path, 'not json');
  await assert.rejects(() => createTodoStore(path).read());
  const aside = readdirSync(dirname(path)).find(f => f.includes('.corrupt-'));
  assert.equal(mode(join(dirname(path), aside)), 0o600);
});

test('a board file made before keeps working and becomes 0600 at its next write', async () => {
  const path = tmp();
  // A mode on writeFileSync is cut by the umask (0600 under 077), so chmod it.
  writeFileSync(path, JSON.stringify([{ id: 1, text: 'a', lane: 'idea' }]));
  chmodSync(path, 0o644);
  assert.equal(mode(path), 0o644);
  await createTodoStore(path).write([{ id: 1, text: 'b', lane: 'idea' }]);
  assert.equal(mode(path), 0o600);
});

// The test file itself sits where the suite expects.
test('this suite is in server/test', () => assert.ok(HERE.endsWith(join('server', 'test'))));
