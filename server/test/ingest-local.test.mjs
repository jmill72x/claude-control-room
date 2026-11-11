// The ingest routes take posts from this machine only (lib/local-caller.mjs): Tailscale
// Serve puts the whole loopback port on the tailnet, and before this any tailnet device
// could post a fake cron failure, which showed as an alert and was pushed. Every host
// name, login and address here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { localCaller, PROXY_HEADERS } from '../lib/local-caller.mjs';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';
import { createNeedsYouStore } from '../lib/needs-you.mjs';

const SERVE_HOST = 'mini.example-tailnet.ts.net';
const local = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: '127.0.0.1:8322', ...headers }, socket: { remoteAddress } });

test('a loopback caller naming a loopback host, with no proxy header, is local', () => {
  assert.equal(localCaller(local()), null);
  assert.equal(localCaller(local({ host: 'localhost:8322' })), null);
  assert.equal(localCaller(local({ host: 'LOCALHOST:8322' })), null);
  assert.equal(localCaller(local({ host: '[::1]:8322' }, '::1')), null);
  assert.equal(localCaller(local({}, '::ffff:127.0.0.1')), null);
  assert.equal(localCaller(local({ host: '127.0.0.1' })), null, 'a port is optional');
});

test('anything a proxy adds makes a caller not local, and the reason names the header, never its value', () => {
  for (const name of PROXY_HEADERS) {
    const why = localCaller(local({ [name]: 'owner@example.com' }));
    assert.ok(why, name);
    assert.ok(why.includes(name), why);
    assert.ok(!why.includes('owner@example.com'), why);
  }
  // Serve passes on whatever Host the client sent: a loopback Host through Serve is
  // still refused, by the proxy headers (Ultron 11-11, L3).
  assert.match(localCaller(local({ host: '127.0.0.1:8322', 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': '127.0.0.1:8322' })), /x-forwarded-for/);
  // What Serve really sends: these together, and the Host as the browser gave it.
  assert.ok(localCaller(local({ host: SERVE_HOST, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': SERVE_HOST, 'x-forwarded-proto': 'https' })));
  // An empty header is still a header: a proxy that sends one is still a proxy.
  assert.ok(localCaller(local({ 'x-forwarded-for': '' })));
  for (const name of ['Tailscale-User-Login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-funnel-request', 'tailscale-headers-info', 'Via']) {
    assert.ok(PROXY_HEADERS.includes(name.toLowerCase()), name);
  }
});

test('a Host that is not loopback, or a socket that is not, is not local', () => {
  assert.match(localCaller(local({ host: SERVE_HOST })), /host/);
  assert.match(localCaller(local({ host: `${SERVE_HOST}:443` })), /host/);
  assert.match(localCaller(local({ host: '127.0.0.1.evil.example:8322' })), /host/);
  assert.match(localCaller(local({ host: 'localhost.evil.example' })), /host/);
  assert.match(localCaller(local({ host: '' })), /host/);
  assert.match(localCaller({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), /host/);
  assert.match(localCaller(local({}, '100.64.0.9')), /address/);
  assert.match(localCaller(local({}, '192.168.1.20')), /address/);
  assert.match(localCaller(local({}, '127.0.0.2')), /address/, 'only the one loopback address the server binds');
  assert.match(localCaller({ headers: { host: '127.0.0.1:8322' } }), /address/, 'no socket at all is not local');
  assert.match(localCaller({ headers: { host: '127.0.0.1:8322' }, socket: {} }), /address/);
});

// ---- the routes ----

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (code, hdrs) => { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const call = async (handler, url, body, headers = {}, remoteAddress = '127.0.0.1') => {
  const raw = JSON.stringify(body);
  let read = false;
  const req = {
    method: 'POST', url,
    headers: { host: '127.0.0.1:8322', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress },
    on(evt, fn) { if (evt === 'data') { read = true; fn(Buffer.from(raw)); } if (evt === 'end') fn(); return req; },
    destroy() {}, unpipe() {}, pause() {}
  };
  const res = mockRes();
  await handler(req, res);
  return { res, read };
};
const deps = () => {
  const logged = [];
  const needsYou = createNeedsYouStore({ whoFor: () => null });
  return {
    cache: createCache(),
    todos: { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) },
    config: { warnThreshold: 85, showAlertBanner: true, present: true },
    needsYou, log: line => logged.push(line), logged
  };
};
const POSTS = [
  ['/api/ingest/crons', [{ name: 'cloud-job', ok: false, last: 'Failed · 1' }], 'ingestCrons'],
  ['/api/ingest/projects', [{ name: 'a-project' }], 'ingestProjects'],
  ['/api/ingest/credits', { balance: 12.5, updatedAt: '2026-11-01' }, 'ingestCredits'],
  ['/api/ingest/needs-you', { hook_event_name: 'Notification', session_id: 'a1b2c3d4-0000-4000-8000-000000000009', notification_type: 'permission_prompt' }, null]
];
const VIA_SERVE = { host: SERVE_HOST, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': SERVE_HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'owner@example.com' };

test('each ingest route takes a post from this machine', async () => {
  for (const [url, body, key] of POSTS) {
    const d = deps();
    const { res } = await call(createHandler(d), url, body);
    assert.equal(res.statusCode, 200, url);
    if (key) assert.equal(d.cache.get(key, Date.now()).status, 'ok', url);
    else assert.equal(d.needsYou.view(Date.now()).length, 1, url);
  }
});

test('each ingest route refuses a post that came through Serve, before reading its body, and stores nothing', async () => {
  const cases = [
    VIA_SERVE,
    { 'x-forwarded-for': '100.64.0.9' }, // a proxy that kept the loopback Host
    { 'tailscale-user-login': 'owner@example.com' },
    { host: SERVE_HOST } // no proxy headers but the tailnet name
  ];
  for (const [url, body, key] of POSTS) {
    for (const headers of cases) {
      const d = deps();
      const { res, read } = await call(createHandler(d), url, body, headers);
      assert.equal(res.statusCode, 403, `${url} ${JSON.stringify(headers)}`);
      assert.match(JSON.parse(res.body).error, /this machine only/);
      assert.equal(read, false, 'the body is never read');
      if (key) assert.equal(d.cache.get(key, Date.now()).status, 'unavailable', url);
      else assert.equal(d.needsYou.view(Date.now()).length, 0, url);
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers.Connection, 'close', 'the unread body is never drained');
    }
    const d = deps();
    assert.equal((await call(createHandler(d), url, body, {}, '100.64.0.9')).res.statusCode, 403, `${url} from a tailnet address`);
  }
});

test('a refusal is logged once per route and reason, naming no header value', async () => {
  const d = deps();
  const h = createHandler(d);
  for (let k = 0; k < 5; k++) await call(h, '/api/ingest/crons', [{ name: 'x' }], VIA_SERVE);
  await call(h, '/api/ingest/credits', { balance: 1 }, VIA_SERVE);
  const lines = d.logged.filter(l => l.startsWith('ingest:'));
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^ingest: refused a post to \/api\/ingest\/crons that did not come from this machine \(/);
  for (const l of lines) {
    assert.ok(!l.includes('owner@example.com') && !l.includes('100.64.0.9') && !l.includes(SERVE_HOST), l);
  }
});

test('the other writes are untouched: the board and acks still take the tailnet', async () => {
  const d = deps();
  const h = createHandler(d);
  const req = {
    method: 'PUT', url: '/api/todos',
    headers: { host: SERVE_HOST, 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'owner@example.com' },
    socket: { remoteAddress: '127.0.0.1' },
    on(evt, fn) { if (evt === 'data') fn(Buffer.from('[]')); if (evt === 'end') fn(); return req; }, destroy() {}
  };
  const res = mockRes();
  await h(req, res);
  assert.equal(res.statusCode, 200);
});

// Over a real socket: the address is the kernel's, not a mock's.
test('over a real loopback socket, a plain post is taken and a forwarded one refused', async () => {
  const d = deps();
  const server = createServer(createHandler(d));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = headers => new Promise((resolve, reject) => {
    const body = JSON.stringify([{ name: 'cloud-job', ok: true }]);
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/ingest/crons', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    assert.equal((await post({ 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': SERVE_HOST })).status, 403);
    assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable');
    assert.equal((await post({ host: `${SERVE_HOST}` })).status, 403);
    const spoofed = await post({ host: '127.0.0.1:8322', 'x-forwarded-for': '100.64.0.9' });
    assert.equal(spoofed.status, 403, 'a loopback Host does not get a forwarded post in');
    assert.equal((await post({})).status, 200);
    assert.equal(d.cache.get('ingestCrons', Date.now()).data[0].name, 'cloud-job');
  } finally {
    await new Promise(r => server.close(r));
  }
});
