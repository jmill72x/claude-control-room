// Web Push on the page, the pure parts (jarvis-os-chat-spec.md, §3): the server's
// key as bytes, whether a subscription was made with that key, and what the
// settings sheet says about this device.

// A base64url string as the Uint8Array pushManager.subscribe wants.
export function keyBytes(b64u) {
  const s = String(b64u ?? '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Whether a subscription's applicationServerKey (an ArrayBuffer, or null) is this key.
export function sameKey(buffer, b64u) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  const b = keyBytes(b64u);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// What the device can do. `standalone`: launched from the home-screen icon. iOS
// offers Web Push only there, so in a Safari tab the answer is to add the icon.
export function pushSupport({ hasWorker, hasPush, hasNotification, standalone, ios }) {
  if (hasWorker && hasPush && hasNotification) return 'ok';
  if (ios && !standalone) return 'home-screen';
  return 'unsupported';
}

// The settings sheet's line and button for this device.
export function pushView({ support, permission, subscribed, server }) {
  if (support === 'home-screen') return { text: 'On iPhone and iPad, notifications work only in the app opened from the home-screen icon. In Safari, tap Share, then Add to Home Screen, and turn them on there.', action: null };
  if (support !== 'ok') return { text: 'This browser can\'t show notifications from the chat.', action: null };
  if (server === 'off') return { text: 'Notifications are not set up on the server yet.', action: null };
  if (permission === 'denied') return { text: 'Notifications are blocked for this app. Allow them in Settings, then come back.', action: null };
  if (subscribed) return { text: 'Notifications are on for this device: new messages while you are away, every approval, and Jarvis going offline. They never show what a message says.', action: 'off' };
  return { text: 'Get a notification for new messages while you are away, every approval, and Jarvis going offline. They never show what a message says.', action: 'on' };
}
