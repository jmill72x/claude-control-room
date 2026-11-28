// A page card waiting across a restart of this server (board ee0bd552). The channel holds a
// relayed request and takes a verdict for it as long as its process lives, but the store
// kept its cards in memory only, so a restart lost them while the reminder still said
// "Answer it in Jarvis OS chat". The store now writes the open requests with the channel
// process that relayed them (lib/chat-store.mjs, permissions.json), puts them back only
// when that same process says hello to the new server (channelHello), holds them unseen
// until a sessions pass judges them by the lead's transcripts (lib/answered-elsewhere.mjs),
// and the reminder names the chat only while a card there is open (lib/approval-wait.mjs).
// Every id, pid, session and time here is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChatStore, PERMISSIONS_FILE, PERMISSIONS_FILE_VERSION, PERMISSIONS_FILE_MAX_BYTES, SECRET_STAND_IN, RESTORE_JUDGE_MS, PERMISSION_TTL_MS, CHANNEL_GONE_MS, OPEN_PERMISSIONS_MAX
} from '../lib/chat-store.mjs';
import { createSocketRouter, SESSION_HEADER } from '../lib/chat-socket.mjs';
import { isWhyLine, whyLine } from '../lib/approvals.mjs';
import { createAnsweredElsewhere } from '../lib/answered-elsewhere.mjs';
import { agentKey } from '../lib/needs-you.mjs';
import { reminderBody, isReminderPush, REMINDER_TAIL, REMINDER_TAIL_NO_CARD, createApprovalReminders } from '../lib/approval-wait.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const T0 = 1794380000000;
const HOLD = 12 * HOUR + 3 * MIN;        // channel 0.4.11's hold
const WINDOW = 12 * HOUR;                 // the page's window for it: the hold less a minute, at most 12 hours
const A = { pid: 4101, startedAt: T0 - HOUR };      // the channel process
const B = { pid: 4102, startedAt: T0 + 5 * MIN };   // a later one
const LEAD = 'a1b2c3d4-0000-4000-8000-00000000000a';
const AGENT = 'a0000000000000001';
const KEY = agentKey(AGENT);
const PREVIEW = '{"command":"ls -la /home/owner/Projects/app"}';

// A store on `dir` with its own clock; `start(id)` is the channel's first hello to it.
async function storeAt(dir, clock) {
  const logs = [];
  const store = createChatStore({ dir, now: () => clock.t, log: l => logs.push(l) });
  const loaded = await store.load();
  const events = [];
  store.subscribe(e => { if (e.type === 'permission' || e.type === 'permission-closed') events.push([e.type, e.request.requestId, e.request.state]); });
  const start = (id = A, holdMs = HOLD) => { const r = store.channelHello(id); store.setPermissionHold(holdMs); store.noteChannelAlive(clock.t); return r; };
  const open = (requestId, { tool = 'Bash', description = 'list the files', inputPreview = PREVIEW, relayedAt = clock.t } = {}) => store.openPermission({ requestId, tool, description, inputPreview, relayedAt }, { assess: () => ({ denyOnly: [], why: null, exact: 'ls -la /home/owner/Projects/app' }) });
  return { store, loaded, logs, events, start, open };
}
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'card-restart-'));
  const clock = { t: T0 };
  // Servers a test opens are closed here too, so a failed assertion never leaves one open.
  const servers = new Set();
  const clean = async () => {
    for (const srv of servers) { srv.closeAllConnections?.(); await new Promise(r => srv.close(r)); }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { dir, clock, servers, file: join(dir, PERMISSIONS_FILE), clean };
}
const readSnap = async path => JSON.parse(await readFile(path, 'utf8'));
// A first server with one open card from process A, written to disk; answers the world and
// that store.
async function withOneCard(w, id = 'abcde') {
  const s = await storeAt(w.dir, w.clock);
  s.start(A);
  await s.open(id);
  await s.store.flushPermissions();
  return s;
}

test('the file: the channel process, its session, the ids and each open card as relayed; 0600; never the exact command', async () => {
  const w = await world();
  try {
    const s = await withOneCard(w);
    const snap = await readSnap(w.file);
    assert.equal(snap.version, PERMISSIONS_FILE_VERSION);
    assert.deepEqual(snap.channel, { pid: A.pid, startedAt: A.startedAt, sessionAt: T0 });
    assert.deepEqual(snap.seen, ['abcde']);
    assert.deepEqual(snap.cards, [{ requestId: 'abcde', tool: 'Bash', description: 'list the files', inputPreview: PREVIEW, cut: false, relayedAt: T0, openedAt: T0, windowMs: WINDOW, messageId: s.store.permission('abcde').messageId, why: null }]);
    assert.equal(s.store.permission('abcde').exact, 'ls -la /home/owner/Projects/app', 'the card has its exact command in memory');
    assert.ok(!JSON.stringify(snap).includes('"exact"'), 'and the file never has it');
    assert.equal((await stat(w.file)).mode & 0o777, 0o600);
    // A card that closes leaves the file; the seen id stays.
    w.clock.t += MIN;
    await s.store.answerPermission('abcde', 'deny', 'phone');
    await s.store.flushPermissions();
    assert.deepEqual((await readSnap(w.file)).cards, []);
    assert.deepEqual((await readSnap(w.file)).seen, ['abcde']);
  } finally { await w.clean(); }
});

