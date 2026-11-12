// Approvals as buttons (docs/design/2026-11-11-jarvis-os-approvals.md, with Ultron's
// 11-11 findings H1-H2, M3-M6 and L7-L12): the pure rules in lib/approvals.mjs, the
// store's permission entries, and the two routes run on real sockets with their own
// servers. Every name, path and id is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { existsSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  revealHidden, readApprovalsConfig, capField, markerReasons, parsePreview, shownHash, pathForms, denyOnlyReasons, blockReasonWords,
  verdictOriginProblem, createApprovals, cutMarker, NO_EXACT, okWriteFolder, protectedWhy, sensitiveWhy, FIELD_MAX, BLOCK_WINDOW_MS, LATE_AFTER_MS, VERDICTS_PER_MINUTE,
  VERDICTS_PER_HOUR, REFUSALS_FOR_LOCKOUT, LOCKOUT_MS, ALLOW_BURST, FLOOD_OPEN
} from '../lib/approvals.mjs';
import { createChatStore, PERMISSION_TTL_MS } from '../lib/chat-store.mjs';
import { createDeviceStore, COOKIE_NAME, PAIR_COOKIE_NAME } from '../lib/chat-devices.mjs';
import { createSocketRouter, toInbound, SESSION_HEADER, HEARTBEAT_FRESH_MS } from '../lib/chat-socket.mjs';
import { createChatRoutes, createAdminRouter } from '../lib/chat-routes.mjs';
import { chatEventLine, ALERTED_KINDS } from '../lib/chat-events.mjs';

const MIN = 60e3;
const HOME = '/home/owner';
const noReal = () => null;
const rules = (tool, preview, extra = {}) => denyOnlyReasons({ tool, description: 'd', inputPreview: typeof preview === 'string' ? preview : JSON.stringify(preview), ...extra }, { home: HOME, realpath: noReal });
const bash = cmd => rules('Bash', { command: cmd });

// ---- the pure rules ----

