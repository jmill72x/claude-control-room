// The Chat tab's unseen badge (src/lib/orbit/unseen.js): what counts as unseen,
// the per-device "seen up to" mark, a poll's answer reconciled against it, and the
// badge's text and label. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsAsUnseen, unseenAfter, parseSeen, reconcile, markSeen, badgeText, chatTabLabel, SEEN_KEY } from '../src/lib/orbit/unseen.js';

const msg = (seq, from, kind = 'chat') => ({ seq, id: `m_${seq}abcdef`, from, kind, text: 'x' });

test('only the lead\'s messages and event lines count as unseen', () => {
  assert.equal(countsAsUnseen(msg(1, 'jarvis')), true);
  assert.equal(countsAsUnseen(msg(2, 'jarvis', 'permission')), true, 'an approval request is the lead\'s');
  assert.equal(countsAsUnseen(msg(3, 'system', 'event')), true);
  assert.equal(countsAsUnseen({ ...msg(3, 'system', 'event'), meta: { event: { source: 'launchd' } } }), true);
  assert.equal(countsAsUnseen({ ...msg(3, 'system', 'event'), meta: { event: { source: 'presence' } } }), false, 'his own Shortcut\'s arrival is no news to him');
  assert.equal(countsAsUnseen({ ...msg(3, 'jarvis'), meta: { event: { source: 'presence' } } }), true, 'only an event can be his own report');
  assert.equal(countsAsUnseen(msg(4, 'jeff')), false, 'the owner\'s own message, even from another device');
  assert.equal(countsAsUnseen(msg(5, 'jeff', 'verdict')), false);
  assert.equal(countsAsUnseen(msg(6, 'system', 'notice')), false, 'a restart notice is not news');
  assert.equal(countsAsUnseen({ ...msg(7, 'jarvis'), seq: null }), false, 'no seq, not on the server yet');
  assert.equal(countsAsUnseen(null), false);
});

test('unseenAfter counts only what lies past the mark', () => {
  const list = [msg(4, 'jarvis'), msg(5, 'jeff'), msg(6, 'system', 'event'), msg(7, 'jarvis')];
  assert.equal(unseenAfter(list, 3), 3);
  assert.equal(unseenAfter(list, 4), 2);
  assert.equal(unseenAfter(list, 7), 0);
  assert.equal(unseenAfter(undefined, 0), 0);
});

test('the stored mark is read defensively', () => {
  assert.equal(SEEN_KEY, 'jos.chat.seen');
  assert.deepEqual(parseSeen('{"epoch":"e1","seq":12}'), { epoch: 'e1', seq: 12 });
  assert.deepEqual(parseSeen('{"seq":12}'), { epoch: null, seq: 12 });
  assert.equal(parseSeen(null), null);
  assert.equal(parseSeen('not json'), null);
  assert.equal(parseSeen('{"epoch":"e1","seq":-1}'), null);
  assert.equal(parseSeen('{"epoch":"e1","seq":1.5}'), null);
  assert.equal(parseSeen('[1]'), null);
  assert.deepEqual(parseSeen('{"epoch":7,"seq":3}'), { epoch: null, seq: 3 }, 'a non-string epoch is unknown');
});

test('a device with no mark starts from the store\'s current seq, with no badge', () => {
  const r = reconcile(null, { messages: [msg(1, 'jarvis')], seq: 40, epoch: 'e1' });
  assert.deepEqual(r, { seen: { epoch: 'e1', seq: 40 }, count: 0, more: false });
});

test('a poll counts the lead\'s messages after the mark and keeps the mark', () => {
  const seen = { epoch: 'e1', seq: 10 };
  const r = reconcile(seen, { messages: [msg(11, 'jeff'), msg(12, 'jarvis'), msg(13, 'system', 'event')], seq: 13, epoch: 'e1' });
  assert.deepEqual(r, { seen, count: 2, more: false });
});

test('a mark with no epoch adopts the store\'s and keeps its seq', () => {
  const r = reconcile({ epoch: null, seq: 10 }, { messages: [msg(11, 'jarvis')], seq: 11, epoch: 'e1' });
  assert.deepEqual(r, { seen: { epoch: 'e1', seq: 10 }, count: 1, more: false });
});

test('a store that started again (new epoch, or a lower seq) resets the mark', () => {
  assert.deepEqual(reconcile({ epoch: 'e1', seq: 90 }, { messages: [], seq: 3, epoch: 'e2' }), { seen: { epoch: 'e2', seq: 3 }, count: 0, more: false });
  assert.deepEqual(reconcile({ epoch: 'e1', seq: 90 }, { messages: [], seq: 3, epoch: 'e1' }), { seen: { epoch: 'e1', seq: 3 }, count: 0, more: false });
});

test('a full page means there may be more past it', () => {
  const page = Array.from({ length: 100 }, (_, i) => msg(i + 1, 'jarvis'));
  const r = reconcile({ epoch: 'e1', seq: 0 }, { messages: page, seq: 150, epoch: 'e1' });
  assert.equal(r.count, 100);
  assert.equal(r.more, true);
  const exact = reconcile({ epoch: 'e1', seq: 0 }, { messages: page, seq: 100, epoch: 'e1' });
  assert.equal(exact.more, false, 'the page reached the store\'s end');
});

test('a malformed answer changes nothing', () => {
  const seen = { epoch: 'e1', seq: 5 };
  assert.deepEqual(reconcile(seen, null), { seen, count: 0, more: false });
  assert.deepEqual(reconcile(seen, { messages: 'x', seq: 'y' }), { seen, count: 0, more: false });
});

test('markSeen only moves forward and keeps the epoch', () => {
  assert.deepEqual(markSeen({ epoch: 'e1', seq: 5 }, 9), { epoch: 'e1', seq: 9 });
  assert.deepEqual(markSeen({ epoch: 'e1', seq: 9 }, 5), { epoch: 'e1', seq: 9 });
  assert.deepEqual(markSeen(null, 4), { epoch: null, seq: 4 });
  assert.deepEqual(markSeen({ epoch: 'e1', seq: 9 }, null), { epoch: 'e1', seq: 9 });
});

test('the badge\'s text and the tab\'s accessible name', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(120), '99+');
  assert.equal(badgeText(40, true), '40+');
  assert.equal(chatTabLabel(0), 'Chat');
  assert.equal(chatTabLabel(1), 'Chat, 1 unread message');
  assert.equal(chatTabLabel(3), 'Chat, 3 unread messages');
  assert.equal(chatTabLabel(40, true), 'Chat, more than 40 unread messages');
  assert.equal(chatTabLabel(120), 'Chat, more than 99 unread messages');
});
