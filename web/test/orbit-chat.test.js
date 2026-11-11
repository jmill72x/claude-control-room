// The Chat tab's pure logic (src/lib/orbit/chat.js): merge and dedup by seq, the
// pending bubble's replacement, ticks, the status banner, permission cards, the
// photo resize, the day lines and the ids. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newClientId, mergeMessages, applyEdit, applyState, lastSeq, oldestId, tickFor, TICK_MARKS, bannerFor,
  permissionView, upsertPermission, effectiveStatus, resizeTarget, fileSize, dayLabel, threadRows, quoted, quoteLine, PERMISSION_TTL_MS
} from '../src/lib/orbit/chat.js';
import { parseRoute, routeHash } from '../src/lib/orbit/page.js';

const T0 = new Date(2026, 10, 11, 9, 5).getTime();
const msg = (seq, from, text, extra = {}) => ({ seq, id: `m_${seq}abcdef`, at: T0 + seq * 1000, from, kind: 'chat', text, replyTo: null, attachments: [], editedAt: null, state: from === 'jeff' ? 'queued' : null, ...extra });

test('the chat tab lives at #chat', () => {
  assert.deepEqual(parseRoute('#chat'), { tab: 'chat', item: null });
  assert.equal(routeHash({ tab: 'chat' }), '#chat');
  assert.deepEqual(parseRoute('#board'), { tab: 'board', item: null });
  assert.deepEqual(parseRoute('#chat/x'), { tab: 'overview', item: null }, 'nothing hangs off #chat');
});

test('client ids are unique and of the server\'s shape', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(newClientId());
  assert.equal(ids.size, 200);
  assert.match(newClientId(1794380000000, () => 0.5), /^p_[a-z0-9]+_[a-z0-9]{6}$/);
  assert.ok(newClientId().length <= 80);
});

test('a merge keeps each seq once, in order, the newer copy winning', () => {
  const a = [msg(1, 'jeff', 'hi'), msg(3, 'jarvis', 'yes')];
  const merged = mergeMessages(a, [msg(2, 'jarvis', 'hello'), { ...msg(3, 'jarvis', 'yes!'), editedAt: 5 }, msg(1, 'jeff', 'hi')]);
  assert.deepEqual(merged.map(m => m.seq), [1, 2, 3]);
  assert.equal(merged[2].text, 'yes!', 'the later copy of seq 3 wins');
  assert.equal(mergeMessages(a, msg(0.5, 'x', 'bad')).length, 2, 'a message without an integer seq is dropped');
  assert.equal(mergeMessages(a, [null, undefined]).length, 2);
  const older = mergeMessages(merged, [msg(-1, 'jarvis', 'first')]);
  assert.equal(older[0].seq, -1, 'older history goes in front');
});

test('a pending bubble stays until the server\'s copy of its send arrives, then gives way', () => {
  const pending = { clientId: 'p_1', id: null, seq: null, from: 'jeff', kind: 'chat', text: 'sending', at: T0, attachments: [] };
  const list = mergeMessages([msg(1, 'jarvis', 'hello')], [], {});
  const withPending = [...list, pending];
  assert.equal(withPending.length, 2);
  // Someone else's message arrives: the pending bubble stays, after the seqs.
  const other = mergeMessages(withPending, msg(2, 'jarvis', 'more'));
  assert.deepEqual(other.map(m => m.seq), [1, 2, null]);
  // The send answered {id: m_3abcdef}; when that message arrives it replaces the bubble.
  const done = mergeMessages(other, msg(3, 'jeff', 'sending'), { pendingId: 'm_3abcdef', clientId: 'p_1' });
  assert.deepEqual(done.map(m => m.seq), [1, 2, 3]);
  assert.ok(!done.some(m => m.clientId === 'p_1' && m.seq === null));
  // The same answer without the pending id resolves nothing (a different clientId).
  const kept = mergeMessages(other, msg(3, 'jeff', 'sending'), { pendingId: 'm_3abcdef', clientId: 'p_other' });
  assert.equal(kept.length, 4);
  // The page's own optimistic copy carrying the server's id (set after the send
  // answered) is replaced when the live event comes without the hint too.
  const named = [...list, { ...pending, id: 'm_9abcdef' }];
  assert.equal(mergeMessages(named, msg(9, 'jeff', 'sending')).filter(m => m.id === 'm_9abcdef').length, 1);
});

