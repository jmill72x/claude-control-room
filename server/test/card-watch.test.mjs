// A card answered somewhere else closes within seconds, and never early (board 48308589;
// lib/card-watch.mjs). Real files in a temp folder, the real sessions collector as "the last
// pass", the real chat store and answered-elsewhere. Every id, session and time here is
// invented; no line is a copy of a real transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, appendFile, writeFile, rename, truncate, utimes, symlink, open, lstat, readdir, stat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardWatch, createThreadUses, createFileTail, seedOf, leadFiles, mayMatter, WATCH_EVERY_MS, SETTLE_MS, NEW_FILE_MAX, TICK_READ_MAX, LINE_MAX, SUBAGENT_FILES_MAX } from '../lib/card-watch.mjs';
import { parseTranscript } from '../lib/parse-transcript.mjs';
import { CARD_NEAR_MS, CARD_SKEW_MS, threadTimes } from '../lib/approval-wait.mjs';
import { createAnsweredElsewhere } from '../lib/answered-elsewhere.mjs';
import { createChatStore } from '../lib/chat-store.mjs';
import { collectSessions } from '../collectors/sessions.mjs';

const MIN = 60e3;
const LEAD = 'c0ffee00-0000-4000-8000-00000000000a';
const OLD = 'c0ffee00-0000-4000-8000-00000000000b';
const OTHER = 'c0ffee00-0000-4000-8000-00000000000c';
const AG1 = 'a1000000000000001';
const AG2 = 'a2000000000000002';
const USAGE = { input_tokens: 1, output_tokens: 1 };
const iso = t => new Date(t).toISOString();
// The fake clock runs from 10 minutes ago, so every real file write is "since" its times.
const BASE = Math.floor(Date.now() / 1000) * 1000 - 10 * MIN;

// Transcript lines, one block a line, as Claude Code writes them.
const asst = (sid, ts, msg, uses, stop = 'tool_use') => JSON.stringify({ type: 'assistant', timestamp: iso(ts), sessionId: sid, requestId: `req-${msg}`, message: { id: msg, role: 'assistant', stop_reason: uses.length ? stop : 'end_turn', content: uses.length ? uses.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} })) : [{ type: 'text', text: 'ok' }], usage: USAGE } });
const result = (sid, ts, id, { denied = false } = {}) => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denied ? 'Permission for this tool use was denied.' : 'ok', ...(denied ? { is_error: true } : {}) }] } });
const prompt = (sid, ts) => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: sid, message: { role: 'user', content: 'go on' } });
const interrupted = (sid, ts) => JSON.stringify({ type: 'user', timestamp: iso(ts), sessionId: sid, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
const queued = (sid, ts) => JSON.stringify({ type: 'queue-operation', timestamp: iso(ts), sessionId: sid, operation: 'enqueue' });

async function setup({ hello = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'card-watch-'));
  const proj = join(dir, 'p');
  await mkdir(join(proj, LEAD, 'subagents'), { recursive: true });
  const clock = { t: BASE };
  const store = createChatStore({ dir: join(dir, 'chat'), now: () => clock.t });
  await store.load();
  store.setPermissionHold(12 * 3600e3 + 3 * MIN);
  if (hello) store.newPermissionSession();
  const cache = new Map();
  const s = { dir, proj, clock, store, cache, logs: [], leadIds: [LEAD], leads: [] };
  s.ae = createAnsweredElsewhere({ store, isLeadSession: id => s.leadIds.includes(id), now: () => clock.t, log: l => s.logs.push(l) });
  // The watch's file calls, counted: opens, lstats, listings and the bytes read.
  s.counts = { open: 0, lstat: 0, readdir: 0, bytes: 0 };
  const fs = {
    open: async (p, flags) => {
      s.counts.open++;
      const fh = await open(p, flags);
      return { stat: () => fh.stat(), read: async (...a) => { const r = await fh.read(...a); s.counts.bytes += r.bytesRead; return r; }, close: () => fh.close() };
    },
    lstat: p => { s.counts.lstat++; return lstat(p); },
    readdir: p => { s.counts.readdir++; return readdir(p); }
  };
  s.watch = createCardWatch({ store, leads: () => s.leads, seedFor: p => seedOf(cache.get(p)), known: p => cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => clock.t, log: l => s.logs.push(l), fs });
  s.main = (sid = LEAD) => join(proj, `${sid}.jsonl`);
  s.sub = (id, sid = LEAD) => join(proj, sid, 'subagents', `agent-${id}.jsonl`);
  s.write = (path, ...lines) => appendFile(path, lines.map(l => `${l}\n`).join(''));
  // The sessions pass: the real collector over the folder, its cache, the lead's files.
  s.pass = async () => { await collectSessions({ roots: [{ root: proj, surface: 'Code' }], cache }); s.leads = leadFiles(cache, s.leadIds); };
  // The same, with answered-elsewhere's part of it, as server.mjs runs it.
  s.fullPass = async () => {
    const r = await collectSessions({ roots: [{ root: proj, surface: 'Code' }], cache });
    s.leads = leadFiles(cache, s.leadIds);
    return s.ae.pass({ threads: threadTimes(r.transcripts), sessions: s.leadIds, readAt: clock.t, written: new Map(s.leads.map(l => [l.sessionId, l.writtenAt])) });
  };
  s.card = (requestId, tool = 'Bash') => store.openPermission({ requestId, tool, description: 'd', inputPreview: '{}', relayedAt: clock.t });
  s.state = id => store.permission(id).state;
  s.tick = () => s.watch.tick();
  // Past the card's window and the settle time: a card relayed at `at` can be judged.
  s.judgeable = at => { clock.t = Math.max(clock.t, at + CARD_SKEW_MS + SETTLE_MS); };
  s.clean = () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  // A lead session with some history, read by a pass, then a minute on.
  s.begin = async () => {
    await s.write(s.main(), prompt(LEAD, BASE + 1e3), asst(LEAD, BASE + 2e3, 'm0', []));
    await s.pass();
    clock.t = BASE + MIN;
  };
  return s;
}

test('the constants', () => {
  assert.equal(WATCH_EVERY_MS, 2e3, 'within a few seconds');
  assert.equal(SETTLE_MS, 2e3);
  assert.equal(NEW_FILE_MAX, 8 * 1024 * 1024);
  assert.equal(TICK_READ_MAX, 32 * 1024 * 1024);
  assert.equal(LINE_MAX, 64 * 1024 * 1024);
  assert.equal(SUBAGENT_FILES_MAX, 500);
});

test('the lead\'s own card closes at the first watch after its call\'s result, and not before', async () => {
  const s = await setup();
  try {
    await s.begin();
    // After the pass: his Bash, then its card 2 s later (hooks, the classifier, the prompt).
    const useAt = s.clock.t;
    await s.write(s.main(), prompt(LEAD, useAt - 3e3), asst(LEAD, useAt, 'm1', [['u1', 'Bash']]));
    s.clock.t += 2e3;
    const relayedAt = s.clock.t;
    await s.card('owncd');
    s.clock.t += 2e3;
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'));
    assert.equal(await s.tick(), 0, 'the window and the settle time not over: not judged, even with the result in');
    s.judgeable(relayedAt);
    s.clock.t -= 1;
    assert.equal(await s.tick(), 0, 'one ms short');
    s.clock.t += 1;
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('owncd'), 'elsewhere');
    assert.equal(s.store.permission('owncd').closedBy, 'its own thread');
    assert.match(s.logs.at(-1), /^chat: 1 permission card closed, answered somewhere else or no longer asked \(its thread's transcript shows the call answered\): owncd$/);
    assert.equal(await s.tick(), 0);
    assert.equal(s.watch.size(), 0, 'no card open: every file forgotten');
  } finally { await s.clean(); }
});

test('a card waiting at its prompt stays open however long, and closes within one watch of the answer', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('waitd');
    s.judgeable(relayedAt);
    for (let i = 0; i < 30; i++) {
      // The session only queues the messages it gets while blocked.
      if (i % 5 === 0) await s.write(s.main(), queued(LEAD, s.clock.t));
      assert.equal(await s.tick(), 0);
      s.clock.t += WATCH_EVERY_MS;
    }
    // A pass in between changes nothing.
    await s.pass();
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('waitd'), 'open');
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('waitd'), 'elsewhere');
  } finally { await s.clean(); }
});

