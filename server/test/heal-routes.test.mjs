// The taps on a loop 2 card (lib/heal-routes.mjs) through the chat's real router and a
// real device store: who may tap, from where, how often, and what is reported. The loop
// behind it is a fake that records what it was asked (test/heal-missed.test.mjs tests
// the real one). Also the pieces around it: the route while the chat is off
// (routes.mjs), the alert words (lib/chat-events.mjs), ntfy's priority (notify.mjs),
// the standalone script check (lib/program-check.mjs) and server.mjs's wiring. Every
// name and host is invented; nothing touches :8322.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChatEnv } from './helpers/chat-env.mjs';
import { createChatRoutes } from '../lib/chat-routes.mjs';
import { createHealTaps, TAPS_PER_MINUTE } from '../lib/heal-routes.mjs';
import { chatEventLine, ALERTED_KINDS } from '../lib/chat-events.mjs';
import { LIMITED_KINDS } from '../lib/chat-alert-limit.mjs';
import { createHandler } from '../routes.mjs';
import { createCache } from '../cache.mjs';
import { sendAlert } from '../notify.mjs';
import { checkScript, vetPrograms } from '../lib/program-check.mjs';
import { createMissedRunLoops } from '../lib/heal-missed.mjs';
import { createHealRunner } from '../lib/heal-runner.mjs';
import { createHealLedger } from '../lib/heal-ledger.mjs';
import { readHealConfig, withMissedRuns } from '../lib/heal.mjs';
import { createAckStore } from '../acks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = 'jos.example.test';
const ORIGIN = `https://${HOST}`;
const PAGE = { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const ID = 'c0ffee'.repeat(5) + 'ab';

function fakeLoops() {
  const asked = [];
  return {
    asked,
    answer: null,
    async approve(id, action, by) { asked.push(['approve', id, action, by]); return this.answer ?? { status: 202, ok: true, name: 'Friday alert', action, checkBy: 1 }; },
    async decline(id, by) { asked.push(['decline', id, by]); return { status: 200, ok: true, name: 'Friday alert', action: 'not-now' }; }
  };
}

async function setup() {
  const env = await makeChatEnv();
  env.loops = fakeLoops();
  env.logs = [];
  const healTaps = createHealTaps({ loops: env.loops, now: env.now, onEvent: e => env.events.push(e), log: l => env.logs.push(l) });
  env.routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [HOST] }, now: env.now, onEvent: e => env.events.push(e), log: () => {}, pingMs: 60e3, healTaps });
  env.extra.push(async (req, res) => { await env.routes.handler(req, res); return true; });
  env.approver = async name => { const d = await env.pair(name); await env.devices.setApprover(d.id, true); return { ...d, name }; };
  env.post = (path, cookie, body = {}, headers = {}) => env.call({ method: 'POST', path, headers: { ...PAGE, cookie, ...headers }, body });
  env.taps = () => env.events.filter(e => e.kind === 'heal-tap');
  return env;
}

test('an approver device on the page taps Run it now, Ack and Not now; each is reported with the device and the job', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const run = await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'rerun-job' });
    assert.equal(run.status, 202, run.text);
    assert.deepEqual(run.json, { ok: true, name: 'Friday alert', action: 'rerun-job', checkBy: 1 });
    assert.equal(run.headers['cache-control'], 'no-store');
    assert.equal((await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'ack-until-next-run' })).status, 202);
    assert.equal((await env.post(`/api/loops/${ID}/decline`, dev.cookie)).status, 200);
    assert.deepEqual(env.loops.asked, [['approve', ID, 'rerun-job', 'iPhone'], ['approve', ID, 'ack-until-next-run', 'iPhone'], ['decline', ID, 'iPhone']]);
    assert.deepEqual(env.taps().map(e => [e.device, e.action, e.name]), [['iPhone', 'rerun-job', 'Friday alert'], ['iPhone', 'ack-until-next-run', 'Friday alert'], ['iPhone', 'not-now', 'Friday alert']]);
    assert.equal(chatEventLine(env.taps()[0]), 'a missed-run card was answered from iPhone: Run it now (Friday alert)');
    assert.ok(ALERTED_KINDS.includes('heal-tap'), 'a tap pushes like a verdict');
  } finally { await env.close(); }
});

