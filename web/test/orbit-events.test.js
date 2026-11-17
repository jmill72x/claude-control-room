// Events on the Chat tab (server lib/events.mjs): a notice line of plain text, the
// kill switch's note, a reply to an event answering nothing of the owner's, and the
// quote's header. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventLine, quoteWho, tickFor } from '../src/lib/orbit/chat.js';

const T0 = new Date(2026, 10, 11, 9, 14).getTime();
const msg = (seq, from, kind, text, extra = {}) => ({ seq, id: `m_${seq}abcdef`, at: T0 + seq * 1000, from, kind, text, replyTo: null, attachments: [], state: from === 'jeff' ? 'delivered' : null, ...extra });

test('an event\'s line is its text, as text: markup stays characters, whitespace folds', () => {
  const html = '<img src=x onerror=alert(1)> Job <b>x</b>\n failed';
  assert.deepEqual(eventLine(msg(1, 'system', 'event', html)), { text: '<img src=x onerror=alert(1)> Job <b>x</b> failed', off: false, note: null });
  assert.deepEqual(eventLine(msg(2, 'system', 'event', '', { state: 'off' })), { text: 'An event', off: true, note: 'Not sent to Jarvis: events were off' });
  assert.deepEqual(eventLine(msg(3, 'system', 'event', 'x', { state: 'undelivered' })), { text: 'x', off: false, note: 'Not delivered to Jarvis' });
});

test('the Chat tab renders events as text children, never as HTML', () => {
  const src = readFileSync(new URL('../src/orbit/Chat.jsx', import.meta.url), 'utf8');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/.test(src), 'no HTML sinks anywhere in the tab');
  // The row also carries its id (data-mid, the target of a search jump) and the jump's mark.
  assert.match(src, /if \(m\.kind === 'event'\) \{\s*const ev = eventLine\(m\);\s*return <li data-mid=\{mid\} className=\{`o-chat-notice o-chat-event\$\{foundClass\}`\}><span>\{ev\.text\}<\/span>/);
  // The search sheet shows snippets (raw text cut anywhere) the same way: text children only.
  const search = readFileSync(new URL('../src/orbit/ChatSearch.jsx', import.meta.url), 'utf8');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|<Markdown|Markdown\.jsx/.test(search), 'no HTML sink and no Markdown in the search sheet');
});

test('a reply of the lead\'s to an event does not mark the owner\'s message answered; a reply to the owner does', () => {
  const q = msg(1, 'jeff', 'chat', 'are you there?');
  const ev = msg(2, 'system', 'event', 'Job a launchd job failed at 09:14');
  const toEvent = msg(3, 'jarvis', 'chat', 'looking', { replyTo: ev.id });
  assert.equal(tickFor(q, [q, ev, toEvent]), 'delivered');
  assert.equal(tickFor(q, [q, ev, toEvent, msg(4, 'jarvis', 'chat', 'yes')]), 'answered');
  assert.equal(tickFor(ev, [q, ev]), null, 'an event has no tick');
});

test('a quote names who it is from', () => {
  assert.equal(quoteWho(null), 'Reply');
  assert.equal(quoteWho({ from: 'jeff', kind: 'chat' }), 'You');
  assert.equal(quoteWho({ from: 'system', kind: 'event' }), 'Event');
  assert.equal(quoteWho({ from: 'jarvis', kind: 'chat' }), 'Jarvis');
});
