// The Control Room's service worker: Web Push for the chat, nothing else
// (jarvis-os-chat-spec.md, §3). No fetch handler and no caching, on purpose: a
// cached page is how an old board tab once saved over a newer board, so every
// request keeps going to the server.
//
// The server sends Declarative Web Push JSON ({web_push: 8030, notification:
// {title, body, navigate, app_badge}}), with generic text only. iOS 18.4 and later
// can show that without this file; before 18.4, and in other browsers, this push
// handler shows it, and it must always show something (userVisibleOnly), so a
// payload it can't read still becomes a plain "Jarvis" notification.
const FALLBACK = { title: 'Jarvis', body: 'New message', navigate: '/#chat', app_badge: 1 };

function readPayload(data) {
  try {
    const n = data?.json()?.notification;
    if (n && typeof n === 'object') return { ...FALLBACK, ...n };
  } catch { /* not JSON: the fallback */ }
  return FALLBACK;
}

// The notification's tag: a local script's alert (its title starts "Local alert",
// server/lib/chat-push.mjs) has its own, so it never takes the approval's place or
// the chat's; an approval is the server's own line under the title "Jarvis", and so is
// an approval reminder (server/lib/approval-wait.mjs: its body ends with REMINDER_TAIL).
const REMINDER_TAIL = ' on an approval card.';
function tagFor(n) {
  const title = String(n.title || '');
  if (title === 'Local alert' || title.startsWith('Local alert: ')) return 'jos-local';
  const body = String(n.body || '');
  return title === 'Jarvis' && (body === 'Jarvis needs an approval' || body.includes(REMINDER_TAIL)) ? 'jos-approval' : 'jos-chat';
}

// Only this site's own #chat, whatever a payload says.
function chatUrl() {
  return new URL('/#chat', self.location.origin).href;
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  const n = readPayload(event.data);
  const tag = tagFor(n);
  const shown = self.registration.showNotification(String(n.title || 'Jarvis'), {
    body: String(n.body || ''),
    tag,
    // An approval or its reminder that takes an older one's place still sounds (board
    // e7427be1): a second card 18 s after the first must not land silently.
    ...(tag === 'jos-approval' ? { renotify: true } : {}),
    data: { url: chatUrl() }
  });
  const badge = typeof self.navigator?.setAppBadge === 'function' ? self.navigator.setAppBadge(Number(n.app_badge) || 1).catch(() => {}) : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = chatUrl();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      // An open page: bring it forward and let it switch to the Chat tab.
      client.postMessage({ type: 'open-chat' });
      if ('focus' in client) return client.focus();
      return undefined;
    }
    return self.clients.openWindow(url);
  })());
});
