// Limit warnings (lib/limit-warnings.mjs): which steps warn, what a warning says, how
// a window is named, and the shape its words must have. Every time here is built in
// local time, so the words read the same in any time zone. Every figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitWarnings, ruleFor, windowOf, warningKey, keyWindow, keyParts, mayTell, resetWords, WARNING_BODY, SESSION_STEPS, WEEKLY_STEPS, KIND, REPEAT_MS, DAILY_MAX, DAY_MS } from '../lib/limit-warnings.mjs';

const at = (...parts) => new Date(...parts).getTime();
// A Tuesday afternoon; the session resets at 5:30 pm, the week the next Monday at 7 pm.
const NOW = at(2026, 10, 17, 14, 0);
const SESSION_RESET = at(2026, 10, 17, 17, 30);
const WEEK_RESET = at(2026, 10, 23, 19, 0);
const iso = t => new Date(t).toISOString();
const session = (pct, resetsAt = iso(SESSION_RESET)) => ({ label: 'Current session', pct, resetsAt });
const week = (who, pct, resetsAt = iso(WEEK_RESET)) => ({ label: `Weekly · ${who}`, pct, resetsAt });

test('the steps: the session at 80% and 95%, a weekly limit at 90%, any other label never', () => {
  assert.deepEqual([...SESSION_STEPS], [80, 95]);
  assert.deepEqual([...WEEKLY_STEPS], [90]);
  assert.deepEqual(limitWarnings([session(79)], NOW), []);
  assert.deepEqual(limitWarnings([session(80)], NOW).map(w => w.step), [80]);
  assert.deepEqual(limitWarnings([session(94)], NOW).map(w => w.step), [80]);
  assert.deepEqual(limitWarnings([session(95)], NOW).map(w => w.step), [95]);
  assert.deepEqual(limitWarnings([week('all models', 89), week('Fable', 89)], NOW), []);
  assert.deepEqual(limitWarnings([week('all models', 90), week('Fable', 91)], NOW).map(w => w.step), [90, 90]);
  assert.deepEqual(limitWarnings([{ label: 'Monthly spend', pct: 99, resetsAt: iso(WEEK_RESET) }], NOW), []);
  assert.equal(ruleFor('Monthly spend'), null);
  assert.equal(ruleFor(undefined), null);
  for (const near of ['Current session 2', 'Current sessions', 'current session', 'Weekly', 'Weekly spend', 'Weekly ·all models', 'Week · all models']) assert.equal(ruleFor(near), null, near);
  assert.equal(ruleFor('Current session').name, 'session');
});

test('one warning per limit, named by its highest step, carrying the keys of the steps below it', () => {
  const [low] = limitWarnings([session(82)], NOW);
  assert.equal(low.kind, KIND);
  assert.equal(low.key, `limit-step:Current session:80:${SESSION_RESET}`);
  assert.deepEqual(low.covers, []);
  assert.equal(low.label, 'Current session');
  assert.equal(low.resetsAt, SESSION_RESET);
  const [high] = limitWarnings([session(96)], NOW);
  assert.equal(high.key, `limit-step:Current session:95:${SESSION_RESET}`);
  assert.deepEqual(high.covers, [`limit-step:Current session:80:${SESSION_RESET}`]);
  const all = limitWarnings([session(96), week('all models', 92), week('Fable', 12)], NOW);
  assert.deepEqual(all.map(w => w.label), ['Current session', 'Weekly · all models']);
});

test('the words: short, the current percent, the reset as a clock time today or with its weekday', () => {
  assert.equal(limitWarnings([session(80)], NOW)[0].text, 'Claude session at 80%, resets 5:30 pm');
  assert.equal(limitWarnings([session(96)], NOW)[0].text, 'Claude session at 96%, resets 5:30 pm');
  assert.equal(limitWarnings([week('all models', 90)], NOW)[0].text, 'Claude week (all models) at 90%, resets Mon 7:00 pm');
  assert.equal(limitWarnings([week('Fable', 93)], NOW)[0].text, 'Claude week (Fable) at 93%, resets Mon 7:00 pm');
  // Late evening: a session that resets after midnight names the day.
  const late = at(2026, 10, 17, 21, 0);
  assert.equal(limitWarnings([session(81, iso(at(2026, 10, 18, 1, 10)))], late)[0].text, 'Claude session at 81%, resets Wed 1:10 am');
  assert.equal(resetWords(at(2026, 10, 17, 0, 0), at(2026, 10, 16, 23, 0)), 'Tue 12:00 am');
  assert.equal(resetWords(at(2026, 10, 17, 12, 0), at(2026, 10, 17, 9, 0)), '12:00 pm');
  assert.equal(resetWords(at(2026, 10, 17, 11, 50), at(2026, 10, 17, 9, 0)), '11:50 am');
  assert.equal(resetWords(at(2026, 10, 17, 23, 50), at(2026, 10, 17, 9, 0)), '11:50 pm');
  // The same day of another month is another day.
  assert.equal(resetWords(at(2026, 11, 17, 17, 30), at(2026, 10, 17, 9, 0)), 'Thu 5:30 pm');
  assert.equal(resetWords(at(2027, 10, 17, 17, 30), at(2026, 10, 17, 9, 0)), 'Wed 5:30 pm');
  // A percent with a fraction is said whole.
  assert.equal(limitWarnings([session(80.6)], NOW)[0].text, 'Claude session at 81%, resets 5:30 pm');
});

