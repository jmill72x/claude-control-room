// The live agents panel's logic (src/lib/orbit/live.js). Every agent, run and
// figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveRows, liveSummary, duration, QUIET_MS, UNNAMED_SESSION } from '../src/lib/orbit/live.js';
import { DIRECT_RUN, NO_BRIEF } from '../src/lib/orbit/agents.js';

const MIN = 60e3;
const NOW = new Date(2026, 9, 21, 15, 0).getTime();
const roster = { agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }] };
const run = extra => ({ id: 'abc', agent: 'forge', type: 'forge', direct: false, task: 'Build the widget', session: 'Atlas', start: NOW - 12 * MIN, last: NOW - 10e3, tokens: 58_000, model: 'opus', ...extra });

test('duration reads as seconds, minutes, then hours and minutes', () => {
  assert.equal(duration(40e3), '40 s');
  assert.equal(duration(12 * MIN), '12 min');
  assert.equal(duration(65 * MIN), '1 h 05 min');
  assert.equal(duration(-5), '0 s');
});

test('a roster agent shows its name, brief line, time running, model, tokens and session', () => {
  const [row] = liveRows({ live: { runs: [run()] }, roster, now: NOW });
  assert.deepEqual({ ...row, agent: row.agent.key }, {
    key: 'abc', agent: 'forge', name: 'Forge', task: 'Build the widget', running: '12 min',
    model: 'Opus', tokens: '58K tokens', session: 'in Atlas', quiet: null
  });
});

test('a helper type, an unnamed session, a direct run and a missing brief each say so', () => {
  const rows = liveRows({ live: { runs: [
    run({ id: 'h', agent: null, type: 'general-purpose', session: null, task: null }),
    run({ id: 'd', agent: 'atlas', type: 'atlas', direct: true, session: null, task: null, model: 'mystery' })
  ] }, roster, now: NOW });
  assert.deepEqual([rows[0].name, rows[0].session, rows[0].task, rows[0].agent.index], ['general-purpose', `in ${UNNAMED_SESSION}`, NO_BRIEF, -1]);
  assert.deepEqual([rows[1].name, rows[1].session, rows[1].task, rows[1].model], ['Atlas', DIRECT_RUN.toLowerCase(), DIRECT_RUN, null]);
});

test('a run silent for two minutes or more is marked quiet', () => {
  const [fresh, quiet] = liveRows({ live: { runs: [run({ id: 'a', last: NOW - QUIET_MS + 1000 }), run({ id: 'b', last: NOW - 6 * MIN })] }, roster, now: NOW });
  assert.equal(fresh.quiet, null);
  assert.equal(quiet.quiet, 'quiet 6 min');
});

test('the summary counts the runs, and says when the list leaves some out', () => {
  assert.equal(liveSummary(null), 'none running');
  assert.equal(liveSummary({ runs: [] , more: 0 }), 'none running');
  assert.equal(liveSummary({ runs: [run()], more: 0 }), '1 running');
  assert.equal(liveSummary({ runs: [run(), run()], more: 3 }), '5 running, 2 shown');
});

test('rows without a start time, or a block that is not a list, give nothing', () => {
  assert.deepEqual(liveRows({ live: { runs: [run({ start: null })] }, roster, now: NOW }), []);
  assert.deepEqual(liveRows({ live: { runs: 'nope' }, roster, now: NOW }), []);
  assert.deepEqual(liveRows({ live: undefined, roster, now: NOW }), []);
});
