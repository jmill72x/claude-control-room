// The Chat tab's pure logic (src/lib/orbit/chat.js): merge and dedup by seq, the
// pending bubble's replacement, ticks, the status banner, permission cards, the
// photo resize, the day lines and the ids. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newClientId, mergeMessages, applyEdit, applyState, lastSeq, oldestId, tickFor, TICK_MARKS, bannerFor,
  fileKind, transferFiles, dragHasFiles, intake, MAX_FILES, FILE_MAX_BYTES, ACCEPT, permissionView, upsertPermission, withStatus, cardFields, exactRows, markerSegments, hasMarker, shownInput, sha256Hex, allowArmed, ALLOW_ARM_MS, sentLine, phaseFor, afterStreamRefusal, effectiveStatus, resizeTarget, fileSize, dayLabel, threadRows, quoted, quoteLine, PERMISSION_TTL_MS,
  isPhotoType, fileWord, viaWords, keyLine, keyRows, pairedSince, codeState
} from '../src/lib/orbit/chat.js';
import { parseRoute, routeHash } from '../src/lib/orbit/page.js';

const T0 = new Date(2026, 10, 11, 9, 5).getTime();
const msg = (seq, from, text, extra = {}) => ({ seq, id: `m_${seq}abcdef`, at: T0 + seq * 1000, from, kind: 'chat', text, replyTo: null, attachments: [], editedAt: null, state: from === 'jeff' ? 'queued' : null, ...extra });

test('the chat tab lives at #chat', () => {
  assert.deepEqual(parseRoute('#chat'), { tab: 'chat', item: null });
  assert.equal(routeHash({ tab: 'chat' }), '#chat');
  assert.deepEqual(parseRoute('#board'), { tab: 'board', item: null });
  assert.deepEqual(parseRoute('#chat/x'), { tab: 'overview', item: null }, 'nothing hangs off #chat');
});

test('client ids are unique and of the server\'s shape', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(newClientId());
  assert.equal(ids.size, 200);
  assert.match(newClientId(1794380000000, () => 0.5), /^p_[a-z0-9]+_[a-z0-9]{6}$/);
  assert.ok(newClientId().length <= 80);
});

test('a merge keeps each seq once, in order, the newer copy winning', () => {
  const a = [msg(1, 'jeff', 'hi'), msg(3, 'jarvis', 'yes')];
  const merged = mergeMessages(a, [msg(2, 'jarvis', 'hello'), { ...msg(3, 'jarvis', 'yes!'), editedAt: 5 }, msg(1, 'jeff', 'hi')]);
  assert.deepEqual(merged.map(m => m.seq), [1, 2, 3]);
  assert.equal(merged[2].text, 'yes!', 'the later copy of seq 3 wins');
  assert.equal(mergeMessages(a, msg(0.5, 'x', 'bad')).length, 2, 'a message without an integer seq is dropped');
  assert.equal(mergeMessages(a, [null, undefined]).length, 2);
  const older = mergeMessages(merged, [msg(-1, 'jarvis', 'first')]);
  assert.equal(older[0].seq, -1, 'older history goes in front');
});

test('a pending bubble stays until the server\'s copy of its send arrives, then gives way', () => {
  const pending = { clientId: 'p_1', id: null, seq: null, from: 'jeff', kind: 'chat', text: 'sending', at: T0, attachments: [] };
  const list = mergeMessages([msg(1, 'jarvis', 'hello')], [], {});
  const withPending = [...list, pending];
  assert.equal(withPending.length, 2);
  // Someone else's message arrives: the pending bubble stays, after the seqs.
  const other = mergeMessages(withPending, msg(2, 'jarvis', 'more'));
  assert.deepEqual(other.map(m => m.seq), [1, 2, null]);
  // The send answered {id: m_3abcdef}; when that message arrives it replaces the bubble.
  const done = mergeMessages(other, msg(3, 'jeff', 'sending'), { pendingId: 'm_3abcdef', clientId: 'p_1' });
  assert.deepEqual(done.map(m => m.seq), [1, 2, 3]);
  assert.ok(!done.some(m => m.clientId === 'p_1' && m.seq === null));
  // The same answer without the pending id resolves nothing (a different clientId).
  const kept = mergeMessages(other, msg(3, 'jeff', 'sending'), { pendingId: 'm_3abcdef', clientId: 'p_other' });
  assert.equal(kept.length, 4);
  // The page's own optimistic copy carrying the server's id (set after the send
  // answered) is replaced when the live event comes without the hint too.
  const named = [...list, { ...pending, id: 'm_9abcdef' }];
  assert.equal(mergeMessages(named, msg(9, 'jeff', 'sending')).filter(m => m.id === 'm_9abcdef').length, 1);
});