test('the same tool on two threads: the lead\'s own Bash finishing never closes the card a subagent\'s Bash waits on', async () => {
  const s = await setup();
  try {
    await s.begin();
    const t = s.clock.t;
    // The subagent's Bash at t (it waits at its prompt), the lead's own at t + 2 s (no prompt).
    await s.write(s.sub(AG1), prompt(LEAD, t - 1e3), asst(LEAD, t, 'a1', [['s1', 'Bash']]));
    await s.write(s.main(), asst(LEAD, t + 2e3, 'm1', [['l1', 'Bash']]));
    s.clock.t = t + 3e3;
    const relayedAt = s.clock.t;
    await s.card('subcd');
    // His finishes; he goes on, with another Bash after the card's window and its result.
    await s.write(s.main(), result(LEAD, t + 4e3, 'l1'), asst(LEAD, t + 5e3, 'm2', [['l2', 'Bash']]), result(LEAD, t + 30e3, 'l2'), asst(LEAD, t + 31e3, 'm3', []));
    s.judgeable(relayedAt);
    for (let i = 0; i < 5; i++) { assert.equal(await s.tick(), 0); s.clock.t += WATCH_EVERY_MS; }
    assert.equal(s.state('subcd'), 'open');
    // A second subagent calls Bash just after the card (in the window) and finishes.
    await s.write(s.sub(AG2), asst(LEAD, relayedAt + 1e3, 'b1', [['t1', 'Bash']]), result(LEAD, relayedAt + 2e3, 't1'));
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('subcd'), 'open');
    // The subagent's own answer.
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1'));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('subcd'), 'elsewhere');
  } finally { await s.clean(); }
});

test('board 48308589 H1, Ultron\'s repro: two Bash calls in one response, the first answered after 5 minutes, the second\'s card relayed then; the lead\'s own Bash, finished, closes nothing', async () => {
  const s = await setup();
  try {
    await s.begin();
    const t0 = s.clock.t;
    // The subagent's response: two Bash calls at t0 (one line each, one message id).
    await s.write(s.sub(AG1), prompt(LEAD, t0 - 1e3), asst(LEAD, t0, 'a1', [['s1', 'Bash']]), asst(LEAD, t0, 'a1', [['s2', 'Bash']]));
    await s.pass();
    // The lead's own Bash at t0 + 250 s, finished; the first call answered at t0 + 300 s;
    // the second's prompt opens then, and its card is relayed at t0 + 301 s.
    await s.write(s.main(), asst(LEAD, t0 + 250e3, 'm1', [['l1', 'Bash']]), result(LEAD, t0 + 255e3, 'l1'), asst(LEAD, t0 + 256e3, 'm2', []));
    await s.write(s.sub(AG1), result(LEAD, t0 + 300e3, 's1'));
    s.clock.t = t0 + 301e3;
    const relayedAt = s.clock.t;
    await s.card('h1rep');
    s.judgeable(relayedAt);
    for (let i = 0; i < 5; i++) { assert.equal(await s.tick(), 0, `watch ${i}`); s.clock.t += WATCH_EVERY_MS; }
    // The minute pass and the lead's turn keep it too (board 7d284b3a).
    assert.equal(await s.fullPass(), 0);
    assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 0);
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('h1rep'), 'open');
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's2'));
    // Answered. Its call is older than the card's window, so the watch, which counts only
    // answered calls written in the window, has no word; no other call of the tool was
    // answered after the card. The next minute pass sees its thread past it.
    assert.equal(await s.tick(), 0);
    assert.equal(await s.fullPass(), 1);
    assert.equal(s.state('h1rep'), 'elsewhere');
  } finally { await s.clean(); }
});

test('board 48308589 H1: a card relayed 3 or 5 minutes after its call stays open until its own call is answered, whatever other threads\' Bash do in its window', async () => {
  for (const late of [3 * MIN, 5 * MIN]) {
    for (const seeded of [true, false]) {
      const s = await setup();
      try {
        await s.begin();
        const t0 = s.clock.t;
        await s.write(s.sub(AG1), prompt(LEAD, t0 - 1e3), asst(LEAD, t0, 'a1', [['s1', 'Bash']]), asst(LEAD, t0, 'a1', [['s2', 'Bash']]));
        if (seeded) await s.pass();
        const relayedAt = t0 + late;
        // The first call runs `late` and is answered a second before the card.
        await s.write(s.sub(AG1), result(LEAD, relayedAt - 1e3, 's1'));
        // The lead's own Bash in the window, finished before the card.
        await s.write(s.main(), asst(LEAD, relayedAt - 50e3, 'm1', [['l1', 'Bash']]), result(LEAD, relayedAt - 40e3, 'l1'));
        s.clock.t = relayedAt;
        await s.card('latec');
        // Another subagent's Bash just after the card, answered after it: one answered
        // call of the tool in the window.
        await s.write(s.sub(AG2), prompt(LEAD, relayedAt), asst(LEAD, relayedAt + 1e3, 'b1', [['t1', 'Bash']]), result(LEAD, relayedAt + 2e3, 't1'));
        s.judgeable(relayedAt);
        const tag = `${late / MIN} min late, ${seeded ? 'seeded' : 'read from its start'}`;
        for (let i = 0; i < 10; i++) { assert.equal(await s.tick(), 0, `${tag}: watch ${i}`); s.clock.t += WATCH_EVERY_MS; }
        assert.equal(await s.fullPass(), 0, `${tag}: the pass`);
        assert.equal(s.ae.note({ event: 'UserPromptSubmit', sessionId: LEAD, at: s.clock.t }), 0, `${tag}: his next prompt`);
        assert.equal(s.ae.note({ event: 'Stop', sessionId: LEAD, at: s.clock.t }), 0, `${tag}: his Stop`);
        s.clock.t += MIN;
        assert.equal(await s.fullPass(), 0);
        assert.equal(await s.tick(), 0);
        assert.equal(s.state('latec'), 'open', tag);
        await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's2'));
        assert.equal(await s.tick(), 1, `${tag}: its own call answered`);
        assert.equal(s.state('latec'), 'elsewhere');
      } finally { await s.clean(); }
    }
  }
});

test('board 48308589 H1: a quiet thread (its open call written long before the card, nothing since) is still visited, seeded or read from its start, and its call holds the card', async () => {
  for (const seeded of [true, false]) {
    const s = await setup();
    try {
      await s.begin();
      const t0 = s.clock.t;
      await s.write(s.sub(AG1), prompt(LEAD, t0 - 1e3), asst(LEAD, t0, 'a1', [['s1', 'Bash']]));
      // Quiet since t0: its last write is before the card's window.
      await utimes(s.sub(AG1), new Date(t0), new Date(t0));
      if (seeded) await s.pass();
      const relayedAt = t0 + 3 * MIN;
      s.clock.t = relayedAt;
      await s.card('quiet');
      // The lead's own Bash just before the card, answered after it.
      await s.write(s.main(), asst(LEAD, relayedAt - 1e3, 'm1', [['l1', 'Bash']]), result(LEAD, relayedAt + 1e3, 'l1'));
      s.judgeable(relayedAt);
      const before = s.counts.open;
      for (let i = 0; i < 3; i++) assert.equal(await s.tick(), 0, `${seeded ? 'seeded' : 'unseeded'}: watch ${i}`);
      // Seeded and quiet: no byte of it read.
      if (seeded) assert.equal(s.counts.open - before, 1, 'only the lead\'s file opened');
      assert.equal(s.state('quiet'), 'open');
      await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1'));
      assert.equal(await s.tick(), 1);
    } finally { await s.clean(); }
  }
});

