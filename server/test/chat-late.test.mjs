// Board 89248590 (2026-11-20): two iPad messages written at 12:10 reached the
// server at 15:38 with no tap, were stored as new and read as new. These tests
// replay that: a send whose body was made hours before it lands is held for the
// owner's tap, a tap sends it, and the lead's inbound line says when it was written.
// Every name and message is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChatEnv } from './helpers/chat-env.mjs';
import { request, createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { toInbound, historyMessage, createSocketRouter, SESSION_HEADER } from '../lib/chat-socket.mjs';
import * as late from '../lib/chat-late.mjs';
import { STALE_SEND_MS, composedAtOf, staleSend, lateMeta, lateNote, lateBy, when, badTime, lateComposedAt } from '../lib/chat-late.mjs';
// Read through the namespace so the file loads, and fails by test, before leadText exists.
const leadText = m => late.leadText(m);

const MIN = 60e3, HOUR = 3600e3;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
// The note's clock, made a second way (the locale's own formatter): 12:10 PM EST, in
// whatever zone this run is in. The zone-pinned literals are in the test further down.
const hm = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).replace(/\s+/g, ' ');
// The page's clientId (web lib/orbit/chat.js newClientId): the Send tap's ms in base 36.
const pageId = (t, tail) => `p_${t.toString(36)}_${tail}`;

const send = (env, cookie, body) => env.call({ method: 'POST', path: '/api/chat/messages', headers: { cookie }, body });

test('the 11-20 re-send: two sends made 8 s apart, landing 3.5 h later 8 ms apart, are held, not stored, and say when they were written', async () => {
  const lines = [];
  const env = await makeChatEnv({ routes: { log: l => lines.push(l) } });
  try {
    const ipad = await env.pair('ipad');
    const T0 = env.clock.t;
    // The bodies as the page built them at the Send taps.
    const first = { clientId: pageId(T0, 'ac9dil'), text: 'pasted terminal check', composedAt: T0, confirmed: false };
    const second = { clientId: pageId(T0 + 8000, 'h20vr1'), text: 'did not seem to work', composedAt: T0 + 8000, confirmed: false };
    env.clock.t = T0 + 3 * HOUR + 28 * MIN;
    const a = await send(env, ipad.cookie, first);
    env.clock.t += 8;
    const b = await send(env, ipad.cookie, second);
    for (const [r, body] of [[a, first], [b, second]]) {
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.stale, true);
      assert.equal(r.json.composedAt, body.composedAt);
      assert.ok(r.json.error.includes(` ${hm(body.composedAt)} and reached`), r.json.error);
      assert.ok(!r.text.includes(body.text), 'the text is never echoed');
    }
    assert.equal(env.store.size, 0, 'neither was stored, so nothing reached the lead');
    assert.deepEqual(lines, ['chat: a message from ipad written 3 h 28 min ago was held for a tap, not stored', 'chat: a message from ipad written 3 h 28 min ago was held for a tap, not stored']);
  } finally { await env.close(); }
});

test('a page built before the change (no composedAt) is caught by the time in its clientId', async () => {
  const env = await makeChatEnv();
  try {
    const ipad = await env.pair('ipad');
    const T0 = env.clock.t;
    env.clock.t = T0 + 2 * HOUR;
    const r = await send(env, ipad.cookie, { clientId: pageId(T0, 'ac9dil'), text: 'old page' });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.composedAt, T0);
    // An id of another shape carries no time: sent as before.
    const other = await send(env, ipad.cookie, { clientId: 'page-1', text: 'no time known' });
    assert.equal(other.status, 200, other.text);
    assert.equal(env.store.byClientId('page-1').meta, null);
  } finally { await env.close(); }
});