test("the gate: the write guard, a Shortcut key, no device, a plain device, another origin, a cross-site fetch, http", async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const plain = await env.pair('iPad');
    const path = `/api/loops/${ID}/approve`;
    const body = { action: 'rerun-job' };
    const cases = [
      [await env.post(path, dev.cookie, body, { authorization: 'Bearer abc' }), 403, 'a Shortcut key never acts'],
      [await env.post(path, '', body), 401, 'no device'],
      [await env.post(path, plain.cookie, body), 403, 'approver devices only'],
      [await env.post(path, dev.cookie, body, { origin: 'https://evil.example', host: 'evil.example' }), 403, 'another origin'],
      [await env.post(path, dev.cookie, body, { origin: 'https://evil.example' }), 403, 'cross-origin'],
      [await env.post(path, dev.cookie, body, { 'sec-fetch-site': 'same-site' }), 403, 'cross-site fetch'],
      [await env.post(path, dev.cookie, body, { origin: `http://${HOST}` }), 403, 'not the https page'],
      [await env.call({ method: 'POST', path, headers: { host: HOST, 'sec-fetch-site': 'same-origin', cookie: dev.cookie }, body }), 403, 'no Origin: a script, not the page'],
      [await env.call({ method: 'POST', path, headers: { ...PAGE, cookie: dev.cookie, 'content-type': 'text/plain' }, body: Buffer.from('{}') }), 415, 'JSON only'],
      [await env.call({ method: 'GET', path, headers: { ...PAGE, cookie: dev.cookie } }), 404, 'POST only']
    ];
    for (const [r, status, what] of cases) assert.equal(r.status, status, `${what}: ${r.text}`);
    assert.deepEqual(env.loops.asked, [], 'no refused tap reached the loop');
    assert.deepEqual(env.taps(), []);
    // The key and the plain device are alerted (L5); the other refusals are only answered.
    const refused = env.events.filter(e => e.kind === 'heal-tap-refused');
    assert.deepEqual(refused.map(e => [e.why, e.device]), [['key', undefined], ['not-approver', 'iPad']]);
    assert.equal(chatEventLine(refused[0]), 'a tap on a heal card carried a Shortcut key and was refused');
    assert.equal(chatEventLine(refused[1]), 'a tap on a heal card from iPad was refused: that device is not marked approver');
    assert.ok(ALERTED_KINDS.includes('heal-tap-refused'));
    assert.ok(Object.hasOwn(LIMITED_KINDS, 'heal-tap-refused'), 'capped: at most one push per 10 minutes, the rest counted');
  } finally { await env.close(); }
});

test('the body names an action and nothing else; a bad id is no route; the loop answers the rest', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    for (const action of [undefined, 'mark-quiet', 'kickstart-kill', ['rerun-job'], 'RERUN-JOB']) {
      assert.equal((await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action })).status, 400, String(action));
    }
    // Bad bodies count toward the minute's taps too, so a loop of them is held.
    assert.equal((await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'nope' })).status, 400);
    assert.equal((await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'rerun-job' })).status, 429);
    env.clock.t += 60e3;
    for (const bad of ['short', ID.toUpperCase(), `${ID}0`, '../../todos']) {
      assert.equal((await env.post(`/api/loops/${bad}/approve`, dev.cookie, { action: 'rerun-job' })).status, 404, bad);
    }
    assert.equal((await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'rerun-job', label: 'com.example.other', args: ['-k'] })).status, 202, 'extra fields are ignored');
    assert.deepEqual(env.loops.asked.map(a => a.slice(0, 3)), [['approve', ID, 'rerun-job']], 'only the id and the action reach the loop');
    env.clock.t += 60e3;
    env.loops.answer = { status: 404, error: 'that card is no longer open' };
    const gone = await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'rerun-job' });
    assert.deepEqual([gone.status, gone.json.error], [404, 'that card is no longer open']);
    assert.equal(env.taps().length, 1, 'a refusal is logged, not alerted');
    assert.ok(env.logs.some(l => /refused \(404/.test(l)));
    const big = await env.post(`/api/loops/${ID}/approve`, dev.cookie, { action: 'rerun-job', pad: 'x'.repeat(2000) });
    assert.equal(big.status, 413);
  } finally { await env.close(); }
});

