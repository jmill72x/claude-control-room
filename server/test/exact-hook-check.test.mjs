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
import { EXACT_WINDOW_AFTER_MS, EXACT_WINDOW_BEFORE_MS } from '../lib/exact-commands.mjs';
import { CONSOLE_1113 } from './fixtures/console-1113.mjs';

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

// A channel with a fake clock and fake timers: `fire()` runs the timers that are due.
const unitChannel = () => {
  const env = { clock: { t: 1794380000000 }, lines: [], sent: [], raws: [], timers: [] };
  env.ch = createChannel({ dir: '/x', now: () => env.clock.t, out: m => env.sent.push(m), say: s => env.lines.push(s), raw: o => env.raws.push(o), later: (ms, fn) => env.timers.push({ at: env.clock.t + ms, fn }) });
  env.fire = () => { const due = env.timers.filter(x => x.at <= env.clock.t); env.timers = env.timers.filter(x => x.at > env.clock.t); for (const x of due) x.fn(); };
  env.report = command => env.ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', command });
  env.request = (command, tool = 'Bash') => env.ch.onPermission({ tool_name: tool, input_preview: JSON.stringify(tool === 'Bash' ? { command } : command) });
  return env;
};

test('the stand-in channel, unit: the console test of 11-13 replayed: each request paired with the report after it, ORDER AFTER with the gap, EQUALS, and the exact text on every card', () => {
  const env = unitChannel();
  env.ch.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '9.9.9' } } });
  assert.deepEqual(env.sent[0].result.capabilities.experimental, { 'claude/channel': {}, 'claude/channel/permission': {} });
  assert.equal(env.sent[0].result.protocolVersion, '2025-06-18');
  assert.match(env.lines.at(-1), /channel started by "claude-code" "9.9.9"/);
  env.ch.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2026-07-28' } });
  assert.equal(env.sent[1].result.protocolVersion, '2025-06-18', 'never a newer protocol than it knows');
  const start = env.clock.t;
  for (const [i, r] of CONSOLE_1113.entries()) {
    env.clock.t = start + r.at;
    env.fire();
    env.ch.handle({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: `abcd${i}`, tool_name: 'Bash', description: 'd', input_preview: JSON.stringify({ command: r.preview }) } });
    assert.match(env.lines.at(-1), new RegExp(`permission request #${i + 1}: Bash\n.*input_preview, raw: .*\n.*preview's command: `));
    assert.doesNotMatch(env.lines.at(-1), /ORDER|EQUALS|DIFFERS/, 'nothing to compare before the report');
    env.clock.t += r.after;
    env.report(r.report);
    assert.match(env.lines.at(-2), new RegExp(`hook report: Bash, ${r.report.length} characters`));
    const block = env.lines.at(-1);
    assert.match(block, new RegExp(`request #${i + 1}: its hook report came ${r.after} ms AFTER it: ORDER AFTER \\(\\+${r.after} ms\\)`), block);
    assert.match(block, new RegExp(`reported command: ${shown(r.report).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.match(block, /the server's fold of the report EQUALS the preview's command/);
    assert.match(block, /exact text on the card: yes/);
  }
  env.clock.t += 60e3;
  env.fire();
  assert.doesNotMatch(env.lines.join('\n'), /ORDER FAIL|NO REPORT|NO REQUEST|DIFFERS/);
  // The Write: its raw preview keeps the line breaks.
  env.request({ file_path: '/x/lines.md', content: 'one\ntwo\nthree\n' }, 'Write');
  assert.match(env.lines.at(-1), /permission request #6: Write\n.*content.*one\\\\ntwo\\\\nthree.*\n.*not Bash: no hook report is expected/);
  assert.equal(env.sent.length, 2, 'it never answers a prompt');
});

test('the stand-in channel, unit: a report before its request, a fold that differs, a carriage return, a request with no report, a report with no request', () => {
  const env = unitChannel();
  // A report 40 ms before the request (inside the window's 1 s before).
  env.report('touch a.txt');
  env.clock.t += 40;
  env.request('touch a.txt');
  assert.match(env.lines.at(-1), /request #1: its hook report came 40 ms BEFORE it: ORDER BEFORE \(-40 ms\)/);
  assert.match(env.lines.at(-1), /EQUALS/);
  // A preview that kept a run of spaces (the relay stopped folding).
  env.clock.t += 60e3;
  env.request('touch  b.txt');
  env.clock.t += 20;
  env.report('touch  b.txt');
  assert.match(env.lines.at(-1), /the report EQUALS the preview's command as it is: this preview was NOT folded/);
  // A fold that differs: a tab is never a space.
  env.clock.t += 60e3;
  env.request('touch c.txt');
  env.clock.t += 20;
  env.report('touch\tc.txt');
  assert.match(env.lines.at(-1), /DIFFERS FROM/);
  assert.match(env.lines.at(-1), /exact text on the card: no \(no report matched\)/);
  // A carriage return: the relay keeps it, and the card can't show it.
  env.clock.t += 60e3;
  env.request('touch d\r\ntouch e');
  env.clock.t += 20;
  env.report('touch d\r\ntouch e');
  assert.match(env.lines.at(-1), /reported command: "touch d\\r\\ntouch e"/);
  assert.match(env.lines.at(-1), /exact text on the card: no \(characters outside plain ASCII/);
  // A request with no report: said once its window has closed, not before.
  env.clock.t += 60e3;
  env.request('touch f.txt');
  env.clock.t += EXACT_WINDOW_AFTER_MS;
  env.fire();
  assert.doesNotMatch(env.lines.at(-1), /NO REPORT/);
  env.clock.t += 1;
  env.fire();
  assert.match(env.lines.at(-1), /request #5: no hook report from 1 s before it to 2 s after it: NO REPORT/);
  // A report 2 s after (too late to count for that request) met no request.
  env.report('touch f.txt');
  env.clock.t += EXACT_WINDOW_BEFORE_MS + 1;
  env.fire();
  assert.match(env.lines.at(-1), /met no Bash request .*: NO REQUEST/);
  // A report older than the window before a request is not paired with it.
  env.request('touch f.txt');
  assert.doesNotMatch(env.lines.at(-1), /ORDER/);
  // Two requests waiting: the report goes to the oldest whose window it falls in.
  env.clock.t += 60e3;
  env.request('touch g.txt');
  env.clock.t += 10;
  env.request('touch h.txt');
  env.clock.t += 10;
  env.report('touch g.txt');
  assert.match(env.lines.at(-1), /request #7: its hook report came 20 ms AFTER it/);
  env.report('touch h.txt');
  assert.match(env.lines.at(-1), /request #8: its hook report came 10 ms AFTER it/);
  // A refused report says why, as the server would.
  env.ch.onReport({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Monitor', command: 'x' });
  assert.match(env.lines.at(-1), /REFUSED as the server would refuse it: tool_name must be Bash/);
  // The raw log keeps no session id, only that one was there.
  assert.ok(env.raws.filter(r => r.kind === 'report').every(r => r.body.session_id === 'present'));
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
    const two = 'touch t2.txt\ntouch t3.txt';
    const results = join(dir, 'results.txt');
    // The relay first, then the hook, as Claude Code 2.1.323 does them.
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: JSON.stringify({ command: two }) } }) + '\n');
    assert.ok(await until(async () => (await readFile(results, 'utf8')).includes('permission request #1')));
    const run = await new Promise(resolveRun => {
      const h = spawn('/bin/sh', ['-c', hook], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
      let out = '';
      h.stdout.on('data', c => { out += c; });
      h.stderr.on('data', c => { out += c; });
      h.on('close', code => resolveRun({ code, out }));
      h.stdin.end(JSON.stringify({ session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: two, description: 'x' } }));
    });
    assert.deepEqual(run, { code: 0, out: '' });
    assert.ok(await until(async () => (await readFile(results, 'utf8')).includes('exact text on the card')), 'the report landed and was paired');
    const text = await readFile(results, 'utf8');
    assert.match(text, /request #1: its hook report came \d+ ms AFTER it: ORDER AFTER/);
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
