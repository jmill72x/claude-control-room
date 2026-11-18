// A tag typed on the page (board 14a66582): the Orbit page's New item form has an
// "Other…" choice that takes a new tag, and the board refuses one that is too long or
// holds a control, invisible or direction character. The page checks by the server's
// rule before sending (web/src/lib/orbit/board.js, tagProblem), so these tests hold
// the two to one rule: the same limit, and the same characters, code point by code
// point. Every tag here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore, TAG_MAX, InvalidBoardError } from '../todos.mjs';
import { UNSAFE_CHARS } from '../lib/text.mjs';
import { TAG_MAX as PAGE_TAG_MAX, TAG_UNSAFE, tagProblem, newItem } from '../../web/src/lib/orbit/board.js';

const scratch = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'board-tag-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return createTodoStore(join(dir, 'todos.json'));
};
const item = tag => ({ id: 'a1', text: 'Something to do', lane: 'idea', tag });
const cp = c => String.fromCodePoint(c);

test('the page and the server share one limit and one set of refused characters', () => {
  assert.equal(TAG_MAX, 40);
  assert.equal(PAGE_TAG_MAX, TAG_MAX);
  assert.equal(TAG_UNSAFE.flags, UNSAFE_CHARS.flags);
  const differ = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const ch = cp(c);
    if (TAG_UNSAFE.test(ch) !== UNSAFE_CHARS.test(ch)) differ.push(c.toString(16));
  }
  assert.deepEqual(differ, [], 'no code point is refused by one and taken by the other');
});

test('the board refuses a tag over the limit or with a refused character, and says why', async t => {
  const store = await scratch(t);
  for (const [tag, why] of [
    ['x'.repeat(TAG_MAX + 1), /tag must be at most 40 characters/],
    [`${'x'.repeat(TAG_MAX)}y`, /at most 40/],
    [`Pi${cp(0x0a)}`, /tag must not hold control characters/],
    [`a${cp(0x09)}b`, /control characters/],
    [`Ops${cp(0x202e)}`, /direction/],
    [`Ops${cp(0x200b)}`, /invisible/],
    [`${cp(0xfeff)}Ops`, /invisible/],
    [`Ops${cp(0x85)}`, /control/]
  ]) {
    await assert.rejects(store.write([item(tag)]), err => err instanceof InvalidBoardError && why.test(err.message), JSON.stringify(tag));
    assert.ok(tagProblem(tag), `the page refuses ${JSON.stringify(tag)} too`);
  }
});

test('the board takes a tag at the limit, counted in characters once trimmed', async t => {
  const store = await scratch(t);
  const astral = cp(0x1f680).repeat(TAG_MAX);
  for (const tag of ['Pi', 'Fantasy football', 'x'.repeat(TAG_MAX), `  ${'x'.repeat(TAG_MAX)}  `, astral, 'Área · ops', '', undefined]) {
    const todos = await store.write([item(tag)]);
    assert.equal(todos.length, 1, JSON.stringify(tag));
    if (tag) assert.equal(tagProblem(tag), null, `the page takes ${JSON.stringify(tag)} too`);
  }
  assert.equal(astral.length, 2 * TAG_MAX, 'eighty UTF-16 units, forty characters');
});

test('an item made by the form with a typed tag is one the board takes', async t => {
  const store = await scratch(t);
  const made = newItem({ title: 'Try the new area', detail: '', tag: '  Garden  ', priority: 'P2', due: '', lane: 'idea' }, 'n1');
  assert.equal(made.tag, 'Garden');
  const todos = await store.write([made]);
  assert.equal(todos[0].tag, 'Garden');
});