test('edits and state changes touch one message', () => {
  const list = [msg(1, 'jeff', 'hi'), msg(2, 'jarvis', 'hello')];
  const edited = applyEdit(list, { id: 'm_2abcdef', text: 'hello!', editedAt: 77 });
  assert.equal(edited[1].text, 'hello!');
  assert.equal(edited[1].editedAt, 77);
  assert.equal(edited[0].text, 'hi');
  const delivered = applyState(list, { id: 'm_1abcdef', state: 'delivered' });
  assert.equal(delivered[0].state, 'delivered');
  assert.equal(delivered[1], list[1], 'untouched rows are the same objects');
  assert.equal(applyState(list, { id: 'm_1abcdef', state: 'queued' })[0], list[0], 'the same state changes nothing');
});

test('lastSeq and oldestId skip pending bubbles', () => {
  assert.equal(lastSeq([]), 0);
  assert.equal(lastSeq([msg(4, 'jeff', 'a'), { clientId: 'p', seq: null }, msg(2, 'jeff', 'b')]), 4);
  assert.equal(oldestId([{ clientId: 'p', seq: null }]), null);
  assert.equal(oldestId([msg(2, 'jeff', 'b'), msg(4, 'jeff', 'a')]), 'm_2abcdef');
});

test('ticks: sending, failed, queued, one when delivered, two when answered; only the owner\'s chat messages', () => {
  const mine = msg(1, 'jeff', 'hi');
  assert.equal(tickFor(mine, [mine]), 'queued');
  assert.equal(TICK_MARKS.queued, '');
  assert.equal(tickFor({ ...mine, state: 'delivered' }, [mine]), 'delivered');
  assert.equal(TICK_MARKS.delivered, '✓');
  const answered = [mine, msg(2, 'jarvis', 'hello')];
  assert.equal(tickFor(mine, answered), 'answered');
  assert.equal(TICK_MARKS.answered, '✓✓');
  assert.equal(tickFor(mine, [mine, msg(2, 'jarvis', 'x', { kind: 'permission' })]), 'queued', 'a permission request is not an answer');
  assert.equal(tickFor(mine, [mine, msg(0, 'jarvis', 'earlier')]), 'queued', 'an earlier message is not an answer');
  assert.equal(tickFor({ ...mine, seq: null, clientId: 'p' }, []), 'sending');
  assert.equal(tickFor({ ...mine, seq: null, failed: true }, []), 'failed');
  assert.equal(tickFor(msg(2, 'jarvis', 'hello'), answered), null);
  assert.equal(tickFor(msg(3, 'jeff', 'allow', { kind: 'verdict' }), answered), null);
  assert.equal(tickFor(null, []), null);
});

