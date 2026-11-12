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
import {
  foldWhitespace, exactTextOk, checkExactReport, createExactCommands,
  EXACT_TTL_MS, EXACT_WINDOW_BEFORE_MS, EXACT_WINDOW_AFTER_MS, EXACT_MAX_CHARS, EXACT_KEEP
} from '../lib/exact-commands.mjs';
import { createApprovals, denyOnlyReasons, readApprovalsConfig, shownHash, NO_EXACT } from '../lib/approvals.mjs';
import { createHandler, createIngestHandler } from '../routes.mjs';
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

test('the fold: each run of whitespace becomes one space, and nothing is trimmed', () => {
  assert.equal(foldWhitespace('cat a\nrm b'), 'cat a rm b');
  assert.equal(foldWhitespace('a \t\n  b'), 'a b');
  assert.equal(foldWhitespace('a\r\nb'), 'a b', 'CRLF is one run');
  assert.equal(foldWhitespace('  ls  '), ' ls ', 'leading and trailing runs fold, they are not dropped');
  assert.equal(foldWhitespace('ls\n'), 'ls ');
  assert.equal(foldWhitespace('one two'), 'one two');
  assert.equal(foldWhitespace(`a${cp(0xa0)}b`), 'a b', 'other whitespace too');
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
  s.note('cat a\nrm b');
  assert.deepEqual(s.candidates('cat a rm b', T0), { texts: ['cat a\nrm b'], unusable: false, conflict: false });
  assert.deepEqual(s.candidates('cat a\nrm b', T0).texts, ['cat a\nrm b'], 'a relay that did not fold matches outright');
  assert.deepEqual(s.candidates('cat a rm', T0).texts, [], 'character for character');
  assert.deepEqual(s.candidates('cat a rm b ', T0).texts, []);
  assert.deepEqual(s.candidates('cat a  rm b', T0).texts, []);
  // The window: the report came up to 30 s before the relay, or up to 5 s after.
  assert.equal(s.candidates('cat a rm b', T0 + EXACT_WINDOW_BEFORE_MS).texts.length, 1);
  assert.equal(s.candidates('cat a rm b', T0 + EXACT_WINDOW_BEFORE_MS + 1).texts.length, 0);
  assert.equal(s.candidates('cat a rm b', T0 - EXACT_WINDOW_AFTER_MS).texts.length, 1);
  assert.equal(s.candidates('cat a rm b', T0 - EXACT_WINDOW_AFTER_MS - 1).texts.length, 0);
  assert.equal(s.candidates('cat a rm b', NaN).texts.length, 0);
  assert.equal(s.candidates(null, T0).texts.length, 0);
  // The same text twice is one candidate; a different text with the same fold is a conflict.
  s.note('cat a\nrm b');
  assert.deepEqual(s.candidates('cat a rm b', T0), { texts: ['cat a\nrm b'], unusable: false, conflict: false });
  s.note('cat a rm b');
  assert.deepEqual(s.candidates('cat a rm b', T0), { texts: ['cat a\nrm b', 'cat a rm b'], unusable: false, conflict: true });
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
  s.note('ls /a\r\nrm /b');
  assert.deepEqual(s.candidates('ls /a rm /b', T0), { texts: [], unusable: true, conflict: false });
  s.note('ls /a rm /b');
  assert.deepEqual(s.candidates('ls /a rm /b', T0), { texts: ['ls /a rm /b'], unusable: true, conflict: true }, 'a forged plain copy only ties with the real one');
  const many = createExactCommands({ now: () => clock.t });
  many.note('first');
  for (let i = 0; i < EXACT_KEEP; i++) many.note(`cmd ${i}`);
  assert.equal(many.size(), EXACT_KEEP);
  assert.deepEqual(many.candidates('first', T0).texts, [], 'the oldest went first');
  assert.deepEqual(many.candidates(`cmd ${EXACT_KEEP - 1}`, T0).texts, [`cmd ${EXACT_KEEP - 1}`]);
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

test('exact mode: the folded two-liner is caught, because the exact text keeps its line break', () => {
  const env = gate();
  const real = `cat ${APP}/notes.txt\nrm -rf /home/owner/Projects`;
  env.report(real);
  const p = env.open(foldWhitespace(real));
  assert.equal(p.exact, real, 'the card gets the text with its line break');
  assert.ok(has(p.denyOnly, /more than one line/), p.denyOnly.join('; '));
  assert.equal(env.a.view(p).canAllow, false);
  // A tab, and a trailing line break, are not one plain line either.
  env.report('ls\t/home/owner/Projects/app');
  assert.ok(has(env.open('ls /home/owner/Projects/app').denyOnly, /more than one line, or a tab/));
  const env2 = gate();
  env2.report('pwd\n');
  assert.ok(has(env2.open('pwd ').denyOnly, /more than one line/));
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
  const real = `cat ${APP}/a\nrm ${APP}/b`;
  const forged = `cat ${APP}/a rm ${APP}/b`;
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
  late.clock.t += 29e3;
  const lp = late.open(forged);
  assert.equal(lp.exact, forged);
  late.clock.t += 4e3;
  late.report(real);
  late.clock.t = T0 + EXACT_TTL_MS + 1;
  assert.ok(has(late.a.reasonsNow(lp), /two different exact copies/), 'the one text left is not the one the card showed');
  assert.deepEqual(late.events, [{ kind: 'approvals-exact-conflict' }]);
  // A later report that can't be shown (a carriage return) counts against the card as well.
  const crLater = gate({ bashCommands: [forged] });
  crLater.report(forged);
  const cl = crLater.open(forged);
  crLater.report(`cat ${APP}/a\r\nrm ${APP}/b`);
  crLater.clock.t = T0 + EXACT_TTL_MS - 1;
  assert.equal(crLater.a.view(cl).canAllow, false);
  assert.deepEqual(crLater.events, [{ kind: 'approvals-exact-conflict' }]);
  // The same text reported twice is no conflict.
  const twice = gate();
  twice.report(`cat ${APP}/a`);
  twice.report(`cat ${APP}/a`);
  const q = twice.open(`cat ${APP}/a`);
  assert.deepEqual(q.denyOnly, []);
  assert.equal(twice.a.view(q).canAllow, true);
  assert.deepEqual(twice.events, []);
  // A real command that can't be shown (a carriage return) plus a forged plain copy: a tie.
  const cr = gate();
  cr.report(`cat ${APP}/a\r\nrm ${APP}/b`);
  assert.ok(has(cr.open(forged).denyOnly, /outside plain ASCII, line breaks and tabs/));
  cr.report(forged);
  assert.ok(has(cr.open(forged).denyOnly, /two different exact copies/));
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
