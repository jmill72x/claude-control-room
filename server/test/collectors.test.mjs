import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUsage } from '../collectors/usage.mjs';
import { collectAgents } from '../collectors/agents.mjs';
import { collectPlan } from '../collectors/plan.mjs';
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

// `claude auth status --json` also returns an email, org id, and org name.
// The injected fixture below includes them, matching the real command's
// shape, specifically so this test can assert they never survive the parse.
const AUTH_STATUS_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  orgId: '00000000-0000-0000-0000-000000000000',
  orgName: "someone@example.com's Organization",
  subscriptionType: 'pro'
});

test('collectPlan returns only the mapped tier, nothing else from the CLI output', async () => {
  const out = await collectPlan({ run: async () => AUTH_STATUS_JSON });
  assert.deepEqual(out, { tier: 'Pro' });
  const keys = Object.keys(out);
  assert.deepEqual(keys, ['tier']);
});

test('collectPlan never lets the email or org id past the parse boundary', async () => {
  const out = await collectPlan({ run: async () => AUTH_STATUS_JSON });
  const serialized = JSON.stringify(out);
  assert.doesNotMatch(serialized, /example\.com/);
  assert.doesNotMatch(serialized, /00000000-0000-0000-0000-000000000000/);
});

test('collectPlan rejects invalid JSON rather than returning a default tier', async () => {
  await assert.rejects(() => collectPlan({ run: async () => 'not json' }));
});

test('collectPlan rejects JSON with no subscriptionType rather than returning a default tier', async () => {
  await assert.rejects(() => collectPlan({ run: async () => JSON.stringify({ loggedIn: true }) }));
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

const HISTORY_USAGE_TEXT = `Current session: 50% used · resets Aug 6 at 10:00am (America/New_York)
Current week (all models): 20% used · resets Aug 10 at 8:00pm (America/New_York)
`;

test('collectUsage appends a history record on success', async () => {
  const appended = [];
  await collectUsage({
    run: async () => HISTORY_USAGE_TEXT,
    history: { append: async r => appended.push(r), recent: () => [] }
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].limits.length, 2);
  assert.ok(Number.isFinite(appended[0].t));
});

test('a failed parse appends nothing — a gap must mean no reading, not zero', async () => {
  const appended = [];
  await assert.rejects(() => collectUsage({
    run: async () => 'garbage',
    history: { append: async r => appended.push(r), recent: () => [] }
  }));
  assert.equal(appended.length, 0);
});

test('collectUsage works without a history store injected', async () => {
  const out = await collectUsage({ run: async () => HISTORY_USAGE_TEXT });
  assert.equal(out.limits.length, 2);
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
