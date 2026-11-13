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
