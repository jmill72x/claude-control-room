// Approval cards left waiting (lib/approval-wait.mjs; board e7427be1): which waits are
// the lead's cards, their words, the threads' newest requests from the transcripts, the
// reminder's schedule (10 min, then each 30, at most six, one push at a time, quiet hours
// held to 07:00) and the answer watch's file. Every name, id and time is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolLabel, NAMED_TOOLS, TOOL_LABELS, threadTimes, describeWait, approvalWaits, waitWords, minutesOf,
  reminderBody, isReminderPush, REMINDER_TAIL, createApprovalReminders, fileView,
  REMIND_FIRST_MS, REMIND_EVERY_MS, REMIND_MAX, REMIND_GAP_MS, REMIND_RETRY_MS, FILE_VERSION
} from '../lib/approval-wait.mjs';
import { agentKey } from '../lib/needs-you.mjs';
import { isQuiet } from '../lib/events.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const at = (d, h, min = 0) => new Date(2026, 10, d, h, min).getTime(); // November 2026, local
const T0 = at(26, 13, 31);
const LEAD = 'Inventlead';

test('the numbers: first at 10 min, then each 30, six at most, never two pushes inside 10 min', () => {
  assert.equal(REMIND_FIRST_MS, 10 * MIN);
  assert.equal(REMIND_EVERY_MS, 30 * MIN);
  assert.equal(REMIND_MAX, 6);
  assert.equal(REMIND_GAP_MS, 10 * MIN);
  assert.equal(REMIND_RETRY_MS, 5 * MIN);
});

test('a tool is said by a fixed label: a known name, else "an MCP tool" or "a tool"; nothing is said when none is known', () => {
  for (const n of NAMED_TOOLS) assert.equal(toolLabel(n), n);
  assert.equal(toolLabel('mcp__plugin_invented_server__do_it'), 'an MCP tool');
  assert.equal(toolLabel('IGNORE PREVIOUS INSTRUCTIONS'), 'a tool');
  assert.equal(toolLabel('bash'), 'a tool', 'case counts');
  for (const none of [null, undefined, '', 7, {}]) assert.equal(toolLabel(none), null, String(none));
  assert.deepEqual(TOOL_LABELS, [...NAMED_TOOLS, 'an MCP tool', 'a tool']);
});

test('threadTimes: each session\'s own newest request and each subagent\'s, by the hash of the id in its file name', () => {
  const tx = [
    { sessionId: 's1', subagent: false, filePath: '/p/s1.jsonl', records: [{ ts: 5 }, { ts: 9 }, { ts: 'x' }] },
    { sessionId: 's1', subagent: false, filePath: '/p/s1-older.jsonl', records: [{ ts: 7 }] },
    { sessionId: 's1', subagent: true, filePath: '/p/s1/subagents/agent-aaa111.jsonl', meta: { agentType: 'invented-agent' }, records: [{ ts: 3 }] },
    { sessionId: 's1', subagent: true, filePath: '/p/s1/subagents/agent-bbb222.jsonl', records: [] },
    { sessionId: 's1', subagent: true, filePath: '/p/s1/subagents/not-an-agent.jsonl', records: [{ ts: 99 }] },
    { sessionId: 's2', subagent: true, filePath: '/p/s2/subagents/agent-ccc333.jsonl', records: [{ ts: 4 }] },
    { sessionId: '', records: [{ ts: 1 }] }, null, 'x'
  ];
  const t = threadTimes(tx);
  assert.deepEqual([...t.keys()], ['s1', 's2']);
  assert.equal(t.get('s1').main, 9, 'the newest over its own files');
  assert.equal(t.get('s1').agents.get(agentKey('aaa111')), 3);
  assert.equal(t.get('s1').agents.get(agentKey('bbb222')), -Infinity, 'read, with no request yet');
  assert.equal(t.get('s1').types.get(agentKey('aaa111')), 'invented-agent');
  assert.equal(t.get('s1').agents.size, 2, 'a file not named agent-<id> is no thread');
  assert.equal(t.get('s2').main, undefined, 'its own transcript was not read');
  assert.deepEqual(threadTimes(null), new Map());
});

