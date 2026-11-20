// Restart Jarvis with Face ID (board 98a30b15; lib/jarvis-recover.mjs): the routes, the
// one fixed program, the run's result, its limits and its ledger, and the line that
// brings him back in every Jarvis-down alert (lib/recover-command.mjs). A software
// authenticator stands in for Face ID, as in agent-stop.test.mjs; a fake spawn stands in
// for the script, except in the one test that runs a scratch script for real. Every name
// and host is invented; nothing touches :8322, data/ or the real jarvis-recover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync, readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, readdir, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { makeChatEnv } from './helpers/chat-env.mjs';
import { createStepUp } from '../lib/stepup.mjs';
import { createAgentStop } from '../lib/agent-stop.mjs';
import { createChatRoutes } from '../lib/chat-routes.mjs';
import {
  createRecover, readRecoverConfig, recoverProgram, recoverEnv, lastLine, cleanLine, verdictOf, publicRun, leadHealth, runsAtRisk, missingConfirm,
  UNSEEN, STOP_RUNS_MAX, RECOVER_COMMAND, RECOVER_LINE, CRASHED_START_LINE, STOP_FLAG_PARTS, PURPOSE, RUNS_PER_HOUR, RUNS_PER_DAY, NO_ANSWER_MS, NO_ANSWER_LINE, LINE_MAX, KEEP_OUTS, HOUR_MS, KILL_FILE, ROUTES
} from '../lib/jarvis-recover.mjs';
import { pushableFrom, LEAD_DOWN_WORDS } from '../lib/push-alerts.mjs';
import { alertPayload, ALERT_PAYLOAD_MAX } from '../lib/chat-push.mjs';
import { createLocalAlerts, checkLocalAlert } from '../lib/local-alerts.mjs';
import { chatEventLine, ALERTED_KINDS } from '../lib/chat-events.mjs';
import { LIMITED_KINDS } from '../lib/chat-alert-limit.mjs';
import { RECOVER_NTFY_LINE } from '../lib/recover-command.mjs';
import { entryAlert, sendAlert } from '../notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = 'jos.example.test';
const ORIGIN = `https://${HOST}`;
const PAGE = { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const HOME = '/Users/someone';
const SCRIPT = `${HOME}/Projects/.worktrees/jarvis-release/bin/jarvis-recover`;
const MIN = 60e3;
// An invented roster: the lead first, as config's roster lists him.
const ROSTER = { agents: [{ key: 'lead', name: 'Jarvis' }, { key: 'vision', name: 'Vision' }, { key: 'ultron', name: 'Ultron' }] };
const sha = b => createHash('sha256').update(b).digest();
const b64u = b => Buffer.from(b).toString('base64url');

// A software platform authenticator (agent-stop.test.mjs has the same).
function authenticator({ rpId = HOST, flags = 0x05 } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = Buffer.from('cred-' + Math.random().toString(16).slice(2));
  const a = { flags, counter: 0, rpId, credId, spki: publicKey.export({ format: 'der', type: 'spki' }) };
  const head = (fl, n) => { const h = Buffer.alloc(37); sha(Buffer.from(a.rpId)).copy(h, 0); h[32] = fl; h.writeUInt32BE(n, 33); return h; };
  a.create = ({ challenge }) => {
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN }));
    const len = Buffer.alloc(2); len.writeUInt16BE(a.credId.length);
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, 'base64url'), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, 'base64url')]);
    const authData = Buffer.concat([head(a.flags | 0x40, a.counter), Buffer.alloc(16), len, a.credId, cose]);
    return { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), publicKey: b64u(a.spki), credentialId: b64u(a.credId) };
  };
  a.get = ({ challenge, fl = a.flags, n = ++a.counter }) => {
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }));
    const authData = head(fl, n);
    const signature = sign('sha256', Buffer.concat([authData, sha(cd)]), { key: privateKey, dsaEncoding: 'der' });
    return { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), credentialId: b64u(a.credId) };
  };
  return a;
}

// A spawn that records its call and writes `output` to the run's file, as the script
// would. `child.end(code, signal)` ends it; `throws` makes spawn itself throw.
function fakeSpawn() {
  const calls = [];
  const children = [];
  let nextPid = 4100;
  const spawn = (file, args, opts) => {
    if (spawn.throws) throw Object.assign(new Error('nope'), { code: 'EAGAIN' });
    // What the ledger held as the script started (the run must be there already).
    let ledger = null;
    try { ledger = JSON.parse(readFileSync(spawn.ledgerPath, 'utf8')); } catch { ledger = null; }
    calls.push({ file, args, opts, ledger });
    if (spawn.output !== undefined) writeSync(opts.stdio[1], spawn.output);
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.unref = () => { child.unrefd = true; };
    child.end = (code = 0, signal = null) => child.emit('exit', code, signal);
    children.push(child);
    return child;
  };
  spawn.calls = calls;
  spawn.children = children;
  spawn.output = 'fixed: removed the stop flag\nOK: Jarvis is back in full (Discord and Jarvis OS chat).\n';
  return spawn;
}

async function setup({ enabled = true, exists = true, recoverOpts = {}, routesConfig = {} } = {}) {
  const env = await makeChatEnv();
  const stepUp = createStepUp({ path: join(env.dir, 'passkeys.json'), now: env.now, onEvent: e => env.events.push(e) });
  await stepUp.load();
  env.spawn = fakeSpawn();
  env.logs = [];
  env.killed = false;
  env.alive = new Set();
  env.health = 'unknown';
  env.stopped = false;
  // The sessions panel as the cache gives it (lib/live-agents.mjs's block): current and empty.
  env.live = { status: 'ok', data: { liveAgents: { windowMs: 900e3, more: 0, runs: [] } } };
  env.chatDir = join(env.dir, 'chat');
  env.spawn.ledgerPath = join(env.chatDir, 'recover.json');
  env.makeRecover = (over = {}) => createRecover({
    home: HOME, dir: env.chatDir, stepUp, enabled, killed: () => env.killed, now: env.now, spawn: env.spawn,
    exists: async p => (typeof exists === 'function' ? exists(p) : exists), isAlive: pid => env.alive.has(pid),
    onEvent: e => env.events.push(e), log: l => env.logs.push(l), health: () => env.health, stopped: () => env.stopped, liveAgents: () => env.live, roster: ROSTER, env: { USER: 'someone', LOGNAME: 'someone', TMPDIR: '/tmp/x/', XPC_SERVICE_NAME: 'com.example.control-room', TMUX: '/tmp/tmux-1/default,1,0', SECRET_TOKEN: 'nope', LANG: 'en_GB.UTF-8' },
    ...recoverOpts, ...over
  });
  env.recover = env.makeRecover();
  await env.recover.load();
  const agentStop = createAgentStop({ stepUp, socket: { ...env.socket, stopsOk: () => true }, store: env.store, now: env.now, onEvent: e => env.events.push(e), log: () => {}, liveRuns: () => [] });
  env.routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [HOST], ...routesConfig }, now: env.now, onEvent: e => env.events.push(e), log: () => {}, pingMs: 60e3, agentStop, recover: env.recover });
  env.extra.push(async (req, res) => { await env.routes.handler(req, res); return true; });
  env.stepUp = stepUp;
  env.approver = async name => { const d = await env.pair(name); await env.devices.setApprover(d.id, true); return { ...d, name }; };
  env.post = (path, cookie, body = {}, headers = {}) => env.call({ method: 'POST', path, headers: { ...PAGE, cookie, ...headers }, body });
  env.get = (path, cookie, headers = {}) => env.call({ method: 'GET', path, headers: { host: HOST, cookie, ...headers } });
  env.enrol = async (dev, auth = authenticator()) => {
    const o = await env.post('/api/stepup/register/options', dev.cookie);
    assert.equal(o.status, 200, o.text);
    const r = await env.post('/api/stepup/register', dev.cookie, auth.create({ challenge: o.json.publicKey.challenge }));
    assert.equal(r.status, 200, r.text);
    const c = await stepUp.confirm(r.json.code, { name: dev.name, isApprover: id => env.devices.list().some(d => d.id === id && d.approver) });
    assert.equal(c.ok, true, c.error);
    return auth;
  };
  // Face ID, then the restart; `body` is merged into the Face ID answer, `ask` is the challenge's body.
  env.restart = async (dev, auth, body = {}, ask = {}) => {
    const c = await env.post(ROUTES.challenge, dev.cookie, ask);
    if (c.status !== 200) return c;
    return env.post(ROUTES.run, dev.cookie, { ...auth.get({ challenge: c.json.publicKey.challenge }), ...body });
  };
  env.status = dev => env.get(ROUTES.status, dev.cookie);
  // Until `done()` holds (a run's end reads its file, so it takes a few turns), then the ledger's writes.
  env.until = async (done, rec = env.recover) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5)); await rec.idle(); };
  env.settle = (rec = env.recover) => env.until(() => rec.view().running === null, rec);
  const close = env.close;
  env.close = async () => { env.recover.stop(); await close(); };
  return env;
}