test(`at most ${TAPS_PER_MINUTE} taps a minute, from any device`, async () => {
  const env = await setup();
  try {
    const a = await env.approver('iPhone');
    const b = await env.approver('iPad');
    for (let i = 0; i < TAPS_PER_MINUTE; i++) assert.equal((await env.post(`/api/loops/${ID}/decline`, i % 2 ? a.cookie : b.cookie)).status, 200);
    assert.equal((await env.post(`/api/loops/${ID}/decline`, a.cookie)).status, 429);
    env.clock.t += 60e3;
    assert.equal((await env.post(`/api/loops/${ID}/decline`, a.cookie)).status, 200);
  } finally { await env.close(); }
});

test("the chat's router owns the taps but not the read; with the chat off a tap is refused", async () => {
  const taps = createHealTaps({ loops: fakeLoops() });
  assert.equal(taps.owns(`/api/loops/${ID}/approve`), true);
  assert.equal(taps.owns('/api/loops'), false);
  const h = createHandler({ cache: createCache(), todos: { readState: async () => ({ todos: [], revision: null }) }, config: { present: true } });
  const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.body = b ?? ''; } };
  await h({ method: 'POST', url: `/api/loops/${ID}/approve`, headers: { host: '127.0.0.1:8322', 'content-type': 'application/json' }, on() { return this; } }, res);
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error, /chat is off/);
});

test("sendAlert passes ntfy's priority; #pepper gets the words", async () => {
  const got = {};
  await sendAlert({ topic: 't', title: 'Control Room', message: 'm', priority: 'high', ntfy: async m => { got.ntfy = m; return { sent: true }; }, discord: async m => { got.discord = m; return { sent: true }; } });
  assert.equal(got.ntfy.priority, 'high');
  assert.deepEqual(got.discord, { title: 'Control Room', message: 'm', feed: 'pepper' });
  await sendAlert({ topic: 't', title: 'x', message: 'm', ntfy: async m => { got.plain = m; return { sent: true }; }, discord: async () => ({ sent: true }) });
  assert.equal(got.plain.priority, 'default');
});