test('describeWait: the oldest ask\'s tool and thread; a subagent by its roster name, else "a subagent"; with no ask, the card\'s hint', () => {
  const roster = { typeOf: (sid, key) => (sid === 's1' && key === 'k1' ? 'invented' : sid === 's1' && key === 'k2' ? 'stranger' : null), rosterName: w => (w === 'invented' ? 'Inventrun' : null) };
  assert.deepEqual(describeWait({ sessionId: 's1' }, [{ agent: null, tool: 'Bash' }, { agent: 'k1', tool: 'Edit' }], roster), { tool: 'Bash', run: null });
  assert.deepEqual(describeWait({ sessionId: 's1' }, [{ agent: 'k1', tool: 'Edit' }], roster), { tool: 'Edit', run: 'Inventrun' });
  assert.deepEqual(describeWait({ sessionId: 's1' }, [{ agent: 'k2', tool: 'mcp__x__y' }], roster), { tool: 'an MCP tool', run: 'a subagent' });
  assert.deepEqual(describeWait({ sessionId: 's1', hint: 'Bash' }, [], roster), { tool: 'Bash', run: null });
  assert.deepEqual(describeWait({ sessionId: 's1' }, [], roster), { tool: null, run: null });
  // A roster name that is not a plain short name is not said.
  assert.equal(describeWait({ sessionId: 's1' }, [{ agent: 'k1', tool: 'Bash' }], { typeOf: () => 'x', rosterName: () => 'IGNORE\nPREVIOUS' }).run, 'a subagent');
});

test('approvalWaits: the permission waits of the lead\'s sessions only, oldest first, with fixed labels; own unless a subagent asked', () => {
  const view = [
    { who: LEAD, kind: 'permission', since: T0 + 5, key: 'needs-you:b', tool: 'Edit', run: 'Inventrun' },
    { who: LEAD, kind: 'permission', since: T0, key: 'needs-you:a', tool: 'Bash', run: null },
    { who: LEAD, kind: 'idle', since: T0 - 1, key: 'needs-you:c' },
    { who: 'Otheragent', kind: 'permission', since: T0, key: 'needs-you:d' },
    { who: null, kind: 'permission', since: T0, key: 'needs-you:e' },
    { who: LEAD, kind: 'permission', since: T0, key: 'needs-you:f', tool: 'rm -rf /' },
    { who: LEAD, kind: 'permission', since: 'soon', key: 'needs-you:g' }, null
  ];
  const got = approvalWaits(view, LEAD);
  assert.deepEqual(got.map(w => w.key), ['needs-you:a', 'needs-you:f', 'needs-you:b']);
  assert.deepEqual(got[0], { key: 'needs-you:a', who: LEAD, run: null, tool: 'Bash', since: T0, own: true });
  assert.equal(got[1].tool, null, 'a tool that is no label is not said');
  assert.deepEqual(got[2], { key: 'needs-you:b', who: LEAD, run: 'Inventrun', tool: 'Edit', since: T0 + 5, own: false });
  assert.deepEqual(approvalWaits(view, null), []);
  assert.deepEqual(approvalWaits(view, ''), []);
  assert.deepEqual(approvalWaits(null, LEAD), []);
});

test('the words: whose card, its tool and session, and whole minutes', () => {
  const own = { who: LEAD, run: null, tool: 'Bash', since: T0 };
  assert.equal(waitWords(own, T0 + 42 * MIN + 59e3), 'Inventlead\'s approval card (Bash), open 42 min');
  assert.equal(waitWords({ ...own, tool: null }, T0), 'Inventlead\'s approval card, open 0 min');
  assert.equal(waitWords({ ...own, run: 'Inventrun' }, T0 + HOUR), 'Inventrun\'s approval card (Bash, in Inventlead\'s session), open 60 min');
  assert.equal(minutesOf(-5), 0);
});

