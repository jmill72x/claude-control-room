// A request answered somewhere else closes its card on the page (2026-11-12: a card
// stayed open after the prompt was allowed in Claude Code's own dialog, and a Deny
// tapped on it a minute later was sent for a request already answered).
//
// One request shows in three places: Claude Code's own prompt, Discord's DM buttons and
// the page. Claude Code tells a channel when a request opens and never when it closes
// (checked in CLI 2.1.322: the only channel notifications are `permission_request` out
// and `permission` in), so the page can't be told. What the server does hear is the
// lead's session moving on, through the needs-you hooks (lib/needs-you.mjs), and what each
// thread of it wrote, through the transcripts (the sessions pass, each minute):
//
//   UserPromptSubmit  the session took its next prompt
//   Stop              its turn ended
//   SessionEnd        it closed
//
// SessionEnd closes every card the channel relayed before it. UserPromptSubmit and Stop
// are the lead's own thread moving on, so they close only the cards that were his own
// thread's: a subagent of his keeps its prompt open while he takes his next prompt (board
// 28644093: Vision's 17:30Z card on 2026-11-26 was closed at the lead's next turn while
// the run still waited). Which threads a card may be comes from the transcripts (lib/
// approval-wait.mjs, cardThreads: every thread whose newest response has an open tool use
// of the card's tool, written just before the card was relayed; more than one when two
// threads each called that tool then, board 48308589):
//
//   the lead's own thread   closed at his UserPromptSubmit or Stop, as before;
//   a subagent's (any one   kept open; it closes once every thread it may be is past it
//   of them)                (threadPast: the tool use has its result, the thread wrote a
//                           request after it, or it stopped), or at SessionEnd;
//   not known yet           (no sessions pass since it was relayed) the close waits for the
//                           next pass, which says which thread it is;
//   no thread found         (a pass read the transcripts and no thread is at it) closed at
//                           his UserPromptSubmit or Stop, as before.
//
// Every card whose threads are all past it closes at the next pass, whoever's it was, and
// within seconds through lib/card-watch.mjs (`closeAnswered`), which reads only the new
// bytes of those threads' transcripts every 2 s while a card is open. Those
// cards close (the store's `closePermissionsElsewhere`, state `elsewhere`), no verdict is
// written and nothing is sent to the channel. PostToolUse is left out on purpose: the
// session's other tool calls and its helpers' post it under the same session id while a
// prompt still waits (seen 2026-11-12, 3 s after a request that then waited 17 minutes).
// The hooks are read the same with the 2026-11-12 entries (no tool or thread) and with
// NEXT.md §28's: only the event and the session.
//
// What this can't do: close the card the moment the prompt is answered in another
// place. The transcript shows the answer only once the call has its result (a denial at
// once; an allowed call when it finishes running) or the thread moved on, and the watch
// reads it a few seconds later; until then the card stays, and a tap on it goes to the
// channel, which hands it to Claude Code, which drops a verdict for a request that is no
// longer open.
//
// Only the lead's session by name counts (`isLeadSession`, the strict test the
// exact-command reports use): another session's turn ending says nothing here.
import { cardThreads, threadPast } from './approval-wait.mjs';

export const MOVED_EVENTS = Object.freeze(['UserPromptSubmit', 'Stop', 'SessionEnd']);
// The lead's own thread moving on: closes only his own thread's cards.
const OWN_EVENTS = new Set(['UserPromptSubmit', 'Stop']);
// A card a pass found no thread for.
const NONE = Object.freeze({ none: true });
// At most this many cards' threads are kept (the store keeps at most 50 open).
export const REFS_MAX = 200;
// The passes run each minute. With none for this long (the transcripts can't be read), a
// card whose thread is not known closes at the lead's turn as before, and one whose close
// was waiting for a pass closes at the next hook event.
export const PASS_FRESH_MS = 3 * 60e3;

