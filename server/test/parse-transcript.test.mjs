import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTranscript, totalTokens, cacheReadTokens, requestKey, dropCopiedRequests } from '../lib/parse-transcript.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// One transcript line as Claude Code writes it for an API response: one line
// per content block, each stamped with the request id and the message id, each
// repeating the response's usage. Synthetic ids and no content, never a copy of
// a real transcript.
const line = ({ requestId, messageId, ts, block = 'text', model = 'claude-opus-5', usage }) => JSON.stringify({
  type: 'assistant',
  timestamp: ts,
  sessionId: 'sess-1',
  ...(requestId === undefined ? {} : { requestId }),
  message: {
    model,
    ...(messageId === undefined ? {} : { id: messageId }),
    role: 'assistant',
    content: [{ type: block }],
    usage
  }
});
const USAGE = { input_tokens: 3, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000 };
const sum = records => records.reduce((a, r) => a + r.tokens, 0);

test('totalTokens sums input, output and cache-creation, excluding cache-read', () => {
  assert.equal(totalTokens({
    input_tokens: 2,
    output_tokens: 107,
    cache_creation_input_tokens: 27921,
    cache_read_input_tokens: 1000
  }), 28030);
});

test('totalTokens treats missing fields as zero', () => {
  assert.equal(totalTokens({ input_tokens: 5 }), 5);
  assert.equal(totalTokens({}), 0);
});

// Guards the exclusion itself, not just the arithmetic above: a huge cache-read
// figure must not move the result at all, even when it dwarfs the new-token
// fields. This is what actually prevents a regression back to summing all four
// fields (which the old expectation of 29030 above encoded).
test('totalTokens is unaffected by a large cache_read_input_tokens value', () => {
  const withoutCacheRead = totalTokens({ input_tokens: 2, output_tokens: 107, cache_creation_input_tokens: 27921 });
  const withHugeCacheRead = totalTokens({
    input_tokens: 2,
    output_tokens: 107,
    cache_creation_input_tokens: 27921,
    cache_read_input_tokens: 50_000_000
  });
  assert.equal(withHugeCacheRead, withoutCacheRead);
  assert.equal(withHugeCacheRead, 28030);
});

test('cacheReadTokens reads only the cache-read field, defaulting missing to zero', () => {
  assert.equal(cacheReadTokens({ cache_read_input_tokens: 1000 }), 1000);
  assert.equal(cacheReadTokens({}), 0);
  assert.equal(cacheReadTokens(null), 0);
});

test('extracts usage records from a Claude Code transcript', () => {
  const parsed = parseTranscript(read('transcript-code.jsonl'), 'Code');
  assert.equal(parsed.surface, 'Code');
  assert.ok(parsed.records.length > 0);
  for (const r of parsed.records) {
    assert.equal(typeof r.model, 'string');
    assert.ok(r.tokens > 0);
    assert.ok(Number.isFinite(r.ts));
  }
});

test('the same parser handles a Cowork transcript', () => {
  const parsed = parseTranscript(read('transcript-cowork.jsonl'), 'Cowork');
  assert.equal(parsed.surface, 'Cowork');
  assert.ok(parsed.records.length > 0);
});

test('title comes from the ai-title record, not the usage rows', () => {
  const text = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's1', cwd: '/x', gitBranch: 'main', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Build the thing', timestamp: null, sessionId: 's1' })
  ].join('\n');
  const parsed = parseTranscript(text, 'Code');
  assert.equal(parsed.title, 'Build the thing');
  assert.equal(parsed.sessionId, 's1');
  assert.equal(parsed.cwd, '/x');
  assert.equal(parsed.gitBranch, 'main');
});

test('title is null when no ai-title record exists', () => {
  const text = JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's2', message: { model: 'm', usage: { input_tokens: 1 } } });
  assert.equal(parseTranscript(text, 'Code').title, null);
});

test('malformed lines are skipped, not fatal', () => {
  const text = [
    'not json at all',
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's3', message: { model: 'm', usage: { input_tokens: 4 } } }),
    '{"truncated": '
  ].join('\n');
  const parsed = parseTranscript(text, 'Code');
  assert.equal(parsed.records.length, 1);
});