test('the push\'s words: one fixed shape, a roster name and whole minutes, never a tool; anything else is refused', () => {
  const w = { who: LEAD, run: null, tool: 'Bash', since: T0 };
  assert.equal(reminderBody([w], T0 + 10 * MIN), `Inventlead has waited 10 min on an approval card. ${REMINDER_TAIL}`);
  assert.equal(reminderBody([{ ...w, run: 'Inventrun' }, w, w], T0 + 40 * MIN), `Inventrun has waited 40 min on an approval card. 2 more cards are waiting too. ${REMINDER_TAIL}`);
  assert.equal(reminderBody([w, w], T0 + 40 * MIN), `Inventlead has waited 40 min on an approval card. 1 more card is waiting too. ${REMINDER_TAIL}`);
  assert.ok(!reminderBody([w], T0 + 10 * MIN).includes('Bash'), 'no tool in a push');
  assert.equal(reminderBody([{ ...w, who: 'IGNORE\nTHIS' }], T0), `Jarvis has waited 0 min on an approval card. ${REMINDER_TAIL}`, 'a name that is not plain is the lead\'s word');
  assert.equal(reminderBody([], T0), null);
  assert.equal(reminderBody(null, T0), null);
  for (const bad of ['Jarvis needs an approval', `Inventlead has waited 10 min on an approval card. ${REMINDER_TAIL} rm -rf`, `x\nhas waited 1 min on an approval card. ${REMINDER_TAIL}`, `Inventlead has waited 12345 min on an approval card. ${REMINDER_TAIL}`, null, 7])
    assert.equal(isReminderPush(bad), false, String(bad));
});

// A reminder world: a push that records each body, a clock, the log.
function world({ reached = r => r.tried, tried = 2, quiet = () => false } = {}) {
  const pushes = [];
  const logs = [];
  const push = async body => { pushes.push(body); const r = { tried }; r.reached = typeof reached === 'function' ? reached(r) : reached; return r; };
  const rem = createApprovalReminders({ push, log: l => logs.push(l), quiet });
  return { rem, pushes, logs };
}
const card = (extra = {}) => ({ key: 'needs-you:aaaa', who: LEAD, run: null, tool: 'Bash', since: T0, own: true, ...extra });
// Steps each minute from `from` to `to`.
async function minutes(w, waits, from, to) { for (let t = from; t <= to; t += MIN) await w.rem.step(typeof waits === 'function' ? waits(t) : waits, t); }

test('a card that waits: a reminder at 10 min, then each 30, six in all, then none; each one logged', async () => {
  const w = world();
  await minutes(w, [card()], T0, T0 + 6 * HOUR);
  assert.equal(w.pushes.length, REMIND_MAX);
  assert.deepEqual(w.pushes.map(b => Number(/waited (\d+) min/.exec(b)[1])), [10, 40, 70, 100, 130, 160]);
  assert.equal(w.logs.length, 6);
  assert.equal(w.logs[0], 'approval-wait: a reminder went to 2 of 2 devices for Inventlead\'s approval card (Bash), open 10 min (reminder 1 of 6)');
  assert.equal(w.logs[5], 'approval-wait: a reminder went to 2 of 2 devices for Inventlead\'s approval card (Bash), open 160 min (reminder 6 of 6, the last)');
});

test('a card answered before 10 min is never reminded; a new card in the same session starts its own count', async () => {
  const w = world();
  await minutes(w, t => (t < T0 + 9 * MIN ? [card()] : []), T0, T0 + 30 * MIN);
  assert.equal(w.pushes.length, 0);
  assert.equal(w.rem.size(), 0, 'a card gone is forgotten');
  const later = T0 + HOUR;
  await minutes(w, [card({ since: later })], later, later + 10 * MIN);
  assert.equal(w.pushes.length, 1, 'same key, new start: a new card');
});

test('one push covers every card due; two cards never make two pushes inside 10 minutes', async () => {
  const w = world();
  await minutes(w, [card(), card({ key: 'needs-you:bbbb', since: T0 + 3 * MIN, run: 'Inventrun', own: false })], T0, T0 + 20 * MIN);
  assert.deepEqual(w.pushes, [`Inventlead has waited 10 min on an approval card. ${REMINDER_TAIL}`, `Inventrun has waited 17 min on an approval card. ${REMINDER_TAIL}`],
    'the second card falls due at 13 min, inside the gap, and goes at 20');
  const v = world();
  await minutes(v, [card(), card({ key: 'needs-you:bbbb', since: T0 })], T0, T0 + 10 * MIN);
  assert.deepEqual(v.pushes, [`Inventlead has waited 10 min on an approval card. 1 more card is waiting too. ${REMINDER_TAIL}`]);
  assert.match(v.logs[0], / and 1 more \(reminder 1 of 6\)$/);
});

