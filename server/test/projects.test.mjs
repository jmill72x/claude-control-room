import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjects, agentsReadable } from '../lib/projects.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const MIN = 60000;

const input = {
  agents: [
    { pid: 1, cwd: '/Users/example/Projects/invoice', status: 'busy', name: 'invoice-a1' },
    { pid: 2, cwd: '/Users/example/Projects/warehouse', status: 'idle', name: 'warehouse-b2' }
  ],
  coworkSessions: [
    { sessionId: 'c1', title: 'Board narrative', model: 'claude-opus-5', folder: '/Users/example/CoworkSpace', lastActivityAt: NOW - 22 * MIN, archived: false },
    { sessionId: 'c2', title: 'Archived thing', model: 'claude-opus-5', folder: '/Users/example/Old', lastActivityAt: NOW - 99 * MIN, archived: true }
  ],
  transcripts: [
    { cwd: '/Users/example/Projects/invoice', gitBranch: 'main', lastTs: NOW - 4 * MIN },
    { cwd: '/Users/example/Projects/warehouse', gitBranch: 'feat/etl', lastTs: NOW - 26 * 60 * MIN }
  ]
};

test('marks a busy agent as running', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'invoice');
  assert.equal(p.running, true);
  assert.equal(p.tool, 'Code');
});

test('marks an idle agent as not running', () => {
  assert.equal(buildProjects(input, NOW).find(x => x.name === 'warehouse').running, false);
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

test('running projects sort ahead of idle ones', () => {
  const names = buildProjects(input, NOW).map(p => p.name);
  assert.equal(names[0], 'invoice');
});

// Extra test beyond the brief: the input above happens to insert the running
// project ('invoice') first via the agents loop, so the previous test would
// pass even with the .sort() call deleted entirely. This test reorders the
// agents so the idle project is inserted first, so it only passes if
// buildProjects actually sorts running-first rather than relying on
// insertion order.
test('running projects sort ahead of idle ones even when idle is inserted first', () => {
  const reordered = {
    agents: [
      { pid: 2, cwd: '/Users/example/Projects/warehouse', status: 'idle', name: 'warehouse-b2' },
      { pid: 1, cwd: '/Users/example/Projects/invoice', status: 'busy', name: 'invoice-a1' }
    ],
    coworkSessions: [],
    transcripts: []
  };
  const names = buildProjects(reordered, NOW).map(p => p.name);
  assert.deepEqual(names, ['invoice', 'warehouse']);
});

// Extra test beyond the brief: a project with genuinely no known activity
// (no agent, no transcript, no Cowork session) must never fabricate a
// timestamp-based detail string.
test('a project with no known activity gets a truthful detail, never a fabricated timestamp', () => {
  const noActivity = {
    agents: [{ pid: 3, cwd: '/Users/example/Projects/mystery', status: 'idle', name: 'mystery-c3' }],
    coworkSessions: [],
    transcripts: []
  };
  const p = buildProjects(noActivity, NOW).find(x => x.name === 'mystery');
  assert.equal(p.detail, 'no recent activity');
  assert.equal(p.tasks, null);
});

// Fix-round test: among two running projects, the more recently active one
// must come first. Both projects are busy (running === true) so the running
// flag alone can't order them — only a recency tiebreak can.
test('among running projects, the most recently active one sorts first', () => {
  const twoRunning = {
    agents: [
      { pid: 1, cwd: '/Users/example/Projects/stale', status: 'busy', name: 'stale-a1' },
      { pid: 2, cwd: '/Users/example/Projects/fresh', status: 'busy', name: 'fresh-b2' }
    ],
    coworkSessions: [],
    transcripts: [
      { cwd: '/Users/example/Projects/stale', gitBranch: 'main', lastTs: NOW - 60 * MIN },
      { cwd: '/Users/example/Projects/fresh', gitBranch: 'main', lastTs: NOW - 1 * MIN }
    ]
  };
  const names = buildProjects(twoRunning, NOW).map(p => p.name);
  assert.deepEqual(names, ['fresh', 'stale']);
});

// Fix-round test: a Code project and a Cowork session that happen to share a
// basename must not be merged. Without a tool-aware key, the Cowork session
// (processed after agents/transcripts) is silently swallowed into the Code
// project's row.
test('a Code project and a Cowork session sharing a basename produce two separate rows', () => {
  const collision = {
    agents: [{ pid: 1, cwd: '/Users/example/Projects/docs', status: 'busy', name: 'docs-a1' }],
    coworkSessions: [
      { sessionId: 'c9', title: 'Docs rewrite', model: 'claude-opus-5', folder: '/Users/example/CoworkSpace/docs', lastActivityAt: NOW - 5 * MIN, archived: false }
    ],
    transcripts: []
  };
  const rows = buildProjects(collision, NOW).filter(p => p.name === 'docs');
  assert.equal(rows.length, 2);
  const tools = rows.map(r => r.tool).sort();
  assert.deepEqual(tools, ['Code', 'Cowork']);
});

// Fix-round test: buildProjects must use the transcript's OWN surface field
// rather than hardcoding 'Code'. Hardcoding 'Code' files every Cowork
// transcript under a Code project named after Cowork's internal directory
// (e.g. a project called 'outputs' on the live page).
test('a transcript with surface Cowork produces a Cowork project, not Code', () => {
  const coworkTranscript = {
    agents: [],
    coworkSessions: [],
    transcripts: [
      { cwd: '/Users/example/CoworkSpace/outputs', gitBranch: null, lastTs: NOW - 3 * MIN, surface: 'Cowork' }
    ]
  };
  const p = buildProjects(coworkTranscript, NOW).find(x => x.name === 'outputs');
  assert.equal(p.tool, 'Cowork');
});

// Fix-round test: the first transcript touching a project has no lastTs. A
// naive `p.lastTs === null` check gets poisoned to `undefined` and never
// recovers, so a later transcript with a real timestamp must still win.
test('a missing lastTs on first touch does not block a later real timestamp', () => {
  const poisoned = {
    agents: [],
    coworkSessions: [],
    transcripts: [
      { cwd: '/Users/example/Projects/ledger', gitBranch: 'main', lastTs: undefined },
      { cwd: '/Users/example/Projects/ledger', gitBranch: 'main', lastTs: NOW - 7 * MIN }
    ]
  };
  const p = buildProjects(poisoned, NOW).find(x => x.name === 'ledger');
  assert.equal(p.detail, 'edited 7m ago · main');
});

// Fix-round test: guard against a future `lastTs` (or any other internal
// sort-key field) leaking through the public shape.
test('returned project objects expose exactly the documented keys', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'invoice');
  assert.deepEqual(Object.keys(p).sort(), ['detail', 'name', 'running', 'tasks', 'tool']);
});

