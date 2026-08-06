import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../lib/aggregate.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const HOUR = 3600000, DAY = 24 * HOUR;

const sessions = [
  { sessionId: 'a', title: 'Invoice parser', surface: 'Code', cwd: '/Users/example/Projects/invoice', gitBranch: 'main',
    records: [
      { ts: NOW - HOUR, model: 'claude-sonnet-5', tokens: 600 },
      { ts: NOW - 2 * HOUR, model: 'claude-opus-5', tokens: 400 }
    ] },
  { sessionId: 'b', title: 'Board narrative', surface: 'Cowork', cwd: '/Users/example/CoworkSpace', gitBranch: null,
    records: [{ ts: NOW - 3 * HOUR, model: 'claude-sonnet-5', tokens: 1000 }] },
  { sessionId: 'c', title: 'Ancient', surface: 'Code', cwd: '/Users/example/Projects/old', gitBranch: 'main',
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
    sessionId: `p${i}`, title: `t${i}`, surface: 'Code', cwd: `/Users/example/Projects/proj${i}`, gitBranch: 'main',
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

test('recentSessions entries expose exactly the contracted shape, with no leaked sort key', () => {
  const { recentSessions } = aggregate(sessions, NOW);
  const keys = Object.keys(recentSessions[0]).sort();
  assert.deepEqual(keys, ['id', 'model', 'pct', 'surface', 'title', 'tokens', 'when'].sort());
});

test('recentSessions model comes from the same record as when, not from array order (session a stores newest-first)', () => {
  const { recentSessions } = aggregate(sessions, NOW);
  // Session 'a' (Invoice parser) lists its records newest-first: NOW-1h Sonnet, then
  // NOW-2h Opus. The newest record is Sonnet, so model must report Sonnet — picking
  // by array index (records[records.length - 1]) would wrongly report Opus.
  assert.equal(recentSessions[0].title, 'Invoice parser');
  assert.equal(recentSessions[0].model, 'Sonnet');
});

test('a session with no title falls back to its project name', () => {
  const untitled = [{ sessionId: 'x', title: null, surface: 'Code', cwd: '/Users/example/Projects/thing', gitBranch: 'main',
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
  const s = [{ sessionId: 'z', title: 'Today session', surface: 'Code', cwd: '/Users/example/Projects/z', gitBranch: 'main',
    records: [{ ts: base - HOUR, model: 'claude-opus-5', tokens: 10 }] }];
  const { recentSessions } = aggregate(s, base);
  assert.equal(recentSessions[0].when, '11:00');
});

test('when-label shows Yest for a session exactly one calendar day back', () => {
  const base = localNoonToday();
  const s = [{ sessionId: 'z', title: 'Yesterday session', surface: 'Code', cwd: '/Users/example/Projects/z', gitBranch: 'main',
    records: [{ ts: base - DAY, model: 'claude-opus-5', tokens: 10 }] }];
  const { recentSessions } = aggregate(s, base);
  assert.equal(recentSessions[0].when, 'Yest');
});

test('when-label shows a weekday abbreviation for sessions further back', () => {
  const base = localNoonToday();
  const ts = base - 3 * DAY;
  const s = [{ sessionId: 'z', title: 'Older session', surface: 'Code', cwd: '/Users/example/Projects/z', gitBranch: 'main',
    records: [{ ts, model: 'claude-opus-5', tokens: 10 }] }];
  const { recentSessions } = aggregate(s, base);
  const expected = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ts).getDay()];
  assert.equal(recentSessions[0].when, expected);
});

// Day bucketing must be by calendar day, not elapsed milliseconds. These pin
// the boundary from both sides using local field mutation (setDate/setHours),
// which respects whatever TZ the process runs under rather than a fixed
// absolute instant.

function localTime(hh, mm = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function sessionAt(ts) {
  return [{ sessionId: 'z', title: 'Session', surface: 'Code', cwd: '/Users/example/Projects/z', gitBranch: 'main',
    records: [{ ts, model: 'claude-opus-5', tokens: 10 }] }];
}

test('when-label shows the weekday abbreviation for a 23:00 timestamp two calendar days before a 01:00 now, not Yest, despite only ~26h elapsed', () => {
  const now = localTime(1, 0, 0).getTime();
  const tsDate = localTime(23, 0, -2);
  const { recentSessions } = aggregate(sessionAt(tsDate.getTime()), now);
  const expected = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][tsDate.getDay()];
  assert.equal(recentSessions[0].when, expected);
  assert.notEqual(recentSessions[0].when, 'Yest');
});

test('when-label shows Yest for a late-yesterday timestamp read early today (minimal elapsed time across the midnight boundary)', () => {
  const now = localTime(0, 30, 0).getTime();
  const ts = localTime(23, 30, -1).getTime();
  const { recentSessions } = aggregate(sessionAt(ts), now);
  assert.equal(recentSessions[0].when, 'Yest');
});

test('when-label shows Yest for an early-yesterday timestamp read late today (near-48h elapsed but still one calendar day back)', () => {
  const now = localTime(23, 30, 0).getTime();
  const ts = localTime(0, 30, -1).getTime();
  const { recentSessions } = aggregate(sessionAt(ts), now);
  assert.equal(recentSessions[0].when, 'Yest');
});

test('byProject omits Other entirely when there are three or fewer projects', () => {
  const few = [1, 2, 3].map(i => ({
    sessionId: `p${i}`, title: `t${i}`, surface: 'Code', cwd: `/Users/example/Projects/proj${i}`, gitBranch: 'main',
    records: [{ ts: NOW - HOUR, model: 'claude-opus-5', tokens: 100 * i }]
  }));
  const { byProject } = aggregate(few, NOW);
  assert.equal(byProject.length, 3);
  assert.equal(byProject.some(p => p.name === 'Other'), false);
});

// T10: the client keyed rows on when+title. Two untitled sessions in the same
// project in the same minute produce identical keys, and React drops one row —
// real usage vanishing from the list with no marker at all.
test('recentSessions carry the transcript sessionId so identical rows stay distinct', () => {
  const minute = Date.parse('2026-08-05T11:30:00Z');
  const twins = [
    { sessionId: 'first', title: null, surface: 'Code', cwd: '/Users/example/Projects/twin', records: [{ ts: minute, model: 'claude-opus-5', tokens: 10 }] },
    { sessionId: 'second', title: null, surface: 'Code', cwd: '/Users/example/Projects/twin', records: [{ ts: minute, model: 'claude-opus-5', tokens: 10 }] }
  ];
  const { recentSessions } = aggregate(twins, NOW);
  assert.equal(recentSessions.length, 2);
  assert.equal(recentSessions[0].when, recentSessions[1].when);
  assert.equal(recentSessions[0].title, recentSessions[1].title);
  assert.notEqual(recentSessions[0].id, recentSessions[1].id);
});

test('a transcript with no sessionId yields an explicit null id rather than a fabricated one', () => {
  const { recentSessions } = aggregate(
    [{ title: 'x', surface: 'Code', cwd: '/tmp/x', records: [{ ts: NOW - HOUR, model: 'claude-opus-5', tokens: 5 }] }],
    NOW
  );
  assert.equal(recentSessions[0].id, null);
});

// N1: Claude Code writes several transcript FILES sharing a single sessionId
// (a parent transcript plus one per sub-agent). collectSessions emits one
// aggregate-input entry per file, so keying recentSessions purely on
// sessionId produces duplicate ids for genuinely distinct rows. React then
// keys its row list on a value that is not unique, silently dropping or
// duplicating a row on the next poll — a session appears on screen that is
// not actually in the payload. The fix is to fold the file identity
// (`filePath`, attached by collectSessions — one per file, so unique by
// construction) into the id.
test('recentSessions ids stay distinct across multiple transcripts sharing one sessionId (parent + sub-agent files) (N1)', () => {
  const sharedSessionId = [
    { sessionId: 'shared', filePath: '/logs/shared/parent.jsonl', title: 'Parent', surface: 'Code',
      cwd: '/Users/example/Projects/shared',
      records: [{ ts: NOW - HOUR, model: 'claude-sonnet-5', tokens: 10 }] },
    { sessionId: 'shared', filePath: '/logs/shared/subagent-1.jsonl', title: 'Sub 1', surface: 'Code',
      cwd: '/Users/example/Projects/shared',
      records: [{ ts: NOW - 2 * HOUR, model: 'claude-sonnet-5', tokens: 10 }] },
    { sessionId: 'shared', filePath: '/logs/shared/subagent-2.jsonl', title: 'Sub 2', surface: 'Code',
      cwd: '/Users/example/Projects/shared',
      records: [{ ts: NOW - 3 * HOUR, model: 'claude-sonnet-5', tokens: 10 }] }
  ];
  const { recentSessions } = aggregate(sharedSessionId, NOW);
  assert.equal(recentSessions.length, 3, 'all three distinct files must survive into recentSessions');
  const ids = recentSessions.map(s => s.id);
  assert.equal(new Set(ids).size, 3, `expected 3 distinct ids, got ${JSON.stringify(ids)}`);
});

test('recentSessions id for a given file is stable across polls, so React does not needlessly remount the row (N1)', () => {
  const one = [{ sessionId: 's', filePath: '/logs/a/session.jsonl', title: 'A', surface: 'Code',
    cwd: '/Users/example/Projects/a',
    records: [{ ts: NOW - HOUR, model: 'claude-sonnet-5', tokens: 10 }] }];
  const firstPoll = aggregate(one, NOW).recentSessions[0].id;
  const secondPoll = aggregate(one, NOW + 60000).recentSessions[0].id;
  assert.equal(firstPoll, secondPoll);
});
