// deploy/swap-needs-you-hooks.py: moves the six needs-you hook commands in a Claude
// Code settings file from the TCP port to the ingest socket (Ultron's 11-12 ask, in
// place of a sed). Run for real with /usr/bin/python3 -I, on fixture copies in a
// scratch folder and a scratch socket: never the real settings file or socket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = new URL('../../deploy/swap-needs-you-hooks.py', import.meta.url).pathname;
const PY = '/usr/bin/python3';
const SOCKET_PART = m => `/usr/bin/curl -q -s -m ${m} --noproxy '*' --unix-socket "$HOME/.local/state/jarvis-os/ingest.sock" -X POST http://localhost/api/ingest/needs-you`;
const TCP_PART = m => `curl -s -m ${m} -X POST http://127.0.0.1:8322/api/ingest/needs-you`;
// One old command exactly as README gave it before 2026-11-12 (main 1e1da2d).
const OLD_NOTIFICATION = "/usr/bin/jq -c '{hook_event_name,session_id,notification_type,at:(now*1000|floor)}' | curl -s -m 3 -X POST http://127.0.0.1:8322/api/ingest/needs-you -H 'Content-Type: application/json' -d @- >/dev/null || true";

// README's six new entries (the five needs-you ones and PermissionDenied).
const readmeHooks = async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const entry = heading => JSON.parse(readme.slice(readme.indexOf(heading)).match(/```json\n([\s\S]*?)\n```/)[1]).hooks;
  return { ...entry('### A session waiting on you'), ...entry('**The classifier-block hook.**') };
};
const toOld = hooks => JSON.parse(JSON.stringify(hooks).replace(/\/usr\/bin\/curl -q -s -m (\d+) --noproxy '\*' --unix-socket \\"\$HOME\/\.local\/state\/jarvis-os\/ingest\.sock\\" -X POST http:\/\/localhost\/api\/ingest\/needs-you/g, (_, m) => TCP_PART(m)));

// A settings file like the owner's: other keys, other hooks with their own matchers,
// and the six old commands, laid out by hand (not JSON.stringify's layout), so a test
// can see that the layout is kept.
const fixture = hooks => {
  const lines = Object.entries(hooks).map(([event, groups]) => `    ${JSON.stringify(event)}: ${JSON.stringify(groups)}`);
  lines.push('    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "/usr/local/bin/guard --check" }] }]');
  return `{\n  "model": "opus",\n  "permissions": { "allow": ["Bash(ls:*)"], "deny": [] },\n  "hooks": {\n${lines.join(',\n')}\n  },\n  "statusLine": { "type": "command", "command": "echo hi" }\n}\n`;
};

const dirs = [];
const servers = [];
after(async () => {
  for (const s of servers) await new Promise(r => s.close(r));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
// A scratch folder with settings.json (mode 0644, like Claude Code's) and, unless
// told otherwise, a 0600 socket of this user's.
const setup = async ({ text, socket = 'ok' } = {}) => {
  const dir = await mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'sw-'));
  dirs.push(dir);
  const settings = join(dir, 'settings.json');
  await writeFile(settings, text ?? fixture(toOld(await readmeHooks())));
  await chmod(settings, 0o644);
  const sock = join(dir, 'ingest.sock');
  if (socket !== 'none' && socket !== 'file') {
    const s = createServer();
    await new Promise(r => s.listen(sock, r));
    servers.push(s);
    await chmod(sock, socket === 'loose' ? 0o660 : 0o600);
  }
  if (socket === 'file') await writeFile(sock, '', { mode: 0o600 });
  return { dir, settings, sock };
};
const run = (s, ...flags) => {
  const r = spawnSync(PY, ['-I', SCRIPT, '--settings', s.settings, '--socket', s.sock, ...flags], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const commandsOf = settings => Object.values(settings.hooks).flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));
const skip = t => { if (!existsSync(PY)) { t.skip('needs /usr/bin/python3'); return true; } return false; };

