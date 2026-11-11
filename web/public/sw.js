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

// Only this site's own #chat, whatever a payload says.
function chatUrl() {
  return new URL('/#chat', self.location.origin).href;
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  const n = readPayload(event.data);
  const shown = self.registration.showNotification(String(n.title || 'Jarvis'), {
    body: String(n.body || ''),
    tag: n.body === 'Jarvis needs an approval' ? 'jos-approval' : 'jos-chat',
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