test('config: off unless "deny" or "on"; anything else is off with a problem; extra Deny-only patterns are lower-cased', () => {
  assert.deepEqual(readApprovalsConfig({}), { mode: 'off', patterns: [], bash: 'deny', bashCommands: [], writeFolders: [], writeProtected: [], problems: [] });
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

// ---- Ultron's 11-11 build review: folding, non-ASCII, the write allowlist, the lows ----

const APP = '/home/owner/Projects/app';
const REPO = '/home/owner/Projects/claude-control-room';
const WRITE = ['~/Projects/app', '/home/owner/Projects/site'];
// "exact" mode with the hook's report in hand: `strict(cmd)` judges a command whose exact
// text is `cmd` (tier 1, the strict grammar). No test here touches the disk: `isLink` and
// `isExecutable` are stand-ins.
const strictOpts = { home: HOME, realpath: noReal, bash: 'exact', writeFolders: WRITE, repoRoot: REPO, isExecutable: p => p.endsWith('.sh') || p.endsWith('/bin/tool'), isLink: () => false };
const strict = cmd => denyOnlyReasons({ tool: 'Bash', description: 'd', inputPreview: JSON.stringify({ command: cmd }) }, { ...strictOpts, exact: cmd });
const has = (list, re) => list.some(r => re.test(r));
const cp = n => String.fromCodePoint(n);

test('Bash is Deny-only on the page by default: a relayed command may have lost its line breaks (finding 1)', () => {
  for (const cmd of ['ls', 'pwd', 'git status', `cat ${APP}/notes.txt`, 'cat notes.txt rm -rf ~/Projects']) {
    assert.ok(has(bash(cmd), /Bash is answered at the terminal or in Discord/), cmd);
  }
  assert.equal(readApprovalsConfig({}).bash, 'deny', 'the default');
  assert.equal(readApprovalsConfig({ chat: { approvalsBash: 'exact' } }).bash, 'exact');
  for (const bad of ['on', 'allow', true, 'EXACT', 'strict']) {
    const r = readApprovalsConfig({ chat: { approvalsBash: bad } });
    assert.equal(r.bash, 'deny', String(bad));
    assert.equal(r.problems.length, 1);
  }
  // The gate carries the mode through.
  const off = createApprovals({ mode: 'on', home: HOME, realpath: noReal });
  assert.ok(off.assess({ tool: 'Bash', inputPreview: '{"command":"pwd"}' }).denyOnly.length > 0);
  // "exact" without a report from the hook is still Deny-only (the hook never decides).
  const on = createApprovals({ mode: 'on', home: HOME, realpath: noReal, bash: 'exact' });
  assert.deepEqual(on.assess({ tool: 'Bash', inputPreview: '{"command":"pwd"}' }).denyOnly, [NO_EXACT]);
});

test('Bash tier 1, the strict grammar over the exact text: a listed command, only its own options, every other word an absolute path (findings 1 and 4)', () => {
  const ok = [
    'pwd', 'date', 'date -u', 'ls', 'ls -la', `ls -la ${APP}`, `cat ${APP}/README.md`, `cat -n ${APP}/a ${APP}/b`,
    `head -n 5 ${APP}/a`, `head -n5 ${APP}/a`, `tail -20 ${APP}/a`, `tail -c 100 ${APP}/a`, `wc -l ${APP}/a`, `stat ${APP}/a`, `file ${APP}/a`,
    `du -sh ${APP}`, 'df -h', `diff -u ${APP}/a ${APP}/b`, `touch ${APP}/new.txt`, `mkdir -p ${APP}/out/x`, 'touch ~/Projects/app/x',
    'git status', 'git status --short', `git -C ${APP} status`, 'git diff --stat', 'git diff --cached', 'git log --oneline -5', 'git log -n 5',
    'git show --stat HEAD', 'git show 0123abc', 'git rev-parse --short HEAD', 'git diff HEAD~2 HEAD'
  ];
  for (const cmd of ok) assert.deepEqual(strict(cmd), [], cmd);
  const deny = {
    // The folded two-liners: line breaks arrive as single spaces.
    'cat notes.txt rm -rf ~/Projects': /not an absolute path|not one of cat's/,
    [`cat ${APP}/notes.txt rm -rf ~/Projects`]: /"rm" is not an absolute path/,
    [`cat ${APP}/notes.txt rm ${APP}/x`]: /"rm" is not an absolute path/,
    [`cat ${APP}/a ${APP}/deploy.sh`]: /a file that can be run/,
    [`ls ${APP} ${APP}/bin/tool ${APP}/x`]: /a file that can be run/,
    [`ls ${APP} /usr/bin/id`]: /system folder/, 'cat /dev/urandom': /system folder/, 'cat /etc/hosts': /system folder/,
    [`cat ${APP}/a /opt/homebrew/bin/node ${APP}/x.js`]: /homebrew/i,
    'pwd rm -rf /home/owner/Projects/app': /pwd takes no/,
    [`git status rm ${APP}/x`]: /git status/,
    'git show rm': /git show/,
    [`touch ${APP}/a chmod 755 ${APP}/a`]: /"chmod" is not an absolute path/,
    // Free words can't be told from a second command, so these are out even here.
    'grep -n TODO /home/owner/Projects/app/a': /"grep" is not on the short list/,
    'rg --hostname-bin=/home/owner/x TODO': /"rg" is not on the short list/,
    'echo hi': /"echo" is not on the short list/, 'which node': /not on the short list/,
    // Options: only each command's own, exactly; an attached value is refused.
    [`cat -f/home/owner/x ${APP}/a`]: /not one of cat's/, [`ls --color=always ${APP}`]: /not one of ls's/,
    [`head -n x ${APP}/a`]: /-n needs a number/, [`head -n ${APP}/a`]: /-n needs a number/,
    [`tail -f ${APP}/a`]: /not one of tail's/, [`diff --output=/tmp/x ${APP}/a ${APP}/b`]: /not one of diff's/,
    [`mkdir -m 777 ${APP}/x`]: /not one of mkdir's/, [`du -I x ${APP}`]: /not one of du's/,
    'git push': /only git status/, 'git -c core.pager=x status': /git/, 'git diff --output=/tmp/x': /not one of git diff's/,
    'git log --format=%H': /not one of git log's/, 'git diff main': /git diff/, 'git show HEAD 0123abc': /git show takes only/, 'git status HEAD': /git status takes only/, [`git -C ${APP}`]: /only git status/,
    'git -C app status': /not an absolute path/,
    // touch and mkdir need absolute paths.
    'touch scratch.txt': /not an absolute path/, 'mkdir -p out/x': /not an absolute path/, 'cat README.md': /not an absolute path/,
    'cat': /cat needs/, [`diff ${APP}/a`]: /diff needs/, 'ls ~root': /not an absolute path/,
    // Shell syntax, as before.
    'ls; rm x': /shell syntax/, 'ls | sh': /shell syntax/, 'ls && rm x': /shell syntax/, 'echo $HOME': /shell syntax/, 'echo `id`': /shell syntax/,
    'ls > f': /shell syntax/, 'cat < f': /shell syntax/, 'ls (x)': /shell syntax/, 'ls\nrm x': /more than one line/, "cat '.ssh/id'": /shell syntax/,
    'cat .s\\sh/id': /shell syntax/, 'cat ~/.ss?/id': /shell syntax/, 'ls\t-la': /more than one line, or a tab/, [`cat ${APP}/a\n`]: /more than one line/,
    'rm -rf /tmp/x': /not on the short list/, 'bash -c ls': /not on the short list/, 'sudo ls': /not on the short list/, 'Ls': /not on the short list/, '/bin/ls': /not on the short list/
  };
  for (const [cmd, re] of Object.entries(deny)) assert.ok(has(strict(cmd), re), `${cmd}: ${strict(cmd).join('; ')}`);
  assert.ok(has(rules('Bash', { description: 'no command' }), /no command/));
});

test('Bash writes (touch, mkdir) pass only inside the write folders; reads pass the read rules', () => {
  assert.ok(has(strict('touch /home/owner/elsewhere/a'), /outside the folders/));
  assert.ok(has(strict('mkdir -p /home/owner/Projects/jarvis/x'), /outside the folders|jarvis repo/));
  assert.ok(has(strict('touch ~/.local/state/jarvis-os/approvals-allow'), /outside the folders/));
  assert.ok(has(strict(`touch ${APP}/approvals-allow`), /flag name/));
  assert.ok(has(strict(`mkdir ${APP}/.git/hooks`), /\.git folder/));
  assert.deepEqual(strict('cat /home/owner/elsewhere/a'), [], 'a read is not held to the write folders');
  assert.ok(has(strict('cat /home/owner/.ssh/config'), /\.ssh/));
  assert.ok(has(strict('ls /home/owner'), /holds protected/));
});

test('non-ASCII in a Bash command or any path is Deny-only: APFS folds what Node does not (finding 2)', () => {
  const longS = cp(0x17f), kelvin = cp(0x212a), wideS = cp(0xff53), wideH = cp(0xff48);
  const why = /outside plain ASCII/;
  for (const cmd of [`cat ~/.${longS}sh/id_x`, `cat ~/.z${longS}hrc`, `ls ~/Library/LaunchAgent${longS}`, `cat ~/.doc${kelvin}er/config.json`, `cat ~/.${wideS}${wideS}${wideH}/config`, `cat ${APP}/caf${cp(0xe9)}.txt`]) {
    assert.ok(has(strict(cmd), why), `strict: ${Array.from(cmd).map(c => c.codePointAt(0).toString(16)).join(' ')}`);
    assert.ok(has(bash(cmd), why), 'and in the default mode');
  }
  const w = (tool, input) => denyOnlyReasons({ tool, inputPreview: JSON.stringify(input) }, strictOpts);
  for (const p of [`/home/owner/.${longS}sh/authorized_keys`, `${APP}/.git/hoo${kelvin}s/pre-commit`, `${APP}/${wideS}rc/a.js`, `/home/owner/Library/LaunchAgent${longS}/x.plist`]) {
    assert.ok(has(w('Write', { file_path: p, content: 'x' }), why), 'Write');
    assert.ok(has(w('Edit', { file_path: p, old_string: 'a', new_string: 'b' }), why), 'Edit');
    assert.ok(has(w('Read', { file_path: p }), why), 'Read');
    assert.ok(has(w('Grep', { pattern: 'x', path: p }), why), 'Grep');
    assert.ok(has(w('Glob', { pattern: '*.js', path: p }), why), 'Glob path');
    assert.ok(has(w('mcp__plugin_jarvis-channel_jarvis__reply', { text: 'x', files: [p] }), why), 'files');
  }
  assert.ok(has(w('Glob', { pattern: `**/.${longS}sh/*`, path: APP }), why), 'Glob pattern');
  assert.ok(has(w('Grep', { pattern: 'x', path: APP, glob: `*.p${cp(0xff45)}m` }), why), 'Grep glob');
  assert.ok(has(w('NotebookEdit', { notebook_path: `${APP}/n${longS}.ipynb`, new_source: 'x' }), why));
  // Content is not a path: non-ASCII there is fine.
  assert.deepEqual(w('Write', { file_path: `${APP}/notes.md`, content: `caf${cp(0xe9)} ${longS}` }), []);
  assert.deepEqual(w('Grep', { pattern: `caf${cp(0xe9)}`, path: APP }), []);
  // A control character in a path is refused the same way (a tab, a DEL).
  assert.ok(has(w('Read', { file_path: `${APP}/a\tb` }), why));
});

test('the real path comes from realpathSync.native, which folds names the way the disk does (finding 2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appr-real-'));
  try {
    await mkdir(join(dir, 'ssh'));
    const real = realpathSync.native(dir);
    const asked = join(dir, cp(0x17f) + 'sh', 'x');
    const forms = pathForms(asked, { home: HOME }).forms;
    // Only a disk that folds the long s (APFS does) finds the folder under that name.
    const folds = existsSync(join(dir, cp(0x17f) + 'sh'));
    if (folds) assert.ok(forms.includes(join(real, 'ssh', 'x').toLowerCase()), 'the stored name, not the one asked for');
    else console.log('approvals: this disk does not fold the long s; the native real path was not exercised');
    assert.equal(folds, process.platform === 'darwin', 'macOS folds it');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writes (Write, Edit, MultiEdit, NotebookEdit) pass only inside config\'s write folders, and the protected list still applies inside them (finding 3, the owner\'s option b)', () => {
  const w = (tool, input, opts = strictOpts) => denyOnlyReasons({ tool, inputPreview: JSON.stringify(input) }, opts);
  const write = (p, opts) => w('Write', { file_path: p, content: 'x' }, opts);
  assert.deepEqual(write(`${APP}/notes.md`), []);
  assert.deepEqual(write('~/Projects/app/src/a.js'), []);
  assert.deepEqual(write('/home/owner/PROJECTS/APP/notes.md'), [], 'the disk ignores case');
  assert.deepEqual(write('/home/owner/Projects/site/index.html'), []);
  assert.deepEqual(w('Edit', { file_path: `${APP}/a.js`, old_string: 'a', new_string: 'b', replace_all: true }), []);
  assert.deepEqual(w('MultiEdit', { file_path: `${APP}/a.js`, edits: [{ old_string: 'a', new_string: 'b' }] }), []);
  assert.deepEqual(w('NotebookEdit', { notebook_path: `${APP}/a.ipynb`, new_source: 'x', cell_id: 'c1' }), []);
  for (const p of ['/home/owner/notes.md', '/home/owner/Projects/app2/a', '/home/owner/Projects/other/a', '/tmp/x', '/home/owner/Projects/apple', '/home/owner/Projects']) {
    assert.ok(has(write(p), /outside the folders/), p);
    assert.ok(has(w('Edit', { file_path: p, old_string: 'a', new_string: 'b' }), /outside the folders/), p);
    assert.ok(has(w('NotebookEdit', { notebook_path: p, new_source: 'x' }), /outside the folders/), p);
  }
  // The safe default: no folders, so no page Allow for any write.
  assert.ok(has(write(`${APP}/notes.md`, { home: HOME, realpath: noReal }), /outside the folders/));
  // A symlink out of a write folder: the real path is judged too.
  const link = { ...strictOpts, realpath: p => (p === `${APP}/link` ? '/home/owner/elsewhere' : null) };
  assert.ok(has(write(`${APP}/link/a`, link), /outside the folders/));
  // A write folder that is itself a link: its real path counts as inside.
  const linked = { ...strictOpts, realpath: p => (p.startsWith(APP) ? p.replace(APP, '/vol/app') : null) };
  assert.deepEqual(write(`${APP}/a.md`, linked), []);
  // The second layer, inside a write folder.
  const inside = {
    [`${APP}/.git/config`]: /\.git folder/, [`${APP}/.claude/settings.json`]: /\.claude folder/, [`${APP}/.mcp.json`]: /\.mcp\.json/,
    [`${APP}/.github/workflows/ci.yml`]: /workflow/, [`${APP}/.worktrees/x/a`]: /worktrees/, [`${APP}/.env`]: /\.env/,
    [`${APP}/sub/approvals-enabled`]: /flag name/, [`${APP}/channel-enabled`]: /flag name/, [`${APP}/approvals-off`]: /flag name/, [`${APP}/anything-off`]: /flag name/,
    [`${APP}/.zshrc`]: /shell startup/, [`${APP}/a/../../jarvis/x`]: /\.\./
  };
  for (const [p, re] of Object.entries(inside)) assert.ok(has(write(p), re), `${p}: ${write(p).join('; ')}`);
  // Even when config lists them, these stay out.
  const wide = { ...strictOpts, writeFolders: ['~/Projects', `${REPO}/docs`, '~/.config', '/opt/homebrew/etc'] };
  const never = {
    '/home/owner/Projects/jarvis/bin/x': /jarvis repo/, '/home/owner/Projects/machine-setup/a': /machine-setup/, '/home/owner/Projects/.worktrees/a/b': /worktrees/,
    [`${REPO}/server/lib/a.mjs`]: /Control Room's own code/, [`${REPO}/web/src/a.js`]: /Control Room's own code/, [`${REPO}/bin/chat-pair`]: /Control Room's own code|chat-pair/,
    [`${REPO}/mod/a.ts`]: /Control Room's own code/, [`${REPO}/server/config.json`]: /config/, '/home/owner/.config/git/config': /git settings/, '/home/owner/.config/gh/hosts.yml': /GitHub CLI/,
    '/opt/homebrew/etc/x': /Homebrew/
  };
  for (const [p, re] of Object.entries(never)) assert.ok(has(write(p, wide), re), `${p}: ${write(p, wide).join('; ')}`);
  assert.deepEqual(write(`${REPO}/docs/a.md`, wide), [], 'the repo\'s docs are not its code');
  assert.ok(has(write('notes.md'), /absolute path/));
  assert.ok(has(write('~root/x'), /absolute path/));
});

test('config: the write folders must be absolute, plain and narrower than the home folder; a bad entry is dropped with a problem', () => {
  const read = folders => readApprovalsConfig({ chat: { approvalsWriteFolders: folders } }, { home: HOME });
  assert.deepEqual(readApprovalsConfig({}).writeFolders, [], 'the default allows no page writes');
  assert.deepEqual(read(['~/Projects/app', '/home/owner/Projects/site/']).writeFolders, ['~/Projects/app', '/home/owner/Projects/site/']);
  for (const bad of ['Projects/app', '~', '~/', '/', '/home', '/home/owner', '/home/owner/', '/HOME/owner', '~/a/../b', '~/a*', `~/caf${cp(0xe9)}`, '', 7, null, '~other/x']) {
    const r = read(['~/Projects/app', bad]);
    assert.deepEqual(r.writeFolders, ['~/Projects/app'], String(bad));
    assert.equal(r.problems.length, 1, String(bad));
  }
  assert.deepEqual(read('~/Projects/app').writeFolders, []);
  assert.equal(read('~/Projects/app').problems.length, 1);
  assert.equal(read(Array.from({ length: 41 }, (_, i) => `~/p${i}`)).writeFolders.length, 0, 'too many is ignored whole');
});

test('read and write are both Deny-only for the account, git, cloud and tool settings (finding 3)', () => {
  const w = (tool, input) => denyOnlyReasons({ tool, inputPreview: JSON.stringify(input) }, { ...strictOpts, writeFolders: ['~/Projects', '~/.config', '~/.aws', '~/.docker', '~/.cloudflared', '~/.local', '/opt/homebrew'] });
  const places = ['/home/owner/.claude.json', '/home/owner/.claude.json.backup', '/home/owner/.gitconfig', '/home/owner/.config/git/ignore', '/home/owner/.config/gh/hosts.yml',
    '/home/owner/.cloudflared/cert.json', '/home/owner/.aws/credentials', '/home/owner/.docker/config.json', '/home/owner/.local/bin/tool', '/opt/homebrew/bin/node', '/home/owner/.tmux.conf',
    '/home/owner/.claude/.credentials.json'];
  for (const p of places) {
    assert.ok(w('Read', { file_path: p }).length > 0, `Read ${p}`);
    assert.ok(w('Write', { file_path: p, content: 'x' }).some(r => !/outside the folders/.test(r)), `Write ${p}: ${w('Write', { file_path: p, content: 'x' }).join('; ')}`);
    assert.ok(w('Grep', { pattern: 'x', path: p }).length > 0, `Grep ${p}`);
    assert.ok(has(strict(`cat ${p}`), /reads|touches/), `cat ${p}`);
  }
  // A search root above them covers them.
  for (const root of ['/', '/home', '/home/owner', '/home/owner/.config', '/home/owner/.local', '/home/owner/.claude', '/opt', '/home/owner/.local/state']) {
    assert.ok(has(w('Grep', { pattern: 'KEY', path: root }), /holds protected/), `Grep ${root}`);
    assert.ok(has(w('Glob', { pattern: '**/*', path: root }), /holds protected/), `Glob ${root}`);
  }
  assert.deepEqual(w('Grep', { pattern: 'KEY', path: '/home/owner/Projects/app' }), []);
});

test('Read, Glob and Grep: absolute literal paths; wildcards only in the last part of a pattern; the channels folder, ~/.ssh, .env files and keys stay out (finding 4)', () => {
  const r = (tool, input) => denyOnlyReasons({ tool, inputPreview: JSON.stringify(input) }, strictOpts);
  for (const p of ['/home/owner/.claude/channels/discord/access.json', '/home/owner/.ssh/config', '/home/owner/app/.env', '/home/owner/app/.env.local', '/home/owner/k.pem', '/home/owner/id_ed25519', '/home/owner/.netrc']) {
    assert.ok(r('Read', { file_path: p }).length > 0, p);
  }
  assert.deepEqual(r('Read', { file_path: `${APP}/README.md`, offset: 1, limit: 20 }), []);
  assert.deepEqual(r('Read', { file_path: '/home/owner/.claude/agent-memory/x.md' }), [], 'reading other .claude files is fine');
  assert.ok(has(r('Read', { file_path: 'README.md' }), /absolute path/));
  assert.ok(has(r('Read', { file_path: `${APP}/a/../../../.ssh/id` }), /\.\./), '.. in an absolute path');
  assert.ok(has(r('Read', {}), /absolute path/));
  // Glob and Grep: the folder.
  assert.deepEqual(r('Glob', { pattern: 'src/**/*.js', path: APP }), []);
  assert.deepEqual(r('Glob', { pattern: '**/*', path: '~/Projects/app' }), []);
  assert.deepEqual(r('Grep', { pattern: 'TODO', path: APP, glob: '*.js', output_mode: 'content', '-n': true }), []);
  assert.deepEqual(r('Grep', { pattern: 'a.*b[0-9]?', path: APP }), [], 'the search pattern itself is free');
  assert.ok(has(r('Glob', { pattern: '**/*.js' }), /absolute folder/), 'no folder: the working folder is not known here');
  assert.ok(has(r('Grep', { pattern: 'x' }), /absolute folder/));
  assert.ok(has(r('Grep', { pattern: 'x', path: 'src' }), /absolute folder/));
  assert.ok(r('Grep', { pattern: 'x', path: '/home/owner/.ssh' }).length > 0);
  for (const path of ['/home/owner/.s*', '/home/owner/.ss?', '/home/owner/.[s]sh', '/home/owner/{.ssh,x}', `${APP}/*/secrets`]) {
    assert.ok(has(r('Glob', { pattern: '*', path }), /wildcard/), `Glob ${path}`);
    assert.ok(has(r('Grep', { pattern: 'x', path }), /wildcard/), `Grep ${path}`);
  }
  assert.ok(has(r('Grep', { pattern: 'x', path: `${APP}/../../.ssh` }), /\.\./));
  // The patterns: relative, literal folders (or a whole **), wildcards in the last part only.
  for (const pattern of ['**/.s*/id_rsa', '.s*h/**', 'a/*/b/*.js', '**/.e[n]v/x', '{.ssh,src}/x', '/home/owner/.ssh/*', '~/.ssh/*', '../*', 'a/../../*', '**/.ssh/*', '.ssh/**', '**/.env', '.claude/channels/**']) {
    assert.ok(r('Glob', { pattern, path: APP }).length > 0, `Glob ${pattern}`);
    assert.ok(r('Grep', { pattern: 'x', path: APP, glob: pattern }).length > 0, `Grep glob ${pattern}`);
  }
  for (const pattern of ['/home/owner/Projects/other/*.js', '~/Projects/other/*.js', '~']) {
    assert.ok(has(r('Glob', { pattern, path: APP }), /names its own folder/), `Glob ${pattern}`);
    assert.ok(has(r('Grep', { pattern: 'x', path: APP, glob: pattern }), /names its own folder/), `Grep glob ${pattern}`);
  }
  // Grep reads what its glob picks: only a plain `*.ext` (or a literal name) there, never one that picks key or .env files.
  for (const glob of ['*.pem', '**/*.key', '.e*', '.env*', 'id_*', '*', '**/*', '*.p?m', '.env', 'id_rsa']) {
    assert.ok(r('Grep', { pattern: 'x', path: APP, glob }).length > 0, `Grep glob ${glob}`);
  }
  for (const glob of ['*.js', '**/*.mjs', 'src/**/*.test.js', 'README.md']) assert.deepEqual(r('Grep', { pattern: 'x', path: APP, glob }), [], glob);
  // Glob lists names only, so any last part is fine.
  for (const pattern of ['*', '**/*', 'src/*.{js,ts}', 'a/b/c?.txt']) assert.deepEqual(r('Glob', { pattern, path: APP }), [], pattern);
});

test('input keys outside each tool\'s short list are Deny-only; so is a hidden character in any parsed field (finding 4)', () => {
  const r = (tool, input) => denyOnlyReasons({ tool, inputPreview: typeof input === 'string' ? input : JSON.stringify(input) }, tool === 'Bash' ? { ...strictOpts, exact: 'pwd' } : strictOpts);
  const extra = [
    ['Bash', { command: 'pwd', run_in_background: true }], ['Bash', { command: 'pwd', dangerouslyDisableSandbox: true }],
    ['Write', { file_path: `${APP}/a`, content: 'x', mode: '0777' }], ['Edit', { file_path: `${APP}/a`, old_string: 'a', new_string: 'b', path: '/x' }],
    ['Read', { file_path: `${APP}/a`, follow: true }], ['Glob', { pattern: '*', path: APP, root: '/' }], ['Grep', { pattern: 'x', path: APP, '--pre': 'sh' }],
    ['WebFetch', { url: 'https://github.com/a', prompt: 'p', headers: {} }], ['WebSearch', { query: 'q', site: 'x' }],
    ['NotebookEdit', { notebook_path: `${APP}/a.ipynb`, new_source: 'x', file_path: '/home/owner/.zshrc' }],
    ['mcp__plugin_jarvis-channel_jarvis__reply', { text: 'x', path: '/x' }]
  ];
  for (const [tool, input] of extra) assert.ok(has(r(tool, input), /is not one this tool is known to take/), `${tool} ${Object.keys(input).join(',')}: ${r(tool, input).join('; ')}`);
  assert.deepEqual(r('Bash', { command: 'pwd', description: 'where', timeout: 1000 }), []);
  assert.deepEqual(r('Read', { file_path: `${APP}/a.pdf`, pages: '1-5', allow_large: true }), []);
  assert.deepEqual(r('WebSearch', { query: 'node test runner', allowed_domains: ['nodejs.org'] }), []);
  assert.deepEqual(r('mcp__plugin_jarvis-channel_jarvis__reply', { chat_id: 'jos', text: 'hi', reply_to: 'm_1' }), []);
  assert.deepEqual(r('mcp__plugin_discord_discord__react', { chat_id: '1', message_id: '2', emoji: 'ok' }), []);
  assert.ok(r('mcp__plugin_discord_discord__reply', { files: ['/home/owner/.ssh/id_rsa'] }).length > 0);
  assert.ok(has(r('mcp__plugin_discord_discord__reply', { text: 'x', files: ['notes.md'] }), /absolute path/));
  assert.ok(has(r('mcp__plugin_discord_discord__reply', { text: 'x', files: '/home/owner/a' }), /files/));
  assert.ok(has(r('Write', { file_path: [`${APP}/a`], content: 'x' }), /absolute path/), 'a path that is not text');
  // A hidden character written as a JSON escape is not in the preview's own text, only in the parsed field.
  const escaped = '{"file_path":"/home/owner/Projects/app/a.md","content":"safe \\u202e txt.exe"}';
  assert.ok(!escaped.includes(cp(0x202e)) && !markerReasons(escaped).length, 'the raw text carries no hidden character');
  assert.ok(r('Write', escaped).includes('it carries invisible or direction characters'));
  assert.deepEqual(parsePreview(escaped).fields[1], ['content', 'safe ⟦U+202E⟧ txt.exe'], 'and the card shows it');
  assert.ok(r('Bash', '{"command":"pwd","description":"a\\u200bb"}').includes('it carries invisible or direction characters'));
  assert.ok(r('Edit', '{"file_path":"/home/owner/Projects/app/a","old_string":"a","new_string":"b","replace_all":false,"old\\u2066string":"x"}').includes('it carries invisible or direction characters'), 'a key');
  assert.ok(r('MultiEdit', '{"file_path":"/home/owner/Projects/app/a","edits":[{"old_string":"a","new_string":"b\\u0007"}]}').includes('it carries invisible or direction characters'), 'nested');
  assert.equal(parsePreview('{"edits":[{"new_string":"b\\u202e"}]}').fields[0][1].includes('⟦U+202E⟧'), true);
});

test('WebFetch, WebSearch and unknown tools, as before', () => {
  assert.deepEqual(rules('WebFetch', { url: 'https://code.claude.com/docs/en/hooks.md', prompt: 'p' }), []);
  assert.ok(has(rules('WebFetch', { url: 'https://code.claude.com/docs?x=1' }), /query/));
  assert.ok(has(rules('WebFetch', { url: 'https://evil.example/' }), /short list of sites/));
  assert.ok(has(rules('WebFetch', { url: 'http://code.claude.com/' }), /https/));
  assert.ok(has(rules('WebFetch', { url: 'https://u:p@github.com/' }), /https/));
  assert.deepEqual(rules('WebSearch', { query: 'node test runner' }), []);
  for (const t of ['TodoWrite', 'Agent', 'mcp__other__tool', 'KillShell']) assert.ok(has(rules(t, { x: 1 }), /does not know/), t);
});

test('paths: ~ and case are folded, a trailing slash dropped, .. reported, and a link\'s real path judged too', () => {
  assert.deepEqual(pathForms('~/a/B/', { home: HOME, realpath: noReal }), { relative: false, dotdot: false, forms: ['/home/owner/a/b'] });
  assert.equal(pathForms('~/a/../B', { home: HOME, realpath: noReal }).dotdot, true, '.. counts in an absolute path too');
  assert.equal(pathForms('/a/..', { home: HOME, realpath: noReal }).dotdot, true);
  assert.equal(pathForms('/a/..b/c', { home: HOME, realpath: noReal }).dotdot, false, 'a name that only starts with dots');
  assert.equal(pathForms('a/../b', { home: HOME, realpath: noReal }).dotdot, true);
  const link = denyOnlyReasons({ tool: 'Read', inputPreview: JSON.stringify({ file_path: '/home/owner/link/id_x' }) }, { home: HOME, realpath: p => (p === '/home/owner/link' ? '/home/owner/.ssh' : null) });
  assert.ok(has(link, /\.ssh/), link.join('; '));
  const protectedReads = ['/home/owner/.CLAUDE/channels/x', '/home/owner/.local/state/jarvis-os/launch.json', '/home/owner/.SSH/config'];
  for (const p of protectedReads) assert.ok(rules('Read', { file_path: p }).length > 0, p);
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
  assert.equal(g.mode(), 'deny', 'until the channel says it delivers Allow, on counts as deny');
  assert.equal(g.serverMode(), 'on');
  g.noteChannelRelay('allow');
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
  g.noteChannelRelay('allow');
  const p = { tool: 'Read', description: 'd', inputPreview: '{"file_path":"/home/owner/Projects/app/a"}', state: 'open', denyOnly: [] };
  assert.equal(g.view(p).canAllow, true);
  assert.equal(g.noteBlock({ sessionId: 'other-agent', tool: 'Read', reason: '[Data Exfiltration]' }), false);
  assert.equal(g.view(p).canAllow, true);
  assert.equal(g.noteBlock({ sessionId: 'lead', tool: 'Read', reason: '[Data Exfiltration]' }), true);
  assert.deepEqual(g.view(p), { mode: 'on', denyOnly: ['auto mode blocked something in the last 15 minutes'], canAllow: false });
  assert.equal(g.status().denyOnlyUntil, clock.t + BLOCK_WINDOW_MS);
  assert.equal(g.assess(p).why, 'Auto mode refused this Read call (Data Exfiltration), so Claude Code is asking you');
  assert.equal(g.assess({ ...p, tool: 'Glob' }).why, null, 'only for the same tool');
  clock.t += 2 * MIN + 1;
  assert.equal(g.assess(p).why, null, 'only right after the block');
  clock.t += BLOCK_WINDOW_MS - 2 * MIN - 2;
  assert.equal(g.view(p).canAllow, false);
  clock.t += 1;
  assert.equal(g.view(p).canAllow, true);
  assert.equal(g.status().denyOnlyUntil, null);
  assert.equal(createApprovals({ mode: 'deny' }).view(p).canAllow, false, 'never in deny mode');
});

test('the channel\'s relay mode: unless it says allow, "on" counts as deny here; a change after the first report is an event (finding 5)', () => {
  const events = [];
  const g = createApprovals({ mode: 'on', onEvent: e => events.push(e), home: HOME, realpath: noReal });
  const p = { tool: 'Read', description: 'd', inputPreview: '{"file_path":"/home/owner/Projects/app/a"}', state: 'open', denyOnly: [] };
  assert.deepEqual(g.view(p), { mode: 'deny', denyOnly: ['the channel has not said it can deliver Allow'], canAllow: false }, 'before any hello');
  assert.deepEqual(g.status(), { mode: 'deny', relay: 'unknown', denyOnlyUntil: null });
  for (const said of [undefined, null, '', 'ALLOW', 'on', 1, true, 'off']) {
    g.noteChannelRelay(said);
    assert.equal(g.view(p).canAllow, false, String(said));
    assert.equal(g.mode(), 'deny', String(said));
  }
  assert.equal(g.status().relay, 'off');
  g.noteChannelRelay('deny');
  assert.deepEqual(g.view(p), { mode: 'deny', denyOnly: ['the channel delivers Deny only'], canAllow: false });
  assert.deepEqual(g.reasonsNow(p), ['the channel delivers Deny only'], 'the verdict route refuses Allow with this');
  g.noteChannelRelay('allow');
  assert.deepEqual(g.view(p), { mode: 'on', denyOnly: [], canAllow: true });
  assert.deepEqual(g.status(), { mode: 'on', relay: 'allow', denyOnlyUntil: null });
  g.noteChannelRelay('allow');
  assert.deepEqual(events.filter(e => e.kind === 'approvals-relay').slice(-2), [{ kind: 'approvals-relay', relay: 'deny', previous: 'off' }, { kind: 'approvals-relay', relay: 'allow', previous: 'deny' }], 'no event for the same mode again');
  assert.equal(events.filter(e => e.kind === 'approvals-relay')[0].previous, 'unknown', 'none for the first report');
  // The channel's word never raises the server's own mode.
  const deny = createApprovals({ mode: 'deny' });
  deny.noteChannelRelay('allow');
  assert.equal(deny.mode(), 'deny');
  const off = createApprovals({ mode: 'off' });
  off.noteChannelRelay('allow');
  assert.equal(off.mode(), 'off');
});

test('a channel under its test switch is offered Deny only, and each such hello is an event (channel 0.4.6, board 1bede46d)', () => {
  const events = [];
  const said = () => events.filter(e => e.kind === 'approvals-test-channel').length;
  const g = createApprovals({ mode: 'on', onEvent: e => events.push(e), home: HOME, realpath: noReal });
  const p = { tool: 'Read', description: 'd', inputPreview: '{"file_path":"/home/owner/Projects/app/a"}', state: 'open', denyOnly: [] };
  g.noteChannelRelay('allow');
  assert.equal(g.view(p).canAllow, true, 'a hello with no `test` (a channel before 0.4.6) is not test mode');
  assert.equal(g.noteChannelTest(false), false);
  assert.equal(g.noteChannelTest(undefined), false);
  assert.deepEqual(g.view(p), { mode: 'on', denyOnly: [], canAllow: true });
  assert.equal(said(), 0);
  // true, and anything else that is not plainly false: Deny only, with the reason on the card.
  let n = 0;
  for (const v of [true, 'false', 0, null, 1, 'yes', {}]) {
    assert.equal(g.noteChannelTest(v), true, String(v));
    assert.equal(g.mode(), 'deny', String(v));
    assert.deepEqual(g.view(p), { mode: 'deny', denyOnly: ['the channel runs in test mode'], canAllow: false }, String(v));
    assert.deepEqual(g.reasonsNow(p), ['the channel runs in test mode'], 'the verdict route refuses Allow with this');
    assert.equal(said(), ++n, 'each such hello is reported');
  }
  assert.deepEqual(g.status(), { mode: 'deny', relay: 'allow', denyOnlyUntil: null }, 'the relay it reports is kept as said');
  // The next channel is not in test mode: Allow is back, with nothing more to report.
  g.noteChannelTest(false);
  assert.deepEqual(g.view(p), { mode: 'on', denyOnly: [], canAllow: true });
  assert.equal(said(), n);
  // It never raises the server's own mode, and is reported whatever that mode is.
  for (const mode of ['deny', 'off']) {
    const seen = [];
    const other = createApprovals({ mode, onEvent: e => seen.push(e) });
    other.noteChannelRelay('allow');
    other.noteChannelTest(true);
    assert.equal(other.mode(), mode);
    assert.deepEqual(seen, [{ kind: 'approvals-test-channel' }]);
  }
  // Only a scratch harness, in code, may take a test channel's Allow; config has no key for it.
  const seen = [];
  const harness = createApprovals({ mode: 'on', onEvent: e => seen.push(e), home: HOME, realpath: noReal, testChannelOk: true });
  harness.noteChannelRelay('allow');
  assert.equal(harness.noteChannelTest(true), true);
  assert.deepEqual(harness.view(p), { mode: 'on', denyOnly: [], canAllow: true });
  assert.deepEqual(seen, []);
  // Only `true` itself turns the cap off.
  for (const ok of ['true', 1, 'yes', {}]) {
    const almost = createApprovals({ mode: 'on', home: HOME, realpath: noReal, testChannelOk: ok });
    almost.noteChannelRelay('allow');
    almost.noteChannelTest(true);
    assert.equal(almost.view(p).canAllow, false, String(ok));
  }
  assert.ok(!('testChannelOk' in readApprovalsConfig({ chat: { approvals: 'on', testChannelOk: true, approvalsTestChannelOk: true } })));
  // And nothing in the server but the gate itself knows the option's name.
  const serverDir = new URL('..', import.meta.url);
  const sources = [new URL('server.mjs', serverDir), new URL('routes.mjs', serverDir), ...readdirSync(new URL('lib/', serverDir)).filter(f => f.endsWith('.mjs') && f !== 'approvals.mjs').map(f => new URL(`lib/${f}`, serverDir))];
  assert.ok(sources.length > 40);
  for (const file of sources) assert.ok(!readFileSync(file, 'utf8').includes('testChannelOk'), `${file.pathname} names the harness option`);
  // The event has its words and is sent as an alert (lib/chat-events.mjs, which server.mjs uses).
  assert.match(chatEventLine({ kind: 'approvals-test-channel' }), /^a chat channel said hello in test mode: page approvals are Deny only/);
  assert.ok(ALERTED_KINDS.includes('approvals-test-channel') && ALERTED_KINDS.includes('approvals-relay'));
  assert.match(readFileSync(new URL('server.mjs', serverDir), 'utf8'), /const chatEvents = createChatEventHandler\(\{/);
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

async function setup(opts = {}) {
  const { mode = 'on' } = opts;
  // An explicit `relay: undefined` is a hello that names no mode.
  const relay = 'relay' in opts ? opts.relay : 'allow';
  const env = { clock: { t: 1794380000000 }, events: [], files: new Set() };
  env.dir = await mkdtemp(join(tmpdir(), 'appr-'));
  const now = () => env.clock.t;
  const onEvent = e => env.events.push(e);
  env.store = createChatStore({ dir: join(env.dir, 'chat'), now });
  await env.store.load();
  env.devices = createDeviceStore({ path: join(env.dir, 'devices.json'), now, onEvent });
  await env.devices.load();
  env.approvals = createApprovals({ mode, killPath: '/k/approvals-off', exists: p => env.files.has(p), now, onEvent, home: HOME, realpath: noReal, isLead: id => id !== 'other', isLink: () => false, isExecutable: () => false, ...(opts.gate ?? {}) });
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
  // `test` goes in the hello only when the test names it (a channel before 0.4.6 sends none).
  const h = await call({ socketPath: env.sockPath, method: 'POST', path: '/v1/hello', body: { pid: 1, relay, ...('test' in opts ? { test: opts.test } : {}) } });
  env.token = h.json.token;
  env.unix = opts => call({ socketPath: env.sockPath, ...opts, headers: { [SESSION_HEADER]: env.token, ...(opts.headers ?? {}) } });
  // A request the page may allow by default: a Read inside a plain project folder.
  env.open = (requestId, preview = { file_path: '/home/owner/Projects/app/README.md' }, extra = {}) => env.unix({ method: 'POST', path: '/v1/permission-request', body: { requestId, tool: 'command' in preview ? 'Bash' : 'Read', description: 'list', inputPreview: JSON.stringify(preview), relayedAt: env.clock.t, ...extra } });
  env.shown = id => { const p = env.store.permission(id); return shownHash(p.tool, p.description, p.inputPreview, p.exact); };
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
    env.approvals.noteBlock({ sessionId: 'lead', tool: 'Read', reason: '[Irreversible Local Destruction]' });
    await env.open('abcde');
    const st = await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } });
    assert.equal(st.json.approvals.denyOnlyUntil, env.clock.t + BLOCK_WINDOW_MS);
    assert.equal(st.json.openPermission.canAllow, false);
    assert.equal(st.json.openPermission.why, 'Auto mode refused this Read call (Irreversible Local Destruction), so Claude Code is asking you');
    assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 403);
    clock(env, BLOCK_WINDOW_MS - 2 * MIN);
    await env.open('fghij');
    clock(env, 2 * MIN);
    assert.equal((await env.tap('fghij', env.phone, 'allow')).status, 200, 'after the window, Allow again');
  } finally { await env.close(); }
});

