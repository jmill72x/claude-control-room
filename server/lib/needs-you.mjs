// "Jarvis is waiting on you" (docs/design/2026-11-10-jarvis-os-home.md, §5.2): a
// Claude Code hook posts the hook's JSON to POST /api/ingest/needs-you when a session
// waits for a person (a permission prompt, an idle prompt, a question) and again
// when it moves on. This file holds the pure parts and the in-memory store; the
// route is in routes.mjs. Checked by test/needs-you.test.mjs.
//
// What is kept: the session's id (to clear it later), the kind of wait and when it
// began, and for a permission prompt which thread of the session asked for which tool
// (below). What leaves this server: `who` (a roster name, or nothing), `kind`, `since`
// and a key made from a hash of the id. The hook's message text, the tool's input
// and the transcript path are never read, let alone kept.
//
// Which tool use ends a permission wait (board 9fb32c4d). On 2026-11-12 a wait opened at
// 15:37:37.017 and was cleared at .296 by a PostToolUse from a background subagent of the
// same session (subagents post under their session's id), so the 5-minute alert never
// fired for a prompt that then waited 17 minutes. The exact match would be the tool use's
// id, but Claude Code gives none to the hooks that see a prompt: `Notification` carries
// only the session, and `PermissionRequest` the tool's name and input and, from a
// subagent, `agent_id` (checked in the 2.1.330 hook schema). So the best match the hooks
// give is the thread (`agent_id`, absent for the session's own thread) and the tool:
//
//   PermissionRequest  notes an "ask": this thread asked for this tool, at `at`.
//   Notification       opens the wait as before (Claude Code sends it a few seconds
//                      after the prompt shows, so the ask is normally noted first).
//   PostToolUse, PostToolUseFailure
//                      answer the oldest ask of the same thread for the same tool whose
//                      tool started (`at` - `duration_ms`) no earlier than the ask: a
//                      call that was already running when the prompt opened is not its
//                      answer. A call of the same thread that started ASK_MOVED_ON_MS or
//                      more after an ask ends that ask too: the thread is past it (a
//                      denied prompt writes no PostToolUse).
//   Stop, UserPromptSubmit
//                      end the session's own thread's asks made before them.
//   SubagentStop       ends that subagent's asks made before it.
//   SessionEnd         ends everything.
//   (a stopped thread) the sessions pass, each minute, ends a subagent's asks made
//                      before its transcript's final answer or interruption mark
//                      (endThreads): TaskStop aborts the run, and in 2.1.330 an aborted
//                      run's query returns without its stop hooks and runAgent then skips
//                      SubagentStop, so no hook says it ended (board 2c49fcfa).
//
// A permission wait ends when the session's last ask is answered or ended. A session with no ask
// known (the hook entries from before this change, which send no tool, or a restart
// between the ask and its Notification) is cleared as before, by any of the clearing
// events. An idle or question wait belongs to the session's own thread, so a
// subagent's tool use leaves it alone.
//
// How long a permission wait lives (board e7427be1, 2026-11-26). A wait with no clear used
// to lapse after NEEDS_YOU_TTL_MS whatever was happening: on 11-26 the lead's own prompt
// (a Bash call) opened at 18:31 and was still unanswered at 20:02, but the wait lapsed at
// 19:01, so Needs you went blank while the lead sat blocked. Now the sessions pass, each
// minute, reads each permission wait's thread in its transcript (confirmWaits): a request
// written after the ask (or, with no ask known, after the wait opened) means the thread
// moved on, and its ask, or the wait, ends; no newer request means it is still held, and a
// held wait lives on past the lapse, up to PERMISSION_MAX_MS, while a pass in the last
// HELD_FRESH_MS saw it held. A wait whose thread's transcript is not read lapses as before.
// The asks and the order times of a session with a live permission wait live as long as it.
import { createHash } from 'node:crypto';

