// The page's side of the chat (jarvis-os-chat-spec.md, §2.2-2.4, 2.6), over TCP
// behind the Host check: the device cookie on everything, the write guards (JSON
// only, same origin or none) on writes, pairing, the message routes, uploads, the
// SSE stream with Last-Event-ID replay, verdicts and status. The admin router,
// for `bin/chat-pair` over the admin socket, is at the end.
//
// Cookies are `__Host-` cookies: a browser accepts them over HTTPS only, so until
// Serve runs on HTTPS (the spec's P2) the page can't pair; curl can, and does in the
// tests. `Tailscale-User-Login` is checked against config's `chat.login` when that
// is set: a second factor, never the credential, since a local process can forge it.
import { json, readBody, guardWrite, guardDelete, HttpError } from '../routes.mjs';
import { publicMessage, isMessageId, isClientId, isAttachmentId, isRequestId, MAX_PAGE_TEXT, ATTACHMENT_MAX_BYTES } from './chat-store.mjs';
import { COOKIE_NAME, PAIR_COOKIE_NAME, COOKIE_MAX_AGE_S, PAIR_CODE_TTL_MS, cookieHeader, clearCookieHeader } from './chat-devices.mjs';
import { HEARTBEAT_FRESH_MS } from './chat-socket.mjs';
import { readFile } from 'node:fs/promises';

