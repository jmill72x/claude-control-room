// The page's side of the chat (jarvis-os-chat-spec.md, §2.2-2.4, 2.6), over TCP
// behind the Host check: the device cookie on everything, the write guards (JSON
// only, same origin or none) on writes, pairing, the message routes, uploads, the
// SSE stream with Last-Event-ID replay, verdicts and status. The admin router,
// for `bin/chat-pair` over the admin socket, is at the end.
//
// Cookies are `__Host-` cookies: a browser accepts them over HTTPS only, so until
// Serve runs on HTTPS (the spec's P2) the page can't pair; curl can, and does in the
// tests. `Tailscale-User-Login` is checked against config's `chat.login` on every chat
// route, pairing included: a second factor, never the credential, since a local
// process can forge it. The chat runs only with `chat.login` set and the Host check
// enforcing (`readChatConfig`, the 2026-11-11 review, 3 and 4).
import { json, readBody, guardWrite, guardDelete, HttpError } from '../routes.mjs';
import { publicMessage, isMessageId, isClientId, isAttachmentId, isRequestId, sniffType, MAX_PAGE_TEXT, ATTACHMENT_MAX_BYTES } from './chat-store.mjs';
import { COOKIE_NAME, PAIR_COOKIE_NAME, COOKIE_MAX_AGE_S, PAIR_CODE_TTL_MS, cookieHeader, clearCookieHeader, cleanName } from './chat-devices.mjs';
import { HEARTBEAT_FRESH_MS } from './chat-socket.mjs';
import { readFile } from 'node:fs/promises';
import { checkSubscription } from './webpush.mjs';
import { readAllowedHosts } from './host-guard.mjs';
import { verdictOriginProblem } from './approvals.mjs';
import { oneLine } from './chat-events.mjs';

export const SSE_PING_MS = 20e3;
export const SLOW_AFTER_MS = 10 * 60e3;
// What the page may upload: photos, and PDFs (never text: the channel refuses it
// from the page's side on purpose). Each is sniffed by its first bytes.
export const PAGE_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf']);

// How a file is served to the page. A photo shows inline in the thread; a PDF or a
// text file is always a download, never rendered at this origin: a PDF can carry script and
// forms, and a PDF viewer is a large parser, so `attachment` keeps it out of the
// page's origin altogether (a sandboxing policy alone would also stop Chromium's
// own viewer, so inline-and-sandboxed buys nothing over it). The name is ASCII in
// `filename` and whole in `filename*`.
const DOWNLOAD_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown']);
export function dispositionFor(a) {
  // A text file (the lead's, or text shared through a Shortcut) downloads too: what
  // someone else wrote is never shown as a page at this origin.
  if (!DOWNLOAD_TYPES.has(a?.type)) return 'inline';
  const fallback = a.type === 'application/pdf' ? 'file.pdf' : 'file.txt';
  // Well formed first: a lone surrogate makes encodeURIComponent throw (a 500).
  const name = String(a.name ?? fallback).toWellFormed();
  const ascii = name.replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 120) || fallback;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
const PENDING_UPLOAD_MS = 3600e3;
// Uploads not yet sent with a message, per device: past this the next one is refused
// (429), so a page can't fill the disk with files no message will ever carry.
export const PENDING_UPLOADS_MAX = 8;
const UPLOAD_SWEEP_MS = 10 * 60e3;
const MAX_ATTACHMENTS = 4;
const NO_STORE = { 'Cache-Control': 'no-store' };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const LOGIN = /^[\x21-\x7e]{3,200}$/;

