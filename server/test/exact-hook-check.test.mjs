// The scratch kit for the A1-H + A1-F test (bin/exact-hook-check.mjs): its settings
// carry README's exact-command hook with only the socket changed, and its stand-in
// channel, run the way Claude Code runs it, declares the permission relay and writes
// the order, the fold and the raw preview. Everything runs in a scratch folder; no
// Claude Code session, no Control Room, never :8322.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup, scratchHookEntry, readmeHookEntry, createChannel, shown, CHANNEL_NAME } from '../../bin/exact-hook-check.mjs';
import { foldWhitespace } from '../lib/exact-commands.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = join(REPO, 'bin', 'exact-hook-check.mjs');
const base = () => mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'ehc-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };

test('setup: README\'s hook word for word but the socket, a stand-in channel in a scratch MCP config, and a notes file', async () => {
  const readme = await readFile(join(REPO, 'README.md'), 'utf8');
  const b = await base();
  try {
    const { dir, socketPath } = setup({ base: b, readme, node: '/opt/node' });
    assert.equal(socketPath, join(dir, 'ingest.sock'));
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings), ['hooks', 'enabledPlugins'], 'the hook and the plugins off: nothing else of a settings file');
    // The two real channels off by name (Ultron's L4, 11-13).
    assert.deepEqual(settings.enabledPlugins, { 'discord@claude-plugins-official': false, 'jarvis-channel@jarvis-local': false });
    assert.deepEqual(Object.keys(settings.hooks), ['PermissionRequest']);
    const live = readmeHookEntry(readme)[0];
    const mine = settings.hooks.PermissionRequest[0];
    assert.deepEqual({ ...mine, hooks: [{ ...mine.hooks[0], command: null }] }, { ...live, hooks: [{ ...live.hooks[0], command: null }] }, 'matcher, timeout and type as README has them');
    assert.equal(mine.hooks[0].command, live.hooks[0].command.replace('"$HOME/.local/state/jarvis-os/ingest.sock"', `'${socketPath}'`));
    assert.ok(!mine.hooks[0].command.includes('jarvis-os'), 'the live socket is not named');
    const mcp = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'));
    assert.deepEqual(mcp, { mcpServers: { [CHANNEL_NAME]: { command: '/opt/node', args: [KIT, 'channel', dir] } } });
    assert.ok(existsSync(join(dir, 'work', 'notes.txt')));
    assert.throws(() => scratchHookEntry(readme, '/tmp/a b/ingest.sock'), /must be plain/);
    assert.throws(() => scratchHookEntry(readme, "/tmp/a'b"), /must be plain/);
    assert.throws(() => readmeHookEntry('# nothing here'), /no exact-command hook entry/);
  } finally { await rm(b, { recursive: true, force: true }); }
});

