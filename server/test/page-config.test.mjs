// What of config.json reaches the page, and the roster block it carries. The
// names, keys, paths and labels are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';
import { readRoster } from '../lib/roster.mjs';

const CONFIG = {
  warnThreshold: 80,
  showAlertBanner: true,
  plan: { price: '$1 / month', renews: '2026-01-15', cycle: 'monthly', seats: '1 · none', secretPlanNote: 'PLANTED-PLAN' },
  credits: { balance: 5, spent: 1, monthlyLimit: 10, resetsOn: '2026-11-01', promoAmount: 2, promoExpiresOn: '2026-11-02', updatedAt: '2026-10-20', note: 'PLANTED-CREDITS' },
  roster: {
    avatarDir: '/PLANTED/avatar/folder',
    agents: [{ key: 'lead', name: 'The Lead' }, { key: 'builder', name: 'Builder' }],
    tagOwners: { Ops: 'builder', Chief: 'lead' }
  },
  jobs: { 'com.example.brief': { name: 'Morning brief', owner: 'lead' } },
  ntfyTopic: 'PLANTED-TOPIC',
  jobStatusCommand: '/PLANTED/bin/job-status',
  present: true,
  error: null
};

const dashboard = async config => {
  const handler = createHandler({ cache: createCache(), todos: null, config });
  const res = { headers: {}, body: '' };
  res.writeHead = (code, h) => { res.statusCode = code; Object.assign(res.headers, h ?? {}); };
  res.end = b => { res.body = b ?? ''; };
  await handler({ method: 'GET', url: '/api/dashboard', headers: { host: '127.0.0.1:8322' } }, res);
  return { status: res.statusCode, body: res.body, payload: JSON.parse(res.body) };
};

test('the page gets only the config fields it shows: thresholds, plan, credits, roster names and job names', async () => {
  const { status, payload } = await dashboard(CONFIG);
  assert.equal(status, 200);
  const data = payload.config.data;
  assert.deepEqual(Object.keys(data).sort(), ['credits', 'jobs', 'plan', 'roster', 'showAlertBanner', 'warnThreshold']);
  assert.equal(data.warnThreshold, 80);
  assert.equal(data.showAlertBanner, true);
  assert.deepEqual(Object.keys(data.plan).sort(), ['cycle', 'nextRenewal', 'price', 'renews', 'seats']);
  assert.equal(data.plan.price, '$1 / month');
  assert.match(data.plan.nextRenewal, /^\d{4}-\d{2}-15$/);
  assert.deepEqual(data.credits, { balance: 5, spent: 1, monthlyLimit: 10, resetsOn: '2026-11-01', promoAmount: 2, promoExpiresOn: '2026-11-02', updatedAt: '2026-10-20' });
  assert.deepEqual(data.roster, {
    agents: [{ key: 'lead', name: 'The Lead' }, { key: 'builder', name: 'Builder' }],
    tagOwners: { Ops: 'builder', Chief: 'lead' }
  });
  assert.deepEqual(data.jobs, { 'com.example.brief': { name: 'Morning brief', owner: 'lead' } });
});

test('paths, commands and anything else in config never reach the page', async () => {
  const { body } = await dashboard(CONFIG);
  for (const planted of ['PLANTED-PLAN', 'PLANTED-CREDITS', '/PLANTED/avatar/folder', 'PLANTED-TOPIC', '/PLANTED/bin/job-status', 'avatarDir', 'ntfyTopic']) {
    assert.equal(body.includes(planted), false, `${planted} reached the page`);
  }
});

test('with no plan, credits or roster in config, the page gets nulls and empty lists, not invented values', async () => {
  const { payload } = await dashboard({ warnThreshold: 85, showAlertBanner: true, plan: null, credits: null, present: true });
  const data = payload.config.data;
  assert.equal(data.plan, null);
  assert.equal(data.credits, null);
  assert.deepEqual(data.roster, { agents: [], tagOwners: {} });
  assert.deepEqual(data.jobs, {});
});

test('the roster keeps good entries, and leaves out bad ones with a reason', () => {
  const r = readRoster({
    roster: {
      avatarDir: 'relative/folder',
      agents: [
        { key: 'lead', name: 'The Lead' }, { key: 'Bad Key', name: 'x' }, { key: 'nameless' },
        { key: 'lead', name: 'Again' }, { key: 'builder', name: 'Builder' }, null
      ],
      tagOwners: { Ops: 'builder', Docs: 'nobody' }
    },
    jobs: { a: { name: 'A job', owner: 'lead' }, b: { name: 'B job', owner: 'ghost' }, c: {} }
  });
  assert.deepEqual(r.agents, [{ key: 'lead', name: 'The Lead' }, { key: 'builder', name: 'Builder' }]);
  assert.deepEqual(r.tagOwners, { Ops: 'builder' });
  assert.equal(r.avatarDir, null);
  assert.deepEqual(r.jobs, { a: { name: 'A job', owner: 'lead' }, b: { name: 'B job' } });
  for (const why of [/"Bad Key" is not an agent key/, /nameless has no name/, /lead is listed twice/, /"Docs" names "nobody"/,
    /avatarDir must be an absolute path/, /"b" names an owner that is not on the roster/, /"c" has no name/]) {
    assert.ok(r.problems.some(p => why.test(p)), `missing problem ${why}`);
  }
  assert.equal(readRoster({ roster: { avatarDir: '/abs/folder' } }).avatarDir, '/abs/folder');
  assert.deepEqual(readRoster(undefined), { agents: [], tagOwners: {}, avatarDir: null, jobs: {}, problems: [] });
});
