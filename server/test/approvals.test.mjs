// Approvals as buttons (docs/design/2026-11-11-jarvis-os-approvals.md, with Ultron's
// 11-11 findings H1-H2, M3-M6 and L7-L12): the pure rules in lib/approvals.mjs, the
// store's permission entries, and the two routes run on real sockets with their own
// servers. Every name, path and id is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  revealHidden, readApprovalsConfig, capField, markerReasons, parsePreview, shownHash, pathForms, denyOnlyReasons, blockReasonWords,
  verdictOriginProblem, createApprovals, cutMarker, FIELD_MAX, BLOCK_WINDOW_MS, LATE_AFTER_MS, VERDICTS_PER_MINUTE,
  VERDICTS_PER_HOUR, REFUSALS_FOR_LOCKOUT, LOCKOUT_MS, ALLOW_BURST, FLOOD_OPEN
} from '../lib/approvals.mjs';
import { createChatStore, PERMISSION_TTL_MS } from '../lib/chat-store.mjs';
import { createDeviceStore, COOKIE_NAME, PAIR_COOKIE_NAME } from '../lib/chat-devices.mjs';
import { createSocketRouter, toInbound, SESSION_HEADER, HEARTBEAT_FRESH_MS } from '../lib/chat-socket.mjs';
import { createChatRoutes, createAdminRouter } from '../lib/chat-routes.mjs';

const MIN = 60e3;
const HOME = '/home/owner';
const noReal = () => null;
const rules = (tool, preview, extra = {}) => denyOnlyReasons({ tool, description: 'd', inputPreview: typeof preview === 'string' ? preview : JSON.stringify(preview), ...extra }, { home: HOME, realpath: noReal });
const bash = cmd => rules('Bash', { command: cmd });

// ---- the pure rules ----

test('config: off unless "deny" or "on"; anything else is off with a problem; extra Deny-only patterns are lower-cased', () => {
  assert.deepEqual(readApprovalsConfig({}), { mode: 'off', patterns: [], problems: [] });
  assert.equal(readApprovalsConfig({ chat: { login: 'x' } }).mode, 'off', 'the default is off (Ultron H2)');
  assert.equal(readApprovalsConfig({ chat: { approvals: 'deny' } }).mode, 'deny');
  assert.equal(readApprovalsConfig({ chat: { approvals: 'on' } }).mode, 'on');
  for (const bad of ['ON', 'allow', true, 1, 'yes']) {
    const r = readApprovalsConfig({ chat: { approvals: bad } });
    assert.equal(r.mode, 'off', String(bad));
    assert.equal(r.problems.length, 1);
  }
  assert.deepEqual(readApprovalsConfig({ chat: { approvalsDenyOnly: [' Deploy '] } }).patterns, ['deploy']);
  assert.equal(readApprovalsConfig({ chat: { approvalsDenyOnly: 'deploy' } }).problems.length, 1);
});

test('fields are kept whole to 16,100 code points (the channel cuts at 16,000); a longer one keeps its start, is marked and says so (H1)', () => {
  assert.deepEqual(capField('abc'), { text: 'abc', cut: false });
  assert.equal(capField('a'.repeat(16000)).cut, false, 'the channel\'s whole 16,000 fit, with room for its marker');
  assert.equal(FIELD_MAX, 16100);
  const exact = '😀'.repeat(FIELD_MAX);
  assert.deepEqual(capField(exact), { text: exact, cut: false }, 'counted in code points, not UTF-16 units');
  const over = capField('a'.repeat(FIELD_MAX + 7));
  assert.equal(over.cut, true);
  assert.ok(over.text.startsWith('a'.repeat(FIELD_MAX)));
  assert.ok(over.text.endsWith(cutMarker(7)));
  assert.deepEqual(capField(42), { text: '', cut: false });
  assert.deepEqual(markerReasons(over.text), ['it was cut short']);
  assert.deepEqual(markerReasons('a ⋯ 12 code points elided ⋯ b'), ['part of it was elided']);
  assert.deepEqual(markerReasons('token [REDACTED]'), ['part of it was masked']);
  assert.deepEqual(markerReasons('{"x":"(value unserializable)"}'), ['a value could not be shown']);
  assert.deepEqual(markerReasons('⋯ 3 code points cut by the channel ⋯'), ['it was cut short']);
  assert.deepEqual(markerReasons('nothing hidden'), []);
  // Direction and invisible characters, built from code points (never typed in).
  const rlo = String.fromCodePoint(0x202e), zw = String.fromCodePoint(0x200b), bell = String.fromCodePoint(7);
  assert.deepEqual(capField(`a${rlo}b${zw}c${bell}d\te\nf`), { text: 'a⟦U+202E⟧b⟦U+200B⟧c⟦U+0007⟧d\te\nf', cut: false });
  assert.deepEqual(markerReasons(capField(`x${rlo}`).text), ['it carries invisible or direction characters']);
  assert.equal(revealHidden(String.fromCodePoint(0xfeff)), '⟦U+FEFF⟧');
});