test('Send now (confirmed) stores it, marks it late, and the lead\'s line starts with when it was written; the uploads held for it still go', async () => {
  const env = await makeChatEnv();
  try {
    const ipad = await env.pair('ipad');
    const T0 = env.clock.t;
    const up = await env.call({ method: 'POST', path: '/api/chat/attachments?name=shot.jpg', headers: { cookie: ipad.cookie, 'content-type': 'image/jpeg' }, body: JPEG });
    assert.equal(up.status, 200, up.text);
    const body = { clientId: pageId(T0, 'ac9dil'), text: 'held message', composedAt: T0, attachmentIds: [up.json.id] };
    env.clock.t = T0 + 3 * HOUR + 28 * MIN;
    assert.equal((await send(env, ipad.cookie, { ...body, confirmed: false })).status, 409);
    env.clock.t += 20e3;
    const ok = await send(env, ipad.cookie, { ...body, confirmed: true });
    assert.equal(ok.status, 200, ok.text);
    const m = env.store.byClientId(body.clientId);
    assert.deepEqual(m.meta, { composedAt: T0 });
    assert.equal(m.text, 'held message', 'the stored text stays as typed');
    assert.equal(m.attachments.length, 1, 'the upload waited for the tap');
    const line = toInbound(m);
    assert.equal(line.composedAt, T0);
    assert.equal(line.at, m.at);
    assert.equal(line.text, `[Written ${hm(T0)}, delivered ${hm(m.at)}: 3 h 28 min late. Read it as of when it was written.]\n\nheld message`);
    // A Retry of the same message after its answer was lost: the dedup still answers first.
    const again = await send(env, ipad.cookie, { ...body, confirmed: false });
    assert.deepEqual(again.json, { id: m.id, seq: m.seq, duplicate: true });
    assert.equal(env.store.size, 1);
  } finally { await env.close(); }
});

test('the dedup comes before the age: a message already stored answers 200 even when its retry is old and untapped', async () => {
  const env = await makeChatEnv();
  try {
    const ipad = await env.pair('ipad');
    const T0 = env.clock.t;
    const body = { clientId: pageId(T0, 'aaaaaa'), text: 'took', composedAt: T0 };
    const sent = await send(env, ipad.cookie, body);
    assert.equal(sent.status, 200);
    env.clock.t += 2 * HOUR;
    const late = await send(env, ipad.cookie, body);
    assert.deepEqual(late.json, { id: sent.json.id, seq: sent.json.seq, duplicate: true });
  } finally { await env.close(); }
});

test('the window: 5 minutes is still sent unmarked, a millisecond more is held; a clock ahead counts as now', async () => {
  const env = await makeChatEnv();
  try {
    const ipad = await env.pair('ipad');
    const T = env.clock.t;
    const edge = await send(env, ipad.cookie, { clientId: 'edge', text: 'x', composedAt: T - STALE_SEND_MS });
    assert.equal(edge.status, 200, edge.text);
    assert.equal(env.store.byClientId('edge').meta, null, 'not late, so no mark');
    assert.equal(toInbound(env.store.byClientId('edge')).text, 'x');
    assert.ok(!('composedAt' in toInbound(env.store.byClientId('edge'))));
    assert.equal((await send(env, ipad.cookie, { clientId: 'past', text: 'x', composedAt: T - STALE_SEND_MS - 1 })).status, 409);
    const ahead = await send(env, ipad.cookie, { clientId: 'ahead', text: 'x', composedAt: T + HOUR });
    assert.equal(ahead.status, 200, 'a device clock ahead of the server is taken as now');
    assert.equal(env.store.byClientId('ahead').meta, null);
  } finally { await env.close(); }
});

test('the timing fields are typed: a composedAt that is not ms and a confirmed that is not a boolean are refused', async () => {
  const env = await makeChatEnv();
  try {
    const ipad = await env.pair('ipad');
    // Before 2020 too (board f8e1ea1b): it would read as no time and skip the clientId's.
    const before2020 = [['1 ms', { composedAt: 1 }], ['the last ms of 2019', { composedAt: Date.UTC(2020, 0, 1) - 1 }], ['in seconds, not ms', { composedAt: Math.floor(Date.UTC(2026, 10, 20) / 1000) }]];
    for (const [why, extra] of [['string', { composedAt: '12:10' }], ['float', { composedAt: 1.5 }], ['negative', { composedAt: -5 }], ['zero', { composedAt: 0 }], ...before2020, ['confirmed string', { confirmed: 'yes' }]]) {
      const r = await send(env, ipad.cookie, { clientId: 'typed', text: 'x', ...extra });
      assert.equal(r.status, 400, why);
      if ('composedAt' in extra) assert.equal(r.json.error, 'composedAt must be a time in ms, from 2020 on', why);
    }
    assert.equal(env.store.size, 0);
  } finally { await env.close(); }
});

