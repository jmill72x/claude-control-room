// When the chat pushes to a paired device, and what it says (jarvis-os-chat-spec.md,
// §3). Three generic lines and nothing else, never a message's text or a tool's name:
//
// - "New message": a chat message from the lead, to each device that has had no
//   stream open in the last 10 s. A device whose stream closed under 10 s ago is
//   checked again when the 10 s are up, and pushed only if no stream opened since
//   the message. At most one per device a minute while it stays away.
// - "Jarvis needs an approval": every permission request, to every device, urgent.
// - "Jarvis is offline": once, after 5 minutes without the channel's heartbeat;
//   once more only after it has come back.
//
// `notice`s (the channel's restart line), verdicts, edits and the owner's own
// messages never push. A subscription the push service calls gone (404 or 410) is
// deleted; a 403 (the key or the JWT refused) is an alert, at most one per window.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendPush, vapidKeys } from './webpush.mjs';

const exec = promisify(execFile);

export const CHAT_QUIET_MS = 10e3;
export const CHAT_REPEAT_MS = 60e3;
export const OFFLINE_AFTER_MS = 5 * 60e3;
export const OFFLINE_CHECK_MS = 30e3;
export const BODIES = Object.freeze({ chat: 'New message', approval: 'Jarvis needs an approval', offline: 'Jarvis is offline' });
const TOPICS = { chat: 'jos-chat', approval: 'jos-approval', offline: 'jos-chat' };
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
// account vapid-private-key; bin/vapid-keygen puts it there), read the way the ntfy
// topic is (notify.mjs, getTopic): `security` under the service's own user. Null
// when it is missing or unreadable; never logged.
export async function readVapidKey({ run } = {}) {
  const call = run ?? (async () => (await exec('/usr/bin/security', ['find-generic-password', '-s', 'claude-control-room', '-a', 'vapid-private-key', '-w'])).stdout);
  try {
    const v = String(await call()).trim();
    return v || null;
  } catch {
    return null;
  }
}

// The VAPID keys and subject push sends with, or null with the reason to log.
export async function loadVapid({ config, read = readVapidKey } = {}) {
  const settings = readPushConfig(config);
  if (!settings.subject) return { vapid: null, problems: settings.problems.length ? settings.problems : ['no push.subject in config; notifications stay off'] };
  const priv = await read();
  if (!priv) return { vapid: null, problems: ['no VAPID key in the Keychain (run bin/vapid-keygen); notifications stay off'] };
  try {
    return { vapid: { ...vapidKeys(priv), subject: settings.subject }, problems: [] };
  } catch {
    return { vapid: null, problems: ['the Keychain\'s VAPID key is not a P-256 private key; notifications stay off'] };
  }
}

// The declarative Web Push message (iOS 18.4+; sw.js shows the same for older
// iOS): a title, one of three bodies, where a tap goes, and the badge.
export function payloadFor(kind, origin) {
  const navigate = `${typeof origin === 'string' && /^https?:\/\/[^/]+$/.test(origin) ? origin : ''}/#chat`;
  return { web_push: 8030, notification: { title: 'Jarvis', body: BODIES[kind], navigate, app_badge: 1 } };
}

export function createPushService({
  devices, store, socket, lastStream, vapid = null,
  now = () => Date.now(), fetchImpl = fetch, log = console.log, onEvent = () => {},
  testHosts = null, startedAt = now(), setTimer = setTimeout, clearTimer = clearTimeout,
  checkMs = OFFLINE_CHECK_MS
}) {
  const waiting = new Map();     // device id -> { timer, since }: a chat push held for the quiet window
  const lastChatPush = new Map(); // device id -> when its last "New message" went
  let offlinePushed = false;
  const sending = new Set();

  async function send(target, kind) {
    if (!vapid) return { outcome: 'off' };
    const r = await sendPush({
      subscription: target.push, payload: payloadFor(kind, target.push.origin), vapid,
      urgency: kind === 'approval' ? 'high' : 'normal', topic: TOPICS[kind], now: now(), fetchImpl, testHosts
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
    lastChatPush.set(target.id, at);
    track(send(target, 'chat'));
  }

  function onStoreEvent(event) {
    if (event.type === 'message') {
      const m = event.message;
      if (m.from !== 'jarvis' || m.kind !== 'chat') return; // notices, permissions, verdicts and the owner's own
      for (const target of devices.pushTargets()) considerChat(target, m.at ?? now());
    } else if (event.type === 'permission') {
      for (const target of devices.pushTargets()) track(send(target, 'approval'));
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
    for (const target of devices.pushTargets()) track(send(target, 'offline'));
  }

  const unsubscribe = store.subscribe(onStoreEvent);
  const offlineTimer = setInterval(checkOffline, checkMs);
  offlineTimer.unref?.();

  return {
    publicKey: () => vapid?.publicKey ?? null,
    on: () => vapid !== null,
    testHosts,
    checkOffline,
    idle: async () => { while (sending.size) await Promise.allSettled([...sending]); },
    stop: () => { unsubscribe(); clearInterval(offlineTimer); for (const w of waiting.values()) clearTimer(w.timer); waiting.clear(); }
  };
}
