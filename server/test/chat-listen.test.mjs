// Where the chat's sockets may go (lib/chat-listen.mjs): the folder's mode and
// owner, and that a socket a live server answers on is never unlinked. Real
// folders and sockets under a temp dir; every path here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, chmod, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSocketDir, socketAnswering, prepareSocketPath } from '../lib/chat-listen.mjs';

const exists = p => stat(p).then(() => true, () => false);
// A stale socket the way a crash leaves one: a child listens, then dies by SIGKILL,
// so the file stays and nobody answers on it.
async function staleSocket(path) {
  const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.stdout.write("up\\n"))', '--', path], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.equal(await exists(path), true, 'the dead server left its socket file');
}

test('the socket folder must exist, be a folder, be ours and be 0700', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-listen-'));
  try {
    const good = join(dir, 'good');
    await mkdir(good, { mode: 0o700 });
    assert.deepEqual(await checkSocketDir(join(good, 'channel.sock')), []);
    const loose = join(dir, 'loose');
    await mkdir(loose);
    await chmod(loose, 0o755);
    const problems = await checkSocketDir(join(loose, 'channel.sock'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /mode 755, not 0700/);
    await chmod(loose, 0o770);
    assert.match((await checkSocketDir(join(loose, 'channel.sock')))[0], /mode 770/, 'group access is too loose as well');
    assert.match((await checkSocketDir(join(dir, 'missing', 'channel.sock')))[0], /does not exist/);
    await writeFile(join(dir, 'file'), 'x', { mode: 0o600 });
    assert.match((await checkSocketDir(join(dir, 'file', 'channel.sock')))[0], /does not exist|not a folder/);
    const notOurs = await checkSocketDir(join(good, 'channel.sock'), { uid: (process.getuid?.() ?? 0) + 1 });
    assert.deepEqual(notOurs.map(p => /not owned by this user/.test(p)), [true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a socket with a server behind it answers; a stale socket file or a missing one does not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-listen-'));
  try {
    const live = join(dir, 'live.sock');
    const server = createServer(() => {});
    await new Promise(r => server.listen(live, r));
    try {
      assert.equal(await socketAnswering(live), true);
      assert.equal(await socketAnswering(join(dir, 'missing.sock')), false);
    } finally {
      await new Promise(r => server.close(r));
    }
    const stale = join(dir, 'stale.sock');
    await staleSocket(stale);
    assert.equal(await socketAnswering(stale), false, 'nobody listens: a connect is refused');
    // A plain file where the socket should be is not understood, so it counts as
    // answering: a doubt is never a reason to unlink.
    const file = join(dir, 'file.sock');
    await writeFile(file, '');
    assert.equal(await socketAnswering(file), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepareSocketPath removes a stale socket and refuses to touch a live one or a loose folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-listen-'));
  try {
    const folder = join(dir, 'state');
    await mkdir(folder, { mode: 0o700 });
    const stale = join(folder, 'channel.sock');
    await staleSocket(stale);
    assert.deepEqual(await prepareSocketPath(stale), { ok: true, problems: [] });
    assert.equal(await exists(stale), false, 'the stale file is gone');
    assert.deepEqual(await prepareSocketPath(stale), { ok: true, problems: [] }, 'nothing there is fine too');

    const live = join(folder, 'live.sock');
    const server = createServer(() => {});
    await new Promise(r => server.listen(live, r));
    try {
      const refused = await prepareSocketPath(live);
      assert.equal(refused.ok, false);
      assert.match(refused.problems[0], /already answering/);
      assert.equal(await exists(live), true, 'the live socket was left alone');
    } finally {
      // Closed whatever the verdict, or a failing run hangs on the open listener.
      await new Promise(r => server.close(r));
    }

    await chmod(folder, 0o755);
    const loose = await prepareSocketPath(join(folder, 'other.sock'));
    assert.equal(loose.ok, false);
    assert.match(loose.problems[0], /not 0700/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
