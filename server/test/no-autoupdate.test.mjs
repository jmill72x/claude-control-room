// Every claude this repo starts runs with DISABLE_AUTOUPDATER=1 (board a24a6aee,
// 2026-11-21: the owner turned Claude Code's self-update off in the user settings'
// `env`, which `--setting-sources project` skips). lib/claude-env.mjs holds the
// variable; this file pins each launch site, and fails when a new file starts claude
// without that module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NO_AUTOUPDATE, claudeEnv } from '../lib/claude-env.mjs';
import { runUsageCli } from '../collectors/usage.mjs';
import { runPlanCli } from '../collectors/plan.mjs';
import { recoverEnv } from '../lib/jarvis-recover.mjs';
import { setup } from '../../bin/exact-hook-check.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = { PATH: '/usr/bin:/bin', HOME: '/Users/someone', DISABLE_AUTOUPDATER: '0' };

test('claudeEnv: the base environment kept, DISABLE_AUTOUPDATER forced to 1', () => {
  assert.deepEqual(NO_AUTOUPDATE, { DISABLE_AUTOUPDATER: '1' });
  assert.ok(Object.isFrozen(NO_AUTOUPDATE));
  assert.deepEqual(claudeEnv(BASE), { PATH: '/usr/bin:/bin', HOME: '/Users/someone', DISABLE_AUTOUPDATER: '1' }, 'a base that says 0 is overruled');
  assert.equal(claudeEnv({}).DISABLE_AUTOUPDATER, '1');
  assert.equal(BASE.DISABLE_AUTOUPDATER, '0', 'the base itself is not changed');
  assert.equal(claudeEnv().PATH, process.env.PATH, 'by default, this process\'s own environment');
});

test('the /usage poll starts claude with updates off, and its own PATH kept', async () => {
  const calls = [];
  await runUsageCli({ env: BASE, exec: async (file, args, opts) => { calls.push({ file, opts }); return { stdout: '' }; } });
  const [{ file, opts }] = calls;
  assert.equal(file, 'claude');
  assert.equal(opts.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(opts.env.PATH, BASE.PATH, 'claude is still found on the server\'s PATH');
  assert.equal(opts.timeout, 120000, 'the other options as before');
});

test('the plan check (claude auth status) starts claude with updates off', async () => {
  const calls = [];
  await runPlanCli({ env: BASE, exec: async (file, args, opts) => { calls.push({ file, args, opts }); return { stdout: '{}' }; } });
  const [{ file, args, opts }] = calls;
  assert.equal(file, 'claude');
  assert.deepEqual(args, ['auth', 'status', '--json']);
  assert.equal(opts.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(opts.env.HOME, BASE.HOME);
});

test('Restart Jarvis: the recovery script, and the claude it starts, get updates off', () => {
  assert.equal(recoverEnv('/Users/someone', {}).DISABLE_AUTOUPDATER, '1');
  assert.equal(recoverEnv('/Users/someone', { DISABLE_AUTOUPDATER: '0' }).DISABLE_AUTOUPDATER, '1', 'never taken from this server');
});

test('the console test\'s scratch settings turn updates off (its session skips the user settings)', async () => {
  const b = await mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'nau-'));
  try {
    const { dir } = setup({ base: b, node: '/opt/node' });
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.env, { DISABLE_AUTOUPDATER: '1' });
  } finally {
    await rm(b, { recursive: true, force: true });
  }
});

// The guard for launch sites still to come: a call whose first argument is `claude`
// (or a path ending in /claude), in any source file outside the tests, must sit in a
// file that imports lib/claude-env.mjs. Today that is the two collectors.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '.git', 'design_handoff_claude_control_room', 'todos-history', 'data']);
const SOURCE = /\.(mjs|cjs|js|ts)$/;
const STARTS_CLAUDE = /\b\w+\(\s*['"`](?:[^'"`\s]*\/)?claude['"`]\s*,/;
const IMPORTS_ENV = /from\s+['"][./]+(?:server\/)?lib\/claude-env\.mjs['"]/;

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) sources(path, out); continue; }
    if (SOURCE.test(name) || (relative(REPO, dir) === 'bin' && !name.includes('.'))) out.push(path);
  }
  return out;
}

test('every file that starts claude imports claude-env (and the scan still sees the known ones)', () => {
  const found = [];
  for (const dir of ['server', 'bin', 'mod']) {
    for (const path of sources(join(REPO, dir))) {
      const text = readFileSync(path, 'utf8');
      if (!STARTS_CLAUDE.test(text)) continue;
      found.push(relative(REPO, path));
      assert.match(text, IMPORTS_ENV, `${relative(REPO, path)} starts claude without lib/claude-env.mjs`);
    }
  }
  assert.deepEqual(found.sort(), ['server/collectors/plan.mjs', 'server/collectors/usage.mjs'], 'a new launch site is fine once it passes the variable; add it here');
});
