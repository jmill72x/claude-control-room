// The ack notices' per-key limit (lib/ack-notice-limit.mjs, Ultron's 11-12 3-M1):
// the first notice for a key goes out at once, later ones for it in 10 minutes are
// counted, and the count goes out with the next notice or with the latest held one
// when the window ends, so nothing is hidden. A fake clock and fake timers; nothing
// is pushed anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createAckNoticeLimiter, createAckNtfyBudget, createAckNotices, localDay, ACK_NOTICE_WINDOW_MS, ACK_NTFY_WINDOW_MS,
  ACK_NTFY_DAY_MAX, ACK_NTFY_LAST_LINE, carriedSuffix, flushSuffix, ntfyCarriedSuffix, ntfyFlushSuffix
} from '../lib/ack-notice-limit.mjs';

const MIN = 60e3;
const T0 = 1794380000000;
const A = 'cron:launchd:com.example.friday';
const B = 'service:launchd:Tunnel';
const notice = (message, extra = {}) => ({ message, ntfyMessage: 'generic', priority: 'low', ...extra });

const harness = () => {
  const h = { now: T0, sent: [], timers: [], errors: [] };
  h.limiter = createAckNoticeLimiter({
    send: async n => { if (h.failNext) { h.failNext = false; throw new Error('ntfy down'); } h.sent.push(n); },
    clock: () => h.now,
    setTimer: (fn, ms) => { h.timers.push({ fn, at: h.now + ms }); },
    onError: e => h.errors.push(e.message)
  });
  // Run every timer due by `to`, in order, as the event loop would (a timer set
  // while running waits for a later tick).
  h.tick = async to => {
    h.now = to;
    const due = h.timers.filter(t => t.at <= to).sort((x, y) => x.at - y.at);
    h.timers = h.timers.filter(t => t.at > to);
    for (const t of due) await t.fn();
  };
  return h;
};

test('the window and the words', () => {
  assert.equal(ACK_NOTICE_WINDOW_MS, 10 * MIN);
  assert.equal(carriedSuffix(3), ' (and 3 more for this alert held back in the last 10 minutes)');
  assert.equal(flushSuffix(2), ' (the latest of 2 for this alert held back in the last 10 minutes)');
});

test('250 renewals of one alert in a minute push once at once and once more at the window\'s end, with the full count', async () => {
  const h = harness();
  assert.deepEqual(await h.limiter.notice(A, notice('n0')), { sent: true, held: 0 });
  for (let i = 1; i < 250; i++) {
    h.now = T0 + Math.floor(i * MIN / 250);
    assert.equal((await h.limiter.notice(A, notice(`n${i}`))).sent, false);
  }
  assert.equal(h.limiter.held(A), 249);
  assert.deepEqual(h.sent.map(n => n.message), ['n0'], 'one push, not 250');
  await h.tick(T0 + 10 * MIN - 1);
  assert.equal(h.sent.length, 1, 'nothing before the window ends');
  await h.tick(T0 + 10 * MIN);
  assert.equal(h.sent.length, 2);
  const last = h.sent[1];
  assert.equal(last.message, 'n249' + flushSuffix(249), 'the latest held notice, with the count of every held one');
  assert.equal(last.ntfyMessage, 'generic', '#pepper\'s count is on #pepper\'s words only: ntfy has its own budget');
  assert.equal(last.priority, 'low');
  assert.equal(h.limiter.held(A), 0);
});

test('a notice after a window that held some carries the count, and starts a new window', async () => {
  const h = harness();
  await h.limiter.notice(A, notice('first'));
  h.now = T0 + 2 * MIN;
  await h.limiter.notice(A, notice('held 1'));
  h.now = T0 + 3 * MIN;
  await h.limiter.notice(A, notice('held 2'));
  // The window ends, but the event loop runs the next notice before its timer.
  h.now = T0 + 11 * MIN;
  assert.deepEqual(await h.limiter.notice(A, notice('next')), { sent: true, held: 0 });
  assert.deepEqual(h.sent.map(n => n.message), ['first', 'next' + carriedSuffix(2)]);
  // The first window's timer, late, finds a newer window and sends nothing.
  await h.tick(T0 + 11 * MIN);
  assert.equal(h.sent.length, 2, 'a stale timer never pushes the new window early');
  h.now = T0 + 12 * MIN;
  assert.equal((await h.limiter.notice(A, notice('in the new window'))).sent, false, 'the carried push began a window');
  await h.tick(T0 + 21 * MIN);
  assert.deepEqual(h.sent.map(n => n.message).at(-1), 'in the new window' + flushSuffix(1));
});

