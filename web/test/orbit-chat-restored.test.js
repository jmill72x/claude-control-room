// A card the server put back after a restart of the Control Room (board 88c1d4ec, Ultron's
// L6): marked while open, never gated harder, and the mark is not in the shown hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restoredLine, RESTORED_LINE, permissionView, shownInput } from '../src/lib/orbit/chat.js';

const T0 = 1794380000000;
const card = { requestId: 'abcde', tool: 'Read', description: 'read a file', inputPreview: '{"file_path":"/home/owner/a"}', relayedAt: T0, expiresAt: T0 + 3600e3, state: 'open', canAllow: true, denyOnly: [] };

test('restoredLine: the mark on an open card put back, and only there', () => {
  assert.equal(RESTORED_LINE, 'Came back after a Control Room restart: check the terminal.');
  const open = permissionView({ ...card, restored: true }, T0 + 1000, { approver: true, approvals: { mode: 'on', denyOnlyUntil: null } });
  assert.equal(restoredLine(open), RESTORED_LINE);
  assert.equal(open.canAllow, true, 'a mark, not a gate: Allow is offered as for any card');
  assert.equal(restoredLine(permissionView(card, T0 + 1000, { approver: true, approvals: { mode: 'on' } })), null, 'a new card');
  for (const state of ['allowed', 'denied', 'elsewhere', 'repeat']) assert.equal(restoredLine(permissionView({ ...card, restored: true, state }, T0 + 1000)), null, state);
  assert.equal(restoredLine(permissionView({ ...card, restored: true }, T0 + 7200e3)), null, 'its window over');
  assert.equal(restoredLine({ ...card, view: 'open', restored: 'yes' }), null);
  assert.equal(restoredLine(null), null);
  assert.equal(shownInput({ ...card, restored: true }), shownInput(card), 'the hash a verdict carries is the same');
});

test('the card draws the mark (Chat.jsx)', () => {
  const src = readFileSync(new URL('../src/orbit/Chat.jsx', import.meta.url), 'utf8');
  assert.match(src, /\{restoredLine\(p\) && <p className="o-chat-card-hidden">\{restoredLine\(p\)\}<\/p>\}/);
});
