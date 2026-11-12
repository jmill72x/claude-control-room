// Parity with the relay (config's chat.approvalsRules "parity", the owner's decision of
// 2026-11-12) and the close of a card answered somewhere else (lib/answered-elsewhere.mjs):
// the pure rules, the gate, the store, the needs-you ingest's hook, and the wiring in
// server.mjs read as source. Every name, path and id is invented; nothing touches :8322
// or data/. Hidden characters are built from code points, never typed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdtemp, mkdir, chmod, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readApprovalsConfig, denyOnlyReasons, createApprovals, parityStartLine, RULES_MODES, HIDDEN_MODES, BLOCK_WINDOW_MS, FLOOD_OPEN, INGEST_OFF } from '../lib/approvals.mjs';
import { createChatStore, PERMISSION_TTL_MS, CARD_REPLAY_MS } from '../lib/chat-store.mjs';
import { createAnsweredElsewhere, MOVED_EVENTS } from '../lib/answered-elsewhere.mjs';
import { chatEventLine } from '../lib/chat-events.mjs';
import { createIngestHandler } from '../routes.mjs';
import { createCache } from '../cache.mjs';
import { createNeedsYouStore } from '../lib/needs-you.mjs';

const HOME = '/home/owner';
const noReal = () => null;
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const HIDDEN = 'it carries invisible or direction characters';
const req = (tool, preview, extra = {}) => ({ tool, description: 'd', inputPreview: typeof preview === 'string' ? preview : JSON.stringify(preview), ...extra });
const guarded = (r, opts = {}) => denyOnlyReasons(r, { home: HOME, realpath: noReal, ...opts });
const parity = (r, opts = {}) => denyOnlyReasons(r, { home: HOME, realpath: noReal, rules: 'parity', ...opts });

// ---- config ----

test('config: chat.approvalsRules is "guarded" unless it says "parity"; chat.approvalsHidden is "deny" unless it says "allow"; anything else keeps the cautious value with a problem', () => {
  assert.deepEqual(RULES_MODES, ['guarded', 'parity']);
  assert.deepEqual(HIDDEN_MODES, ['deny', 'allow']);
  const plain = readApprovalsConfig({ chat: { approvals: 'on' } });
  assert.equal(plain.rules, 'guarded', 'the default is unchanged: the page\'s own rules');
  assert.equal(plain.hidden, 'deny');
  assert.deepEqual(plain.problems, []);
  const on = readApprovalsConfig({ chat: { approvals: 'on', approvalsRules: 'parity' } });
  assert.equal(on.rules, 'parity');
  assert.equal(on.hidden, 'deny', 'parity alone keeps hidden characters Deny-only');
  assert.equal(on.bash, 'deny', 'the Bash mode is read as before, for a rollback');
  assert.deepEqual(on.problems, []);
  assert.equal(readApprovalsConfig({ chat: { approvalsRules: 'guarded' } }).rules, 'guarded');
  assert.equal(readApprovalsConfig({ chat: { approvalsRules: 'parity', approvalsHidden: 'allow' } }).hidden, 'allow');
  for (const bad of ['PARITY', 'on', true, 1, ['parity'], 'strict']) {
    const r = readApprovalsConfig({ chat: { approvals: 'on', approvalsRules: bad } });
    assert.equal(r.rules, 'guarded', JSON.stringify(bad));
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /approvalsRules must be "guarded" or "parity"/);
  }
  for (const bad of ['ALLOW', true, 'yes', 0]) {
    const r = readApprovalsConfig({ chat: { approvalsRules: 'parity', approvalsHidden: bad } });
    assert.equal(r.hidden, 'deny', JSON.stringify(bad));
    assert.match(r.problems[0], /approvalsHidden must be "deny" or "allow"/);
  }
  // Parity does not turn approvals on by itself.
  assert.equal(readApprovalsConfig({ chat: { approvalsRules: 'parity' } }).mode, 'off');
});

// ---- the rules ----