// At most this many open waits; the oldest go first when there are more.
export const NEEDS_YOU_MAX = 20;
// A wait with no clear is dropped after this: a session that was closed with the
// prompt open, or a hook whose clear never came. Asks lapse with it.
export const NEEDS_YOU_TTL_MS = 30 * 60e3;
// A permission wait its transcript shows still held lives at most this long: Claude Code
// holds a prompt with no end, and this bounds memory and a wait nobody can clear. The
// channel's own longest hold (lib/chat-store.mjs, 12 h) is the same.
export const PERMISSION_MAX_MS = 12 * 3600e3;
// A held mark counts for this long: three sessions passes (each minute), so one missed
// pass never drops a wait.
export const HELD_FRESH_MS = 3 * 60e3;
// A wait this old becomes an alert (and, counted, a push).
export const NEEDS_YOU_ALERT_MS = 5 * 60e3;
// At most this many asks a session; the oldest go first.
export const ASKS_MAX = 10;
// A tool use of the same thread that started this long after an ask ends it: the
// thread has moved past the prompt. Long enough that a call started beside the asked one
// (its permission check took longer) is not counted; a denied prompt's thread takes an
// answer and a model turn before its next call.
export const ASK_MOVED_ON_MS = 10e3;

// The hook events that open a wait, by the kind of wait, and the ones that end it.
// A Notification opens one only for the types that mean "someone must answer":
// an `auth_success` or anything new is a no-op, never a wait.
export const WAIT_KINDS = { permission_prompt: 'permission', idle_prompt: 'idle', elicitation_dialog: 'question' };
export const OPENING_EVENTS = new Set(['Notification']);
// Names the tool a thread asks about; opens no wait by itself.
export const ASK_EVENTS = new Set(['PermissionRequest']);
export const CLEARING_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionEnd']);
const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
const THREAD_ENDS = new Set(['Stop', 'UserPromptSubmit']);
// Auto mode's classifier refused a tool call (approvals, decision 3): logged and handed
// to the approvals gate, which makes page cards Deny-only for a while. It opens and
// clears no wait, and decides nothing in Claude Code (the hook runs async).
export const BLOCK_EVENTS = new Set(['PermissionDenied']);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
export const BLOCK_REASON_MAX = 300;
// A tool's name for matching an ask: MCP tools run long (mcp__<plugin>_<server>__<tool>).
const MATCH_TOOL_NAME = /^[A-Za-z0-9_.-]{1,200}$/;

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const WORD = /^[a-z_]{1,40}$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = error => ({ ok: false, error });
const pass = value => ({ ok: true, value });
const given = v => v !== undefined && v !== null;

// At most this many sessions' newest event times (and asks) are kept for ordering,
// each for as long as a wait lives.
export const NEEDS_YOU_SEEN_MAX = 200;

// A subagent's id is kept only as a short hash: it is compared, never shown or logged.
export const agentKey = id => createHash('sha256').update(String(id)).digest('hex').slice(0, 16);

// The hook's JSON, down to the fields read: { event, sessionId, kind, at }, plus
// `agent` (a hash of `agent_id`), `tool` (`tool_name`) and `ms` (`duration_ms`) when the
// body has them in a usable form. `kind` is null for a clear, an ask, and a Notification that opens
// nothing. `at` is when the hook ran (epoch ms, the hook entry's `(now*1000|floor)`), or
// null from an entry that sends none; the hooks run async, so posts can arrive out of
// order.
export function checkNeedsYou(body) {
  if (!isObject(body)) return fail('the body must be the hook\'s JSON object');
  const event = body.hook_event_name;
  if (typeof event !== 'string' || !(OPENING_EVENTS.has(event) || ASK_EVENTS.has(event) || CLEARING_EVENTS.has(event) || BLOCK_EVENTS.has(event))) {
    return fail(`hook_event_name must be one of ${[...OPENING_EVENTS, ...ASK_EVENTS, ...CLEARING_EVENTS, ...BLOCK_EVENTS].join(', ')}`);
  }
  if (typeof body.session_id !== 'string' || !SESSION_ID.test(body.session_id)) return fail('session_id must be an id of at most 80 letters, digits, hyphens and underscores');
  let kind = null;
  if (event === 'Notification') {
    const type = body.notification_type;
    if (type !== undefined && type !== null && (typeof type !== 'string' || !WORD.test(type))) return fail('notification_type must be a word');
    kind = Object.hasOwn(WAIT_KINDS, type ?? '') ? WAIT_KINDS[type] : null;
  }
  const at = body.at ?? null;
  if (at !== null && !(Number.isSafeInteger(at) && at >= 0)) return fail('at must be a time in whole milliseconds since 1970');
  if (BLOCK_EVENTS.has(event)) {
    // The tool's name and the classifier's reason, only as far as the approvals card
    // uses them (lib/approvals.mjs, blockReasonWords); never the tool's input.
    const tool = typeof body.tool_name === 'string' && TOOL_NAME.test(body.tool_name) ? body.tool_name : null;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, BLOCK_REASON_MAX) : null;
    return pass({ event, sessionId: body.session_id, kind: null, at, tool, reason });
  }
  // The three matching fields are optional, and an odd one is read as absent, never a
  // 400 (Ultron's L2): a lost post would lose its clear too, while a post without them
  // falls back to clearing as before. Any non-empty agent id is hashed whatever its form;
  // a tool name is kept when it is a name (long MCP names included).
  const value = { event, sessionId: body.session_id, kind, at };
  if (typeof body.agent_id === 'string' && body.agent_id !== '') value.agent = agentKey(body.agent_id);
  if (typeof body.tool_name === 'string' && MATCH_TOOL_NAME.test(body.tool_name)) value.tool = body.tool_name;
  if (Number.isSafeInteger(body.duration_ms) && body.duration_ms >= 0) value.ms = body.duration_ms;
  return pass(value);
}