// ---- the pure parts ----

test('config: recover.enabled true turns it on; anything else leaves it off, with a problem line', () => {
  assert.deepEqual(readRecoverConfig({}), { on: false, state: 'unset', problems: [] });
  assert.deepEqual(readRecoverConfig({ recover: { enabled: true } }), { on: true, state: 'on', problems: [] });
  assert.deepEqual(readRecoverConfig({ recover: { enabled: false } }), { on: false, state: 'off', problems: [] });
  assert.equal(readRecoverConfig({ recover: { enabled: 'yes' } }).on, false);
  assert.match(readRecoverConfig({ recover: { enabled: 'yes' } }).problems[0], /must be true or false/);
  assert.equal(readRecoverConfig({ recover: true }).on, false);
  assert.match(readRecoverConfig({ recover: [] }).problems[0], /not an object/);
  const extra = readRecoverConfig({ recover: { enabled: true, command: 'rm -rf ~' } });
  assert.equal(extra.on, true);
  assert.match(extra.problems[0], /recover\.command is not a setting/);
});

test('the program is fixed: /bin/bash, the release worktree\'s jarvis-recover, from ~/Projects; the line matches the run sheet\'s', () => {
  assert.deepEqual(recoverProgram(HOME), { file: '/bin/bash', args: [SCRIPT], cwd: `${HOME}/Projects` });
  assert.equal(RECOVER_COMMAND, 'cd ~/Projects && ~/Projects/.worktrees/jarvis-release/bin/jarvis-recover');
  assert.ok(RECOVER_LINE.endsWith(`: ${RECOVER_COMMAND}`));
  assert.match(RECOVER_LINE, /outside the jarvis tmux session/);
  assert.equal(PURPOSE, 'recover:jarvis');
});

test('the environment is built, never this server\'s: HOME, the restart job\'s PATH, LANG and four kept names; no XPC_SERVICE_NAME, TMUX or anything else', () => {
  const env = recoverEnv(HOME, { USER: 'someone', LOGNAME: 'someone', SHELL: '/bin/zsh', TMPDIR: '/tmp/x/', LANG: 'en_GB.UTF-8', XPC_SERVICE_NAME: 'com.example.control-room', TMUX: 'x', TMUX_PANE: '%1', NODE_OPTIONS: '--inspect', SECRET_TOKEN: 's', PATH: '/evil' });
  assert.deepEqual(env, {
    HOME, PATH: `${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_GB.UTF-8', xcrun_nocache: '1',
    USER: 'someone', LOGNAME: 'someone', SHELL: '/bin/zsh', TMPDIR: '/tmp/x/'
  });
  assert.equal(recoverEnv(HOME, {}).LANG, 'en_US.UTF-8');
  assert.equal(recoverEnv(HOME, { USER: '' }).USER, undefined);
});

test('the last line, cleaned: the last one with text; one line, capped, hidden characters marked, a credential withheld by name', () => {
  assert.equal(lastLine('a\nfixed: x\nOK: back.\n\n  \n'), 'OK: back.');
  assert.equal(lastLine('one\r\nNOT OK: two  \r\n'), 'NOT OK: two');
  assert.equal(lastLine(''), '');
  assert.equal(lastLine('\n \n'), '');
  const long = 'NOT OK: ' + 'x'.repeat(LINE_MAX * 2);
  assert.ok([...cleanLine(long)].length <= LINE_MAX + 20);
  assert.match(cleanLine(long), /more cut$/);
  const rlo = String.fromCodePoint(0x202e);
  assert.equal(cleanLine(`OK: a${rlo}b`), 'OK: a⟦U+202E⟧b');
  const key = `NOT OK: sk-ant-${'a'.repeat(30)}`;
  const shown = cleanLine(key);
  assert.ok(!shown.includes('sk-ant-'), 'never the match');
  assert.match(shown, /withheld: it looked like an Anthropic key/);
});

test('the verdict: the script\'s words first, then how it ended', () => {
  const rows = [
    ['OK: Jarvis is back in full (Discord and Jarvis OS chat).', 0, null, 'ok'],
    ['OK, degraded: Jarvis is back with Discord, but without Jarvis OS chat: x.', 0, null, 'degraded'],
    ['NOT OK: the Claude login lapsed.', 1, null, 'not-ok'],
    ['NOT OK: anything', 0, null, 'not-ok'],
    ['OK: back', 1, null, 'not-ok'],
    ['OK, degraded: up', 2, null, 'not-ok'],
    ['OK: back', null, null, 'ok'],
    ['OK: back', null, 'SIGTERM', 'not-ok'],
    ['bash: line 1: no such file', 127, null, 'not-ok'],
    ['something else', 0, null, 'unknown'],
    ['', null, null, 'unknown'],
    ['  OK: indented is not a verdict', 0, null, 'unknown']
  ];
  for (const [line, exit, signal, want] of rows) assert.equal(verdictOf(line, exit, signal), want, `${line} / ${exit} / ${signal}`);
  assert.equal(publicRun(null), null);
  assert.deepEqual(Object.keys(publicRun({ id: 'a', by: 'b', startedAt: 1, pid: 9, verdict: 'ok', line: 'x' })).sort(), ['by', 'exit', 'finishedAt', 'id', 'line', 'startedAt', 'verdict']);
});

// ---- the routes ----

test('a restart with Face ID from an approver runs the one fixed program, detached, stdin closed, output to a 0600 file; the result shows in the status', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    let s = await env.status(dev);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual([s.json.on, s.json.passkey, s.json.running, s.json.last, s.json.blocked, s.json.command], [true, true, null, null, null, RECOVER_COMMAND]);
    assert.deepEqual(s.json.jarvis, { health: 'unknown', stopped: false });
    assert.equal(s.headers['cache-control'], 'no-store');
    // Anything else in the body is ignored: the program never comes from the request.
    const r = await env.restart(dev, auth, { command: 'rm -rf ~', args: ['--evil'], cwd: '/', file: '/bin/sh' });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.run.verdict, 'running');
    assert.equal(r.json.run.by, 'iPhone');
    assert.equal(r.json.run.pid, undefined, 'the page never sees the pid');
    assert.equal(env.spawn.calls.length, 1);
    const [{ file, args, opts, ledger: before }] = env.spawn.calls;
    // In the ledger before the script started, so a crash in between is seen.
    assert.equal(before?.length, 1);
    assert.deepEqual([before[0].id, before[0].verdict, before[0].by], [r.json.run.id, 'starting', 'iPhone']);
    assert.equal(file, '/bin/bash');
    assert.deepEqual(args, [SCRIPT]);
    assert.equal(opts.cwd, `${HOME}/Projects`);
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio[0], 'ignore', 'no terminal: the Keychain step never asks for a password');
    assert.equal(typeof opts.stdio[1], 'number');
    assert.equal(opts.stdio[1], opts.stdio[2]);
    assert.equal(opts.shell, undefined);
    assert.equal(opts.env.XPC_SERVICE_NAME, undefined);
    assert.equal(opts.env.TMUX, undefined);
    assert.equal(opts.env.SECRET_TOKEN, undefined);
    assert.equal(opts.env.HOME, HOME);
    assert.equal(env.spawn.children[0].unrefd, true);
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-asked'), [{ kind: 'recover-asked', device: 'iPhone', health: 'unknown', stopped: false, agentRuns: [], agentsKnown: true }]);
    s = await env.status(dev);
    assert.equal(s.json.running.verdict, 'running');
    assert.match(s.json.blocked, /already going/);
    // The ledger has the run before it ends, 0600.
    const ledger = JSON.parse(await readFile(join(env.chatDir, 'recover.json'), 'utf8'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].verdict, 'running');
    assert.equal(ledger[0].pid, env.spawn.children[0].pid);
    assert.equal((await stat(join(env.chatDir, 'recover.json'))).mode & 0o777, 0o600);
    const outs = await readdir(join(env.chatDir, 'recover'));
    assert.equal(outs.length, 1);
    assert.equal((await stat(join(env.chatDir, 'recover', outs[0]))).mode & 0o777, 0o600);
    assert.equal((await stat(join(env.chatDir, 'recover'))).mode & 0o777, 0o700);
    env.clock.t += 90e3;
    env.spawn.children[0].end(0);
    await env.settle();
    s = await env.status(dev);
    assert.equal(s.json.running, null);
    assert.equal(s.json.last.verdict, 'ok');
    assert.equal(s.json.last.line, 'OK: Jarvis is back in full (Discord and Jarvis OS chat).');
    assert.equal(s.json.last.exit, 0);
    assert.equal(s.json.last.finishedAt, env.clock.t);
    assert.equal(s.json.blocked, null);
    const done = env.events.find(e => e.kind === 'recover-done');
    assert.deepEqual(done, { kind: 'recover-done', device: 'iPhone', verdict: 'ok', line: 'OK: Jarvis is back in full (Discord and Jarvis OS chat).' });
    assert.ok(env.logs.some(l => /^recover: iPhone asked for a Jarvis restart \(Face ID passed; health said unknown\); run [a-f0-9]{16} started jarvis-recover \(pid 4100\)$/.test(l)), env.logs.join('\n'));
    assert.ok(env.logs.some(l => /^recover: run [a-f0-9]{16} ended \(exit 0\): OK: Jarvis is back in full/.test(l)));
  } finally { await env.close(); }
});

test('NOT OK and a run that printed nothing: the card says so, with the exit', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    env.spawn.output = 'This terminal...\nNOT OK: this shell can\'t reach the login Keychain. Run: security unlock-keychain ~/Library/Keychains/login.keychain-db, then this again.\n';
    assert.equal((await env.restart(dev, auth)).status, 202);
    env.spawn.children[0].end(1);
    await env.settle();
    let last = (await env.status(dev)).json.last;
    assert.deepEqual([last.verdict, last.exit], ['not-ok', 1]);
    assert.match(last.line, /^NOT OK: this shell can't reach the login Keychain/);
    env.spawn.output = '';
    assert.equal((await env.restart(dev, auth)).status, 202);
    env.spawn.children[1].end(null, 'SIGKILL');
    await env.settle();
    last = (await env.status(dev)).json.last;
    assert.deepEqual([last.verdict, last.line], ['not-ok', 'jarvis-recover was stopped (SIGKILL) before its last line']);
  } finally { await env.close(); }
});

test('the gate: Shortcut header, no device, non-approver, foreign or http origin, cross-site fetch, wrong method', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    await env.enrol(dev);
    const plain = await env.pair('iPad');
    for (const path of [ROUTES.challenge, ROUTES.run]) {
      assert.equal((await env.post(path, dev.cookie, {}, { authorization: 'Bearer abc' })).status, 403, 'a Shortcut key never restarts');
      assert.equal((await env.post(path, '')).status, 401);
      assert.equal((await env.post(path, plain.cookie)).status, 403, 'approver devices only');
      assert.equal((await env.post(path, dev.cookie, {}, { origin: 'https://evil.example', host: 'evil.example' })).status, 403);
      assert.equal((await env.post(path, dev.cookie, {}, { 'sec-fetch-site': 'same-site' })).status, 403);
      assert.equal((await env.post(path, dev.cookie, {}, { origin: `http://${HOST}` })).status, 403);
      assert.equal((await env.call({ method: 'POST', path, headers: { ...PAGE, cookie: dev.cookie, 'content-type': 'text/plain' }, body: Buffer.from('{}') })).status, 415);
      assert.equal((await env.get(path, dev.cookie)).status, 405);
    }
    assert.equal((await env.get(ROUTES.status, '')).status, 401);
    assert.equal((await env.get(ROUTES.status, plain.cookie)).status, 403);
    assert.equal((await env.get(ROUTES.status, dev.cookie, { authorization: 'Bearer abc' })).status, 403);
    assert.equal((await env.post(ROUTES.status, dev.cookie)).status, 405);
    // The server hands these paths to the chat router (server.mjs asks its owns()).
    for (const path of Object.values(ROUTES)) assert.equal(env.routes.owns(path), true, path);
    assert.equal(env.routes.owns('/api/recover/other'), false);
    assert.equal(env.spawn.calls.length, 0);
  } finally { await env.close(); }
});

