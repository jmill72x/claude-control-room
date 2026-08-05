import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUsage } from '../collectors/usage.mjs';
import { collectAgents } from '../collectors/agents.mjs';
import { buildAlerts } from '../lib/alerts.mjs';

const USAGE_TEXT = `Current session: 24% used · resets Aug 5 at 12:09pm (America/New_York)
Current week (all models): 5% used · resets Aug 10 at 8pm (America/New_York)
Current week (Opus): 88% used
`;

test('collectUsage parses whatever the injected runner returns', async () => {
  const out = await collectUsage({ run: async () => USAGE_TEXT });
  assert.equal(out.limits.length, 3);
  assert.equal(out.limits[2].pct, 88);
});

test('collectUsage propagates failure so the registry can mark it', async () => {
  await assert.rejects(() => collectUsage({ run: async () => 'garbage output' }));
});

test('collectAgents parses the JSON array', async () => {
  const json = JSON.stringify([{ pid: 1, cwd: '/x', kind: 'interactive', status: 'busy', name: 'a' }]);
  const out = await collectAgents({ run: async () => json });
  assert.equal(out[0].status, 'busy');
});

test('collectAgents rejects invalid JSON rather than returning empty', async () => {
  await assert.rejects(() => collectAgents({ run: async () => 'not json' }));
});

test('collectAgents rejects valid JSON that is not an array', async () => {
  await assert.rejects(() => collectAgents({ run: async () => JSON.stringify({ pid: 1 }) }));
});

test('alerts fire for a failing cron', () => {
  const snapshot = {
    crons: { status: 'ok', data: [{ name: 'nightly-sync', ok: false, last: 'Failed · 429' }] },
    usage: { status: 'ok', data: { limits: [] } }
  };
  const alerts = buildAlerts(snapshot, { warnThreshold: 85 }, Date.now());
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /nightly-sync/);
});

test('alerts fire for a limit at or above the threshold', () => {
  const snapshot = {
    crons: { status: 'ok', data: [] },
    usage: { status: 'ok', data: { limits: [{ label: 'Weekly · Opus', pct: 88 }] } }
  };
  const alerts = buildAlerts(snapshot, { warnThreshold: 85 }, Date.now());
  assert.match(alerts[0].text, /88%/);
});

test('a limit exactly at the threshold fires; one point below does not', () => {
  const at = buildAlerts({
    crons: { data: [] },
    usage: { data: { limits: [{ label: 'Weekly', pct: 85 }] } }
  }, { warnThreshold: 85 }, Date.now());
  assert.equal(at.length, 1);

  const below = buildAlerts({
    crons: { data: [] },
    usage: { data: { limits: [{ label: 'Weekly', pct: 84 }] } }
  }, { warnThreshold: 85 }, Date.now());
  assert.equal(below.length, 0);
});

test('no alerts when everything is healthy', () => {
  const snapshot = {
    crons: { status: 'ok', data: [{ name: 'ok-job', ok: true }] },
    usage: { status: 'ok', data: { limits: [{ label: 'Current session', pct: 10 }] } }
  };
  assert.deepEqual(buildAlerts(snapshot, { warnThreshold: 85 }, Date.now()), []);
});

test('a promo credit expiring within 30 days raises an alert', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const config = { warnThreshold: 85, credits: { promoAmount: 88.61, promoExpiresOn: '2026-09-19', updatedAt: '2026-09-01' } };
  const alerts = buildAlerts({ crons: { data: [] }, usage: { data: { limits: [] } } }, config, now);
  assert.match(alerts[0].text, /expire/i);
});

test('credits older than 14 days raise a staleness alert', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const config = { warnThreshold: 85, credits: { promoExpiresOn: '2027-01-01', updatedAt: '2026-08-01' } };
  const alerts = buildAlerts({ crons: { data: [] }, usage: { data: { limits: [] } } }, config, now);
  assert.ok(alerts.some(a => /credits/i.test(a.text)));
});