test('the channel in deny (or silent about its mode): the card is Deny-only and Allow is refused; a heartbeat carries a change (finding 5)', async () => {
  for (const relay of ['deny', undefined, 'off', 'yes']) {
    const env = await setup({ relay });
    try {
      await env.mark('phone', true);
      await env.open('abcde');
      const st = await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } });
      assert.equal(st.json.approvals.mode, 'deny', String(relay));
      assert.equal(st.json.approvals.relay, relay === 'deny' || relay === 'off' ? relay : 'unknown');
      assert.equal(st.json.openPermission.canAllow, false);
      assert.ok(st.json.openPermission.denyOnly.some(r => /the channel/.test(r)));
      const refused = await env.tap('abcde', env.phone, 'allow');
      assert.equal(refused.status, 403, String(relay));
      assert.equal(env.store.permission('abcde').state, 'open');
      // The channel's flags changed while it ran: its next heartbeat says so.
      assert.equal((await env.unix({ method: 'POST', path: '/v1/heartbeat', body: { pid: 1, relay: 'allow' } })).status, 200);
      assert.equal((await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } })).json.openPermission.canAllow, true);
      // A heartbeat that says nothing changes nothing; one that says deny takes Allow away.
      assert.equal((await env.unix({ method: 'POST', path: '/v1/heartbeat', body: { pid: 1 } })).status, 200);
      assert.equal(env.approvals.mode(), 'on');
      assert.equal((await env.unix({ method: 'POST', path: '/v1/heartbeat' })).status, 200, 'no body at all');
      assert.equal(env.approvals.mode(), 'on');
      await env.unix({ method: 'POST', path: '/v1/heartbeat', body: { pid: 1, relay: 'deny' } });
      assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 403);
      assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 200, 'Deny still works');
    } finally { await env.close(); }
  }
});

