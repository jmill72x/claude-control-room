// deploy/add-needs-you-matching.py (board 9fb32c4d, Ultron's M2): gives the needs-you
// hooks the fields and events the server matches a permission wait on, appending only, and
// keeps the exact-command hook's synchronous Bash entry first and unchanged. Run for real
// with /usr/bin/python3 -I on fixture copies in a scratch folder: never the real settings
// file. Every value here is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, chmod, rm, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SOCKET_HOOKS } from './helpers/needs-you-hooks-1112.mjs';

const SCRIPT = new URL('../../deploy/add-needs-you-matching.py', import.meta.url).pathname;
const PY = '/usr/bin/python3';
const MARKER = 'invented-token-marker-9f3a';

const readme = async () => readFile(new URL('../../README.md', import.meta.url), 'utf8');
const block = (text, heading) => JSON.parse(text.slice(text.indexOf(heading)).match(/```json\n([\s\S]*?)\n```/)[1]).hooks;
// The exact-command hook's entry as README gives it (its own section).
const exactEntry = async () => block(await readme(), '**The exact-command hook.**').PermissionRequest[0];

// A settings file like the owner's on 2026-11-21: other keys (an env block with a
// token-shaped value), the 11-12 socket entries, the exact-command Bash entry, and an
// unrelated PreToolUse hook. Two-space JSON, as Claude Code writes it.
const owner = async (edit = h => h) => {
  const hooks = JSON.parse(JSON.stringify(SOCKET_HOOKS));
  hooks.PermissionRequest = [await exactEntry()];
  hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard --check' }] }];
  return { model: 'opus', env: { SOME_TOKEN: MARKER }, permissions: { allow: ['Bash(ls:*)'], deny: [] }, hooks: edit(hooks), statusLine: { type: 'command', command: 'echo hi' } };
};
const text = settings => `${JSON.stringify(settings, null, 2)}\n`;

const dirs = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
const setup = async body => {
  const dir = await mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'nym-'));
  dirs.push(dir);
  const settings = join(dir, 'settings.json');
  await writeFile(settings, body ?? text(await owner()));
  await chmod(settings, 0o644);
  return { dir, settings };
};
const run = (s, ...flags) => {
  const r = spawnSync(PY, ['-I', SCRIPT, '--settings', s.settings, ...flags], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const skip = t => { if (!existsSync(PY)) { t.skip('needs /usr/bin/python3'); return true; } return false; };
const backups = async s => (await readdir(s.dir)).filter(n => n.startsWith('settings.json.bak-'));

test('--apply: the hooks become README\'s entry, PermissionRequest merged with the Bash entry first and unchanged; everything else stays; a 0600 backup first', async t => {
  if (skip(t)) return;
  const s = await setup();
  const before = await readFile(s.settings, 'utf8');
  const r = run(s, '--apply');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^changed 5 needs-you filters and appended 3 entries; backup: .*settings\.json\.bak-\d{8}-\d{6}\n$/);
  assert.ok(!r.out.includes(MARKER) && !r.err.includes(MARKER));
  const now = JSON.parse(await readFile(s.settings, 'utf8'));
  const want = block(await readme(), '### A session waiting on you');
  for (const [event, groups] of Object.entries(want)) assert.deepEqual(now.hooks[event], groups, `${event}: exactly README's entry`);
  assert.deepEqual(now.hooks.PermissionRequest[0], await exactEntry(), 'the Bash entry is first and unchanged');
  assert.deepEqual(now.hooks.PermissionDenied, SOCKET_HOOKS.PermissionDenied);
  assert.deepEqual(now.hooks.PreToolUse, JSON.parse(before).hooks.PreToolUse);
  const old = JSON.parse(before);
  for (const k of ['model', 'env', 'permissions', 'statusLine']) assert.deepEqual(now[k], old[k], k);
  assert.equal((await stat(s.settings)).mode & 0o777, 0o644, 'the file keeps its mode');
  const [bak] = await backups(s);
  assert.equal(await readFile(join(s.dir, bak), 'utf8'), before);
  assert.equal((await stat(join(s.dir, bak))).mode & 0o777, 0o600);
  assert.equal((await readdir(s.dir)).filter(n => n.includes('.tmp')).length, 0, 'no temp file left');
  // Run again: it has run, so it refuses and changes nothing.
  const after2 = await readFile(s.settings, 'utf8');
  const again = run(s, '--apply');
  assert.equal(again.code, 1);
  assert.match(again.err, /already has the new filter/);
  assert.equal(await readFile(s.settings, 'utf8'), after2);
});

test('a dry run is the default: it prints the change to hooks only (never the env block), writes nothing, not even a backup', async t => {
  if (skip(t)) return;
  const s = await setup();
  const before = await readFile(s.settings, 'utf8');
  const r = run(s);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^--- .*settings\.json: hooks\n\+\+\+ .*settings\.json: hooks \(with matching\)\n/);
  assert.match(r.out, /^\+.*agent_id,tool_name,duration_ms/m);
  assert.match(r.out, /^\+ {2}"SubagentStop": \[/m);
  assert.ok(!r.out.includes(MARKER) && !r.err.includes(MARKER), 'the rest of the file is never printed');
  assert.match(r.err, /dry run: 5 filters would change and 3 entries be appended; nothing written \(run again with --apply\)/);
  assert.equal(await readFile(s.settings, 'utf8'), before);
  assert.deepEqual(await backups(s), []);
  // Another layout: the dry run says the write would re-lay it out, and still prints no secret.
  const one = await setup(JSON.stringify(await owner()));
  const r2 = run(one);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.err, /not in two-space JSON now/);
  assert.ok(!r2.out.includes(MARKER) && !r2.err.includes(MARKER));
  const w = run(one, '--apply');
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /re-laid out as two-space JSON/);
});

