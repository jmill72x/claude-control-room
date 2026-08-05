import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUsage, UsageParseError } from '../lib/parse-usage.mjs';

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Aug 5 at 12:09pm (America/New_York)
Current week (all models): 5% used · resets Aug 10 at 8pm (America/New_York)
Current week (Fable): 0% used

What's contributing to your limits usage?

Last 24h · 1349 requests · 2 sessions
Last 7d · 3338 requests · 9 sessions
`;

const NOW = new Date('2026-08-05T12:00:00-04:00');

test('parses every limit line in order', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(limits.length, 3);
  assert.equal(limits[0].label, 'Current session');
  assert.equal(limits[0].pct, 24);
  assert.equal(limits[1].label, 'Weekly · all models');
  assert.equal(limits[1].pct, 5);
});

test('reads the model-scoped label rather than assuming Opus', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(limits[2].label, 'Weekly · Fable');
  assert.equal(limits[2].pct, 0);
});

test('resolves reset timestamps to ISO strings', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(typeof limits[0].resetsAt, 'string');
  assert.ok(new Date(limits[0].resetsAt) > NOW);
});

test('a limit with no reset clause yields null, not a guess', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(limits[2].resetsAt, null);
});

test('extracts request and session counts', () => {
  const { requests, sessions } = parseUsage(SAMPLE, NOW);
  assert.equal(requests.last24h, 1349);
  assert.equal(sessions.last24h, 2);
  assert.equal(requests.last7d, 3338);
  assert.equal(sessions.last7d, 9);
});

test('throws on unrecognised output instead of returning zeros', () => {
  const bad = readFileSync(new URL('./fixtures/usage-malformed.txt', import.meta.url), 'utf8');
  assert.throws(() => parseUsage(bad, NOW), UsageParseError);
});

test('parses the real captured fixture', () => {
  const real = readFileSync(new URL('./fixtures/usage-ok.txt', import.meta.url), 'utf8');
  const { limits } = parseUsage(real, new Date());
  assert.ok(limits.length >= 2);
  for (const l of limits) {
    assert.ok(l.pct >= 0 && l.pct <= 1000);
    assert.equal(typeof l.label, 'string');
  }
});