test('a card whose words look like they hold a secret is never written', async () => {
  const w = await world();
  try {
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    await s.open('abcde', { inputPreview: JSON.stringify({ command: 'echo ' + 'ghp_' + 'x'.repeat(36) }) });
    await s.open('fghij', { description: 'use ' + 'ghp_' + 'y'.repeat(36) });
    await s.open('klmno');
    await s.store.flushPermissions();
    const text = await readFile(w.file, 'utf8');
    assert.deepEqual(JSON.parse(text).cards.map(c => c.requestId), ['klmno']);
    assert.ok(!text.includes('ghp_'));
  } finally { await w.clean(); }
});

test('the same channel process after a restart: the card is held, unseen and unanswerable, with its session\'s start and ids', async () => {
  const w = await world();
  try {
    const first = await withOneCard(w);
    const messageId = first.store.permission('abcde').messageId;
    w.clock.t += 2 * MIN;
    const s = await storeAt(w.dir, w.clock);
    assert.equal(s.loaded.permissionsOnFile, 1);
    const before = await readFile(w.file, 'utf8');
    // Nothing is written before the first hello: a start that never gets one keeps the file.
    s.store.setPermissionHold(HOLD);
    s.store.closePermissionsElsewhere({ upTo: w.clock.t, event: 'Stop', ids: new Set(['abcde']) });
    s.store.restoringPermissions();
    await s.store.flushPermissions();
    assert.equal(await readFile(w.file, 'utf8'), before, 'a hook\'s close before the hello writes nothing either');
    assert.deepEqual(s.start(A), { session: 1, restored: 1, dropped: 0, why: null });
    assert.equal(s.store.permissionSessionAt, T0, 'the session goes on from its first hello');
    assert.equal(s.store.permission('abcde'), null, 'held back: no card');
    assert.deepEqual(s.store.openPermissions(), []);
    assert.deepEqual(s.store.cardPermissions(), []);
    assert.deepEqual(s.store.closablePermissions(), []);
    assert.equal((await s.store.answerPermission('abcde', 'allow', 'phone')).status, 404);
    assert.deepEqual(s.events, [], 'no page hears of it yet');
    assert.deepEqual(s.store.restoringPermissions(), [{ requestId: 'abcde', tool: 'Bash', relayedAt: T0, restoredAt: T0 + 2 * MIN }]);
    // A held card stays in the file, so a second restart before the pass keeps it too.
    await s.store.flushPermissions();
    assert.deepEqual((await readSnap(w.file)).cards.map(c => c.requestId), ['abcde']);
    // The pass's word: shown again, as it was, under the new session.
    const assessed = [];
    const out = s.store.settleRestored(new Map([['abcde', true]]), { assess: p => { assessed.push(p.requestId); return { denyOnly: ['a reason'], why: null }; } });
    assert.deepEqual(out, { opened: ['abcde'], dropped: [] });
    assert.deepEqual(assessed, ['abcde'], 'the gate\'s reasons are worked out again');
    const p = s.store.permission('abcde');
    assert.equal(p.state, 'open');
    assert.equal(p.messageId, messageId, 'its own message');
    assert.equal(p.exact, null, 'the exact command went with the old process');
    assert.deepEqual(p.denyOnly, ['a reason']);
    const pub = s.store.publicPermission(p);
    assert.equal(pub.relayedAt, T0);
    assert.equal(pub.expiresAt, T0 + WINDOW, 'its window, from when the channel relayed it');
    assert.deepEqual(s.events, [['permission', 'abcde', 'open']], 'every page gets the card');
    // And it takes a verdict, which replies to its message.
    const r = await s.store.answerPermission('abcde', 'deny', 'phone');
    assert.equal(r.ok, true);
    const verdict = s.store.newest(1)[0];
    assert.equal(verdict.kind, 'verdict');
    assert.equal(verdict.replyTo, messageId);
    assert.equal(verdict.meta.requestId, 'abcde');
  } finally { await w.clean(); }
});

test('a different channel process, or a hello that does not say its pid and start: nothing comes back (L7)', async () => {
  for (const [name, id, why] of [
    ['another pid', { ...A, pid: B.pid }, 'a different channel process said hello'],
    ['another start', { ...A, startedAt: A.startedAt + 1 }, 'a different channel process said hello'],
    ['a new process', B, 'a different channel process said hello'],
    ['no start', { pid: A.pid }, 'the channel\'s hello did not say its pid and start'],
    ['no pid', { startedAt: A.startedAt }, 'the channel\'s hello did not say its pid and start'],
    ['a start that is not whole', { pid: A.pid, startedAt: A.startedAt + 0.5 }, 'the channel\'s hello did not say its pid and start']
  ]) {
    const w = await world();
    try {
      await withOneCard(w);
      w.clock.t += MIN;
      const s = await storeAt(w.dir, w.clock);
      const r = s.start(id);
      assert.deepEqual(r, { session: 1, restored: 0, dropped: 1, why }, name);
      assert.deepEqual(s.store.restoringPermissions(), [], name);
      assert.equal(s.store.permissionSessionAt, w.clock.t, `${name}: a new session from this hello`);
      await s.store.flushPermissions();
      const snap = await readSnap(w.file);
      assert.deepEqual(snap.cards, [], `${name}: the old card is gone from the file`);
      assert.deepEqual(snap.seen, [], name);
    } finally { await w.clean(); }
  }
});

test('only the first hello of a start can bring the cards back; a later one from a new process ends them', async () => {
  const w = await world();
  try {
    await withOneCard(w);
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    assert.equal(s.store.restoringPermissions().length, 1);
    assert.deepEqual(s.start(B), { session: 2, restored: 0, dropped: 0, why: null });
    assert.deepEqual(s.store.restoringPermissions(), [], 'a new process: the held card goes');
    // And process A coming back to this same server gets nothing: the file was read once.
    assert.deepEqual(s.start(A), { session: 3, restored: 0, dropped: 0, why: null });
  } finally { await w.clean(); }
});

