// Ultron's lows on the card brought back after a restart (board 88c1d4ec, 2026-11-28):
// L4, the reminder names the chat only for a card that can really answer the wait; L5, the
// hello's start is checked against ps's; L6, a card put back is marked and its lost exact
// copy said so; L7, the channel posting a held card again keeps the held card. Every id, pid,
// session and time here is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../lib/chat-store.mjs';
import { createSocketRouter, SESSION_HEADER } from '../lib/chat-socket.mjs';
import { startMatches, START_BEFORE_MS, START_AFTER_MS } from '../lib/chat-verify.mjs';
import { cardTakesWait, hasCardFor, createApprovalReminders, REMINDER_TAIL, REMINDER_TAIL_NO_CARD } from '../lib/approval-wait.mjs';
import { createAnsweredElsewhere } from '../lib/answered-elsewhere.mjs';
import { createNeedsYouStore, waitKey } from '../lib/needs-you.mjs';
import { createApprovals, NO_EXACT, EXACT_LOST, shownHash } from '../lib/approvals.mjs';
import { agentKey } from '../lib/needs-you.mjs';
import { RECOVER_COMMAND, RECOVER_LINE } from '../lib/recover-command.mjs';
import { pushableFrom } from '../lib/push-alerts.mjs';
import { BODIES, alertPayload } from '../lib/chat-push.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const T0 = 1794380000000;
const HOLD = 12 * HOUR + 3 * MIN;
const A = { pid: 4101, startedAt: T0 - HOUR + 250 };   // the channel process (ms, as START_MS)
const LEAD = 'a1b2c3d4-0000-4000-8000-00000000000a';
const OTHER = 'a1b2c3d4-0000-4000-8000-00000000000b';
const KEY = agentKey('a0000000000000001');
const PREVIEW = '{"command":"ls -la /home/owner/Projects/app"}';

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'card-lows-'));
  const clock = { t: T0 };
  const servers = new Set();
  const clean = async () => {
    for (const srv of servers) { srv.closeAllConnections?.(); await new Promise(r => srv.close(r)); }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { dir, clock, servers, clean };
}
async function storeAt(w) {
  const logs = [];
  const store = createChatStore({ dir: w.dir, now: () => w.clock.t, log: l => logs.push(l) });
  await store.load();
  const events = [];
  store.subscribe(e => { if (e.type === 'permission' || e.type === 'permission-closed') events.push([e.type, e.request.requestId, e.request.state]); });
  const start = (id = A, extra = {}) => { const r = store.channelHello({ ...id, ...extra }); store.setPermissionHold(HOLD); store.noteChannelAlive(w.clock.t); return r; };
  const open = (requestId, { tool = 'Bash', description = 'list the files', inputPreview = PREVIEW, relayedAt = T0, cut = false } = {}) => store.openPermission({ requestId, tool, description, inputPreview, relayedAt, cut }, { assess: () => ({ denyOnly: [], why: null }) });
  return { store, logs, events, start, open };
}
// A first server with one card open from process A, on disk; then a second at the same
// folder a minute later, the same process's hello taken (the card held).
async function restarted(w, extra = {}) {
  const one = await storeAt(w);
  one.start(A);
  await one.open('abcde');
  await one.store.flushPermissions();
  w.clock.t += MIN;
  const two = await storeAt(w);
  const back = two.start(A, extra);
  return { one, two, back };
}

// ---- L5: the hello's start against ps's ----

test('L5 startMatches: the hello\'s start may be up to 2 s after ps\'s whole second, or 1 s before it; anything else, or missing, is no match', () => {
  const ps = T0 - HOUR; // lstart: whole seconds, cut down
  assert.equal(START_BEFORE_MS, 1000);
  assert.equal(START_AFTER_MS, 2000);
  for (const d of [0, 1, 250, 999, 1281, 1999, -1, -1000]) assert.equal(startMatches(ps + d, ps), true, `d=${d}`);
  for (const d of [2000, 2001, 60e3, -1001, -HOUR]) assert.equal(startMatches(ps + d, ps), false, `d=${d}`);
  assert.equal(startMatches(ps, null), false, 'no ps start');
  assert.equal(startMatches(ps, NaN), false);
  assert.equal(startMatches(null, ps), false, 'no hello start');
  assert.equal(startMatches(ps + 0.5, ps), false, 'not whole ms');
  assert.equal(startMatches(0, 0), false);
  assert.equal(startMatches(String(ps), ps), false);
  assert.equal(startMatches(ps, String(ps)), false, 'a ps start that is not a number');
});