export const SSE_PING_MS = 20e3;
export const SLOW_AFTER_MS = 10 * 60e3;
export const PAGE_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic']);
const PENDING_UPLOAD_MS = 3600e3;
const MAX_ATTACHMENTS = 4;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The raw body of an upload, bounded, as a Buffer.
const readRaw = (req, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0, done = false;
  req.on('data', c => {
    if (done) return;
    size += c.length;
    if (size > limit) { done = true; req.pause?.(); return reject(new HttpError(413, `the file is over ${Math.round(limit / 1024 / 1024)} MB`)); }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
  req.on('error', err => { if (!done) { done = true; reject(new HttpError(400, String(err?.message ?? err))); } });
});

// The chat status (§2.6): online, waiting on you, offline or slow, and since when.
export function chatState({ socket, store, now }) {
  const open = store.openPermissions();
  const lastJarvis = store.lastJarvisAt();
  const lastJeff = store.lastJeffAt();
  let state, since;
  if (!socket.channelConnected) { state = 'offline'; since = socket.lastHeartbeatAt; }
  else if (open.length > 0) { state = 'waiting on you'; since = Math.min(...open.map(p => p.openedAt)); }
  else if (lastJeff && (!lastJarvis || lastJarvis < lastJeff) && now - lastJeff >= SLOW_AFTER_MS) { state = 'slow'; since = lastJeff; }
  else { state = 'online'; since = socket.helloAt; }
  return { state, since: since ?? null, channelConnected: socket.channelConnected, lastHeartbeatAt: socket.lastHeartbeatAt, lastJarvisMessageAt: lastJarvis, openPermission: open.length > 0 ? store.publicPermission(open[0]) : null, openPermissions: open.length };
}

export function createChatRoutes({ store, devices, socket, config = {}, now = () => Date.now(), onEvent = () => {}, log = console.log, pingMs = SSE_PING_MS }) {
  const login = typeof config?.chat?.login === 'string' && config.chat.login ? config.chat.login : null;
  const pendingUploads = new Map(); // id -> { attachment, at, deviceId }
  const streams = new Set();         // { res, deviceId }

  // The device behind a request, or a 401. The login header, when configured, must
  // match too (403): it says which tailnet user the proxy saw.
  function requireDevice(req) {
    const device = devices.authenticate(req.headers?.cookie);
    if (!device) throw new HttpError(401, 'this device is not paired');
    if (login !== null) {
      const seen = req.headers?.['tailscale-user-login'];
      if (typeof seen !== 'string' || seen.trim().toLowerCase() !== login.toLowerCase()) throw new HttpError(403, 'the request did not come as the owner through the tailnet');
    }
    return device;
  }

  const writeEvent = (res, name, id, data) => { try { res.write(`event: ${name}\n${id !== null ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
  const eventFor = event => {
    if (event.type === 'message') return ['message', event.message.seq, publicMessage(event.message)];
    if (event.type === 'edit') return ['edit', null, publicMessage(event.message)];
    if (event.type === 'state') return ['state', null, { id: event.message.id, state: event.message.state }];
    if (event.type === 'permission') return ['permission', null, store.publicPermission(event.request)];
    if (event.type === 'permission-closed') return ['permission-closed', null, store.publicPermission(event.request)];
    return null;
  };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      // ---- pairing (§2.2) ----
      if (req.method === 'POST' && path === '/api/pair/start') {
        guardWrite(req);
        const body = await readBody(req);
        const r = await devices.start(isObject(body) ? body.name : null);
        if (!r.ok) throw new HttpError(r.status, r.error);
        onEvent({ kind: 'pairing-started', name: isObject(body) ? String(body.name).slice(0, 40) : '' });
        return json(res, 200, { code: r.code, expiresAt: r.expiresAt }, { 'Set-Cookie': cookieHeader(PAIR_COOKIE_NAME, r.pairToken, Math.round(PAIR_CODE_TTL_MS / 1000)) });
      }
      if (req.method === 'POST' && path === '/api/pair/approve') {
        guardWrite(req);
        const device = requireDevice(req);
        const body = await readBody(req);
        const r = await devices.approve(isObject(body) ? body.code : null, { by: device.name, login: req.headers?.['tailscale-user-login'] ?? null });
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true, name: r.name });
      }
      if (req.method === 'GET' && path === '/api/pair/status') {
        const r = await devices.status(req.headers?.cookie);
        if (r.state === 'paired') {
          return json(res, 200, { state: 'paired', device: r.device }, { 'Set-Cookie': [cookieHeader(COOKIE_NAME, r.token, COOKIE_MAX_AGE_S), clearCookieHeader(PAIR_COOKIE_NAME)] });
        }
        return json(res, 200, { state: r.state, expiresAt: r.expiresAt ?? null });
      }
      if (req.method === 'GET' && path === '/api/devices') {
        requireDevice(req);
        return json(res, 200, { devices: devices.list() });
      }
      const dev = /^\/api\/devices\/([a-f0-9]{16})$/.exec(path);
      if (req.method === 'DELETE' && dev) {
        guardDelete(req);
        const device = requireDevice(req);
        const r = await devices.revoke(dev[1], device.name);
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true });
      }

      // ---- messages (§2.3) ----
      if (req.method === 'GET' && path === '/api/chat/messages') {
        requireDevice(req);
        const after = url.searchParams.has('after') ? Number.parseInt(url.searchParams.get('after'), 10) : null;
        const before = url.searchParams.get('before');
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
        if (before !== null && !isMessageId(before)) throw new HttpError(400, 'before must be a message id');
        const list = before !== null ? store.list({ before, limit }) : store.list({ after: Number.isInteger(after) ? after : Math.max(0, store.seq - (Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50)), limit });
        return json(res, 200, { messages: list.map(publicMessage), seq: store.seq, epoch: store.epoch }, { 'Cache-Control': 'no-store' });
      }
      if (req.method === 'POST' && path === '/api/chat/messages') {
        guardWrite(req);
        const device = requireDevice(req);
        const body = await readBody(req);
        if (!isObject(body)) throw new HttpError(400, 'the body must be an object');
        if (!isClientId(body.clientId)) throw new HttpError(400, 'clientId must be an id of at most 80 characters');
        const had = store.byClientId(body.clientId);
        if (had) return json(res, 200, { id: had.id, seq: had.seq, duplicate: true });
        if (typeof body.text !== 'string' || body.text.length > MAX_PAGE_TEXT) throw new HttpError(400, `text must be a string of at most ${MAX_PAGE_TEXT} characters`);
        if (body.replyTo !== undefined && body.replyTo !== null && !isMessageId(body.replyTo)) throw new HttpError(400, 'replyTo must be a message id');
        const ids = body.attachmentIds === undefined || body.attachmentIds === null ? [] : body.attachmentIds;
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || !ids.every(isAttachmentId)) throw new HttpError(400, `attachmentIds must be a list of at most ${MAX_ATTACHMENTS} ids`);
        if (body.text.trim() === '' && ids.length === 0) throw new HttpError(400, 'a message needs text or a file');
        const attachments = [];
        for (const id of ids) {
          const up = pendingUploads.get(id);
          if (!up || up.deviceId !== device.id) throw new HttpError(400, 'an attachment id is unknown or belongs to another device');
          attachments.push(up.attachment);
        }
        const m = await store.append({ from: 'jeff', kind: 'chat', text: body.text, replyTo: body.replyTo ?? null, device: device.name, clientId: body.clientId, attachments, state: 'queued' });
        for (const id of ids) pendingUploads.delete(id);
        return json(res, 200, { id: m.id, seq: m.seq });
      }
      if (req.method === 'POST' && path === '/api/chat/attachments') {
        // Raw bytes, so no JSON to require: the origin rule alone, like a DELETE.
        guardDelete(req);
        const device = requireDevice(req);
        const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!PAGE_ATTACHMENT_TYPES.has(type)) throw new HttpError(415, 'an upload is a jpeg, png, webp or heic image');
        const data = await readRaw(req, ATTACHMENT_MAX_BYTES);
        let a;
        try { a = await store.putAttachment({ name: url.searchParams.get('name') ?? 'photo', type, data }); } catch (err) { throw new HttpError(err.status ?? 400, err.message); }
        if (!PAGE_ATTACHMENT_TYPES.has(a.type)) throw new HttpError(415, 'the file is not an image');
        const at = now();
        for (const [id, up] of pendingUploads) if (at - up.at > PENDING_UPLOAD_MS) pendingUploads.delete(id);
        pendingUploads.set(a.id, { attachment: a, at, deviceId: device.id });
        return json(res, 200, { id: a.id, name: a.name, type: a.type, bytes: a.bytes });
      }
      const att = /^\/api\/chat\/attachments\/([a-f0-9]{32})$/.exec(path);
      if (req.method === 'GET' && att) {
        requireDevice(req);
        const a = store.attachment(att[1]) ?? pendingUploads.get(att[1])?.attachment ?? null;
        if (!a) throw new HttpError(404, 'no such attachment');
        let data;
        try { data = await readFile(store.attachmentPath(att[1])); } catch { throw new HttpError(410, 'the file is gone'); }
        res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.end(data);
      }

      // ---- the stream (§2.4) ----
      if (req.method === 'GET' && path === '/api/chat/stream') {
        const device = requireDevice(req);
        const lastId = Number.parseInt(req.headers?.['last-event-id'] ?? url.searchParams.get('after') ?? '', 10);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.write(`retry: 3000\n\n`);
        writeEvent(res, 'status', null, chatState({ socket: socket.status(), store, now: now() }));
        if (Number.isInteger(lastId)) {
          for (const m of store.list({ after: lastId, limit: 100 })) writeEvent(res, 'message', m.seq, publicMessage(m));
        }
        for (const p of store.openPermissions()) writeEvent(res, 'permission', null, store.publicPermission(p));
        const unsubscribe = store.subscribe(event => { const e = eventFor(event); if (e) writeEvent(res, ...e); });
        const timer = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* gone */ }
          writeEvent(res, 'status', null, chatState({ socket: socket.status(), store, now: now() }));
        }, pingMs);
        const entry = { res, deviceId: device.id };
        streams.add(entry);
        req.on('close', () => { streams.delete(entry); clearInterval(timer); unsubscribe(); });
        return undefined;
      }

      // ---- verdicts and status ----
      const perm = /^\/api\/chat\/permission\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (req.method === 'POST' && perm) {
        guardWrite(req);
        const device = requireDevice(req);
        const body = await readBody(req);
        if (!isRequestId(perm[1])) throw new HttpError(400, 'bad request id');
        const r = await store.answerPermission(perm[1], isObject(body) ? body.behavior : null, device.name);
        if (!r.ok) throw new HttpError(r.status, r.error);
        log(`chat: permission ${perm[1]} ${r.request.state} by ${device.name}`);
        onEvent({ kind: 'verdict', requestId: perm[1], behavior: r.request.state, device: device.name, tool: r.request.tool });
        return json(res, 200, { ok: true, state: r.request.state });
      }
      if (req.method === 'GET' && path === '/api/chat/status') {
        requireDevice(req);
        return json(res, 200, { ...chatState({ socket: socket.status(), store, now: now() }), seq: store.seq, epoch: store.epoch, streams: streams.size }, { 'Cache-Control': 'no-store' });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('chat route error', path, err);
      if (res.headersSent) return res.end();
      if (code === 413) { res.writeHead(413, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); return res.end(JSON.stringify({ error: String(err.message) })); }
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
    }
  }

  // Which paths this router owns.
  const owns = path => path.startsWith('/api/chat/') || path.startsWith('/api/pair/') || path === '/api/devices' || path.startsWith('/api/devices/');
  // How many devices hold a stream open now (the push rule later: none in 10 s means push).
  const streaming = () => new Set([...streams].map(s => s.deviceId));

  return { handler, owns, streaming, chatState: () => chatState({ socket: socket.status(), store, now: now() }), HEARTBEAT_FRESH_MS };
}

// The admin socket's router: `bin/chat-pair <code>` on the machine approves the
// pending code (the first device, with nothing paired yet to approve from), and
// lists the devices. Reachable only through the 0600 admin socket.
export function createAdminRouter({ devices, onEvent = () => {} }) {
  return async function handler(req, res) {
    const path = new URL(req.url, 'http://unix').pathname;
    try {
      if (req.method === 'POST' && path === '/admin/approve') {
        const body = await readBody(req);
        const r = await devices.approve(isObject(body) ? body.code : null, { by: 'chat-pair on this machine' });
        if (!r.ok) throw new HttpError(r.status, r.error);
        onEvent({ kind: 'pairing-approved', by: 'chat-pair', name: r.name });
        return json(res, 200, { ok: true, name: r.name });
      }
      if (req.method === 'GET' && path === '/admin/devices') return json(res, 200, { devices: devices.list(), pending: devices.pendingCode() !== null });
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('chat admin error', path, err);
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
    }
  };
}
