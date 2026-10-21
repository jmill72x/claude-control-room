// The Orbit page's board logic (src/lib/orbit/board.js). Run with `npm test` in
// web/ (node --test, no install). Every item here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstSentence, cardTitle, cardDetail, joinTitleDetail, editFields, applyEdit, newItem, withPriority, withDue,
  areaOptions, ownerOf, agentOf, boardTotals, ownerChips, boardView, priorityFilters, moves, dueLook, showingLine,
  IDEAS_SHOWN, DONE_SHOWN
} from '../src/lib/orbit/board.js';

const ROSTER = {
  agents: [{ key: 'chief', name: 'Chief' }, { key: 'builder', name: 'Builder' }, { key: 'writer', name: 'Writer' }, { key: 'scout', name: 'Scout' }],
  tagOwners: { Feature: 'builder', Bug: 'builder', Blog: 'writer', Planning: 'chief' }
};

// ---- titles ----

test('the fallback title is the first sentence, without its full stop', () => {
  assert.equal(firstSentence('Fix the login bug. The token expires early.'), 'Fix the login bug');
  assert.equal(firstSentence('Is it done? Check later'), 'Is it done?');
  assert.equal(firstSentence('Use the API (e.g. the export endpoint) to pull it. Then store it.'), 'Use the API (e.g. the export endpoint) to pull it');
  assert.equal(firstSentence('Bump the parser to v1.2 tonight'), 'Bump the parser to v1.2 tonight');
  assert.equal(firstSentence('A title line\nand the detail below it'), 'A title line');
  assert.equal(firstSentence('  Water the plants.  '), 'Water the plants');
});

test('a long first sentence is cut at a word boundary to 72 characters, with an ellipsis', () => {
  const long = 'Rebuild the import step so that it reads each source file once and keeps a cache of what it parsed. More.';
  const title = firstSentence(long);
  assert.equal(title, 'Rebuild the import step so that it reads each source file once and…');
  assert.ok(Array.from(title).length <= 72, title);
  assert.ok(title.endsWith('…'));
  assert.ok(long.startsWith(title.slice(0, -1)));
  assert.equal(title.at(-2) === ' ', false);
  const word = 'x'.repeat(100);
  assert.equal(firstSentence(word), `${'x'.repeat(71)}…`);
});

test('an item\'s own title wins over the fallback', () => {
  assert.deepEqual(cardTitle({ title: '  Renew the domain ', text: 'Something else entirely.' }), { text: 'Renew the domain', fallback: false });
  assert.deepEqual(cardTitle({ title: '', text: 'Fix it. Soon.' }), { text: 'Fix it', fallback: true });
});

test('the detail leaves off a leading repeat of the title, and only a repeat', () => {
  assert.equal(cardDetail({ text: 'Fix the login bug. The token expires early.' }), 'The token expires early.');
  assert.equal(cardDetail({ text: 'Water the plants.' }), '');
  assert.equal(cardDetail({ title: 'Renew the domain', text: 'Renew the domain: the registrar emails bounce' }), 'the registrar emails bounce');
  assert.equal(cardDetail({ title: 'Renew the domain', text: 'Renew the domain before it lapses' }), 'Renew the domain before it lapses');
  assert.equal(cardDetail({ title: 'Short label', text: 'The whole story, told differently.' }), 'The whole story, told differently.');
});

// ---- editing ----

test('Edit text in an item whose text repeats its title: Detail is the rest, and a new title goes back in front', () => {
  const item = { id: 1, title: 'Renew the domain', text: 'Renew the domain. Pay by Friday.', tag: 'Ops', lane: 'idea' };
  assert.deepEqual(editFields(item), { title: 'Renew the domain', detail: 'Pay by Friday.', tag: 'Ops', repeat: true });
  const next = applyEdit(item, { title: 'Renew both domains', detail: 'Pay by Friday.', tag: 'Ops' });
  assert.deepEqual(next, { id: 1, text: 'Renew both domains. Pay by Friday.', tag: 'Ops', lane: 'idea', title: 'Renew both domains' });
});

test('a new area alone leaves the text exactly as it is on disk', () => {
  const item = { id: 2, title: 'Renew the domain', text: 'Renew the domain:   pay by Friday', tag: 'Ops', lane: 'idea' };
  const next = applyEdit(item, { ...editFields(item), tag: 'Blog' });
  assert.equal(next.text, item.text);
  assert.equal(next.tag, 'Blog');
  assert.equal(next.title, 'Renew the domain');
});

test('Edit text in an item whose text does not repeat its title: Detail is the whole text', () => {
  const item = { id: 3, title: 'Short label', text: 'The long version of the item.', tag: 'Ops', lane: 'doing' };
  assert.equal(editFields(item).detail, 'The long version of the item.');
  const next = applyEdit(item, { title: 'Short label', detail: 'A rewritten long version.', tag: 'Ops' });
  assert.equal(next.text, 'A rewritten long version.');
  assert.equal(next.title, 'Short label');
  const untitled = applyEdit(item, { title: '', detail: 'The long version of the item.', tag: 'Ops' });
  assert.equal('title' in untitled, false);
  assert.equal(untitled.text, 'The long version of the item.');
});

