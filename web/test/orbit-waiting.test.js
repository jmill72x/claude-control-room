// Waiting on you (src/lib/orbit/waiting.js) and Jeff's own items on Next 24
// hours. Dates are plain local dates and times are built from local parts, so
// the tests hold in any time zone. Every item, repo and agent is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waits, askTime, dueSoon, toPush, pushView, waitingCards, waitingView, youEvents, WAIT_SHOWN, DUE_SOON_DAYS
} from '../src/lib/orbit/waiting.js';
import { next24 } from '../src/lib/orbit/overview.js';

const TODAY = '2026-10-21'; // a Wednesday
const ROSTER = {
  agents: [{ key: 'juniper', name: 'Juniper Vale' }, { key: 'otis', name: 'Otis Fernwood' }, { key: 'mara', name: 'Mara Quill' }],
  tagOwners: { Planning: 'juniper', Feature: 'otis', Blog: 'mara' }
};
const ask = (kind = 'do', extra = {}) => ({ what: 'Pick one of the two venues.', why: 'The booking closes Friday.', kind, ...extra });
const item = (id, extra = {}) => ({ id, text: `Item ${id}. Its detail.`, lane: 'idea', tag: 'Planning', ...extra });

// ---- which items wait ----

test('an open item with an ask waits on you; a done one, or a malformed ask, does not', () => {
  assert.equal(waits(item('a', { ask: ask() })), true);
  assert.equal(waits(item('b', { ask: ask('decide'), lane: 'doing' })), true);
  assert.equal(waits(item('c', { ask: ask(), lane: 'done' })), false);
  assert.equal(waits(item('d')), false);
  assert.equal(waits(item('e', { ask: null })), false);
  assert.equal(waits(item('f', { ask: { what: '  ', kind: 'do' } })), false);
  assert.equal(waits(item('g', { ask: { what: 'x', kind: 'maybe' } })), false);
  assert.equal(waits(item('h', { ask: 'call the venue' })), false);
});

test("an ask's time reads as the clock does: 10 AM, 4:30 PM, 12:05 AM", () => {
  assert.equal(askTime('10:00'), '10 AM');
  assert.equal(askTime('16:30'), '4:30 PM');
  assert.equal(askTime('00:05'), '12:05 AM');
  assert.equal(askTime('12:00'), '12 PM');
  assert.equal(askTime('24:00'), null);
  assert.equal(askTime('9:00'), null);
  assert.equal(askTime(undefined), null);
});

// ---- Due soon ----

test('due soon is a date within 7 days or past: the weekday (and time), dark for today, tomorrow and overdue', () => {
  const soon = (due, time) => dueSoon({ due, ask: ask('do', time ? { time } : {}) }, TODAY);
  assert.deepEqual(soon('2026-10-18'), { chip: 'Overdue Sun 10-18', diff: -3, look: 'hot' });
  assert.deepEqual(soon('2026-10-21'), { chip: 'Today', diff: 0, look: 'hot' });
  assert.deepEqual(soon('2026-10-21', '16:30'), { chip: 'Today 4:30 PM', diff: 0, look: 'hot' });
  assert.deepEqual(soon('2026-10-22', '10:00'), { chip: 'Thu 10 AM', diff: 1, look: 'hot' });
  assert.deepEqual(soon('2026-10-23'), { chip: 'Fri', diff: 2, look: 'soon' });
  assert.deepEqual(soon('2026-10-28'), { chip: 'Next Wed', diff: DUE_SOON_DAYS, look: 'soon' });
  assert.equal(soon('2026-10-29'), null);
  assert.equal(soon(undefined), null);
  assert.equal(soon('next week'), null);
});

// ---- the cards ----

test('items split into Due soon and Decide or do, each in its order, with owner, title and what to do', () => {
  const items = [
    item('d1', { ask: ask('decide'), priority: 'P2' }),
    item('s1', { ask: ask('do', { time: '15:00' }), due: '2026-10-23', priority: 'P2', tag: 'Blog' }),
    item('d2', { ask: ask('do', { why: '' }), priority: 'P1', tag: 'Feature', title: 'Ship the fern page' }),
    item('x', { ask: ask(), lane: 'done', due: '2026-10-21' }),
    item('s2', { ask: ask('do', { time: '09:00' }), due: '2026-10-23', priority: 'P3' }),
    item('s3', { ask: ask('decide'), due: '2026-10-19', priority: 'P3', owner: 'mara' }),
    item('d3', { ask: ask('decide'), priority: 'P2', lane: 'doing' }),
    item('n', { priority: 'P0' }),
    item('d4', { ask: ask('do'), due: '2026-11-30' })
  ];
  const cards = waitingCards({ items, today: TODAY, roster: ROSTER, toPushEnv: undefined });
  assert.deepEqual(cards.due.map(c => [c.itemId, c.chip, c.look]), [
    ['s3', 'Overdue Mon 10-19', 'hot'],
    ['s2', 'Fri 9 AM', 'soon'],
    ['s1', 'Fri 3 PM', 'soon']
  ]);
  assert.deepEqual(cards.decide.map(c => [c.itemId, c.chip]), [['d2', 'Do'], ['d3', 'Decide'], ['d1', 'Decide'], ['d4', 'Do']]);
  const d2 = cards.decide[0];
  assert.equal(d2.title, 'Ship the fern page');
  assert.equal(d2.what, 'Pick one of the two venues.');
  assert.equal(d2.why, null);
  assert.equal(d2.owner.name, 'Otis Fernwood');
  assert.equal(d2.meta, 'P1 · Feature');
  assert.equal(d2.group, 'decide');
  assert.equal(cards.decide[3].title, 'Item d4', 'the first sentence when there is no title');
  assert.equal(cards.decide[3].meta, 'No priority · Planning');
  assert.equal(cards.due[0].owner.name, 'Mara Quill', "the item's own owner wins over its tag's");
  assert.equal(cards.due[1].owner.name, 'Juniper Vale');
});

