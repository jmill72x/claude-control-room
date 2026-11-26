// When the chat pushes to a paired device, and what it says (jarvis-os-chat-spec.md,
// §3). Three generic lines and a limit warning, never a message's text or a tool's name:
//
// - "New message": a chat message from the lead, to each device that has had no
//   stream open in the last 10 s. A device whose stream closed under 10 s ago is
//   checked again when the 10 s are up, and pushed only if no stream opened since
//   the message. At most one per device a minute while it stays away.
// - "Jarvis needs an approval": a permission request, to every device, urgent. At
//   most one per device each 15 s: a request inside that window is held, and pushed
//   at its end only if a request is still open then (a burst of requests is one
//   push). One the send queue drops (below) starts no window and is held the same
//   way, tried again every 15 s while a request is open, so a request left open
//   is announced as soon as the queue has room.
// - An approval reminder (lib/approval-wait.mjs; board e7427be1): "Jarvis has waited 10
//   min on an approval card. Answer it in ...", to every device at once, urgent, looking
//   or not, when a card of the lead's has waited 10 minutes, then each 30 (at most six,
//   held in quiet hours). Its body is the one other that is not a fixed line: a roster
//   name and whole minutes in one fixed shape (isReminderPush), never a tool's name; a
//   body not in that shape is not sent. A tap opens the Chat. The same Topic and tag as
//   the approval push, so a newer one takes an older one's place.
// - "Jarvis is offline": once, after 5 minutes without the channel's heartbeat;
//   once more only after it has come back. With the line that brings him back (the
//   page's Restart Jarvis, or the run sheet's command): fixed words too.
//
// - A limit warning (lib/limit-warnings.mjs; the notifier calls limitWarning): a line
//   such as "Claude session at 80%, resets 5:30 pm", to every device at once, urgent,
//   looking or not, at any hour. The one push whose body is not a fixed line: it is
//   the usage panel's own numbers in a fixed shape (WARNING_BODY), and a body that is
//   not in that shape is not sent. A tap opens the Overview. Titled "Control Room".
//   The same route carries the full line ("Jarvis is at the session limit until 5:30
//   pm", FULL_BODY) and the fixed back line ("Jarvis is back under the limit",
//   BACK_TEXT): isLimitPush is the check, and nothing else passes it.
// - A local alert (lib/local-alerts.mjs; the ingest socket's local-alert route calls
//   localAlert): "Local alert: " and a script's own title, its body, already cleaned and bounded there, to
//   every device at once, looking or not, at any hour; urgent unless its severity is
//   "info". No Topic, so two alerts never replace each other at the push service, and
//   kept there ALERT_TTL_S for a phone that is away. The body is cut to fit one record
//   (ALERT_PAYLOAD_MAX). A tap opens the Overview, where the strip and Needs you hold it.
//
// `notice`s (the channel's restart line), verdicts, edits and the owner's own
// messages never push. A subscription the push service calls gone (404 or 410) is
// deleted; a 403 (the key or the JWT refused) is an alert, at most one per window.
// At most 4 sends are in flight at once; the rest wait in a queue of at most 16,
// past which a push is dropped with a log line. A dropped push starts none of the
// windows above, so the next message or request pushes as if it never happened.
import { sendPush, vapidKeys } from './webpush.mjs';
import { readStoredKey, runSecurity, LOGIN_KEYCHAIN } from './vapid-store.mjs';
import { isLimitPush } from './limit-warnings.mjs';
import { RECOVER_LINE } from './recover-command.mjs';
import { isReminderPush } from './approval-wait.mjs';

