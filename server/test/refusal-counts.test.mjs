// The TCP port's ingest refusals, counted per route and reason (lib/refusal-counts.mjs,
// Ultron's 11-11 L5, board 1ba66c95): the first refusal of a key is logged at once,
// later ones at most once an hour per key, with counts, and no line carries a value.
// Every host name, login, address and token here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefusalCounts, refusalCountLine, REFUSAL_LOG_EVERY_MS as HOUR } from '../lib/refusal-counts.mjs';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';
import { createNeedsYouStore } from '../lib/needs-you.mjs';

// A clock the test moves, and timers it fires by hand.
const fakeTime = () => {
  let now = Date.UTC(2026, 10, 22, 9, 0);
  const timers = [];
  return {
    clock: () => now,
    advance: ms => { now += ms; },
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }); },
    // Fire every timer that is due, as the event loop would.
    run: () => { for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) { if (t.at <= now) t.fn(); else timers.push(t); } },
    pending: () => timers.length
  };
};
const counter = (t, extra = {}) => {
  const logged = [];
  const refused = createRefusalCounts({ log: l => logged.push(l), clock: t.clock, setTimer: t.setTimer, ...extra });
  return { logged, refused };
};

test('several refusals of one key: the first logged at once, the rest held and logged once at the hour, with counts', () => {
  const t = fakeTime();
  const { logged, refused } = counter(t);
  refused('/api/ingest/crons', 'on the TCP port', 'first line');
  assert.deepEqual(logged, ['first line']);
  for (let k = 0; k < 6; k++) { t.advance(60_000); refused('/api/ingest/crons', 'on the TCP port', 'first line'); }
  assert.deepEqual(logged, ['first line'], 'nothing more inside the hour');
  assert.equal(t.pending(), 1, 'one timer for the hour, however many refusals');
  t.advance(HOUR); t.run();
  assert.deepEqual(logged.slice(1), [refusalCountLine('/api/ingest/crons', 'on the TCP port', 6, 7)]);
  assert.equal(logged[1], 'ingest: refused 6 more posts to /api/ingest/crons on the TCP port since the last such line (7 since the start)');
  // A quiet hour writes nothing; the next refusal after it is written at once.
  t.advance(2 * HOUR); t.run();
  assert.equal(logged.length, 2);
  refused('/api/ingest/crons', 'on the TCP port', 'first line');
  assert.equal(logged[2], 'ingest: refused 1 more post to /api/ingest/crons on the TCP port since the last such line (8 since the start)');
  assert.deepEqual(refused.totals(), [{ path: '/api/ingest/crons', reason: 'on the TCP port', total: 8 }]);
});

test('a timer from an hour already written does nothing, so no line comes early', () => {
  const t = fakeTime();
  const { logged, refused } = counter(t);
  refused('/r', 'why', 'first');
  t.advance(1000); refused('/r', 'why', 'first'); // held, timer at the hour
  t.advance(HOUR); refused('/r', 'why', 'first'); // past the hour: written at once
  assert.equal(logged.length, 2);
  t.advance(1000); refused('/r', 'why', 'first'); // held for the new hour
  t.run(); // the old timer, due now, fires; the new hour's is not due
  assert.equal(logged.length, 2, 'the stale timer wrote nothing early');
  t.advance(HOUR); t.run();
  assert.equal(logged[2], 'ingest: refused 1 more post to /r why since the last such line (4 since the start)');
});

test('two keys are counted apart, a route with two reasons included', () => {
  const t = fakeTime();
  const { logged, refused } = counter(t);
  for (let k = 0; k < 3; k++) refused('/api/ingest/crons', 'on the TCP port', 'crons first');
  for (let k = 0; k < 5; k++) refused('/api/ingest/needs-you', 'that did not come from this machine (its address is not loopback)', 'needs-you first');
  refused('/api/ingest/crons', 'that did not come from this machine (its host is not loopback)', 'crons host first');
  assert.deepEqual(logged, ['crons first', 'needs-you first', 'crons host first']);
  t.advance(HOUR); t.run();
  assert.deepEqual(logged.slice(3).sort(), [
    'ingest: refused 2 more posts to /api/ingest/crons on the TCP port since the last such line (3 since the start)',
    'ingest: refused 4 more posts to /api/ingest/needs-you that did not come from this machine (its address is not loopback) since the last such line (5 since the start)'
  ].sort(), 'the key refused once has nothing more to say');
  assert.deepEqual(refused.totals().map(k => k.total), [3, 5, 1]);
});