// ---- To push ----

const repo = (name, extra = {}) => ({ name, owner: 'otis', state: 'ok', branch: 'main', detached: false, upstream: true, staged: 0, ahead: 0, behind: 0, partial: false, checkedAt: new Date(2026, 9, 21, 14, 5).getTime(), ...extra });
const env = (repos, extra = {}) => ({ data: { configured: true, repos }, status: 'ok', error: null, ...extra });

test('a repo counts when its branch has an upstream and something staged or ahead', () => {
  assert.equal(toPush(repo('a', { staged: 2 })), true);
  assert.equal(toPush(repo('b', { ahead: 1 })), true);
  assert.equal(toPush(repo('c')), false);
  assert.equal(toPush(repo('d', { staged: 3, upstream: false, ahead: null })), false);
  assert.equal(toPush(repo('e', { staged: 3, detached: true, upstream: false })), false);
  assert.equal(toPush(repo('f', { state: 'error', staged: 3 })), false);
});

test('push cards: Staged for staged work, Push for commits ahead, stating the facts without asking for the go', () => {
  const view = pushView(env([
    repo('tools', { ahead: 1 }),
    repo('garden-app', { staged: 12, partial: true }),
    repo('notes-site', { staged: 1, ahead: 2, behind: 3, owner: 'mara' }),
    repo('quiet')
  ]), ROSTER);
  assert.equal(view.known, true);
  assert.deepEqual(view.cards.map(c => [c.title, c.chip]), [
    ['garden-app: 12+ staged', 'Staged'],
    ['notes-site: 1 staged, 2 commits to push', 'Staged'],
    ['tools: 1 commit to push', 'Push']
  ]);
  assert.equal(view.cards[0].what, "The 12 staged files on main aren't committed yet. The commit waits for its status and diff stat, then your C&P.");
  assert.equal(view.cards[1].what, "The 1 staged file on main isn't committed yet, and it is already 2 commits ahead. The commit waits for its status and diff stat, then your C&P. It is also 3 commits behind, so it needs a pull first.");
  assert.ok(view.cards.every(c => !c.what.startsWith('Say C&P')), 'a card never asks for the go itself');
  assert.equal(view.cards[2].what, "Push main: 1 commit isn't on its upstream yet.");
  assert.equal(view.cards[0].meta, 'main · checked 2:05 PM');
  assert.equal(view.cards[1].owner.name, 'Mara Quill');
  assert.equal(view.cards[0].itemId, null, 'no board item to open');
  assert.deepEqual(view.notes, []);
});

test('the To push tile says what it could not count, and why', () => {
  const view = pushView(env([
    repo('lead-repo', { branch: 'build/v2', upstream: false, ahead: null, staged: 4 }),
    repo('odd', { branch: null, detached: true, upstream: false }),
    { name: 'broken', owner: null, state: 'error', why: 'timed out after 10 s', checkedAt: 1 }
  ], { status: 'stale', error: 'the last check failed' }), ROSTER);
  assert.deepEqual(view.cards, []);
  assert.deepEqual(view.notes, [
    'These are from an earlier check: the last check failed.',
    'Not read: broken (timed out after 10 s).',
    'Not counted, with no upstream to push to: lead-repo on build/v2, odd on a detached head.'
  ]);
});

test('no panel, no reading or no repos set up: the count is unknown and the tile says why', () => {
  assert.deepEqual(pushView(undefined, ROSTER), { known: false, cards: [], notes: ["The server running now doesn't check the repos. That arrives with its next restart."] });
  assert.deepEqual(pushView({ data: null, status: 'unavailable', error: 'no reading yet' }, ROSTER).notes, ['To push: Unavailable: no reading yet.']);
  assert.deepEqual(pushView({ data: { configured: false, repos: [] }, status: 'ok' }, ROSTER).notes, ['To push is not set up: config.json names no repos to check.']);
});

// ---- the view ----

const many = (n, extra = {}) => Array.from({ length: n }, (_, i) => item(`i${i}`, { ask: ask(), priority: 'P2', ...extra }));