test('a hello that says test mode: the card is Deny-only and Allow is refused, even from an approver; a hello that says false gets Allow back (channel 0.4.6)', async () => {
  for (const test of [true, 'yes', null]) {
    const env = await setup({ test });
    try {
      await env.mark('phone', true);
      assert.deepEqual(env.events.filter(e => e.kind === 'approvals-test-channel'), [{ kind: 'approvals-test-channel' }], String(test));
      await env.open('abcde');
      const st = await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } });
      assert.deepEqual(st.json.approvals, { mode: 'deny', relay: 'allow', denyOnlyUntil: null }, 'it said allow, and is capped all the same');
      assert.equal(st.json.openPermission.canAllow, false);
      assert.deepEqual(st.json.openPermission.denyOnly, ['the channel runs in test mode']);
      const refused = await env.tap('abcde', env.phone, 'allow');
      assert.equal(refused.status, 403, String(test));
      assert.match(refused.json.error, /Deny only/);
      assert.equal(env.store.permission('abcde').state, 'open');
      // A heartbeat that says allow lifts nothing: test mode is the hello's word.
      await env.unix({ method: 'POST', path: '/v1/heartbeat', body: { pid: 1, relay: 'allow', test: false } });
      assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 403);
      assert.equal((await env.tap('abcde', env.phone, 'deny')).status, 200, 'Deny still works');
      // The same channel says hello again, not in test mode: Allow is offered.
      const again = await env.unix({ method: 'POST', path: '/v1/hello', body: { pid: 1, relay: 'allow', test: false } });
      env.token = again.json.token;
      await env.open('fghij');
      assert.equal((await call({ port: env.port, path: '/api/chat/status', headers: { cookie: env.phone } })).json.openPermission.canAllow, true);
      assert.equal((await env.tap('fghij', env.phone, 'allow')).status, 200);
      assert.equal(env.events.filter(e => e.kind === 'approvals-test-channel').length, 1);
    } finally { await env.close(); }
  }
  // A hello with no `test`, and one that says false, are offered Allow as before.
  for (const opts of [{}, { test: false }]) {
    const env = await setup(opts);
    try {
      await env.mark('phone', true);
      await env.open('abcde');
      assert.equal((await env.tap('abcde', env.phone, 'allow')).status, 200);
      assert.equal(env.events.filter(e => e.kind === 'approvals-test-channel').length, 0);
    } finally { await env.close(); }
  }
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

