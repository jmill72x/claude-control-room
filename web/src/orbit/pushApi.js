// Web Push in the browser (jarvis-os-chat-spec.md, §3): the service worker's
// registration, this device's subscription, and the three /api/push routes. The
// pure parts are in ../lib/orbit/push.js.
import { keyBytes, sameKey, pushSupport } from '../lib/orbit/push.js';
import { ChatError } from './chatApi.js';

const answer = async res => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ChatError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body;
};
export const pushKey = () => fetch('/api/push/key', { cache: 'no-store' }).then(answer);
const saveSubscription = sub => fetch('/api/push/subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) }).then(answer);
const dropSubscription = () => fetch('/api/push/subscription', { method: 'DELETE' }).then(answer);

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export function support() {
  return pushSupport({
    hasWorker: 'serviceWorker' in navigator,
    hasPush: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    standalone: isStandalone(),
    ios: isIos()
  });
}
export const permission = () => ('Notification' in window ? Notification.permission : 'default');

// Register the worker (every load: the browser checks /sw.js for changes itself),
// and switch to the Chat tab when a notification is tapped while the page is open.
export function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open-chat' && window.location.hash !== '#chat') window.location.hash = '#chat';
  });
}

const registration = () => navigator.serviceWorker.ready;
export const currentSubscription = async () => (await registration()).pushManager.getSubscription();

// From a tap: ask for permission first, at once (iOS wants it straight from the
// gesture), then subscribe with the server's key and send the subscription.
// `key` is fetched before the tap, so nothing waits on the network in between.
export async function turnOn(key) {
  const asked = await Notification.requestPermission();
  if (asked !== 'granted') return { permission: asked, subscribed: false };
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await saveSubscription(sub);
  return { permission: 'granted', subscribed: true };
}

export async function turnOff() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) await sub.unsubscribe().catch(() => {});
  await dropSubscription();
  return { subscribed: false };
}

// On each launch, with permission already given: send the browser's subscription
// again (the server may have dropped it on a 410, or a new key replaced it), and
// make a new one when the key changed or the browser lost it. Quiet on failure.
export async function resync() {
  try {
    if (support() !== 'ok' || permission() !== 'granted') return;
    const { key } = await pushKey();
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await saveSubscription(sub);
  } catch { /* not paired, push off on the server, or the browser said no: the sheet shows it */ }
}
