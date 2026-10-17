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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTodoStore } from './todos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
if (args.length !== 1 || (args[0].startsWith('-') && args[0] !== '--list')) {
  console.error('usage: node restore-todos.mjs --list | <file>');
  process.exit(2);
}

const store = createTodoStore(join(HERE, 'todos.json'));
try {
  if (args[0] === '--list') {
    const copies = await store.copies();
    // To stderr, so stdout is nothing but the list.
    if (copies.length === 0) console.error('no copies yet: the first write over an existing board makes one');
    for (const c of copies) {
      console.log(c.error ? `${c.file}  unreadable: ${c.error}` : `${c.file}  ${c.items} items`);
    }
  } else {
    const { file, items } = await store.restore(args[0]);
    console.log(`restored ${file}  ${items} items`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
