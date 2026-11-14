import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveAgents, LIVE_WINDOW_MS, MAX_LIVE } from '../lib/live-agents.mjs';
import { parseTranscript, endsRun } from '../lib/parse-transcript.mjs';

// The live agents panel (war room slice 1). An invented roster, invented runs and
// invented briefs: never a real agent, path or prompt.
const MIN = 60e3;
const NOW = Date.parse('2026-08-12T15:00:00Z');
const roster = { agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }, { key: 'quill', name: 'Quill' }] };
const rec = (ago, tokens, model = 'claude-opus-5') => ({ ts: NOW - ago, tokens, model });
const sub = (meta, records, extra = {}) => ({
  sessionId: 's-lead', subagent: true, meta, agentSetting: null, agentName: null, records,
  filePath: '/home/someone/.claude/projects/-home-someone-secret-project/s-lead/subagents/agent-a1.jsonl',
  lastLineTs: records.length ? Math.max(...records.map(r => r.ts)) : null, ended: false, ...extra
});
const names = new Map([['s-lead', 'atlas'], ['s-other', 'Side project']]);
const build = (transcripts, extra = {}) => buildLiveAgents({ transcripts, sessionNames: names, roster, now: NOW, ...extra });

test('a running subagent shows its agent, brief line, start, model, tokens and session', () => {
  const out = build([sub({ agentType: 'forge', description: 'Build the widget' }, [rec(20 * MIN, 1000, 'claude-sonnet-5'), rec(1 * MIN, 500)])]);
  assert.equal(out.windowMs, LIVE_WINDOW_MS);
  assert.equal(out.more, 0);
  assert.equal(out.runs.length, 1);
  const { id, ...rest } = out.runs[0];
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepEqual(rest, { agent: 'forge', type: 'forge', direct: false, task: 'Build the widget', session: 'Atlas', stoppable: false, start: NOW - 20 * MIN, last: NOW - MIN, tokens: 1500, model: 'opus' });
});

test('the page gets no path, session id, cwd or prompt text', () => {
  const t = sub({ agentType: 'forge', description: 'Build the widget' }, [rec(MIN, 10)], { cwd: '/home/someone/secret-project', title: 'Secret title' });
  const text = JSON.stringify(build([t]));
  for (const leak of ['/home', 'secret', 's-lead', 'agent-a1', 'Secret title']) assert.equal(text.includes(leak), false, leak);
});

test('a run that ended, or wrote nothing within the window, is not live', () => {
  const ended = sub({ agentType: 'forge', description: 'Done' }, [rec(2 * MIN, 10)], { ended: true });
  const stale = sub({ agentType: 'quill', description: 'Gone quiet' }, [rec(LIVE_WINDOW_MS + MIN, 10)]);
  assert.deepEqual(build([ended, stale]).runs, []);
});

test('a line written after the last request (a tool result) keeps a quiet run live', () => {
  const t = sub({ agentType: 'forge', description: 'Long test' }, [rec(LIVE_WINDOW_MS + 5 * MIN, 10)], { lastLineTs: NOW - 3 * MIN });
  const [run] = build([t]).runs;
  assert.equal(run.last, NOW - 3 * MIN);
});

test('a subagent not on the roster shows its type; an unnamed session is null; no meta is left out', () => {
  const helper = sub({ agentType: 'general-purpose', description: 'Review it' }, [rec(MIN, 10)], { sessionId: 's-none' });
  const other = sub({ agentType: 'Explore', description: 'Look around' }, [rec(MIN, 10)], { sessionId: 's-other' });
  const bare = sub(null, [rec(MIN, 10)]);
  const runs = build([helper, other, bare]).runs;
  assert.deepEqual(runs.map(r => [r.agent, r.type, r.session]), [[null, 'general-purpose', null], [null, 'Explore', 'Side project']]);
});

test('a --agent run on the roster is a direct run; other top-level sessions are left out', () => {
  const direct = { sessionId: 's-d', subagent: false, meta: null, agentSetting: 'quill', agentName: null, records: [rec(4 * MIN, 70)], lastLineTs: NOW - MIN, ended: false };
  const lead = { sessionId: 's-lead', subagent: false, meta: null, agentSetting: null, agentName: 'atlas', records: [rec(MIN, 70)], lastLineTs: NOW, ended: false };
  const poll = { sessionId: 's-p', subagent: false, meta: null, agentSetting: null, agentName: null, records: [rec(MIN, 70)], lastLineTs: NOW, ended: false };
  const stranger = { ...direct, sessionId: 's-x', agentSetting: 'not-ours' };
  const runs = build([direct, lead, poll, stranger]).runs;
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].agent, runs[0].direct, runs[0].task, runs[0].session], ['quill', true, null, null]);
});

const RLO = String.fromCodePoint(0x202e);
test('labels are one plain short line, newest run first, and the list is capped', () => {
  const odd = sub({ agentType: `evil${RLO}type-with-a-very-long-name-that-goes-on-and-on`, description: 'line one\nline two' }, [rec(MIN, 1)]);
  const [run] = build([odd]).runs;
  assert.equal(run.type.includes(RLO), false);
  assert.ok([...run.type].length <= 40);
  assert.equal(run.task, 'line one line two');
  const many = Array.from({ length: MAX_LIVE + 3 }, (_, i) => sub({ agentType: 'forge', description: `run ${i}` }, [rec((i + 1) * 10e3, 1)], { filePath: `f${i}` }));
  const out = build(many);
  assert.equal(out.runs.length, MAX_LIVE);
  assert.equal(out.more, 3);
  assert.equal(out.runs[0].task, 'run 0');
});

// The parser's part: the latest line's time, and whether the latest assistant line ended the run.
const line = (type, ts, message) => JSON.stringify({ type, sessionId: 's', timestamp: new Date(ts).toISOString(), ...(message ? { message } : {}) });
const usage = { input_tokens: 5, output_tokens: 5 };

test('endsRun: a final answer or SubagentHandback ends a run; any other tool call does not', () => {
  assert.equal(endsRun({ stop_reason: 'end_turn', content: [{ type: 'text' }] }), true);
  assert.equal(endsRun({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'SubagentHandback' }] }), true);
  assert.equal(endsRun({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] }), false);
  assert.equal(endsRun({ stop_reason: null, content: [{ type: 'thinking' }] }), false);
  assert.equal(endsRun(null), false);
});

test('the parser keeps the latest line time and whether the last assistant line ended the run', () => {
  const going = parseTranscript([
    line('assistant', NOW - 5 * MIN, { id: 'm1', usage, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] }),
    line('user', NOW - 2 * MIN, { content: [{ type: 'tool_result' }] })
  ].join('\n'), 'Code');
  assert.equal(going.ended, false);
  assert.equal(going.lastLineTs, NOW - 2 * MIN);
  const done = parseTranscript([
    line('assistant', NOW - 5 * MIN, { id: 'm1', usage, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'SubagentHandback' }] }),
    line('user', NOW - 4 * MIN, { content: [{ type: 'tool_result' }] })
  ].join('\n'), 'Code');
  assert.equal(done.ended, true);
  const resumed = parseTranscript([
    line('assistant', NOW - 9 * MIN, { id: 'm1', usage, stop_reason: 'end_turn', content: [{ type: 'text' }] }),
    line('assistant', NOW - 1 * MIN, { id: 'm2', usage, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] })
  ].join('\n'), 'Code');
  assert.equal(resumed.ended, false);
});
