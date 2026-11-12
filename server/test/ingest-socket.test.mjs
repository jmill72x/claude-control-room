// The ingest's own Unix socket (lib/ingest-socket.mjs, routes.mjs createIngestHandler):
// the only way in for every /api/ingest/* route, 0600 in a 0700 folder of this user's.
// Everything runs on scratch sockets under a temporary folder, never the real state
// folder or the dashboard's port. Every name here is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, chmod, rm, stat, lstat, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createIngestHandler, createHandler, INGEST_ROUTES } from '../routes.mjs';
import { listenIngestSocket, checkSocketFile, createLegacyNotice, LEGACY_ALERT, startIngestSocket, INGEST_TRIES, INGEST_RETRY_MS, INGEST_OFF_ALERT, INGEST_LOST_ALERT } from '../lib/ingest-socket.mjs';
import { createCache } from '../cache.mjs';
import { createNeedsYouStore } from '../lib/needs-you.mjs';

const SID = 'a1b2c3d4-0000-4000-8000-00000000000a';
// macOS caps a Unix socket path at 104 bytes: keep the scratch folder short.
const scratch = async () => mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'is-'));
const clean = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const privateDir = async () => {
  const dir = await scratch();
  const sockDir = join(dir, 's');
  await mkdir(sockDir, { mode: 0o700 });
  await chmod(sockDir, 0o700);
  return { dir, path: join(sockDir, 'ingest.sock') };
};
const deps = () => {
  const logged = [];
  return {
    cache: createCache(),
    needsYou: createNeedsYouStore({ whoFor: () => null }),
    log: line => logged.push(line),
    logged,
    blocks: [],
    exact: []
  };
};
const handlerFor = d => createIngestHandler({ ...d, onBlock: v => { d.blocks.push(v); return true; }, onExact: v => { d.exact.push(v); return 'kept'; } });

const post = (socketPath, path, payload, { method = 'POST', headers = {} } = {}) => new Promise((resolve, reject) => {
  const body = payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
  const req = request({ socketPath, method, path, agent: false,
    headers: { host: 'localhost', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...headers } }, res => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  // A refused upload (the 413) may hang up while the body is still going out: the
  // answer counts, and a pipe error with no answer is that refusal seen from here.
  req.on('error', err => (err.code === 'EPIPE' || err.code === 'ECONNRESET') && payload && body.length > 256 * 1024 ? resolve({ status: 'hung up', text: '' }) : reject(err));
  req.end(body);
});
const close = server => new Promise(r => server.close(r));
// Every server a test opened is closed at the end, so a failed check never leaves the
// run hanging on a listener.
const opened = [];
const listen = async opts => {
  const r = await listenIngestSocket(opts);
  if (r.server) opened.push(r.server);
  return r;
};
after(async () => { for (const s of opened) if (s.listening) await close(s); });

const POSTS = {
  '/api/ingest/needs-you': { hook_event_name: 'Notification', session_id: SID, notification_type: 'permission_prompt' },
  '/api/ingest/exact-command': { hook_event_name: 'PermissionRequest', session_id: SID, tool_name: 'Bash', command: 'ls -la' },
  '/api/ingest/crons': [{ name: 'cloud-job', ok: false, last: 'Failed · 1' }],
  '/api/ingest/projects': [{ name: 'a-project' }],
  '/api/ingest/credits': { balance: 12.5, updatedAt: '2026-11-01' }
};

test('over the socket, every ingest route takes its post; the socket is 0600 and the folder 0700, both this user\'s', async () => {
  const { dir, path } = await privateDir();
  const d = deps();
  const { server, problems } = await listen({ path, handler: handlerFor(d) });
  try {
    assert.deepEqual(problems, []);
    assert.ok(server);
    const info = await lstat(path);
    assert.ok(info.isSocket());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.uid, process.getuid());
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.deepEqual([...INGEST_ROUTES].sort(), Object.keys(POSTS).sort(), 'every ingest route is tried here');
    for (const [route, body] of Object.entries(POSTS)) {
      const r = await post(path, route, body);
      assert.equal(r.status, 200, `${route} ${r.text}`);
    }
    assert.equal(d.needsYou.view(Date.now()).length, 1);
    assert.deepEqual(d.exact, [{ sessionId: SID, command: 'ls -la' }]);
    for (const key of ['ingestCrons', 'ingestProjects', 'ingestCredits']) assert.equal(d.cache.get(key, Date.now()).status, 'ok', key);
    // A classifier block over the socket reaches the gate too.
    const block = await post(path, '/api/ingest/needs-you', { hook_event_name: 'PermissionDenied', session_id: SID, tool_name: 'Bash', reason: '[Data Exfiltration]' });
    assert.deepEqual(JSON.parse(block.text), { ok: true, block: true });
    assert.equal(d.blocks.length, 1);
  } finally {
    if (server) await close(server);
    await clean(dir);
  }
});

