// The exact text of a Bash command, for approvals (docs/design/2026-11-11-jarvis-os-
// approvals.md, section 0.2). Claude Code folds each run of whitespace in a relayed
// preview to one space, so the preview alone can't say whether a command has one line or
// two. A PermissionRequest hook (README "Approvals as buttons", report-only: it prints
// nothing and decides nothing) posts the tool's real input to the loopback ingest just
// before the prompt is relayed. This file checks such a report and keeps it, in memory
// only, for two minutes; lib/approvals.mjs matches a relayed request to one by content.
// Nothing here is logged or written to disk. Checked by test/exact-commands.test.mjs.

// A report is forgotten after this.
export const EXACT_TTL_MS = 2 * 60e3;
// A report counts for a request when it arrived this long before the channel got the
// prompt, or this little after (the hook runs first; the slack is for clocks).
export const EXACT_WINDOW_BEFORE_MS = 30e3;
export const EXACT_WINDOW_AFTER_MS = 5e3;
// Claude Code elides a preview field over 3,500 code points, and an elided preview is
// Deny-only, so a longer command could never be allowed here anyway.
export const EXACT_MAX_CHARS = 4000;
// At most this many reports are kept; the oldest go first.
export const EXACT_KEEP = 40;

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = error => ({ ok: false, error });

// This server's own fold: each run of whitespace becomes one space, nothing trimmed.
// It must give what Claude Code's relay gives for the same text, or nothing matches
// (which is the safe side); design section 9.2's scratch test checks the two agree.
export const foldWhitespace = s => String(s ?? '').replace(/\s+/gu, ' ');

// Text the card can show in full: printable ASCII, line breaks and tabs, nothing else
// (no carriage return, no other control, nothing a disk or a font could fold).
export function exactTextOk(s) {
  if (typeof s !== 'string' || s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x09)) return false;
  }
  return true;
}

// The hook's post, down to what is read: { sessionId, command }. Only a Bash
// PermissionRequest counts (a Bash matcher also fires for Monitor commands).
export function checkExactReport(body) {
  if (!isObject(body)) return fail('the body must be the hook\'s JSON object');
  if (body.hook_event_name !== 'PermissionRequest') return fail('hook_event_name must be PermissionRequest');
  if (body.tool_name !== 'Bash') return fail('tool_name must be Bash');
  if (typeof body.session_id !== 'string' || !SESSION_ID.test(body.session_id)) return fail('session_id must be an id of at most 80 letters, digits, hyphens and underscores');
  if (typeof body.command !== 'string' || body.command === '') return fail('command must be the command\'s text');
  if (body.command.length > EXACT_MAX_CHARS) return fail(`command is over ${EXACT_MAX_CHARS} characters`);
  return { ok: true, value: { sessionId: body.session_id, command: body.command } };
}

// The reports, newest last. `candidates(previewCommand, relayedAt)` answers what a
// relayed request can be matched to: the distinct usable texts whose fold equals the
// preview's command character for character (or that equal it outright, for a relay
// that did not fold), among the reports inside the window, and whether a report that
// matched can't be shown (`unusable`). One text and nothing unusable is a match; more
// than one is a conflict, which the caller treats as Deny-only and alerts.
export function createExactCommands({ now = () => Date.now() } = {}) {
  let list = []; // { at, text, fold, usable }
  const prune = () => { const at = now(); list = list.filter(e => at - e.at < EXACT_TTL_MS); };
  return {
    note(command) {
      prune();
      const text = String(command);
      list.push({ at: now(), text, fold: foldWhitespace(text), usable: exactTextOk(text) });
      if (list.length > EXACT_KEEP) list = list.slice(list.length - EXACT_KEEP);
    },
    candidates(previewCommand, relayedAt) {
      prune();
      const texts = [];
      let unusable = false;
      if (typeof previewCommand !== 'string' || !Number.isFinite(relayedAt)) return { texts, unusable, conflict: false };
      for (const e of list) {
        if (e.at < relayedAt - EXACT_WINDOW_BEFORE_MS || e.at > relayedAt + EXACT_WINDOW_AFTER_MS) continue;
        if (e.fold !== previewCommand && e.text !== previewCommand) continue;
        if (!e.usable) unusable = true;
        else if (!texts.includes(e.text)) texts.push(e.text);
      }
      return { texts, unusable, conflict: texts.length + (unusable ? 1 : 0) > 1 };
    },
    size() { prune(); return list.length; }
  };
}
