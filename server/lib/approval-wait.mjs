// Approval cards left waiting (board e7427be1, 2026-11-26). The lead's own prompt for a
// Bash call opened at 18:31 and blocked his whole session until a restart at 20:02: the
// card's one push went at 18:31, the page's card ended at 18:41 (the channel then held a
// request 10 minutes), the five-minute needs-you alert went to ntfy and #pepper only,
// which ring no phone, the wait itself lapsed at 19:01, and the idle wake-ups at 18:41
// and 19:41 said "no agent run is live". This module holds the pure parts of the fix:
//
// - Which waits are the lead's approval cards (approvalWaits): the needs-you waits of
//   kind `permission` in a session named as the lead's, his own thread's or one of his
//   subagents'. A wait's tool is a fixed label (toolLabel) and the subagent is named only
//   by the roster (describeWait): never an id, a path or a tool's input.
// - What the transcripts say of each wait's thread (threadTimes), for lib/needs-you.mjs's
//   confirmWaits: the newest request each thread wrote.
// - The reminder to the paired devices (createApprovalReminders): the first once a card
//   has waited REMIND_FIRST_MS, then every REMIND_EVERY_MS, at most REMIND_MAX times a
//   card, and never two pushes within REMIND_GAP_MS whatever the cards (one push covers
//   every card due). Quiet hours are the events module's (22:00-07:00 local): a reminder
//   due then waits for 07:00, and goes then if the card still waits. The pushed words are
//   in one fixed shape (reminderBody, isReminderPush): a name from the roster and whole
//   minutes, never a tool's name (lib/chat-push.mjs says no push names a tool).
// - The words other parts say of a card (waitWords), and the file the jarvis repo's
//   answer watch reads (fileView): labels, names and times only.
import { agentKey } from './needs-you.mjs';

const MIN = 60e3;
export const REMIND_FIRST_MS = 10 * MIN;
export const REMIND_EVERY_MS = 30 * MIN;
// Six: at 10, 40, 70, 100, 130 and 160 minutes. A card that waits longer has had six
// pushes and the answer watch's own alerts; more would only teach Jeff to ignore them.
export const REMIND_MAX = 6;
// The floor under every card's schedule, whatever their number (Ultron's lesson on the
// limit warnings: a rate cap under every once-per-key rule).
export const REMIND_GAP_MS = 10 * MIN;
// A push that reached no device is tried again this much later, at most REMIND_MAX
// times in all (a try that reached nothing still counts toward none).
export const REMIND_RETRY_MS = 5 * MIN;
// The file the answer watch reads is current while written in the last this long.
export const FILE_FRESH_MS = 3 * MIN;
export const FILE_VERSION = 1;