test('the preview is parsed into fields, what runs or changes first; anything else is null', () => {
  const p = parsePreview(JSON.stringify({ description: 'pad', timeout: 5, command: 'ls' }));
  assert.deepEqual(p.fields, [['command', 'ls'], ['description', 'pad'], ['timeout', '5']]);
  assert.deepEqual(parsePreview('{"content":"x","file_path":"/a"}').fields.map(f => f[0]), ['file_path', 'content']);
  for (const bad of ['', 'ls -la', '[1,2]', '"text"', 'null', '{"a":', 7]) assert.equal(parsePreview(bad), null, String(bad));
});

test('the shown hash is sha256 over JSON.stringify([tool, description, inputPreview]) (L11), so fields cannot run into each other', () => {
  const want = createHash('sha256').update(JSON.stringify(['Bash', 'd', '{"command":"ls"}'])).digest('hex');
  assert.equal(shownHash('Bash', 'd', '{"command":"ls"}'), want);
  assert.notEqual(shownHash('a\nb', 'c', ''), shownHash('a', 'b\nc', ''), 'a newline join would make these equal');
});

test('H1: a Bash call padded with a 3,400-code-point description keeps its command, first, whole and unmarked', async () => {
  const pad = 'Tidy the build folder. '.repeat(148).slice(0, 3400);
  assert.equal(Array.from(pad).length, 3400);
  const preview = JSON.stringify({ description: pad, command: 'rm -rf ~/Projects' });
  const dir = await mkdtemp(join(tmpdir(), 'appr-'));
  try {
    const store = createChatStore({ dir, now: () => 1794380000000 });
    await store.load();
    const p = await store.openPermission({ requestId: 'abcde', tool: 'Bash', description: pad, inputPreview: preview }, { assess: q => ({ denyOnly: denyOnlyReasons(q, { home: HOME, realpath: noReal }), why: null }) });
    assert.equal(p.inputPreview, preview, 'nothing cut');
    assert.equal(p.cut, false);
    const pub = store.publicPermission(p);
    assert.deepEqual(pub.fields[0], ['command', 'rm -rf ~/Projects'], 'the command leads the card');
    assert.ok(!pub.denyOnly.includes('it was cut short'));
    assert.ok(pub.denyOnly.some(r => /not on the short list/.test(r)), 'and rm is Deny-only anyway');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Bash: one plain command whose first word is on the short list may be allowed; everything else is Deny-only (M5)', () => {
  for (const ok of ['ls -la /tmp', 'cat README.md', 'git status', 'git log --oneline -5', 'wc -l notes.txt', 'grep -n TODO src/app.js', 'touch /tmp/scratch/a', 'mkdir -p /tmp/scratch/x']) {
    assert.deepEqual(bash(ok), [], ok);
  }
  const deny = {
    'ls; rm x': /shell syntax/, 'ls | sh': /shell syntax/, 'ls && rm x': /shell syntax/, 'echo $HOME': /shell syntax/,
    'echo `id`': /shell syntax/, 'echo hi > f': /shell syntax/, 'cat < f': /shell syntax/, 'ls (x)': /shell syntax/,
    'ls\nrm x': /shell syntax/, "cat '.ssh/id'": /shell syntax/, 'cat .s\\sh/id': /shell syntax/, 'cat ~/.ss?/id': /shell syntax/,
    'rm -rf /tmp/x': /not on the short list/, 'bash -c ls': /not on the short list|-c/, 'sudo ls': /not on the short list/,
    'Ls': /not on the short list/, '/bin/ls': /not on the short list/, 'git push': /only git status/, 'git -C /x status': /only git status/,
    'git diff --output=/tmp/x': /--output/, 'rg --pre cat x': /--pre/, 'ls ~root': /another user/, 'echo -c x': /-c/
  };
  for (const [cmd, re] of Object.entries(deny)) assert.ok(bash(cmd).some(r => re.test(r)), `${cmd}: ${bash(cmd).join('; ')}`);
  assert.ok(rules('Bash', { description: 'no command' }).some(r => /no command/.test(r)));
});

test('paths are normalised (~, .., case, the real path of the parent) and the protected and sensitive ones are Deny-only, for Bash as well as Edit and Write', () => {
  const protectedCmds = [
    'touch ~/.claude/settings.json', 'cat ~/.CLAUDE/x', 'touch /home/owner/Projects/app/.mcp.json', 'cat x/.git/config',
    'cat .github/workflows/ci.yml', 'touch ~/Projects/machine-setup/git-hooks/pre-commit', 'cat ~/Projects/jarvis/README.md',
    'cat ~/.zshenv', 'cat ~/.zshrc', 'cat server/config.json', 'cat ~/Projects/claude-control-room/bin/chat-pair',
    'ls ~/.local/state/jarvis-os/', 'ls ~/Library/LaunchAgents', 'cat /etc/hosts', 'touch /home/owner/tmp/../.ssh/x'
  ];
  for (const cmd of protectedCmds) assert.ok(bash(cmd).some(r => /touches|reads/.test(r)), `${cmd}: ${bash(cmd).join('; ')}`);
  assert.ok(bash('cat ../secrets.txt').some(r => /relative path with \.\./.test(r)));
  // A symlink: the parent's real path is judged too.
  const link = denyOnlyReasons({ tool: 'Bash', inputPreview: JSON.stringify({ command: 'cat /home/owner/link/id_x' }) }, { home: HOME, realpath: p => (p === '/home/owner/link' ? '/home/owner/.ssh' : null) });
  assert.ok(link.some(r => /\.ssh/.test(r)), link.join('; '));
  assert.deepEqual(pathForms('~/a/../B', { home: HOME, realpath: noReal }), { relative: false, dotdot: false, forms: ['/home/owner/b'] });
  for (const p of ['~/.claude/agents/x.md', '/home/owner/.mcp.json', '/home/owner/Projects/jarvis/bin/x', '/home/owner/.zshenv', '/home/owner/Projects/claude-control-room/server/config.json', '/home/owner/.local/state/jarvis-os/approvals-allow']) {
    assert.ok(rules('Write', { file_path: p, content: 'x' }).length > 0, p);
    assert.ok(rules('Edit', { file_path: p, old_string: 'a', new_string: 'b' }).length > 0, p);
  }
  assert.deepEqual(rules('Write', { file_path: '/home/owner/Projects/app/notes.md', content: 'x' }), []);
  assert.ok(rules('Write', { file_path: 'notes.md', content: 'x' }).some(r => /absolute path/.test(r)));
  assert.deepEqual(rules('NotebookEdit', { notebook_path: '/home/owner/a.ipynb', new_source: 'x' }), []);
});

test('Read, Glob and Grep are Deny-only for the channels folder, ~/.ssh, .env files and keys; WebFetch for a query string or another site; unknown tools always', () => {
  for (const p of ['/home/owner/.claude/channels/discord/access.json', '/home/owner/.ssh/config', '/home/owner/app/.env', '/home/owner/app/.env.local', '/home/owner/k.pem', '/home/owner/id_ed25519', '/home/owner/.netrc']) {
    assert.ok(rules('Read', { file_path: p }).length > 0, p);
  }
  assert.deepEqual(rules('Read', { file_path: '/home/owner/Projects/app/README.md' }), []);
  assert.deepEqual(rules('Read', { file_path: '/home/owner/.claude/agent-memory/x.md' }), [], 'reading other .claude files is fine');
  assert.ok(rules('Grep', { pattern: 'x', path: '/home/owner/.ssh' }).length > 0);
  assert.ok(rules('Glob', { pattern: '**/.env' }).length > 0);
  assert.deepEqual(rules('Glob', { pattern: 'src/**/*.js' }), []);
  assert.deepEqual(rules('WebFetch', { url: 'https://code.claude.com/docs/en/hooks.md', prompt: 'p' }), []);
  assert.ok(rules('WebFetch', { url: 'https://code.claude.com/docs?x=1' }).some(r => /query/.test(r)));
  assert.ok(rules('WebFetch', { url: 'https://evil.example/' }).some(r => /short list of sites/.test(r)));
  assert.ok(rules('WebFetch', { url: 'http://code.claude.com/' }).some(r => /https/.test(r)));
  assert.ok(rules('WebFetch', { url: 'https://u:p@github.com/' }).some(r => /https/.test(r)));
  assert.deepEqual(rules('WebSearch', { query: 'node test runner' }), []);
  assert.deepEqual(rules('mcp__plugin_jarvis-channel_jarvis__reply', { chat_id: 'jos', text: 'hi' }), []);
  assert.ok(rules('mcp__plugin_discord_discord__reply', { files: ['/home/owner/.ssh/id_rsa'] }).length > 0);
  for (const t of ['TodoWrite', 'Agent', 'mcp__other__tool', 'KillShell']) assert.ok(rules(t, { x: 1 }).some(r => /does not know/.test(r)), t);
});

test('markers, a preview that will not parse, a cut, and config patterns are Deny-only whatever the tool', () => {
  assert.ok(rules('Bash', '{"command":"ls ⋯ 9 code points elided ⋯"}').includes('part of it was elided'));
  assert.ok(rules('Bash', { command: 'cat [REDACTED]' }).includes('part of it was masked'));
  assert.ok(rules('Read', { file_path: '(value unserializable)' }).includes('a value could not be shown'));
  assert.ok(rules('Bash', 'ls -la').includes('its arguments could not be read'));
  assert.ok(rules('Bash', { command: 'ls' }, { cut: true }).includes('it was cut short'));
  assert.ok(rules('Bash', { command: 'ls' }, { description: 'see ⋯ 2 code points elided ⋯' }).includes('part of it was elided'), 'the description counts too');
  assert.ok(denyOnlyReasons({ tool: 'Bash', inputPreview: '{"command":"ls deploy"}' }, { home: HOME, realpath: noReal, patterns: ['deploy'] }).some(r => /config/.test(r)));
});

test('the block reason words: a bracketed rule name, the two fixed kinds, else nothing', () => {
  assert.equal(blockReasonWords('[Data Exfiltration]'), 'Data Exfiltration');
  assert.equal(blockReasonWords('Auto mode could not evaluate this action and is blocking it for safety'), 'auto mode could not evaluate it');
  assert.equal(blockReasonWords('Classifier unavailable'), 'the classifier was unavailable');
  assert.equal(blockReasonWords('[x] and then some <script>'), null);
  assert.equal(blockReasonWords(null), null);
});

test('a verdict needs the page\'s own https Origin, and Sec-Fetch-Site same-origin when sent (G2)', () => {
  const hosts = new Set(['jos.example.test']);
  assert.equal(verdictOriginProblem({ origin: 'https://jos.example.test', 'sec-fetch-site': 'same-origin' }, hosts), null);
  assert.equal(verdictOriginProblem({ origin: 'https://jos.example.test' }, hosts), null, 'an older browser sends no Sec-Fetch-Site');
  assert.equal(verdictOriginProblem({ origin: 'https://jos.example.test:443' }, new Set(['jos.example.test:443'])), null);
  for (const h of [{}, { origin: '' }, { origin: 'null' }, { origin: 'http://jos.example.test' }, { origin: 'https://evil.example' }, { origin: 'nonsense' },
    { origin: 'https://jos.example.test', 'sec-fetch-site': 'cross-site' }, { origin: 'https://jos.example.test', 'sec-fetch-site': 'same-site' }]) {
    assert.ok(verdictOriginProblem(h, hosts), JSON.stringify(h));
  }
});

test('the gate: the kill file turns it off on the next request and both changes are reported; limits, lockout, anonymous refusals, bursts and floods', () => {
  const clock = { t: 1794380000000 };
  const events = [];
  const files = new Set();
  const g = createApprovals({ mode: 'on', killPath: '/k/approvals-off', now: () => clock.t, onEvent: e => events.push(e), exists: p => files.has(p) });
  assert.equal(g.mode(), 'on');
  files.add('/k/approvals-off');
  assert.equal(g.mode(), 'off');
  files.delete('/k/approvals-off');
  assert.equal(g.mode(), 'on');
  assert.deepEqual(events, [{ kind: 'approvals-kill', on: true }, { kind: 'approvals-kill', on: false }]);
  assert.equal(createApprovals({ mode: 'sideways' }).mode(), 'off');
  assert.equal(createApprovals({ mode: 'on', killPath: '/k', exists: () => { throw new Error('EACCES'); } }).mode(), 'off', 'a kill file that cannot be checked counts as there');
  // Per-device limits: the 7th tap in a minute and the 31st in an hour are refused.
  for (let i = 0; i < VERDICTS_PER_MINUTE; i++) { assert.equal(g.check('d1'), null); g.noteTap('d1'); }
  assert.equal(g.check('d1').status, 429);
  clock.t += MIN;
  assert.equal(g.check('d1'), null);
  for (let i = VERDICTS_PER_MINUTE; i < VERDICTS_PER_HOUR; i++) { g.noteTap('d1'); clock.t += 11e3; }
  assert.match(g.check('d1')?.error ?? '', /hour/);
  assert.equal(g.check('d2'), null, 'per device');
  // Ten refusals in ten minutes lock the device out for ten minutes, reported once.
  for (let i = 0; i < REFUSALS_FOR_LOCKOUT - 1; i++) g.noteRefusal('d2', 'ipad');
  assert.equal(g.check('d2'), null);
  g.noteRefusal('d2', 'ipad');
  assert.match(g.check('d2').error, /locked out/);
  assert.deepEqual(events.at(-1), { kind: 'approvals-lockout', device: 'ipad' });
  clock.t += LOCKOUT_MS;
  assert.equal(g.check('d2'), null, 'over after ten minutes');
  // Refusals with no device lock nobody out; past ten they are reported once a window.
  for (let i = 0; i < 25; i++) g.noteAnonymousRefusal();
  assert.equal(g.check('d3'), null);
  assert.equal(events.filter(e => e.kind === 'approvals-anonymous').length, 1);
  // More than three allows in five minutes: one alert.
  for (let i = 0; i < ALLOW_BURST; i++) g.noteAllow();
  assert.ok(!events.some(e => e.kind === 'approvals-burst'));
  g.noteAllow();
  g.noteAllow();
  assert.equal(events.filter(e => e.kind === 'approvals-burst').length, 1);
  // A flood of open requests: Deny-only for a while, reported.
  g.noteOpenCount(FLOOD_OPEN);
  assert.ok(!events.some(e => e.kind === 'approvals-flood'));
  g.noteOpenCount(FLOOD_OPEN + 1);
  assert.deepEqual(g.reasonsNow({ denyOnly: [] }), ['too many requests at once']);
});

test('a classifier block in the lead\'s session makes cards Deny-only for 15 minutes; another agent\'s does not; a recent block says why it is asking (M3/M6)', () => {
  const clock = { t: 1794380000000 };
  const g = createApprovals({ mode: 'on', now: () => clock.t, isLead: id => id !== 'other-agent' });
  const p = { tool: 'Bash', description: 'd', inputPreview: '{"command":"ls"}', state: 'open', denyOnly: [] };
  assert.equal(g.view(p).canAllow, true);
  assert.equal(g.noteBlock({ sessionId: 'other-agent', tool: 'Bash', reason: '[Data Exfiltration]' }), false);
  assert.equal(g.view(p).canAllow, true);
  assert.equal(g.noteBlock({ sessionId: 'lead', tool: 'Bash', reason: '[Data Exfiltration]' }), true);
  assert.deepEqual(g.view(p), { mode: 'on', denyOnly: ['auto mode blocked something in the last 15 minutes'], canAllow: false });
  assert.equal(g.status().denyOnlyUntil, clock.t + BLOCK_WINDOW_MS);
  assert.equal(g.assess(p).why, 'Auto mode refused this Bash call (Data Exfiltration), so Claude Code is asking you');
  assert.equal(g.assess({ ...p, tool: 'Read' }).why, null, 'only for the same tool');
  clock.t += 2 * MIN + 1;
  assert.equal(g.assess(p).why, null, 'only right after the block');
  clock.t += BLOCK_WINDOW_MS - 2 * MIN - 2;
  assert.equal(g.view(p).canAllow, false);
  clock.t += 1;
  assert.equal(g.view(p).canAllow, true);
  assert.equal(g.status().denyOnlyUntil, null);
  assert.equal(createApprovals({ mode: 'deny' }).view(p).canAllow, false, 'never in deny mode');
});

// ---- the store ----

test('store: a new channel session expires open requests; a repeated id in one session opens an unanswerable `repeat`; relayedAt drives expiry; a late one is the terminal\'s (L7, L9, G5)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appr-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    await store.load();
    const closed = [];
    store.subscribe(e => { if (e.type === 'permission-closed') closed.push([e.request.requestId, e.request.state]); });
    const a = await store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'd', inputPreview: '{"command":"ls"}' });
    const again = await store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'changed', inputPreview: '{"command":"rm"}' });
    assert.equal(again.state, 'repeat');
    assert.notEqual(again, a);
    assert.equal(store.permission('abcde'), again, 'the id finds its newest entry');
    assert.match((await store.answerPermission('abcde', 'deny', 'phone')).error, /terminal/);
    assert.equal(store.openPermissions().length, 1, 'the first is still open');
    store.newPermissionSession();
    assert.deepEqual(closed, [['abcde', 'expired']]);
    assert.equal(store.openPermissions().length, 0);
    const fresh = await store.openPermission({ requestId: 'abcde', tool: 'Bash', description: 'd', inputPreview: '{"command":"ls"}' });
    assert.equal(fresh.state, 'open', 'the same id in a new session is a new request');
    // Expiry counts from relayedAt, not from when it reached the server.
    const r = await store.openPermission({ requestId: 'fghij', tool: 'Bash', description: 'd', inputPreview: '{}', relayedAt: clock.t - 90e3 });
    assert.equal(r.state, 'open');
    assert.equal(store.publicPermission(r).expiresAt, clock.t - 90e3 + PERMISSION_TTL_MS);
    clock.t += PERMISSION_TTL_MS - 90e3;
    assert.equal(store.permission('fghij').state, 'expired');
    // Over two minutes old on arrival: late, shown, never answerable here.
    const late = await store.openPermission({ requestId: 'kmnop', tool: 'Bash', description: 'd', inputPreview: '{}', relayedAt: clock.t - LATE_AFTER_MS - 1 });
    assert.equal(late.state, 'late');
    assert.equal((await store.answerPermission('kmnop', 'deny', 'phone')).status, 409);
    const edge = await store.openPermission({ requestId: 'qrstu', tool: 'Bash', description: 'd', inputPreview: '{}', relayedAt: clock.t - LATE_AFTER_MS });
    assert.equal(edge.state, 'open', 'exactly two minutes is still answerable');
    // A clock far ahead is ignored; a little ahead counts as now.
    const ahead = await store.openPermission({ requestId: 'vwxyz', tool: 'Bash', description: 'd', inputPreview: '{}', relayedAt: clock.t + 3600e3 });
    assert.equal(ahead.relayedAt, clock.t);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('store: the shown hash must match; the verdict line carries answeredAt, tool, hash and the Deny-only flag; a secret-shaped description never reaches the disk (G3, G4, L12)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appr-'));
  try {
    const clock = { t: 1794380000000 };
    const store = createChatStore({ dir, now: () => clock.t });
    await store.load();
    const secret = ['sk', 'ant', 'api03', 'Q'.repeat(30)].join('-');
    const p = await store.openPermission({ requestId: 'abcde', tool: 'Bash', description: `use ${secret}`, inputPreview: '{"command":"ls"}' }, { assess: () => ({ denyOnly: ['x'], why: null }) });
    const onDisk = (await Promise.all((await readdir(dir)).filter(n => n.startsWith('messages-')).map(n => readFile(join(dir, n), 'utf8')))).join('');
    assert.ok(!onDisk.includes(secret), 'not on disk');
    assert.match(onDisk, /looked like it held a secret/);
    assert.equal(p.description, `use ${secret}`, 'the card still shows it from memory');
    assert.equal((await store.answerPermission('abcde', 'deny', 'phone', { requireShown: true })).status, 409, 'no hash');
    assert.equal((await store.answerPermission('abcde', 'deny', 'phone', { shown: 'f'.repeat(64) })).status, 409, 'a stale card');
    assert.equal((await store.answerPermission('abcde', 'allow', 'phone', { shown: shownHash(p.tool, p.description, p.inputPreview), allowProblem: () => 'no' })).status, 403);
    assert.equal(store.permission('abcde').state, 'open', 'a refusal changes nothing');
    clock.t += 5000;
    const ok = await store.answerPermission('abcde', 'deny', 'phone', { shown: shownHash(p.tool, p.description, p.inputPreview), requireShown: true });
    assert.equal(ok.ok, true);
    const v = store.list({ after: 0 }).find(m => m.kind === 'verdict');
    assert.deepEqual(v.meta, { requestId: 'abcde', behavior: 'deny', answeredAt: clock.t, tool: 'Bash', shown: shownHash(p.tool, p.description, p.inputPreview), denyOnly: true });
    assert.deepEqual(toInbound(v), { type: 'verdict', seq: v.seq, requestId: 'abcde', behavior: 'deny', answeredAt: clock.t, device: 'phone' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the verdict stream carries only the owner\'s verdicts that name their request (L8)', () => {
  const base = { seq: 3, id: 'm_abcdef1', at: 1, kind: 'verdict', text: 'allow', device: 'phone' };
  assert.equal(toInbound({ ...base, from: 'jarvis', meta: { requestId: 'abcde', behavior: 'allow' } }), null);
  assert.equal(toInbound({ ...base, from: 'system', meta: { requestId: 'abcde', behavior: 'allow' } }), null);
  assert.equal(toInbound({ ...base, from: 'jeff', meta: null }), null, 'the text alone never makes one');
  assert.equal(toInbound({ ...base, from: 'jeff', meta: { behavior: 'allow' } }), null);
  assert.equal(toInbound({ ...base, from: 'jeff', meta: { requestId: 'abcde', behavior: 'yes' } }), null);
  assert.equal(toInbound({ ...base, from: 'jeff', meta: { requestId: 'abcde', behavior: 'allow' } }).answeredAt, null, 'an old line without answeredAt: the channel drops it');
});

// ---- the routes, on real sockets ----

const call = ({ socketPath, port, method = 'GET', path, headers = {}, body }) => new Promise((resolve, reject) => {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = request({
    ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }), method, path,
    headers: { ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...headers }
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, json, text }); });
  });
  req.on('error', reject);
  if (raw) req.write(raw);
  req.end();
});