test('L5 the store: a hello whose start is not proven brings nothing back and keeps nothing of its session for the next start', async () => {
  const w = await world();
  try {
    const { two, back } = await restarted(w, { unproven: 'the start time in the channel\'s hello is not its process\'s (ps)' });
    assert.deepEqual({ restored: back.restored, dropped: back.dropped, why: back.why }, { restored: 0, dropped: 1, why: 'the start time in the channel\'s hello is not its process\'s (ps)' });
    assert.deepEqual(two.store.restoringPermissions(), []);
    // A card opened in that session is not written for the next start (no channel kept).
    await two.open('fghij', { relayedAt: w.clock.t });
    await two.store.flushPermissions();
    w.clock.t += MIN;
    const three = await storeAt(w);
    assert.equal(three.start(A).restored, 0, 'nothing on file for the unproven session');
  } finally { await w.clean(); }
});

test('L5 the store: an empty or non-string doubt is no doubt; a hello with no start keeps its own words', async () => {
  for (const unproven of ['', null, undefined, 7]) {
    const w = await world();
    try {
      const { back } = await restarted(w, { unproven });
      assert.equal(back.restored, 1, String(unproven));
    } finally { await w.clean(); }
  }
  const w = await world();
  try {
    const { back } = await restarted(w, { startedAt: null, unproven: 'x' });
    assert.equal(back.why, 'the channel\'s hello did not say its pid and start');
  } finally { await w.clean(); }
});

// The socket over a real Unix socket: the verifier's ps start decides.
const call = ({ socketPath, method, path, body = null, headers = {} }) => new Promise((resolve, reject) => {
  const raw = body === null ? null : JSON.stringify(body);
  const req = request({ socketPath, method, path, headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers } }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});
async function serverAt(w, n, { psStart = A.startedAt, verify = true } = {}) {
  const logs = [], events = [];
  const store = createChatStore({ dir: w.dir, now: () => w.clock.t, log: l => logs.push(l) });
  await store.load();
  const approvals = { mode: () => 'on', serverMode: () => 'on', assess: () => ({ denyOnly: [], why: null }), noteChannelRelay: v => v, noteChannelTest: () => false, noteOpenCount: () => {} };
  const socket = createSocketRouter({
    store, now: () => w.clock.t, onEvent: e => events.push(e), log: l => logs.push(l), pingMs: 60e3, approvals,
    verifyRestart: async () => ({ ok: true, startedAt: psStart === null ? null : Math.floor(psStart / 1000) * 1000 }), verifyEveryHello: verify
  });
  const socketPath = join(w.dir, `s${n}.sock`);
  const srv = createServer((q, r) => socket.handler(q, r));
  await new Promise(r => srv.listen(socketPath, r));
  w.servers.add(srv);
  const env = { store, logs, events, token: null };
  env.hello = async (token = null) => { const h = await call({ socketPath, method: 'POST', path: '/v1/hello', body: { ...A, permHoldMs: HOLD, relay: 'allow', test: false }, headers: token ? { [SESSION_HEADER]: token } : {} }); if (h.status === 200) env.token = h.json.token; return h; };
  env.open = (id, body = {}) => call({ socketPath, method: 'POST', path: '/v1/permission-request', headers: { [SESSION_HEADER]: env.token }, body: { requestId: id, tool: 'Bash', description: 'list', inputPreview: PREVIEW, relayedAt: T0, ...body } });
  env.close = async () => { await store.flushPermissions(); w.servers.delete(srv); srv.closeAllConnections?.(); await new Promise(r => srv.close(r)); };
  return env;
}
async function socketRestart(w, second) {
  const one = await serverAt(w, 1);
  assert.equal((await one.hello()).status, 200);
  assert.equal((await one.open('abcde')).status, 200);
  const old = one.token;
  await one.close();
  w.clock.t += MIN;
  const two = await serverAt(w, 2, second);
  assert.equal((await two.hello(old)).status, 200);
  return two;
}

