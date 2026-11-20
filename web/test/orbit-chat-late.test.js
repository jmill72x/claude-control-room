// Board 89248590 (2026-11-20): a message written at 12:10 reached the server at
// 15:38 and was read as new. The page now says when each send was written and
// whether it is a tap; an old bubble asks for Send now with its time; a message
// that arrived late says when it was written. Server side: server/test/chat-late.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBody, isStaleRefusal, unsentWords, writtenWords, writtenAt, STALE_SEND_MS } from '../src/lib/orbit/chat.js';
import { hasUnsent } from '../src/lib/orbit/build.js';
import { clock } from '../src/lib/orbit/page.js';

const HOUR = 3600e3;

test('sendBody: the first attempt says when it was written and is no tap; Retry and Send now say confirmed', () => {
  const pending = { clientId: 'p_x_abcdef', text: 'hi', replyTo: null, at: 1794380000000, attachmentIds: ['a'.repeat(32)], files: [{}], failed: true };
  assert.deepEqual(sendBody(pending), { clientId: 'p_x_abcdef', text: 'hi', replyTo: null, attachmentIds: ['a'.repeat(32)], composedAt: 1794380000000, confirmed: false });
  assert.equal(sendBody(pending, { confirmed: true }).confirmed, true);
  assert.equal(sendBody({ ...pending, at: 'soon' }).composedAt, null);
  assert.deepEqual(sendBody({ clientId: 'c', text: 't' }).attachmentIds, []);
  assert.ok(!('files' in sendBody(pending)), 'only the fields the route reads');
});

test('isStaleRefusal: only the server\'s 409 with stale set', () => {
  assert.equal(isStaleRefusal({ status: 409, body: { stale: true } }), true);
  assert.equal(isStaleRefusal({ status: 409, body: { changed: true } }), false);
  assert.equal(isStaleRefusal({ status: 400, body: { stale: true } }), false);
  assert.equal(isStaleRefusal(new Error('Load failed')), false);
  assert.equal(isStaleRefusal(null), false);
});

test('unsentWords: a fresh failure offers Retry; one held as stale, or older than the window, says when it was written and offers Send now', () => {
  const now = new Date(2026, 10, 20, 15, 38).getTime();
  const fresh = { at: now - 60e3, failed: true, error: 'Load failed' };
  assert.deepEqual(unsentWords(fresh, now), { line: 'Not sent: Load failed', action: 'Retry' });
  assert.deepEqual(unsentWords({ ...fresh, error: null }, now), { line: 'Not sent', action: 'Retry' });
  const held = { at: now - 3 * HOUR - 28 * 60e3, failed: true, stale: true, error: null };
  assert.deepEqual(unsentWords(held, now), { line: `Written ${clock(held.at)}, not sent: it reached the server only now`, action: 'Send now' });
  // Failed hours ago and never retried: the same question, with its own reason.
  const old = { at: now - STALE_SEND_MS - 1, failed: true, error: 'Load failed' };
  assert.deepEqual(unsentWords(old, now), { line: `Written ${clock(old.at)}, not sent: Load failed`, action: 'Send now' });
  assert.equal(unsentWords({ at: now - STALE_SEND_MS, failed: true }, now).action, 'Retry', 'the window itself is still recent');
  // A stale answer even inside the window (the device clock is behind the server's).
  assert.equal(unsentWords({ at: now - 1000, failed: true, stale: true }, now).action, 'Send now');
});

test('writtenWords: only a message stored late says when it was written, with the day when that differs', () => {
  const at = new Date(2026, 10, 20, 15, 38).getTime();
  assert.equal(writtenWords({ at, meta: { composedAt: at - 3 * HOUR } }), `written ${clock(at - 3 * HOUR)}`);
  assert.equal(writtenWords({ at, meta: { composedAt: at - 60e3 } }), null, 'inside the window: nothing to say');
  assert.equal(writtenWords({ at, meta: null }), null);
  assert.equal(writtenWords({ at, meta: { composedAt: '12:10' } }), null);
  const dayBefore = new Date(2026, 10, 19, 23, 50).getTime();
  assert.equal(writtenWords({ at, meta: { composedAt: dayBefore } }), `written Thu ${clock(dayBefore)}`);
  assert.equal(writtenAt(at - HOUR, at), clock(at - HOUR));
});

test('a held bubble still holds a reload: it has no seq and no id', () => {
  assert.equal(hasUnsent([{ clientId: 'p', seq: null, id: null, failed: true, stale: true }]), true);
});
