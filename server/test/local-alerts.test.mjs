// Local alerts (lib/local-alerts.mjs; board 5f892918): a local script's alert, taken on
// the ingest socket only, pushed to the paired devices and shown in the strip and Needs
// you. Everything runs on scratch sockets under a temporary folder and a fake push
// service, never the real state folder, the dashboard's port or a real device. Every
// name here is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createECDH, randomBytes } from 'node:crypto';
import {
  checkLocalAlert, createLocalAlerts, cleanTitle, cleanBody, cut, proxyHeaderOf, alertKey,
  LOCAL_ALERT_ROUTE, LOCAL_ALERT_BODY_MAX, TITLE_MAX, BODY_MAX, DEDUPE_MS, PER_HOUR, HOUR_MS, KEEP_MS, KEEP_MAX, WITHHELD_TITLE,
  JARVIS_DOWN_RESERVE, PUSH_PER_HOUR, PUSH_PER_DAY, PUSH_RESERVE_HOUR, PUSH_RESERVE_DAY, DAY_MS, KILL_FILE
} from '../lib/local-alerts.mjs';
import { createIngestHandler, createHandler, INGEST_ROUTES } from '../routes.mjs';
import { listenIngestSocket } from '../lib/ingest-socket.mjs';
import { RECOVER_LINE } from '../lib/recover-command.mjs';
import { PROXY_HEADERS } from '../lib/local-caller.mjs';
import { createCache } from '../cache.mjs';
import { createNeedsYouStore } from '../lib/needs-you.mjs';
import { createPushService, payloadFor, ALERT_TTL_S, ALERT_PAYLOAD_MAX, ALERT_FALLBACK_TITLE, ALERT_FALLBACK_BODY, ALERT_TITLE_PREFIX } from '../lib/chat-push.mjs';
import { vapidKeys, newVapidKeys, decrypt, b64u } from '../lib/webpush.mjs';
import { activeAcks, addAck, removeAck, matchingAck } from '../lib/acks.mjs';

const MIN = 60e3;
const T0 = 1794380000000;
const ELLIPSIS = String.fromCodePoint(0x2026);
// Built from code points, never typed: a right-to-left override, a zero-width space, a
// line separator, a C1 control, a tag character and an astral letter.
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const LSEP = String.fromCodePoint(0x2028);
const NEL = String.fromCodePoint(0x85);
const TAG_A = String.fromCodePoint(0xe0041);
const ASTRAL = String.fromCodePoint(0x1d4b3);
const TOKEN = `ghp_${'a1B2'.repeat(6)}`;

const clockAt = (t = T0) => {
  const c = { t, now: () => c.t };
  return c;
};

// ---- the request ----

test('checkLocalAlert: defaults, the allowed fields and values, and refusals in fixed words that never repeat the text', () => {
  const ok = checkLocalAlert({ title: 'Jarvis failed to start' });
  assert.deepEqual(ok, { ok: true, value: { title: 'Jarvis failed to start', body: '', severity: 'warning', kind: 'other', withheld: [] } });
  assert.deepEqual(checkLocalAlert({ title: 'x', body: null, severity: null, kind: null }).value, { title: 'x', body: '', severity: 'warning', kind: 'other', withheld: [] });
  for (const severity of ['info', 'warning', 'critical']) assert.equal(checkLocalAlert({ title: 'x', severity }).value.severity, severity);
  for (const kind of ['jarvis-down', 'jarvis-back', 'other']) assert.equal(checkLocalAlert({ title: 'x', kind }).value.kind, kind);
  const refusals = [
    [['MARKER'], /must be an object/],
    [null, /must be an object/],
    ['MARKER', /must be an object/],
    [{ title: 'MARKER', from: 'jeff' }, /only title, body, severity and kind/],
    [{ body: 'MARKER' }, /title must be text/],
    [{ title: 7 }, /title must be text/],
    [{ title: 'MARKER', body: 7 }, /body must be text/],
    [{ title: 'MARKER', severity: 'MARKER' }, /severity must be one of info, warning, critical/],
    [{ title: 'MARKER', severity: 'Critical' }, /severity must be one of/],
    [{ title: 'MARKER', kind: 'MARKER' }, /kind must be one of jarvis-down, jarvis-back, other/],
    [{ title: `  ${ZWSP}${RLO}\n\t ` }, /title must hold some visible text/]
  ];
  for (const [body, words] of refusals) {
    const r = checkLocalAlert(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.ok(words.test(r.error), r.error);
    assert.ok(!r.error.includes('MARKER'), 'the error repeats none of the text');
  }
});

test('the title is one plain line: breaks, tabs and separators become spaces, hidden characters go, spaces collapse', () => {
  assert.equal(cleanTitle(`  Jarvis\r\nfailed\tto${LSEP}start ${RLO}now${ZWSP}${TAG_A}${NEL}  `), 'Jarvis failed to start now');
  assert.equal(cleanTitle(`a${'   '}b`), 'a b');
  // A bare line break is a space, never nothing (hidden characters are taken out, which would join the words).
  assert.equal(cleanTitle('a\nb'), 'a b');
  assert.equal(cleanTitle('a\rb'), 'a b');
  // A lone surrogate becomes U+FFFD, never a broken string.
  assert.equal(cleanTitle(`x${String.fromCharCode(0xd800)}y`), `x${String.fromCodePoint(0xfffd)}y`);
});

test('the body keeps its line breaks: CRLF and separators become \\n, tabs spaces, hidden characters go, at most one blank line', () => {
  assert.equal(cleanBody(`line one  \r\nline${RLO} two\r\r\n\n\n\nline\tthree${LSEP}four${ZWSP}\n\n`), 'line one\nline two\n\nline three\nfour');
  assert.equal(cleanBody(''), '');
  // A lone CR is a line end too, and exactly three breaks are cut to two.
  assert.equal(cleanBody('a\rb'), 'a\nb');
  assert.equal(cleanBody('a\n\n\nb'), 'a\n\nb');
  assert.equal(cleanBody('a\n\nb'), 'a\n\nb');
});

test('the title is cut at 120 and the body at 1,000 code points, astral ones counted as one, with an ellipsis', () => {
  assert.equal(TITLE_MAX, 120);
  assert.equal(BODY_MAX, 1000);
  assert.equal(cut('abc', 3), 'abc');
  assert.equal(cut('abcd', 3), `ab${ELLIPSIS}`);
  const title = checkLocalAlert({ title: ASTRAL.repeat(TITLE_MAX) }).value.title;
  assert.equal([...title].length, TITLE_MAX, 'exactly at the cap: kept whole');
  assert.ok(!title.endsWith(ELLIPSIS));
  const long = checkLocalAlert({ title: ASTRAL.repeat(TITLE_MAX + 1), body: ASTRAL.repeat(BODY_MAX + 1) }).value;
  assert.equal([...long.title].length, TITLE_MAX);
  assert.ok(long.title.endsWith(ELLIPSIS));
  assert.equal([...long.body].length, BODY_MAX);
  assert.ok(long.body.endsWith(ELLIPSIS));
  assert.equal([...checkLocalAlert({ title: 'x', body: 'b'.repeat(BODY_MAX) }).value.body].length, BODY_MAX);
  assert.ok(!checkLocalAlert({ title: 'x', body: 'b'.repeat(BODY_MAX) }).value.body.endsWith(ELLIPSIS));
});

test('text shaped like a credential is withheld, the answer names the pattern, and a token the cut would split is still caught', () => {
  const inBody = checkLocalAlert({ title: 'Start failed', body: `token was ${TOKEN}` }).value;
  assert.equal(inBody.title, 'Start failed');
  assert.deepEqual(inBody.withheld, ['a GitHub token']);
  assert.ok(!inBody.body.includes(TOKEN));
  assert.match(inBody.body, /withheld: it looked like a GitHub token/);
  const inTitle = checkLocalAlert({ title: `failed with ${TOKEN}`, body: 'fine' }).value;
  assert.equal(inTitle.title, WITHHELD_TITLE);
  assert.ok(!inTitle.body.includes('fine'), 'the body goes too: the title said something it should not have');
  assert.deepEqual(inTitle.withheld, ['a GitHub token']);
  // The token straddles the 1,000th character: the cut alone would leave 19 of its characters.
  const straddle = checkLocalAlert({ title: 'x', body: `${'y'.repeat(BODY_MAX - 6)} ${TOKEN}` }).value;
  assert.deepEqual(straddle.withheld, ['a GitHub token']);
  assert.ok(!straddle.body.includes('ghp_'));
  // Split by a hidden character, it is found once that goes.
  assert.deepEqual(checkLocalAlert({ title: 'x', body: `ghp_${ZWSP}${'a1B2'.repeat(6)}` }).value.withheld, ['a GitHub token']);
});

test('proxyHeaderOf names the first proxy header a request carries, empty ones included', () => {
  assert.equal(proxyHeaderOf({ headers: { host: 'localhost' } }), null);
  for (const h of PROXY_HEADERS) assert.equal(proxyHeaderOf({ headers: { host: 'localhost', [h]: '' } }), h);
  assert.equal(proxyHeaderOf({}), null);
});

// ---- the store ----

const value = (over = {}) => checkLocalAlert({ title: 'Jarvis failed to start', body: 'MARKER the bot token is missing', severity: 'critical', kind: 'jarvis-down', ...over }).value;
const other = (over = {}) => value({ kind: 'other', severity: 'warning', ...over });
// `push`: null (off), 'record' (every device reached), 'none' (tried, reached nobody), or a function.
const store = ({ c = clockAt(), push = null, killed = () => false, isAcked = () => false, pushWaitMs, setTimer, clearTimer } = {}) => {
  const logs = [];
  const pushed = [];
  const s = createLocalAlerts({
    now: c.now, log: l => logs.push(l), killed, isAcked,
    push: () => push === null ? null
      : push === 'record' ? (a => { pushed.push(a); return { tried: 2, reached: 2 }; })
      : push === 'none' ? (a => { pushed.push(a); return { tried: 2, reached: 0 }; })
      : push,
    ...(pushWaitMs ? { pushWaitMs } : {}), ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {})
  });
  return { s, c, logs, pushed };
};
const KEY = alertKey('jarvis-down', 'Jarvis failed to start');
const ID = KEY.slice(KEY.lastIndexOf(':') + 1);

