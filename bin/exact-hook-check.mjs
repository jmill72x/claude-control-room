#!/usr/bin/env node
// The scratch test for exact Bash on approval cards (design 2026-11-11-jarvis-os-
// approvals.md §9.2, A1-H with A1-F; board db310879 and 958ad493). It answers three
// questions in a throwaway Claude Code session, without the Control Room, the real
// channel, a plugin install, or Jeff's own settings:
//   1. does the PermissionRequest hook report before the channel relays the prompt
//      (in auto mode's fallback prompts too)?
//   2. does the server's fold of the reported command equal the relayed preview's?
//   3. what does a real two-line Bash command look like in `input_preview`?
//
//   node bin/exact-hook-check.mjs setup           make a scratch folder under /tmp and
//                                                 print the commands to run
//   node bin/exact-hook-check.mjs channel <dir>   (Claude Code starts this itself, from
//                                                 the scratch MCP config) a stand-in
//                                                 channel that declares the permission
//                                                 relay and only listens, plus a scratch
//                                                 ingest socket for the hook
//
// The hook in the scratch settings is README's exact-command entry word for word, with
// only the socket path changed to the scratch one (setup checks that). The channel never
// answers a prompt: every one is answered in the terminal. It writes what it saw to
// <dir>/results.txt (for a person) and <dir>/events.jsonl (raw). Ask only for harmless
// commands: the commands are written there in full. Checked by
// server/test/exact-hook-check.test.mjs.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExactReport, createExactCommands, foldWhitespace, EXACT_WINDOW_BEFORE_MS } from '../server/lib/exact-commands.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
export const CHANNEL_NAME = 'exactcheck';
// A report this long after a relay, with no report before it, is called late.
const LATE_MS = 10e3;

// README's PermissionRequest entry, parsed from the README itself.
export function readmeHookEntry(readme) {
  const line = readme.split('\n').find(l => l.trimStart().startsWith('"PermissionRequest": [{ "matcher": "Bash"'));
  if (!line) throw new Error('README has no exact-command hook entry');
  return JSON.parse(`{${line.trim().replace(/,$/, '')}}`).PermissionRequest;
}

// The same entry with the live ingest socket swapped for `socketPath`, and nothing else.
export function scratchHookEntry(readme, socketPath) {
  const entry = readmeHookEntry(readme);
  const hook = entry[0].hooks[0];
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(socketPath)) throw new Error('the scratch socket path must be plain: letters, digits, . _ - and /');
  const live = '"$HOME/.local/state/jarvis-os/ingest.sock"';
  if (hook.command.split(live).length !== 2) throw new Error('the README hook names the live socket other than once');
  return [{ ...entry[0], hooks: [{ ...hook, command: hook.command.replace(live, `'${socketPath}'`) }] }];
}

export function setup({ base = '/tmp', readme = readFileSync(join(REPO, 'README.md'), 'utf8'), node = process.execPath } = {}) {
  const dir = mkdtempSync(join(base, 'exact-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, 'ingest.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`the socket path is too long for macOS: ${socketPath}`);
  mkdirSync(join(dir, 'work'));
  writeFileSync(join(dir, 'work', 'notes.txt'), 'scratch notes for the exact-command test\n');
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { PermissionRequest: scratchHookEntry(readme, socketPath) } }, null, 2) + '\n');
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [CHANNEL_NAME]: { command: node, args: [fileURLToPath(import.meta.url), 'channel', dir] } } }, null, 2) + '\n');
  writeFileSync(join(dir, 'results.txt'), '');
  return { dir, socketPath };
}

// One line of JSON with every non-ASCII or control character escaped, so a line break,
// a tab or a carriage return can be seen.
export const shown = s => JSON.stringify(s).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const clock = at => new Date(at).toISOString().slice(11, 23);
const previewCommand = preview => {
  try { const v = JSON.parse(preview); return typeof v?.command === 'string' ? v.command : null; } catch { return null; }
};