// ---- Ultron's final read (2026-11-11): code inside the write folders, reply files, the lows ----

// Invented stand-ins for the kinds of repo the owner's write folders hold: a tool that
// scheduled jobs run, a posting agent, a site, a data repo, a contact form.
const P = '/home/owner/Projects';
const FINAL_WRITE = [`${P}/league`, `${P}/league-data`, `${P}/post-agent`, `${P}/contact`, `${P}/content`, `${P}/site`, `${REPO}/docs`];
const FINAL_PROTECTED = [
  '~/Projects/league/ops', '~/Projects/league/src', '~/Projects/league/tests', '~/Projects/league/leagues', '~/Projects/league/data/browser-profile',
  '~/Projects/post-agent/scripts', '~/Projects/post-agent/launchd', '~/Projects/post-agent/drafts', '~/Projects/post-agent/config.json',
  '~/Projects/site/scripts', '~/Projects/league-data/MANIFEST.sha256'
];
const finalOpts = { home: HOME, realpath: noReal, writeFolders: FINAL_WRITE, writeProtected: FINAL_PROTECTED, repoRoot: REPO, isExecutable: () => false, isLink: () => false };
const wr = (p, opts = finalOpts) => denyOnlyReasons({ tool: 'Write', inputPreview: JSON.stringify({ file_path: p, content: 'x' }) }, opts);
const ed = (p, opts = finalOpts) => denyOnlyReasons({ tool: 'Edit', inputPreview: JSON.stringify({ file_path: p, old_string: 'a', new_string: 'b' }) }, opts);
const rd = (p, opts = finalOpts) => denyOnlyReasons({ tool: 'Read', inputPreview: JSON.stringify({ file_path: p }) }, opts);