test('board 48308589 H1: a call answered before the card was relayed can\'t be its answer', async () => {
  const s = await setup();
  try {
    await s.begin();
    // The lead's Bash 10 s before the card, answered 5 s before it: the card's own call is
    // somewhere the watch can't see (a session of someone else's), so no word.
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 5e3, 'u1'));
    s.clock.t += 10e3;
    const relayedAt = s.clock.t;
    await s.card('befor');
    s.judgeable(relayedAt);
    for (let i = 0; i < 3; i++) { assert.equal(await s.tick(), 0); s.clock.t += WATCH_EVERY_MS; }
    assert.equal(s.state('befor'), 'open');
    // Answered at the relay's very ms: not after it, so not counted.
    await s.write(s.main(), asst(LEAD, relayedAt, 'm2', [['u2', 'Bash']]), result(LEAD, relayedAt, 'u2'));
    assert.equal(await s.tick(), 0);
    // One ms after: counted.
    await s.write(s.main(), asst(LEAD, relayedAt + 1, 'm3', [['u3', 'Bash']]), result(LEAD, relayedAt + 1, 'u3'));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('board 8d73e1dd L3: the read budget is per tick, over every file; a file past it is behind and holds the cards', async () => {
  const s = await setup();
  try {
    await s.begin();
    let bytes = 0;
    const perTick = [];
    const countFs = { open: async (p, f) => { const fh = await open(p, f); return { stat: () => fh.stat(), read: async (...a) => { const r = await fh.read(...a); bytes += r.bytesRead; return r; }, close: () => fh.close() }; }, lstat, readdir };
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), readMax: 1500, fs: countFs });
    const t = s.clock.t;
    // Two new subagents, each about 1,000 bytes: a Bash call, queued lines, its result after the card.
    for (const [ag, id] of [[AG1, 's1'], [AG2, 's2']]) await s.write(s.sub(ag), asst(LEAD, t, `a-${id}`, [[id, 'Bash']]), ...Array.from({ length: 4 }, () => queued(LEAD, t)));
    s.clock.t += 1e3;
    await s.card('budgt');
    for (const [ag, id] of [[AG1, 's1'], [AG2, 's2']]) await s.write(s.sub(ag), result(LEAD, s.clock.t + 500, id));
    const size = (await stat(s.sub(AG1))).size + (await stat(s.sub(AG2))).size;
    assert.ok(size > 1500 && size < 3000, `${size} bytes`);
    s.judgeable(s.clock.t);
    let closed = 0, ticks = 0;
    while (closed === 0 && ticks < 5) { const b = bytes; closed = await s.tick(); perTick.push(bytes - b); ticks++; }
    assert.equal(closed, 1);
    assert.equal(ticks, 2, 'held while one file was behind, closed once both were read');
    assert.ok(perTick.every(b => b <= 1500), `bytes a tick: ${perTick}`);
    assert.equal(bytes, size, 'every byte read once');
  } finally { await s.clean(); }
});

test('a subagent waits while the lead moves on: his new turns, his end of turn and his own interruption leave its card open', async () => {
  const s = await setup();
  try {
    await s.write(s.sub(AG1), prompt(LEAD, BASE + 1e3));
    await s.begin();
    const t = s.clock.t;
    await s.write(s.sub(AG1), asst(LEAD, t, 'a1', [['e1', 'Edit']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('editc', 'Edit');
    await s.write(s.main(), prompt(LEAD, t + 10e3), asst(LEAD, t + 11e3, 'm1', [['g1', 'Grep']]), result(LEAD, t + 12e3, 'g1'), asst(LEAD, t + 13e3, 'm2', []));
    await s.write(s.main(), prompt(LEAD, t + 20e3), asst(LEAD, t + 21e3, 'm3', [['x1', 'Edit']]), interrupted(LEAD, t + 22e3));
    s.judgeable(relayedAt);
    s.clock.t = Math.max(s.clock.t, t + 25e3);
    assert.equal(await s.tick(), 0);
    await s.pass();
    s.clock.t += MIN;
    assert.equal(await s.tick(), 0, 'and after a pass, read on from it');
    assert.equal(s.state('editc'), 'open');
    // The subagent goes on: a new response with no result line for its Edit (the next
    // request goes only once every call has its result).
    await s.write(s.sub(AG1), asst(LEAD, s.clock.t, 'a2', []));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('editc'), 'elsewhere');
  } finally { await s.clean(); }
});

test('a denied call closes its card; so does an interruption mark in its own thread', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.sub(AG1), asst(LEAD, s.clock.t, 'a1', [['d1', 'Bash']]));
    await s.write(s.sub(AG2), asst(LEAD, s.clock.t, 'b1', [['w1', 'Write']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('denyc');
    await s.card('stopc', 'Write');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 'd1', { denied: true }));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('denyc'), 'elsewhere');
    // An interruption in another thread (the lead's) says nothing of the subagent's call.
    await s.write(s.main(), interrupted(LEAD, s.clock.t));
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('stopc'), 'open');
    // Esc at its prompt, or TaskStop: its own thread's mark.
    await s.write(s.sub(AG2), interrupted(LEAD, s.clock.t));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('stopc'), 'elsewhere');
  } finally { await s.clean(); }
});

test('a parallel call of the same tool in the same thread still open keeps the card', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['p1', 'Bash']]), asst(LEAD, s.clock.t + 1, 'm1', [['p2', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('parac');
    s.judgeable(relayedAt);
    await s.write(s.main(), result(LEAD, s.clock.t, 'p1'));
    assert.equal(await s.tick(), 0);
    await s.write(s.main(), result(LEAD, s.clock.t, 'p2'));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a transcript appended mid-read: a half-written line is held and read whole, after the pass and after the watch', async () => {
  const s = await setup();
  try {
    await s.write(s.main(), prompt(LEAD, BASE + 1e3));
    // The pass reads while the tool use's line is half written.
    s.clock.t = BASE + MIN;
    const use = asst(LEAD, s.clock.t, 'm1', [['h1', 'Bash']]);
    await appendFile(s.main(), use.slice(0, 40));
    await s.pass();
    assert.equal(s.cache.get(s.main()).transcript.endOffset, Buffer.byteLength(`${prompt(LEAD, BASE + 1e3)}\n`), 'the pass ends where its last whole line did');
    await appendFile(s.main(), `${use.slice(40)}\n`);
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('halfc');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0, 'the call is seen, and open');
    // Its result arrives in two writes: the first half is no answer.
    const res = result(LEAD, s.clock.t, 'h1');
    await appendFile(s.main(), res.slice(0, 30));
    assert.equal(await s.tick(), 0);
    await appendFile(s.main(), res.slice(30, 60));
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('halfc'), 'open');
    await appendFile(s.main(), `${res.slice(60)}\n`);
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a card answered before its window ends is judged once the window and the settle time are over', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['f1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('fastc');
    await s.write(s.main(), result(LEAD, s.clock.t + 500, 'f1'));
    for (const dt of [500, 2e3, 4e3, 6e3]) { s.clock.t = relayedAt + dt; assert.equal(await s.tick(), 0, `at +${dt} ms`); }
    s.clock.t = relayedAt + CARD_SKEW_MS + SETTLE_MS;
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('no call of the card\'s tool in its window, or one only in another session: no word, the pass decides', async () => {
  const s = await setup();
  try {
    await s.write(s.main(OTHER), prompt(OTHER, BASE + 1e3));
    await s.begin();
    // Another session (not the lead's) has a Bash in the window, done.
    await s.write(s.main(OTHER), asst(OTHER, s.clock.t, 'o1', [['q1', 'Bash']]), result(OTHER, s.clock.t + 1e3, 'q1'));
    // The lead's own Bash, done, but before the window.
    await s.write(s.main(), asst(LEAD, s.clock.t - CARD_NEAR_MS - 1, 'm1', [['z1', 'Bash']]), result(LEAD, s.clock.t - CARD_NEAR_MS, 'z1'));
    await s.pass();
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('nonec');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    s.clock.t += MIN;
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('nonec'), 'open');
  } finally { await s.clean(); }
});

test('no hello from the channel yet, or a card from before it: not judged', async () => {
  const s = await setup({ hello: false });
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 2e3, 'u1'));
    s.clock.t += 1e3;
    await s.card('hello');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 0);
    assert.equal(s.counts.lstat + s.counts.open + s.counts.readdir, 0, 'nothing read');
    // A hello after the card was relayed: the card is an older process's.
    s.store.newPermissionSession();
    assert.equal(s.state('hello'), 'expired', 'the store ends it with its channel');
  } finally { await s.clean(); }
});