const PAGE_HOST = 'jos.example.test';
const PAGE = { host: PAGE_HOST, origin: `https://${PAGE_HOST}`, 'sec-fetch-site': 'same-origin' };

async function setup({ mode = 'on' } = {}) {
  const env = { clock: { t: 1794380000000 }, events: [], files: new Set() };
  env.dir = await mkdtemp(join(tmpdir(), 'appr-'));
  const now = () => env.clock.t;
  const onEvent = e => env.events.push(e);
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  env.devices = createDeviceStore({ path: join(env.dir, 'devices.json'), now, onEvent });
  await env.devices.load();
  env.approvals = createApprovals({ mode, killPath: '/k/approvals-off', exists: p => env.files.has(p), now, onEvent, home: HOME, realpath: noReal, isLead: id => id !== 'other' });
  env.socket = createSocketRouter({ store: env.store, now, onEvent, log: () => {}, pingMs: 60, approvals: env.approvals, verifyRestart: async () => ({ ok: true }) });
  env.routes = createChatRoutes({ store: env.store, devices: env.devices, socket: env.socket, config: { allowedHosts: [PAGE_HOST] }, now, onEvent, log: () => {}, pingMs: 60, approvals: env.approvals });
  env.sockPath = join(env.dir, 'c.sock');
  env.adminPath = join(env.dir, 'a.sock');
  env.servers = [createServer((q, s) => env.socket.handler(q, s)), createServer((q, s) => createAdminRouter({ devices: env.devices, onEvent })(q, s)), createServer((q, s) => env.routes.handler(q, s))];
  await new Promise(r => env.servers[0].listen(env.sockPath, r));
  await new Promise(r => env.servers[1].listen(env.adminPath, r));
  await new Promise(r => env.servers[2].listen(0, '127.0.0.1', r));
  env.port = env.servers[2].address().port;
  const pair = async name => {
    const s = await env.devices.start(name);
    await env.devices.approve(s.code, { by: 'test' });
    const r = await env.devices.status(`${PAIR_COOKIE_NAME}=${s.pairToken}`);
    return `${COOKIE_NAME}=${r.token}`;
  };
  env.phone = await pair('phone');
  env.ipad = await pair('ipad');
  env.mark = (device, on) => call({ socketPath: env.adminPath, method: 'POST', path: '/admin/approver', body: { device, on } });
  const h = await call({ socketPath: env.sockPath, method: 'POST', path: '/v1/hello', body: { pid: 1 } });
  env.token = h.json.token;
  env.unix = opts => call({ socketPath: env.sockPath, ...opts, headers: { [SESSION_HEADER]: env.token, ...(opts.headers ?? {}) } });
  env.open = (requestId, preview = { command: 'ls' }, extra = {}) => env.unix({ method: 'POST', path: '/v1/permission-request', body: { requestId, tool: 'Bash', description: 'list', inputPreview: JSON.stringify(preview), relayedAt: env.clock.t, ...extra } });
  env.shown = id => { const p = env.store.permission(id); return shownHash(p.tool, p.description, p.inputPreview); };
  // `shown` defaults to the right hash; passing `shown: undefined` leaves it out.
  env.tap = (id, cookie, behavior, opts = {}) => {
    const shown = 'shown' in opts ? opts.shown : env.store.permission(id) ? env.shown(id) : 'f'.repeat(64);
    return call({ port: env.port, method: 'POST', path: `/api/chat/permission/${id}`, headers: { ...(opts.headers ?? PAGE), ...(cookie ? { cookie } : {}) }, body: { behavior, ...(shown === undefined ? {} : { shown }) } });
  };
  env.close = async () => { for (const s of env.servers) await new Promise(r => s.close(r)); await rm(env.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  return env;
}

test('mode off (the default): both permission routes answer 403 and nothing is stored (H2)', async () => {
  const env = await setup({ mode: 'off' });
  try {
    const r = await env.open('abcde');
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'approvals are off on this server' });
    assert.equal(env.store.size, 0);
    const v = await env.tap('abcde', env.phone, 'allow', { shown: 'f'.repeat(64) });
    assert.equal(v.status, 403);
    const anon = await env.tap('abcde', null, 'allow', { shown: 'f'.repeat(64) });
    assert.equal(anon.status, 403, 'off answers before any device check');
    // A server with no gate at all is off too.
    const bare = createSocketRouter({ store: env.store, log: () => {} });
    assert.equal(typeof bare.handler, 'function');
  } finally { await env.close(); }
});

