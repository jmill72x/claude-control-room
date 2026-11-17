// Chat search on the page (src/lib/orbit/chat-search.js): when a query is worth
// sending, a snippet cut into plain and marked pieces, the summary line, and the steps
// of loading older history until a result's message is on the page. Every message
// here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchable, snippetParts, resultWho, searchSummary, reachStep, reachProblem, REACH_PAGE, REACH_PAGES_MAX, SEARCH_DEBOUNCE_MS } from '../src/lib/orbit/chat-search.js';

test('a query is sent at 2 to 100 characters after trimming', () => {
  assert.equal(SEARCH_DEBOUNCE_MS, 300);
  assert.equal(searchable('ab'), true);
  assert.equal(searchable('  ab  '), true);
  assert.equal(searchable('a'), false);
  assert.equal(searchable(' a '), false);
  assert.equal(searchable(String.fromCodePoint(0x1f600)), false, 'one character, two units');
  assert.equal(searchable('x'.repeat(100)), true);
  assert.equal(searchable('x'.repeat(101)), false);
  assert.equal(searchable(null), false);
});

test('snippetParts: plain and marked pieces that rebuild the snippet exactly', () => {
  const s = 'Short Note about the Deploy';
  const parts = snippetParts(s, [[6, 10], [21, 27]]);
  assert.deepEqual(parts, [
    { text: 'Short ', mark: false }, { text: 'Note', mark: true }, { text: ' about the ', mark: false }, { text: 'Deploy', mark: true }
  ]);
  assert.equal(parts.map(p => p.text).join(''), s);
  assert.deepEqual(snippetParts('abc', []), [{ text: 'abc', mark: false }]);
  assert.deepEqual(snippetParts('', [[0, 1]]), []);
});

test('snippetParts never trusts the marks: out of range, backwards, overlapping, unsorted or not numbers', () => {
  const s = 'abcdefghij';
  for (const marks of [null, 'x', [[-5, 2]], [[8, 99]], [[5, 3]], [[1, 4], [2, 6]], [[6, 8], [0, 2]], [['a', 'b']], [[1.5, 3]], [[0, 0]]]) {
    const parts = snippetParts(s, marks);
    assert.equal(parts.map(p => p.text).join(''), s, JSON.stringify(marks));
    assert.ok(parts.every(p => p.text.length > 0), JSON.stringify(marks));
  }
  assert.deepEqual(snippetParts(s, [[6, 8], [0, 2]]).filter(p => p.mark).map(p => p.text), ['ab', 'gh']);
  assert.deepEqual(snippetParts(s, [[1, 4], [2, 6]]).filter(p => p.mark).map(p => p.text), ['bcdef']);
  assert.deepEqual(snippetParts(s, [[8, 99]]).filter(p => p.mark).map(p => p.text), ['ij']);
});

test('who said it', () => {
  assert.equal(resultWho({ from: 'jeff', kind: 'chat' }), 'You');
  assert.equal(resultWho({ from: 'jarvis', kind: 'chat' }), 'Jarvis');
  assert.equal(resultWho({ from: 'system', kind: 'event' }), 'Event');
});

test('the summary line says how many, whether there are more, and whether old messages were left out', () => {
  assert.equal(searchSummary(null), '');
  assert.equal(searchSummary({ results: [], more: false, truncated: false }), 'No messages match.');
  assert.equal(searchSummary({ results: [{}], more: false, truncated: false }), '1 message.');
  assert.equal(searchSummary({ results: [{}, {}], more: false, truncated: false }), '2 messages.');
  assert.equal(searchSummary({ results: [{}, {}], more: true, truncated: false }), 'The newest 2 matches. Add a word to narrow it.');
  assert.equal(searchSummary({ results: [{}], more: false, truncated: true, scanned: 20000 }), '1 message. Only the newest 20,000 messages were searched.');
});

const page = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, id: `m_${String(from + i).padStart(6, '0')}` }));

test('reachStep: found, keep going, the start of the chat, or passed it (no longer there)', () => {
  assert.equal(REACH_PAGE, 100);
  assert.equal(REACH_PAGES_MAX, 20);
  const target = { id: 'm_000150', seq: 150 };
  assert.equal(reachStep(page(101, 200), target, 100), 'found');
  assert.equal(reachStep(page(201, 300), target, 100), 'more');
  assert.equal(reachStep(page(1, 99), { id: 'm_x', seq: 150 }, 100), 'passed', 'below its seq without it');
  assert.equal(reachStep(page(151, 200), target, 100), 'start', 'fewer than asked: nothing older');
  assert.equal(reachStep([], target, 100), 'start');
  assert.equal(reachStep(page(140, 239).map(m => (m.seq === 150 ? { ...m, id: 'm_other' } : m)), target, 100), 'passed');
  assert.equal(reachStep(page(150, 249).map(m => (m.seq === 150 ? { ...m, id: 'm_other' } : m)), target, 100), 'passed', 'its own seq, another id');
});

test('reachProblem: plain words for each way a jump can fail', () => {
  assert.equal(reachProblem('found'), null);
  assert.match(reachProblem('too-far'), /more than 2,000 messages back/);
  assert.match(reachProblem('passed'), /no longer in the chat/);
  assert.match(reachProblem('start'), /no longer in the chat/);
  assert.match(reachProblem('newer'), /reopen the Chat tab/);
  assert.match(reachProblem('error'), /couldn't load/i);
});
