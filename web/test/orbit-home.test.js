// The merged home screen (src/lib/orbit/home.js, board f74ca819): the section order,
// the Agents card's tabs, the Usage fold's words, the remembered folds, Today's
// schedule line and where the loops go. Times are built from local dates, so the
// tests hold in any time zone. Every job, agent and figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  homeSections, AGENT_TABS, DEFAULT_AGENT_TAB, agentTab, agentTabLabels, tabAfterKey,
  usageFoldLabel, FOLD_KEYS, readFold, writeFold, scheduleSub, loopsLine
} from '../src/lib/orbit/home.js';
import { routinesView } from '../src/lib/orbit/routines.js';

const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime(); // November 2026, local
const NOW = at(14, 15, 20);
const loops = (extra = {}) => ({ status: 'on', why: null, open: [], quiet: [], held: [], recent: [], weeks: [], generatedAt: NOW, ...extra });
const OPEN = [{ name: 'Evening digest', class: 'stale-log', tier: 'T1', step: 'diagnosing', detectedAt: NOW - 60e3 }];

// ---- the order ----

test('five sections at most: Needs you, Agents, Usage, Today\'s schedule, then Loops only while one is open', () => {
  assert.deepEqual(homeSections(loops()), ['waiting', 'usage', 'schedule', 'agents']);
  assert.deepEqual(homeSections(loops({ open: OPEN })), ['waiting', 'usage', 'schedule', 'agents', 'loops']);
  assert.deepEqual(homeSections(undefined), ['waiting', 'usage', 'schedule', 'agents'], 'a server without loops');
});

// ---- the Agents card ----

test('the tabs go Now, Today, Recent, and the card opens on Now, where the Stop buttons are', () => {
  assert.deepEqual(AGENT_TABS.map(t => t.key), ['now', 'today', 'recent']);
  assert.equal(DEFAULT_AGENT_TAB, 'now');
  assert.equal(agentTab('today'), 'today');
  assert.equal(agentTab('recent'), 'recent');
  for (const bad of [undefined, null, '', 'map', 'NOW', 3]) assert.equal(agentTab(bad), 'now', String(bad));
});

test('the tab words count what runs now (with the ones the list leaves out) and the runs today', () => {
  const words = agentTabLabels({ live: { runs: [{}, {}], more: 1 }, todayTotal: 6 }).map(t => t.text);
  assert.deepEqual(words, ['Now · 3', 'Today · 6', 'Recent']);
  assert.deepEqual(agentTabLabels({ live: { runs: [] }, todayTotal: 0 }).map(t => t.text), ['Now · 0', 'Today · 0', 'Recent'],
    'an empty list from a server that sends one is a real 0');
});

test('a count the page has no source for is left off, never shown as 0', () => {
  const t = agentTabLabels({ live: null, todayTotal: null });
  assert.deepEqual(t.map(x => x.text), ['Now', 'Today', 'Recent']);
  assert.deepEqual(t.map(x => x.count), [null, null, null]);
  assert.equal(agentTabLabels({ live: { more: 4 }, todayTotal: NaN })[0].text, 'Now', 'no runs list at all');
  assert.equal(agentTabLabels({ live: { runs: [{}], more: 'x' }, todayTotal: 1 })[0].text, 'Now · 1', 'a bad "more" adds nothing');
});

test('the arrow keys move along the tabs and wrap; Home and End go to the ends; other keys are not the tabs\'', () => {
  assert.equal(tabAfterKey('now', 'ArrowRight'), 'today');
  assert.equal(tabAfterKey('today', 'ArrowRight'), 'recent');
  assert.equal(tabAfterKey('recent', 'ArrowRight'), 'now');
  assert.equal(tabAfterKey('now', 'ArrowLeft'), 'recent');
  assert.equal(tabAfterKey('recent', 'ArrowLeft'), 'today');
  assert.equal(tabAfterKey('today', 'Home'), 'now');
  assert.equal(tabAfterKey('now', 'End'), 'recent');
  assert.equal(tabAfterKey('now', 'Enter'), null);
  assert.equal(tabAfterKey('now', 'ArrowDown'), null);
  assert.equal(tabAfterKey('nonsense', 'ArrowRight'), 'today', 'an unknown tab counts as the first');
});

// ---- the Usage fold ----

