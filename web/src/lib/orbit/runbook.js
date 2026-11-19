// "Bring Jarvis Back", the run sheet for when the lead goes quiet (board 52ee3f17,
// 2026-11-19). It is a private claude.ai page, readable only when signed in, so its
// address is no secret. This is the one place the address lives: every link to it on
// the page (the Overview's foot, the lead's health details, the alert strip, the
// chat's banner and menu) reads it from here. Checked by web/test/orbit-runbook.test.js.

export const RUNBOOK_URL = 'https://claude.ai/artifact/NSRZHmezuvqUUQmhfwmARm';
export const RUNBOOK_LABEL = 'Bring Jarvis Back';

// A message of the owner's that the server holds (`queued`) but the channel has not
// taken two minutes after this page saw it so, with the channel connected and the
// stream open, is stuck. The channel takes a message within a second or two whenever it
// is connected (server/lib/chat-store.mjs marks it `delivered` on the channel's ack),
// so two minutes is a channel that is there by its heartbeat but not taking anything.
export const STUCK_AFTER_MS = 2 * 60e3;

// The owner's chat messages the server has numbered and still holds `queued`. One
// still sending, or refused, is the page's own trouble (its Retry says so), and an
// `undelivered` one already has its own line. A queued one is left out when the thread
// shows the channel got past it anyway (Ultron, 2026-11-19, board ed663682): a later
// message of the owner's that is `delivered` (the channel's acks are cumulative), or
// any later message from the lead. A page that was away can hold a stale `queued`.
// A routine's message (`meta.routine`: the morning brief, the weekly digest) is the
// lead's by name only: a launchd job posts it, not his channel, so it proves nothing.
function queuedMine(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let passed = -Infinity; // the highest seq the channel is known to have got past
  for (const m of list) {
    if (!m || !Number.isInteger(m.seq)) continue;
    if ((m.from === 'jeff' && m.state === 'delivered') || (m.from === 'jarvis' && !m.meta?.routine)) passed = Math.max(passed, m.seq);
  }
  return list.filter(m => m?.from === 'jeff' && m.kind === 'chat' && !m.failed && Number.isInteger(m.seq) &&
    m.state === 'queued' && m.seq > passed);
}

// When this page first saw each queued message while it could trust what it sees
// (`watching`: the stream open and the channel connected), on the device's own clock,
// so the server's `at` and the device's clock are never compared (Ultron's low). Not
// watching starts every clock again: while the channel is offline the banner says so,
// and after a resume the refetched thread gets two minutes to bring the acks.
// Returns a new Map of id -> first seen; the caller keeps it between renders.
export function noteQueued(seen, messages, now, watching) {
  const next = new Map();
  if (!watching) return next;
  for (const m of queuedMine(messages)) next.set(m.id, seen instanceof Map && seen.has(m.id) ? seen.get(m.id) : now);
  return next;
}

// The oldest stuck message (its `at` is what the banner names), or null. `seen` is
// noteQueued's map; a message it doesn't hold has not been watched long enough.
export function stuckSince(messages, now = Date.now(), seen = null) {
  if (!(seen instanceof Map)) return null;
  let oldest = null;
  for (const m of queuedMine(messages)) {
    const first = seen.get(m.id);
    if (!Number.isFinite(first) || now - first < STUCK_AFTER_MS) continue;
    if (oldest === null || m.seq < oldest.seq) oldest = m;
  }
  return oldest;
}

// The health strip's service for the lead's session (server/lib/health.mjs): the
// `session` service named like the roster's lead, else the only `session` there is.
export function leadService(services, leadName) {
  const sessions = (Array.isArray(services) ? services : []).filter(s => s?.kind === 'session');
  if (typeof leadName === 'string' && leadName !== '') {
    const named = sessions.find(s => s.name === leadName);
    if (named) return named;
  }
  return sessions.length === 1 ? sessions[0] : null;
}

// Whether a health chip's key is the lead's session (its details then carry the link).
export const isLeadServiceKey = (key, services, leadName) => {
  const lead = leadService(services, leadName);
  return Boolean(lead) && typeof key === 'string' && key === lead.key;
};

// Whether an alert strip entry is "<lead> is not running" (server/lib/alerts.mjs: kind
// `service`, key `service:<the service's key>`), five minutes into the lead's
// session being down. Then the strip carries the link, on every tab.
export function isLeadDownAlert(alert, services, leadName) {
  if (alert?.kind !== 'service' || typeof alert.key !== 'string') return false;
  // No health services to match against (the panel unread or unavailable): the
  // alert's own key says it is a session's, and the lead's is the only one set up.
  if (!Array.isArray(services)) return alert.key.startsWith('service:session:');
  const lead = leadService(services, leadName);
  return lead !== null && alert.key === `service:${lead.key}`;
}