const threadOf = value => value?.agent ?? null;
// When the tool of a PostToolUse started running: the hook's time less the run's length
// (which leaves out the prompt). Null when the post doesn't say how long it ran.
const startOf = (value, now) => (Number.isSafeInteger(value.ms) ? (value.at ?? now) - value.ms : null);

// Whether an ask is still kept: under the lapse, or, for a session in `keep` (a Set of the
// sessions with a live permission wait), under PERMISSION_MAX_MS.
const askLives = (a, sid, now, keep) => now - a.receivedAt < (keep instanceof Set && keep.has(sid) ? PERMISSION_MAX_MS : NEEDS_YOU_TTL_MS);

// The asks after one event: `asks` maps a session to its asks, oldest first, each
// { agent, tool, at, receivedAt }. Answers { asks, before, after }: how many asks the
// event's session had before it, and has after it. `keep`: as askLives says.
export function noteAsks(asks, value, now, keep = null) {
  const next = new Map();
  for (const [sid, list] of asks instanceof Map ? asks : []) {
    const kept = (Array.isArray(list) ? list : []).filter(a => isObject(a) && askLives(a, sid, now, keep));
    if (kept.length > 0) next.set(sid, kept);
  }
  const sid = value.sessionId;
  const mine = next.get(sid) ?? [];
  const thread = threadOf(value);
  const when = value.at ?? now;
  let left = mine;
  if (ASK_EVENTS.has(value.event)) {
    left = [...mine, { agent: thread, tool: value.tool ?? null, at: when, receivedAt: now }].slice(-ASKS_MAX);
  } else if (TOOL_EVENTS.has(value.event) && given(value.tool)) {
    const start = startOf(value, now);
    let answered = false;
    left = mine.filter(a => {
      if (a.agent !== thread) return true;
      if (!answered && a.tool === value.tool && (start === null || start >= a.at)) { answered = true; return false; }
      return !(start !== null && start >= a.at + ASK_MOVED_ON_MS);
    });
  } else if (THREAD_ENDS.has(value.event)) {
    left = mine.filter(a => a.agent !== null || a.at > when);
  } else if (value.event === 'SubagentStop' && thread !== null) {
    left = mine.filter(a => a.agent !== thread || a.at > when);
  } else if (value.event === 'SessionEnd') {
    left = [];
  }
  next.delete(sid);
  if (left.length > 0) next.set(sid, left);
  while (next.size > NEEDS_YOU_SEEN_MAX) next.delete(next.keys().next().value);
  return { asks: next, before: mine.length, after: left.length };
}

