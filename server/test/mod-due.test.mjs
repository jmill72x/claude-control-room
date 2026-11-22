// The mod's due dates (mod/hooks/model.js) against the two copies they mirror:
// the server's isDueDate (todos.mjs), which decides what a board may hold, and
// the page's dueChip (web/src/lib/due.js), which decides what a card says. The
// mod's own tests run only inside Claude Code's mod harness; model.js imports
// nothing, so it runs here beside the server's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDueDate as serverIsDueDate } from '../todos.mjs';
import { dueChip as pageDueChip } from '../../web/src/lib/due.js';
import { isDueDate, readDue, withDue, dueChip, localToday, ADD_DUE_WORDS } from '../../mod/hooks/model.js';

const iso = ms => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;

test('the mod takes exactly the due dates the server takes', () => {
  const odd = [
    '', ' ', '2026-11-25 ', ' 2026-11-25', '2026-11-25T00:00', '2026-11-5', '2026-1-05', '26-11-25',
    '2026/11/25', '20261125', '2026-11-25\n', '\uff12\uff10\uff12\uff16-11-25', '0000-01-01', '9999-12-31',
    '2026-00-10', '2026-13-01', '2026-02-29', '2028-02-29', '1900-02-29', '2000-02-29', '2026-04-31',
    '2026-06-31', '2026-12-32', '2026-12-00', null, undefined, 20261125, {}, ['2026-11-25']
  ];
  for (const v of odd) assert.equal(isDueDate(v), serverIsDueDate(v), JSON.stringify(v));
  // Every month and day number from 00 to 13 and 00 to 32, over a leap year,
  // a plain year and a century year that is not a leap year.
  let taken = 0;
  for (const y of ['2024', '2026', '2100']) {
    for (let m = 0; m <= 13; m++) {
      for (let d = 0; d <= 32; d++) {
        const v = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        assert.equal(isDueDate(v), serverIsDueDate(v), v);
        if (isDueDate(v)) taken++;
      }
    }
  }
  assert.equal(taken, 366 + 365 + 365);
});

test('a typed date is trimmed, an empty one clears, anything else is refused with the reason', () => {
  assert.deepEqual(readDue(' 2026-11-25 '), { due: '2026-11-25' });
  assert.deepEqual(readDue(''), { due: '' });
  assert.deepEqual(readDue('   '), { due: '' });
  assert.deepEqual(readDue(undefined), { due: '' });
  const bad = readDue('2026-02-30');
  assert.equal(bad.due, undefined);
  assert.match(bad.error, /^Not saved: a due date is written YYYY-MM-DD/);
  assert.ok(bad.error.includes('"2026-02-30"'));
  // A long paste is cut in the message, not echoed whole.
  assert.ok(readDue('x'.repeat(500)).error.length < 160);
});

test('Add an idea reads its date with the same check as Set due, worded for a new idea', () => {
  for (const v of ['', '  ', ' 2026-11-25 ', '2026-11-25', '2026-02-30', '2028-02-29', '2026-13-01', '11/25', 'tomorrow', undefined]) {
    const set = readDue(v);
    const add = readDue(v, ADD_DUE_WORDS);
    assert.equal(add.due, set.due, JSON.stringify(v));
    assert.equal(Boolean(add.error), Boolean(set.error), JSON.stringify(v));
  }
  // Every date the server takes, and only those, over a leap year.
  for (let m = 0; m <= 13; m++) {
    for (let d = 0; d <= 32; d++) {
      const v = `2028-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      assert.equal(readDue(v, ADD_DUE_WORDS).due === v, serverIsDueDate(v), v);
    }
  }
  const bad = readDue('2026-02-30', ADD_DUE_WORDS).error;
  assert.match(bad, /^Not added: a due date is written YYYY-MM-DD, such as 2026-11-25, or left empty for no date \(got "2026-02-30"\)$/);
});

test('withDue sets a date and clearing drops the key, as the page writes it', () => {
  assert.deepEqual(withDue({ id: 'a', due: '2026-01-01' }, '2026-11-25'), { id: 'a', due: '2026-11-25' });
  assert.deepEqual(withDue({ id: 'a', due: '2026-01-01' }, ''), { id: 'a' });
  assert.ok(!('due' in withDue({ id: 'a' }, '')));
});

test('the mod\'s due chip says what the page\'s says, every day for two years either side of today', () => {
  const today = '2026-11-21';
  const base = Date.parse(`${today}T00:00:00Z`);
  for (let n = -730; n <= 730; n++) {
    const due = iso(base + n * DAY);
    for (const lane of ['idea', 'doing', 'done']) {
      const page = pageDueChip(due, lane, today);
      const mod = dueChip(due, lane, today);
      assert.deepEqual(mod, { label: page.label, state: page.state }, `${due} ${lane}`);
    }
  }
  for (const v of [undefined, '', 'soon', '2026-11-5']) assert.equal(dueChip(v, 'idea', today), null);
});

test('today is the local calendar date of the clock the mod is given', () => {
  const now = new Date(2026, 10, 21, 23, 59).getTime();
  assert.equal(localToday(now), '2026-11-21');
  assert.equal(localToday(new Date(2026, 0, 1, 0, 0).getTime()), '2026-01-01');
});
