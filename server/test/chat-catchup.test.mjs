// The restart catch-up (GET /v1/unanswered) fits the channel's room (board e0f5a95d,
// Ultron's L4 on NEXT §41): never empty when anything is unanswered, the newest kept,
// and a note when older messages were left out. Every message here is invented; the
// socket is a temp file, never :8322.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { makeChatEnv } from './helpers/chat-env.mjs';
import { createSocketRouter, historyMessage, SESSION_HEADER } from '../lib/chat-socket.mjs';
import {
  fitCatchUp, channelCost, lineFrame, leftOutNote, cutNote,
  CATCHUP_MAX, CATCHUP_CHARS, CHANNEL_CONTENT_MAX, HEADER_RESERVE
} from '../lib/chat-catchup.mjs';

const MIN = 60e3, HOUR = 3600e3;
const send = (env, cookie, body) => env.call({ method: 'POST', path: '/api/chat/messages', headers: { cookie }, body });
const pageId = (t, tail) => `p_${t.toString(36)}_${tail}`;

// The jarvis channel's catch-up text, as its catchUpContent builds it (jarvis-channel
// server.mjs: one line per message, line breaks folded to " ⏎ ", "<channel" escaped),
// before its cap of CHANNEL_CONTENT_MAX code points cuts from the end.
// The copies are pinned to the channel's source by the drift test at the end.
const HEADER = "Jeff's Jarvis OS messages after Jarvis's last reply, which may have gone unanswered across a restart (oldest first):\n";
const TAG = /<(\s*\/?\s*channel)/gi;
const BREAK_RUNS = /[\r\n]+/g;
const FOLD_TO = ' ⏎ ';
const LINE_TEMPLATE = "`[${isoOf(m.at)}] jeff: ${foldLine(m.text)} (id: ${m.id}${n ? `, +${n}att` : ''})`";
const fold = s => String(s).replace(/[\u2028\u2029]/g, '\n').replace(TAG, '&lt;$1').replace(BREAK_RUNS, FOLD_TO);
const channelText = msgs => HEADER + msgs.map(m => {
  const n = Array.isArray(m.attachments) ? m.attachments.length : 0;
  return `[${new Date(m.at).toISOString()}] jeff: ${fold(m.text)} (id: ${m.id}${n ? `, +${n}att` : ''})`;
}).join('\n');
const fitsChannel = msgs => Array.from(channelText(msgs)).length <= CHANNEL_CONTENT_MAX;

const viaSocket = (sockPath, method, path, payload, token) => new Promise((resolve, reject) => {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const req = request({ socketPath: sockPath, method, path, agent: false, headers: { host: 'localhost', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(token ? { [SESSION_HEADER]: token } : {}) } }, res => {
    let text = '';
    res.setEncoding('utf8'); // an emoji split across chunks stays whole
    res.on('data', c => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(body);
});

// A chat env with the channel's socket router on a temp unix socket, and the channel's
// own steps: hello, then the catch-up.
async function withSocket(fn) {
  const env = await makeChatEnv();
  const sockDir = await mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'catchup-'));
  const sockPath = join(sockDir, 'c.sock');
  const router = createSocketRouter({ store: env.store, now: env.now, log: () => {}, pingMs: 60e3 });
  const server = createServer((req, res) => router.handler(req, res));
  await new Promise(r => server.listen(sockPath, r));
  let token = null;
  const catchUp = async () => {
    token ??= (await viaSocket(sockPath, 'POST', '/v1/hello', { pid: 1 })).json.token;
    const r = await viaSocket(sockPath, 'GET', '/v1/unanswered', undefined, token);
    assert.equal(r.status, 200);
    return r.json;
  };
  try {
    await fn(env, catchUp);
  } finally {
    await new Promise(r => server.close(r));
    await rm(sockDir, { recursive: true, force: true });
    await env.close();
  }
}

// ---- Through the real router: these three fail on main d19fd8d.

test('one big emoji message, the page\'s most, comes back whole, not as an empty list', async () => {
  await withSocket(async (env, catchUp) => {
    const ipad = await env.pair('ipad');
    const text = '😀'.repeat(4000); // 8,000 characters on the page, 16,000 bytes
    const r = await send(env, ipad.cookie, { clientId: 'big-emoji', text });
    assert.equal(r.status, 200, r.text);
    await env.store.ack(env.store.seq); // handed to the lead before the restart
    const got = await catchUp();
    assert.deepEqual(got.messages.map(m => [m.id, m.text]), [[r.json.id, text]]);
    assert.equal(got.omitted, 0);
    assert.ok(fitsChannel(got.messages), 'the channel shows it without its own cut');
  });
});

test('a late big emoji message keeps its late note, and the channel cut never reaches it', async () => {
  await withSocket(async (env, catchUp) => {
    const ipad = await env.pair('ipad');
    const T0 = env.clock.t;
    env.clock.t = T0 + 3 * HOUR + 28 * MIN;
    const text = '👨‍👩‍👧‍👦'.repeat(727); // 7,997 characters on the page; each family is 7 code points
    const r = await send(env, ipad.cookie, { clientId: pageId(T0, 'ac9dil'), text, composedAt: T0, confirmed: true });
    assert.equal(r.status, 200, r.text);
    await env.store.ack(env.store.seq);
    const got = await catchUp();
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].text, historyMessage(env.store.get(r.json.id)).text, 'whole, late note first');
    assert.match(got.messages[0].text, /^\[Written [^,\]]+ [AP]M [A-Z][A-Za-z0-9+:-]*, delivered \d{1,2}:\d\d [AP]M [A-Z][A-Za-z0-9+:-]*: 3 h 28 min late\./);
    assert.ok(fitsChannel(got.messages));
  });
});