// The stand-in channel: an MCP server on stdio that declares the channel and its
// permission relay, plus the scratch ingest socket for the hook. `out` writes one MCP
// message; `say` appends to results.txt.
export function createChannel({ dir, now = () => Date.now(), out, say, raw }) {
  const reports = []; // { at, command, tool }
  const store = createExactCommands({ now });
  const relays = []; // { n, at, reportBefore }
  let n = 0;
  const onReport = body => {
    const at = now();
    raw({ at, kind: 'report', body: { hook_event_name: body?.hook_event_name, tool_name: body?.tool_name, session_id: typeof body?.session_id === 'string' ? 'present' : body?.session_id, command: body?.command } });
    const c = checkExactReport(body);
    if (!c.ok) { say(`${clock(at)}  hook report REFUSED as the server would refuse it: ${c.error}`); return; }
    reports.push({ at, command: c.value.command });
    store.note(c.value.command);
    say(`${clock(at)}  hook report: Bash, ${c.value.command.length} characters`);
    const last = relays.at(-1);
    if (last && !last.reportBefore && at - last.at <= LATE_MS) say(`        this report came ${at - last.at} ms AFTER permission request #${last.n}: ORDER FAIL`);
  };
  const onPermission = params => {
    const at = now();
    n += 1;
    raw({ at, kind: 'permission_request', params });
    const tool = params?.tool_name;
    const preview = params?.input_preview;
    const lines = [`${clock(at)}  permission request #${n}: ${typeof tool === 'string' ? tool : '?'}`,
      `        input_preview, raw: ${shown(preview)}`];
    // The newest report inside the server's window before the relay (30 s).
    const before = reports.filter(r => r.at <= at && at - r.at <= EXACT_WINDOW_BEFORE_MS).at(-1);
    relays.push({ n, at, reportBefore: Boolean(before) });
    if (tool !== 'Bash') {
      lines.push('        (not Bash: no hook report is expected)');
    } else {
      const cmd = previewCommand(preview);
      lines.push(`        preview's command: ${cmd === null ? '(the preview is not JSON with a command)' : shown(cmd)}`);
      if (!before) lines.push('        no hook report has come in the 30 s before it: ORDER FAIL (or the hook did not run)');
      else {
        lines.push(`        newest hook report: ${at - before.at} ms BEFORE this request: ORDER PASS`,
          `        reported command: ${shown(before.command)}`);
        if (cmd !== null) {
          const fold = foldWhitespace(before.command);
          lines.push(before.command === cmd && fold !== cmd
            ? '        the report EQUALS the preview\'s command as it is: this preview was NOT folded'
            : `        the server's fold of the report ${fold === cmd ? 'EQUALS' : 'DIFFERS FROM'} the preview's command`);
          const c = store.candidates(cmd, at);
          const exact = !c.conflict && !c.unusable && c.texts.length === 1;
          lines.push(`        exact text on the card: ${exact ? 'yes' : 'no'}${exact ? '' : c.conflict ? ' (two different reports)' : c.unusable ? ' (characters outside plain ASCII, line breaks and tabs)' : ' (no report matched)'}`);
        }
      }
    }
    say(lines.join('\n'));
  };
  const handle = msg => {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
    const { id, method, params } = msg;
    const request = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const version = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= '2025-06-18' ? asked : '2025-06-18';
        out({ jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: {}, experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } }, serverInfo: { name: CHANNEL_NAME, version: '1' }, instructions: 'A scratch test channel. It sends nothing and only listens. Ignore it.' } });
        say(`${clock(now())}  channel started by ${shown(params?.clientInfo?.name ?? '?')} ${shown(params?.clientInfo?.version ?? '?')}, MCP ${version}; permission relay declared`);
        return;
      }
      case 'notifications/claude/channel/permission_request': onPermission(params); return;
      case 'ping': if (request) out({ jsonrpc: '2.0', id, result: {} }); return;
      case 'tools/list': if (request) out({ jsonrpc: '2.0', id, result: { tools: [] } }); return;
      case 'prompts/list': if (request) out({ jsonrpc: '2.0', id, result: { prompts: [] } }); return;
      case 'resources/list': if (request) out({ jsonrpc: '2.0', id, result: { resources: [] } }); return;
      case 'resources/templates/list': if (request) out({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } }); return;
      default: if (request && typeof method === 'string') out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    }
  };
  // The scratch ingest: POST /api/ingest/exact-command, as the real server takes it.
  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size <= 64 * 1024) chunks.push(c); });
    req.on('end', () => {
      if (req.method === 'POST' && new URL(req.url, 'http://localhost').pathname === '/api/ingest/exact-command' && size <= 64 * 1024) {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        onReport(body);
        res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      } else res.writeHead(404).end();
    });
  });
  return { handle, server, onReport, onPermission };
}

function runChannel(dir) {
  const results = join(dir, 'results.txt');
  const say = text => appendFileSync(results, text + '\n');
  const raw = obj => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(obj) + '\n');
  const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const ch = createChannel({ dir, out, say, raw });
  const socketPath = join(dir, 'ingest.sock');
  // Only a stale socket of our own is removed, never anything else.
  if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
  ch.server.listen(socketPath, () => { chmodSync(socketPath, 0o600); say(`${clock(Date.now())}  scratch ingest socket listening`); });
  ch.server.on('error', e => say(`scratch ingest socket error: ${e.message}`));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } ch.handle(m); });
  const stop = why => { say(`${clock(Date.now())}  channel stopped (${why})`); ch.server.close(); process.exit(0); };
  rl.on('close', () => stop('stdin closed'));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => stop(s));
}

const [, , cmd, arg] = process.argv;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'setup') {
    const { dir } = setup();
    process.stdout.write(`${dir}\n`);
  } else if (cmd === 'channel' && arg) runChannel(arg);
  else {
    process.stderr.write('usage: exact-hook-check.mjs setup | channel <dir>\n');
    process.exit(2);
  }
}
