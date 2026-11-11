// The channel's side of the chat (jarvis-os-chat-spec.md, §1.5-1.6): socket API v1,
// served on a Unix socket of its own with its own router. Nothing here is reachable
// over TCP, and no page route is reachable here. The socket has no authority of the
// owner's: it can't make a message "from jeff" and can't answer a permission; both
// come only through the page routes, which need the device cookie.
//
// One client at a time, held by a session token (the 2026-11-11 review, 1): `hello`
// answers a random token, and every other route but `status` takes it in the
// `X-Session-Token` header; a call without the current token gets 409, whatever it
// says its pid is. A hello from another process while the current one's heartbeat
// is under 45 s old is refused with 409 and reported (`onEvent`, kind
// `client-refused`); the holder may say hello again with its token (a reconnect)
// and gets a new one. After the heartbeat has gone stale a hello without the token
// takes over, reported as `client-replaced` (alerted, since a takeover is what a
// hostile local process would do); the old inbound stream, if any, gets one last
// line `{"type":"replaced"}` and its socket closes, and the old token is dead.
//
// Errors are `{error}` with fixed words: never the text of a message.
import { json, readBody, HttpError } from '../routes.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { publicMessage, isMessageId, isClientId, isAttachmentId, MAX_TEXT, ATTACHMENT_MAX_BYTES } from './chat-store.mjs';
import { secretShapes } from './secret-shape.mjs';
import { readFile } from 'node:fs/promises';

