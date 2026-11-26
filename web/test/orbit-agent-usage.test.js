import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageView, checkWords, USAGE_WORDS } from '../src/lib/orbit/agent-usage.js';

// The Agents card's Tokens tab (Orbit Phase 6). An invented roster and invented counts.
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = new Date(2026, 7, 12, 15, 20).getTime();
const roster = { agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }, { key: 'quill', name: 'Quill' }] };
const env = data => ({ status: 'ok', data, fetchedAt: NOW, error: null });
const hour = Math.floor(NOW / HOUR) * HOUR;
const on = (extra = {}) => ({
  state: 'on', port: 8323, since: new Date(2026, 7, 10, 9, 0).getTime(), lastAt: NOW - MIN,
  agents: [
    { key: 'atlas', tokens24h: 1250000, tokens7d: 9800000, cacheRead7d: 1 },
    { key: 'forge', tokens24h: 70000, tokens7d: 310000, cacheRead7d: 0 }
  ],
  other: { tokens24h: 4200, tokens7d: 51000, cacheRead7d: 0 },
  redacted: false,
  check: {
    from: hour - DAY, to: hour,
    rows: [
      { key: 'atlas', otel: 1200000, transcripts: 1150000, verdict: 'matches' },
      { key: 'forge', otel: 70000, transcripts: 210000, verdict: 'differs' },
      { key: 'quill', otel: 0, transcripts: 0, verdict: 'small' }
    ],
    total: { otel: 1300000, transcripts: 1400000, verdict: 'matches' }
  },
  ...extra
});

test('each state with nothing to draw says why, in words', () => {
  assert.equal(usageView({ env: undefined, roster, now: NOW }).note, USAGE_WORDS.oldServer);
  assert.equal(usageView({ env: { status: 'ok', data: null }, roster, now: NOW }).note, USAGE_WORDS.oldServer);
  assert.equal(usageView({ env: { status: 'unavailable', error: 'it broke', data: null }, roster, now: NOW }).note, 'Unavailable: it broke.');
  for (const state of ['unset', 'off', 'failed', 'waiting']) {
    const v = usageView({ env: env({ state }), roster, now: NOW });
    assert.equal(v.note, USAGE_WORDS[state], state);
    assert.deepEqual(v.rows, [], state);
  }
  assert.equal(usageView({ env: env({ state: 'later' }), roster, now: NOW }).note, USAGE_WORDS.oldServer, 'a state this page does not know');
  assert.equal(usageView({ env: env(on()), roster: { agents: [] }, now: NOW }).note, USAGE_WORDS.noRoster);
  assert.match(USAGE_WORDS.waiting, /^No data yet\./);
});

test('one row per roster agent, in roster order, with its figures and its check', () => {
  const v = usageView({ env: env(on()), roster, now: NOW });
  assert.equal(v.note, null);
  assert.deepEqual(v.rows.map(r => [r.key, r.name, r.day, r.week, r.check, r.differs]), [
    ['atlas', 'Atlas', '1.3M', '9.8M', 'matches the transcripts', false],
    ['forge', 'Forge', '70K', '310K', 'transcripts say 210K', true],
    ['quill', 'Quill', '0', '0', 'too little to check', false]
  ]);
  assert.equal(v.rows[1].agent.index, 1);
  assert.deepEqual(v.other, { day: '4.2K', week: '51K' });
  assert.equal(v.differs, 1);
  assert.equal(v.total.text, 'All sessions, last 24 h: 1.3M from OpenTelemetry, 1.4M in the transcripts');
  assert.equal(v.total.words, 'they match');
  assert.equal(v.sub, 'new tokens from OpenTelemetry since Mon 08-10');
  assert.equal(v.checkNote, null);
  assert.equal(v.redacted, false);
});

test('a total that differs is counted and said so; a missing check says when it starts', () => {
  const differs = usageView({ env: env(on({ check: { ...on().check, total: { otel: 1e6, transcripts: 3e6, verdict: 'differs' } } })), roster, now: NOW });
  assert.equal(differs.total.words, 'they differ');
  assert.equal(differs.differs, 2);
  const none = usageView({ env: env(on({ check: null })), roster, now: NOW });
  assert.equal(none.total, null);
  assert.equal(none.checkNote, USAGE_WORDS.checkLater);
  assert.ok(none.rows.every(r => r.check === null && r.differs === false));
  assert.equal(none.differs, 0);
});

test('old metrics show their age in the sub line; fresh ones do not', () => {
  assert.equal(usageView({ env: env(on({ lastAt: NOW - 15 * MIN })), roster, now: NOW }).sub, 'new tokens from OpenTelemetry since Mon 08-10');
  assert.equal(usageView({ env: env(on({ lastAt: NOW - 16 * MIN })), roster, now: NOW }).sub, 'new tokens from OpenTelemetry since Mon 08-10 · last metrics 16 min ago');
  assert.equal(usageView({ env: env(on({ lastAt: NOW - 5 * HOUR })), roster, now: NOW }).sub, 'new tokens from OpenTelemetry since Mon 08-10 · last metrics 5 h ago');
  assert.equal(usageView({ env: env(on({ since: null })), roster, now: NOW }).sub, 'new tokens from OpenTelemetry');
});

test('the redacted note shows only on an exact true; an agent the server omits reads 0', () => {
  assert.equal(usageView({ env: env(on({ redacted: true })), roster, now: NOW }).redacted, true);
  assert.equal(usageView({ env: env(on({ redacted: 'yes' })), roster, now: NOW }).redacted, false);
  const v = usageView({ env: env(on({ agents: [], other: null })), roster, now: NOW });
  assert.deepEqual(v.rows.map(r => r.week), ['0', '0', '0']);
  assert.equal(v.other, null);
});

test('checkWords: differs names the transcripts\' figure; an unknown verdict says nothing', () => {
  assert.equal(checkWords(null), null);
  assert.equal(checkWords({ verdict: 'differs', transcripts: 3600000 }), 'transcripts say 3.6M');
  assert.equal(checkWords({ verdict: 'matches' }), 'matches the transcripts');
  assert.equal(checkWords({ verdict: 'small' }), 'too little to check');
  assert.equal(checkWords({ verdict: 'odd' }), null);
});
