import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts } from '../lib/alerts.mjs';

const env = data => ({ data, fetchedAt: Date.now(), status: 'ok', error: null });
const NOW = Date.parse('2026-08-05T12:00:00Z');
const DAY = 24 * 3600 * 1000;

test('an ingested cron that failed raises an alert (spec §6: any non-zero exit)', () => {
  // Ingested crons run on Claude Cloud; reporting in here is the only way their
  // failure is ever seen. Reading snapshot.crons alone raised nothing at all.
  const alerts = buildAlerts(
    { crons: env([]), ingestCrons: env([{ name: 'cloud-digest', ok: false, last: 'Failed · 1' }]) },
    { warnThreshold: 85 },
    NOW
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /cloud-digest/);
  assert.match(alerts[0].text, /Failed/);
});

test('local and ingested cron failures both raise, together', () => {
  const alerts = buildAlerts(
    {
      crons: env([{ name: 'nightly', ok: false, last: 'Failed · 2' }]),
      ingestCrons: env([{ name: 'cloud-digest', ok: false }])
    },
    { warnThreshold: 85 },
    NOW
  );
  assert.equal(alerts.length, 2);
});

test('a cron whose result is unknown is not reported as failing', () => {
  const alerts = buildAlerts(
    { ingestCrons: env([{ name: 'cloud-digest' }]) },
    { warnThreshold: 85 },
    NOW
  );
  assert.deepEqual(alerts, []);
});

test('a non-array ingest feed cannot throw the alert builder', () => {
  const alerts = buildAlerts(
    { crons: env(null), ingestCrons: env({ nope: true }) },
    { warnThreshold: 85 },
    NOW
  );
  assert.deepEqual(alerts, []);
});

test('a limit at or over the threshold raises', () => {
  const alerts = buildAlerts(
    { usage: env({ limits: [{ label: 'Current week', pct: 91 }] }) },
    { warnThreshold: 85 },
    NOW
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /91%/);
});

test('ingested credits outrank config credits for the promo warning', () => {
  const config = { warnThreshold: 85, credits: { promoExpiresOn: '2027-01-01' } };
  const alerts = buildAlerts(
    { ingestCredits: env({ promoExpiresOn: new Date(NOW + 5 * DAY).toISOString() }) },
    config,
    NOW
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /expires in 5 days/);
});

test('config credits still drive the warning when nothing has been ingested', () => {
  const alerts = buildAlerts(
    {},
    { warnThreshold: 85, credits: { updatedAt: new Date(NOW - 20 * DAY).toISOString() } },
    NOW
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /14 days old/);
});

const snapshotWith = limits => ({
  crons: { data: [] },
  ingestCrons: { data: [] },
  usage: { status: 'ok', data: { limits } }
});

test('a limit projected to exceed 100% raises an alert', () => {
  const limits = [{ label: 'Weekly · all models', pct: 60, pace: { state: 'ahead', projectedPct: 140 } }];
  const alerts = buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now());
  assert.ok(alerts.some(a => /projected/i.test(a.text) && /140/.test(a.text)));
});

test('a projection at or under 100% raises nothing', () => {
  const limits = [{ label: 'Weekly · all models', pct: 40, pace: { state: 'on', projectedPct: 100 } }];
  assert.deepEqual(buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now()), []);
});

test('no projection alert below the confidence guard', () => {
  const limits = [{ label: 'Current session', pct: 40, pace: { state: 'too-early', projectedPct: null } }];
  assert.deepEqual(buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now()), []);
});

test('no projection alert when the window length is unknown', () => {
  const limits = [{ label: 'Current session', pct: 90, pace: { state: 'unknown-window', projectedPct: null } }];
  const alerts = buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now());
  assert.equal(alerts.filter(a => /projected/i.test(a.text)).length, 0);
});

test('a limit with no pace object at all is handled', () => {
  const limits = [{ label: 'Weekly · Opus', pct: 10 }];
  assert.deepEqual(buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now()), []);
});