test('L5 socket: ps\'s start for the pid within the margin brings the card back; another start, no ps start, or no ps check brings none, and the log says why', async () => {
  for (const [name, second, line] of [
    ['ps agrees', {}, `chat: 1 permission card from before the restart held for the sessions pass (the same channel process said hello, pid ${A.pid})`],
    ['ps agrees, the hello 1.25 s after its whole second', { psStart: A.startedAt - 1000 }, `chat: 1 permission card from before the restart held for the sessions pass (the same channel process said hello, pid ${A.pid})`],
    ['ps says a whole second too early (2.25 s)', { psStart: A.startedAt - 2000 }, 'chat: 1 permission card from before the restart not put back (the start time in the channel\'s hello is not its process\'s (ps))'],
    ['ps says a later start', { psStart: A.startedAt + 5000 }, 'chat: 1 permission card from before the restart not put back (the start time in the channel\'s hello is not its process\'s (ps))'],
    ['ps says an earlier start', { psStart: A.startedAt - 3000 }, 'chat: 1 permission card from before the restart not put back (the start time in the channel\'s hello is not its process\'s (ps))'],
    ['ps gives no start', { psStart: null }, 'chat: 1 permission card from before the restart not put back (the start time in the channel\'s hello is not its process\'s (ps))'],
    ['no ps check', { verify: false }, 'chat: 1 permission card from before the restart not put back (the channel\'s start could not be checked (chat.channelServer is not set))']
  ]) {
    const w = await world();
    try {
      const two = await socketRestart(w, second);
      assert.ok(two.logs.includes(line), `${name}: ${two.logs.join('\n')}`);
      assert.equal(two.store.restoringPermissions().length, line.includes('held for') ? 1 : 0, name);
      await two.close();
    } finally { await w.clean(); }
  }
});

// ---- L7: the channel posts a held card again ----

test('L7 the store: the same body under a held id is the held card: no repeat, no new message, and the pass then shows one card', async () => {
  const w = await world();
  try {
    const { two } = await restarted(w);
    const before = two.store.list({ limit: 50 }).length;
    assert.ok(before > 0);
    const p = await two.open('abcde');
    assert.deepEqual(p, { requestId: 'abcde', tool: 'Bash', state: 'held', openedAt: T0 });
    assert.equal(two.store.permission('abcde'), null, 'no entry made');
    assert.deepEqual(two.events, [], 'nothing drawn');
    assert.equal(two.store.restoringPermissions().length, 1, 'still held');
    assert.equal(two.store.list({ limit: 50 }).length, before, 'no new message');
    assert.deepEqual(two.store.settleRestored(new Map([['abcde', true]])), { opened: ['abcde'], dropped: [] });
    assert.equal(two.store.permission('abcde').state, 'open');
    assert.deepEqual(two.events, [['permission', 'abcde', 'open']], 'one card');
    // After it is shown, the same body again is that card (Ultron's L1 on jos/card-lows).
    assert.equal((await two.open('abcde')).state, 'restored');
  } finally { await w.clean(); }
});

test('L7 the store: a held id with another tool, description, preview or cut is a repeat, and the held card goes as newer', async () => {
  for (const change of [{ tool: 'Read' }, { description: 'list the files.' }, { inputPreview: PREVIEW + ' ' }, { cut: true }]) {
    const w = await world();
    try {
      const { two } = await restarted(w);
      assert.equal((await two.open('abcde', change)).state, 'repeat', JSON.stringify(change));
      assert.deepEqual(two.store.settleRestored(new Map([['abcde', true]])), { opened: [], dropped: ['abcde'] });
    } finally { await w.clean(); }
  }
});

test('L7 the store: a new id while one is held opens as usual; the held one\'s re-post after the pass let it go is a repeat', async () => {
  const w = await world();
  try {
    const { two } = await restarted(w);
    assert.equal((await two.open('zzzzz', { relayedAt: w.clock.t })).state, 'open');
    two.store.settleRestored(new Map([['abcde', false]]));
    assert.equal((await two.open('abcde')).state, 'repeat');
  } finally { await w.clean(); }
});

