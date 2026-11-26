// The Board tab's archive view and the Added line (board 17924110): plain functions
// in src/lib/orbit/board.js. All items are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveView, archivedLine, archiveNote, addedLine, shortDate, joinArchivePage, ARCHIVE_SHOWN } from '../src/lib/orbit/board.js';

const NOW = new Date('2026-11-25T17:00:00.000Z');

test('shortDate: weekday and month-day on the viewer\'s clock, the year only when it is not this one', () => {
  const d = new Date(2026, 10, 5, 10, 0); // a local time, so the test holds in any zone
  assert.equal(shortDate(d.toISOString(), NOW), 'Thu 11-05');
  const old = new Date(2025, 11, 31, 10, 0);
  assert.equal(shortDate(old.toISOString(), NOW), 'Wed 2025-12-31');
  for (const bad of [null, undefined, '', 'soon']) assert.equal(shortDate(bad, NOW), null);
});

test('archiveView: newest finished first, undated last (newest added first); more while the archive holds more', () => {
  const items = [
    { id: 'u1', text: 'undated, archived first' },
    { id: 'a', text: 'a', doneAt: '2026-11-01T10:00:00.000Z' },
    { id: 'b', text: 'b', doneAt: '2026-11-09T10:00:00.000Z' },
    { id: 'u2', text: 'undated, archived later' }
  ];
  assert.deepEqual(archiveView(items).shown.map(t => t.id), ['b', 'a', 'u2', 'u1']);
  // One page loaded of a bigger archive: shown as loaded, more to come.
  const page = Array.from({ length: ARCHIVE_SHOWN }, (_, i) => ({ id: i, text: `${i}`, doneAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }));
  const v = archiveView(page, { total: ARCHIVE_SHOWN + 5 });
  assert.equal(v.shown.length, ARCHIVE_SHOWN);
  assert.equal(v.total, ARCHIVE_SHOWN + 5);
  assert.equal(v.more, true);
  assert.equal(v.shown[0].id, ARCHIVE_SHOWN - 1, 'the newest first');
  assert.equal(archiveView(page, { total: ARCHIVE_SHOWN }).more, false);
  assert.equal(archiveView(page).more, false, 'no total: what is loaded is all');
  assert.deepEqual(archiveView(null), { shown: [], total: 0, more: false });
});

test('archivedLine says when it was finished and archived, and plainly when the date is unknown', () => {
  const done = new Date(2026, 10, 5, 9).toISOString();
  const moved = new Date(2026, 10, 25, 9).toISOString();
  assert.equal(archivedLine({ doneAt: done, archivedAt: moved }, NOW), 'Done Thu 11-05 · archived Wed 11-25');
  assert.equal(archivedLine({ archivedAt: moved }, NOW), 'Done before dates were kept · archived Wed 11-25');
});

test('archiveNote names the days, or says archiving is off', () => {
  assert.equal(archiveNote(14, 3), '3 archived items. Done items move here 14 days after they are finished, to keep the board small enough to save.');
  assert.equal(archiveNote(1, 1), '1 archived item. Done items move here 1 day after they are finished, to keep the board small enough to save.');
  assert.equal(archiveNote(null, 0), 'Nothing is archived. Archiving is off, so nothing new moves here.');
});

test('addedLine: the date, "before dates were kept" for null, nothing when the server has not stamped it yet', () => {
  assert.equal(addedLine({ createdAt: new Date(2026, 10, 5, 9).toISOString() }, NOW), 'Added Thu 11-05');
  assert.equal(addedLine({ createdAt: null }, NOW), 'Added before dates were kept');
  assert.equal(addedLine({}, NOW), null);
  assert.equal(addedLine(null, NOW), null);
});

test('joinArchivePage: a changed total reloads from the start; otherwise the page joins, less ids already loaded', () => {
  const loaded = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(joinArchivePage(loaded, { total: 5, items: [{ id: 'c' }] }, 4), { reload: true }, 'a move or a Bring back in between');
  assert.deepEqual(joinArchivePage(loaded, { total: 3, items: [{ id: 'c' }] }, 4), { reload: true });
  assert.deepEqual(joinArchivePage(loaded, { items: [{ id: 'c' }] }, 4), { reload: true }, 'no total: read again');
  const joined = joinArchivePage(loaded, { total: 4, items: [{ id: 'b' }, { id: 'c' }, { id: 1 }] }, 4);
  assert.equal(joined.reload, false);
  assert.deepEqual(joined.items.map(t => t.id), ['a', 'b', 'c', 1], 'b is not shown twice');
  assert.deepEqual(joinArchivePage([{ id: 1 }], { total: 2, items: [{ id: '1' }, { id: 2 }] }, 2).items.map(t => t.id), [1, 2], 'ids compared as text, as the page does');
});
