#!/usr/bin/python3 -I
"""Move the six needs-you hooks in ~/.claude/settings.json from the TCP port to the
ingest socket (README "What the ingest endpoints require"; NEXT.md section 10).

Run it after the service restart that brings the socket up, never before:

    /usr/bin/python3 -I ~/Projects/claude-control-room/deploy/swap-needs-you-hooks.py --dry-run
    /usr/bin/python3 -I ~/Projects/claude-control-room/deploy/swap-needs-you-hooks.py

What it changes, in each of exactly six hook commands, and nothing else:

    curl -s -m N -X POST http://127.0.0.1:8322/api/ingest/needs-you
 -> /usr/bin/curl -q -s -m N --noproxy '*' --unix-socket "$HOME/.local/state/jarvis-os/ingest.sock" -X POST http://localhost/api/ingest/needs-you

keeping each hook's own -m N, its jq filter, its event, matcher and `async`. The edit is
made on the file's text, so its layout stays as it was, and then checked on the parsed
JSON: the new settings must equal the old ones with only those six commands changed.

It stops, changing nothing, when:
  - the file is not there, is a symlink, or is not a JSON object with a "hooks" object
    (the check `jq -e .` would make, and a little more);
  - it holds other than six old needs-you commands, or a command that posts to the TCP
    ingest in any other form, or the result would not hold exactly six socket commands
    and none of the old;
  - the socket (~/.local/state/jarvis-os/ingest.sock) is not a socket of this user's,
    mode 0600: the server must be up on the new build first, or every hook post is lost.

When it writes: a backup beside the file first (settings.json.bak-YYYYMMDD-HHMMSS, 0600,
never overwriting one), then a temporary file in the same folder, flushed and renamed
over the original with the original's mode, then the file is read back and checked.
To undo: copy the backup back over settings.json.

--dry-run prints the diff and what would stop it, and writes nothing.
--settings and --socket name other paths: for the tests, which run on fixture copies.
"""
import argparse
import difflib
import json
import os
import re
import stat
import sys
import tempfile
import time

SOCKET_DEFAULT = '~/.local/state/jarvis-os/ingest.sock'
SETTINGS_DEFAULT = '~/.claude/settings.json'
EXPECTED = 6

# The old command's TCP part, as README gave it before 2026-11-12 (curl from PATH or
# /usr/bin, silent, a time limit, the loopback port). Nothing in it needs a JSON escape,
# so it reads the same in the file's text and in the parsed string. Never preceded by a
# word character or a slash (Ultron's 11-12 low): `/opt/homebrew/bin/curl …` or `xcurl …`
# must not half-match and become `/opt/homebrew/bin//usr/bin/curl …`; such a command is
# an unknown form, and the script refuses.
OLD = re.compile(r"(?<![\w/])(?:/usr/bin/)?curl -s -m (\d+) -X POST http://127\.0\.0\.1:8322/api/ingest/needs-you(?![\w/-])")
# Any post to the TCP ingest at all: each must be one of the above.
ANY_TCP_INGEST = re.compile(r"127\.0\.0\.1:8322/api/ingest|localhost:8322/api/ingest")
NEW_FORM = ("/usr/bin/curl -q -s -m {m} --noproxy '*' --unix-socket "
            "\"$HOME/.local/state/jarvis-os/ingest.sock\" -X POST http://localhost/api/ingest/needs-you")
NEW = re.compile(re.escape(NEW_FORM).replace(r'\{m\}', r'\d+'))


class Refusal(Exception):
    pass


def commands(settings):
    """Every hook command string, in order."""
    out = []
    hooks = settings.get('hooks') if isinstance(settings, dict) else None
    if not isinstance(hooks, dict):
        return out
    for groups in hooks.values():
        if not isinstance(groups, list):
            continue
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
                continue
            for hook in group['hooks']:
                if isinstance(hook, dict) and isinstance(hook.get('command'), str):
                    out.append(hook['command'])
    return out


def swap_command(command):
    return OLD.sub(lambda m: NEW_FORM.format(m=m.group(1)), command)


def expected_after(settings):
    """The parsed settings with each hook command swapped, everything else as it was."""
    if isinstance(settings, dict):
        return {k: (swap_command(v) if k == 'command' and isinstance(v, str) else expected_after(v)) for k, v in settings.items()}
    if isinstance(settings, list):
        return [expected_after(v) for v in settings]
    return settings


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


def count(cmds):
    old = sum(len(OLD.findall(c)) for c in cmds)
    new = sum(len(NEW.findall(c)) for c in cmds)
    return old, new