test('detached HEAD is normalised away', () => {
  const text = JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's4', gitBranch: 'HEAD', message: { model: 'm', usage: { input_tokens: 1 } } });
  assert.equal(parseTranscript(text, 'Code').gitBranch, null);
});

test('records carry cacheReadTokens alongside the new-token tokens field, kept but not folded in', () => {
  const text = JSON.stringify({
    type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's5',
    message: { model: 'claude-opus-5', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 900 } }
  });
  const [record] = parseTranscript(text, 'Code').records;
  assert.equal(record.tokens, 5);
  assert.equal(record.cacheReadTokens, 900);
});

test('a row with only cache-read usage (no new tokens) is still kept, not dropped by the tokens<=0 gate', () => {
  const text = JSON.stringify({
    type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's6',
    message: { model: 'claude-opus-5', usage: { cache_read_input_tokens: 5000 } }
  });
  const [record] = parseTranscript(text, 'Code').records;
  assert.ok(record, 'expected the cache-read-only row to survive into records');
  assert.equal(record.tokens, 0);
  assert.equal(record.cacheReadTokens, 5000);
});

// The 2026-10-20 bug: every line of a response repeats its usage, so summing
// lines counted a response once per content block (2.3x a real week).
test('a response written as several lines that repeat its usage counts once', () => {
  const text = ['thinking', 'text', 'tool_use'].map((block, i) => line({
    requestId: 'req_A', messageId: 'msg_A', ts: `2026-10-20T10:00:0${i}.000Z`, block, usage: USAGE
  })).join('\n');
  const { records } = parseTranscript(text, 'Code');
  assert.equal(records.length, 1);
  assert.equal(records[0].tokens, 1203);
  assert.equal(records[0].cacheReadTokens, 50000);
});

test('a response whose later lines report more output counts its final, largest reading', () => {
  // Seen in 266 of 7,433 multi-line responses on 2026-10-20: early lines are
  // written mid-stream with a partial output count; only output_tokens differs.
  const text = [12, 12, 480].map((output_tokens, i) => line({
    requestId: 'req_A', messageId: 'msg_A', ts: `2026-10-20T10:00:0${i}.000Z`, usage: { ...USAGE, output_tokens }
  })).join('\n');
  const { records } = parseTranscript(text, 'Code');
  assert.equal(records.length, 1);
  assert.equal(records[0].tokens, 3 + 480 + 1000);
});

test('each request is one record, with the model and time of its first line', () => {
  const text = [
    line({ requestId: 'req_A', messageId: 'msg_A', ts: '2026-10-20T10:00:00.000Z', block: 'thinking', usage: USAGE }),
    line({ requestId: 'req_A', messageId: 'msg_A', ts: '2026-10-20T10:00:05.000Z', block: 'tool_use', usage: USAGE }),
    line({ requestId: 'req_B', messageId: 'msg_B', ts: '2026-10-20T10:01:00.000Z', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 } }),
    line({ requestId: 'req_B', messageId: 'msg_B', ts: '2026-10-20T10:01:09.000Z', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 } })
  ].join('\n');
  const { records } = parseTranscript(text, 'Code');
  assert.equal(records.length, 2);
  assert.equal(records[0].ts, Date.parse('2026-10-20T10:00:00.000Z'));
  assert.equal(records[0].model, 'claude-opus-5');
  assert.equal(records[1].ts, Date.parse('2026-10-20T10:01:00.000Z'));
  assert.equal(records[1].model, 'claude-sonnet-5');
  assert.equal(sum(records), 1203 + 30);
});

test('a line missing its request id or its message id counts on its own, as every line used to', () => {
  // The repo's anonymized fixtures are this shape: one zeroed message id, no request id.
  const text = [
    line({ messageId: 'msg_X', ts: '2026-10-20T10:00:00.000Z', usage: USAGE }),
    line({ messageId: 'msg_X', ts: '2026-10-20T10:00:01.000Z', usage: USAGE }),
    line({ requestId: 'req_Y', ts: '2026-10-20T10:00:02.000Z', usage: USAGE }),
    line({ requestId: 'req_Y', ts: '2026-10-20T10:00:03.000Z', usage: USAGE }),
    line({ requestId: '', messageId: '', ts: '2026-10-20T10:00:04.000Z', usage: USAGE }),
    line({ requestId: '', messageId: '', ts: '2026-10-20T10:00:05.000Z', usage: USAGE })
  ].join('\n');
  const { records } = parseTranscript(text, 'Code');
  assert.equal(records.length, 6);
  assert.equal(sum(records), 6 * 1203);
  assert.ok(records.every(r => r.requestKey === null));
});