test('the key is the kind and a short hash of the cleaned title: the same condition always has the same key', () => {
  assert.match(KEY, /^local:jarvis-down:[0-9a-f]{12}$/);
  assert.equal(alertKey('jarvis-down', 'Jarvis failed to start'), KEY);
  assert.notEqual(alertKey('other', 'Jarvis failed to start'), KEY, 'the kind is part of it');
  assert.notEqual(alertKey('jarvis-down', 'Jarvis failed to start!'), KEY);
});

test('a taken alert is pushed once with its title, body and severity, and shown the last-seen first in the alerts\' shape', async () => {
  const e = store({ push: 'record' });
  const r = await e.s.post(value());
  assert.deepEqual(r, { status: 200, body: { ok: true, id: ID, key: KEY, push: 'on', devices: { tried: 2, reached: 2 } } });
  // A "jarvis-down" alert's push carries the way back as its tail (board 98a30b15).
  assert.deepEqual(e.pushed, [{ title: 'Jarvis failed to start', body: 'MARKER the bot token is missing', severity: 'critical', tail: RECOVER_LINE }]);
  e.c.t += MIN;
  await e.s.post(other({ title: 'Routine failed', severity: 'info' }));
  const view = e.s.view(e.c.t);
  assert.deepEqual(view.map(a => a.text), ['Routine failed', 'Jarvis failed to start']);
  assert.deepEqual(view[1], { text: 'Jarvis failed to start', kind: 'local', key: KEY, since: T0, at: T0, severity: 'critical', about: 'jarvis-down', body: 'MARKER the bot token is missing' });
  assert.equal(view[0].about, 'other');
  assert.equal(view[0].severity, 'info');
  assert.ok(!e.logs.join('\n').includes('MARKER'), 'no log line holds the body');
  assert.ok(!e.logs.join('\n').includes('failed to start'), 'or the title');
  assert.equal(e.logs[0], `local-alert: jarvis-down critical alert ${ID} taken; pushed to 2 of 2 devices`);
});

test('a repeat with the same kind and title is one entry: since stays the first time, the rest is the latest post', async () => {
  const e = store({ push: 'record' });
  await e.s.post(value());
  e.c.t += 20 * MIN;
  const r = await e.s.post(value({ body: 'MARKER still no token', severity: 'warning' }));
  assert.equal(r.body.key, KEY);
  assert.equal(r.body.duplicate, undefined, 'a new body is not a duplicate');
  const view = e.s.view(e.c.t);
  assert.equal(view.length, 1);
  assert.equal(view[0].since, T0);
  assert.equal(view[0].at, T0 + 20 * MIN);
  assert.equal(view[0].body, 'MARKER still no token');
  assert.equal(view[0].severity, 'warning');
  // A repeat moves it to the front.
  await e.s.post(other({ title: 'Routine failed' }));
  e.c.t += MIN;
  await e.s.post(value({ body: 'MARKER again' }));
  assert.deepEqual(e.s.view(e.c.t).map(a => a.about), ['jarvis-down', 'other']);
});