test('mode deny: a card opens and Deny works, but Allow is refused server-side even from an approver (A0, M4)', async () => {
  const env = await setup({ mode: 'deny' });
  try {
    assert.equal((await env.open('abcde')).status, 200);
    await env.mark('phone', true);
    const allow = await env.tap('abcde', env.phone, 'allow');
    assert.equal(allow.status, 403);
    assert.match(allow.json.error, /Deny only/);
    assert.equal(env.store.permission('abcde').state, 'open');
    const st = await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } });
    assert.equal(st.json.openPermission.canAllow, false);
    assert.equal(st.json.approvals.mode, 'deny');
    const deny = await env.tap('abcde', env.ipad, 'deny');
    assert.equal(deny.status, 200, deny.text);
    assert.deepEqual(env.events.filter(e => e.kind === 'verdict').map(e => [e.behavior, e.device]), [['denied', 'ipad']]);
  } finally { await env.close(); }
});

test('the kill file turns both routes off without a restart', async () => {
  const env = await setup();
  try {
    assert.equal((await env.open('abcde')).status, 200);
    env.files.add('/k/approvals-off');
    assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 403);
    assert.equal((await env.open('fghij')).status, 403);
    env.files.delete('/k/approvals-off');
    assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 200);
    assert.deepEqual(env.events.filter(e => e.kind === 'approvals-kill').map(e => e.on), [true, false]);
  } finally { await env.close(); }
});

