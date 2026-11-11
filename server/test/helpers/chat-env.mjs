// A small chat server for a test file of its own: a temp store and device list,
// the page routes on a loopback port, a channel whose status the test sets, and
// `pair(name)` that pairs a device straight through the store and returns its
// cookie. Every name and message is invented; nothing touches :8322 or data/.
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../../lib/chat-store.mjs';
import { createDeviceStore, COOKIE_NAME, PAIR_COOKIE_NAME } from '../../lib/chat-devices.mjs';
import { createChatRoutes } from '../../lib/chat-routes.mjs';

export const call = ({ port, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = request({
    host: '127.0.0.1', port, method, path,
    headers: { ...(raw && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Length': raw.length } : {}), ...headers }
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      resolve({ status: res.statusCode, headers: res.headers, text, json });
    });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

// Open an SSE stream and keep it until `close()`; resolves once the headers are in.
export const openStream = ({ port, path = '/api/chat/stream', headers = {} }) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, res => {
    res.resume();
    resolve({ status: res.statusCode, close: () => new Promise(r => { res.on('close', r); req.destroy(); }) });
  });
  req.on('error', reject);
  req.end();
});

export async function makeChatEnv({ routes: routeOpts = {}, start = 1794380000000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-env-'));
  const clock = { t: start };
  const now = () => clock.t;
  const events = [];
  const store = createChatStore({ dir: join(dir, 'chat'), now });
  await store.load();
  const devices = createDeviceStore({ path: join(dir, 'devices.json'), now, onEvent: e => events.push(e) });
  await devices.load();
  const channel = { connected: true, lastHeartbeatAt: start, helloAt: start };
  const socket = { status: () => ({ channelConnected: channel.connected, lastHeartbeatAt: channel.lastHeartbeatAt, helloAt: channel.helloAt, version: null, streaming: false }) };
  const routes = createChatRoutes({ store, devices, socket, config: {}, now, onEvent: e => events.push(e), log: () => {}, pingMs: 60e3, ...routeOpts });
  const extra = [];
  const server = createServer(async (req, res) => {
    for (const h of extra) if (await h(req, res)) return;
    return routes.handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const pair = async name => {
    const s = await devices.start(name);
    if (!s.ok) throw new Error(s.error);
    const a = await devices.approve(s.code);
    if (!a.ok) throw new Error(a.error);
    const r = await devices.status(`${PAIR_COOKIE_NAME}=${s.pairToken}`);
    return { cookie: `${COOKIE_NAME}=${r.token}`, id: r.device.id };
  };
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, clock, now, events, store, devices, channel, socket, routes, server, port, pair, close, extra, call: opts => call({ port, ...opts }) };
}