// The asks after the stopped threads are known: `ended` is live-agents.mjs's
// endedThreads, Map<session id, Map<agent key, stop time>>. An ask of a subagent made at
// or before that thread's stop is over (a resumed thread's new asks come after it), and
// lapsed asks go as in noteAsks. Answers { asks, dropped, emptied }: how many asks of
// stopped threads went, and the sessions left with no ask after losing one that way.
export function dropEndedAsks(asks, ended, now, keep = null) {
  const next = new Map();
  let dropped = 0;
  const emptied = [];
  for (const [sid, list] of asks instanceof Map ? asks : []) {
    const threads = ended instanceof Map ? ended.get(sid) : undefined;
    let mine = 0;
    const kept = (Array.isArray(list) ? list : []).filter(a => {
      if (!isObject(a) || !askLives(a, sid, now, keep)) return false;
      const stop = a.agent !== null && threads instanceof Map ? threads.get(a.agent) : undefined;
      if (Number.isFinite(stop) && a.at <= stop) { mine += 1; return false; }
      return true;
    });
    dropped += mine;
    if (kept.length > 0) next.set(sid, kept);
    else if (mine > 0) emptied.push(sid);
  }
  return { asks: next, dropped, emptied };
}

// Whether a clearing event ends the session's wait `w` (not counting an answered last
// ask, which recordNeedsYou checks first). `ask` is noteAsks' answer for the event.
function endsWait(w, value, ask) {
  if (value.event === 'SessionEnd') return true;
  if (TOOL_EVENTS.has(value.event)) {
    // An entry that names no tool can't be matched: as before the asks.
    if (!given(value.tool)) return true;
    // Idle or a question: the session's own thread is at work again.
    if (w.kind !== 'permission') return threadOf(value) === null;
    // No ask known for this session: as before.
    return ask.before === 0;
  }
  if (THREAD_ENDS.has(value.event)) return w.kind !== 'permission' || ask.after === 0;
  return false;
}

// The list after one event. An opening event with a kind replaces the session's
// wait (its `since` stays when the kind is unchanged: a re-sent prompt is the same
// wait), and a Notification that opens nothing drops it. A clearing event drops it as
// endsWait says, and a permission wait goes once the session's last ask is answered,
// even from a post that arrived out of order (noteAsks compares the times). `ask` is
// noteAsks' answer for this event; `stale` an event older than the newest seen.
export function recordNeedsYou(list, value, now, ask = { before: 0, after: 0 }, stale = false) {
  const active = activeWaits(list, now);
  const wait = active.find(w => w.sessionId === value.sessionId) ?? null;
  const others = active.filter(w => w.sessionId !== value.sessionId);
  if (ASK_EVENTS.has(value.event)) return active;
  if (wait?.kind === 'permission' && ask.before > 0 && ask.after === 0) return others;
  if (stale) return active;
  if (OPENING_EVENTS.has(value.event)) {
    if (value.kind === null) return others;
    // The same wait again keeps its start and its held mark; a new one may take a tool's
    // name from `hint` (the chat's card, for a session whose hooks name no tool).
    const same = wait?.kind === value.kind;
    const w = { sessionId: value.sessionId, kind: value.kind, since: same ? wait.since : now };
    if (same && Number.isFinite(wait.heldAt)) w.heldAt = wait.heldAt;
    const hint = same ? wait.hint : value.hint;
    if (typeof hint === 'string' && hint) w.hint = hint;
    others.push(w);
    others.sort((a, b) => a.since - b.since);
    return others.slice(Math.max(0, others.length - NEEDS_YOU_MAX));
  }
  if (wait === null) return active;
  return endsWait(wait, value, ask) ? others : active;
}

// A wait lives for NEEDS_YOU_TTL_MS, and a permission wait a pass saw held in the last
// HELD_FRESH_MS lives on to PERMISSION_MAX_MS (confirmWaits).
export const isHeld = (w, now) => w.kind === 'permission' && Number.isFinite(w.heldAt) && now - w.heldAt < HELD_FRESH_MS && now - w.since < PERMISSION_MAX_MS;
export const activeWaits = (list, now) =>
  (Array.isArray(list) ? list : []).filter(w => isObject(w) && Number.isFinite(w.since) && (now - w.since < NEEDS_YOU_TTL_MS || isHeld(w, now)));

