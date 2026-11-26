// What git must never pick up in this public repo: the config (credit balances) and
// the dated copies made of it before an edit. Read as text, and asked of git itself
// where this is a checkout. No file is opened but .gitignore; the names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = '/usr/bin/git';
const git = args => new Promise(resolve => execFile(GIT, args, { cwd: REPO }, (err, stdout) => resolve({ code: err ? err.code : 0, out: stdout })));

test('.gitignore names the config and its dated copies', async () => {
  const lines = (await readFile(join(REPO, '.gitignore'), 'utf8')).split('\n');
  assert.ok(lines.includes('server/config.json'));
  assert.ok(lines.includes('server/config.json.bak-*'));
  assert.ok(!lines.some(l => l.startsWith('!') && l.includes('config.json')), 'and nothing takes either back');
});

test('git ignores a dated copy of the config, and no tracked file is caught by an ignore rule', { skip: existsSync(GIT) && existsSync(join(REPO, '.git')) ? false : 'not a git checkout' }, async () => {
  for (const name of ['server/config.json', 'server/config.json.bak-20260101-000000', 'server/config.json.bak-x']) {
    assert.equal((await git(['check-ignore', '-q', '--no-index', name])).code, 0, name);
  }
  for (const name of ['server/config.example.json', 'server/config.json.backup', 'server/lib/config.json.bak-1.mjs', 'config.json.bak-1']) {
    assert.equal((await git(['check-ignore', '-q', '--no-index', name])).code, 1, `${name} is not ignored`);
  }
  assert.equal((await git(['ls-files', '-ci', '--exclude-standard'])).out, '');
});

// The done-lane archive (board 17924110) holds board content: the archive, its temp
// files and the copy kept before the first move are all ignored.
test('git ignores the board archive, its temp files and the pre-archive copy', { skip: existsSync(GIT) && existsSync(join(REPO, '.git')) ? false : 'not a git checkout' }, async () => {
  for (const name of ['server/data/todos-archive.json', 'server/data/todos-archive.json.tmp-1-2-3', 'server/todos-history/todos-pre-archive-20261125T120000000Z.json',
    'server/todos.json.lock', 'server/todos.json.lock.stale-1-abc']) {
    assert.equal((await git(['check-ignore', '-q', '--no-index', name])).code, 0, name);
  }
});
