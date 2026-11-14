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
// line `{"type":"replaced"}` and its socket closes, and the old token is dead. The
// holder's own re-hello, or a second inbound stream it opens, ends its old stream
// with `{"type":"superseded"}` instead: nobody else took anything.
//
// A clean exit says `POST /v1/bye` (2026-11-11, the channel's end-to-end run): the
// place is free at once, logged and never alerted. A holder whose inbound stream
// has closed (not by this server) and that has then missed a heartbeat is gone too
// (a crash): stale after 20 s instead of 45, so its restart is let in sooner.
//
// Inbound replay pages through everything after `after`, not one page of 100, and
// an ack moves the cursor only as far as this session's streams have actually sent
// (the end-to-end run lost 30 of 130 queued messages to both).
//
// Backpressure (Ultron's third 11-11 re-read): the replay writes one message at a
// time and waits for 'drain' whenever a write says the buffer is full, so a big
// backlog never sits in memory at once. A holder that stops reading (stalled,
// SIGSTOP) still can't make the server buffer without limit: once the stream's
// unsent bytes pass INBOUND_BUFFER_MAX the stream is cut (logged), and the channel
// reconnects from its cursor, since nothing unacked was marked delivered.
//
// A bye followed by a fresh hello is a normal restart: the gap is logged (and
// called quick under 5 s) and a `notice` from `system` goes in the store, "Jarvis's
// channel restarted HH:MM" in the server's local time, so the chat shows it. It is
// never pushed or alerted (no `onEvent`), and the channel's own stream skips it.
//
// The hello after a bye is checked (Ultron's channel-fixes review, finding 1): the
// channel says bye on a signal any same-user process can send, so `verifyRestart(pid)`
// (lib/chat-verify.mjs: alive, running the released channel's server.mjs, under the
// lead's launch) must pass. If it fails, or no verifier was given, the hello is refused
// with 409 and alerted as `client-replaced` (with `unverified` set), and the place stays
// free for the real channel. A bye with no hello after it within 2 minutes is alerted
// once, as `channel-silent` (finding 5). Hellos are handled one at a time, so a check in
// flight can't be raced.
//
// Errors are `{error}` with fixed words: never the text of a message.
import { json, readBody, HttpError } from '../routes.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { publicMessage, isMessageId, isClientId, isAttachmentId, MAX_TEXT, ATTACHMENT_MAX_BYTES } from './chat-store.mjs';
import { secretShapes } from './secret-shape.mjs';
import { readFile } from 'node:fs/promises';