test('L7 socket: the old server took the relay and stopped before answering; the channel\'s post after the hello keeps the held card, logs it and opens nothing', async () => {
  const w = await world();
  try {
    const two = await socketRestart(w, {});
    const r = await two.open('abcde');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { requestId: 'abcde', state: 'held', openedAt: T0 });
    assert.ok(two.logs.includes('chat: the channel posted again a permission request held from before the restart (abcde); it waits for the sessions pass'), two.logs.join('\n'));
    assert.equal(two.events.filter(e => e.kind === 'permission-opened').length, 0, 'no event for a card not drawn');
    assert.equal(two.store.restoringPermissions().length, 1);
    assert.deepEqual(two.store.settleRestored(new Map([['abcde', true]])).opened, ['abcde']);
    await two.close();
  } finally { await w.clean(); }
});

test('L1 the store: a repost of the open restored card after the pass showed it is that card: no entry, no message, no event, still answerable', async () => {
  const w = await world();
  try {
    const { two } = await restarted(w);
    assert.deepEqual(two.store.settleRestored(new Map([['abcde', true]])).opened, ['abcde']);
    const card = two.store.permission('abcde');
    const messages = two.store.list({ limit: 50 }).length;
    const events = two.events.length;
    assert.deepEqual(await two.open('abcde'), { requestId: 'abcde', tool: 'Bash', state: 'restored', openedAt: T0 });
    assert.equal(two.store.permission('abcde'), card, 'the restored card is still the one found by its id');
    assert.equal(two.store.list({ limit: 50 }).length, messages, 'no new message');
    assert.equal(two.events.length, events, 'no event');
    const r = await two.store.answerPermission('abcde', 'deny', 'phone');
    assert.equal(r.ok, true, r.error);
    // Answered: a repost now is a repeat, as is another body while it was open.
    assert.equal((await two.open('abcde')).state, 'repeat');
  } finally { await w.clean(); }
});

test('L1 the store: another body, a card that is not a restored one, or one from an earlier session is a repeat as before', async () => {
  const w = await world();
  try {
    const { two } = await restarted(w);
    two.store.settleRestored(new Map([['abcde', true]]));
    assert.equal((await two.open('abcde', { description: 'something else' })).state, 'repeat');
  } finally { await w.clean(); }
  const w2 = await world();
  try {
    const s = await storeAt(w2);
    s.start(A);
    await s.open('fghij');
    assert.equal((await s.open('fghij')).state, 'repeat', 'a card opened in this process, posted again');
  } finally { await w2.clean(); }
  const w3 = await world();
  try {
    const { two } = await restarted(w3);
    two.store.settleRestored(new Map([['abcde', true]]));
    two.start({ pid: 4102, startedAt: T0 + 5 * MIN });  // a new process: a new session
    assert.equal((await two.open('abcde')).state, 'open', 'a new session sees the id afresh');
  } finally { await w3.clean(); }
});

test('L1 socket: the repost after the pass logs it and opens nothing', async () => {
  const w = await world();
  try {
    const two = await socketRestart(w, {});
    two.store.settleRestored(new Map([['abcde', true]]));
    const r = await two.open('abcde');
    assert.deepEqual(r.json, { requestId: 'abcde', state: 'restored', openedAt: T0 });
    assert.ok(two.logs.includes('chat: the channel posted again a permission request from before the restart (abcde); its card is already shown again'), two.logs.join('\n'));
    assert.equal(two.events.filter(e => e.kind === 'permission-opened').length, 0);
    assert.equal(two.store.permission('abcde').state, 'open');
    await two.close();
  } finally { await w.clean(); }
});

// ---- M1: every recover line ends with the command ----