// The tools a card's words may name; any other is "an MCP tool" or "a tool" (the same
// rule as the answer watch's tool_label, jarvis/answer_watch.py).
export const NAMED_TOOLS = Object.freeze(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']);
export const TOOL_LABELS = Object.freeze([...NAMED_TOOLS, 'an MCP tool', 'a tool']);
export function toolLabel(name) {
  if (typeof name !== 'string' || name === '') return null;
  if (NAMED_TOOLS.includes(name)) return name;
  return name.startsWith('mcp__') ? 'an MCP tool' : 'a tool';
}
// A name from the roster, as the words may carry it.
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9 ._'-]{0,39}$/;
const safeName = v => (typeof v === 'string' && SAFE_NAME.test(v) ? v : null);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The newest request each thread wrote, from the sessions pass's transcripts:
// Map<session id, { main, agents: Map<agentKey, time>, types: Map<agentKey, agent type> }>.
// `main` is the session's own transcript's (-Infinity when it has no request yet), left
// undefined when that transcript was not among them. A subagent's key is the hash of the
// id in its file's name (agent-<id>.jsonl), as its hooks send it.
const AGENT_FILE = /(?:^|\/)agent-([^/]+)\.jsonl$/;
export function threadTimes(transcripts) {
  const out = new Map();
  const entry = sid => {
    if (!out.has(sid)) out.set(sid, { main: undefined, agents: new Map(), types: new Map() });
    return out.get(sid);
  };
  for (const t of Array.isArray(transcripts) ? transcripts : []) {
    if (!isObject(t) || typeof t.sessionId !== 'string' || t.sessionId === '') continue;
    let last = -Infinity;
    for (const r of Array.isArray(t.records) ? t.records : []) if (Number.isFinite(r?.ts) && r.ts > last) last = r.ts;
    const e = entry(t.sessionId);
    if (t.subagent) {
      const id = typeof t.filePath === 'string' ? AGENT_FILE.exec(t.filePath)?.[1] : null;
      if (!id) continue;
      const key = agentKey(id);
      e.agents.set(key, Math.max(e.agents.get(key) ?? -Infinity, last));
      if (typeof t.meta?.agentType === 'string') e.types.set(key, t.meta.agentType);
    } else {
      e.main = Math.max(e.main ?? -Infinity, last);
    }
  }
  return out;
}

// A permission wait's tool and the subagent that asked, for the page and the words: the
// oldest open ask's (lib/needs-you.mjs), else the chat card's hint the wait opened with.
// `typeOf(sessionId, agentKey)` answers a subagent's type; `rosterName(word)` the
// roster's name for it or null. A subagent not on the roster is "a subagent".
export function describeWait(w, asks, { typeOf = () => null, rosterName = () => null } = {}) {
  const first = (Array.isArray(asks) ? asks : []).find(a => isObject(a));
  if (first) {
    const run = first.agent === null || first.agent === undefined ? null : (safeName(rosterName(typeOf(w.sessionId, first.agent))) ?? 'a subagent');
    return { tool: toolLabel(first.tool), run };
  }
  return { tool: toolLabel(w.hint ?? null), run: null };
}

// The lead's approval cards from the needs-you view (needsYouView with detailFor):
// [{ key, who, run, tool, since }], oldest first. `own` is true for the lead's own
// thread, and for a wait whose thread is not known (no ask: the hooks before board
// 9fb32c4d's entries, which clear such a wait on any tool use, so one that lasts is the
// lead's own prompt or one nothing else in his session is past).
export function approvalWaits(view, leadName) {
  if (typeof leadName !== 'string' || leadName === '') return [];
  return (Array.isArray(view) ? view : [])
    .filter(w => isObject(w) && w.kind === 'permission' && w.who === leadName && Number.isFinite(w.since))
    .map(w => ({ key: w.key, who: w.who, run: typeof w.run === 'string' ? w.run : null, tool: TOOL_LABELS.includes(w.tool) ? w.tool : null, since: w.since, own: typeof w.run !== 'string' }))
    .sort((a, b) => a.since - b.since);
}

export const minutesOf = (ms) => Math.max(0, Math.floor(ms / MIN));

// One card in words: "Jarvis's approval card (Bash), open 42 min", "Vision's approval
// card (Bash, in Jarvis's session), open 42 min".
export function waitWords(w, now) {
  const subject = w.run ?? w.who;
  const what = [w.tool, w.run ? `in ${w.who}'s session` : null].filter(Boolean).join(', ');
  return `${subject}'s approval card${what ? ` (${what})` : ''}, open ${minutesOf(now - w.since)} min`;
}

// ---- the reminder ----

export const REMINDER_TAIL = 'Answer it in Jarvis OS chat, Discord or the terminal.';
const REMINDER_SHAPE = /^[A-Za-z][A-Za-z0-9 ._'-]{0,39} has waited \d{1,4} min on an approval card\.(?: \d{1,2} more cards? (?:is|are) waiting too\.)? Answer it in Jarvis OS chat, Discord or the terminal\.$/;
// The push's words: the oldest due card's name (the subagent's, else the session's) and
// whole minutes, how many more cards wait, and where to answer.
export function reminderBody(waits, now) {
  const list = (Array.isArray(waits) ? waits : []).filter(w => isObject(w) && Number.isFinite(w.since));
  if (list.length === 0) return null;
  const first = list[0];
  const name = safeName(first.run) ?? safeName(first.who) ?? 'Jarvis';
  const mins = Math.min(9999, minutesOf(now - first.since));
  const more = Math.min(99, list.length - 1);
  const body = `${name} has waited ${mins} min on an approval card.${more > 0 ? ` ${more} more card${more === 1 ? ' is' : 's are'} waiting too.` : ''} ${REMINDER_TAIL}`;
  return isReminderPush(body) ? body : null;
}
export const isReminderPush = body => typeof body === 'string' && REMINDER_SHAPE.test(body);

// The reminders: `push(body)` sends one to every paired device (lib/chat-push.mjs,
// approvalReminder) and answers { tried, reached }. `step(waits, now)` runs each minute
// with approvalWaits' list. `quiet(now)` is the events module's isQuiet (server.mjs passes
// it; not imported here, so lib/chat-push.mjs can read the shape without the events
// module). In memory only: the waits themselves are (a restart forgets
// them, lib/needs-you.mjs). A card is known by its key and start, so a new prompt in the
// same session is a new card.
export function createApprovalReminders({ push, log = console.log, quiet = () => false } = {}) {
  const cards = new Map(); // `${key}:${since}` -> { count, nextAt }
  let lastPushAt = null;
  let quietSaid = false;
  let sending = false;
  const idOf = w => `${w.key}:${w.since}`;

  async function step(waits, now) {
    const list = (Array.isArray(waits) ? waits : []).filter(w => isObject(w) && typeof w.key === 'string' && Number.isFinite(w.since));
    const live = new Set(list.map(idOf));
    for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);
    for (const w of list) if (!cards.has(idOf(w))) cards.set(idOf(w), { count: 0, nextAt: w.since + REMIND_FIRST_MS });
    const due = list.filter(w => { const c = cards.get(idOf(w)); return c.count < REMIND_MAX && now >= c.nextAt; });
    if (due.length === 0) { quietSaid = false; return { status: 'none' }; }
    if (quiet(now)) {
      if (!quietSaid) log(`approval-wait: a reminder for ${waitWords(due[0], now)} waits for the end of quiet hours`);
      quietSaid = true;
      return { status: 'quiet' };
    }
    quietSaid = false;
    if (lastPushAt !== null && now - lastPushAt < REMIND_GAP_MS) return { status: 'gap' };
    if (typeof push !== 'function' || sending) return { status: 'off' };
    const body = reminderBody(due, now);
    if (!body) return { status: 'refused' };
    sending = true;
    let r;
    try { r = await push(body); } catch { r = { tried: 0, reached: 0, failed: true }; } finally { sending = false; }
    const tried = Number.isInteger(r?.tried) ? r.tried : 0;
    const reached = Number.isInteger(r?.reached) ? r.reached : 0;
    if (tried === 0 && !r?.failed) {
      // Push is off or no device takes one: nothing to try; the card's time moves on.
      for (const w of due) cards.get(idOf(w)).nextAt = now + REMIND_EVERY_MS;
      log(`approval-wait: no device takes a push, so no reminder went for ${waitWords(due[0], now)}`);
      return { status: 'no-devices' };
    }
    lastPushAt = now;
    if (reached === 0) {
      for (const w of due) cards.get(idOf(w)).nextAt = now + REMIND_RETRY_MS;
      log(`approval-wait: a reminder for ${waitWords(due[0], now)} reached none of ${tried} device${tried === 1 ? '' : 's'}; tried again in ${REMIND_RETRY_MS / MIN} min`);
      return { status: 'missed' };
    }
    for (const w of due) {
      const c = cards.get(idOf(w));
      c.count++;
      c.nextAt = now + REMIND_EVERY_MS;
    }
    const c0 = cards.get(idOf(due[0]));
    log(`approval-wait: a reminder went to ${reached} of ${tried} device${tried === 1 ? '' : 's'} for ${waitWords(due[0], now)}${due.length > 1 ? ` and ${due.length - 1} more` : ''} (reminder ${c0.count} of ${REMIND_MAX}${c0.count === REMIND_MAX ? ', the last' : ''})`);
    return { status: 'sent', reached, tried };
  }

  return { step, size: () => cards.size };
}

// ---- the answer watch's file ----

// data/approval-waits.json (0600, written each minute): what the jarvis repo's answer
// watch reads to name a card in its alert. Labels, roster names and times only.
export function fileView(waits, now) {
  return {
    version: FILE_VERSION,
    at: now,
    waits: (Array.isArray(waits) ? waits : []).map(w => ({ who: w.who, run: w.run, tool: w.tool, since: w.since, own: w.own }))
  };
}
