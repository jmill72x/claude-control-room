// The Orbit Overview's logic (src/lib/orbit/overview.js). Times are built from
// local dates, so the tests hold in any time zone. Every figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RINGS, circumference, ringLabel, ringView, resetNote, sessionCountdown, next24,
  burnBars, burnShares, shareLabel, shadeLevel, heatRows, SHADES
} from '../src/lib/orbit/overview.js';

const at = (d, h, min = 0) => new Date(2026, 9, d, h, min).getTime(); // October 2026, local
const NOW = at(20, 21, 30); // Tue 10-20, 9:30 PM
const iso = t => new Date(t).toISOString();

// ---- Usage limits ----

test('ring labels: Session, Week, and the model for any other weekly limit', () => {
  assert.equal(ringLabel('Current session'), 'Session');
  assert.equal(ringLabel('Weekly · all models'), 'Week');
  assert.equal(ringLabel('Weekly · Fable'), 'Fable');
});

test('each ring\'s arc is its percent of the circle, clamped, with the last window as a faint arc', () => {
  const limits = [
    { label: 'Current session', pct: 25, resetsAt: iso(at(21, 0, 40)), lastWindowPct: 79 },
    { label: 'Weekly · all models', pct: 140, resetsAt: iso(at(26, 20)), lastWindowPct: 7 },
    { label: 'Weekly · Fable', pct: null, resetsAt: null }
  ];
  const [s, w, f] = ringView(limits, NOW);
  assert.equal(s.r, RINGS[0].r);
  assert.ok(Math.abs(s.arc - circumference(88) / 4) < 1e-9);
  assert.ok(Math.abs(s.ghost - circumference(88) * 0.79) < 1e-9);
  assert.equal(s.pctLabel, '25%');
  assert.equal(s.note, 'resets 12:40 AM');
  assert.equal(s.ghostLabel, 'last window 79%');
  assert.ok(Math.abs(w.arc - circumference(70)) < 1e-9, 'clamped at a full circle');
  assert.equal(w.pctLabel, '140%');
  assert.equal(w.note, 'resets Mon 8 PM');
  assert.equal(w.ghostLabel, 'last week 7%');
  assert.equal(f.pctLabel, '—');
  assert.equal(f.arc, 0);
  assert.equal(f.ghost, null);
  assert.equal(f.ghostLabel, '');
  assert.equal(f.note, 'no reset reported');
});

test('the countdown runs to the session reset, and there is none without a session window', () => {
  assert.equal(sessionCountdown([{ label: 'Current session', resetsAt: iso(NOW + (4 * 3600 + 38 * 60 + 41) * 1000) }], NOW), '4:38:41');
  assert.equal(sessionCountdown([{ label: 'Current session', resetsAt: iso(NOW - 1000) }], NOW), '0:00:00');
  assert.equal(sessionCountdown([{ label: 'Current session', resetsAt: null }], NOW), null);
  assert.equal(sessionCountdown([], NOW), null);
});

test('a reset more than a day off reads as its weekday and time', () => {
  assert.equal(resetNote(iso(at(26, 19, 59)), NOW), 'resets Mon 7:59 PM');
  assert.equal(resetNote(iso(at(21, 7, 30)), NOW), 'resets 7:30 AM');
  assert.equal(resetNote(null, NOW), 'no reset reported');
});

// ---- Next 24 hours ----

const CRONS = [
  { label: 'com.example.brief', name: 'brief', nextRunAt: at(21, 7, 30) },
  { label: 'com.example.alert', name: 'alert', nextRunAt: at(21, 16, 45) },
  { label: 'com.example.weekly', name: 'weekly', nextRunAt: at(25, 4, 0) }, // more than 24 hours away
  { label: 'com.example.watch', name: 'watch', nextRunAt: null }, // every few minutes: no fixed next run
  { label: 'com.example.past', name: 'past', nextRunAt: at(20, 21, 0) }
];
const JOBS = { 'com.example.brief': { name: 'Morning brief', owner: 'chief' } };

test('next 24 hours: the next run of each calendar job within the day, and the limit resets, soonest first', () => {
  const { events } = next24({
    crons: CRONS, jobs: JOBS, now: NOW,
    limits: [{ label: 'Current session', resetsAt: iso(at(21, 0, 40)) }, { label: 'Weekly · all models', resetsAt: iso(at(26, 20)) }]
  });
  assert.deepEqual(events.map(e => [e.name, e.at, e.owner, e.kind, e.row]), [
    ['Session resets', '12:40 AM', null, 'reset', 'top'],
    ['Morning brief', '7:30 AM', 'chief', 'job', 'bottom'],
    ['alert', '4:45 PM', null, 'job', 'top']
  ]);
  assert.equal(events[1].left, `${(((at(21, 7, 30) - NOW) / 864e5) * 100).toFixed(2)}%`);
  assert.deepEqual(events.map(e => e.align), ['center', 'center', 'center']);
  // Near either end of the day, a label lines up inward.
  const edges = next24({
    crons: [{ label: 'x', name: 'soon', nextRunAt: at(20, 22, 30) }, { label: 'y', name: 'late', nextRunAt: at(21, 21, 0) }],
    limits: [], jobs: {}, now: NOW
  });
  assert.deepEqual(edges.events.map(e => e.align), ['start', 'end']);
});