// What config says about the chat, checked: `on` only with a `chat` object whose
// `login` is set and with the Host check in enforce mode. Each problem is logged by
// the caller once; any of them keeps the chat off, the rest of the dashboard runs.
export function readChatConfig(config, hostMode) {
  const chat = config?.chat;
  if (chat === undefined || chat === null) return { on: false, login: null, problems: [] };
  const problems = [];
  if (!isObject(chat)) return { on: false, login: null, problems: ['chat must be an object; the chat stays off'] };
  const login = typeof chat.login === 'string' && LOGIN.test(chat.login.trim()) ? chat.login.trim().toLowerCase() : null;
  if (login === null) problems.push('chat.login must be the owner\'s tailnet login (the value Serve sends as Tailscale-User-Login); the chat stays off');
  if (hostMode !== 'enforce') problems.push('chat needs hostCheck "enforce"; the chat stays off');
  return { on: problems.length === 0, login, problems };
}

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
export function chatState({ socket, store, now, approvals = null }) {
  const open = store.openPermissions();
  const lastJarvis = store.lastJarvisAt();
  const lastJeff = store.lastJeffAt();
  let state, since;
  if (!socket.channelConnected) { state = 'offline'; since = socket.lastHeartbeatAt; }
  else if (open.length > 0) { state = 'waiting on you'; since = Math.min(...open.map(p => p.openedAt)); }
  else if (lastJeff && (!lastJarvis || lastJarvis < lastJeff) && now - lastJeff >= SLOW_AFTER_MS) { state = 'slow'; since = lastJeff; }
  else { state = 'online'; since = socket.helloAt; }
  const pub = p => (approvals ? { ...store.publicPermission(p), ...approvals.view(p, now) } : store.publicPermission(p));
  return {
    state, since: since ?? null, channelConnected: socket.channelConnected, lastHeartbeatAt: socket.lastHeartbeatAt, lastJarvisMessageAt: lastJarvis,
    openPermission: open.length > 0 ? pub(open[0]) : null, openPermissions: open.length,
    approvals: approvals ? approvals.status(now) : { mode: 'off', denyOnlyUntil: null }
  };
}

// Where a tap on a notification goes, from the subscribing page's Origin: kept only
// when it is https and its host is one of config's `allowedHosts` (the Serve name),
// and then only its normalised origin; anything else is null, and the push says the
// relative `/#chat`. The write guard has already matched Origin with Host, but a
// Host that the guard lets through in "log" mode, or a loopback page, is no place to
// send a tap from the lock screen.
export function notificationOrigin(raw, allowedHosts) {
  if (typeof raw !== 'string' || raw === '' || raw === 'null') return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  // URL leaves out the default port, so a name listed as `name:443` matches too.
  return allowedHosts.has(u.host) || (u.port === '' && allowedHosts.has(`${u.hostname}:443`)) ? u.origin : null;
}