test('one ack covers every repeat: an acked alert is shown and never pushed, with the alert as the page sees it handed to the check', async () => {
  const asked = [];
  let acked = false;
  const e = store({ push: 'record', isAcked: a => { asked.push(a); return acked; } });
  await e.s.post(value());
  acked = true;
  for (let i = 1; i <= 3; i++) {
    e.c.t += 15 * MIN;
    const r = await e.s.post(value({ body: `MARKER repeat ${i}` }));
    assert.equal(r.status, 200);
    assert.equal(r.body.push, 'acked');
    assert.deepEqual(r.body.devices, { tried: 0, reached: 0 });
  }
  assert.equal(e.pushed.length, 1, 'only the first, before the ack');
  assert.equal(e.s.view(e.c.t).length, 1, 'still shown (the page moves it to acked)');
  assert.deepEqual(asked.map(a => [a.key, a.kind, a.since]), Array(4).fill([KEY, 'local', T0]));
  assert.ok(e.logs.at(-1).endsWith('not pushed: it is acknowledged'));
  // A check that fails reads as not acked: the push goes. So does any answer but true.
  const broken = store({ push: 'record', isAcked: async () => { throw new Error('no file'); } });
  assert.equal((await broken.s.post(value())).body.push, 'on');
  const odd = store({ push: 'record', isAcked: () => ({ key: KEY }) });
  assert.equal((await odd.s.post(value())).body.push, 'on');
});

test('the kill file stops every push and nothing else: the alert is still taken and shown', async () => {
  let off = true;
  const e = store({ push: 'record', killed: () => off });
  const r = await e.s.post(value());
  assert.deepEqual(r.body, { ok: true, id: ID, key: KEY, push: 'killed', devices: { tried: 0, reached: 0 } });
  assert.equal(e.pushed.length, 0);
  assert.equal(e.s.view(e.c.t).length, 1);
  assert.ok(e.logs[0].endsWith('not pushed: the kill file (local-alerts-off) is there'));
  assert.equal(KILL_FILE, 'local-alerts-off');
  // Checked on every post: gone, the next one pushes.
  off = false;
  e.c.t += MIN;
  assert.equal((await e.s.post(value({ body: 'MARKER next' }))).body.push, 'on');
});

test('pushes are capped below the intake, 3 an hour and 12 a day, with jarvis-down\'s own reserve; capped alerts are still shown', async () => {
  assert.deepEqual([PUSH_PER_HOUR, PUSH_PER_DAY, PUSH_RESERVE_HOUR, PUSH_RESERVE_DAY], [3, 12, 1, 3]);
  const e = store({ push: 'record' });
  // Other kinds: 2 an hour (one of the 3 is kept for jarvis-down).
  assert.equal((await e.s.post(other({ title: 'o1' }))).body.push, 'on');
  assert.equal((await e.s.post(other({ title: 'o2' }))).body.push, 'on');
  const third = await e.s.post(other({ title: 'o3' }));
  assert.equal(third.status, 200);
  assert.equal(third.body.push, 'capped');
  assert.ok(e.logs.at(-1).endsWith('not pushed: over the push limit (3 an hour, 12 a day)'));
  // jarvis-down still has its one.
  assert.equal((await e.s.post(value())).body.push, 'on');
  assert.equal((await e.s.post(value({ title: 'Jarvis started degraded' }))).body.push, 'capped', '3 in the hour now, for any kind');
  assert.equal(e.pushed.length, 3);
  assert.equal(e.s.view(e.c.t).length, 5, 'every one is on the page');
  // The hour rolls; the day keeps counting: 12 a day, 3 of them jarvis-down's.
  const day = store({ push: 'record' });
  let others = 0;
  for (let h = 0; h < 8; h++) {
    for (let i = 0; i < 2; i++) if ((await day.s.post(other({ title: `h${h} n${i}` }))).body.push === 'on') others++;
    day.c.t += HOUR_MS;
  }
  assert.equal(others, PUSH_PER_DAY - PUSH_RESERVE_DAY, 'other kinds stop at 9 a day');
  for (let i = 0; i < 4; i++) {
    const r = await day.s.post(value({ title: `down ${i}` }));
    assert.equal(r.body.push, i < PUSH_RESERVE_DAY ? 'on' : 'capped', `jarvis-down ${i}`);
    day.c.t += HOUR_MS;
  }
  // A day after the first push, room again.
  day.c.t = T0 + DAY_MS;
  assert.equal((await day.s.post(other({ title: 'next day' }))).body.push, 'on');
  // With push off nothing is counted against the caps: once it is on, the pushes go.
  let send = null;
  const c = clockAt();
  const offLater = createLocalAlerts({ now: c.now, log: () => {}, push: () => send });
  for (let i = 0; i < 5; i++) assert.equal((await offLater.post(other({ title: `x${i}` }))).body.push, 'off');
  send = () => ({ tried: 1, reached: 1 });
  assert.equal((await offLater.post(other({ title: 'y1' }))).body.push, 'on');
  assert.equal((await offLater.post(other({ title: 'y2' }))).body.push, 'on');
});

test('an identical alert within 10 minutes whose push reached a device is a duplicate, answered with that push\'s outcome', async () => {
  const e = store({ push: 'record' });
  await e.s.post(value());
  e.c.t += DEDUPE_MS - 1;
  assert.deepEqual(await e.s.post(value()), { status: 200, body: { ok: true, id: ID, key: KEY, duplicate: true, push: 'on', devices: { tried: 2, reached: 2 } } });
  assert.equal(e.pushed.length, 1);
  assert.equal(e.s.view(e.c.t)[0].at, T0 + DEDUPE_MS - 1, 'a duplicate still counts as seen');
  // Cleaned text is compared: hidden characters and spacing don't make a new alert.
  assert.equal((await e.s.post(checkLocalAlert({ title: `Jarvis  failed${ZWSP} to start`, body: 'MARKER the bot token is missing  ', severity: 'critical', kind: 'jarvis-down' }).value)).body.duplicate, true);
  for (const over of [{ severity: 'warning' }, { body: 'MARKER other words' }]) {
    assert.equal((await e.s.post(value(over))).body.duplicate, undefined, JSON.stringify(over));
  }
  e.c.t = T0 + 3 * DEDUPE_MS;
  assert.equal((await e.s.post(value({ body: 'MARKER other words' }))).body.duplicate, undefined, 'ten minutes after it was taken, it is new');
  // Exactly ten minutes on is new too.
  const edge = store({ push: 'record' });
  await edge.s.post(value());
  edge.c.t = T0 + DEDUPE_MS;
  assert.equal((await edge.s.post(value())).body.duplicate, undefined);
  assert.match(e.logs.find(l => /duplicate/.test(l)), new RegExp(`^local-alert: a duplicate of ${ID} within 10 minutes, not pushed again$`));
});