test('parity: what the page\'s own rules make Deny-only can be allowed, Bash of any shape and a write anywhere included', () => {
  const cases = [
    req('Bash', { command: 'ls -la /tmp/x' }),
    req('Bash', { command: 'cd /tmp && make build | tee out.log; echo done' }),
    req('Bash', { command: 'sudo launchctl list' }),
    req('Bash', { command: 'cat ~/Projects/café/notes.md' }),
    req('Write', { file_path: '/home/owner/elsewhere/notes.md', content: 'x' }),
    req('Write', { file_path: '/home/owner/Projects/app/CLAUDE.md', content: 'x' }),
    req('Edit', { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }),
    req('Read', { file_path: '/home/owner/.ssh/config' }),
    req('Glob', { pattern: '/home/owner/**/*' }),
    req('WebFetch', { url: 'http://example.test/?q=1' }),
    req('SomethingNew', { anything: 1 }),
    req('Bash', 'not json at all'),
    req('Bash', { command: 'ls' }, { cut: true }),
    req('Bash', { command: 'echo a ⋯ 12 code points elided ⋯ b' }),
    req('Bash', { command: 'curl -H "Authorization: [REDACTED]" https://example.test' })
  ];
  for (const c of cases) {
    assert.notDeepEqual(guarded(c), [], `guarded keeps this Deny-only: ${c.inputPreview.slice(0, 60)}`);
    assert.deepEqual(parity(c), [], `parity lets it be allowed: ${c.inputPreview.slice(0, 60)}`);
  }
});

test('parity: only the plain word turns it on; config\'s own Deny-only words still apply', () => {
  const bash = req('Bash', { command: 'ls -la /tmp/x' });
  for (const rules of ['PARITY', 'Parity', true, 1, null, undefined, 'guarded', 'on']) {
    assert.notDeepEqual(denyOnlyReasons(bash, { home: HOME, realpath: noReal, rules }), [], JSON.stringify(rules));
  }
  assert.deepEqual(parity(req('Bash', { command: 'npm run DEPLOY' }), { patterns: ['deploy'] }), ['it matches a Deny-only pattern in config']);
  assert.deepEqual(parity(req('Bash', { command: 'ls' }, { description: 'Deploy the site' }), { patterns: ['deploy'] }), ['it matches a Deny-only pattern in config']);
  assert.deepEqual(parity(req('Bash', { command: 'npm run build' }), { patterns: ['deploy'] }), []);
});

test('parity: a hidden character keeps the card Deny-only, as text, as the mark the store made of it, or as an escape inside the preview; "allow" lifts that', () => {
  const marked = req('Bash', { command: 'echo ⟦U+202E⟧ done' });
  const inDescription = req('Bash', { command: 'ls' }, { description: 'list ⟦U+200B⟧ files' });
  const raw = req('Bash', { command: `echo ${RLO}txt.exe` });
  const zero = req('Write', { file_path: '/home/owner/notes.md', content: `a${ZWSP}b` });
  // JSON text whose escape only parsing brings out.
  const escaped = req('Bash', `{"command":"echo \\u${(0x202e).toString(16)} x"}`);
  assert.ok(!escaped.inputPreview.includes(RLO), 'the fixture holds the escape, not the character');
  for (const r of [marked, inDescription, raw, zero, escaped]) {
    assert.deepEqual(parity(r), [HIDDEN], r.inputPreview.slice(0, 40));
    assert.deepEqual(parity(r, { hidden: 'deny' }), [HIDDEN]);
    assert.deepEqual(parity(r, { hidden: 'allow' }), [], 'the owner chose marks only');
    // Anything but the plain word "allow" is deny.
    for (const v of ['ALLOW', true, null, 'yes']) assert.deepEqual(parity(r, { hidden: v }), [HIDDEN], JSON.stringify(v));
  }
  assert.deepEqual(parity(req('Bash', { command: 'echo plain' })), []);
});

// ---- the gate ----

const READ = { tool: 'Read', description: 'd', inputPreview: '{"file_path":"/home/owner/Projects/app/a"}', state: 'open', denyOnly: [] };
const BASH = { tool: 'Bash', description: 'd', inputPreview: '{"command":"cd /tmp && make | tee log"}', state: 'open' };

