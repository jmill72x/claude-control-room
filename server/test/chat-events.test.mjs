// The chat's events in words (lib/chat-events.mjs): one log line each, the alerted
// kinds pushed too, and every verdict from the page (Deny or Allow) alerted with the
// device that tapped (board e8d3ef26, Ultron's 11-10 condition 4). A hostile device
// or tool name can't make a second log or alert line. The end-to-end tests run the
// real routes on their own sockets; every name, path and id is invented, and nothing
// touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { oneLine, chatEventLine, createChatEventHandler, ALERTED_KINDS, LINE_MAX, NTFY_WORDS } from '../lib/chat-events.mjs';
import { createApprovals, shownHash } from '../lib/approvals.mjs';
import { createChatStore } from '../lib/chat-store.mjs';
import { createDeviceStore, COOKIE_NAME, PAIR_COOKIE_NAME } from '../lib/chat-devices.mjs';
import { createSocketRouter, SESSION_HEADER } from '../lib/chat-socket.mjs';
import { createChatRoutes, createAdminRouter } from '../lib/chat-routes.mjs';

// Built from code points, never typed in (a typed escape has become the real
// character in this repo before).
const cp = n => String.fromCodePoint(n);
const LF = cp(0x0a), CR = cp(0x0d), NEL = cp(0x85), LS = cp(0x2028), PS = cp(0x2029), RLO = cp(0x202e), ZW = cp(0x200b), ESC = cp(0x1b), TAB = cp(0x09);
// Anything a log reader, a terminal or Discord could take as the end of a line, or
// that could reorder or hide what the line says.
const BREAKING = [LF, CR, NEL, LS, PS, cp(0x0b), cp(0x0c)];
const unsafeIn = s => [...s].filter(ch => { const c = ch.codePointAt(0); return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || c === 0x061c; });

// ---- the words ----

test('oneLine: line breaks, controls and direction or invisible characters become visible markers; a tab a space; plain text is untouched', () => {
  assert.equal(oneLine('a permission was denied from phone (Read)'), 'a permission was denied from phone (Read)');
  assert.equal(oneLine(`a${LF}b${CR}c${NEL}d${LS}e${PS}f`), 'a⟦U+000A⟧b⟦U+000D⟧c⟦U+0085⟧d⟦U+2028⟧e⟦U+2029⟧f');
  assert.equal(oneLine(`x${RLO}y${ZW}z${ESC}[2K`), 'x⟦U+202E⟧y⟦U+200B⟧z⟦U+001B⟧[2K');
  assert.equal(oneLine(`a${TAB}b`), 'a b');
  assert.equal(oneLine(cp(0x7f)), '⟦U+007F⟧');
  assert.equal(oneLine(cp(0x061c) + cp(0xfeff) + cp(0x2066)), '⟦U+061C⟧⟦U+FEFF⟧⟦U+2066⟧');
  assert.equal(oneLine('é 😀 ⟦ ok'), 'é 😀 ⟦ ok', 'other non-ASCII stays as it is');
  assert.equal(oneLine(null), '');
  for (let c = 0; c < 0x20; c++) assert.equal(unsafeIn(oneLine(`a${cp(c)}b`)).length, 0, `U+${c.toString(16)}`);
});

test('oneLine: a line over LINE_MAX code points keeps its start and says how much was cut', () => {
  assert.equal(oneLine('x'.repeat(LINE_MAX)), 'x'.repeat(LINE_MAX));
  const long = oneLine('😀'.repeat(LINE_MAX + 5));
  assert.equal(long, '😀'.repeat(LINE_MAX) + ' ⋯ 5 more cut', 'counted in code points');
  // A marker counts as what it shows, so a flood of line breaks is cut too.
  assert.ok(oneLine(LF.repeat(1000)).endsWith(' more cut'));
});

test('every alerted kind has its own words, on one line, whatever its fields carry', () => {
  const hostile = `evil${LF}chat: a permission was allowed from phone (Read)${CR}${LS}${RLO}`;
  const fields = { device: hostile, name: hostile, by: hostile, tool: hostile, unverified: hostile, previous: hostile, mode: hostile, relay: hostile, count: hostile, open: hostile, behavior: hostile, key: { name: hostile } };
  for (const kind of ALERTED_KINDS) {
    const plain = chatEventLine({ kind });
    assert.notEqual(plain, `chat event ${kind}`, `${kind} has words of its own`);
    const event = { kind, ...fields, device: kind === 'paired' || kind === 'revoked' || kind === 'approver-changed' ? { name: hostile } : hostile };
    const line = chatEventLine(event);
    assert.deepEqual(unsafeIn(line), [], kind);
    for (const b of BREAKING) assert.ok(!line.includes(b), kind);
  }
  assert.equal(new Set(ALERTED_KINDS).size, ALERTED_KINDS.length);
  assert.ok(ALERTED_KINDS.includes('verdict'));
  assert.ok(!ALERTED_KINDS.includes('permission-opened'), 'a request opening is logged, not pushed');
  assert.equal(chatEventLine({ kind: `odd${LF}kind` }), 'chat event odd⟦U+000A⟧kind', 'an unknown kind is one line too');
});