test('the lead restarted: an older session of his that wrote nothing since the hello is not read, so the call it left open holds nothing', async () => {
  const s = await setup();
  try {
    s.leadIds = [OLD];
    // The old process: a Bash it left open when it ended (and a subagent's), its files last
    // written before the hello. Read, they would hold every Bash card for good.
    const helloAt = s.store.permissionSessionAt;
    const relayedAt = helloAt + 30e3;
    await mkdir(join(s.proj, OLD, 'subagents'), { recursive: true });
    await s.write(s.main(OLD), asst(OLD, relayedAt - 40e3, 'o1', [['k1', 'Bash']]), result(OLD, relayedAt - 35e3, 'k1'), asst(OLD, relayedAt - 34e3, 'o2', [['k2', 'Bash']]));
    await s.write(s.sub(AG2, OLD), asst(OLD, relayedAt - 34e3, 'q1', [['k3', 'Bash']]));
    await utimes(s.main(OLD), new Date(helloAt - 1e3), new Date(helloAt - 1e3));
    await utimes(s.sub(AG2, OLD), new Date(helloAt - 2e3), new Date(helloAt - 2e3));
    // The new process's session: read by the pass, but not named the lead's yet.
    await s.write(s.main(), prompt(LEAD, helloAt + 1e3), asst(LEAD, relayedAt - 2e3, 'm1', [['u1', 'Bash']]));
    await s.pass();
    s.clock.t = relayedAt;
    await s.card('restc');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('restc'), 'open');
    // Named at the next pass: its open Bash holds the card; its result closes it.
    s.leadIds = [OLD, LEAD];
    await s.pass();
    assert.equal(s.leads.find(l => l.sessionId === OLD).writtenAt, helloAt - 1e3, 'the old session last wrote before the hello');
    assert.equal(await s.tick(), 0);
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a lead session whose own file wrote nothing since the hello but whose subagent did is current: its subagent\'s open call holds the card', async () => {
  const s = await setup();
  try {
    const helloAt = s.store.permissionSessionAt;
    await s.write(s.main(), prompt(LEAD, BASE + 1e3), asst(LEAD, BASE + 2e3, 'm0', [['t0', 'Task']]));
    await s.write(s.sub(AG1), prompt(LEAD, BASE + 3e3), asst(LEAD, BASE + MIN, 'a1', [['s1', 'Bash']]));
    // His own file last written just before the hello (a channel that said hello again
    // while his turn waited on the subagent); the subagent's since.
    await utimes(s.main(), new Date(helloAt - 1e3), new Date(helloAt - 1e3));
    await s.pass();
    assert.ok(s.leads[0].writtenAt >= helloAt);
    s.clock.t = BASE + MIN + 1e3;
    const relayedAt = s.clock.t;
    await s.card('subcu');
    // Another of his threads answers a Bash in the window, after the card: a new subagent.
    await s.write(s.sub(AG2), asst(LEAD, relayedAt + 1e3, 'b1', [['t1', 'Bash']]), result(LEAD, relayedAt + 2e3, 't1'));
    await utimes(s.main(), new Date(helloAt - 1e3), new Date(helloAt - 1e3));
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0, 'the subagent\'s Bash is open');
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1'));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a call of the card\'s tool written after its window doesn\'t hold it: answered, then the next Bash runs long', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('nextb');
    s.clock.t += 10e3;
    // Allowed in the terminal; it runs and ends; his next Bash starts and runs on.
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'), asst(LEAD, s.clock.t + 1e3, 'm2', [['u2', 'Bash']]));
    s.judgeable(relayedAt);
    assert.ok(s.clock.t + 1e3 > relayedAt + CARD_SKEW_MS);
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('nextb'), 'elsewhere');
  } finally { await s.clean(); }
});

test('a session the pass has not read, written since the hello, holds every card', async () => {
  const s = await setup();
  try {
    await s.begin();
    // The lead's known session has a Bash in the window, finished; a new session (the
    // pass has not read it) has an open one: the card may be that one's.
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 2500, 'u1'));
    await s.write(s.main(OTHER), prompt(OTHER, s.clock.t), asst(OTHER, s.clock.t + 1e3, 'n1', [['n1u', 'Bash']]));
    s.clock.t += 2e3;
    const relayedAt = s.clock.t;
    await s.card('newsc');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    assert.match(s.logs.join('\n'), /card-watch: a session the sessions pass has not read yet wrote since the channel's hello; open cards wait for that pass/);
    // An unknown file last written before the hello (an older process's) holds nothing,
    // even inside the card's window.
    const helloAt = s.store.permissionSessionAt;
    assert.ok(relayedAt - CARD_NEAR_MS < helloAt - 5e3);
    await utimes(s.main(OTHER), new Date(helloAt - 5e3), new Date(helloAt - 5e3));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a new subagent the pass has not read is read from its start; one too big to be is held for the pass', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.sub(AG1), prompt(LEAD, s.clock.t - 5e3), asst(LEAD, s.clock.t, 'a1', [['s1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('newag');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1'));
    assert.equal(await s.tick(), 1);
    // A big one: over NEW_FILE_MAX before any pass read it.
    await s.write(s.sub(AG2), prompt(LEAD, s.clock.t), JSON.stringify({ type: 'user', timestamp: iso(s.clock.t), message: { role: 'user', content: 'x'.repeat(NEW_FILE_MAX) } }), asst(LEAD, s.clock.t + 1e3, 'b1', [['b1u', 'Bash']]));
    s.clock.t += 3e3;
    const relayedAt2 = s.clock.t;
    await s.card('bigag');
    s.judgeable(relayedAt2);
    // A call of the card's tool elsewhere, answered after the card: the big file still holds it.
    await s.write(s.main(), asst(LEAD, relayedAt2 + 1e3, 'm9', [['m9u', 'Bash']]), result(LEAD, relayedAt2 + 2e3, 'm9u'));
    assert.equal(await s.tick(), 0, 'held: what it holds is not known');
    assert.match(s.logs.join('\n'), /card-watch: a transcript of the lead's has no place to read on from \(not read by the last sessions pass, and over 8 MiB\); open cards wait for that pass/);
    await s.pass();
    assert.equal(await s.tick(), 0, 'the pass read it: its call is open');
    await s.write(s.sub(AG2), result(LEAD, s.clock.t, 'b1u'));
    assert.equal(await s.tick(), 1, 'and answered');
  } finally { await s.clean(); }
});

test('cost: nothing is read while no card is open; with one, only the bytes written since the pass, and nothing again until more come', async () => {
  const s = await setup();
  try {
    await s.write(s.main(), prompt(LEAD, BASE + 1e3), JSON.stringify({ type: 'user', timestamp: iso(BASE + 2e3), message: { role: 'user', content: 'y'.repeat(2e6) } }));
    // A subagent the pass read, quiet since well before any card's window (its last call
    // answered): one lstat a tick, never opened.
    await s.write(s.sub(AG2), prompt(LEAD, BASE), asst(LEAD, BASE + 1e3, 'b1', [['b1u', 'Bash']]), result(LEAD, BASE + 2e3, 'b1u'), asst(LEAD, BASE + 3e3, 'b2', []), JSON.stringify({ type: 'user', timestamp: iso(BASE + 2e3), message: { role: 'user', content: 'w'.repeat(1e6) } }));
    await utimes(s.sub(AG2), new Date(BASE - 5 * MIN), new Date(BASE - 5 * MIN));
    await s.pass();
    s.clock.t = BASE + MIN;
    for (let i = 0; i < 5; i++) assert.equal(await s.tick(), 0);
    assert.deepEqual(s.counts, { open: 0, lstat: 0, readdir: 0, bytes: 0 }, 'no card: no file touched');
    const line = `${asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']])}\n`;
    await appendFile(s.main(), line);
    s.clock.t += 1e3;
    await s.card('costc');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 0);
    assert.equal(s.counts.bytes, Buffer.byteLength(line), 'only the new line, not the 2 MB before it');
    const opens = s.counts.open;
    for (let i = 0; i < 3; i++) assert.equal(await s.tick(), 0);
    assert.equal(s.counts.open, opens, 'no new bytes: no file opened');
    assert.equal(s.counts.bytes, Buffer.byteLength(line));
    const res = `${result(LEAD, s.clock.t, 'u1')}\n`;
    await appendFile(s.main(), res);
    assert.equal(await s.tick(), 1);
    assert.equal(s.counts.bytes, Buffer.byteLength(line) + Buffer.byteLength(res));
  } finally { await s.clean(); }
});

test('a file read before and replaced, cut short or gone since holds every card while cards are open: its calls went with it', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    await s.write(s.sub(AG1), prompt(LEAD, s.clock.t));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('replc');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    // Replaced by another file whose bytes say the call was answered: the old file's calls
    // are not known now, so the card waits (the pass and the hooks still close it).
    const text = await readFile(s.main(), 'utf8');
    await writeFile(join(s.proj, 'tmp'), `${text}${result(LEAD, s.clock.t, 'u1')}\n`);
    await rename(join(s.proj, 'tmp'), s.main());
    assert.equal(await s.tick(), 0);
    await s.pass();
    assert.equal(await s.tick(), 0, 'held for as long as cards are open');
    // A card relayed long after the lost file's last write is held too: the lost file could
    // have held an open call of its tool of any age (a late prompt).
    s.clock.t = Date.now() + 5 * MIN;
    await s.write(s.sub(AG1), asst(LEAD, s.clock.t, 'a1', [['w1', 'Write']]));
    s.clock.t += 1e3;
    await s.card('laterc', 'Write');
    await utimes(s.main(), new Date(s.clock.t - 5 * MIN), new Date(s.clock.t - 5 * MIN));
    s.judgeable(s.clock.t);
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 'w1'));
    assert.equal(await s.tick(), 0);
    assert.equal(s.state('replc'), 'open');
    assert.equal(s.state('laterc'), 'open');
    // Once no card is open the loss is forgotten.
    await s.store.answerPermission('replc', 'deny', 'phone');
    await s.store.answerPermission('laterc', 'deny', 'phone');
    assert.equal(await s.tick(), 0);
    await s.write(s.sub(AG1), asst(LEAD, s.clock.t, 'a2', [['w2', 'Write']]));
    s.clock.t += 1e3;
    await s.card('nextw', 'Write');
    s.judgeable(s.clock.t);
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 'w2'));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('nextw'), 'elsewhere');
  } finally { await s.clean(); }
});