test('an identical alert whose push reached nobody is taken again, so it gets another try', async () => {
  let mode = 'none';
  const e = store({ push: () => (mode === 'none' ? { tried: 1, reached: 0 } : { tried: 1, reached: 1 }) });
  assert.deepEqual((await e.s.post(value())).body.devices, { tried: 1, reached: 0 });
  mode = 'ok';
  e.c.t += MIN;
  const again = await e.s.post(value());
  assert.equal(again.body.duplicate, undefined);
  assert.deepEqual(again.body.devices, { tried: 1, reached: 1 });
  e.c.t += MIN;
  assert.equal((await e.s.post(value())).body.duplicate, true, 'now it reached one, the next is a duplicate');
  // Push off reaches nobody too.
  const off = store();
  await off.s.post(value());
  assert.equal((await off.s.post(value())).body.duplicate, undefined);
});

test('an identical post that arrives while the first one\'s push is still going is taken too, never answered from a push with no outcome yet', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const e = store({ push: async () => { await gate; return { tried: 1, reached: 1 }; } });
  const first = e.s.post(value());
  const second = e.s.post(value());
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.body.push, 'on');
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, undefined);
  assert.equal(b.body.push, 'on');
});

test('at most 10 are taken in any hour, 2 of them kept for jarvis-down; one over the limit is a 429 but still shown, with no push', async () => {
  assert.equal(PER_HOUR, 10);
  assert.equal(JARVIS_DOWN_RESERVE, 2);
  const e = store({ push: 'record' });
  for (let i = 0; i < PER_HOUR - JARVIS_DOWN_RESERVE; i++) {
    assert.equal((await e.s.post(other({ title: `alert ${i}` }))).status, 200);
    e.c.t += MIN;
  }
  // 8 minutes in: other kinds are full, and their oldest leaves the hour at T0 + 60 min.
  const r = await e.s.post(other({ title: 'one too many' }));
  assert.equal(r.status, 429);
  assert.equal(r.headers['Retry-After'], String((HOUR_MS - 8 * MIN) / 1000));
  assert.match(r.body.error, /^at most 10 local alerts an hour \(8 for kinds other than jarvis-down\); it is shown on the page but not pushed; try again in 3120 s$/);
  assert.equal(r.body.shown, true);
  assert.equal(r.body.key, alertKey('other', 'one too many'));
  assert.ok(e.s.view(e.c.t).some(a => a.text === 'one too many'), 'kept on the page');
  const pushesBefore = e.pushed.length;
  // jarvis-down still gets in, twice.
  assert.equal((await e.s.post(value())).status, 200);
  assert.equal((await e.s.post(value({ title: 'Jarvis started degraded' }))).status, 200);
  assert.equal((await e.s.post(value({ title: 'Jarvis down a third way' }))).status, 429, 'the hour is full for every kind');
  assert.equal(e.pushed.length, pushesBefore + 1, 'the refused ones are never pushed (and the push cap holds the second)');
  for (let i = 0; i < 5; i++) assert.equal((await e.s.post(other({ title: `more ${i}` }))).status, 429);
  assert.equal(e.logs.filter(l => /over the hour's limit/.test(l)).length, 1, 'refusals are logged once a minute');
  // Refused ones are not counted: room comes back as soon as the first leaves the hour.
  e.c.t = T0 + HOUR_MS - 1;
  assert.equal((await e.s.post(other({ title: 'still full' }))).status, 429);
  e.c.t = T0 + HOUR_MS;
  assert.equal((await e.s.post(other({ title: 'room again' }))).status, 200);
  // An hour on from the last of them, a full hour again names its own oldest for Retry-After.
  e.c.t = T0 + 2 * HOUR_MS;
  for (let i = 0; i < 8; i++) assert.equal((await e.s.post(other({ title: `later ${i}` }))).status, 200);
  const later = await e.s.post(other({ title: 'later, too many' }));
  assert.equal(later.status, 429);
  assert.equal(later.headers['Retry-After'], String(HOUR_MS / 1000));
});

test('alerts are kept 24 hours after they were last seen, at most 20 of them, the oldest dropped first', async () => {
  const e = store();
  await e.s.post(value());
  e.c.t = T0 + KEEP_MS - 1;
  assert.equal(e.s.view(e.c.t).length, 1);
  e.c.t = T0 + KEEP_MS;
  assert.equal(e.s.view(e.c.t).length, 0);
  // A repeat keeps it: 24 hours from the last one.
  const r = store();
  await r.s.post(value());
  r.c.t = T0 + 20 * 3600e3;
  await r.s.post(value({ body: 'MARKER later' }));
  r.c.t = T0 + KEEP_MS + MIN;
  assert.equal(r.s.view(r.c.t).length, 1);
  assert.equal(r.s.view(r.c.t)[0].since, T0);
  const f = store();
  for (let i = 0; i < KEEP_MAX + 5; i++) {
    await f.s.post(other({ title: `alert ${i}` }));
    f.c.t += HOUR_MS / (PER_HOUR - JARVIS_DOWN_RESERVE);
  }
  const kept = f.s.view(f.c.t);
  assert.equal(kept.length, KEEP_MAX);
  assert.equal(kept[0].text, `alert ${KEEP_MAX + 4}`);
  assert.equal(kept.at(-1).text, 'alert 5');
});

test('with push off the alert is still shown; a push that throws or hangs never fails the post', async () => {
  const off = store();
  assert.deepEqual((await off.s.post(value())).body, { ok: true, id: ID, key: KEY, push: 'off', devices: { tried: 0, reached: 0 } });
  assert.match(off.logs[0], /push is off$/);
  assert.equal(off.s.view(off.c.t).length, 1);
  const offService = store({ push: async () => ({ tried: 0, reached: 0, off: true }) });
  assert.equal((await offService.s.post(value())).body.push, 'off');
  const broken = store({ push: () => { throw Object.assign(new Error('MARKER'), { code: 'EBROKEN' }); } });
  assert.deepEqual((await broken.s.post(value())).body, { ok: true, id: ID, key: KEY, push: 'failed', devices: { tried: 0, reached: 0 } });
  assert.ok(broken.logs.some(l => l === 'local-alert: the push failed (EBROKEN)'));
  assert.ok(!broken.logs.join('\n').includes('MARKER'));
  const hangs = store({ push: () => new Promise(() => {}), pushWaitMs: 30 });
  const started = Date.now();
  assert.deepEqual((await hangs.s.post(value())).body, { ok: true, id: ID, key: KEY, push: 'pending', devices: { tried: 0, reached: 0 } });
  assert.ok(Date.now() - started < 1000);
  assert.equal(hangs.s.view(hangs.c.t).length, 1);
  // Odd counts from the push are read as numbers or nothing.
  const odd = store({ push: async () => ({ tried: 2, reached: 5 }) });
  assert.deepEqual((await odd.s.post(value())).body.devices, { tried: 2, reached: 2 });
  const junk = store({ push: async () => ({ tried: 'x', reached: -1 }) });
  assert.deepEqual((await junk.s.post(value())).body.devices, { tried: 0, reached: 0 });
});

test('the wait for the push is an unref\'d timer, cleared once the push answers', async () => {
  const timers = [];
  const cleared = [];
  const e = store({
    push: 'record',
    setTimer: (fn, ms) => { const t = { fn, ms, unrefd: false, unref() { this.unrefd = true; } }; timers.push(t); return t; },
    clearTimer: t => cleared.push(t)
  });
  await e.s.post(value());
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15e3);
  assert.equal(timers[0].unrefd, true);
  assert.deepEqual(cleared, [timers[0]]);
});

test('with a withheld text the answer names the pattern and the log says so, without the text', async () => {
  const e = store({ push: 'record' });
  const r = await e.s.post(checkLocalAlert({ title: 'Start failed', body: `token ${TOKEN}` }).value);
  assert.deepEqual(r.body.withheld, ['a GitHub token']);
  assert.ok(!JSON.stringify(e.pushed).includes(TOKEN));
  assert.match(e.logs[0], /\(its text was withheld\)/);
});

// ---- over the ingest socket ----

const scratch = async () => mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'la-'));
const clean = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
const send = (socketPath, payload, { method = 'POST', path = LOCAL_ALERT_ROUTE, headers = {} } = {}) => new Promise((resolve, reject) => {
  const body = payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
  const req = request({ socketPath, method, path, agent: false, headers: { host: 'localhost', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', err => ((err.code === 'EPIPE' || err.code === 'ECONNRESET') && body.length > LOCAL_ALERT_BODY_MAX ? resolve({ status: 'hung up', text: '' }) : reject(err)));
  req.end(body);
});
const opened = [];
after(async () => { for (const s of opened) if (s.listening) await new Promise(r => { s.closeAllConnections?.(); s.close(r); }); });
async function socketEnv({ withAlerts = true, push = 'record' } = {}) {
  const dir = await scratch();
  const sockDir = join(dir, 's');
  await mkdir(sockDir, { mode: 0o700 });
  await chmod(sockDir, 0o700);
  const path = join(sockDir, 'ingest.sock');
  const e = store({ push });
  const handler = createIngestHandler({ cache: createCache(), needsYou: createNeedsYouStore({ whoFor: () => null }), log: l => e.logs.push(l), ...(withAlerts ? { onLocalAlert: v => e.s.post(v) } : {}) });
  const { server, problems } = await listenIngestSocket({ path, handler });
  assert.deepEqual(problems, []);
  opened.push(server);
  return { ...e, path, close: async () => { await new Promise(r => server.close(r)); await clean(dir); } };
}

test('over the ingest socket: an alert is taken, pushed and shown; a bad one is refused and its text never comes back or reaches a log', async () => {
  const e = await socketEnv();
  try {
    const ok = await send(e.path, { title: 'Jarvis failed to start', body: 'MARKER no bot token', severity: 'critical', kind: 'jarvis-down' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(ok.text), { ok: true, id: ID, key: KEY, push: 'on', devices: { tried: 2, reached: 2 } });
    assert.equal(e.pushed.length, 1);
    assert.equal(e.s.view(e.c.t)[0].about, 'jarvis-down');
    const refusals = [
      [{ title: 'MARKER', severity: 'loud' }, 400, /severity must be one of/],
      [{ title: 'MARKER', from: 'jeff' }, 400, /only title, body, severity and kind/],
      ['{"title":"MARKER"', 400, /./],
      [['MARKER'], 400, /must be an object/]
    ];
    for (const [body, status, words] of refusals) {
      const r = await send(e.path, body);
      assert.equal(r.status, status, r.text);
      assert.ok(words.test(JSON.parse(r.text).error), r.text);
      assert.ok(!r.text.includes('MARKER'), 'the answer repeats none of the text');
    }
    assert.equal((await send(e.path, { title: 'MARKER' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await send(e.path, { title: 'MARKER' }, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await send(e.path, undefined, { method: 'GET' })).status, 404);
    assert.equal((await send(e.path, { title: 'MARKER' }, { path: `${LOCAL_ALERT_ROUTE}/` })).status, 404);
    const big = await send(e.path, { title: 'MARKER', body: 'M'.repeat(LOCAL_ALERT_BODY_MAX) });
    assert.ok(big.status === 413 || big.status === 'hung up', String(big.status));
    assert.equal(e.s.view(e.c.t).length, 1, 'none of the refused posts was taken');
    assert.equal(e.pushed.length, 1, 'or pushed');
    assert.ok(!e.logs.join('\n').includes('MARKER'), 'no log line holds the text');
  } finally { await e.close(); }
});

test('over the ingest socket: a request carrying any proxy header is refused unread, and the log names the header, never its value', async () => {
  const e = await socketEnv();
  try {
    for (const h of PROXY_HEADERS) {
      const r = await send(e.path, { title: 'MARKER' }, { headers: { [h]: 'MARKER-value' } });
      assert.equal(r.status, 403, h);
      assert.deepEqual(JSON.parse(r.text), { error: 'a local alert never comes through a proxy' });
      assert.equal(r.headers.connection, 'close', 'answered and hung up, the body unread');
    }
    // An empty one counts too: a proxy that sets a header sets it.
    assert.equal((await send(e.path, { title: 'MARKER' }, { headers: { 'x-forwarded-for': '' } })).status, 403);
    assert.equal(e.s.view(e.c.t).length, 0);
    assert.equal(e.pushed.length, 0);
    assert.ok(e.logs.includes('local-alert: refused a post that came through a proxy (tailscale-user-login)'));
    assert.ok(!e.logs.join('\n').includes('MARKER'));
  } finally { await e.close(); }
});

test('over the ingest socket: the limits answer as the store does, and without a store the route answers 503', async () => {
  const e = await socketEnv();
  try {
    assert.equal((await send(e.path, { title: 'same', kind: 'jarvis-down' })).status, 200);
    const sameKey = alertKey('jarvis-down', 'same');
    assert.deepEqual(JSON.parse((await send(e.path, { title: 'same', kind: 'jarvis-down' })).text),
      { ok: true, id: sameKey.slice(-12), key: sameKey, duplicate: true, push: 'on', devices: { tried: 2, reached: 2 } });
    for (let i = 1; i < PER_HOUR; i++) assert.equal((await send(e.path, { title: `n${i}`, kind: 'jarvis-down' })).status, 200);
    const r = await send(e.path, { title: 'eleventh' });
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], String(HOUR_MS / 1000));
    assert.equal(JSON.parse(r.text).shown, true);
    assert.ok(e.s.view(e.c.t).some(a => a.text === 'eleventh'), 'refused by the limit, still on the page');
  } finally { await e.close(); }
  const off = await socketEnv({ withAlerts: false });
  try {
    const r = await send(off.path, { title: 'x' });
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.text), { error: 'local alerts are not set up on this server' });
  } finally { await off.close(); }
});

test('a proxied post is answered and hung up before its body is read', async () => {
  const logs = [];
  const handler = createIngestHandler({ cache: createCache(), log: l => logs.push(l), onLocalAlert: () => { throw new Error('a proxied post reached the store'); } });
  let read = false;
  const req = {
    method: 'POST', url: LOCAL_ALERT_ROUTE, headers: { host: 'localhost', 'content-type': 'application/json', via: '1.1 proxy' },
    on(evt, fn) { if (evt === 'data') { read = true; fn(Buffer.from('{"title":"x"}')); } if (evt === 'end') fn(); return req; },
    destroy() {}, unpipe() {}, pause() {}
  };
  const res = { statusCode: 200, body: '', headers: {}, headersSent: false, writeHead(code, h) { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, h ?? {}); }, end(body) { res.body = body ?? ''; res.finished = true; } };
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers.Connection, 'close');
  assert.equal(read, false, 'the body is never read');
  assert.deepEqual(logs, ['local-alert: refused a post that came through a proxy (via)']);
});

// ---- never on the TCP port ----

test('the TCP port refuses the route unread, from loopback with no proxy header too, whatever ingest.tcp says', async () => {
  assert.ok(INGEST_ROUTES.has(LOCAL_ALERT_ROUTE));
  const cases = [
    ['loopback', { host: '127.0.0.1:8322' }, { remoteAddress: '127.0.0.1' }],
    ['localhost', { host: 'localhost:8322' }, { remoteAddress: '::1' }],
    ['through Serve', { host: 'mini.example.ts.net', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'someone@example.com' }, { remoteAddress: '127.0.0.1' }],
    ['from the network', { host: '127.0.0.1:8322' }, { remoteAddress: '100.64.0.7' }]
  ];
  for (const ingest of [undefined, { tcp: 'legacy' }, { tcp: 'off' }]) {
    for (const [name, headers, socket] of cases) {
      const logged = [];
      const handler = createHandler({
        cache: createCache(), needsYou: createNeedsYouStore({ whoFor: () => null }), log: l => logged.push(l),
        todos: { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) },
        config: { warnThreshold: 85, showAlertBanner: true, present: true, ...(ingest ? { ingest } : {}) },
        localAlerts: { view: () => [], post: () => { throw new Error('the TCP port reached the store'); } },
        onLocalAlert: () => { throw new Error('the TCP port reached the way in'); }
      });
      let read = false;
      const req = {
        method: 'POST', url: LOCAL_ALERT_ROUTE, headers: { ...headers, 'content-type': 'application/json' }, socket,
        on(evt, fn) { if (evt === 'data') { read = true; fn(Buffer.from('{"title":"x"}')); } if (evt === 'end') fn(); return req; },
        destroy() {}, unpipe() {}, pause() {}
      };
      const res = { statusCode: 200, body: '', headers: {}, setHeader() {}, writeHead(code, h) { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, h ?? {}); }, end(body) { res.body = body ?? ''; res.finished = true; } };
      await handler(req, res);
      assert.equal(res.statusCode, 403, `${name} ${JSON.stringify(ingest)}`);
      assert.match(JSON.parse(res.body).error, /Unix socket only/);
      assert.equal(res.headers.Connection, 'close');
      assert.equal(read, false, 'the body is never read');
    }
  }
});

