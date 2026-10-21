import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentWork, taskLine, ROUTINE_WINDOW_MS } from '../lib/agent-work.mjs';

// The agent views (Orbit plan, Phase 3). An invented roster, invented jobs and
// invented runs: never a real agent, job or brief.
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-12T15:00:00Z');
const roster = {
  agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }, { key: 'quill', name: 'Quill' }, { key: 'relay', name: 'Relay' }],
  jobs: {
    'com.example.scan': { name: 'Weekly scan', owner: 'relay' },
    'com.example.audit': { name: 'Quarterly audit', owner: 'relay' },
    'com.example.digest': { name: 'Morning digest', owner: 'atlas' },
    'com.example.loose': { name: 'Unowned job' }
  }
};
const SCAN_DUE = NOW - 5 * HOUR;
const crons = [
  { label: 'com.example.scan', dueAt: [SCAN_DUE - 7 * DAY + 60e3, SCAN_DUE] },
  { label: 'com.example.audit', dueAt: [SCAN_DUE - 10 * MIN] },
  { label: 'com.example.digest', dueAt: [NOW - 7 * HOUR] }
];
const rec = (ago, tokens) => ({ ts: NOW - ago, tokens, model: 'claude-opus-5' });
const lead = { sessionId: 's-lead', subagent: false, meta: null, agentSetting: null, agentName: 'Atlas', records: [rec(2 * HOUR, 100), rec(30 * MIN, 50)] };
const sub = (sessionId, meta, records) => ({ sessionId, subagent: true, meta, agentSetting: null, agentName: null, records });
const top = (agentSetting, records, agentName = null) => ({ sessionId: `s-${Math.random()}`, subagent: false, meta: null, agentSetting, agentName, records });
const names = new Map([['s-lead', 'Atlas'], ['s-other', 'Someone else']]);
const build = (transcripts, extra = {}) => buildAgentWork({ transcripts, sessionNames: names, roster, crons, now: NOW, ...extra });

test('a subagent whose type is on the roster is that agent\'s run, timed from its first request', () => {
  const out = build([lead, sub('s-lead', { agentType: 'forge', description: 'Build the widget' }, [rec(90 * MIN, 1000), rec(80 * MIN, 500)])]);
  assert.equal(out.lead, 'atlas');
  assert.deepEqual(out.runs, [{ agent: 'forge', helper: false, direct: false, task: 'Build the widget', tokens: 1500, start: NOW - 90 * MIN, last: NOW - 80 * MIN }]);
  assert.deepEqual(out.agents.forge, { tokens7d: 1500, lastActivity: NOW - 80 * MIN });
});

test("any other subagent under the lead's session is a helper of the lead's; under anyone else's it is left out", () => {
  const helper = sub('s-lead', { agentType: 'general-purpose', description: 'Review the widget' }, [rec(70 * MIN, 300)]);
  const elsewhere = sub('s-other', { agentType: 'general-purpose', description: 'Not ours' }, [rec(60 * MIN, 7000)]);
  const orphan = sub('s-missing', { agentType: 'Explore', description: 'Parent unknown' }, [rec(60 * MIN, 8000)]);
  const out = build([lead, helper, elsewhere, orphan]);
  assert.deepEqual(out.runs, [{ agent: 'atlas', helper: true, direct: false, task: 'Review the widget', tokens: 300, start: NOW - 70 * MIN, last: NOW - 70 * MIN }]);
  assert.equal(out.agents.atlas.tokens7d, 100 + 50 + 300, "the lead's own session and its helpers");
  assert.equal(out.agents.atlas.lastActivity, NOW - 30 * MIN);
});

test('a subagent with no meta file is left out, even under the lead\'s session', () => {
  const out = build([lead, sub('s-lead', null, [rec(60 * MIN, 900)])]);
  assert.deepEqual(out.runs, []);
  assert.equal(out.agents.atlas.tokens7d, 150);
});

test("the lead's own session counts towards the lead, but is not a run", () => {
  const out = build([lead]);
  assert.deepEqual(out.runs, []);
  assert.deepEqual(out.agents.atlas, { tokens7d: 150, lastActivity: NOW - 30 * MIN });
  const byKey = build([{ ...lead, agentName: '  ATLAS ' }]);
  assert.equal(byKey.agents.atlas.tokens7d, 150, 'the name is matched without case or spaces, or by key');
  assert.equal(build([{ ...lead, agentName: 'atlas' }]).agents.atlas.tokens7d, 150);
  assert.equal(build([{ ...lead, agentName: 'Atlas-Spike' }]).agents.atlas.tokens7d, 0, 'a different name is someone else');
});

