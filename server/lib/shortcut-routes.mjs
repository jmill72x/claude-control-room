// The Shortcut routes (docs/design/2026-11-12-jarvis-os-shortcuts.md): how an iPhone
// Shortcut sends into the chat. Two sides, one router, all under `/api/shortcut/`:
//
// - **The Shortcut's side** takes no cookie and refuses a browser outright (any
//   `Origin` or `Sec-Fetch-Site` header: a Shortcut sends neither, a page always
//   does). `pair` trades the one-time code for the key; `send` and `event` take the
//   key (`Authorization: Bearer`, lib/shortcut-keys.mjs).
// - **The page's side** takes a paired device's cookie, like the chat: make the code
//   for a new key, list the keys, revoke one.
//
// Every route also needs the owner's tailnet login from the proxy, as the chat does.
//
// What a key can do, and nothing else:
// - `send`: one chat message from the owner, appended to the same store by the same
//   call the page's route makes (`from: jeff`, `kind: chat`, `state: queued`), so the
//   channel gets it down the same stream. Its `device` is the key's name with
//   "(Shortcut…)", which the channel shows the lead. It carries no reply target and no
//   uploads. **What the owner typed or dictated (`text`) is the message; what he shared
//   (`shared`) is outside content:** a single short http(s) link to a public host name
//   goes in the text as `URL` rebuilt it, under the fixed line "Shared link, outside
//   content:"; any other shared text (a long link, one to an address or to this machine
//   included) becomes a `text/plain` attachment, which the channel already marks as
//   data (`attachments_are_data`), never as his words.
// - `event`: a presence report by name (`arrived-home`). No text travels: the words
//   are a template's (lib/events.mjs), it reaches the lead as an event (data, from
//   `system`, never the owner), and the event caps and kill switch apply.
//
// Limits per key, in memory: 20 messages in 10 minutes and 100 a day; the same message
// again within 15 s is answered as the first (a retry never doubles it); the same
// presence report within 10 minutes is a duplicate; 6 reports a day. Each is counted
// in the same step as its check, before anything awaits, so requests in flight
// together can't all pass; a send that then fails gives its count back. A key over a
// limit, and a run of refused pairing tries, are reported (rate-limited), not logged
// line by line. A key that made no message and no report for 30 days has expired
// (lib/shortcut-keys.mjs): it is refused like one that is not paired, in words that say
// so, and reported once a day while it keeps being tried. Only a message or a report
// that was made counts as a use (`keys.used`): a refused request, or a repeat answered
// as the first, never keeps a key alive. Every answer has
// a `say` line the Shortcut can show or speak as it is. Nothing here logs or echoes a
// message's text. A kill file (`~/.local/state/jarvis-os/shortcuts-off`) refuses every
// Shortcut-side route and new codes at once; listing and revoking still work.
import { createHash } from 'node:crypto';
import { json, readBody, guardWrite, guardDelete, HttpError } from '../routes.mjs';
import { isClientId, MAX_PAGE_TEXT } from './chat-store.mjs';
import { PRESENCE_EVENTS } from './events.mjs';
import { proxyAddress, KEY_IDLE_DAYS } from './shortcut-keys.mjs';
import { oneLine } from './chat-events.mjs';