// ---- the push ----

const receiver = () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = b64u(randomBytes(16));
  return { ua, auth, sub: { endpoint: `https://web.push.apple.com/${randomBytes(6).toString('hex')}`, expirationTime: null, keys: { p256dh: b64u(ua.getPublicKey()), auth }, origin: 'https://mini.example.ts.net' } };
};
function pushEnv({ vapid = true, status = 201, targets = 2 } = {}) {
  const sent = [];
  const logs = [];
  const rs = Array.from({ length: targets }, receiver);
  const svc = createPushService({
    devices: { pushTargets: () => rs.map((r, i) => ({ id: `d${i}`, name: `device ${i}`, push: r.sub })), dropPush: async () => false },
    store: { subscribe: () => () => {}, openPermissions: () => [] },
    socket: { status: () => ({ channelConnected: true, lastHeartbeatAt: Date.now() }) },
    lastStream: () => null,
    vapid: vapid ? { ...vapidKeys(newVapidKeys().privateKey), subject: 'mailto:owner@example.com' } : null,
    log: l => logs.push(l),
    fetchImpl: async (url, init) => { sent.push({ url, init }); return { status, arrayBuffer: async () => new ArrayBuffer(0) }; },
    checkMs: 3600e3
  });
  const opened = i => sent.filter(x => x.url === rs[i].sub.endpoint).map(x => JSON.parse(decrypt({ body: x.init.body, uaPrivate: rs[i].ua.getPrivateKey(), authSecret: rs[i].auth })));
  return { svc, sent, logs, rs, opened };
}

