import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUsage, UsageParseError } from '../lib/parse-usage.mjs';

// resolveReset() only resolves a printed zone when it matches the host's
// own zone (see lib/parse-usage.mjs); it returns null on any mismatch
// rather than guess an offset. A fixture with a zone hardcoded to a single
// literal (e.g. "America/New_York") therefore only exercises the resolved
// path on that one host — everywhere else resetsAt comes back null and any
// assertion that it's a populated ISO string fails for reasons unrelated to
// what's under test. HOST_ZONE keeps the fixture's printed zone equal to
// whatever zone the suite is actually running under, so the resolved path
// is exercised on every host.
const HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Aug 5 at 12:09pm (${HOST_ZONE})
Current week (all models): 5% used · resets Aug 10 at 8pm (${HOST_ZONE})
Current week (Fable): 0% used

What's contributing to your limits usage?

Last 24h · 1349 requests · 2 sessions
Last 7d · 3338 requests · 9 sessions
`;

// Built via local wall-clock components, not a fixed UTC offset string.
// resolveReset() constructs reset dates with `new Date(year, month, day,
// hour, ...)`, which always uses the runtime's local offset — so NOW must
// use the same construction to stay comparable across timezones. A fixed
// '...-04:00' instant only sorts correctly relative to those wall-clock
// dates on hosts near UTC-4; anywhere else (e.g. TZ=Asia/Tokyo) the
// comparison silently inverts.
const NOW = new Date(2026, 7, 5, 12, 0, 0); // Aug 5 2026, 12:00 local

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

test('a limit-looking line with a malformed percentage throws', () => {
  const bad = `You are currently using your subscription to power your Claude Code usage

Current session: fifty% used
`;
  assert.throws(() => parseUsage(bad, NOW), (err) => {
    assert.ok(err instanceof UsageParseError);
    assert.equal(err.name, 'UsageParseError');
    return true;
  });
});

test('a malformed limit line throws even when a good limit line is present', () => {
  const mixed = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Aug 5 at 12:09pm (${HOST_ZONE})
Current week (all models): garbled beyond recognition
`;
  assert.throws(() => parseUsage(mixed, NOW), UsageParseError);
});

test('a garbled or concatenated percentage exceeding the plausibility bound throws', () => {
  const bad = `You are currently using your subscription to power your Claude Code usage

Current session: 123456% used
`;
  assert.throws(() => parseUsage(bad, NOW), UsageParseError);
});

test('a legitimately high percentage under the plausibility bound is accepted', () => {
  const overage = `You are currently using your subscription to power your Claude Code usage

Current session: 118% used
`;
  const { limits } = parseUsage(overage, NOW);
  assert.equal(limits[0].pct, 118);
});

test('reset with a zone matching the host resolves to an ISO string', () => {
  const sample = `You are currently using your subscription to power your Claude Code usage

Current session: 10% used · resets Aug 5 at 3pm (${HOST_ZONE})
`;
  const { limits } = parseUsage(sample, NOW);
  assert.equal(typeof limits[0].resetsAt, 'string');
  assert.ok(new Date(limits[0].resetsAt) > NOW);
});

test('reset with a zone that does not match the host resolves to null', () => {
  const mismatchZone = HOST_ZONE === 'Europe/London' ? 'Asia/Tokyo' : 'Europe/London';
  const sample = `You are currently using your subscription to power your Claude Code usage

Current session: 10% used · resets Aug 5 at 3pm (${mismatchZone})
`;
  const { limits } = parseUsage(sample, NOW);
  assert.equal(limits[0].resetsAt, null);
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