test('a thread cut short, or gone, after it was read holds its cards', async () => {
  for (const how of ['cut', 'gone', 'fifo']) {
    const s = await setup();
    try {
      await s.begin();
      await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 1500, 'u1'));
      await s.write(s.sub(AG1), asst(LEAD, s.clock.t, 'a1', [['s1', 'Bash']]));
      s.clock.t += 1e3;
      const relayedAt = s.clock.t;
      await s.card('lostc');
      s.judgeable(relayedAt);
      assert.equal(await s.tick(), 0, 'the subagent\'s call is open');
      if (how === 'cut') { await truncate(s.sub(AG1), 10); await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1')); } else await rm(s.sub(AG1));
      // Listed still, but no regular file: what it held is not known either.
      if (how === 'fifo') execFileSync('/usr/bin/mkfifo', [s.sub(AG1)]);
      assert.equal(await s.tick(), 0, `${how}: its open call is not known now`);
      assert.equal(await s.tick(), 0, `${how}: and still not`);
      // Once no card is open the loss is forgotten: a new card near it is judged.
      await s.store.answerPermission('lostc', 'deny', 'phone');
      assert.equal(await s.tick(), 0);
      await s.write(s.main(), asst(LEAD, s.clock.t, 'm2', [['u2', 'Edit']]), result(LEAD, s.clock.t + 1500, 'u2'));
      s.clock.t += 1e3;
      await s.card('nextc', 'Edit');
      s.judgeable(s.clock.t);
      if (how === 'fifo') {
        // Still no regular file: it holds every card while it is there (Ultron's L2).
        assert.equal(await s.tick(), 0, 'fifo: held while it is there');
        await rm(s.sub(AG1));
      }
      assert.equal(await s.tick(), 1, `${how}: a new episode`);
    } finally { await s.clean(); }
  }
});

test('a seed past the end of a file cut short before the watch began it: the file is read from its start', async () => {
  const s = await setup();
  try {
    await s.begin();
    const lines = [asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 1500, 'u1')];
    await s.write(s.main(), ...lines);
    await s.pass();
    await writeFile(s.main(), lines.map(l => `${l}\n`).join(''));
    assert.ok(s.cache.get(s.main()).transcript.endOffset > (await stat(s.main())).size);
    s.clock.t += 1e3;
    await s.card('shrtc');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a line over the limit holds its file\'s cards until a pass has read past it', async () => {
  const s = await setup();
  try {
    await s.begin();
    let bytes = 0;
    const countFs = { open: async (p, f) => { const fh = await open(p, f); return { stat: () => fh.stat(), read: async (...a) => { const r = await fh.read(...a); bytes += r.bytesRead; return r; }, close: () => fh.close() }; }, lstat, readdir };
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), lineMax: 2000, fs: countFs });
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    // A subagent's call of the tool in the window, answered: only the lead's own holds the card.
    await s.write(s.sub(AG1), asst(LEAD, s.clock.t, 'a1', [['s1', 'Bash']]), result(LEAD, s.clock.t + 1500, 's1'));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('longc');
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0);
    // A pass now ends exactly where the watch will meet the long line.
    await s.pass();
    // What the long line says is not known (it could be the answer, or another call).
    await s.write(s.main(), JSON.stringify({ type: 'user', timestamp: iso(s.clock.t), message: { role: 'user', content: 'z'.repeat(3000) } }));
    assert.equal(await s.tick(), 0, 'held at once: the lead\'s open call went with the dropped file state');
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'));
    const before = bytes;
    assert.equal(await s.tick(), 0, 'held: the file is not read again from the old seed');
    assert.equal(await s.tick(), 0);
    assert.equal(bytes, before, 'nor from its start: nothing read until a pass is past the line');
    // The pass read past it. Its seed no longer lists the lead's call (answered before it),
    // so the only call left in the card's window is the subagent's, answered: it closes,
    // rightly. A call answered after that seed is followed as before.
    await s.pass();
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('longc'), 'elsewhere');
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm2', [['u2', 'Edit']]));
    s.clock.t += 1e3;
    await s.card('longd', 'Edit');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 0);
    await s.write(s.main(), result(LEAD, s.clock.t, 'u2'));
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('longd'), 'elsewhere');
  } finally { await s.clean(); }
});

test('more new bytes than one read takes: the rest is read next time, and its cards wait for it', async () => {
  const s = await setup();
  try {
    await s.begin();
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), readMax: 600 });
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 1500, 'u1'));
    // The subagent's open Bash comes after 2 KB of other lines.
    await s.write(s.sub(AG1), ...Array.from({ length: 10 }, () => queued(LEAD, s.clock.t)), asst(LEAD, s.clock.t + 200, 'a1', [['s1', 'Bash']]));
    s.clock.t += 1e3;
    await s.card('behnd');
    s.judgeable(s.clock.t);
    assert.ok((await stat(s.sub(AG1))).size > 1200);
    for (let i = 0; i < 6; i++) assert.equal(await s.tick(), 0, `read ${i}`);
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1'));
    let closed = 0;
    for (let i = 0; i < 3 && closed === 0; i++) closed = await s.tick();
    assert.equal(closed, 1);
  } finally { await s.clean(); }
});

test('known sessions that are not the lead\'s, and a lead session with no subagents folder, hold nothing', async () => {
  const s = await setup();
  try {
    await rm(join(s.proj, LEAD), { recursive: true });
    await s.write(s.main(OTHER), prompt(OTHER, BASE + 1e3));
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 1500, 'u1'));
    await s.write(s.main(OTHER), asst(OTHER, s.clock.t, 'o1', [['q1', 'Read']]));
    s.clock.t += 1e3;
    await s.card('knwnc');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a FIFO or a symlink named like a transcript is never opened as one, and holds every card while it is there', async () => {
  const s = await setup();
  try {
    await s.begin();
    execFileSync('/usr/bin/mkfifo', [s.sub(AG1)]);
    await writeFile(join(s.dir, 'elsewhere.jsonl'), `${asst(LEAD, s.clock.t, 'z9', [['z9', 'Bash']])}\n${result(LEAD, s.clock.t, 'z9')}\n`);
    await symlink(join(s.dir, 'elsewhere.jsonl'), s.sub(AG2));
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('fifoc');
    s.judgeable(relayedAt);
    const t0 = Date.now();
    assert.equal(await s.tick(), 0);
    assert.ok(Date.now() - t0 < 1000, 'no wait on the FIFO');
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'));
    // There from the start, never read by a pass as one of the lead's transcripts: what it
    // holds is not known (board 8d73e1dd, Ultron's L2).
    assert.equal(await s.tick(), 0, 'held');
    assert.equal(s.logs.filter(l => l === 'card-watch: a transcript of the lead\'s is not a regular file (a symlink or a special file); open cards wait for the sessions pass').length, 2, 'once for each');
    await rm(s.sub(AG1));
    assert.equal(await s.tick(), 0, 'the symlink still holds');
    await rm(s.sub(AG2));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a subagents folder that can\'t be listed, or holds too many, holds every card', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 1500, 'u1'));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('dirsc');
    s.judgeable(relayedAt);
    const real = s.watch;
    // The listing fails (as EACCES would).
    let fail = true;
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), fs: { open, lstat, readdir: async p => { if (fail && p.endsWith('subagents')) throw Object.assign(new Error('no'), { code: 'EACCES' }); return readdir(p); } } });
    assert.equal(await s.tick(), 0);
    assert.match(s.logs.join('\n'), /card-watch: a subagents folder of the lead's could not be listed \(EACCES\)/);
    // Too many subagent files.
    fail = false;
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), fs: { open, lstat, readdir: async p => (p.endsWith('subagents') ? Array.from({ length: SUBAGENT_FILES_MAX + 1 }, (_, i) => `agent-x${i}.jsonl`) : readdir(p)) } });
    assert.equal(await s.tick(), 0);
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), fs: { open, lstat, readdir: async p => (p.endsWith('subagents') ? Array.from({ length: SUBAGENT_FILES_MAX }, (_, i) => `agent-x${i}.jsonl`) : readdir(p)) } });
    assert.equal(await s.tick(), 1, 'at the limit: listed (the names are no files, so nothing)');
    void real;
  } finally { await s.clean(); }
});