test('localAlert pushes the alert\'s own title and body to every device: urgent unless info, no Topic, kept 6 hours, a tap to the Overview, no badge', async () => {
  const p = pushEnv();
  try {
    assert.deepEqual(await p.svc.localAlert({ title: 'Jarvis failed to start', body: 'No bot token.\nSee the log.', severity: 'critical' }), { tried: 2, reached: 2 });
    assert.equal(p.sent.length, 2);
    for (const i of [0, 1]) {
      assert.deepEqual(p.opened(i), [{ web_push: 8030, notification: { title: 'Local alert: Jarvis failed to start', body: 'No bot token.\nSee the log.', navigate: 'https://mini.example.ts.net/#overview' } }]);
    }
    for (const s of p.sent) {
      assert.equal(s.init.headers.Urgency, 'high');
      assert.equal(s.init.headers.TTL, String(ALERT_TTL_S));
      assert.equal(ALERT_TTL_S, 6 * 3600);
      assert.equal(s.init.headers.Topic, undefined, 'two alerts never replace each other');
    }
    await p.svc.localAlert({ title: 'a', body: 'b', severity: 'warning' });
    await p.svc.localAlert({ title: 'a', body: 'b', severity: 'info' });
    assert.deepEqual(p.sent.slice(2).map(s => s.init.headers.Urgency), ['high', 'high', 'normal', 'normal']);
    assert.ok(p.logs.includes('push: a local alert went to 2 of 2 devices'));
    assert.ok(!p.logs.join('\n').includes('bot token'));
  } finally { p.svc.stop(); }
});

