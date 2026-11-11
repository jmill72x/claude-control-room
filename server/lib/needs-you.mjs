// "Jarvis is waiting on you" (docs/design/2026-11-10-jarvis-os-home.md, §5.2): a
// Claude Code hook posts the hook's JSON to POST /api/ingest/needs-you when a session
// waits for a person (a permission prompt, an idle prompt, a question) and again
// when it moves on. This file holds the pure parts and the in-memory store; the
// route is in routes.mjs. Checked by test/needs-you.test.mjs.
//
// What is kept: the session's id (to clear it later), the kind of wait and when it
// began. What leaves this server: `who` (a roster name, or nothing), `kind`, `since`
// and a key made from a hash of the id. The hook's message text, the tool's input
// and the transcript path are never read, let alone kept.
import { createHash } from 'node:crypto';

// At most this many open waits; the oldest go first when there are more.
export const NEEDS_YOU_MAX = 20;
// A wait with no clear is dropped after this: a session that was closed with the
// prompt open, or a hook whose clear never came.
export const NEEDS_YOU_TTL_MS = 30 * 60e3;
// A wait this old becomes an alert (and, counted, a push).
export const NEEDS_YOU_ALERT_MS = 5 * 60e3;

// The hook events that open a wait, by the kind of wait, and the ones that end it.
// A Notification opens one only for the types that mean "someone must answer":
// an `auth_success` or anything new is a no-op, never a wait.
export const WAIT_KINDS = { permission_prompt: 'permission', idle_prompt: 'idle', elicitation_dialog: 'question' };
export const OPENING_EVENTS = new Set(['Notification', 'PermissionRequest']);
export const CLEARING_EVENTS = new Set(['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
// Auto mode's classifier refused a tool call (approvals, decision 3): logged and handed
// to the approvals gate, which makes page cards Deny-only for a while. It opens and
// clears no wait, and decides nothing in Claude Code (the hook runs async).
export const BLOCK_EVENTS = new Set(['PermissionDenied']);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
export const BLOCK_REASON_MAX = 300;

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const WORD = /^[a-z_]{1,40}$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = error => ({ ok: false, error });
const pass = value => ({ ok: true, value });

// At most this many sessions' newest event times are kept for ordering, each for
// as long as a wait lives.
export const NEEDS_YOU_SEEN_MAX = 200;

// The hook's JSON, down to the four fields read: { event, sessionId, kind, at }.
// `kind` is null for a clear, and for a Notification that opens nothing. `at` is
// when the hook ran (epoch ms, the hook entry's `(now*1000|floor)`), or null from
// an entry that sends none; the hooks run async, so posts can arrive out of order.
export function checkNeedsYou(body) {
  if (!isObject(body)) return fail('the body must be the hook\'s JSON object');
  const event = body.hook_event_name;
  if (typeof event !== 'string' || !(OPENING_EVENTS.has(event) || CLEARING_EVENTS.has(event) || BLOCK_EVENTS.has(event))) {
    return fail(`hook_event_name must be one of ${[...OPENING_EVENTS, ...CLEARING_EVENTS, ...BLOCK_EVENTS].join(', ')}`);
  }
  if (typeof body.session_id !== 'string' || !SESSION_ID.test(body.session_id)) return fail('session_id must be an id of at most 80 letters, digits, hyphens and underscores');
  let kind = null;
  if (event === 'PermissionRequest') kind = 'permission';
  else if (event === 'Notification') {
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
  return pass({ event, sessionId: body.session_id, kind, at });
}

// The list after one event. An opening event with a kind replaces the session's
// wait (its `since` stays when the kind is unchanged: a re-sent prompt is the same
// wait); a clearing event, or a Notification that opens nothing, drops it.
export function recordNeedsYou(list, value, now) {
  const kept = activeWaits(list, now).filter(w => w.sessionId !== value.sessionId);
  if (!OPENING_EVENTS.has(value.event) || value.kind === null) return kept;
  const before = activeWaits(list, now).find(w => w.sessionId === value.sessionId);
  kept.push({ sessionId: value.sessionId, kind: value.kind, since: before?.kind === value.kind ? before.since : now });
  kept.sort((a, b) => a.since - b.since);
  return kept.slice(Math.max(0, kept.length - NEEDS_YOU_MAX));
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
// wait nobody has. An event with no `at` can't be ordered, so it always counts.
export const isStaleEvent = (seen, value) =>
  value.at !== null && seen.has(value.sessionId) && value.at < seen.get(value.sessionId).at;

// The map after a taken event: its `at` noted, lapsed entries dropped, the oldest
// going first past NEEDS_YOU_SEEN_MAX.
export function noteSeen(seen, value, now) {
  const next = new Map([...seen].filter(([, e]) => now - e.receivedAt < NEEDS_YOU_TTL_MS));
  if (value.at === null) return next;
  next.delete(value.sessionId);
  next.set(value.sessionId, { at: value.at, receivedAt: now });
  while (next.size > NEEDS_YOU_SEEN_MAX) next.delete(next.keys().next().value);
  return next;
}

// The store: in memory only. A restart forgets every wait, and the next hook
// event (or the hook's clear) sets it straight. `record` answers { open, stale }:
// a stale event changes nothing.
export function createNeedsYouStore({ whoFor = () => null } = {}) {
  let list = [];
  let seen = new Map();
  return {
    record: (value, now = Date.now()) => {
      if (isStaleEvent(seen, value)) return { open: activeWaits(list, now).length, stale: true };
      seen = noteSeen(seen, value, now);
      list = recordNeedsYou(list, value, now);
      return { open: list.length, stale: false };
    },
    view: (now = Date.now()) => needsYouView(list, whoFor, now),
    size: (now = Date.now()) => activeWaits(list, now).length
  };
}

// The log's line: the event and the kind, never the session.
export const needsYouLogLine = (value, open, stale = false) =>
  `needs-you: ${value.event}${value.kind ? ` (${value.kind})` : ''}${stale ? ', older than the last event seen, ignored' : ''}, ${open} open`;
