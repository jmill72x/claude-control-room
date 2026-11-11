// Approvals as buttons (docs/design/2026-11-11-jarvis-os-approvals.md, with Ultron's
// 11-11 findings H1-H2, M3-M6 and L7-L12): the pure rules in lib/approvals.mjs, the
// store's permission entries, and the two routes run on real sockets with their own
// servers. Every name, path and id is invented; nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
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
  assert.deepEqual(readApprovalsConfig({}), { mode: 'off', patterns: [], bash: 'deny', writeFolders: [], problems: [] });
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
const strictOpts = { home: HOME, realpath: noReal, bash: 'strict', writeFolders: WRITE, repoRoot: REPO, isExecutable: p => p.endsWith('.sh') || p.endsWith('/bin/tool') };
const strict = cmd => denyOnlyReasons({ tool: 'Bash', description: 'd', inputPreview: JSON.stringify({ command: cmd }) }, strictOpts);
const has = (list, re) => list.some(r => re.test(r));
const cp = n => String.fromCodePoint(n);

test('Bash is Deny-only on the page by default: a relayed command may have lost its line breaks (finding 1)', () => {
  for (const cmd of ['ls', 'pwd', 'git status', `cat ${APP}/notes.txt`, 'cat notes.txt rm -rf ~/Projects']) {
    assert.ok(has(bash(cmd), /Bash is answered at the terminal or in Discord/), cmd);
  }
  assert.equal(readApprovalsConfig({}).bash, 'deny', 'the default');
  assert.equal(readApprovalsConfig({ chat: { approvalsBash: 'strict' } }).bash, 'strict');
  for (const bad of ['on', 'allow', true, 'STRICT']) {
    const r = readApprovalsConfig({ chat: { approvalsBash: bad } });
    assert.equal(r.bash, 'deny', String(bad));
    assert.equal(r.problems.length, 1);
  }
  // The gate carries the mode through.
  const off = createApprovals({ mode: 'on', home: HOME, realpath: noReal });
  assert.ok(off.assess({ tool: 'Bash', inputPreview: '{"command":"pwd"}' }).denyOnly.length > 0);
  const on = createApprovals({ mode: 'on', home: HOME, realpath: noReal, bash: 'strict' });
  assert.deepEqual(on.assess({ tool: 'Bash', inputPreview: '{"command":"pwd"}' }).denyOnly, []);
});

test('Bash, strict grammar: a listed command, only its own options, every other word an absolute path (findings 1 and 4)', () => {
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
    'ls > f': /shell syntax/, 'cat < f': /shell syntax/, 'ls (x)': /shell syntax/, 'ls\nrm x': /shell syntax/, "cat '.ssh/id'": /shell syntax/,
    'cat .s\\sh/id': /shell syntax/, 'cat ~/.ss?/id': /shell syntax/, 'ls\t-la': /shell syntax/,
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
  const wide = { ...strictOpts, writeFolders: ['~/Projects', '~/.config', '/opt/homebrew/etc'] };
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
  assert.deepEqual(w('Grep', { pattern: 'KEY', path: '/home/owner/Projects' }), []);
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
  const r = (tool, input) => denyOnlyReasons({ tool, inputPreview: typeof input === 'string' ? input : JSON.stringify(input) }, strictOpts);
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
  const h = await call({ socketPath: env.sockPath, method: 'POST', path: '/v1/hello', body: { pid: 1, relay } });
  env.token = h.json.token;
  env.unix = opts => call({ socketPath: env.sockPath, ...opts, headers: { [SESSION_HEADER]: env.token, ...(opts.headers ?? {}) } });
  // A request the page may allow by default: a Read inside a plain project folder.
  env.open = (requestId, preview = { file_path: '/home/owner/Projects/app/README.md' }, extra = {}) => env.unix({ method: 'POST', path: '/v1/permission-request', body: { requestId, tool: 'command' in preview ? 'Bash' : 'Read', description: 'list', inputPreview: JSON.stringify(preview), relayedAt: env.clock.t, ...extra } });
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
