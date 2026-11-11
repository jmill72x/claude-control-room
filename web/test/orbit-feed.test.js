// The Feed tab (src/lib/orbit/feed.js): what the page shows from GET /api/feed, the
// pins, the filter by agent, the title the post's text repeats, long posts, and the
// words for each state. Every name, key and text here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedView, bodyOf, isLong, dayLabel, phaseForStatus, emptyWords, droppedWords, KIND_LABEL, FEED_POLL_MS, agentFor } from '../src/lib/orbit/feed.js';

const ROSTER = { agents: [{ key: 'lead', name: 'The Lead' }, { key: 'builder', name: 'The Builder' }, { key: 'scout', name: 'The Scout' }], tagOwners: {} };
const T0 = new Date(2026, 10, 11, 9, 0).getTime(); // Wed 11 Nov 2026, 9:00 local
const p = (id, agent, minutes, extra = {}) => ({ id, agent, at: T0 + minutes * 60e3, title: null, text: `text ${id}`, ...extra });
const FEED = {
  status: 'ok',
  posts: [p('c', 'scout', 30), p('b', 'builder', 20), p('a', 'lead', 10)],
  pinned: { brief: p('br', 'lead', -60, { kind: 'brief', title: 'Morning brief' }), digest: p('dg', 'lead', -3 * 24 * 60, { kind: 'digest', title: 'Weekly digest' }) },
  agents: [{ key: 'lead', count: 3, latestAt: T0 + 10 * 60e3 }, { key: 'builder', count: 1, latestAt: T0 + 20 * 60e3 }, { key: 'scout', count: 1, latestAt: T0 + 30 * 60e3 }, { key: 'ghost', count: 0, latestAt: null }],
  skipped: 0, unreadable: 0
};

test('the feed polls once a minute while its tab is open', () => {
  assert.equal(FEED_POLL_MS, 60_000);
});

test('with no filter: every post newest first, and both pins, newest first', () => {
  const v = feedView(FEED, { filter: null, roster: ROSTER });
  assert.deepEqual(v.posts.map(x => x.id), ['c', 'b', 'a']);
  assert.deepEqual(v.pins.map(x => x.id), ['br', 'dg']);
  assert.equal(v.pins[0].label, KIND_LABEL.brief);
  assert.equal(KIND_LABEL.brief, 'Morning brief');
  assert.equal(KIND_LABEL.digest, 'Weekly digest');
});

test('a filter keeps one agent\'s posts, and the pins only for the lead', () => {
  const builder = feedView(FEED, { filter: 'builder', roster: ROSTER });
  assert.deepEqual(builder.posts.map(x => x.id), ['b']);
  assert.deepEqual(builder.pins, []);
  const lead = feedView(FEED, { filter: 'lead', roster: ROSTER });
  assert.deepEqual(lead.posts.map(x => x.id), ['a']);
  assert.deepEqual(lead.pins.map(x => x.id), ['br', 'dg']);
});

test('the filters: All, then each agent with posts, in roster order, named from the roster', () => {
  const v = feedView(FEED, { filter: null, roster: ROSTER });
  assert.deepEqual(v.filters, [
    { key: null, name: 'All', count: 5 },
    { key: 'lead', name: 'The Lead', count: 3 },
    { key: 'builder', name: 'The Builder', count: 1 },
    { key: 'scout', name: 'The Scout', count: 1 }
  ]);
});

test('a filter for an agent with no posts still shows itself, so it can be cleared', () => {
  const v = feedView(FEED, { filter: 'ghost', roster: ROSTER });
  assert.deepEqual(v.posts, []);
  assert.equal(v.filters.some(f => f.key === 'ghost'), true);
});

test('an agent the roster does not know is named by its key, with no picture', () => {
  assert.deepEqual(agentFor('ghost', ROSTER), { key: 'ghost', name: 'ghost', index: -1 });
  assert.deepEqual(agentFor('builder', ROSTER), { key: 'builder', name: 'The Builder', index: 1 });
});

test('malformed posts and pins from the server are left out, not shown broken', () => {
  const bad = {
    status: 'ok',
    posts: [p('ok', 'lead', 1), null, { id: 'x', agent: 'lead', at: 'yesterday', text: 'x' }, { id: 'y', agent: 'lead', at: T0, text: 7 }, { id: 'z', agent: 7, at: T0, text: 'x' }, 'text'],
    pinned: { brief: { id: 'q', agent: 'lead', at: T0 }, digest: 'nope' },
    agents: 'nope'
  };
  const v = feedView(bad, { filter: null, roster: ROSTER });
  assert.deepEqual(v.posts.map(x => x.id), ['ok']);
  assert.deepEqual(v.pins, []);
  assert.deepEqual(v.filters, [{ key: null, name: 'All', count: 1 }, { key: 'lead', name: 'The Lead', count: 1 }]);
  assert.deepEqual(feedView(null, { filter: null, roster: ROSTER }).posts, []);
});

test('the body leaves out the bold title the post repeats at its top', () => {
  assert.equal(bodyOf({ title: 'Pi check', text: '**Pi check**\nMirror healthy.' }), 'Mirror healthy.');
  assert.equal(bodyOf({ title: 'Pi check', text: '**Pi check**' }), '');
  assert.equal(bodyOf({ title: null, text: 'Just text' }), 'Just text');
  assert.equal(bodyOf({ title: 'Other', text: '**Pi check**\nbody' }), '**Pi check**\nbody', 'only its own title');
  assert.equal(bodyOf({ title: 'a*b', text: '**a*b**\nbody' }), 'body');
});

test('long posts are folded: over 700 characters or 12 lines', () => {
  assert.equal(isLong('x'.repeat(700)), false);
  assert.equal(isLong('x'.repeat(701)), true);
  assert.equal(isLong(Array(12).fill('l').join('\n')), false);
  assert.equal(isLong(Array(13).fill('l').join('\n')), true);
});

test('day labels: Today, Yesterday, then the weekday and date', () => {
  assert.equal(dayLabel(T0, T0 + 3600e3), 'Today');
  assert.equal(dayLabel(T0 - 24 * 3600e3, T0), 'Yesterday');
  assert.equal(dayLabel(T0 - 2 * 24 * 3600e3, T0), 'Mon 11-09');
  assert.equal(dayLabel(Number.NaN, T0), '');
});

test('a note when the server left older posts out', () => {
  assert.equal(droppedWords(0), null);
  assert.equal(droppedWords(undefined), null);
  assert.equal(droppedWords('3'), null);
  assert.equal(droppedWords(1), '1 older post left out to keep this page light.');
  assert.equal(droppedWords(12), '12 older posts left out to keep this page light.');
});

test('what each answer means for the page', () => {
  assert.equal(phaseForStatus(401), 'unpaired');
  assert.equal(phaseForStatus(403), 'forbidden');
  assert.equal(phaseForStatus(500), 'error');
  assert.equal(phaseForStatus(0), 'error');
  assert.match(emptyWords('missing'), /No posts yet/);
  assert.match(emptyWords('refused'), /service log/);
  assert.match(emptyWords('off'), /switched off/);
  assert.match(emptyWords('ok'), /No posts/);
});