test('the fixture: the old commands are README\'s old ones, six of them, with their own -m', async () => {
  const old = toOld(await readmeHooks());
  assert.equal(old.Notification[0].hooks[0].command, OLD_NOTIFICATION);
  const cmds = commandsOf({ hooks: old });
  assert.equal(cmds.length, 6);
  assert.equal(cmds.filter(c => c.includes(TCP_PART(3))).length, 5);
  assert.equal(cmds.filter(c => c.includes(TCP_PART(1))).length, 1, 'SessionEnd keeps its 1 s');
});

test('the swap: six commands move to the socket, each keeping its -m; events, matchers, async, other hooks and the layout stay', async t => {
  if (skip(t)) return;
  const s = await setup();
  const before = await readFile(s.settings, 'utf8');
  const r = run(s);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^moved 6 hook commands to the ingest socket; backup: .*settings\.json\.bak-\d{8}-\d{6}\n$/);
  const text = await readFile(s.settings, 'utf8');
  const now = JSON.parse(text);
  const readme = await readmeHooks();
  for (const [event, groups] of Object.entries(readme)) assert.deepEqual(now.hooks[event], groups, `${event}: exactly README's new entry`);
  assert.deepEqual(now.hooks.PreToolUse, JSON.parse(before).hooks.PreToolUse);
  assert.equal(now.model, 'opus');
  assert.deepEqual(now.permissions, { allow: ['Bash(ls:*)'], deny: [] });
  assert.ok(text.includes('--unix-socket \\"$HOME/.local/state/jarvis-os/ingest.sock\\"'), 'the quotes are JSON-escaped in the file');
  assert.equal(text.split('\n').length, before.split('\n').length, 'the layout is kept: same lines');
  assert.equal(text.replace(/\/usr\/bin\/curl -q -s -m (\d) --noproxy '\*' --unix-socket \\"\$HOME\/\.local\/state\/jarvis-os\/ingest\.sock\\" -X POST http:\/\/localhost/g, (_, m) => `curl -s -m ${m} -X POST http://127.0.0.1:8322`), before, 'and nothing else in the text changed');
  assert.equal((await stat(s.settings)).mode & 0o777, 0o644, 'the file keeps its mode');
  const backups = (await readdir(s.dir)).filter(n => n.startsWith('settings.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(s.dir, backups[0]), 'utf8'), before, 'the backup is the old file');
  assert.equal((await stat(join(s.dir, backups[0]))).mode & 0o777, 0o600, 'the backup is 0600');
  assert.deepEqual((await readdir(s.dir)).filter(n => n.endsWith('.tmp')), [], 'no temp file left');
  // A second run finds nothing to move, and changes nothing.
  const again = run(s);
  assert.equal(again.code, 1);
  assert.match(again.err, /found 0 old needs-you hook commands, not 6: nothing changed/);
  assert.equal(await readFile(s.settings, 'utf8'), text);
});

test('--dry-run prints the diff and writes nothing, not even a backup', async t => {
  if (skip(t)) return;
  const s = await setup();
  const before = await readFile(s.settings, 'utf8');
  const r = run(s, '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^--- .*settings\.json\n\+\+\+ .*settings\.json \(swapped\)\n/);
  assert.equal((r.out.match(/^-.*127\.0\.0\.1:8322\/api\/ingest\/needs-you/gm) ?? []).length, 6);
  assert.equal((r.out.match(/^\+.*--unix-socket/gm) ?? []).length, 6);
  assert.match(r.err, /dry run: 6 commands would move to the socket; nothing written/);
  assert.equal(await readFile(s.settings, 'utf8'), before);
  assert.deepEqual((await readdir(s.dir)).sort(), ['ingest.sock', 'settings.json']);
  // With no socket, the dry run still shows the diff, and says it would refuse.
  const n = await setup({ socket: 'none' });
  const r2 = run(n, '--dry-run');
  assert.equal(r2.code, 1);
  assert.match(r2.out, /\+.*--unix-socket/);
  assert.match(r2.err, /would refuse: the ingest socket .* is not there: restart the service on the new build first/);
});

test('it refuses, changing nothing, unless the socket is a 0600 socket of this user\'s', async t => {
  if (skip(t)) return;
  for (const [socket, why] of [['none', /is not there/], ['file', /is not a socket/], ['loose', /is mode 660, not 0600/]]) {
    const s = await setup({ socket });
    const before = await readFile(s.settings, 'utf8');
    const r = run(s);
    assert.equal(r.code, 1, socket);
    assert.match(r.err, why, socket);
    assert.match(r.err, /nothing changed/);
    assert.equal(await readFile(s.settings, 'utf8'), before, socket);
    assert.equal((await readdir(s.dir)).filter(n => n.includes('.bak-')).length, 0, `${socket}: no backup either`);
  }
});

test('it refuses, changing nothing, on other than six old commands, an unknown TCP form, a symlink or bad JSON', async t => {
  if (skip(t)) return;
  const hooks = toOld(await readmeHooks());
  const five = { ...hooks };
  delete five.Stop;
  const seven = { ...hooks, SubagentStop: hooks.Stop };
  const half = JSON.parse(JSON.stringify(hooks));
  half.Stop[0].hooks[0].command = half.Stop[0].hooks[0].command.replace(TCP_PART(3), SOCKET_PART(3));
  const odd = { ...hooks, PreCompact: [{ hooks: [{ type: 'command', command: "curl -s -X POST http://127.0.0.1:8322/api/ingest/crons -d '[]'" }] }] };
  const brew = JSON.parse(JSON.stringify(hooks));
  brew.Stop[0].hooks[0].command = brew.Stop[0].hooks[0].command.replace(TCP_PART(3), `/opt/homebrew/bin/${TCP_PART(3)}`);
  assert.ok(brew.Stop[0].hooks[0].command.includes('/opt/homebrew/bin/curl -s -m 3 -X POST'), 'the fixture has the Homebrew curl');
  const brewExtra = { ...hooks, SubagentStop: [{ hooks: [{ type: 'command', command: `/opt/homebrew/bin/${TCP_PART(3)} -d @-` }] }] };
  const wordExtra = { ...hooks, SubagentStop: [{ hooks: [{ type: 'command', command: `x${TCP_PART(3)} -d @-` }] }] };
  const cases = [
    [fixture(five), /found 5 old needs-you hook commands, not 6/],
    [fixture(seven), /found 7 old needs-you hook commands, not 6/],
    [fixture(half), /found 5 old/],
    [fixture(odd), /post to the TCP ingest in a form this script does not know/],
    // Another curl's path, or a word ending in curl, never half-matches (Ultron's 11-12 low).
    [fixture(brew), /found 5 old needs-you hook commands, not 6/],
    [fixture(brewExtra), /1 hook command\(s\) post to the TCP ingest in a form this script does not know/],
    [fixture(wordExtra), /1 hook command\(s\) post to the TCP ingest in a form this script does not know/],
    ['{ "hooks": ', /is not valid JSON/],
    ['[]', /is not a JSON object/],
    ['{ "model": "opus" }', /has no "hooks" object/]
  ];
  for (const [text, why] of cases) {
    const s = await setup({ text });
    for (const flags of [[], ['--dry-run']]) {
      const r = run(s, ...flags);
      assert.equal(r.code, 1, `${why} ${flags}`);
      assert.match(r.err, why);
      assert.equal(await readFile(s.settings, 'utf8'), text);
    }
    assert.deepEqual((await readdir(s.dir)).sort(), ['ingest.sock', 'settings.json'], `${why}: no backup, no temp file`);
  }
  // A settings file that is a symlink (to a repo copy, say) is not replaced by a file.
  const s = await setup();
  const real = join(s.dir, 'real.json');
  await writeFile(real, fixture(hooks));
  await rm(s.settings);
  await symlink(real, s.settings);
  const r = run(s);
  assert.equal(r.code, 1);
  assert.match(r.err, /is a symlink or not a regular file/);
  assert.equal(await readFile(real, 'utf8'), fixture(hooks));
});