// The sessions whose asks and order times are kept past the lapse: those with a live
// permission wait.
export const keptSessions = (list, now) => new Set(activeWaits(list, now).filter(w => w.kind === 'permission').map(w => w.sessionId));

// What the transcripts say of each live permission wait (the sessions pass, each minute).
// `threads` is Map<session id, { main, agents }>: `main` the time of the newest request in
// the session's own transcript (undefined when it was not read this pass), `agents` a
// Map<agentKey, newest request time> of its subagents' (lib/approval-wait.mjs,
// threadTimes). An ask whose thread wrote a request after it is over (the prompt was
// answered, somewhere, and the thread went on); a wait with no ask known is judged on the
// session's own thread from when it opened. A wait whose asks all ended goes; one with a
// thread still held is marked held at `now`. Answers { list, asks, ended, held, dropped }.
export function confirmWaits(list, asks, threads, now) {
  const active = activeWaits(list, now);
  const nextAsks = new Map(asks instanceof Map ? asks : []);
  let ended = 0, held = 0, dropped = 0;
  const out = [];
  for (const w of active) {
    const t = w.kind === 'permission' && threads instanceof Map ? threads.get(w.sessionId) : undefined;
    if (!isObject(t)) { out.push(w); continue; }
    const timeOf = agent => (agent === null ? t.main : t.agents instanceof Map ? t.agents.get(agent) : undefined);
    const mine = Array.isArray(nextAsks.get(w.sessionId)) ? nextAsks.get(w.sessionId) : [];
    let still = false, over = false;
    if (mine.length === 0) {
      const last = t.main;
      if (Number.isFinite(last) || last === -Infinity) {
        if (last > w.since) over = true;
        else still = true;
      }
    } else {
      const left = mine.filter(a => {
        const last = timeOf(a.agent ?? null);
        if (!(Number.isFinite(last) || last === -Infinity)) return true;
        if (last > a.at) { dropped++; return false; }
        still = true;
        return true;
      });
      if (left.length === 0) { nextAsks.delete(w.sessionId); over = true; }
      else nextAsks.set(w.sessionId, left);
    }
    if (over) { ended++; continue; }
    if (still) { held++; out.push({ ...w, heldAt: now }); } else out.push(w);
  }
  return { list: out, asks: nextAsks, ended, held, dropped };
}

// The key names the session without saying which: a short hash of its id.
export const waitKey = sessionId => `needs-you:${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12)}`;

// What the page gets: [{ who, kind, since, key }], oldest first. `whoFor` turns a
// session id into a roster name, or null when the session is nobody's on the roster.
// A permission wait also gets `tool` and `run` from `detailFor(wait, asks)` (lib/
// approval-wait.mjs, describeWait): a fixed label for the tool and the roster name of
// the subagent that asked, each null when not known; never an id.
export function needsYouView(list, whoFor, now, detailFor = null, asks = null) {
  return activeWaits(list, now).map(w => {
    let who = null;
    try { who = whoFor?.(w.sessionId) ?? null; } catch { who = null; }
    const out = { who: typeof who === 'string' && who.trim() ? who.trim().slice(0, 40) : null, kind: w.kind, since: w.since, key: waitKey(w.sessionId) };
    if (w.kind === 'permission' && typeof detailFor === 'function') {
      let d = null;
      try { d = detailFor(w, asks instanceof Map ? asks.get(w.sessionId) ?? [] : []); } catch { d = null; }
      out.tool = typeof d?.tool === 'string' ? d.tool : null;
      out.run = typeof d?.run === 'string' ? d.run : null;
    }
    return out;
  });
}

const KIND_WORDS = { permission: 'a permission', idle: 'an answer', question: 'an answer to a question' };
export const waitWords = kind => KIND_WORDS[kind] ?? 'you';

// The alerts: a wait older than five minutes, each keyed on its session's hash.
export function needsYouAlerts(waits, now) {
  const out = [];
  for (const w of Array.isArray(waits) ? waits : []) {
    if (!Number.isFinite(w?.since) || now - w.since < NEEDS_YOU_ALERT_MS) continue;
    out.push({ text: `${w.who ?? 'A session'} is waiting on ${waitWords(w.kind)}`, kind: 'needs-you', key: w.key, since: w.since });
  }
  return out;
}

