import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ccr-config-'));

test('a real config is marked present', async () => {
  const path = join(dir(), 'config.json');
  writeFileSync(path, JSON.stringify({ plan: { name: 'Max' }, warnThreshold: 90 }));
  const config = await loadConfig(path);
  assert.equal(config.present, true);
  assert.equal(config.error, null);
  assert.equal(config.warnThreshold, 90);
  assert.equal(config.plan.name, 'Max');
});

// M2: the route hardcoded status 'ok' for config, so with no file the plan and
// credits panels rendered nothing under their labels and said nothing about why.
test('a missing config is marked absent with a reason, not silently defaulted', async () => {
  const config = await loadConfig(join(dir(), 'nope.json'));
  assert.equal(config.present, false);
  assert.match(config.error, /no config\.json/);
  assert.equal(config.plan, null);
  assert.equal(config.warnThreshold, 85, 'the alert threshold still needs a working default');
});

test('an unparseable config is absent and says so distinctly from a missing one', async () => {
  const path = join(dir(), 'config.json');
  writeFileSync(path, '{ truncated');
  const config = await loadConfig(path);
  assert.equal(config.present, false);
  assert.match(config.error, /could not be read/);
});

test('a config holding a list rather than an object is refused', async () => {
  const path = join(dir(), 'config.json');
  writeFileSync(path, '[]');
  const config = await loadConfig(path);
  assert.equal(config.present, false);
});

// From the 2026-10-21 security review: the error text reaches every device on the tailnet with
// the page, and a JSON parse error quotes the file around the fault (a credit
// balance, a path). The page gets a fixed line; the service log gets the detail.
test("a config that won't parse gives the page a fixed line, never the file's text, and logs the detail", async () => {
  const path = join(dir(), 'config.json');
  writeFileSync(path, '{"credits": {"balance": 4321.99, "note": "MARKER-7"}, oops');
  const logged = [];
  const config = await loadConfig(path, { log: line => logged.push(line) });
  assert.equal(config.present, false);
  assert.equal(config.error, 'config.json could not be read; the service log says why');
  assert.ok(!/4321|MARKER|oops|\//.test(config.error));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^config: .*config\.json could not be read: /);
});

test("a config that can't be opened says the same fixed line, without its path", async () => {
  const folder = dir(); // a directory where the file should be: EISDIR
  const logged = [];
  const config = await loadConfig(folder, { log: line => logged.push(line) });
  assert.equal(config.error, 'config.json could not be read; the service log says why');
  assert.ok(!config.error.includes(folder));
  assert.equal(logged.length, 1);
});

test('a missing config is normal and logs nothing', async () => {
  const logged = [];
  await loadConfig(join(dir(), 'nope.json'), { log: line => logged.push(line) });
  assert.deepEqual(logged, []);
});
