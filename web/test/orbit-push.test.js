// Web Push on the page: the key bytes, the key match, what the settings sheet
// says, and the service worker itself, run in a vm with a fake `self`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { keyBytes, sameKey, pushSupport, pushView } from '../src/lib/orbit/push.js';

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

test('the key as bytes, and whether a subscription carries it', () => {
  const b = keyBytes(KEY);
  assert.equal(b.length, 65);
  assert.equal(b[0], 4);
  assert.deepEqual([...b], [...Buffer.from(KEY, 'base64url')]);
  assert.ok(sameKey(b.buffer, KEY));
  const other = new Uint8Array(b); other[64] ^= 1;
  assert.equal(sameKey(other.buffer, KEY), false);
  assert.equal(sameKey(null, KEY), false);
  assert.equal(sameKey(new Uint8Array(64).buffer, KEY), false);
  assert.equal(sameKey(b.slice(0, 64).buffer, KEY), false, 'a prefix is not the key');
});

test('support: everything present is ok; iOS outside the home-screen app is told to add the icon', () => {
  assert.equal(pushSupport({ hasWorker: true, hasPush: true, hasNotification: true, standalone: false, ios: false }), 'ok');
  assert.equal(pushSupport({ hasWorker: true, hasPush: false, hasNotification: false, standalone: false, ios: true }), 'home-screen');
  assert.equal(pushSupport({ hasWorker: true, hasPush: false, hasNotification: false, standalone: true, ios: true }), 'unsupported');
  assert.equal(pushSupport({ hasWorker: false, hasPush: false, hasNotification: false, standalone: false, ios: false }), 'unsupported');
});

test('the sheet: the home-screen note, server off, blocked, on (turn off) and off (turn on)', () => {
  assert.match(pushView({ support: 'home-screen' }).text, /home-screen icon/);
  assert.equal(pushView({ support: 'home-screen' }).action, null);
  assert.equal(pushView({ support: 'unsupported' }).action, null);
  assert.match(pushView({ support: 'ok', server: 'off', permission: 'default' }).text, /not set up on the server/);
  assert.equal(pushView({ support: 'ok', server: 'on', permission: 'denied' }).action, null);
  assert.equal(pushView({ support: 'ok', server: 'on', permission: 'granted', subscribed: true }).action, 'off');
  assert.equal(pushView({ support: 'ok', server: 'on', permission: 'granted', subscribed: false }).action, 'on');
  assert.equal(pushView({ support: 'ok', server: 'on', permission: 'default', subscribed: false }).action, 'on');
  for (const v of [pushView({ support: 'ok', server: 'on', permission: 'default' }), pushView({ support: 'ok', server: 'on', permission: 'granted', subscribed: true })]) {
    assert.match(v.text, /never show what a message says/);
  }
});

// ---- the service worker ----

function loadWorker() {
  const listeners = {};
  const shown = [];
  const waited = [];
  const opened = [];
  const posted = [];
  const badges = [];
  const clients = [];
  const self = {
    location: { origin: 'https://mini.example.ts.net' },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    skipWaiting: () => {},
    registration: { showNotification: async (title, opts) => { shown.push(JSON.parse(JSON.stringify({ title, ...opts }))); } },
    navigator: { setAppBadge: async n => { badges.push(n); } },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      openWindow: async url => { opened.push(url); }
    }
  };
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(src, { self, URL, Promise, String, Number, JSON });
  let waits = 0;
  const fire = async (type, event) => {
    const before = waits;
    const e = { waitUntil: p => { waits++; waited.push(p); }, ...event };
    for (const fn of listeners[type] ?? []) fn(e);
    await Promise.all(waited.splice(0));
    return waits - before;
  };
  return { listeners, shown, opened, posted, badges, clients, fire };
}

test('sw.js: no fetch handler, and every push shows a notification inside waitUntil, even one it cannot read', async () => {
  const w = loadWorker();
  assert.equal(w.listeners.fetch, undefined, 'no fetch handler: no caching, ever');
  const data = obj => ({ json: () => obj });
  assert.equal(await w.fire('push', { data: data({ web_push: 8030, notification: { title: 'Jarvis', body: 'New message', navigate: 'https://mini.example.ts.net/#chat', app_badge: 1 } }) }), 1, 'inside waitUntil');
  await w.fire('push', { data: data({ web_push: 8030, notification: { title: 'Jarvis', body: 'Jarvis needs an approval', navigate: 'https://evil.example/', app_badge: 1 } }) });
  await w.fire('push', { data: { json: () => { throw new Error('not json'); } } });
  await w.fire('push', { data: null });
  assert.equal(w.shown.length, 4);
  assert.deepEqual(w.shown[0], { title: 'Jarvis', body: 'New message', tag: 'jos-chat', data: { url: 'https://mini.example.ts.net/#chat' } });
  assert.equal(w.shown[1].tag, 'jos-approval');
  assert.equal(w.shown[1].data.url, 'https://mini.example.ts.net/#chat', 'only this site\'s #chat, whatever the payload says');
  assert.equal(w.shown[2].title, 'Jarvis');
  assert.equal(w.shown[3].title, 'Jarvis');
  assert.deepEqual(w.badges, [1, 1, 1, 1]);
});

test('sw.js: a tap opens /#chat, or brings an open page forward and tells it to switch tabs', async () => {
  const w = loadWorker();
  let closed = 0;
  assert.equal(await w.fire('notificationclick', { notification: { close: () => { closed++; } } }), 1);
  assert.deepEqual(w.opened, ['https://mini.example.ts.net/#chat']);
  let focused = 0;
  const msgs = [];
  w.clients.push({ url: 'https://other.example/', postMessage: () => { throw new Error('not ours'); }, focus: async () => {} });
  w.clients.push({ url: 'https://mini.example.ts.net/#board', postMessage: m => msgs.push(JSON.parse(JSON.stringify(m))), focus: async () => { focused++; } });
  await w.fire('notificationclick', { notification: { close: () => { closed++; } } });
  assert.equal(closed, 2);
  assert.deepEqual(msgs, [{ type: 'open-chat' }]);
  assert.equal(focused, 1);
  assert.equal(w.opened.length, 1, 'no second window');
});