// Out-of-order posts. `seen` maps a session to the newest `at` taken for it (and
// when that arrived). An event whose `at` is older than that is stale: an async
// "waiting" post landing after the clear that followed it would otherwise leave a
// wait nobody has. An event with no `at` can't be ordered, so it always counts. An ask
// is never stale (it only names a tool; its answer is matched by time). A subagent's
// event is checked but not noted: its thread runs beside the session's own, so its
// newer posts say nothing about the order of the session's prompt and turn.
export const isStaleEvent = (seen, value) =>
  !ASK_EVENTS.has(value.event) && value.at !== null && seen.has(value.sessionId) && value.at < seen.get(value.sessionId).at;

// The map after a taken event: its `at` noted, lapsed entries dropped, the oldest
// going first past NEEDS_YOU_SEEN_MAX.
export function noteSeen(seen, value, now, keep = null) {
  const next = new Map([...seen].filter(([sid, e]) => now - e.receivedAt < (keep instanceof Set && keep.has(sid) ? PERMISSION_MAX_MS : NEEDS_YOU_TTL_MS)));
  if (value.at === null || ASK_EVENTS.has(value.event) || threadOf(value) !== null) return next;
  next.delete(value.sessionId);
  next.set(value.sessionId, { at: value.at, receivedAt: now });
  while (next.size > NEEDS_YOU_SEEN_MAX) next.delete(next.keys().next().value);
  return next;
}

// ---- across a restart (board cf9b6496) ----
//
// A restart of this server forgot every wait: a card opened before it was unknown until its
// session's next hook event, so with the lead blocked on a prompt (which sends none) Needs
// you stayed blank, the reminder never went and the idle wake-up was not held. The chat's
// own cards can't rebuild one: they live in memory too, the message log never says which
// were answered in the terminal or Discord, and no card names its thread. Nor can the
// transcripts alone: a thread stopped at a prompt and one running a long tool look the
// same (a tool use, no result, nothing after it). So the store writes what it knows of the
// permission waits (snapshotOf, data/needs-you.json, 0600; server.mjs writes it on each
// change and each sessions pass), and the next process puts back the waits of one written
// at most SNAPSHOT_FRESH_MS before it started (readSnapshot, restore): an older file means
// the server was down long enough for hook events to be lost. The sessions pass's
// confirmWaits then judges each put-back wait by its transcript in the same pass, as it
// does every minute: a thread that wrote a request after its ask (no ask: after the wait
// opened) is over; one still held lives on.
//
// Kept: each permission wait's session id, start and tool hint, and that session's asks
// (the thread's hash, the tool's name, when). Idle and question waits are not kept: the
// transcripts can't say one is still held, and an idle one is the lead's normal state.
// What the hooks give is unchanged, so this works the same with the 2026-11-12 entries
// (no asks, so a put-back wait is judged on the session's own thread from its start, and
// any tool use in the session clears it, as before) and with NEXT.md §28's.
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FRESH_MS = 3 * 60e3;
// A snapshot may say a time this far after this process started (the old process's clock
// is this machine's; a little slack for the write landing as this one starts).
const SNAPSHOT_SKEW_MS = 5e3;
const AGENT_KEY = /^[0-9a-f]{16}$/;
const HINT = /^[A-Za-z ]{1,20}$/;

// The permission waits and their sessions' asks, as data/needs-you.json holds them.
export function snapshotOf(list, asks, now) {
  const waits = activeWaits(list, now).filter(w => w.kind === 'permission');
  const kept = {};
  for (const w of waits) {
    const mine = asks instanceof Map ? asks.get(w.sessionId) : undefined;
    if (Array.isArray(mine) && mine.length > 0) kept[w.sessionId] = mine.map(a => ({ agent: a.agent ?? null, tool: a.tool ?? null, at: a.at }));
  }
  return {
    version: SNAPSHOT_VERSION,
    at: now,
    waits: waits.map(w => ({ sessionId: w.sessionId, since: w.since, ...(typeof w.hint === 'string' ? { hint: w.hint } : {}) })),
    asks: kept
  };
}