test('localAlert reports what the push service took, and says off with no key', async () => {
  const failing = pushEnv({ status: 500, targets: 1 });
  try {
    assert.deepEqual(await failing.svc.localAlert({ title: 'a', body: 'b', severity: 'warning' }), { tried: 1, reached: 0 });
    assert.ok(failing.logs.includes('push: a local alert went to 0 of 1 device'));
  } finally { failing.svc.stop(); }
  const off = pushEnv({ vapid: false });
  try {
    assert.deepEqual(await off.svc.localAlert({ title: 'a', body: 'b', severity: 'warning' }), { tried: 0, reached: 0, off: true });
    assert.equal(off.sent.length, 0);
  } finally { off.svc.stop(); }
});

test('the longest alert there can be still goes out in one record and reaches the device', async () => {
  assert.equal(ALERT_PAYLOAD_MAX, 3072, 'well under one record (4,096 bytes less the tag and the delimiter)');
  const p = pushEnv({ targets: 1 });
  try {
    const worst = String.fromCodePoint(0x1f600).repeat(BODY_MAX);
    assert.deepEqual(await p.svc.localAlert({ title: ASTRAL.repeat(TITLE_MAX), body: worst, severity: 'critical' }), { tried: 1, reached: 1 });
    assert.equal(p.opened(0)[0].notification.title, `Local alert: ${ASTRAL.repeat(TITLE_MAX)}`);
  } finally { p.svc.stop(); }
});

test('a body too long for one record is cut to fit, and an empty title or body gets fixed words', () => {
  const big = payloadFor('alert', 'https://mini.example.ts.net', { title: ASTRAL.repeat(TITLE_MAX), body: ASTRAL.repeat(BODY_MAX), severity: 'critical' });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= ALERT_PAYLOAD_MAX);
  assert.ok(big.notification.body.endsWith(ELLIPSIS));
  assert.ok(big.notification.body.startsWith(ASTRAL.repeat(100)), 'cut from the end, by whole code points');
  assert.equal(big.notification.title, `Local alert: ${ASTRAL.repeat(TITLE_MAX)}`, 'the title is never cut here');
  const small = payloadFor('alert', 'https://mini.example.ts.net', { title: 'short', body: 'b'.repeat(BODY_MAX) });
  assert.equal(small.notification.body, 'b'.repeat(BODY_MAX), 'a body that fits is untouched');
  assert.deepEqual(payloadFor('alert', 'http://evil.example', { title: '', body: '' }), { web_push: 8030, notification: { title: ALERT_FALLBACK_TITLE, body: ALERT_FALLBACK_BODY, navigate: '/#overview' } });
  assert.equal(ALERT_FALLBACK_TITLE, 'Local alert');
});

test('every local alert\'s push title carries the fixed marker, so a script can\'t pass for the server\'s own lines', () => {
  assert.equal(ALERT_TITLE_PREFIX, 'Local alert: ');
  for (const title of ['Jarvis', 'Jarvis needs an approval', 'Control Room']) {
    const n = payloadFor('alert', 'https://mini.example.ts.net', { title, body: 'Jarvis needs an approval' }).notification;
    assert.equal(n.title, `Local alert: ${title}`);
    assert.notEqual(n.title, 'Jarvis');
  }
});

test('end to end over the socket: the store asks for the push service on each post, so an alert after the chat starts is pushed', async () => {
  const p = pushEnv({ targets: 1 });
  let live = null;
  const dir = await scratch();
  const sockDir = join(dir, 's');
  await mkdir(sockDir, { mode: 0o700 });
  const path = join(sockDir, 'ingest.sock');
  const s = createLocalAlerts({ push: () => live, log: () => {} });
  const { server } = await listenIngestSocket({ path, handler: createIngestHandler({ cache: createCache(), onLocalAlert: v => s.post(v) }) });
  opened.push(server);
  try {
    assert.equal(JSON.parse((await send(path, { title: 'before the chat' })).text).push, 'off');
    live = a => p.svc.localAlert(a);
    const r = JSON.parse((await send(path, { title: 'Jarvis started degraded', body: 'The Discord plugin did not load.', kind: 'jarvis-down' })).text);
    assert.deepEqual(r.devices, { tried: 1, reached: 1 });
    assert.deepEqual(p.opened(0)[0].notification, { title: 'Local alert: Jarvis started degraded', body: `The Discord plugin did not load.\n\n${RECOVER_LINE}`, navigate: 'https://mini.example.ts.net/#overview' });
  } finally {
    p.svc.stop();
    await new Promise(r => server.close(r));
    await clean(dir);
  }
});

// ---- the strip, Needs you and acks ----

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, hdrs) => { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const call = async (handler, method, url, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method, url, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:8322', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    on(evt, fn) {
      if (evt === 'data' && body !== undefined) fn(Buffer.from(raw));
      if (evt === 'end') fn();
      return req;
    },
    unpipe() {}, pause() {}
  };
  const res = mockRes();
  await handler(req, res);
  return res;
};
const ackMemory = () => {
  let list = [];
  return {
    read: async now => activeAcks(list, now),
    add: async (a, now) => { list = addAck(list, a, now); return list; },
    remove: async (k, now) => { list = removeAck(list, k, now); return list; }
  };
};
const dashboardHandler = (localAlerts, { showAlertBanner = true, acks = ackMemory() } = {}) => {
  const cache = createCache();
  cache.set('health', { jobs: { status: 'ok', error: null, list: [] }, services: [{ key: 'launchd:Tunnel', kind: 'launchd', name: 'Tunnel', state: 'down', downSince: Date.now() - 3600e3 }] });
  return createHandler({
    cache, localAlerts, acks, log: () => {},
    todos: { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) },
    config: { warnThreshold: 85, showAlertBanner, present: true }
  });
};