test('M1: every line the server sends with the recover command ends with it, nothing after (a paste of the end runs exactly it)', () => {
  const ends = (text, name) => {
    assert.ok(text.endsWith(RECOVER_COMMAND), `${name}: ${text}`);
    assert.ok(!text.slice(text.indexOf(RECOVER_COMMAND) + RECOVER_COMMAND.length).trim(), name);
    assert.equal(text.indexOf(RECOVER_COMMAND), text.lastIndexOf(RECOVER_COMMAND), `${name}: once`);
  };
  ends(RECOVER_LINE, 'the line');
  ends(BODIES.offline, 'the chat\'s offline push');
  const [lead] = pushableFrom([{ kind: 'service', key: 'service:session:Jarvis', text: 'Jarvis is not running' }]);
  ends(lead.message, 'the lead-down alert');
  ends(alertPayload('https://mini.example.ts.net', { title: 'T', body: 'short', tail: RECOVER_LINE }).notification.body, 'a jarvis-down push');
  ends(alertPayload('https://mini.example.ts.net', { title: 'T', body: '€'.repeat(5000), tail: RECOVER_LINE }).notification.body, 'a long jarvis-down push');
  // Until the jarvis release carries 10981bf, no line gives --if-down.
  for (const t of [RECOVER_LINE, BODIES.offline, lead.message]) assert.ok(!t.includes('--if-down'));
});

// ---- L6: the mark, and the lost exact copy ----

test('L6 publicPermission: a card put back says restored; a new one does not; the mark is not in what a verdict is checked against', async () => {
  const w = await world();
  try {
    const { two } = await restarted(w);
    await two.open('zzzzz', { relayedAt: w.clock.t });
    two.store.settleRestored(new Map([['abcde', true]]));
    const back = two.store.publicPermission(two.store.permission('abcde'));
    assert.equal(back.restored, true);
    assert.equal('restored' in two.store.publicPermission(two.store.permission('zzzzz')), false);
    // The verdict's hash is the card's tool, description and preview, as for any card.
    const r = await two.store.answerPermission('abcde', 'allow', 'phone', { requireShown: true, shown: shownHash('Bash', 'list the files', PREVIEW) });
    assert.equal(r.ok, true, r.error);
  } finally { await w.clean(); }
});

test('L6 assess: a Bash card put back says its exact copy was lost in the restart; a new one says none came; a report since gives one as before', async () => {
  const g = createApprovals({ mode: 'on', bash: 'exact', now: () => T0 });
  const card = { requestId: 'abcde', tool: 'Bash', description: 'list', inputPreview: PREVIEW, relayedAt: T0, state: 'open' };
  assert.ok(g.assess(card).denyOnly.includes(NO_EXACT));
  const back = g.assess({ ...card, restored: true });
  assert.ok(back.denyOnly.includes(EXACT_LOST), back.denyOnly.join('; '));
  assert.ok(!back.denyOnly.includes(NO_EXACT));
  assert.match(EXACT_LOST, /lost when the Control Room restarted/);
  // Not Bash: no word of an exact copy.
  assert.ok(!g.assess({ ...card, tool: 'Read', inputPreview: '{"file_path":"/home/owner/x"}', restored: true }).denyOnly.includes(EXACT_LOST));
});

// ---- L4: which card can take the answer for a wait ----

const waitOf = (over = {}) => ({ sessionId: LEAD, asks: [{ agent: null, tool: 'Bash' }], hint: null, ...over });
const own = [{ sessionId: LEAD, agent: null }];

