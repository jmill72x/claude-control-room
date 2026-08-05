import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};

const call = async (handler, method, url, body) => {
  const req = { method, url, headers: {}, on(evt, fn) {
    if (evt === 'data' && body) fn(Buffer.from(JSON.stringify(body)));
    if (evt === 'end') fn();
    return req;
  } };
  const res = mockRes();
  await handler(req, res);
  return res;
};

const deps = () => {
  const cache = createCache();
  const todos = { read: async () => [], write: async () => {} };
  return { cache, todos, config: { warnThreshold: 85, showAlertBanner: true, plan: {}, credits: {} } };
};

test('GET /api/dashboard returns every panel envelope', async () => {
  const d = deps();
  d.cache.set('usage', { limits: [{ label: 'Current session', pct: 10, resetsAt: null }] });
  const res = await call(createHandler(d), 'GET', '/api/dashboard');
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.usage.status, 'ok');
  assert.ok('crons' in payload);
  assert.ok('alerts' in payload);
});

test('an unwritten panel reports unavailable rather than being omitted', async () => {
  const res = await call(createHandler(deps()), 'GET', '/api/dashboard');
  assert.equal(JSON.parse(res.body).usage.status, 'unavailable');
});

test('PUT /api/todos persists through the store', async () => {
  const d = deps();
  let saved = null;
  d.todos.write = async v => { saved = v; };
  const res = await call(createHandler(d), 'PUT', '/api/todos', [{ id: 1, text: 'a', lane: 'idea' }]);
  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, 1);
});

test('POST /api/ingest/crons writes into the cache', async () => {
  const d = deps();
  const res = await call(createHandler(d), 'POST', '/api/ingest/crons', [{ name: 'cloud-job', ok: true }]);
  assert.equal(res.statusCode, 200);
  assert.equal(d.cache.get('ingestCrons', Date.now()).data[0].name, 'cloud-job');
});

test('an unknown route is a 404', async () => {
  const res = await call(createHandler(deps()), 'GET', '/api/nope');
  assert.equal(res.statusCode, 404);
});