// A snapshot checked whole: { waits, asks } to put back, or null when it is missing, of
// another version, not written within SNAPSHOT_FRESH_MS before `startAt` (or written after
// it), or not in its shape. Each field is checked as a hook's would be; a wait or an ask
// that fails is left out, never the rest.
export function readSnapshot(snap, startAt, now) {
  if (!isObject(snap) || snap.version !== SNAPSHOT_VERSION || !Number.isSafeInteger(snap.at)) return null;
  if (snap.at > startAt + SNAPSHOT_SKEW_MS || startAt - snap.at > SNAPSHOT_FRESH_MS) return null;
  const waits = [];
  const asks = new Map();
  const seenIds = new Set();
  for (const w of Array.isArray(snap.waits) ? snap.waits.slice(0, NEEDS_YOU_MAX) : []) {
    if (!isObject(w) || typeof w.sessionId !== 'string' || !SESSION_ID.test(w.sessionId) || seenIds.has(w.sessionId)) continue;
    if (!Number.isSafeInteger(w.since) || w.since > snap.at || now - w.since >= PERMISSION_MAX_MS) continue;
    seenIds.add(w.sessionId);
    waits.push({ sessionId: w.sessionId, since: w.since, ...(typeof w.hint === 'string' && HINT.test(w.hint) ? { hint: w.hint } : {}) });
    const raw = isObject(snap.asks) && Object.hasOwn(snap.asks, w.sessionId) ? snap.asks[w.sessionId] : null;
    const mine = (Array.isArray(raw) ? raw : []).filter(a => isObject(a)
      && (a.agent === null || (typeof a.agent === 'string' && AGENT_KEY.test(a.agent)))
      && (a.tool === null || (typeof a.tool === 'string' && MATCH_TOOL_NAME.test(a.tool)))
      && Number.isSafeInteger(a.at) && a.at <= snap.at).slice(-ASKS_MAX);
    if (mine.length > 0) asks.set(w.sessionId, mine.map(a => ({ agent: a.agent, tool: a.tool, at: a.at })));
  }
  return { waits, asks };
}