test('the lead\'s project folder that can\'t be listed holds every card (a session the pass has not read could be in it)', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('projc');
    await s.write(s.main(), result(LEAD, relayedAt + 500, 'u1'));
    s.judgeable(relayedAt);
    let fail = true;
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), fs: { open, lstat, readdir: async p => { if (fail && p === s.proj) throw Object.assign(new Error('no'), { code: 'EACCES' }); return readdir(p); } } });
    assert.equal(await s.tick(), 0);
    fail = false;
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('his own transcript gone, or made a symlink, after it was read: what it held is not known, so every card waits', async () => {
  for (const how of ['gone', 'symlink']) {
    const s = await setup();
    try {
      await s.begin();
      // The card's call is his own; a subagent's Bash in the window is answered after the card.
      await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
      s.clock.t += 1e3;
      const relayedAt = s.clock.t;
      await s.card('mainl');
      s.judgeable(relayedAt);
      assert.equal(await s.tick(), 0, `${how}: his call is open`);
      await s.write(s.sub(AG1), asst(LEAD, relayedAt + 1e3, 'a1', [['s1', 'Bash']]), result(LEAD, relayedAt + 2e3, 's1'));
      const text = await readFile(s.main(), 'utf8');
      await rm(s.main());
      if (how === 'symlink') { await writeFile(join(s.dir, 'moved.jsonl'), text); await symlink(join(s.dir, 'moved.jsonl'), s.main()); }
      // The last pass still lists it, and its session wrote since the hello.
      assert.equal(await s.tick(), 0, `${how}: held`);
      assert.equal(await s.tick(), 0, `${how}: still held`);
      assert.equal(s.state('mainl'), 'open');
    } finally { await s.clean(); }
  }
});