test('the gate in parity: a Bash request is assessed with no reason and may be allowed; guarded keeps it Deny-only', () => {
  const g = createApprovals({ mode: 'on', rules: 'parity', home: HOME, realpath: noReal });
  g.noteChannelRelay('allow');
  assert.equal(g.rules, 'parity');
  assert.equal(g.hidden, 'deny');
  const a = g.assess(BASH);
  assert.deepEqual(a.denyOnly, []);
  assert.deepEqual(g.view({ ...BASH, denyOnly: a.denyOnly }), { mode: 'on', denyOnly: [], canAllow: true });
  assert.deepEqual(g.status(), { mode: 'on', relay: 'allow', rules: 'parity', denyOnlyUntil: null });
  const strict = createApprovals({ mode: 'on', home: HOME, realpath: noReal });
  strict.noteChannelRelay('allow');
  assert.equal(strict.rules, 'guarded');
  assert.notDeepEqual(strict.assess(BASH).denyOnly, []);
  assert.deepEqual(strict.status(), { mode: 'on', relay: 'allow', denyOnlyUntil: null }, 'the default status keeps its shape');
  // Only the plain word.
  for (const rules of ['PARITY', true, 1]) assert.equal(createApprovals({ mode: 'on', rules }).rules, 'guarded', JSON.stringify(rules));
  // Hidden characters: Deny-only unless config said allow.
  const hiddenBash = { ...BASH, inputPreview: JSON.stringify({ command: `echo ${RLO}x` }) };
  assert.deepEqual(g.assess(hiddenBash).denyOnly, [HIDDEN]);
  const lax = createApprovals({ mode: 'on', rules: 'parity', hidden: 'allow', home: HOME, realpath: noReal });
  assert.equal(lax.hidden, 'allow');
  assert.deepEqual(lax.assess(hiddenBash).denyOnly, []);
  assert.equal(createApprovals({ mode: 'on', rules: 'parity', hidden: 'ALLOW' }).hidden, 'deny');
});

test('the gate in parity: a classifier block opens no Deny-only window and answers "parity" for the log; the next card still says why it is asking', () => {
  const clock = { t: 1794380000000 };
  const g = createApprovals({ mode: 'on', rules: 'parity', now: () => clock.t, isLead: id => id !== 'other-agent', home: HOME, realpath: noReal });
  g.noteChannelRelay('allow');
  assert.equal(g.noteBlock({ sessionId: 'other-agent', tool: 'Bash', reason: '[Data Exfiltration]' }), false, 'another agent\'s block is still not the lead\'s');
  assert.equal(g.noteBlock({ sessionId: 'lead', tool: 'Bash', reason: '[Data Exfiltration]' }), 'parity');
  assert.deepEqual(g.view(READ), { mode: 'on', denyOnly: [], canAllow: true });
  assert.deepEqual(g.reasonsNow(READ), []);
  assert.equal(g.status().denyOnlyUntil, null);
  assert.equal(g.assess(BASH).why, 'Auto mode refused this Bash call (Data Exfiltration), so Claude Code is asking you');
  // The same block under the page's own rules, for contrast.
  const strict = createApprovals({ mode: 'on', now: () => clock.t, home: HOME, realpath: noReal });
  strict.noteChannelRelay('allow');
  assert.equal(strict.noteBlock({ sessionId: 'lead', tool: 'Bash', reason: 'x' }), true);
  assert.equal(strict.status().denyOnlyUntil, clock.t + BLOCK_WINDOW_MS);
  assert.equal(strict.view(READ).canAllow, false);
});