test('every alert carries a kind and a key', () => {
  const snapshot = {
    crons: { status: 'ok', data: [{ name: 'nightly', label: 'net.example.nightly', ok: false, last: 'Failed · 1' }] },
    ingestCrons: { data: [] },
    usage: { status: 'ok', data: { limits: [{ label: 'Weekly · all models', pct: 90, pace: { projectedPct: 140 } }] } }
  };
  const alerts = buildAlerts(snapshot, { warnThreshold: 85 }, Date.now());
  for (const a of alerts) {
    assert.ok(typeof a.text === 'string' && a.text.length > 0);
    assert.ok(['cron', 'limit', 'projection', 'credits'].includes(a.kind));
    assert.ok(typeof a.key === 'string' && a.key.length > 0);
  }
});

test('a limit alert keeps the same key as its percentage moves', () => {
  const at = pct => buildAlerts(
    { crons: { data: [] }, ingestCrons: { data: [] },
      usage: { status: 'ok', data: { limits: [{ label: 'Weekly · all models', pct }] } } },
    { warnThreshold: 85 }, Date.now()
  ).find(a => a.kind === 'limit');
  assert.equal(at(86).key, at(87).key);
  assert.notEqual(at(86).text, at(87).text);
});

test('a projection alert keeps the same key as the projection moves', () => {
  const at = projectedPct => buildAlerts(
    { crons: { data: [] }, ingestCrons: { data: [] },
      usage: { status: 'ok', data: { limits: [{ label: 'Weekly · Opus', pct: 50, pace: { projectedPct } }] } } },
    { warnThreshold: 85 }, Date.now()
  ).find(a => a.kind === 'projection');
  assert.equal(at(140).key, at(150).key);
});

test('two limits produce distinct keys', () => {
  const alerts = buildAlerts(
    { crons: { data: [] }, ingestCrons: { data: [] },
      usage: { status: 'ok', data: { limits: [
        { label: 'Weekly · all models', pct: 90 }, { label: 'Weekly · Opus', pct: 91 }
      ] } } },
    { warnThreshold: 85 }, Date.now()
  );
  const keys = alerts.map(a => a.key);
  assert.equal(new Set(keys).size, keys.length);
});

// The key carries the SOURCE as well as the label. The notifier forgets a key
// only when it could observe that key's source this run; a bare `cron:label`
// could not say whether it came from launchd or the ingest poster, so an
// ingested job's key was forgotten whenever launchd alone was readable — and
// re-pushed on every poster gap.
test('a launchd cron alert keys on its source and label, which is stable across runs', () => {
  const alerts = buildAlerts(
    { crons: { status: 'ok', data: [{ name: 'nightly', label: 'net.example.nightly', ok: false, last: 'Failed · 1' }] },
      ingestCrons: { data: [] }, usage: { data: { limits: [] } } },
    { warnThreshold: 85 }, Date.now()
  );
  assert.equal(alerts[0].kind, 'cron');
  assert.equal(alerts[0].key, 'cron:launchd:net.example.nightly');
});

test('an ingested cron alert keys on its own source, so it never shares a key with a launchd job', () => {
  const alerts = buildAlerts(
    { crons: { status: 'ok', data: [{ name: 'x', label: 'same', ok: false }] },
      ingestCrons: { status: 'ok', data: [{ name: 'x', label: 'same', ok: false }] },
      usage: { data: { limits: [] } } },
    { warnThreshold: 85 }, Date.now()
  );
  assert.deepEqual(alerts.map(a => a.key).sort(), ['cron:ingest:same', 'cron:launchd:same']);
});

test('a cron with no label still gets a key rather than colliding with others', () => {
  const alerts = buildAlerts(
    { crons: { status: 'ok', data: [{ name: 'a', ok: false }, { name: 'b', ok: false }] },
      ingestCrons: { data: [] }, usage: { data: { limits: [] } } },
    { warnThreshold: 85 }, Date.now()
  );
  assert.equal(new Set(alerts.map(a => a.key)).size, 2);
});

test('the two credits rules produce different keys', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const config = { warnThreshold: 85, credits: { promoExpiresOn: '2026-09-19', updatedAt: '2026-07-01' } };
  const alerts = buildAlerts({ crons: { data: [] }, ingestCrons: { data: [] }, usage: { data: { limits: [] } } }, config, now);
  assert.equal(new Set(alerts.map(a => a.key)).size, alerts.length);
});
