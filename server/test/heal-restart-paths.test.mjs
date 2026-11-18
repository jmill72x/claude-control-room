// Loop 3's restart card and the two page files the server runs (board 2703904f):
// web/src/lib/orbit/speech.js and the markdown.js it imports run inside the server once
// `chat.speech` is on, so a merge that changes either makes a restart due, like one
// under server/. The rest of web/ still opens nothing (the page is read from disk).
// SERVER_PATHS is what reaches git-read after `--`: fixed, literal and inside the repo.
// test/chat-speech.test.mjs ties the list to the server's real import graph. Every
// name, hash and file here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, normalize, isAbsolute } from 'node:path';
import { SERVER_PATHS, filesArgs, mergesArgs, createCheckoutReader } from '../lib/heal-programs.mjs';

const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40);

test('SERVER_PATHS: server/ and the two page files, each a fixed path git can only read as itself', () => {
  assert.deepEqual(SERVER_PATHS, ['server', 'web/src/lib/orbit/speech.js', 'web/src/lib/orbit/markdown.js']);
  assert.ok(Object.isFrozen(SERVER_PATHS));
  for (const p of SERVER_PATHS) {
    // No option, no pathspec magic (a leading ':'), no glob character, no way out.
    assert.match(p, /^[a-z][a-z0-9/._-]*$/, p);
    assert.ok(!isAbsolute(p) && normalize(p) === p && !p.split('/').includes('..'), p);
    assert.ok(existsSync(new URL(`../../${p}`, import.meta.url)), `${p} is in this checkout`);
  }
  // Both reads put the paths after `--`, with the two hashes alone before it.
  assert.deepEqual(filesArgs(H1, H2), ['diff', '--name-only', H1, H2, '--', ...SERVER_PATHS]);
  assert.deepEqual(mergesArgs(H1, H2), ['rev-list', '--first-parent', '--count', `${H1}..${H2}`, '--', ...SERVER_PATHS]);
});

test('the checkout reader on a scratch repo: a merge of speech.js or markdown.js is due a restart, the rest of web/ is not', { skip: !existsSync('/usr/bin/git') }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'heal-paths-git-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.test', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.test', xcrun_nocache: '1' };
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { env, encoding: 'utf8' });
  const commitOn = async (branch, path, text) => {
    git('checkout', '-q', '-b', branch, 'main');
    await mkdir(join(dir, dirname(path)), { recursive: true });
    await writeFile(join(dir, path), text);
    git('add', path);
    git('commit', '-q', '-m', `${branch}: ${path}`);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch);
    return git('rev-parse', 'HEAD').trim();
  };
  git('init', '-q', '-b', 'main');
  const files = ['server/server.mjs', 'web/index.html', 'web/src/lib/orbit/speech.js', 'web/src/lib/orbit/markdown.js', 'web/src/lib/orbit/loops.js', 'web/src/lib/orbit/speech.js.bak'];
  for (const f of files) {
    await mkdir(join(dir, dirname(f)), { recursive: true });
    await writeFile(join(dir, f), 'one\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  const start = git('rev-parse', 'HEAD').trim();
  const reader = createCheckoutReader({ gitRead: 'git-read', repo: dir, run: async (_, repo, { args }) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { env, encoding: 'utf8' }) });

  // Page files the server never loads: their neighbours, a look-alike name, a new file
  // beside them, a folder spelled like one of them in another place.
  await commitOn('jos/loops', 'web/src/lib/orbit/loops.js', 'two\n');
  await commitOn('jos/bak', 'web/src/lib/orbit/speech.js.bak', 'two\n');
  await commitOn('jos/near', 'web/src/lib/orbit/speech.jsx', 'new\n');
  const page = await commitOn('jos/elsewhere', 'docs/web/src/lib/orbit/markdown.js', 'new\n');
  assert.deepEqual(await reader.changed(start, page), { files: 0, merges: 0 }, 'no restart due');

  const speech = await commitOn('jos/speech', 'web/src/lib/orbit/speech.js', 'two\n');
  assert.deepEqual(await reader.changed(start, speech), { files: 1, merges: 1 });
  assert.deepEqual(await reader.changed(page, speech), { files: 1, merges: 1 });
  const md = await commitOn('jos/md', 'web/src/lib/orbit/markdown.js', 'two\n');
  assert.deepEqual(await reader.changed(speech, md), { files: 1, merges: 1 });
  const server = await commitOn('jos/server', 'server/server.mjs', 'two\n');
  assert.deepEqual(await reader.changed(start, server), { files: 3, merges: 3 }, 'each kind counts, side by side');
  // Removing a page file is a change too.
  git('rm', '-q', 'web/src/lib/orbit/markdown.js');
  git('commit', '-q', '-m', 'drop markdown');
  const gone = git('rev-parse', 'HEAD').trim();
  assert.deepEqual(await reader.changed(server, gone), { files: 1, merges: 1 });
  // A change taken back by a later merge leaves nothing to restart for.
  const back = await commitOn('jos/back', 'web/src/lib/orbit/speech.js', 'one\n');
  assert.deepEqual(await reader.changed(page, back), { files: 2, merges: 5 }, 'markdown.js gone and server.mjs changed, by five commits; speech.js back as it was');
  assert.equal((await reader.changed(speech, back)).files, 3, 'from the speech merge, speech.js has changed back');
});
