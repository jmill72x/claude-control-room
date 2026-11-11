// The acknowledge form's logic (src/lib/orbit/acks.js). Times are built from
// local dates, so the tests hold in any time zone. Every job here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAck, untilChoices, ackBody, WEEK_MS, AFTER_NEXT_MS } from '../src/lib/orbit/acks.js';

const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime(); // November 2026, local
const NOW = at(10, 15, 0); // Tue 11-10, 3:00 PM
const cron = { text: 'friday cron Overdue · log 270 h old', kind: 'cron', key: 'cron:launchd:com.example.friday', since: at(1, 16, 45), nextRunAt: at(13, 16, 45) };
const service = { text: 'Tunnel is not running', kind: 'service', key: 'service:launchd:Tunnel', since: at(10, 12, 0) };

test('a failed job and a down service can be acked; a limit, a projection, credits and the board cannot', () => {
  assert.ok(canAck(cron));
  assert.ok(canAck(service));
  for (const kind of ['limit', 'projection', 'credits', 'board']) assert.ok(!canAck({ kind, key: `${kind}:x`, text: 'x' }), kind);
  assert.ok(!canAck({ kind: 'cron', text: 'no key' }));
  assert.ok(!canAck(null));
});

test('the choices: its next run plus 2 h when there is one, else 24 hours; and 7 days', () => {
  assert.deepEqual(untilChoices(cron, NOW), [
    { id: 'next', label: 'Until its next run (Fri 6:45 PM)', until: undefined },
    { id: 'week', label: 'For 7 days (11-17 3:00 PM)', until: NOW + WEEK_MS }
  ]);
  assert.equal(untilChoices(service, NOW)[0].label, 'For 24 hours');
  assert.equal(untilChoices({ ...cron, nextRunAt: NOW - 1 }, NOW)[0].label, 'For 24 hours', 'a next run already past is no next run');
  assert.equal(AFTER_NEXT_MS, 2 * 3600e3);
});

test('with no since there is no 7-day choice, and the default never says more than 24 hours', () => {
  const unknown = { ...cron, since: null };
  assert.deepEqual(untilChoices(unknown, NOW), [{ id: 'next', label: 'For 24 hours', until: undefined }], 'its next run is 3 days off');
  assert.deepEqual(untilChoices({ ...unknown, nextRunAt: at(10, 20, 0) }, NOW), [{ id: 'next', label: 'Until its next run (10:00 PM)', until: undefined }], 'a next run within the day keeps its label');
  assert.equal(untilChoices({ ...unknown, nextRunAt: at(11, 13, 1) }, NOW)[0].label, 'For 24 hours', 'next run + 2 h one minute past the cap');
  assert.equal(untilChoices({ ...cron, since: undefined }, NOW).length, 1);
  assert.equal(untilChoices({ ...service, since: null }, NOW).length, 1);
  assert.equal(untilChoices(service, NOW).length, 2, 'a down service with a downSince keeps both');
  assert.deepEqual(ackBody(unknown, { choice: 'week' }, NOW), { key: cron.key }, 'asking for the week falls back to the default');
});

test('the body: the key, a trimmed note when given, until for the 7-day choice only, never by', () => {
  assert.deepEqual(ackBody(cron, { note: '  mini restarted before login ', choice: 'next' }, NOW),
    { key: cron.key, note: 'mini restarted before login' });
  assert.deepEqual(ackBody(cron, { note: '', choice: 'week' }, NOW), { key: cron.key, until: NOW + WEEK_MS });
  assert.deepEqual(ackBody(cron, {}, NOW), { key: cron.key });
  assert.deepEqual(ackBody(cron, { choice: 'nonsense' }, NOW), { key: cron.key }, 'an unknown choice is the default');
  assert.equal(ackBody(cron, { note: 'n'.repeat(250) }, NOW).note.length, 200);
});