// `push` is the push service (lib/chat-push.mjs), or null while notifications are
// off: its key, and the loopback hosts a scratch push service may use (tests only).
// `approvals` is the gate (lib/approvals.mjs); without one, every verdict is refused.
// `shortcutKeys` says whether the Shortcut routes are on (lib/shortcut-routes.mjs): the
// status answer carries it, so the page asks for the keys only when there are any.
export function createChatRoutes({ store, devices, socket, config = {}, now = () => Date.now(), onEvent = () => {}, log: logLine = console.log, pingMs = SSE_PING_MS, push = null, approvals = null, shortcutKeys = false, agentStop = null }) {
  // Every log line here names a device, and a name read back from devices.json was
  // never cleaned, so each line is made one line (lib/chat-events.mjs).
  const log = line => logLine(oneLine(line));
  const login = typeof config?.chat?.login === 'string' && config.chat.login.trim() ? config.chat.login.trim().toLowerCase() : null;
  const notifyHosts = new Set(readAllowedHosts(config).names);
  const pendingUploads = new Map(); // id -> { attachment, at, deviceId }
  const streams = new Set();         // { res, deviceId, stop }
  const streamClosedAt = new Map();  // device id -> when its last stream closed (the push rule)

  // A pending upload expires after an hour, and its file goes with it: on every
  // upload and every 10 minutes (an unref'd timer), so an unsent photo stays on
  // disk an hour or so, not the 90 days a sent one keeps.
  async function sweepUploads() {
    const at = now();
    let gone = 0;
    for (const [id, up] of [...pendingUploads]) {
      if (at - up.at <= PENDING_UPLOAD_MS) continue;
      pendingUploads.delete(id);
      if (await store.removeAttachment(id)) gone++;
    }
    return gone;
  }
  const sweepTimer = setInterval(() => { sweepUploads().catch(() => {}); }, UPLOAD_SWEEP_MS);
  sweepTimer.unref?.();

  // The login header, when configured, must match (403): it says which tailnet user
  // the proxy saw. Checked on every chat route, the pairing ones first of all.
  function requireLogin(req) {
    if (login === null) return;
    const seen = req.headers?.['tailscale-user-login'];
    if (typeof seen !== 'string' || seen.trim().toLowerCase() !== login) throw new HttpError(403, 'the request did not come as the owner through the tailnet');
  }
  // The device behind a request, or a 401.
  function requireDevice(req) {
    requireLogin(req);
    const device = devices.authenticate(req.headers?.cookie);
    if (!device) throw new HttpError(401, 'this device is not paired');
    return device;
  }

  // End every open stream of a device (its revoke), with one last event so the page
  // knows why, and never on a later ping alone.
  function closeStreams(deviceId, reason) {
    for (const entry of [...streams]) {
      if (entry.deviceId !== deviceId) continue;
      streams.delete(entry);
      entry.stop();
      writeEvent(entry.res, reason, null, { reason });
      try { entry.res.end(); } catch { /* gone */ }
    }
  }

  // A request as the page gets it: the store's fields plus the gate's view (mode, the
  // reasons it is Deny-only now, whether Allow may be offered).
  const pubPermission = p => (approvals ? { ...store.publicPermission(p), ...approvals.view(p, now()) } : { ...store.publicPermission(p), mode: 'off', canAllow: false });
  const state = () => chatState({ socket: socket.status(), store, now: now(), approvals });
  // Each request, as it opens: which paired devices had the chat open to draw its card
  // (board: "this approval never went to Jarvis OS", 2026-11-12, when nothing said
  // whether a page was there to show it). Names only; the push rule is chat-push.mjs's.
  store.subscribe?.(event => {
    if (event.type !== 'permission' || event.request?.state !== 'open') return;
    const names = [...new Set([...streams].map(s => devices.list?.().find(d => d.id === s.deviceId)?.name ?? 'a device'))];
    log(`chat: request ${event.request.requestId} opened with ${names.length ? `the chat open on ${names.join(', ')}` : 'no page open on the chat (a push goes to each device that takes one)'}`);
  });
  const writeEvent = (res, name, id, data) => { try { res.write(`event: ${name}\n${id !== null ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
  const eventFor = event => {
    if (event.type === 'message') return ['message', event.message.seq, publicMessage(event.message)];
    if (event.type === 'edit') return ['edit', null, publicMessage(event.message)];
    if (event.type === 'state') return ['state', null, { id: event.message.id, state: event.message.state }];
    if (event.type === 'permission') return ['permission', null, pubPermission(event.request)];
    if (event.type === 'permission-closed') return ['permission-closed', null, pubPermission(event.request)];
    return null;
  };

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      // ---- stops and their Face ID (lib/agent-stop.mjs) ----
      if (agentStop?.owns(path)) return await agentStop.handle(req, res, path, { requireDevice, notifyHosts });
      // ---- pairing (§2.2) ----
      if (req.method === 'POST' && path === '/api/pair/start') {
        guardWrite(req);
        requireLogin(req);
        // A device that is paired already has nothing to pair: refused, so it can
        // never hold an approved pairing that outlives its own revoke.
        if (devices.authenticate(req.headers?.cookie)) throw new HttpError(409, 'this device is already paired');
        const body = await readBody(req);
        const r = await devices.start(isObject(body) ? body.name : null);
        if (!r.ok) throw new HttpError(r.status, r.error);
        // The cleaned name, the one the device will carry: never the raw text.
        log(`chat: a device asked to pair (${r.name})`);
        onEvent({ kind: 'pairing-started', name: r.name });
        return json(res, 200, { code: r.code, expiresAt: r.expiresAt }, { ...NO_STORE, 'Set-Cookie': cookieHeader(PAIR_COOKIE_NAME, r.pairToken, Math.round(PAIR_CODE_TTL_MS / 1000)) });
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
        requireLogin(req);
        // A device that is paired already hears so here (its own id and name; no
        // device cookie set, and any pairing cookie it still holds cleared): the
        // page asks this first, so an unpaired device never has to take a 401 to
        // learn that it must pair.
        const already = devices.authenticate(req.headers?.cookie);
        if (already) return json(res, 200, { state: 'paired', device: { id: already.id, name: already.name }, already: true }, { ...NO_STORE, 'Set-Cookie': clearCookieHeader(PAIR_COOKIE_NAME) });
        const r = await devices.status(req.headers?.cookie);
        if (r.state === 'paired') {
          return json(res, 200, { state: 'paired', device: r.device }, { ...NO_STORE, 'Set-Cookie': [cookieHeader(COOKIE_NAME, r.token, COOKIE_MAX_AGE_S), clearCookieHeader(PAIR_COOKIE_NAME)] });
        }
        return json(res, 200, { state: r.state, expiresAt: r.expiresAt ?? null }, NO_STORE);
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
        closeStreams(dev[1], 'revoked');
        // Revoking itself, the device also drops the cookie it can no longer use.
        return json(res, 200, { ok: true }, dev[1] === device.id ? { 'Set-Cookie': clearCookieHeader(COOKIE_NAME) } : {});
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
        await sweepUploads();
        if ([...pendingUploads.values()].filter(up => up.deviceId === device.id).length >= PENDING_UPLOADS_MAX) {
          throw new HttpError(429, `at most ${PENDING_UPLOADS_MAX} files can wait to be sent; send or wait an hour`);
        }
        const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!PAGE_ATTACHMENT_TYPES.has(type)) throw new HttpError(415, 'an upload is a jpeg, png, webp or heic image, or a pdf');
        const data = await readRaw(req, ATTACHMENT_MAX_BYTES);
        // Sniffed before anything is written: the bytes decide, and a photo must
        // say photo and a PDF say PDF (`%PDF-`), never one dressed as the other.
        const sniffed = sniffType(data);
        if (!PAGE_ATTACHMENT_TYPES.has(sniffed)) throw new HttpError(415, 'the file is not an image or a pdf');
        if ((sniffed === 'application/pdf') !== (type === 'application/pdf')) throw new HttpError(415, 'the file is not what its type says');
        let a;
        try { a = await store.putAttachment({ name: url.searchParams.get('name') ?? (sniffed === 'application/pdf' ? 'file.pdf' : 'photo'), type, data }); } catch (err) { throw new HttpError(err.status ?? 400, err.message); }
        pendingUploads.set(a.id, { attachment: a, at: now(), deviceId: device.id });
        return json(res, 200, { id: a.id, name: a.name, type: a.type, bytes: a.bytes });
      }
      const att = /^\/api\/chat\/attachments\/([a-f0-9]{32})$/.exec(path);
      if (req.method === 'GET' && att) {
        const device = requireDevice(req);
        // A file on a message is every device's; one still pending is its uploader's alone.
        let a = store.attachment(att[1]);
        if (!a) {
          const up = pendingUploads.get(att[1]);
          if (up && up.deviceId === device.id) a = up.attachment;
        }
        if (!a) throw new HttpError(404, 'no such attachment');
        let data;
        try { data = await readFile(store.attachmentPath(att[1])); } catch { throw new HttpError(410, 'the file is gone'); }
        // no-store, like the rest of the chat: a device that is revoked or lost keeps
        // no copy of a photo in its cache, and a re-read over the tailnet is cheap.
        res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': dispositionFor(a), 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.end(data);
      }

      // ---- the stream (§2.4) ----
      if (req.method === 'GET' && path === '/api/chat/stream') {
        const device = requireDevice(req);
        const lastId = Number.parseInt(req.headers?.['last-event-id'] ?? url.searchParams.get('after') ?? '', 10);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.write(`retry: 3000\n\n`);
        writeEvent(res, 'status', null, state());
        if (Number.isInteger(lastId)) {
          for (const m of store.list({ after: lastId, limit: 100 })) writeEvent(res, 'message', m.seq, publicMessage(m));
        }
        // The open requests, and those that timed out here unanswered in the last hour.
        for (const p of (store.cardPermissions ?? store.openPermissions)()) writeEvent(res, 'permission', null, pubPermission(p));
        const unsubscribe = store.subscribe(event => { const e = eventFor(event); if (e) writeEvent(res, ...e); });
        const entry = { res, deviceId: device.id, stop: () => { clearInterval(timer); unsubscribe(); } };
        // Each ping re-checks the device: a revoke from any path ends the stream
        // within one ping, even when the revoke route's own close missed it.
        const timer = setInterval(() => {
          if (!devices.isActive(device.id)) { closeStreams(device.id, 'revoked'); return; }
          try { res.write(': ping\n\n'); } catch { /* gone */ }
          writeEvent(res, 'status', null, state());
        }, pingMs);
        streams.add(entry);
        req.on('close', () => { streams.delete(entry); entry.stop(); streamClosedAt.set(device.id, now()); });
        return undefined;
      }

      // ---- notifications (§3) ----
      if (req.method === 'GET' && path === '/api/push/key') {
        const device = requireDevice(req);
        if (!push?.on()) throw new HttpError(503, 'notifications are not set up on the server yet');
        return json(res, 200, { key: push.publicKey(), subscribed: devices.hasPush(device.id) }, NO_STORE);
      }
      if (req.method === 'POST' && path === '/api/push/subscription') {
        guardWrite(req);
        const device = requireDevice(req);
        if (!push?.on()) throw new HttpError(503, 'notifications are not set up on the server yet');
        const checked = checkSubscription(await readBody(req), { testHosts: push.testHosts ?? null });
        if (!checked.ok) throw new HttpError(400, checked.error);
        // Where a tap on a notification goes (notificationOrigin): the Serve name's
        // https origin, else null and a relative link.
        const origin = notificationOrigin(req.headers?.origin, notifyHosts);
        const r = await devices.setPush(device.id, { ...checked.subscription, origin });
        if (!r.ok) throw new HttpError(r.status, r.error);
        log(`push: ${device.name} turned notifications on`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && path === '/api/push/subscription') {
        guardDelete(req);
        const device = requireDevice(req);
        await devices.setPush(device.id, null);
        log(`push: ${device.name} turned notifications off`);
        return json(res, 200, { ok: true });
      }

      // ---- verdicts and status ----
      const perm = /^\/api\/chat\/permission\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (req.method === 'POST' && perm) return await verdict(req, res, perm[1]);
      if (req.method === 'GET' && path === '/api/chat/status') {
        const device = requireDevice(req);
        // `device` is the asking device's own id and name (the Chat tab's settings
        // sheet marks "this device" with it); never another device's.
        return json(res, 200, { ...state(), seq: store.seq, epoch: store.epoch, streams: streams.size, device: { id: device.id, name: device.name, approver: device.approver === true }, shortcutKeys: shortcutKeys === true }, { 'Cache-Control': 'no-store' });
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

  // A verdict (design §5.1 step 7, with Ultron's order): the write guard, the mode
  // (off answers 403 to anyone), the device (a refusal with no device locks nobody
  // out), its lockout and limits, the Origin rule, then the body: Allow needs mode
  // "on" and an approver device, and the store checks the request is open, the
  // `shown` hash matches and nothing makes it Deny-only now. Every refusal after the
  // device is known counts toward its lockout, and changes nothing, except a card that
  // changed under the tap (below), which still counts toward the tap limits.
  async function verdict(req, res, requestId) {
    guardWrite(req);
    if (!approvals || approvals.mode() === 'off') throw new HttpError(403, 'approvals are off on this server');
    let device;
    try { device = requireDevice(req); } catch (err) { approvals.noteAnonymousRefusal(); throw err; }
    const refuse = (status, error) => { approvals.noteRefusal(device.id, device.name); log(`chat: a verdict from ${device.name} was refused (${status}: ${error})`); return new HttpError(status, error); };
    const limited = approvals.check(device.id);
    if (limited) throw refuse(limited.status, limited.error);
    const originProblem = verdictOriginProblem(req.headers, notifyHosts);
    if (originProblem) throw refuse(403, originProblem);
    approvals.noteTap(device.id);
    const body = await readBody(req);
    const behavior = isObject(body) ? body.behavior : null;
    const shown = isObject(body) && typeof body.shown === 'string' ? body.shown : null;
    if (behavior !== 'allow' && behavior !== 'deny') throw refuse(400, 'behavior must be allow or deny');
    if (!/^[a-f0-9]{64}$/.test(shown ?? '')) throw refuse(400, 'shown must be the hash of what the card showed');
    if (behavior === 'allow') {
      if (approvals.mode() !== 'on') throw refuse(403, 'approvals are Deny only for now; allow this one at the terminal or in Discord');
      if (device.approver !== true) throw refuse(403, 'this device may not allow; answer at the terminal or in Discord');
    }
    // Before an Allow is checked against what the card showed: let the gate look again,
    // so a parity card whose exact text was just disputed has lost it, and a tap made on
    // the old card is refused as stale (409) instead of allowing a text that may be false.
    // Not before a Deny: Deny always works.
    if (behavior === 'allow') { const cur = store.permission(requestId); if (cur?.state === 'open') approvals.reasonsNow(cur); }
    const r = await store.answerPermission(requestId, behavior, device.name, {
      shown, requireShown: true,
      allowProblem: p => { const why = approvals.reasonsNow(p); return why.length ? `allow this one at the terminal or in Discord: ${why[0]}` : null; }
    });
    // A card that changed under the tap (the gate marked it after the page drew it) is
    // no wrong tap: it is not counted toward the lockout, and the answer carries the card
    // as it is now, so the page redraws it before anyone taps again (Ultron's L1).
    if (!r.ok && r.changed === true && r.request) {
      log(`chat: a verdict from ${device.name} was refused (409: ${r.error}); the page gets the card again`);
      return json(res, 409, { error: r.error, changed: true, request: pubPermission(r.request) });
    }
    if (!r.ok) throw refuse(r.status, r.error);
    log(`chat: permission ${requestId} ${r.request.state} by ${device.name}`);
    if (behavior === 'allow') approvals.noteAllow();
    onEvent({ kind: 'verdict', requestId, behavior: r.request.state, device: device.name, tool: r.request.tool });
    return json(res, 200, { ok: true, state: r.request.state, answeredAt: r.request.answeredAt });
  }

  // Which paths this router owns.
  const owns = path => agentStop?.owns(path) === true || path.startsWith('/api/chat/') || path.startsWith('/api/pair/') || path.startsWith('/api/push/') || path === '/api/devices' || path.startsWith('/api/devices/');
  // How many devices hold a stream open now (the push rule later: none in 10 s means push).
  const streaming = () => new Set([...streams].map(s => s.deviceId));

  // Whether a device has a stream open ('open'), else when its last one closed, or
  // null if it never had one in this run: the 10 s rule (lib/chat-push.mjs).
  const lastStream = id => ([...streams].some(s => s.deviceId === id) ? 'open' : streamClosedAt.get(id) ?? null);

  return { handler, owns, streaming, lastStream, sweepUploads, chatState: () => state(), HEARTBEAT_FRESH_MS };
}

// The admin socket's router: `bin/chat-pair <code>` on the machine approves the
// pending code (the first device, with nothing paired yet to approve from), lists
// the devices, and sets a device's approver mark (`chat-pair approver <name> on|off`,
// alerted through the device store's onEvent). Reachable only through the 0600 admin
// socket.
export function createAdminRouter({ devices, onEvent = () => {}, stepUp = null }) {
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
      if (req.method === 'POST' && path === '/admin/approver') {
        const body = await readBody(req);
        const r = await devices.setApprover(isObject(body) ? body.device : null, isObject(body) ? body.on : null);
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true, changed: r.changed, device: r.device });
      }
      // `chat-pair passkey <CODE>`: shows which device set up Face ID for stops (GET),
      // then confirms it with the code and the device name typed back (lib/stepup.mjs).
      if (req.method === 'GET' && path === '/admin/passkey' && stepUp) return json(res, 200, { pending: stepUp.pendingInfo() });
      if (req.method === 'POST' && path === '/admin/passkey' && stepUp) {
        const body = await readBody(req);
        const isApprover = id => devices.list().some(d => d.id === id && !d.revokedAt && d.approver === true);
        const r = await stepUp.confirm(isObject(body) ? body.code : null, { isApprover, name: isObject(body) ? body.name : null });
        if (!r.ok) throw new HttpError(r.status, r.error);
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