test('edits and state changes touch one message', () => {
  const list = [msg(1, 'jeff', 'hi'), msg(2, 'jarvis', 'hello')];
  const edited = applyEdit(list, { id: 'm_2abcdef', text: 'hello!', editedAt: 77 });
  assert.equal(edited[1].text, 'hello!');
  assert.equal(edited[1].editedAt, 77);
  assert.equal(edited[0].text, 'hi');
  const delivered = applyState(list, { id: 'm_1abcdef', state: 'delivered' });
  assert.equal(delivered[0].state, 'delivered');
  assert.equal(delivered[1], list[1], 'untouched rows are the same objects');
  assert.equal(applyState(list, { id: 'm_1abcdef', state: 'queued' })[0], list[0], 'the same state changes nothing');
});

test('lastSeq and oldestId skip pending bubbles', () => {
  assert.equal(lastSeq([]), 0);
  assert.equal(lastSeq([msg(4, 'jeff', 'a'), { clientId: 'p', seq: null }, msg(2, 'jeff', 'b')]), 4);
  assert.equal(oldestId([{ clientId: 'p', seq: null }]), null);
  assert.equal(oldestId([msg(2, 'jeff', 'b'), msg(4, 'jeff', 'a')]), 'm_2abcdef');
});

test('ticks: sending, failed, queued, one when delivered, two when answered; only the owner\'s chat messages', () => {
  const mine = msg(1, 'jeff', 'hi');
  assert.equal(tickFor(mine, [mine]), 'queued');
  assert.equal(TICK_MARKS.queued, '');
  assert.equal(tickFor({ ...mine, state: 'delivered' }, [mine]), 'delivered');
  assert.equal(TICK_MARKS.delivered, '✓');
  const answered = [mine, msg(2, 'jarvis', 'hello')];
  assert.equal(tickFor(mine, answered), 'answered');
  assert.equal(TICK_MARKS.answered, '✓✓');
  assert.equal(tickFor(mine, [mine, msg(2, 'jarvis', 'x', { kind: 'permission' })]), 'queued', 'a permission request is not an answer');
  assert.equal(tickFor(mine, [mine, msg(0, 'jarvis', 'earlier')]), 'queued', 'an earlier message is not an answer');
  assert.equal(tickFor({ ...mine, seq: null, clientId: 'p' }, []), 'sending');
  assert.equal(tickFor({ ...mine, seq: null, failed: true }, []), 'failed');
  assert.equal(tickFor(msg(2, 'jarvis', 'hello'), answered), null);
  assert.equal(tickFor(msg(3, 'jeff', 'allow', { kind: 'verdict' }), answered), null);
  assert.equal(tickFor(null, []), null);
});

test('the banner says what the status means, in local time', () => {
  const now = T0;
  assert.equal(bannerFor(null).tone, 'quiet');
  assert.deepEqual(bannerFor({ state: 'online' }, now), { tone: 'online', text: 'Jarvis is online' });
  const off = bannerFor({ state: 'offline', since: new Date(2026, 10, 11, 8, 7).getTime() }, now);
  assert.equal(off.tone, 'offline');
  assert.equal(off.text, "Jarvis is offline since 08:07. Messages wait here and reach him when he's back.");
  assert.equal(bannerFor({ state: 'offline', since: null }, now).text, "Jarvis is offline. Messages wait here and reach him when he's back.");
  assert.deepEqual(bannerFor({ state: 'slow', since: now - 10 * 60e3 - 5000 }, now), { tone: 'slow', text: 'Delivered 10 m ago, no answer yet' });
  assert.equal(bannerFor({ state: 'slow', since: now - 1000 }, now).text, 'Delivered 1 m ago, no answer yet', 'never 0 m');
  assert.equal(bannerFor({ state: 'slow' }, now).text, 'Delivered a while ago, no answer yet');
  assert.equal(bannerFor({ state: 'waiting on you' }, now).tone, 'waiting');
});

test('the open cards decide "waiting on you" between status pings, both ways', () => {
  const p = { requestId: 'r1', tool: 'Bash', description: 'x', inputPreview: '', openedAt: T0, state: 'open' };
  const open = new Map([['r1', p]]);
  assert.equal(effectiveStatus({ state: 'online' }, open, T0).state, 'waiting on you');
  const same = { state: 'waiting on you', since: 1 };
  assert.equal(effectiveStatus(same, open, T0), same, 'unchanged when the server says so already');
  assert.equal(effectiveStatus({ state: 'waiting on you', channelConnected: true }, new Map(), T0).state, 'online', 'closed on the page before the next ping');
  assert.equal(effectiveStatus({ state: 'waiting on you', channelConnected: false }, new Map(), T0).state, 'offline');
  assert.equal(effectiveStatus({ state: 'waiting on you' }, new Map([['r1', { ...p, state: 'allowed' }]]), T0).state, 'online');
  assert.equal(effectiveStatus({ state: 'online' }, open, T0 + PERMISSION_TTL_MS).state, 'online', 'an expired card is not waiting');
  assert.equal(effectiveStatus({ state: 'offline' }, new Map(), T0).state, 'offline');
  assert.equal(effectiveStatus(null, open, T0), null);
});