test('a standalone script passes the ownership rule with no package beside it; a loose one does not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-script-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  const script = join(dir, 'missed-runs');
  await writeFile(script, '#!/usr/bin/python3\n', { mode: 0o700 });
  await chmod(script, 0o700);
  assert.deepEqual(await checkScript(script), { real: script.replace(/^\/var\//, '/private/var/'), problem: null });
  const settings = { missedRuns: script };
  assert.deepEqual(await vetPrograms([['heal.missedRuns', settings, 'missedRuns', { standalone: true }]]), []);
  assert.ok(settings.missedRuns.endsWith('/missed-runs'));
  const packaged = { missedRuns: script };
  const problems = await vetPrograms([['heal.missedRuns', packaged, 'missedRuns']]);
  assert.equal(problems.length, 1, 'the package rule still holds without the flag');
  assert.equal(packaged.missedRuns, null);
  await chmod(script, 0o720);
  assert.match((await checkScript(script)).problem, /other users/);
  assert.match((await checkScript(join(dir, 'nothing'))).problem, /could not be checked/);
});

test('server.mjs: loop 2 shares the ledger and the switch, runs the catalog program, and its taps go through the chat', async () => {
  const src = (await readFile(join(HERE, '..', 'server.mjs'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const wired = [
    [/vetPrograms\(\[\['heal\.missedRuns', healSettings, 'missedRuns', \{ standalone: true \}\]\]\)/, 'missed-runs is checked like job-status'],
    [/createMissedRunLoops\(\{\s*settings: healSettings,\s*ledger: healLedger,\s*status: \(\) => heal\.status\(\),\s*launchctlPrint: runLaunchctlPrint,\s*runProgram: \(entry, target\) => runCatalogProgram\(entry, target\),/, 'one ledger, one switch, the catalog program'],
    [/missedRuns: healSettings\.missedRuns \? \(\) => runMissedRuns\(healSettings\.missedRuns\) : null,/, 'the vetted path only'],
    [/addAck: \(ack, now\) => ackStore\.add\(ack, now\),/, 'the real ack store'],
    [/await missed\.pass\(out\);/, 'each crons pass'],
    [/const healTaps = createHealTaps\(\{ loops: \{ missed, restart: restartLoop \}, onEvent: chatEvents, log: line => console\.log\(oneLine\(line\)\) \}\);/, 'taps report through the chat events, one line each'],
    [/createChatRoutes\(\{[^}]*healTaps[, a-zA-Z]* \}\);/, 'behind the chat router']
  ];
  for (const [re, what] of wired) assert.ok(re.test(src), what);
  assert.ok(!/kickstart|execFile|spawn\(/.test(src), 'no launchctl write or program of its own in server.mjs');
});

test('the whole path on real routes: a card on GET /api/loops, a tap from the page, the program once, the run verified', async t => {
  const FIRE = new Date(2026, 10, 6, 16, 45).getTime();
  const NOW = new Date(2026, 10, 6, 17, 0).getTime();
  const L = 'com.example.friday';
  const pad = n => String(n).padStart(2, '0');
  const iso = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const env = await makeChatEnv({ start: NOW });
  const dir = await mkdtemp(join(tmpdir(), 'heal-path-'));
  t.after(async () => { await env.close(); await rm(dir, { recursive: true, force: true }); });
  const settings = readHealConfig({ heal: { enabled: true, targets: { friday: { label: L, actions: ['rerun-job', 'ack-until-next-run'] } } } });
  const ledger = createHealLedger({ path: join(dir, 'heals.json'), now: env.now });
  const runs = { n: 5, running: false };
  const print = async () => `x = {\n\tstate = ${runs.running ? 'running' : 'not running'}\n\truns = ${runs.n}\n\tlast exit code = 0\n}`;
  const heal = createHealRunner({ settings, ledger, launchctlPrint: print, now: env.now, log: () => {} });
  await heal.load();
  const programs = [];
  const acks = createAckStore(join(dir, 'acks.json'));
  const missed = createMissedRunLoops({
    settings, ledger, status: () => heal.status(), launchctlPrint: print,
    runProgram: async (entry, target) => { programs.push([entry.program.file, entry.program.args, target]); runs.n++; runs.running = true; },
    missedRuns: async () => ({ jobs: [{ label: L, loaded: true, last_run: iso(FIRE - 7 * 864e5), result: { missed: [{ at: iso(FIRE), why: 'restart' }], unresolved: true } }], needs_look: [L] }),
    addAck: (a, now) => acks.add(a, now), jobNames: { [L]: { name: 'Friday alert' } }, now: env.now, log: () => {}, notify: async () => ({ sent: true }), autoScan: false
  });
  const routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [HOST] }, now: env.now, onEvent: e => env.events.push(e), log: () => {}, pingMs: 60e3, healTaps: createHealTaps({ loops: missed, now: env.now, onEvent: e => env.events.push(e), log: () => {} }) });
  const api = createHandler({ cache: createCache(), todos: { readState: async () => ({ todos: [], revision: null }) }, config: { present: true }, acks, loops: () => withMissedRuns(heal.view(), missed.view()) });
  env.extra.push(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (routes.owns(path)) await routes.handler(req, res);
    else await api(req, res);
    return true;
  });
  const cronsNow = [{ name: 'friday', label: L, ok: true, state: 'ok', lastRunAt: FIRE - 7 * 864e5, nextRunAt: FIRE + 7 * 864e5 }];
  await missed.scan();
  await missed.pass(cronsNow);
  const loops = (await env.call({ method: 'GET', path: '/api/loops' })).json;
  assert.equal(loops.proposals.length, 1);
  assert.equal(loops.open[0].waiting, true);
  assert.ok(!JSON.stringify(loops).includes('com.example'), 'no label on the page');
  const dash = (await env.call({ method: 'GET', path: '/api/dashboard' })).json;
  assert.equal(dash.loops.proposals[0].id, loops.proposals[0].id, 'the dashboard carries the same view');
  const d = await env.pair('iPhone');
  await env.devices.setApprover(d.id, true);
  const tap = await env.call({ method: 'POST', path: `/api/loops/${loops.proposals[0].id}/approve`, headers: { ...PAGE, cookie: d.cookie }, body: { action: 'rerun-job' } });
  assert.equal(tap.status, 202, tap.text);
  assert.deepEqual(programs, [['/bin/launchctl', ['kickstart', 'gui/{uid}/{label}'], { uid: process.getuid(), label: L }]]);
  const again = await env.call({ method: 'POST', path: `/api/loops/${loops.proposals[0].id}/approve`, headers: { ...PAGE, cookie: d.cookie }, body: { action: 'rerun-job' } });
  assert.equal(again.status, 404, 'the id was spent');
  assert.equal(programs.length, 1);
  runs.running = false;
  env.clock.t += 60e3;
  await missed.pass(cronsNow);
  const after = (await env.call({ method: 'GET', path: '/api/loops' })).json;
  assert.deepEqual([after.proposals.length, after.open.length, after.recent[0].words], [0, 0, 'ran it again, clean']);
  assert.deepEqual(env.events.filter(e => e.kind === 'heal-tap').map(e => e.device), ['iPhone']);
  assert.deepEqual(await acks.read(env.now()), [], 'Run it now acks nothing');
});

test('a tap\'s log line stays one line, whatever the device is called (L3)', async () => {
  const lines = [];
  const name = `iPhone${String.fromCodePoint(0x0a)}heal: forged line`;
  const taps = createHealTaps({ loops: fakeLoops(), log: l => lines.push(l) });
  const res = { status: 0, headers: {}, body: '', headersSent: false, writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; }, end(b) { this.body = b ?? ''; } };
  const { Readable } = await import('node:stream');
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ action: 'rerun-job' }))]), { method: 'POST', url: `/api/loops/${ID}/approve`, headers: { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } });
  await taps.handle(req, res, `/api/loops/${ID}/approve`, { requireDevice: () => ({ name, approver: true }), requireLogin: () => {}, notifyHosts: new Set([HOST]) });
  assert.equal(res.status, 202);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(String.fromCodePoint(0x0a)), 'no line break reaches the log');
  assert.match(lines[0], /U\+000A/);
});

