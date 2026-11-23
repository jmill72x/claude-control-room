#!/usr/bin/python3 -I
"""Give the needs-you hooks in ~/.claude/settings.json what the server needs to match a
permission wait to its own tool use (board 9fb32c4d; README "A session waiting on you",
"Which tool use ends a permission wait"; NEXT.md section 28).

A dry run by default; --apply writes:

    /usr/bin/python3 -I ~/Projects/claude-control-room/deploy/add-needs-you-matching.py
    /usr/bin/python3 -I ~/Projects/claude-control-room/deploy/add-needs-you-matching.py --apply

What it changes, and nothing else:
  - in each of the five needs-you commands on the ingest socket (Notification,
    PostToolUse, UserPromptSubmit, Stop, SessionEnd), the jq filter
        {hook_event_name,session_id,notification_type,at:(now*1000|floor)}
    becomes
        {hook_event_name,session_id,notification_type,agent_id,tool_name,duration_ms,at:(now*1000|floor)}
    keeping each hook's own -m, event, matcher and `async`;
  - it appends one async needs-you entry to the end of each of PermissionRequest,
    PostToolUseFailure and SubagentStop (making the list when there is none). It never
    removes, replaces or reorders an entry: on PermissionRequest the exact-command hook's
    synchronous Bash entry stays where it is, first, unchanged.

It stops, changing nothing, when:
  - the file is not there, is a symlink, or is not a JSON object with a "hooks" object;
  - any hook command already has the new filter (it ran before);
  - it doesn't find exactly the five old needs-you commands, one under each of those
    events, and no other command with the old filter;
  - PermissionRequest doesn't hold exactly one entry with matcher "Bash" whose hook posts
    to the exact-command ingest and is synchronous (no "async": true), or any of the three
    lists it appends to is not a list;
  - the result would differ from the old settings in more than the above, or the Bash
    entry would not be unchanged at its old place.

When it writes: a backup beside the file first (settings.json.bak-YYYYMMDD-HHMMSS, 0600,
never overwriting one), then a temporary file in the same folder, flushed and renamed over
the original with the original's mode, then the file is read back and checked. The file is
written as two-space JSON, the layout Claude Code itself writes; when the old layout was
another, the run says so. Every read opens the file without following a symlink
(O_NOFOLLOW), and just before the rename the file must still be the one read (same inode,
size, modification time and text), else nothing is renamed over it and the run says so
(Ultron's L2 on NEXT.md section 28; the window left is the rename itself). To undo, copy
the backup the run named back over the file, in a terminal, with no session saving
settings meanwhile:

    cp -p ~/.claude/settings.json.bak-YYYYMMDD-HHMMSS ~/.claude/settings.json

What it prints is the change to the "hooks" object only: never the rest of the file, which
can hold tokens (an "env" block).

--settings names another path: for the tests, which run on fixture copies.
"""
import argparse
import copy
import difflib
import json
import os
import stat
import sys
import tempfile
import time

SETTINGS_DEFAULT = '~/.claude/settings.json'
OLD_FILTER = '{hook_event_name,session_id,notification_type,at:(now*1000|floor)}'
NEW_FILTER = '{hook_event_name,session_id,notification_type,agent_id,tool_name,duration_ms,at:(now*1000|floor)}'
CURL = ("/usr/bin/curl -q -s -m {m} --noproxy '*' --unix-socket \"$HOME/.local/state/jarvis-os/ingest.sock\" "
        "-X POST http://localhost/api/ingest/needs-you -H 'Content-Type: application/json' -d @- >/dev/null || true")
# The five commands as README gave them from 2026-11-12 (each event's -m).
FIVE = {'Notification': 3, 'PostToolUse': 3, 'UserPromptSubmit': 3, 'Stop': 3, 'SessionEnd': 1}
APPENDED = ('PermissionRequest', 'PostToolUseFailure', 'SubagentStop')
EXACT_INGEST = '/api/ingest/exact-command'


def command(filt, m):
    return "/usr/bin/jq -c '%s' | %s" % (filt, CURL.format(m=m))


def new_group():
    return {'hooks': [{'type': 'command', 'async': True, 'command': command(NEW_FILTER, 3)}]}


class Refusal(Exception):
    pass


def hook_commands(groups):
    """(group index, hook index, command) for each hook command in an event's list."""
    out = []
    for gi, group in enumerate(groups if isinstance(groups, list) else []):
        hooks = group.get('hooks') if isinstance(group, dict) else None
        for hi, hook in enumerate(hooks if isinstance(hooks, list) else []):
            if isinstance(hook, dict) and isinstance(hook.get('command'), str):
                out.append((gi, hi, hook['command']))
    return out


