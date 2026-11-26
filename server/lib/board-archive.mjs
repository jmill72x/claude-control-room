// The done-lane archive's setting and its timer (board 17924110). The move itself is
// the store's (todos.mjs, archiveDone): it runs in the same queue as every PUT, so it
// never interleaves with a save, and it changes the board's revision like any write.
//
// config.json:
//   "board": { "archiveDays": 14 }   Done items finished 14 or more days ago move out
//   no "board" block, or null        off: nothing is ever moved (the default)
//
// Off by default, so archiving starts only when Jeff picks it over a higher save limit.

export const ARCHIVE_DAYS_MAX = 365;
// The first run waits a little after a start, then one an hour: an item crosses its
// day at most an hour late, and a busy board (one written in the last two minutes,
// ARCHIVE_QUIET_MS) is simply tried again next hour.
export const ARCHIVE_FIRST_MS = 2 * 60 * 1000;
export const ARCHIVE_EVERY_MS = 60 * 60 * 1000;
// How many ids one restore may name: a page tap names one, and a script that wants
// more makes more calls.
export const RESTORE_MAX_IDS = 50;

import { ARCHIVE_WARN_BYTES } from '../todos.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readBoardArchiveConfig(config) {
  const problems = [];
  const off = state => ({ on: false, state, days: null, problems });
  const raw = config?.board;
  if (raw === undefined || raw === null) return off('unset');
  if (!isObject(raw)) {
    problems.push('board is not an object; the done-lane archive stays off');
    return off('off');
  }
  for (const k of Object.keys(raw)) if (k !== 'archiveDays') problems.push(`board.${k} is not a setting (only "archiveDays"); it is ignored`);
  const days = raw.archiveDays;
  if (days === undefined || days === null) return off('off');
  if (!Number.isInteger(days) || days < 1 || days > ARCHIVE_DAYS_MAX) {
    problems.push(`board.archiveDays must be a whole number of days from 1 to ${ARCHIVE_DAYS_MAX}, or null for off; the done-lane archive stays off`);
    return off('off');
  }
  return { on: true, state: 'on', days, problems };
}

const kb = n => `${Math.round(n / 1024)} KB`;

// The log line for a move that took something. Counts and sizes only: no item text.
export function archiveLogLine(result, days) {
  const n = result.moved;
  return `board: archived ${n} done item${n === 1 ? '' : 's'} finished ${days} or more days ago` +
    ` (board file ${kb(result.before)} -> ${kb(result.after)}; the archive holds ${result.archived})` +
    (result.first ? '; the board before this first move is kept in todos-history/ as todos-pre-archive-*.json' : '');
}

// Runs the move on a timer. `status()` is what the board panel shows: whether it is
// on, its days, and the last run's outcome.
export function createArchiveSweeper({
  store, days, log = console.log, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
  firstMs = ARCHIVE_FIRST_MS, everyMs = ARCHIVE_EVERY_MS
}) {
  let timer = null;
  let running = null;
  let last = null;
  let failing = false;

  const run = async () => {
    if (running) return running;
    running = (async () => {
      const at = now();
      try {
        const result = await store.archiveDone({ days, now: at });
        last = { at, moved: result.moved, ...(result.held ? { held: result.held } : {}) };
        if (result.moved > 0) log(archiveLogLine(result, days));
        // Said on each move past it (Ultron L5): the file is read whole on every move.
        if (result.moved > 0 && result.archiveBytes > ARCHIVE_WARN_BYTES) {
          log(`board: the archive file is ${Math.round(result.archiveBytes / (1024 * 1024))} MB, over ${ARCHIVE_WARN_BYTES / (1024 * 1024)} MB; it is read whole on every move and bring-back`);
        }
        if (failing) log('board: the archive move works again');
        failing = false;
      } catch (err) {
        last = { at, moved: 0, error: err?.message ?? String(err) };
        // Said once per failing spell, not every hour.
        if (!failing) log(`board: the archive move failed, nothing was moved (${last.error})`);
        failing = true;
      }
      return last;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  };

  const schedule = ms => {
    timer = setTimer(async () => {
      await run();
      if (timer !== null) schedule(everyMs);
    }, ms);
    timer?.unref?.();
  };

  return {
    run,
    start() {
      if (timer === null) schedule(firstMs);
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    // For the dashboard payload, which every paired device reads: no error text (it
    // can name a path), only that the last run failed. The log has the words.
    status() {
      if (!last) return { on: true, days, last: null };
      const { error, ...rest } = last;
      return { on: true, days, last: error ? { ...rest, failed: true } : rest };
    }
  };
}