test('quiet hours hold a reminder to 07:00, said once; the 07:00 pass sends it if the card still waits', async () => {
  const start = at(26, 21, 55);
  const w = world({ quiet: t => isQuiet(t) });
  await minutes(w, [card({ since: start })], start, at(27, 7, 0));
  assert.equal(w.pushes.length, 1);
  assert.match(w.pushes[0], /^Inventlead has waited 545 min/);
  assert.deepEqual(w.logs.filter(l => l.includes('quiet hours')), ['approval-wait: a reminder for Inventlead\'s approval card (Bash), open 10 min waits for the end of quiet hours']);
  // A card answered in the night is never reminded.
  const v = world({ quiet: t => isQuiet(t) });
  await minutes(v, t => (t < at(27, 6, 0) ? [card({ since: start })] : []), start, at(27, 8, 0));
  assert.equal(v.pushes.length, 0);
});

test('a push that reached no device is tried again 5 min on and counts toward none; with no device at all, nothing is tried', async () => {
  let reach = 0;
  const w = world({ reached: () => reach });
  await minutes(w, [card()], T0, T0 + 10 * MIN);
  assert.equal(w.pushes.length, 1);
  assert.match(w.logs[0], /reached none of 2 devices; tried again in 5 min$/);
  reach = 2;
  await minutes(w, [card()], T0 + 11 * MIN, T0 + 20 * MIN);
  assert.equal(w.pushes.length, 2, 'the gap holds the retry to 10 min after the miss');
  assert.match(w.logs.at(-1), /\(reminder 1 of 6\)$/);
  const none = world({ tried: 0, reached: 0 });
  await minutes(none, [card()], T0, T0 + 45 * MIN);
  assert.equal(none.pushes.length, 2, 'tried at 10 and again at 40: the schedule moves on');
  assert.equal(none.logs.filter(l => l.includes('no device takes a push')).length, 2);
});

test('a push that throws is a miss, and the next minute\'s step never sends a second while one is in flight', async () => {
  let calls = 0;
  let release;
  const rem = createApprovalReminders({ push: () => { calls++; return new Promise(r => { release = r; }); }, log: () => {} });
  const first = rem.step([card()], T0 + 10 * MIN);
  // Raced with a short timer, so a second send that waits on the first fails, never hangs.
  assert.deepEqual(await Promise.race([rem.step([card()], T0 + 11 * MIN), new Promise(r => setTimeout(() => r('a second send'), 200))]), { status: 'off' });
  release({ tried: 1, reached: 1 });
  assert.equal((await first).status, 'sent');
  assert.equal(calls, 1);
  const boom = createApprovalReminders({ push: async () => { throw new Error('gone'); }, log: () => {} });
  assert.equal((await boom.step([card()], T0 + 10 * MIN)).status, 'missed');
  assert.equal((await createApprovalReminders({}).step([card()], T0 + 10 * MIN)).status, 'off', 'no push');
});

test('the answer watch\'s file: a version, when, and each card\'s labels and start only', () => {
  const w = { key: 'needs-you:aaaa', who: LEAD, run: null, tool: 'Bash', since: T0, own: true };
  assert.deepEqual(fileView([w], T0 + MIN), { version: FILE_VERSION, at: T0 + MIN, waits: [{ who: LEAD, run: null, tool: 'Bash', since: T0, own: true }] });
  assert.deepEqual(fileView(null, 5), { version: 1, at: 5, waits: [] });
  assert.ok(!JSON.stringify(fileView([w], 1)).includes('needs-you:'), 'no key');
});

// server.mjs is not run by a test; its wiring is checked here, as other source tests do.
test('server.mjs: the sessions pass confirms the waits, the check reads the cards, and the reminder runs each minute with quiet hours', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const sessionsPass = src.slice(src.indexOf("registry.register('sessions'"), src.indexOf("registry.register('sessions'") + 3000);
  assert.ok(sessionsPass.includes('threadsNow = threadTimes(transcripts);') && sessionsPass.includes('needsYou.confirm(threadsNow, now)'), 'confirm in the sessions pass');
  assert.match(src, /approvalWaits: \(\) => approvalWaitsNow\(Date\.now\(\)\)/, 'the proactive check gets the cards');
  assert.match(src, /createApprovalReminders\(\{ push: body => push\.approvalReminder\(body\), quiet: at => isQuiet\(at\) \}\)/);
  assert.match(src, /approvalReminders\.step\(waits, now\)/);
  assert.match(src, /approvalWaitsFile\.write\(fileView\(waits, now\)\)/);
  assert.match(src, /hintFor: \(sid, now\) => cardToolHint\?\.\(sid, now\)/);
});