const MIN = 60e3, DAY = 24 * 3600e3;
export const SHARED_MAX = 100000;
// A shared link longer than this is attached like other shared text, never inline.
export const LINK_INLINE_MAX = 300;
// 100,000 characters of shared text as JSON, with room for escapes.
export const SEND_BODY_MAX = 768 * 1024;
export const SMALL_BODY_MAX = 2048;
export const SENDS_PER_WINDOW = 20;
export const SEND_WINDOW_MS = 10 * MIN;
export const SENDS_PER_DAY = 100;
export const DUPLICATE_MS = 15e3;
export const EVENT_DEBOUNCE_MS = 10 * MIN;
// Few on purpose: every event counts toward the 30 a day all sources share
// (lib/events.mjs), and a job's failure must never be the one held back.
export const EVENTS_PER_DAY = 6;
// Wrong or missing keys in 10 minutes before it is reported (once per window).
export const REFUSALS_REPORTED_AT = 5;
export const CLIENT_ID_MAX = 60;
// How a send says where it came from, and what the message's device then reads.
export const VIAS = Object.freeze({ share: ' (Shortcut, share)', siri: ' (Shortcut, Siri)' });
const VIA_NONE = ' (Shortcut)';
const SEND_FIELDS = new Set(['text', 'shared', 'via', 'clientId']);
const SHORTCUT_SIDE = new Set(['/api/shortcut/pair', '/api/shortcut/send', '/api/shortcut/event']);
const SHARED_NAME = 'shared-text.txt';
export const SHARED_WORDS = 'Shared from the share sheet: the text is attached.';
// The fixed line over a shared link in a message's text: the link is not his words.
export const SHARED_LINK_WORDS = 'Shared link, outside content:';
const NO_STORE = { 'Cache-Control': 'no-store' };
// What the Setup Shortcut shows when its code is refused.
const PAIR_SAY = Object.freeze({
  400: 'Wrong code. Check the code in Jarvis OS and run Setup again.',
  404: 'No code is waiting. In Jarvis OS open Chat, the dots, Shortcut keys, and make a new one.',
  409: 'Jarvis OS has too many Shortcut keys. Revoke one and run Setup again.',
  429: 'Too many wrong codes. Make a new code in Jarvis OS.'
});
const NUL = String.fromCharCode(0);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A refusal the Shortcut can show or speak: `say` rides beside `error`.
class Refusal extends HttpError {
  constructor(status, message, say) { super(status, message); this.say = say; }
}

// What config says: on only with `chat.shortcuts: true` (the chat itself must be on;
// server.mjs checks that). Anything else but absent or false is a problem, and off.
export function readShortcutsConfig(config) {
  const raw = config?.chat?.shortcuts;
  if (raw === undefined || raw === null || raw === false) return { on: false, problems: [] };
  if (raw === true) return { on: true, problems: [] };
  return { on: false, problems: ['chat.shortcuts must be true or false; Shortcut keys stay off'] };
}