test('chat-late helpers: the time comes from composedAt, else the page clientId; staleness needs no tap; the note words', () => {
  const now = Date.UTC(2026, 10, 20, 20, 38, 49);
  assert.equal(composedAtOf({ composedAt: now - 1000, clientId: pageId(now - 9e6, 'abcdef') }, now), now - 1000, 'composedAt wins');
  assert.equal(composedAtOf({ clientId: pageId(now - 9e6, 'abcdef') }, now), now - 9e6);
  assert.equal(composedAtOf({ clientId: 'p_zz_abcdef' }, now), null, 'before 2020 is no time');
  assert.equal(composedAtOf({ clientId: 'c_0123456789abcdef01234567' }, now), null);
  assert.equal(composedAtOf({ composedAt: now + 5000 }, now), now);
  assert.equal(composedAtOf({}, now), null);
  assert.equal(staleSend({ composedAt: now - STALE_SEND_MS - 1 }, now), true);
  assert.equal(staleSend({ composedAt: now - STALE_SEND_MS - 1, confirmed: true }, now), false);
  assert.equal(staleSend({ composedAt: null }, now), false);
  assert.equal(staleSend({ composedAt: now - STALE_SEND_MS }, now), false);
  assert.equal(lateMeta(now - STALE_SEND_MS, now), null);
  assert.deepEqual(lateMeta(now - STALE_SEND_MS - 1, now), { composedAt: now - STALE_SEND_MS - 1 });
  assert.equal(lateMeta(null, now), null);
  assert.equal(lateComposedAt({ at: now, meta: { composedAt: now - HOUR } }), now - HOUR);
  assert.equal(lateComposedAt({ at: now, meta: { composedAt: now - MIN } }), null, 'a mark inside the window is no mark');
  assert.equal(lateComposedAt({ at: now, meta: null }), null);
  assert.equal(badTime({}), null);
  assert.equal(badTime({ composedAt: null, confirmed: null }), null);
  assert.equal(badTime({ composedAt: now, confirmed: true }), null);
  assert.equal(badTime({ composedAt: Date.UTC(2020, 0, 1) }), null, 'the first ms of 2020 is a time');
  assert.equal(badTime({ composedAt: Date.UTC(2020, 0, 1) - 1 }), 'composedAt must be a time in ms, from 2020 on');
  assert.equal(lateBy(6 * MIN), '6 min');
  assert.equal(lateBy(3 * HOUR + 28 * MIN), '3 h 28 min');
  assert.equal(lateBy(2 * HOUR), '2 h');
  assert.equal(lateBy(50 * HOUR), '2 days');
  // A different day puts the day in front of the time.
  const yesterday = now - 24 * HOUR;
  const d = new Date(yesterday);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  assert.equal(when(yesterday, now), `${months[d.getMonth()]} ${d.getDate()} ${hm(yesterday)}`);
  assert.equal(when(now - MIN, now), hm(now - MIN));
  assert.equal(lateNote(now - 3 * HOUR - 28 * MIN, now), `[Written ${hm(now - 3 * HOUR - 28 * MIN)}, delivered ${hm(now)}: 3 h 28 min late. Read it as of when it was written.]`);
  // A late message of files only still says so; the lead's other lines are untouched.
  const filesOnly = toInbound({ seq: 1, id: 'm_x', at: now, from: 'jeff', kind: 'chat', text: '', meta: { composedAt: now - HOUR }, attachments: [] });
  assert.equal(filesOnly.text, lateNote(now - HOUR, now));
  const lead = toInbound({ seq: 2, id: 'm_y', at: now, from: 'jarvis', kind: 'chat', text: 'hi', meta: { composedAt: now - HOUR } });
  assert.equal(lead, null, 'the lead\'s own messages never go down the inbound stream');
});

