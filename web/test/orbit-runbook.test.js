// "Bring Jarvis Back" on the page (board 52ee3f17): where the run sheet's link shows,
// and when the chat's banner offers it. src/lib/orbit/runbook.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNBOOK_URL, RUNBOOK_LABEL, STUCK_AFTER_MS, stuckSince, noteQueued, leadService, isLeadServiceKey, isLeadDownAlert
} from '../src/lib/orbit/runbook.js';
import { bannerFor, mergeFresh } from '../src/lib/orbit/chat.js';

const T0 = new Date(2026, 10, 19, 14, 30).getTime();
const mine = (seq, at, extra = {}) => ({ seq, id: `m_${seq}abcdef`, at, from: 'jeff', kind: 'chat', text: 'hi', state: 'queued', ...extra });

test('the run sheet is a claude.ai page, named as Jeff knows it', () => {
  assert.match(RUNBOOK_URL, /^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9]+$/);
  assert.equal(RUNBOOK_LABEL, 'Bring Jarvis Back');
});

test('the address lives in one place: no other source file holds it', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const holders = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|jsx|css|html)$/.test(name) && readFileSync(path, 'utf8').includes(RUNBOOK_URL.split('/').pop())) holders.push(path.slice(src.length + 1));
    }
  };
  walk(src);
  assert.deepEqual(holders, ['lib/orbit/runbook.js']);
});

test('every place that offers it uses the one link component', () => {
  const read = f => readFileSync(new URL(`../src/orbit/${f}`, import.meta.url), 'utf8');
  for (const f of ['Overview.jsx', 'Health.jsx', 'Acks.jsx', 'Waiting.jsx', 'Chat.jsx']) {
    assert.match(read(f), /<Runbook(Link|Foot)\b/, `${f} draws the link`);
  }
  const link = read('Runbook.jsx');
  assert.match(link, /target="_blank" rel="noopener noreferrer"/, 'a new tab, without handing claude.ai this page');
  assert.match(link, /href=\{RUNBOOK_URL\}/);
});

// A map as noteQueued keeps it: id -> when this page first saw the message queued.
const seenAt = (...pairs) => new Map(pairs);
const theirs = (seq, extra = {}) => ({ seq, id: `m_${seq}jarvis0`, at: T0, from: 'jarvis', kind: 'chat', text: 'ok', state: null, ...extra });

test('a message is stuck once this page has watched it queued for two minutes', () => {
  const now = T0;
  assert.equal(STUCK_AFTER_MS, 120e3);
  const m1 = mine(1, now - 60 * 60e3);
  assert.equal(stuckSince([], now, seenAt()), null);
  assert.equal(stuckSince(undefined, now, seenAt()), null);
  assert.equal(stuckSince([m1], now), null, 'never watched: never stuck');
  assert.equal(stuckSince([m1], now, seenAt()), null, 'not in the map: not watched yet');
  assert.equal(stuckSince([m1], now, seenAt([m1.id, now - STUCK_AFTER_MS + 1])), null, 'not yet two minutes');
  assert.equal(stuckSince([m1], now, seenAt([m1.id, now - STUCK_AFTER_MS])), m1, 'two minutes exactly');
  // The oldest one is named, in whatever order the thread holds them.
  const m2 = mine(2, now - 3 * 60e3);
  assert.equal(stuckSince([m2, m1], now, seenAt([m1.id, now - 5 * 60e3], [m2.id, now - 3 * 60e3])), m1);
});

test('the two minutes run on this device\'s clock, never against the server\'s `at` (Ultron\'s low)', () => {
  const now = T0;
  // The server's clock far behind this device's: the message looks an hour old.
  const old = mine(1, now - 60 * 60e3);
  assert.equal(stuckSince([old], now, seenAt([old.id, now - 10e3])), null, 'seen 10 s ago here');
  // The server's clock ahead: the message looks sent in the future.
  const ahead = mine(1, now + 10 * 60e3);
  assert.equal(stuckSince([ahead], now, seenAt([ahead.id, now - 3 * 60e3])), ahead);
});

test('noteQueued starts a clock per queued message only while the page is watching', () => {
  const now = T0;
  const m1 = mine(1, now), m2 = mine(2, now);
  assert.deepEqual([...noteQueued(null, [m1], now, true)], [[m1.id, now]], 'first seen now');
  const before = seenAt([m1.id, now - 90e3]);
  assert.deepEqual([...noteQueued(before, [m1, m2], now, true)], [[m1.id, now - 90e3], [m2.id, now]], 'an earlier sighting is kept');
  assert.notEqual(noteQueued(before, [m1], now, true), before, 'a new map, the old one untouched');
  assert.deepEqual([...noteQueued(before, [mine(1, now, { state: 'delivered' })], now, true)], [], 'delivered: its clock goes');
  assert.deepEqual([...noteQueued(before, [m1], now, false)], [], 'stream closed or channel gone: every clock starts again');
  assert.deepEqual([...noteQueued(before, [m1, theirs(2)], now, true)], [], 'a later message from the lead passes it');
});