// ---- loop 3's taps (lib/heal-restart.mjs) and the key refusal's order (board fe4d2bfe) ----

function fakeRestart(id) {
  const asked = [];
  return {
    asked,
    has: x => x === id,
    async approve(x, action, by) { asked.push(['approve', x, action, by]); return { status: 202, ok: true, name: 'Control Room', action, card: 'restart-due', from: 'a1a1a1a', to: 'b2b2b2b', checkBy: 1 }; },
    async decline(x, by) { asked.push(['decline', x, by]); return { status: 200, ok: true, name: 'Control Room', action: 'not-now', card: 'restart-due' }; }
  };
}

test("Restart goes to loop 3, Not now to the loop whose card it is; the alert says it was a restart card", async () => {
  const env = await makeChatEnv();
  const RID = 'beef'.repeat(8);
  const missed = fakeLoops();
  const restart = fakeRestart(RID);
  const healTaps = createHealTaps({ loops: { missed, restart }, now: env.now, onEvent: e => env.events.push(e), log: () => {} });
  const routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [HOST] }, now: env.now, onEvent: e => env.events.push(e), log: () => {}, pingMs: 60e3, healTaps });
  env.extra.push(async (req, res) => { await routes.handler(req, res); return true; });
  try {
    const d = await env.pair('iPhone');
    await env.devices.setApprover(d.id, true);
    const post = (path, body) => env.call({ method: 'POST', path, headers: { ...PAGE, cookie: d.cookie }, body });
    const r = await post(`/api/loops/${RID}/approve`, { action: 'restart-control-room' });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json, { ok: true, name: 'Control Room', action: 'restart-control-room', card: 'restart-due', from: 'a1a1a1a', to: 'b2b2b2b', checkBy: 1 });
    assert.equal((await post(`/api/loops/${RID}/decline`, {})).status, 200);
    assert.equal((await post(`/api/loops/${ID}/decline`, {})).status, 200);
    assert.equal((await post(`/api/loops/${ID}/approve`, { action: 'rerun-job' })).status, 202);
    assert.deepEqual(restart.asked, [['approve', RID, 'restart-control-room', 'iPhone'], ['decline', RID, 'iPhone']]);
    assert.deepEqual(missed.asked, [['decline', ID, 'iPhone'], ['approve', ID, 'rerun-job', 'iPhone']]);
    const taps = env.events.filter(e => e.kind === 'heal-tap');
    assert.equal(chatEventLine(taps[0]), 'a restart card was answered from iPhone: Restart (Control Room)');
    assert.equal(chatEventLine(taps[1]), 'a restart card was answered from iPhone: Not now (Control Room)');
    assert.equal(chatEventLine(taps[2]), 'a missed-run card was answered from iPhone: Not now (Friday alert)');
    // With no loop 3 on the server, Restart finds no card.
    const only = createHealTaps({ loops: { missed }, onEvent: () => {}, log: () => {} });
    const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.body = b ?? ''; } };
    const { Readable } = await import('node:stream');
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ action: 'restart-control-room' }))]), { method: 'POST', url: `/api/loops/${RID}/approve`, headers: { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } });
    await only.handle(req, res, `/api/loops/${RID}/approve`, { requireDevice: () => ({ name: 'iPhone', approver: true }), requireLogin: () => {}, notifyHosts: new Set([HOST]) });
    assert.equal(res.status, 404);
  } finally { await env.close(); }
});

