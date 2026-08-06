import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTranscript, totalTokens, cacheReadTokens } from '../lib/parse-transcript.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

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