test('answered on the page before the stop: never put back, even when the file still has it', async () => {
  const w = await world();
  try {
    const first = await withOneCard(w);
    const stale = await readFile(w.file, 'utf8');
    w.clock.t += MIN;
    await first.store.answerPermission('abcde', 'allow', 'phone');
    await first.store.flushPermissions();
    // The write after the verdict never landed (a stop in between): the old file stays.
    await writeFile(w.file, stale, { mode: 0o600 });
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    assert.equal(s.loaded.permissionsOnFile, 0, 'the verdict in the chat log answers it');
    assert.deepEqual(s.start(A), { session: 1, restored: 0, dropped: 0, why: null });
  } finally { await w.clean(); }
});

test('only a verdict to the card\'s own message answers it: one to an earlier request with the same id does not', async () => {
  const w = await world();
  try {
    const first = await withOneCard(w);
    const own = first.store.permission('abcde').messageId;
    const earlier = await first.store.append({ from: 'jarvis', kind: 'permission', text: 'an earlier one', meta: { requestId: 'abcde', tool: 'Bash' } });
    await first.store.append({ from: 'jeff', kind: 'verdict', text: 'deny', replyTo: earlier.id, meta: { requestId: 'abcde', behavior: 'deny' } });
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 1);
    await first.store.append({ from: 'jeff', kind: 'verdict', text: 'deny', replyTo: own, meta: { requestId: 'abcde', behavior: 'deny' } });
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0);
  } finally { await w.clean(); }
});

test('the window: a card whose window ended while the server was down is not put back, at the start or at the hello', async () => {
  const w = await world();
  try {
    const s0 = await storeAt(w.dir, w.clock);
    s0.start(A, null);                 // a channel that names no hold: 10 minutes
    await s0.open('abcde');
    await s0.store.flushPermissions();
    const kept = await readFile(w.file, 'utf8');
    w.clock.t += PERMISSION_TTL_MS;
    assert.equal((await storeAt(w.dir, w.clock)).loaded.permissionsOnFile, 0, 'out of its window at the start');
    await assert.rejects(stat(w.file), { code: 'ENOENT' }, 'and a file that brings back nothing is removed');
    await writeFile(w.file, kept, { mode: 0o600 });
    w.clock.t = T0 + PERMISSION_TTL_MS - 2;
    const s = await storeAt(w.dir, w.clock);
    assert.equal(s.loaded.permissionsOnFile, 1);
    w.clock.t += 2;
    assert.deepEqual(s.start(A), { session: 1, restored: 0, dropped: 1, why: 'their window had ended' });
  } finally { await w.clean(); }
});

test('shown again inside the smaller of its own window and the channel\'s current one', async () => {
  const w = await world();
  try {
    await withOneCard(w);
    w.clock.t += 2 * MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A, 11 * MIN);              // the process now says it holds one 11 minutes
    s.store.settleRestored(new Map([['abcde', true]]));
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).expiresAt, T0 + 10 * MIN);
    // And one past that smaller window is let go, not shown.
    const w2 = await world();
    try {
      await withOneCard(w2);
      w2.clock.t += 10 * MIN;
      const t = await storeAt(w2.dir, w2.clock);
      t.start(A, 11 * MIN);
      assert.deepEqual(t.store.settleRestored(new Map([['abcde', true]])), { opened: [], dropped: ['abcde'] });
    } finally { await w2.clean(); }
  } finally { await w.clean(); }
});

test('a held card goes, unseen, when nothing judges it in time, the channel goes silent, says bye, or the lead\'s session ends', async () => {
  const cases = [
    ['no pass in time', s => { s.clock.t += RESTORE_JUDGE_MS; }],
    ['a silent channel', s => { s.clock.t += CHANNEL_GONE_MS - 1; s.store.noteChannelAlive(s.clock.t - CHANNEL_GONE_MS + 1); s.clock.t += 1; }],
    ['a bye', s => { s.store.newPermissionSession(); }],
    ['the lead\'s SessionEnd', s => { s.store.closePermissionsElsewhere({ upTo: s.clock.t, event: 'SessionEnd' }); }]
  ];
  for (const [name, act] of cases) {
    const w = await world();
    try {
      await withOneCard(w);
      w.clock.t += MIN;
      const s = await storeAt(w.dir, w.clock);
      s.start(A);
      await s.store.flushPermissions();
      assert.deepEqual((await readSnap(w.file)).cards.map(c => c.requestId), ['abcde'], `${name}: on file while held`);
      w.clock.t += RESTORE_JUDGE_MS - 1;
      assert.equal(s.store.restoringPermissions().length, 1, `${name}: still held just before`);
      act({ ...s, clock: w.clock });
      assert.deepEqual(s.store.restoringPermissions(), [], name);
      await s.store.flushPermissions();
      assert.deepEqual((await readSnap(w.file)).cards, [], `${name}: and gone from the file`);
      assert.deepEqual(s.store.settleRestored(new Map([['abcde', true]])), { opened: [], dropped: [] }, `${name}: nothing left to show`);
      assert.deepEqual(s.events.filter(e => e[0] === 'permission'), [], `${name}: never shown`);
    } finally { await w.clean(); }
  }
});

