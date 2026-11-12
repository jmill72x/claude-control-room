// The ingest's TCP side (lib/local-caller.mjs): Tailscale Serve puts the whole loopback
// port on the tailnet, and before 2026-11-11 any tailnet device could post a fake cron
// failure, which showed as an alert and was pushed. Since the ingest socket
// (ingest-socket.test.mjs) the port takes only the needs-you route, in the transition,
// behind this guard. Every host
// name, login and address here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { localCaller, PROXY_HEADERS } from '../lib/local-caller.mjs';
import { createCache } from '../cache.mjs';
import { createHandler, readIngestConfig } from '../routes.mjs';
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
    needsYou, log: line => logged.push(line), logged, exact: [], tcpPosts: [], tcpFlags: []
  };
};
const POSTS = [
  ['/api/ingest/crons', [{ name: 'cloud-job', ok: false, last: 'Failed · 1' }], 'ingestCrons'],
  ['/api/ingest/projects', [{ name: 'a-project' }], 'ingestProjects'],
  ['/api/ingest/credits', { balance: 12.5, updatedAt: '2026-11-01' }, 'ingestCredits'],
  ['/api/ingest/exact-command', { hook_event_name: 'PermissionRequest', session_id: 'a1b2c3d4-0000-4000-8000-000000000009', tool_name: 'Bash', command: 'ls' }, 'exact'],
  ['/api/ingest/needs-you', { hook_event_name: 'Notification', session_id: 'a1b2c3d4-0000-4000-8000-000000000009', notification_type: 'permission_prompt' }, null]
];
const VIA_SERVE = { host: SERVE_HOST, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': SERVE_HOST, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'owner@example.com' };
// What a route stored, if anything: a cache key, the gate's reports, or a wait.
const stored = (d, key) => (key === 'exact' ? d.exact.length > 0 : key ? d.cache.get(key, Date.now()).status !== 'unavailable' : d.needsYou.view(Date.now()).length > 0);
const tcpHandler = (d, ingest) => createHandler({ ...d, config: { ...d.config, ...(ingest === undefined ? {} : { ingest }) }, onExact: v => { d.exact.push(v); return 'kept'; }, onIngestTcp: (p, flags) => { d.tcpPosts.push(p); d.tcpFlags.push(flags); } });

// The TCP port since the ingest socket (lib/ingest-socket.mjs): only the needs-you route,
// and only in the "legacy" transition (the default); every other post is refused unread.
test('on the TCP port, in the legacy transition, only the needs-you route takes a post from this machine, and each one is reported', async () => {
  for (const ingest of [undefined, { tcp: 'legacy' }, {}]) {
    for (const [url, body, key] of POSTS) {
      const d = deps();
      const { res, read } = await call(tcpHandler(d, ingest), url, body);
      if (url === '/api/ingest/needs-you') {
        assert.equal(res.statusCode, 200, url);
        assert.equal(stored(d, key), true, url);
        assert.deepEqual(d.tcpPosts, [url], 'the transition notice hears it');
        assert.deepEqual(d.tcpFlags, [{ taken: true, proxied: false }]);
      } else {
        assert.equal(res.statusCode, 403, url);
        assert.match(JSON.parse(res.body).error, /Unix socket only/);
        assert.equal(read, false, 'the body is never read');
        assert.equal(stored(d, key), false, url);
        assert.equal(res.headers.Connection, 'close');
        assert.deepEqual(d.tcpPosts, []);
      }
    }
  }
});

test('with ingest.tcp "off", or a setting it cannot read, the TCP port takes no ingest post at all', async () => {
  for (const ingest of [{ tcp: 'off' }, { tcp: 'on' }, { tcp: true }, 'legacy', ['legacy']]) {
    for (const [url, body, key] of POSTS) {
      const d = deps();
      const { res, read } = await call(tcpHandler(d, ingest), url, body);
      assert.equal(res.statusCode, 403, `${url} ${JSON.stringify(ingest)}`);
      assert.match(JSON.parse(res.body).error, /Unix socket only/);
      assert.equal(read, false);
      assert.equal(stored(d, key), false);
      assert.deepEqual(d.tcpPosts, []);
    }
  }
});

test('readIngestConfig: absent is the legacy transition; "off" closes it; anything else closes it and says why', () => {
  assert.deepEqual(readIngestConfig({}), { tcp: 'legacy', problems: [] });
  assert.deepEqual(readIngestConfig(null), { tcp: 'legacy', problems: [] });
  assert.deepEqual(readIngestConfig({ ingest: {} }), { tcp: 'legacy', problems: [] });
  assert.deepEqual(readIngestConfig({ ingest: { tcp: 'legacy' } }), { tcp: 'legacy', problems: [] });
  assert.deepEqual(readIngestConfig({ ingest: { tcp: 'off' } }), { tcp: 'off', problems: [] });
  for (const ingest of [{ tcp: 'on' }, { tcp: null }, { tcp: 'LEGACY' }, 'off', ['off'], 7]) {
    const r = readIngestConfig({ ingest });
    assert.equal(r.tcp, 'off', JSON.stringify(ingest));
    assert.equal(r.problems.length, 1);
  }
});

test('the legacy route refuses a post that came through Serve, before reading its body, and stores nothing', async () => {
  const cases = [
    VIA_SERVE,
    { 'x-forwarded-for': '100.64.0.9' }, // a proxy that kept the loopback Host
    { 'tailscale-user-login': 'owner@example.com' },
    { host: SERVE_HOST } // no proxy headers but the tailnet name
  ];
  for (const [url, body, key] of POSTS) {
    for (const headers of cases) {
      const d = deps();
      const { res, read } = await call(tcpHandler(d), url, body, headers);
      assert.equal(res.statusCode, 403, `${url} ${JSON.stringify(headers)}`);
      assert.match(JSON.parse(res.body).error, url === '/api/ingest/needs-you' ? /this machine only/ : /Unix socket only/);
      assert.equal(read, false, 'the body is never read');
      assert.equal(stored(d, key), false, url);
      if (url === '/api/ingest/needs-you') {
        // Reported as refused, with whether a proxy header came with it, so the
        // hour's log line counts it (Ultron's 4-M2); never as taken, so no alert.
        assert.deepEqual(d.tcpPosts, [url]);
        assert.deepEqual(d.tcpFlags, [{ taken: false, proxied: headers !== cases[3] }], JSON.stringify(headers));
      } else {
        assert.deepEqual(d.tcpPosts, [], 'another route on TCP is no transition use');
      }
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers.Connection, 'close', 'the unread body is never drained');
    }
    const d = deps();
    assert.equal((await call(tcpHandler(d), url, body, {}, '100.64.0.9')).res.statusCode, 403, `${url} from a tailnet address`);
    if (url === '/api/ingest/needs-you') assert.deepEqual(d.tcpFlags, [{ taken: false, proxied: false }]);
  }
});