test('the banner says what the status means, in local time', () => {
  const now = T0;
  assert.equal(bannerFor(null).tone, 'quiet');
  assert.deepEqual(bannerFor({ state: 'online' }, now), { tone: 'online', text: 'Jarvis is online' });
  const off = bannerFor({ state: 'offline', since: new Date(2026, 10, 11, 8, 7).getTime() }, now);
  assert.equal(off.tone, 'offline');
  assert.equal(off.text, "Jarvis is offline since 08:07. Messages wait here and reach him when he's back.");
  assert.equal(bannerFor({ state: 'offline', since: null }, now).text, "Jarvis is offline. Messages wait here and reach him when he's back.");
  assert.deepEqual(bannerFor({ state: 'slow', since: now - 10 * 60e3 - 5000 }, now), { tone: 'slow', text: 'Delivered 10 m ago, no answer yet' });
  assert.equal(bannerFor({ state: 'slow', since: now - 1000 }, now).text, 'Delivered 1 m ago, no answer yet', 'never 0 m');
  assert.equal(bannerFor({ state: 'slow' }, now).text, 'Delivered a while ago, no answer yet');
  assert.equal(bannerFor({ state: 'waiting on you' }, now).tone, 'waiting');
});

test('the open cards decide "waiting on you" between status pings, both ways', () => {
  const p = { requestId: 'r1', tool: 'Bash', description: 'x', inputPreview: '', openedAt: T0, state: 'open' };
  const open = new Map([['r1', p]]);
  assert.equal(effectiveStatus({ state: 'online' }, open, T0).state, 'waiting on you');
  const same = { state: 'waiting on you', since: 1 };
  assert.equal(effectiveStatus(same, open, T0), same, 'unchanged when the server says so already');
  assert.equal(effectiveStatus({ state: 'waiting on you', channelConnected: true }, new Map(), T0).state, 'online', 'closed on the page before the next ping');
  assert.equal(effectiveStatus({ state: 'waiting on you', channelConnected: false }, new Map(), T0).state, 'offline');
  assert.equal(effectiveStatus({ state: 'waiting on you' }, new Map([['r1', { ...p, state: 'allowed' }]]), T0).state, 'online');
  assert.equal(effectiveStatus({ state: 'online' }, open, T0 + PERMISSION_TTL_MS).state, 'online', 'an expired card is not waiting');
  assert.equal(effectiveStatus({ state: 'offline' }, new Map(), T0).state, 'offline');
  const offline = { state: 'offline', channelConnected: false, since: 1 };
  assert.equal(effectiveStatus(offline, open, T0), offline, 'offline wins over an open card');
  assert.equal(effectiveStatus(null, open, T0), null);
});

test('a status that counts no open request drops the cards the page still shows as open; expired and closed ones stay', () => {
  const p = { requestId: 'r1', tool: 'Bash', description: 'x', inputPreview: '', openedAt: T0, state: 'open' };
  const map = new Map([['r1', p], ['r2', { ...p, requestId: 'r2', openedAt: T0 - PERMISSION_TTL_MS }], ['r3', { ...p, requestId: 'r3', state: 'allowed' }]]);
  const next = withStatus(map, { state: 'online', openPermissions: 0 }, T0);
  assert.deepEqual([...next.keys()], ['r2', 'r3']);
  assert.equal(map.size, 3, 'the old map is left alone');
  assert.equal(withStatus(map, { state: 'waiting on you', openPermissions: 1 }, T0), map, 'the server still counts one');
  assert.equal(withStatus(map, { state: 'online' }, T0), map, 'no count, no change');
  assert.equal(withStatus(map, null, T0), map);
  const noneOpen = new Map([['r3', map.get('r3')]]);
  assert.equal(withStatus(noneOpen, { openPermissions: 0 }, T0), noneOpen, 'nothing to drop, same map');
});

test('a refusal after the stream gave up: 401, 403 and 404 stop with their phase; anything else opens again', () => {
  assert.equal(phaseFor({ status: 401 }), 'unpaired');
  assert.equal(phaseFor({ status: 403 }), 'forbidden');
  assert.equal(phaseFor({ status: 404 }), 'off');
  assert.equal(phaseFor({ status: 500 }), 'error');
  assert.equal(phaseFor(new TypeError('Failed to fetch')), 'error');
  assert.deepEqual(afterStreamRefusal({ status: 401 }), { reopen: false, phase: 'unpaired' });
  assert.deepEqual(afterStreamRefusal({ status: 403 }), { reopen: false, phase: 'forbidden' });
  assert.deepEqual(afterStreamRefusal({ status: 404 }), { reopen: false, phase: 'off' });
  assert.deepEqual(afterStreamRefusal({ status: 502 }), { reopen: true, phase: null });
  assert.deepEqual(afterStreamRefusal(new TypeError('Failed to fetch')), { reopen: true, phase: null });
});