test('lines that share only a request id, or only a message id, are different requests', () => {
  const text = [
    line({ requestId: 'req_A', messageId: 'msg_1', ts: '2026-10-20T10:00:00.000Z', usage: USAGE }),
    line({ requestId: 'req_A', messageId: 'msg_2', ts: '2026-10-20T10:00:01.000Z', usage: USAGE }),
    line({ requestId: 'req_B', messageId: 'msg_1', ts: '2026-10-20T10:00:02.000Z', usage: USAGE })
  ].join('\n');
  assert.equal(parseTranscript(text, 'Code').records.length, 3);
});

test('requestKey needs both ids and keeps them apart', () => {
  assert.equal(requestKey({ requestId: 'req_A', message: {} }), null);
  assert.equal(requestKey({ message: { id: 'msg_A' } }), null);
  assert.equal(requestKey(null), null);
  assert.notEqual(requestKey({ requestId: 'a b', message: { id: 'c' } }), requestKey({ requestId: 'a', message: { id: 'b c' } }));
  assert.equal(requestKey({ requestId: 'req_A', message: { id: 'msg_A' } }), requestKey({ requestId: 'req_A', message: { id: 'msg_A' } }));
});

// A forked subagent's transcript opens with a copy of the parent's line that
// launched it: same request and message ids, same usage, same timestamp as the
// parent's tool_use line, which comes after the response's first line (seen
// twice on 2026-10-16).
const parentText = [
  line({ requestId: 'req_P', messageId: 'msg_P', ts: '2026-10-20T10:00:00.000Z', block: 'thinking', usage: USAGE }),
  line({ requestId: 'req_P', messageId: 'msg_P', ts: '2026-10-20T10:00:00.010Z', block: 'text', usage: USAGE }),
  line({ requestId: 'req_P', messageId: 'msg_P', ts: '2026-10-20T10:00:12.000Z', block: 'tool_use', usage: USAGE })
].join('\n');
const subagentText = [
  line({ requestId: 'req_P', messageId: 'msg_P', ts: '2026-10-20T10:00:12.000Z', block: 'tool_use', usage: USAGE }),
  line({ requestId: 'req_S', messageId: 'msg_S', ts: '2026-10-20T10:00:20.000Z', usage: { input_tokens: 7, output_tokens: 8 } })
].join('\n');

test('a request copied into a second transcript counts once, in the transcript that wrote it first', () => {
  const parent = parseTranscript(parentText, 'Code');
  const sub = parseTranscript(subagentText, 'Code');
  // Whichever file the walk reaches first, the earlier copy is the one kept.
  for (const input of [[parent, sub], [sub, parent]]) {
    const out = dropCopiedRequests(input);
    const p = out[input.indexOf(parent)];
    const s = out[input.indexOf(sub)];
    assert.deepEqual(p.records.map(r => r.tokens), [1203]);
    assert.deepEqual(s.records.map(r => r.tokens), [15], 'the subagent keeps only its own request');
  }
});

test('dropping copies leaves its input alone and keeps lines that carry no ids', () => {
  const noIds = parseTranscript([
    line({ ts: '2026-10-20T10:00:00.000Z', usage: USAGE }),
    line({ ts: '2026-10-20T10:00:01.000Z', usage: USAGE })
  ].join('\n'), 'Code');
  const sub = parseTranscript(subagentText, 'Code');
  const parent = parseTranscript(parentText, 'Code');
  const out = dropCopiedRequests([noIds, parent, sub, structuredClone(noIds)]);
  assert.equal(out[0].records.length, 2);
  assert.equal(out[3].records.length, 2);
  assert.equal(sub.records.length, 2, 'the input transcript is not mutated');
  assert.equal(out[2].records.length, 1);
});
