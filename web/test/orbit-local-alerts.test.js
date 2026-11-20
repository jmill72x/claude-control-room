// A local script's alert on the page (server/lib/local-alerts.mjs; board 5f892918): the
// strip's words, the Needs you card, the ack and the "Bring Jarvis Back" button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalAlert, localChip, localWhat, localMeta, stripText } from '../src/lib/orbit/local-alerts.js';
import { RECOVER_WHAT } from '../src/lib/orbit/recover.js';
import { alertCards, waitingCards } from '../src/lib/orbit/waiting.js';
import { isLeadDownAlert } from '../src/lib/orbit/runbook.js';
import { canAck, untilChoices, ackBody } from '../src/lib/orbit/acks.js';
import { clock } from '../src/lib/orbit/page.js';

const T0 = new Date(2026, 10, 19, 14, 5).getTime();
const SERVICES = [{ key: 'session:Jarvis', kind: 'session', name: 'Jarvis', state: 'up' }];
const local = (extra = {}) => ({
  text: 'Jarvis failed to start', kind: 'local', key: 'local:a1b2c3', since: T0, at: T0,
  severity: 'critical', about: 'jarvis-down', body: 'The bot token is missing.\nSee the start log.', ...extra
});

test('a local alert is told by its kind alone', () => {
  assert.equal(isLocalAlert(local()), true);
  assert.equal(isLocalAlert({ ...local(), kind: 'service' }), false);
  assert.equal(isLocalAlert(null), false);
});

test('the strip adds the time a local alert was raised; any other alert keeps its words', () => {
  assert.equal(stripText(local()), `Jarvis failed to start · ${clock(T0)}`);
  assert.equal(stripText(local()), 'Jarvis failed to start · 2:05 PM');
  assert.equal(stripText({ ...local(), at: undefined }), 'Jarvis failed to start');
  assert.equal(stripText({ text: 'Tunnel is not running', kind: 'service', key: 'service:launchd:Tunnel', at: T0 }), 'Tunnel is not running');
  assert.equal(stripText(null), '');
});

test('the card\'s chip says Jarvis down for the lead\'s start script, else the severity', () => {
  assert.equal(localChip(local()), 'Jarvis down');
  assert.equal(localChip(local({ about: 'other', severity: 'critical' })), 'Critical');
  assert.equal(localChip(local({ about: 'other', severity: 'warning' })), 'Warning');
  assert.equal(localChip(local({ about: 'other', severity: 'info' })), 'Notice');
  assert.equal(localChip(local({ about: 'other', severity: 'odd' })), 'Alert');
});

test('the card\'s text is the body, then how to put it away; an empty body leaves the second part', () => {
  // A "jarvis-down" alert says how to bring him back between the two (board 98a30b15).
  assert.equal(localWhat(local()), `The bot token is missing.\nSee the start log.\n\n${RECOVER_WHAT}\n\nOnce it is handled, acknowledge it; it leaves on its own 24 hours after it was raised.`);
  assert.equal(localWhat(local({ body: '  ' })), `${RECOVER_WHAT}\n\nOnce it is handled, acknowledge it; it leaves on its own 24 hours after it was raised.`);
  assert.equal(localWhat(local({ about: 'other' })), 'The bot token is missing.\nSee the start log.\n\nOnce it is handled, acknowledge it; it leaves on its own 24 hours after it was raised.');
  assert.equal(localWhat(local({ about: 'other', body: '  ' })), 'Once it is handled, acknowledge it; it leaves on its own 24 hours after it was raised.');
  assert.equal(localWhat(local({ about: 'other', body: undefined })), 'Once it is handled, acknowledge it; it leaves on its own 24 hours after it was raised.');
  assert.equal(localMeta(local()), 'a local script · raised 2:05 PM');
});

test('Needs you: a local alert is a card in Alerts with its chip, body (kept in lines), time and Acknowledge', () => {
  const { cards } = alertCards({ alerts: [local(), { text: 'Tunnel is not running', kind: 'service', key: 'service:launchd:Tunnel', since: T0 }], acked: [], needsYou: [], now: T0 });
  assert.equal(cards.length, 2);
  const [card, service] = cards;
  assert.deepEqual(card, {
    key: 'alert:local:a1b2c3', group: 'alerts', look: 'alert', chip: 'Jarvis down', title: 'Jarvis failed to start',
    what: localWhat(local()), preLine: true, why: null, owner: null, fallback: '!', meta: 'a local script · raised 2:05 PM',
    itemId: null, alert: local()
  });
  assert.equal(service.chip, 'Service down');
  assert.equal(service.preLine, undefined, 'other cards keep the usual text');
  // It counts on the Alerts tile like any other.
  const all = waitingCards({ items: [], today: '2026-11-19', roster: null, toPushEnv: null, alerts: [local()], now: T0 });
  assert.equal(all.alerts.length, 1);
});

test('"Bring Jarvis Back" goes on a jarvis-down local alert only, whatever the health panel says', () => {
  assert.equal(isLeadDownAlert(local(), SERVICES, 'Jarvis'), true);
  assert.equal(isLeadDownAlert(local(), null, 'Jarvis'), true);
  assert.equal(isLeadDownAlert(local({ about: 'other' }), SERVICES, 'Jarvis'), false);
  assert.equal(isLeadDownAlert(local({ about: undefined }), SERVICES, 'Jarvis'), false);
  // A local alert keyed like the lead's service alert is still told by `about`.
  assert.equal(isLeadDownAlert(local({ about: 'other', key: 'service:session:Jarvis' }), SERVICES, 'Jarvis'), false);
});

test('a local alert can be acknowledged, for 24 hours only (it leaves on its own then)', () => {
  assert.equal(canAck(local()), true);
  const choices = untilChoices(local(), T0 + 60e3);
  assert.deepEqual(choices.map(c => [c.id, c.label, c.until]), [['next', 'For 24 hours', undefined]]);
  assert.deepEqual(ackBody(local(), { note: ' handled ', choice: 'week' }, T0), { key: 'local:a1b2c3', note: 'handled' });
  // A down service with a known start still gets its 7 days.
  assert.equal(untilChoices({ kind: 'service', key: 'service:launchd:Tunnel', since: T0 }, T0 + 60e3).length, 2);
});