// ---- Ultron's M1 (board cd4d7dc3, 2026-11-20 review): every way the lead reads the owner's
// message says when it was written: the inbound stream, the restart catch-up
// (/v1/unanswered) and the history call (/v1/history). Before, only the stream did, so a
// message caught up after a restart read as new.

const viaSocket = (sockPath, method, path, payload, token) => new Promise((resolve, reject) => {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const req = request({ socketPath: sockPath, method, path, agent: false, headers: { host: 'localhost', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(token ? { [SESSION_HEADER]: token } : {}) } }, res => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  req.end(body);
});

// The inbound stream never ends by itself: read it until `want` message lines have
// come, or until the deadline (counted from the request, not the answer), then hang
// up. Settles once, on an error too; at the deadline it gives what it has, so the
// comparison below names what was missing (Ultron's L2).
const readMessages = (sockPath, path, token, { want, deadlineMs = 5000 }) => new Promise((resolve, reject) => {
  const messages = [];
  let settled = false, buf = '';
  const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); fn(v); };
  const timer = setTimeout(() => settle(resolve, messages), deadlineMs);
  const req = request({ socketPath: sockPath, method: 'GET', path, agent: false, headers: { host: 'localhost', [SESSION_HEADER]: token } }, res => {
    if (res.statusCode !== 200) return settle(reject, new Error(`inbound answered ${res.statusCode}`));
    res.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let l;
        try { l = JSON.parse(line); } catch (err) { return settle(reject, err); }
        if (l.type === 'message') messages.push(l);
        if (messages.length >= want) return settle(resolve, messages);
      }
    });
    res.on('end', () => settle(resolve, messages));
    res.on('error', err => settle(reject, err));
  });
  req.on('error', err => settle(reject, err));
  req.end();
});

test('M1: the late note is the same on the inbound stream, the restart catch-up and the history call; on time and the page\'s copy stay as typed', async () => {
  const env = await makeChatEnv();
  const sockDir = await mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'late-'));
  const sockPath = join(sockDir, 'c.sock');
  const router = createSocketRouter({ store: env.store, now: env.now, log: () => {}, pingMs: 60e3 });
  const server = createServer((req, res) => router.handler(req, res));
  await new Promise(r => server.listen(sockPath, r));
  try {
    const ipad = await env.pair('ipad');
    const T0 = env.clock.t;
    // One written at T0 and sent with a tap 3 h 28 min later; one on time; one of files only, late.
    env.clock.t = T0 + 3 * HOUR + 28 * MIN;
    const late = await send(env, ipad.cookie, { clientId: pageId(T0, 'ac9dil'), text: 'pasted terminal check', composedAt: T0, confirmed: true });
    assert.equal(late.status, 200, late.text);
    const onTime = await send(env, ipad.cookie, { clientId: 'on-time', text: 'and this one is new', composedAt: env.clock.t });
    assert.equal(onTime.status, 200, onTime.text);
    const up = await env.call({ method: 'POST', path: '/api/chat/attachments?name=shot.jpg', headers: { cookie: ipad.cookie, 'content-type': 'image/jpeg' }, body: JPEG });
    const filesOnly = await send(env, ipad.cookie, { clientId: pageId(T0 + 1000, 'bbbbbb'), text: '', composedAt: T0 + 1000, confirmed: true, attachmentIds: [up.json.id] });
    assert.equal(filesOnly.status, 200, filesOnly.text);
    const at = env.store.get(late.json.id).at;
    const note = `[Written ${hm(T0)}, delivered ${hm(at)}: 3 h 28 min late. Read it as of when it was written.]`;
    const want = new Map([[late.json.id, `${note}\n\npasted terminal check`], [onTime.json.id, 'and this one is new'], [filesOnly.json.id, lateNote(T0 + 1000, env.store.get(filesOnly.json.id).at)]]);

    const token = JSON.parse((await viaSocket(sockPath, 'POST', '/v1/hello', { pid: 1 })).text).token;
    const lines = await readMessages(sockPath, '/v1/inbound?after=0', token, { want: 3 });
    await env.store.ack(env.store.seq); // handed over, so the catch-up lists them (lib/chat-catchup.mjs)
    const unanswered = JSON.parse((await viaSocket(sockPath, 'GET', '/v1/unanswered', undefined, token)).text).messages;
    const history = JSON.parse((await viaSocket(sockPath, 'GET', '/v1/history?limit=10', undefined, token)).text).messages;
    const before = JSON.parse((await viaSocket(sockPath, 'GET', `/v1/history?before=${filesOnly.json.id}&limit=10`, undefined, token)).text).messages;
    // All paths compared at once, so a failure names every path that went wrong.
    const texts = list => list.map(m => [m.id, m.text]);
    const all = [late.json.id, onTime.json.id, filesOnly.json.id].map(id => [id, want.get(id)]);
    assert.deepEqual(
      { stream: texts(lines), unanswered: texts(unanswered), history: texts(history), historyBefore: texts(before) },
      { stream: all, unanswered: all, history: all, historyBefore: all.slice(0, 2) }
    );
    // The page reads its own copy: the text as typed, with meta.composedAt for its "written" line.
    const page = await env.call({ path: '/api/chat/messages', headers: { cookie: ipad.cookie } });
    const pageLate = page.json.messages.find(m => m.id === late.json.id);
    assert.equal(pageLate.text, 'pasted terminal check');
    assert.deepEqual(pageLate.meta, { composedAt: T0 });
    assert.equal(env.store.get(late.json.id).text, 'pasted terminal check', 'the store keeps the text as typed');
  } finally {
    await new Promise(r => server.close(r));
    await rm(sockDir, { recursive: true, force: true });
    await env.close();
  }
});