test('the second layer: every write Ultron showed as allowed is now Deny-only, by a generic rule or by config\'s protected places (board 97332dd5)', () => {
  const deny = {
    [`${P}/league/ops/run_alert.sh`]: /config protects/,
    [`${P}/league/src/sffl/cli.py`]: /config protects/,
    [`${P}/league/tests/test_cli.py`]: /config protects/,
    [`${P}/league/leagues/one/settings.json`]: /config protects/,
    [`${P}/league/.venv/lib/python3.12/site-packages/x.pth`]: /\.venv folder/,
    [`${P}/post-agent/scripts/draft.mjs`]: /config protects/,
    [`${P}/post-agent/launchd/job.plist`]: /config protects/,
    [`${P}/post-agent/drafts/pending/abc123.json`]: /config protects/,
    [`${P}/post-agent/config.json`]: /config protects/,
    [`${P}/post-agent/skill.md`]: /by its name \(skill\.md\)/,
    [`${P}/league/CLAUDE.md`]: /by its name \(claude\.md\)/,
    [`${P}/league/.gitignore`]: /by its name/,
    [`${P}/contact/wrangler.jsonc`]: /by its name/,
    [`${P}/site/.github/dependabot.yml`]: /\.github folder/,
    [`${P}/site/.github/workflows/deploy.yml`]: /workflow/,
    [`${P}/site/scripts/build.mjs`]: /config protects/,
    [`${P}/league-data/MANIFEST.sha256`]: /config protects/,
    [`${P}/league/data/browser-profile/Default/Cookies`]: /browser profile|config protects/
  };
  for (const [p, re] of Object.entries(deny)) {
    assert.ok(has(wr(p), re), `Write ${p}: ${wr(p).join('; ')}`);
    assert.ok(has(ed(p), re), `Edit ${p}`);
    assert.ok(!has(wr(p), /outside the folders/), `${p} is inside a write folder: only the second layer stops it`);
  }
  // What stays writable: the notes, docs and content these folders are listed for.
  for (const p of [`${P}/league/docs/plan.md`, `${P}/league/README.md`, `${P}/league/data/notes.csv`, `${P}/post-agent/topics.md`, `${P}/post-agent/docs/voice.md`, `${P}/site/content/posts/a.md`,
    `${P}/site/src/pages/index.astro`, `${P}/content/a.md`, `${P}/league-data/README.md`, `${P}/contact/README.md`, `${REPO}/docs/design/a.md`, `${P}/league/opsnotes.md`, `${P}/post-agent/scripts.md`]) {
    assert.deepEqual(wr(p), [], p);
    assert.deepEqual(ed(p), [], p);
  }
  // Config's places are compared lower-cased, and by the real path too.
  assert.ok(has(wr(`${P}/League/OPS/x.sh`), /config protects/));
  const alias = { ...finalOpts, realpath: p => (p === `${P}/league/alias` ? `${P}/league/src` : null) };
  assert.ok(has(wr(`${P}/league/alias/a.py`, alias), /config protects/), 'a folder that is a link into a protected place');
  const moved = { ...finalOpts, writeFolders: [...FINAL_WRITE, '/vol/work'], realpath: p => (p === `${P}/league/src` ? '/vol/work/src' : null) };
  assert.ok(has(wr('/vol/work/src/a.py', moved), /config protects/), 'a protected place that is itself a link: its real path is protected too');
  // Without the config entries only the generic rules hold: the runbook's values matter.
  const generic = { ...finalOpts, writeProtected: [] };
  assert.deepEqual(wr(`${P}/post-agent/scripts/draft.mjs`, generic), []);
  assert.ok(has(wr(`${P}/league/.venv/x.pth`, generic), /\.venv folder/));
  // Reads are not held to the write layer.
  assert.deepEqual(rd(`${P}/league/src/sffl/cli.py`), []);
  assert.deepEqual(rd(`${P}/league/CLAUDE.md`), []);
  // A bad entry in a call is ignored there; config's reader fails closed (below).
  assert.deepEqual(wr(`${P}/league/docs/a.md`, { ...finalOpts, writeProtected: ['league/docs', 7, '~/a/../b'] }), []);
  assert.deepEqual(wr(`${P}/league/docs/a.md`, { ...finalOpts, writeProtected: 'not a list' }), []);
});

test('the second layer, generic: folders and file names that tools load or run without being asked, in any write folder', () => {
  const A = `${P}/content`;
  for (const seg of ['.venv', 'node_modules', '.husky', '.github']) {
    assert.ok(has(wr(`${A}/${seg}/x`), new RegExp(`a \\${seg.startsWith('.') ? seg : seg} folder`.replace('\\n', 'n'))), seg);
    assert.ok(has(wr(`${A}/deep/${seg}/y/z.js`), /folder/), seg);
    assert.equal(protectedWhy(`${A}/${seg}`.toLowerCase(), HOME, REPO), `a ${seg} folder`);
  }
  const names = ['CLAUDE.md', 'AGENTS.md', 'skill.md', 'SKILL.md', '.gitignore', '.gitattributes', '.gitmodules', 'package.json', 'package-lock.json', 'pyproject.toml',
    'requirements.txt', 'requirements-dev.txt', 'requirements_test.txt', 'setup.py', 'setup.cfg', 'conftest.py', 'sitecustomize.py', 'usercustomize.py', 'evil.pth', 'Makefile', 'GNUmakefile',
    'wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'com.example.job.plist', '.envrc', '_headers', '_redirects'];
  for (const n of names) {
    assert.ok(has(wr(`${A}/${n}`), /by its name|\.env/), `${n}: ${wr(`${A}/${n}`).join('; ')}`);
    assert.ok(has(wr(`${A}/sub/dir/${n}`), /by its name|\.env/), `nested ${n}`);
  }
  // Near names stay writable.
  for (const n of ['claude.md.txt', 'notes-claude.md', 'skills.md', 'mypackage.json', 'package.json5', 'requirements.md', 'requirements.txt.bak', 'setup.py.md', 'a.pth.md', 'makefile.md', 'plist.md', 'headers', 'redirects.md', 'venv/a.md', 'github/a.md']) {
    assert.deepEqual(wr(`${A}/${n}`), [], n);
  }
  // The browser profile and the Wrangler state are private for reads as well.
  assert.ok(has(rd(`${P}/league/data/browser-profile/Default/Cookies`), /reads a browser profile/));
  assert.ok(has(rd(`${P}/site/.wrangler/state/v3/d1/x.sqlite`), /Wrangler/));
  assert.ok(has(wr(`${P}/site/.wrangler/tmp/x`), /Wrangler/));
});

// ---- The go-live patch (2026-11-11): Ultron's high (board 97332dd5) and medium (669ea1d2) ----

test('the go-live patch: Python modules, compiled code and CLAUDE.local.md are Deny-only for a write, in any write folder (board 97332dd5)', () => {
  // A module beside a job's entry point is imported ahead of the standard library's
  // (json.py), and the next Claude Code session obeys a CLAUDE.local.md it finds.
  const deny = [`${P}/league/json.py`, `${P}/league/sffl.py`, `${P}/league/CLAUDE.local.md`, `${P}/content/CLAUDE.local.md`, `${P}/league/docs/CLAUDE.local.md`,
    `${P}/league/docs/claude.local.md`, `${P}/league/docs/tool.py`, `${P}/league/Json.PY`, `${P}/league/__pycache__/json.cpython-312.pyc`, `${P}/league/run.pyw`, `${P}/league/_speedups.so`,
    `${P}/league/pytest.ini`, `${P}/league/tox.ini`, `${P}/league/.python-version`, `${P}/site/.vscode/tasks.json`, `${P}/site/docs/.vscode/settings.json`];
  for (const p of deny) {
    assert.ok(has(wr(p), /by its name|\.vscode folder/), `Write ${p}: ${wr(p).join('; ')}`);
    assert.ok(has(ed(p), /by its name|\.vscode folder/), `Edit ${p}`);
    assert.ok(!has(wr(p), /outside the folders/), `${p} is inside a write folder: only the second layer stops it`);
  }
  // Notes and docs stay writable, near names too.
  for (const p of [`${P}/league/docs/plan.md`, `${P}/league/docs/python.md`, `${P}/league/docs/json.py.md`, `${P}/league/docs/claude.local.md.txt`, `${P}/league/docs/local.md`,
    `${P}/league/stubs.pyi`, `${P}/league/also`, `${P}/league/so.md`, `${P}/league/pytest.ini.md`, `${P}/league/vscode/a.md`, `${P}/league/python-version.md`]) {
    assert.deepEqual(wr(p), [], p);
  }
  // Reads are not held to the write layer.
  assert.deepEqual(rd(`${P}/league/json.py`), []);
  assert.deepEqual(rd(`${P}/league/CLAUDE.local.md`), []);
  // Wrangler's local secrets file is private, for reads and searches as well.
  for (const n of ['.dev.vars', '.dev.vars.production']) {
    assert.ok(has(rd(`${P}/contact/${n}`), /reads a \.dev\.vars file/), n);
    assert.ok(has(wr(`${P}/contact/${n}`), /touches a \.dev\.vars file/), n);
    assert.ok(has(denyOnlyReasons({ tool: 'Grep', inputPreview: JSON.stringify({ pattern: 'KEY', path: `${P}/contact`, glob: n }) }, finalOpts), /\.dev\.vars/), `Grep glob ${n}`);
  }
  assert.deepEqual(rd(`${P}/contact/dev.vars.md`), []);
});

test('the go-live patch: other names for the same disk (/System, /Volumes, /.vol, /.file, /.nofollow, /.resolve) are Deny-only (board 669ea1d2)', () => {
  // The real path does not fold these back to /Users/…, so no rule written for the home
  // folder sees them: each path below is caught by this rule alone.
  const r = (tool, input) => denyOnlyReasons({ tool, inputPreview: JSON.stringify(input) }, strictOpts);
  const other = /another name for the disk/;
  const aliases = ['/System/Volumes/Data/Users/owner/Library/x', '/System/Volumes/Data/Users/owner', '/.nofollow/Users/owner/.claude/projects/x', '/.vol/1/2',
    '/.file/id=1.2', '/.resolve/1/Users/owner/notes.md', '/Volumes/Data/Users/owner/notes.md', '/System', '/.vol', '/.file', '/.nofollow', '/.resolve', '/Volumes', '/system/volumes/data/x', '/VOLUMES/x'];
  for (const p of aliases) {
    assert.ok(has(r('Read', { file_path: p }), other), `Read ${p}: ${r('Read', { file_path: p }).join('; ')}`);
    assert.ok(has(r('Grep', { pattern: 'KEY', path: p }), other), `Grep ${p}`);
    assert.ok(has(r('Glob', { pattern: '**/*.md', path: p }), other), `Glob ${p}`);
    assert.ok(has(strict(`cat ${p}`), other), `cat ${p}`);
    assert.ok(has(r('mcp__plugin_jarvis-channel_jarvis__reply', { text: 't', files: [p] }), other), `reply file ${p}`);
  }
  assert.ok(has(denyOnlyReasons({ tool: 'Write', inputPreview: JSON.stringify({ file_path: '/Volumes/work/a.md', content: 'x' }) }, { ...strictOpts, writeFolders: ['/Volumes/work'] }), other), 'a write folder there is no way round');
  // Near names are ordinary folders.
  for (const p of [`${APP}/System/a.md`, `${APP}/Volumes/a.md`, `${APP}/.vol/a.md`, `${APP}/.nofollow/a.md`]) assert.deepEqual(r('Read', { file_path: p }), [], p);
  for (const p of ['/Systems/a.md', '/Volumes2/a.md', '/.volx/a.md', '/.files/a.md']) assert.ok(!has(r('Read', { file_path: p }), other), p);
});

test('the second layer: an existing file that can be run is Deny-only for a write (the disk decides), on a real folder', async () => {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'appr-run-')));
  try {
    await mkdir(join(dir, 'w'));
    await writeFile(join(dir, 'w', 'run.sh'), '#!/bin/sh\n');
    await chmod(join(dir, 'w', 'run.sh'), 0o755);
    await writeFile(join(dir, 'w', 'notes.md'), 'x');
    await chmod(join(dir, 'w', 'notes.md'), 0o644);
    await symlink(join(dir, 'w', 'notes.md'), join(dir, 'w', 'link.md'));
    await symlink(join(dir, 'w'), join(dir, 'w', 'dirlink'));
    const opts = { home: dir, writeFolders: [join(dir, 'w')], repoRoot: REPO };
    assert.ok(has(wr(join(dir, 'w', 'run.sh'), opts), /changes a file that can be run/));
    assert.ok(has(ed(join(dir, 'w', 'run.sh'), opts), /changes a file that can be run/));
    assert.deepEqual(wr(join(dir, 'w', 'notes.md'), opts), []);
    // Any execute bit counts, the owner's alone too.
    await writeFile(join(dir, 'w', 'mine.py'), 'x');
    await chmod(join(dir, 'w', 'mine.py'), 0o744);
    assert.ok(has(wr(join(dir, 'w', 'mine.py'), opts), /changes a file that can be run/));
    assert.deepEqual(wr(join(dir, 'w', 'new.md'), opts), [], 'a file that does not exist yet');
    assert.deepEqual(wr(join(dir, 'w', 'new-folder', 'a.md'), opts), []);
    // lstat on the last part: a link is Deny-only, for a write and for a read.
    assert.ok(has(wr(join(dir, 'w', 'link.md'), opts), /last part is a link/));
    assert.ok(has(rd(join(dir, 'w', 'link.md'), opts), /last part is a link/));
    assert.ok(has(rd(join(dir, 'w', 'dirlink'), opts), /last part is a link/));
    assert.ok(has(rd(join(dir, 'w', 'dirlink') + '/', opts), /last part is a link/), 'a trailing slash does not hide it');
    assert.deepEqual(rd(join(dir, 'w', 'notes.md'), opts), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
  // The checks can be told what the disk says; one that throws counts as yes.
  assert.ok(has(wr(`${P}/content/a.md`, { ...finalOpts, isExecutable: () => true }), /can be run/));
  assert.ok(has(wr(`${P}/content/a.md`, { ...finalOpts, isExecutable: () => { throw new Error('x'); } }), /can be run/));
  assert.ok(has(wr(`${P}/content/a.md`, { ...finalOpts, isLink: () => { throw new Error('x'); } }), /link/));
  const seen = [];
  wr('~/Projects/content/a.md', { ...finalOpts, isLink: p => { seen.push(p); return false; }, isExecutable: p => { seen.push(p); return false; } });
  assert.deepEqual(seen, [`${P}/content/a.md`, `${P}/content/a.md`], '~ is resolved before the disk is asked');
  assert.deepEqual(rd(`${P}/content/run.sh`, { ...finalOpts, isExecutable: () => true }), [], 'reading a script is not running it');
});

