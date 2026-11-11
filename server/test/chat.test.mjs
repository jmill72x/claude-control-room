// The chat (jarvis-os-chat-spec.md, C2): the store, the devices and pairing, the
// channel's Unix-socket API, the page's TCP routes, SSE replay, verdicts and
// status, run against real servers on a temp socket and a loopback port. Every
// name, id and message here is invented; nothing touches :8322 or data/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, stat, utimes, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createChatStore, newMessageId, sniffType, isMessageId, publicMessage,
  PERMISSION_TTL_MS, PREVIEW_TTL_MS, EDIT_WINDOW_MS, UNANSWERED_MAX, ATTACHMENT_TTL_MS
} from '../lib/chat-store.mjs';
import { createDeviceStore, readCookie, cookieHeader, newCode, COOKIE_NAME, PAIR_COOKIE_NAME, DEVICES_MAX } from '../lib/chat-devices.mjs';
import { createSocketRouter, inboundEvent, HEARTBEAT_FRESH_MS } from '../lib/chat-socket.mjs';
import { createChatRoutes, createAdminRouter, chatState, SLOW_AFTER_MS } from '../lib/chat-routes.mjs';
import { secretShapes } from '../lib/secret-shape.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

// ---- the store ----

test('ids, sniffing and the public shape', () => {
  const id = newMessageId(1794380000000);
  assert.ok(isMessageId(id), id);
  assert.notEqual(newMessageId(1794380000000), id);
  assert.equal(sniffType(PNG), 'image/png');
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniffType(Buffer.from('%PDF-1.4 hello world')), 'application/pdf');
  assert.equal(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffType(Buffer.from('hi')), null);
  const m = { seq: 1, id, at: 1, from: 'jeff', kind: 'chat', text: 'hi', clientId: 'c1', attachments: [{ id: 'a'.repeat(32), name: 'x.png', type: 'image/png', bytes: 3, sha256: 'h' }] };
  const p = publicMessage(m);
  assert.ok(!('clientId' in p));
  assert.ok(!('sha256' in p.attachments[0]));
  assert.equal(p.replyTo, null);
});