test('M1: leadText is the one place the lead\'s copy of the owner\'s words is made', () => {
  const now = Date.UTC(2026, 10, 20, 20, 38, 49);
  const m = { seq: 1, id: 'm_x', at: now, from: 'jeff', kind: 'chat', text: 'hi', meta: { composedAt: now - HOUR }, attachments: [] };
  assert.equal(leadText(m), `${lateNote(now - HOUR, now)}\n\nhi`);
  assert.equal(leadText({ ...m, text: '' }), lateNote(now - HOUR, now));
  assert.equal(leadText({ ...m, meta: null }), 'hi');
  assert.equal(leadText({ ...m, meta: { composedAt: now - MIN } }), 'hi', 'inside the window: no note');
  // Only the owner's chat: the lead's own words and anything else are never rewritten.
  assert.equal(leadText({ ...m, from: 'jarvis' }), 'hi');
  assert.equal(leadText({ ...m, kind: 'event', from: 'system' }), 'hi');
  // The owner's, late, but not chat (Ultron's L1): the kind alone keeps the text as stored,
  // so a check on `from` alone fails here. A verdict's history line is one such.
  for (const kind of ['verdict', 'notice', 'stop']) {
    const x = { ...m, kind };
    assert.equal(leadText(x), 'hi', kind);
    assert.equal(historyMessage(x).text, 'hi', `${kind} in history`);
  }
  for (const x of [m, { ...m, text: '' }, { ...m, meta: null }]) {
    assert.equal(toInbound(x).text, leadText(x));
    assert.equal(historyMessage(x).text, leadText(x));
  }
});