test('a permission card is open, expired after 10 minutes on the page too, or closed', () => {
  const p = { requestId: 'r1', tool: 'Bash', description: 'run ls', inputPreview: 'ls -la', openedAt: T0, state: 'open' };
  assert.equal(permissionView(p, T0 + 1000).view, 'open');
  assert.equal(permissionView(p, T0 + PERMISSION_TTL_MS).view, 'expired');
  assert.equal(permissionView({ ...p, state: 'expired' }, T0).view, 'expired');
  assert.equal(permissionView({ ...p, state: 'allowed' }, T0).view, 'closed');
  assert.equal(permissionView({ ...p, state: 'denied' }, T0 + PERMISSION_TTL_MS).view, 'closed');
  assert.equal(permissionView(null), null);
  const empty = new Map();
  let map = upsertPermission(empty, p);
  assert.equal(empty.size, 0, 'the old map is left alone (React compares by identity)');
  const opened = map;
  map = upsertPermission(map, { ...p, state: 'allowed' });
  assert.notEqual(map, opened);
  assert.equal(opened.get('r1').state, 'open');
  assert.equal(map.size, 1);
  assert.equal(map.get('r1').state, 'allowed');
  assert.equal(upsertPermission(map, { tool: 'x' }), map, 'no id, no change');
});

test('a photo is drawn at a 1568 px long edge, the aspect kept, never scaled up', () => {
  assert.deepEqual(resizeTarget(4032, 3024), { width: 1568, height: 1176, scaled: true });
  assert.deepEqual(resizeTarget(3024, 4032), { width: 1176, height: 1568, scaled: true });
  assert.deepEqual(resizeTarget(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(resizeTarget(1568, 1568), { width: 1568, height: 1568, scaled: false });
  assert.deepEqual(resizeTarget(10000, 1), { width: 1568, height: 1, scaled: true }, 'a sliver keeps a pixel');
  assert.deepEqual(resizeTarget(3000, 2000, 1000), { width: 1000, height: 667, scaled: true });
  assert.equal(fileSize(900), '900 B');
  assert.equal(fileSize(820 * 1024), '820 KB');
  assert.equal(fileSize(2.3 * 1024 * 1024), '2.3 MB');
  assert.equal(fileSize(NaN), '');
});

test('day lines: Today, Yesterday, then the weekday and date; one per day', () => {
  const now = T0;
  assert.equal(dayLabel(now - 60e3, now), 'Today');
  assert.equal(dayLabel(now - 24 * 3600e3, now), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 10, 3, 23).getTime(), now), 'Tue 11-03');
  const rows = threadRows([
    { ...msg(1, 'jeff', 'a'), at: new Date(2026, 10, 10, 9).getTime() },
    { ...msg(2, 'jarvis', 'b'), at: new Date(2026, 10, 10, 10).getTime() },
    { ...msg(3, 'jeff', 'c'), at: now },
    { clientId: 'p_1', seq: null, id: null, from: 'jeff', kind: 'chat', text: 'd', at: now }
  ], now);
  assert.deepEqual(rows.map(r => r.type), ['day', 'message', 'message', 'day', 'message', 'message']);
  assert.equal(rows[0].label, 'Yesterday');
  assert.equal(rows[3].label, 'Today');
  assert.equal(rows[5].key, 'p_1', 'a pending row is keyed by its clientId');
});