test('the push at a window\'s end begins a window of its own, so a steady loop pushes at most once per 10 minutes', async () => {
  const h = harness();
  // A renewal every minute for an hour.
  for (let m = 0; m < 60; m++) {
    await h.tick(T0 + m * MIN);
    await h.limiter.notice(A, notice(`m${m}`));
  }
  await h.tick(T0 + 70 * MIN);
  await h.tick(T0 + 80 * MIN);
  const total = h.sent.length;
  assert.ok(total <= 7, `at most one push per 10 minutes over the hour, plus the last window's (${total})`);
  // Nothing hidden: every notice is either sent or counted in a sent one.
  const counted = h.sent.reduce((n, s) => {
    const m = s.message.match(/\((and|the latest of) (\d+)(?: more)? for this alert/);
    if (!m) return n + 1;
    return n + Number(m[2]) + (m[1] === 'and' ? 1 : 0);
  }, 0);
  assert.equal(counted, 60, 'every one of the 60 is in a push, sent or counted');
  assert.equal(h.limiter.size(), 0, 'and once quiet, no window is kept');
});

test('keys are limited apart: a second alert\'s first notice goes out at once', async () => {
  const h = harness();
  await h.limiter.notice(A, notice('a'));
  h.now = T0 + MIN;
  assert.equal((await h.limiter.notice(A, notice('a again'))).sent, false);
  assert.deepEqual(await h.limiter.notice(B, notice('b')), { sent: true, held: 0 });
  assert.deepEqual(h.sent.map(n => n.message), ['a', 'b']);
});

test('a window that held nothing ends quietly and is forgotten', async () => {
  const h = harness();
  await h.limiter.notice(A, notice('only'));
  assert.equal(h.limiter.size(), 1);
  await h.tick(T0 + 10 * MIN);
  assert.equal(h.sent.length, 1);
  assert.equal(h.limiter.size(), 0);
  h.now = T0 + 10 * MIN + 1;
  assert.equal((await h.limiter.notice(A, notice('later'))).sent, true);
});

test('a failed push at the window\'s end is reported to onError, and a failed direct push throws to the caller', async () => {
  const h = harness();
  await h.limiter.notice(A, notice('first'));
  h.now = T0 + MIN;
  await h.limiter.notice(A, notice('held'));
  h.failNext = true;
  await h.tick(T0 + 10 * MIN);
  assert.deepEqual(h.errors, ['ntfy down']);
  h.failNext = true;
  await assert.rejects(h.limiter.notice(B, notice('b')), /ntfy down/);
});

// A merge of jos/ack-notice with jos/verdict-alerts-csp or jos/ingest-socket edits
// the same createHandler call in server.mjs; this guards the wiring (Ultron, 11-12).
test('server.mjs hands every ack notice to createHandler through both limits', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ createAckNotices \} from '\.\/lib\/ack-notice-limit\.mjs';/);
  assert.match(src, /const ackNotices = createAckNotices\(\{\s*sendPepper: notice => sendAckPepper\(notice\),\s*sendNtfy: push => sendAckNtfy\(push\),/);
  // The createHandler call, one line or several, up to its closing `});`.
  const handler = src.slice(src.indexOf('const api = createHandler({'));
  const call = handler.slice(0, handler.indexOf('});') + 3);
  assert.ok(handler.length > 0 && call.length > 30, 'the createHandler call is there');
  assert.match(call.replace(/\/\/[^\n]*/g, ''), /[{,]\s*onAckNotice: \(notice, key\) => ackNotices\.notice\(key, notice\)\s*[,}]/, 'onAckNotice is wired in the createHandler call, not in a comment');
  assert.equal((src.match(/createHandler\(\{/g) ?? []).length, 1, 'one handler, so the wired one is the one serving');
});

// ---- ntfy's budget across every key (Ultron's 11-12 medium): one an hour, 12 a day ----

const HOUR = 60 * MIN;
// Local-time moments, so the day's edges are the server's midnight in any TZ the suite runs in.
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

const both = (start = at(12, 0)) => {
  const h = { now: start, pepper: [], ntfy: [], timers: [], errors: [] };
  h.notices = createAckNotices({
    sendPepper: async n => { if (h.failPepper) throw new Error('discord down'); h.pepper.push(n); },
    sendNtfy: async n => { if (h.failNtfy) { h.failNtfy = false; throw new Error('ntfy down'); } h.ntfy.push(n); },
    clock: () => h.now,
    setTimer: (fn, ms) => { h.timers.push({ fn, at: h.now + ms }); },
    onError: e => h.errors.push(e.message)
  });
  h.tick = async to => {
    while (true) {
      const due = h.timers.filter(t => t.at <= to).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      h.timers.splice(h.timers.indexOf(due), 1);
      h.now = due.at;
      await due.fn();
    }
    h.now = to;
  };
  return h;
};
const ack = (words = 'generic') => notice('details', { ntfyMessage: words });

test('the budget\'s numbers and words', () => {
  assert.equal(ACK_NTFY_WINDOW_MS, HOUR);
  assert.equal(ACK_NTFY_DAY_MAX, 12);
  assert.equal(ACK_NTFY_LAST_LINE, 'Ack notices are Discord-only until tomorrow.');
  assert.equal(ntfyCarriedSuffix(3), ' (and 3 more in the last 60 minutes)');
  assert.equal(ntfyFlushSuffix(2), ' (the latest of 2 in the last 60 minutes)');
});

test('a day is the server\'s local calendar day: it ends at local midnight', () => {
  assert.equal(localDay(at(12, 0, 0)), localDay(at(12, 23, 59)));
  assert.notEqual(localDay(at(12, 23, 59)), localDay(at(13, 0, 0)));
  assert.equal(localDay(at(12, 9)), '2026-11-12');
});

test('two alerts\' first acks: #pepper gets both at once, ntfy one, and the other rides at the hour\'s end', async () => {
  const h = both();
  assert.deepEqual(await h.notices.notice(A, ack('acked')), { pepper: { sent: true, held: 0 }, ntfy: { sent: true, held: 0, spent: false } });
  h.now += MIN;
  assert.deepEqual((await h.notices.notice(B, ack('acked B'))).ntfy, { sent: false, held: 1, spent: false });
  assert.equal(h.pepper.length, 2, 'per key on #pepper');
  assert.deepEqual(h.ntfy, [{ message: 'acked', priority: 'low' }], 'one ntfy push for both keys');
  await h.tick(at(12, 0) + HOUR - 1);
  assert.equal(h.ntfy.length, 1, 'nothing before the hour is up');
  await h.tick(at(12, 0) + HOUR);
  assert.deepEqual(h.ntfy[1], { message: 'acked B' + ntfyFlushSuffix(1), priority: 'low' });
  assert.ok(h.ntfy.every(n => !n.message.includes('details')), 'ntfy only ever gets the generic words');
});

test('a notice after the hour, before its timer, carries the count; the stale timer pushes nothing', async () => {
  const h = both();
  await h.notices.notice(A, ack('first'));
  h.now += 10 * MIN;
  await h.notices.notice(B, ack('held'));
  h.now = at(12, 1, 5);
  assert.equal((await h.notices.notice(A, ack('next'))).ntfy.sent, true);
  assert.deepEqual(h.ntfy.map(n => n.message), ['first', 'next' + ntfyCarriedSuffix(1)]);
  for (const t of h.timers.filter(t => t.at <= h.now)) await t.fn();
  assert.equal(h.ntfy.length, 2, 'a stale timer never pushes the new window early');
  assert.equal(h.notices.ntfy.held(), 0);
});

test('two alerts renewing every minute all day: ntfy gets 12, the 12th says Discord-only, then nothing until local midnight', async () => {
  const h = both();
  const day = at(12, 0);
  for (let m = 0; m < 24 * 60; m++) {
    await h.tick(day + m * MIN);
    await h.notices.notice(A, ack('renewed'));
    await h.notices.notice(B, ack('renewed'));
  }
  await h.tick(at(12, 23, 59, 59));
  assert.equal(h.ntfy.length, ACK_NTFY_DAY_MAX, `12 a day, not ${h.ntfy.length}`);
  assert.equal(h.notices.ntfy.pushedToday(), 12);
  assert.ok(h.ntfy.slice(0, 11).every(n => !n.message.includes(ACK_NTFY_LAST_LINE)), 'only the last says so');
  // 10:00's push opened the window before that minute's two renewals: 60 minutes of two.
  assert.equal(h.ntfy[11].message, 'renewed' + ntfyFlushSuffix(120) + '\n' + ACK_NTFY_LAST_LINE, 'the 12th carries the hour\'s count and the last line');
  assert.equal(h.notices.ntfy.held(), 0, 'notices after the cap are not held for tomorrow');
  // #pepper kept going, per key, about every 10 minutes each.
  assert.ok(h.pepper.length >= 2 * 6 * 24 - 2, `#pepper is not capped by ntfy's budget (${h.pepper.length})`);
  // Local midnight: a new day, and the next ack goes out at once, without the last line.
  await h.tick(at(13, 0));
  assert.equal(h.ntfy.length, 12, 'nothing held over midnight');
  assert.equal((await h.notices.notice(A, ack('new day'))).ntfy.sent, true);
  assert.deepEqual(h.ntfy[12], { message: 'new day', priority: 'low' });
  assert.equal(h.notices.ntfy.pushedToday(), 1);
});

test('one an hour: no two ntfy pushes are less than an hour apart, whatever the pattern', async () => {
  const h = both();
  const stamps = [];
  const budget = createAckNtfyBudget({ send: async () => { stamps.push(h.now); }, clock: () => h.now, setTimer: (fn, ms) => { h.timers.push({ fn, at: h.now + ms }); } });
  const start = at(12, 0);
  // Bursts at odd moments over six hours; the timers' pushes are stamped at their due time.
  for (const m of [0, 1, 2, 59, 60, 61, 62, 119, 200, 201, 260, 261, 262, 330]) {
    await h.tick(start + m * MIN);
    await budget.notice(ack());
  }
  await h.tick(start + 8 * HOUR);
  assert.ok(stamps.length >= 5, `the bursts were pushed (${stamps.length})`);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= HOUR, `push ${i} came ${(stamps[i] - stamps[i - 1]) / MIN} minutes after the last`);
  assert.equal(budget.held(), 0, 'and every burst went out in the end');
});

test('a held count that crosses local midnight is the new day\'s first push', async () => {
  const h = both(at(12, 23, 30));
  // A fresh budget pushes at 23:30 and holds one at 23:45.
  await h.notices.notice(A, ack('late'));
  h.now = at(12, 23, 45);
  await h.notices.notice(B, ack('later'));
  await h.tick(at(13, 0, 30));
  assert.deepEqual(h.ntfy.map(n => n.message), ['late', 'later' + ntfyFlushSuffix(1)]);
  assert.equal(h.notices.ntfy.pushedToday(), 1, 'counted on the day it went out');
});

test('a failed ntfy push at the hour\'s end goes to onError; a failure on one channel never stops the other', async () => {
  const h = both();
  await h.notices.notice(A, ack('first'));
  h.now += MIN;
  await h.notices.notice(B, ack('held'));
  h.failNtfy = true;
  await h.tick(at(12, 1));
  assert.deepEqual(h.errors, ['ntfy down']);
  // #pepper down: ntfy still gets its push, and the caller hears the failure.
  h.failPepper = true;
  h.now = at(12, 3);
  await assert.rejects(h.notices.notice('cron:launchd:com.example.other', ack('pepper down')), /discord down/);
  assert.equal(h.ntfy.at(-1).message, 'pepper down', 'ntfy went out although #pepper failed');
  // ntfy down on a direct push: #pepper still gets its notice.
  h.failPepper = false;
  h.failNtfy = true;
  h.now = at(12, 5);
  const before = h.pepper.length;
  await assert.rejects(h.notices.notice('cron:launchd:com.example.third', ack('ntfy down')), /ntfy down/);
  assert.equal(h.pepper.length, before + 1, '#pepper went out although ntfy failed');
});

test('notices after the day\'s last push are #pepper\'s only: never held, so nothing from them crosses midnight', async () => {
  const h = both(at(12, 0));
  // Spend the day: one push an hour, 12 of them, the last at 11:00.
  for (let i = 0; i < 12; i++) {
    await h.tick(at(12, i));
    await h.notices.ntfy.notice(ack(`hour ${i}`));
  }
  assert.equal(h.ntfy.length, 12);
  assert.ok(h.ntfy[11].message.endsWith('\n' + ACK_NTFY_LAST_LINE));
  // Late in the day, inside the 11:00 window's hour no more: still spent.
  await h.tick(at(12, 23, 50));
  assert.deepEqual(await h.notices.ntfy.notice(ack('after the cap')), { sent: false, held: 0, spent: true });
  // Even inside the last push's own hour, which runs past midnight (a budget of 2 to keep it short).
  const h2 = both(at(12, 0));
  const budget = createAckNtfyBudget({ send: async n => { h2.ntfy.push(n); }, clock: () => h2.now, setTimer: (fn, ms) => { h2.timers.push({ fn, at: h2.now + ms }); }, dayMax: 2 });
  await h2.tick(at(12, 22, 0));
  await budget.notice(ack('one'));
  await h2.tick(at(12, 23, 30));
  await budget.notice(ack('two'));
  assert.ok(h2.ntfy[1].message.endsWith('\n' + ACK_NTFY_LAST_LINE), 'with dayMax 2, the second is the last');
  await h2.tick(at(12, 23, 40));
  assert.deepEqual(await budget.notice(ack('inside the last push\'s hour')), { sent: false, held: 0, spent: true });
  assert.equal(budget.held(), 0);
  await h2.tick(at(13, 0, 45));
  assert.equal(h2.ntfy.length, 2, 'the window that opened at 23:30 ends after midnight with nothing to push');
  assert.equal((await budget.notice(ack('new day'))).sent, true);
});
