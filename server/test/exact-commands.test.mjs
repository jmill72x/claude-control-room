// The exact text of a Bash command for approvals (design 0.2; lib/exact-commands.mjs):
// the report's check, the two-minute store, the match by content in the approvals gate,
// the two policy tiers, the loopback ingest and the README's hook entry, which is run
// here against a scratch server on its own port (never :8322). Every name, path and id
// is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  foldWhitespace, exactTextOk, checkExactReport, createExactCommands,
  EXACT_TTL_MS, EXACT_WINDOW_BEFORE_MS, EXACT_WINDOW_AFTER_MS, EXACT_MAX_CHARS, EXACT_KEEP
} from '../lib/exact-commands.mjs';
import { createApprovals, denyOnlyReasons, readApprovalsConfig, shownHash, NO_EXACT } from '../lib/approvals.mjs';
import { createHandler, createIngestHandler } from '../routes.mjs';
import { chatEventLine } from '../lib/chat-events.mjs';
import { createCache } from '../cache.mjs';

// A short scratch HOME: macOS caps a Unix socket path at 104 bytes, and the socket sits
// 35 below it.
const scratchHome = () => mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'ih-'));

const T0 = 1794380000000;
const HOME = '/home/owner';
const APP = '/home/owner/Projects/app';
const LEAD = 'lead-session-1';
const noReal = () => null;
const has = (list, re) => list.some(r => re.test(r));
const cp = n => String.fromCodePoint(n);

test('the fold is the relay\'s (Claude Code 2.1.323, 11-13): each run of spaces becomes one space, nothing is trimmed, and nothing else is touched', () => {
  assert.equal(foldWhitespace("printf 'a  b' > t5.txt"), "printf 'a b' > t5.txt");
  assert.equal(foldWhitespace('  touch t6.txt  '), ' touch t6.txt ', 'leading and trailing runs fold, they are not dropped');
  assert.equal(foldWhitespace('a    b'), 'a b');
  assert.equal(foldWhitespace('touch t2.txt\ntouch t3.txt'), 'touch t2.txt\ntouch t3.txt', 'a line break stays');
  assert.equal(foldWhitespace('touch\tt4.txt'), 'touch\tt4.txt', 'a tab stays');
  assert.equal(foldWhitespace('a \t\n  b'), 'a \t\n b', 'only the run of spaces folds');
  assert.equal(foldWhitespace('a\t\tb\n\nc'), 'a\t\tb\n\nc', 'runs of tabs and line breaks stay');
  assert.equal(foldWhitespace('a\r\nb'), 'a\r\nb');
  assert.equal(foldWhitespace('ls\n'), 'ls\n');
  assert.equal(foldWhitespace('one two'), 'one two');
  assert.equal(foldWhitespace(`a${cp(0xa0)}${cp(0xa0)}b`), `a${cp(0xa0)}${cp(0xa0)}b`, 'other whitespace stays');
});

test('text the card can show in full: printable ASCII, line breaks and tabs only', () => {
  for (const ok of ['ls', 'cat a\nrm b', 'a\tb', ' ~!@ ']) assert.equal(exactTextOk(ok), true, JSON.stringify(ok));
  for (const bad of ['', 'a\rb', 'a\r\nb', `a${cp(0)}b`, `a${cp(0x1b)}[0m`, `a${cp(0x7f)}`, `caf${cp(0xe9)}`, `a${cp(0x202e)}b`, `a${cp(0xa0)}b`, 7, null, undefined]) {
    assert.equal(exactTextOk(bad), false, JSON.stringify(bad));
  }
});

