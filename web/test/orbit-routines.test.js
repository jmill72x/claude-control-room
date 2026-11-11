// Today's routines (src/lib/orbit/routines.js). Times are built from local dates,
// so the tests hold in any time zone. Every job here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routinesView, routinesSummary, verdictFor, VERDICT_WORDS } from '../src/lib/orbit/routines.js';

const MIN = 60e3;
const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime(); // November 2026, local
const NOW = at(10, 15, 0); // Tue 11-10, 3:00 PM
const jobs = {
  'com.example.morning': { name: 'Morning brief', owner: 'atlas' },
  'com.example.scout': { name: 'Scout', owner: 'atlas' },
  'com.example.friday': { name: 'Friday alert', owner: 'forge' },
  'com.example.backup': { name: 'Memory backup', owner: 'ops' }
};
const crons = [
  { label: 'com.example.morning', name: 'morning', ok: true, state: 'ok', dueAt: [at(10, 7, 30)], lastRunAt: at(10, 7, 30) + 20e3, nextRunAt: at(11, 7, 30) },
  { label: 'com.example.scout', name: 'scout', ok: false, state: 'failed', dueAt: [at(10, 9)], lastRunAt: at(9, 9), nextRunAt: at(11, 9) },
  { label: 'com.example.friday', name: 'friday', ok: true, state: 'ok', dueAt: [], lastRunAt: at(6, 16, 45), nextRunAt: at(13, 16, 45) },
  { label: 'com.example.evening', name: 'evening', ok: true, state: 'ok', dueAt: [], lastRunAt: at(9, 20), nextRunAt: at(10, 20) },
  { label: 'com.example.backup', name: 'backup', ok: true, state: 'ok', dueAt: [], lastRunAt: at(8, 4, 30), nextRunAt: at(15, 4, 30) },
  { label: 'com.example.interval', name: 'interval', ok: true, state: 'ok', nextRunAt: null }
];

test('a verdict: ran, due, missed, acked, late (not failed yet) or scheduled (no run time known)', () => {
  const due = at(10, 9);
  assert.equal(verdictFor({ lastRunAt: due + 5e3 }, due, NOW), 'ran');
  assert.equal(verdictFor({ lastRunAt: due - 30e3 }, due, NOW), 'ran', 'job-status rounds to 36 s: a run logged just before counts');
  assert.equal(verdictFor({ lastRunAt: at(9, 9) }, at(10, 20), NOW), 'due');
  assert.equal(verdictFor({ lastRunAt: at(9, 9), ok: false }, due, NOW), 'missed');
  assert.equal(verdictFor({ lastRunAt: at(9, 9), state: 'failed' }, due, NOW), 'missed');
  assert.equal(verdictFor({ lastRunAt: at(9, 9), ok: false, ack: { by: 'jeff' } }, due, NOW), 'acked');
  assert.equal(verdictFor({ lastRunAt: at(9, 9), ok: true }, due, NOW), 'late');
  assert.equal(verdictFor({ lastRunAt: null }, due, NOW), 'scheduled');
  assert.equal(verdictFor({}, due, NOW), 'scheduled');
  assert.deepEqual(Object.keys(VERDICT_WORDS).sort(), ['acked', 'due', 'late', 'missed', 'ran', 'scheduled']);
});

test("today's rows: every due time today in order, named from config, with its verdict; later runs today as due; then the next day's first", () => {
  const view = routinesView({ crons, jobs, now: NOW });
  assert.deepEqual(view.rows.map(r => [r.time, r.name, r.verdict, r.word, r.tone]), [
    ['7:30 AM', 'Morning brief', 'ran', 'ran', 'ok'],
    ['9:00 AM', 'Scout', 'missed', 'missed', 'bad'],
    ['8:00 PM', 'evening', 'due', 'due', 'idle']
  ]);
  assert.equal(view.next.text, 'Wed 7:30 AM Morning brief');
  assert.equal(view.next.t, at(11, 7, 30));
  assert.deepEqual(view.counts, { ran: 1, due: 1, missed: 0 + 1, acked: 0 });
  assert.equal(routinesSummary(view), '1 ran · 1 due · 1 missed');
});

test('a due time already in dueAt is not listed twice as due; yesterday\'s and tomorrow\'s are left out', () => {
  const both = [{ label: 'com.example.evening', name: 'evening', dueAt: [at(9, 20), at(10, 20), at(11, 20)], lastRunAt: at(9, 20), nextRunAt: at(10, 20) }];
  const view = routinesView({ crons: both, jobs, now: NOW });
  assert.deepEqual(view.rows.map(r => [r.time, r.verdict]), [['8:00 PM', 'due']]);
  assert.equal(view.next, null, 'tomorrow\'s due time is not a nextRunAt');
});

test('an acked failure reads acked, and an interval job never appears', () => {
  const acked = [{ ...crons[1], ack: { by: 'jeff', until: NOW + 60 * MIN } }, crons[5]];
  const view = routinesView({ crons: acked, jobs, now: NOW });
  assert.deepEqual(view.rows.map(r => r.verdict), ['acked']);
  assert.equal(routinesSummary(view), '1 acked');
});

test('without job-status the marks are scheduled; with nothing today the summary says so', () => {
  const noOverlay = [{ label: 'com.example.morning', name: 'morning', dueAt: [at(10, 7, 30)], nextRunAt: at(11, 7, 30) }];
  const view = routinesView({ crons: noOverlay, jobs, now: NOW });
  assert.deepEqual(view.rows.map(r => r.verdict), ['scheduled']);
  assert.equal(routinesSummary(view), '1 scheduled');
  assert.equal(routinesSummary(routinesView({ crons: [], jobs, now: NOW })), 'No calendar job runs today.');
  assert.equal(routinesSummary(routinesView({ crons: null, jobs, now: NOW })), 'No calendar job runs today.');
  assert.equal(routinesSummary(null), 'No calendar job runs today.');
});

test('a job with no config name uses its own, and a run due at this minute is not yet missed', () => {
  const view = routinesView({ crons: [{ label: 'x.y', name: 'loose', dueAt: [NOW - 10e3], lastRunAt: at(9, 9), ok: true, nextRunAt: at(11, 15) }], jobs: {}, now: NOW });
  assert.deepEqual(view.rows.map(r => [r.name, r.verdict]), [['loose', 'late']]);
});