test('board 8d73e1dd L3: a tick whose bytes are spent before a file with new bytes holds the cards', async () => {
  const s = await setup();
  try {
    await s.begin();
    const t = s.clock.t;
    // The card's call: a new subagent's Bash, open.
    await s.write(s.sub(AG1), asst(LEAD, t, 'a1', [['s1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('spent');
    // His own Bash in the window, answered after the card: his file's new bytes are exactly
    // the tick's budget, and his file is read first.
    const before = (await stat(s.main())).size;
    await s.write(s.main(), asst(LEAD, relayedAt + 1e3, 'm1', [['u1', 'Bash']]), result(LEAD, relayedAt + 2e3, 'u1'));
    const budget = (await stat(s.main())).size - before;
    s.watch = createCardWatch({ store: s.store, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t, log: l => s.logs.push(l), readMax: budget });
    s.judgeable(relayedAt);
    assert.equal(await s.tick(), 0, 'the subagent\'s file not read this tick: held');
    assert.equal(await s.tick(), 0, 'read next tick: its call is open');
    await s.write(s.sub(AG1), result(LEAD, s.clock.t, 's1'));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('a seed the parser cut (more calls open than it keeps) holds the cards until every call is ended', async () => {
  const s = await setup();
  try {
    await s.write(s.main(), prompt(LEAD, BASE + 1e3));
    s.clock.t = BASE + MIN;
    const many = Array.from({ length: 21 }, (_, i) => [`c${i}`, 'Bash']);
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', many));
    await s.pass();
    assert.equal(s.cache.get(s.main()).transcript.openCut, true);
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('cutcd');
    s.judgeable(relayedAt);
    // Every call the seed kept is answered; the one it dropped is not known.
    await s.write(s.main(), ...many.slice(1).map(([id]) => result(LEAD, s.clock.t, id)));
    assert.equal(await s.tick(), 0);
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm2', []));
    assert.equal(await s.tick(), 1, 'a new response: every call ended');
  } finally { await s.clean(); }
});

test('the watch never runs two reads at once, and a failing read says so once and closes nothing', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]), result(LEAD, s.clock.t + 1500, 'u1'));
    s.clock.t += 1e3;
    await s.card('onecd');
    s.judgeable(s.clock.t);
    let leadsCalls = 0;
    const w0 = createCardWatch({ store: s.store, leads: () => { leadsCalls++; return s.leads; }, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t });
    const [a, b] = await Promise.all([w0.tick(), w0.tick()]);
    assert.deepEqual([a, b].sort(), [0, 1]);
    assert.equal(leadsCalls, 1, 'the second waited for nothing: it did not run');
    const logs = [];
    let calls = 0;
    const w = createCardWatch({ store: { closablePermissions: () => [{ requestId: 'x', tool: 'Bash', relayedAt: 1 }], permissionSessionAt: 0 }, leads: () => { calls++; throw Object.assign(new Error('secret words'), { code: 'EBOOM' }); }, now: () => 1e6, log: l => logs.push(l) });
    assert.equal(await w.tick(), 0);
    assert.equal(await w.tick(), 0);
    assert.equal(calls, 2);
    assert.deepEqual(logs, [], 'a leads() that throws is no lead session, not a failure');
    const w2 = createCardWatch({ store: { closablePermissions: () => [{ requestId: 'x', tool: 'Bash', relayedAt: 1 }], permissionSessionAt: 0 }, leads: () => [{ sessionId: LEAD, mains: ['/nowhere/x.jsonl'] }], now: () => 1e6, log: l => logs.push(l), fs: { lstat: async () => { throw new Error('gone'); }, readdir: async () => { throw Object.assign(new Error('secret words'), { code: 'EIO' }); }, open } });
    assert.equal(await w2.tick(), 0);
    assert.equal(logs.length, 0, 'a main that is gone is no current session');
    const w3 = createCardWatch({ store: { closablePermissions: () => [{ requestId: 'x', tool: 'Bash', relayedAt: 1 }], get permissionSessionAt() { throw new Error('secret words'); } }, now: () => 1e6, log: l => logs.push(l) });
    assert.equal(await w3.tick(), 0);
    assert.match(logs.join('\n'), /^card-watch: a read failed \(Error\); open cards wait for the sessions pass$/);
    assert.ok(!logs.join('\n').includes('secret'), 'never the error\'s words');
    await w3.tick();
    assert.equal(logs.length, 1, 'once');
  } finally { await s.clean(); }
});

test('start and stop: one timer, unref\'d, every WATCH_EVERY_MS', async () => {
  let n = 0;
  const w = createCardWatch({ store: { get closablePermissions() { n++; return () => []; } }, everyMs: 20 });
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  w.start();
  w.start();
  await new Promise(r => setTimeout(r, 75));
  w.stop();
  const after = n;
  await new Promise(r => setTimeout(r, 50));
  assert.ok(after >= 2 && after <= 4, `ran ${after} times`);
  assert.equal(n, after, 'stopped');
  w.start();
  assert.equal(process.getActiveResourcesInfo().filter(r => r === 'Timeout').length, before, 'an unref\'d timer');
  w.stop();
});

// ---- the pieces ----

test('createThreadUses follows the parser\'s open calls line for line, from the start or from where a parse ended', () => {
  // A small random transcript language: responses with and without ids and times, calls of
  // two tools, results (some for unknown ids), interruptions, typed lines, odd lines.
  // mulberry32: whole numbers all the way (a float LCG loses its low bits and cycles).
  let seed = 7;
  const rnd = n => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) % n; };
  const gen = () => {
    const lines = [];
    let t = 1e12;
    for (let i = 0; i < 30; i++) {
      t += 1000;
      const k = rnd(10);
      const id = `u${rnd(8)}`;
      if (k < 4) {
        const m = rnd(4) === 0 ? undefined : `m${rnd(3)}`;
        lines.push(JSON.stringify({ type: 'assistant', ...(rnd(6) === 0 ? {} : { timestamp: iso(t) }), message: { ...(m ? { id: m } : {}), content: [{ type: 'tool_use', id, name: rnd(2) ? 'Bash' : 'Edit' }] } }));
      } else if (k < 7) lines.push(JSON.stringify({ type: 'user', timestamp: iso(t), message: { content: [{ type: 'tool_result', tool_use_id: id }] } }));
      else if (k === 7) lines.push(JSON.stringify({ type: 'user', ...(rnd(3) === 0 ? {} : { timestamp: iso(t) }), message: { content: rnd(2) ? '[Request interrupted by user]' : [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
      else if (k === 8) lines.push(JSON.stringify({ type: 'user', timestamp: iso(t), message: { content: 'typed' } }));
      else lines.push(rnd(2) ? 'null' : JSON.stringify({ type: 'queue-operation', timestamp: iso(t) }));
    }
    return lines;
  };
  const openOf = uses => ['Bash', 'Edit'].flatMap(name => uses.calls(name, -Infinity, Infinity).filter(u => !u.done).map(u => `${name}@${u.at}`)).sort();
  const parsedOpen = lines => parseTranscript(lines.join('\n'), 'Code').openTools.map(u => `${u.name}@${u.at}`).sort();
  for (let run = 0; run < 400; run++) {
    const lines = gen();
    const all = createThreadUses();
    for (const l of lines) if (mayMatter(l)) all.line(JSON.parse(l));
    assert.deepEqual(openOf(all), parsedOpen(lines), `run ${run}: from the start`);
    const cut = rnd(lines.length);
    const head = parseTranscript(lines.slice(0, cut).join('\n'), 'Code');
    const rest = createThreadUses({ open: head.openTools, response: head.openResponse, cut: head.openCut });
    for (const l of lines.slice(cut)) if (mayMatter(l)) rest.line(JSON.parse(l));
    assert.deepEqual(openOf(rest), parsedOpen(lines), `run ${run}: from line ${cut}`);
  }
});

test('createThreadUses: answered calls are kept for the cards\' windows and bounded; too many open is unsure', () => {
  const u = createThreadUses({ open: [{ id: 'a', name: 'Bash', at: 10 }, { id: 'b', name: 'x'.repeat(300), at: 11 }, { id: 3, name: 'Bash', at: 1 }, null, { id: 'c', name: '', at: 1 }, { id: 'd', name: 'Bash', at: Number.NaN }] });
  assert.equal(u.size, 2, 'odd seed entries left out');
  assert.deepEqual(u.calls('Bash', 0, 100), [{ at: 10, done: false, doneAt: NaN }]);
  assert.equal(u.calls('x'.repeat(200), 0, 100).length, 1, 'a long name cut as the parser cuts it');
  assert.deepEqual(u.calls('Bash', 11, 100), [], 'the window\'s ends');
  assert.deepEqual(u.calls('Bash', 0, 9), []);
  assert.equal(u.calls('Bash', 10, 10).length, 1, 'both ends in');
  u.line({ type: 'user', timestamp: iso(20), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } });
  assert.deepEqual(u.calls('Bash', 0, 100), [{ at: 10, done: true, doneAt: 20 }], 'answered, at its result line\'s time');
  // A second result, a new response or an interruption later leaves when it was answered.
  u.line({ type: 'user', timestamp: iso(25), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } });
  assert.deepEqual(u.calls('Bash', 0, 100), [{ at: 10, done: true, doneAt: 20 }]);
  u.prune(10);
  assert.equal(u.calls('Bash', 0, 100).length, 1, 'kept from its window\'s start');
  u.prune(11);
  assert.equal(u.calls('Bash', 0, 100).length, 0, 'an answered call before every window goes');
  assert.equal(u.size, 1, 'an open one is never pruned');
  const many = createThreadUses();
  many.line({ type: 'assistant', timestamp: iso(1), message: { id: 'm', content: Array.from({ length: 250 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash' })) } });
  assert.equal(many.unsure, true);
  many.line({ type: 'user', timestamp: iso(2), message: { content: Array.from({ length: 250 }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}` })) } });
  assert.equal(many.unsure, true, 'still unsure until every call is ended at once');
  many.line({ type: 'assistant', timestamp: iso(3), message: { id: 'n', content: [] } });
  assert.equal(many.unsure, false);
  many.prune(0);
  assert.equal(many.size, 200, 'answered calls bounded, newest kept');
  assert.equal(createThreadUses({ cut: true }).unsure, true);
  // Like the parser: a use with an empty name is none; a long name is cut.
  const odd = createThreadUses();
  odd.line({ type: 'assistant', timestamp: iso(1), message: { id: 'm', content: [{ type: 'tool_use', id: 'e', name: '' }, { type: 'tool_use', id: 'l', name: 'y'.repeat(300) }] } });
  assert.equal(odd.size, 1);
  assert.equal(odd.calls('y'.repeat(200), 0, 9).length, 1);
  // An open call before every window is kept: it may still be some card's.
  const early = createThreadUses({ open: [{ id: 'o', name: 'Bash', at: 5 }] });
  early.prune(10);
  assert.equal(early.size, 1);
});

test('createThreadUses seeded where a pass ended: a parallel call of the same response written after it ends nothing', () => {
  const u = createThreadUses({ open: [{ id: 'u1', name: 'Bash', at: 10 }], response: 'm1' });
  u.line({ type: 'assistant', timestamp: iso(20), message: { id: 'm1', content: [{ type: 'tool_use', id: 'u2', name: 'Read' }] } });
  assert.deepEqual(u.calls('Bash', 0, 100), [{ at: 10, done: false, doneAt: NaN }], 'the same response: still open');
  u.line({ type: 'assistant', timestamp: iso(30), message: { id: 'm2', content: [] } });
  assert.deepEqual(u.calls('Bash', 0, 100), [{ at: 10, done: true, doneAt: 30 }], 'the next response ends it, at its time');
  // An interruption mark ends the open ones at its time; a response line with no time ends
  // them with none (NaN: never counted as answered after a card).
  const v = createThreadUses({ open: [{ id: 'v1', name: 'Bash', at: 10 }], response: 'm1' });
  v.line({ type: 'user', timestamp: iso(40), message: { content: '[Request interrupted by user]' } });
  assert.deepEqual(v.calls('Bash', 0, 100), [{ at: 10, done: true, doneAt: 40 }]);
  const w = createThreadUses({ open: [{ id: 'w1', name: 'Bash', at: 10 }], response: 'm1' });
  w.line({ type: 'assistant', message: { id: 'm2', content: [] } });
  assert.deepEqual(w.calls('Bash', 0, 100), [{ at: 10, done: true, doneAt: NaN }]);
  const x = createThreadUses({ open: [{ id: 'x1', name: 'Bash', at: 10 }] });
  x.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1' }] } });
  assert.deepEqual(x.calls('Bash', 0, 100), [{ at: 10, done: true, doneAt: NaN }], 'a result line with no time');
});

test('mayMatter: every line that can change a call, and not the rest', () => {
  for (const l of [asst(LEAD, 1, 'm', [['u', 'Bash']]), asst(LEAD, 1, 'm', []), result(LEAD, 1, 'u'), interrupted(LEAD, 1), JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } })]) assert.ok(mayMatter(l));
  for (const l of [prompt(LEAD, 1), queued(LEAD, 1), JSON.stringify({ type: 'attachment' }), '']) assert.ok(!mayMatter(l));
});

test('createFileTail: whole lines only, a last line held, a piece at a time, and every way a file can go wrong', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-tail-'));
  try {
    const p = join(dir, 'a.jsonl');
    await writeFile(p, 'one\ntw');
    const ino = (await stat(p)).ino;
    const t = createFileTail({ path: p, ino, chunk: 2 });
    assert.deepEqual(await t.read(), { status: 'ok', lines: ['one'] });
    assert.equal(t.offset, 6, 'what was read, the held part included');
    assert.deepEqual(await t.read(), { status: 'ok', lines: [] });
    await appendFile(p, 'o\n€uro\n\n');
    assert.deepEqual(await t.read(), { status: 'ok', lines: ['two', '€uro'] }, 'a character split across pieces; an empty line skipped');
    // At most maxBytes a read: the rest next time.
    await appendFile(p, 'aaaa\nbbbb\ncccc\n');
    assert.deepEqual(await t.read(7), { status: 'behind', lines: ['aaaa'] });
    assert.deepEqual(await t.read(), { status: 'ok', lines: ['bbbb', 'cccc'] });
    // From an offset (a seed): the bytes before it are never read.
    const from = createFileTail({ path: p, ino, offset: (await stat(p)).size - 5 });
    assert.deepEqual(await from.read(), { status: 'ok', lines: ['cccc'] });
    // A line over the limit.
    const big = createFileTail({ path: p, ino, lineMax: 3 });
    assert.equal((await big.read()).status, 'broken');
    // Cut short, replaced, gone, a FIFO, a symlink.
    const cut = createFileTail({ path: p, ino, offset: 1e6 });
    assert.equal((await cut.read()).status, 'reset');
    assert.equal((await createFileTail({ path: p, ino: ino + 1 }).read()).status, 'reset');
    assert.equal((await createFileTail({ path: join(dir, 'none'), ino }).read()).status, 'gone');
    execFileSync('/usr/bin/mkfifo', [join(dir, 'f.jsonl')]);
    assert.equal((await createFileTail({ path: join(dir, 'f.jsonl'), ino: (await stat(join(dir, 'f.jsonl'))).ino }).read()).status, 'gone');
    await symlink(p, join(dir, 's.jsonl'));
    assert.equal((await createFileTail({ path: join(dir, 's.jsonl'), ino }).read()).status, 'gone');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('seedOf and leadFiles: from the pass\'s cache, only what can be read on from', () => {
  const t = { sessionId: LEAD, subagent: false, endOffset: 120, openTools: [{ id: 'u', name: 'Bash', at: 1 }], openResponse: 'm', openCut: false };
  assert.deepEqual(seedOf({ ino: 5, oversizedLines: 0, transcript: t }), { ino: 5, offset: 120, open: t.openTools, response: 'm', cut: false });
  assert.equal(seedOf({ ino: 5, oversizedLines: 1, transcript: t }), null, 'a line too long to decode was dropped');
  assert.equal(seedOf({ ino: 5, transcript: t }), null);
  assert.equal(seedOf({ ino: 5, oversizedLines: 0, transcript: { ...t, endOffset: undefined } }), null);
  assert.equal(seedOf({ oversizedLines: 0, transcript: t }), null);
  assert.equal(seedOf(undefined), null);
  assert.equal(seedOf({ ino: 5, oversizedLines: 0, transcript: { ...t, openCut: 'yes' } }).cut, false);
  const cache = new Map([
    ['/p/a.jsonl', { transcript: t }],
    ['/p/b.jsonl', { transcript: { ...t } }],
    ['/p/a/subagents/agent-x.jsonl', { transcript: { ...t, subagent: true } }],
    ['/p/o.jsonl', { transcript: { ...t, sessionId: OTHER } }],
    ['/p/n.jsonl', {}]
  ]);
  assert.deepEqual(leadFiles(cache, [LEAD]), [{ sessionId: LEAD, mains: ['/p/a.jsonl', '/p/b.jsonl'], writtenAt: null }], 'no times: none');
  // When the session last wrote: the newest mtime of any of its files, a subagent's too.
  const timed = new Map([
    ['/p/a.jsonl', { mtimeMs: 50, transcript: t }],
    ['/p/b.jsonl', { mtimeMs: 70, transcript: { ...t } }],
    ['/p/a/subagents/agent-x.jsonl', { mtimeMs: 90, transcript: { ...t, subagent: true } }],
    ['/p/a/subagents/agent-y.jsonl', { mtimeMs: 60, transcript: { ...t, subagent: true } }],
    ['/p/o.jsonl', { mtimeMs: 500, transcript: { ...t, sessionId: OTHER } }],
    ['/p/s/subagents/agent-z.jsonl', { mtimeMs: 400, transcript: { ...t, sessionId: OTHER, subagent: true } }]
  ]);
  assert.deepEqual(leadFiles(timed, [LEAD]), [{ sessionId: LEAD, mains: ['/p/a.jsonl', '/p/b.jsonl'], writtenAt: 90 }]);
  assert.deepEqual(leadFiles(new Map([['/p/a/subagents/agent-x.jsonl', { mtimeMs: 90, transcript: { ...t, subagent: true } }]]), [LEAD]), [], 'a session with no file of his own is none');
  assert.deepEqual(leadFiles(cache, []), []);
  assert.deepEqual(leadFiles(null, [LEAD]), []);
});

test('server.mjs: the watch is made with the chat store, reads on from the pass\'s cache, closes through answered-elsewhere, and starts', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /\nlet leadFilesNow = \[\];\n/);
  assert.ok(src.indexOf('let leadFilesNow = [];') < src.indexOf("registry.register('sessions'"), 'declared before the sessions pass');
  const passSrc = src.slice(src.indexOf("registry.register('sessions'"), src.indexOf('}, 60 * 1000);', src.indexOf("registry.register('sessions'")));
  assert.match(passSrc, /\n {2}leadFilesNow = leadFiles\(transcriptCache, leadSessions\);\n/);
  // The pass is told when each lead session last wrote, from those files, after they are found.
  assert.match(passSrc, /answeredElsewhere\?\.pass\(\{ threads: threadsNow, sessions: leadSessions, stopped: ended, readAt, written: new Map\(leadFilesNow\.map\(s => \[s\.sessionId, s\.writtenAt\]\)\) \}\)/);
  assert.ok(passSrc.indexOf('leadFilesNow = leadFiles(') < passSrc.indexOf('answeredElsewhere?.pass('), 'found before the pass is told');
  assert.match(src, /createCardWatch\(\{\n {4}store: chatStore,\n {4}leads: \(\) => leadFilesNow,\n {4}seedFor: path => seedOf\(transcriptCache\.get\(path\)\),\n {4}known: path => transcriptCache\.has\(path\),\n {4}closeAnswered: ids => answeredElsewhere\.closeAnswered\(ids\)\n {2}\}\)\.start\(\);/);
  assert.ok(src.indexOf('createCardWatch({') > src.indexOf('answeredElsewhere = createAnsweredElsewhere('), 'after answered-elsewhere is made');
});

test('a card relayed before the channel\'s current hello (one that timed out here under an older process) is not judged', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    s.clock.t += 1e3;
    const relayedAt = s.clock.t;
    await s.card('oldpc');
    await s.write(s.main(), result(LEAD, relayedAt + 500, 'u1'));
    s.judgeable(relayedAt);
    const watchWith = helloAt => createCardWatch({ store: { closablePermissions: () => s.store.closablePermissions(), permissionSessionAt: helloAt }, leads: () => s.leads, seedFor: p => seedOf(s.cache.get(p)), known: p => s.cache.has(p), closeAnswered: ids => s.ae.closeAnswered(ids), now: () => s.clock.t });
    assert.equal(await watchWith(relayedAt + 1).tick(), 0);
    assert.equal(await watchWith(relayedAt).tick(), 1, 'relayed at the hello: this process\'s');
  } finally { await s.clean(); }
});

test('a file replaced after the pass, before the watch began it: the old seed is never used on it', async () => {
  const s = await setup();
  try {
    await s.write(s.main(), prompt(LEAD, BASE + 1e3));
    await s.pass();
    s.clock.t = BASE + MIN;
    const oldSize = (await stat(s.main())).size;
    // The new file: an open Bash whose line covers where the old file ended, then another
    // Bash, answered. Read on from the old offset, only the answered one would be seen.
    const t = s.clock.t;
    const open1 = asst(LEAD, t, 'm1', [['x1', 'Bash']]);
    assert.ok(Buffer.byteLength(open1) > oldSize);
    await writeFile(join(s.proj, 'tmp'), [open1, asst(LEAD, t + 1, 'm1', [['y1', 'Bash']]), result(LEAD, t + 2, 'y1')].map(l => `${l}\n`).join(''));
    await rename(join(s.proj, 'tmp'), s.main());
    s.clock.t += 1e3;
    await s.card('replb');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 0, 'read from its start: x1 is open');
    await s.write(s.main(), result(LEAD, s.clock.t, 'x1'));
    assert.equal(await s.tick(), 1);
  } finally { await s.clean(); }
});

test('answered calls before every open card\'s window are let go', async () => {
  const s = await setup();
  try {
    await s.begin();
    await s.write(s.main(), asst(LEAD, s.clock.t, 'm1', [['u1', 'Bash']]));
    s.clock.t += 1e3;
    await s.card('firstc');
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 0);
    assert.equal(s.watch.calls(), 1);
    // A second card 5 minutes on; then the first is answered and closes.
    s.clock.t += 5 * MIN;
    await s.write(s.main(), asst(LEAD, s.clock.t - 3e3, 'm1', [['u2', 'Edit']]));
    await s.card('secnc', 'Edit');
    await s.write(s.main(), result(LEAD, s.clock.t, 'u1'));
    s.judgeable(s.clock.t);
    assert.equal(await s.tick(), 1);
    assert.equal(s.state('firstc'), 'elsewhere');
    assert.equal(await s.tick(), 0);
    assert.equal(s.watch.calls(), 1, 'u1 is outside the open card\'s window now: gone');
  } finally { await s.clean(); }
});