test('messages get seqs and persist whole; a reload continues the seq and keeps the epoch; a new dir gets a new one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    const first = await store.load();
    assert.deepEqual(first, { messages: 0, seq: 0, epoch: store.epoch, deliveredSeq: 0 });
    assert.match(store.epoch, /^[a-f0-9]{16}$/);
    const a = await store.append({ from: 'jeff', kind: 'chat', text: 'hello', device: 'phone', clientId: 'c1' });
    clock.t += 1000;
    const b = await store.append({ from: 'jarvis', kind: 'chat', text: 'hi', replyTo: a.id, clientId: 'r1' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(b.replyTo, a.id);
    assert.equal(await store.append({ from: 'jeff', kind: 'chat', text: 'again', clientId: 'c1' }), a, 'a repeated clientId is the same message');
    const files = (await readdir(dir)).filter(n => n.startsWith('messages-'));
    assert.equal(files.length, 1);
    assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'cursor.json'))).mode & 0o777, 0o600);

    const again = createChatStore({ dir, now: () => clock.t });
    const loaded = await again.load();
    assert.equal(loaded.messages, 2);
    assert.equal(loaded.seq, 2);
    assert.equal(again.epoch, store.epoch, 'the epoch lives with the store');
    const c = await again.append({ from: 'jeff', kind: 'chat', text: 'more', clientId: 'c2' });
    assert.equal(c.seq, 3, 'never reused');
    assert.equal(again.byClientId('c1').id, a.id, 'clientIds are known after a reload');

    const other = createChatStore({ dir: join(dir, 'fresh'), now: () => clock.t });
    await other.load();
    assert.notEqual(other.epoch, store.epoch);
    await assert.rejects(store.append({ from: 'nobody', text: 'x' }), /from/);
    await assert.rejects(store.append({ from: 'jeff', text: 'x'.repeat(32001) }), /32000/);
    await assert.rejects(store.append({ from: 'jeff', text: 'x', clientId: 'bad id!' }), /clientId/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an edit changes only the lead's own chat message within 24 hours, and survives a reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    await store.load();
    const j = await store.append({ from: 'jeff', text: 'q', clientId: 'c1' });
    const r = await store.append({ from: 'jarvis', text: 'a', clientId: 'r1' });
    assert.equal((await store.edit(j.id, 'x')).status, 403);
    assert.equal((await store.edit('m_nothere1', 'x')).status, 404);
    assert.equal((await store.edit(r.id, 'y'.repeat(32001))).status, 400);
    clock.t += 1000;
    const ok = await store.edit(r.id, 'a, corrected');
    assert.equal(ok.ok, true);
    assert.equal(ok.message.editedAt, clock.t);
    clock.t += EDIT_WINDOW_MS;
    assert.equal((await store.edit(r.id, 'too late')).status, 403);
    const again = createChatStore({ dir, now: () => clock.t });
    await again.load();
    assert.equal(again.get(r.id).text, 'a, corrected');
    assert.equal(again.get(r.id).editedAt, ok.message.editedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listing after a seq or before an id, the unanswered rule, and the delivery cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    await store.load();
    const ids = [];
    for (let i = 1; i <= 5; i++) { ids.push((await store.append({ from: 'jeff', text: `q${i}`, clientId: `c${i}`, state: 'queued' })).id); clock.t += 1000; }
    assert.deepEqual(store.list({ after: 3 }).map(m => m.seq), [4, 5]);
    assert.deepEqual(store.list({ after: 0, limit: 2 }).map(m => m.seq), [1, 2]);
    assert.deepEqual(store.list({ before: ids[3], limit: 2 }).map(m => m.seq), [2, 3]);
    assert.deepEqual(store.list({ before: 'm_unknown1', limit: 2 }).map(m => m.seq), [4, 5], 'an unknown id reads as the end');
    assert.equal(store.list({ after: 0, limit: 500 }).length, 5, 'capped at 100 per page');
    // Unanswered: everything of the owner's after the lead's last message.
    assert.deepEqual(store.unanswered().map(m => m.text), ['q1', 'q2', 'q3', 'q4', 'q5']);
    await store.append({ from: 'jarvis', text: 'a', clientId: 'r1' });
    assert.deepEqual(store.unanswered(), []);
    await store.append({ from: 'jeff', text: 'q6', clientId: 'c6' });
    assert.deepEqual(store.unanswered().map(m => m.text), ['q6']);
    for (let i = 7; i <= 20; i++) await store.append({ from: 'jeff', text: `q${i}`, clientId: `c${i}` });
    assert.equal(store.unanswered().length, UNANSWERED_MAX);
    await store.append({ from: 'jeff', text: 'x'.repeat(9000), clientId: 'big' });
    assert.equal(store.unanswered().length, UNANSWERED_MAX, 'the big one is past both caps');
    clock.t += DAY + 1;
    assert.deepEqual(store.unanswered(), [], 'nothing within 24 hours');
    // The cursor: forward only, never past the last seq, and queued messages up to it become delivered.
    assert.equal(store.deliveredSeq, 0);
    assert.equal(await store.ack(3), 3);
    assert.equal(await store.ack(2), 3, 'never back');
    assert.equal(await store.ack(999), 3, 'never past what exists');
    assert.deepEqual(store.list({ after: 0, limit: 5 }).map(m => m.state), ['delivered', 'delivered', 'delivered', 'queued', 'queued']);
    const again = createChatStore({ dir, now: () => clock.t });
    await again.load();
    assert.equal(again.deliveredSeq, 3);
    assert.equal(again.get(ids[0]).state, 'delivered', 'the state change is on file');
    assert.equal(again.lastJarvisAt() > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('permissions: opened as a message, first answer wins, expiry at 10 minutes, the preview stripped after 24 hours', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    await store.load();
    const events = [];
    store.subscribe(e => events.push(e.type));
    const p = await store.openPermission({ requestId: 'ABCDE', tool: 'Bash', description: 'run the tests', inputPreview: 'npm test' });
    assert.equal(p.state, 'open');
    assert.ok(isMessageId(p.messageId));
    assert.equal(store.get(p.messageId).kind, 'permission');
    assert.deepEqual(store.get(p.messageId).meta, { requestId: 'ABCDE', tool: 'Bash' });
    assert.equal(await store.openPermission({ requestId: 'ABCDE', tool: 'Bash', description: 'again' }), p, 'a repeated id is the same request');
    await assert.rejects(store.openPermission({ requestId: 'bad id!' }), /requestId/);
    assert.equal(store.openPermissions().length, 1);
    assert.equal((await store.answerPermission('ABCDE', 'maybe', 'phone')).status, 400);
    assert.equal((await store.answerPermission('NOPE', 'allow', 'phone')).status, 404);
    const first = await store.answerPermission('ABCDE', 'allow', 'phone');
    assert.equal(first.ok, true);
    assert.equal(first.request.state, 'allowed');
    assert.equal(first.request.answeredBy, 'phone');
    const second = await store.answerPermission('ABCDE', 'deny', 'ipad');
    assert.equal(second.status, 409, 'first answer wins');
    const verdict = store.list({ after: 0 }).find(m => m.kind === 'verdict');
    assert.deepEqual([verdict.from, verdict.text, verdict.replyTo, verdict.device, verdict.meta], ['jeff', 'allow', p.messageId, 'phone', { requestId: 'ABCDE', behavior: 'allow' }]);
    assert.deepEqual(events, ['message', 'permission', 'message', 'permission-closed']);
    // Expiry.
    const q = await store.openPermission({ requestId: 'FGHIJ', tool: 'Edit', description: 'edit a file', inputPreview: 'secret-ish' });
    clock.t += PERMISSION_TTL_MS;
    assert.deepEqual(store.openPermissions(), []);
    assert.equal(store.permission('FGHIJ').state, 'expired');
    assert.equal((await store.answerPermission('FGHIJ', 'allow', 'phone')).status, 409);
    assert.equal(store.permission('FGHIJ').inputPreview, 'secret-ish');
    clock.t += PREVIEW_TTL_MS;
    assert.equal(store.permission('FGHIJ').inputPreview, null, 'the preview is gone after a day');
    void q;
    const longPreview = await store.openPermission({ requestId: 'KLMNO', tool: 'Bash', description: 'd', inputPreview: 'x'.repeat(5000) });
    assert.equal(longPreview.inputPreview.length, 3500, 'capped at 3,500 code points');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('attachments: only sniffed images, pdf or declared text, under 10 MB, as 0600 files named by a random id, pruned after 90 days', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    await store.load();
    const a = await store.putAttachment({ name: '../evil/../photo.png', type: 'image/png', data: PNG });
    assert.match(a.id, /^[a-f0-9]{32}$/);
    assert.equal(a.name, '.._evil_.._photo.png', 'the name is cleaned, and never used as a path');
    assert.equal(a.type, 'image/png');
    assert.equal(a.bytes, PNG.length);
    assert.match(a.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await stat(join(dir, 'files', a.id))).mode & 0o777, 0o600);
    assert.equal(store.attachment(a.id), null, 'not on a message yet');
    const m = await store.append({ from: 'jeff', text: '', clientId: 'c1', attachments: [a] });
    assert.equal(store.attachment(a.id).path, join(dir, 'files', a.id));
    assert.equal(store.attachmentPath(a.id), join(dir, 'files', a.id));
    assert.equal(store.attachmentPath('../x'), null);
    const t = await store.putAttachment({ name: 'notes.md', type: 'text/markdown', data: Buffer.from('# hello') });
    assert.equal(t.type, 'text/markdown');
    for (const [why, args] of [
      ['declared png, not png', { name: 'x.png', type: 'image/png', data: Buffer.from('hello world, not a png') }],
      ['svg', { name: 'x.svg', type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }],
      ['html as text', { name: 'x.html', type: 'text/html', data: Buffer.from('<script>1</script>') }],
      ['text with NUL', { name: 'x.txt', type: 'text/plain', data: Buffer.from('a\u0000b') }],
      ['empty', { name: 'x.png', type: 'image/png', data: Buffer.alloc(0) }]
    ]) {
      await assert.rejects(store.putAttachment(args), undefined, why);
    }
    await assert.rejects(store.putAttachment({ name: 'big.png', type: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]) }), err => err.status === 413);
    // Pruning by age.
    const old = new Date(clock.t - ATTACHMENT_TTL_MS - DAY);
    await utimes(join(dir, 'files', a.id), old, old);
    assert.equal(await store.pruneAttachments(), 1);
    assert.deepEqual(await readdir(join(dir, 'files')), [t.id]);
    assert.equal(store.get(m.id).attachments[0].id, a.id, 'the message keeps its record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt line, a duplicate id and a foreign file in the chat folder are skipped on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const store = createChatStore({ dir, now: () => 1794380000000 });
    await store.load();
    const a = await store.append({ from: 'jeff', text: 'one', clientId: 'c1' });
    const file = (await readdir(dir)).find(n => n.startsWith('messages-'));
    await writeFile(join(dir, file), `{not json\n${JSON.stringify({ op: 'message', ...a })}\n{"op":"edit","id":"m_nothere1","text":"x"}\n`, { flag: 'a' });
    await writeFile(join(dir, 'messages-notes.txt'), 'ignored');
    const again = createChatStore({ dir, now: () => 1794380000000 });
    assert.equal((await again.load()).messages, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secret shapes are named, never quoted', () => {
  assert.deepEqual(secretShapes('plain words about the weather'), []);
  assert.deepEqual(secretShapes('here: sk-ant-api03-' + 'A'.repeat(40)), ['an Anthropic key']);
  assert.deepEqual(secretShapes('ghp_' + 'x'.repeat(36)), ['a GitHub token']);
  // Assembled at run time, so the file itself never holds the shape a scanner looks for.
  assert.deepEqual(secretShapes(['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')), ['a private key block']);
  assert.deepEqual(secretShapes('tskey-auth-' + 'k'.repeat(20)), ['a Tailscale key']);
  assert.deepEqual(secretShapes(null), []);
});

// ---- devices and pairing ----

test('pairing: a code and a pairing cookie, three wrong tries, approval, the cookie collected once; at most 4 devices; revoke', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  try {
    const clock = { t: 1794380000000 };
    const events = [];
    const devices = createDeviceStore({ path: join(dir, 'devices.json'), now: () => clock.t, onEvent: e => events.push(e.kind) });
    assert.equal(await devices.load(), 0);
    assert.equal((await devices.start('')).status, 400);
    const s = await devices.start("  Jeff's ‮phone  ");
    assert.equal(s.ok, true);
    assert.match(s.code, /^[A-HJ-KM-NP-Z]{6}$/);
    assert.equal(s.expiresAt, clock.t + 10 * MIN);
    assert.equal((await devices.start('another')).status, 409, 'one pending at a time');
    const pairCookie = `${PAIR_COOKIE_NAME}=${s.pairToken}`;
    assert.deepEqual(await devices.status(pairCookie), { ok: true, state: 'pending', expiresAt: s.expiresAt });
    assert.deepEqual(await devices.status('nothing=here'), { ok: true, state: 'none' });
    assert.equal((await devices.approve('WRONG1', { by: 'test' })).status, 400);
    assert.equal((await devices.approve('WRONG2', { by: 'test' })).status, 400);
    assert.equal((await devices.approve('WRONG3', { by: 'test' })).status, 429);
    assert.deepEqual(events, ['pairing-failed']);
    assert.equal((await devices.approve(s.code, { by: 'test' })).status, 404, 'the pairing is gone');
    const s2 = await devices.start('phone');
    assert.equal((await devices.approve(s2.code.toLowerCase(), { by: 'test', login: 'owner@example' })).ok, true, 'case does not matter');
    assert.equal((await devices.approve(s2.code, { by: 'test' })).status, 409);
    const got = await devices.status(`${PAIR_COOKIE_NAME}=${s2.pairToken}`);
    assert.equal(got.state, 'paired');
    assert.equal(got.device.name, 'phone');
    assert.match(got.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await devices.status(`${PAIR_COOKIE_NAME}=${s2.pairToken}`), { ok: true, state: 'none' }, 'collected once');
    assert.deepEqual(events, ['pairing-failed', 'paired']);
    const onDisk = JSON.parse(await readFile(join(dir, 'devices.json'), 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.ok(!JSON.stringify(onDisk).includes(got.token), 'only the hash is on file');
    assert.equal(onDisk[0].login, 'owner@example');
    assert.equal((await stat(join(dir, 'devices.json'))).mode & 0o777, 0o600);
    const d = devices.authenticate(`other=1; ${COOKIE_NAME}=${got.token}`);
    assert.equal(d.name, 'phone');
    assert.equal(devices.authenticate(`${COOKIE_NAME}=${got.token.slice(1)}x`), null);
    assert.equal(devices.authenticate(''), null);
    assert.ok(!('tokenSha256' in devices.list()[0]));
    // An expired pairing.
    const s3 = await devices.start('ipad');
    clock.t += 10 * MIN;
    assert.deepEqual(await devices.status(`${PAIR_COOKIE_NAME}=${s3.pairToken}`), { ok: true, state: 'expired' });
    assert.equal((await devices.approve(s3.code, { by: 'test' })).status, 404);
    // The cap.
    for (const name of ['two', 'three', 'four']) {
      const st = await devices.start(name);
      await devices.approve(st.code, { by: 'test' });
      await devices.status(`${PAIR_COOKIE_NAME}=${st.pairToken}`);
    }
    assert.equal(devices.list().filter(x => !x.revokedAt).length, DEVICES_MAX);
    assert.equal((await devices.start('five')).status, 409);
    assert.equal((await devices.revoke(d.id, 'phone')).ok, true);
    assert.equal(devices.authenticate(`${COOKIE_NAME}=${got.token}`), null, 'revoked');
    assert.equal((await devices.revoke(d.id, 'phone')).status, 404);
    assert.equal((await devices.start('five')).ok, true, 'room again');
    assert.equal(readCookie('a=1; __Host-jos=abc; b=2', '__Host-jos'), 'abc');
    assert.match(cookieHeader('__Host-jos', 'abc', 10), /^__Host-jos=abc; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=10$/);
    assert.match(newCode(), /^[A-HJ-KM-NP-Z]{6}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the servers ----

const call = ({ socketPath, port, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = request({
    ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }), method, path,
    headers: { ...(raw && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Length': raw.length } : {}), ...headers }
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(text.toString('utf8')); } catch { json = null; }
      resolve({ status: res.statusCode, headers: res.headers, text: text.toString('utf8'), buf: text, json });
    });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

// A streaming GET: collect what arrives for `ms`, then hang up.
const stream = ({ socketPath, port, path, headers = {}, ms = 300 }) => new Promise((resolve, reject) => {
  const req = request({ ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }), method: 'GET', path, headers }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', c => { text += c; });
    const done = () => resolve({ status: res.statusCode, headers: res.headers, text });
    res.on('end', done);
    setTimeout(() => { req.destroy(); done(); }, ms);
  });
  req.on('error', reject);
  req.end();
});
const ndjson = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l));
const sse = text => text.split('\n\n').filter(b => b.trim()).map(block => {
  const ev = { comment: null };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) ev.comment = line.slice(1).trim();
    else if (line.startsWith('event: ')) ev.event = line.slice(7);
    else if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
    else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
    else if (line.startsWith('retry: ')) ev.retry = Number(line.slice(7));
  }
  return ev;
});

const env = {};
before(async () => {
  env.dir = await mkdtemp(join(tmpdir(), 'chat-srv-'));
  env.clock = { t: 1794380000000 };
  env.events = [];
  const now = () => env.clock.t;
  const onEvent = e => env.events.push(e);
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  env.devices = createDeviceStore({ path: join(env.dir, 'devices.json'), now, onEvent });
  await env.devices.load();
  env.socket = createSocketRouter({ store: env.store, now, onEvent, log: () => {}, pingMs: 60 });
  env.routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: {}, now, onEvent, log: () => {}, pingMs: 60 });
  env.admin = createAdminRouter({ devices: env.devices, onEvent });
  env.sockPath = join(env.dir, 'channel.sock');
  env.adminPath = join(env.dir, 'admin.sock');
  env.unix = createServer((req, res) => env.socket.handler(req, res));
  await new Promise(r => env.unix.listen(env.sockPath, r));
  env.adminSrv = createServer((req, res) => env.admin(req, res));
  await new Promise(r => env.adminSrv.listen(env.adminPath, r));
  env.tcp = createServer((req, res) => env.routes.handler(req, res));
  await new Promise(r => env.tcp.listen(0, '127.0.0.1', r));
  env.port = env.tcp.address().port;
});
after(async () => {
  for (const s of [env.unix, env.adminSrv, env.tcp]) await new Promise(r => s.close(r));
  await rm(env.dir, { recursive: true, force: true });
});