test('Allow needs mode on, an approver device, the right Origin, the shown hash and no Deny-only reason; each refusal changes nothing and counts toward the lockout', async () => {
  const env = await setup();
  try {
    await env.open('abcde');
    assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 403, 'not an approver');
    assert.equal((await env.mark('phone', true)).status, 200);
    assert.deepEqual(env.events.filter(e => e.kind === 'approver-changed').map(e => [e.device.name, e.on]), [['phone', true]]);
    for (const headers of [{ host: PAGE_HOST }, { ...PAGE, origin: 'https://evil.example' }, { ...PAGE, origin: 'null' }, { ...PAGE, origin: `http://${PAGE_HOST}`, host: PAGE_HOST }, { ...PAGE, 'sec-fetch-site': 'cross-site' }]) {
      const r = await env.tap('abcde', env.phone, 'allow', { headers });
      assert.ok([403].includes(r.status), `${JSON.stringify(headers)}: ${r.status} ${r.text}`);
    }
    assert.equal((await env.tap('abcde', env.phone, 'allow', { shown: undefined })).status, 400);
    assert.equal((await env.tap('abcde', env.phone, 'allow', { shown: 'e'.repeat(64) })).status, 409);
    assert.equal(env.store.permission('abcde').state, 'open', 'nothing changed');
    // A Deny-only request: Allow refused, Deny fine.
    await env.open('fghij', { command: 'sudo ls' });
    const risky = await env.tap('fghij', env.phone, 'allow');
    assert.equal(risky.status, 403);
    assert.match(risky.json.error, /terminal or in Discord/);
    clock(env, MIN);
    const ok = await env.tap('abcde', env.phone, 'allow');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(env.store.permission('abcde').state, 'allowed');
  } finally { await env.close(); }
});
const clock = (env, ms) => { env.clock.t += ms; };