// ---- Ultron's L3 (board b547ea09, 2026-11-24): the note's times carry their zone. It used
// to say "15:10", the server's local time with no zone, beside the channel's UTC `ts`.
// Each case runs the module in a child with its own TZ, so these literals hold whatever
// zone the suite runs in (the service runs in US Eastern).
const LATE_MODULE = new URL('../lib/chat-late.mjs', import.meta.url).href;
function notesIn(tz, cases) {
  const script = `const { lateNote, when } = await import(${JSON.stringify(LATE_MODULE)});
    const cases = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(cases.map(([w, a]) => a === undefined ? when(w) : lateNote(w, a))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(cases)], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const TAIL = 'Read it as of when it was written.]';

test('L3: the 11-20 pair in US Eastern reads "12:10 PM EST, delivered 3:38 PM EST", the page\'s clock with the zone', () => {
  const written = Date.UTC(2026, 10, 20, 17, 10, 52);  // 12:10 PM EST
  const at = Date.UTC(2026, 10, 20, 20, 38, 49);       // 3:38 PM EST, the channel's ts 20:38:49Z
  const summer = Date.UTC(2026, 6, 4, 13, 5);          // 9:05 AM EDT
  const [pair, july, overnight, midnight, noon] = notesIn('America/New_York', [
    [written, at], [summer - 2 * HOUR, summer],
    [Date.UTC(2026, 10, 20, 3, 30), Date.UTC(2026, 10, 20, 13, 0)], // 10:30 PM the night before, 8:00 AM
    [Date.UTC(2026, 10, 20, 5, 0)], [Date.UTC(2026, 10, 20, 17, 0)]
  ]);
  assert.equal(pair, `[Written 12:10 PM EST, delivered 3:38 PM EST: 3 h 28 min late. ${TAIL}`);
  assert.equal(july, `[Written 7:05 AM EDT, delivered 9:05 AM EDT: 2 h late. ${TAIL}`);
  assert.equal(overnight, `[Written Nov 19 10:30 PM EST, delivered 8:00 AM EST: 9 h 30 min late. ${TAIL}`);
  assert.equal(midnight, '12:00 AM EST');
  assert.equal(noon, '12:00 PM EST');
  // What Jarvis's style keys on ("[Written …, delivered …") is unchanged.
  assert.match(pair, /^\[Written [^,\]]+, delivered /);
});

test('L3: across a clock change each time keeps its own zone, so the note never reads backwards or long', () => {
  // Fall back, 2026-11-01: 2:00 AM EDT became 1:00 AM EST at 06:00Z. Without zones this
  // read "Written 01:50, delivered 01:20: 30 min late".
  const [fall, spring] = notesIn('America/New_York', [
    [Date.UTC(2026, 10, 1, 5, 50), Date.UTC(2026, 10, 1, 6, 20)],
    // Spring forward, 2026-03-08: 2:00 AM EST became 3:00 AM EDT at 07:00Z ("01:50 to 03:10" read as 80 min).
    [Date.UTC(2026, 2, 8, 6, 50), Date.UTC(2026, 2, 8, 7, 10)]
  ]);
  assert.equal(fall, `[Written 1:50 AM EDT, delivered 1:20 AM EST: 30 min late. ${TAIL}`);
  assert.equal(spring, `[Written 1:50 AM EST, delivered 3:10 AM EDT: 20 min late. ${TAIL}`);
});

test('L3: in a zone with no short English name the offset is the name; under UTC it says UTC', () => {
  const written = Date.UTC(2026, 10, 20, 17, 10, 52), at = Date.UTC(2026, 10, 20, 20, 38, 49);
  assert.deepEqual(notesIn('Asia/Tokyo', [[written, at], [Date.UTC(2026, 10, 20, 14, 0), Date.UTC(2026, 10, 20, 16, 0)]]), [
    `[Written 2:10 AM GMT+9, delivered 5:38 AM GMT+9: 3 h 28 min late. ${TAIL}`,
    `[Written Nov 20 11:00 PM GMT+9, delivered 1:00 AM GMT+9: 2 h late. ${TAIL}` // Tokyo's day, not UTC's
  ]);
  assert.deepEqual(notesIn('UTC', [[written, at]]), [`[Written 5:10 PM UTC, delivered 8:38 PM UTC: 3 h 28 min late. ${TAIL}`]);
  // The longest it gets: a day in front, a two-part offset on both sides, 47 h 59 min.
  const [longest] = notesIn('Pacific/Chatham', [[at - 47 * HOUR - 59 * MIN, at]]);
  assert.match(longest, /^\[Written [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d\d [AP]M GMT\+13:45, delivered \d{1,2}:\d\d [AP]M GMT\+13:45: 47 h 59 min late\./);
  assert.ok(longest.length <= 130, `${longest.length}: within what lib/chat-catchup.mjs's comment allows`);
});
