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
//
// A permission wait ends when the session's last ask is answered. A session with no ask
// known (the hook entries from before this change, which send no tool, or a restart
// between the ask and its Notification) is cleared as before, by any of the clearing
// events. An idle or question wait belongs to the session's own thread, so a
// subagent's tool use leaves it alone.
import { createHash } from 'node:crypto';

// At most this many open waits; the oldest go first when there are more.
export const NEEDS_YOU_MAX = 20;
// A wait with no clear is dropped after this: a session that was closed with the
// prompt open, or a hook whose clear never came. Asks lapse with it.
export const NEEDS_YOU_TTL_MS = 30 * 60e3;
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

// The asks after one event: `asks` maps a session to its asks, oldest first, each
// { agent, tool, at, receivedAt }. Answers { asks, before, after }: how many asks the
// event's session had before it, and has after it.
export function noteAsks(asks, value, now) {
  const next = new Map();
  for (const [sid, list] of asks instanceof Map ? asks : []) {
    const kept = (Array.isArray(list) ? list : []).filter(a => isObject(a) && now - a.receivedAt < NEEDS_YOU_TTL_MS);
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
    others.push({ sessionId: value.sessionId, kind: value.kind, since: wait?.kind === value.kind ? wait.since : now });
    others.sort((a, b) => a.since - b.since);
    return others.slice(Math.max(0, others.length - NEEDS_YOU_MAX));
  }
  if (wait === null) return active;
  return endsWait(wait, value, ask) ? others : active;
}

export const activeWaits = (list, now) =>
  (Array.isArray(list) ? list : []).filter(w => isObject(w) && Number.isFinite(w.since) && now - w.since < NEEDS_YOU_TTL_MS);

// The key names the session without saying which: a short hash of its id.
export const waitKey = sessionId => `needs-you:${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12)}`;

// What the page gets: [{ who, kind, since, key }], oldest first. `whoFor` turns a
// session id into a roster name, or null when the session is nobody's on the roster.
export function needsYouView(list, whoFor, now) {
  return activeWaits(list, now).map(w => {
    let who = null;
    try { who = whoFor?.(w.sessionId) ?? null; } catch { who = null; }
    return { who: typeof who === 'string' && who.trim() ? who.trim().slice(0, 40) : null, kind: w.kind, since: w.since, key: waitKey(w.sessionId) };
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
export function noteSeen(seen, value, now) {
  const next = new Map([...seen].filter(([, e]) => now - e.receivedAt < NEEDS_YOU_TTL_MS));
  if (value.at === null || ASK_EVENTS.has(value.event) || threadOf(value) !== null) return next;
  next.delete(value.sessionId);
  next.set(value.sessionId, { at: value.at, receivedAt: now });
  while (next.size > NEEDS_YOU_SEEN_MAX) next.delete(next.keys().next().value);
  return next;
}

// The store: in memory only. A restart forgets every wait and ask, and the next hook
// event (or the hook's clear) sets it straight. `record` answers { open, stale }:
// a stale event changes no wait, but its tool use still answers an ask, and when that
// was the session's last ask the permission wait goes and the event is not stale.
export function createNeedsYouStore({ whoFor = () => null } = {}) {
  let list = [];
  let seen = new Map();
  let asks = new Map();
  return {
    record: (value, now = Date.now()) => {
      const stale = isStaleEvent(seen, value);
      const ask = noteAsks(asks, value, now);
      asks = ask.asks;
      if (!stale) seen = noteSeen(seen, value, now);
      const had = activeWaits(list, now).length;
      list = recordNeedsYou(list, value, now, ask, stale);
      // Stale and still ending a wait (its tool use answered the last ask): not ignored.
      return { open: list.length, stale: stale && list.length === had };
    },
    view: (now = Date.now()) => needsYouView(list, whoFor, now),
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