test('it appends to PostToolUseFailure and SubagentStop lists that are there, after their own entries', async t => {
  if (skip(t)) return;
  const mine = { hooks: [{ type: 'command', command: '/usr/local/bin/own-hook' }] };
  const s = await setup(text(await owner(h => ({ ...h, SubagentStop: [mine], PostToolUseFailure: [] }))));
  assert.equal(run(s, '--apply').code, 0);
  const now = JSON.parse(await readFile(s.settings, 'utf8'));
  assert.deepEqual(now.hooks.SubagentStop[0], mine, 'its own entry stays first');
  assert.equal(now.hooks.SubagentStop.length, 2);
  assert.equal(now.hooks.PostToolUseFailure.length, 1);
});

test('it refuses, changing nothing, without the synchronous Bash entry, on other than the five old commands, a list that is not one, a symlink or bad JSON', async t => {
  if (skip(t)) return;
  const exact = await exactEntry();
  const asyncExact = { ...exact, hooks: exact.hooks.map(h => ({ ...h, async: true })) };
  const cases = [
    [h => { delete h.PermissionRequest; return h; }, /no PermissionRequest list/],
    [h => ({ ...h, PermissionRequest: [] }), /0 Bash entries posting to the exact-command ingest, not 1/],
    [h => ({ ...h, PermissionRequest: [exact, exact] }), /2 Bash entries/],
    [h => ({ ...h, PermissionRequest: [asyncExact] }), /is async/],
    [h => ({ ...h, PermissionRequest: [{ ...exact, matcher: 'Bash|Monitor' }] }), /0 Bash entries/],
    [h => ({ ...h, PermissionRequest: { a: 1 } }), /hooks\.PermissionRequest is not a list/],
    [h => ({ ...h, SubagentStop: 'x' }), /hooks\.SubagentStop is not a list/],
    [h => { delete h.Stop; return h; }, /found 4 hook commands with the old needs-you filter, not 5/],
    [h => ({ ...h, SubagentStop: [h.Stop[0]] }), /found 6 hook commands with the old needs-you filter/],
    [h => ({ ...h, Stop: [{ hooks: [{ ...h.Stop[0].hooks[0], command: h.Stop[0].hooks[0].command.replace('-m 3', '-m 5') }] }] }), /found 0 needs-you commands under Stop in the form README gave/],
    [h => ({ ...h, Stop: [{ hooks: [{ ...h.Stop[0].hooks[0], command: h.Stop[0].hooks[0].command.replace('at:(now', 'agent_id,tool_name,duration_ms,at:(now') }] }] }), /already has the new filter/]
  ];
  for (const [edit, why] of cases) {
    const s = await setup(text(await owner(edit)));
    const before = await readFile(s.settings, 'utf8');
    for (const flags of [[], ['--apply']]) {
      const r = run(s, ...flags);
      assert.equal(r.code, 1, `${why} ${flags}`);
      assert.match(r.err, new RegExp(`^refused: .*${why.source}`), r.err);
      assert.match(r.err, /nothing changed/);
    }
    assert.equal(await readFile(s.settings, 'utf8'), before, String(why));
    assert.deepEqual(await backups(s), []);
  }
  const bad = await setup('{ "hooks": ');
  assert.match(run(bad, '--apply').err, /not valid JSON/);
  const arr = await setup('[]');
  assert.match(run(arr).err, /not a JSON object/);
  const noHooks = await setup('{ "model": "opus" }');
  assert.match(run(noHooks).err, /no "hooks" object/);
  const real = await setup();
  const link = join(real.dir, 'link.json');
  await symlink(real.settings, link);
  const r = run({ ...real, settings: link }, '--apply');
  assert.equal(r.code, 1);
  assert.match(r.err, /symlink or not a regular file/);
  assert.match(run({ ...real, settings: join(real.dir, 'missing.json') }).err, /is not there/);
});