test('L4 cardTakesWait: Allow offered, the wait\'s session by a pass, the named ask\'s own tool and thread; anything unknown is no card', () => {
  const card = { tool: 'Bash', canAllow: true };
  assert.equal(cardTakesWait(waitOf(), card, own), true);
  assert.equal(cardTakesWait(waitOf(), { ...card, canAllow: false }, own), false, 'a Deny-only card');
  assert.equal(cardTakesWait(waitOf(), { ...card, canAllow: 'yes' }, own), false);
  assert.equal(cardTakesWait(waitOf(), card, [{ sessionId: OTHER, agent: null }]), false, 'a card of another session');
  assert.equal(cardTakesWait(waitOf(), card, null), false, 'no pass has judged the card');
  assert.equal(cardTakesWait(waitOf(), card, []), false, 'a pass found no thread for it');
  assert.equal(cardTakesWait(waitOf(), { ...card, tool: 'Read' }, own), false, 'another tool');
  // MCP tools: one label, but the names must match.
  const mcp = waitOf({ asks: [{ agent: null, tool: 'mcp__plugin_x_y__send' }] });
  assert.equal(cardTakesWait(mcp, { tool: 'mcp__plugin_x_y__read', canAllow: true }, own), false, 'another MCP tool of the same label');
  assert.equal(cardTakesWait(mcp, { tool: 'mcp__plugin_x_y__send', canAllow: true }, own), true);
  // The thread: the subagent's ask needs the card in that subagent's thread.
  const sub = waitOf({ asks: [{ agent: KEY, tool: 'Bash' }] });
  assert.equal(cardTakesWait(sub, card, own), false, 'the card is the lead\'s own thread\'s');
  assert.equal(cardTakesWait(sub, card, [{ sessionId: LEAD, agent: KEY }]), true);
  assert.equal(cardTakesWait(sub, card, [{ sessionId: LEAD, agent: null }, { sessionId: LEAD, agent: KEY }]), true, 'one of its threads');
  // The oldest ask is the one the push names.
  const two = waitOf({ asks: [{ agent: null, tool: 'Read' }, { agent: null, tool: 'Bash' }] });
  assert.equal(cardTakesWait(two, card, own), false);
  assert.equal(cardTakesWait(two, { ...card, tool: 'Read' }, own), true);
  // No ask (hooks that name no tool): the session and the hint's label; with no hint either,
  // no card at all (Ultron's L2 on jos/card-lows: the safer of his two options).
  assert.equal(cardTakesWait(waitOf({ asks: [] }), card, own), false, 'no ask, no hint');
  assert.equal(cardTakesWait(waitOf({ asks: [] }), card, [{ sessionId: LEAD, agent: KEY }]), false);
  assert.equal(cardTakesWait(waitOf({ asks: [], hint: 'Bash' }), card, own), true);
  assert.equal(cardTakesWait(waitOf({ asks: [], hint: 'Read' }), card, own), false);
  assert.equal(cardTakesWait(waitOf({ asks: [], hint: 'Bash' }), card, [{ sessionId: OTHER, agent: null }]), false);
  // Shapes.
  assert.equal(cardTakesWait(null, card, own), false);
  assert.equal(cardTakesWait(waitOf(), null, own), false);
  assert.equal(cardTakesWait(waitOf({ sessionId: null }), card, own), false);
  assert.equal(cardTakesWait(waitOf(), { canAllow: true }, own), false, 'a card with no tool');
});

test('L4 hasCardFor: the wait by its key, each open card with its own Allow and threads; the reminder\'s words follow', async () => {
  const cards = [{ requestId: 'aaaaa', tool: 'Bash' }, { requestId: 'bbbbb', tool: 'Read' }];
  const allow = new Map([['aaaaa', false], ['bbbbb', true]]);
  const threads = new Map([['aaaaa', own], ['bbbbb', own]]);
  const has = hasCardFor({ waitThread: k => (k === 'needs-you:k1' ? waitOf() : k === 'needs-you:k2' ? waitOf({ asks: [{ agent: null, tool: 'Read' }] }) : null), openCards: () => cards, canAllow: p => allow.get(p.requestId), threadsOf: id => threads.get(id) });
  assert.equal(has({ key: 'needs-you:k1' }), false, 'its Bash card is Deny-only; the Read card is not its tool');
  assert.equal(has({ key: 'needs-you:k2' }), true);
  assert.equal(has({ key: 'needs-you:gone' }), false, 'a wait no longer known');
  assert.equal(has(null), false);
  allow.set('aaaaa', true);
  assert.equal(has({ key: 'needs-you:k1' }), true);
  threads.set('aaaaa', null);
  assert.equal(has({ key: 'needs-you:k1' }), false, 'no pass has judged it');
  const loose = hasCardFor({ waitThread: () => waitOf(), openCards: () => [{ requestId: 'aaaaa', tool: 'Bash' }], canAllow: () => 'yes', threadsOf: () => own });
  assert.equal(loose({ key: 'x' }), false, 'only a plain true offers Allow');
  const noCards = hasCardFor({ waitThread: () => waitOf(), openCards: () => null, canAllow: () => true, threadsOf: () => own });
  assert.equal(noCards({ key: 'x' }), false);
  // In the reminder: a Deny-only card leaves the chat out of the words.
  for (const [canAllow, tail] of [[false, REMINDER_TAIL_NO_CARD], [true, REMINDER_TAIL]]) {
    const pushes = [];
    const rem = createApprovalReminders({ push: async b => { pushes.push(b); return { tried: 1, reached: 1 }; }, log: () => {}, hasCard: hasCardFor({ waitThread: () => waitOf(), openCards: () => [{ requestId: 'aaaaa', tool: 'Bash' }], canAllow: () => canAllow, threadsOf: () => own }) });
    await rem.step([{ key: 'needs-you:k1', who: 'Inventlead', run: null, tool: 'Bash', since: T0, own: true }], T0 + 10 * MIN);
    assert.deepEqual(pushes, [`Inventlead has waited 10 min on an approval card. ${tail}`]);
  }
});