test('the gate in parity: a burst of open requests is still alerted, once per window, and makes no card Deny-only; the ingest being off adds nothing', () => {
  const events = [];
  const clock = { t: 1794380000000 };
  const g = createApprovals({ mode: 'on', rules: 'parity', now: () => clock.t, onEvent: e => events.push(e), ingestOk: () => false, home: HOME, realpath: noReal });
  g.noteChannelRelay('allow');
  g.noteOpenCount(FLOOD_OPEN + 1);
  g.noteOpenCount(FLOOD_OPEN + 2);
  assert.deepEqual(events, [{ kind: 'approvals-flood', open: FLOOD_OPEN + 1, parity: true }]);
  assert.deepEqual(g.view(READ), { mode: 'on', denyOnly: [], canAllow: true });
  assert.equal(g.status().denyOnlyUntil, null);
  assert.ok(!g.reasonsNow(READ).includes(INGEST_OFF));
  assert.match(chatEventLine(events[0]), /6 permission requests were open at once: the cards keep Allow \(parity with the relay\)/);
  assert.match(chatEventLine({ kind: 'approvals-flood', open: 6, parity: false }), /page approvals are Deny only for 10 minutes/);
  assert.match(chatEventLine({ kind: 'approvals-flood', open: 6 }), /page approvals are Deny only for 10 minutes/);
  assert.match(chatEventLine({ kind: 'approvals-flood', open: 6, parity: 'yes' }), /page approvals are Deny only for 10 minutes/, 'only a plain true');
});

test('the gate in parity: the mode, the kill file, the channel\'s relay mode and its test switch all still hold', () => {
  const files = new Set();
  const events = [];
  const g = createApprovals({ mode: 'on', rules: 'parity', killPath: '/k/approvals-off', exists: p => files.has(p), onEvent: e => events.push(e), home: HOME, realpath: noReal });
  assert.deepEqual(g.view(READ), { mode: 'deny', denyOnly: ['the channel has not said it can deliver Allow'], canAllow: false }, 'before any hello');
  g.noteChannelRelay('deny');
  assert.deepEqual(g.view(READ), { mode: 'deny', denyOnly: ['the channel delivers Deny only'], canAllow: false });
  g.noteChannelRelay('allow');
  assert.equal(g.view(READ).canAllow, true);
  g.noteChannelTest(true);
  assert.deepEqual(g.view(READ), { mode: 'deny', denyOnly: ['the channel runs in test mode'], canAllow: false });
  g.noteChannelTest(false);
  assert.equal(g.view(READ).canAllow, true);
  files.add('/k/approvals-off');
  assert.equal(g.mode(), 'off');
  assert.equal(g.view(READ).canAllow, false);
  assert.ok(events.some(e => e.kind === 'approvals-kill' && e.on === true));
  files.delete('/k/approvals-off');
  assert.equal(g.mode(), 'on');
  assert.equal(createApprovals({ mode: 'deny', rules: 'parity' }).view(READ).canAllow, false, 'config "deny" is Deny only in parity too');
  const off = createApprovals({ mode: 'off', rules: 'parity' });
  off.noteChannelRelay('allow');
  assert.equal(off.mode(), 'off');
  assert.equal(off.view(READ).canAllow, false);
});