test('Face ID: none set up, a wrong signature, a challenge for a stop, one used twice: nothing runs', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const none = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(none.status, 403);
    assert.match(none.json.error, /set up Face ID/);
    const auth = await env.enrol(dev);
    const c = await env.post(ROUTES.challenge, dev.cookie);
    const answer = auth.get({ challenge: c.json.publicKey.challenge });
    const forged = { ...answer, signature: authenticator().get({ challenge: c.json.publicKey.challenge }).signature };
    assert.equal((await env.post(ROUTES.run, dev.cookie, forged)).status, 403);
    assert.equal((await env.post(ROUTES.run, dev.cookie, answer)).status, 403, 'the challenge was spent by the forged try');
    // A challenge issued for a stop is not one for a restart.
    const ch = env.stepUp.challenge((await env.devices.list()).find(d => d.name === 'iPhone').id, 'stop:a1b2c3d4e5f60718', ORIGIN);
    const wrong = await env.post(ROUTES.run, dev.cookie, auth.get({ challenge: ch.publicKey.challenge }));
    assert.equal(wrong.status, 403);
    assert.match(wrong.json.error, /for something else/);
    // No user verification (Face ID not done).
    const c2 = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal((await env.post(ROUTES.run, dev.cookie, auth.get({ challenge: c2.json.publicKey.challenge, fl: 0x01 }))).status, 403);
    assert.equal((await env.post(ROUTES.run, dev.cookie, {})).status, 400);
    assert.equal(env.spawn.calls.length, 0);
    assert.ok(env.logs.some(l => l.startsWith('recover: a restart from iPhone was refused')));
  } finally { await env.close(); }
});

test('off, the kill file, a run going: refused before Face ID is asked; the status says why', async () => {
  const off = await setup({ enabled: false });
  try {
    const dev = await off.approver('iPhone');
    await off.enrol(dev);
    const c = await off.post(ROUTES.challenge, dev.cookie);
    assert.equal(c.status, 403);
    assert.match(c.json.error, /off \(config recover\.enabled\)/);
    const s = await off.status(dev);
    assert.deepEqual([s.json.on, s.json.command], [false, RECOVER_COMMAND]);
    assert.match(s.json.blocked, /off/);
  } finally { await off.close(); }
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    env.killed = true;
    const k = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(k.status, 503);
    assert.ok(k.json.error.includes(KILL_FILE));
    // The kill file put in place between Face ID and the run still stops it.
    env.killed = false;
    const c = await env.post(ROUTES.challenge, dev.cookie);
    env.killed = true;
    assert.equal((await env.post(ROUTES.run, dev.cookie, auth.get({ challenge: c.json.publicKey.challenge }))).status, 503);
    env.killed = false;
    assert.equal((await env.restart(dev, auth)).status, 202);
    const busy = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(busy.status, 409);
    assert.match(busy.json.error, /already going \(asked from iPhone at \d\d:\d\d UTC\)/);
    assert.equal(env.spawn.calls.length, 1);
  } finally { await env.close(); }
});

test('two Face ID answers at once start one run', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    const c1 = await env.post(ROUTES.challenge, dev.cookie);
    const c2 = await env.post(ROUTES.challenge, dev.cookie);
    const [a, b] = await Promise.all([
      env.post(ROUTES.run, dev.cookie, auth.get({ challenge: c1.json.publicKey.challenge })),
      env.post(ROUTES.run, dev.cookie, auth.get({ challenge: c2.json.publicKey.challenge }))
    ]);
    assert.deepEqual([a.status, b.status].sort(), [202, 409]);
    assert.equal(env.spawn.calls.length, 1);
  } finally { await env.close(); }
});

