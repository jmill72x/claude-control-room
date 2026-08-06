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