test('a report is the hook\'s JSON for a Bash PermissionRequest: session and command, nothing else read', () => {
  const body = (extra = {}) => ({ hook_event_name: 'PermissionRequest', session_id: LEAD, tool_name: 'Bash', command: 'ls -la', ...extra });
  assert.deepEqual(checkExactReport(body({ transcript_path: '/x', cwd: '/y', at: 5 })), { ok: true, value: { sessionId: LEAD, command: 'ls -la' } });
  assert.equal(checkExactReport(body({ command: ' a\n\tb ' })).value.command, ' a\n\tb ', 'kept character for character');
  for (const bad of [null, [], 'x', body({ hook_event_name: 'PreToolUse' }), body({ hook_event_name: 'PermissionDenied' }), body({ tool_name: 'Monitor' }), body({ tool_name: 'Write' }),
    body({ tool_name: undefined }), body({ session_id: 'a b' }), body({ session_id: 7 }), body({ session_id: 'x'.repeat(81) }), body({ command: '' }), body({ command: null }),
    body({ command: ['ls'] }), body({ command: 'x'.repeat(EXACT_MAX_CHARS + 1) })]) {
    assert.equal(checkExactReport(bad).ok, false, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(checkExactReport(body({ command: 'x'.repeat(EXACT_MAX_CHARS) })).ok, true);
});

test('the store: memory for two minutes, a window around the relay time, distinct texts, and a conflict when two differ', () => {
  const clock = { t: T0 };
  const s = createExactCommands({ now: () => clock.t });
  s.note('cat a  rm b');
  assert.deepEqual(s.candidates('cat a rm b', T0), { texts: ['cat a  rm b'], unusable: false, conflict: false, evicted: false });
  assert.deepEqual(s.candidates('cat a  rm b', T0).texts, ['cat a  rm b'], 'a relay that did not fold matches outright');
  assert.deepEqual(s.candidates('cat a rm', T0).texts, [], 'character for character');
  assert.deepEqual(s.candidates('cat a rm b ', T0).texts, []);
  assert.deepEqual(s.candidates('cat a rm  b', T0).texts, []);
  assert.deepEqual(s.candidates('cat a\nrm b', T0).texts, [], 'a line break is never a space');
  // The window: the report came up to 1 s before the relay, or up to 2 s after.
  assert.equal(s.candidates('cat a rm b', T0 + EXACT_WINDOW_BEFORE_MS).texts.length, 1);
  assert.equal(s.candidates('cat a rm b', T0 + EXACT_WINDOW_BEFORE_MS + 1).texts.length, 0);
  assert.equal(s.candidates('cat a rm b', T0 - EXACT_WINDOW_AFTER_MS).texts.length, 1);
  assert.equal(s.candidates('cat a rm b', T0 - EXACT_WINDOW_AFTER_MS - 1).texts.length, 0);
  assert.equal(s.candidates('cat a rm b', NaN).texts.length, 0);
  assert.equal(s.candidates(null, T0).texts.length, 0);
  // The same text twice is one candidate; a different text with the same fold is a conflict.
  s.note('cat a  rm b');
  assert.deepEqual(s.candidates('cat a rm b', T0), { texts: ['cat a  rm b'], unusable: false, conflict: false, evicted: false });
  s.note('cat a rm b');
  assert.deepEqual(s.candidates('cat a rm b', T0), { texts: ['cat a  rm b', 'cat a rm b'], unusable: false, conflict: true, evicted: false });
  // Two minutes, then gone.
  clock.t = T0 + EXACT_TTL_MS - 1;
  assert.equal(s.size(), 3);
  clock.t = T0 + EXACT_TTL_MS;
  assert.equal(s.size(), 0);
  assert.deepEqual(s.candidates('cat a rm b', T0).texts, []);
});

test('the store: a matching report that cannot be shown counts against the match; at most 40 are kept', () => {
  const clock = { t: T0 };
  const s = createExactCommands({ now: () => clock.t });
  s.note('ls /a\r\nrm  /b');
  assert.deepEqual(s.candidates('ls /a\r\nrm /b', T0), { texts: [], unusable: true, conflict: false, evicted: false });
  // (A plain copy can't share its fold: the fold keeps the carriage return.)
  s.note('ls /a\nrm /b');
  assert.deepEqual(s.candidates('ls /a\r\nrm /b', T0), { texts: [], unusable: true, conflict: false, evicted: false });
  const many = createExactCommands({ now: () => clock.t });
  many.note('first');
  for (let i = 0; i < EXACT_KEEP; i++) many.note(`cmd ${i}`);
  assert.equal(many.size(), EXACT_KEEP);
  assert.deepEqual(many.candidates('first', T0).texts, [], 'the oldest went first');
  assert.deepEqual(many.candidates(`cmd ${EXACT_KEEP - 1}`, T0), { texts: [`cmd ${EXACT_KEEP - 1}`], unusable: false, conflict: true, evicted: true }, 'and since one was dropped, a match is a conflict');
});

test('the cap (Ultron, 11-11): once a report is dropped, every match is a conflict until the dropped one would have been forgotten', () => {
  const clock = { t: T0 };
  const s = createExactCommands({ now: () => clock.t });
  const real = 'cat /a  rm /b';
  const forged = 'cat /a rm /b';
  // The real report, then a flood of 40 unrelated ones a second later pushes it out, and a forged copy lands in the window.
  s.note(real);
  clock.t += 1000;
  for (let i = 0; i < EXACT_KEEP - 1; i++) s.note(`noise ${i}`);
  assert.deepEqual(s.candidates(forged, clock.t).texts, [real], 'exactly 40: nothing dropped yet');
  assert.equal(s.candidates(forged, clock.t).conflict, false);
  s.note(forged);
  assert.equal(s.size(), EXACT_KEEP);
  assert.deepEqual(s.candidates(forged, clock.t), { texts: [forged], unusable: false, conflict: true, evicted: true }, 'the forged copy is alone in the store, but it is not a match');
  assert.equal(s.disputes(forged, forged), 'evicted');
  // A text with no report at all is no match, so no conflict either.
  assert.deepEqual(s.candidates('pwd', clock.t), { texts: [], unusable: false, conflict: false, evicted: false });
  // It holds until the dropped report would have been forgotten (it came at T0), not a moment longer.
  const flooded = clock.t;
  clock.t = T0 + EXACT_TTL_MS - 1;
  assert.equal(s.candidates(forged, flooded).conflict, true);
  assert.equal(s.disputes(forged, forged), 'evicted');
  clock.t = T0 + EXACT_TTL_MS;
  assert.deepEqual(s.candidates(forged, flooded), { texts: [forged], unusable: false, conflict: false, evicted: false });
  assert.equal(s.disputes(forged, forged), false);
  // A later flood moves the end out: the newest dropped report counts.
  const f = createExactCommands({ now: () => clock.t });
  for (let i = 0; i < EXACT_KEEP + 3; i++) { f.note(`n ${i}`); clock.t += 100; }
  const lastDropped = clock.t - (EXACT_KEEP + 1) * 100;
  const newest = clock.t - 100;
  clock.t = lastDropped + EXACT_TTL_MS - 1;
  assert.equal(f.candidates(`n ${EXACT_KEEP + 2}`, newest).evicted, true);
  clock.t = lastDropped + EXACT_TTL_MS;
  assert.equal(f.candidates(`n ${EXACT_KEEP + 2}`, newest).evicted, false);
});

test('outside the window (Ultron, 11-11): a different report for the same preview is a conflict whenever it came, while it is kept', () => {
  const clock = { t: T0 };
  const s = createExactCommands({ now: () => clock.t });
  const real = 'cat /a  rm /b';
  const forged = 'cat /a rm /b';
  // The real report came 2 s before the relay (outside the window), the forged one inside it.
  s.note(real);
  clock.t += EXACT_WINDOW_BEFORE_MS + 1000;
  s.note(forged);
  const relayed = clock.t - 1000 + 1;
  assert.deepEqual(s.candidates(forged, relayed), { texts: [forged], unusable: false, conflict: true, evicted: false });
  // The same text outside the window is no rival.
  const same = createExactCommands({ now: () => clock.t });
  same.note(forged);
  clock.t += 60e3;
  same.note(forged);
  assert.deepEqual(same.candidates(forged, clock.t), { texts: [forged], unusable: false, conflict: false, evicted: false });
  // A report that can't be shown, outside the window, counts too; a non-matching one never does.
  const cr = createExactCommands({ now: () => clock.t });
  cr.note('cat /a\r  rm /b');
  cr.note('cat /z');
  clock.t += 40e3;
  cr.note('cat /a\r rm /b');
  assert.equal(cr.candidates('cat /a\r rm /b', clock.t).unusable, true);
  assert.equal(cr.candidates('cat /a\r rm /b', clock.t).conflict, false, 'two that can\'t be shown are no rivals: neither is drawn');
  assert.equal(cr.candidates('cat /z', clock.t + EXACT_WINDOW_BEFORE_MS + 1).conflict, false, 'only reports outside the window: no match, so no conflict');
  // Rivals after the window, too (a report that came well after the relay).
  const after = createExactCommands({ now: () => clock.t });
  after.note(forged);
  const at = clock.t;
  clock.t += EXACT_WINDOW_AFTER_MS + 10e3;
  after.note(real);
  assert.equal(after.candidates(forged, at).conflict, true);
  // disputes(): store-wide, from the card's point of view.
  assert.equal(after.disputes(forged, forged), 'differs');
  assert.equal(after.disputes(forged, real), 'differs');
  assert.equal(after.disputes('cat /q', 'cat /q'), false);
  assert.equal(after.disputes(null, forged), false);
  // Once a report is forgotten it no longer counts: the first one is gone here, the later one is not.
  clock.t = at + EXACT_TTL_MS;
  assert.equal(after.disputes(forged, real), false, 'only the card\'s own text is left');
  assert.equal(after.disputes(forged, forged), 'differs', 'a card that showed the forgotten text still meets its rival');
});

// ---- the gate ----

const gate = (extra = {}) => {
  const env = { clock: { t: T0 }, events: [], files: new Set() };
  env.a = createApprovals({
    mode: 'on', bash: 'exact', home: HOME, realpath: noReal, now: () => env.clock.t, onEvent: e => env.events.push(e),
    killPath: '/k/off', exists: p => env.files.has(p), isLeadSession: id => id === LEAD, isLink: () => false, isExecutable: () => false, ...extra
  });
  env.a.noteChannelRelay('allow');
  env.report = (command, sessionId = LEAD) => env.a.noteExact({ sessionId, command });
  // A stored request as the store builds it, assessed the way openPermission does.
  env.open = (previewCommand, more = {}) => {
    const p = { tool: 'Bash', description: 'd', inputPreview: JSON.stringify({ command: previewCommand }), relayedAt: env.clock.t, openedAt: env.clock.t, state: 'open', ...more };
    const r = env.a.assess(p);
    p.denyOnly = r.denyOnly;
    p.exact = r.exact;
    return p;
  };
  return env;
};

test('exact mode: no report means Deny-only; one report gives the exact text and tier 1 allows a strict one-liner', () => {
  const env = gate();
  const none = env.open(`cat ${APP}/notes.txt`);
  assert.equal(none.exact, null);
  assert.deepEqual(none.denyOnly, [NO_EXACT], 'the hook never decides: silence is Deny-only');
  assert.equal(env.a.view(none).canAllow, false);
  assert.equal(env.report(`cat ${APP}/notes.txt`), 'kept');
  const p = env.open(`cat ${APP}/notes.txt`);
  assert.equal(p.exact, `cat ${APP}/notes.txt`);
  assert.deepEqual(p.denyOnly, []);
  assert.equal(env.a.view(p).canAllow, true);
  assert.deepEqual(env.events, []);
  // The same tier-1 rules as before, now over the exact text.
  env.report('rm -rf /home/owner/Projects/app');
  assert.ok(has(env.open('rm -rf /home/owner/Projects/app').denyOnly, /not on the short list/));
  env.report('ls | sh');
  assert.ok(has(env.open('ls | sh').denyOnly, /shell syntax/));
});

test('exact mode: a two-liner is caught, because the exact text keeps its line break', () => {
  const env = gate();
  const real = `cat ${APP}/notes.txt\nrm -rf /home/owner/Projects`;
  env.report(real);
  const p = env.open(foldWhitespace(real));
  assert.equal(p.exact, real, 'the card gets the text with its line break');
  assert.ok(has(p.denyOnly, /more than one line/), p.denyOnly.join('; '));
  assert.equal(env.a.view(p).canAllow, false);
  // A tab, and a trailing line break, are not one plain line either (the relay keeps both).
  env.report('ls\t/home/owner/Projects/app');
  assert.ok(has(env.open('ls\t/home/owner/Projects/app').denyOnly, /more than one line, or a tab/));
  assert.deepEqual(env.open('ls /home/owner/Projects/app').denyOnly, [NO_EXACT], 'a tab is never matched to a space');
  const env2 = gate();
  env2.report('pwd\n');
  assert.ok(has(env2.open('pwd\n').denyOnly, /more than one line/));
  assert.deepEqual(env2.open('pwd ').denyOnly, [NO_EXACT]);
  // Spaces inside quotes fold: the card shows the two spaces the relay lost.
  const q = gate();
  q.report(`ls '${APP}/a  b'`);
  assert.equal(q.open(`ls '${APP}/a b'`).exact, `ls '${APP}/a  b'`);
  // Leading and trailing spaces fold to one space each: the match is still exact.
  const env3 = gate();
  env3.report('  pwd  ');
  assert.equal(env3.open(' pwd ').exact, '  pwd  ');
  assert.equal(env3.open('pwd').exact, null, 'a relay that trimmed would not match: Deny-only, the safe side');
});

test('exact mode, tier 2: a command listed in config is allowed character for character, line breaks included; nothing near it is', () => {
  const listed = 'cd /home/owner/Projects/app && npm test\necho done';
  const env = gate({ bashCommands: [listed, 'git -C /home/owner/Projects/app pull --ff-only'] });
  env.report(listed);
  const p = env.open(foldWhitespace(listed));
  assert.equal(p.exact, listed);
  assert.deepEqual(p.denyOnly, []);
  assert.equal(env.a.view(p).canAllow, true);
  const near = gate({ bashCommands: [listed] });
  for (const text of [listed + ' ', listed.replace('\n', ' '), listed.replace('\n', '\n\n'), listed + '\nrm -rf /x', listed.toUpperCase()]) {
    near.report(text);
    const q = near.open(foldWhitespace(text));
    assert.ok(q.denyOnly.length > 0, JSON.stringify(text));
  }
  // Not listed and not a strict one-liner: Deny-only, whatever it is.
  const plain = gate();
  plain.report('npm test');
  assert.ok(has(plain.open('npm test').denyOnly, /not on the short list/));
  // A listed command is still held to the tool's known inputs and to the hidden-text rules.
  const env4 = gate({ bashCommands: ['npm test'] });
  env4.report('npm test');
  assert.ok(has(env4.open('npm test', { inputPreview: JSON.stringify({ command: 'npm test', run_in_background: true }) }).denyOnly, /not one this tool is known to take/));
  // The pure rule, without the gate: the list is compared with the exact text only.
  const r = (exact, cmd, bashCommands) => denyOnlyReasons({ tool: 'Bash', inputPreview: JSON.stringify({ command: cmd }) }, { home: HOME, realpath: noReal, bash: 'exact', exact, bashCommands, isLink: () => false, isExecutable: () => false });
  assert.deepEqual(r('npm test', 'npm test', ['npm test']), []);
  assert.ok(has(r('npm  test', 'npm test', ['npm test']), /not on the short list/), 'two spaces is another command text');
  assert.ok(has(r('npm test', 'npm run', ['npm test']), /does not match the preview/), 'an exact text for some other preview is refused');
  assert.ok(has(r(`caf${cp(0xe9)}`, `caf${cp(0xe9)}`, [`caf${cp(0xe9)}`]), /outside plain ASCII/));
  assert.deepEqual(r(null, 'npm test', ['npm test']), [NO_EXACT], 'the preview alone never matches the list');
  assert.ok(has(denyOnlyReasons({ tool: 'Bash', inputPreview: '{"command":"npm test"}' }, { home: HOME, realpath: noReal, exact: 'npm test', bashCommands: ['npm test'] }), /Bash is answered at the terminal/), 'the default mode ignores both');
});

test('a forged report can only tie: two different texts for one preview are Deny-only and alerted, before or after the card opens', () => {
  const real = `cat ${APP}/a\nrm  ${APP}/b`;
  const forged = `cat ${APP}/a\nrm ${APP}/b`;
  // Both there when the request opens, in either order.
  for (const order of [[real, forged], [forged, real]]) {
    const env = gate();
    for (const text of order) env.report(text);
    const p = env.open(forged);
    assert.equal(p.exact, null, 'no text is shown as exact');
    assert.ok(has(p.denyOnly, /two different exact copies/));
    assert.equal(env.a.view(p).canAllow, false);
    assert.deepEqual(env.events, [{ kind: 'approvals-exact-conflict' }]);
  }
  // The second one lands after the card opened: Allow is refused from then on, alerted once, for good.
  const env = gate({ bashCommands: [forged] });
  env.report(forged);
  const p = env.open(forged);
  assert.equal(env.a.view(p).canAllow, true);
  env.clock.t += 2000;
  env.report(real);
  assert.ok(has(env.a.reasonsNow(p), /two different exact copies/));
  assert.equal(env.a.view(p).canAllow, false);
  assert.equal(env.a.view(p).canAllow, false);
  assert.deepEqual(env.events, [{ kind: 'approvals-exact-conflict' }], 'one alert, not one per look');
  env.clock.t += EXACT_TTL_MS;
  assert.equal(env.a.view(p).canAllow, false, 'still, after the reports are forgotten');
  // The first report is forgotten before anyone looks again, the second is still there: caught all the same.
  const late = gate({ bashCommands: [forged] });
  late.report(forged);
  late.clock.t += 500;
  const lp = late.open(forged);
  assert.equal(lp.exact, forged);
  late.clock.t += 4e3;
  late.report(real);
  late.clock.t = T0 + EXACT_TTL_MS + 1;
  assert.ok(has(late.a.reasonsNow(lp), /two different exact copies/), 'the one text left is not the one the card showed');
  assert.deepEqual(late.events, [{ kind: 'approvals-exact-conflict' }]);
  // The same text reported twice is no conflict.
  const twice = gate();
  twice.report(`cat ${APP}/a`);
  twice.report(`cat ${APP}/a`);
  const q = twice.open(`cat ${APP}/a`);
  assert.deepEqual(q.denyOnly, []);
  assert.equal(twice.a.view(q).canAllow, true);
  assert.deepEqual(twice.events, []);
  // A real command that can't be shown (a carriage return): Deny-only, with that reason.
  // (No plain copy can share its fold any more: the relay's fold keeps the carriage return.)
  const cr = gate();
  cr.report(`cat ${APP}/a\r\nrm ${APP}/b`);
  assert.ok(has(cr.open(`cat ${APP}/a\r\nrm ${APP}/b`).denyOnly, /outside plain ASCII, line breaks and tabs/));
});

test('the gate, Ultron\'s two conditions: a rival outside the window and a flood that drops reports both make the card Deny-only, at open or later', () => {
  const real = `cat ${APP}/a\nrm  ${APP}/b`;
  const forged = `cat ${APP}/a\nrm ${APP}/b`;
  const EVICTED = /so many exact-command reports came in two minutes that some were dropped unread/;
  // The real report 2 s before the relay: outside the window, but it still ties with the forged copy inside it.
  const out = gate({ bashCommands: [forged] });
  out.report(real);
  out.clock.t += EXACT_WINDOW_BEFORE_MS + 1000;
  out.report(forged);
  const op = out.open(forged);
  assert.equal(op.exact, null);
  assert.ok(has(op.denyOnly, /two different exact copies/));
  assert.deepEqual(out.events, [{ kind: 'approvals-exact-conflict' }]);
  // A rival that lands 12 s after the relay (past the 2 s window) still takes Allow away from an open card.
  const late = gate({ bashCommands: [forged] });
  late.report(forged);
  const lp = late.open(forged);
  assert.equal(late.a.view(lp).canAllow, true);
  late.clock.t += EXACT_WINDOW_AFTER_MS + 10e3;
  late.report(real);
  assert.equal(late.a.view(lp).canAllow, false);
  assert.ok(has(late.a.reasonsNow(lp), /two different exact copies/));
  assert.deepEqual(late.events, [{ kind: 'approvals-exact-conflict' }]);
  // A flood pushes the real report out before the request opens: the forged copy alone is no match.
  const flood = gate({ bashCommands: [forged] });
  flood.report(real);
  for (let i = 0; i < EXACT_KEEP; i++) flood.report(`echo ${i}`);
  flood.report(forged);
  const fp = flood.open(forged);
  assert.equal(fp.exact, null);
  assert.ok(has(fp.denyOnly, EVICTED), fp.denyOnly.join('; '));
  assert.equal(flood.a.view(fp).canAllow, false);
  assert.deepEqual(flood.events, [{ kind: 'approvals-exact-conflict', evicted: true }]);
  // A flood after the card opened: Allow goes, once, for good.
  const after = gate({ bashCommands: [forged] });
  after.report(forged);
  const ap = after.open(forged);
  assert.equal(after.a.view(ap).canAllow, true);
  for (let i = 0; i <= EXACT_KEEP; i++) after.report(`echo ${i}`);
  assert.equal(after.a.view(ap).canAllow, false);
  assert.ok(has(after.a.reasonsNow(ap), EVICTED));
  after.clock.t += EXACT_TTL_MS * 2;
  assert.equal(after.a.view(ap).canAllow, false, 'sticky, after the flood is forgotten');
  assert.deepEqual(after.events, [{ kind: 'approvals-exact-conflict', evicted: true }]);
  // Exactly 40 in two minutes drops nothing, so nothing changes.
  const full = gate({ bashCommands: [forged] });
  for (let i = 0; i < EXACT_KEEP - 1; i++) full.report(`echo ${i}`);
  full.report(forged);
  const fu = full.open(forged);
  assert.equal(fu.exact, forged);
  assert.equal(full.a.view(fu).canAllow, true);
  // The alert says which it was.
  assert.match(chatEventLine({ kind: 'approvals-exact-conflict', evicted: true }), /some were dropped unread/);
  assert.match(chatEventLine({ kind: 'approvals-exact-conflict' }), /two different exact-command reports/);
  // And which rules hold (Ultron's L3): Deny only when guarded, Allow kept in parity.
  for (const evicted of [false, true]) {
    assert.match(chatEventLine({ kind: 'approvals-exact-conflict', evicted }), /the card is Deny only$/);
    assert.doesNotMatch(chatEventLine({ kind: 'approvals-exact-conflict', evicted, parity: true }), /Deny only/);
    assert.match(chatEventLine({ kind: 'approvals-exact-conflict', evicted, parity: true }), /keeps Allow \(parity with the relay\)/);
    assert.match(chatEventLine({ kind: 'approvals-exact-conflict', evicted, parity: 'yes' }), /Deny only$/, 'only a plain true');
  }
});

test('parity with "exact" (board 8ecf3ca9; the owner\'s pick 11-13: mark, never gate): a match draws the exact text; a conflict, at open or later, takes the text off the card and marks it, and Allow stays', () => {
  const real = `ls ${APP}  # look\nrm -rf ${APP}`;
  const folded = foldWhitespace(real);
  const MARK = /A different command with the same look was reported.*Check the terminal before allowing/;
  // A match: the card carries the two lines, and Allow (parity).
  const m = gate({ rules: 'parity' });
  m.report(real);
  const mp = m.open(folded);
  assert.equal(mp.exact, real);
  assert.deepEqual(mp.denyOnly, []);
  assert.deepEqual(m.a.view(mp), { mode: 'on', denyOnly: [], canAllow: true }, 'no mark, and the view keeps its usual shape');
  // Conflicts at open, by a rival outside the window or by a flood: no exact text, a mark, alerted, Allow kept.
  const o = gate({ rules: 'parity' });
  o.report(folded);
  o.clock.t += EXACT_WINDOW_BEFORE_MS + 1000;
  o.report(real);
  const op = o.open(folded);
  assert.equal(op.exact, null, 'neither text is drawn as the exact one');
  assert.deepEqual(o.events, [{ kind: 'approvals-exact-conflict', parity: true }]);
  const ov = o.a.view(op);
  assert.equal(ov.canAllow, true);
  assert.equal(ov.exact, null);
  assert.match(ov.exactNote, MARK);
  const f = gate({ rules: 'parity' });
  for (let i = 0; i <= EXACT_KEEP; i++) f.report(`echo ${i}`);
  f.report(real);
  const fp = f.open(folded);
  assert.equal(fp.exact, null);
  assert.match(f.a.view(fp).exactNote, /Too many command reports came at once/);
  assert.equal(f.a.view(fp).canAllow, true);
  assert.deepEqual(f.events, [{ kind: 'approvals-exact-conflict', evicted: true, parity: true }]);
  // A card that drew a text, then a rival: the text comes off, the mark goes on, Allow stays; alerted once.
  const d = gate({ rules: 'parity' });
  d.report(real);
  const dp = d.open(folded);
  const before = shownHash(dp.tool, dp.description, dp.inputPreview, dp.exact);
  d.clock.t += 20e3;
  d.report(folded);
  const dv = d.a.view(dp);
  assert.deepEqual(dv.denyOnly, []);
  assert.equal(dv.canAllow, true);
  assert.equal(dv.exact, null);
  assert.match(dv.exactNote, MARK);
  assert.equal(dp.exact, null, 'gone from the request too, so the shown hash changes');
  assert.notEqual(shownHash(dp.tool, dp.description, dp.inputPreview, dp.exact), before);
  d.a.view(dp);
  assert.deepEqual(d.events, [{ kind: 'approvals-exact-conflict', parity: true }]);
  // A flood after the card drew a text: the other mark.
  const fl = gate({ rules: 'parity' });
  fl.report(real);
  const flp = fl.open(folded);
  for (let i = 0; i <= EXACT_KEEP; i++) fl.report(`echo ${i}`);
  assert.match(fl.a.view(flp).exactNote, /Too many command reports came at once/);
  assert.equal(fl.a.view(flp).canAllow, true);
  // Guarded stays as it was: a later rival is Deny-only, and the text stays on the card.
  const g = gate();
  g.report(`cat ${APP}/a`);
  const gp = g.open(`cat ${APP}/a`);
  g.report(`cat ${APP}/a`.replace(' ', '  '));
  assert.equal(g.a.view(gp).canAllow, false);
  assert.equal(gp.exact, `cat ${APP}/a`);
  assert.equal(g.a.view(gp).exactNote, undefined);
});

// The gate with open cards, as the chat store holds them: `env.open` adds the card to the
// open list, and every redraw is recorded.
const gateWithCards = (extra = {}) => {
  const cards = { list: [], redrawn: [] };
  const env = gate({ cards: { openPermissions: () => cards.list.filter(p => p.state === 'open'), redrawPermission: p => { cards.redrawn.push(p); return true; } }, ...extra });
  const open = env.open;
  env.open = (cmd, more) => { const p = open(cmd, more); cards.list.push(p); return p; };
  env.cards = cards;
  return env;
};

test('the report after the relay (measured 11-13: 20-25 ms after): a card opened with no text gains it, its rules worked out again, and is redrawn', () => {
  const cmd = `cat ${APP}/notes.txt`;
  const env = gateWithCards();
  const p = env.open(cmd);
  assert.equal(p.exact, null);
  assert.deepEqual(p.denyOnly, [NO_EXACT]);
  env.clock.t += 22;
  assert.equal(env.report(cmd), 'kept');
  assert.equal(p.exact, cmd);
  assert.deepEqual(p.denyOnly, [], 'tier 1 judged over the exact text');
  assert.equal(env.a.view(p).canAllow, true);
  assert.deepEqual(env.cards.redrawn, [p], 'redrawn once');
  assert.equal(p.exactGained, true);
  // A second copy of the same text changes nothing and redraws nothing.
  env.report(cmd);
  assert.equal(p.exact, cmd);
  assert.equal(env.cards.redrawn.length, 1);
  assert.deepEqual(env.events, []);
  // The rules still judge the text it gained: a two-liner is Deny-only, with the text shown.
  const two = `ls ${APP}\nrm -rf ${APP}`;
  const q = env.open(two);
  env.clock.t += 25;
  env.report(two);
  assert.equal(q.exact, two);
  assert.ok(has(q.denyOnly, /more than one line/));
  // A report for another command touches neither card.
  const r = env.open(`cat ${APP}/other.txt`);
  env.report(`cat ${APP}/else.txt`);
  assert.equal(r.exact, null);
  assert.equal(env.cards.redrawn.includes(r), false);
});

test('the report after the relay: only inside the window, only for an open Bash card still waiting, and only as its one candidate', () => {
  const cmd = `cat ${APP}/a`;
  // At the window's edge it counts; a millisecond past it, it doesn't.
  const edge = gateWithCards();
  const ep = edge.open(cmd);
  edge.clock.t += EXACT_WINDOW_AFTER_MS;
  edge.report(cmd);
  assert.equal(ep.exact, cmd);
  const past = gateWithCards();
  const pp = past.open(cmd);
  past.clock.t += EXACT_WINDOW_AFTER_MS + 1;
  past.report(cmd);
  assert.equal(pp.exact, null);
  assert.deepEqual(pp.denyOnly, [NO_EXACT]);
  assert.deepEqual(past.cards.redrawn, []);
  // A report from well before the relay (an earlier prompt) is never the card's text.
  const early = gateWithCards();
  early.report(cmd);
  early.clock.t += 5000;
  assert.equal(early.open(cmd).exact, null);
  early.clock.t += EXACT_WINDOW_BEFORE_MS;
  early.report(cmd);
  assert.equal(early.open(cmd).exact, cmd, 'one inside the 1 s before still is');
  // A closed card, a card of another tool, and one with a hidden part gain nothing.
  const other = gateWithCards();
  const closed = other.open(cmd);
  closed.state = 'denied';
  const read = { tool: 'Read', inputPreview: JSON.stringify({ command: cmd }), relayedAt: other.clock.t, state: 'open', denyOnly: ['x'], exact: null };
  other.cards.list.push(read);
  const masked = other.open('curl -H [REDACTED] https://example.test');
  other.clock.t += 20;
  other.report(cmd);
  other.report('curl -H [REDACTED] https://example.test');
  assert.equal(closed.exact, null);
  assert.equal(read.exact, null);
  assert.equal(masked.exact, null);
  assert.deepEqual(other.cards.redrawn, []);
  // Two different texts for the card's preview after it opened: the first gives the text,
  // the second is a rival as before (Deny-only, alerted once), whatever the order they came in.
  const real = `cat ${APP}/a\nrm  ${APP}/b`;
  const forged = `cat ${APP}/a\nrm ${APP}/b`;
  const tie = gateWithCards({ bashCommands: [forged] });
  const tp = tie.open(forged);
  tie.clock.t += 20;
  tie.report(forged);
  assert.equal(tie.a.view(tp).canAllow, true);
  tie.clock.t += 5;
  tie.report(real);
  assert.equal(tie.a.view(tp).canAllow, false);
  assert.ok(has(tie.a.reasonsNow(tp), /two different exact copies/));
  assert.deepEqual(tie.events, [{ kind: 'approvals-exact-conflict' }]);
  // A rival kept from before the window: the late report is a conflict, not a text.
  for (const rules of ['guarded', 'parity']) {
    const pre = gateWithCards({ bashCommands: [forged], rules });
    pre.report(real);
    pre.clock.t += EXACT_WINDOW_BEFORE_MS + 1000;
    const prp = pre.open(forged);
    assert.equal(prp.exact, null, 'nothing in the window yet');
    assert.deepEqual(pre.events, []);
    pre.clock.t += 22;
    pre.report(forged);
    assert.equal(prp.exact, null, rules);
    assert.deepEqual(pre.events, [{ kind: 'approvals-exact-conflict', ...(rules === 'parity' ? { parity: true } : {}) }], rules);
    assert.deepEqual(pre.cards.redrawn, [prp]);
    if (rules === 'parity') {
      assert.match(pre.a.view(prp).exactNote, /A different command with the same look/);
      assert.equal(pre.a.view(prp).canAllow, true);
    } else assert.ok(has(prp.denyOnly, /two different exact copies/), prp.denyOnly.join('; '));
    // Settled: a third report changes nothing more and alerts no more.
    pre.report(forged);
    assert.equal(pre.events.length, 1);
    assert.equal(pre.cards.redrawn.length, 1);
  }
});

test('the report after the relay, in parity: the card is allowable as relayed until the text comes, then shows it and stays allowable', () => {
  const real = `ls ${APP}  # look\nrm -rf ${APP}`;
  const env = gateWithCards({ rules: 'parity' });
  const p = env.open(foldWhitespace(real));
  assert.equal(p.exact, null);
  assert.equal(env.a.view(p).canAllow, true, 'parity: the folded card can be allowed, as today');
  env.clock.t += 23;
  env.report(real);
  assert.equal(p.exact, real);
  assert.deepEqual(env.a.view(p), { mode: 'on', denyOnly: [], canAllow: true });
  assert.deepEqual(env.cards.redrawn, [p]);
});

test('reports are kept only in exact mode with approvals on, only from the lead\'s session by name, and only inside the window', () => {
  const env = gate();
  assert.equal(env.report(`cat ${APP}/a`, 'someone-else'), 'other');
  assert.equal(env.report(`cat ${APP}/a`, null), 'other');
  assert.equal(env.a.noteExact(), 'other');
  assert.deepEqual(env.open(`cat ${APP}/a`).denyOnly, [NO_EXACT], 'another session\'s report was not kept');
  assert.equal(gate({ isLeadSession: () => { throw new Error('x'); } }).report('ls'), 'other');
  assert.equal(createApprovals({ mode: 'on', bash: 'exact' }).noteExact({ sessionId: LEAD, command: 'ls' }), 'other', 'nobody is the lead unless the server says who is');
  assert.equal(gate({ bash: 'deny' }).report('ls'), 'off');
  assert.equal(gate({ mode: 'off' }).report('ls'), 'off');
  const killed = gate();
  killed.files.add('/k/off');
  assert.equal(killed.report('ls'), 'off', 'the kill file');
  // The window is counted from the channel's relay time.
  const w = gate();
  w.report(`cat ${APP}/a`);
  w.clock.t += EXACT_WINDOW_BEFORE_MS + 1;
  assert.deepEqual(w.open(`cat ${APP}/a`).denyOnly, [NO_EXACT]);
  assert.deepEqual(w.open(`cat ${APP}/a`, { relayedAt: T0 + 1000 }).denyOnly, []);
});

test('a preview with a hidden part never gets an exact text, and the default mode keeps Bash Deny-only whatever was reported', () => {
  const env = gate({ bashCommands: ['curl -H [REDACTED] https://example.test'] });
  env.report('curl -H [REDACTED] https://example.test');
  const p = env.open('curl -H [REDACTED] https://example.test');
  assert.equal(p.exact, null);
  assert.ok(has(p.denyOnly, /part of it was masked/) && has(p.denyOnly, /hidden in the preview/), p.denyOnly.join('; '));
  const elided = gate();
  elided.report('ls a ⋯ 12 code points elided ⋯ b');
  assert.equal(elided.open('ls a ⋯ 12 code points elided ⋯ b').exact, null);
  // Only Bash: another tool with a `command` input gets nothing.
  const other = gate();
  other.report('pwd');
  assert.equal(other.a.assess({ tool: 'Read', inputPreview: '{"command":"pwd"}', relayedAt: T0 }).exact, null);
  assert.equal(readApprovalsConfig({}).bash, 'deny');
  assert.deepEqual(readApprovalsConfig({}).bashCommands, []);
});

test('config: approvalsBashCommands is a short list of plain commands; a bad list is ignored whole', () => {
  const read = list => readApprovalsConfig({ chat: { approvalsBash: 'exact', approvalsBashCommands: list } });
  assert.deepEqual(read(['npm test', 'a\n\tb']).bashCommands, ['npm test', 'a\n\tb']);
  for (const bad of ['npm test', [7], [''], ['   '], [`caf${cp(0xe9)}`], ['a\r\nb'], ['x'.repeat(2001)], Array.from({ length: 51 }, (_, i) => `c${i}`), ['ok', null]]) {
    const r = read(bad);
    assert.deepEqual(r.bashCommands, [], JSON.stringify(bad).slice(0, 60));
    assert.equal(r.problems.length, 1);
    assert.equal(r.bash, 'exact');
  }
});

test('the shown hash covers the exact text when the card showed one', () => {
  assert.equal(shownHash('Bash', 'd', '{"command":"a b"}'), shownHash('Bash', 'd', '{"command":"a b"}', null), 'no exact text: the hash as before');
  assert.notEqual(shownHash('Bash', 'd', '{"command":"a b"}', 'a b'), shownHash('Bash', 'd', '{"command":"a b"}'));
  assert.notEqual(shownHash('Bash', 'd', '{"command":"a b"}', 'a b'), shownHash('Bash', 'd', '{"command":"a b"}', 'a\nb'), 'one line or two is another card');
});

test('the shown hash covers the parity note too, as an object after the exact text (Ultron\'s L3, 11-13)', () => {
  const pv = '{"command":"a b"}';
  assert.notEqual(shownHash('Bash', 'd', pv, null, 'N.'), shownHash('Bash', 'd', pv), 'a card with the note is not the card before it');
  assert.equal(shownHash('Bash', 'd', pv, null, null), shownHash('Bash', 'd', pv), 'no note: the hash as before');
  assert.notEqual(shownHash('Bash', 'd', pv, null, 'N.'), shownHash('Bash', 'd', pv, 'N.'), 'a note never reads as an exact text');
  // Pinned, and pinned the same in web/test/orbit-chat.test.js: the page hashes alike.
  assert.equal(shownHash('Bash', 'd', pv, null, 'N.'), createHash('sha256').update(JSON.stringify(['Bash', 'd', pv, { note: 'N.' }])).digest('hex'));
  assert.equal(shownHash('Bash', 'd', pv, null, 'N.'), 'd211438aea7f2c7251cc228704cda9e51112e1971a713717554b8ab70b0225be');
  assert.equal(shownHash('Bash', 'd', pv, 'a  b', 'N.'), 'ebaf5c7d63a829124085e339ccc1588e38989c9106624bdf06508915820e6b17');
});

// ---- the ingest ----

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, hdrs) => { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const call = async (handler, method, url, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method, url,
    headers: { host: '127.0.0.1:8322', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    on(evt, fn) { if (evt === 'data' && body !== undefined) fn(Buffer.from(raw)); if (evt === 'end') fn(); return req; },
    socket: { remoteAddress: '127.0.0.1' },
    unpipe() {}, pause() {}
  };
  const res = mockRes();
  await handler(req, res);
  return res;
};
const deps = () => {
  const logged = [];
  const todos = { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) };
  return { cache: createCache(), todos, config: { present: true }, log: line => logged.push(line), logged };
};
const SECRET_LOOKING = 'cat /home/owner/Projects/app/zz-marker-9471.txt';
const hookBody = (extra = {}) => ({ hook_event_name: 'PermissionRequest', session_id: LEAD, tool_name: 'Bash', command: SECRET_LOOKING, ...extra });

test('POST /api/ingest/exact-command: on the ingest socket only, the report goes to the gate, and the command is never in the log or the answer', async () => {
  const d = deps();
  const got = [];
  const h = createIngestHandler({ ...d, onExact: v => { got.push(v); return v.sessionId === LEAD ? 'kept' : 'other'; } });
  const res = await call(h, 'POST', '/api/ingest/exact-command', hookBody());
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true, kept: true });
  assert.deepEqual(got, [{ sessionId: LEAD, command: SECRET_LOOKING }]);
  const other = await call(h, 'POST', '/api/ingest/exact-command', hookBody({ session_id: 'another' }));
  assert.deepEqual(JSON.parse(other.body), { ok: true, kept: false });
  assert.deepEqual(d.logged, ['exact-command: a Bash report, from the lead\'s session, kept for 2 minutes', 'exact-command: a Bash report, not from the lead\'s session, dropped']);
  assert.ok(!JSON.stringify(d.logged).includes('zz-marker') && !res.body.includes('zz-marker') && !JSON.stringify(d.logged).includes(LEAD), 'neither the command nor the session id is logged');
  // No gate (the chat is off), or one that throws: dropped, answered, the session goes on.
  const none = createIngestHandler(d);
  assert.deepEqual(JSON.parse((await call(none, 'POST', '/api/ingest/exact-command', hookBody())).body), { ok: true, kept: false });
  assert.match(d.logged.at(-1), /dropped \(approvals for Bash are not in "exact" mode\)/);
  const broken = createIngestHandler({ ...d, onExact: () => { throw new Error('boom'); } });
  assert.equal((await call(broken, 'POST', '/api/ingest/exact-command', hookBody())).statusCode, 200);
  // Refusals: the TCP port (even from this machine, in either ingest.tcp mode), not
  // JSON from a page, not a Bash PermissionRequest, too big.
  for (const ingest of [undefined, { tcp: 'legacy' }, { tcp: 'off' }]) {
    const tcp = createHandler({ ...d, config: { ...d.config, ingest }, onExact: v => { got.push(v); return 'kept'; } });
    const refused = await call(tcp, 'POST', '/api/ingest/exact-command', hookBody());
    assert.equal(refused.statusCode, 403, `the TCP port, ingest ${JSON.stringify(ingest)}`);
    assert.match(JSON.parse(refused.body).error, /Unix socket only/);
  }
  assert.equal((await call(h, 'POST', '/api/ingest/exact-command', hookBody(), { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await call(h, 'POST', '/api/ingest/exact-command', hookBody({ tool_name: 'Monitor' }))).statusCode, 400);
  assert.equal((await call(h, 'POST', '/api/ingest/exact-command', hookBody({ command: 'x'.repeat(EXACT_MAX_CHARS + 1) }))).statusCode, 400);
  assert.equal((await call(h, 'POST', '/api/ingest/exact-command', hookBody({ command: 'x'.repeat(40000) }))).statusCode, 413);
  assert.equal(got.length, 2, 'no refused post reached the gate');
  assert.equal((await call(h, 'GET', '/api/ingest/exact-command')).statusCode, 404);
  // It opens no "waiting on you" card: this is not the needs-you ingest.
  assert.deepEqual(JSON.parse((await call(createHandler(d), 'GET', '/api/dashboard')).body).needsYou, []);
});

// ---- the README's hook entry ----

const readmeHook = async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const at = readme.indexOf('**The exact-command hook.**');
  assert.ok(at > 0, 'the README has the exact-command hook');
  return JSON.parse(readme.slice(at).match(/```json\n([\s\S]*?)\n```/)[1]);
};

