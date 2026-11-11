// The channel's socket, from the channel's end-to-end run (2026-11-11): the inbound
// replay pages through the whole backlog with no gap before the live messages, an
// ack moves the cursor only as far as was sent, `POST /v1/bye` frees the place at
// once, a holder whose stream closed and who then missed a heartbeat is stale at
// 20 s, and the holder's own re-hello supersedes its stream rather than replacing
// it. Each test gets its own store and router on a temp socket; every message here
// is invented, and nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../lib/chat-store.mjs';
import { createSocketRouter, HEARTBEAT_FRESH_MS, HEARTBEAT_MISSED_MS, REPLAY_PAGE, SESSION_HEADER } from '../lib/chat-socket.mjs';

const call = ({ socketPath, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({ socketPath, method, path, headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      resolve({ status: res.statusCode, text, json });
    });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

// A streaming GET held open until `close()` (or until the server ends it).
function openStream({ socketPath, path, headers }) {
  let text = '';
  let req;
  const ended = new Promise((resolve, reject) => {
    req = request({ socketPath, method: 'GET', path, headers }, res => {
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve('server'));
      res.on('close', () => resolve('closed'));
    });
    req.on('error', err => (err.code === 'ECONNRESET' ? resolve('closed') : reject(err)));
    req.end();
  });
  return { lines: () => text.split('\n').filter(Boolean).map(l => JSON.parse(l)), ended, close: () => { req.destroy(); return ended; } };
}
// How a stream ended, or 'still open' after a second.
const endedSoon = st => Promise.race([st.ended, new Promise(r => setTimeout(() => r('still open'), 1000).unref())]);
const until = async (fn, what, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
};

async function setup({ wrap = s => s } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-sock-'));
  const clock = { t: 1794380000000 };
  const events = [];
  const logs = [];
  const store = createChatStore({ dir: join(dir, 'chat'), now: () => clock.t });
  await store.load();
  const socket = createSocketRouter({ store: wrap(store), now: () => clock.t, onEvent: e => events.push(e), log: l => logs.push(l), pingMs: 60e3 });
  const socketPath = join(dir, 's.sock');
  const srv = createServer((req, res) => socket.handler(req, res));
  await new Promise(r => srv.listen(socketPath, r));
  const env = { dir, clock, events, logs, store, socket, socketPath, token: null, streams: [] };
  env.call = opts => call({ socketPath, ...opts, headers: { ...(env.token ? { [SESSION_HEADER]: env.token } : {}), ...(opts.headers ?? {}) } });
  env.stranger = opts => call({ socketPath, ...opts });
  env.hello = async (body = { pid: 100 }) => { const h = await env.call({ method: 'POST', path: '/v1/hello', body }); if (h.status === 200) env.token = h.json.token; return h; };
  env.inbound = after => { const s = openStream({ socketPath, path: `/v1/inbound${after === undefined ? '' : `?after=${after}`}`, headers: { [SESSION_HEADER]: env.token } }); env.streams.push(s); return s; };
  env.ack = seq => env.call({ method: 'POST', path: '/v1/ack', body: { seq, epoch: store.epoch } });
  env.done = async () => {
    for (const s of env.streams) await s.close();
    await new Promise(r => srv.close(r));
    await rm(dir, { recursive: true, force: true });
  };
  return env;
}
const msgs = lines => lines.filter(l => l.type === 'message');

test('replay sends every queued message after the cursor, past one page of 100, each once and in order; the ack then marks them all delivered', async () => {
  const env = await setup();
  try {
    // 250 of the owner's messages with a reply of the lead's after every 25th: three
    // pages of 100 by seq, the replies on the store but not on the stream.
    let owner = 0;
    for (let i = 1; i <= 250; i++) {
      await env.store.append({ from: 'jeff', text: `q${i}`, state: 'queued' });
      owner++;
      if (i % 25 === 0) await env.store.append({ from: 'jarvis', text: `a${i}` });
    }
    assert.ok(env.store.seq > 2 * REPLAY_PAGE, 'more than two pages queued');
    assert.equal((await env.hello()).json.cursor, 0);
    const s = env.inbound(0);
    await until(() => msgs(s.lines()).length >= owner, 'the whole backlog');
    await new Promise(r => setTimeout(r, 30));
    const got = msgs(s.lines());
    assert.equal(got.length, owner, 'every queued message, not the first 100');
    assert.deepEqual(got.map(l => l.text), Array.from({ length: owner }, (_, i) => `q${i + 1}`), 'each once, oldest first');
    const seqs = got.map(l => l.seq);
    assert.ok(seqs.every((q, i) => i === 0 || q > seqs[i - 1]), 'seqs rising');
    // A live message after the backlog, then the ack of everything.
    const live = await env.store.append({ from: 'jeff', text: 'live', state: 'queued' });
    await until(() => msgs(s.lines()).some(l => l.text === 'live'), 'the live message');
    assert.deepEqual((await env.ack(live.seq)).json, { deliveredSeq: live.seq, epoch: env.store.epoch });
    assert.ok(env.store.list({ after: 0, limit: 100 }).concat(env.store.list({ after: 100, limit: 100 }), env.store.list({ after: 200, limit: 100 }))
      .filter(m => m.from === 'jeff').every(m => m.state === 'delivered'), 'all delivered');
    // Without `after` the stream starts at the cursor: nothing is replayed twice.
    const again = env.inbound();
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(msgs(again.lines()), []);
  } finally { await env.done(); }
});

test('no live message falls between the replay and the subscription, and none comes twice', async () => {
  // A store whose list(), on its first call, plays two live events through whoever
  // has subscribed by then: one the replay will also list (must come once) and one
  // past the store's end (must come after the replay, not lost and not early).
  let listener = null;
  let fired = false;
  let extra = null;
  const wrap = store => new Proxy(store, {
    get(target, prop) {
      if (prop === 'subscribe') return fn => { listener = fn; const off = target.subscribe(fn); return () => { listener = null; off(); }; };
      if (prop === 'list') {
        return opts => {
          const out = target.list(opts);
          if (!fired && opts?.after !== undefined) {
            fired = true;
            const overlap = target.list({ after: 150, limit: 1 })[0];
            extra = { seq: target.seq + 1, id: 'm_zzzzzzzz', at: 0, from: 'jeff', kind: 'chat', text: 'between', attachments: [] };
            if (listener) { listener({ type: 'message', message: overlap }); listener({ type: 'message', message: extra }); }
          }
          return out;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const env = await setup({ wrap });
  try {
    for (let i = 1; i <= 160; i++) await env.store.append({ from: 'jeff', text: `q${i}`, state: 'queued' });
    await env.hello();
    const s = env.inbound(0);
    await until(() => msgs(s.lines()).length >= 161, 'the backlog and the live one', 1000).catch(() => {});
    await new Promise(r => setTimeout(r, 30));
    const texts = msgs(s.lines()).map(l => l.text);
    assert.equal(texts.filter(t => t === 'q151').length, 1, 'the overlap once');
    assert.equal(texts.length, 161, 'all 160 and the live one');
    assert.deepEqual(texts.slice(0, 160), Array.from({ length: 160 }, (_, i) => `q${i + 1}`), 'the backlog in order, not cut short by the live one');
    assert.equal(texts.at(-1), 'between', 'the live one after the backlog');
  } finally { await env.done(); }
});

test('an ack moves the cursor only as far as this session has sent: not past the stream, not with no stream, not across a new hello', async () => {
  const env = await setup();
  try {
    for (let i = 1; i <= 5; i++) await env.store.append({ from: 'jeff', text: `q${i}`, state: 'queued' });
    await env.hello();
    // No stream yet: nothing was sent, so nothing is delivered.
    assert.deepEqual((await env.ack(5)).json, { deliveredSeq: 0, epoch: env.store.epoch });
    assert.ok(env.logs.some(l => /ack for seq 5 moved the cursor only to 0/.test(l)));
    assert.equal(env.store.list({ after: 0 }).filter(m => m.state === 'delivered').length, 0);
    // A stream from 0 sends 1-5; the ack of 3 moves the cursor to 3.
    const s = env.inbound(0);
    await until(() => msgs(s.lines()).length === 5, 'five lines');
    assert.equal((await env.ack(3)).json.deliveredSeq, 3);
    // A new hello starts from the cursor: what the old session sent counts no more.
    await env.hello();
    assert.equal((await env.ack(5)).json.deliveredSeq, 3, '4 and 5 went to the old session only');
    const s1 = env.inbound();
    await until(() => msgs(s1.lines()).length === 2, 'q4 and q5 again, from the cursor');
    assert.equal((await env.ack(5)).json.deliveredSeq, 5);
    await s1.close();
    await until(() => env.socket.status().streaming === false, 'the stream to close');
    // A message the store takes after the stream closed was never sent.
    await env.store.append({ from: 'jeff', text: 'q6', state: 'queued' });
    assert.equal((await env.ack(6)).json.deliveredSeq, 5, 'seq 6 came after the stream closed: never sent, never delivered');
    assert.equal(env.store.list({ after: 5 })[0].state, 'queued');
    // The channel may say it has messages already (`after` past the cursor): that
    // is its word, so an ack up to there moves the cursor, though nothing was sent.
    const s2 = env.inbound(6);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(msgs(s2.lines()), []);
    assert.equal((await env.ack(6)).json.deliveredSeq, 6);
    await env.store.append({ from: 'jeff', text: 'q7', state: 'queued' });
    await until(() => msgs(s2.lines()).length === 1, 'q7 live');
    assert.equal((await env.ack(7)).json.deliveredSeq, 7);
    // Past the store's end it claims nothing.
    const s3 = env.inbound(999);
    await new Promise(r => setTimeout(r, 20));
    await env.store.append({ from: 'jeff', text: 'q8', state: 'queued' });
    await until(() => msgs(s3.lines()).length === 1, 'q8 after a claim past the end');
    assert.equal(msgs(s3.lines())[0].seq, 8);
    assert.equal((await env.ack(999)).json.deliveredSeq, 8, 'an ack past the store moves nothing past it');
  } finally { await env.done(); }
});

test('bye frees the place at once with no alert, and ends the inbound stream; it takes the token', async () => {
  const env = await setup();
  try {
    await env.hello();
    const s = env.inbound(0);
    await new Promise(r => setTimeout(r, 20));
    assert.equal((await env.stranger({ method: 'POST', path: '/v1/bye' })).status, 409, 'not without the token');
    assert.equal(env.socket.status().channelConnected, true);
    const bye = await env.call({ method: 'POST', path: '/v1/bye' });
    assert.equal(bye.status, 200);
    assert.deepEqual(bye.json, { ok: true });
    assert.equal(await endedSoon(s), 'server', 'the stream ended');
    assert.deepEqual(s.lines().at(-1), { type: 'bye' });
    assert.ok(env.logs.includes('chat: the channel said bye'));
    assert.deepEqual(env.socket.status(), { channelConnected: false, lastHeartbeatAt: null, helloAt: null, version: null, streaming: false });
    assert.equal((await env.call({ method: 'POST', path: '/v1/heartbeat' })).status, 409, 'the token died');
    // The restarted channel is let straight in: no wait, no refusal, no takeover alert.
    const next = await env.stranger({ method: 'POST', path: '/v1/hello', body: { pid: 200, startedAt: env.clock.t } });
    assert.equal(next.status, 200);
    assert.deepEqual(env.events, [], 'a clean bye and a new hello push nothing');
  } finally { await env.done(); }
});

test('a holder whose stream closed and who then missed a heartbeat is stale at 20 s; one with its stream open, or still beating, keeps 45 s', async () => {
  const env = await setup();
  try {
    await env.hello({ pid: 100 });
    // No stream ever opened: the 45 s rule alone.
    env.clock.t += HEARTBEAT_MISSED_MS + 5e3;
    assert.equal((await env.stranger({ method: 'POST', path: '/v1/hello', body: { pid: 200 } })).status, 409);
    assert.equal((await env.call({ method: 'POST', path: '/v1/heartbeat' })).status, 200);
    // A stream closed by the holder and a new one opened: the new one counts.
    const s0 = env.inbound(0);
    await new Promise(r => setTimeout(r, 20));
    await s0.close();
    await until(() => env.socket.status().streaming === false, 'the first stream to close');
    env.inbound(0);
    await until(() => env.socket.status().streaming === true, 'the second stream');
    env.clock.t += HEARTBEAT_MISSED_MS + 5e3;
    assert.equal(env.socket.status().channelConnected, true, 'a stream is open again: 45 s');
    assert.equal((await env.call({ method: 'POST', path: '/v1/heartbeat' })).status, 200);
    // A stream the holder closes itself, then a heartbeat: still alive.
    const s = env.inbound(0);
    await new Promise(r => setTimeout(r, 20));
    await s.close();
    await until(() => env.socket.status().streaming === false, 'the stream to close');
    env.clock.t += 10e3;
    assert.equal((await env.call({ method: 'POST', path: '/v1/heartbeat' })).status, 200);
    env.clock.t += HEARTBEAT_MISSED_MS - 1;
    assert.equal((await env.stranger({ method: 'POST', path: '/v1/hello', body: { pid: 200 } })).status, 409, 'just under 20 s since the last heartbeat');
    env.clock.t += 1;
    assert.equal(env.socket.status().channelConnected, false, 'stale at 20 s');
    const taken = await env.stranger({ method: 'POST', path: '/v1/hello', body: { pid: 200 } });
    assert.equal(taken.status, 200, 'the restart is let in');
    assert.deepEqual(env.events.map(e => e.kind), ['client-refused', 'client-refused', 'client-replaced'], 'a crash is still a takeover, alerted');
    assert.equal(env.events.at(-1).staleFor, HEARTBEAT_MISSED_MS);
    // The holder's own second stream supersedes its first; the first closing that
    // way is the server's doing and never marks the holder as gone.
    env.token = taken.json.token;
    const a = env.inbound(0);
    await new Promise(r => setTimeout(r, 20));
    const b = env.inbound(0);
    assert.equal(await endedSoon(a), 'server');
    assert.deepEqual(a.lines().at(-1), { type: 'superseded' });
    await new Promise(r => setTimeout(r, 20));
    env.clock.t += HEARTBEAT_FRESH_MS - 1;
    assert.equal(env.socket.status().channelConnected, true, 'b is open: 45 s, not 20');
    void b;
  } finally { await env.done(); }
});

test('the holder\'s re-hello ends its stream with `superseded`; a takeover after 45 s ends it with `replaced`', async () => {
  const env = await setup();
  try {
    await env.hello({ pid: 100 });
    const a = env.inbound(0);
    await new Promise(r => setTimeout(r, 20));
    await env.hello({ pid: 100 });
    assert.equal(await endedSoon(a), 'server');
    assert.deepEqual(a.lines(), [{ type: 'superseded' }]);
    const b = env.inbound(0);
    await new Promise(r => setTimeout(r, 20));
    env.clock.t += HEARTBEAT_FRESH_MS;
    const taken = await env.stranger({ method: 'POST', path: '/v1/hello', body: { pid: 200 } });
    assert.equal(taken.status, 200);
    assert.equal(await endedSoon(b), 'server');
    assert.deepEqual(b.lines(), [{ type: 'replaced' }]);
    assert.deepEqual(env.events.map(e => e.kind), ['client-replaced']);
  } finally { await env.done(); }
});