test('the words at a start: the alert names parity and what it does with hidden characters; the start line says which rules are not applied', () => {
  assert.equal(chatEventLine({ kind: 'approvals-mode', mode: 'on', previous: 'on' }), 'chat approvals are on (Deny and Allow once) at this start');
  assert.equal(chatEventLine({ kind: 'approvals-mode', mode: 'on', previous: 'on', rules: 'guarded', hidden: 'deny' }), 'chat approvals are on (Deny and Allow once) at this start');
  assert.equal(chatEventLine({ kind: 'approvals-mode', mode: 'on', previous: 'on', rules: 'parity', hidden: 'deny' }),
    'chat approvals are on (Deny and Allow once) at this start; parity with the relay: the page may allow whatever the channel relays, but a request with hidden characters stays Deny only');
  assert.match(chatEventLine({ kind: 'approvals-mode', mode: 'on', rules: 'parity', hidden: 'allow' }), /hidden characters marked but allowed$/);
  assert.equal(chatEventLine({ kind: 'approvals-mode', mode: 'off', rules: 'parity' }), 'chat approvals are off at this start', 'off is off');
  assert.match(parityStartLine({ hidden: 'deny' }), /^chat: approvals follow the channel's relay \(parity\): .*Bash and writes anywhere included; the Bash mode, the write folders and the Deny-only windows are not applied; a request with hidden characters stays Deny-only$/);
  assert.match(parityStartLine({ hidden: 'allow' }), /hidden characters are marked and may be allowed$/);
  assert.match(parityStartLine(), /stays Deny-only$/);
});

// ---- the store: closed elsewhere, and what a new stream is sent ----

const storeAt = async t0 => {
  const dir = await mkdtemp(join(tmpdir(), 'par-'));
  const clock = { t: t0 };
  const store = createChatStore({ dir, now: () => clock.t });
  await store.load();
  const closed = [];
  store.subscribe(e => { if (e.type === 'permission-closed') closed.push([e.request.requestId, e.request.state]); });
  const open = (requestId, relayedAt = clock.t) => store.openPermission({ requestId, tool: 'Bash', description: 'd', inputPreview: '{"command":"ls"}', relayedAt });
  return { dir, clock, store, closed, open, clean: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
};
const T0 = 1794380000000;

test('store: requests relayed before the moment close as `elsewhere`, with one event each and no verdict; one relayed at or after it stays open', async () => {
  const s = await storeAt(T0);
  try {
    await s.open('abcde');
    s.clock.t += 1000;
    await s.open('fghij');
    const before = s.store.seq;
    // The post reaches the server half a second after its hook ran.
    s.clock.t += 500;
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: T0 + 1000, event: 'Stop' }), ['abcde'], 'strictly before: the one relayed at that moment stays');
    assert.deepEqual(s.closed, [['abcde', 'elsewhere']]);
    assert.equal(s.store.seq, before, 'no verdict, no message: nothing goes to the channel');
    const p = s.store.permission('abcde');
    assert.equal(p.state, 'elsewhere');
    assert.equal(p.closedAt, T0 + 1500, 'closed when the server heard, not when the hook ran');
    assert.equal(p.closedBy, 'Stop');
    assert.equal(s.store.publicPermission(p).state, 'elsewhere');
    assert.equal(s.store.publicPermission(p).closedAt, T0 + 1500);
    assert.ok(!('closedAt' in s.store.publicPermission(s.store.permission('fghij'))), 'an open request\'s shape is unchanged');
    assert.deepEqual(s.store.openPermissions().map(x => x.requestId), ['fghij']);
    // A tap on the closed one answers 409 and changes nothing.
    const late = await s.store.answerPermission('abcde', 'allow', 'phone');
    assert.equal(late.status, 409);
    assert.match(late.error, /already answered somewhere else, or no longer asked/);
    assert.equal(s.store.seq, before);
    // Again: nothing left to close before that moment; an `upTo` that is no time closes nothing.
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: T0 + 1000 }), []);
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: Number.NaN }), []);
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: 'soon' }), []);
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: null }), []);
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: '9'.repeat(15) }), [], 'a number as text is no time either');
    assert.equal(s.store.permission('fghij').state, 'open');
    // With no `upTo`: everything relayed before now.
    s.clock.t += 5;
    assert.deepEqual(s.store.closePermissionsElsewhere(), ['fghij']);
    assert.equal(s.store.permission('fghij').closedBy, null);
  } finally { await s.clean(); }
});

test('store: a request that timed out here is closed elsewhere too; one answered here, or ended by a new channel session, is left as it was', async () => {
  const s = await storeAt(T0);
  try {
    await s.open('abcde');
    await s.open('fghij');
    await s.store.answerPermission('fghij', 'deny', 'phone');
    s.clock.t += PERMISSION_TTL_MS;
    assert.equal(s.store.permission('abcde').state, 'expired');
    await s.open('kmnop');
    s.store.newPermissionSession();
    assert.equal(s.store.permission('kmnop').state, 'expired');
    s.clock.t += 1000;
    assert.deepEqual(s.store.closePermissionsElsewhere({ upTo: s.clock.t, event: 'UserPromptSubmit' }), ['abcde']);
    assert.equal(s.store.permission('abcde').state, 'elsewhere');
    assert.equal(s.store.permission('fghij').state, 'denied');
    assert.equal(s.store.permission('kmnop').state, 'expired', 'its channel process is gone: not this rule\'s to close');
  } finally { await s.clean(); }
});