test('a held card goes on a silent channel alone, and at the end of its window alone, inside the 3 minutes', async () => {
  const w = await world();
  try {
    await withOneCard(w);
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    s.store.noteChannelAlive(w.clock.t - CHANNEL_GONE_MS);
    assert.deepEqual(s.store.restoringPermissions(), [], 'silent for 10 minutes');
  } finally { await w.clean(); }
  const v = await world();
  try {
    const s0 = await storeAt(v.dir, v.clock);
    s0.start(A, null);
    await s0.open('abcde');
    await s0.store.flushPermissions();
    v.clock.t += PERMISSION_TTL_MS - MIN;
    const s = await storeAt(v.dir, v.clock);
    s.start(A, null);
    assert.equal(s.store.restoringPermissions().length, 1);
    v.clock.t += MIN;
    assert.deepEqual(s.store.restoringPermissions(), [], 'its window ended a minute after the restart');
  } finally { await v.clean(); }
});

test('a held card the lead\'s own turn passes (no ids) waits for the pass; ids name only open cards', async () => {
  const w = await world();
  try {
    await withOneCard(w);
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    s.store.closePermissionsElsewhere({ upTo: w.clock.t, event: 'Stop', ids: new Set(['abcde']) });
    assert.equal(s.store.restoringPermissions().length, 1);
  } finally { await w.clean(); }
});

test('the ids the session saw before the restart stay seen: the same id relayed again is a repeat', async () => {
  const w = await world();
  try {
    const first = await withOneCard(w);
    await first.open('fghij');
    w.clock.t += MIN;
    await first.store.answerPermission('fghij', 'deny', 'phone');
    await first.store.flushPermissions();
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    assert.equal((await s.open('fghij')).state, 'repeat');
    assert.equal((await s.open('zzzzz')).state, 'open');
    // A held card whose id came again in this session with another body stays the newer
    // one's (the same body is the channel posting the held card again: card-lows.test.mjs).
    assert.equal((await s.open('abcde', { description: 'something else' })).state, 'repeat');
    assert.deepEqual(s.store.settleRestored(new Map([['abcde', true]])), { opened: [], dropped: ['abcde'] });
    assert.equal(s.store.permission('abcde').state, 'repeat');
  } finally { await w.clean(); }
});

test('two restarts before any pass: the card is still the same process\'s and still held', async () => {
  const w = await world();
  try {
    await withOneCard(w);
    w.clock.t += MIN;
    const s1 = await storeAt(w.dir, w.clock);
    s1.start(A);
    await s1.store.flushPermissions();
    w.clock.t += MIN;
    const s2 = await storeAt(w.dir, w.clock);
    assert.deepEqual(s2.start(A), { session: 1, restored: 1, dropped: 0, why: null });
    assert.equal(s2.store.permissionSessionAt, T0);
    s2.store.settleRestored(new Map([['abcde', true]]));
    assert.equal(s2.store.permission('abcde').state, 'open');
  } finally { await w.clean(); }
});

test('a false word lets it go; at most 50 open after it is shown again', async () => {
  const w = await world();
  try {
    const first = await storeAt(w.dir, w.clock);
    first.start(A);
    await first.open('abcde');
    await first.open('fghij');
    await first.store.flushPermissions();
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    for (let i = 0; i < OPEN_PERMISSIONS_MAX; i++) await s.open(`n${String(i).padStart(4, '0')}`);
    assert.deepEqual(s.store.settleRestored(new Map([['abcde', false], ['fghij', true]])), { opened: [], dropped: ['abcde', 'fghij'] });
  } finally { await w.clean(); }
});

test('a file that is odd in any way brings nothing back', async () => {
  const w = await world();
  try {
    const first = await withOneCard(w);
    const good = await readSnap(w.file);
    const card = good.cards[0];
    const variants = [
      ['not JSON', '{'],
      ['another version', { ...good, version: 2 }],
      ['no channel', { ...good, channel: null }],
      ['a pid that is text', { ...good, channel: { ...good.channel, pid: String(A.pid) } }],
      ['no session start', { ...good, channel: { pid: A.pid, startedAt: A.startedAt } }],
      ['a bad id', { ...good, cards: [{ ...card, requestId: 'a b' }] }],
      ['no tool', { ...good, cards: [{ ...card, tool: '' }] }],
      ['a preview that is no text', { ...good, cards: [{ ...card, inputPreview: null }] }],
      ['a relay time ahead', { ...good, cards: [{ ...card, relayedAt: T0 + HOUR }] }],
      ['an opened time ahead', { ...good, cards: [{ ...card, openedAt: T0 + HOUR }] }],
      ['a window over 12 hours', { ...good, cards: [{ ...card, windowMs: 12 * HOUR + 1 }] }],
      ['no window', { ...good, cards: [{ ...card, windowMs: 0 }] }],
      ['a message that is not on file', { ...good, cards: [{ ...card, messageId: 'm_zzzzzzzzzzzz' }] }],
      ['a message of another kind', { ...good, cards: [{ ...card, messageId: first.store.newest(1)[0].id, requestId: 'zzzzz' }] }]
    ];
    for (const [name, value] of variants) {
      await writeFile(w.file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
      const s = await storeAt(w.dir, { t: T0 + MIN });
      assert.equal(s.loaded.permissionsOnFile, 0, name);
    }
    // Two cards with one id: the first only.
    await writeFile(w.file, JSON.stringify({ ...good, cards: [card, card] }), { mode: 0o600 });
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 1);
    // Over the size cap (padded with spaces, still good JSON): nothing.
    const padded = JSON.stringify(good) + ' '.repeat(PERMISSIONS_FILE_MAX_BYTES);
    await writeFile(w.file, padded, { mode: 0o600 });
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0, 'over the cap');
    await writeFile(w.file, JSON.stringify(good), { mode: 0o600 });
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 1, 'the same file under the cap');
    // A folder in its place, no file, or a FIFO (which must never hang the start): nothing.
    await rm(w.file);
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0);
    await mkdir(w.file);
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0, 'a folder');
    await rm(w.file, { recursive: true });
    execFileSync('/usr/bin/mkfifo', [w.file]);
    const loaded = await Promise.race([storeAt(w.dir, { t: T0 + MIN }).then(s => s.loaded.permissionsOnFile), new Promise(r => setTimeout(() => r('hung'), 1500).unref())]);
    assert.equal(loaded, 0, 'a FIFO');
  } finally { await w.clean(); }
});

