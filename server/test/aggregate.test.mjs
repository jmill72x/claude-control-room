import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../lib/aggregate.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const HOUR = 3600000, DAY = 24 * HOUR;

const sessions = [
  { sessionId: 'a', title: 'Invoice parser', surface: 'Code', cwd: '/Users/jeff/Projects/invoice', gitBranch: 'main',
    records: [
      { ts: NOW - HOUR, model: 'claude-sonnet-5', tokens: 600 },
      { ts: NOW - 2 * HOUR, model: 'claude-opus-5', tokens: 400 }
    ] },
  { sessionId: 'b', title: 'Board narrative', surface: 'Cowork', cwd: '/Users/jeff/CoworkSpace', gitBranch: null,
    records: [{ ts: NOW - 3 * HOUR, model: 'claude-sonnet-5', tokens: 1000 }] },
  { sessionId: 'c', title: 'Ancient', surface: 'Code', cwd: '/Users/jeff/Projects/old', gitBranch: 'main',
    records: [{ ts: NOW - 30 * DAY, model: 'claude-opus-5', tokens: 99999 }] }
];

test('ignores records outside the week window', () => {
  const { byModel } = aggregate(sessions, NOW);
  const total = byModel.reduce((s, m) => s + m.tokens, 0);
  assert.equal(total, 2000);
});

test('byModel sums per model and sorts descending', () => {
  const { byModel } = aggregate(sessions, NOW);
  assert.equal(byModel[0].name, 'Sonnet');
  assert.equal(byModel[0].tokens, 1600);
  assert.equal(byModel[0].pct, 80);
  assert.equal(byModel[1].name, 'Opus');
  assert.equal(byModel[1].pct, 20);
});

test('bySurface splits Cowork and Code and marks Chat unmeasurable', () => {
  const { bySurface } = aggregate(sessions, NOW);
  const chat = bySurface.find(s => s.name === 'Chat');
  assert.equal(chat.measurable, false);
  assert.equal(chat.tokens, null);
  const code = bySurface.find(s => s.name === 'Code');
  assert.equal(code.tokens, 1000);
  assert.equal(code.measurable, true);
});

test('surface percentages are computed over measurable surfaces only', () => {
  const { bySurface } = aggregate(sessions, NOW);
  const measurable = bySurface.filter(s => s.measurable);
  assert.equal(measurable.reduce((s, x) => s + x.pct, 0), 100);
});

test('byProject uses the directory basename and collapses the tail into Other', () => {
  const many = [1, 2, 3, 4, 5].map(i => ({
    sessionId: `p${i}`, title: `t${i}`, surface: 'Code', cwd: `/Users/jeff/Projects/proj${i}`, gitBranch: 'main',
    records: [{ ts: NOW - HOUR, model: 'claude-opus-5', tokens: 100 * (6 - i) }]
  }));
  const { byProject } = aggregate(many, NOW);
  assert.equal(byProject.length, 4);
  assert.equal(byProject[0].name, 'proj1');
  assert.equal(byProject[3].name, 'Other');
  assert.equal(byProject[3].tokens, 300);
});

test('recentSessions are newest first with a share-of-week percentage', () => {
  const { recentSessions } = aggregate(sessions, NOW);
  assert.equal(recentSessions[0].title, 'Invoice parser');
  assert.equal(recentSessions[0].tokens, 1000);
  assert.equal(recentSessions[0].pct, 50);
  assert.equal(recentSessions[0].surface, 'Code');
});

test('a session with no title falls back to its project name', () => {
  const untitled = [{ sessionId: 'x', title: null, surface: 'Code', cwd: '/Users/jeff/Projects/thing', gitBranch: 'main',
    records: [{ ts: NOW - HOUR, model: 'claude-opus-5', tokens: 10 }] }];
  assert.equal(aggregate(untitled, NOW).recentSessions[0].title, 'thing');
});

test('empty input yields empty panels rather than throwing', () => {
  const out = aggregate([], NOW);
  assert.deepEqual(out.byModel, []);
  assert.deepEqual(out.byProject, []);
  assert.equal(out.recentSessions.length, 0);
});

// --- whenLabel does local date math (toDateString/getDay/getHours), so these
// construct timestamps relative to a locally-derived `now` rather than a fixed
// absolute instant, keeping them valid under any TZ (verify with TZ=Asia/Tokyo
// and TZ=UTC in addition to the default). ---

function localNoonToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

test('when-label shows HH:MM for a session earlier today', () => {
  const base = localNoonToday();
  const s = [{ sessionId: 'z', title: 'Today session', surface: 'Code', cwd: '/Users/jeff/Projects/z', gitBranch: 'main',
    records: [{ ts: base - HOUR, model: 'claude-opus-5', tokens: 10 }] }];
  const { recentSessions } = aggregate(s, base);
  assert.equal(recentSessions[0].when, '11:00');
});

test('when-label shows Yest for a session exactly one calendar day back', () => {
  const base = localNoonToday();
  const s = [{ sessionId: 'z', title: 'Yesterday session', surface: 'Code', cwd: '/Users/jeff/Projects/z', gitBranch: 'main',
    records: [{ ts: base - DAY, model: 'claude-opus-5', tokens: 10 }] }];
  const { recentSessions } = aggregate(s, base);
  assert.equal(recentSessions[0].when, 'Yest');
});

test('when-label shows a weekday abbreviation for sessions further back', () => {
  const base = localNoonToday();
  const ts = base - 3 * DAY;
  const s = [{ sessionId: 'z', title: 'Older session', surface: 'Code', cwd: '/Users/jeff/Projects/z', gitBranch: 'main',
    records: [{ ts, model: 'claude-opus-5', tokens: 10 }] }];
  const { recentSessions } = aggregate(s, base);
  const expected = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ts).getDay()];
  assert.equal(recentSessions[0].when, expected);
});