test('store: a new stream is sent the open requests and those that timed out here in the last hour, never one closed any other way', async () => {
  const s = await storeAt(T0);
  try {
    assert.equal(CARD_REPLAY_MS, 60 * 60e3);
    await s.open('abcde');
    assert.deepEqual(s.store.cardPermissions().map(p => p.requestId), ['abcde']);
    s.clock.t += PERMISSION_TTL_MS;
    assert.deepEqual(s.store.cardPermissions().map(p => [p.requestId, p.state]), [['abcde', 'expired']], 'timed out here: still sent, as a card that cannot be answered');
    assert.deepEqual(s.store.openPermissions(), []);
    await s.open('fghij');
    await s.open('kmnop');
    await s.open('qrstu');
    await s.store.answerPermission('fghij', 'deny', 'phone');
    s.store.closePermissionsElsewhere({ upTo: s.clock.t + 1 });
    assert.deepEqual(s.store.cardPermissions(), [], 'answered here or closed elsewhere: gone from the replay');
    await s.open('vwxyz');
    s.store.newPermissionSession();
    assert.deepEqual(s.store.cardPermissions(), [], 'ended by a new channel session: not replayed');
    await s.open('bcdef');
    s.clock.t += CARD_REPLAY_MS - 1;
    assert.deepEqual(s.store.cardPermissions().map(p => p.requestId), ['bcdef']);
    s.clock.t += 1;
    assert.deepEqual(s.store.cardPermissions(), [], 'an hour after it was relayed it is no longer sent');
  } finally { await s.clean(); }
});

// ---- the lead's session moved on ----

test('answered elsewhere: the lead\'s UserPromptSubmit, Stop or SessionEnd closes the cards relayed before the hook ran; PostToolUse, a Notification and other sessions close nothing', async () => {
  const s = await storeAt(T0);
  try {
    assert.deepEqual(MOVED_EVENTS, ['UserPromptSubmit', 'Stop', 'SessionEnd']);
    const logs = [];
    const note = createAnsweredElsewhere({ store: s.store, isLeadSession: id => id === 'lead', now: () => s.clock.t, log: l => logs.push(l) });
    await s.open('abcde');
    s.clock.t += 3000;
    for (const event of ['PostToolUse', 'Notification', 'PermissionRequest', 'PermissionDenied', 'SubagentStop']) {
      assert.equal(note({ event, sessionId: 'lead', at: s.clock.t }), 0, event);
    }
    for (const event of MOVED_EVENTS) assert.equal(note({ event, sessionId: 'other', at: s.clock.t }), 0, `another session's ${event}`);
    assert.equal(note(null), 0);
    assert.equal(note({}), 0);
    assert.equal(s.store.permission('abcde').state, 'open');
    assert.deepEqual(logs, []);
    // A hook that ran before the request was relayed says nothing about it, however late its post arrives.
    assert.equal(note({ event: 'Stop', sessionId: 'lead', at: T0 - 1 }), 0);
    assert.equal(note({ event: 'Stop', sessionId: 'lead', at: T0 }), 0, 'at the same millisecond: not before');
    assert.equal(s.store.permission('abcde').state, 'open');
    assert.equal(note({ event: 'Stop', sessionId: 'lead', at: T0 + 1 }), 1);
    assert.equal(s.store.permission('abcde').state, 'elsewhere');
    assert.deepEqual(logs, ['chat: 1 permission card closed, answered somewhere else or no longer asked (the lead\'s session moved on: Stop): abcde']);
    for (const event of ['UserPromptSubmit', 'SessionEnd']) {
      const id = event === 'SessionEnd' ? 'fghij' : 'kmnop';
      await s.open(id);
      s.clock.t += 10;
      assert.equal(note({ event, sessionId: 'lead', at: s.clock.t }), 1, event);
      assert.equal(s.store.permission(id).closedBy, event);
    }
  } finally { await s.clean(); }
});