const unix = (opts) => call({ socketPath: env.sockPath, ...opts });
const tcp = (opts) => call({ port: env.port, ...opts });

test('socket: hello gives the cursor and epoch; a second pid while the heartbeat is fresh is refused; the same pid or a stale one takes over', async () => {
  const noHello = await unix({ method: 'POST', path: '/v1/heartbeat' });
  assert.equal(noHello.status, 409);
  const h = await unix({ method: 'POST', path: '/v1/hello', body: { pid: 100, version: '0.1', startedAt: env.clock.t } });
  assert.equal(h.status, 200, h.text);
  assert.deepEqual(h.json, { cursor: 0, epoch: env.store.epoch, seq: 0 });
  const other = await unix({ method: 'POST', path: '/v1/hello', body: { pid: 200, version: '0.1' } });
  assert.equal(other.status, 409);
  assert.deepEqual(other.json, { error: 'another channel is connected and its heartbeat is fresh' });
  assert.deepEqual(env.events.at(-1), { kind: 'client-refused', pid: 200, current: 100 });
  assert.equal((await unix({ method: 'POST', path: '/v1/hello', body: { pid: 100 } })).status, 200, 'the same pid again is fine');
  const hb = await unix({ method: 'POST', path: '/v1/heartbeat' });
  assert.deepEqual(hb.json, { ok: true, openPermissions: 0 });
  assert.equal(env.socket.status().channelConnected, true);
  env.clock.t += HEARTBEAT_FRESH_MS;
  assert.equal(env.socket.status().channelConnected, false, 'stale at 45 s');
  assert.equal((await unix({ method: 'POST', path: '/v1/hello', body: { pid: 200 } })).status, 200, 'a stale heartbeat lets another process in');
  assert.equal((await unix({ method: 'POST', path: '/v1/hello', body: { pid: 100 } })).status, 409, 'and now 100 is the stranger');
  env.clock.t += HEARTBEAT_FRESH_MS;
  assert.equal((await unix({ method: 'POST', path: '/v1/hello', body: { pid: 100 } })).status, 200);
  assert.equal((await unix({ path: '/v1/nothing' })).status, 404);
  assert.equal((await unix({ method: 'POST', path: '/v1/hello', body: '"text"' })).status, 400);
});