test('a verdict names what was decided, the device and the tool: Deny and Allow', () => {
  assert.equal(chatEventLine({ kind: 'verdict', requestId: 'abcde', behavior: 'denied', device: 'phone', tool: 'Read' }), 'a permission was denied from phone (Read)');
  assert.equal(chatEventLine({ kind: 'verdict', requestId: 'abcde', behavior: 'allowed', device: 'ipad', tool: 'Write' }), 'a permission was allowed from ipad (Write)');
  assert.equal(chatEventLine({ kind: 'verdict', behavior: 'denied' }), 'a permission was denied from a device (a tool)');
});

// ---- the handler: one log line per event, one push per alerted event ----

const capture = (opts = {}) => {
  const out = { logs: [], errors: [], sent: [] };
  out.handle = createChatEventHandler({
    send: async message => { if (opts.fail) throw new Error('no network'); out.sent.push(message); },
    log: line => out.logs.push(line),
    logError: (...a) => out.errors.push(a.join(' '))
  });
  return out;
};

test('the handler logs every event as one `chat:` line and pushes the alerted ones with the same words', async () => {
  const c = capture();
  await c.handle({ kind: 'verdict', requestId: 'abcde', behavior: 'denied', device: 'phone', tool: 'Read' });
  await c.handle({ kind: 'verdict', requestId: 'fghij', behavior: 'allowed', device: 'ipad', tool: 'Read' });
  await c.handle({ kind: 'permission-opened', requestId: 'kmnop', tool: 'Read' });
  assert.deepEqual(c.logs, ['chat: a permission was denied from phone (Read)', 'chat: a permission was allowed from ipad (Read)', 'chat: the lead asked for a permission (Read)']);
  assert.deepEqual(c.sent, ['a permission was denied from phone (Read)', 'a permission was allowed from ipad (Read)'], 'every verdict pushes, Deny and Allow; an opening does not');
  // Verdicts are never rate-limited: ten in a row are ten pushes.
  for (let i = 0; i < 10; i++) await c.handle({ kind: 'verdict', behavior: 'denied', device: 'phone', tool: 'Read' });
  assert.equal(c.sent.length, 12);
  assert.deepEqual(c.errors, []);
});

test('a refused channel pushes once per window (lib/chat-alert-limit.mjs), and the held-back one is logged', async () => {
  const c = capture();
  await c.handle({ kind: 'client-refused' });
  await c.handle({ kind: 'client-refused' });
  assert.equal(c.sent.length, 1);
  assert.deepEqual(c.logs.slice(-1), ['chat: alert held back (1 client-refused in this window)']);
});

test('a failed push is logged and never thrown; the log line is written first', async () => {
  const c = capture({ fail: true });
  await c.handle({ kind: 'verdict', behavior: 'denied', device: 'phone', tool: 'Read' });
  assert.deepEqual(c.logs, ['chat: a permission was denied from phone (Read)']);
  assert.deepEqual(c.errors, ['chat: alert failed no network']);
  await c.handle(undefined);
  assert.deepEqual(c.logs.at(-1), 'chat: chat event undefined');
});

test('ntfy gets generic words only (it shows on a lock screen, L10)', () => {
  assert.doesNotMatch(NTFY_WORDS, /phone|device|allow|deny/i);
  assert.match(NTFY_WORDS, /#pepper/);
});

// ---- end to end: the real routes, a hostile device name and a hostile tool name ----

const call = ({ socketPath, port, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({
    ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }), method, path,
    headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers }
  }, res => {
    const chunks = [];
    res.on('data', ch => chunks.push(ch));
    res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, json, text }); });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

const PAGE_HOST = 'jos.example.test';
const PAGE = { host: PAGE_HOST, origin: `https://${PAGE_HOST}`, 'sec-fetch-site': 'same-origin' };
const HOME = '/home/owner';
const FORGED = 'chat: a permission was allowed from phone (Read)';
// A name that went straight into devices.json (a local process that wrote it, or a
// name from before pairing cleaned names): pairing's cleanName never saw it.
const RAW_NAME = `mac${LF}${FORGED}${CR}${LS}${RLO}`;
const RAW_TOKEN = 'raw-device-token-0123456789abcdef';