test('answered elsewhere: a hook time ahead of this clock counts as now, one with no time counts as now, a lead check or a store that throws closes nothing', async () => {
  const s = await storeAt(T0);
  try {
    const note = createAnsweredElsewhere({ store: s.store, isLeadSession: () => true, now: () => s.clock.t, log: () => {} });
    await s.open('abcde');
    s.clock.t += 500;
    await s.open('fghij', s.clock.t);
    // A time far ahead must not close what was relayed after the real moment.
    s.clock.t += 500;
    await s.open('kmnop', s.clock.t);
    assert.equal(note({ event: 'Stop', sessionId: 'lead', at: s.clock.t + 3600e3 }), 2, 'capped at now: the one relayed this millisecond stays');
    assert.equal(s.store.permission('kmnop').state, 'open');
    s.clock.t += 1;
    assert.equal(note({ event: 'Stop', sessionId: 'lead', at: null }), 1, 'no time: now');
    await s.open('qrstu');
    s.clock.t += 1;
    // A time that is no whole number of milliseconds is no time: now.
    const asked = [];
    const again = createAnsweredElsewhere({ store: { closePermissionsElsewhere: ({ upTo }) => { asked.push(upTo); return []; } }, isLeadSession: () => true, now: () => s.clock.t, log: () => {} });
    for (const at of ['soon', 1.5, undefined, true, s.clock.t - 7]) assert.equal(again({ event: 'Stop', sessionId: 'lead', at }), 0);
    assert.deepEqual(asked, [s.clock.t, s.clock.t, s.clock.t, s.clock.t, s.clock.t - 7]);
    const strict = createAnsweredElsewhere({ store: s.store, isLeadSession: () => 'yes', now: () => s.clock.t, log: () => {} });
    assert.equal(strict({ event: 'Stop', sessionId: 'lead', at: s.clock.t }), 0, 'only a plain true is the lead');
    const throws = createAnsweredElsewhere({ store: s.store, isLeadSession: () => { throw new Error('boom'); }, now: () => s.clock.t, log: () => {} });
    assert.equal(throws({ event: 'Stop', sessionId: 'lead', at: s.clock.t }), 0);
    const broken = createAnsweredElsewhere({ store: { closePermissionsElsewhere: () => { throw new Error('boom'); } }, isLeadSession: () => true, log: () => {} });
    assert.equal(broken({ event: 'Stop', sessionId: 'lead', at: 1 }), 0);
    assert.equal(createAnsweredElsewhere({ store: s.store })({ event: 'Stop', sessionId: 'lead', at: s.clock.t }), 0, 'with no lead check given, nobody is the lead');
    assert.equal(s.store.permission('qrstu').state, 'open');
  } finally { await s.clean(); }
});

// ---- the needs-you ingest hands each event on ----