test('a refusal is logged once per route and reason, naming no header value', async () => {
  const d = deps();
  const h = tcpHandler(d);
  for (let k = 0; k < 5; k++) await call(h, '/api/ingest/needs-you', POSTS[4][1], VIA_SERVE);
  for (let k = 0; k < 5; k++) await call(h, '/api/ingest/crons', [{ name: 'x' }], VIA_SERVE);
  await call(h, '/api/ingest/credits', { balance: 1 });
  const lines = d.logged.filter(l => l.startsWith('ingest:'));
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^ingest: refused a post to \/api\/ingest\/needs-you that did not come from this machine \(/);
  assert.equal(lines[1], 'ingest: refused a post to /api/ingest/crons on the TCP port (the ingest takes posts on its Unix socket only)');
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
test('over a real loopback socket: a plain needs-you post is taken in the transition, a forwarded one and every other ingest post refused', async () => {
  const d = deps();
  const server = createServer(tcpHandler(d));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = (path, payload, headers) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const wait = POSTS[4][1];
  try {
    assert.equal((await post('/api/ingest/needs-you', wait, { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': SERVE_HOST })).status, 403);
    assert.equal(d.needsYou.view(Date.now()).length, 0);
    assert.equal((await post('/api/ingest/needs-you', wait, { host: `${SERVE_HOST}` })).status, 403);
    const spoofed = await post('/api/ingest/needs-you', wait, { host: '127.0.0.1:8322', 'x-forwarded-for': '100.64.0.9' });
    assert.equal(spoofed.status, 403, 'a loopback Host does not get a forwarded post in');
    assert.equal((await post('/api/ingest/crons', [{ name: 'cloud-job', ok: true }], {})).status, 403, 'crons: socket only, even from this machine');
    assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable');
    assert.equal((await post('/api/ingest/needs-you', wait, {})).status, 200);
    assert.equal(d.needsYou.view(Date.now()).length, 1);
  } finally {
    await new Promise(r => server.close(r));
  }
});
