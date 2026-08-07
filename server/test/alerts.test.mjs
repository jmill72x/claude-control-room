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
