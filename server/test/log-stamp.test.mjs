import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp } from '../lib/log-stamp.mjs';
import { installLogStamps } from '../lib/log-stamp.mjs';

const fakeConsole = () => {
  const lines = [];
  const c = {};
  for (const level of ['log', 'info', 'warn', 'error']) c[level] = (...args) => lines.push([level, ...args]);
  return { c, lines };
};

test('every level starts with the UTC time of the call', () => {
  const { c, lines } = fakeConsole();
  const at = Date.UTC(2026, 9, 2, 13, 4, 5, 6);
  installLogStamps(c, () => at);
  c.log('control room on http://127.0.0.1:8322');
  c.error('watchdog: 3 failed self-checks');
  c.warn('w');
  c.info('i');
  assert.deepEqual(lines.map(l => l[1]), Array(4).fill('2026-10-02T13:04:05.006Z'));
  assert.equal(lines[0][2], 'control room on http://127.0.0.1:8322');
  assert.equal(lines[1][0], 'error');
});

test('an Error passes through untouched, so its stack still prints', () => {
  const { c, lines } = fakeConsole();
  installLogStamps(c, () => 0);
  const err = new Error('boom');
  c.error('request failed', err);
  assert.equal(lines[0][3], err);
});

test('installing twice stamps once', () => {
  const { c, lines } = fakeConsole();
  installLogStamps(c, () => 0);
  installLogStamps(c, () => 0);
  c.log('x');
  assert.equal(lines[0].length, 3);
});

test('stamp is ISO 8601 in UTC', () => {
  assert.equal(stamp(0), '1970-01-01T00:00:00.000Z');
});

test('stampLines stamps each non-empty line of a block and keeps its newlines', async () => {
  const { stampLines } = await import('../lib/log-stamp.mjs');
  assert.equal(
    stampLines('[discord] posted 1 message(s) to #pepper\nsecond\n', 0),
    '1970-01-01T00:00:00.000Z [discord] posted 1 message(s) to #pepper\n1970-01-01T00:00:00.000Z second\n'
  );
  assert.equal(stampLines('', 0), '');
  assert.equal(stampLines(undefined, 0), '');
});