test('the script\'s new entries are README\'s, and its default target is the real settings path (never run on it here)', async () => {
  const src = await readFile(SCRIPT, 'utf8');
  assert.match(src, /^SETTINGS_DEFAULT = '~\/\.claude\/settings\.json'$/m);
  assert.match(src, /^#!\/usr\/bin\/python3 -I$/m);
  assert.ok(src.includes("ap.add_argument('--apply', action='store_true'"), 'writing needs --apply');
  const want = block(await readme(), '### A session waiting on you');
  // Each README command is the script's command() for its event's -m, with the new filter.
  for (const event of ['Notification', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PostToolUseFailure', 'SubagentStop']) {
    const c = want[event].at(-1).hooks[0].command;
    assert.ok(c.startsWith("/usr/bin/jq -c '{hook_event_name,session_id,notification_type,agent_id,tool_name,duration_ms,at:(now*1000|floor)}' | /usr/bin/curl -q -s -m "), event);
  }
});

// Ultron's L2 on §28: the two race windows, driven by loading the script as a module in
// /usr/bin/python3 -I and making the "other session" act at the exact step: a symlink
// swapped in after the lstat check, and a save landing after the backup, just before
// the rename (a new text, or the same text in a new file).
const HARNESS = String.raw`
import contextlib, importlib.util, io, json, os, sys
script, path, scenario = sys.argv[1:4]
spec = importlib.util.spec_from_file_location('nym', script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
real_lstat, real_backup = os.lstat, mod.write_backup
def swap_link(p, *a, **k):
    info = real_lstat(p, *a, **k)
    if p == path and scenario == 'dir':
        os.lstat = real_lstat
        os.rename(path, path + '.moved')
        os.mkdir(path)
    if p == path and scenario in ('link', 'file'):
        os.lstat = real_lstat
        decoy = path + '.decoy'
        with open(path, encoding='utf-8') as f, open(decoy, 'w', encoding='utf-8') as g:
            g.write(f.read())
        os.unlink(path)
        if scenario == 'link':
            os.symlink(decoy, path)
        else:
            os.rename(decoy, path)
    return info
os.lstat = swap_link
def late_save(p, text):
    b = real_backup(p, text)
    if scenario == 'edit':
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text.replace('"opus"', '"sonnet"'))
    elif scenario == 'sneaky':
        # Same length, same inode, and the old modification time put back.
        before = os.stat(p)
        with open(p, 'r+', encoding='utf-8') as f:
            f.write(text.replace('"opus"', '"opux"', 1))
        os.utime(p, ns=(before.st_atime_ns, before.st_mtime_ns))
    elif scenario == 'same':
        with open(p + '.new', 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(p + '.new', p)
    return b
mod.write_backup = late_save
err = io.StringIO()
with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
    code = mod.main(['--settings', path, '--apply'])
print(json.dumps({'code': code, 'err': err.getvalue()}))
`;
const race = (s, scenario) => {
  const r = spawnSync(PY, ['-I', '-c', HARNESS, SCRIPT, s.settings, scenario], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const leftovers = async s => (await readdir(s.dir)).filter(n => n.startsWith('.settings.'));

test('the race windows (Ultron\'s L2): a symlink swapped in after the check is not read through; a save after the backup is not overwritten', async t => {
  if (skip(t)) return;
  // The harness itself, with nobody else acting: it applies.
  const calm = await setup();
  assert.equal(race(calm, 'none').code, 0);
  assert.ok((await readFile(calm.settings, 'utf8')).includes('agent_id,tool_name,duration_ms'));

  const link = await setup();
  const r1 = race(link, 'link');
  assert.equal(r1.code, 1);
  assert.match(r1.err, /^refused: .*could not be opened as a regular file.*nothing changed/);
  assert.ok((await readFile(`${link.settings}.decoy`, 'utf8')).includes('notification_type,at:(now'), 'the file behind the link is untouched');
  assert.deepEqual(await backups(link), []);
  // Another regular file swapped in after the check: not the one checked.
  const swapped = await setup();
  const r0 = race(swapped, 'file');
  assert.equal(r0.code, 1);
  assert.match(r0.err, /^refused: .*was replaced while this ran: nothing changed/);
  assert.ok(!(await readFile(swapped.settings, 'utf8')).includes('agent_id,tool_name'));
  assert.deepEqual(await backups(swapped), []);
  // A folder swapped in: a refusal, not a crash.
  const folder = await setup();
  const rd = race(folder, 'dir');
  assert.equal(rd.code, 1);
  assert.match(rd.err, /^refused: .*is not a regular file: nothing changed/);

  const edit = await setup();
  const r2 = race(edit, 'edit');
  assert.equal(r2.code, 1);
  assert.match(r2.err, /^refused: .*changed while this ran: nothing changed, run it again \(the backup .*settings\.json\.bak-\d{8}-\d{6} was made first and is left\)\n$/);
  const kept = await readFile(edit.settings, 'utf8');
  assert.ok(kept.includes('"sonnet"') && !kept.includes('agent_id,tool_name'), 'the other save stands');
  assert.deepEqual(await leftovers(edit), [], 'no temp file left');

  // A save that keeps the inode, the size and the modification time: the text tells.
  const sneaky = await setup();
  const rs = race(sneaky, 'sneaky');
  assert.equal(rs.code, 1);
  assert.match(rs.err, /changed while this ran/);
  assert.ok((await readFile(sneaky.settings, 'utf8')).includes('"opux"'));

  const same = await setup();
  const before = await readFile(same.settings, 'utf8');
  const ino = (await stat(same.settings)).ino;
  const r3 = race(same, 'same');
  assert.equal(r3.code, 1, 'a new file with the same text is still not the one read');
  assert.match(r3.err, /changed while this ran/);
  assert.equal(await readFile(same.settings, 'utf8'), before);
  assert.notEqual((await stat(same.settings)).ino, ino, 'the other file stands, not ours');
  assert.deepEqual(await leftovers(same), []);
});

test('README spells out the undo: the cp of the backup the run named', async () => {
  const text = await readme();
  const at = text.indexOf('`deploy/add-needs-you-matching.py` makes the change');
  assert.ok(at > 0);
  const near = text.slice(at, at + 3000);
  assert.match(near, /cp -p ~\/\.claude\/settings\.json\.bak-YYYYMMDD-HHMMSS ~\/\.claude\/settings\.json/);
  assert.match(await readFile(SCRIPT, 'utf8'), /cp -p ~\/\.claude\/settings\.json\.bak-YYYYMMDD-HHMMSS ~\/\.claude\/settings\.json/);
});