test('limits: the 7th tap in a minute is 429; ten refusals lock the device out for ten minutes, alerted; refusals with no device lock nobody out', async () => {
  const env = await setup();
  try {
    await env.open('abcde');
    for (let i = 0; i < 6; i++) assert.equal((await env.tap('abcde', env.phone, 'deny', { shown: '0'.repeat(64) })).status, 409);
    assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 429, 'the 7th in a minute');
    // 7 refusals so far; three more in the window lock it out.
    clock(env, MIN);
    for (let i = 0; i < 3; i++) await env.tap('abcde', env.phone, 'deny', { shown: '0'.repeat(64) });
    assert.deepEqual(env.events.filter(e => e.kind === 'approvals-lockout'), [{ kind: 'approvals-lockout', device: 'phone' }]);
    clock(env, MIN);
    const locked = await env.tap('abcde', env.phone, 'deny');
    assert.equal(locked.status, 429);
    assert.match(locked.json.error, /locked out/);
    // Anonymous refusals: twenty 401s, and the iPad still answers.
    for (let i = 0; i < 20; i++) assert.equal((await env.tap('abcde', null, 'deny')).status, 401);
    assert.equal(env.events.filter(e => e.kind === 'approvals-anonymous').length, 1);
    assert.equal((await env.tap('abcde', env.ipad, 'deny')).status, 200);
  } finally { await env.close(); }
});

