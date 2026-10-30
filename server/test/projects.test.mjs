import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjects } from '../lib/projects.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const MIN = 60000;

const input = {
  coworkSessions: [
    { sessionId: 'c1', title: 'Board narrative', model: 'claude-opus-5', folder: '/Users/example/CoworkSpace', lastActivityAt: NOW - 22 * MIN, archived: false },
    { sessionId: 'c2', title: 'Archived thing', model: 'claude-opus-5', folder: '/Users/example/Old', lastActivityAt: NOW - 99 * MIN, archived: true }
  ],
  transcripts: [
    { cwd: '/Users/example/Projects/invoice', gitBranch: 'main', lastTs: NOW - 4 * MIN },
    { cwd: '/Users/example/Projects/warehouse', gitBranch: 'feat/etl', lastTs: NOW - 26 * 60 * MIN }
  ]
};

test('a transcript makes a Code project', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'invoice');
  assert.equal(p.tool, 'Code');
});

test('includes the git branch and relative edit time in the detail line', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'invoice');
  assert.equal(p.detail, 'edited 4m ago · main');
});

test('omits the branch when there is none', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'CoworkSpace');
  assert.equal(p.detail, 'edited 22m ago');
  assert.equal(p.tool, 'Cowork');
});

test('archived Cowork sessions are excluded', () => {
  assert.equal(buildProjects(input, NOW).some(p => p.name === 'Old'), false);
});

// The transcripts arrive oldest first here, so only the sort puts the newest on top.
test('the most recently active project sorts first', () => {
  const names = buildProjects({
    transcripts: [
      { cwd: '/Users/example/Projects/stale', gitBranch: 'main', lastTs: NOW - 60 * MIN },
      { cwd: '/Users/example/Projects/fresh', gitBranch: 'main', lastTs: NOW - 1 * MIN }
    ]
  }, NOW).map(p => p.name);
  assert.deepEqual(names, ['fresh', 'stale']);
});

// A project with genuinely no known activity must never fabricate a
// timestamp-based detail string.
test('a project with no known activity gets a truthful detail, never a fabricated timestamp', () => {
  const p = buildProjects({ transcripts: [{ cwd: '/Users/example/Projects/mystery', lastTs: undefined }] }, NOW)
    .find(x => x.name === 'mystery');
  assert.equal(p.detail, 'no recent activity');
  assert.equal(p.tasks, null);
});

// A Code project and a Cowork session that happen to share a basename must not
// be merged into one row.
test('a Code project and a Cowork session sharing a basename produce two separate rows', () => {
  const rows = buildProjects({
    coworkSessions: [
      { sessionId: 'c9', title: 'Docs rewrite', model: 'claude-opus-5', folder: '/Users/example/CoworkSpace/docs', lastActivityAt: NOW - 5 * MIN, archived: false }
    ],
    transcripts: [{ cwd: '/Users/example/Projects/docs', gitBranch: 'main', lastTs: NOW - MIN }]
  }, NOW).filter(p => p.name === 'docs');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.tool).sort(), ['Code', 'Cowork']);
});

// buildProjects must use the transcript's OWN surface field rather than
// hardcoding 'Code'.
test('a transcript with surface Cowork produces a Cowork project, not Code', () => {
  const p = buildProjects({
    transcripts: [{ cwd: '/Users/example/CoworkSpace/outputs', gitBranch: null, lastTs: NOW - 3 * MIN, surface: 'Cowork' }]
  }, NOW).find(x => x.name === 'outputs');
  assert.equal(p.tool, 'Cowork');
});

// The first transcript touching a project has no lastTs; a later one with a
// real timestamp must still win.
test('a missing lastTs on first touch does not block a later real timestamp', () => {
  const p = buildProjects({
    transcripts: [
      { cwd: '/Users/example/Projects/ledger', gitBranch: 'main', lastTs: undefined },
      { cwd: '/Users/example/Projects/ledger', gitBranch: 'main', lastTs: NOW - 7 * MIN }
    ]
  }, NOW).find(x => x.name === 'ledger');
  assert.equal(p.detail, 'edited 7m ago · main');
});

// No `running` key at all since the agents poll was dropped (2026-10-30). The
// page reads an absent key as "not tracked" and a null as "unknown", so a
// `running: null` here would bring back a warning on every visit.
test('returned project objects expose exactly the documented keys, with no running state', () => {
  for (const p of buildProjects(input, NOW)) {
    assert.deepEqual(Object.keys(p).sort(), ['detail', 'name', 'tasks', 'tool']);
  }
});
