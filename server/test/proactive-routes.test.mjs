// GET /api/proactive (lib/proactive-routes.mjs): the Feed's read rule exactly (a paired
// device, the owner's tailnet login when one is set, nobody with the chat off), GET
// only, uncached, a failed view as fixed words; and server.mjs's wiring of the check
// (a source test: the board is read from its file, never through the board store).
// Every name is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProactiveRoutes, PROACTIVE_PATH } from '../lib/proactive-routes.mjs';
import { makeChatEnv } from './helpers/chat-env.mjs';

const SERVE = { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': 'mini.example-tailnet.ts.net', 'x-forwarded-proto': 'https' };
const VIEW = { status: 'on', hits: [{ id: '0123456789abcdef', rule: 'due', item: 'aa11aa11-0000-4000-8000-000000000001', priority: 'P2', due: '2026-11-17', late: 1 }] };

async function env(t, { devices = true, login = null, view = () => VIEW } = {}) {
  const e = await makeChatEnv();
  const routes = createProactiveRoutes({ view, devices: devices ? e.devices : null, login, log: () => {} });
  e.extra.push(async (req, res) => (routes.owns(new URL(req.url, 'http://x').pathname) ? (await routes.handler(req, res), true) : false));
  t.after(() => e.close());
  return e;
}

test('a paired device reads the view, uncached, as JSON', async t => {
  const e = await env(t);
  const { cookie } = await e.pair('Test phone');
  const r = await e.call({ path: PROACTIVE_PATH, headers: { cookie } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, VIEW);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(PROACTIVE_PATH, '/api/proactive');
});

test('no cookie, a forged cookie, the wrong login or no login are refused, as for the Feed', async t => {
  const e = await env(t, { login: 'owner@example.com' });
  const { cookie } = await e.pair('Test phone');
  const owner = { ...SERVE, 'tailscale-user-login': 'owner@example.com' };
  assert.equal((await e.call({ path: PROACTIVE_PATH, headers: owner })).status, 401);
  assert.equal((await e.call({ path: PROACTIVE_PATH, headers: { ...owner, cookie: 'cr_device=forged' } })).status, 401);
  assert.equal((await e.call({ path: PROACTIVE_PATH, headers: { ...SERVE, 'tailscale-user-login': 'someone@example.com', cookie } })).status, 403);
  assert.equal((await e.call({ path: PROACTIVE_PATH, headers: { ...SERVE, cookie } })).status, 403);
  const ok = await e.call({ path: PROACTIVE_PATH, headers: { ...owner, cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.hits.length, 1);
  const refused = await e.call({ path: PROACTIVE_PATH, headers: owner });
  assert.equal(refused.json.hits, undefined, 'a refusal carries no hits');
});

test('with the chat off there are no devices, so nobody reads it, from Serve or the mini', async t => {
  const e = await env(t, { devices: false });
  for (const headers of [{}, SERVE]) {
    const r = await e.call({ path: PROACTIVE_PATH, headers });
    assert.equal(r.status, 401);
    assert.equal(r.json.hits, undefined);
  }
});

test('GET only; other paths are not its own', async t => {
  const e = await env(t);
  const { cookie } = await e.pair('Test phone');
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await e.call({ method, path: PROACTIVE_PATH, headers: { cookie }, body: {} })).status, 405, method);
  }
  const routes = createProactiveRoutes({ view: () => VIEW });
  assert.equal(routes.owns('/api/proactive'), true);
  assert.equal(routes.owns('/api/proactivex'), false);
  assert.equal(routes.owns('/api/proactive/x'), false);
});

test('a view that throws is a 500 with fixed words', async t => {
  const e = await env(t, { view: () => { throw new Error('/private/path boom'); } });
  const { cookie } = await e.pair('Test phone');
  const r = await e.call({ path: PROACTIVE_PATH, headers: { cookie } });
  assert.equal(r.status, 500);
  assert.equal(r.text.includes('private'), false);
});

// ---- server.mjs's wiring ----

const block = (src, start, end) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `server.mjs has ${start}`);
  const j = src.indexOf(end, i);
  assert.ok(j > i, `server.mjs closes ${start} with ${end}`);
  return src.slice(i, j);
};

test('server.mjs: the board is read from its file, never through the board store; the rest as built', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const made = block(src, 'const proactive = createProactive({', '\n});');
  // One path for the board's file, the store's and the check's (Ultron's L6).
  assert.match(made, /readBoard: \(\) => readFile\(TODOS_PATH, 'utf8'\)/);
  assert.match(src, /const TODOS_PATH = join\(HERE, 'todos\.json'\);\nconst todos = createTodoStore\(TODOS_PATH\);/);
  assert.equal(src.match(/'todos\.json'/g).length, 1, 'the file named once');
  assert.match(made, /excludeKeys: eventsSettings\.excludeKeys,/);
  assert.ok(!/\btodos\.[a-zA-Z]+\(/.test(made), 'no board store call in the check');
  assert.match(made, /events: \(\) => events,/);
  assert.match(made, /killed: \(\) => existsSync\(proactiveOffPath\)/);
  assert.match(made, /store: proactiveStore,/);
  assert.match(src, /const proactiveOffPath = join\(stateDir, 'proactive-off'\);/);
  assert.match(src, /const proactiveStore = createSentStore\(join\(HERE, 'data', 'proactive\.json'\)\);/);
  // The route has the Feed's devices and login, and sits in the router.
  const route = block(src, 'const proactiveRoutes = createProactiveRoutes({', '\n});');
  assert.match(route, /devices: chatDevicesForFeed,/);
  assert.match(route, /login: chatSettings\.on \? chatSettings\.login : null/);
  assert.match(src, /if \(proactiveRoutes\.owns\(new URL\(req\.url, 'http:\/\/localhost'\)\.pathname\)\) return proactiveRoutes\.handler\(req, res\);/);
  // Passes only when config turns it on and someone can hear or read a hit (L5), after
  // the first collector pass.
  assert.match(src, /const proactiveStarted = proactiveStart\(\{ settings: proactiveSettings, events: Boolean\(events\), devices: Boolean\(chatDevicesForFeed\), killFile: existsSync\(proactiveOffPath\) \}\);/);
  assert.match(src, /console\.log\(proactiveStarted\.line\);/);
  const on = block(src, 'if (proactiveStarted.run) {', '\n}\n');
  assert.match(on, /registry\.whenFirstPass\(\)\.then\(/);
  assert.ok(on.indexOf('await proactiveStore.sweep()') >= 0 && on.indexOf('await proactiveStore.sweep()') < on.indexOf('registry.whenFirstPass()'), 'its temp files swept before the first pass');
  assert.match(on, /setInterval\(runPass, PROACTIVE_EVERY_MS\)\.unref\(\)/);
  assert.match(on, /nextQuietEnd\(Date\.now\(\)\)/);
  // The Shortcut keys reach the expiry rule once loaded.
  assert.match(src, /shortcutKeysForProactive = shortcutKeys;/);
});