test('a classifier block in the lead\'s session: Allow is Deny-only for 15 minutes, the status says until when, and the card says why it asked', async () => {
  const env = await setup();
  try {
    await env.mark('phone', true);
    env.approvals.noteBlock({ sessionId: 'lead', tool: 'Bash', reason: '[Irreversible Local Destruction]' });
    await env.open('abcde');
    const st = await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } });
    assert.equal(st.json.approvals.denyOnlyUntil, env.clock.t + BLOCK_WINDOW_MS);
    assert.equal(st.json.openPermission.canAllow, false);
    assert.equal(st.json.openPermission.why, 'Auto mode refused this Bash call (Irreversible Local Destruction), so Claude Code is asking you');
    assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 403);
    clock(env, BLOCK_WINDOW_MS - 2 * MIN);
    await env.open('fghij');
    clock(env, 2 * MIN);
    assert.equal((await env.tap('fghij', env.phone, 'allow')).status, 200, 'after the window, Allow again');
  } finally { await env.close(); }
});

test('a hello from a new channel process expires the open requests; the holder\'s own re-hello keeps them (L7)', async () => {
  const env = await setup();
  try {
    await env.open('abcde');
    const again = await env.unix({ method: 'POST', path: '/v1/hello', body: { pid: 1 } });
    env.token = again.json.token;
    assert.equal(env.store.permission('abcde').state, 'open', 'a reconnect keeps it');
    clock(env, HEARTBEAT_FRESH_MS);
    const other = await call({ socketPath: env.sockPath, method: 'POST', path: '/v1/hello', body: { pid: 2 } });
    assert.equal(other.status, 200);
    assert.equal(env.store.permission('abcde').state, 'expired');
    assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 409);
  } finally { await env.close(); }
});

