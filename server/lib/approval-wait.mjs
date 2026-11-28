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
// Map<session id, { main, agents: Map<agentKey, time>, types: Map<agentKey, agent type>,
// mainOpen, agentsOpen: Map<agentKey, open tool uses> }>. `main` is the session's own
// transcript's (-Infinity when it has no request yet), left undefined when that transcript
// was not among them. A subagent's key is the hash of the id in its file's name
// (agent-<id>.jsonl), as its hooks send it. The open tool uses ([{ name, at }], lib/
// parse-transcript.mjs, openTools) are the newest response's that have no result yet: the
// newest transcript's when a session has two own files.
const AGENT_FILE = /(?:^|\/)agent-([^/]+)\.jsonl$/;
const openOf = t => (Array.isArray(t.openTools) ? t.openTools.filter(u => isObject(u) && typeof u.name === 'string' && Number.isFinite(u.at)) : []);
export function threadTimes(transcripts) {
  const out = new Map();
  const entry = sid => {
    if (!out.has(sid)) out.set(sid, { main: undefined, agents: new Map(), types: new Map(), mainOpen: undefined, agentsOpen: new Map() });
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
      if (!(e.agents.get(key) > last)) e.agentsOpen.set(key, openOf(t));
      e.agents.set(key, Math.max(e.agents.get(key) ?? -Infinity, last));
      if (typeof t.meta?.agentType === 'string') e.types.set(key, t.meta.agentType);
    } else {
      if (!(e.main > last)) e.mainOpen = openOf(t);
      e.main = Math.max(e.main ?? -Infinity, last);
    }
  }
  return out;
}

// ---- which thread a permission card is ----

// A thread's tool use is a card's when it was written from CARD_NEAR_MS before the card
// was relayed to CARD_SKEW_MS after: Claude Code writes the tool use, then runs the
// PreToolUse hooks and, in auto mode, the classifier, then shows the prompt.
export const CARD_NEAR_MS = 2 * MIN;
export const CARD_SKEW_MS = 5e3;

// Which threads of `sessions` (the lead's session ids) a card for `tool` relayed at `at`
// may be: every thread whose newest response has an open tool use of that name in the
// window above, each once (its use nearest to `at`), the session's own thread first. In a
// session of `current` (the ones written since the channel's current process said hello),
// an open tool use of that name written up to CARD_SKEW_MS after `at` counts however old
// it is (board 7d284b3a, Ultron's M1 on 48308589): a prompt opens when the call before it
// in the same response has run, so two Bash calls in one response, the first taking 5
// minutes, relay the second's card 5 minutes after its call. Only in a current session: a
// session of an older process keeps the calls it left open when it ended open for good,
// and one of those would hold every later card of that tool.
// Answers [{ sessionId, agent (null: the session's own thread), name, toolAt }], empty when
// none is. All of them, not the nearest (board 48308589): two threads can each hold an open
// call of one tool around one card, the lead's own running and a subagent's waiting at its
// prompt, and a card matched to the wrong one closed when that one finished while the
// right one still waited. The card is answered only once every one of them is past it
// (threadPast). An open tool use alone never says a prompt waits (a running tool looks
// the same).
export function cardThreads(threads, sessions, tool, at, current = null) {
  if (typeof tool !== 'string' || tool === '' || !Number.isFinite(at) || !(threads instanceof Map)) return [];
  const anyAge = current instanceof Set ? current : new Set();
  const out = [];
  const consider = (sessionId, agent, newest, open) => {
    if (!Array.isArray(open)) return;
    let best = null;
    for (const u of open) {
      if (u.name !== tool || u.at > at + CARD_SKEW_MS) continue;
      if (u.at < at - CARD_NEAR_MS && !anyAge.has(sessionId)) continue;
      // The thread wrote no request after its tool use (it is the newest response's).
      if (Number.isFinite(newest) && newest > u.at) continue;
      if (best === null || Math.abs(at - u.at) < Math.abs(at - best.at)) best = u;
    }
    if (best !== null) out.push({ sessionId, agent, name: best.name, toolAt: best.at });
  };
  for (const sid of new Set(Array.isArray(sessions) ? sessions : [])) {
    const t = threads.get(sid);
    if (!isObject(t)) continue;
    consider(sid, null, t.main, t.mainOpen);
    for (const [key, open] of t.agentsOpen instanceof Map ? t.agentsOpen : []) consider(sid, key, t.agents instanceof Map ? t.agents.get(key) : undefined, open);
  }
  return out;
}

