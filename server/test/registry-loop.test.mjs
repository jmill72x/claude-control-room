// The registry's `then` (collectors/registry.mjs) starts one collector right after
// another. A `then` that leads back to its own collector would run the two back to
// back with no timer between them, for good (board b468ff61). Such a link is refused
// when it is registered: the collector stays, the link goes, the log says so. The
// `then` itself is tested in registry.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createRegistry } from '../collectors/registry.mjs';

const fakeTimers = () => {
  const jobs = [];
  return { jobs, setInterval: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; }, clearInterval: () => {} };
};
// Long enough for any chain here to run out, or for a loop to run far past its limit.
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
// A registry whose collectors count their runs. A run past `LIMIT` throws, so a loop
// that got through ends the test instead of hanging it.
const LIMIT = 10;
const setup = () => {
  const runs = {};
  const lines = [];
  const timers = fakeTimers();
  const cache = createCache();
  const r = createRegistry(cache, timers, { log: line => lines.push(line) });
  const add = (name, then) => r.register(name, async () => {
    runs[name] = (runs[name] ?? 0) + 1;
    if (runs[name] > LIMIT) throw new Error(`${name} ran ${runs[name]} times`);
    return runs[name];
  }, 1000, then === undefined ? undefined : { then });
  return { r, runs, lines, timers, cache, add };
};

test('a collector that names itself runs once, not for good', async () => {
  const { r, runs, lines, add } = setup();
  add('usage', 'usage');
  assert.deepEqual(lines, ['registry: usage then usage would loop (usage > usage); registered without it']);
  await r.runOnce('usage');
  await settle();
  assert.deepEqual(runs, { usage: 1 });
});

test('two that name each other: the link that closes the loop is refused, in either order, and the first still works', async () => {
  for (const [first, second] of [['usage', 'notifier'], ['notifier', 'usage']]) {
    const { r, runs, lines, add } = setup();
    add(first, second);
    assert.deepEqual(lines, [], 'nothing wrong yet: the other is not registered');
    add(second, first);
    assert.deepEqual(lines, [`registry: ${second} then ${first} would loop (${second} > ${first} > ${second}); registered without it`]);
    await r.runOnce(first);
    await settle();
    assert.deepEqual(runs, { [first]: 1, [second]: 1 }, 'the first link is kept');
    await r.runOnce(second);
    await settle();
    assert.deepEqual(runs, { [first]: 1, [second]: 2 }, 'the refused one starts nothing');
  }
});

test('a loop through three is caught at its last link, whichever that is', async () => {
  const links = [['a', 'b'], ['b', 'c'], ['c', 'a']];
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1]]) {
    const { r, runs, lines, add } = setup();
    for (const i of order) add(...links[i]);
    const [name, then] = links[order[2]];
    const chain = { a: 'a > b > c > a', b: 'b > c > a > b', c: 'c > a > b > c' }[name];
    assert.deepEqual(lines, [`registry: ${name} then ${then} would loop (${chain}); registered without it`], order.join());
    for (const start of ['a', 'b', 'c']) await r.runOnce(start);
    await settle();
    assert.ok(Object.values(runs).every(n => n <= 3), `${order.join()}: ${JSON.stringify(runs)}`);
    // Two links are left, so a run of the chain's head reaches its end and stops there.
    assert.equal(Object.values(runs).reduce((a, b) => a + b, 0), 6, `${order.join()}: 3 + 2 + 1 runs`);
  }
});

test('a chain that ends is not a loop: every link is kept and nothing is logged', async () => {
  const { r, runs, lines, add } = setup();
  add('a', 'b');
  add('b', 'c');
  add('c');
  add('d', 'c');
  add('e', 'nobody');
  await r.runOnce('a');
  await settle();
  assert.deepEqual(runs, { a: 1, b: 1, c: 1 });
  await r.runOnce('d');
  await r.runOnce('e');
  await settle();
  assert.deepEqual(runs, { a: 1, b: 1, c: 2, d: 1, e: 1 });
  assert.deepEqual(lines, []);
});

test('registering a name again is judged by its new link, against the links that stand', async () => {
  const { r, runs, lines, add } = setup();
  add('a', 'b');
  add('b');
  add('b', 'a');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^registry: b then a would loop \(b > a > b\)/);
  // With a's link gone, b's is no loop any more.
  add('a');
  add('b', 'a');
  assert.equal(lines.length, 1, 'accepted this time');
  await r.runOnce('b');
  await settle();
  assert.deepEqual(runs, { b: 1, a: 1 });
  // And now a's old link would close it from the other side.
  add('a', 'b');
  assert.match(lines[1], /^registry: a then b would loop \(a > b > a\)/);
  await r.runOnce('a');
  await settle();
  assert.deepEqual(runs, { b: 1, a: 2 });
});

test('no `then`, in each way of giving none, is no loop and no line', async () => {
  const { r, lines, runs, add } = setup();
  r.register('a', async () => 1, 1000);
  r.register('b', async () => 1, 1000, {});
  r.register('c', async () => 1, 1000, { then: null });
  r.register('d', async () => 1, 1000, { then: undefined });
  add('e', '');
  await r.runOnce('e');
  await settle();
  assert.deepEqual(runs, { e: 1 });
  assert.deepEqual(lines, []);
});

test('a collector whose link was refused is a collector all the same: its timer, its first pass, its cache budget', async () => {
  const { r, runs, lines, timers, cache, add } = setup();
  add('usage', 'notifier');
  add('notifier', 'usage');
  assert.equal(lines.length, 1);
  r.startAll();
  assert.deepEqual(await r.whenFirstPass(), { failed: [] });
  await settle();
  // startAll ran each once, and usage's kept link asked for one more notifier run.
  assert.deepEqual(runs, { usage: 1, notifier: 2 });
  assert.deepEqual(timers.jobs.map(j => j.ms), [1000, 1000]);
  await timers.jobs[1].fn();
  await settle();
  assert.deepEqual(runs, { usage: 1, notifier: 3 }, 'the notifier\'s own tick starts no usage poll');
  assert.equal(cache.get('notifier', Date.now()).status, 'ok');
});

test('the log is console.error unless one is given, and the server\'s own registrations hold no loop', async t => {
  const said = [];
  t.mock.method(console, 'error', line => said.push(line));
  const r = createRegistry(createCache(), fakeTimers());
  r.register('a', async () => 1, 1000, { then: 'a' });
  assert.deepEqual(said, ['registry: a then a would loop (a > a); registered without it']);
  // server.mjs as written: every `then` it registers, followed to its end.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const links = new Map([...src.matchAll(/\bthen: '([a-zA-Z]+)'/g)].map(m => {
    const before = src.slice(0, m.index);
    return [before.slice(before.lastIndexOf("registry.register('")).match(/^registry\.register\('([a-zA-Z]+)'/)[1], m[1]];
  }));
  assert.deepEqual([...links], [['usage', 'notifier']]);
  for (const start of links.keys()) {
    const seen = new Set([start]);
    for (let next = links.get(start); next; next = links.get(next)) {
      assert.ok(!seen.has(next), `${start} leads back to ${next}`);
      seen.add(next);
    }
  }
});