test('first answer wins across devices; a late request is shown but answered only at the terminal; a revoke clears the approver mark', async () => {
  const env = await setup();
  try {
    await env.mark('phone', true);
    await env.mark('ipad', true);
    await env.open('abcde');
    const [a, b] = await Promise.all([env.tap('abcde', env.phone, 'allow'), env.tap('abcde', env.ipad, 'deny')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.match(loser.json.error, /already (allowed|denied) by (phone|ipad)/);
    assert.equal(env.store.list({ after: 0 }).filter(m => m.kind === 'verdict').length, 1);
    const late = await env.open('fghij', { command: 'ls' }, { relayedAt: env.clock.t - LATE_AFTER_MS - 1000 });
    assert.equal(late.json.state, 'late');
    assert.equal((await env.tap('fghij', env.phone, 'deny')).status, 409);
    const devs = env.devices.list();
    await env.devices.revoke(devs.find(d => d.name === 'ipad').id, 'test');
    assert.equal(env.devices.list().find(d => d.name === 'ipad').approver, false);
  } finally { await env.close(); }
});

test('admin: the approver mark by name or id; unknown 404, two of one name 409, unchanged is not reported', async () => {
  const env = await setup();
  try {
    assert.equal((await env.mark('nobody', true)).status, 404);
    assert.equal((await env.mark('phone', 'yes')).status, 400);
    const id = env.devices.list().find(d => d.name === 'ipad').id;
    assert.deepEqual((await env.mark(id, true)).json, { ok: true, changed: true, device: { id, name: 'ipad', approver: true } });
    assert.equal((await env.mark('ipad', true)).json.changed, false);
    assert.equal(env.events.filter(e => e.kind === 'approver-changed').length, 1);
    const s = await env.devices.start('ipad');
    await env.devices.approve(s.code, { by: 'test' });
    await env.devices.status(`${PAIR_COOKIE_NAME}=${s.pairToken}`);
    assert.equal((await env.mark('ipad', false)).status, 409);
    const list = await call({ socketPath: env.adminPath, path: '/admin/devices' });
    assert.deepEqual(list.json.devices.map(d => d.approver), [false, true, false]);
  } finally { await env.close(); }
});

test('a padded preview over 16,000 code points is cut, marked on the card and Deny-only', async () => {
  const env = await setup();
  try {
    await env.mark('phone', true);
    const r = await env.open('abcde', { command: 'ls', content: 'x'.repeat(FIELD_MAX) });
    assert.equal(r.status, 200);
    const p = env.store.permission('abcde');
    assert.equal(p.cut, true);
    assert.ok(p.inputPreview.endsWith(cutMarker(JSON.stringify({ command: 'ls', content: 'x'.repeat(FIELD_MAX) }).length - FIELD_MAX)));
    assert.ok(p.denyOnly.includes('it was cut short'));
    assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 403);
    const fromChannel = await env.open('fghij', { command: 'ls' }, { cut: true });
    assert.equal(fromChannel.status, 200);
    assert.ok(env.store.permission('fghij').denyOnly.includes('it was cut short'), 'the channel\'s own cut counts');
  } finally { await env.close(); }
});