test("a Shortcut key's refusal is alerted only from the owner's login (fe4d2bfe); anyone else is refused unalerted", async () => {
  const env = await makeChatEnv();
  const routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [HOST], chat: { login: 'owner@example.test' } }, now: env.now, onEvent: e => env.events.push(e), log: () => {}, pingMs: 60e3, healTaps: createHealTaps({ loops: fakeLoops(), now: env.now, onEvent: e => env.events.push(e), log: () => {} }) });
  env.extra.push(async (req, res) => { await routes.handler(req, res); return true; });
  try {
    const path = `/api/loops/${ID}/approve`;
    const call = headers => env.call({ method: 'POST', path, headers: { ...PAGE, authorization: 'Bearer abc', ...headers }, body: { action: 'rerun-job' } });
    for (const login of [undefined, 'someone@example.test', '']) {
      const r = await call(login === undefined ? {} : { 'tailscale-user-login': login });
      assert.equal(r.status, 403, String(login));
      assert.match(r.json.error, /owner through the tailnet/);
    }
    assert.deepEqual(env.events.filter(e => e.kind === 'heal-tap-refused'), [], 'no push for a caller that is not the owner');
    const owner = await call({ 'tailscale-user-login': 'Owner@example.test' });
    assert.equal(owner.status, 403);
    assert.match(owner.json.error, /Shortcut key/);
    assert.deepEqual(env.events.filter(e => e.kind === 'heal-tap-refused').map(e => e.why), ['key']);
  } finally { await env.close(); }
});

test('L10: the heal routes refuse to run without the login check', async () => {
  const taps = createHealTaps({ loops: fakeLoops(), onEvent: () => {}, log: () => {} });
  const req = { method: 'POST', url: `/api/loops/${ID}/approve`, headers: { host: HOST, origin: ORIGIN, authorization: 'Bearer abc' } };
  for (const requireLogin of [undefined, null, 'yes']) {
    await assert.rejects(taps.handle(req, {}, `/api/loops/${ID}/approve`, { requireDevice: () => ({ name: 'x', approver: true }), requireLogin, notifyHosts: new Set([HOST]) }), /need the login check/);
  }
});