test('a reply quotes the message by id, on one short line', () => {
  const list = [msg(1, 'jarvis', 'The first line\nand a second one that goes on and on and on and on and on and on and on and on and on')];
  assert.equal(quoted(list, 'm_1abcdef'), list[0]);
  assert.equal(quoted(list, 'm_nope'), null);
  assert.equal(quoted(list, null), null);
  const line = quoteLine(list[0]);
  assert.equal(line.length, 90);
  assert.ok(line.endsWith('…'));
  assert.ok(!line.includes('\n'));
  assert.equal(quoteLine(null), 'an earlier message');
  assert.equal(quoteLine({ text: '', attachments: [{ id: 'a' }] }), 'Photo');
  assert.equal(quoteLine({ text: '', attachments: [{ id: 'a' }, { id: 'b' }] }), 'Photos');
});

// ---- files beyond photos: paste, drop, PDFs ----

const file = (name, type, size = 1000) => ({ name, type, size });

test('a file is a photo, a pdf, or refused; a typeless drag goes by its name', () => {
  assert.equal(fileKind(file('a.png', 'image/png')), 'photo');
  assert.equal(fileKind(file('image.png', 'IMAGE/PNG')), 'photo');
  assert.equal(fileKind(file('x.heic', 'image/heic')), 'photo');
  assert.equal(fileKind(file('plan.pdf', 'application/pdf')), 'pdf');
  assert.equal(fileKind(file('plan.PDF', '')), 'pdf');
  assert.equal(fileKind(file('IMG_1.HEIC', '')), 'photo');
  assert.equal(fileKind(file('notes.txt', 'text/plain')), null, 'no text from the page');
  assert.equal(fileKind(file('notes.md', '')), null);
  assert.equal(fileKind(file('fake.pdf', 'text/html')), null, 'a declared type wins over the name');
  assert.equal(fileKind(null), null);
  assert.equal(ACCEPT, 'image/*,application/pdf');
});

test('a paste or drop: files when the browser fills them, else the file items; text alone gives none', () => {
  const shot = file('image.png', 'image/png');
  assert.deepEqual(transferFiles({ files: [shot], items: [] }), [shot]);
  assert.deepEqual(transferFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => shot }] }), [shot], 'a screenshot pasted on some browsers comes only as an item');
  assert.deepEqual(transferFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] }), [], 'a text paste carries no file');
  assert.deepEqual(transferFiles({ files: [], items: [{ kind: 'file', getAsFile: () => null }] }), []);
  assert.deepEqual(transferFiles(null), []);
  assert.equal(dragHasFiles({ types: ['text/plain', 'Files'] }), true);
  assert.equal(dragHasFiles({ types: ['text/plain', 'text/uri-list'] }), false, 'dragged text is left to the box');
  assert.equal(dragHasFiles(null), false);
});

test('intake: photos and PDFs only, a PDF under 10 MB, four at most across both, counting those already held', () => {
  const photo = file('a.jpg', 'image/jpeg', 9e6 * 3);
  const pdf = file('b.pdf', 'application/pdf', 2000);
  const big = file('c.pdf', 'application/pdf', FILE_MAX_BYTES + 1);
  const txt = file('d.txt', 'text/plain');
  let r = intake([photo, pdf], 0);
  assert.deepEqual(r.take.map(t => [t.file.name, t.kind]), [['a.jpg', 'photo'], ['b.pdf', 'pdf']], 'a big photo is fine: it is resized');
  assert.equal(r.note, null);
  assert.equal(intake([file('e.pdf', 'application/pdf', FILE_MAX_BYTES)]).take.length, 1, '10 MB exactly is allowed');
  r = intake([txt, big, pdf], 0);
  assert.deepEqual(r.take.map(t => t.file.name), ['b.pdf']);
  assert.equal(r.note, 'Only photos and PDFs can be sent (1 left out); a PDF must be under 10 MB (1 left out).');
  r = intake([photo, pdf, photo], 2);
  assert.deepEqual(r.take.map(t => t.kind), ['photo', 'pdf']);
  assert.equal(r.note, `At most ${MAX_FILES} files a message (1 left out).`);
  assert.deepEqual(intake([pdf], MAX_FILES).take, []);
  assert.deepEqual(intake([], 0), { take: [], note: null });
  assert.deepEqual(intake(undefined), { take: [], note: null });
});

