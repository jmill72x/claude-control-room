// The hourly series behind Burn and the week's heat map. Every time is built
// from a local date (new Date(y, m, d, h, min)), so the tests hold in any time
// zone; they run in local time and in TZ=Asia/Tokyo. The records are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHourly, familyOf, FAMILIES } from '../lib/hourly.mjs';

const at = (d, h, min = 0) => new Date(2026, 9, d, h, min).getTime(); // October 2026, local
const NOW = at(20, 15, 20); // Tue 10-20, 3:20 PM
const rec = (ts, tokens, model = 'claude-opus-4-1') => ({ ts, tokens, model, cacheReadTokens: 999 });
const one = records => [{ records }];

test('model ids fall into Opus, Fable, Sonnet, Haiku, or Other for anything else', () => {
  assert.deepEqual(FAMILIES, ['opus', 'fable', 'sonnet', 'haiku', 'other']);
  assert.equal(familyOf('claude-opus-4-1'), 'opus');
  assert.equal(familyOf('claude-fable-5'), 'fable');
  assert.equal(familyOf('claude-sonnet-4-5-20250929'), 'sonnet');
  assert.equal(familyOf('claude-haiku-4-5'), 'haiku');
  for (const id of ['claude-mythos-1', 'unknown', '<synthetic>', '', undefined]) assert.equal(familyOf(id), 'other', String(id));
});

test('the last 24 clock hours: the current hour last, each record in its hour and family, new tokens only', () => {
  const { last24h } = buildHourly(one([
    rec(at(20, 15, 5), 100),
    rec(at(20, 14, 59), 50, 'claude-fable-5'),
    rec(at(20, 14, 10), 7, 'claude-haiku-4-5'),
    rec(at(19, 16, 0), 3, 'claude-sonnet-4-5'), // the first hour of the 24
    rec(at(19, 15, 59), 1000), // the hour before it: out
    rec(at(20, 15, 25), 1000) // after now: out
  ]), NOW);
  assert.equal(last24h.length, 24);
  assert.equal(last24h[23].start, at(20, 15));
  assert.equal(last24h[0].start, at(19, 16));
  assert.deepEqual(last24h[23], { start: at(20, 15), opus: 100, fable: 0, sonnet: 0, haiku: 0, other: 0 });
  assert.deepEqual(last24h[22], { start: at(20, 14), opus: 0, fable: 50, sonnet: 0, haiku: 7, other: 0 });
  assert.equal(last24h[0].sonnet, 3);
  const all = last24h.reduce((sum, h) => sum + FAMILIES.reduce((s, f) => s + h[f], 0), 0);
  assert.equal(all, 160);
});

test('the last hour is a rolling 60 minutes, not the clock hour', () => {
  const { lastHour } = buildHourly(one([
    rec(NOW - 59 * 60000, 10),
    rec(NOW - 61 * 60000, 1000),
    rec(NOW, 5)
  ]), NOW);
  assert.equal(lastHour, 15);
});

test('the week: today and the six days before, by local clock hour, with day totals and the peak hour', () => {
  const { week } = buildHourly(one([
    rec(at(14, 3, 10), 4), // the first day
    rec(at(13, 23, 59), 1000), // the day before it: out
    rec(at(18, 15, 1), 300, 'claude-fable-5'),
    rec(at(18, 15, 40), 32),
    rec(at(18, 20, 0), 25),
    rec(at(20, 9, 30), 60)
  ]), NOW);
  assert.deepEqual(week.days.map(d => d.date), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
  assert.equal(week.days[0].start, at(14, 0));
  assert.equal(week.days[0].hours[3], 4);
  assert.equal(week.days[0].total, 4);
  assert.equal(week.days[4].hours[15], 332);
  assert.equal(week.days[4].hours[20], 25);
  assert.equal(week.days[4].total, 357);
  assert.equal(week.days[6].hours[9], 60);
  for (const d of week.days) assert.equal(d.hours.length, 24);
  assert.deepEqual(week.peak, { date: '2026-10-18', hour: 15, tokens: 332 });
});

test('no records: every bucket is zero and there is no peak, rather than an invented one', () => {
  const out = buildHourly([], NOW);
  assert.equal(out.lastHour, 0);
  assert.equal(out.week.peak, null);
  assert.ok(out.last24h.every(h => FAMILIES.every(f => h[f] === 0)));
  assert.ok(out.week.days.every(d => d.total === 0));
});

test('records across several files are summed, and a record with no usable time or tokens is skipped', () => {
  const out = buildHourly([
    { records: [rec(at(20, 15, 1), 10)] },
    { records: [rec(at(20, 15, 2), 20), { ts: NaN, tokens: 5, model: 'claude-opus-4-1' }, rec(at(20, 15, 3), -4)] }
  ], NOW);
  assert.equal(out.last24h[23].opus, 30);
  assert.equal(out.week.days[6].total, 30);
});