test('limits: three an hour and eight a day, counted from the ledger, so a restart of the server keeps them', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    const run = async () => {
      const r = await env.restart(dev, auth);
      if (r.status === 202) { env.spawn.children.at(-1).end(0); await env.settle(); }
      return r;
    };
    for (let i = 0; i < RUNS_PER_HOUR; i++) { assert.equal((await run()).status, 202, `run ${i}`); env.clock.t += MIN; }
    const first = env.clock.t - RUNS_PER_HOUR * MIN;
    const capped = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(capped.status, 429);
    assert.match(capped.json.error, /3 restarts in the last hour/);
    assert.equal((await env.status(dev)).json.nextAt, first + HOUR_MS);
    // A new server reads the ledger: still capped.
    env.recover.stop();
    const again = env.makeRecover();
    await again.load();
    assert.match(again.blocked().why, /3 restarts in the last hour/);
    env.clock.t = first + HOUR_MS;
    assert.equal(again.blocked(), null);
    // The day: eight, an hour apart in threes.
    let started = RUNS_PER_HOUR;
    while (started < RUNS_PER_DAY) {
      if ((await run()).status === 202) started++;
      else env.clock.t += HOUR_MS;
      env.clock.t += MIN;
    }
    env.clock.t += HOUR_MS;
    const day = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(day.status, 429);
    assert.match(day.json.error, /8 restarts in the last day/);
    again.stop();
  } finally { await env.close(); }
});

test('the script not there: refused with the run sheet\'s way, and the ledger says NOT OK; spawn throwing does the same', async () => {
  const env = await setup({ exists: p => p !== SCRIPT });
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    const r = await env.restart(dev, auth);
    assert.equal(r.status, 503);
    assert.match(r.json.error, /recovery script is not there/);
    assert.equal(env.spawn.calls.length, 0);
    const s = await env.status(dev);
    assert.equal(s.json.running, null);
    assert.equal(s.json.last.verdict, 'not-ok');
    assert.match(s.json.last.line, /^NOT OK: the recovery script is not there/);
  } finally { await env.close(); }
  const env2 = await setup();
  try {
    const dev = await env2.approver('iPhone');
    const auth = await env2.enrol(dev);
    env2.spawn.throws = true;
    const r = await env2.restart(dev, auth);
    assert.equal(r.status, 503);
    assert.match(r.json.error, /could not be started \(EAGAIN\)/);
    assert.equal((await env2.status(dev)).json.running, null, 'a failed start frees the slot');
  } finally { await env2.close(); }
});

test('no answer after 45 minutes: the card says so and a new run may start; a late end still lands', async () => {
  const timers = [];
  const env = await setup({ recoverOpts: { setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearTimer: () => {} } });
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    assert.equal((await env.restart(dev, auth)).status, 202);
    const t = timers.find(x => x.ms === NO_ANSWER_MS);
    assert.ok(t, 'a timer for the no-answer line');
    env.clock.t += NO_ANSWER_MS;
    t.fn();
    await env.settle();
    let s = await env.status(dev);
    assert.equal(s.json.running, null);
    assert.deepEqual([s.json.last.verdict, s.json.last.line], ['unknown', NO_ANSWER_LINE]);
    assert.equal(s.json.blocked, null);
    assert.ok(env.events.some(e => e.kind === 'recover-done' && e.verdict === 'unknown'));
    env.spawn.children[0].end(0);
    await env.until(() => env.recover.view().last?.verdict === 'ok');
    s = await env.status(dev);
    assert.equal(s.json.last.verdict, 'ok', 'the late end replaces the no-answer line');
  } finally { await env.close(); }
});

test('after a restart of this server: a run still going is watched to its end; a dead one is closed from its output; one never started is NOT OK', async () => {
  const repeats = [];
  const env = await setup({ recoverOpts: { setRepeat: (fn, ms) => { const t = { fn, ms, unref() {} }; repeats.push(t); return t; }, clearRepeat: t => { t.cleared = true; } } });
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    assert.equal((await env.restart(dev, auth)).status, 202);
    const pid = env.spawn.children[0].pid;
    env.alive.add(pid);
    env.recover.stop();
    // A new process: the old child's exit never reaches it; it watches the pid.
    const next = env.makeRecover();
    await next.load();
    assert.equal(next.view().running.verdict, 'running');
    assert.match(next.blocked().why, /already going/);
    assert.ok(env.logs.some(l => /is still going after this server's restart/.test(l)));
    const watch = repeats.at(-1);
    watch.fn();
    await new Promise(r => setTimeout(r, 50));
    await next.idle();
    assert.equal(next.view().running?.verdict, 'running', 'still alive: still watched');
    env.alive.delete(pid);
    watch.fn();
    await env.settle(next);
    assert.equal(next.view().running, null);
    assert.deepEqual([next.view().last.verdict, next.view().last.exit], ['ok', null]);
    assert.equal(watch.cleared, true);
    next.stop();
    // A ledger with a dead running run and a run that never started.
    const ledgerPath = join(env.chatDir, 'recover.json');
    const runs = JSON.parse(await readFile(ledgerPath, 'utf8'));
    runs.push({ id: 'aaaaaaaaaaaaaaaa', by: 'iPad', startedAt: env.clock.t, finishedAt: null, verdict: 'starting', line: '', exit: null, pid: null });
    await writeFile(ledgerPath, JSON.stringify(runs));
    const third = env.makeRecover();
    await third.load();
    assert.equal(third.view().running, null);
    // A running one whose pid is gone, inside the 45 minutes, is closed at once (not watched).
    const dead = { id: 'cccccccccccccccc', by: 'iPad', startedAt: env.clock.t, finishedAt: null, verdict: 'running', line: '', exit: null, pid: 999999 };
    await writeFile(ledgerPath, JSON.stringify([dead]));
    const dying = env.makeRecover();
    await dying.load();
    assert.equal(dying.view().running, null);
    assert.equal(dying.view().last.id, 'cccccccccccccccc');
    assert.equal(dying.view().last.line, 'jarvis-recover printed nothing');
    dying.stop();
    runs.pop();
    runs.push({ id: 'aaaaaaaaaaaaaaaa', by: 'iPad', startedAt: env.clock.t, finishedAt: null, verdict: 'starting', line: '', exit: null, pid: null });
    await writeFile(ledgerPath, JSON.stringify(runs));
    const third2 = env.makeRecover();
    await third2.load();
    third.stop();
    assert.equal(third2.view().last.id, 'aaaaaaaaaaaaaaaa');
    // Still `starting`: it may have run (Ultron's L2), so it is closed like a run with no
    // answer, never "nothing ran", and points to the script's own log.
    assert.deepEqual([third2.view().last.verdict, third2.view().last.line], ['unknown', CRASHED_START_LINE]);
    assert.match(CRASHED_START_LINE, /may have run; see ~\/Library\/Logs\/jarvis-recover\.log$/);
    assert.ok(!/nothing ran|^NOT OK/.test(CRASHED_START_LINE));
    assert.equal(third2.view().running, null);
    assert.equal(third2.view().blocked, null, 'a new run may start, as after a run with no answer');
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-done').at(-1), { kind: 'recover-done', device: 'iPad', verdict: 'unknown', line: CRASHED_START_LINE });
    assert.match(chatEventLine(env.events.filter(e => e.kind === 'recover-done').at(-1)), /ended: no verdict\. Its last line: The Control Room restarted while starting jarvis-recover; it may have run/);
    assert.ok(env.logs.some(l => l.startsWith('recover: run aaaaaaaaaaaaaaaa was still starting when this server stopped; it may have run')));
    const kept = JSON.parse(await readFile(ledgerPath, 'utf8')).find(r => r.id === 'aaaaaaaaaaaaaaaa');
    assert.deepEqual([kept.verdict, kept.line, kept.finishedAt], ['unknown', CRASHED_START_LINE, env.clock.t]);
    third2.stop();
    // Read again, it stays closed: a later start does not close it a second time.
    const again = env.makeRecover();
    const before = env.events.length;
    await again.load();
    assert.equal(env.events.length, before);
    again.stop();
    // A ledger that is not a list, or holds junk: read as empty, never a crash.
    await writeFile(ledgerPath, '{"no": 1}');
    const fourth = env.makeRecover();
    assert.equal(await fourth.load(), 0);
    await writeFile(ledgerPath, JSON.stringify([{ id: 'x' }, { id: 'bbbbbbbbbbbbbbbb', startedAt: 'soon', verdict: 'ok' }, null]));
    assert.equal(await fourth.load(), 0);
    fourth.stop();
  } finally { await env.close(); }
});

test('only the newest outputs are kept', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    for (let i = 0; i < KEEP_OUTS + 2; i++) {
      env.clock.t += 2 * HOUR_MS;
      assert.equal((await env.restart(dev, auth)).status, 202);
      env.spawn.children.at(-1).end(0);
      await env.settle();
      await new Promise(r => setTimeout(r, 5));
    }
    const outs = (await readdir(join(env.chatDir, 'recover'))).sort();
    assert.equal(outs.length, KEEP_OUTS);
    assert.ok(outs.at(-1).includes(String(env.clock.t)));
  } finally { await env.close(); }
});

