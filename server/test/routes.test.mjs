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
  const todos = {
    read: async () => [],
    write: async () => {},
    readState: async () => ({ todos: await todos.read(), revision: null }),
    save: async (list, opts) => ({ todos: (await todos.write(list, opts)) ?? list, revision: null })
  };
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

test('GET /api/health answers ok without touching the cache, todos or config', async () => {
  const handler = createHandler({ cache: null, todos: null, config: null });
  const res = await call(handler, 'GET', '/api/health');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

// The board's own cap (the 2026-10-21 security review): it grows by every item ever
// written, so its PUT may carry up to 1 MiB, while every other write keeps 256 KB.
const boardOf = bytes => {
  const item = n => ({ id: `i${n}`, text: 'x'.repeat(1000), lane: 'idea', tag: 'Note' });
  const list = [];
  while (JSON.stringify(list).length < bytes) list.push(item(list.length));
  return list;
};

test('a board PUT may be larger than the 256 KB that other writes get', async () => {
  const d = deps();
  let saved = null;
  d.todos.write = async v => { saved = v; };
  const list = boardOf(600 * 1024);
  const res = await call(createHandler(d), 'PUT', '/api/todos', list);
  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, list.length);
});

test('a board PUT over 1 MiB is refused, and nothing is written', async () => {
  const d = deps();
  let saved = null;
  d.todos.write = async v => { saved = v; };
  const res = await call(createHandler(d), 'PUT', '/api/todos', boardOf(1024 * 1024 + 2000));
  assert.equal(res.statusCode, 413);
  assert.equal(saved, null);
});

test('an ingest POST keeps the 256 KB cap', async () => {
  const d = deps();
  const res = await call(createHandler(d), 'POST', '/api/ingest/projects', `[{"name":"${'x'.repeat(260 * 1024)}"}]`);
  assert.equal(res.statusCode, 413);
});

test("/api/dashboard carries the board's size against its cap", async () => {
  const d = deps();
  d.cache.set('board', { bytes: 1000, cap: 1024 * 1024 });
  const payload = JSON.parse((await call(createHandler(d), 'GET', '/api/dashboard')).body);
  assert.deepEqual(payload.board.data, { bytes: 1000, cap: 1024 * 1024 });
});

// The health strip (Orbit plan, Phase 2): its panel goes to the page as the
// collector built it, and its config block never does.
test('/api/dashboard carries the health panel, and a down service as an alert, but never the health config', async () => {
  const d = deps();
  d.config.health = { jobStatus: '/secret/bin/job-status', services: [{ kind: 'launchd', name: 'Tunnel', label: 'com.example.tunnel' }] };
  const now = Date.now();
  d.cache.set('health', {
    jobs: { status: 'ok', error: null, list: [] },
    services: [{ key: 'launchd:Tunnel', kind: 'launchd', name: 'Tunnel', about: null, state: 'down', launchd: 'not running', reason: null, downSince: now - 6 * 60e3 }]
  });
  const payload = JSON.parse((await call(createHandler(d), 'GET', '/api/dashboard')).body);
  assert.equal(payload.health.status, 'ok');
  assert.equal(payload.health.data.services[0].state, 'down');
  assert.deepEqual(payload.alerts.map(a => a.text), ['Tunnel is not running']);
  assert.ok(!('health' in payload.config.data));
  assert.ok(!JSON.stringify(payload).includes('/secret') && !JSON.stringify(payload).includes('com.example.tunnel'));
});

// Waiting on you's To push tile (Orbit plan, Phase 4): its panel goes to the
// page as the collector built it, and its config block (git-read's path and
// the repos' paths) never does.
test('/api/dashboard carries the toPush panel, but never the toPush config', async () => {
  const d = deps();
  d.config.toPush = { gitRead: '/secret/bin/git-read', repos: [{ path: '/secret/projects/garden-app', owner: 'builder' }] };
  d.cache.set('toPush', {
    configured: true,
    repos: [{ name: 'garden-app', owner: 'builder', state: 'ok', branch: 'main', detached: false, upstream: true, staged: 2, ahead: 0, behind: 0, partial: false, checkedAt: 1 }]
  });
  const payload = JSON.parse((await call(createHandler(d), 'GET', '/api/dashboard')).body);
  assert.equal(payload.toPush.status, 'ok');
  assert.equal(payload.toPush.data.repos[0].staged, 2);
  assert.ok(!('toPush' in payload.config.data));
  assert.ok(!JSON.stringify(payload).includes('/secret'));
});