test('a channel reply may attach only files inside the outbox, by the path as written and by its real path; both reply tools (board bf222809)', () => {
  const OUT = '/home/owner/.local/state/jarvis/outbox';
  for (const tool of ['mcp__plugin_discord_discord__reply', 'mcp__plugin_jarvis-channel_jarvis__reply']) {
    const f = (files, opts = finalOpts) => denyOnlyReasons({ tool, inputPreview: JSON.stringify({ chat_id: '1', text: 'here', files }) }, opts);
    assert.deepEqual(f([`${OUT}/chart.png`]), [], tool);
    assert.deepEqual(f(['~/.local/state/jarvis/outbox/sub/report.pdf', `${OUT}/b.txt`]), []);
    assert.deepEqual(f([]), []);
    for (const p of ['/home/owner/.zsh_history', `${P}/league/README.md`, `${P}/content/a.png`, '/tmp/a.png', OUT, `${OUT}/`, `${OUT}2/a.png`, '/home/owner/.local/state/jarvis/a.png',
      '/home/owner/.local/state/jarvis/outbox.bak/a', `${OUT}/../state.json`, '/home/owner/.local/state/jarvis-os/outbox/a']) {
      assert.ok(has(f([p]), /outside the outbox/), `${tool} ${p}: ${f([p]).join('; ')}`);
      assert.ok(has(f([`${OUT}/ok.png`, p]), /outside the outbox/), 'one bad file among good ones');
    }
    assert.ok(has(f(['~']), /absolute path/));
    assert.ok(has(f(['outbox/a.png']), /absolute path/));
    // A folder in the outbox that is a link out of it; and a file that is itself a link.
    const out = { ...finalOpts, realpath: p => (p === `${OUT}/exit` ? '/home/owner' : null) };
    assert.ok(has(f([`${OUT}/exit/.zsh_history`], out), /outside the outbox/));
    assert.ok(has(f([`${OUT}/exit/.zsh_history`], out), /history file/));
    assert.ok(has(f([`${OUT}/a.png`], { ...finalOpts, isLink: p => p === `${OUT}/a.png` }), /last part is a link/));
    // An outbox that lives elsewhere by its real path still counts, both ways round.
    const vol = { ...finalOpts, realpath: p => (p.startsWith(OUT) ? p.replace(OUT, '/vol/outbox') : null) };
    assert.deepEqual(f([`${OUT}/a.png`], vol), []);
    // Private names stay private even inside it.
    assert.ok(f([`${OUT}/.env`]).length > 0);
  }
  // Another channel tool without files is untouched.
  assert.deepEqual(denyOnlyReasons({ tool: 'mcp__plugin_discord_discord__reply', inputPreview: JSON.stringify({ chat_id: '1', text: 'hi' }) }, finalOpts), []);
});

test('the lows: more private places for reads, wide search roots, a space in a write path (board 4f52c42f)', () => {
  const g = (tool, input, opts = finalOpts) => denyOnlyReasons({ tool, inputPreview: JSON.stringify(input) }, opts);
  const priv = {
    '/home/owner/.zsh_history': /history file/, '/home/owner/.bash_history': /history file/, '/home/owner/.python_history': /history file/, [`${P}/content/.node_repl_history`]: /history file/,
    [`${P}/league/data/browser-profile/x`]: /browser profile/, [`${P}/site/.wrangler/state/x`]: /Wrangler/, '/home/owner/.gnupg/pubring.kbx': /GnuPG/,
    '/home/owner/.config/gcloud/credentials.db': /Google Cloud/, '/home/owner/Library/Preferences/com.example.plist': /Library folder/, '/home/owner/Library/Logs/job.log': /Library folder/,
    '/home/owner/Library': /Library folder/, '/home/owner/.claude/projects/-home-owner/abc.jsonl': /transcripts/, [`${REPO}/server/config.json`]: /Control Room's config or data/,
    [`${REPO}/server/data/chat/devices.json`]: /Control Room's config or data/, [`${REPO}/server/data`]: /Control Room's config or data/
  };
  for (const [p, re] of Object.entries(priv)) {
    assert.ok(has(rd(p), re), `Read ${p}: ${rd(p).join('; ')}`);
    assert.ok(has(g('Grep', { pattern: 'x', path: p }), re), `Grep ${p}`);
    assert.ok(has(wr(p), re), `Write ${p}`);
  }
  assert.equal(sensitiveWhy('/home/owner/library/x', HOME, REPO), 'the Library folder');
  // Near them, still readable.
  for (const p of [`${REPO}/server/lib/a.mjs`, `${REPO}/README.md`, `${REPO}/server/config.example.json`, `${REPO}/server/database.md`, `${P}/content/history.md`, `${P}/content/Library/a.md`,
    '/home/owner/.claude/agents/a.md', `${P}/content/shell_history.md`, `${P}/other-repo/server/config.json`]) {
    assert.deepEqual(rd(p), [], p);
  }
  // A search rooted above a private place reaches it; the whole Projects folder is too wide by itself.
  for (const root of ['/home/owner/Library', '/home/owner/.claude', '/home/owner/.config', REPO, `${REPO}/server`]) {
    assert.ok(g('Grep', { pattern: 'x', path: root }).length > 0, `Grep ${root}`);
    assert.ok(g('Glob', { pattern: '**/*.md', path: root }).length > 0, `Glob ${root}`);
  }
  for (const root of [P, `${P}/`, '~/Projects', '/home/owner/PROJECTS']) {
    assert.ok(has(g('Grep', { pattern: 'x', path: root }), /whole Projects folder/), `Grep ${root}`);
    assert.ok(has(g('Glob', { pattern: '**/*.md', path: root }), /whole Projects folder/), `Glob ${root}`);
  }
  const far = { ...finalOpts, repoRoot: '/srv/control-room' };
  assert.deepEqual(g('Grep', { pattern: 'x', path: P }, far), ['a search of the whole Projects folder'], 'by its own rule, not only because the Control Room sits inside');
  assert.ok(has(g('Grep', { pattern: 'x', path: '/work' }, { ...far, realpath: p => (p === '/work' ? P : null) }), /whole Projects folder/), 'a link to it');
  assert.deepEqual(g('Grep', { pattern: 'x', path: `${P}/content` }), []);
  assert.deepEqual(g('Glob', { pattern: '**/*.md', path: `${REPO}/docs` }), []);
  assert.deepEqual(g('Read', { file_path: P }, far), [], 'the rule is for searches');
  // Whitespace in a write path: the relay folds it, so the real path can't be known.
  for (const p of [`${P}/content/my notes.md`, `${P}/content/a.md `, `${P}/content/sub dir/a.md`]) {
    assert.ok(has(wr(p), /space in it/), p);
    assert.ok(has(ed(p), /space in it/), p);
    assert.ok(has(g('NotebookEdit', { notebook_path: p, new_source: 'x' }), /space in it/), p);
  }
  assert.ok(wr(`${P}/content/a\tb.md`).length > 0 && wr(`${P}/content/a\nb.md`).length > 0, 'a tab or a line break was already refused');
  assert.deepEqual(rd(`${P}/content/my notes.md`), [], 'a read is not held to it');
});

