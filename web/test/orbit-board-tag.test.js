// A new tag typed in the New item form's "Other…" choice (board 14a66582): why one
// can't be used, and which tag in use a typed one would join. That the page's rule is
// the server's, character by character, is checked in
// server/test/board-new-tag.test.mjs. Every tag here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_MAX, tagProblem, existingTag, newItem } from '../src/lib/orbit/board.js';

const cp = c => String.fromCodePoint(c);

test('tagProblem: a name is needed, of at most TAG_MAX characters once trimmed', () => {
  assert.equal(TAG_MAX, 40);
  for (const empty of ['', '   ', null, undefined]) assert.equal(tagProblem(empty), 'Type a name for the new area.', String(empty));
  assert.equal(tagProblem('Garden'), null);
  assert.equal(tagProblem('x'.repeat(TAG_MAX)), null);
  assert.equal(tagProblem(`   ${'x'.repeat(TAG_MAX)}   `), null, 'the spaces around it are not counted');
  assert.equal(tagProblem(cp(0x1f331).repeat(TAG_MAX)), null, 'characters, not UTF-16 units');
  assert.equal(tagProblem('x'.repeat(TAG_MAX + 1)), 'At most 40 characters.');
  assert.equal(tagProblem(cp(0x1f331).repeat(TAG_MAX + 1)), 'At most 40 characters.');
});

test('tagProblem: no control, invisible or direction character, even at the ends', () => {
  const why = 'No control, invisible or direction characters.';
  for (const c of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x85, 0x9f, 0x61c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
    assert.equal(tagProblem(`Gar${cp(c)}den`), why, c.toString(16));
    assert.equal(tagProblem(`Garden${cp(c)}`), why, `${c.toString(16)} at the end`);
  }
  // Their neighbours are ordinary text.
  for (const c of [0x20, 0x7e, 0xa0, 0x61b, 0x200a, 0x2010, 0x2029 - 1, 0x202f, 0x2061, 0x206a, 0xfefe, 0xff01]) {
    assert.equal(tagProblem(`Gar${cp(c)}den`), null, c.toString(16));
  }
});

test('existingTag: a typed tag that matches one in use, whatever its case, joins it', () => {
  const items = [{ tag: 'Jarvis OS' }, { tag: ' Pi ' }, { tag: 7 }, {}, null];
  assert.equal(existingTag(items, 'jarvis os'), 'Jarvis OS');
  assert.equal(existingTag(items, '  JARVIS OS '), 'Jarvis OS');
  assert.equal(existingTag(items, 'pi'), 'Pi');
  assert.equal(existingTag(items, 'Garden'), null);
  assert.equal(existingTag(items, '   '), null);
  assert.equal(existingTag(null, 'Pi'), null);
});

test('newItem keeps a typed tag, trimmed', () => {
  const item = newItem({ title: 'Plant the beds', detail: '', tag: '  Garden ', priority: 'P2', due: '', lane: 'idea' }, 'x1');
  assert.equal(item.tag, 'Garden');
});