async function setup() {
  const env = { clock: { t: 1794380000000 }, logs: [], sent: [], errors: [] };
  env.dir = await mkdtemp(join(tmpdir(), 'chat-events-'));
  const now = () => env.clock.t;
  const log = line => env.logs.push(line);
  const onEvent = createChatEventHandler({ send: async m => { env.sent.push(m); }, log, logError: (...a) => env.errors.push(a.join(' ')) });
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  const devicesPath = join(env.dir, 'devices.json');
  await writeFile(devicesPath, JSON.stringify([{ id: 'raw0000000000001', name: RAW_NAME, createdAt: env.clock.t, lastSeenAt: env.clock.t, login: null, tokenSha256: createHash('sha256').update(RAW_TOKEN).digest('hex'), revokedAt: null, approver: true }]), { mode: 0o600 });
  env.devices = createDeviceStore({ path: devicesPath, now, onEvent });
  await env.devices.load();
  env.approvals = createApprovals({ mode: 'on', killPath: '/k/approvals-off', exists: () => false, now, onEvent, home: HOME, realpath: () => null, isLead: () => true, isLink: () => false, isExecutable: () => false });
  env.socket = createSocketRouter({ store: env.store, now, onEvent, log, pingMs: 60, approvals: env.approvals, verifyRestart: async () => ({ ok: true }) });
  env.routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [PAGE_HOST] }, now, onEvent, log, pingMs: 60, approvals: env.approvals });
  env.sockPath = join(env.dir, 'c.sock');
  env.adminPath = join(env.dir, 'a.sock');
  env.servers = [createServer((q, s) => env.socket.handler(q, s)), createServer((q, s) => createAdminRouter({ devices: env.devices, onEvent })(q, s)), createServer((q, s) => env.routes.handler(q, s))];
  await new Promise(r => env.servers[0].listen(env.sockPath, r));
  await new Promise(r => env.servers[1].listen(env.adminPath, r));
  await new Promise(r => env.servers[2].listen(0, '127.0.0.1', r));
  env.port = env.servers[2].address().port;
  const pair = async name => {
    const s = await env.devices.start(name);
    assert.equal(s.ok, true);
    await env.devices.approve(s.code, { by: 'test' });
    const r = await env.devices.status(`${PAIR_COOKIE_NAME}=${s.pairToken}`);
    return `${COOKIE_NAME}=${r.token}`;
  };
  env.phone = await pair('phone');
  // Pairing cleans this one: its line break and direction mark become spaces.
  env.hostile = await pair(`ipad${CR}${LF}${FORGED}${RLO}`);
  env.raw = `${COOKIE_NAME}=${RAW_TOKEN}`;
  assert.equal((await call({ socketPath: env.adminPath, method: 'POST', path: '/admin/approver', body: { device: 'phone', on: true } })).status, 200);
  const h = await call({ socketPath: env.sockPath, method: 'POST', path: '/v1/hello', body: { pid: 1, relay: 'allow', test: false } });
  env.token = h.json.token;
  env.open = (requestId, tool = 'Read') => call({ socketPath: env.sockPath, method: 'POST', path: '/v1/permission-request', headers: { [SESSION_HEADER]: env.token }, body: { requestId, tool, description: 'look', inputPreview: JSON.stringify({ file_path: '/home/owner/Projects/app/README.md' }), relayedAt: env.clock.t } });
  env.tap = (id, cookie, behavior) => {
    const p = env.store.permission(id);
    return call({ port: env.port, method: 'POST', path: `/api/chat/permission/${id}`, headers: { ...PAGE, cookie }, body: { behavior, shown: shownHash(p.tool, p.description, p.inputPreview, p.exact) } });
  };
  // Settle the handler's pushes (onEvent is not awaited by the routes).
  env.settle = () => new Promise(r => setTimeout(r, 20));
  env.close = async () => { for (const s of env.servers) await new Promise(r => s.close(r)); await rm(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  return env;
}

// Every line logged or pushed is one line: no break of any kind and nothing that
// reorders it, and only the real verdicts start with the verdict words.
const assertOneLineEach = env => {
  for (const line of [...env.logs, ...env.sent]) {
    assert.deepEqual(unsafeIn(line), [], 'a logged or pushed line carries no break, control or direction character');
  }
};

test('end to end: Deny and Allow from the page each log one line and push one alert naming the device', async () => {
  const env = await setup();
  try {
    assert.equal((await env.open('abcde')).status, 200);
    const deny = await env.tap('abcde', env.phone, 'deny');
    assert.equal(deny.status, 200, deny.text);
    assert.equal((await env.open('fghij')).status, 200);
    const allow = await env.tap('fghij', env.phone, 'allow');
    assert.equal(allow.status, 200, allow.text);
    await env.settle();
    const verdictPushes = env.sent.filter(m => m.startsWith('a permission was'));
    assert.deepEqual(verdictPushes, ['a permission was denied from phone (Read)', 'a permission was allowed from phone (Read)']);
    assert.deepEqual(env.logs.filter(l => l.startsWith('chat: a permission was')), ['chat: a permission was denied from phone (Read)', 'chat: a permission was allowed from phone (Read)']);
    assert.deepEqual(env.logs.filter(l => l.startsWith('chat: permission ')), ['chat: permission abcde denied by phone', 'chat: permission fghij allowed by phone']);
    assertOneLineEach(env);
    assert.deepEqual(env.errors, []);
  } finally { await env.close(); }
});

test('end to end: a hostile device name (cleaned at pairing, or raw in devices.json) cannot forge a second log or alert line', async () => {
  const env = await setup();
  try {
    // Cleaned at pairing: one line, its forged words inside it, never at a line's start.
    assert.equal((await env.open('abcde')).status, 200);
    assert.equal((await env.tap('abcde', env.hostile, 'deny')).status, 200);
    // Raw from devices.json, an approver: Deny, then Allow.
    assert.equal((await env.open('fghij')).status, 200);
    assert.equal((await env.tap('fghij', env.raw, 'deny')).status, 200);
    assert.equal((await env.open('kmnop')).status, 200);
    const allow = await env.tap('kmnop', env.raw, 'allow');
    assert.equal(allow.status, 200, allow.text);
    await env.settle();
    assertOneLineEach(env);
    const verdicts = env.sent.filter(m => m.startsWith('a permission was'));
    assert.equal(verdicts.length, 3, 'three taps, three pushes, no forged fourth');
    assert.equal(env.logs.filter(l => l.startsWith('chat: a permission was')).length, 3, 'and three log lines');
    assert.equal(env.logs.filter(l => l.startsWith('chat: permission ')).length, 3);
    assert.ok(!env.sent.some(m => m === FORGED.slice('chat: '.length)), 'the forged words never stand alone');
    assert.equal(verdicts[0], 'a permission was denied from ipad chat: a permission was allowed from (Read)', 'cleaned to 40 code points of one line');
    const shownRaw = 'mac⟦U+000A⟧chat: a permission was allowed from phone (Read)⟦U+000D⟧⟦U+2028⟧⟦U+202E⟧';
    assert.deepEqual(verdicts.slice(1), [`a permission was denied from ${shownRaw} (Read)`, `a permission was allowed from ${shownRaw} (Read)`], 'the raw name shows its breaks as markers');
    assert.ok(env.logs.includes(`chat: permission kmnop allowed by ${shownRaw}`), 'the route\'s own log line too');
  } finally { await env.close(); }
});

test('end to end: a hostile tool name from the channel (capField keeps its line breaks) cannot forge a line either', async () => {
  const env = await setup();
  try {
    const tool = `Read${LF}${FORGED}${NEL}x`;
    assert.equal((await env.open('abcde', tool)).status, 200);
    assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 200);
    await env.settle();
    assertOneLineEach(env);
    assert.deepEqual(env.sent.filter(m => m.startsWith('a permission was')), [`a permission was denied from phone (Read⟦U+000A⟧${FORGED}⟦U+0085⟧x)`]);
    assert.equal(env.logs.filter(l => l.startsWith('chat: a permission was')).length, 1);
    assert.equal(env.logs.filter(l => l.startsWith('chat: the lead asked for a permission')).length, 1, 'the opening is one line as well');
  } finally { await env.close(); }
});

test('end to end: a refused verdict is logged on one line and pushes nothing', async () => {
  const env = await setup();
  try {
    assert.equal((await env.open('abcde')).status, 200);
    const r = await env.tap('abcde', env.hostile, 'allow');
    assert.equal(r.status, 403, 'the hostile device is no approver');
    await env.settle();
    assertOneLineEach(env);
    assert.equal(env.sent.filter(m => m.startsWith('a permission was')).length, 0);
    assert.equal(env.logs.filter(l => l.startsWith('chat: a verdict from ipad chat: a permission was allowed from was refused (403: ')).length, 1);
  } finally { await env.close(); }
});
