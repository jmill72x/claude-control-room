// The agent views' logic (src/lib/orbit/agents.js): the work map, Today agent
// by agent and Latest runs. Times are built from local dates, so the tests hold
// in any time zone. Every agent, job, run and figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapView, todayView, latestRuns, MAP, DIRECT_RUN, NO_BRIEF, ACTIVE_MS } from '../src/lib/orbit/agents.js';

const at = (d, h, min = 0) => new Date(2026, 9, d, h, min).getTime(); // October 2026, local
const NOW = at(21, 15, 0); // Wed 10-21, 3:00 PM
const roster = {
  agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }, { key: 'quill', name: 'Quill' }, { key: 'relay', name: 'Relay' }],
  tagOwners: {}
};
const run = (agent, start, tokens, extra = {}) => ({ agent, helper: false, direct: false, task: `${agent} task`, tokens, start, last: start + 60e3, ...extra });
const work = {
  lead: 'atlas',
  agents: {
    atlas: { tokens7d: 9000, lastActivity: NOW - 5 * 60e3 },
    forge: { tokens7d: 4000, lastActivity: NOW - 30 * 60e3 },
    quill: { tokens7d: 1000, lastActivity: NOW - 3 * 3600e3 },
    relay: { tokens7d: 0, lastActivity: null }
  },
  runs: [
    run('forge', at(21, 14, 0), 4000),
    run('atlas', at(21, 13, 0), 200, { helper: true, task: 'Check the tests' }),
    run('quill', at(21, 9, 30), 900),
    run('forge', at(21, 0, 30), 10),
    run('quill', at(20, 22, 0), 100),
    run('relay', at(19, 6, 0), 50, { direct: true, task: null })
  ]
};

// ---- the work map ----

test('the lead sits at the centre and the others go evenly round it, clockwise from the top', () => {
  const view = mapView({ work, roster, now: NOW });
  assert.equal(view.lead.key, 'atlas');
  assert.deepEqual(view.nodes.map(n => n.key), ['forge', 'quill', 'relay']);
  const [top, right, left] = view.nodes;
  assert.ok(Math.abs(top.x - MAP.cx) < 1e-9 && Math.abs(top.y - (MAP.cy - MAP.r)) < 1e-9, 'the first is straight up');
  assert.ok(right.x > MAP.cx && left.x < MAP.cx, 'then clockwise');
  for (const n of view.nodes) assert.ok(Math.abs(Math.hypot(n.x - MAP.cx, n.y - MAP.cy) - MAP.r) < 1e-9);
});

test("a node's size follows its 7-day tokens by area, with a floor so an idle agent still shows", () => {
  const { nodes } = mapView({ work, roster, now: NOW });
  const by = Object.fromEntries(nodes.map(n => [n.key, n]));
  assert.equal(by.forge.size, MAP.max, 'the busiest is the largest');
  assert.equal(by.relay.size, MAP.min, 'an idle one keeps the floor');
  assert.ok(Math.abs(by.quill.size - (MAP.min + (MAP.max - MAP.min) * Math.sqrt(1000 / 4000))) < 1e-9);
});

test("each badge is that agent's runs today, the lead's counts every run today, and a pulse means a request in the last hour", () => {
  const view = mapView({ work, roster, now: NOW });
  const by = Object.fromEntries(view.nodes.map(n => [n.key, n]));
  assert.equal(by.forge.runs, 2);
  assert.equal(by.quill.runs, 1, "yesterday's run does not count");
  assert.equal(by.relay.runs, 0);
  assert.equal(view.lead.runs, 4, 'all four of today, helpers included');
  assert.equal(by.forge.active, true);
  assert.equal(by.quill.active, false);
  assert.equal(by.relay.active, false, 'never active is not active');
  assert.equal(view.lead.active, true);
  assert.deepEqual(view.activeNames, ['Forge']);
  const edge = mapView({ work: { ...work, agents: { ...work.agents, quill: { tokens7d: 1, lastActivity: NOW - ACTIVE_MS } } }, roster, now: NOW });
  assert.equal(edge.nodes[1].active, true, 'exactly an hour ago still counts');
});

