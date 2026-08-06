import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createTodoStore } from '../todos.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-')), 'todos.json');

test('seeds on first read', async () => {
  const store = createTodoStore(tmp());
  const todos = await store.read();
  assert.ok(todos.length > 0);
  assert.ok(todos.every(t => ['idea', 'doing', 'done'].includes(t.lane)));
});

test('writes survive a reread', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'x', lane: 'idea', tag: 'Note' }]);
  assert.deepEqual(await createTodoStore(path).read(), [{ id: 1, text: 'x', lane: 'idea', tag: 'Note' }]);
});

test('rejects a non-array payload', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write({ nope: true }));
});

test('rejects an unknown lane', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write([{ id: 1, text: 'x', lane: 'nowhere' }]));
});

test('a corrupt file is preserved and reported, never silently reseeded (I6)', async () => {
  const path = tmp();
  const real = [{ id: 1, text: 'months of real backlog', lane: 'doing', tag: 'Note' }];
  await createTodoStore(path).write(real);
  // Exactly what a crash mid-write used to leave behind.
  writeFileSync(path, JSON.stringify(real).slice(0, -6));

  await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);

  const kept = readdirSync(dirname(path)).filter(f => f.includes('.corrupt-'));
  assert.equal(kept.length, 1, 'the damaged file must be kept, not overwritten with seed items');
  assert.match(readFileSync(join(dirname(path), kept[0]), 'utf8'), /real backlog/);
});

test('a file holding valid JSON that is not a list is preserved too', async () => {
  const path = tmp();
  writeFileSync(path, '{"lane":"idea"}');
  await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);
  assert.equal(readdirSync(dirname(path)).filter(f => f.includes('.corrupt-')).length, 1);
});

test('an unreadable file is reported, not treated as a first run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-'));
  // A directory where a file is expected: readFile fails with EISDIR, which is
  // not ENOENT and so must never seed.
  const path = join(dir, 'todos.json');
  mkdirSync(path);
  await assert.rejects(() => createTodoStore(path).read(), /could not read/);
});

test('a write leaves no temp file behind and is never partially visible', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'x', lane: 'idea' }]);
  await store.write([{ id: 2, text: 'y', lane: 'done' }]);
  const leftovers = readdirSync(dirname(path)).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].id, 2);
});

test('a rejected write leaves the previous list intact on disk', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'keep me', lane: 'idea' }]);
  await assert.rejects(() => store.write([{ id: 2, text: 'bad', lane: 'nowhere' }]));
  assert.equal(JSON.parse(readFileSync(path, 'utf8'))[0].text, 'keep me');
});

// N2: the aside name was `todos.json.corrupt-${Date.now()}`, and POSIX
// rename() silently replaces whatever already sits at the destination. Two
// corruptions landing in the same millisecond (plausible under test load, or
// simply two rapid writes) produce the same aside name, and the second
// "preserve" operation destroys the first. Pin Date.now() to force the
// collision deterministically rather than hoping two real calls land in the
// same millisecond.
test('two corruptions in the same millisecond leave two distinct preserved files, not one clobbering the other (N2)', async () => {
  const path = tmp();
  const realNow = Date.now;
  try {
    Date.now = () => 1735689600123;

    writeFileSync(path, '{"not":"a list"}extra-garbage-1');
    await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);

    writeFileSync(path, '{"not":"a list"}extra-garbage-2');
    await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);
  } finally {
    Date.now = realNow;
  }

  const kept = readdirSync(dirname(path)).filter(f => f.includes('.corrupt-'));
  assert.equal(kept.length, 2, `expected two distinct preserved files, got ${JSON.stringify(kept)}`);

  const contents = kept.map(f => readFileSync(join(dirname(path), f), 'utf8'));
  assert.ok(contents.some(c => c.includes('extra-garbage-1')), 'the first corrupt file must survive the second corruption');
  assert.ok(contents.some(c => c.includes('extra-garbage-2')), 'the second corrupt file must also be preserved');
});

// N3: after a corrupt file is renamed aside, `path` itself is gone — which
// looks, from read()'s point of view, exactly like a brand-new install that
// has never had a todos.json. Seeding there buries the preserved backlog
// under three invented items with nothing on screen explaining why they
// showed up. Seeding must be reserved for a genuinely first-run ENOENT.
test('a corrupt file set aside is not silently reseeded on the next read (N3)', async () => {
  const path = tmp();
  const real = [{ id: 1, text: 'irreplaceable backlog item', lane: 'doing', tag: 'Note' }];
  await createTodoStore(path).write(real);
  writeFileSync(path, JSON.stringify(real).slice(0, -6));

  await assert.rejects(() => createTodoStore(path).read(), /could not be parsed/);
  assert.equal(existsSync(path), false, 'the corrupt file must have moved aside, not stayed at path');

  // From here, path is ENOENT exactly as a first run would be. It must not
  // be silently reseeded.
  await assert.rejects(() => createTodoStore(path).read(), /corrupt/i);
  assert.equal(existsSync(path), false,
    'a silent reseed would have recreated the file at path with fabricated SEED content');
});

test('a genuinely first-run ENOENT, with no aside file present, still seeds', async () => {
  const path = tmp();
  const todos = await createTodoStore(path).read();
  assert.ok(todos.length > 0);
  assert.equal(readdirSync(dirname(path)).filter(f => f.includes('.corrupt-')).length, 0);
});