// The store. A restart forgets every wait and ask, but for the permission waits put back
// from a fresh snapshot (restore, above); the next hook event (or the hook's clear) sets
// the rest straight. `record` answers { open, stale }: a stale event changes no wait, but
// its tool use still answers an ask, and when that was the session's last ask the
// permission wait goes and the event is not stale. `onChange()` is called after any change
// to what snapshotOf would write (server.mjs writes the file then).
export function createNeedsYouStore({ whoFor = () => null, detailFor = null, hintFor = null, onChange = null } = {}) {
  let list = [];
  let seen = new Map();
  let asks = new Map();
  const keyOf = snap => { const { at, ...rest } = snap; void at; return JSON.stringify(rest); };
  let lastKey = keyOf(snapshotOf([], new Map(), 0));
  const changed = now => {
    if (typeof onChange !== 'function') return;
    const key = keyOf(snapshotOf(list, asks, now));
    if (key === lastKey) return;
    lastKey = key;
    try { onChange(); } catch { /* the file is written again at the next pass */ }
  };
  return {
    record: (value, now = Date.now()) => {
      const stale = isStaleEvent(seen, value);
      const keep = keptSessions(list, now);
      const ask = noteAsks(asks, value, now, keep);
      asks = ask.asks;
      if (!stale) seen = noteSeen(seen, value, now, keep);
      // A permission wait about to open: the tool's name from the chat's card, when the
      // session's hooks name none (`hintFor`, server.mjs). Only a label leaves here.
      if (value.kind === 'permission' && typeof hintFor === 'function') {
        let hint = null;
        try { hint = hintFor(value.sessionId, now); } catch { hint = null; }
        if (typeof hint === 'string' && hint) value = { ...value, hint };
      }
      const had = activeWaits(list, now).length;
      list = recordNeedsYou(list, value, now, ask, stale);
      changed(now);
      // Stale and still ending a wait (its tool use answered the last ask): not ignored.
      return { open: list.length, stale: stale && list.length === had };
    },
    // The stopped subagent threads, from each sessions pass (live-agents.mjs,
    // endedThreads): their asks go, and a permission wait whose asks were all theirs
    // goes with them, as when its last ask is answered. Answers { dropped, ended, open }:
    // asks dropped, waits ended, waits open.
    endThreads: (ended, now = Date.now()) => {
      const out = dropEndedAsks(asks, ended, now, keptSessions(list, now));
      asks = out.asks;
      const active = activeWaits(list, now);
      const gone = new Set(out.emptied);
      list = active.filter(w => !(w.kind === 'permission' && gone.has(w.sessionId)));
      changed(now);
      return { dropped: out.dropped, ended: active.length - list.length, open: list.length };
    },
    // Each sessions pass (board e7427be1): which permission waits their transcripts show
    // still held, and which moved on (confirmWaits). Answers { ended, held, dropped, open }.
    confirm: (threads, now = Date.now()) => {
      const out = confirmWaits(list, asks, threads, now);
      list = out.list;
      asks = out.asks;
      changed(now);
      return { ended: out.ended, held: out.held, dropped: out.dropped, open: list.length };
    },
    // What data/needs-you.json holds now (snapshotOf).
    snapshot: (now = Date.now()) => snapshotOf(list, asks, now),
    // At start: the permission waits of the last process's snapshot (readSnapshot), each
    // for a session with no wait of its own yet (a hook since this start knows better),
    // marked held at `now` until the transcripts judge it (the sessions pass's confirm,
    // run straight after). Its asks come back with it. Answers { restored, asks }.
    restore: (snap, startAt, now = Date.now()) => {
      const checked = readSnapshot(snap, startAt, now);
      if (checked === null) return { restored: 0, asks: 0 };
      const active = activeWaits(list, now);
      const taken = new Set(active.map(w => w.sessionId));
      let restored = 0, n = 0;
      for (const w of checked.waits) {
        if (taken.has(w.sessionId)) continue;
        taken.add(w.sessionId);
        active.push({ sessionId: w.sessionId, kind: 'permission', since: w.since, heldAt: now, ...(w.hint ? { hint: w.hint } : {}) });
        restored++;
        const mine = checked.asks.get(w.sessionId);
        if (mine && !asks.has(w.sessionId)) {
          asks.set(w.sessionId, mine.map(a => ({ ...a, receivedAt: now })));
          n += mine.length;
        }
      }
      active.sort((a, b) => a.since - b.since);
      list = active.slice(Math.max(0, active.length - NEEDS_YOU_MAX));
      while (asks.size > NEEDS_YOU_SEEN_MAX) asks.delete(asks.keys().next().value);
      changed(now);
      return { restored, asks: n };
    },
    view: (now = Date.now()) => needsYouView(list, whoFor, now, detailFor, asks),
    // The permission wait the view's `key` names, for server.mjs's reminder words (board
    // 88c1d4ec, Ultron's L4): { sessionId, asks: [{ agent, tool }] (its open asks, oldest
    // first: the tool's own name and the thread's hash, null for the session's own), hint },
    // or null. Kept in this process: the view never carries an id or a tool's name.
    permissionThread: (key, now = Date.now()) => {
      if (typeof key !== 'string') return null;
      const w = activeWaits(list, now).find(x => x.kind === 'permission' && waitKey(x.sessionId) === key);
      if (!w) return null;
      const mine = asks.get(w.sessionId);
      return {
        sessionId: w.sessionId,
        asks: (Array.isArray(mine) ? mine : []).filter(a => isObject(a)).map(a => ({ agent: typeof a.agent === 'string' ? a.agent : null, tool: typeof a.tool === 'string' ? a.tool : null })),
        hint: typeof w.hint === 'string' ? w.hint : null
      };
    },
    size: (now = Date.now()) => activeWaits(list, now).length
  };
}

// The log's line: the event, the kind or the tool, and whether a subagent posted it;
// never the session or the agent's id.
export function needsYouLogLine(value, open, stale = false) {
  const parts = [value.kind, value.tool].filter(given);
  if (threadOf(value) !== null) parts.push('a subagent');
  return `needs-you: ${value.event}${parts.length ? ` (${parts.join(', ')})` : ''}${stale ? ', older than the last event seen, ignored' : ''}, ${open} open`;
}