export const HEARTBEAT_FRESH_MS = 45e3;
export const INBOUND_PING_MS = 15e3;
// The channel's heartbeat comes every 15 s; one missed, with 5 s of slack.
export const HEARTBEAT_MISSED_MS = 20e3;
export const REPLAY_PAGE = 100;
export const SESSION_HEADER = 'x-session-token';
// What a channel names in hello's `capabilities` to be sent events.
export const EVENTS_CAPABILITY = 'events';
// What a channel names in hello's `capabilities` to be sent stop requests (war room
// slice 2, docs/design/2026-11-13-war-room-stop.md): one that doesn't is never sent
// one, and the stop route refuses while it holds the socket (an older channel acks a
// line type it doesn't know, which would swallow the stop: Ultron's L4 for events).
export const STOP_CAPABILITY = 'stop';
// A stop goes down the stream only this soon after the tap: one replayed after a
// channel restart, later than this, is never delivered (marked undelivered instead),
// so a stop can't land on a run started since.
export const STOP_DELIVER_MS = 2 * 60e3;
export const UNDELIVERED = 'undelivered';
// What a stream may hold unsent before it is cut: a stalled holder's ceiling.
export const INBOUND_BUFFER_MAX = 4 * 1024 * 1024;
// A hello this soon after a bye is a quick restart (named in the log line).
export const QUICK_RESTART_MS = 5e3;
// A bye with no hello after it for this long is alerted, once.
export const BYE_SILENCE_MS = 120e3;
// After a bye, the new channel must have started no earlier than this before it.
export const BYE_START_SLACK_MS = 2e3;
const pad2 = n => String(n).padStart(2, '0');
// HH:MM in the server's local time.
export const clockTime = at => { const d = new Date(at); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
export const restartNotice = at => `Jarvis's channel restarted ${clockTime(at)}`;
const newToken = () => randomBytes(32).toString('base64url');
// The version a hello names, for a log line: the channel writes it, so anything but a
// plain version string (digits, letters, dots, plus and dash, 40 at most) is left out.
export const logVersion = v => (typeof v === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(v) ? `version ${v}` : 'version not given or not plain');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
export const MAX_FILES = 4;
// A reply with four 10 MB files, base64, with room to spare.
const REPLY_BODY_MAX = 4 * ATTACHMENT_MAX_BYTES * 1.4 + 64 * 1024;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// What goes down the inbound stream: the owner's chat messages, verdicts and events
// (lib/events.mjs). An event goes only when `eventOk(m)` says so at that moment: the
// channel said at hello that it handles events (`capabilities: ["events"]`, Ultron's
// L4: an older channel acks a line type it doesn't know, which would swallow it), the
// kill switch is off, it was not made while the switch was on, it is under 2 h old and
// its alert is still live. One that fails any of these is skipped, failing closed, and
// marked `undelivered` in the store so the page says so (Ultron's L3). Its line carries the template's words and typed fields,
// never an alert key or a label beyond what the words say (README, "Events").
export function toInbound(m, { eventOk = () => false, stopOk = () => false } = {}) {
  if (m.kind === 'event') {
    if (m.from !== 'system' || !eventOk(m)) return null;
    const ev = m.meta?.event ?? {};
    return { type: 'event', seq: m.seq, id: m.id, at: m.at, source: typeof ev.source === 'string' ? ev.source : 'unknown', event: typeof ev.type === 'string' ? ev.type : 'unknown', text: m.text, count: Number.isInteger(ev.count) ? ev.count : 1, ids: [m.id] };
  }
  // A stop request (lib/agent-stop.mjs): only from the owner's side, only typed fields,
  // never text. The channel builds its own fixed words from them (C1).
  if (m.kind === 'stop') {
    const st = m.meta?.stop;
    if (m.from !== 'jeff' || !isStopMeta(st) || !stopOk(m)) return null;
    return { type: 'stop', seq: m.seq, id: m.id, at: m.at, row: st.row, agent: st.agent, start: st.start };
  }
  if (m.from === 'jeff' && m.kind === 'chat') {
    return { type: 'message', seq: m.seq, id: m.id, at: m.at, text: m.text, replyTo: m.replyTo ?? null, device: m.device ?? null, attachments: (m.attachments ?? []).map(a => ({ id: a.id, name: a.name, type: a.type, bytes: a.bytes })) };
  }
  // A verdict only from the owner's side and naming its request (L8): the store makes
  // them from a device's tap alone, and anything else in the store is never one.
  if (m.kind === 'verdict') {
    const behavior = m.meta?.behavior;
    if (m.from !== 'jeff' || typeof m.meta?.requestId !== 'string' || (behavior !== 'allow' && behavior !== 'deny')) return null;
    return { type: 'verdict', seq: m.seq, requestId: m.meta.requestId, behavior, answeredAt: Number.isSafeInteger(m.meta.answeredAt) ? m.meta.answeredAt : null, device: m.device ?? null };
  }
  return null;
}
// The fields a stop carries, each in the one shape the channel accepts.
export const STOP_ROW_RE = /^[a-f0-9]{16}$/;
export const STOP_AGENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
export function isStopMeta(st) {
  return isObject(st) && typeof st.row === 'string' && STOP_ROW_RE.test(st.row) && typeof st.agent === 'string' && STOP_AGENT_RE.test(st.agent) && Number.isSafeInteger(st.start) && st.start > 0;
}
// The name the tests and older callers know.
export const inboundEvent = toInbound;

// The events a replay found waiting, as one line: a single one as itself, several as a
// `summary` whose seq and id are the last one's (so an ack covers them all and seq
// order holds) and whose `ids` name every one, for a reply's replyTo.
export const SUMMARY_LIST_MAX = 10;
export function summaryLine(events) {
  if (events.length === 1) return events[0];
  const last = events[events.length - 1];
  const sources = [...new Set(events.map(e => e.source))];
  const shown = events.slice(0, SUMMARY_LIST_MAX).map(e => e.text);
  const more = events.length - shown.length;
  const text = `${events.length} events while the channel was away: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
  return { type: 'event', seq: last.seq, id: last.id, at: last.at, source: sources.length === 1 ? sources[0] : 'mixed', event: 'summary', text, count: events.reduce((n, e) => n + (e.count ?? 1), 0), ids: events.map(e => e.id) };
}

// `events` (lib/events.mjs) decides whether a stored event may go now; without it no
// event is ever delivered.
export function createSocketRouter({
  store, events = null, now = () => Date.now(), onEvent = () => {}, log = console.log, pingMs = INBOUND_PING_MS, inboundBufferMax = INBOUND_BUFFER_MAX,
  // The approvals gate (lib/approvals.mjs); without one, permission requests are refused.
  approvals = null,
  verifyRestart = async () => ({ ok: false, reason: 'no verifier' }),
  // Check every hello without the current token, not only after a bye (set once
  // config's chat.channelServer is).
  verifyEveryHello = false,
  byeSilenceMs = BYE_SILENCE_MS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = t => clearTimeout(t)
}) {
  const eventOk = m => Boolean(events?.deliverable(m, now()));
  // { pid, version, startedAt, helloAt, lastHeartbeatAt, token, sentSeq, streamClosedAt }
  // sentSeq: how far this session's inbound streams have gone (every seq up to it was
  // written to one, or lay at or below the `after` the channel asked from), the most
  // an ack may move the cursor to. streamClosedAt: when its inbound stream closed by
  // itself (the channel's end), null while one is open or none was ever opened.
  let client = null;
  let inbound = null;  // { res, stop }
  let byeAt = null;    // when the last client said bye, until the next hello
  let byePid = null;   // the pid that said it
  let silenceTimer = null;
  let helloLock = Promise.resolve();
  const oneAtATime = fn => { const next = helloLock.then(fn, fn); helloLock = next.catch(() => {}); return next; };
  const fresh = at => {
    if (client === null) return false;
    const age = at - client.lastHeartbeatAt;
    if (age >= HEARTBEAT_FRESH_MS) return false;
    return !(client.streamClosedAt !== null && age >= HEARTBEAT_MISSED_MS);
  };
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
        return await oneAtATime(() => hello(req, res, body));
      }
      return await rest(req, res, url, path);
    } catch (err) {
      return fail(res, path, err);
    }
  }

  function fail(res, path, err) {
    const code = err instanceof HttpError ? err.status : 500;
    if (code === 500) console.error('chat socket error', path, err);
    if (res.headersSent) return res.end();
    return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
  }

  async function hello(req, res, body) {
    {
      {
        const pid = Number.isInteger(body.pid) ? body.pid : null;
        const at = now();
        const holder = holds(req);
        if (client && !holder && fresh(at)) {
          onEvent({ kind: 'client-refused', pid, current: client.pid });
          throw new HttpError(409, 'another channel is connected and its heartbeat is fresh');
        }
        // After a bye the place is free, and whoever says hello must prove to be the
        // released channel under the lead's launch, started since the bye and not the
        // process that said it; with verifyEveryHello, every hello without the token is
        // checked the same way (less the start time). Anything less is refused and alerted.
        const afterBye = !client && byeAt !== null;
        if (!holder && (afterBye || verifyEveryHello)) {
          let verdict;
          if (afterBye && pid !== null && pid === byePid) verdict = { ok: false, reason: 'the pid that said bye' };
          else {
            try { verdict = await verifyRestart(pid, { notBefore: afterBye ? byeAt - BYE_START_SLACK_MS : null }); } catch { verdict = { ok: false, reason: 'the check failed' }; }
          }
          if (!verdict?.ok) {
            const reason = verdict?.reason ?? 'the check failed';
            log(`chat: a hello${afterBye ? ' after the bye' : ''} was refused: ${reason} (pid ${pid})`);
            onEvent({ kind: 'client-replaced', pid, previous: null, staleFor: 0, unverified: reason });
            throw new HttpError(409, 'a hello must come from the released channel; this one could not be verified');
          }
        }
        if (client && !holder) {
          const staleFor = at - client.lastHeartbeatAt;
          log(`chat: the channel was replaced after a stale heartbeat (pid ${client.pid} to ${pid}, ${Math.round(staleFor / 1000)} s stale)`);
          onEvent({ kind: 'client-replaced', pid, previous: client.pid, staleFor });
        } else if (client) {
          log('chat: the channel said hello again');
        }
        // startedAt is the channel process's start in epoch milliseconds (kept, not served).
        // `capabilities`: what this channel handles beyond messages and verdicts; only
        // `events` means anything yet. Absent or malformed, it handles none.
        const events = Array.isArray(body.capabilities) && body.capabilities.includes(EVENTS_CAPABILITY);
        const stops = Array.isArray(body.capabilities) && body.capabilities.includes(STOP_CAPABILITY);
        client = { pid, version: typeof body.version === 'string' ? body.version.slice(0, 40) : null, startedAt: Number.isFinite(body.startedAt) ? body.startedAt : null, helloAt: at, lastHeartbeatAt: at, token: newToken(), sentSeq: store.deliveredSeq, streamClosedAt: null, events, stops };
        const { token } = client;
        endInbound(holder ? 'superseded' : 'replaced');
        // A new channel process: the requests the old one relayed can't be answered
        // through this one (L7). The holder's own re-hello keeps them.
        if (!holder) store.newPermissionSession?.();
        // How long the channel holds a relayed request before it forgets it (board
        // 94b380fd): the page answers for that long, less a minute, at most 12 hours;
        // a channel that doesn't say (0.4.6 and older) gets the old 10 minutes.
        store.noteChannelAlive?.(at);
        const windowMs = store.setPermissionHold?.(body.permHoldMs);
        if (approvals && Number.isFinite(windowMs)) log(`chat: the page can answer a permission request for ${Math.round(windowMs / 60e3)} min (${Number.isSafeInteger(body.permHoldMs) && body.permHoldMs > 0 ? 'the channel holds one that long, less a minute' : 'the channel does not say how long it holds one'})`);
        // What the channel says its permission relay does (off, deny or allow); one
        // that doesn't say counts as unknown, and the page then offers Deny only.
        const relay = approvals?.noteChannelRelay?.(body.relay) ?? null;
        if (relay !== null && approvals.serverMode?.() !== 'off') log(`chat: the channel's permission relay is ${relay}`);
        // Whether it runs under its test switch (channel 0.4.6 says; an older one
        // sends nothing): one that does is offered Deny only, and reported.
        approvals?.noteChannelTest?.(body.test);
        // A hello with no word on its test switch is a channel older than 0.4.6. It is
        // still treated as not in test mode (Allow stays possible), so each one is
        // logged: the log shows whether any older channel still says hello before
        // the server stops trusting the silence (board 762bb28d).
        if (approvals && body.test === undefined) log(`chat: the channel's hello has no test field (a channel older than 0.4.6, ${logVersion(body.version)}, pid ${pid ?? 'not given'}): treated as not in test mode, so Allow is not capped for it`);
        if (silenceTimer !== null) { clearTimer(silenceTimer); silenceTimer = null; }
        if (byeAt !== null) {
          // A bye, then a fresh hello: a restart. Logged and noted in the chat, never pushed.
          const gap = Math.max(0, at - byeAt);
          byeAt = null;
          log(`chat: the channel is back ${(gap / 1000).toFixed(1)} s after its bye${gap < QUICK_RESTART_MS ? ' (a quick restart, under 5 s)' : ''}`);
          try {
            await store.append({ from: 'system', kind: 'notice', text: restartNotice(at), meta: { event: 'channel-restarted', gapMs: gap } });
          } catch (err) { log(`chat: the restart notice was not recorded (${err?.message ?? err})`); }
        }
        return json(res, 200, { cursor: store.deliveredSeq, epoch: store.epoch, seq: store.seq, token });
      }
    }
  }

  async function rest(req, res, url, path) {
    {
      if (req.method === 'GET' && path === '/v1/status') return json(res, 200, { ...status(), seq: store.seq, epoch: store.epoch, deliveredSeq: store.deliveredSeq });
      // Everything from here on is the current client's alone.
      requireHolder(req);
      // Any request from the holder shows its channel is alive (heartbeats come every 15 s).
      store.noteChannelAlive?.(now());
      if (req.method === 'POST' && path === '/v1/bye') {
        // A clean exit (stdin EOF): the place is free now, not in 45 s. Logged, not alerted.
        byePid = client.pid;
        client = null;
        byeAt = now();
        endInbound('bye');
        log('chat: the channel said bye');
        // Its session has ended, and the requests it relayed with it: their cards end.
        store.newPermissionSession?.();
        // No hello within 2 minutes: the lead's session has lost the chat. Alerted once.
        if (silenceTimer !== null) clearTimer(silenceTimer);
        const since = byeAt;
        silenceTimer = setTimer(() => {
          silenceTimer = null;
          if (client === null && byeAt === since) {
            log(`chat: no hello in ${Math.round(byeSilenceMs / 1000)} s since the channel's bye`);
            onEvent({ kind: 'channel-silent', after: byeSilenceMs });
          }
        }, byeSilenceMs);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/v1/heartbeat') {
        client.lastHeartbeatAt = now();
        // A heartbeat may carry the relay mode too, so a flag removed while the
        // channel runs reaches the page within one beat. One without it changes nothing.
        let beat = null;
        try { beat = await readBody(req); } catch { beat = null; }
        if (isObject(beat) && 'relay' in beat) approvals?.noteChannelRelay?.(beat.relay);
        return json(res, 200, { ok: true, openPermissions: store.openPermissions().length });
      }
      if (req.method === 'GET' && path === '/v1/inbound') {
        const asked = Number.parseInt(url.searchParams.get('after') ?? '', 10);
        // A stream the holder already has is its own: superseded, not replaced.
        endInbound('superseded');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const session = client;
        session.streamClosedAt = null;
        let closed = false;
        let timer = null;
        let unsubscribe = () => {};
        let wake = null;  // ends a replay's wait for 'drain'
        const stop = () => { closed = true; clearInterval(timer); unsubscribe(); wake?.(); };
        const entry = { res, stop };
        inbound = entry;
        // The holder stopped reading: cut the stream rather than buffer without limit.
        const cut = () => {
          const unsent = res.writableLength;
          if (inbound === entry) inbound = null;
          stop();
          log(`chat: the inbound stream was cut with ${unsent} bytes unsent (the cap is ${inboundBufferMax}): the channel is not reading; it reconnects from its cursor`);
          res.destroy();
        };
        // false when the buffer is full (wait for 'drain' before more) or the stream is gone.
        const send = ev => {
          if (closed) return false;
          let ok;
          try { ok = res.write(JSON.stringify(ev) + '\n'); } catch { return false; }
          if (res.writableLength > inboundBufferMax) { cut(); return false; }
          return ok;
        };
        const drained = () => new Promise(resolve => {
          if (closed) return resolve();
          const go = () => { res.off('drain', go); wake = null; resolve(); };
          wake = go;
          res.on('drain', go);
        });
        // `after` is the channel's word that it has everything up to it; past the
        // store's last seq it can claim nothing.
        let done = Math.min(Number.isInteger(asked) && asked >= 0 ? asked : store.deliveredSeq, store.seq);
        if (done > session.sentSeq) session.sentSeq = done;
        // Each message once, in seq order: what this stream has gone past is skipped.
        // While the stream catches up (the replay, and what arrived during it), events
        // wait in `gathered` and go as one summary line just before the next other
        // line, or at the end of the catch-up, so seq order holds on the wire.
        let catchingUp = true;
        let gathered = [];
        const flushGathered = () => {
          if (gathered.length === 0) return true;
          const line = summaryLine(gathered);
          gathered = [];
          return send(line);
        };
        const sessionEventOk = x => session.events === true && eventOk(x);
        const sessionStopOk = x => session.stops === true && now() - x.at <= STOP_DELIVER_MS;
        // An event or a stop this stream passes over unsent: marked so the page shows it (never
        // an owner's chat or a lead's message; never one already `off`).
        const skipped = m => {
          const ours = (m.kind === 'event' && m.from === 'system') || (m.kind === 'stop' && m.from === 'jeff');
          if (!ours || m.state === 'off' || m.state === UNDELIVERED) return;
          store.setState?.(m.id, UNDELIVERED)?.catch?.(err => log(`chat: an event's undelivered mark failed (${err?.message ?? err})`));
        };
        const deliver = m => {
          if (m.seq <= done) return true;
          done = m.seq;
          const ev = toInbound(m, { eventOk: sessionEventOk, stopOk: sessionStopOk });
          if (!ev) skipped(m);
          let ok = true;
          if (ev?.type === 'event' && catchingUp) gathered.push(ev);
          else if (ev) { ok = flushGathered(); ok = send(ev) && ok; }
          if (done > session.sentSeq) session.sentSeq = done;
          return ok;
        };
        req.on('close', () => {
          if (inbound !== entry) return;
          inbound = null;
          stop();
          // The channel's end closed it: if heartbeats stop too, the process is gone.
          // (After a bye or a new hello, `session` is no longer the client: harmless.)
          session.streamClosedAt = now();
        });
        // Live messages are listened for before the replay starts and held until it
        // ends, so none falls between the two; the seq check drops the overlap.
        let held = [];
        unsubscribe = store.subscribe(event => {
          if (event.type !== 'message') return;
          if (held) held.push(event.message);
          else deliver(event.message);
        });
        // The whole backlog, a page at a time, until the store has nothing after it,
        // waiting for 'drain' whenever the buffer fills.
        for (;;) {
          const page = store.list({ after: done, limit: REPLAY_PAGE });
          if (page.length === 0) break;
          for (const m of page) {
            if (closed) return undefined;
            if (!deliver(m)) await drained();
          }
        }
        if (closed) return undefined;
        const waiting = held;
        held = null;
        for (const m of waiting) deliver(m);
        catchingUp = false;
        if (!flushGathered() && !closed) await drained();
        if (closed) return undefined;
        timer = setInterval(() => send({ type: 'ping' }), pingMs);
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
        // Only as far as this session's streams have sent: a seq never written to the
        // channel is never marked delivered, whatever the ack says.
        const upTo = Math.min(body.seq, client.sentSeq);
        if (upTo < body.seq) log(`chat: an ack for seq ${body.seq} moved the cursor only to ${upTo}, as far as was sent`);
        return json(res, 200, { deliveredSeq: await store.ack(upTo), epoch: store.epoch });
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
        // Approvals off (config, or the kill file): refused, which the channel takes as
        // final, so the prompt stays in the terminal and Discord only.
        if (!approvals || approvals.mode() === 'off') throw new HttpError(403, 'approvals are off on this server');
        const body = await readBody(req, 512 * 1024);
        if (!isObject(body)) throw new HttpError(400, 'the body must be an object');
        let p;
        try {
          p = await store.openPermission(
            { requestId: body.requestId, tool: body.tool, description: body.description, inputPreview: body.inputPreview, relayedAt: body.relayedAt ?? null, cut: body.cut === true },
            { assess: q => approvals.assess(q) }
          );
        } catch (err) { throw new HttpError(400, err.message); }
        approvals.noteOpenCount?.(store.openPermissions().length);
        onEvent({ kind: 'permission-opened', requestId: p.requestId, tool: p.tool, state: p.state });
        return json(res, 200, { requestId: p.requestId, state: p.state, openedAt: p.openedAt });
      }
      return json(res, 404, { error: 'not found' });
    }
  }

  // Whether a stop can go now: a fresh channel that said at hello it takes stops.
  const stopsOk = () => fresh(now()) && client?.stops === true;
  return { handler, status, stopsOk, isAttachmentId };
}
