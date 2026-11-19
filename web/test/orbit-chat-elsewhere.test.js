// Cards answered somewhere else, cards that timed out here, and parity with the relay,
// as the page shows them (src/lib/orbit/chat.js). Every request here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionView, sentLine, cardGone, keepCard, rememberDismissed, DISMISSED_KEEP_MS, DISMISSED_MAX, effectiveStatus, withStatus, upsertPermission, CLOSED_CARD_MS, ELSEWHERE_CARD_MS, DENY_ONLY_LEAD, PERMISSION_TTL_MS } from '../src/lib/orbit/chat.js';

const T0 = new Date(2026, 10, 12, 10, 37).getTime();
const P = { requestId: 'abcde', tool: 'Bash', description: 'list', inputPreview: '{"command":"ls"}', openedAt: T0, relayedAt: T0, expiresAt: T0 + PERMISSION_TTL_MS, state: 'open', canAllow: true, denyOnly: [] };

test('a request the server closed as answered elsewhere is a closed card with no buttons, whatever the device', () => {
  const v = permissionView({ ...P, state: 'elsewhere', closedAt: T0 + 5000 }, T0 + 6000, { approver: true, approvals: { mode: 'on', denyOnlyUntil: null } });
  assert.equal(v.view, 'closed');
  assert.equal(v.state, 'elsewhere');
  assert.equal(v.canAllow, false);
  // Past its 10 minutes it is still "elsewhere", never "expired": the server said what became of it.
  assert.equal(permissionView({ ...P, state: 'elsewhere', closedAt: T0 + 5000 }, T0 + PERMISSION_TTL_MS + 1).view, 'closed');
  assert.equal(sentLine({ state: 'elsewhere', closedAt: T0 + 5000 }), 'Jarvis moved on at 10:37: this was answered in Claude Code or Discord, or is no longer asked. Nothing was sent from here.');
  assert.equal(sentLine({ state: 'elsewhere' }), 'Jarvis moved on: this was answered in Claude Code or Discord, or is no longer asked. Nothing was sent from here.');
  assert.equal(sentLine({ state: 'denied', answeredBy: 'Mac', answeredAt: T0 }), 'Deny sent from Mac at 10:37. Claude Code uses it if the prompt was still open.', 'an answer from here reads as before');
});

test('a card closed elsewhere goes by itself after a minute; an answer sent from here stays ten; open, timed-out and terminal cards never go by themselves', () => {
  assert.equal(ELSEWHERE_CARD_MS, 60e3);
  assert.equal(CLOSED_CARD_MS, 10 * 60e3);
  const elsewhere = at => permissionView({ ...P, state: 'elsewhere', closedAt: T0 + 5000 }, at);
  assert.equal(cardGone(elsewhere(T0 + 5000 + ELSEWHERE_CARD_MS - 1), T0 + 5000 + ELSEWHERE_CARD_MS - 1), false);
  assert.equal(cardGone(elsewhere(T0 + 5000 + ELSEWHERE_CARD_MS), T0 + 5000 + ELSEWHERE_CARD_MS), true);
  // With no closedAt (an older server), from when it opened.
  assert.equal(cardGone(permissionView({ ...P, state: 'elsewhere' }, T0), T0 + ELSEWHERE_CARD_MS), true);
  const denied = permissionView({ ...P, state: 'denied', answeredAt: T0 + 1000 }, T0);
  assert.equal(cardGone(denied, T0 + 1000 + ELSEWHERE_CARD_MS), false, 'what was sent from here stays to be read');
  assert.equal(cardGone(denied, T0 + 1000 + CLOSED_CARD_MS - 1), false);
  assert.equal(cardGone(denied, T0 + 1000 + CLOSED_CARD_MS), true);
  for (const state of ['open', 'expired', 'late', 'repeat']) {
    assert.equal(cardGone(permissionView({ ...P, state }, T0), T0 + 24 * 3600e3), false, state);
  }
  assert.equal(cardGone(null, T0), false);
});

test('a dismissed card stays gone when a new stream sends it again, unless it is open', () => {
  const dismissed = new Set(['abcde']);
  assert.equal(keepCard({ ...P, state: 'expired' }, dismissed), false, 'the hourly replay of a timed-out request');
  assert.equal(keepCard({ ...P, state: 'elsewhere' }, dismissed), false);
  assert.equal(keepCard({ ...P, state: 'open' }, dismissed), true, 'an open request has no Dismiss: always shown');
  assert.equal(keepCard({ ...P, requestId: 'fghij', state: 'expired' }, dismissed), true);
  assert.equal(keepCard({ ...P, state: 'expired' }, new Set()), true);
  assert.equal(keepCard({ ...P, state: 'expired' }, null), true);
  assert.equal(keepCard({ state: 'open' }, dismissed), false, 'no id, no card');
  assert.equal(keepCard(null, dismissed), false);
});

