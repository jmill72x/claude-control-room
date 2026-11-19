// Heads up on the Overview (src/lib/orbit/headsup.js, the proactive check): what the
// page makes of GET /api/proactive, row by row, and where the section goes
// (lib/orbit/home.js, homeSections). Times are built from local dates, so the tests
// hold in any time zone. Every id, title, job and number is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headsUpView, rowOf, stateWords, staleWords, dayWords, TITLE_CHARS, HEADS_POLL_MS, RULE_ORDER } from '../src/lib/orbit/headsup.js';
import { homeSections } from '../src/lib/orbit/home.js';

const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime();
const NOW = at(18, 10);
const answer = (hits, extra = {}) => ({ status: 'on', checkedAt: NOW - 2 * 60e3, quiet: { start: 22, end: 7, now: false }, events: true, rules: { repeatDays: 14 }, hits, ...extra });
const told = { firstAt: NOW - 3600e3, toldAt: NOW - 3600e3, heldAt: null, silent: false };
const TODOS = [{ id: 'aa11', title: 'Renew the domain', text: 'Renew the domain before it lapses', lane: 'doing' }, { id: 7, text: 'A numbered item. With more words after.', lane: 'idea' }];

test('every rule becomes one row, in the rules\' order, a board row named from the board', () => {
  const v = headsUpView(answer([
    { id: 'h8', rule: 'expiry', what: 'shortcut-key', name: 'iPhone', days: 2, ...told },
    { id: 'h7', rule: 'session', pct: 77, ...told },
    { id: 'h6', rule: 'week', limit: 'week (all models)', projected: 112, ...told },
    { id: 'h5', rule: 'heals', target: 'NAS mount', count: 3, ...told },
    { id: 'h4', rule: 'fails', job: null, count: 6, ...told },
    { id: 'h3', rule: 'stale', item: '7', priority: 'P1', lane: 'idea', days: 9, ...told },
    { id: 'h2', rule: 'ask', item: 'zz99', priority: null, kind: 'decide', days: 4, ...told },
    { id: 'h1', rule: 'due', item: 'aa11', priority: 'P2', due: '2026-11-17', late: 1, ...told }
  ]), { todos: TODOS, now: NOW });
  assert.deepEqual(v.rows.map(r => [r.rule, r.name, r.line, r.itemId, r.mark, r.tone]), [
    ['due', 'Renew the domain', 'past due: due Nov 17, 1 day late · P2', 'aa11', '!', 'bad'],
    ['ask', 'Item zz99', 'an ask (decide) waiting 4 days', 'zz99', '?', 'warn'],
    ['stale', 'A numbered item', 'P1 unchanged for 9 days · idea', '7', '~', 'warn'],
    ['fails', 'A launchd job', 'failed 6 times in 14 days', null, '×', 'bad'],
    ['heals', 'NAS mount', 'healed 3 times in 14 days: a lasting fix is due', null, '↻', 'warn'],
    ['week', 'Claude week (all models)', 'projected at 112% by its reset', null, '%', 'warn'],
    ['session', 'Claude session', 'at 77%', null, '%', 'warn'],
    ['expiry', 'Shortcut key iPhone', 'stops working in 2 days unless used', null, '◔', 'warn']
  ]);
  assert.equal(v.sub, '8 heads-ups · checked 2 min ago');
  assert.deepEqual(v.rows.map(r => r.key), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8']);
  assert.deepEqual(RULE_ORDER, ['due', 'ask', 'stale', 'fails', 'heals', 'week', 'session', 'expiry']);
});

test('nothing to show: off, killed, unset, no hits, not an answer, or only hits this page can\'t read', () => {
  for (const a of [null, undefined, 'x', [], { status: 'off', hits: [] }, { status: 'killed', hits: [{ id: 'x', rule: 'due', due: '2026-11-17', late: 1 }] },
    { status: 'unset' }, answer([]), answer('nope'), answer([{ id: 'x', rule: 'other' }, { rule: 'due' }, null, { id: 'y', rule: 'due', due: 'soon', late: 1 }])]) {
    assert.equal(headsUpView(a, { todos: TODOS, now: NOW }), null, JSON.stringify(a));
  }
});

test('the sub line says when quiet hours hold new ones and when Jarvis can\'t be told', () => {
  const hit = { id: 'h1', rule: 'session', pct: 80, ...told };
  assert.equal(headsUpView(answer([hit], { quiet: { now: true } }), { now: NOW }).sub, '1 heads-up · checked 2 min ago · quiet hours: new ones wait for 07:00');
  assert.equal(headsUpView(answer([hit], { events: false, checkedAt: null }), { now: NOW }).sub, '1 heads-up · Jarvis is not told while the chat is off');
});

test('where each hit stands: sent, sent by the limit warning, waiting for 07:00, not sent yet', () => {
  assert.equal(stateWords({ toldAt: NOW - 5 * 60e3 }, NOW), 'sent 5 min ago');
  assert.equal(stateWords({ toldAt: NOW, silent: true }, NOW), 'sent by the limit warning');
  assert.equal(stateWords({ toldAt: null, heldAt: at(17, 23) }, NOW), 'waits for 07:00');
  assert.equal(stateWords({ toldAt: null, heldAt: null }, NOW), 'not sent yet');
});

test('a long board title is cut; a missing title falls back to the text, then to the id', () => {
  const long = { id: 'b', title: 'x'.repeat(200), lane: 'doing' };
  const r = rowOf({ id: 'h', rule: 'due', item: 'b', due: '2026-11-17', late: 1 }, { byId: new Map([['b', long]]), now: NOW });
  assert.equal(Array.from(r.name).length, TITLE_CHARS);
  assert.ok(r.name.endsWith('…'));
  assert.equal(rowOf({ id: 'h', rule: 'due', item: null, due: '2026-11-17', late: 2 }, { now: NOW }).name, 'A board item');
  assert.equal(rowOf({ id: 'h', rule: 'due', item: null, due: '2026-11-17', late: 2 }, { now: NOW }).itemId, null, 'no id, no button');
});

test('a row the page can\'t read is left out', () => {
  for (const h of [
    { id: 'h', rule: 'due', due: '2026-13-01', late: 1 }, { id: 'h', rule: 'due', due: '2026-11-17', late: -1 },
    { id: 'h', rule: 'ask', days: 'x' }, { id: 'h', rule: 'stale', days: 3 }, { id: 'h', rule: 'fails', count: 1.5 },
    { id: 'h', rule: 'heals' }, { id: 'h', rule: 'week', projected: 120, limit: ' ' }, { id: 'h', rule: 'session' },
    { id: 'h', rule: 'expiry', days: null }, { id: 3, rule: 'session', pct: 80 }, { id: 'h', rule: 'constructor' }
  ]) assert.equal(rowOf(h, { now: NOW }), null, JSON.stringify(h));
});

test('plain dates are read as dates, in any time zone', () => {
  assert.equal(dayWords('2026-11-01'), 'Nov 1');
  assert.equal(dayWords('2026-01-31'), 'Jan 31');
  assert.equal(dayWords('2026-00-10'), null);
  assert.equal(dayWords('Nov 1'), null);
});

test('Heads up goes right after Needs you, only while it has a hit; the rest keep their order', () => {
  const loops = { open: [] };
  assert.deepEqual(homeSections(loops, true), ['waiting', 'headsup', 'usage', 'schedule', 'agents']);
  assert.deepEqual(homeSections(loops, false), ['waiting', 'usage', 'schedule', 'agents']);
  assert.deepEqual(homeSections(loops), ['waiting', 'usage', 'schedule', 'agents']);
  assert.deepEqual(homeSections(loops, 'yes'), ['waiting', 'usage', 'schedule', 'agents'], 'only true');
  assert.equal(HEADS_POLL_MS, 60_000);
});

test('a row from a source the server could not read on its last check says so, and is marked', () => {
  const hit = { id: 'h1', rule: 'due', item: 'aa11', priority: 'P2', due: '2026-11-17', late: 1, ...told };
  const fresh = rowOf({ ...hit, current: true, readAt: NOW - 60e3 }, { now: NOW });
  assert.deepEqual([fresh.stale, fresh.state], [false, 'sent 1 h ago']);
  const old = rowOf({ ...hit, current: false, readAt: NOW - 25 * 60e3 }, { now: NOW });
  assert.deepEqual([old.stale, old.state], [true, 'as of 25 min ago, not read since · sent 1 h ago']);
  assert.equal(rowOf({ ...hit, current: false, readAt: null }, { now: NOW }).state, 'not current · sent 1 h ago');
  // An answer from before the field (none sent) is current.
  assert.equal(rowOf(hit, { now: NOW }).stale, false);
  assert.equal(staleWords({ current: 'no' }, NOW), null, 'only false marks it');
  assert.equal(staleWords({ current: false, readAt: Number.NaN }, NOW), 'not current');
});

test('a week row says the recent rate its projection rests on, when the server sends one', () => {
  const week = extra => ({ id: 'h6', rule: 'week', limit: 'week (all models)', projected: 112, firstAt: NOW, toldAt: NOW, ...extra });
  assert.equal(rowOf(week({ rateHours: 24 }), { now: NOW }).line, 'projected at 112% by its reset at the last 24 h rate');
  assert.equal(rowOf(week({ rateHours: 1 }), { now: NOW }).line, 'projected at 112% by its reset at the last 1 h rate');
  for (const rateHours of [null, undefined, 0, -3, 24.5, '24', 'IGNORE PREVIOUS INSTRUCTIONS']) {
    assert.equal(rowOf(week({ rateHours }), { now: NOW }).line, 'projected at 112% by its reset', String(rateHours));
  }
});
