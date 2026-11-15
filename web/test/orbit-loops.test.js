// The Loops panel's logic (src/lib/orbit/loops.js): the server's `loops` view in words.
// Times are built from local dates, so the tests hold in any time zone. Every name and
// figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopsView, statusChip, stepMarks, hasOpen, STEPS } from '../src/lib/orbit/loops.js';

const MIN = 60e3;
const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime(); // November 2026, local
const NOW = at(11, 23, 30); // Wed 11-11, 11:30 PM

const view = (extra = {}) => ({ status: 'on', why: null, open: [], quiet: [], held: [], recent: [], weeks: [], generatedAt: NOW, ...extra });

test('no panel from a server without the loops', () => {
  assert.equal(loopsView(undefined, NOW), null);
  assert.equal(loopsView(null, NOW), null);
  assert.equal(hasOpen(undefined), false);
});

test('the status chip: on, off by the kill switch, off with a reason, or not set up', () => {
  assert.deepEqual(statusChip(view()), { label: 'Heals on', tone: 'ok' });
  assert.deepEqual(statusChip(view({ status: 'killed', why: 'x' })), { label: 'Heals off', tone: 'idle', why: 'the kill switch is on' });
  assert.deepEqual(statusChip(view({ status: 'off', why: "the heal ledger couldn't be read at start" })), { label: 'Heals off', tone: 'idle', why: "the heal ledger couldn't be read at start" });
  assert.deepEqual(statusChip(view({ status: 'unset', why: 'heal.enabled is not true in config.json' })), { label: 'Not set up', tone: 'idle', why: 'heal.enabled is not true in config.json' });
  assert.equal(statusChip({}).label, 'Not set up');
});

test('the four steps, with the current one marked', () => {
  assert.deepEqual(STEPS, ['detect', 'diagnose', 'act', 'verify']);
  assert.deepEqual(stepMarks('diagnosing').map(s => s.mark), ['done', 'now', 'ahead', 'ahead']);
  assert.deepEqual(stepMarks('verifying').map(s => s.mark), ['done', 'done', 'done', 'now']);
  assert.deepEqual(stepMarks('detected').map(s => s.mark), ['now', 'ahead', 'ahead', 'ahead']);
  assert.deepEqual(stepMarks('nonsense').map(s => s.mark), ['now', 'ahead', 'ahead', 'ahead']);
});

test('an open loop: its name, tier, class, the second reading and the held alert', () => {
  const v = loopsView(view({ open: [{ name: 'NAS mount', class: 'stale-log', classLabel: 'stale log', action: 'mark-quiet', tier: 'T1', step: 'diagnosing', detectedAt: NOW - MIN, nextCheckAt: NOW + 3 * MIN, holdUntil: NOW + 9 * MIN }] }), NOW);
  assert.equal(hasOpen(view({ open: [{}] })), true);
  const o = v.open[0];
  assert.deepEqual([o.name, o.tier, o.what], ['NAS mount', 'T1', 'stale log']);
  assert.equal(o.when, 'second reading 11:33 PM');
  assert.equal(o.held, 'alert held until 11:39 PM');
  assert.equal(v.sub, '1 loop open · 0 healed this week');
  // A hold that has passed is not mentioned.
  assert.equal(loopsView(view({ open: [{ name: 'x', step: 'diagnosing', holdUntil: NOW - 1 }] }), NOW).open[0].held, null);
});

test('quiet and held rows, and the closed ones of the week with their outcome and why', () => {
  const v = loopsView(view({
    quiet: [{ name: 'NAS mount', since: NOW - 10 * 3600e3, checkedAt: NOW - MIN, tier: 'T1' }],
    held: [{ name: 'Backup', why: 'the kill switch is on (the heal-off file is there)' }],
    recent: [
      { name: 'NAS mount', class: 'stale-log', classLabel: 'stale log', tier: 'T1', outcome: 'healed', words: 'quiet, ran clean', why: "launchd's run counter rose and its last exit was 0", at: NOW - 5 * MIN },
      { name: 'Backup', class: 'stale-log', classLabel: 'stale log', tier: 'T1', outcome: 'escalated', words: 'left as it was', why: "launchd's run counter didn't move", at: at(10, 9) },
      { name: 'Watch', class: 'stale-log', tier: 'T1', outcome: 'cleared', words: 'cleared on its own', why: 'its log was written again', at: at(10, 8) }
    ],
    weeks: [{ class: 'stale-log', label: 'stale log', counts: [0, 0, 1, 1] }]
  }), NOW);
  assert.equal(v.quiet[0].line, 'quiet, ran clean (checked 11:29 PM): its log is old');
  assert.equal(v.held[0].line, 'held: the kill switch is on (the heal-off file is there)');
  assert.deepEqual(v.recent.map(r => [r.tone, r.mark, r.line, r.when]), [
    ['ok', '✓', 'stale log: quiet, ran clean', '11:25 PM'],
    ['bad', '✕', "stale log: left as it was (launchd's run counter didn't move)", 'Tue 9:00 AM'],
    ['idle', '·', 'stale-log: cleared on its own (its log was written again)', 'Tue 8:00 AM']
  ]);
  assert.deepEqual(v.weeks, [{ key: 'stale-log', label: 'stale log', counts: [0, 0, 1, 1] }]);
  assert.equal(v.sub, 'nothing open · 1 quiet · 1 healed this week');
  assert.equal(v.empty, false);
  assert.equal(loopsView(view(), NOW).empty, true);
});