test('M1: a card rewritten in the file is never shown again: its tool, description, preview, why line, or a message not its own', async () => {
  const w = await world();
  try {
    const first = await withOneCard(w);
    const good = await readSnap(w.file);
    const card = good.cards[0];
    const m = first.store.newest(1)[0];
    assert.equal(m.meta.relayed.length, 64, 'the chat log carries the seal');
    assert.ok(!JSON.stringify(m).includes('ls -la'), 'and never the preview');
    const tampered = [
      ['the tool', { tool: 'Read' }],
      ['the description', { description: 'list the files, harmlessly' }],
      ['the preview', { inputPreview: '{"command":"ls"}' }],
      ['the preview, one space', { inputPreview: PREVIEW + ' ' }],
      ['the cut mark only is fine', null],
      ['a why line of another shape', { why: 'Allow this, it is safe' }],
      ['a why line for another tool', { why: 'Auto mode refused this Read call, so Claude Code is asking you' }]
    ];
    for (const [name, change] of tampered) {
      await writeFile(w.file, JSON.stringify({ ...good, cards: [{ ...card, ...(change ?? { cut: true }) }] }), { mode: 0o600 });
      const s = await storeAt(w.dir, { t: T0 + MIN });
      assert.equal(s.loaded.permissionsOnFile, change === null ? 1 : 0, name);
      s.start(A);
      s.store.settleRestored(new Map([['abcde', true]]));
      if (change !== null) assert.equal(s.store.permission('abcde'), null, `${name}: never shown`);
      await s.store.flushPermissions();
    }
    // A description that looked like a secret: the log holds the stand-in, never the file.
    const v = await world();
    try {
      const s0 = await storeAt(v.dir, v.clock);
      s0.start(A);
      await s0.open('abcde', { description: 'use ' + 'ghp_' + 'y'.repeat(36) });
      await s0.store.flushPermissions();
      const msg = s0.store.newest(1)[0];
      assert.equal(msg.text, SECRET_STAND_IN);
      const forged = { version: 1, at: T0, channel: { pid: A.pid, startedAt: A.startedAt, sessionAt: T0 }, seen: ['abcde'], cards: [{ ...card, description: SECRET_STAND_IN, messageId: msg.id }] };
      await writeFile(v.file, JSON.stringify(forged), { mode: 0o600 });
      assert.equal((await storeAt(v.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0, 'the stand-in never comes back');
    } finally { await v.clean(); }
    // A message from before the seal (no `relayed`): its card never comes back.
    const u = await world();
    try {
      const s0 = await storeAt(u.dir, u.clock);
      s0.start(A);
      const old = await s0.store.append({ from: 'jarvis', kind: 'permission', text: 'list the files', meta: { requestId: 'abcde', tool: 'Bash' } });
      const forged = { version: 1, at: T0, channel: { pid: A.pid, startedAt: A.startedAt, sessionAt: T0 }, seen: ['abcde'], cards: [{ ...card, messageId: old.id }] };
      await writeFile(u.file, JSON.stringify(forged), { mode: 0o600 });
      assert.equal((await storeAt(u.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0);
      // Nor one whose permission message is the owner's, not the lead's.
      const mine = await s0.store.append({ from: 'jeff', kind: 'permission', text: 'list the files', meta: { requestId: 'abcde', tool: 'Bash', relayed: m.meta.relayed } });
      await writeFile(u.file, JSON.stringify({ ...forged, cards: [{ ...card, messageId: mine.id }] }), { mode: 0o600 });
      assert.equal((await storeAt(u.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0);
    } finally { await u.clean(); }
  } finally { await w.clean(); }
});

test('L1: the card\'s "why it is asking" line comes back as it was, never from a block this process saw', async () => {
  const w = await world();
  try {
    const s0 = await storeAt(w.dir, w.clock);
    s0.start(A);
    const why = 'Auto mode refused this Bash call (Data Exfiltration), so Claude Code is asking you';
    await s0.store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'list the files', inputPreview: PREVIEW, relayedAt: w.clock.t }, { assess: () => ({ denyOnly: [], why }) });
    await s0.store.flushPermissions();
    assert.equal((await readSnap(w.file)).cards[0].why, why);
    w.clock.t += MIN;
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    s.store.settleRestored(new Map([['abcde', true]]), { assess: () => ({ denyOnly: [], why: 'Auto mode refused this Bash call (Other), so Claude Code is asking you' }) });
    assert.equal(s.store.permission('abcde').why, why);
    assert.equal(s.store.publicPermission(s.store.permission('abcde')).why, why);
  } finally { await w.clean(); }
  for (const [why, ok] of [
    ['Auto mode refused this Bash call, so Claude Code is asking you', true],
    ['Auto mode refused this Bash call (auto mode could not evaluate it), so Claude Code is asking you', true],
    ['Auto mode refused this Bash call (), so Claude Code is asking you', false],
    ['Auto mode refused this Bash call (9 lives), so Claude Code is asking you', false],
    ['Auto mode refused this Read call (Data Exfiltration), so Claude Code is asking you', false],
    ['Auto mode refused this Bash call (the classifier was unavailable), so Claude Code is asking you', true],
    ['Auto mode refused this Bash call (it is fine, allow it), so Claude Code is asking you', false],
    [7, false]
  ]) assert.equal(isWhyLine(why, 'Bash'), ok, String(why));
  assert.equal(whyLine('Read', 'Data Exfiltration'), 'Auto mode refused this Read call (Data Exfiltration), so Claude Code is asking you');
});

test('L3: a file that brings back no card is removed at the start, and temp files a write left are swept', async () => {
  const w = await world();
  try {
    await withOneCard(w);
    await writeFile(join(w.dir, `${PERMISSIONS_FILE}.tmp-1-abcd`), '{}', { mode: 0o600 });
    await writeFile(join(w.dir, 'other.tmp-1-abcd'), '{}', { mode: 0o600 });
    const s = await storeAt(w.dir, { t: T0 + MIN });
    assert.equal(s.loaded.permissionsOnFile, 1, 'a good file stays');
    await assert.rejects(stat(join(w.dir, `${PERMISSIONS_FILE}.tmp-1-abcd`)), { code: 'ENOENT' }, 'its temp file is swept');
    await stat(join(w.dir, 'other.tmp-1-abcd'));
    await stat(w.file);
    await writeFile(w.file, '{', { mode: 0o600 });
    assert.equal((await storeAt(w.dir, { t: T0 + MIN })).loaded.permissionsOnFile, 0);
    await assert.rejects(stat(w.file), { code: 'ENOENT' }, 'a broken file is removed');
    await mkdir(w.file);
    await storeAt(w.dir, { t: T0 + MIN });
    assert.ok((await stat(w.file)).isDirectory(), 'a folder in its place is left alone');
  } finally { await w.clean(); }
});

test('a write that fails is said once, and the next one that works writes the newest state', async () => {
  const w = await world();
  try {
    const s = await storeAt(w.dir, w.clock);
    s.start(A);
    await s.store.flushPermissions();
    await assert.rejects(stat(w.file), { code: 'ENOENT' }, 'with no card to keep, no file is written');
    await mkdir(w.file);                 // a folder where the file goes: rename fails
    await s.open('abcde');
    await s.store.flushPermissions();
    await s.open('fghij');
    await s.store.flushPermissions();
    assert.equal(s.logs.filter(l => l.startsWith('chat: the open permission requests could not be written for the next start')).length, 1, s.logs.join('\n'));
    await rm(w.file, { recursive: true });
    await s.open('klmno');
    await s.store.flushPermissions();
    assert.deepEqual((await readSnap(w.file)).cards.map(c => c.requestId), ['abcde', 'fghij', 'klmno']);
  } finally { await w.clean(); }
});

// ---- the pass's word (lib/answered-elsewhere.mjs) ----

// The sessions pass's view of the lead's session: his own thread and one subagent.
const view = ({ main = T0 - 3e3, mainOpen = [], agent = T0 - 2e3, agentOpen = [] } = {}) => new Map([[LEAD, { main, agents: new Map([[KEY, agent]]), types: new Map([[KEY, 'vision']]), mainOpen, agentsOpen: new Map([[KEY, agentOpen]]) }]]);
const bash = at => [{ name: 'Bash', at }];
async function heldWorld() {
  const w = await world();
  await withOneCard(w);
  w.clock.t += 2 * MIN;
  const s = await storeAt(w.dir, w.clock);
  s.start(A);
  const logs = [];
  const assessed = [];
  const ae = createAnsweredElsewhere({ store: s.store, isLeadSession: id => id === LEAD, now: () => w.clock.t, log: l => logs.push(l), assess: p => { assessed.push(p.requestId); return { denyOnly: [], why: null }; } });
  const pass = (threads, extra = {}) => ae.pass({ threads, sessions: [LEAD], readAt: w.clock.t, written: new Map([[LEAD, w.clock.t]]), ...extra });
  return { ...w, s, ae, logs, assessed, pass };
}

test('the pass: the card\'s call still open in the lead\'s own thread: shown again, gated again, and then closed as any card when its thread moves on', async () => {
  const h = await heldWorld();
  try {
    h.clock.t += 1e3;
    h.pass(view({ mainOpen: bash(T0 - 1e3) }));
    assert.equal(h.s.store.permission('abcde').state, 'open');
    assert.deepEqual(h.assessed, ['abcde']);
    assert.ok(h.logs.includes('chat: 1 permission card from before the restart shown again (the lead\'s transcripts show the call still open): abcde'), h.logs.join('\n'));
    // His own Stop now closes it (his own thread's card), as before the restart.
    h.clock.t += MIN;
    h.ae.note({ event: 'Stop', sessionId: LEAD, at: h.clock.t });
    assert.equal(h.s.store.permission('abcde').state, 'elsewhere');
  } finally { await h.clean(); }
});

test('the pass: a subagent\'s card still open is shown again and kept through the lead\'s turn', async () => {
  const h = await heldWorld();
  try {
    h.clock.t += 1e3;
    h.pass(view({ agentOpen: bash(T0 - 1e3) }));
    assert.equal(h.s.store.permission('abcde').state, 'open');
    h.ae.note({ event: 'UserPromptSubmit', sessionId: LEAD, at: h.clock.t });
    assert.equal(h.s.store.permission('abcde').state, 'open', 'a subagent\'s card stays at the lead\'s turn');
    h.clock.t += MIN;
    h.pass(view({ agent: T0 + MIN, agentOpen: [] }));
    assert.equal(h.s.store.permission('abcde').state, 'elsewhere', 'and closes once its own thread moved past it');
  } finally { await h.clean(); }
});

test('the pass: answered at the terminal while the server was down (no call open), or the thread moved past it: never shown', async () => {
  for (const [name, threads, words] of [
    ['no call open', view({ mainOpen: [] }), 'no thread of the lead\'s has its call open'],
    ['a call of another tool', view({ mainOpen: [{ name: 'Read', at: T0 - 1e3 }] }), 'no thread of the lead\'s has its call open'],
    ['a request after it', view({ main: T0 + MIN, mainOpen: bash(T0 - 1e3) }), 'no thread of the lead\'s has its call open'],
    ['its subagent stopped', view({ agentOpen: bash(T0 - 1e3) }), 'its thread moved past it']
  ]) {
    const h = await heldWorld();
    try {
      h.clock.t += 1e3;
      const stopped = name === 'its subagent stopped' ? new Map([[LEAD, new Map([[KEY, T0 + 30e3]])]]) : null;
      h.pass(threads, { stopped });
      assert.equal(h.s.store.permission('abcde'), null, name);
      assert.deepEqual(h.s.store.restoringPermissions(), [], `${name}: let go`);
      assert.deepEqual(h.s.events, [], `${name}: no page heard of it`);
      assert.ok(h.logs.includes(`chat: 1 permission card from before the restart not shown again (${words}): abcde`), `${name}: ${h.logs.join('\n')}`);
    } finally { await h.clean(); }
  }
});

test('the pass: two threads with the call open, one past it (a stopped subagent): still shown, as a card stays open while any is at it', async () => {
  const h = await heldWorld();
  try {
    h.clock.t += 1e3;
    h.pass(view({ mainOpen: bash(T0 - 1e3), agentOpen: bash(T0 - 2e3) }), { stopped: new Map([[LEAD, new Map([[KEY, T0 + 30e3]])]]) });
    assert.equal(h.s.store.permission('abcde').state, 'open');
  } finally { await h.clean(); }
});

test('the pass: one that began reading before the hello, or one with no lead session, leaves it held; one that read nothing of the thread lets it go', async () => {
  const h = await heldWorld();
  try {
    const at = h.clock.t;
    h.pass(view({ mainOpen: bash(T0 - 1e3) }), { readAt: at - 1 });
    assert.equal(h.s.store.restoringPermissions().length, 1, 'read before the hello');
    h.ae.pass({ threads: view({ mainOpen: bash(T0 - 1e3) }), sessions: [], readAt: at + 1 });
    assert.equal(h.s.store.restoringPermissions().length, 1, 'no lead session named');
    // A lead session whose transcripts were not read: no open call is seen, so it is let go
    // (fail closed: a card never comes back on no evidence).
    const unread = new Map([[LEAD, { main: undefined, agents: new Map(), types: new Map(), mainOpen: undefined, agentsOpen: new Map() }]]);
    h.pass(unread, { readAt: at + 1 });
    assert.deepEqual(h.s.store.restoringPermissions(), [], 'nothing read: let go, never shown');
    assert.equal(h.s.store.permission('abcde'), null);
  } finally { await h.clean(); }
});

test('the pass: a card relayed long after its call (a late prompt) is shown again only in a current session', async () => {
  const h = await heldWorld();
  try {
    h.clock.t += 1e3;
    // The call was written 5 minutes before the relay: in a session not written since the
    // channel's hello it can't be the card's, so nothing holds it open.
    h.pass(view({ main: T0 - 6 * MIN, mainOpen: bash(T0 - 5 * MIN) }), { written: new Map([[LEAD, T0 - HOUR - 1]]) });
    assert.deepEqual(h.s.store.restoringPermissions(), []);
    assert.equal(h.s.store.permission('abcde'), null);
  } finally { await h.clean(); }
  const k = await heldWorld();
  try {
    k.clock.t += 1e3;
    k.pass(view({ main: T0 - 6 * MIN, mainOpen: bash(T0 - 5 * MIN) }));
    assert.equal(k.s.store.permission('abcde').state, 'open', 'written since the hello (the session\'s own first hello): any age');
  } finally { await k.clean(); }
});

// ---- end to end through the channel's socket ----

const call = ({ socketPath, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({ socketPath, method, path, headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});
// One server process: a store on the world's folder and the socket router on its own socket.
async function serverAt(w, n) {
  const logs = [];
  const now = () => w.clock.t;
  const store = createChatStore({ dir: w.dir, now, log: l => logs.push(l) });
  await store.load();
  const approvals = { mode: () => 'on', serverMode: () => 'on', assess: () => ({ denyOnly: [], why: null }), noteChannelRelay: v => v, noteChannelTest: () => false, noteOpenCount: () => {} };
  // The verifier answers ps's start for the pid (whole seconds, cut down), as chat-verify's does.
  const starts = new Map([[A.pid, A.startedAt], [B.pid, B.startedAt]]);
  const socket = createSocketRouter({ store, now, onEvent: () => {}, log: l => logs.push(l), pingMs: 60e3, approvals, verifyRestart: async pid => ({ ok: true, startedAt: Math.floor(starts.get(pid) / 1000) * 1000 }), verifyEveryHello: true });
  const socketPath = join(w.dir, `s${n}.sock`);
  const srv = createServer((q, r) => socket.handler(q, r));
  await new Promise(r => srv.listen(socketPath, r));
  w.servers.add(srv);
  const env = { store, logs, token: null };
  env.hello = async (body, token = null) => { const h = await call({ socketPath, method: 'POST', path: '/v1/hello', body: { relay: 'allow', test: false, ...body }, headers: token ? { [SESSION_HEADER]: token } : {} }); if (h.status === 200) env.token = h.json.token; return h; };
  env.open = id => call({ socketPath, method: 'POST', path: '/v1/permission-request', headers: { [SESSION_HEADER]: env.token }, body: { requestId: id, tool: 'Bash', description: 'list', inputPreview: PREVIEW, relayedAt: w.clock.t } });
  env.close = async () => { await store.flushPermissions(); w.servers.delete(srv); srv.closeAllConnections?.(); await new Promise(r => srv.close(r)); };
  return env;
}

test('socket: the same channel process meets the restarted server, with the token the old one gave: its card comes back; a new process\'s hello does not bring it', async () => {
  const w = await world();
  try {
    const one = await serverAt(w, 1);
    assert.equal((await one.hello({ ...A, permHoldMs: HOLD })).status, 200);
    assert.equal((await one.open('abcde')).status, 200);
    const oldToken = one.token;
    await one.close();
    w.clock.t += MIN;
    const two = await serverAt(w, 2);
    // The channel re-hellos with the token it holds, which this server never gave.
    assert.equal((await two.hello({ ...A, permHoldMs: HOLD }, oldToken)).status, 200);
    assert.ok(two.logs.includes(`chat: 1 permission card from before the restart held for the sessions pass (the same channel process said hello, pid ${A.pid})`), two.logs.join('\n'));
    assert.equal(two.store.restoringPermissions().length, 1);
    // Its own re-hello later keeps it (the holder's).
    assert.equal((await two.hello({ ...A, permHoldMs: HOLD }, two.token)).status, 200);
    assert.equal(two.store.restoringPermissions().length, 1);
    two.store.settleRestored(new Map([['abcde', true]]));
    assert.equal(two.store.publicPermission(two.store.permission('abcde')).expiresAt, T0 + WINDOW);
    await two.close();
    w.clock.t += MIN;
    const three = await serverAt(w, 3);
    assert.equal((await three.hello({ ...B, permHoldMs: HOLD })).status, 200);
    assert.ok(three.logs.includes('chat: 1 permission card from before the restart not put back (a different channel process said hello)'), three.logs.join('\n'));
    assert.equal(three.store.permission('abcde'), null);
    await three.close();
  } finally { await w.clean(); }
});

// ---- the reminder's words ----

test('the reminder names the chat only while a card there is open for the wait', async () => {
  const wait = { key: 'needs-you:aaaa', who: 'Inventlead', run: null, tool: 'Bash', since: T0, own: true };
  assert.equal(REMINDER_TAIL_NO_CARD, 'Answer it in Discord or the terminal.');
  const without = reminderBody([wait], T0 + 10 * MIN);
  assert.equal(without, `Inventlead has waited 10 min on an approval card. ${REMINDER_TAIL_NO_CARD}`, 'with no word of a card, no chat');
  assert.equal(isReminderPush(without), true);
  assert.equal(reminderBody([wait], T0 + 10 * MIN, { card: 'yes' }), without, 'only a plain true names the chat');
  assert.equal(isReminderPush(reminderBody([wait], T0 + 10 * MIN, { card: true })), true);
  assert.ok(reminderBody([wait], T0 + 10 * MIN, { card: true }).endsWith(REMINDER_TAIL));
  assert.equal(isReminderPush(`Inventlead has waited 10 min on an approval card. Answer it in Jarvis OS chat or the terminal.`), false);
  assert.equal(isReminderPush(`Inventlead has waited 10 min on an approval card. Answer it in the terminal.`), false);
  for (const [name, hasCard, tail] of [
    ['a card', () => true, REMINDER_TAIL],
    ['none', () => false, REMINDER_TAIL_NO_CARD],
    ['a check that throws', () => { throw new Error('x'); }, REMINDER_TAIL_NO_CARD],
    ['a word that is not true', () => 1, REMINDER_TAIL_NO_CARD],
    ['no check given', undefined, REMINDER_TAIL_NO_CARD]
  ]) {
    const pushes = [];
    const seen = [];
    const rem = createApprovalReminders({ push: async b => { pushes.push(b); return { tried: 1, reached: 1 }; }, log: () => {}, ...(hasCard ? { hasCard: w => { seen.push(w.key); return hasCard(w); } } : {}) });
    await rem.step([wait, { ...wait, key: 'needs-you:bbbb' }], T0 + 10 * MIN);
    assert.deepEqual(pushes, [`Inventlead has waited 10 min on an approval card. 1 more card is waiting too. ${tail}`], name);
    if (hasCard) assert.deepEqual(seen, ['needs-you:aaaa'], `${name}: asked of the wait the push names`);
  }
});

// server.mjs is not run by a test; its wiring is checked here.
test('server.mjs: the store logs its write failures, the start says what is on file, the pass gets the gate, the reminder the open cards', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /createChatStore\(\{ dir: chatDir, log: line => console\.error\(line\) \}\)/);
  assert.match(src, /loaded\.permissionsOnFile > 0/);
  assert.match(src, /createAnsweredElsewhere\(\{[^}]*assess: q => approvals\.assess\(q\) \}\)/);
  assert.match(src, /hasCard = hasCardFor\(\{ waitThread: key => needsYou\.permissionThread\(key, Date\.now\(\)\)/);
  const sock = await readFile(new URL('../lib/chat-socket.mjs', import.meta.url), 'utf8');
  assert.match(sock, /const back = store\.channelHello\(\{ pid, startedAt: client\.startedAt, unproven \}\);/);
});