test('a run started with --agent is that agent\'s, and takes its routine\'s name when it starts just after one fell due', () => {
  const routine = top('relay', [rec(5 * HOUR - 40e3, 4000)]);
  const later = top('relay', [rec(5 * HOUR - ROUTINE_WINDOW_MS - 60e3, 10)]);
  const early = top('relay', [rec(5 * HOUR + 60e3, 20)]);
  const out = build([routine, later, early]);
  const tasks = out.runs.map(r => [r.agent, r.task, r.tokens]);
  assert.ok(out.runs.every(r => r.direct === true && r.helper === false), 'a --agent run is direct, and nobody\'s helper');
  assert.deepEqual(tasks, [['relay', null, 10], ['relay', 'Weekly scan', 4000], ['relay', 'Quarterly audit', 20]],
    'the closest due time before the start wins; past the window there is none; a run that starts before the scan fell due is the audit, due 9 minutes earlier');
  assert.equal(out.agents.relay.tokens7d, 4030);
});

test("a routine's name comes only from the agent's own jobs", () => {
  const out = build([top('forge', [rec(5 * HOUR - 40e3, 5)])]);
  assert.equal(out.runs[0].task, null, 'forge owns no job, so the scan falling due says nothing about its run');
  const none = buildAgentWork({ transcripts: [top('relay', [rec(5 * HOUR - 40e3, 5)])], sessionNames: names, roster, crons: null, now: NOW });
  assert.equal(none.runs[0].task, null, 'no schedules read yet: no name, and no crash');
});

test('anything else is left out: an agent not on the roster, or a session with no agent', () => {
  const out = build([top('stranger', [rec(HOUR, 50)]), top(null, [rec(HOUR, 60)]), top(null, [rec(HOUR, 70)], 'Someone else')]);
  assert.deepEqual(out.runs, []);
  for (const key of ['atlas', 'forge', 'quill', 'relay']) assert.deepEqual(out.agents[key], { tokens7d: 0, lastActivity: null });
});

test('the last 7 days only: older runs drop out, and an older request does not count', () => {
  const old = sub('s-lead', { agentType: 'forge', description: 'Old work' }, [rec(8 * DAY, 999)]);
  const long = { ...lead, records: [rec(8 * DAY, 5000), rec(HOUR, 10)] };
  const out = build([old, long]);
  assert.deepEqual(out.runs, []);
  assert.equal(out.agents.forge.tokens7d, 0);
  assert.equal(out.agents.forge.lastActivity, NOW - 8 * DAY, 'its last activity is still known');
  assert.equal(out.agents.atlas.tokens7d, 10);
});

test('runs are newest first, and an agent with no runs still has an entry', () => {
  const a = sub('s-lead', { agentType: 'forge', description: 'First' }, [rec(3 * HOUR, 1)]);
  const b = sub('s-lead', { agentType: 'quill', description: 'Second' }, [rec(2 * HOUR, 2)]);
  const c = top('relay', [rec(HOUR, 3)]);
  const out = build([a, c, b]);
  assert.deepEqual(out.runs.map(r => r.task ?? r.agent), ['relay', 'Second', 'First']);
  assert.deepEqual(Object.keys(out.agents), ['atlas', 'forge', 'quill', 'relay']);
});

test('with no roster there is no lead, no agent and no run', () => {
  const out = buildAgentWork({ transcripts: [lead], sessionNames: names, roster: { agents: [], jobs: {} }, crons, now: NOW });
  assert.deepEqual(out, { lead: null, agents: {}, runs: [] });
});

test('a task line is one plain line: control and direction characters go, spaces close up, and it is cut at 120', () => {
  assert.equal(taskLine('  Build\u202e the\nwidget\t\u2066now\u0007 '), 'Build the widget now');
  assert.equal(taskLine('\u0085\u009f'), null);
  assert.equal(taskLine(42), null);
  const long = taskLine('word '.repeat(60));
  assert.equal([...long].length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(taskLine('Émoji 🙂 ok'), 'Émoji 🙂 ok');
});

test('a task line reaches the run cleaned', () => {
  const out = build([lead, sub('s-lead', { agentType: 'forge', description: 'Fix\u202ethe\n\nbuild' }, [rec(HOUR, 1)])]);
  assert.equal(out.runs[0].task, 'Fix the build');
});
