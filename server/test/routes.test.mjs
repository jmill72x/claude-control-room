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

// A real write from the page carries a JSON content type and either no Origin
// (curl) or this server's own.
const call = async (handler, method, url, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:8322',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    destroy() { this.destroyed = true; },
    on(evt, fn) {
      if (evt === 'data' && body !== undefined) fn(Buffer.from(raw));
      if (evt === 'end') fn();
      return req;
    }
  };
  const res = mockRes();
  await handler(req, res);
  return res;
};

const deps = () => {
  const cache = createCache();
  const todos = { read: async () => [], write: async () => {} };
  return {
    cache,
    todos,
    config: { warnThreshold: 85, showAlertBanner: true, plan: {}, credits: {}, present: true }
  };
};

test('GET /api/dashboard returns every panel envelope', async () => {
  const d = deps();
  d.cache.set('usage', { limits: [{ label: 'Current session', pct: 10, resetsAt: null }] });
  const res = await call(createHandler(d), 'GET', '/api/dashboard');
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.usage.status, 'ok');
  assert.ok('crons' in payload);
  assert.ok('plan' in payload);
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

test('a body over the size cap is refused rather than buffered', async () => {
  const d = deps();
  const huge = 'x'.repeat(300 * 1024);
  const res = await call(createHandler(d), 'POST', '/api/ingest/crons', `[{"name":"${huge}"}]`);
  assert.equal(res.statusCode, 413);
  assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable');
});

test('an ingest POST without a JSON content type is refused (the CORS simple-request path)', async () => {
  const d = deps();
  const res = await call(
    createHandler(d), 'POST', '/api/ingest/crons', [{ name: 'x' }], { 'content-type': 'text/plain' }
  );
  assert.equal(res.statusCode, 415);
  assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable');
});

test('an ingest POST from another origin is refused', async () => {
  const d = deps();
  const res = await call(
    createHandler(d), 'POST', '/api/ingest/crons', [{ name: 'x' }], { origin: 'https://evil.example' }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable');
});

test('an ingest POST from this server\'s own origin is accepted', async () => {
  const d = deps();
  const res = await call(
    createHandler(d), 'POST', '/api/ingest/crons', [{ name: 'x' }], { origin: 'http://127.0.0.1:8322' }
  );
  assert.equal(res.statusCode, 200);
});

test('a malformed ingest body is rejected and never cached', async () => {
  const d = deps();
  const handler = createHandler(d);
  for (const body of [{}, 'a string', [{ ok: true }], [{ name: 'x', ok: 'yes' }]]) {
    const res = await call(handler, 'POST', '/api/ingest/crons', body);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable');
});

test('invalid JSON is a 400, not a crash', async () => {
  const res = await call(createHandler(deps()), 'POST', '/api/ingest/crons', '{not json');
  assert.equal(res.statusCode, 400);
});

test('a cross-origin to-do write is refused', async () => {
  const d = deps();
  let saved = null;
  d.todos.write = async v => { saved = v; };
  const res = await call(
    createHandler(d), 'PUT', '/api/todos', [{ id: 1, text: 'a', lane: 'idea' }],
    { origin: 'https://evil.example' }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(saved, null);
});

test('a store that throws answers 500 instead of rejecting out of the handler', async () => {
  const d = deps();
  d.todos.read = async () => { throw new Error('todos.json is corrupt'); };
  const res = await call(createHandler(d), 'GET', '/api/todos');
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /corrupt/);
});

test('with no config.json the config envelope is unavailable, not a hardcoded ok', async () => {
  const d = deps();
  d.config = { warnThreshold: 85, showAlertBanner: true, plan: null, credits: null, present: false, error: 'no config.json' };
  const res = await call(createHandler(d), 'GET', '/api/dashboard');
  const payload = JSON.parse(res.body);
  assert.equal(payload.config.status, 'unavailable');
  assert.match(payload.config.error, /config/);
});

test('ingested credits are cached under their own key for the page to prefer', async () => {
  const d = deps();
  const res = await call(createHandler(d), 'POST', '/api/ingest/credits', { balance: 12.5, updatedAt: '2026-08-01' });
  assert.equal(res.statusCode, 200);
  assert.equal(d.cache.get('ingestCredits', Date.now()).data.balance, 12.5);
});