// A shared value that is one short http(s) link to a public host name and nothing
// else, as `URL` rebuilt it; else null, and the caller attaches it as text like any
// other shared content (Ultron's M3). Short: at most LINK_INLINE_MAX characters as
// rebuilt (percent-escapes counted), so a link can't carry a paragraph. Public: a DNS name with a dot whose last label is
// letters (so no IPv4 or IPv6 literal, in any spelling `URL` folds to one) and is not a
// name for this machine or a private network. No white space, no credentials.
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|invalid|onion)$/;
export function publicHostName(hostname) {
  const h = typeof hostname === 'string' ? hostname.toLowerCase().replace(/\.$/, '') : '';
  if (h === '' || h.length > 253) return false;
  // Plain labels only, which a bracketed IPv6 literal never is.
  const labels = h.split('.');
  if (labels.length < 2 || labels.some(l => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  // A lettered last label, which no IPv4 address has (`URL` folds every spelling of one,
  // hex and single-number forms too, to four numbers).
  const tld = labels.at(-1);
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(tld)) return false;
  return !PRIVATE_SUFFIX.test(h);
}
export function sharedLink(shared) {
  const s = typeof shared === 'string' ? shared.trim() : '';
  if (s === '' || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!publicHostName(u.hostname)) return null;
  return u.href.length <= LINK_INLINE_MAX ? u.href : null;
}

// What a send's body must be: `{ text?, shared?, via?, clientId? }` and nothing else,
// with something to say in `text` or `shared`.
export function checkSend(body) {
  if (!isObject(body)) return { ok: false, error: 'the body must be an object' };
  for (const k of Object.keys(body)) if (!SEND_FIELDS.has(k)) return { ok: false, error: 'the body may hold only text, shared, via and clientId' };
  const text = body.text ?? '';
  const shared = body.shared ?? '';
  if (typeof text !== 'string' || text.length > MAX_PAGE_TEXT) return { ok: false, error: `text must be a string of at most ${MAX_PAGE_TEXT} characters` };
  if (typeof shared !== 'string' || shared.length > SHARED_MAX) return { ok: false, error: `shared must be a string of at most ${SHARED_MAX} characters` };
  const via = body.via ?? null;
  if (via !== null && (typeof via !== 'string' || !Object.hasOwn(VIAS, via))) return { ok: false, error: `via must be one of ${Object.keys(VIAS).join(', ')}` };
  const clientId = body.clientId ?? null;
  if (clientId !== null && (!isClientId(clientId) || clientId.length > CLIENT_ID_MAX)) return { ok: false, error: `clientId must be an id of at most ${CLIENT_ID_MAX} characters` };
  if (text.trim() === '' && shared.trim() === '') return { ok: false, error: 'a message needs text or something shared' };
  return { ok: true, text: text.trim(), shared: shared.trim(), via, clientId };
}

export function createShortcutRoutes({
  keys, devices, store, events = null, socket = null, login = null,
  now = () => Date.now(), log: logLine = console.log, onEvent = () => {}, killed = () => false
}) {
  // A key's name is cleaned when it pairs; one read back from the file was not.
  const log = line => logLine(oneLine(line));
  const owner = typeof login === 'string' && login.trim() ? login.trim().toLowerCase() : null;
  const sends = new Map();     // key id -> times of its sends in the last day
  const reports = new Map();   // key id -> times of its presence reports in the last day
  const lastSend = new Map();  // key id -> { hash, at, done: resolves to { id, seq } or null }
  const lastReport = new Map(); // `${key id}:${event}` -> when
  const overAt = new Map();    // `${key id}:${limit}` -> when it was last reported
  const expiredAt = new Map(); // key id -> when its use after expiry was last reported
  let refusals = { start: 0, n: 0 };
  let pairRefusals = { start: 0, n: 0 };

  function requireLogin(req) {
    if (owner === null) return;
    const seen = req.headers?.['tailscale-user-login'];
    if (typeof seen !== 'string' || seen.trim().toLowerCase() !== owner) throw new Refusal(403, 'the request did not come as the owner through the tailnet', 'Jarvis OS refused this: it did not come through the tailnet as the owner.');
  }
  function requireDevice(req) {
    requireLogin(req);
    const device = devices?.authenticate(req.headers?.cookie);
    if (!device) throw new HttpError(401, 'this device is not paired');
    return device;
  }
  // The Shortcut's side: never a browser, JSON only, the owner's login, not switched off.
  function requireShortcutCaller(req) {
    if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) throw new Refusal(403, 'this route is for a Shortcut, never a page', 'Jarvis OS refused this: the route is for a Shortcut.');
    guardWrite(req);
    requireLogin(req);
    if (killed()) throw new Refusal(503, 'Shortcut keys are switched off on the server', 'Shortcuts are switched off in Jarvis OS for now.');
  }
  // The key behind a request, or a 401. Wrong keys are counted, and the fifth in 10
  // minutes is reported once. An expired key is a 401 of its own: the answer says to
  // pair again, and it is reported once a day per key however often it is tried (an
  // automation shows nothing on the phone, so the report is how its owner hears).
  function requireKey(req) {
    const { key, expired } = keys.check(req.headers?.authorization, { addr: proxyAddress(req.headers) });
    if (key) return key;
    const at = now();
    if (expired) {
      const last = expiredAt.get(expired.id);
      if (last === undefined || at - last >= DAY) {
        expiredAt.set(expired.id, at);
        onEvent({ kind: 'shortcut-expired', key: { id: expired.id, name: expired.name }, days: KEY_IDLE_DAYS });
      }
      throw new Refusal(401, `this Shortcut key expired after ${KEY_IDLE_DAYS} days without use`, `This Shortcut is not paired with Jarvis OS any more: its key expired after ${KEY_IDLE_DAYS} days without use. Make a new code in Jarvis OS and run the Jarvis Setup Shortcut.`);
    }
    if (at - refusals.start >= SEND_WINDOW_MS) refusals = { start: at, n: 0 };
    refusals.n++;
    if (refusals.n === REFUSALS_REPORTED_AT) onEvent({ kind: 'shortcut-refused', count: refusals.n });
    throw new Refusal(401, 'this Shortcut is not paired', 'This Shortcut is not paired with Jarvis OS. Run the Jarvis Setup Shortcut.');
  }
  // The times a key acted in the last day: one array per key, pruned in place, so
  // every request in flight sees, and adds to, the same one (Ultron's M2: a new array
  // each call let requests in flight together count on copies).
  const recent = (map, id, at) => {
    let times = map.get(id);
    if (!times) { times = []; map.set(id, times); }
    let old = 0;
    while (old < times.length && at - times[old] >= DAY) old++;
    if (old > 0) times.splice(0, old);
    return times;
  };
  const takeBack = (times, at) => { const i = times.lastIndexOf(at); if (i >= 0) times.splice(i, 1); };
  const online = () => socket?.status?.().channelConnected === true;
  // A key over a limit is reported once per key and limit in 10 minutes, however often
  // it is refused: the event is the log line, and the alert kind is rate-limited too.
  function overLimit(key, what, at) {
    const mark = `${key.id}:${what}`;
    const last = overAt.get(mark);
    if (last !== undefined && at - last < SEND_WINDOW_MS) return;
    overAt.set(mark, at);
    onEvent({ kind: 'shortcut-over-limit', key: { id: key.id, name: key.name }, what });
  }
  // A refused pairing try (a wrong code, or none waiting): the first in 10 minutes is
  // logged, the fifth reported, the rest only counted.
  function pairRefused(status) {
    const at = now();
    if (at - pairRefusals.start >= SEND_WINDOW_MS) pairRefusals = { start: at, n: 0 };
    pairRefusals.n++;
    if (pairRefusals.n === 1) log(`shortcut: a pairing try was refused (${status}); more in the next 10 minutes are counted, not logged`);
    if (pairRefusals.n === REFUSALS_REPORTED_AT) onEvent({ kind: 'shortcut-pair-refused', count: pairRefusals.n });
  }

  async function send(req, res) {
    requireShortcutCaller(req);
    const key = requireKey(req);
    const checked = checkSend(await readBody(req, SEND_BODY_MAX));
    if (!checked.ok) throw new Refusal(400, checked.error, 'Jarvis OS could not read that message.');
    const { text, shared, via } = checked;
    const label = `${key.name}${via ? VIAS[via] : VIA_NONE}`;
    const duplicate = m => json(res, 200, { ok: true, id: m.id, seq: m.seq, duplicate: true, online: online(), say: 'Already sent to Jarvis.' }, NO_STORE);
    // A given clientId is the key's own: it can never name a page's message.
    const clientId = checked.clientId ? `sc.${key.id}.${checked.clientId}` : null;
    const had = clientId ? store.byClientId(clientId) : null;
    if (had) return duplicate(had);
    // The same words again within 15 s: a retry, answered as the first, also while the
    // first is still being written (it waits for it).
    const hash = createHash('sha256').update(JSON.stringify([via, text, shared])).digest('hex');
    const last = lastSend.get(key.id);
    if (last && last.hash === hash && now() - last.at < DUPLICATE_MS) {
      const first = await last.done;
      if (first) return duplicate(first);
      // The first try failed, so this one stands on its own.
    }
    // From here to `sent.push` nothing awaits: the check and the count are one step,
    // so sends in flight together can't all pass the check before any is counted.
    const at = now();
    const sent = recent(sends, key.id, at);
    if (sent.length >= SENDS_PER_DAY || sent.filter(t => at - t < SEND_WINDOW_MS).length >= SENDS_PER_WINDOW) {
      overLimit(key, 'message', at);
      throw new Refusal(429, `a Shortcut key sends at most ${SENDS_PER_WINDOW} messages in 10 minutes and ${SENDS_PER_DAY} a day`, 'Too many messages from this Shortcut. Use the Jarvis OS app for now.');
    }
    sent.push(at);
    let settle;
    const mine = { hash, at, done: new Promise(resolve => { settle = resolve; }) };
    lastSend.set(key.id, mine);
    // What he shared: a short public link in the text under a fixed line, anything else
    // a text file (data to the lead).
    const link = sharedLink(shared);
    const attachments = [];
    let body = text;
    let what = 'text';
    let m = null;
    try {
      if (link) {
        body = `${text ? `${text}\n\n` : ''}${SHARED_LINK_WORDS}\n${link}`;
        what = 'a link';
      } else if (shared !== '') {
        // `textOnly`: the words decide nothing about the file's type. Text that begins
        // like a PDF or a picture is still kept, and served, as text/plain (Ultron's L5).
        try { attachments.push(await store.putAttachment({ name: SHARED_NAME, type: 'text/plain', data: Buffer.from(shared.replaceAll(NUL, ''), 'utf8'), textOnly: true })); } catch (err) { throw new Refusal(err.status ?? 400, 'the shared text could not be kept', 'Jarvis OS could not keep the shared text.'); }
        body = text || SHARED_WORDS;
        what = 'shared text, attached';
      }
      m = await store.append({ from: 'jeff', kind: 'chat', text: body, replyTo: null, device: label, clientId, attachments, state: 'queued', meta: { shortcut: { key: key.id, via: via ?? 'shortcut' } } });
    } catch (err) {
      // Not sent: the count goes back, and so does the file. The retry mark needs no
      // undoing: it resolves to nothing below, and a send that finds it goes on alone.
      takeBack(sent, at);
      for (const a of attachments) await store.removeAttachment(a.id);
      throw err;
    } finally {
      settle(m ? { id: m.id, seq: m.seq } : null);
    }
    // The store answered with an earlier message of this clientId (two of them in
    // flight together): this one made nothing, so its file and its count go back.
    if (attachments.length > 0 && !m.attachments.some(a => a.id === attachments[0].id)) {
      takeBack(sent, at);
      for (const a of attachments) await store.removeAttachment(a.id);
      return duplicate(m);
    }
    // A message was made: that is a use, and the key's idle clock starts again.
    keys.used(key.id);
    log(`shortcut: ${label} sent a message (${what})`);
    const up = online();
    return json(res, 200, { ok: true, id: m.id, seq: m.seq, online: up, say: up ? 'Sent to Jarvis. His answer comes to Jarvis OS.' : 'Sent. Jarvis is offline now; he gets it when he is back.' }, NO_STORE);
  }

  async function event(req, res) {
    requireShortcutCaller(req);
    const key = requireKey(req);
    const body = await readBody(req, SMALL_BODY_MAX);
    if (!isObject(body) || Object.keys(body).some(k => k !== 'event') || typeof body.event !== 'string' || !Object.hasOwn(PRESENCE_EVENTS, body.event)) {
      throw new Refusal(400, `the body must be {"event": …} with one of ${Object.keys(PRESENCE_EVENTS).join(', ')}`, 'Jarvis OS does not know that event.');
    }
    if (!events) throw new Refusal(503, 'events are off on the server', 'Events are off in Jarvis OS.');
    const at = now();
    const words = PRESENCE_EVENTS[body.event];
    const mark = `${key.id}:${body.event}`;
    const before = lastReport.get(mark);
    // A geofence flaps: the same report again within 10 minutes is the first one.
    if (before !== undefined && at - before < EVENT_DEBOUNCE_MS) return json(res, 200, { ok: true, status: 'duplicate', say: `Already noted: ${words}.` }, NO_STORE);
    const made = recent(reports, key.id, at);
    if (made.length >= EVENTS_PER_DAY) {
      overLimit(key, 'presence', at);
      throw new Refusal(429, `a Shortcut key reports at most ${EVENTS_PER_DAY} presence events a day`, 'Too many reports from this Shortcut today.');
    }
    // Counted and marked before the first await, like a send: reports in flight
    // together find the mark and are duplicates.
    made.push(at);
    lastReport.set(mark, at);
    let r;
    try {
      r = await events.presence({ what: body.event, subject: key.name });
    } catch (err) {
      // Not made: the count and the mark go back. An earlier mark needs no restoring:
      // this report got past it, so it had run out.
      takeBack(made, at);
      if (lastReport.get(mark) === at) lastReport.delete(mark);
      throw err;
    }
    // The report was taken: a use, like a message.
    keys.used(key.id);
    log(`shortcut: ${key.name} reported ${body.event} (${r.status})`);
    return json(res, 200, { ok: true, status: r.status, say: `Noted: ${words}.` }, NO_STORE);
  }

  async function handler(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      // ---- the Shortcut's side ----
      if (req.method === 'POST' && path === '/api/shortcut/pair') {
        requireShortcutCaller(req);
        const body = await readBody(req, SMALL_BODY_MAX);
        const r = await keys.claim(isObject(body) ? body.code : null, { addr: proxyAddress(req.headers) });
        if (!r.ok) {
          pairRefused(r.status);
          throw new Refusal(r.status, r.error, PAIR_SAY[r.status] ?? 'Jarvis OS could not pair this Shortcut.');
        }
        log(`shortcut: a Shortcut collected its key (${r.name})`);
        return json(res, 200, { key: r.key, name: r.name, say: 'Paired with Jarvis OS.' }, NO_STORE);
      }
      if (req.method === 'POST' && path === '/api/shortcut/send') return await send(req, res);
      if (req.method === 'POST' && path === '/api/shortcut/event') return await event(req, res);

      // ---- the page's side ----
      if (req.method === 'GET' && path === '/api/shortcut/keys') {
        requireDevice(req);
        return json(res, 200, { keys: keys.list(), waiting: keys.waiting(), off: killed() }, NO_STORE);
      }
      // A code for one new key: shown on this page, typed into the Shortcut.
      if (req.method === 'POST' && path === '/api/shortcut/keys') {
        guardWrite(req);
        const device = requireDevice(req);
        if (killed()) throw new HttpError(503, 'Shortcut keys are switched off on the server');
        const body = await readBody(req, SMALL_BODY_MAX);
        const r = await keys.mint(isObject(body) ? body.name : null, { by: device.name, byId: device.id });
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { code: r.code, name: r.name, expiresAt: r.expiresAt }, NO_STORE);
      }
      const one = /^\/api\/shortcut\/keys\/([a-f0-9]{16})$/.exec(path);
      if (req.method === 'DELETE' && one) {
        guardDelete(req);
        const device = requireDevice(req);
        const r = await keys.revoke(one[1], device.name);
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true }, NO_STORE);
      }
      return json(res, 404, { error: 'not found' }, NO_STORE);
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('shortcut route error', path, err?.message ?? err);
      if (res.headersSent) return res.end();
      const answer = { error: code === 500 ? 'internal error' : String(err.message) };
      // The Shortcut's side always gets a line to show, whatever refused it.
      if (err instanceof Refusal) answer.say = err.say;
      else if (SHORTCUT_SIDE.has(path)) answer.say = code === 500 ? 'Jarvis OS had a problem. Try again.' : 'Jarvis OS could not take that request.';
      // A body cut off mid-way (413) leaves unread bytes on the connection.
      return json(res, code, answer, code === 413 ? { ...NO_STORE, Connection: 'close' } : NO_STORE);
    }
  }

  const owns = path => path.startsWith('/api/shortcut/');
  return { handler, owns };
}