test('the dashboard lists local alerts first in `alerts`, with what the strip and Needs you draw; acking one moves it to `acked`', async () => {
  const s = createLocalAlerts({ log: () => {} });
  await s.post(value());
  const handler = dashboardHandler(s);
  const payload = JSON.parse((await call(handler, 'GET', '/api/dashboard')).body);
  assert.deepEqual(payload.alerts.map(a => a.kind), ['local', 'service']);
  const local = payload.alerts[0];
  assert.equal(local.text, 'Jarvis failed to start');
  assert.equal(local.body, 'MARKER the bot token is missing');
  assert.equal(local.about, 'jarvis-down');
  assert.equal(local.severity, 'critical');
  assert.ok(Number.isFinite(local.at) && local.since === local.at);
  // The ack: the default is 24 hours, the alert's own life.
  const acked = await call(handler, 'POST', '/api/acks', { key: local.key, note: 'seen' }, { origin: 'http://127.0.0.1:8322' });
  assert.equal(acked.statusCode, 200, acked.body);
  const after = JSON.parse((await call(handler, 'GET', '/api/dashboard')).body);
  assert.deepEqual(after.alerts.map(a => a.kind), ['service']);
  assert.deepEqual(after.acked.map(a => a.key), [local.key]);
  assert.equal(after.acked[0].ack.kind, 'local');
  assert.ok(Math.abs(after.acked[0].ack.until - (after.acked[0].ack.at + 24 * 3600e3)) < 1000);
});

test('with the banner off no local alert reaches the page, and a server without the store raises none', async () => {
  const s = createLocalAlerts({ log: () => {} });
  await s.post(value());
  const payload = JSON.parse((await call(dashboardHandler(s, { showAlertBanner: false }), 'GET', '/api/dashboard')).body);
  assert.deepEqual(payload.alerts, []);
  const bare = JSON.parse((await call(dashboardHandler(undefined), 'GET', '/api/dashboard')).body);
  assert.deepEqual(bare.alerts.map(a => a.kind), ['service']);
});

test('with server.mjs\'s ack check, one ack from the page covers the repeats: they stay in `acked` and are never pushed', async () => {
  const acks = ackMemory();
  const pushed = [];
  const s = createLocalAlerts({
    log: () => {},
    push: () => a => { pushed.push(a); return { tried: 1, reached: 1 }; },
    isAcked: async alert => matchingAck(alert, await acks.read(Date.now()), Date.now()) !== null
  });
  await s.post(value());
  const handler = dashboardHandler(s, { acks });
  const key = JSON.parse((await call(handler, 'GET', '/api/dashboard')).body).alerts[0].key;
  assert.equal(key, KEY);
  assert.equal((await call(handler, 'POST', '/api/acks', { key }, { origin: 'http://127.0.0.1:8322' })).statusCode, 200);
  for (const body of ['MARKER repeat one', 'MARKER repeat two']) {
    const r = await s.post(value({ body }));
    assert.equal(r.body.push, 'acked');
  }
  assert.equal(pushed.length, 1);
  const after = JSON.parse((await call(handler, 'GET', '/api/dashboard')).body);
  assert.deepEqual(after.alerts.map(a => a.kind), ['service']);
  assert.deepEqual(after.acked.map(a => [a.key, a.body]), [[KEY, 'MARKER repeat two']]);
});

// ---- the docs ----

const readme = async () => readFile(new URL('../../README.md', import.meta.url), 'utf8');
const section = (text, start, end) => {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `no section starting ${start}`);
  const b = text.indexOf(end, a + start.length);
  return text.slice(a, b < 0 ? undefined : b);
};

test('README: a caller\'s body carries fixed words and a log path only, and reached under 1 means not delivered', async () => {
  const s = section(await readme(), "### A local script's alert", '### A session waiting on you');
  const flat = s.replace(/\s+/g, ' ');
  assert.ok(flat.includes('never carries a log tail, command output or a URL with parameters'), 'the L7 rule');
  assert.ok(flat.includes('only fixed words and the path of the log'), 'what it carries instead');
  assert.ok(flat.includes('`reached` under 1 means not delivered'), 'the L3 rule');
  assert.ok(flat.includes('local-alerts-off'), 'the kill file');
});

test('README and NEXT.md: the ntfy reasoning is general, never a claim about the live machine\'s Keychain', async () => {
  const next = await readFile(new URL('../../NEXT.md', import.meta.url), 'utf8');
  const parts = [section(await readme(), "### A local script's alert", '### A session waiting on you'), section(next, '## 20. ', '\n## 21. ')];
  for (const s of parts) {
    const flat = s.replace(/\s+/g, ' ');
    assert.ok(!/missing from the Keychain|Keychain items missing|ntfy fallback is dead|dead ntfy|found missing/i.test(flat), flat.slice(0, 80));
  }
});

// ---- the wiring ----

// server.mjs starts `claude -p` and can't run in a test.
test('server.mjs: the ingest socket\'s handler gets onLocalAlert, the TCP handler the store\'s view, and the chat sets the push', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /handler: createIngestHandler\(\{[^}]*\bonLocalAlert\b[^}]*\}\)/);
  assert.match(src, /const localAlerts = createLocalAlerts\(\{\s*push: \(\) => localAlertPush,\s*killed: \(\) => existsSync\(join\(stateDir, LOCAL_ALERTS_KILL_FILE\)\),\s*isAcked: async alert => matchingAck\(alert, await ackStore\.read\(Date\.now\(\)\), Date\.now\(\)\) !== null\s*\}\);/);
  assert.match(src, /import \{ createLocalAlerts, KILL_FILE as LOCAL_ALERTS_KILL_FILE \} from '\.\/lib\/local-alerts\.mjs';/);
  assert.match(src, /const stateDir = join\(homedir\(\), '\.local', 'state', 'jarvis-os'\);/);
  assert.match(src, /const onLocalAlert = value => localAlerts\.post\(value\);/);
  assert.match(src, /localAlertPush = alert => push\.localAlert\(alert\);/);
  assert.match(src, /const api = createHandler\(\{\s*cache, todos, config, acks: ackStore, needsYou, localAlerts,/);
  // Only the socket's handler takes posts: the TCP handler is never given the way in.
  const uses = src.split('\n').filter(l => /\bonLocalAlert\b/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(uses.length, 2, 'the definition and the socket\'s handler');
});