def plan(text):
    """The new text, or a Refusal saying why not."""
    before = parse(text, 'the settings file')
    cmds = commands(before)
    old, new = count(cmds)
    if old != EXPECTED:
        raise Refusal('found %d old needs-you hook commands, not %d: nothing changed' % (old, EXPECTED))
    if new != 0:
        raise Refusal('found %d needs-you hook commands already on the socket: nothing changed' % new)
    odd = [c for c in cmds if ANY_TCP_INGEST.search(OLD.sub('', c))]
    if odd:
        raise Refusal('%d hook command(s) post to the TCP ingest in a form this script does not know: nothing changed' % len(odd))
    if len(OLD.findall(text)) != EXPECTED:
        raise Refusal('the file\'s text holds %d old commands, not %d (an escaped form?): nothing changed' % (len(OLD.findall(text)), EXPECTED))
    # The swap on the text, so the layout stays; JSON-escaped, so "$HOME/…" is \"$HOME/…\".
    after_text = OLD.sub(lambda m: json.dumps(NEW_FORM.format(m=m.group(1)))[1:-1], text)
    after = parse(after_text, 'the new settings')
    old_after, new_after = count(commands(after))
    if (old_after, new_after) != (0, EXPECTED):
        raise Refusal('the new settings would hold %d old and %d socket commands, not 0 and %d: nothing changed' % (old_after, new_after, EXPECTED))
    if after != expected_after(before):
        raise Refusal('the new settings would differ from the old in more than the six commands: nothing changed')
    return after_text


def socket_problem(path):
    try:
        info = os.lstat(path)
    except OSError:
        return 'the ingest socket %s is not there: restart the service on the new build first' % path
    if not stat.S_ISSOCK(info.st_mode):
        return '%s is not a socket' % path
    if info.st_uid != os.getuid():
        return 'the ingest socket %s is not owned by this user' % path
    if stat.S_IMODE(info.st_mode) != 0o600:
        return 'the ingest socket %s is mode %o, not 0600' % (path, stat.S_IMODE(info.st_mode))
    return None


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


def write_atomic(path, text, mode):
    folder = os.path.dirname(path) or '.'
    fd, tmp = tempfile.mkstemp(prefix='.settings.', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv):
    ap = argparse.ArgumentParser(description='Move the six needs-you hooks to the ingest socket.')
    ap.add_argument('--dry-run', action='store_true', help='print the diff and any refusal; write nothing')
    ap.add_argument('--settings', default=SETTINGS_DEFAULT, help=argparse.SUPPRESS)
    ap.add_argument('--socket', default=SOCKET_DEFAULT, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    settings_path = os.path.expanduser(args.settings)
    socket_path = os.path.expanduser(args.socket)

    try:
        info = os.lstat(settings_path)
    except OSError:
        print('refused: %s is not there: nothing changed' % settings_path, file=sys.stderr)
        return 1
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        print('refused: %s is a symlink or not a regular file: nothing changed' % settings_path, file=sys.stderr)
        return 1
    with open(settings_path, encoding='utf-8') as f:
        text = f.read()

    try:
        after_text = plan(text)
    except Refusal as why:
        print('refused: %s' % why, file=sys.stderr)
        return 1
    problem = socket_problem(socket_path)

    if args.dry_run:
        sys.stdout.writelines(difflib.unified_diff(
            text.splitlines(True), after_text.splitlines(True), fromfile=settings_path, tofile=settings_path + ' (swapped)'))
        if problem:
            print('would refuse: %s' % problem, file=sys.stderr)
            return 1
        print('dry run: %d commands would move to the socket; nothing written' % EXPECTED, file=sys.stderr)
        return 0

    if problem:
        print('refused: %s: nothing changed' % problem, file=sys.stderr)
        return 1
    # Read again just before writing: a session may have saved settings meanwhile.
    with open(settings_path, encoding='utf-8') as f:
        if f.read() != text:
            print('refused: %s changed while this ran: nothing changed, run it again' % settings_path, file=sys.stderr)
            return 1
    backup = write_backup(settings_path, text)
    write_atomic(settings_path, after_text, stat.S_IMODE(info.st_mode))
    with open(settings_path, encoding='utf-8') as f:
        written = f.read()
    if written != after_text:
        write_atomic(settings_path, text, stat.S_IMODE(info.st_mode))
        print('failed: the file read back differs from what was written; the old settings are put back (backup %s)' % backup, file=sys.stderr)
        return 1
    print('moved %d hook commands to the ingest socket; backup: %s' % (EXPECTED, backup))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
