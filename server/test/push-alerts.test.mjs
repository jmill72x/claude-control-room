import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushableFrom, newKeys, prune, observableSources } from '../lib/push-alerts.mjs';

const cron = (key, text) => ({ kind: 'cron', key, text });
const limit = (key, text) => ({ kind: 'limit', key, text });
const service = (key, text) => ({ kind: 'service', key, text });
const isCounted = msg => /jobs? failed|services? (is|are) down|needs? attention/i.test(msg);

test('a limit alert pushes its real text', () => {
  const out = pushableFrom([limit('limit:W', 'Weekly · all models at 88%')]);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /Weekly · all models at 88%/);
});

test('a cron alert never sends the job name or its exit status', () => {
  const out = pushableFrom([cron('cron:net.example.secret-job', 'secret-job cron Failed · 429')]);
  assert.equal(out.length, 1);
  const blob = `${out[0].title} ${out[0].message}`;
  assert.ok(!blob.includes('secret-job'), 'job name must not leave the machine');
  assert.ok(!blob.includes('429'), 'exit status must not leave the machine');
  assert.equal(out[0].message, '1 job failed — open the dashboard for detail');
});

test('several failing crons collapse into one counted message', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed'), cron('cron:c', 'c failed')]);
  const crons = out.filter(o => isCounted(o.message));
  assert.equal(crons.length, 1);
  assert.match(crons[0].message, /^3 jobs failed/);
});

test('the collapsed cron entry still carries every cron key, so each is deduped separately', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed')]);
  const entry = out.find(o => isCounted(o.message));
  assert.deepEqual([...entry.keys].sort(), ['cron:a', 'cron:b']);
});

// The allowlist is the point: a kind that is missing, misspelled, or invented
// later by someone who has not read the comment must still be counted, never
// quoted — a denylist would disclose it by default instead.
test('an alert of an unrecognized kind is counted, never quoted', () => {
  const out = pushableFrom([{ kind: 'session', key: 'session:x', text: '/Users/jeff/private/path leaked' }]);
  assert.equal(out.length, 1);
  assert.ok(!out[0].message.includes('/Users/jeff/private/path'), 'unknown kinds must not be disclosed by default');
  assert.match(out[0].message, /needs? attention/i);
});

test('newKeys returns only alerts not already notified', () => {
  const alerts = [limit('limit:A', 'A at 90%'), limit('limit:B', 'B at 91%')];
  assert.deepEqual(newKeys(alerts, { 'limit:A': 1 }), ['limit:B']);
});

test('newKeys on an empty notified set returns everything', () => {
  const alerts = [limit('limit:A', 'A at 90%')];
  assert.deepEqual(newKeys(alerts, {}), ['limit:A']);
});

test('prune forgets a key whose condition has cleared, when its kind is observable', () => {
  const pruned = prune({ 'limit:A': 1, 'limit:B': 2 }, [limit('limit:A', 'A at 90%')], new Set(['limit']));
  assert.deepEqual(Object.keys(pruned), ['limit:A']);
});

test('prune keeps a key whose kind is not observable this run, even though the alert is absent', () => {
  // No observable set passed at all — the safe default is "nothing is observable",
  // so nothing is forgotten. This is the cold-start case: a restart where the
  // usage collector has not written yet must not look like every limit clearing.
  const pruned = prune({ 'limit:A': 1 }, []);
  assert.deepEqual(pruned, { 'limit:A': 1 });
});

test('prune keeps a key of one kind while forgetting a cleared key of an observable kind', () => {
  const pruned = prune(
    { 'limit:A': 1, 'cron:x': 2 },
    [],
    new Set(['limit']) // only limit is observable this run; cron is not
  );
  assert.deepEqual(pruned, { 'cron:x': 2 }, 'limit:A cleared and was observable, so it is forgotten; cron:x was not observable, so it is kept');
});

test('a cleared then returning condition notifies again, once its kind is observable', () => {
  const a = [limit('limit:A', 'A at 90%')];
  let sent = { 'limit:A': 1 };
  sent = prune(sent, [], new Set(['limit']));  // condition cleared, and we could see that
  assert.deepEqual(newKeys(a, sent), ['limit:A']); // and returns
});

test('an alert with no key is dropped rather than pushed unkeyed', () => {
  assert.deepEqual(pushableFrom([{ kind: 'limit', text: 'no key' }]), []);
});

test('observableSources reports usage-backed keys only when the usage panel is ok', () => {
  assert.deepEqual([...observableSources({ usage: { status: 'ok' } })].sort(), ['credits', 'limit', 'projection']);
  assert.deepEqual([...observableSources({ usage: { status: 'stale' } })].sort(), ['credits']);
});