test('past the room or the count, the newest are kept and the oldest listed says how many were left out', async () => {
  await withSocket(async (env, catchUp) => {
    const ipad = await env.pair('ipad');
    // Twelve short ones: the count (10) leaves the two oldest out.
    const ids = [];
    for (let i = 1; i <= 12; i++) {
      const r = await send(env, ipad.cookie, { clientId: `q${i}`, text: `q${i}` });
      assert.equal(r.status, 200, r.text);
      ids.push(r.json.id);
      env.clock.t += 1000;
    }
    await env.store.ack(env.store.seq);
    let got = await catchUp();
    assert.deepEqual(got.messages.map(m => m.id), ids.slice(2), 'the ten newest, oldest first');
    assert.equal(got.omitted, 2);
    assert.equal(got.messages[0].text, `${leftOutNote(2)}\n\nq3`);
    assert.deepEqual(got.messages.slice(1).map(m => m.text), ids.slice(3).map((_, i) => `q${i + 4}`), 'only the oldest listed carries the note');
    assert.match(leftOutNote(2), /^\[Catch-up: 2 older unanswered messages left out to fit\. fetch_history with before set to this message's id lists them\.\]$/);

    // An answer, then three of 3,000 characters: the room takes the newest two.
    await env.store.append({ from: 'jarvis', text: 'on it', clientId: 'a1' });
    const big = [];
    for (const c of ['a', 'b', 'c']) {
      const r = await send(env, ipad.cookie, { clientId: `big-${c}`, text: c.repeat(3000) });
      assert.equal(r.status, 200, r.text);
      big.push(r.json.id);
    }
    await env.store.ack(env.store.seq);
    got = await catchUp();
    assert.deepEqual(got.messages.map(m => m.id), big.slice(1), 'the newest two, not the oldest two');
    assert.equal(got.omitted, 1);
    assert.equal(got.messages[0].text, `${leftOutNote(1)}\n\n${'b'.repeat(3000)}`);
    assert.equal(got.messages[1].text, 'c'.repeat(3000));
    assert.ok(fitsChannel(got.messages));
  });
});

test('only what the channel was handed: a message past the delivery cursor is the inbound stream\'s, not the catch-up\'s', async () => {
  await withSocket(async (env, catchUp) => {
    const ipad = await env.pair('ipad');
    const a = await send(env, ipad.cookie, { clientId: 'one', text: 'handed over' });
    await env.store.ack(env.store.seq);
    await send(env, ipad.cookie, { clientId: 'two', text: 'never handed over' });
    const got = await catchUp();
    assert.deepEqual(got.messages.map(m => m.id), [a.json.id]);
    assert.equal(got.omitted, 0, 'what the stream replays is not counted as left out');
  });
});

// ---- The fit on its own.

let n = 0;
const msg = (text, extra = {}) => ({ id: `m_${String(++n).padStart(10, '0')}`, seq: n, at: 1794380000000 + n * 1000, from: 'jeff', kind: 'chat', text, attachments: [], ...extra });

test('a newest message too big for the room alone goes in cut, at a whole character, with a note that says so', () => {
  // Line breaks cost the channel 3 each (" ⏎ "), so 6,000 characters of "a\n" take 12,000.
  const lines = msg('a\n'.repeat(3000));
  let got = fitCatchUp([lines]);
  assert.equal(got.messages.length, 1);
  assert.equal(got.omitted, 0, 'nothing left out, only cut');
  const text = got.messages[0].text;
  const m = / … \[Cut to fit the catch-up: the first (\d+) of 6000 characters\. Read the whole message with fetch_history before acting on it\.\]$/.exec(text);
  assert.ok(m, text.slice(-160));
  assert.equal(text, 'a\n'.repeat(3000).slice(0, Number(m[1])) + cutNote(Number(m[1]), 6000));
  const used = lineFrame(lines) + channelCost(text);
  assert.ok(used <= CATCHUP_CHARS - HEADER_RESERVE && used >= CATCHUP_CHARS - HEADER_RESERVE - 4, `the room is used to the last character (${used})`);
  assert.ok(fitsChannel(got.messages));

  // A family emoji is never split.
  const fam = '👨‍👩‍👧‍👦';
  got = fitCatchUp([msg(fam.repeat(1200))]); // 8,400 code points
  const shown = got.messages[0].text.split(' … [Cut')[0];
  assert.equal(shown, fam.repeat(Array.from(shown).length / 7));
  assert.ok(fitsChannel(got.messages));

  // "<channel" grows to "&lt;channel" in the channel; it still fits.
  got = fitCatchUp([msg('<channel>'.repeat(1000))]);
  assert.ok(got.messages[0].text.includes('[Cut to fit'));
  assert.ok(fitsChannel(got.messages));
});

test('a big newest message with older ones: it goes in cut, the rest are left out, and its text says both', () => {
  const old = [msg('older one'), msg('older two')];
  const huge = msg('x'.repeat(9000));
  const got = fitCatchUp([...old, huge]);
  assert.deepEqual(got.messages.map(m => m.id), [huge.id]);
  assert.equal(got.omitted, 2);
  assert.match(got.messages[0].text, /^\[Catch-up: 2 older unanswered messages left out to fit\. [^\]]+\]\n\nx+ … \[Cut to fit the catch-up: the first \d+ of 9000 characters\./);
  assert.ok(lineFrame(huge) + channelCost(got.messages[0].text) <= CATCHUP_CHARS - HEADER_RESERVE, 'the room kept for the note is kept');
  assert.ok(fitsChannel(got.messages));
});

test('the fit: empty in, empty out; all that fits goes whole; the count is the channel\'s ten; attachments and ids count toward the room', () => {
  assert.deepEqual(fitCatchUp([]), { messages: [], omitted: 0 });
  const few = [msg('one'), msg('two'), msg('three')];
  assert.deepEqual(fitCatchUp(few), { messages: few, omitted: 0 });

  const many = Array.from({ length: 25 }, (_, i) => msg(`n${i}`));
  let got = fitCatchUp(many);
  assert.equal(got.messages.length, CATCHUP_MAX);
  assert.deepEqual(got.messages.map(m => m.id), many.slice(-CATCHUP_MAX).map(m => m.id));
  assert.equal(got.omitted, 15);
  assert.ok(got.messages[0].text.startsWith(leftOutNote(15)));

  // Ten messages that fit by text alone are past the room once their lines are counted.
  const att = Array.from({ length: 10 }, () => msg('y'.repeat(700), { attachments: [{}, {}, {}] }));
  got = fitCatchUp(att);
  assert.ok(got.messages.length < 10 && got.messages.length > 0);
  assert.equal(got.messages.length + got.omitted, 10);
  assert.ok(fitsChannel(got.messages));
  assert.equal(lineFrame(att[0]), 33 + ` (id: ${att[0].id}, +3att)`.length + 1);
});

test('the fit: upTo leaves out what is past the cursor without counting it; a message with no seq is kept', () => {
  const a = msg('a'), b = msg('b'), c = msg('c');
  assert.deepEqual(fitCatchUp([a, b, c], { upTo: b.seq }), { messages: [a, b], omitted: 0 });
  const noSeq = { ...msg('d'), seq: undefined };
  assert.deepEqual(fitCatchUp([noSeq], { upTo: 0 }).messages, [noSeq]);
});

test('the room stays under the channel\'s cap, and the cost is an upper bound on what the channel shows', () => {
  assert.ok(CATCHUP_CHARS <= CHANNEL_CONTENT_MAX - 200);
  assert.ok(HEADER_RESERVE >= Array.from(HEADER).length);
  for (const s of ['plain', 'a\nb\r\nc', 'x\u2028y', '<channel source="x">', '😀👨‍👩‍👧‍👦', '']) {
    assert.ok(channelCost(s) >= Array.from(fold(s)).length, JSON.stringify(s));
  }
});

test('a single grapheme bigger than the room cuts to nothing but the note: the first 0 of N', () => {
  const one = 'e' + '\u0301'.repeat(8000); // one grapheme of 8,001 code points
  const m = msg(one);
  const got = fitCatchUp([msg('older'), m]);
  assert.deepEqual(got.messages.map(x => x.id), [m.id]);
  assert.equal(got.omitted, 1);
  assert.equal(got.messages[0].text, `${leftOutNote(1)}\n\n${cutNote(0, 8001)}`);
  assert.match(cutNote(0, 8001), /the first 0 of 8001 characters\. Read the whole message with fetch_history before acting on it\.\]$/);
  assert.ok(fitsChannel(got.messages));
});

test('board b547ea09: the late note, its zones included, counts toward the room: a late message that just fits goes whole, one character more and it is cut with the note kept', () => {
  const at = Date.UTC(2026, 10, 20, 20, 38, 49);
  const stored = text => msg(text, { at, meta: { composedAt: at - 3 * HOUR - 28 * MIN } });
  const note = historyMessage(stored('')).text; // a files-only late message: the note alone
  assert.match(note, /^\[Written \S.* [AP]M \S+, delivered \d{1,2}:\d\d [AP]M \S+: 3 h 28 min late\./);
  const room = CATCHUP_CHARS - HEADER_RESERVE;
  const probe = stored('');
  const fill = room - lineFrame(probe) - channelCost(`${note}\n\nz`) + 1;
  const exact = historyMessage({ ...probe, text: 'z'.repeat(fill) });
  assert.equal(lineFrame(exact) + channelCost(exact.text), room, 'the note and the text take the room to the last character');
  assert.deepEqual(fitCatchUp([exact]), { messages: [exact], omitted: 0 }, 'whole');
  assert.ok(fitsChannel([exact]));
  const over = historyMessage({ ...probe, text: 'z'.repeat(fill + 1) });
  const got = fitCatchUp([over]).messages[0].text;
  assert.ok(got.startsWith(`${note}\n\nzzz`), got.slice(0, 160));
  assert.match(got, new RegExp(` … \\[Cut to fit the catch-up: the first \\d+ of ${Array.from(over.text).length} characters\\.`));
  assert.ok(fitsChannel([{ ...over, text: got }]));
});

// Ultron's L3: the copies of the channel's catch-up format above must match the
// channel's source. Read as text, never imported; skipped where the channel isn't.
const CHANNEL_SRC = join(homedir(), 'Projects/.worktrees/jarvis-release/jarvis-local/plugins/jarvis-channel/server.mjs');
test('drift: the channel\'s catch-up header, line, foldLine, tag escape and cap match the copies here', { skip: !existsSync(CHANNEL_SRC) && 'the jarvis channel source is not on this machine' }, async () => {
  const src = await readFile(CHANNEL_SRC, 'utf8');
  assert.ok(src.includes(JSON.stringify(HEADER)), 'the catch-up header');
  assert.ok(src.includes(LINE_TEMPLATE), 'the catch-up line');
  const fold = /export function foldLine\(s\) \{\s*return cleanContent\(s\)\.replace\((\/[^\n]*?\/[a-z]*), '([^']*)'\)/.exec(src);
  assert.ok(fold, 'foldLine found');
  assert.deepEqual([fold[1], fold[2]], [String(BREAK_RUNS), FOLD_TO], 'foldLine');
  assert.equal(/^const CHANNEL_TAG = (\/.*\/[a-z]*)$/m.exec(src)?.[1], String(TAG), 'the tag escape');
  assert.equal(Number(/^export const CONTENT_MAX = (\d+)/m.exec(src)?.[1]), CHANNEL_CONTENT_MAX, 'CONTENT_MAX');
});