test('a permission card is open, expired after 10 minutes on the page too, or closed', () => {
  const p = { requestId: 'r1', tool: 'Bash', description: 'run ls', inputPreview: 'ls -la', openedAt: T0, state: 'open' };
  assert.equal(permissionView(p, T0 + 1000).view, 'open');
  assert.equal(permissionView(p, T0 + PERMISSION_TTL_MS).view, 'expired');
  assert.equal(permissionView({ ...p, state: 'expired' }, T0).view, 'expired');
  assert.equal(permissionView({ ...p, state: 'allowed' }, T0).view, 'closed');
  assert.equal(permissionView({ ...p, state: 'denied' }, T0 + PERMISSION_TTL_MS).view, 'closed');
  assert.equal(permissionView(null), null);
  const empty = new Map();
  let map = upsertPermission(empty, p);
  assert.equal(empty.size, 0, 'the old map is left alone (React compares by identity)');
  const opened = map;
  map = upsertPermission(map, { ...p, state: 'allowed' });
  assert.notEqual(map, opened);
  assert.equal(opened.get('r1').state, 'open');
  assert.equal(map.size, 1);
  assert.equal(map.get('r1').state, 'allowed');
  assert.equal(upsertPermission(map, { tool: 'x' }), map, 'no id, no change');
});

test('a photo is drawn at a 1568 px long edge, the aspect kept, never scaled up', () => {
  assert.deepEqual(resizeTarget(4032, 3024), { width: 1568, height: 1176, scaled: true });
  assert.deepEqual(resizeTarget(3024, 4032), { width: 1176, height: 1568, scaled: true });
  assert.deepEqual(resizeTarget(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(resizeTarget(1568, 1568), { width: 1568, height: 1568, scaled: false });
  assert.deepEqual(resizeTarget(10000, 1), { width: 1568, height: 1, scaled: true }, 'a sliver keeps a pixel');
  assert.deepEqual(resizeTarget(3000, 2000, 1000), { width: 1000, height: 667, scaled: true });
  assert.equal(fileSize(900), '900 B');
  assert.equal(fileSize(820 * 1024), '820 KB');
  assert.equal(fileSize(2.3 * 1024 * 1024), '2.3 MB');
  assert.equal(fileSize(NaN), '');
});

test('day lines: Today, Yesterday, then the weekday and date; one per day', () => {
  const now = T0;
  assert.equal(dayLabel(now - 60e3, now), 'Today');
  assert.equal(dayLabel(now - 24 * 3600e3, now), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 10, 3, 23).getTime(), now), 'Tue 11-03');
  const rows = threadRows([
    { ...msg(1, 'jeff', 'a'), at: new Date(2026, 10, 10, 9).getTime() },
    { ...msg(2, 'jarvis', 'b'), at: new Date(2026, 10, 10, 10).getTime() },
    { ...msg(3, 'jeff', 'c'), at: now },
    { clientId: 'p_1', seq: null, id: null, from: 'jeff', kind: 'chat', text: 'd', at: now }
  ], now);
  assert.deepEqual(rows.map(r => r.type), ['day', 'message', 'message', 'day', 'message', 'message']);
  assert.equal(rows[0].label, 'Yesterday');
  assert.equal(rows[3].label, 'Today');
  assert.equal(rows[5].key, 'p_1', 'a pending row is keyed by its clientId');
});

test('a reply quotes the message by id, on one short line', () => {
  const list = [msg(1, 'jarvis', 'The first line\nand a second one that goes on and on and on and on and on and on and on and on and on')];
  assert.equal(quoted(list, 'm_1abcdef'), list[0]);
  assert.equal(quoted(list, 'm_nope'), null);
  assert.equal(quoted(list, null), null);
  const line = quoteLine(list[0]);
  assert.equal(line.length, 90);
  assert.ok(line.endsWith('…'));
  assert.ok(!line.includes('\n'));
  assert.equal(quoteLine(null), 'an earlier message');
  assert.equal(quoteLine({ text: '', attachments: [{ id: 'a' }] }), 'Photo');
  assert.equal(quoteLine({ text: '', attachments: [{ id: 'a' }, { id: 'b' }] }), 'Photos');
});