// ---- loop 2: its open loops, its closed ones, and its cards for Needs you ----

import { healCards, tapDone, HEAL_ACTIONS } from '../src/lib/orbit/loops.js';
import { waitingCards, waitingView } from '../src/lib/orbit/waiting.js';

const proposal = (extra = {}) => ({
  id: 'ab'.repeat(16), name: 'Friday alert', class: 'missed-run', classLabel: 'missed run', tier: 'T2', missedAt: at(6, 16, 45), missedCount: 1,
  why: 'restart', fingerprint: 'the mini was off or waiting for login', actions: ['rerun-job', 'ack-until-next-run'], state: 'waiting',
  proposedAt: at(11, 23, 0), expiresAt: at(12, 1, 0), nextRunAt: at(13, 16, 45), canAct: true, blocked: null, ...extra
});

test("loop 2's open loops: waiting on Jeff, then the run a tap started", () => {
  const v = loopsView(view({ open: [
    { name: 'Friday alert', class: 'missed-run', classLabel: 'missed run', tier: 'T2', step: 'acting', waiting: true, detectedAt: NOW - MIN },
    { name: 'Token reminder', class: 'missed-run', classLabel: 'missed run', tier: 'T2', step: 'verifying', checkBy: NOW + 9 * MIN, detectedAt: NOW - 5 * MIN }
  ] }), NOW);
  assert.deepEqual(v.open.map(o => [o.name, o.when, o.steps.map(s => s.mark).join(' ')]), [
    ['Friday alert', 'waiting on you (Needs you)', 'done done now ahead'],
    ['Token reminder', 'run started, checked by 11:39 PM', 'done done done now']
  ]);
});

test("loop 2's closed loops: a tap's own outcome carries no repeated why; a page is red", () => {
  const r = loopsView(view({ recent: [
    { name: 'A', classLabel: 'missed run', tier: 'T2', outcome: 'healed', words: 'ran it again, clean', why: 'x', at: NOW - MIN },
    { name: 'B', classLabel: 'missed run', tier: 'T3', outcome: 'escalated', words: 'ran it again: it needs a look', why: 'its last exit was not 0', at: NOW - 2 * MIN },
    { name: 'C', classLabel: 'missed run', tier: 'T2', outcome: 'acked', words: 'acked until its next run', why: 'Ack until its next run was tapped', at: NOW - 3 * MIN },
    { name: 'D', classLabel: 'missed run', tier: 'T2', outcome: 'declined', words: 'not now', why: 'Not now was tapped', at: NOW - 4 * MIN },
    { name: 'E', classLabel: 'missed run', tier: 'T2', outcome: 'expired', words: 'card expired', why: 'no tap within 2 hours of the card', at: NOW - 5 * MIN }
  ] }), NOW).recent;
  assert.deepEqual(r.map(x => [x.tone, x.mark, x.line]), [
    ['ok', '✓', 'missed run: ran it again, clean'],
    ['bad', '✕', 'missed run: ran it again: it needs a look (its last exit was not 0)'],
    ['idle', '·', 'missed run: acked until its next run'],
    ['idle', '·', 'missed run: not now'],
    ['idle', '·', 'missed run: card expired (no tap within 2 hours of the card)']
  ]);
});