test('only the owner\'s numbered, queued chat messages can be stuck', () => {
  const now = T0;
  const at = now - 10 * 60e3;
  const check = m => stuckSince([m], now, seenAt([m.id, at]));
  assert.equal(check(mine(1, at, { state: 'delivered' })), null, 'the channel took it');
  assert.equal(check(mine(1, at, { state: 'undelivered' })), null, 'it has its own line');
  assert.equal(check(mine(1, at, { from: 'jarvis' })), null);
  assert.equal(check(mine(1, at, { from: 'system' })), null, 'only the owner\'s own');
  assert.equal(check(mine(1, at, { kind: 'verdict' })), null);
  assert.equal(check(mine(undefined, at)), null, 'still sending: the page\'s own trouble');
  assert.equal(check(mine(1, at, { failed: true })), null, 'refused: its Retry says so');
});

test('a stale `queued` is not stuck when the thread shows the channel got past it (Ultron\'s medium)', () => {
  const now = T0;
  const at = now - 10 * 60e3;
  const q = mine(3, at);
  const seen = seenAt([q.id, at]);
  assert.equal(stuckSince([q], now, seen), q, 'alone, it is stuck');
  assert.equal(stuckSince([q, mine(5, at, { state: 'delivered' })], now, seen), null, 'a later message of the owner\'s delivered: acks are cumulative');
  assert.equal(stuckSince([q, theirs(4)], now, seen), null, 'a later message from the lead');
  assert.equal(stuckSince([q, theirs(4, { kind: 'notice' })], now, seen), null, 'any kind from the lead');
  assert.equal(stuckSince([theirs(2), q], now, seen), q, 'an earlier answer says nothing about this one');
  assert.equal(stuckSince([mine(2, at, { state: 'delivered' }), q], now, seen), q, 'nor an earlier delivered one');
  assert.equal(stuckSince([q, mine(5, at)], now, seenAt([q.id, at], [`m_5abcdef`, at])), q, 'a later one still queued proves nothing');
  assert.equal(stuckSince([q, theirs(4, { meta: { routine: 'brief' } })], now, seen), q, 'a routine\'s message comes from launchd, not the channel');
});

test('the banner offers the run sheet loudly when the channel is gone or stuck, quietly when he is silent', () => {
  const now = T0;
  assert.equal(bannerFor({ state: 'offline', since: now - 60e3 }, now).runbook, 'loud');
  assert.equal(bannerFor({ state: 'online' }, now).runbook, undefined);
  assert.equal(bannerFor(null, now).runbook, undefined, 'not while connecting');
  assert.equal(bannerFor({ state: 'slow', since: now - 11 * 60e3 }, now).runbook, 'quiet');

  const q = mine(4, new Date(2026, 10, 19, 14, 25).getTime());
  const stuck = [q];
  const seen = seenAt([q.id, now - 3 * 60e3]);
  const b = bannerFor({ state: 'online' }, now, stuck, seen);
  assert.deepEqual(b, { tone: 'stuck', text: "Your message from 14:25 hasn't reached Jarvis: his channel isn't taking messages.", runbook: 'loud' });
  assert.equal(bannerFor({ state: 'online' }, now, stuck).tone, 'online', 'without the page\'s sightings, never stuck');
  assert.equal(bannerFor({ state: 'slow', since: now - 11 * 60e3 }, now, stuck, seen).tone, 'stuck', 'stuck outranks slow');
  assert.equal(bannerFor({ state: 'offline', since: now - 60e3 }, now, stuck, seen).tone, 'offline', 'offline says more');
  assert.equal(bannerFor({ state: 'waiting on you' }, now, stuck, seen).tone, 'waiting', 'an open request proves the channel works');
  assert.equal(bannerFor({ state: 'online' }, now, stuck, seenAt([q.id, now - 30e3])).tone, 'online', 'seen queued 30 s ago is not stuck');
});