// The admin socket's side (`bin/chat-pair shortcut-code …` on the machine): make the
// code for a new key, list the keys, revoke one by id or exact name. Reachable only
// through the 0600 admin socket.
export function createShortcutAdminRouter({ keys, killed = () => false }) {
  const owns = path => path === '/admin/shortcuts' || path.startsWith('/admin/shortcut/');
  async function handler(req, res) {
    const path = new URL(req.url, 'http://unix').pathname;
    try {
      if (req.method === 'GET' && path === '/admin/shortcuts') return json(res, 200, { keys: keys.list(), waiting: keys.waiting() });
      if (req.method === 'POST' && path === '/admin/shortcut/code') {
        // The kill file stops new codes from the machine too; listing and revoking go on.
        if (killed()) throw new HttpError(503, 'Shortcut keys are switched off on the server (remove the kill file first)');
        const body = await readBody(req, SMALL_BODY_MAX);
        const r = await keys.mint(isObject(body) ? body.name : null, { by: 'chat-pair on this machine' });
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true, code: r.code, name: r.name, expiresAt: r.expiresAt });
      }
      if (req.method === 'POST' && path === '/admin/shortcut/revoke') {
        const body = await readBody(req, SMALL_BODY_MAX);
        const r = await keys.revoke(isObject(body) ? body.key : null, 'chat-pair on this machine');
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true, key: r.key });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('shortcut admin error', path, err?.message ?? err);
      if (res.headersSent) return res.end();
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
    }
  }
  return { handler, owns };
}