test('the README\'s exact-command hook entry can never decide: Bash only, not async, a 3 s limit, no output, always exit 0', async () => {
  const entry = await readmeHook();
  assert.deepEqual(Object.keys(entry.hooks), ['PermissionRequest']);
  assert.equal(entry.hooks.PermissionRequest.length, 1);
  const group = entry.hooks.PermissionRequest[0];
  assert.equal(group.matcher, 'Bash');
  assert.equal(group.hooks.length, 1);
  const h = group.hooks[0];
  assert.deepEqual(Object.keys(h).sort(), ['command', 'timeout', 'type'], 'no async, no if, nothing else');
  assert.equal(h.type, 'command');
  assert.ok(h.timeout >= 2 && h.timeout <= 3, 'seconds');
  assert.match(h.command, /^\/usr\/bin\/jq -c '\{hook_event_name,session_id,tool_name,command:\.tool_input\.command\}' 2>\/dev\/null \| \/usr\/bin\/curl -q -s -m 2 --noproxy '\*' --unix-socket "\$HOME\/\.local\/state\/jarvis-os\/ingest\.sock" -X POST http:\/\/localhost\/api\/ingest\/exact-command -H 'Content-Type: application\/json' --data-binary @- >\/dev\/null 2>&1 \|\| true$/);
  assert.ok(!/updatedInput|hookSpecificOutput|decision|echo|printf/.test(h.command), 'it prints nothing Claude Code could read as a decision');
});