test('L4 needs-you permissionThread: the wait its key names, with its open asks (tool names, thread hashes) and hint; never another session\'s', () => {
  const ny = createNeedsYouStore({ whoFor: () => 'Inventlead', detailFor: () => ({ tool: 'Bash', run: null }) });
  const at = T0;
  ny.record({ event: 'PermissionRequest', sessionId: LEAD, tool: 'mcp__plugin_x_y__send', at }, at);
  ny.record({ event: 'Notification', sessionId: LEAD, kind: 'permission', at: at + 1 }, at + 1);
  ny.record({ event: 'Notification', sessionId: OTHER, kind: 'permission', at: at + 2 }, at + 2);
  const t = ny.permissionThread(waitKey(LEAD), at + 3);
  assert.deepEqual(t, { sessionId: LEAD, asks: [{ agent: null, tool: 'mcp__plugin_x_y__send' }], hint: null });
  assert.deepEqual(ny.permissionThread(waitKey(OTHER), at + 3), { sessionId: OTHER, asks: [], hint: null });
  assert.equal(ny.permissionThread('needs-you:000000000000', at + 3), null);
  assert.equal(ny.permissionThread(7, at + 3), null);
  // The view still carries no id and no tool's own name.
  const view = JSON.stringify(ny.view(at + 3));
  assert.ok(!view.includes(LEAD) && !view.includes('mcp__plugin_x_y__send'), view);
});

test('L4 answered-elsewhere threadsOf: null before a pass judged the card, [] when it found none, the threads (session, thread) when it did', () => {
  const cards = [{ requestId: 'aaaaa', tool: 'Bash', relayedAt: T0 }, { requestId: 'bbbbb', tool: 'Read', relayedAt: T0 }];
  const store = { closablePermissions: () => cards, closePermissionsElsewhere: () => [], restoringPermissions: () => [], permissionSessionAt: T0 - HOUR };
  let clock = T0 + MIN;
  const ae = createAnsweredElsewhere({ store, now: () => clock, log: () => {} });
  assert.equal(ae.threadsOf('aaaaa'), null);
  const threads = new Map([[LEAD, { main: T0 - MIN, agents: new Map(), types: new Map(), mainOpen: [{ name: 'Bash', at: T0 - 1000 }], agentsOpen: new Map() }]]);
  ae.pass({ threads, sessions: [LEAD], readAt: clock });
  assert.deepEqual(ae.threadsOf('aaaaa'), [{ sessionId: LEAD, agent: null }]);
  assert.deepEqual(ae.threadsOf('bbbbb'), []);
  // A copy: changing it changes nothing kept.
  ae.threadsOf('aaaaa').push({ sessionId: OTHER, agent: null });
  assert.equal(ae.threadsOf('aaaaa').length, 1);
});

// server.mjs is not run by a test; its wiring for these is checked here.
test('server.mjs and the socket: the reminder\'s hasCard from the parts, the verifier\'s start passed to the store', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /canAllow: p => approvals\.view\(p\)\.canAllow, threadsOf: id => answeredElsewhere\?\.threadsOf\(id\) \?\? null/);
  const sock = await readFile(new URL('../lib/chat-socket.mjs', import.meta.url), 'utf8');
  assert.match(sock, /psStart = Number\.isFinite\(verdict\.startedAt\) \? verdict\.startedAt : null;/);
  assert.match(sock, /!startMatches\(client\.startedAt, psStart\)/);
});