// ---- approvals (docs/design/2026-11-11-jarvis-os-approvals.md) ----

test('a card offers Allow only when the server says so, this device is an approver, and no Deny-only window runs', () => {
  const p = { requestId: 'r1', tool: 'Bash', description: 'd', inputPreview: '{"command":"ls"}', openedAt: T0, relayedAt: T0, expiresAt: T0 + PERMISSION_TTL_MS, state: 'open', denyOnly: [], canAllow: true };
  const on = { mode: 'on', denyOnlyUntil: null };
  assert.equal(permissionView(p, T0, { approver: true, approvals: on }).canAllow, true);
  assert.equal(permissionView(p, T0, { approver: false, approvals: on }).canAllow, false, 'not an approver');
  assert.equal(permissionView(p, T0).canAllow, false, 'nothing known: no Allow');
  assert.equal(permissionView({ ...p, canAllow: false, denyOnly: ['x'] }, T0, { approver: true, approvals: on }).canAllow, false);
  const deny = permissionView(p, T0, { approver: true, approvals: { mode: 'deny', denyOnlyUntil: null } });
  assert.equal(deny.canAllow, false);
  assert.deepEqual(deny.denyOnly, ['approvals are Deny only for now']);
  const block = permissionView(p, T0, { approver: true, approvals: { mode: 'on', denyOnlyUntil: T0 + 1 } });
  assert.equal(block.canAllow, false, 'a window that began after the card opened');
  assert.deepEqual(block.denyOnly, ['auto mode blocked something in the last 15 minutes']);
  assert.equal(permissionView(p, T0 + 1, { approver: true, approvals: { mode: 'on', denyOnlyUntil: T0 + 1 } }).canAllow, true, 'over');
  // Expiry from expiresAt (counted from relayedAt on the server), and the terminal's own.
  assert.equal(permissionView({ ...p, expiresAt: T0 + 5 }, T0 + 5).view, 'expired');
  assert.equal(permissionView({ ...p, expiresAt: undefined, relayedAt: T0 - PERMISSION_TTL_MS }, T0).view, 'expired');
  for (const state of ['late', 'repeat']) {
    const v = permissionView({ ...p, state }, T0, { approver: true, approvals: on });
    assert.deepEqual([v.view, v.canAllow], ['terminal', false], state);
  }
});

test('the card leads with the parsed fields, and marks what it cannot vouch for', () => {
  assert.deepEqual(cardFields({ fields: [['command', 'ls'], ['description', 'pad']] }), [['command', 'ls'], ['description', 'pad']]);
  assert.deepEqual(cardFields({ fields: null, inputPreview: 'raw text' }), [['input', 'raw text']]);
  assert.deepEqual(cardFields({}), []);
  assert.deepEqual(markerSegments('ls ⋯ 12 code points elided ⋯ x'), [{ text: 'ls ', marker: false }, { text: '⋯ 12 code points elided ⋯', marker: true }, { text: ' x', marker: false }]);
  assert.deepEqual(markerSegments('[REDACTED]'), [{ text: '[REDACTED]', marker: true }]);
  assert.deepEqual(markerSegments('a⟦U+202E⟧b').map(x => x.marker), [false, true, false]);
  assert.deepEqual(markerSegments('y ⋯ 5 code points cut by the channel ⋯').map(x => x.marker), [false, true]);
  assert.deepEqual(markerSegments('<b>not html</b>'), [{ text: '<b>not html</b>', marker: false }], 'text stays text');
  assert.equal(hasMarker({ fields: [['command', 'cat (value unserializable)']] }), true);
  assert.equal(hasMarker({ fields: [['command', 'ls']], description: 'x [REDACTED]' }), true);
  assert.equal(hasMarker({ fields: [['command', 'ls']], description: 'x' }), false);
});

