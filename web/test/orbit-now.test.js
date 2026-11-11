// The Now chip (src/lib/orbit/now.js). Times are built from local dates, so the
// tests hold in any time zone. Every agent, job and run here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowChip, nowDetail, nowFromPayload, leadNow, workingNow, nextJob, shortAgo, upFor, WORKING_MS } from '../src/lib/orbit/now.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime(); // November 2026, local
const NOW = at(10, 15, 0); // Tue 11-10, 3:00 PM
const roster = { agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }, { key: 'quill', name: 'Quill' }] };
const health = { status: 'ok', data: { services: [{ key: 'session:Atlas', kind: 'session', name: 'Atlas', state: 'up', startedAt: NOW - 3 * DAY - HOUR }] } };
const work = {
  lead: 'atlas', leadModel: 'fable', leadLast: NOW - 2 * MIN,
  runs: [
    { agent: 'forge', helper: false, direct: false, task: 'Build the widget', tokens: 120000, start: NOW - 9 * MIN, last: NOW - 4 * MIN, model: 'fable' },
    { agent: 'quill', helper: false, direct: false, task: 'Write the note', tokens: 30000, start: NOW - 40 * MIN, last: NOW - 18 * MIN, model: 'opus' },
    { agent: 'forge', helper: false, direct: true, task: null, tokens: 10, start: NOW - 2 * HOUR, last: NOW - 2 * HOUR, model: 'opus' },
    { agent: 'forge', helper: false, direct: false, task: 'An older run of Forge', tokens: 500, start: NOW - 6 * MIN, last: NOW - 4 * MIN - 30e3, model: 'opus' },
    { agent: 'atlas', helper: true, direct: false, task: 'Summarise', tokens: 5000, start: NOW - 3 * MIN, last: NOW - MIN, model: 'fable' }
  ]
};
const jobs = { 'com.example.friday': { name: 'Friday alert', owner: 'forge' }, 'com.example.morning': { name: 'Morning brief', owner: 'atlas' } };
const crons = [
  { label: 'com.example.morning', name: 'morning', nextRunAt: at(11, 7, 30) },
  { label: 'com.example.friday', name: 'friday', nextRunAt: at(10, 16, 45) },
  { label: 'com.example.interval', name: 'interval', nextRunAt: null }
];

test('short ages and uptimes read as the chip says them', () => {
  assert.equal(shortAgo(4 * MIN + 30e3), '4 m');
  assert.equal(shortAgo(0), '0 m');
  assert.equal(shortAgo(3 * HOUR), '3 h');
  assert.equal(shortAgo(3 * DAY), '3 d');
  assert.equal(upFor(NOW - 3 * DAY - HOUR, NOW), 'up 3 d');
  assert.equal(upFor(NOW - 5 * HOUR, NOW), 'up 5 h');
  assert.equal(upFor(NOW - 12 * MIN, NOW), 'up 12 m');
  assert.equal(upFor(null, NOW), null);
});

test("the lead's part: name, model from the transcript, up for how long; down and unknown said as such", () => {
  const lead = leadNow({ health, work, roster, now: NOW });
  assert.equal(lead.text, 'Atlas · Fable · up 3 d');
  assert.equal(lead.state, 'up');
  assert.equal(lead.model, 'Fable');
  assert.equal(leadNow({ health, work: { ...work, leadModel: 'opus' }, roster, now: NOW }).text, 'Atlas · Opus · up 3 d');
  assert.equal(leadNow({ health, work: { ...work, leadModel: null }, roster, now: NOW }).text, 'Atlas · up 3 d', 'no request on record: no model word');
  assert.equal(leadNow({ health, work: { ...work, leadModel: 'other' }, roster, now: NOW }).model, 'Other');
  const down = { status: 'ok', data: { services: [{ kind: 'session', state: 'down', startedAt: null }] } };
  assert.equal(leadNow({ health: down, work, roster, now: NOW }).text, 'Atlas · Fable · down');
  assert.equal(leadNow({ health: null, work, roster, now: NOW }).text, 'Atlas · Fable · state unknown', 'no health panel is not down');
  assert.equal(leadNow({ health, work: null, roster, now: NOW }).text, 'Atlas · up 3 d');
  assert.equal(leadNow({ health, work, roster: { agents: [] }, now: NOW }), null);
});