test('the README\'s hook command, run for real against a scratch server: the body is the command character for character, nothing is printed, and it exits 0 with the server down', async t => {
  if (!existsSync('/usr/bin/jq') || !existsSync('/usr/bin/curl')) return t.skip('needs /usr/bin/jq and /usr/bin/curl');
  const entry = await readmeHook();
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { bodies.push({ url: req.url, type: req.headers['content-type'], text: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"kept":true}'); });
  });
  // The command as written, unchanged: it finds the socket under $HOME, so a scratch
  // HOME holds a scratch socket and the real one is never touched.
  const home = await scratchHome();
  const socketPath = join(home, '.local', 'state', 'jarvis-os', 'ingest.sock');
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await new Promise(r => server.listen(socketPath, r));
  const command = entry.hooks.PermissionRequest[0].hooks[0].command;
  const run = (cmd, input) => new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: home } });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
  const hookInput = cmd => JSON.stringify({
    session_id: LEAD, transcript_path: '/home/owner/.claude/projects/x/y.jsonl', cwd: '/home/owner/Projects/app', permission_mode: 'auto', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: cmd, description: 'a friendly summary', timeout: 5000 }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }]
  });
  try {
    const texts = ['ls -la', 'cat notes.txt\necho second-line', 'a\tb', 'a\r\nb', '  lead and trail  ', 'two  spaces', 'quote "x" \'y\' $HOME `id` \\ end', 'line\n'];
    for (const cmd of texts) {
      const r = await run(command, hookInput(cmd));
      assert.deepEqual(r, { code: 0, out: '', err: '' }, JSON.stringify(cmd));
      const sent = bodies.at(-1);
      assert.equal(sent.url, '/api/ingest/exact-command');
      assert.equal(sent.type, 'application/json');
      const body = JSON.parse(sent.text);
      assert.deepEqual(Object.keys(body).sort(), ['command', 'hook_event_name', 'session_id', 'tool_name'], 'the description, the paths and the suggestions stay in the session');
      const checked = checkExactReport(body);
      assert.equal(checked.ok, true);
      assert.equal(checked.value.command, cmd, 'character for character');
    }
    assert.equal(bodies.length, texts.length);
    // Not Bash's shape (no tool_input): the post is refused by the check, and the hook still says nothing.
    const odd = await run(command, JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: LEAD, tool_name: 'Write' }));
    assert.deepEqual(odd, { code: 0, out: '', err: '' });
    assert.equal(checkExactReport(JSON.parse(bodies.at(-1).text)).ok, false);
    // Input that is not JSON at all: jq fails, curl posts nothing useful, exit 0, silence.
    assert.deepEqual(await run(command, 'not json'), { code: 0, out: '', err: '' });
  } finally {
    await new Promise(r => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
  // The server is gone: still exit 0, still silent, and well inside the hook's limit.
  const started = Date.now();
  const down = await run(command, hookInput('ls'));
  assert.deepEqual(down, { code: 0, out: '', err: '' });
  assert.ok(Date.now() - started < 2500, 'curl gives up at once on a refused connection');
});