test('the shown hash is sha256 over JSON.stringify([tool, description, inputPreview]) as delivered, the server\'s own rule', async () => {
  const p = { tool: 'Bash', description: 'list\nfiles', inputPreview: '{"command":"ls"}' };
  assert.equal(shownInput(p), JSON.stringify(['Bash', 'list\nfiles', '{"command":"ls"}']));
  const { createHash } = await import('node:crypto');
  assert.equal(await sha256Hex(shownInput(p)), createHash('sha256').update(shownInput(p)).digest('hex'));
  await assert.rejects(sha256Hex('x', null), /secure context/);
});

test('the exact command: the hash covers it, and its rows keep every line break and tab in sight', async () => {
  const p = { tool: 'Bash', description: 'd', inputPreview: '{"command":"cat a rm b"}' };
  assert.equal(shownInput({ ...p, exact: 'cat a\nrm b' }), JSON.stringify(['Bash', 'd', '{"command":"cat a rm b"}', 'cat a\nrm b']));
  assert.equal(shownInput({ ...p, exact: null }), shownInput(p), 'no exact text: the hash as before');
  assert.equal(shownInput({ ...p, exact: 7 }), shownInput(p));
  assert.notEqual(shownInput({ ...p, exact: 'cat a rm b' }), shownInput({ ...p, exact: 'cat a\nrm b' }));
  // The server's rule, computed apart: sha256 over the same four items.
  const { createHash } = await import('node:crypto');
  assert.equal(await sha256Hex(shownInput({ ...p, exact: 'cat a\nrm b' })), createHash('sha256').update(JSON.stringify([p.tool, p.description, p.inputPreview, 'cat a\nrm b'])).digest('hex'));
  assert.deepEqual(exactRows('ls -la'), [{ parts: [{ text: 'ls -la' }], end: false }]);
  assert.deepEqual(exactRows('cat a\nrm b'), [{ parts: [{ text: 'cat a' }], end: true }, { parts: [{ text: 'rm b' }], end: false }]);
  assert.deepEqual(exactRows('a\tb'), [{ parts: [{ text: 'a' }, { tab: true }, { text: 'b' }], end: false }]);
  assert.deepEqual(exactRows('\ta\t'), [{ parts: [{ tab: true }, { text: 'a' }, { tab: true }], end: false }]);
  assert.deepEqual(exactRows('pwd\n'), [{ parts: [{ text: 'pwd' }], end: true }], 'a final line break is a mark, not an empty row');
  assert.deepEqual(exactRows('a\n\nb').map(r => [r.parts.length, r.end]), [[1, true], [0, true], [1, false]], 'an empty line in the middle is a row');
  assert.deepEqual(exactRows('\n'), [{ parts: [], end: true }]);
  assert.deepEqual(exactRows('<b>x</b>'), [{ parts: [{ text: '<b>x</b>' }], end: false }], 'text stays text');
  for (const none of [null, undefined, '', 7, ['ls']]) assert.deepEqual(exactRows(none), []);
});

test('Allow once is armed by the first tap for 4 seconds; the "sent" line never says done', () => {
  assert.equal(allowArmed(null, T0), false);
  assert.equal(allowArmed(T0, T0), true);
  assert.equal(allowArmed(T0, T0 + ALLOW_ARM_MS - 1), true);
  assert.equal(allowArmed(T0, T0 + ALLOW_ARM_MS), false);
  assert.equal(allowArmed(T0 + 10, T0), false, 'a clock that went back');
  assert.equal(sentLine({ state: 'allowed', answeredBy: 'iPhone', answeredAt: T0 }), 'Allow sent from iPhone at 09:05. Claude Code uses it if the prompt was still open.');
  assert.equal(sentLine({ state: 'denied' }), 'Deny sent. Claude Code uses it if the prompt was still open.');
});

// ---- Shortcut keys and what a Shortcut sent ----

test('a sent file is a picture or a chip: only image types are shown, and each chip has its word', () => {
  for (const type of ['image/png', 'image/jpeg', 'IMAGE/HEIC']) assert.equal(isPhotoType(type), true, type);
  for (const type of ['application/pdf', 'text/plain', 'text/markdown', '', null, undefined, 7]) assert.equal(isPhotoType(type), false, String(type));
  assert.equal(fileWord('application/pdf'), 'PDF');
  assert.equal(fileWord('text/plain'), 'text file');
  assert.equal(fileWord('text/markdown'), 'text file');
  assert.equal(fileWord('application/zip'), 'file');
});

