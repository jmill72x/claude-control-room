// Cards that live as long as the channel holds the request (board 94b380fd): the age
// line past two hours, the expired card's words for each way a request ends here, and
// the page's own expiry following the server's `expiresAt`, not 10 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageLine, expiredLine, permissionView, PERMISSION_TTL_MS } from '../src/lib/orbit/chat.js';

const T0 = Date.UTC(2026, 10, 13, 3, 0, 0);
const HOUR = 3600e3;
const P = { requestId: 'abcde', tool: 'Bash', description: 'list', inputPreview: '{"command":"ls"}', openedAt: T0, relayedAt: T0, state: 'open', canAllow: true, denyOnly: [] };

test('ageLine: seconds, then minutes, then whole hours from two hours on', () => {
  assert.equal(ageLine(0), '0 s ago');
  assert.equal(ageLine(59), '59 s ago');
  assert.equal(ageLine(60), '1 min ago');
  assert.equal(ageLine(119 * 60 + 59), '119 min ago');
  assert.equal(ageLine(120 * 60), '2 h ago');
  assert.equal(ageLine(11 * 3600 + 3599), '11 h ago');
  assert.equal(ageLine(-5), '0 s ago');
  assert.equal(ageLine(undefined), '0 s ago');
});

test('permissionView: a card with a 12-hour expiresAt is open after 11 hours and expired at 12', () => {
  const p = { ...P, expiresAt: T0 + 12 * HOUR };
  assert.equal(permissionView(p, T0 + 11 * HOUR, { approver: true }).view, 'open');
  assert.equal(permissionView(p, T0 + 12 * HOUR - 1, { approver: true }).view, 'open');
  assert.equal(permissionView(p, T0 + 12 * HOUR).view, 'expired');
  assert.equal(permissionView({ ...P }, T0 + PERMISSION_TTL_MS).view, 'expired', 'no expiresAt (an older server): 10 minutes');
});

test('expiredLine: the window it had, in minutes or hours; a channel that ended or a crowd says so instead', () => {
  assert.equal(expiredLine({ ...P, expiresAt: T0 + 10 * 60e3 }), 'This page could answer it for 10 minutes. If Jarvis is still waiting on it, answer in Claude Code or in Discord.');
  assert.equal(expiredLine({ ...P, expiresAt: T0 + 12 * HOUR, ended: 'timeout' }), 'This page could answer it for 12 hours. If Jarvis is still waiting on it, answer in Claude Code or in Discord.');
  assert.equal(expiredLine({ ...P, expiresAt: T0 + 90 * 60e3 }), 'This page could answer it for 90 minutes. If Jarvis is still waiting on it, answer in Claude Code or in Discord.');
  assert.equal(expiredLine({ ...P, expiresAt: T0 + 60e3 }), 'This page could answer it for 1 minute. If Jarvis is still waiting on it, answer in Claude Code or in Discord.');
  assert.equal(expiredLine({ ...P }), 'This page could answer it for 10 minutes. If Jarvis is still waiting on it, answer in Claude Code or in Discord.', 'no expiresAt: the old 10 minutes');
  assert.equal(expiredLine({ ...P, expiresAt: T0 }), 'This page could answer it for 10 minutes. If Jarvis is still waiting on it, answer in Claude Code or in Discord.', 'a zero window is not worded as 0 minutes');
  assert.equal(expiredLine({ ...P, expiresAt: T0 + 12 * HOUR, ended: 'channel' }), 'Jarvis\'s session or its channel ended, so this page can no longer answer it. If a prompt is still open, answer it in Claude Code.');
  assert.equal(expiredLine({ ...P, ended: 'crowded' }), 'Too many requests were waiting at once, so this page let the oldest go. If Jarvis is still waiting on it, answer in Claude Code or in Discord.');
  assert.equal(expiredLine(null), 'This page could answer it for 10 minutes. If Jarvis is still waiting on it, answer in Claude Code or in Discord.');
});

test('permissionView keeps the server\'s `ended` on an expired card', () => {
  const v = permissionView({ ...P, state: 'expired', ended: 'channel', expiresAt: T0 + 12 * HOUR }, T0 + 60e3);
  assert.equal(v.view, 'expired');
  assert.equal(v.ended, 'channel');
});