def exact_bash_index(groups):
    """The index of the one synchronous Bash exact-command entry, or a Refusal."""
    found = []
    for gi, group in enumerate(groups):
        if not isinstance(group, dict) or group.get('matcher') != 'Bash':
            continue
        hooks = group.get('hooks') if isinstance(group.get('hooks'), list) else []
        if any(isinstance(h, dict) and isinstance(h.get('command'), str) and EXACT_INGEST in h['command'] for h in hooks):
            found.append((gi, hooks))
    if len(found) != 1:
        raise Refusal('PermissionRequest holds %d Bash entries posting to the exact-command ingest, not 1: nothing changed' % len(found))
    gi, hooks = found[0]
    if any(isinstance(h, dict) and h.get('async') is True for h in hooks):
        raise Refusal('the exact-command Bash entry is async; it must be the synchronous one README gives: nothing changed')
    return gi


def parse(text, what):
    try:
        settings = json.loads(text)
    except ValueError as err:
        raise Refusal('%s is not valid JSON (%s)' % (what, err))
    if not isinstance(settings, dict):
        raise Refusal('%s is not a JSON object' % what)
    if not isinstance(settings.get('hooks'), dict):
        raise Refusal('%s has no "hooks" object' % what)
    return settings


def plan(text):
    """(new settings, the old parsed) or a Refusal saying why not."""
    before = parse(text, 'the settings file')
    hooks = before['hooks']
    every = [c for groups in hooks.values() for _, _, c in hook_commands(groups)]
    if any(NEW_FILTER in c for c in every):
        raise Refusal('a hook command already has the new filter (this ran before?): nothing changed')
    if sum(OLD_FILTER in c for c in every) != len(FIVE):
        raise Refusal('found %d hook commands with the old needs-you filter, not %d: nothing changed' % (sum(OLD_FILTER in c for c in every), len(FIVE)))
    where = {}
    for event, m in FIVE.items():
        hits = [(gi, hi) for gi, hi, c in hook_commands(hooks.get(event)) if c == command(OLD_FILTER, m)]
        if len(hits) != 1:
            raise Refusal('found %d needs-you commands under %s in the form README gave, not 1: nothing changed' % (len(hits), event))
        where[event] = hits[0]
    for event in APPENDED:
        if event in hooks and not isinstance(hooks[event], list):
            raise Refusal('hooks.%s is not a list: nothing changed' % event)
    if not isinstance(hooks.get('PermissionRequest'), list):
        raise Refusal('there is no PermissionRequest list, so no exact-command Bash entry to keep: nothing changed')
    exact = exact_bash_index(hooks['PermissionRequest'])

    after = copy.deepcopy(before)
    for event, (gi, hi) in where.items():
        after['hooks'][event][gi]['hooks'][hi]['command'] = command(NEW_FILTER, FIVE[event])
    for event in APPENDED:
        after['hooks'].setdefault(event, []).append(new_group())
    check(before, after, where, exact)
    return after, before


def check(before, after, where, exact):
    """The result differs from the old settings only as planned."""
    if set(before) != set(after) or any(before[k] != after[k] for k in before if k != 'hooks'):
        raise Refusal('the new settings would change more than "hooks": nothing changed')
    bh, ah = before['hooks'], after['hooks']
    if set(ah) != set(bh) | set(APPENDED):
        raise Refusal('the new settings would add or drop other hook events: nothing changed')
    for event in bh:
        if event in FIVE or event in APPENDED:
            continue
        if bh[event] != ah[event]:
            raise Refusal('the new settings would change hooks.%s: nothing changed' % event)
    for event, (gi, hi) in where.items():
        expected = copy.deepcopy(bh[event])
        expected[gi]['hooks'][hi]['command'] = command(NEW_FILTER, FIVE[event])
        if ah[event] != expected:
            raise Refusal('the new settings would change hooks.%s beyond its filter: nothing changed' % event)
    # Append only: every old entry stays as it was, in its place, and one new entry follows.
    # On PermissionRequest that is what keeps the exact-command Bash entry (at `exact`)
    # unchanged where it was, so it needs no check of its own.
    for event in APPENDED:
        old = bh.get(event, [])
        if ah[event][:len(old)] != old or ah[event][len(old):] != [new_group()]:
            what = 'the exact-command Bash entry would not stay unchanged in its place (entry %d)' % exact if event == 'PermissionRequest' else 'the new settings would not just append to hooks.%s' % event
            raise Refusal('%s: nothing changed' % what)