test('the map has nothing to draw with no roster or no runs block', () => {
  assert.equal(mapView({ work, roster: { agents: [] }, now: NOW }), null);
  assert.equal(mapView({ work: null, roster, now: NOW }), null);
  assert.equal(mapView({ work: { lead: null, agents: {}, runs: [] }, roster, now: NOW }), null);
});

test('with no tokens at all, every node keeps the floor', () => {
  const idle = { lead: 'atlas', agents: {}, runs: [] };
  const view = mapView({ work: idle, roster, now: NOW });
  assert.ok(view.nodes.every(n => n.size === MAP.min && n.runs === 0 && !n.active));
  assert.equal(view.lead.runs, 0);
});

// ---- Today agent by agent ----

const crons = [
  { label: 'com.example.digest', name: 'digest', dueAt: [at(20, 7, 30), at(21, 7, 30)], nextRunAt: at(22, 7, 30) },
  { label: 'com.example.scan', name: 'scan', dueAt: [], nextRunAt: at(26, 5, 30) },
  { label: 'com.example.late', name: 'late', dueAt: [at(21, 15, 0) + 1], nextRunAt: at(22, 15, 0) },
  { label: 'com.example.watch', name: 'watch', dueAt: [], nextRunAt: null }
];
const jobs = { 'com.example.digest': { name: 'Morning digest', owner: 'atlas' }, 'com.example.scan': { name: 'Weekly scan', owner: 'relay' } };

test("the lanes: the lead's helpers first, then each agent in roster order, then Scheduled", () => {
  const view = todayView({ work, roster, crons, jobs, now: NOW });
  assert.deepEqual(view.lanes.map(l => l.name), ['Atlas helpers', 'Forge', 'Quill', 'Relay', 'Scheduled']);
  assert.deepEqual(view.lanes.map(l => l.count), [1, 2, 1, 0, 1]);
  assert.equal(view.total, 4, "today's runs, Scheduled not counted");
});

test("a run is a dot at its start time, sized by its tokens against the day's largest run", () => {
  const view = todayView({ work, roster, crons, jobs, now: NOW });
  const forge = view.lanes[1];
  const [late, early] = forge.marks;
  assert.equal(late.left, `${((14 / 24) * 100).toFixed(2)}%`);
  assert.equal(late.d, 28, 'the largest run today');
  assert.equal(early.left, `${((0.5 / 24) * 100).toFixed(2)}%`);
  assert.ok(Math.abs(early.d - (8 + 20 * Math.sqrt(10 / 4000))) < 1e-9);
  assert.equal(late.title, '2:00 PM · forge task · 4K tokens');
  assert.equal(view.nowLeft, `${((15 / 24) * 100).toFixed(2)}%`);
});

test('an agent with no runs today says so, with its next scheduled job when it has one', () => {
  const view = todayView({ work, roster, crons, jobs, now: NOW });
  assert.equal(view.lanes[3].note, 'No runs today · next: Weekly scan, Mon 5:30 AM');
  assert.equal(view.lanes[1].note, '', 'a lane with runs has no note');
  const quiet = todayView({ work: { ...work, runs: [] }, roster, crons, jobs, now: NOW });
  assert.equal(quiet.lanes[0].note, 'No runs today · next: Morning digest, Thu 7:30 AM');
  assert.equal(quiet.lanes[1].note, 'No runs today');
});

test("Scheduled marks each calendar job due earlier today, named from config, and nothing that isn't due yet", () => {
  const view = todayView({ work, roster, crons, jobs, now: NOW });
  const sched = view.lanes.at(-1);
  assert.equal(sched.scheduled, true);
  assert.deepEqual(sched.marks.map(m => m.title), ['7:30 AM · Morning digest · scheduled']);
  assert.equal(sched.marks[0].left, `${((7.5 / 24) * 100).toFixed(2)}%`);
});