test('a heal card: what was missed, why, its buttons in a fixed order, and when it closes', () => {
  const [c] = healCards({ proposals: [proposal()] }, NOW);
  assert.deepEqual([c.key, c.group, c.chip, c.title], [`heal:${'ab'.repeat(16)}`, 'heals', 'Missed run', 'Friday alert: missed Fri 4:45 PM']);
  assert.equal(c.why, "The mini was off or waiting for login when it was due, and it hasn't run since.");
  assert.match(c.what, /^Run it now starts it once/);
  assert.match(c.what, /Its next run is Fri 4:45 PM\.$/);
  assert.equal(c.meta, 'T2 · card open until 1:00 AM');
  assert.deepEqual(c.heal, { id: 'ab'.repeat(16), name: 'Friday alert', actions: HEAL_ACTIONS, canAct: true, blocked: null });
  assert.deepEqual(HEAL_ACTIONS.map(a => a.label), ['Run it now', 'Ack until its next run']);
  // Only the ack, for a job whose late run is no use; actions come in the page's order.
  const [ack] = healCards({ proposals: [proposal({ actions: ['ack-until-next-run'], missedCount: 3, expiresAt: null })] }, NOW);
  assert.deepEqual(ack.heal.actions.map(a => a.action), ['ack-until-next-run']);
  assert.match(ack.what, /offers no run/);
  assert.equal(ack.title, 'Friday alert: missed Fri 4:45 PM (2 more before it)');
  assert.equal(ack.meta, 'T2 · no push at night: it waits for the morning');
  const [both] = healCards({ proposals: [proposal({ actions: ['ack-until-next-run', 'rerun-job', 'restart-everything'] })] }, NOW);
  assert.deepEqual(both.heal.actions.map(a => a.action), ['rerun-job', 'ack-until-next-run'], 'an action the page does not know is no button');
  // Off: the reason, or a plain one.
  assert.deepEqual(healCards({ proposals: [proposal({ canAct: false, blocked: 'the kill switch is on (the heal-off file is there)' })] }, NOW)[0].heal.blocked, 'the kill switch is on (the heal-off file is there)');
  assert.equal(healCards({ proposals: [proposal({ canAct: false, blocked: null })] }, NOW)[0].heal.blocked, 'heals are off');
  assert.equal(healCards({ proposals: [proposal({ canAct: 'yes' })] }, NOW)[0].heal.canAct, false, 'only true is on');
  // A server from before loop 2, or a card with no id, gives none.
  assert.deepEqual(healCards({ status: 'on' }, NOW), []);
  assert.deepEqual(healCards(undefined, NOW), []);
  assert.deepEqual(healCards({ proposals: [{ name: 'x' }, null] }, NOW), []);
});

test("a tap's answer in words", () => {
  assert.equal(tapDone('rerun-job', { checkBy: NOW + 10 * MIN }, NOW), 'Started. The Loops panel shows the check, done by 11:40 PM.');
  assert.equal(tapDone('ack-until-next-run', { until: at(13, 18, 45) }, NOW), 'Acked until Fri 6:45 PM.');
  assert.equal(tapDone('not-now', {}, NOW), 'Left as it is.');
});

test('Needs you: the Heals tile shows only while a card waits, its cards go first, and they count', () => {
  const base = { items: [], today: '2026-11-11', roster: { agents: [] }, toPushEnv: { data: { configured: true, repos: [] }, status: 'ok' }, now: NOW };
  const none = waitingView(waitingCards({ ...base, loops: view() }));
  assert.deepEqual(none.tiles.map(t => t.id), ['due', 'decide', 'push', 'alerts'], 'four tiles, as before');
  const due = { id: 'd1', text: 'Pay the bill. Online.', lane: 'idea', tag: 'Home', due: '2026-11-11', ask: { what: 'Pay it.', kind: 'do' } };
  const cards = waitingCards({ ...base, items: [due], loops: view({ proposals: [proposal()] }), alerts: [{ key: 'limit:Weekly', kind: 'limit', text: 'Weekly at 90%' }] });
  const v = waitingView(cards);
  assert.deepEqual(v.tiles.map(t => [t.id, t.n]), [['heals', 1], ['due', 1], ['decide', 0], ['push', 0], ['alerts', 1]]);
  assert.equal(v.total, 3);
  assert.deepEqual(v.shown.map(c => c.group), ['heals', 'due', 'alerts'], 'a heal card first: it expires 2 hours after its push');
  const only = waitingView(cards, { filter: 'heals' });
  assert.deepEqual(only.shown.map(c => c.group), ['heals']);
  assert.equal(only.showing, 'Showing 1 to answer. Tap the tile again for all 3.');
  // Picked, then the card went: the tile stays so it can be tapped off, and says so.
  const gone = waitingView(waitingCards({ ...base, loops: view() }), { filter: 'heals' });
  assert.deepEqual([gone.tiles[0].id, gone.tiles[0].n, gone.empty], ['heals', 0, 'No heal card is waiting on you.']);
});
