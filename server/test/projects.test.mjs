import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjects } from '../lib/projects.mjs';

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