// `store` is the chat store. `note({ event, sessionId, at })` takes a needs-you event as
// lib/needs-you.mjs checked it and answers how many cards it closed; `pass({ threads,
// sessions, stopped, readAt, written })` takes each sessions pass's threads (lib/
// approval-wait.mjs, threadTimes), the lead's session ids, the stopped subagents
// (Map<session id, Map<agentKey, time>>), when the pass began reading and when each of the
// lead's sessions last wrote (Map<session id, newest mtime of its files>; a session written
// since the channel's hello, the store's `permissionSessionAt`, is current, and an open call
// in it of any age can be a card's), and answers how many it closed.
// `at` is when the hook ran (never trusted past this clock); without one, now.
export function createAnsweredElsewhere({ store, isLeadSession = () => false, now = () => Date.now(), log = console.log } = {}) {
  // requestId -> cardThreads' answer (a non-empty list), or NONE.
  const refs = new Map();
  // requestId -> { event }: a card the lead's own thread moved past before any pass said
  // whose it is.
  const deferred = new Map();
  let lastPassAt = null;
  const isSubagents = ref => Array.isArray(ref) && ref.some(r => r.agent !== null);

  const close = (ids, event, why) => {
    if (ids.size === 0) return 0;
    let closed = [];
    try { closed = store.closePermissionsElsewhere({ upTo: now() + 1, event, ids }) ?? []; } catch { closed = []; }
    for (const id of closed) { refs.delete(id); deferred.delete(id); }
    if (closed.length > 0) log(`chat: ${closed.length} permission card${closed.length === 1 ? '' : 's'} closed, answered somewhere else or no longer asked (${why}): ${closed.join(', ')}`);
    return closed.length;
  };

  function note(value) {
    if (!value || !MOVED_EVENTS.includes(value.event)) return 0;
    let lead = false;
    try { lead = isLeadSession(value.sessionId) === true; } catch { lead = false; }
    if (!lead) return 0;
    const at = now();
    const upTo = Number.isSafeInteger(value.at) ? Math.min(value.at, at) : at;
    const why = `the lead's session moved on: ${value.event}`;
    const fresh = lastPassAt !== null && at - lastPassAt < PASS_FRESH_MS;
    let n = 0;
    if (!fresh && deferred.size > 0) {
      const stale = new Map();
      for (const [id, d] of deferred) {
        if (!stale.has(d.event)) stale.set(d.event, new Set());
        stale.get(d.event).add(id);
      }
      deferred.clear();
      for (const [event, ids] of stale) n += close(ids, event, `the lead's session moved on: ${event}; no sessions pass said whose it was`);
    }
    if (!OWN_EVENTS.has(value.event)) {
      let closed = [];
      try { closed = store.closePermissionsElsewhere({ upTo, event: value.event }) ?? []; } catch { closed = []; }
      for (const id of closed) { refs.delete(id); deferred.delete(id); }
      if (closed.length > 0) log(`chat: ${closed.length} permission card${closed.length === 1 ? '' : 's'} closed, answered somewhere else or no longer asked (${why}): ${closed.join(', ')}`);
      return n + closed.length;
    }
    let cards = [];
    try { cards = store.closablePermissions() ?? []; } catch { cards = []; }
    const now_ = new Set(), kept = [];
    for (const p of cards) {
      if (!(p.relayedAt < upTo)) continue;
      const ref = refs.get(p.requestId);
      if (isSubagents(ref)) kept.push(p.requestId);
      else if (ref === undefined && fresh) deferred.set(p.requestId, { event: value.event });
      else now_.add(p.requestId);
    }
    if (kept.length > 0) log(`chat: ${kept.length} permission card${kept.length === 1 ? '' : 's'} kept open at the lead's ${value.event}: a subagent's, and its thread has not moved past it: ${kept.join(', ')}`);
    return n + close(now_, value.event, why);
  }

  function pass({ threads, sessions = [], stopped = null, readAt = null, written = null } = {}) {
    // A pass that can't say whose a card is (no transcripts, no session of the lead's
    // named) is no pass here.
    if (!(threads instanceof Map) || !Array.isArray(sessions) || sessions.length === 0) return 0;
    let cards = [];
    try { cards = store.closablePermissions() ?? []; } catch { return 0; }
    lastPassAt = now();
    // Only a card relayed before the transcripts were read can be judged by them: its
    // tool use was on disk by then. A later one waits for the next pass.
    const before = Number.isFinite(readAt) ? Math.min(readAt, lastPassAt) : lastPassAt;
    const live = new Set(cards.map(p => p.requestId));
    for (const id of refs.keys()) if (!live.has(id)) refs.delete(id);
    for (const id of deferred.keys()) if (!live.has(id)) deferred.delete(id);
    const past = new Set(), byEvent = new Map(), kept = [];
    let current = null;
    for (const p of cards) {
      let ref = refs.get(p.requestId);
      if (ref === undefined) {
        if (!(p.relayedAt < before)) continue;
        current ??= currentSessions(written);
        let found = [];
        try { found = cardThreads(threads, sessions, p.tool, p.relayedAt, current); } catch { found = []; }
        ref = Array.isArray(found) && found.length > 0 ? found : NONE;
        refs.set(p.requestId, ref);
        while (refs.size > REFS_MAX) refs.delete(refs.keys().next().value);
      }
      const wait = deferred.get(p.requestId);
      if (ref !== NONE) {
        // Past only when every thread it may be is past it: one still at it, or not read
        // this pass, keeps it.
        let gone = true;
        for (const r of ref) {
          let g = null;
          try { g = threadPast(threads, r, stopped instanceof Map ? stopped.get(r.sessionId) : null); } catch { g = null; }
          if (g !== true) { gone = false; break; }
        }
        if (gone) { past.add(p.requestId); continue; }
      }
      if (!wait) continue;
      if (isSubagents(ref)) { deferred.delete(p.requestId); kept.push(p.requestId); continue; }
      if (!byEvent.has(wait.event)) byEvent.set(wait.event, new Set());
      byEvent.get(wait.event).add(p.requestId);
    }
    if (kept.length > 0) log(`chat: ${kept.length} permission card${kept.length === 1 ? '' : 's'} kept open after the lead's turn: a subagent's, and its thread has not moved past it: ${kept.join(', ')}`);
    let n = close(past, 'its own thread', 'its own thread moved past it');
    for (const [event, ids] of byEvent) n += close(ids, event, `the lead's session moved on: ${event}`);
    return n;
  }

  // The lead's sessions written since the channel's current process said hello.
  function currentSessions(written) {
    const out = new Set();
    let helloAt = null;
    try { helloAt = store.permissionSessionAt; } catch { helloAt = null; }
    if (!Number.isFinite(helloAt) || !(written instanceof Map)) return out;
    for (const [sid, t] of written) if (Number.isFinite(t) && t >= helloAt) out.add(sid);
    return out;
  }

  // lib/card-watch.mjs found these cards answered in their threads' transcripts (every
  // thread a card may be is past it): they close now, as a pass would close them.
  // `ids` is a Set (the store closes nothing for anything else).
  const closeAnswered = ids => close(ids, 'its own thread', 'its thread\'s transcript shows the call answered');

  return { note, pass, closeAnswered, size: () => ({ refs: refs.size, deferred: deferred.size }) };
}