// Whether a thread a card may be (one of cardThreads' answers) has gone past it: no tool
// use of that name is open in its newest response any more (each has its result: allowed
// and run, or denied; one of two parallel calls of the same tool still open keeps it), or
// the thread wrote a request after it, or it stopped (`stoppedAt`, lib/live-agents.mjs endedThreads' times for the
// session: Map<agentKey, time>). Answers true, false (still at it), or null when this
// pass did not read that thread.
export function threadPast(threads, ref, stopped = null) {
  if (!isObject(ref) || !(threads instanceof Map)) return null;
  const t = threads.get(ref.sessionId);
  if (!isObject(t)) return null;
  const own = ref.agent === null;
  const newest = own ? t.main : t.agents instanceof Map ? t.agents.get(ref.agent) : undefined;
  if (!(Number.isFinite(newest) || newest === -Infinity)) return null;
  if (newest > ref.toolAt) return true;
  const stop = !own && stopped instanceof Map ? stopped.get(ref.agent) : undefined;
  if (Number.isFinite(stop) && stop >= ref.toolAt) return true;
  const open = own ? t.mainOpen : t.agentsOpen instanceof Map ? t.agentsOpen.get(ref.agent) : undefined;
  if (!Array.isArray(open)) return null;
  return !open.some(u => u.name === ref.name);
}

// Whether an open card in the chat can take the answer for a permission wait, so the
// reminder may send the owner there (board 88c1d4ec, Ultron's L4; it was any open card of
// the wait's tool label, Deny-only ones and other sessions' included, and "an MCP tool"
// matched any MCP tool). `wait` is lib/needs-you.mjs's permissionThread: { sessionId, asks:
// [{ agent, tool }], hint }; `card` is { tool, canAllow } (canAllow: lib/approvals.mjs's
// view, as the page offers Allow); `threads` the threads a sessions pass found for the
// card (lib/answered-elsewhere.mjs, threadsOf: [{ sessionId, agent }], or null before one
// judged it). True only when Allow is offered there, a pass put the card in the wait's
// session, and: with an ask, the oldest ask's (the one the push names) tool by its own
// name and its thread; with none (hooks that name no tool), its hint's label, and with
// neither ask nor hint, no card (Ultron's L2 on jos/card-lows: any Allow card in the
// session counted; none is the safer of his two options, since such a wait names no tool
// and no card was relayed in the two minutes before it, so no card there is known to be
// its). Anything not known is no card: the words then name Discord and the terminal.
export function cardTakesWait(wait, card, threads) {
  if (!isObject(wait) || !isObject(card) || card.canAllow !== true || typeof card.tool !== 'string') return false;
  if (typeof wait.sessionId !== 'string' || !Array.isArray(threads)) return false;
  const here = threads.filter(t => isObject(t) && t.sessionId === wait.sessionId);
  if (here.length === 0) return false;
  const first = (Array.isArray(wait.asks) ? wait.asks : []).find(a => isObject(a));
  if (first) return first.tool === card.tool && here.some(t => (t.agent ?? null) === (first.agent ?? null));
  return typeof wait.hint === 'string' && toolLabel(card.tool) === wait.hint;
}

