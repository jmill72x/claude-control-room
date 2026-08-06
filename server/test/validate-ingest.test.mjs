import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIngest } from '../lib/validate-ingest.mjs';

test('crons must be an array of named objects', () => {
  assert.equal(validateIngest('crons', 'a string').ok, false);
  assert.equal(validateIngest('crons', { name: 'x' }).ok, false);
  assert.equal(validateIngest('crons', [null]).ok, false);
  assert.equal(validateIngest('crons', [{ ok: true }]).ok, false, 'a cron with no name is unrenderable');
  assert.equal(validateIngest('crons', [{ name: '   ' }]).ok, false);
});

test('a valid cron is normalised without inventing an ok state', () => {
  const r = validateIngest('crons', [{ name: 'nightly-digest' }]);
  assert.equal(r.ok, true);
  assert.equal(r.value[0].name, 'nightly-digest');
  assert.equal(r.value[0].ok, undefined, 'a feed that did not report a result must not be shown as passing');
  assert.equal(r.value[0].nextRunAt, null);
});

test('cron field types are enforced', () => {
  assert.equal(validateIngest('crons', [{ name: 'x', ok: 'true' }]).ok, false);
  assert.equal(validateIngest('crons', [{ name: 'x', nextRunAt: 'soon' }]).ok, false);
  assert.equal(validateIngest('crons', [{ name: 'x', ok: false, last: 'Failed · 1' }]).ok, true);
});

test('unknown fields are dropped rather than reaching the page', () => {
  const r = validateIngest('crons', [{ name: 'x', evil: '<script>', pct: 99 }]);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value[0]).sort(), ['label', 'last', 'name', 'nextRunAt', 'ok', 'schedule']);
  assert.equal(r.value[0].evil, undefined);
});

test('an absurd number of entries is refused', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}` }));
  assert.equal(validateIngest('crons', many).ok, false);
});

test('projects must be an array of named objects and keep running tri-state', () => {
  assert.equal(validateIngest('projects', {}).ok, false);
  assert.equal(validateIngest('projects', [{ tool: 'Cloud' }]).ok, false);
  const r = validateIngest('projects', [{ name: 'atlas', running: true }]);
  assert.equal(r.ok, true);
  assert.equal(r.value[0].running, true);
  assert.equal(validateIngest('projects', [{ name: 'atlas' }]).value[0].running, undefined);
});

test('credits must be an object of numbers and dates', () => {
  assert.equal(validateIngest('credits', []).ok, false);
  assert.equal(validateIngest('credits', 'nope').ok, false);
  assert.equal(validateIngest('credits', {}).ok, false, 'an empty object carries no fact');
  assert.equal(validateIngest('credits', { balance: '12' }).ok, false);
  assert.equal(validateIngest('credits', { resetsOn: 'someday' }).ok, false);
  const r = validateIngest('credits', { balance: 10, spent: 2, monthlyLimit: 20, updatedAt: '2026-08-01' });
  assert.equal(r.ok, true);
  assert.equal(r.value.balance, 10);
});

test('an unknown feed name is refused', () => {
  assert.equal(validateIngest('secrets', {}).ok, false);
});