test('a refetched page brings the states a resumed stream never replays', () => {
  const now = T0;
  const page = [theirs(1), mine(2, now, { state: 'delivered' }), theirs(3)];
  const out = mergeFresh([theirs(1), mine(2, now)], page);
  assert.deepEqual(out.map(m => [m.seq, m.state]), [[1, null], [2, 'delivered'], [3, null]], 'queued -> delivered, and the answer added');
  // A live event that landed while the fetch was on its way is never undone.
  assert.equal(mergeFresh([mine(2, now, { state: 'delivered' })], [mine(2, now)])[0].state, 'delivered');
  assert.equal(mergeFresh([mine(2, now, { state: 'undelivered' })], [mine(2, now)])[0].state, 'undelivered');
  const edited = mergeFresh([theirs(1, { text: 'new', editedAt: now })], [theirs(1, { text: 'old', editedAt: null })])[0];
  assert.deepEqual([edited.text, edited.editedAt], ['new', now], 'a later live edit is kept');
  const newer = mergeFresh([theirs(1, { text: 'a', editedAt: now })], [theirs(1, { text: 'b', editedAt: now + 1 })])[0];
  assert.equal(newer.text, 'b', 'a newer edit from the server wins');
  // A bubble still sending stays; a missing or empty page changes nothing.
  const pending = { id: 'p1', clientId: 'c1', from: 'jeff', kind: 'chat', text: 'x' };
  assert.equal(mergeFresh([pending, mine(2, now)], [mine(2, now)]).length, 2);
  assert.deepEqual(mergeFresh([mine(2, now)], undefined), [mine(2, now)]);
});

test('every stream open refetches the latest page and merges it with mergeFresh', () => {
  const src = readFileSync(new URL('../src/orbit/useChat.js', import.meta.url), 'utf8');
  const open = src.slice(src.indexOf("es.addEventListener('open'"), src.indexOf("es.addEventListener('status'"));
  assert.match(open, /api\.latestMessages\(PAGE\)/);
  assert.match(open, /mergeFresh\(list, page\?\.messages\)/);
  assert.match(open, /esRef\.current !== es/, 'an answer for an older stream is dropped');
  const chat = readFileSync(new URL('../src/orbit/Chat.jsx', import.meta.url), 'utf8');
  assert.match(chat, /chat\.stream === 'open' && chat\.status\?\.channelConnected === true/, 'watched only with the stream open and the channel connected');
  assert.match(chat, /bannerFor\([^)]*\)[^;]*queuedRef\.current\)/);
});

const SERVICES = [
  { key: 'session:Jarvis', kind: 'session', name: 'Jarvis', state: 'down' },
  { key: 'self:Control Room', kind: 'self', name: 'Control Room', state: 'up' },
  { key: 'launchd:Tunnel', kind: 'launchd', name: 'Tunnel', state: 'running' }
];

test('the lead\'s session is the one named like the roster\'s lead, else the only one', () => {
  assert.equal(leadService(SERVICES, 'Jarvis')?.key, 'session:Jarvis');
  assert.equal(leadService(SERVICES, 'Someone')?.key, 'session:Jarvis', 'the only session');
  assert.equal(leadService(SERVICES, null)?.key, 'session:Jarvis');
  const two = [...SERVICES, { key: 'session:Other', kind: 'session', name: 'Other' }];
  assert.equal(leadService(two, 'Other')?.key, 'session:Other');
  assert.equal(leadService(two, 'Someone'), null, 'two sessions and no name: neither');
  assert.equal(leadService(null, 'Jarvis'), null);
  assert.equal(leadService(SERVICES.filter(s => s.kind !== 'session'), 'Jarvis'), null);
});

test('the lead\'s health details carry the link, no other chip\'s', () => {
  assert.equal(isLeadServiceKey('session:Jarvis', SERVICES, 'Jarvis'), true);
  assert.equal(isLeadServiceKey('launchd:Tunnel', SERVICES, 'Jarvis'), false);
  assert.equal(isLeadServiceKey('jobs', SERVICES, 'Jarvis'), false);
  assert.equal(isLeadServiceKey(null, SERVICES, 'Jarvis'), false);
  assert.equal(isLeadServiceKey('session:Jarvis', undefined, 'Jarvis'), false);
});

test('"<lead> is not running" carries the link; other alerts do not', () => {
  const down = { text: 'Jarvis is not running', kind: 'service', key: 'service:session:Jarvis', since: T0 };
  assert.equal(isLeadDownAlert(down, SERVICES, 'Jarvis'), true);
  assert.equal(isLeadDownAlert({ ...down, key: 'service:launchd:Tunnel', text: 'Tunnel is not running' }, SERVICES, 'Jarvis'), false);
  assert.equal(isLeadDownAlert({ ...down, kind: 'cron' }, SERVICES, 'Jarvis'), false);
  assert.equal(isLeadDownAlert({ text: 'x', kind: 'service' }, SERVICES, 'Jarvis'), false, 'no key');
  assert.equal(isLeadDownAlert(null, SERVICES, 'Jarvis'), false);
  const two = [...SERVICES, { key: 'session:Other', kind: 'session', name: 'Other' }];
  assert.equal(isLeadDownAlert({ ...down, key: 'service:session:Other' }, two, 'Jarvis'), false, 'another session is not the lead');
  // No health panel to match against: a session's alert is the lead's.
  assert.equal(isLeadDownAlert(down, null, 'Jarvis'), true);
  assert.equal(isLeadDownAlert({ ...down, key: 'service:launchd:Tunnel' }, null, 'Jarvis'), false);
});