export const HEARTBEAT_FRESH_MS = 45e3;
export const INBOUND_PING_MS = 15e3;
export const SESSION_HEADER = 'x-session-token';
const newToken = () => randomBytes(32).toString('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
export const MAX_FILES = 4;
// A reply with four 10 MB files, base64, with room to spare.
const REPLY_BODY_MAX = 4 * ATTACHMENT_MAX_BYTES * 1.4 + 64 * 1024;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// What goes down the inbound stream: the owner's chat messages and verdicts.
export function inboundEvent(m) {
  if (m.from === 'jeff' && m.kind === 'chat') {
    return { type: 'message', seq: m.seq, id: m.id, at: m.at, text: m.text, replyTo: m.replyTo ?? null, device: m.device ?? null, attachments: (m.attachments ?? []).map(a => ({ id: a.id, name: a.name, type: a.type, bytes: a.bytes })) };
  }
  if (m.kind === 'verdict') return { type: 'verdict', seq: m.seq, requestId: m.meta?.requestId ?? null, behavior: m.meta?.behavior ?? m.text, device: m.device ?? null };
  return null;
}

export function createSocketRouter({ store, now = () => Date.now(), onEvent = () => {}, log = console.log, pingMs = INBOUND_PING_MS }) {
  let client = null;   // { pid, version, startedAt, helloAt, lastHeartbeatAt, token }
  let inbound = null;  // { res, stop }
  const fresh = at => client !== null && at - client.lastHeartbeatAt < HEARTBEAT_FRESH_MS;
  // Whether the request carries the current client's token.
  const holds = req => {
    const t = req.headers?.[SESSION_HEADER];
    return client !== null && typeof t === 'string' && t.length > 0 && same(t, client.token);
  };
  const requireHolder = req => {
    if (!client) throw new HttpError(409, 'say hello first');
    if (!holds(req)) throw new HttpError(409, 'not the current channel: say hello again');
  };

  // What leaves this process about the client: never its pid (the 2026-11-11 review).
  const status = () => {
    const at = now();
    return { channelConnected: fresh(at), lastHeartbeatAt: client?.lastHeartbeatAt ?? null, helloAt: client?.helloAt ?? null, version: client?.version ?? null, streaming: inbound !== null };
  };

  function endInbound(reason) {
    if (!inbound) return;
    const old = inbound;
    inbound = null;
    old.stop();
    try { old.res.write(JSON.stringify({ type: reason }) + '\n'); } catch { /* gone */ }
    try { old.res.end(); } catch { /* gone */ }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://unix');
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/v1/hello') {
        const body = await readBody(req);
        if (!isObject(body)) throw new HttpError(400, 'the body must be an object');
        const pid = Number.isInteger(body.pid) ? body.pid : null;
        const at = now();
        const holder = holds(req);
        if (client && !holder && fresh(at)) {
          onEvent({ kind: 'client-refused', pid, current: client.pid });
          throw new HttpError(409, 'another channel is connected and its heartbeat is fresh');
        }
        if (client && !holder) {
          const staleFor = at - client.lastHeartbeatAt;
          log(`chat: the channel was replaced after a stale heartbeat (pid ${client.pid} to ${pid}, ${Math.round(staleFor / 1000)} s stale)`);
          onEvent({ kind: 'client-replaced', pid, previous: client.pid, staleFor });
        } else if (client) {
          log('chat: the channel said hello again');
        }
        client = { pid, version: typeof body.version === 'string' ? body.version.slice(0, 40) : null, startedAt: Number.isFinite(body.startedAt) ? body.startedAt : null, helloAt: at, lastHeartbeatAt: at, token: newToken() };
        endInbound('replaced');
        return json(res, 200, { cursor: store.deliveredSeq, epoch: store.epoch, seq: store.seq, token: client.token });
      }
      if (req.method === 'GET' && path === '/v1/status') return json(res, 200, { ...status(), seq: store.seq, epoch: store.epoch, deliveredSeq: store.deliveredSeq });
      // Everything from here on is the current client's alone.
      requireHolder(req);
      if (req.method === 'POST' && path === '/v1/heartbeat') {
        client.lastHeartbeatAt = now();
        return json(res, 200, { ok: true, openPermissions: store.openPermissions().length });
      }
      if (req.method === 'GET' && path === '/v1/inbound') {
        const after = Number.parseInt(url.searchParams.get('after') ?? '', 10);
        endInbound('replaced');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const send = ev => { try { res.write(JSON.stringify(ev) + '\n'); } catch { /* gone */ } };
        for (const m of store.list({ after: Number.isInteger(after) ? after : store.deliveredSeq, limit: 100 })) {
          const ev = inboundEvent(m);
          if (ev) send(ev);
        }
        const unsubscribe = store.subscribe(event => {
          if (event.type !== 'message') return;
          const ev = inboundEvent(event.message);
          if (ev) send(ev);
        });
        const timer = setInterval(() => send({ type: 'ping' }), pingMs);
        const stop = () => { clearInterval(timer); unsubscribe(); };
        inbound = { res, stop };
        req.on('close', () => { if (inbound?.res === res) { inbound = null; stop(); } });
        return undefined;
      }
      if (req.method === 'POST' && path === '/v1/ack') {
        const body = await readBody(req);
        if (!isObject(body) || !Number.isInteger(body.seq)) throw new HttpError(400, 'seq must be an integer');
        // An ack carries the epoch of the stream its line came from (spec §1.5,
        // 2026-11-11, required since the review's point 8): one from a store that has
        // since been reset moves nothing.
        if (body.epoch === undefined || body.epoch === null) throw new HttpError(400, 'epoch is required: the one hello gave');
        if (String(body.epoch) !== String(store.epoch)) throw new HttpError(409, 'that epoch is not current: the store was reset since; say hello again');
        return json(res, 200, { deliveredSeq: await store.ack(body.seq), epoch: store.epoch });
      }
      if (req.method === 'GET' && path === '/v1/unanswered') {
        return json(res, 200, { messages: store.unanswered().map(publicMessage) });
      }
      if (req.method === 'POST' && path === '/v1/reply') {
        const body = await readBody(req, REPLY_BODY_MAX);
        if (!isObject(body)) throw new HttpError(400, 'the body must be an object');
        if (!isClientId(body.clientId)) throw new HttpError(400, 'clientId must be an id of at most 80 characters');
        const had = store.byClientId(body.clientId);
        if (had) return json(res, 200, { id: had.id, seq: had.seq, duplicate: true });
        if (typeof body.text !== 'string' || body.text.length > MAX_TEXT) throw new HttpError(400, `text must be a string of at most ${MAX_TEXT} characters`);
        if (body.replyTo !== undefined && body.replyTo !== null && !isMessageId(body.replyTo)) throw new HttpError(400, 'replyTo must be a message id');
        const shapes = secretShapes(body.text);
        if (shapes.length) throw new HttpError(400, `the text looks like it holds ${shapes.join(', ')}; it was not sent`);
        const files = body.files === undefined || body.files === null ? [] : body.files;
        if (!Array.isArray(files) || files.length > MAX_FILES) throw new HttpError(400, `files must be a list of at most ${MAX_FILES}`);
        const attachments = [];
        for (const f of files) {
          if (!isObject(f) || typeof f.data !== 'string') throw new HttpError(400, 'each file is { name, type, data } with data in base64');
          let data;
          try { data = Buffer.from(f.data, 'base64'); } catch { throw new HttpError(400, 'a file\'s data is not base64'); }
          try { attachments.push(await store.putAttachment({ name: f.name, type: f.type, data })); } catch (err) { throw new HttpError(err.status ?? 400, err.message); }
        }
        const m = await store.append({ from: 'jarvis', kind: 'chat', text: body.text, replyTo: body.replyTo ?? null, clientId: body.clientId, attachments });
        return json(res, 200, { id: m.id, seq: m.seq });
      }
      if (req.method === 'POST' && path === '/v1/edit') {
        const body = await readBody(req);
        if (!isObject(body) || !isMessageId(body.id)) throw new HttpError(400, 'id must be a message id');
        const shapes = secretShapes(body.text);
        if (shapes.length) throw new HttpError(400, `the text looks like it holds ${shapes.join(', ')}; it was not sent`);
        const r = await store.edit(body.id, body.text);
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { id: r.message.id, seq: r.message.seq });
      }
      if (req.method === 'GET' && path === '/v1/history') {
        const before = url.searchParams.get('before');
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
        if (before !== null && !isMessageId(before)) throw new HttpError(400, 'before must be a message id');
        const list = before === null ? store.list({ before: null, after: Math.max(0, store.seq - (Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20)), limit }) : store.list({ before, limit });
        return json(res, 200, { messages: list.map(publicMessage) });
      }
      const att = /^\/v1\/attachment\/([a-f0-9]{32})$/.exec(path);
      if (req.method === 'GET' && att) {
        const a = store.attachment(att[1]);
        if (!a) throw new HttpError(404, 'no such attachment');
        let data;
        try { data = await readFile(a.path); } catch { throw new HttpError(410, 'the file is gone'); }
        res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' });
        return res.end(data);
      }
      if (req.method === 'POST' && path === '/v1/permission-request') {
        const body = await readBody(req);
        if (!isObject(body)) throw new HttpError(400, 'the body must be an object');
        let p;
        try { p = await store.openPermission({ requestId: body.requestId, tool: body.tool, description: body.description, inputPreview: body.inputPreview }); } catch (err) { throw new HttpError(400, err.message); }
        onEvent({ kind: 'permission-opened', requestId: p.requestId, tool: p.tool });
        return json(res, 200, { requestId: p.requestId, state: p.state, openedAt: p.openedAt });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('chat socket error', path, err);
      if (res.headersSent) return res.end();
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
    }
  }

  return { handler, status, isAttachmentId };
}