test('pairing over TCP and the admin socket: the first device by chat-pair, the second approved by the first; cookies are __Host-, HttpOnly, Secure, Strict', async () => {
  for (const path of ['/api/chat/messages', '/api/chat/status', '/api/chat/stream', '/api/devices']) {
    const r = await tcp({ path });
    assert.equal(r.status, 401, path);
    assert.deepEqual(r.json, { error: 'this device is not paired' });
  }
  const cross = await tcp({ method: 'POST', path: '/api/pair/start', body: { name: 'phone' }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const start = await tcp({ method: 'POST', path: '/api/pair/start', body: { name: 'phone' }, headers: { origin: `http://127.0.0.1:${env.port}` } });
  assert.equal(start.status, 200, start.text);
  assert.match(start.json.code, /^[A-Z]{6}$/);
  const setPair = start.headers['set-cookie'][0];
  assert.match(setPair, /^__Host-jos-pair=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$/);
  const pairCookie = setPair.split(';')[0];
  assert.deepEqual((await tcp({ path: '/api/pair/status', headers: { cookie: pairCookie } })).json, { state: 'pending', expiresAt: start.json.expiresAt });
  assert.equal((await tcp({ path: '/api/pair/status' })).json.state, 'none');
  // The first device: nobody is paired to approve from, so chat-pair on the machine does.
  const wrong = await call({ socketPath: env.adminPath, method: 'POST', path: '/admin/approve', body: { code: 'NOTITX' } });
  assert.equal(wrong.status, 400);
  const ok = await call({ socketPath: env.adminPath, method: 'POST', path: '/admin/approve', body: { code: start.json.code } });
  assert.deepEqual(ok.json, { ok: true, name: 'phone' });
  const paired = await tcp({ path: '/api/pair/status', headers: { cookie: pairCookie } });
  assert.equal(paired.json.state, 'paired');
  assert.equal(paired.json.device.name, 'phone');
  const cookies = paired.headers['set-cookie'];
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^__Host-jos=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000$/);
  assert.match(cookies[1], /^__Host-jos-pair=; .*Max-Age=0$/);
  env.phone = cookies[0].split(';')[0];
  assert.equal((await tcp({ path: '/api/chat/status', headers: { cookie: env.phone } })).status, 200);
  assert.ok(env.events.some(e => e.kind === 'paired' && e.device.name === 'phone'));
  // The second device, approved from the first.
  const s2 = await tcp({ method: 'POST', path: '/api/pair/start', body: { name: 'ipad' } });
  const pair2 = s2.headers['set-cookie'][0].split(';')[0];
  const noCookie = await tcp({ method: 'POST', path: '/api/pair/approve', body: { code: s2.json.code } });
  assert.equal(noCookie.status, 401);
  const approve = await tcp({ method: 'POST', path: '/api/pair/approve', body: { code: s2.json.code }, headers: { cookie: env.phone } });
  assert.deepEqual(approve.json, { ok: true, name: 'ipad' });
  const p2 = await tcp({ path: '/api/pair/status', headers: { cookie: pair2 } });
  env.ipad = p2.headers['set-cookie'][0].split(';')[0];
  const list = await tcp({ path: '/api/devices', headers: { cookie: env.phone } });
  assert.deepEqual(list.json.devices.map(d => d.name), ['phone', 'ipad']);
  assert.ok(!list.text.includes('tokenSha256'));
  const admin = await call({ socketPath: env.adminPath, path: '/admin/devices' });
  assert.equal(admin.json.devices.length, 2);
  assert.equal(admin.json.pending, false);
});

test('a message from the page is queued, reaches the channel\'s inbound stream, and becomes delivered on ack; the channel\'s reply dedups on clientId', async () => {
  const guards = [
    ['cross-origin', { headers: { cookie: env.phone, origin: 'https://evil.example' }, body: { clientId: 'x', text: 'hi' } }, 403],
    ['text/plain', { headers: { cookie: env.phone, 'content-type': 'text/plain' }, body: { clientId: 'x', text: 'hi' } }, 415],
    ['no cookie', { body: { clientId: 'x', text: 'hi' } }, 401],
    ['no clientId', { headers: { cookie: env.phone }, body: { text: 'hi' } }, 400],
    ['too long', { headers: { cookie: env.phone }, body: { clientId: 'x', text: 'x'.repeat(8001) } }, 400],
    ['empty', { headers: { cookie: env.phone }, body: { clientId: 'x', text: '   ' } }, 400],
    ['bad replyTo', { headers: { cookie: env.phone }, body: { clientId: 'x', text: 'hi', replyTo: 'nope' } }, 400]
  ];
  for (const [why, opts, status] of guards) {
    const r = await tcp({ method: 'POST', path: '/api/chat/messages', ...opts });
    assert.equal(r.status, status, why);
    assert.ok(!r.text.includes('hi there'), why);
  }
  assert.equal(env.store.size, 0, 'nothing landed');
  const sent = await tcp({ method: 'POST', path: '/api/chat/messages', headers: { cookie: env.phone }, body: { clientId: 'page-1', text: 'hi there' } });
  assert.equal(sent.status, 200, sent.text);
  assert.ok(isMessageId(sent.json.id));
  assert.equal(sent.json.seq, 1);
  const dup = await tcp({ method: 'POST', path: '/api/chat/messages', headers: { cookie: env.phone }, body: { clientId: 'page-1', text: 'hi there again' } });
  assert.deepEqual(dup.json, { id: sent.json.id, seq: 1, duplicate: true });
  const listed = await tcp({ path: '/api/chat/messages', headers: { cookie: env.phone } });
  assert.equal(listed.json.messages.length, 1);
  assert.deepEqual([listed.json.messages[0].from, listed.json.messages[0].device, listed.json.messages[0].state], ['jeff', 'phone', 'queued']);
  assert.equal(listed.json.epoch, env.store.epoch);
  assert.equal(listed.headers['cache-control'], 'no-store');

  // The channel reads it: replay from the cursor, then live.
  await unix({ method: 'POST', path: '/v1/hello', body: { pid: 100 } });
  const live = stream({ socketPath: env.sockPath, path: '/v1/inbound?after=0', ms: 250 });
  await new Promise(r => setTimeout(r, 40));
  await tcp({ method: 'POST', path: '/api/chat/messages', headers: { cookie: env.ipad }, body: { clientId: 'page-2', text: 'second' } });
  const got = await live;
  assert.equal(got.headers['content-type'], 'application/x-ndjson');
  const lines = ndjson(got.text);
  assert.deepEqual(lines.filter(l => l.type === 'message').map(l => [l.seq, l.text, l.device]), [[1, 'hi there', 'phone'], [2, 'second', 'ipad']]);
  assert.ok(lines.some(l => l.type === 'ping'), 'pings keep the stream warm');
  assert.ok(!lines.some(l => 'clientId' in l));
  const un = await unix({ path: '/v1/unanswered' });
  assert.deepEqual(un.json.messages.map(m => m.text), ['hi there', 'second']);
  assert.deepEqual(Object.keys(un.json.messages[0]).sort(), ['at', 'attachments', 'device', 'editedAt', 'from', 'id', 'kind', 'meta', 'replyTo', 'seq', 'state', 'text']);

  // Ack: the owner's messages up to the seq become delivered.
  const stale = await unix({ method: 'POST', path: '/v1/ack', body: { seq: 2, epoch: 'not-this-one' } });
  assert.equal(stale.status, 409, 'an ack from a stream of another epoch moves nothing');
  assert.equal(env.store.deliveredSeq, 0);
  assert.deepEqual((await unix({ method: 'POST', path: '/v1/ack', body: { seq: 2, epoch: env.store.epoch } })).json, { deliveredSeq: 2, epoch: env.store.epoch });
  assert.deepEqual((await unix({ method: 'POST', path: '/v1/ack', body: { seq: 1 } })).json, { deliveredSeq: 2, epoch: env.store.epoch }, 'no epoch given is fine, and never back');
  assert.equal((await unix({ method: 'POST', path: '/v1/ack', body: { seq: 'x' } })).status, 400);
  const after = await tcp({ path: '/api/chat/messages', headers: { cookie: env.phone } });
  assert.deepEqual(after.json.messages.map(m => m.state), ['delivered', 'delivered']);

  // The reply, with a file, deduped on clientId; a secret-shaped one refused without echo.
  const bad = await unix({ method: 'POST', path: '/v1/reply', body: { clientId: 'r-0', text: 'the key is sk-ant-api03-' + 'Q'.repeat(40) } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Anthropic key/);
  assert.ok(!bad.text.includes('QQQQ'), 'the text is never echoed');
  assert.equal((await unix({ method: 'POST', path: '/v1/reply', body: { clientId: 'r-0', text: 'x', files: [{ name: 'a.png', type: 'image/png', data: Buffer.from('not a png at all').toString('base64') }] } })).status, 415);
  assert.equal((await unix({ method: 'POST', path: '/v1/reply', body: { clientId: 'r-0', text: 'x', files: [1, 2, 3, 4, 5] } })).status, 400);
  const reply = await unix({ method: 'POST', path: '/v1/reply', body: { clientId: 'r-1', text: 'hello back', replyTo: sent.json.id, files: [{ name: 'shot.png', type: 'image/png', data: PNG.toString('base64') }] } });
  assert.equal(reply.status, 200, reply.text);
  assert.ok(isMessageId(reply.json.id));
  assert.equal(reply.json.seq, 3);
  const again = await unix({ method: 'POST', path: '/v1/reply', body: { clientId: 'r-1', text: 'hello back (resent)' } });
  assert.deepEqual(again.json, { id: reply.json.id, seq: 3, duplicate: true });
  assert.deepEqual((await unix({ path: '/v1/unanswered' })).json.messages, []);
  const hist = await unix({ path: '/v1/history?limit=2' });
  assert.deepEqual(hist.json.messages.map(m => m.seq), [2, 3]);
  const before = await unix({ path: `/v1/history?before=${reply.json.id}&limit=5` });
  assert.deepEqual(before.json.messages.map(m => m.seq), [1, 2]);
  assert.equal((await unix({ path: '/v1/history?before=nope' })).status, 400);
  const att = hist.json.messages[1].attachments[0];
  assert.equal(att.name, 'shot.png');
  const file = await unix({ path: `/v1/attachment/${att.id}` });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.ok(file.buf.equals(PNG));
  assert.equal((await unix({ path: `/v1/attachment/${'0'.repeat(32)}` })).status, 404);
  // Edit: the lead's own, not the owner's.
  const edit = await unix({ method: 'POST', path: '/v1/edit', body: { id: reply.json.id, text: 'hello back, edited' } });
  assert.deepEqual(edit.json, { id: reply.json.id, seq: 3 });
  assert.equal((await unix({ method: 'POST', path: '/v1/edit', body: { id: sent.json.id, text: 'nope' } })).status, 403);
  assert.equal((await unix({ method: 'POST', path: '/v1/edit', body: { id: reply.json.id, text: 'ghp_' + 'x'.repeat(40) } })).status, 400);
  env.replyId = reply.json.id;
  env.attachmentId = att.id;
});

test('an upload from the page: raw image bytes, sniffed, bound to the device that sent it, served inline with nosniff and a sandboxed policy', async () => {
  assert.equal((await tcp({ method: 'POST', path: '/api/chat/attachments', headers: { cookie: env.phone, 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg/>') })).status, 415);
  assert.equal((await tcp({ method: 'POST', path: '/api/chat/attachments', headers: { cookie: env.phone, 'content-type': 'image/png' }, body: Buffer.from('not a png') })).status, 415);
  assert.equal((await tcp({ method: 'POST', path: '/api/chat/attachments', headers: { cookie: env.phone, 'content-type': 'image/png', origin: 'https://evil.example' }, body: PNG })).status, 403);
  assert.equal((await tcp({ method: 'POST', path: '/api/chat/attachments', headers: { 'content-type': 'image/png' }, body: PNG })).status, 401);
  const up = await tcp({ method: 'POST', path: '/api/chat/attachments?name=photo.jpg', headers: { cookie: env.phone, 'content-type': 'image/jpeg' }, body: JPEG });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.type, 'image/jpeg');
  assert.equal(up.json.name, 'photo.jpg');
  const wrongDevice = await tcp({ method: 'POST', path: '/api/chat/messages', headers: { cookie: env.ipad }, body: { clientId: 'page-3', text: '', attachmentIds: [up.json.id] } });
  assert.equal(wrongDevice.status, 400);
  const withFile = await tcp({ method: 'POST', path: '/api/chat/messages', headers: { cookie: env.phone }, body: { clientId: 'page-3', text: '', attachmentIds: [up.json.id] } });
  assert.equal(withFile.status, 200, withFile.text);
  const got = await tcp({ path: `/api/chat/attachments/${up.json.id}`, headers: { cookie: env.ipad } });
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.equal(got.headers['content-disposition'], 'inline');
  assert.match(got.headers['content-security-policy'], /sandbox/);
  assert.ok(got.buf.equals(JPEG));
  assert.equal((await tcp({ path: `/api/chat/attachments/${up.json.id}` })).status, 401);
  assert.equal((await tcp({ path: `/api/chat/attachments/${env.attachmentId}`, headers: { cookie: env.phone } })).status, 200, 'the lead\'s file too');
  const big = await tcp({ method: 'POST', path: '/api/chat/attachments', headers: { cookie: env.phone, 'content-type': 'image/png' }, body: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]) }).catch(err => ({ status: 'closed', err }));
  assert.ok(big.status === 413 || big.status === 'closed', String(big.status));
});

test('SSE: a status event first, replay after Last-Event-ID with ids, live messages, edits and pings', async () => {
  const live = stream({ port: env.port, path: '/api/chat/stream', headers: { cookie: env.phone, 'last-event-id': '2' }, ms: 250 });
  await new Promise(r => setTimeout(r, 40));
  await unix({ method: 'POST', path: '/v1/reply', body: { clientId: 'r-2', text: 'live one' } });
  await unix({ method: 'POST', path: '/v1/edit', body: { id: env.replyId, text: 'hello back, edited twice' } });
  const got = await live;
  assert.equal(got.headers['content-type'], 'text/event-stream');
  assert.equal(got.headers['cache-control'], 'no-store');
  const events = sse(got.text);
  assert.equal(events[0].retry, 3000);
  assert.equal(events[1].event, 'status');
  assert.equal(events[1].data.state, 'online');
  const replayed = events.filter(e => e.event === 'message');
  assert.deepEqual(replayed.map(e => [e.id, e.data.seq]), [[3, 3], [4, 4], [5, 5]], 'seq 3 and 4 replayed after id 2, then the live one');
  assert.equal(replayed[2].data.text, 'live one');
  const edit = events.find(e => e.event === 'edit');
  assert.equal(edit.data.text, 'hello back, edited twice');
  assert.ok(events.some(e => e.comment === 'ping'));
  assert.ok(!got.text.includes('clientId'));
  const viaQuery = await stream({ port: env.port, path: '/api/chat/stream?after=4', headers: { cookie: env.ipad }, ms: 80 });
  assert.deepEqual(sse(viaQuery.text).filter(e => e.event === 'message').map(e => e.id), [5]);
});

test('a permission request from the channel reaches the page as an event; the verdict from a device is single use, logged with the device, and goes down the socket', async () => {
  const live = stream({ port: env.port, path: '/api/chat/stream', headers: { cookie: env.phone }, ms: 300 });
  const inbound = stream({ socketPath: env.sockPath, path: `/v1/inbound?after=${env.store.seq}`, ms: 300 });
  await new Promise(r => setTimeout(r, 40));
  const opened = await unix({ method: 'POST', path: '/v1/permission-request', body: { requestId: 'ABCDE', tool: 'Bash', description: 'run the tests', inputPreview: 'npm test' } });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.json.state, 'open');
  assert.equal((await unix({ method: 'POST', path: '/v1/heartbeat' })).json.openPermissions, 1);
  const status = await tcp({ path: '/api/chat/status', headers: { cookie: env.phone } });
  assert.equal(status.json.state, 'waiting on you');
  assert.equal(status.json.openPermission.requestId, 'ABCDE');
  assert.equal(status.json.openPermission.inputPreview, 'npm test');
  const badBehavior = await tcp({ method: 'POST', path: '/api/chat/permission/ABCDE', headers: { cookie: env.ipad }, body: { behavior: 'maybe' } });
  assert.equal(badBehavior.status, 400);
  assert.equal((await tcp({ method: 'POST', path: '/api/chat/permission/ABCDE', body: { behavior: 'allow' } })).status, 401);
  const verdict = await tcp({ method: 'POST', path: '/api/chat/permission/ABCDE', headers: { cookie: env.ipad }, body: { behavior: 'allow' } });
  assert.deepEqual(verdict.json, { ok: true, state: 'allowed' });
  const second = await tcp({ method: 'POST', path: '/api/chat/permission/ABCDE', headers: { cookie: env.phone }, body: { behavior: 'deny' } });
  assert.equal(second.status, 409);
  assert.equal((await tcp({ method: 'POST', path: '/api/chat/permission/ZZZZZ', headers: { cookie: env.phone }, body: { behavior: 'deny' } })).status, 404);
  const ev = env.events.find(e => e.kind === 'verdict');
  assert.deepEqual(ev, { kind: 'verdict', requestId: 'ABCDE', behavior: 'allowed', device: 'ipad', tool: 'Bash' });
  const page = sse((await live).text);
  assert.deepEqual(page.filter(e => e.event === 'permission').map(e => e.data.requestId), ['ABCDE']);
  assert.deepEqual(page.filter(e => e.event === 'permission-closed').map(e => e.data.state), ['allowed']);
  assert.deepEqual(page.filter(e => e.event === 'message').map(e => e.data.kind), ['permission', 'verdict']);
  const sock = ndjson((await inbound).text);
  assert.deepEqual(sock.filter(l => l.type === 'verdict').map(l => [l.requestId, l.behavior, l.device]), [['ABCDE', 'allow', 'ipad']]);
  assert.ok(!sock.some(l => l.type === 'message'), 'the permission message itself is not inbound: the channel asked it');
  assert.equal((await tcp({ path: '/api/chat/status', headers: { cookie: env.phone } })).json.state, 'online');
});

test('status: online, waiting on you, slow after 10 minutes unanswered, offline when the heartbeat is stale', async () => {
  const socketStatus = { channelConnected: true, lastHeartbeatAt: 10, helloAt: 5 };
  const fake = { openPermissions: () => [], lastJarvisAt: () => 100, lastJeffAt: () => 50, publicPermission: p => p };
  assert.equal(chatState({ socket: socketStatus, store: fake, now: 1000 }).state, 'online');
  assert.equal(chatState({ socket: socketStatus, store: { ...fake, lastJeffAt: () => 200 }, now: 200 + SLOW_AFTER_MS }).state, 'slow');
  assert.equal(chatState({ socket: socketStatus, store: { ...fake, lastJeffAt: () => 200 }, now: 200 + SLOW_AFTER_MS - 1 }).state, 'online');
  assert.equal(chatState({ socket: socketStatus, store: { ...fake, openPermissions: () => [{ openedAt: 7 }] }, now: 1000 }).state, 'waiting on you');
  const off = chatState({ socket: { channelConnected: false, lastHeartbeatAt: 10, helloAt: 5 }, store: fake, now: 1000 });
  assert.equal(off.state, 'offline');
  assert.equal(off.since, 10);
  // Over the wire.
  env.clock.t += HEARTBEAT_FRESH_MS;
  const r = await tcp({ path: '/api/chat/status', headers: { cookie: env.phone } });
  assert.equal(r.json.state, 'offline');
  assert.equal(r.json.channelConnected, false);
  await unix({ method: 'POST', path: '/v1/hello', body: { pid: 300 } });
  assert.equal((await tcp({ path: '/api/chat/status', headers: { cookie: env.phone } })).json.state, 'online');
  const s = await unix({ path: '/v1/status' });
  assert.equal(s.json.pid, 300);
  assert.equal(s.json.epoch, env.store.epoch);
});

test('a replaced inbound stream gets one last line and closes; a revoked device is shut out; the login header is a second factor when set', async () => {
  const first = stream({ socketPath: env.sockPath, path: '/v1/inbound?after=0', ms: 400 });
  await new Promise(r => setTimeout(r, 40));
  const second = stream({ socketPath: env.sockPath, path: '/v1/inbound?after=999', ms: 100 });
  const got = await first;
  const lines = ndjson(got.text);
  assert.deepEqual(lines.at(-1), { type: 'replaced' });
  await second;
  // Revoke the iPad from the phone.
  const list = await tcp({ path: '/api/devices', headers: { cookie: env.phone } });
  const ipad = list.json.devices.find(d => d.name === 'ipad');
  assert.equal((await tcp({ method: 'DELETE', path: `/api/devices/${ipad.id}`, headers: { cookie: env.phone, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await tcp({ method: 'DELETE', path: `/api/devices/${ipad.id}`, headers: { cookie: env.phone } })).status, 200);
  assert.equal((await tcp({ path: '/api/chat/status', headers: { cookie: env.ipad } })).status, 401);
  assert.ok(env.events.some(e => e.kind === 'revoked' && e.device.name === 'ipad'));
  // The login header.
  const strict = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { chat: { login: 'owner@example.com' } }, now: () => env.clock.t, log: () => {} });
  const srv = createServer((req, res) => strict.handler(req, res));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal((await call({ port, path: '/api/chat/status', headers: { cookie: env.phone } })).status, 403);
    assert.equal((await call({ port, path: '/api/chat/status', headers: { cookie: env.phone, 'tailscale-user-login': 'Owner@Example.com' } })).status, 200);
    assert.equal((await call({ port, path: '/api/chat/status', headers: { cookie: env.phone, 'tailscale-user-login': 'someone@example.com' } })).status, 403);
    assert.equal((await call({ port, path: '/api/chat/status', headers: { 'tailscale-user-login': 'owner@example.com' } })).status, 401, 'the header alone is nothing');
  } finally {
    await new Promise(r => srv.close(r));
  }
  assert.ok(env.routes.owns('/api/chat/messages') && env.routes.owns('/api/pair/start') && env.routes.owns('/api/devices/abc') && !env.routes.owns('/api/dashboard'));
  assert.equal(inboundEvent({ from: 'jarvis', kind: 'chat', text: 'x' }), null);
});