const SID = 'a1b2c3d4-0000-4000-8000-00000000000a';
const opened = [];
after(async () => { for (const s of opened) await new Promise(r => s.close(r)); });
const scratch = async () => mkdtemp(join(tmpdir().length <= 60 ? tmpdir() : '/tmp', 'pa-'));
const ingest = async deps => {
  const dir = await scratch();
  const sockDir = join(dir, 's');
  await mkdir(sockDir, { mode: 0o700 });
  await chmod(sockDir, 0o700);
  const path = join(sockDir, 'i.sock');
  const logged = [];
  const h = createIngestHandler({ cache: createCache(), needsYou: createNeedsYouStore({ whoFor: () => null }), log: l => logged.push(l), ...deps });
  const server = createServer((q, r) => h(q, r));
  opened.push(server);
  await new Promise(r => server.listen(path, r));
  const post = payload => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const q = request({ socketPath: path, method: 'POST', path: '/api/ingest/needs-you', agent: false, headers: { host: 'localhost', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    q.on('error', reject);
    q.end(body);
  });
  return { post, logged, clean: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
};

test('the needs-you ingest hands every taken event to onMoved, a stale one included, never a block or a refused post; a close that throws never fails the hook\'s post', async () => {
  const moved = [];
  const i = await ingest({ onMoved: v => { moved.push(v); return 0; }, onBlock: () => true });
  try {
    assert.equal((await i.post({ hook_event_name: 'Stop', session_id: SID, at: 2000 })).status, 200);
    assert.equal((await i.post({ hook_event_name: 'PostToolUse', session_id: SID, at: 3000 })).status, 200);
    const stale = await i.post({ hook_event_name: 'UserPromptSubmit', session_id: SID, at: 2500 });
    assert.deepEqual(stale.json, { ok: true, open: 0, stale: true }, 'older than the last one seen: no wait changes');
    assert.equal((await i.post({ hook_event_name: 'PermissionDenied', session_id: SID, tool_name: 'Bash', reason: 'x', at: 4000 })).status, 200);
    assert.equal((await i.post({ hook_event_name: 'PreToolUse', session_id: SID })).status, 400);
    assert.deepEqual(moved, [
      { event: 'Stop', sessionId: SID, kind: null, at: 2000 },
      { event: 'PostToolUse', sessionId: SID, kind: null, at: 3000 },
      { event: 'UserPromptSubmit', sessionId: SID, kind: null, at: 2500 }
    ], 'the stale post still says when its hook ran; the block and the refused post are not handed on');
  } finally { await i.clean(); }
  const broken = await ingest({ onMoved: () => { throw Object.assign(new Error('secret words'), { code: 'EBOOM' }); } });
  try {
    const r = await broken.post({ hook_event_name: 'Stop', session_id: SID, at: 1 });
    assert.deepEqual(r, { status: 200, json: { ok: true, open: 0 } });
    assert.equal(broken.logged.at(-1), 'needs-you: the cards\' close failed (EBOOM)');
    assert.ok(!broken.logged.join('\n').includes('secret words'));
  } finally { await broken.clean(); }
  const none = await ingest({});
  try { assert.equal((await none.post({ hook_event_name: 'Stop', session_id: SID, at: 1 })).status, 200, 'with no onMoved the ingest works as before'); } finally { await none.clean(); }
});

test('the needs-you ingest logs a block by what became of it: the window, parity\'s note, or neither', async () => {
  for (const [answer, words, block] of [
    [true, 'page approvals are Deny only for 15 minutes', true],
    ['parity', 'noted; no Deny-only window (approvals follow the relay)', false],
    [false, 'not the lead\'s session or approvals off, noted only', false]
  ]) {
    const i = await ingest({ onBlock: () => answer });
    try {
      const r = await i.post({ hook_event_name: 'PermissionDenied', session_id: SID, tool_name: 'Bash', reason: 'x' });
      assert.deepEqual(r.json, { ok: true, block }, String(answer));
      assert.equal(i.logged.at(-1), `needs-you: PermissionDenied (Bash), ${words}`);
    } finally { await i.clean(); }
  }
});

// ---- server.mjs, read as source (it can't run in a test) ----

test('server.mjs: both ingest handlers get onMoved, the close counts only the lead\'s session by name, and the gate gets config\'s rules and hidden values', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /\nlet answeredElsewhere = null;\nconst onMoved = value => answeredElsewhere\?\.\(value\) \?\? 0;\n/);
  const handler = src.slice(src.indexOf('const api = createHandler({'));
  assert.match(handler.slice(0, handler.indexOf('\n});')), /\bonMoved\b/, 'the TCP handler (the legacy needs-you route)');
  assert.match(src, /createIngestHandler\(\{[^}]*\bonMoved\b[^}]*\}\)/, 'the ingest socket\'s handler');
  assert.match(src, /answeredElsewhere = createAnsweredElsewhere\(\{ store: chatStore, isLeadSession: id => leadName !== null && \(sessionAgents\.get\(id\) \?\? null\) === leadName \}\);/);
  const gate = src.slice(src.indexOf('approvals = createApprovals({'));
  assert.match(gate.slice(0, gate.indexOf('\n  });')), /\brules: approvalSettings\.rules, hidden: approvalSettings\.hidden,/);
  assert.match(src, /if \(approvals\.rules === 'parity'\) console\.log\(parityStartLine\(approvals\)\);/);
  assert.match(src, /kind: 'approvals-mode', mode: approvals\.serverMode\(\), previous: lastMode, rules: approvals\.rules, hidden: approvals\.hidden \}/);
});