// I2: `claude agents --json` failing is not evidence that nothing is running.
// The old collapse to `running: false` printed "Idle" against every project on
// the page as a statement of fact — and did it deterministically at startup,
// where the first sessions run always reads an empty agents cache.
test('an unavailable agents source leaves running unknown, never false', () => {
  const projects = buildProjects({
    agents: [],
    agentsAvailable: false,
    coworkSessions: [],
    transcripts: [{ cwd: '/Users/example/Projects/ledger', gitBranch: 'main', lastTs: NOW - MIN, surface: 'Code' }]
  }, NOW);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].running, null, 'null means unknown; false would claim idle');
});

test('a readable agents source that lists nothing busy does report idle', () => {
  const projects = buildProjects({
    agents: [{ cwd: '/Users/example/Projects/ledger', status: 'idle' }],
    agentsAvailable: true,
    coworkSessions: [],
    transcripts: []
  }, NOW);
  assert.equal(projects[0].running, false);
});

test('agentsAvailable defaults to true so existing callers are unchanged', () => {
  const projects = buildProjects({ transcripts: [{ cwd: '/Users/example/Projects/x', lastTs: NOW }] }, NOW);
  assert.equal(projects[0].running, false);
});

test('a busy agent still sorts to the top when others are unknown', () => {
  const projects = buildProjects({
    agents: [{ cwd: '/Users/example/Projects/busy', status: 'busy' }],
    agentsAvailable: true,
    coworkSessions: [],
    transcripts: [{ cwd: '/Users/example/Projects/quiet', lastTs: NOW - MIN, surface: 'Code' }]
  }, NOW);
  assert.equal(projects[0].name, 'busy');
});

// The stale case is the one server.mjs used to miss: `status !== 'unavailable'`
// let a cache entry whose last refresh FAILED (data kept, error set, status
// stale) pass as readable, so a dead `claude agents` still printed Running and
// Idle as fact until the process restarted.
test('agentsReadable trusts only an ok agents envelope — stale or unavailable is unknown, never idle', () => {
  assert.equal(agentsReadable({ status: 'ok', data: [], error: null }), true);
  assert.equal(agentsReadable({ status: 'stale', data: [], error: 'claude agents: exit 1' }), false);
  assert.equal(agentsReadable({ status: 'stale', data: [], error: null }), false, 'aged out counts as unknown too');
  assert.equal(agentsReadable({ status: 'unavailable', data: null }), false);
  assert.equal(agentsReadable(undefined), false);
});