// Ultron's parity L7 (11-12): the dismissed ids were never forgotten.
test('dismissed ids are kept two hours and at most DISMISSED_MAX, the oldest going first; keepCard reads the Map', () => {
  assert.equal(DISMISSED_KEEP_MS, 2 * 3600e3);
  let d = rememberDismissed(new Map(), 'abcde', T0);
  assert.equal(keepCard({ ...P, state: 'expired' }, d), false, 'a Map works as the set did');
  d = rememberDismissed(d, 'fghij', T0 + DISMISSED_KEEP_MS - 1);
  assert.deepEqual([...d.keys()], ['abcde', 'fghij'], 'still within its two hours');
  d = rememberDismissed(d, 'klmno', T0 + DISMISSED_KEEP_MS);
  assert.deepEqual([...d.keys()], ['fghij', 'klmno'], 'two hours on, the first is forgotten');
  assert.equal(keepCard({ ...P, state: 'expired' }, d), true, 'and its card may show again');
  // Dismissed again: moved to the newest, with its new time.
  d = rememberDismissed(d, 'fghij', T0 + DISMISSED_KEEP_MS + 5);
  assert.deepEqual([...d.entries()], [['klmno', T0 + DISMISSED_KEEP_MS], ['fghij', T0 + DISMISSED_KEEP_MS + 5]]);
  // The cap.
  let big = new Map();
  for (let i = 0; i < DISMISSED_MAX + 3; i++) big = rememberDismissed(big, `id${i}`, T0 + i);
  assert.equal(big.size, DISMISSED_MAX);
  assert.equal([...big.keys()][0], 'id3', 'the oldest three went');
  assert.equal(big.has(`id${DISMISSED_MAX + 2}`), true);
  // A bad time or a missing list is forgotten, never thrown on.
  assert.deepEqual([...rememberDismissed(new Map([['x', NaN]]), 'y', T0).keys()], ['y']);
  assert.deepEqual([...rememberDismissed(null, 'y', T0).keys()], ['y']);
});

test('a card closed elsewhere is not "waiting on you", and a status that counts no open request leaves it for its minute', () => {
  const map = upsertPermission(new Map(), { ...P, state: 'elsewhere', closedAt: T0 + 5000 });
  assert.equal(effectiveStatus({ state: 'waiting on you', channelConnected: true }, map, T0 + 6000).state, 'online');
  assert.equal(withStatus(map, { openPermissions: 0 }, T0 + 6000), map, 'only cards still shown as open are dropped');
});

test('parity: the page offers what the server says; with the status naming parity and no window, a Bash card from an approver has Allow', () => {
  const parity = { mode: 'on', relay: 'allow', rules: 'parity', denyOnlyUntil: null };
  const v = permissionView(P, T0 + 1000, { approver: true, approvals: parity });
  assert.deepEqual([v.view, v.canAllow, v.denyOnly], ['open', true, []]);
  assert.equal(permissionView(P, T0 + 1000, { approver: false, approvals: parity }).canAllow, false, 'still an approver device only');
  const hidden = permissionView({ ...P, canAllow: false, denyOnly: ['it carries invisible or direction characters'] }, T0 + 1000, { approver: true, approvals: parity });
  assert.deepEqual([hidden.canAllow, hidden.denyOnly], [false, ['it carries invisible or direction characters']]);
  assert.equal(DENY_ONLY_LEAD, 'This page can only deny this one. To allow it, answer in Claude Code or in Discord.');
});

test('a card the server would let be allowed, on a device with no approver mark, says so as its reason; a card with reasons of its own keeps only those', async () => {
  const { NOT_APPROVER } = await import('../src/lib/orbit/chat.js');
  const on = { mode: 'on', relay: 'allow', denyOnlyUntil: null };
  const v = permissionView(P, T0 + 1000, { approver: false, approvals: on });
  assert.deepEqual([v.canAllow, v.denyOnly], [false, [NOT_APPROVER]]);
  assert.deepEqual(permissionView(P, T0 + 1000, { approver: true, approvals: on }).denyOnly, [], 'an approver device has no such reason');
  const own = permissionView({ ...P, canAllow: false, denyOnly: ['it carries invisible or direction characters'] }, T0 + 1000, { approver: false, approvals: on });
  assert.deepEqual(own.denyOnly, ['it carries invisible or direction characters'], 'the request\'s own reason is the one that matters');
  assert.deepEqual(permissionView(P, T0 + 1000, { approver: false, approvals: { mode: 'deny', denyOnlyUntil: null } }).denyOnly, ['approvals are Deny only for now']);
});