test('working now: a request in the last 5 minutes, one entry per agent, most recent first; helpers are the lead', () => {
  assert.equal(WORKING_MS, 5 * MIN);
  const w = workingNow({ work, roster, now: NOW });
  assert.deepEqual(w.map(x => [x.name, x.since, x.task, x.tokens, x.model]), [
    ['Atlas', '1 m', 'Summarise', '5K', 'Fable'],
    ['Forge', '4 m', 'Build the widget', '120K', 'Fable']
  ]);
  assert.equal(w[1].color, '#4D7C0F', "the agent's day colour by roster order");
  assert.equal(w.length, 2, 'one entry per agent: Forge\'s older run within the window is folded into its newest');
  assert.deepEqual(workingNow({ work, roster, now: NOW + 2 * MIN }).map(x => x.name), ['Atlas'], 'Forge drops out past 5 minutes');
  assert.deepEqual(workingNow({ work: null, roster, now: NOW }), []);
  const stranger = { runs: [{ agent: 'ghost', last: NOW, start: NOW, tokens: 1 }] };
  assert.deepEqual(workingNow({ work: stranger, roster, now: NOW }).map(x => x.name), ['ghost'], 'an agent the roster does not know keeps its key');
  const noTask = { runs: [{ agent: 'forge', helper: false, direct: true, task: null, tokens: 1, start: NOW, last: NOW }, { agent: 'atlas', helper: true, task: null, tokens: 1, start: NOW, last: NOW }] };
  assert.deepEqual(workingNow({ work: noTask, roster, now: NOW }).map(x => x.task), ['Direct run', 'Atlas helper']);
});

test('the next job: the soonest nextRunAt, named from config, the clock today and the weekday otherwise', () => {
  assert.deepEqual(nextJob({ crons, jobs, now: NOW }), { t: at(10, 16, 45), name: 'Friday alert', at: '4:45 PM', text: 'next 4:45 PM Friday alert' });
  assert.equal(nextJob({ crons, jobs, now: at(10, 17) }).text, 'next Wed 7:30 AM Morning brief');
  assert.equal(nextJob({ crons: [{ label: 'x', name: 'loose', nextRunAt: at(10, 18) }], jobs: {}, now: NOW }).name, 'loose', 'no config name: the job\'s own');
  assert.equal(nextJob({ crons: [], jobs, now: NOW }), null);
  assert.equal(nextJob({ crons: null, jobs, now: NOW }), null);
});

test('the chip: one line, its tone, and the details it opens', () => {
  const chip = nowChip({ health, work, crons, jobs, roster, now: NOW });
  assert.equal(chip.text, 'Atlas · Fable · up 3 d · 2 working: Atlas 1 m, Forge 4 m · next 4:45 PM Friday alert');
  assert.equal(chip.tone, 'ok');
  assert.equal(chip.count, 2);
  const quiet = nowChip({ health, work: { ...work, runs: [] }, crons: [], jobs, roster, now: NOW });
  assert.equal(quiet.text, 'Atlas · Fable · up 3 d · nobody working');
  assert.equal(quiet.tone, 'idle');
  const down = nowChip({ health: { status: 'ok', data: { services: [{ kind: 'session', state: 'down' }] } }, work, crons, jobs, roster, now: NOW });
  assert.equal(down.tone, 'bad');
  assert.equal(nowChip({ health, work, crons, jobs, roster: null, now: NOW }), null);

  const d = nowDetail(chip, NOW);
  assert.equal(d.title, 'Now');
  assert.deepEqual(d.rows.map(r => [r.name, r.when, r.state, r.tone]), [
    ['Atlas', 'Summarise', '1 m ago · 5K tokens · Fable', 'ok'],
    ['Forge', 'Build the widget', '4 m ago · 120K tokens · Fable', 'ok'],
    ['Atlas', 'last request 2 min ago', 'on Fable', 'idle'],
    ['Next', 'Friday alert', '4:45 PM', 'idle']
  ]);
  const q = nowDetail(quiet, NOW);
  assert.deepEqual(q.rows[0], { name: 'Working', when: 'no agent has made a request in the last 5 minutes', state: 'nobody', tone: 'idle' });
  assert.equal(q.rows.length, 2, 'no next job, no Next row');
  assert.equal(nowDetail(nowChip({ health, work: { ...work, leadLast: null, leadModel: null }, crons, jobs, roster, now: NOW }), NOW).rows.at(-2).state, 'model unknown');
  assert.equal(nowDetail(null, NOW), null);
});

test('from the whole payload: the sessions panel\'s agentWork, the crons panel, the health panel and the job names', () => {
  const payload = { health, sessions: { status: 'ok', data: { agentWork: work } }, crons: { status: 'ok', data: crons }, config: { data: { jobs } } };
  assert.equal(nowFromPayload({ payload, roster, now: NOW }).text, 'Atlas · Fable · up 3 d · 2 working: Atlas 1 m, Forge 4 m · next 4:45 PM Friday alert');
  assert.equal(nowFromPayload({ payload: { health }, roster, now: NOW }).text, 'Atlas · up 3 d · nobody working', 'an older server without agentWork');
  assert.equal(nowFromPayload({ payload: null, roster, now: NOW }).text, 'Atlas · state unknown · nobody working');
});