test('the stand-in channel, unit: order, fold, raw preview and the card\'s exact text, in plain words', () => {
  const clock = { t: 1794380000000 };
  const lines = [], sent = [], raws = [];
  const ch = createChannel({ dir: '/x', now: () => clock.t, out: m => sent.push(m), say: s => lines.push(s), raw: o => raws.push(o) });
  ch.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '9.9.9' } } });
  assert.deepEqual(sent[0].result.capabilities.experimental, { 'claude/channel': {}, 'claude/channel/permission': {} });
  assert.equal(sent[0].result.protocolVersion, '2025-06-18');
  assert.match(lines.at(-1), /channel started by "claude-code" "9.9.9"/);
  ch.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2026-07-28' } });
  assert.equal(sent[1].result.protocolVersion, '2025-06-18', 'never a newer protocol than it knows');
  const two = 'cat notes.txt\necho second-line';
  ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', command: two });
  clock.t += 40;
  ch.handle({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: JSON.stringify({ command: foldWhitespace(two) }) } });
  const block = lines.at(-1);
  assert.match(block, /permission request #1: Bash/);
  assert.match(block, /input_preview, raw: "\{\\"command\\":\\"cat notes.txt echo second-line\\"\}"/);
  assert.match(block, /40 ms BEFORE this request: ORDER PASS/);
  assert.match(block, /reported command: "cat notes.txt\\necho second-line"/);
  assert.match(block, /fold of the report EQUALS the preview's command/);
  assert.match(block, /exact text on the card: yes/);
  assert.equal(sent.length, 2, 'it never answers a prompt');
  // A preview that kept the line break.
  clock.t += 60e3;
  ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', command: 'ls\npwd' });
  ch.onPermission({ tool_name: 'Bash', input_preview: JSON.stringify({ command: 'ls\npwd' }) });
  assert.match(lines.at(-1), /the report EQUALS the preview's command as it is: this preview was NOT folded/);
  // A fold that differs, a carriage return, a request with no report, and a report after it.
  clock.t += 60e3;
  ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', command: 'echo  a' });
  ch.onPermission({ tool_name: 'Bash', input_preview: JSON.stringify({ command: 'echo  a b' }) });
  assert.match(lines.at(-1), /DIFFERS FROM/);
  assert.match(lines.at(-1), /exact text on the card: no \(no report matched\)/);
  clock.t += 60e3;
  ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', command: 'cat a\r\nrm b' });
  ch.onPermission({ tool_name: 'Bash', input_preview: JSON.stringify({ command: 'cat a rm b' }) });
  assert.match(lines.at(-1), /reported command: "cat a\\r\\nrm b"/);
  assert.match(lines.at(-1), /exact text on the card: no \(characters outside plain ASCII/);
  clock.t += 60e3;
  ch.onPermission({ tool_name: 'Bash', input_preview: JSON.stringify({ command: 'pwd' }) });
  assert.match(lines.at(-1), /no hook report has come in the 30 s before it: ORDER FAIL/);
  clock.t += 120;
  ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', command: 'pwd' });
  assert.match(lines.at(-1), /came 120 ms AFTER permission request #5: ORDER FAIL/);
  // Not Bash: the raw preview is still written (the A1-F Write case).
  ch.onPermission({ tool_name: 'Write', input_preview: JSON.stringify({ file_path: '/x/a.md', content: 'one\ntwo' }) });
  assert.match(lines.at(-1), /permission request #6: Write\n.*content.*one\\\\ntwo.*\n.*not Bash: no hook report is expected/);
  // A refused report says why, as the server would.
  ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Monitor', command: 'x' });
  assert.match(lines.at(-1), /REFUSED as the server would refuse it: tool_name must be Bash/);
  // The raw log keeps no session id, only that one was there.
  assert.ok(raws.filter(r => r.kind === 'report').every(r => r.body.session_id === 'present'));
  assert.equal(shown('a\u00e9\u202e'), '"a\\u00e9\\u202e"');
});

test('the stand-in channel, for real: started as Claude Code starts it, it answers on stdio, takes the scratch hook\'s post on its socket, and removes the socket on exit', async t => {
  if (!existsSync('/usr/bin/jq') || !existsSync('/usr/bin/curl')) return t.skip('needs /usr/bin/jq and /usr/bin/curl');
  const b = await base();
  let child = null;
  try {
    const { dir, socketPath } = setup({ base: b });
    const mcp = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')).mcpServers[CHANNEL_NAME];
    child = spawn(mcp.command, mcp.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '0' } } }) + '\n');
    assert.ok(await until(() => stdout.includes('\n')), 'an answer on stdout');
    const answer = JSON.parse(stdout.split('\n')[0]);
    assert.deepEqual(answer.result.capabilities.experimental, { 'claude/channel': {}, 'claude/channel/permission': {} });
    assert.ok(await until(() => existsSync(socketPath)), 'the scratch socket');
    // The hook, exactly as the scratch settings hold it, run by a shell.
    const hook = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
    const two = 'cat notes.txt\necho second-line';
    const run = await new Promise(resolveRun => {
      const h = spawn('/bin/sh', ['-c', hook], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
      let out = '';
      h.stdout.on('data', c => { out += c; });
      h.stderr.on('data', c => { out += c; });
      h.on('close', code => resolveRun({ code, out }));
      h.stdin.end(JSON.stringify({ session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: two, description: 'x' } }));
    });
    assert.deepEqual(run, { code: 0, out: '' });
    const results = join(dir, 'results.txt');
    assert.ok(await until(async () => (await readFile(results, 'utf8')).includes('hook report: Bash')), 'the report landed');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: JSON.stringify({ command: foldWhitespace(two) }) } }) + '\n');
    assert.ok(await until(async () => (await readFile(results, 'utf8')).includes('exact text on the card')));
    const text = await readFile(results, 'utf8');
    assert.match(text, /ORDER PASS/);
    assert.match(text, /EQUALS/);
    assert.match(text, /exact text on the card: yes/);
    assert.equal(stdout.trim().split('\n').length, 1, 'nothing on stdout but the one answer');
    child.kill('SIGTERM');
    assert.ok(await until(() => child.exitCode !== null));
    assert.equal(existsSync(socketPath), false, 'the socket is gone');
    assert.match(await readFile(results, 'utf8'), /channel stopped \(SIGTERM\)/);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await rm(b, { recursive: true, force: true });
  }
});