test('all cards: due soon, then to push, then decide or do; the first 9, then Show all', () => {
  const items = [...many(10), item('due', { ask: ask(), due: '2026-10-22' })];
  const cards = waitingCards({ items, today: TODAY, roster: ROSTER, toPushEnv: env([repo('garden-app', { staged: 1 })]) });
  const view = waitingView(cards);
  assert.equal(view.total, 12);
  assert.deepEqual(view.tiles.map(t => [t.id, t.n]), [['due', 1], ['decide', 10], ['push', 1]]);
  assert.equal(view.shown.length, WAIT_SHOWN);
  assert.deepEqual(view.shown.slice(0, 3).map(c => c.group), ['due', 'push', 'decide']);
  assert.equal(view.more, 12);
  assert.equal(view.showing, 'Showing 9 of 12.');
  assert.equal(view.fewer, false);
  const all = waitingView(cards, { all: true });
  assert.equal(all.shown.length, 12);
  assert.equal(all.more, 0);
  assert.equal(all.fewer, true, 'a way back to the first 9');
  assert.equal(all.showing, 'Showing all 12.');
  assert.equal(waitingView(cards, { filter: 'due', all: true }).fewer, false, 'nothing to fold under 9');
});

test('a tile shows only its cards, and the line says how to get the rest back', () => {
  const cards = waitingCards({ items: [...many(10), item('due', { ask: ask(), due: '2026-10-22' })], today: TODAY, roster: ROSTER, toPushEnv: env([]) });
  const due = waitingView(cards, { filter: 'due' });
  assert.deepEqual(due.shown.map(c => c.itemId), ['due']);
  assert.equal(due.showing, 'Showing 1 due soon. Tap the tile again for all 11.');
  const decide = waitingView(cards, { filter: 'decide' });
  assert.equal(decide.shown.length, 9);
  assert.equal(decide.showing, 'Showing 9 of 10 to decide or do. Tap the tile again for all 11.');
  const push = waitingView(cards, { filter: 'push' });
  assert.deepEqual(push.shown, []);
  assert.equal(push.empty, 'Nothing is staged to commit, and nothing is waiting to be pushed.');
});

test('with nothing waiting, the panel says so; an unknown To push count is not a zero', () => {
  const known = waitingView(waitingCards({ items: [item('a')], today: TODAY, roster: ROSTER, toPushEnv: env([repo('tools')]) }));
  assert.equal(known.total, 0);
  assert.equal(known.empty, 'Nothing is waiting on you.');
  assert.equal(known.tiles[2].n, 0);
  // Without a To push reading, only the board's side can be said.
  const cards = waitingCards({ items: [item('a')], today: TODAY, roster: ROSTER, toPushEnv: undefined });
  const view = waitingView(cards);
  assert.equal(view.tiles[2].n, null);
  assert.equal(view.empty, 'Nothing on the board is waiting on you.');
  const push = waitingView(cards, { filter: 'push' });
  assert.equal(push.empty, null, 'no claim that nothing is staged');
  assert.equal(push.showing, 'To push is unknown. Tap the tile again for all 0.');
});

// ---- Next 24 hours ----

const at = (d, h, min = 0) => new Date(2026, 9, d, h, min).getTime(); // October 2026, local
const NOW = at(21, 21, 30); // Wed 10-21, 9:30 PM

test("You: an item's due date at its ask's time, when that falls in the next 24 hours", () => {
  const items = [
    item('a', { ask: ask('do', { time: '10:00' }), due: '2026-10-22', title: 'Post the teaser' }),
    item('b', { ask: ask('do', { time: '21:30' }), due: '2026-10-22' }),
    item('c', { ask: ask('do', { time: '21:31' }), due: '2026-10-22' }),
    item('d', { ask: ask('do', { time: '21:00' }), due: '2026-10-21' }),
    item('e', { ask: ask('do'), due: '2026-10-22' }),
    item('f', { ask: ask('do', { time: '11:00' }), due: '2026-10-22', lane: 'done' }),
    item('g', { due: '2026-10-22' })
  ];
  const ev = youEvents(items, NOW);
  assert.deepEqual(ev.map(e => [e.name, e.t, e.kind]), [
    ['You: Post the teaser', at(22, 10), 'you'],
    ['You: Item b', at(22, 21, 30), 'you']
  ]);
});

test('Next 24 hours places the You events among the jobs and resets, soonest first', () => {
  const crons = [{ label: 'com.example.digest', name: 'digest', nextRunAt: at(22, 7, 30) }];
  const extra = youEvents([item('a', { ask: ask('do', { time: '10:00' }), due: '2026-10-22', title: 'Post the teaser' })], NOW);
  const { events } = next24({ crons, limits: [], jobs: { 'com.example.digest': { name: 'Morning digest', owner: 'juniper' } }, now: NOW, extra: [...extra, { t: at(23, 9), name: 'You: too late', kind: 'you' }] });
  assert.deepEqual(events.map(e => [e.name, e.kind, e.at]), [['Morning digest', 'job', '7:30 AM'], ['You: Post the teaser', 'you', '10:00 AM']]);
});