test('two weekly limits resetting in the same minute are one event', () => {
  const { events } = next24({
    crons: [], jobs: {}, now: NOW,
    limits: [{ label: 'Weekly · all models', resetsAt: iso(at(21, 20)) }, { label: 'Weekly · Fable', resetsAt: iso(at(21, 20, 1)) }]
  });
  assert.deepEqual(events.map(e => e.name), ['Weekly limits reset']);
  const apart = next24({ crons: [], jobs: {}, now: NOW, limits: [{ label: 'Weekly · Fable', resetsAt: iso(at(21, 20)) }] });
  assert.deepEqual(apart.events.map(e => e.name), ['Fable week resets']);
});

test('the ticks mark midnight, 6 AM, noon and 6 PM within the day ahead', () => {
  const { ticks } = next24({ crons: [], limits: [], jobs: {}, now: NOW });
  assert.deepEqual(ticks.map(t => t.label), ['12 AM', '6 AM', '12 PM', '6 PM']);
  assert.equal(ticks[0].left, `${(((at(21, 0) - NOW) / 864e5) * 100).toFixed(2)}%`);
});

// ---- Burn ----

const hour = (start, f = {}) => ({ start, opus: 0, fable: 0, sonnet: 0, haiku: 0, other: 0, ...f });

test('burn bars scale to the busiest hour, stacked by model, and an empty hour is a stub', () => {
  const bars = burnBars([hour(1, { opus: 150, fable: 50 }), hour(2), hour(3, { opus: 100 })]);
  assert.deepEqual(bars[0].segs.map(s => [s.family, s.h]), [['opus', '72.00%'], ['fable', '24.00%']]);
  assert.deepEqual(bars[1], { start: 2, total: 0, segs: [] });
  assert.deepEqual(bars[2].segs.map(s => s.h), ['48.00%']);
});

test('model shares over the last 24 hours: one decimal under 10%, never 0% for a model that was used', () => {
  const { total, families } = burnShares([hour(1, { opus: 9805, fable: 184, sonnet: 10 }), hour(2, { haiku: 1 })]);
  assert.equal(total, 10000);
  assert.deepEqual(families.map(f => [f.name, f.share]), [['Opus', '98%'], ['Fable', '1.8%'], ['Sonnet', '0.1%'], ['Haiku', '<0.1%']]);
  assert.equal(shareLabel(0), '0%');
  assert.deepEqual(burnShares([hour(1)]).families, []);
});

// ---- the heat map ----

test('shades step at fixed fractions of the week\'s busiest hour', () => {
  assert.equal(shadeLevel(0, 332), 0);
  assert.equal(shadeLevel(25, 332), 1);
  assert.equal(shadeLevel(26, 332), 2);
  assert.equal(shadeLevel(75, 332), 2);
  assert.equal(shadeLevel(150, 332), 3);
  assert.equal(shadeLevel(151, 332), 4);
  assert.equal(shadeLevel(332, 332), 4);
  // The same shape at a hundredth of the size reads the same.
  assert.equal(shadeLevel(1.5, 3.32), 3);
  assert.equal(shadeLevel(5, 0), 0);
  assert.equal(SHADES.length, 5);
});

test('heat rows: weekday labels, the peak hour ringed and named, busy days in bold', () => {
  const day = (date, hours) => {
    const h = new Array(24).fill(0);
    for (const [k, v] of Object.entries(hours)) h[k] = v;
    return { date, start: 0, hours: h, total: h.reduce((a, b) => a + b, 0) };
  };
  const out = heatRows({
    days: [day('2026-10-17', { 3: 4 }), day('2026-10-18', { 15: 332, 20: 25 })],
    peak: { date: '2026-10-18', hour: 15, tokens: 332 }
  });
  assert.deepEqual(out.rows.map(r => r.label), ['Sat', 'Sun']);
  assert.equal(out.rows[1].cells[15].peak, true);
  assert.equal(out.rows[1].cells[15].level, 4);
  assert.equal(out.rows[1].cells[20].level, 1);
  assert.equal(out.rows[0].cells[3].peak, false);
  assert.equal(out.rows[0].cells[15].peak, false, 'the peak is one cell, not an hour on every day');
  assert.equal(out.rows[1].strong, true);
  assert.equal(out.rows[0].strong, false);
  assert.equal(out.rows[1].total, '357');
  assert.equal(out.total, 361);
  assert.equal(out.peakLabel, 'Sun 3 PM');
  assert.equal(heatRows({ days: [], peak: null }).peakLabel, null);
  assert.equal(heatRows({ days: [day('2026-10-19', { 0: 9 })], peak: { date: '2026-10-19', hour: 0, tokens: 9 } }).peakLabel, 'Mon 12 AM');
});