test('for real: a scratch script runs with no terminal, from ~/Projects, in its own process group, with the built environment, and its last line is the result', async () => {
  // The real path: bash's $PWD is the physical folder (/private/var/... on macOS).
  const home = await realpath(await mkdtemp(join(tmpdir(), 'recover-home-')));
  const env = await setup();
  try {
    const bin = join(home, 'Projects', '.worktrees', 'jarvis-release', 'bin');
    await mkdir(bin, { recursive: true });
    // It reports what it sees, then ends like jarvis-recover.
    await writeFile(join(bin, 'jarvis-recover'), [
      '#!/bin/bash',
      'if [ -t 0 ]; then echo "tty: yes"; else echo "tty: no"; fi',
      'echo "pwd: $PWD"',
      'echo "pgid: $(ps -o pgid= -p $$ | tr -d " ") pid: $$"',
      'echo "xpc: ${XPC_SERVICE_NAME:-none} tmux: ${TMUX:-none} secret: ${SECRET_TOKEN:-none}"',
      'echo "OK, degraded: Jarvis is up (test)."',
      ''
    ].join('\n'));
    await chmod(join(bin, 'jarvis-recover'), 0o700);
    env.recover.stop();
    const { spawn } = await import('node:child_process');
    const real = createRecover({ home, dir: env.chatDir, stepUp: env.stepUp, enabled: true, now: () => Date.now(), spawn, log: () => {}, env: { ...process.env, XPC_SERVICE_NAME: 'com.example.x', TMUX: '/tmp/t,1,0', SECRET_TOKEN: 'shh' } });
    await real.load();
    const s = await real.start('iPhone');
    assert.equal(s.ok, true, s.error);
    for (let i = 0; i < 200 && real.view().running; i++) await new Promise(r => setTimeout(r, 25));
    await real.idle();
    const last = real.view().last;
    assert.deepEqual([last.verdict, last.line, last.exit], ['degraded', 'OK, degraded: Jarvis is up (test).', 0]);
    const out = await readFile(join(env.chatDir, 'recover', (await readdir(join(env.chatDir, 'recover')))[0]), 'utf8');
    assert.match(out, /^tty: no$/m);
    assert.match(out, new RegExp(`^pwd: ${join(home, 'Projects').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    const m = /^pgid: (\d+) pid: (\d+)$/m.exec(out);
    assert.ok(m, out);
    assert.equal(m[1], m[2], 'a process group of its own: a restart of this server does not end it');
    assert.match(out, /^xpc: none tmux: none secret: none$/m);
    real.stop();
  } finally { await env.close(); await rm(home, { recursive: true, force: true }); }
});

// ---- a refused restart is alerted, capped (Ultron's L4) ----

test('L4: a refused restart is alerted as recover-refused (a key from the owner, a non-approver, a failed Face ID); the status read never is', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    const plain = await env.pair('iPad');
    const refused = () => env.events.filter(e => e.kind === 'recover-refused');
    // Reads alert nothing: every page reads the status, an approver or not.
    assert.equal((await env.get(ROUTES.status, plain.cookie)).status, 403);
    assert.equal((await env.get(ROUTES.status, dev.cookie, { authorization: 'Bearer abc' })).status, 403);
    assert.deepEqual(refused(), []);
    assert.equal((await env.post(ROUTES.run, dev.cookie, {}, { authorization: 'Bearer abc' })).status, 403);
    assert.equal((await env.post(ROUTES.challenge, plain.cookie)).status, 403);
    const c = await env.post(ROUTES.challenge, dev.cookie);
    const forged = { ...auth.get({ challenge: c.json.publicKey.challenge }), signature: authenticator().get({ challenge: c.json.publicKey.challenge }).signature };
    assert.equal((await env.post(ROUTES.run, dev.cookie, forged)).status, 403);
    assert.deepEqual(refused(), [
      { kind: 'recover-refused', why: 'key' },
      { kind: 'recover-refused', why: 'not-approver', device: 'iPad' },
      { kind: 'recover-refused', why: 'face-id', device: 'iPhone', error: 'the Face ID signature does not check' }
    ]);
    // An unpaired caller, a foreign origin: refused, not alerted (no device to name, or a slip).
    assert.equal((await env.post(ROUTES.run, '')).status, 401);
    assert.equal((await env.post(ROUTES.run, dev.cookie, {}, { origin: 'https://evil.example', host: 'evil.example' })).status, 403);
    assert.equal(refused().length, 3);
    assert.equal(env.spawn.calls.length, 0);
    // Alerted, and capped like a refused heal tap: one push per 10 minutes, the rest counted.
    assert.ok(ALERTED_KINDS.includes('recover-refused'));
    assert.ok(Object.hasOwn(LIMITED_KINDS, 'recover-refused'));
    assert.equal(LIMITED_KINDS['recover-refused'], 'refused Jarvis restarts');
    assert.equal(chatEventLine(refused()[0]), 'a Jarvis restart carried a Shortcut key and was refused');
    assert.equal(chatEventLine(refused()[1]), 'a Jarvis restart from iPad was refused: that device is not marked approver');
    assert.equal(chatEventLine(refused()[2]), 'a Jarvis restart from iPhone was refused: Face ID did not pass (the Face ID signature does not check)');
    assert.ok(!chatEventLine({ kind: 'recover-refused', why: 'face-id', device: 'a\nb', error: 'c\nd' }).includes('\n'));
  } finally { await env.close(); }
});

test('L4: a Shortcut key\'s refusal is alerted only from the owner\'s login; anyone else is refused unalerted', async () => {
  const env = await setup({ routesConfig: { chat: { login: 'owner@example.test' } } });
  try {
    const call = headers => env.call({ method: 'POST', path: ROUTES.challenge, headers: { ...PAGE, authorization: 'Bearer abc', ...headers }, body: {} });
    for (const login of [undefined, 'someone@example.test']) {
      const r = await call(login === undefined ? {} : { 'tailscale-user-login': login });
      assert.equal(r.status, 403, String(login));
      assert.match(r.json.error, /owner through the tailnet/);
    }
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-refused'), []);
    const owner = await call({ 'tailscale-user-login': 'Owner@example.test' });
    assert.equal(owner.status, 403);
    assert.match(owner.json.error, /Shortcut key/);
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-refused'), [{ kind: 'recover-refused', why: 'key' }]);
  } finally { await env.close(); }
});

// ---- Q1: what health and the stop flag show, on the sheet and in the ask ----

test('Q1: leadHealth reads the lead\'s session from the health panel: the named one, else the only one; anything not current is unknown', () => {
  const panel = (services, status = 'ok') => ({ status, data: { services } });
  const lead = state => ({ kind: 'session', name: 'Jarvis', state });
  assert.equal(leadHealth(panel([lead('up')]), 'Jarvis'), 'up');
  assert.equal(leadHealth(panel([lead('down')]), 'Jarvis'), 'down');
  assert.equal(leadHealth(panel([lead('unknown')]), 'Jarvis'), 'unknown');
  assert.equal(leadHealth(panel([lead('up')], 'stale'), 'Jarvis'), 'unknown', 'an old reading says nothing of now');
  assert.equal(leadHealth(panel([lead('up')], 'unavailable'), 'Jarvis'), 'unknown');
  assert.equal(leadHealth(panel([{ kind: 'session', name: 'Other', state: 'up' }]), 'Jarvis'), 'up', 'the only session there is');
  assert.equal(leadHealth(panel([{ kind: 'session', name: 'A', state: 'up' }, { kind: 'session', name: 'B', state: 'down' }]), 'Jarvis'), 'unknown', 'two, neither named: no guess');
  assert.equal(leadHealth(panel([{ kind: 'session', name: 'A', state: 'up' }, lead('down')]), 'Jarvis'), 'down');
  assert.equal(leadHealth(panel([{ kind: 'launchd', name: 'Jarvis', state: 'running' }]), 'Jarvis'), 'unknown');
  assert.equal(leadHealth(panel([lead('sideways')]), 'Jarvis'), 'unknown');
  for (const junk of [null, undefined, {}, { status: 'ok' }, { status: 'ok', data: { services: 'x' } }]) assert.equal(leadHealth(junk, 'Jarvis'), 'unknown');
  assert.deepEqual(STOP_FLAG_PARTS, ['.local', 'state', 'jarvis', 'jarvis-stopped']);
});

test('Q1: a restart runs whether health says up or down; the status says which, and the stop flag; the ask records both', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    env.health = 'up';
    let s = await env.status(dev);
    assert.deepEqual(s.json.jarvis, { health: 'up', stopped: false });
    assert.equal(s.json.blocked, null, 'up is no reason to refuse');
    const r = await env.restart(dev, auth);
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-asked').at(-1), { kind: 'recover-asked', device: 'iPhone', health: 'up', stopped: false, agentRuns: [], agentsKnown: true });
    assert.ok(env.logs.some(l => /\(Face ID passed; health said up\)/.test(l)));
    const ledger = JSON.parse(await readFile(join(env.chatDir, 'recover.json'), 'utf8'));
    assert.deepEqual([ledger[0].health, ledger[0].stopped], ['up', false]);
    assert.equal(publicRun(ledger[0]).health, undefined, 'the page sees health in `jarvis`, not in the run');
    env.spawn.children[0].end(0);
    await env.settle();
    env.health = 'down';
    env.stopped = true;
    s = await env.status(dev);
    assert.deepEqual(s.json.jarvis, { health: 'down', stopped: true });
    assert.equal((await env.restart(dev, auth)).status, 202);
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-asked').at(-1), { kind: 'recover-asked', device: 'iPhone', health: 'down', stopped: true, agentRuns: [], agentsKnown: true });
    assert.ok(env.logs.some(l => /\(Face ID passed; health said down, the stop flag was there\)/.test(l)));
    env.spawn.children[1].end(0);
    await env.settle();
    // A health or flag read that throws, or says something else, is "unknown" / not there: never a 500.
    env.health = 'sideways';
    assert.deepEqual(env.recover.view().jarvis, { health: 'unknown', stopped: true });
    const throwing = env.makeRecover({ health: () => { throw new Error('boom'); }, stopped: () => { throw new Error('boom'); } });
    assert.deepEqual(throwing.view().jarvis, { health: 'unknown', stopped: false });
    throwing.stop();
  } finally { await env.close(); }
});

test('Q1: by default the stop flag is read at ~/.local/state/jarvis/jarvis-stopped under the owner\'s home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recover-flag-'));
  try {
    const rec = createRecover({ home, dir: join(home, 'chat'), stepUp: { pendingFor: () => null, has: () => false }, enabled: true, log: () => {} });
    assert.deepEqual(rec.view().jarvis, { health: 'unknown', stopped: false });
    await mkdir(join(home, '.local', 'state', 'jarvis'), { recursive: true });
    await writeFile(join(home, ...STOP_FLAG_PARTS), '');
    assert.deepEqual(rec.view().jarvis, { health: 'unknown', stopped: true });
    rec.stop();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Q1: the ask\'s event line says what health said, and a stop on purpose', () => {
  assert.equal(chatEventLine({ kind: 'recover-asked', device: 'iPhone', health: 'up', stopped: false }), 'a Jarvis restart was asked from iPhone (Face ID passed; health said Jarvis was up); the Control Room runs jarvis-recover');
  assert.equal(chatEventLine({ kind: 'recover-asked', device: 'iPhone', health: 'down', stopped: true }), 'a Jarvis restart was asked from iPhone (Face ID passed; health said Jarvis was down, and he had been stopped on purpose); the Control Room runs jarvis-recover');
  assert.equal(chatEventLine({ kind: 'recover-asked', device: 'iPhone' }), 'a Jarvis restart was asked from iPhone (Face ID passed; health could not say whether Jarvis was up); the Control Room runs jarvis-recover');
});

// ---- the line in every Jarvis-down alert ----

test('alerts: the lead\'s session down has its own message with the line; other services are still counted, unnamed', () => {
  const out = pushableFrom([
    { kind: 'service', key: 'service:session:Jarvis', text: 'Jarvis is not running' },
    { kind: 'service', key: 'service:launchd:Tunnel', text: 'Tunnel is not running' },
    { kind: 'service', key: 'service:launchd:Review', text: 'Review is not running' }
  ]);
  const lead = out.find(e => e.keys.includes('service:session:Jarvis'));
  assert.deepEqual(lead, { keys: ['service:session:Jarvis'], title: 'Control Room', message: `${LEAD_DOWN_WORDS} ${RECOVER_LINE}`, ntfyMessage: `${LEAD_DOWN_WORDS} ${RECOVER_NTFY_LINE}` });
  assert.ok(lead.message.includes(RECOVER_COMMAND));
  // ntfy: the ways back, no command (Ultron's L1: anyone who knows the topic can publish).
  assert.ok(!lead.ntfyMessage.includes(RECOVER_COMMAND));
  assert.ok(!/jarvis-recover|~\/|cd |&&/.test(lead.ntfyMessage), lead.ntfyMessage);
  assert.match(lead.ntfyMessage, /Restart Jarvis in the Control Room \(Face ID\)/);
  assert.match(lead.ntfyMessage, /run sheet/);
  const rest = out.find(e => e !== lead);
  assert.deepEqual(rest.keys, ['service:launchd:Tunnel', 'service:launchd:Review']);
  assert.equal(rest.message, '2 services are down — open the dashboard for detail');
  assert.ok(!rest.message.includes('jarvis-recover'));
  assert.equal(out.length, 2);
});

test('L1: the notifier\'s alert sends an entry\'s own ntfy words to ntfy and the full message to #pepper; the lead-down command never reaches ntfy', async () => {
  const sent = [];
  const fake = args => sendAlert({ ...args, ntfy: async m => { sent.push(['ntfy', m.message, m.topic]); return { sent: true }; }, discord: async m => { sent.push(['discord', m.message, m.feed]); return { sent: true }; } });
  const send = entryAlert({ topic: 't', send: fake });
  const [lead] = pushableFrom([{ kind: 'service', key: 'service:session:Jarvis', text: 'Jarvis is not running' }]);
  await send(lead);
  assert.deepEqual(sent, [['ntfy', `${LEAD_DOWN_WORDS} ${RECOVER_NTFY_LINE}`, 't'], ['discord', `${LEAD_DOWN_WORDS} ${RECOVER_LINE}`, 'pepper']]);
  assert.ok(!sent[0][1].includes('jarvis-recover'));
  assert.ok(sent[1][1].includes(RECOVER_COMMAND));
  // An entry with no ntfy words of its own sends its message to both; its feed is kept.
  sent.length = 0;
  await send({ keys: ['k'], title: 'Control Room', message: 'Claude session at 100%', feed: 'jarvis' });
  assert.deepEqual(sent, [['ntfy', 'Claude session at 100%', 't'], ['discord', 'Claude session at 100%', 'jarvis']]);
  sent.length = 0;
  await send({ keys: ['k'], title: 'Control Room', message: 'm', ntfyMessage: '' });
  assert.deepEqual(sent.map(x => x[1]), ['m', 'm'], 'empty ntfy words fall back to the message');
});

test('a local alert\'s push: a "jarvis-down" one ends with the line, kept whole however long the body; another kind has none', async () => {
  const pushed = [];
  const s = createLocalAlerts({ push: () => async a => { pushed.push(a); return { tried: 1, reached: 1 }; }, log: () => {} });
  await s.post(checkLocalAlert({ title: 'Jarvis failed to start', body: 'x', kind: 'jarvis-down' }).value);
  await s.post(checkLocalAlert({ title: 'Routine failed', body: 'y', kind: 'other' }).value);
  assert.equal(pushed[0].tail, RECOVER_LINE);
  assert.equal('tail' in pushed[1], false);
  // A body that must be cut: the tail survives whole, after a blank line.
  const big = alertPayload('https://mini.example.ts.net', { title: 'T', body: '€'.repeat(1000), tail: RECOVER_LINE });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= ALERT_PAYLOAD_MAX);
  assert.ok(big.notification.body.endsWith(`…\n\n${RECOVER_LINE}`));
  const small = alertPayload('https://mini.example.ts.net', { title: 'T', body: 'short', tail: RECOVER_LINE });
  assert.equal(small.notification.body, `short\n\n${RECOVER_LINE}`);
  assert.equal(alertPayload('', { title: 'T', body: 'short' }).notification.body, 'short');
});

test('the events: an ask and a result are alerted, in one line each', () => {
  assert.ok(ALERTED_KINDS.includes('recover-asked'));
  assert.ok(ALERTED_KINDS.includes('recover-done'));
  assert.ok(ALERTED_KINDS.includes('recover-refused'));
  assert.equal(chatEventLine({ kind: 'recover-done', device: 'iPhone', verdict: 'ok', line: 'OK: back.' }), 'the Jarvis restart asked from iPhone ended: OK. Its last line: OK: back.');
  assert.match(chatEventLine({ kind: 'recover-done', device: 'iPad', verdict: 'degraded', line: 'OK, degraded: x' }), /ended: OK\./);
  assert.match(chatEventLine({ kind: 'recover-done', device: 'iPad', verdict: 'not-ok', line: 'NOT OK: x' }), /ended: NOT OK\./);
  assert.match(chatEventLine({ kind: 'recover-done', device: 'iPad', verdict: 'unknown', line: 'x' }), /ended: no verdict\./);
  assert.ok(!chatEventLine({ kind: 'recover-done', device: 'a\nb', verdict: 'ok', line: 'c\nd' }).includes('\n'));
});

// ---- wiring and the page's copy ----

test('server.mjs: the restart is made with the stop\'s passkeys, the chat folder, the kill file and the chat\'s events, and served by the chat router; it spawns nothing itself', async () => {
  const src = (await readFile(join(HERE, '..', 'server.mjs'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const recover = createRecover\(\{ home: homedir\(\), dir: chatDir, stepUp, enabled: recoverSettings\.on, killed: \(\) => existsSync\(recoverOffPath\), onEvent: chatEvents, health: \(\) => leadHealth\(cache\.get\('health'\), leadName\), liveAgents: \(\) => cache\.get\('sessions', Date\.now\(\)\), roster \}\);/);
  // The lead's name is the roster's first agent's, as on the page, and is set before the restart is made.
  assert.ok(src.indexOf('const leadName = roster.agents[0]?.name ?? null;') > -1 && src.indexOf('const leadName = roster.agents[0]?.name ?? null;') < src.indexOf('const recover = createRecover('));
  assert.match(src, /const recoverOffPath = join\(stateDir, RECOVER_KILL_FILE\);/);
  assert.match(src, /await recover\.load\(\);/);
  assert.match(src, /chat = createChatRoutes\(\{[^}]*healTaps, recover \}\);/);
  // The notifier's alert goes through entryAlert, so an entry's ntfy words reach ntfy (L1).
  assert.match(src, /send: entrySender\(\{ alert: entryAlert\(\{ topic \}\), devices: limitPush \}\),/);
  assert.ok(!/spawn\(|execFile|kickstart/.test(src));
  assert.equal(KILL_FILE, 'recover-off');
});

test('the page shows the same line, word for word', async () => {
  const page = await readFile(join(HERE, '..', '..', 'web', 'src', 'lib', 'orbit', 'recover.js'), 'utf8');
  const m = /export const RECOVER_COMMAND = '([^']+)';/.exec(page);
  assert.ok(m, 'web/src/lib/orbit/recover.js exports RECOVER_COMMAND');
  assert.equal(m[1], RECOVER_COMMAND);
});

// ---- agent runs a restart would stop (board d8f27c49) ----

// A live agents row as lib/live-agents.mjs builds it; invented ids, names and tasks.
const liveRow = (id, over = {}) => ({ id, agent: 'vision', type: 'vision', direct: false, task: 'An invented brief', session: 'Jarvis', stoppable: true, start: 1000, last: 2000, tokens: 10, model: 'opus', ...over });
const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2', C = 'c3c3c3c3c3c3c3c3';
const panel = (runs, over = {}) => ({ status: 'ok', data: { liveAgents: { windowMs: 900e3, more: 0, runs } }, ...over });

test('runsAtRisk: the lead\'s subagent runs from the live agents panel, by roster name; not a --agent run, not another session\'s; anything not current is not known', () => {
  const rows = [
    liveRow(A),
    liveRow(B, { agent: 'ultron', type: 'ultron', stoppable: false }),
    liveRow(C, { agent: null, type: 'general-purpose', last: null, start: 1500 }),
    liveRow('d4d4d4d4d4d4d4d4', { direct: true, session: null }),
    liveRow('e5e5e5e5e5e5e5e5', { session: 'Vision' }),
    liveRow('f6f6f6f6f6f6f6f6', { session: null }),
    liveRow('not-a-hash'),
    null, 'x'
  ];
  assert.deepEqual(runsAtRisk(panel(rows), ROSTER), { known: true, runs: [{ id: A, name: 'Vision', last: 2000 }, { id: B, name: 'Ultron', last: 2000 }, { id: C, name: 'general-purpose', last: 1500 }] });
  assert.deepEqual(runsAtRisk(panel([]), ROSTER), { known: true, runs: [] });
  // A row with no type at all still counts, by a plain word.
  assert.equal(runsAtRisk(panel([liveRow(A, { agent: null, type: null })]), ROSTER).runs[0].name, 'subagent');
  // Stale (an error, or too old): the runs it last had are still listed, but not known.
  assert.deepEqual(runsAtRisk(panel([liveRow(A)], { status: 'stale' }), ROSTER), { known: false, runs: [{ id: A, name: 'Vision', last: 2000 }] });
  // Over the panel's bound: the list is cut, so not known.
  assert.equal(runsAtRisk({ status: 'ok', data: { liveAgents: { more: 2, runs: [liveRow(A)] } } }, ROSTER).known, false);
  for (const junk of [null, undefined, {}, { status: 'unavailable', data: null }, { status: 'ok', data: {} }, { status: 'ok', data: { liveAgents: { runs: 'x' } } }]) assert.deepEqual(runsAtRisk(junk, ROSTER), { known: false, runs: [] });
  // No roster (no lead to match): not known.
  assert.deepEqual(runsAtRisk(panel([liveRow(A)]), null), { known: false, runs: [] });
  assert.deepEqual(runsAtRisk(panel([liveRow(A)]), { agents: [] }), { known: false, runs: [] });
});

test('missingConfirm: every run\'s id, and UNSEEN when not known; a confirm that isn\'t an array of strings is none', () => {
  const two = { known: true, runs: [{ id: A }, { id: B }] };
  assert.deepEqual(missingConfirm({ known: true, runs: [] }, undefined), []);
  assert.deepEqual(missingConfirm(two, undefined), [A, B]);
  assert.deepEqual(missingConfirm(two, [A]), [B]);
  assert.deepEqual(missingConfirm(two, [B, A, C]), [], 'a run that ended since is no matter');
  assert.deepEqual(missingConfirm(two, `${A},${B}`), [A, B]);
  assert.deepEqual(missingConfirm(two, { 0: A, 1: B, length: 2 }), [A, B]);
  assert.deepEqual(missingConfirm(two, [A, B, ...Array(STOP_RUNS_MAX).fill(C)]), [A, B], 'too long is not a confirm');
  assert.deepEqual(missingConfirm(two, [A, B, ...Array(STOP_RUNS_MAX - 2).fill(C)]), []);
  assert.deepEqual(missingConfirm({ known: false, runs: [] }, []), [UNSEEN]);
  assert.deepEqual(missingConfirm({ known: false, runs: [{ id: A }] }, [A]), [UNSEEN]);
  assert.deepEqual(missingConfirm({ known: false, runs: [{ id: A }] }, [UNSEEN]), [A]);
  assert.deepEqual(missingConfirm({ known: false, runs: [{ id: A }] }, [A, UNSEEN]), []);
  assert.deepEqual(missingConfirm(null, null), [UNSEEN]);
  assert.equal(UNSEEN, 'unseen');
});

test('runs live: the status lists them; both POSTs refuse 409 with the runs until each is named, before Face ID; then the restart goes and says what it stopped', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    env.live = panel([liveRow(A), liveRow(B, { agent: 'ultron', type: 'ultron' }), liveRow('d4d4d4d4d4d4d4d4', { direct: true, session: null })]);
    const s = await env.status(dev);
    assert.deepEqual(s.json.agents, { known: true, runs: [{ id: A, name: 'Vision', last: 2000 }, { id: B, name: 'Ultron', last: 2000 }] });
    assert.equal(s.json.blocked, null, 'runs are no block: a confirm lets the restart through');
    // No confirm: the challenge is refused, so Face ID is never asked.
    let c = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(c.status, 409, c.text);
    assert.equal(c.json.publicKey, undefined);
    assert.equal(c.json.error, '2 agent runs are going; restarting stops them. Confirm to restart anyway.');
    assert.deepEqual(c.json.agents.runs.map(r => r.id), [A, B]);
    // Half a confirm is none.
    c = await env.post(ROUTES.challenge, dev.cookie, { stopRuns: [A] });
    assert.equal(c.status, 409);
    // A page that skipped the warning but has a challenge (an old page, or a forged one): the run POST is refused too, and spawns nothing.
    c = await env.post(ROUTES.challenge, dev.cookie, { stopRuns: [A, B] });
    assert.equal(c.status, 200, c.text);
    let r = await env.post(ROUTES.run, dev.cookie, auth.get({ challenge: c.json.publicKey.challenge }));
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(r.json.agents.runs.map(x => x.id), [A, B]);
    assert.equal(env.spawn.calls.length, 0);
    assert.ok(env.logs.some(l => /^recover: a restart from iPhone waits for a confirm: 2 agent runs would stop$/.test(l)), env.logs.join('\n'));
    // Named, both times: it goes.
    r = await env.restart(dev, auth, { stopRuns: [A, B] }, { stopRuns: [A, B] });
    assert.equal(r.status, 202, r.text);
    assert.equal(env.spawn.calls.length, 1);
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-asked').at(-1), { kind: 'recover-asked', device: 'iPhone', health: 'unknown', stopped: false, agentRuns: ['Vision', 'Ultron'], agentsKnown: true });
    assert.ok(env.logs.some(l => /\(Face ID passed; health said unknown; it stops 2 agent runs: Vision, Ultron\)/.test(l)), env.logs.join('\n'));
    // A Face ID refusal still comes after the runs check, never before it.
    assert.equal(env.events.filter(e => e.kind === 'recover-refused').length, 0);
  } finally { await env.close(); }
});

test('runs live: one that starts while Face ID is up is refused after it, nothing runs; the next confirm names it', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    env.live = panel([liveRow(A)]);
    const c = await env.post(ROUTES.challenge, dev.cookie, { stopRuns: [A] });
    assert.equal(c.status, 200, c.text);
    env.live = panel([liveRow(A), liveRow(C, { agent: 'ultron' })]);
    let r = await env.post(ROUTES.run, dev.cookie, { ...auth.get({ challenge: c.json.publicKey.challenge }), stopRuns: [A] });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, '2 agent runs are going; restarting stops them. Confirm to restart anyway.');
    assert.equal(env.spawn.calls.length, 0);
    r = await env.restart(dev, auth, { stopRuns: [A, C] }, { stopRuns: [A, C] });
    assert.equal(r.status, 202, r.text);
    // One run: singular words.
    env.spawn.children[0].end(0);
    await env.settle();
    env.live = panel([liveRow(B)]);
    const one = await env.post(ROUTES.challenge, dev.cookie);
    assert.equal(one.json.error, '1 agent run is going; restarting stops it. Confirm to restart anyway.');
  } finally { await env.close(); }
});

test('runs not seen (the panel stale, missing, or its read throwing): the confirm must say UNSEEN; the ask says the runs could not be seen', async () => {
  const env = await setup();
  try {
    const dev = await env.approver('iPhone');
    const auth = await env.enrol(dev);
    env.live = { status: 'unavailable', data: null };
    const s = await env.status(dev);
    assert.deepEqual(s.json.agents, { known: false, runs: [] });
    let c = await env.post(ROUTES.challenge, dev.cookie, { stopRuns: [] });
    assert.equal(c.status, 409);
    assert.equal(c.json.error, 'The Control Room can\'t see whether agent runs are going; restarting stops any that are. Confirm to restart anyway.');
    assert.ok(env.logs.some(l => /waits for a confirm: the live agent runs could not be seen$/.test(l)));
    // Stale with a run in it: both the run and UNSEEN.
    env.live = panel([liveRow(A)], { status: 'stale' });
    c = await env.post(ROUTES.challenge, dev.cookie, { stopRuns: [UNSEEN] });
    assert.equal(c.status, 409);
    const r = await env.restart(dev, auth, { stopRuns: [A, UNSEEN] }, { stopRuns: [A, UNSEEN] });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(env.events.filter(e => e.kind === 'recover-asked').at(-1), { kind: 'recover-asked', device: 'iPhone', health: 'unknown', stopped: false, agentRuns: ['Vision'], agentsKnown: false });
    assert.ok(env.logs.some(l => /it stops 1 agent run: Vision; the live agent runs could not be seen\)/.test(l)), env.logs.join('\n'));
    // A read that throws can't fail the status: not known. Neither can the module made without one.
    const throwing = env.makeRecover({ liveAgents: () => { throw new Error('boom'); } });
    assert.deepEqual(throwing.view().agents, { known: false, runs: [] });
    throwing.stop();
    const bare = createRecover({ home: HOME, dir: env.chatDir, stepUp: env.stepUp, enabled: true, log: () => {} });
    assert.deepEqual(bare.view().agents, { known: false, runs: [] });
    bare.stop();
  } finally { await env.close(); }
});

test('the ask\'s event line names the agent runs the restart stopped, or says they could not be seen', () => {
  const base = { kind: 'recover-asked', device: 'iPhone', health: 'down', stopped: false };
  assert.equal(chatEventLine({ ...base, agentRuns: ['Vision', 'Ultron'], agentsKnown: true }), 'a Jarvis restart was asked from iPhone (Face ID passed; health said Jarvis was down; it stopped 2 agent runs he had going (Vision, Ultron), confirmed on the page); the Control Room runs jarvis-recover');
  assert.equal(chatEventLine({ ...base, agentRuns: ['Vision'], agentsKnown: true }), 'a Jarvis restart was asked from iPhone (Face ID passed; health said Jarvis was down; it stopped 1 agent run he had going (Vision), confirmed on the page); the Control Room runs jarvis-recover');
  assert.equal(chatEventLine({ ...base, agentRuns: [], agentsKnown: true }), 'a Jarvis restart was asked from iPhone (Face ID passed; health said Jarvis was down); the Control Room runs jarvis-recover');
  assert.equal(chatEventLine({ ...base, agentRuns: [], agentsKnown: false }), 'a Jarvis restart was asked from iPhone (Face ID passed; health said Jarvis was down; the live agent runs could not be seen, and the restart was confirmed anyway); the Control Room runs jarvis-recover');
  const many = chatEventLine({ ...base, agentRuns: Array.from({ length: 12 }, (_, i) => `Agent${i}`), agentsKnown: true });
  assert.match(many, /it stopped 12 agent runs he had going \(Agent0, .*, Agent9, and 2 more\)/);
  assert.ok(!chatEventLine({ ...base, agentRuns: ['a\nb'], agentsKnown: true }).includes('\n'));
});