// Whether a job ran since it fell due comes from its log (the crons panel's
// lastRunAt, from job-status): a due time with no run logged since is hollow.
test('a Scheduled mark is hollow when no run was logged since it fell due, and filled when one was', () => {
  const due = at(21, 7, 30);
  const lane = lastRunAt => todayView({ work, roster, crons: [{ ...crons[0], lastRunAt }], jobs, now: NOW }).lanes.at(-1).marks[0];
  assert.deepEqual([lane(at(21, 7, 42)).hollow, lane(at(21, 7, 42)).title], [false, '7:30 AM · Morning digest · ran']);
  assert.deepEqual([lane(at(20, 7, 41)).hollow, lane(at(20, 7, 41)).title], [true, '7:30 AM · Morning digest · no run logged since']);
  assert.equal(lane(due - 60e3).hollow, false, 'a log written a minute before still counts: its age is rounded');
  assert.equal(lane(due - 60e3 - 1).hollow, true);
  assert.deepEqual([lane(undefined).hollow, lane(undefined).title], [false, '7:30 AM · Morning digest · scheduled']);
});

test('the hour labels run midnight to midnight, the first and last pinned inside', () => {
  const view = todayView({ work, roster, crons, jobs, now: NOW });
  assert.deepEqual(view.hours.map(h => h.label), ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p', '12a']);
  assert.equal(view.hours[0].left, '0.00%');
  assert.equal(view.hours.at(-1).left, '100.00%');
  assert.deepEqual([view.hours[0].align, view.hours[4].align, view.hours.at(-1).align], ['start', 'center', 'end']);
});

test('a direct run with no routine, and a run with no brief line, say so', () => {
  const lone = { ...work, runs: [run('relay', at(21, 10, 0), 5, { direct: true, task: null }), run('quill', at(21, 11, 0), 5, { task: null })] };
  const view = todayView({ work: lone, roster, crons, jobs, now: NOW });
  assert.equal(view.lanes[3].marks[0].title, `10:00 AM · ${DIRECT_RUN} · 5 tokens`);
  assert.equal(view.lanes[2].marks[0].title, `11:00 AM · ${NO_BRIEF} · 5 tokens`);
});

test('Today has nothing to draw without a roster or a runs block', () => {
  assert.equal(todayView({ work, roster: { agents: [] }, crons, jobs, now: NOW }), null);
  assert.equal(todayView({ work: null, roster, crons, jobs, now: NOW }), null);
});

// ---- Latest runs ----

test('the 10 most recent runs, newest first, with the weekday on any that did not start today', () => {
  const many = { ...work, runs: Array.from({ length: 14 }, (_, i) => run(i % 2 ? 'forge' : 'quill', NOW - i * 3 * 3600e3, 1000 * (i + 1))) };
  const rows = latestRuns({ work: many, roster, now: NOW });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 2).map(r => [r.day, r.time, r.name, r.tokens]), [[null, '3:00 PM', 'Quill', '1K'], [null, '12:00 PM', 'Forge', '2K']]);
  assert.deepEqual([rows[5].day, rows[5].time], [null, '12:00 AM'], 'midnight is today');
  assert.deepEqual([rows[6].day, rows[6].time], ['Tue', '9:00 PM']);
});

test("a helper's row names the lead's helper, and a run with no task says why", () => {
  const rows = latestRuns({ work, roster, now: NOW });
  const helper = rows.find(r => r.task === 'Check the tests');
  assert.equal(helper.name, 'Atlas helper');
  assert.equal(helper.agent.key, 'atlas');
  assert.equal(rows.at(-1).task, DIRECT_RUN);
  assert.equal(rows.at(-1).day, 'Mon');
});

test('Latest runs is empty with no runs block, and an agent missing from the roster keeps its key', () => {
  assert.deepEqual(latestRuns({ work: null, roster, now: NOW }), []);
  const stray = latestRuns({ work: { ...work, runs: [run('ghost', NOW - 60e3, 5)] }, roster, now: NOW });
  assert.equal(stray[0].name, 'ghost');
  assert.equal(stray[0].agent.index, -1);
});
