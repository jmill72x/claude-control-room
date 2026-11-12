// A request answered somewhere else closes its card on the page (2026-11-12: a card
// stayed open after the prompt was allowed in Claude Code's own dialog, and a Deny
// tapped on it a minute later was sent for a request already answered).
//
// One request shows in three places: Claude Code's own prompt, Discord's DM buttons and
// the page. Claude Code tells a channel when a request opens and never when it closes
// (checked in CLI 2.1.322: the only channel notifications are `permission_request` out
// and `permission` in), so the page can't be told. What the server does hear is the
// lead's session moving on, through the needs-you hooks (lib/needs-you.mjs):
//
//   UserPromptSubmit  the session took its next prompt
//   Stop              its turn ended
//   SessionEnd        it closed
//
// Each means every prompt the channel relayed before that moment is no longer asked:
// answered in another place, or dropped with its turn. Those cards close (the store's
// `closePermissionsElsewhere`, state `elsewhere`), no verdict is written and nothing is
// sent to the channel. PostToolUse is left out on purpose: the session's other tool
// calls and its helpers' post it under the same session id while a prompt still waits
// (seen 2026-11-12, 3 s after a request that then waited 17 minutes).
//
// What this can't do: close the card the moment the prompt is answered in another
// place. Until the turn ends or the next prompt is taken the card stays, and a tap on
// it goes to the channel, which hands it to Claude Code, which drops a verdict for a
// request that is no longer open. A helper whose own prompt waits while the lead takes
// a new prompt would lose its card early; the prompt itself stays where it was.
//
// Only the lead's session by name counts (`isLeadSession`, the strict test the
// exact-command reports use): another session's turn ending says nothing here.
export const MOVED_EVENTS = Object.freeze(['UserPromptSubmit', 'Stop', 'SessionEnd']);

// `store` is the chat store. `note({ event, sessionId, at })` takes a needs-you event
// as lib/needs-you.mjs checked it and answers how many cards it closed. `at` is when
// the hook ran (never trusted past this clock); without one, now.
export function createAnsweredElsewhere({ store, isLeadSession = () => false, now = () => Date.now(), log = console.log } = {}) {
  return function note(value) {
    if (!value || !MOVED_EVENTS.includes(value.event)) return 0;
    let lead = false;
    try { lead = isLeadSession(value.sessionId) === true; } catch { lead = false; }
    if (!lead) return 0;
    const at = now();
    const upTo = Number.isSafeInteger(value.at) ? Math.min(value.at, at) : at;
    let closed = [];
    try { closed = store.closePermissionsElsewhere({ upTo, event: value.event }) ?? []; } catch { closed = []; }
    if (closed.length > 0) log(`chat: ${closed.length} permission card${closed.length === 1 ? '' : 's'} closed, answered somewhere else or no longer asked (the lead's session moved on: ${value.event}): ${closed.join(', ')}`);
    return closed.length;
  };
}