// Observability is per SOURCE, not per kind. Launchd being readable says
// nothing about the ingest poster, and vice versa.
test('observableSources treats launchd and ingested crons as separate sources', () => {
  assert.deepEqual([...observableSources({ crons: { status: 'ok' } })].filter(k => k.startsWith('cron')), ['cron:launchd']);
  assert.deepEqual([...observableSources({ ingestCrons: { status: 'ok' } })].filter(k => k.startsWith('cron')), ['cron:ingest']);
  assert.deepEqual([...observableSources({ crons: { status: 'unavailable' }, ingestCrons: { status: 'stale' } })].filter(k => k.startsWith('cron')), []);
});

test('prune keeps an ingested cron key while launchd alone is readable, and forgets a cleared launchd key', () => {
  const pruned = prune(
    { 'cron:launchd:a': 1, 'cron:ingest:b': 2 },
    [],
    observableSources({ crons: { status: 'ok' } }) // poster gap: ingestCrons absent
  );
  assert.deepEqual(pruned, { 'cron:ingest:b': 2 });
});

// Credits alerts read the ingested feed when it is current and fall back to
// config otherwise. So the source is observable when the feed is current (it
// drove the alert) or when it has never been posted (config drove it) — but a
// STALE feed means the alert's real source went quiet, and its key must be kept.
test('observableSources reports credits when the ingested feed is current or was never posted, but not when it is stale', () => {
  assert.ok(observableSources({ ingestCredits: { status: 'ok' } }).has('credits'));
  assert.ok(observableSources({ ingestCredits: { status: 'unavailable' } }).has('credits'));
  assert.ok(observableSources({}).has('credits'));
  assert.ok(observableSources(undefined).has('credits'));
  assert.ok(!observableSources({ ingestCredits: { status: 'stale' } }).has('credits'));
});

test('prune keeps a credits key through an ingest gap, even though the alert is absent that run', () => {
  const pruned = prune({ 'credits:promo': 1 }, [], observableSources({ ingestCredits: { status: 'stale' } }));
  assert.deepEqual(pruned, { 'credits:promo': 1 });
});

test('a stale automatic-credits read makes credits unobservable, so a grant key survives the gap', () => {
  assert.ok(!observableSources({ accountCredits: { status: 'stale' } }).has('credits'));
  assert.ok(observableSources({ accountCredits: { status: 'ok' } }).has('credits'));
});

test("the board's size alert goes out as it is written: it carries only a percent", () => {
  const out = pushableFrom([{ text: 'The board is at 78% of its save limit', kind: 'board', key: 'board:size' }]);
  assert.deepEqual(out, [{ keys: ['board:size'], title: 'Control Room', message: 'The board is at 78% of its save limit' }]);
});

test('the board alert is forgotten only while the board can be read', () => {
  const sent = { 'board:size': 1 };
  assert.ok(observableSources({ board: { status: 'ok' } }).has('board'));
  assert.ok(!observableSources({ board: { status: 'unavailable' } }).has('board'));
  assert.deepEqual(prune(sent, [], observableSources({ board: { status: 'ok' } })), {}, 'the board shrank: next time it notifies again');
  assert.deepEqual(prune(sent, [], observableSources({})), sent, 'no reading: kept');
});

// The health strip (Orbit plan, Phase 2): a down service is counted like a
// failed job, in words of its own, and never named.
test('a down service pushes a count, never its name', () => {
  const one = pushableFrom([service('service:launchd:Secret tunnel', 'Secret tunnel is not running')]);
  assert.equal(one.length, 1);
  assert.equal(one[0].message, '1 service is down — open the dashboard for detail');
  assert.ok(!JSON.stringify(one).includes('Secret tunnel is'), 'the name stays on the machine');
  const two = pushableFrom([service('service:a', 'A is not running'), service('service:b', 'B is not running')]);
  assert.equal(two[0].message, '2 services are down — open the dashboard for detail');
});

test('each counted kind is its own message, carrying only its own keys', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), service('service:t', 'T is not running'), { kind: 'mystery', key: 'mystery:1', text: 'x' }]);
  const byText = Object.fromEntries(out.map(o => [o.message.split(' — ')[0], o.keys]));
  assert.deepEqual(byText, { '1 job failed': ['cron:a'], '1 service is down': ['service:t'], '1 item needs attention': ['mystery:1'] });
});

test('a down service can be forgotten only while the health panel reports', () => {
  assert.ok(observableSources({ health: { status: 'ok' } }).has('service'));
  assert.ok(!observableSources({ health: { status: 'stale' } }).has('service'));
  assert.ok(!observableSources({}).has('service'));
});