test('an item with no title of its own: an untouched form saves nothing, and a typed title is added', () => {
  const item = { id: 4, text: 'Fix the login bug. The token expires early.', tag: 'Bug', lane: 'idea' };
  const start = editFields(item);
  assert.equal(start.title, '');
  assert.equal(start.detail, item.text);
  assert.equal(applyEdit(item, start), null);
  const titled = applyEdit(item, { ...start, title: 'Login bug' });
  assert.equal(titled.title, 'Login bug');
  assert.equal(titled.text, item.text);
});

test('blanking every field never erases an item, and a title is cut to 120 characters', () => {
  const item = { id: 5, title: 'T', text: 'T. More.', tag: 'Ops', lane: 'idea' };
  assert.equal(applyEdit(item, { title: '', detail: '', tag: 'Ops' }), null);
  const long = applyEdit(item, { title: 'y'.repeat(130), detail: 'More.', tag: 'Ops' });
  assert.equal(long.title.length, 120);
});

test('a new item from the form: the title, and text made of the title and the detail', () => {
  assert.deepEqual(newItem({ title: ' Plan the launch ', detail: 'Pick a date first', tag: 'Planning', priority: 'P2', due: '2026-11-02', lane: 'idea' }, 'id-1'),
    { id: 'id-1', text: 'Plan the launch. Pick a date first', title: 'Plan the launch', lane: 'idea', tag: 'Planning', priority: 'P2', due: '2026-11-02' });
  assert.deepEqual(newItem({ title: 'Ship it!', detail: '', tag: 'Ops', priority: 'none', due: '', lane: 'doing' }, 'id-2'),
    { id: 'id-2', text: 'Ship it!', title: 'Ship it!', lane: 'doing', tag: 'Ops' });
  assert.equal(newItem({ title: '   ', detail: 'x', tag: 'Ops', lane: 'idea' }, 'id-3'), null);
  assert.equal(joinTitleDetail('Done?', 'Yes'), 'Done? Yes');
});

test('priority and due are written only when set, and cleared by dropping the key', () => {
  assert.deepEqual(withPriority({ id: 1, priority: 'P2' }, 'P0'), { id: 1, priority: 'P0' });
  assert.deepEqual(withPriority({ id: 1, priority: 'P2' }, 'none'), { id: 1 });
  assert.deepEqual(withDue({ id: 1, due: '2026-11-02' }, ''), { id: 1 });
  assert.deepEqual(withDue({ id: 1 }, '2026-11-03'), { id: 1, due: '2026-11-03' });
});

test('the Area choices are the tags in use, most used first, and keep a rare tag on its item', () => {
  const items = [{ tag: 'Ops' }, { tag: 'Blog' }, { tag: 'Ops' }, { tag: 'ops' }, { tag: '' }, {}];
  assert.deepEqual(areaOptions(items), ['Ops', 'Blog']);
  assert.deepEqual(areaOptions(items, 'Docs'), ['Ops', 'Blog', 'Docs']);
});

// ---- owners ----

test('the owner is the item\'s own, else its tag\'s agent, else nobody', () => {
  assert.equal(ownerOf({ tag: 'Bug', owner: 'writer' }, ROSTER), 'writer');
  assert.equal(ownerOf({ tag: 'bug' }, ROSTER), 'builder');
  assert.equal(ownerOf({ tag: 'Docs' }, ROSTER), null);
  assert.equal(ownerOf({}, ROSTER), null);
  assert.deepEqual(agentOf('builder', ROSTER), { key: 'builder', name: 'Builder', index: 1 });
  assert.deepEqual(agentOf('stranger', ROSTER), { key: 'stranger', name: 'stranger', index: -1 });
  assert.equal(agentOf(null, ROSTER), null);
});

// ---- the band and the lanes ----

const ITEMS = [
  { id: 'i1', text: 'Idea one', lane: 'idea', tag: 'Feature', priority: 'P2' },
  { id: 'i2', text: 'Idea two', lane: 'idea', tag: 'Blog', priority: 'P1', due: '2026-11-05' },
  { id: 'i3', text: 'Idea three', lane: 'idea', tag: 'Docs' },
  { id: 'i4', text: 'Idea four', lane: 'idea', tag: 'Bug', priority: 'P0' },
  { id: 'i5', text: 'Idea five', lane: 'idea', tag: 'Feature', priority: 'P2', due: '2026-11-01' },
  { id: 'd1', text: 'Doing one', lane: 'doing', tag: 'Planning', priority: 'P3' },
  { id: 'x1', text: 'Done long ago', lane: 'done', tag: 'Feature' },
  { id: 'x2', text: 'Done Monday', lane: 'done', tag: 'Blog', doneAt: '2026-10-19T14:00:00.000Z' },
  { id: 'x3', text: 'Done later, no stamp', lane: 'done', tag: 'Bug' },
  { id: 'x4', text: 'Done Tuesday', lane: 'done', tag: 'Feature', doneAt: '2026-10-20T09:00:00.000Z' }
];