test('config: a write folder may not be the Projects folder, nor hold or sit inside the lead\'s repo, machine-setup or the Control Room\'s code; the protected list fails closed', () => {
  const o = { repoRoot: REPO, realpath: noReal };
  for (const ok of ['~/Projects/app', `${P}/league`, `${REPO}/docs`, `${REPO}/docs/design`, '~/Documents/notes', '/srv/site', '~/Projects/jarvis-notes', '~/Projects/machine-setup2']) {
    assert.equal(okWriteFolder(ok, HOME, o), true, ok);
  }
  for (const bad of ['~/Projects', '~/Projects/', P, '/home/owner/PROJECTS', '~/Projects/jarvis', '~/Projects/jarvis/', '~/Projects/jarvis/docs', '~/Projects/machine-setup', '~/Projects/machine-setup/git-hooks',
    REPO, `${REPO}/`, `${REPO}/server`, `${REPO}/server/lib`, `${REPO}/web`, `${REPO}/bin`, `${REPO}/mod/src`]) {
    assert.equal(okWriteFolder(bad, HOME, o), false, bad);
  }
  // By the real path too: a link to the Projects folder, or to the lead's repo.
  assert.equal(okWriteFolder('/work', HOME, { repoRoot: REPO, realpath: p => (p === '/work' ? P : null) }), false);
  assert.equal(okWriteFolder('/srv/j', HOME, { repoRoot: REPO, realpath: p => (p === '/srv/j' ? `${P}/jarvis` : null) }), false);
  assert.equal(okWriteFolder('/srv/site', HOME, { repoRoot: null, realpath: noReal }), true, 'no repo root known: the other rules still hold');
  assert.equal(okWriteFolder('~/Projects/jarvis', HOME, { repoRoot: null, realpath: noReal }), false);
  const read = chat => readApprovalsConfig({ chat }, { home: HOME, repoRoot: REPO, realpath: noReal });
  const r = read({ approvalsWriteFolders: ['~/Projects/app', '~/Projects', REPO, `${REPO}/docs`] });
  assert.deepEqual(r.writeFolders, ['~/Projects/app', `${REPO}/docs`]);
  assert.equal(r.problems.length, 2);
  // Through the rules as well: a refused folder allows nothing, even handed in directly.
  assert.ok(has(wr(`${P}/anything/a.md`, { ...finalOpts, writeFolders: ['~/Projects'] }), /outside the folders/));
  assert.ok(has(wr(`${REPO}/README.md`, { ...finalOpts, writeFolders: [REPO] }), /outside the folders/));
  // The protected places.
  const good = read({ approvalsWriteFolders: ['~/Projects/app'], approvalsWriteProtected: ['~/Projects/app/src', '/home/owner/Projects/app/Makefile.d/'] });
  assert.deepEqual(good.writeProtected, ['~/Projects/app/src', '/home/owner/Projects/app/Makefile.d/']);
  assert.deepEqual(good.writeFolders, ['~/Projects/app']);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(read({}).writeProtected, []);
  for (const bad of ['~/Projects/app/src', ['src'], ['~/Projects/app/src', 7], ['~/a/../b'], ['~/a*'], [`~/caf${cp(0xe9)}`], Array.from({ length: 201 }, (_, i) => `~/p/${i}`)]) {
    const x = read({ approvalsWriteFolders: ['~/Projects/app'], approvalsWriteProtected: bad });
    assert.deepEqual(x.writeFolders, [], `a protected list that can't be read turns page writes off: ${JSON.stringify(bad).slice(0, 50)}`);
    assert.deepEqual(x.writeProtected, []);
    assert.equal(x.problems.length, 1);
    assert.match(x.problems[0], /the page allows no writes/);
  }
});

test('the gate carries config\'s protected places, and the routes the exact command: shown on the card, covered by the hash, dropped when the request closes', async () => {
  const gateOpts = { bash: 'exact', bashCommands: ['cd /home/owner/Projects/app\nnpm test'], writeFolders: FINAL_WRITE, writeProtected: FINAL_PROTECTED, repoRoot: REPO, isLeadSession: id => id === 'lead' };
  const env = await setup({ gate: gateOpts });
  try {
    await env.mark('phone', true);
    // A write into a protected place inside a write folder: the card is Deny-only and Allow is refused.
    await env.unix({ method: 'POST', path: '/v1/permission-request', body: { requestId: 'aaaaa', tool: 'Write', description: 'd', inputPreview: JSON.stringify({ file_path: `${P}/league/src/sffl/cli.py`, content: 'x' }), relayedAt: env.clock.t } });
    assert.ok(has(env.store.permission('aaaaa').denyOnly, /config protects/));
    assert.equal((await env.tap('aaaaa', env.phone, 'allow')).status, 403);
    assert.equal((await env.tap('aaaaa', env.phone, 'deny')).status, 200);
    await env.unix({ method: 'POST', path: '/v1/permission-request', body: { requestId: 'aaaab', tool: 'Write', description: 'd', inputPreview: JSON.stringify({ file_path: `${P}/league/docs/a.md`, content: 'x' }), relayedAt: env.clock.t } });
    assert.equal((await env.tap('aaaab', env.phone, 'allow')).status, 200);
    clock(env, MIN);
    // Bash with no report: Deny-only.
    await env.open('bbbbb', { command: 'pwd' });
    assert.deepEqual(env.store.permission('bbbbb').denyOnly, [NO_EXACT]);
    assert.equal(env.store.publicPermission(env.store.permission('bbbbb')).exact, null);
    assert.equal((await env.tap('bbbbb', env.phone, 'allow')).status, 403);
    assert.equal((await env.tap('bbbbb', env.phone, 'deny')).status, 200);
    // The listed two-liner, reported by the hook, relayed folded.
    const real = 'cd /home/owner/Projects/app\nnpm test';
    assert.equal(env.approvals.noteExact({ sessionId: 'lead', command: real }), 'kept');
    await env.open('ccccc', { command: 'cd /home/owner/Projects/app npm test' });
    const p = env.store.permission('ccccc');
    assert.equal(p.exact, real);
    const status = await call({ port: env.port, path: '/api/chat/status', headers: { host: PAGE_HOST, cookie: env.phone } });
    const open = status.json.openPermission.requestId === 'ccccc' ? status.json.openPermission : null;
    assert.ok(open, JSON.stringify(status.json.openPermission?.requestId));
    assert.equal(open.exact, real, 'the page gets the text with its line break');
    assert.equal(open.canAllow, true);
    // A tap that hashed only the preview (an old page, or one that never showed the exact text) is refused.
    const stale = await env.tap('ccccc', env.phone, 'allow', { shown: shownHash(p.tool, p.description, p.inputPreview) });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(env.store.permission('ccccc').state, 'open');
    clock(env, MIN);
    const ok = await env.tap('ccccc', env.phone, 'allow');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(env.store.permission('ccccc').exact, null, 'dropped once answered');
    // The verdict line on disk carries the hash, never the text.
    const lines = (await readFile(join(env.dir, 'chat', (await readdir(join(env.dir, 'chat'))).find(n => n.endsWith('.jsonl'))), 'utf8'));
    assert.ok(!lines.includes('npm test'), 'the exact text never reaches the disk');
    assert.ok(lines.includes(shownHash(p.tool, p.description, p.inputPreview, real)));
    // A second, different report after the card opened: Allow refused, alerted.
    clock(env, MIN);
    env.approvals.noteExact({ sessionId: 'lead', command: real });
    await env.open('ddddd', { command: 'cd /home/owner/Projects/app npm test' });
    env.approvals.noteExact({ sessionId: 'lead', command: 'cd /home/owner/Projects/app npm test' });
    const tied = await env.tap('ddddd', env.phone, 'allow');
    assert.equal(tied.status, 403, tied.text);
    assert.match(tied.json.error, /two different exact copies/);
    assert.equal(env.events.filter(e => e.kind === 'approvals-exact-conflict').length, 1);
    assert.equal((await env.tap('ddddd', env.phone, 'deny')).status, 200, 'Deny always works');
    // Expiry drops the text too.
    clock(env, MIN);
    env.approvals.noteExact({ sessionId: 'lead', command: real });
    await env.open('eeeee', { command: 'cd /home/owner/Projects/app npm test' });
    assert.equal(env.store.permission('eeeee').exact, real);
    clock(env, PERMISSION_TTL_MS);
    assert.equal(env.store.permission('eeeee').state, 'expired');
    assert.equal(env.store.permission('eeeee').exact, null);
    // And so does a hello from a new channel process.
    clock(env, MIN);
    env.approvals.noteExact({ sessionId: 'lead', command: real });
    await env.open('fffff', { command: 'cd /home/owner/Projects/app npm test' });
    assert.equal(env.store.permission('fffff').exact, real);
    env.store.newPermissionSession();
    assert.equal(env.store.permission('fffff').state, 'expired');
    assert.equal(env.store.permission('fffff').exact, null);
  } finally { await env.close(); }
});