// The reminder's `hasCard` from the server's parts: `waitThread(key)` (needs-you's
// permissionThread), `openCards()` (the chat's open cards), `canAllow(card)` (approvals'
// view) and `threadsOf(requestId)` (answered-elsewhere's). A part that throws makes the
// reminder count no card (createApprovalReminders).
export const hasCardFor = ({ waitThread, openCards, canAllow, threadsOf }) => w => {
  const wait = waitThread(w?.key);
  if (!isObject(wait)) return false;
  return (openCards() ?? []).some(p => isObject(p) && cardTakesWait(wait, { tool: p.tool, canAllow: canAllow(p) === true }, threadsOf(p.requestId) ?? null));
};

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
// When no card in the chat can take the answer (its window ended, or a restart of this
// server didn't bring it back; board ee0bd552), the words leave the chat out.
export const REMINDER_TAIL_NO_CARD = 'Answer it in Discord or the terminal.';
const REMINDER_SHAPE = /^[A-Za-z][A-Za-z0-9 ._'-]{0,39} has waited \d{1,4} min on an approval card\.(?: \d{1,2} more cards? (?:is|are) waiting too\.)? Answer it in (?:Jarvis OS chat, )?Discord or the terminal\.$/;
// The push's words: the oldest due card's name (the subagent's, else the session's) and
// whole minutes, how many more cards wait, and where to answer: the chat only with
// `card` true (a card there is open for it).
export function reminderBody(waits, now, { card = false } = {}) {
  const list = (Array.isArray(waits) ? waits : []).filter(w => isObject(w) && Number.isFinite(w.since));
  if (list.length === 0) return null;
  const first = list[0];
  const name = safeName(first.run) ?? safeName(first.who) ?? 'Jarvis';
  const mins = Math.min(9999, minutesOf(now - first.since));
  const more = Math.min(99, list.length - 1);
  const body = `${name} has waited ${mins} min on an approval card.${more > 0 ? ` ${more} more card${more === 1 ? ' is' : 's are'} waiting too.` : ''} ${card === true ? REMINDER_TAIL : REMINDER_TAIL_NO_CARD}`;
  return isReminderPush(body) ? body : null;
}
export const isReminderPush = body => typeof body === 'string' && REMINDER_SHAPE.test(body);

// A card's schedule when this process first sees it. A card is normally seen in its first
// minute: none sent, the first due at REMIND_FIRST_MS. One first seen later was open before
// a restart (lib/needs-you.mjs, restore; board cf9b6496), and the last process may have sent
// the reminders whose times have passed, which it didn't say: all but the latest of those
// count as sent, and the latest is due now, so the restart sends one and the six stay six.
// One past all six gets none (the answer watch's alerts carry on).
export function firstSchedule(since, now) {
  let passed = 0;
  while (passed < REMIND_MAX && now >= since + REMIND_FIRST_MS + passed * REMIND_EVERY_MS) passed++;
  if (passed === 0) return { count: 0, nextAt: since + REMIND_FIRST_MS };
  if (passed >= REMIND_MAX && now >= since + REMIND_FIRST_MS + REMIND_MAX * REMIND_EVERY_MS) return { count: REMIND_MAX, nextAt: Infinity };
  return { count: passed - 1, nextAt: now };
}

// The reminders: `push(body)` sends one to every paired device (lib/chat-push.mjs,
// approvalReminder) and answers { tried, reached }. `step(waits, now)` runs each minute
// with approvalWaits' list. `quiet(now)` is the events module's isQuiet (server.mjs passes
// it; not imported here, so lib/chat-push.mjs can read the shape without the events
// module). In memory only: the waits themselves are (a restart forgets
// them, lib/needs-you.mjs). A card is known by its key and start, so a new prompt in the
// same session is a new card. `hasCard(w)` says whether the chat has an open card that can
// take the answer for the wait the push names (server.mjs, with cardTakesWait); one
// that throws counts as none, and so does none given: the words never send the owner to a card
// that isn't there.
export function createApprovalReminders({ push, log = console.log, quiet = () => false, hasCard = () => false } = {}) {
  const cards = new Map(); // `${key}:${since}` -> { count, nextAt }
  let lastPushAt = null;
  let quietSaid = false;
  let sending = false;
  const idOf = w => `${w.key}:${w.since}`;

  async function step(waits, now) {
    const list = (Array.isArray(waits) ? waits : []).filter(w => isObject(w) && typeof w.key === 'string' && Number.isFinite(w.since));
    const live = new Set(list.map(idOf));
    for (const id of cards.keys()) if (!live.has(id)) cards.delete(id);
    for (const w of list) if (!cards.has(idOf(w))) cards.set(idOf(w), firstSchedule(w.since, now));
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
    let card = false;
    try { card = hasCard(due[0]) === true; } catch { card = false; }
    const body = reminderBody(due, now, { card });
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