test("Usage's fold: closed it carries the last hour's tokens, open it says how to close", () => {
  assert.equal(usageFoldLabel(false, { lastHour: 48_200 }), 'Burn: 48K tokens in the last hour · hour by hour');
  assert.equal(usageFoldLabel(false, { lastHour: 0 }), 'Burn: 0 tokens in the last hour · hour by hour');
  assert.equal(usageFoldLabel(false, null), 'Burn and hour by hour', 'a server without hourly figures');
  assert.equal(usageFoldLabel(true, { lastHour: 48_200 }), 'Hide burn and hour by hour');
});

// ---- folds remembered per viewer ----

const memory = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('a fold is remembered under its own key, open or closed', () => {
  const s = memory();
  assert.notEqual(FOLD_KEYS.usage, FOLD_KEYS.loops);
  assert.equal(readFold(s, FOLD_KEYS.usage), false, 'closed until opened');
  writeFold(s, FOLD_KEYS.usage, true);
  assert.equal(readFold(s, FOLD_KEYS.usage), true);
  assert.equal(readFold(s, FOLD_KEYS.loops), false, 'the other fold is untouched');
  writeFold(s, FOLD_KEYS.usage, false);
  assert.equal(s.m.get(FOLD_KEYS.usage), 'closed');
  assert.equal(readFold(s, FOLD_KEYS.usage), false);
});

test('without storage, or with storage that throws, a fold reads closed and a write does nothing', () => {
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readFold(throwing, FOLD_KEYS.usage), false);
  assert.doesNotThrow(() => writeFold(throwing, FOLD_KEYS.usage, true));
  assert.equal(readFold(null, FOLD_KEYS.usage), false);
  assert.doesNotThrow(() => writeFold(undefined, FOLD_KEYS.usage, true));
  const odd = memory();
  odd.setItem(FOLD_KEYS.usage, 'yes');
  assert.equal(readFold(odd, FOLD_KEYS.usage), false, 'only "open" opens');
});

test('the hook stores through readFold and writeFold, so the guards above are the ones the page uses', () => {
  const src = readFileSync(new URL('../src/orbit/useFold.js', import.meta.url), 'utf8');
  assert.ok(/readFold\(storage\(\), key\)/.test(src) && /writeFold\(storage\(\), key, v\)/.test(src));
});

// ---- Today's schedule ----

test("Today's schedule line: the routines' own summary, then the next 24 hours' count", () => {
  const crons = [
    { label: 'a', dueAt: [at(14, 7, 30)], lastRunAt: at(14, 7, 31), nextRunAt: at(15, 7, 30) },
    { label: 'b', dueAt: [at(14, 21)], lastRunAt: at(13, 21), nextRunAt: at(14, 21) }
  ];
  const routines = routinesView({ crons, jobs: { a: { name: 'Brief' }, b: { name: 'Digest' } }, now: NOW });
  assert.equal(scheduleSub({ routines, events: [{}, {}, {}], cronsUnavailable: false }), '1 ran · 1 due · 3 in the next 24 h');
  const none = routinesView({ crons: [], jobs: {}, now: NOW });
  assert.equal(scheduleSub({ routines: none, events: [], cronsUnavailable: false }), 'No calendar job runs today · 0 in the next 24 h');
  assert.equal(scheduleSub({ routines: none, events: [{}], cronsUnavailable: true }), '1 in the next 24 h', 'no routines summary without the jobs');
});

// ---- where the loops go ----

test("with no loop open, the loops' state is one line in Today's schedule; with one open, no line (it has its section)", () => {
  const recent = [{ name: 'Backup', class: 'stale-log', tier: 'T1', outcome: 'healed', at: NOW - 3600e3 }];
  assert.equal(loopsLine(loops({ recent }), NOW), 'Heals on · nothing open · 1 healed this week');
  assert.equal(loopsLine(loops({ status: 'killed' }), NOW), 'Heals off · nothing open · 0 healed this week', 'the kill switch still shows');
  assert.equal(loopsLine(loops({ quiet: [{ name: 'NAS', checkedAt: NOW }] }), NOW), 'Heals on · nothing open · 1 quiet · 0 healed this week');
  assert.equal(loopsLine(loops({ open: OPEN }), NOW), null);
  assert.equal(loopsLine(undefined, NOW), null, 'a server without loops');
});