test('viaWords: the mark on a message a Shortcut sent, from the server\'s meta only', () => {
  assert.equal(viaWords({ meta: { shortcut: { key: 'k1', via: 'siri' } } }), 'Siri Shortcut');
  assert.equal(viaWords({ meta: { shortcut: { key: 'k1', via: 'share' } } }), 'share sheet');
  assert.equal(viaWords({ meta: { shortcut: { key: 'k1', via: 'shortcut' } } }), 'Shortcut');
  assert.equal(viaWords({ meta: { shortcut: { via: 'constructor' } } }), 'Shortcut', 'an unknown way is only "Shortcut"');
  for (const m of [null, {}, { meta: null }, { meta: {} }, { meta: { shortcut: null } }, { meta: { shortcut: 'siri' } }, { text: 'via Siri' }]) assert.equal(viaWords(m), null);
});

test('keyLine and keyRows: a key\'s line in the sheet, active keys first, three revoked at most', () => {
  const when = at => `t${at}`;
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: null, uses: 0 }, when), 'made t1 · never used');
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: 5, uses: 1 }, when), 'made t1 · last used t5 · 1 use');
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: 9, uses: 12 }, when), 'made t1 · last used t9 · 12 uses');
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: null, uses: 0, madeBy: 'the pad' }, when), 'made t1 from the pad · never used');
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: 9, uses: 2, madeBy: '' }, when), 'made t1 · last used t9 · 2 uses');
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: 9, uses: 2, madeBy: 7 }, when), 'made t1 · last used t9 · 2 uses');
  assert.equal(keyLine({ createdAt: 1, lastUsedAt: 9, uses: 12, revokedAt: 20 }, when), 'revoked t20');
  assert.equal(keyLine(null, when), '');
  const keys = [
    { id: 'a', revokedAt: 10 }, { id: 'b', revokedAt: null }, { id: 'c', revokedAt: 40 }, { id: 'd', revokedAt: 30 }, { id: 'e', revokedAt: 20 }, { id: 'f', revokedAt: null }, null, { name: 'no id' }
  ];
  assert.deepEqual(keyRows(keys).map(k => k.id), ['b', 'f', 'c', 'd', 'e']);
  assert.deepEqual(keyRows(null), []);
});

test('codeState: a code the sheet made is waiting, then paired (a new active key of its name), or gone', () => {
  const made = { code: 'ABCDEF', name: 'iPhone', expiresAt: 600, before: ['old'] };
  const old = { id: 'old', name: 'iPhone', revokedAt: null };
  assert.equal(codeState(null, { keys: [], waiting: null }), null);
  assert.equal(codeState(made, { keys: [old], waiting: { name: 'iPhone', expiresAt: 600 } }), 'waiting');
  assert.equal(codeState(made, { keys: [old], waiting: null }), 'gone', 'the key that was there before is not the new one');
  assert.equal(codeState(made, { keys: [old], waiting: { name: 'Pad', expiresAt: 900 } }), 'gone', 'another code replaced it');
  assert.equal(codeState(made, { keys: [old, { id: 'new', name: 'iPhone', revokedAt: null }], waiting: null }), 'paired');
  assert.equal(codeState(made, { keys: [old, { id: 'new', name: 'iPhone', revokedAt: 5 }], waiting: null }), 'gone', 'a revoked key is not a pairing');
  assert.equal(codeState(made, { keys: [old, { id: 'new', name: 'Pad', revokedAt: null }], waiting: null }), 'gone');
  assert.equal(codeState(made, null), 'gone');
  assert.deepEqual(pairedSince(null, [{ id: 'a', name: 'iPhone' }], 'iPhone'), { id: 'a', name: 'iPhone' });
  assert.equal(pairedSince(['a'], null, 'iPhone'), null);
});
