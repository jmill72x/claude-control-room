// What the done-lane archive (board 17924110) would move, without moving anything.
//
//   node server/archive-preview.mjs --days 14
//   node server/archive-preview.mjs --days 14 --file /path/to/a/copy.json
//
// It reads the board file (server/todos.json, or --file) and prints counts and sizes
// only, never an item's text: how many Done items are 14 or more days old by the
// archive's clock (todos.mjs, archiveClock), how many of those have no doneAt, and
// the save body before and after against the 1 MiB limit. It writes nothing: the move
// itself runs only inside the server, under the board's lock (config's
// board.archiveDays).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickArchivable, BOARD_MAX_BODY } from './todos.mjs';
import { ARCHIVE_DAYS_MAX } from './lib/board-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function preview(list, { days, now = Date.now() }) {
  const going = pickArchivable(list, { days, now });
  const ids = new Set(going.map(t => t.id));
  const stay = list.filter(t => !ids.has(t.id));
  const body = l => Buffer.byteLength(JSON.stringify(l));
  return {
    items: list.length,
    done: list.filter(t => t?.lane === 'done').length,
    moving: going.length,
    undated: going.filter(t => !t.doneAt).length,
    before: body(list),
    after: body(stay),
    cap: BOARD_MAX_BODY
  };
}

const pct = (n, cap) => `${Math.round((n / cap) * 100)}%`;
const kb = n => `${Math.round(n / 1024)} KB`;

export function previewLines(p, days) {
  return [
    `${p.moving} of ${p.done} done items are ${days} or more days old (${p.undated} of them finished before doneAt existed)`,
    `save body ${kb(p.before)} (${pct(p.before, p.cap)} of the limit) -> ${kb(p.after)} (${pct(p.after, p.cap)}); ${p.items - p.moving} items stay on the board`
  ];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const at = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const days = Number(at('--days'));
  const file = at('--file') ?? join(HERE, 'todos.json');
  if (!Number.isInteger(days) || days < 1 || days > ARCHIVE_DAYS_MAX) {
    console.error(`usage: node archive-preview.mjs --days N [--file board.json]   (N from 1 to ${ARCHIVE_DAYS_MAX})`);
    process.exit(2);
  }
  try {
    const list = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('the file does not contain a list');
    for (const line of previewLines(preview(list, { days }), days)) console.log(line);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