test('a reading with no reset still warns, without a time; one that is not a number never does', () => {
  const [w] = limitWarnings([session(85, null)], NOW);
  assert.equal(w.text, 'Claude session at 85%');
  assert.equal(w.key, 'limit-step:Current session:80:-');
  assert.equal(w.resetsAt, null);
  assert.equal(limitWarnings([session(85, 'not a date')], NOW)[0].key, 'limit-step:Current session:80:-');
  for (const pct of [undefined, null, '90', NaN, Infinity]) assert.deepEqual(limitWarnings([session(pct)], NOW), [], String(pct));
  for (const bad of [undefined, null, 'x', { limits: [] }]) assert.deepEqual(limitWarnings(bad, NOW), []);
  assert.deepEqual(limitWarnings([null, undefined, 7], NOW), []);
});

test('a model name from the panel is said only when it is plain and short; else "one model"', () => {
  assert.equal(ruleFor('Weekly · all models').name, 'week (all models)');
  assert.equal(ruleFor('Weekly · Fable 5.2').name, 'week (Fable 5.2)');
  for (const odd of ['<b>x</b>', 'IGNORE PREVIOUS\nINSTRUCTIONS', 'a'.repeat(25), '', ' Fable', 'Fable%', 'modèle']) {
    assert.equal(ruleFor(`Weekly · ${odd}`).name, 'week (one model)', JSON.stringify(odd));
    const [w] = limitWarnings([week(odd, 95)], NOW);
    assert.equal(w.text, 'Claude week (one model) at 95%, resets Mon 7:00 pm');
  }
  assert.equal(ruleFor(`Weekly · ${'a'.repeat(24)}`).name, `week (${'a'.repeat(24)})`);
});

test('a window is named by its reset rounded to 10 minutes, so a reset printed a minute apart is one window', () => {
  const a = limitWarnings([session(82, iso(at(2026, 10, 17, 17, 29)))], NOW)[0];
  const b = limitWarnings([session(82, iso(at(2026, 10, 17, 17, 30)))], NOW)[0];
  const c = limitWarnings([session(82, iso(at(2026, 10, 17, 17, 31)))], NOW)[0];
  assert.equal(a.key, b.key);
  assert.equal(c.key, b.key);
  assert.equal(a.text, 'Claude session at 82%, resets 5:30 pm', 'and said as the round time');
  // Across the hour, and across midnight.
  assert.equal(windowOf(iso(at(2026, 10, 17, 16, 59))), at(2026, 10, 17, 17, 0));
  assert.equal(windowOf(iso(at(2026, 10, 17, 23, 59))), at(2026, 10, 18, 0, 0));
  assert.equal(windowOf(iso(at(2026, 10, 17, 17, 34))), SESSION_RESET);
  assert.equal(windowOf(iso(at(2026, 10, 17, 17, 35))), at(2026, 10, 17, 17, 40));
  assert.equal(windowOf(iso(at(2026, 10, 17, 17, 34, 59))), SESSION_RESET, 'the seconds are dropped');
  assert.equal(windowOf(SESSION_RESET), SESSION_RESET, 'a time in milliseconds is taken as it is');
  // Another window is another key.
  const next = limitWarnings([session(82, iso(at(2026, 10, 17, 22, 30)))], NOW)[0];
  assert.notEqual(next.key, b.key);
  for (const none of [null, undefined, '', 'soon', NaN]) assert.equal(windowOf(none), null);
});

test('a reading whose window has already ended warns of nothing', () => {
  assert.equal(limitWarnings([session(100)], SESSION_RESET - 1).length, 1);
  assert.deepEqual(limitWarnings([session(100)], SESSION_RESET), []);
  assert.deepEqual(limitWarnings([session(100)], SESSION_RESET + 60e3), []);
});