export const CHAT_QUIET_MS = 10e3;
export const CHAT_REPEAT_MS = 60e3;
export const APPROVAL_REPEAT_MS = 15e3;
export const SEND_CONCURRENCY = 4;
export const SEND_QUEUE_MAX = 16;
export const OFFLINE_AFTER_MS = 5 * 60e3;
export const OFFLINE_CHECK_MS = 30e3;
// "Jarvis is offline" carries the one line that brings him back (lib/recover-command.mjs;
// board 98a30b15): every Jarvis-down push does.
export const BODIES = Object.freeze({ chat: 'New message', approval: 'Jarvis needs an approval', offline: `Jarvis is offline. ${RECOVER_LINE}` });
// A local alert: how long the push service keeps it for a device that is away, the
// most its JSON may take (one record is 4,096 bytes less the tag and the delimiter),
// and the words for an empty title or body.
export const ALERT_TTL_S = 6 * 3600;
export const ALERT_PAYLOAD_MAX = 3072;
// Every local alert's notification title starts with this fixed marker (Ultron's L1), so
// a script's words can never pass for one of the server's own lines ("Jarvis needs an
// approval"); sw.js keys its tag on it too.
export const ALERT_TITLE_PREFIX = 'Local alert: ';
export const ALERT_FALLBACK_TITLE = 'Local alert';
export const ALERT_FALLBACK_BODY = 'Open the Control Room for the details.';
const ELLIPSIS = String.fromCodePoint(0x2026);
const TOPICS = { chat: 'jos-chat', approval: 'jos-approval', reminder: 'jos-approval', offline: 'jos-chat', limit: 'jos-limit' };
// What a limit warning says when its body is not in the fixed shape (payloadFor is
// exported; limitWarning refuses such a body before it gets here).
export const LIMIT_FALLBACK = 'Claude limit warning';
// An origin a tap may go to: https, a DNS name (lowercase, as URL writes it) and an
// optional port; nothing after it. The last label starts with a letter, so an IPv4
// literal is no DNS name. The routes store only the Serve name's origin.
const NAV_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;
const MAILTO = /^mailto:[^\s@<>()"',;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Config's `push` block: `subject` must be a mailto: address (Apple refuses a
// localhost one). Anything else keeps push off, with a problem line to log.
export function readPushConfig(config) {
  const push = config?.push;
  if (push === undefined || push === null) return { subject: null, problems: [] };
  if (typeof push !== 'object' || Array.isArray(push)) return { subject: null, problems: ['push must be an object; notifications stay off'] };
  const subject = typeof push.subject === 'string' ? push.subject.trim() : '';
  if (!MAILTO.test(subject)) return { subject: null, problems: ['push.subject must be a mailto: address; notifications stay off'] };
  return { subject, problems: [] };
}

// The VAPID private key from the login Keychain (service claude-control-room,
// account vapid-private-key; bin/vapid-keygen puts it there), named by its file
// and read into memory by lib/vapid-store.mjs under the service's own user. Null
// when the item is missing (security's exit 44); any other failure throws, so the
// log says the Keychain could not be read rather than that no key exists. Never
// logged.
export async function readVapidKey({ run = runSecurity, keychain = LOGIN_KEYCHAIN } = {}) {
  return readStoredKey({ run, keychain });
}

// The VAPID keys and subject push sends with, or null with the reason to log.
export async function loadVapid({ config, read = readVapidKey } = {}) {
  const settings = readPushConfig(config);
  if (!settings.subject) return { vapid: null, problems: settings.problems.length ? settings.problems : ['no push.subject in config; notifications stay off'] };
  let priv;
  try { priv = await read(); } catch (err) { return { vapid: null, problems: [`the Keychain could not be read (${String(err?.message ?? err)}); notifications stay off`] }; }
  if (!priv) return { vapid: null, problems: ['no VAPID key in the Keychain (run bin/vapid-keygen); notifications stay off'] };
  try {
    return { vapid: { ...vapidKeys(priv), subject: settings.subject }, problems: [] };
  } catch {
    return { vapid: null, problems: ['the Keychain\'s VAPID key is not a P-256 private key; notifications stay off'] };
  }
}

// A local alert's message: its title and body, the body cut (by code points, with an
// ellipsis) until the JSON fits ALERT_PAYLOAD_MAX bytes. No badge: it counts chat messages.
// `tail` (the server's own fixed words, such as a "jarvis-down" alert's way back) goes
// after the body on a paragraph of its own and is never cut: the body is cut first.
export function alertPayload(site, alert) {
  const title = typeof alert?.title === 'string' && alert.title !== '' ? `${ALERT_TITLE_PREFIX}${alert.title}` : ALERT_FALLBACK_TITLE;
  const text = typeof alert?.body === 'string' && alert.body !== '' ? alert.body : ALERT_FALLBACK_BODY;
  const tail = typeof alert?.tail === 'string' && alert.tail !== '' ? `\n\n${alert.tail}` : '';
  const make = body => ({ web_push: 8030, notification: { title, body: body + tail, navigate: `${site}/#overview` } });
  const chars = [...text];
  let n = chars.length;
  let payload = make(text);
  while (n > 0 && Buffer.byteLength(JSON.stringify(payload)) > ALERT_PAYLOAD_MAX) {
    n = Math.max(0, n - 16);
    payload = make(chars.slice(0, n).join('').trimEnd() + ELLIPSIS);
  }
  return payload;
}

// The declarative Web Push message (iOS 18.4+; sw.js shows the same for older
// iOS): a title, one of three bodies, where a tap goes, and the badge.
export function payloadFor(kind, origin, body = null) {
  const site = typeof origin === 'string' && NAV_ORIGIN.test(origin) ? origin : '';
  if (kind === 'alert') return alertPayload(site, body);
  // A limit warning: its own title, the Overview on a tap, and no badge (the badge
  // counts unseen chat messages).
  if (kind === 'limit') {
    return { web_push: 8030, notification: { title: 'Control Room', body: isLimitPush(body) ? body : LIMIT_FALLBACK, navigate: `${site}/#overview` } };
  }
  const navigate = `${site}/#chat`;
  // An approval reminder: its body only in the fixed shape, else the approval's line.
  if (kind === 'reminder') return { web_push: 8030, notification: { title: 'Jarvis', body: isReminderPush(body) ? body : BODIES.approval, navigate, app_badge: 1 } };
  return { web_push: 8030, notification: { title: 'Jarvis', body: BODIES[kind], navigate, app_badge: 1 } };
}

export function createPushService({
  devices, store, socket, lastStream, vapid = null,
  now = () => Date.now(), fetchImpl = fetch, log = console.log, onEvent = () => {},
  testHosts = null, startedAt = now(), setTimer = setTimeout, clearTimer = clearTimeout,
  checkMs = OFFLINE_CHECK_MS, sendConcurrency = SEND_CONCURRENCY, sendQueueMax = SEND_QUEUE_MAX
}) {
  const waiting = new Map();     // device id -> { timer, since }: a chat push held for the quiet window
  const lastChatPush = new Map(); // device id -> when its last "New message" went
  const lastApprovalPush = new Map(); // device id -> when its last approval push went
  const heldApproval = new Map();     // device id -> the timer for an approval held by the 15 s cap
  const queued = [];                  // { target, kind, done } waiting for a free send
  let inFlight = 0;
  let offlinePushed = false;
  const sending = new Set();

  async function send(target, kind, body = null) {
    if (!vapid) return { outcome: 'off' };
    const urgent = kind === 'approval' || kind === 'reminder' || kind === 'limit' || (kind === 'alert' && body?.severity !== 'info');
    const r = await sendPush({
      subscription: target.push, payload: payloadFor(kind, target.push.origin, body), vapid,
      urgency: urgent ? 'high' : 'normal', topic: TOPICS[kind] ?? null, now: now(), fetchImpl, testHosts,
      ...(kind === 'alert' ? { ttl: ALERT_TTL_S } : {})
    });
    if (r.outcome === 'gone') {
      if (await devices.dropPush(target.id, target.push.endpoint)) log(`push: ${target.name}'s subscription is gone (${r.status}); removed`);
    } else if (r.outcome === 'forbidden') {
      log(`push: the push service refused the key for ${target.name} (403)`);
      onEvent({ kind: 'push-forbidden', device: target.name });
    } else if (r.outcome !== 'sent') {
      log(`push: a ${kind} push to ${target.name} failed (${r.status || 'no answer'})`);
    }
    return r;
  }
  // Every send is tracked, so a test (and a shutdown) can wait for them.
  const track = p => { sending.add(p); p.finally(() => sending.delete(p)); return p; };

  // A push goes through a bounded queue: at most `sendConcurrency` in flight, at
  // most `sendQueueMax` waiting; one past that is dropped and logged. A queued push
  // returns the promise of its send's result; a dropped one returns null.
  function pump() {
    while (inFlight < sendConcurrency && queued.length) {
      const job = queued.shift();
      inFlight++;
      send(job.target, job.kind, job.body)
        .catch(err => { log(`push: a ${job.kind} push to ${job.target.name} failed (${err?.message ?? err})`); return { outcome: 'failed' }; })
        .then(r => { inFlight--; job.done(r); pump(); });
    }
  }
  function enqueue(target, kind, body = null) {
    if (queued.length >= sendQueueMax) {
      log(`push: ${queued.length} pushes are waiting; a ${kind} push to ${target.name} was dropped`);
      return null;
    }
    return track(new Promise(done => { queued.push({ target, kind, body, done }); pump(); }));
  }

  // A limit warning to every paired device (the notifier's call), or with `only` (a
  // list of device ids) to those alone: the notifier's later try for the ones a first
  // send missed. Resolves to `{ tried, reached, missed }`: how many devices it was sent
  // to, how many the push service took it for, and the ids of the rest, so "nothing to
  // try" (push off, no device, a body not in the fixed shape: tried 0) and "tried and
  // failed" are told apart. A device whose subscription is gone is not missed: there is
  // nothing left to try.
  async function limitWarning(body, { only = null } = {}) {
    const none = { tried: 0, reached: 0, missed: [] };
    if (!vapid) return none;
    if (!isLimitPush(body)) {
      log('push: a limit warning that is not in the fixed shape was not sent');
      return none;
    }
    const targets = devices.pushTargets().filter(target => !Array.isArray(only) || only.includes(target.id));
    const results = await Promise.all(targets.map(target => enqueue(target, 'limit', body) ?? { outcome: 'dropped' }));
    const reached = results.filter(r => r?.outcome === 'sent').length;
    const missed = targets.filter((_, i) => results[i]?.outcome !== 'sent' && results[i]?.outcome !== 'gone').map(target => target.id);
    log(`push: a limit warning went to ${reached} of ${targets.length} device${targets.length === 1 ? '' : 's'}`);
    return { tried: targets.length, reached, missed };
  }

  // A local alert (lib/local-alerts.mjs) to every paired device: `{ title, body,
  // severity }`, checked there. Resolves to `{ tried, reached }`, or `{ off: true }`
  // with zeros while push is off. A device the queue drops is not tried again: the
  // page's strip still holds the alert, and the caller has its own Discord post.
  async function localAlert(alert) {
    if (!vapid) return { tried: 0, reached: 0, off: true };
    const targets = devices.pushTargets();
    const results = await Promise.all(targets.map(target => enqueue(target, 'alert', alert) ?? { outcome: 'dropped' }));
    const reached = results.filter(r => r?.outcome === 'sent').length;
    log(`push: a local alert went to ${reached} of ${targets.length} device${targets.length === 1 ? '' : 's'}`);
    return { tried: targets.length, reached };
  }

  // An approval reminder (lib/approval-wait.mjs) to every paired device. Resolves to
  // `{ tried, reached }`, zeros while push is off or for a body not in the fixed shape.
  async function approvalReminder(body) {
    if (!vapid) return { tried: 0, reached: 0 };
    if (!isReminderPush(body)) {
      log('push: an approval reminder that is not in the fixed shape was not sent');
      return { tried: 0, reached: 0 };
    }
    const targets = devices.pushTargets();
    const results = await Promise.all(targets.map(target => enqueue(target, 'reminder', body) ?? { outcome: 'dropped' }));
    return { tried: targets.length, reached: results.filter(r => r?.outcome === 'sent').length };
  }

  // An approval held for `ms`: then pushed if the device is still paired and a
  // request is still open. One timer per device.
  function holdApproval(target, ms) {
    if (heldApproval.has(target.id)) return;
    const timer = setTimer(() => {
      heldApproval.delete(target.id);
      const fresh = devices.pushTargets().find(t => t.id === target.id);
      if (fresh && store.openPermissions().length > 0) considerApproval(fresh);
    }, ms);
    timer?.unref?.();
    heldApproval.set(target.id, timer);
  }

  // The 15 s cap on approval pushes for one device. The window starts only when a
  // push is queued; one the queue drops is held for a window and tried again.
  function considerApproval(target) {
    const at = now();
    const last = lastApprovalPush.get(target.id);
    if (last !== undefined && at - last < APPROVAL_REPEAT_MS) {
      holdApproval(target, last + APPROVAL_REPEAT_MS - at);
      return;
    }
    const sent = enqueue(target, 'approval');
    if (sent) {
      lastApprovalPush.set(target.id, at);
      // Said when it lands (board e7427be1: on 11-26 nothing in the log could say whether
      // a card's push went); a failure has its own line in send().
      sent.then(r => { if (r?.outcome === 'sent') log(`push: an approval push went to ${target.name}`); });
      // A retry still held from a drop is covered by this push.
      const held = heldApproval.get(target.id);
      if (held !== undefined) { clearTimer(held); heldApproval.delete(target.id); }
    } else {
      holdApproval(target, APPROVAL_REPEAT_MS);
    }
  }

  // The 10 s rule for one device, `since` being when the message arrived.
  function considerChat(target, since) {
    const seen = lastStream(target.id);
    if (seen === 'open') return;
    if (typeof seen === 'number' && seen >= since) return; // a stream was open after the message
    const at = now();
    if (typeof seen === 'number' && at - seen < CHAT_QUIET_MS) {
      if (!waiting.has(target.id)) {
        const timer = setTimer(() => {
          const w = waiting.get(target.id);
          waiting.delete(target.id);
          const fresh = devices.pushTargets().find(t => t.id === target.id);
          if (w && fresh) considerChat(fresh, w.since);
        }, seen + CHAT_QUIET_MS - at);
        timer?.unref?.();
        waiting.set(target.id, { timer, since });
      }
      return;
    }
    const last = lastChatPush.get(target.id);
    if (last !== undefined && at - last < CHAT_REPEAT_MS && !(typeof seen === 'number' && seen > last)) return;
    if (enqueue(target, 'chat')) lastChatPush.set(target.id, at); // a dropped one starts no minute
  }

  function onStoreEvent(event) {
    if (event.type === 'message') {
      const m = event.message;
      if (m.from !== 'jarvis' || m.kind !== 'chat') return; // notices, permissions, verdicts and the owner's own
      for (const target of devices.pushTargets()) considerChat(target, m.at ?? now());
    } else if (event.type === 'permission') {
      // Only a request the page can answer: a late or repeated one is the terminal's.
      if (event.request?.state !== 'open') return;
      for (const target of devices.pushTargets()) considerApproval(target);
    }
  }

  // The channel's heartbeat, read every 30 s: offline for 5 minutes pushes once.
  function checkOffline() {
    const st = socket.status();
    if (st.channelConnected) { offlinePushed = false; return; }
    if (offlinePushed) return;
    const since = st.lastHeartbeatAt ?? startedAt;
    if (now() - since < OFFLINE_AFTER_MS) return;
    offlinePushed = true;
    log('push: the channel has been offline for 5 minutes');
    for (const target of devices.pushTargets()) enqueue(target, 'offline');
  }

  const unsubscribe = store.subscribe(onStoreEvent);
  const offlineTimer = setInterval(checkOffline, checkMs);
  offlineTimer.unref?.();

  return {
    publicKey: () => vapid?.publicKey ?? null,
    on: () => vapid !== null,
    testHosts,
    checkOffline,
    limitWarning,
    localAlert,
    approvalReminder,
    idle: async () => { while (sending.size) await Promise.allSettled([...sending]); },
    stop: () => { unsubscribe(); clearInterval(offlineTimer); for (const w of waiting.values()) clearTimer(w.timer); waiting.clear(); for (const t of heldApproval.values()) clearTimer(t); heldApproval.clear(); }
  };
}