test('past the key cap, refusals are counted together under one "other" line', () => {
  const t = fakeTime();
  const { logged, refused } = counter(t, { maxKeys: 2 });
  refused('/a', 'r', 'a first');
  refused('/b', 'r', 'b first');
  refused('/c', 'r', 'c first');
  refused('/d', 'r', 'd first');
  assert.equal(logged.length, 3);
  assert.match(logged[2], /^ingest: refused 1 post on other routes and reasons past the first \(1 since the start;/);
  assert.match(logged[2], /names 2 routes and reasons at most\)$/);
  t.advance(HOUR); t.run();
  assert.match(logged[3], /^ingest: refused 1 post on other routes and reasons since the last such line \(2 since the start;/);
  assert.ok(!logged.some(l => l.includes('/c') || l.includes('/d')), 'the keys past the cap are not named');
  assert.deepEqual(refused.totals().at(-1), { other: 2 });
});

// ---- through the TCP handler ----

const SERVE_HOST = 'mini.example-tailnet.ts.net';
const SECRET = 'tok_example_0123456789abcdef';
const VIA_SERVE = { host: SERVE_HOST, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': SERVE_HOST, 'tailscale-user-login': 'owner@example.com', authorization: `Bearer ${SECRET}` };
const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const post = async (handler, url, body, headers = {}, remoteAddress = '127.0.0.1') => {
  const raw = JSON.stringify(body);
  const req = {
    method: 'POST', url,
    headers: { host: '127.0.0.1:8322', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress },
    on(evt, fn) { if (evt === 'data') fn(Buffer.from(raw)); if (evt === 'end') fn(); return req; },
    destroy() {}, unpipe() {}, pause() {}
  };
  const res = mockRes();
  await handler(req, res);
  return res;
};

test('over the TCP handler: repeated refusals are counted and logged hourly, and no line holds a body, header value or address', async () => {
  const t = fakeTime();
  const logged = [];
  const h = createHandler({
    cache: createCache(),
    todos: { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) },
    config: { warnThreshold: 85, showAlertBanner: true, present: true },
    needsYou: createNeedsYouStore({ whoFor: () => null }),
    log: l => logged.push(l), clock: t.clock, setTimer: t.setTimer, onIngestTcp: () => {}
  });
  const body = { name: SECRET, hook_event_name: 'Notification', session_id: 'a1b2c3d4-0000-4000-8000-000000000009', notification_type: 'permission_prompt' };
  for (let k = 0; k < 4; k++) assert.equal((await post(h, '/api/ingest/crons', [body])).statusCode, 403);
  for (let k = 0; k < 3; k++) assert.equal((await post(h, '/api/ingest/needs-you', body, VIA_SERVE)).statusCode, 403);
  for (let k = 0; k < 2; k++) assert.equal((await post(h, '/api/ingest/needs-you', body, {}, '100.64.0.9')).statusCode, 403);
  let lines = logged.filter(l => l.startsWith('ingest:'));
  assert.equal(lines.length, 3, lines.join('\n'));
  t.advance(HOUR); t.run();
  lines = logged.filter(l => l.startsWith('ingest:'));
  assert.deepEqual(lines.slice(3).sort(), [
    'ingest: refused 3 more posts to /api/ingest/crons on the TCP port since the last such line (4 since the start)',
    'ingest: refused 2 more posts to /api/ingest/needs-you that did not come from this machine (it came through a proxy (x-forwarded-for)) since the last such line (3 since the start)',
    'ingest: refused 1 more post to /api/ingest/needs-you that did not come from this machine (its address is not loopback) since the last such line (2 since the start)'
  ].sort());
  for (const l of logged) {
    for (const value of [SECRET, 'owner@example.com', '100.64.0.9', SERVE_HOST, 'a1b2c3d4', 'Bearer', 'permission_prompt']) {
      assert.ok(!l.includes(value), `${value} in: ${l}`);
    }
  }
});