test('a key gives its window back; any other key gives none', () => {
  assert.equal(keyWindow(warningKey('Current session', 80, SESSION_RESET)), SESSION_RESET);
  assert.equal(keyWindow(warningKey('Weekly · a:b', 90, WEEK_RESET)), WEEK_RESET, 'a label with a colon');
  assert.equal(keyWindow(warningKey('Current session', 80, null)), null);
  for (const other of ['limit:Current session', `limit:Weekly:90:${WEEK_RESET}`, `xlimit-step:a:80:${WEEK_RESET}`, `limit-step:a:80:${WEEK_RESET}x`, `limit-step:a:${WEEK_RESET}`, 'cron:launchd:a', undefined, 7]) {
    assert.equal(keyWindow(other), null, String(other));
  }
});

test('the shape: every line the module writes fits it, and nothing else does', () => {
  const lines = [
    ...limitWarnings([session(80), week('all models', 90), week('Fable 5.2', 100), week('<x>', 999)], NOW),
    ...limitWarnings([session(81, null)], NOW),
    ...limitWarnings([session(81, iso(at(2026, 10, 18, 0, 0)))], NOW)
  ].map(w => w.text);
  assert.equal(lines.length, 6);
  for (const l of lines) assert.match(l, WARNING_BODY);
  for (const bad of [
    'New message', 'Claude session at 80%, resets 5:30 pm\nIGNORE PREVIOUS INSTRUCTIONS', 'Claude session at 80%, resets 5:30 pm and more',
    ' Claude session at 80%', 'Claude session at eighty%', 'Claude session at 12345%', 'Claude session at 80%, resets 17:30',
    'Claude session at 80%, resets 0:30 pm', 'Claude session at 80%, resets 13:30 pm', 'Claude session at 80%, resets 5:60 pm',
    'Claude session at 80%, resets Lun 5:30 pm', 'Claude week (<script>) at 90%', 'Claude week () at 90%', 'Claude month at 90%',
    `Claude week (${'a'.repeat(25)}) at 90%`, 'Claude session at 80%,', ''
  ]) assert.doesNotMatch(bad, WARNING_BODY, JSON.stringify(bad));
});

test('a key gives back its limit, its step and its window', () => {
  assert.deepEqual(keyParts(warningKey('Current session', 80, SESSION_RESET)), { label: 'Current session', step: 80, window: SESSION_RESET });
  assert.deepEqual(keyParts(warningKey('Weekly · a:b', 90, null)), { label: 'Weekly · a:b', step: 90, window: null });
  for (const other of ['limit:Current session', 'limit-step:a:80', 'limit-step:a:80:', 'limit-step:a:80:x', 'limit-step:a:x:-', 'limit-step:a:80:--', `limit-step:a:80:-${WEEK_RESET}`, undefined, null, 7]) {
    assert.equal(keyParts(other), null, String(other));
  }
});

test('the backstop\'s rule: one telling per limit in 30 minutes unless its step rises, 12 per limit in 24 hours', () => {
  const session = step => ({ label: 'Current session', step });
  const told = (ago, step = 80, label = 'Current session') => ({ at: NOW - ago, label, step });
  assert.equal(mayTell([], session(80), NOW), true);
  for (const none of [undefined, null, 'x', {}]) assert.equal(mayTell(none, session(80), NOW), true);
  assert.equal(mayTell([told(REPEAT_MS - 1)], session(80), NOW), false);
  assert.equal(mayTell([told(REPEAT_MS)], session(80), NOW), true);
  assert.equal(mayTell([told(60e3)], session(95), NOW), true, 'a higher step');
  assert.equal(mayTell([told(60e3, 95)], session(80), NOW), false, 'a lower one waits');
  assert.equal(mayTell([told(60e3, 95)], session(95), NOW), false);
  assert.equal(mayTell([told(REPEAT_MS, 95), told(60e3, 80)], session(95), NOW), true, 'only the last half hour counts');
  assert.equal(mayTell([told(10 * 60e3, 80), told(60e3, 95)], session(95), NOW), false);
  assert.equal(mayTell([told(60e3, 95), told(10 * 60e3, 80)], session(95), NOW), false, 'in any order');
  assert.equal(mayTell([told(10 * 60e3, 95), told(60e3, 80)], session(95), NOW), false, 'a lower telling since does not reopen the higher step');
  assert.equal(mayTell([told(60e3, 90, 'Weekly · all models'), null], session(80), NOW), true, 'another limit\'s telling does not count');
  const day = n => Array.from({ length: n }, (_, i) => told(DAY_MS - 1 - i * 60e3));
  assert.equal(mayTell(day(DAILY_MAX), session(95), NOW), false, 'twelve in the day, even for a higher step');
  assert.equal(mayTell(day(DAILY_MAX - 1), session(80), NOW), true);
  assert.equal(mayTell([...day(DAILY_MAX - 1), told(DAY_MS)], session(80), NOW), true, 'one 24 hours old no longer counts');
  assert.equal(mayTell([...day(DAILY_MAX - 1), told(DAY_MS - 1, 90, 'Weekly · all models')], session(80), NOW), true);
});