def dump(settings):
    return json.dumps(settings, indent=2, ensure_ascii=False) + '\n'


def hooks_diff(before, after, path):
    return difflib.unified_diff(
        dump(before['hooks']).splitlines(True), dump(after['hooks']).splitlines(True),
        fromfile='%s: hooks' % path, tofile='%s: hooks (with matching)' % path)


def identity(info):
    """What says the file is still the one read: its device, inode, size and mtime."""
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def read_nofollow(path):
    """(text, stat) of the file, opened without following a symlink: a symlink swapped in
    after the lstat check is refused, not read through."""
    try:
        # O_NONBLOCK: a FIFO swapped in is not waited on (a regular file reads the same).
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as err:
        raise Refusal('%s could not be opened as a regular file (%s): nothing changed' % (path, err.strerror))
    # Checked on the descriptor before it becomes a file object (a folder can't).
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise Refusal('%s is not a regular file: nothing changed' % path)
    with os.fdopen(fd, 'r', encoding='utf-8') as f:
        return f.read(), info


def still_same(path, text, info):
    """A Refusal unless the file is still the one read: same identity and text."""
    now_text, now_info = read_nofollow(path)
    if identity(now_info) != identity(info) or now_text != text:
        raise Refusal('%s changed while this ran: nothing changed, run it again' % path)


def write_backup(path, text):
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = '%s.bak-%s' % (path, stamp)
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(backup, 0o600)
    return backup


def write_atomic(path, text, mode, expect=None):
    """Write `text` to a temp file beside `path` and rename it over. With `expect`
    (the text and stat read), the file is checked just before the rename and left alone
    when it changed meanwhile (a Refusal)."""
    folder = os.path.dirname(path) or '.'
    fd, tmp = tempfile.mkstemp(prefix='.settings.', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        if expect is not None:
            still_same(path, *expect)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv):
    ap = argparse.ArgumentParser(description='Add tool-use matching to the needs-you hooks (dry run unless --apply).')
    ap.add_argument('--apply', action='store_true', help='write the change (a backup first); without it, a dry run')
    ap.add_argument('--settings', default=SETTINGS_DEFAULT, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    settings_path = os.path.expanduser(args.settings)

    try:
        info = os.lstat(settings_path)
    except OSError:
        print('refused: %s is not there: nothing changed' % settings_path, file=sys.stderr)
        return 1
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        print('refused: %s is a symlink or not a regular file: nothing changed' % settings_path, file=sys.stderr)
        return 1
    try:
        text, read_info = read_nofollow(settings_path)
        if (read_info.st_dev, read_info.st_ino) != (info.st_dev, info.st_ino):
            raise Refusal('%s was replaced while this ran: nothing changed, run it again' % settings_path)
        after, before = plan(text)
    except Refusal as why:
        print('refused: %s' % why, file=sys.stderr)
        return 1
    after_text = dump(after)
    relaid = dump(before) != text

    if not args.apply:
        sys.stdout.writelines(hooks_diff(before, after, settings_path))
        if relaid:
            print('note: the file is not in two-space JSON now; --apply would also re-lay it out (the settings stay the same)', file=sys.stderr)
        print('dry run: 5 filters would change and 3 entries be appended; nothing written (run again with --apply)', file=sys.stderr)
        return 0

    # Read again just before writing: a session may have saved settings meanwhile. And
    # again just before the rename (write_atomic's `expect`), after the backup.
    try:
        still_same(settings_path, text, read_info)
    except Refusal as why:
        print('refused: %s' % why, file=sys.stderr)
        return 1
    backup = write_backup(settings_path, text)
    try:
        write_atomic(settings_path, after_text, stat.S_IMODE(info.st_mode), expect=(text, read_info))
    except Refusal as why:
        print('refused: %s (the backup %s was made first and is left)' % (why, backup), file=sys.stderr)
        return 1
    try:
        written, _ = read_nofollow(settings_path)
    except Refusal:
        written = None
    if written != after_text:
        write_atomic(settings_path, text, stat.S_IMODE(info.st_mode))
        print('failed: the file read back differs from what was written; the old settings are put back (backup %s)' % backup, file=sys.stderr)
        return 1
    print('changed 5 needs-you filters and appended 3 entries%s; backup: %s' % (' (the file was re-laid out as two-space JSON)' if relaid else '', backup))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
