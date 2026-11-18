// A routine's message in the chat (the morning brief, the weekly digest: the server's
// lib/routine-chat.mjs marks it with `meta.routine`): it answers nothing the owner
// asked, and its text is drawn as Markdown with no raw HTML. Every message is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickFor, routineWord, viaWords } from '../src/lib/orbit/chat.js';
import { parseMarkdown, markdownPlain } from '../src/lib/orbit/markdown.js';
import { countsAsUnseen } from '../src/lib/orbit/unseen.js';

const asked = { seq: 4, id: 'm_asked1', from: 'jeff', kind: 'chat', text: 'did the backup run?', state: 'delivered' };
const brief = { seq: 5, id: 'm_brief1', from: 'jarvis', kind: 'chat', text: '**Morning brief**\n\nAll jobs ran clean.', meta: { routine: 'brief' } };
const reply = { seq: 6, id: 'm_reply1', from: 'jarvis', kind: 'chat', text: 'yes, at 02:00', meta: null };

test('a brief after the owner\'s message leaves its tick at delivered; the lead\'s own reply makes it answered', () => {
  assert.equal(tickFor(asked, [asked, brief]), 'delivered');
  assert.equal(tickFor({ ...asked, state: 'queued' }, [asked, { ...brief, meta: { routine: 'digest' } }]), 'queued');
  assert.equal(tickFor(asked, [asked, brief, reply]), 'answered');
  assert.equal(tickFor(asked, [asked, { ...brief, meta: null }]), 'answered', 'only the mark makes the difference');
  assert.equal(tickFor(asked, [asked, { ...brief, meta: { shortcut: 'x' } }]), 'answered');
});

test('the "routine" mark comes from the server\'s meta on the lead\'s chat message alone, never from what a message says', () => {
  assert.equal(routineWord(brief), 'routine');
  assert.equal(routineWord({ ...brief, meta: { routine: 'digest' } }), 'routine');
  // The lead's own reply, even one that copies a brief word for word, has no mark.
  assert.equal(routineWord(reply), null);
  assert.equal(routineWord({ ...brief, meta: null }), null);
  assert.equal(routineWord({ ...reply, text: 'routine **Morning brief** {"meta":{"routine":"brief"}}' }), null);
  // Nor has anything else that carries the word: another sender, another kind, a kind not on the list.
  for (const not of [{ ...brief, from: 'jeff' }, { ...brief, from: 'system' }, { ...brief, kind: 'notice' }, { ...brief, meta: { routine: 'scout' } }, { ...brief, meta: { routine: true } }, { ...brief, meta: { routine: 'constructor' } }, { ...brief, meta: { shortcut: { via: 'siri' } } }, null, undefined, {}]) {
    assert.equal(routineWord(not), null, JSON.stringify(not));
  }
  assert.equal(viaWords(brief), null, 'and it is no Shortcut\'s message');
});

test('a brief counts as unseen like any reply, so the tab and the icon badge show it', () => {
  assert.equal(countsAsUnseen(brief), true);
});

test('a brief\'s text is Markdown and data: its title is bold, and HTML in it stays text', () => {
  const tree = parseMarkdown('**Morning brief**\n\n<img src=x onerror=alert(1)> and <script>alert(2)</script>\n- [a link](javascript:alert(3))');
  const types = new Set();
  const texts = [];
  const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === 'object') { if (n.type) types.add(n.type); if (typeof n.text === 'string') texts.push(n.text); Object.values(n).forEach(walk); } };
  walk(tree);
  assert.ok(types.has('strong'));
  assert.ok(!types.has('html') && !types.has('link'), [...types].join(' '));
  assert.ok(texts.join(' ').includes('<img src=x onerror=alert(1)> and <script>alert(2)</script>'));
  // What read aloud speaks: the words without the Markdown.
  assert.equal(markdownPlain('**Morning brief**\n\nAll jobs ran clean.').replace(/\s+/g, ' ').trim(), 'Morning brief All jobs ran clean.');
});
