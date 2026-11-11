// Who may say hello after a bye (lib/chat-verify.mjs and its use in lib/chat-socket.mjs;
// Ultron's channel-fixes review, findings 1 and 5). ps and launch.json are always fakes
// or temp files here: nothing reads the real process table's owner or
// ~/.local/state/jarvis-os. Every path, pid and name is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile, symlink, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createChatStore } from '../lib/chat-store.mjs';
import { createSocketRouter, SESSION_HEADER, BYE_SILENCE_MS, BYE_START_SLACK_MS } from '../lib/chat-socket.mjs';
import { readChannelServer, parsePs, parseLstart, isChannelCommand, readLaunchPid, createChannelVerifier, MAX_HOPS, PS_ARGS } from '../lib/chat-verify.mjs';

const SERVER = '/srv/release/jarvis-local/plugins/jarvis-channel/server.mjs';
// ps's lstart for a local moment, as the C locale prints it: `Wed Nov 11 09:14:03 2026`
// (the day of the month padded with a space). Local, so the suite reads the same in Tokyo.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = n => String(n).padStart(2, '0');
const lstart = at => { const d = new Date(at); return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`; };
const BOOT = new Date(2026, 10, 1, 8, 0, 0).getTime();
const CHANNEL_START = new Date(2026, 10, 11, 9, 14, 3).getTime();
// launcher 500 -> shell 510 -> claude 520 -> channel 530; a stranger 900 under 1.
const PS = [
  `    1     0 ${lstart(BOOT)} /sbin/launchd`,
  `  500     1 ${lstart(BOOT)} /bin/zsh /srv/bin/lead-start`,
  `  510   500 ${lstart(BOOT)} tmux new-session`,
  `  520   510 ${lstart(BOOT)} claude --channels plugin:jarvis-channel@jarvis-local`,
  `  530   520 ${lstart(CHANNEL_START)} /opt/homebrew/bin/node ${SERVER}`,
  `  900     1 ${lstart(CHANNEL_START)} node ${SERVER}`,
  `  910     1 ${lstart(CHANNEL_START)} python3 ${SERVER}`,
  `  920   520 ${lstart(CHANNEL_START)} node --inspect ${SERVER}`,
  `  930   520 Xyz Nov 11 09:14:03 2026 node ${SERVER}`,
  ''
].join('\n');

test('config: chat.channelServer is an absolute path to server.mjs, plain characters only', () => {
  assert.deepEqual(readChannelServer({ chat: { channelServer: SERVER } }), { path: SERVER, problems: [] });
  assert.equal(readChannelServer({ chat: {} }).problems.length, 1, 'unset with the chat configured is a problem');
  assert.deepEqual(readChannelServer({}), { path: null, problems: [] }, 'no chat, nothing to say');
  for (const bad of ['relative/server.mjs', '/a/b/other.mjs', '/a b/server.mjs', '/a/$(x)/server.mjs', 7]) {
    assert.equal(readChannelServer({ chat: { channelServer: bad } }).path, null, String(bad));
  }
});

test('ps parsing and the exact `node <server>` command', () => {
  const t = parsePs(PS);
  assert.deepEqual(t.get(530), { ppid: 520, startedAt: CHANNEL_START, command: `/opt/homebrew/bin/node ${SERVER}` });
  assert.equal(t.has(930), false, 'a line whose lstart is not one is left out');
  assert.ok(PS_ARGS.includes('pid=,ppid=,lstart=,command='), 'one fixed argv, lstart included');
  assert.equal(isChannelCommand(`/opt/homebrew/bin/node ${SERVER}`, SERVER), true);
  assert.equal(isChannelCommand(`node ${SERVER}`, SERVER), true);
  assert.equal(isChannelCommand(`python3 ${SERVER}`, SERVER), false);
  assert.equal(isChannelCommand(`node --inspect ${SERVER}`, SERVER), false, 'no extra arguments');
  assert.equal(isChannelCommand(`node ${SERVER} --x`, SERVER), false);
  assert.equal(isChannelCommand(`node /other${SERVER}`, SERVER), false);
  assert.equal(isChannelCommand(`/tmp/nodex ${SERVER}`, SERVER), false);
  assert.equal(isChannelCommand(SERVER, SERVER), false);
  assert.equal(isChannelCommand(`evil /usr/bin/node ${SERVER}`, SERVER), false, 'one executable, nothing before it');
});

test('lstart: local time, single-digit days padded, impossible dates and wrong weekdays refused', () => {
  assert.equal(parseLstart('Wed', 'Nov', '11', '09', '14', '03', '2026'), CHANNEL_START);
  const first = new Date(2026, 10, 1, 0, 0, 7).getTime();
  const m = parsePs(`  77   1 ${lstart(first)} node x`).get(77);
  assert.equal(m.startedAt, first, 'Sun Nov  1 (two spaces) parses');
  assert.equal(parseLstart('Thu', 'Nov', '11', '09', '14', '03', '2026'), null, 'Nov 11 2026 is a Wednesday');
  assert.equal(parseLstart('Mon', 'Feb', '30', '09', '14', '03', '2026'), null);
  assert.equal(parseLstart('Wed', 'Foo', '11', '09', '14', '03', '2026'), null);
  assert.equal(parseLstart('Wed', 'Nov', '11', '25', '14', '03', '2026'), null);
});

test('launch.json: a regular 0600 file of this user\'s, opened without following a symlink, with a pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-verify-'));
  try {
    const good = join(dir, 'launch.json');
    await writeFile(good, JSON.stringify({ pid: 500 }), { mode: 0o600 });
    assert.deepEqual(await readLaunchPid(good), { pid: 500, reason: null });
    const link = join(dir, 'link.json');
    await symlink(good, link);
    assert.equal((await readLaunchPid(link)).reason, 'launch.json is a symlink');
    const loose = join(dir, 'loose.json');
    await writeFile(loose, JSON.stringify({ pid: 500 }), { mode: 0o644 });
    await chmod(loose, 0o644);
    assert.equal((await readLaunchPid(loose)).pid, null);
    const folder = join(dir, 'folder.json');
    await mkdir(folder, { mode: 0o700 });
    assert.equal((await readLaunchPid(folder)).pid, null);
    const fifo = join(dir, 'fifo.json');
    execFileSync('/usr/bin/mkfifo', ['-m', '600', fifo]);
    const t0 = Date.now();
    assert.equal((await readLaunchPid(fifo)).reason, 'launch.json is not a regular file');
    assert.ok(Date.now() - t0 < 1000, 'a FIFO does not hang the open');
    for (const [name, body] of [['bad.json', '{pid'], ['nopid.json', '{}'], ['one.json', '{"pid":1}'], ['str.json', '{"pid":"500"}']]) {
      await writeFile(join(dir, name), body, { mode: 0o600 });
      assert.equal((await readLaunchPid(join(dir, name))).pid, null, name);
    }
    assert.equal((await readLaunchPid(join(dir, 'missing.json'))).pid, null);
    assert.equal((await readLaunchPid(good, { uid: 4242 })).reason, 'launch.json is not this user\'s');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the verifier: alive, the released channel, and under the launch; anything else is refused with a fixed reason', async () => {
  const v = (opts = {}) => createChannelVerifier({ channelServer: SERVER, launchPath: '/x', ps: async () => PS, readLaunch: async () => ({ pid: 500 }), ...opts });
  assert.deepEqual(await v()(530), { ok: true });
  // After a bye: started no earlier than notBefore.
  assert.deepEqual(await v()(530, { notBefore: CHANNEL_START }), { ok: true });
  assert.equal((await v()(530, { notBefore: CHANNEL_START + 1000 })).reason, 'the process started before the bye');
  assert.equal((await v({ ps: async () => PS.replace(lstart(CHANNEL_START) + ' /opt', 'Xyz Nov 11 09:14:03 2026 /opt') })(530, {})).reason, 'no such process', 'an unreadable line is no process');
  assert.equal((await v()(999)).reason, 'no such process');
  assert.equal((await v()(910)).reason, 'the process is not the released channel');
  assert.equal((await v()(920)).reason, 'the process is not the released channel');
  assert.equal((await v()(900)).reason, 'the process does not descend from the lead\'s launch', 'right command, wrong parent');
  assert.equal((await v({ ps: async () => { throw new Error('boom'); } })(530)).reason, 'ps failed');
  assert.equal((await v({ readLaunch: async () => ({ pid: null, reason: 'launch.json is a symlink' }) })(530)).reason, 'launch.json is a symlink');
  assert.equal((await v({ readLaunch: async () => { throw new Error('x'); } })(530)).reason, 'launch.json could not be read');
  assert.equal((await v({ channelServer: null })(530)).reason, 'chat.channelServer is not set');
  assert.equal((await v()(null)).reason, 'the hello named no pid');
  // The launch more than MAX_HOPS parents up is too far.
  const chain = [`  100     1 ${lstart(BOOT)} launcher`];
  for (let i = 0; i < MAX_HOPS; i++) chain.push(`  ${101 + i}   ${100 + i} ${lstart(BOOT)} sh`);
  chain.push(`  300   ${100 + MAX_HOPS} ${lstart(BOOT)} node ${SERVER}`);
  const far = createChannelVerifier({ channelServer: SERVER, launchPath: '/x', ps: async () => chain.join('\n'), readLaunch: async () => ({ pid: 100 }) });
  assert.equal((await far(300)).ok, false);
  const near = createChannelVerifier({ channelServer: SERVER, launchPath: '/x', ps: async () => chain.join('\n'), readLaunch: async () => ({ pid: 101 }) });
  assert.equal((await near(300)).ok, true, `${MAX_HOPS} hops is within reach`);
});

// ---- on the socket ----

const call = ({ socketPath, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({ socketPath, method, path, headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

async function setup(router = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-vsock-'));
  const clock = { t: 1794380000000 };
  const events = [], logs = [], timers = [], asked = [];
  const store = createChatStore({ dir: join(dir, 'chat'), now: () => clock.t });
  await store.load();
  const verdicts = { next: { ok: true } };
  const socket = createSocketRouter({
    store, now: () => clock.t, onEvent: e => events.push(e), log: l => logs.push(l), pingMs: 60e3,
    verifyRestart: async pid => { asked.push(pid); return verdicts.next; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { t.cleared = true; },
    ...router
  });
  const socketPath = join(dir, 'v.sock');
  const srv = createServer((req, res) => socket.handler(req, res));
  await new Promise(r => srv.listen(socketPath, r));
  const env = { dir, clock, events, logs, timers, asked, verdicts, store, socketPath };
  env.hello = (pid, token) => call({ socketPath, method: 'POST', path: '/v1/hello', headers: token ? { [SESSION_HEADER]: token } : {}, body: { pid } });
  env.bye = token => call({ socketPath, method: 'POST', path: '/v1/bye', headers: { [SESSION_HEADER]: token } });
  env.notices = () => store.list({ after: 0, limit: 100 }).filter(m => m.kind === 'notice');
  env.done = async () => { await new Promise(r => srv.close(r)); await rm(dir, { recursive: true, force: true }); };
  return env;
}

test('a hello after a bye is checked: refused with 409 and alerted as an unverified takeover, no notice; the real channel then gets in', async () => {
  const env = await setup();
  try {
    const first = await env.hello(530);
    assert.equal(first.status, 200);
    assert.deepEqual(env.asked, [], 'a hello with no bye before it is not checked');
    await env.bye(first.json.token);
    env.verdicts.next = { ok: false, reason: 'the process is not the released channel' };
    const intruder = await env.hello(900);
    assert.equal(intruder.status, 409);
    assert.equal(intruder.json.token, undefined);
    assert.deepEqual(env.asked, [900], 'the declared pid is the one checked');
    const alert = env.events.find(e => e.kind === 'client-replaced');
    assert.equal(alert.unverified, 'the process is not the released channel');
    assert.equal(env.notices().length, 0, 'no quiet restart notice');
    assert.ok(env.logs.some(l => /a hello after the bye was refused/.test(l)));
    // The place stays free for the real channel, which is still checked.
    env.verdicts.next = { ok: true };
    const back = await env.hello(531);
    assert.equal(back.status, 200);
    assert.deepEqual(env.asked, [900, 531]);
    assert.equal(env.notices().length, 1, 'the real restart is noted');
    // A verifier that throws fails closed too.
    await env.bye(back.json.token);
    const throwing = await setup({ verifyRestart: async () => { throw new Error('x'); } });
    try {
      const h = await throwing.hello(530);
      await throwing.bye(h.json.token);
      assert.equal((await throwing.hello(531)).status, 409);
      assert.equal(throwing.events.find(e => e.kind === 'client-replaced').unverified, 'the check failed');
    } finally { await throwing.done(); }
  } finally { await env.done(); }
});

test('without a verifier, every hello after a bye is refused', async () => {
  const env = await setup({ verifyRestart: undefined });
  try {
    const h = await env.hello(530);
    await env.bye(h.json.token);
    assert.equal((await env.hello(531)).status, 409);
  } finally { await env.done(); }
});

test('two hellos after a bye are taken one at a time: the slow check can\'t be raced', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const env = await setup({ verifyRestart: async () => { await gate; return { ok: true }; } });
  try {
    const h = await env.hello(530);
    await env.bye(h.json.token);
    const a = env.hello(531);
    const b = env.hello(532);
    await new Promise(r => setTimeout(r, 20));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
    assert.ok(env.events.some(e => e.kind === 'client-refused'), 'the second met a fresh holder');
  } finally { await env.done(); }
});

test('a bye with no hello within 2 minutes is alerted once; a hello in time cancels it', async () => {
  const env = await setup();
  try {
    const h = await env.hello(530);
    await env.bye(h.json.token);
    assert.equal(env.timers.length, 1);
    assert.equal(env.timers[0].ms, BYE_SILENCE_MS);
    env.timers[0].fn();
    assert.deepEqual(env.events.filter(e => e.kind === 'channel-silent'), [{ kind: 'channel-silent', after: BYE_SILENCE_MS }]);
    // A refused hello is not a hello: the next bye's timer still fires.
    const back = await env.hello(531);
    await env.bye(back.json.token);
    env.verdicts.next = { ok: false, reason: 'no such process' };
    await env.hello(999);
    env.timers[1].fn();
    assert.equal(env.events.filter(e => e.kind === 'channel-silent').length, 2);
    // In time: cancelled, and a late fire says nothing.
    env.verdicts.next = { ok: true };
    const again = await env.hello(532);
    await env.bye(again.json.token);
    await env.hello(533);
    assert.equal(env.timers[2].cleared, true);
    env.timers[2].fn();
    assert.equal(env.events.filter(e => e.kind === 'channel-silent').length, 2);
  } finally { await env.done(); }
});

test('after a bye: the pid that said bye is refused before any check; the check gets notBefore = bye - 2 s', async () => {
  const seen = [];
  const env = await setup({ verifyRestart: async (pid, opts) => { seen.push([pid, opts]); return { ok: true }; } });
  try {
    const h = await env.hello(530);
    assert.deepEqual(seen, [], 'the first hello is not checked without verifyEveryHello');
    env.clock.t += 5000;
    const byeAt = env.clock.t;
    await env.bye(h.json.token);
    env.clock.t += 1000;
    const same = await env.hello(530);
    assert.equal(same.status, 409);
    assert.equal(env.events.find(e => e.kind === 'client-replaced').unverified, 'the pid that said bye');
    assert.deepEqual(seen, [], 'refused before ps is asked');
    assert.equal((await env.hello(531)).status, 200);
    assert.deepEqual(seen, [[531, { notBefore: byeAt - BYE_START_SLACK_MS }]]);
  } finally { await env.done(); }
});

test('the real verifier end to end on the socket: a SIGSTOPped old channel (started before the bye) is refused; a new one is let in', async () => {
  const byeAt = CHANNEL_START + 60e3;
  const table = [PS.trimEnd(), `  540   520 ${lstart(byeAt - 1000)} node ${SERVER}`, ''].join('\n');
  const verify = createChannelVerifier({ channelServer: SERVER, launchPath: '/x', ps: async () => table, readLaunch: async () => ({ pid: 500 }) });
  const env = await setup({ verifyRestart: verify });
  try {
    env.clock.t = CHANNEL_START + 1000;
    const h = await env.hello(530);
    env.clock.t = byeAt;
    await env.bye(h.json.token);
    // A same-user process names the old channel 520's other child, started long before.
    const old = await env.hello(920);
    assert.equal(old.status, 409);
    // 530 itself is refused as the pid that said bye; a channel started 1 s before the bye passes.
    assert.equal((await env.hello(530)).status, 409);
    assert.equal((await env.hello(540)).status, 200);
  } finally { await env.done(); }
});

test('with verifyEveryHello, a first hello and a stale takeover are checked too (no start-time rule); the holder\'s own re-hello is not', async () => {
  const seen = [];
  let ok = false;
  const env = await setup({ verifyEveryHello: true, verifyRestart: async (pid, opts) => { seen.push([pid, opts]); return ok ? { ok: true } : { ok: false, reason: 'no such process' }; } });
  try {
    const refused = await env.hello(530);
    assert.equal(refused.status, 409, 'the first hello after a start is checked');
    assert.deepEqual(seen, [[530, { notBefore: null }]]);
    assert.equal(env.events.at(-1).unverified, 'no such process');
    ok = true;
    const h = await env.hello(530);
    assert.equal(h.status, 200);
    const again = await env.hello(530, h.json.token);
    assert.equal(again.status, 200);
    assert.equal(seen.length, 2, 'the holder\'s re-hello is not checked');
    // A takeover after a stale heartbeat is checked; refused, it raises no takeover alert.
    env.clock.t += 60e3;
    ok = false;
    const n = env.events.length;
    assert.equal((await env.hello(777)).status, 409);
    assert.deepEqual(env.events.slice(n).map(e => [e.kind, e.unverified ?? null]), [['client-replaced', 'no such process']]);
    assert.ok(!env.logs.some(l => /replaced after a stale heartbeat/.test(l)), 'no takeover logged for a refused hello');
  } finally { await env.done(); }
});
