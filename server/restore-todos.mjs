// Undo a bad board write. Every write to the board first keeps the board it
// replaces in todos-history/ (see createTodoStore in todos.mjs); this lists
// those copies and puts one back.
//
//   node server/restore-todos.mjs --list    the copies, newest first, as `<file>  <n> items`
//   node server/restore-todos.mjs <file>    keep the current board, then restore <file>
//
// <file> is a name from --list, or an absolute path inside todos-history/;
// anything outside it is refused. The restore goes through the same store the
// server writes with, so it is validated like any other write and the board it
// replaces goes into history first — a restore can itself be undone. It works
// on the file, not through PUT /api/todos, so it works with the server down
// too; a running server reads the file on every request and needs no restart.
//
// The done-lane archive (board 17924110):
//
//   node server/restore-todos.mjs --unarchive-all   every archived item back on the board
//   node server/restore-todos.mjs <pinned> --force   the board as it was before the first move
//
// --unarchive-all merges the archive into the board as it is now, so nothing made or
// changed since is lost: the way back from archiving. The copy taken before the first
// archive move is listed as `todos-pre-archive-<time>.json  <n> items  pinned` and is
// never pruned; restoring it needs --force, since every item added since leaves the
// board, and it says how many. An item a restored copy holds that has since been
// archived comes back to the board and leaves data/todos-archive.json, so no item is
// ever in both. With the archive on, an item brought back stays on the board for the
// archive's days again, counted from now; to stop new moves, set config's
// board.archiveDays to null and restart the service first.
//
// The server and this script share a lock file (todos.json.lock), so they never write
// at the same moment; while the server writes, this waits up to 10 seconds.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createTodoStore } from './todos.mjs';
import { readBoardArchiveConfig } from './lib/board-archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const args = argv.filter(a => a !== '--force');
const known = new Set(['--list', '--unarchive-all']);
if (args.length !== 1 || (args[0].startsWith('-') && !known.has(args[0])) || (force && args[0].startsWith('-'))) {
  console.error('usage: node restore-todos.mjs --list | --unarchive-all | <file> [--force]');
  process.exit(2);
}
// Whether the archive is on, to say what happens to items brought back. Config is only
// read here, never written; an unreadable one just leaves the note out.
const archiveNote = async () => {
  try {
    const settings = readBoardArchiveConfig(JSON.parse(await readFile(join(HERE, 'config.json'), 'utf8')));
    return settings.on
      ? `the archive is on (${settings.days} days): items brought back move out again ${settings.days} days from now unless board.archiveDays is set to null and the service restarted`
      : null;
  } catch {
    return null;
  }
};

const store = createTodoStore(join(HERE, 'todos.json'), { archivePath: join(HERE, 'data', 'todos-archive.json') });
try {
  if (args[0] === '--list') {
    const copies = await store.copies();
    // To stderr, so stdout is nothing but the list.
    if (copies.length === 0) console.error('no copies yet: the first write over an existing board makes one');
    for (const c of copies) {
      const pinned = c.pinned ? '  pinned' : '';
      console.log(c.error ? `${c.file}  unreadable: ${c.error}${pinned}` : `${c.file}  ${c.items} items${pinned}`);
    }
  } else if (args[0] === '--unarchive-all') {
    const { returned, alreadyOnBoard, todos } = await store.unarchiveAll();
    console.log(`brought ${returned.length} item${returned.length === 1 ? '' : 's'} back from the archive; the board has ${todos.length}` +
      (alreadyOnBoard ? `; ${alreadyOnBoard} archived item${alreadyOnBoard === 1 ? ' was' : 's were'} on the board already, and the board's copy was kept` : ''));
    const note = await archiveNote();
    if (note && returned.length > 0) console.error(note);
  } else {
    const { file, items, unarchived, lacking } = await store.restore(args[0], { force });
    console.log(`restored ${file}  ${items} items${unarchived ? `, ${unarchived} of them back from the archive` : ''}` +
      (lacking !== undefined ? `; ${lacking} item${lacking === 1 ? '' : 's'} the board had and this copy lacked left the board (the board before the restore is in todos-history)` : ''));
    const note = await archiveNote();
    if (note && unarchived) console.error(note);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