test('the socket serves the ingest and nothing else, and keeps the ingest\'s own guards', async () => {
  const { dir, path } = await privateDir();
  const d = deps();
  const { server } = await listen({ path, handler: handlerFor(d) });
  try {
    for (const [method, route] of [['GET', '/api/dashboard'], ['GET', '/api/todos'], ['PUT', '/api/todos'], ['GET', '/api/health'], ['POST', '/api/acks'], ['GET', '/'], ['GET', '/api/ingest/needs-you'], ['POST', '/api/ingest/other'], ['POST', '/api/ingest/crons/']]) {
      const r = await post(path, route, method === 'GET' ? undefined : [], { method });
      assert.equal(r.status, 404, `${method} ${route}`);
    }
    assert.equal((await post(path, '/api/ingest/crons', POSTS['/api/ingest/crons'], { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post(path, '/api/ingest/crons', POSTS['/api/ingest/crons'], { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.ok([413, 'hung up'].includes((await post(path, '/api/ingest/crons', `[{"name":"${'x'.repeat(300 * 1024)}"}]`)).status));
    const bad = await post(path, '/api/ingest/crons', '{"token": "MARKER-q7q7" trailing');
    assert.equal(bad.status, 400);
    assert.deepEqual(JSON.parse(bad.text), { error: 'invalid JSON' });
    assert.equal(d.cache.get('ingestCrons', Date.now()).status, 'unavailable', 'nothing refused was stored');
    // Proxy headers mean nothing on the socket (only the file's mode does): a post
    // carrying them from a process that could open the socket is taken.
    assert.equal((await post(path, '/api/ingest/crons', POSTS['/api/ingest/crons'], { headers: { 'x-forwarded-for': '100.64.0.9' } })).status, 200);
  } finally {
    await close(server);
    await clean(dir);
  }
});

test('a socket folder open to others, missing, or not this user\'s keeps the socket off, and nothing listens', async () => {
  const dir = await scratch();
  try {
    for (const mode of [0o755, 0o750, 0o770, 0o701]) {
      const loose = join(dir, `m${mode.toString(8)}`);
      await mkdir(loose);
      await chmod(loose, mode);
      const path = join(loose, 'ingest.sock');
      const { server, problems } = await listen({ path, handler: handlerFor(deps()) });
      assert.equal(server, null, mode.toString(8));
      assert.match(problems.join(' '), /not 0700/);
      assert.equal(existsSync(path), false, 'no socket file was made');
    }
    const missing = await listen({ path: join(dir, 'nope', 'ingest.sock'), handler: handlerFor(deps()) });
    assert.equal(missing.server, null);
    assert.match(missing.problems[0], /does not exist/);
    const good = join(dir, 'good');
    await mkdir(good, { mode: 0o700 });
    await chmod(good, 0o700);
    const notOurs = await listen({ path: join(good, 'ingest.sock'), handler: handlerFor(deps()), uid: process.getuid() + 1 });
    assert.equal(notOurs.server, null);
    assert.match(notOurs.problems.join(' '), /not owned by this user/);
    assert.equal(existsSync(join(good, 'ingest.sock')), false);
  } finally {
    await clean(dir);
  }
});

test('a socket file left open to others is refused: closed, removed, and the reason given', async () => {
  const { dir, path } = await privateDir();
  try {
    // A chmod that leaves the socket world-writable (as a umask of 0 would).
    const { server, problems } = await listen({ path, handler: handlerFor(deps()), chmod: async p => chmod(p, 0o666) });
    assert.equal(server, null);
    assert.match(problems.join(' '), /is mode 666, not 0600/);
    assert.equal(existsSync(path), false, 'the refused socket is gone');
    // And a chmod that fails at all.
    const failed = await listen({ path, handler: handlerFor(deps()), chmod: async () => { const e = new Error('no'); e.code = 'EPERM'; throw e; } });
    assert.equal(failed.server, null);
    assert.match(failed.problems[0], /mode could not be set \(EPERM\)/);
    assert.equal(existsSync(path), false);
  } finally {
    await clean(dir);
  }
});

test('a socket file of another owner, or something that is not a socket, is refused (each check apart)', async () => {
  const { dir, path } = await privateDir();
  const fake = over => async p => { const real = await lstat(p); return { isSocket: () => real.isSocket(), uid: real.uid, mode: real.mode, ...over }; };
  try {
    const other = await listen({ path, handler: handlerFor(deps()), lstat: fake({ uid: process.getuid() + 1 }) });
    assert.equal(other.server, null);
    assert.deepEqual(other.problems, [`the ingest socket ${path} is not owned by this user`]);
    assert.equal(existsSync(path), false);
    const notSocket = await listen({ path, handler: handlerFor(deps()), lstat: fake({ isSocket: () => false }) });
    assert.equal(notSocket.server, null);
    assert.deepEqual(notSocket.problems, [`${path} is not a socket`]);
    // checkSocketFile on its own: a plain file, a loose mode, a missing path.
    const plain = join(dirname(path), 'plain');
    await writeFile(plain, '', { mode: 0o600 });
    assert.deepEqual(await checkSocketFile(plain), [`${plain} is not a socket`]);
    await chmod(plain, 0o640);
    assert.match((await checkSocketFile(plain)).join(' '), /mode 640, not 0600/);
    assert.match((await checkSocketFile(join(dirname(path), 'gone')))[0], /is not there/);
  } finally {
    await clean(dir);
  }
});

test('a server already answering on the path is left alone; a stale socket file is replaced', async () => {
  const { dir, path } = await privateDir();
  const first = await listen({ path, handler: handlerFor(deps()) });
  try {
    const second = await listen({ path, handler: handlerFor(deps()) });
    assert.equal(second.server, null);
    assert.match(second.problems[0], /already answering/);
    assert.equal((await post(path, '/api/ingest/projects', POSTS['/api/ingest/projects'])).status, 200, 'the first still answers');
  } finally {
    await close(first.server);
  }
  // A dead socket file (its server was killed, so nothing unlinked it).
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.ok((await lstat(path)).isSocket(), 'the stale socket file is there');
  const again = await listen({ path, handler: handlerFor(deps()) });
  try {
    assert.deepEqual(again.problems, []);
    assert.equal((await post(path, '/api/ingest/projects', POSTS['/api/ingest/projects'])).status, 200);
  } finally {
    await close(again.server);
    await clean(dir);
  }
});

// ---- the TCP transition's notice ----

test('the transition notice: a log line on the first post and at most hourly after, with the counts; an alert at most daily, for a taken post only', async () => {
  let now = 1_800_000_000_000;
  const logged = [];
  const alerts = [];
  const timers = [];
  const notice = createLegacyNotice({ log: l => logged.push(l), alert: async m => { alerts.push(m); }, clock: () => now, setTimer: (fn, ms) => timers.push({ fn, at: now + ms }) });
  notice('/api/ingest/needs-you');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(logged.length, 1);
  assert.equal(logged[0], 'ingest: 1 post to /api/ingest/needs-you over TCP, the old route, the first since the start (1 taken, 0 with a proxy header, refused, 0 refused otherwise); move the hooks to the ingest socket (README, "What the ingest endpoints require")');
  assert.deepEqual(alerts, [LEGACY_ALERT]);
  for (let k = 0; k < 9; k++) { now += 60e3; notice('/api/ingest/needs-you', { taken: k !== 3 && k !== 5, proxied: k === 3 }); }
  assert.equal(logged.length, 1, 'quiet inside the hour');
  now += 60 * 60e3;
  notice('/api/ingest/needs-you');
  assert.equal(logged.length, 2);
  assert.match(logged[1], /^ingest: 10 posts to \/api\/ingest\/needs-you over TCP, the old route, since the last such line \(8 taken, 1 with a proxy header, refused, 1 refused otherwise\);/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(alerts.length, 1, 'one alert a day');
  now += 24 * 60 * 60e3;
  notice('/api/ingest/needs-you', { taken: false, proxied: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(alerts.length, 1, 'a refused post never alerts: it reached nothing');
  notice('/api/ingest/needs-you');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(alerts.length, 2);
  // A failing alert is heard, never thrown into the request.
  const errors = [];
  const failing = createLegacyNotice({ log: () => {}, alert: async () => { throw new Error('ntfy down'); }, onError: e => errors.push(e.message), setTimer: () => {} });
  assert.doesNotThrow(() => failing('/api/ingest/needs-you'));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(errors, ['ntfy down']);
});

test('the alert says something here or a forwarder posted, and points to ingest.tcp "off" (Ultron\'s 4-L2)', () => {
  assert.match(LEGACY_ALERT, /^Something on this machine, or a forwarder, posted to the old TCP ingest/);
  assert.match(LEGACY_ALERT, /set ingest\.tcp to "off"/);
});

test('posts held inside the hour are written when the hour ends, so a trailing post is never left unreported (Ultron\'s 4-M2)', async () => {
  const T = 1_800_000_000_000;
  let now = T;
  const logged = [];
  let timers = [];
  const notice = createLegacyNotice({ log: l => logged.push(l), clock: () => now, setTimer: (fn, ms) => timers.push({ fn, at: now + ms }) });
  const tick = async to => { now = to; const due = timers.filter(t => t.at <= to); timers = timers.filter(t => t.at > to); for (const t of due) await t.fn(); };
  notice('/api/ingest/needs-you');
  assert.equal(timers.length, 0, 'nothing held, nothing scheduled');
  now = T + 5 * 60e3;
  notice('/api/ingest/needs-you', { taken: false, proxied: true });
  now = T + 7 * 60e3;
  notice('/api/ingest/needs-you');
  assert.equal(timers.length, 1, 'one timer for the hour, not one per post');
  assert.equal(timers[0].at, T + 60 * 60e3, 'set for an hour after the last line');
  await tick(T + 60 * 60e3 - 1);
  assert.equal(logged.length, 1);
  await tick(T + 60 * 60e3);
  assert.equal(logged.length, 2, 'the trailing posts, written when the hour ends');
  assert.match(logged[1], /^ingest: 2 posts to \/api\/ingest\/needs-you over TCP, the old route, since the last such line \(1 taken, 1 with a proxy header, refused, 0 refused otherwise\)/);
  // The written line starts the next hour: a post inside it waits for its end.
  now = T + 61 * 60e3;
  notice('/api/ingest/needs-you');
  assert.equal(logged.length, 2);
  // A post that lands after the hour writes the line itself; the late timer then
  // finds a newer line and writes nothing early.
  now = T + 121 * 60e3;
  notice('/api/ingest/needs-you');
  assert.equal(logged.length, 3);
  now = T + 122 * 60e3;
  notice('/api/ingest/needs-you');
  await tick(T + 122 * 60e3 + 1);
  assert.equal(logged.length, 3, 'the stale timer wrote nothing');
  await tick(T + 181 * 60e3);
  assert.equal(logged.length, 4);
  // An hour with nothing held writes nothing.
  await tick(T + 400 * 60e3);
  assert.equal(logged.length, 4);
});

test('the TCP handler reports every transition post, taken or refused, with whether it carried a proxy header; a notice that throws never fails the post', async () => {
  const d = deps();
  const seen = [];
  const base = { cache: d.cache, todos: { readState: async () => ({ todos: [], revision: null }) }, config: { present: true }, needsYou: d.needsYou, log: d.log };
  const mock = (headers = {}) => {
    const raw = JSON.stringify(POSTS['/api/ingest/needs-you']);
    const req = { method: 'POST', url: '/api/ingest/needs-you', headers: { host: '127.0.0.1:8322', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' },
      on(evt, fn) { if (evt === 'data') fn(Buffer.from(raw)); if (evt === 'end') fn(); return req; }, destroy() {}, unpipe() {}, pause() {} };
    const res = { statusCode: 200, headers: {}, body: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h ?? {}); }, setHeader() {}, end(b) { this.body = b ?? ''; } };
    return { req, res };
  };
  const h = createHandler({ ...base, onIngestTcp: (p, f) => seen.push([p, f]) });
  let { req, res } = mock();
  await h(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, [['/api/ingest/needs-you', { taken: true, proxied: false }]]);
  ({ req, res } = mock({ 'x-forwarded-for': '100.64.0.9' }));
  await h(req, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(seen[1], ['/api/ingest/needs-you', { taken: false, proxied: true }], 'a refused post is counted, as refused');
  ({ req, res } = mock({ host: 'mini.example.ts.net' }));
  await h(req, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(seen[2], ['/api/ingest/needs-you', { taken: false, proxied: false }]);
  const throwing = createHandler({ ...base, onIngestTcp: () => { throw new Error('boom'); } });
  ({ req, res } = mock());
  await throwing(req, res);
  assert.equal(res.statusCode, 200);
});

// ---- the socket at the start: tries, the alert, the umask (Ultron's 4-M1, 4-L1) ----

const startHarness = results => {
  const h = { listens: 0, sleeps: [], logs: [], errors: [], off: [], words: [] };
  h.state = startIngestSocket({
    path: '/nowhere/ingest.sock', handler: () => {},
    listen: async () => { const r = results[h.listens++]; if (r instanceof Error) throw r; return r; },
    sleep: async ms => { h.sleeps.push(ms); },
    log: l => h.logs.push(l), logError: (...a) => h.errors.push(a.join(' ')),
    onOff: (s, words) => { h.off.push(s.tries); h.words.push(words); }
  });
  return h;
};

test('a socket that fails at the start is tried four times, 10 s apart, then stays off and alerts once', async () => {
  assert.equal(INGEST_TRIES, 4);
  assert.equal(INGEST_RETRY_MS, 10e3);
  const fail = { server: null, problems: ['the socket folder is mode 755, not 0700'] };
  const h = startHarness([fail, fail, new Error('EADDRINUSE'), fail]);
  assert.equal(h.state.on, false, 'off until a try succeeds');
  await h.state.done;
  assert.equal(h.listens, 4);
  assert.deepEqual(h.sleeps, [10e3, 10e3, 10e3], 'three waits: 30 s in all');
  assert.equal(h.state.on, false);
  assert.deepEqual(h.off, [4], 'one alert, after the last try');
  assert.deepEqual(h.words, [INGEST_OFF_ALERT], 'in the start\'s words');
  assert.equal(h.errors.length, 4, 'each failed try says why');
  assert.match(h.errors[0], /^ingest: the socket folder is mode 755, not 0700; trying again in 10 s \(try 1 of 4\)$/);
  assert.match(h.errors[2], /did not start \(EADDRINUSE\); trying again/);
  assert.match(h.errors[3], /; the ingest socket stays off after 4 tries$/);
  assert.match(INGEST_OFF_ALERT, /Deny-only/);
  assert.ok(!INGEST_OFF_ALERT.includes('/'), 'the alert names no path');
});

test('a socket that starts on a later try is on, says so, and never alerts', async () => {
  const fail = { server: null, problems: ['busy'] };
  const server = new EventEmitter();
  const h = startHarness([fail, fail, { server, problems: [] }]);
  await h.state.done;
  assert.equal(h.state.on, true);
  assert.equal(h.state.server, server);
  assert.equal(h.listens, 3);
  assert.deepEqual(h.off, []);
  assert.deepEqual(h.logs, ['ingest: the socket started on try 3 of 4']);
  const first = startHarness([{ server, problems: [] }]);
  await first.state.done;
  assert.deepEqual([first.listens, first.sleeps, first.logs, first.off], [1, [], [], []], 'the first try needs no line and no wait');
});

test('an alert that fails is logged, never thrown', async () => {
  const errors = [];
  const state = startIngestSocket({ path: '/x', handler: () => {}, tries: 1, listen: async () => ({ server: null, problems: ['no'] }), sleep: async () => {}, logError: (...a) => errors.push(a.join(' ')), onOff: async () => { throw new Error('discord down'); } });
  await state.done;
  assert.match(errors.at(-1), /^ingest: the socket-off alert failed discord down$/);
});

test('the socket is bound under umask 077, so it is closed to others even before the chmod, and the umask is put back (Ultron\'s 4-L1)', async () => {
  const { dir, path } = await privateDir();
  const before = process.umask();
  try {
    // A chmod that does nothing: the mode must come from the bind itself.
    const calls = [];
    const r = await listen({ path, handler: handlerFor(deps()), chmod: async () => {}, umask: m => { calls.push(m); return process.umask(m); } });
    assert.deepEqual(r.problems, []);
    assert.equal((await lstat(path)).mode & 0o077, 0, 'no group or world bit, from the moment of the bind');
    assert.deepEqual(calls, [0o077, before], 'set for the bind, then put back');
    assert.equal(process.umask(), before, 'the umask is the one before');
    await close(r.server);
  } finally {
    process.umask(before);
    await clean(dir);
  }
});

// ---- the socket at run time (Ultron's 11-12 low): identity, close, error ----

// A started socket on a real file, with the alert recorded.
const runHarness = async () => {
  const { dir, path } = await privateDir();
  const h = { dir, path, errors: [], off: [] };
  h.state = startIngestSocket({
    path, handler: handlerFor(deps()), tries: 1,
    listen: async o => listen(o),
    logError: (...a) => h.errors.push(a.join(' ')),
    onOff: (s, words) => { h.off.push(words); }
  });
  await h.state.done;
  assert.equal(h.state.on, true, 'the socket started');
  return h;
};

test('listen keeps the socket file\'s device and inode, exactly as a bigint lstat reads them', async () => {
  const { dir, path } = await privateDir();
  try {
    const r = await listen({ path, handler: handlerFor(deps()) });
    const info = await lstat(path, { bigint: true });
    assert.deepEqual(r.identity, { dev: info.dev, ino: info.ino });
    assert.equal(typeof r.identity.ino, 'bigint');
    await close(r.server);
  } finally {
    await clean(dir);
  }
});

test('a socket file removed under the running server: check() says off, the alert goes once, and approvals are capped from then on', async () => {
  const h = await runHarness();
  try {
    assert.equal(h.state.check(), true, 'the bound file is there');
    assert.equal(h.state.check(), true, 'and checking twice changes nothing');
    await unlink(h.path);
    assert.equal(h.state.server.listening, true, 'the server still listens, on a file no hook can reach');
    assert.equal(h.state.check(), false);
    assert.equal(h.state.on, false);
    await h.state.lost;
    assert.deepEqual(h.off, [INGEST_LOST_ALERT], 'one alert, in the run-time words');
    assert.match(h.errors.at(-1), /^ingest: the ingest socket file was removed; the ingest socket is off until a restart$/);
    assert.equal(h.state.check(), false);
    await close(h.state.server);
    assert.deepEqual(h.off, [INGEST_LOST_ALERT], 'checked again and closed: still one alert');
    assert.equal(h.errors.length, 1, 'and one log line');
    assert.ok(!INGEST_LOST_ALERT.includes('/'), 'the alert names no path');
  } finally {
    if (h.state.server.listening) await close(h.state.server);
    await clean(h.dir);
  }
});

test('a socket file replaced at the path (another socket, or a plain file) is not the one bound', async () => {
  for (const kind of ['socket', 'file']) {
    const h = await runHarness();
    let other = null;
    try {
      await unlink(h.path);
      if (kind === 'socket') {
        other = createServer();
        await new Promise(r => other.listen(h.path, r));
        assert.ok((await lstat(h.path)).isSocket(), 'a socket again, this user\'s, but another inode');
      } else {
        await writeFile(h.path, 'x', { mode: 0o600 });
      }
      assert.equal(h.state.check(), false, kind);
      await h.state.lost;
      assert.match(h.errors.at(-1), /not the one bound \(replaced\); the ingest socket is off until a restart$/, kind);
      assert.deepEqual(h.off, [INGEST_LOST_ALERT], kind);
    } finally {
      if (other) await close(other);
      await close(h.state.server);
      await clean(h.dir);
    }
  }
});

test('a path with the bound device and inode that is no longer a socket (a reused inode number) is not the one bound', async () => {
  const server = new EventEmitter();
  const errors = [];
  let socket = true;
  const state = startIngestSocket({
    path: '/x', handler: () => {}, tries: 1,
    listen: async () => ({ server, problems: [], identity: { dev: 7n, ino: 42n } }),
    lstatSync: () => ({ dev: 7n, ino: 42n, isSocket: () => socket }),
    logError: (...a) => errors.push(a.join(' '))
  });
  await state.done;
  assert.equal(state.check(), true);
  socket = false;
  assert.equal(state.check(), false);
  assert.match(errors.at(-1), /not the one bound \(replaced\)/);
});

test('the server closing or failing at run time turns the socket off and alerts once; an error never throws', async () => {
  const h = await runHarness();
  try {
    h.state.server.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' }));
    assert.equal(h.state.on, false, 'an error turns it off');
    assert.equal(h.state.check(), false);
    await h.state.lost;
    assert.match(h.errors.at(-1), /^ingest: the ingest socket failed \(EMFILE\); the ingest socket is off until a restart$/);
    await close(h.state.server);
    assert.deepEqual(h.off, [INGEST_LOST_ALERT], 'the close after it adds no second alert');
  } finally {
    await clean(h.dir);
  }
  const c = await runHarness();
  try {
    await close(c.state.server);
    assert.equal(c.state.on, false, 'a close turns it off');
    await c.state.lost;
    assert.match(c.errors.at(-1), /^ingest: the ingest socket closed; the ingest socket is off until a restart$/);
    assert.deepEqual(c.off, [INGEST_LOST_ALERT]);
    assert.equal(c.state.check(), false);
  } finally {
    await clean(c.dir);
  }
});

test('a socket that never started is never checked against a file, and alerts once with the start\'s words', async () => {
  const errors = [], off = [];
  let lstats = 0;
  const state = startIngestSocket({
    path: '/x', handler: () => {}, tries: 1, sleep: async () => {},
    listen: async () => ({ server: null, problems: ['no'] }),
    lstatSync: () => { lstats++; throw new Error('never'); },
    logError: (...a) => errors.push(a.join(' ')), onOff: (s, w) => { off.push(w); }
  });
  await state.done;
  assert.equal(state.check(), false);
  assert.equal(lstats, 0);
  assert.deepEqual(off, [INGEST_OFF_ALERT]);
});

// The wiring lives in server.mjs, which starts `claude -p` and can't run in a test:
// a merge must keep it (Ultron, 11-12).
test('server.mjs: the socket is started with retries and the off alert, and approvals are Deny-only while it is off and the TCP route closed', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /const ingestSocket = startIngestSocket\(\{[\s\S]*?onOff: async \(_, words\) => sendAlert\(\{[^\n]*message: words,/);
  assert.match(src, /\nconst ingestOk = \(\) => ingestSocket\.check\(\) \|\| ingestSettings\.tcp === 'legacy';\n/, 'the file is checked on each approval, first');
  const approvals = src.slice(src.indexOf('approvals = createApprovals({'));
  assert.match(approvals.slice(0, approvals.indexOf('\n  });') + 1), /\n    ingestOk\n/, 'createApprovals gets ingestOk');
  assert.ok(!/listenIngestSocket\(/.test(src), 'no single-try start left behind');
});

// ---- the README's hook entries, run for real over a scratch socket ----

const readmeEntries = async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const entry = heading => JSON.parse(readme.slice(readme.indexOf(heading)).match(/```json\n([\s\S]*?)\n```/)[1]);
  const waits = entry('### A session waiting on you');
  const denied = entry('**The classifier-block hook.**');
  return [...Object.values(waits.hooks), ...Object.values(denied.hooks)].flatMap(list => list.flatMap(m => m.hooks.map(h => h.command)));
};

test('the README\'s needs-you and PermissionDenied hooks post to the socket under $HOME, never to a TCP port, and exit 0 silently with the server down', async t => {
  if (!existsSync('/usr/bin/jq') || !existsSync('/usr/bin/curl')) return t.skip('needs /usr/bin/jq and /usr/bin/curl');
  const commands = await readmeEntries();
  assert.equal(commands.length, 6);
  for (const c of commands) {
    assert.ok(!/127\.0\.0\.1|8322|:\/\/[^/]*:\d/.test(c), `no TCP address: ${c}`);
    assert.ok(c.includes('--unix-socket "$HOME/.local/state/jarvis-os/ingest.sock"'), c);
  }
  const home = await scratch();
  const socketPath = join(home, '.local', 'state', 'jarvis-os', 'ingest.sock');
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  const d = deps();
  const { server, problems } = await listen({ path: socketPath, handler: handlerFor(d) });
  assert.deepEqual(problems, []);
  const run = (cmd, input) => new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: home } });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
  const hookInput = event => JSON.stringify({ hook_event_name: event, session_id: SID, notification_type: 'permission_prompt', tool_name: 'Bash', reason: '[Data Exfiltration]', tool_input: { command: 'cat secret-marker' }, transcript_path: '/home/owner/x.jsonl' });
  try {
    const [notification, ...rest] = commands;
    assert.deepEqual(await run(notification, hookInput('Notification')), { code: 0, out: '', err: '' });
    assert.equal(d.needsYou.view(Date.now()).length, 1, 'the wait opened over the socket');
    // PostToolUse, UserPromptSubmit, Stop, SessionEnd clear; PermissionDenied blocks.
    const events = ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PermissionDenied'];
    for (const [k, c] of rest.entries()) {
      assert.deepEqual(await run(c, hookInput(events[k])), { code: 0, out: '', err: '' }, events[k]);
    }
    assert.equal(d.needsYou.view(Date.now()).length, 0, 'cleared over the socket');
    assert.equal(d.blocks.length, 1, 'the PermissionDenied post reached the gate');
    assert.ok(!JSON.stringify(d.blocks).includes('secret-marker'));
  } finally {
    await close(server);
  }
  // The server is gone (the socket file with it): exit 0, silent, at once.
  const started = Date.now();
  for (const c of commands) assert.deepEqual(await run(c, hookInput('Stop')), { code: 0, out: '', err: '' });
  assert.ok(Date.now() - started < 3000);
  await clean(home);
});