test('the band counts open items by priority, P0 and none included, and doing and done', () => {
  assert.deepEqual(boardTotals(ITEMS), { open: 6, doing: 1, done: 4, byPriority: { P0: 1, P1: 1, P2: 2, P3: 1, none: 1 } });
});

test('owner chips: agents with open items only, the most first, ties in roster order', () => {
  assert.deepEqual(ownerChips(ITEMS, ROSTER).map(c => [c.key, c.open]), [['builder', 3], ['chief', 1], ['writer', 1]]);
});

test('sorted by priority: P0 first and no priority last, then by due date, then as added', () => {
  const v = boardView(ITEMS, { roster: ROSTER });
  assert.deepEqual(v.ideas.shown.map(t => t.id), ['i4', 'i2', 'i5', 'i1', 'i3']);
  assert.equal(v.ideas.shown[0].order, undefined, 'the sort key is not left on the items');
});

test('sorted by due date: the soonest first, then the undated by priority', () => {
  assert.deepEqual(boardView(ITEMS, { sort: 'due', roster: ROSTER }).ideas.shown.map(t => t.id), ['i5', 'i2', 'i4', 'i1', 'i3']);
});

test('Done: stamped items newest first, then the unstamped, the newest added first', () => {
  assert.deepEqual(boardView(ITEMS, { roster: ROSTER }).done.shown.map(t => t.id), ['x4', 'x2', 'x3', 'x1']);
});

test('Ideas show the top 8 until all are asked for; Done shows 8 and counts the rest', () => {
  const many = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, text: `Idea ${i}`, lane: 'idea', priority: 'P2' })),
    ...Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, text: `Done ${i}`, lane: 'done', doneAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }))
  ];
  const v = boardView(many);
  assert.equal(v.ideas.shown.length, IDEAS_SHOWN);
  assert.equal(v.ideas.total, 11);
  assert.equal(v.ideas.more, true);
  assert.equal(boardView(many, { ideasAll: true }).ideas.shown.length, 11);
  assert.equal(v.done.shown.length, DONE_SHOWN);
  assert.equal(v.done.older, 4);
  assert.equal(v.done.shown[0].id, 'x11');
});

test('the owner and priority filters, None included, and the showing line', () => {
  const byOwner = boardView(ITEMS, { owner: 'builder', roster: ROSTER });
  assert.deepEqual(byOwner.ideas.shown.map(t => t.id), ['i4', 'i5', 'i1']);
  assert.deepEqual(byOwner.done.shown.map(t => t.id), ['x4', 'x3', 'x1']);
  assert.deepEqual(byOwner.showing, { open: 3, total: 6, filtered: true });
  assert.deepEqual(boardView(ITEMS, { priority: 'none', roster: ROSTER }).ideas.shown.map(t => t.id), ['i3']);
  assert.deepEqual(boardView(ITEMS, { priority: 'P2', roster: ROSTER }).ideas.shown.map(t => t.id), ['i5', 'i1']);
  assert.equal(showingLine(byOwner.showing), 'Showing 3 of 6 open items, plus the done ones that match.');
  assert.equal(showingLine(boardView(ITEMS).showing), 'All 6 open items.');
});

test('the priority filter offers P0 and None only when an open item has one', () => {
  assert.deepEqual(priorityFilters(ITEMS).map(p => p.label), ['All', 'P0', 'P1', 'P2', 'P3', 'None']);
  assert.deepEqual(priorityFilters([{ lane: 'idea', priority: 'P1' }, { lane: 'done' }]).map(p => p.label), ['All', 'P1', 'P2', 'P3']);
});

test('the move buttons follow the lane', () => {
  assert.deepEqual(moves('idea').map(m => [m.label, m.to, m.main]), [['Start it', 'doing', true], ['Mark done', 'done', false]]);
  assert.deepEqual(moves('doing').map(m => [m.label, m.to]), [['Mark done', 'done'], ['Back to ideas', 'idea']]);
  assert.deepEqual(moves('done').map(m => [m.label, m.to]), [['Reopen', 'idea']]);
});

test('due chips keep today\'s rules', () => {
  const today = '2026-10-21';
  assert.deepEqual(dueLook({ due: '2026-10-19', lane: 'idea' }, today), { label: 'Overdue Mon 10-19', tone: 'overdue', title: 'Due Mon 2026-10-19' });
  assert.equal(dueLook({ due: '2026-10-21', lane: 'idea' }, today).label, 'Due today');
  assert.equal(dueLook({ due: '2026-10-23', lane: 'doing' }, today).tone, 'soon');
  assert.equal(dueLook({ due: '2026-11-23', lane: 'idea' }, today).tone, 'later');
  assert.equal(dueLook({ due: '2026-10-19', lane: 'done' }, today).tone, 'done');
  assert.equal(dueLook({ lane: 'idea' }, today), null);
});
