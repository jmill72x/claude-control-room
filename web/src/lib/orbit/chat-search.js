// Chat search on the page (the server's side is server/lib/chat-search.mjs): when a
// query is worth sending, a result's snippet as plain and marked pieces (text only:
// the snippet is the message's raw Markdown cut anywhere, so it is never parsed), the
// summary line, and the steps of loading older history until a result's message is
// on the page. Checked by web/test/orbit-chat-search.test.js.

export const SEARCH_DEBOUNCE_MS = 300;
const Q_MIN = 2;
const Q_MAX = 100;
// Older history is loaded 100 at a time (the server's page cap), 20 pages at most.
export const REACH_PAGE = 100;
export const REACH_PAGES_MAX = 20;

export function searchable(q) {
  if (typeof q !== 'string') return false;
  const n = [...q.trim()].length;
  return n >= Q_MIN && n <= Q_MAX;
}

// The snippet in pieces: [{ text, mark }], rebuilding it exactly. The marks come from
// the server and are checked here anyway: whole numbers only, sorted, overlaps joined,
// empty ones dropped.
export function snippetParts(snippet, marks) {
  const s = typeof snippet === 'string' ? snippet : '';
  if (s === '') return [];
  const spans = (Array.isArray(marks) ? marks : [])
    .filter(m => Array.isArray(m) && Number.isInteger(m[0]) && Number.isInteger(m[1]))
    .sort((x, y) => x[0] - y[0]);
  const parts = [];
  let at = 0;
  // Each mark starts no earlier than the last one's end (and 0); what is left empty
  // (backwards, or inside the last) is skipped. An end past the text needs no clamp:
  // slice stops at the end, and nothing follows a mark that reaches it.
  for (const [a0, b] of spans) {
    const a = Math.max(a0, at);
    if (a >= b) continue;
    if (a > at) parts.push({ text: s.slice(at, a), mark: false });
    parts.push({ text: s.slice(a, b), mark: true });
    at = b;
  }
  if (at < s.length) parts.push({ text: s.slice(at), mark: false });
  // Two touching marks read as one.
  return parts.reduce((out, p) => {
    const last = out[out.length - 1];
    if (last && last.mark === p.mark) last.text += p.text; else out.push({ ...p });
    return out;
  }, []);
}

export const resultWho = r => (r?.from === 'jeff' ? 'You' : r?.kind === 'event' ? 'Event' : 'Jarvis');

export function searchSummary(answer) {
  if (!answer || !Array.isArray(answer.results)) return '';
  const n = answer.results.length;
  let line = n === 0 ? 'No messages match.' : answer.more ? `The newest ${n} matches. Add a word to narrow it.` : `${n} message${n === 1 ? '' : 's'}.`;
  if (answer.truncated) line += ` Only the newest ${Number(answer.scanned).toLocaleString('en-US')} messages were searched.`;
  return line;
}

// After a page of older messages (oldest first, `asked` of them asked for), looking
// for `target` ({ id, seq }): 'found'; 'passed' when the page reaches at or below its
// seq without it (the store no longer holds it); 'start' when the page is the last
// one (short or empty); else 'more'.
export function reachStep(page, target, asked) {
  const list = Array.isArray(page) ? page : [];
  if (list.some(m => m.id === target.id)) return 'found';
  if (list.some(m => Number.isInteger(m.seq) && m.seq <= target.seq)) return 'passed';
  if (list.length < asked) return 'start';
  return 'more';
}

// Plain words for a jump that did not land, or null.
export function reachProblem(outcome) {
  switch (outcome) {
    case 'found': return null;
    case 'too-far': return `That message is more than ${(REACH_PAGE * REACH_PAGES_MAX).toLocaleString('en-US')} messages back, too far for the page to load. Scroll up to reach it.`;
    case 'passed':
    case 'start': return 'That message is no longer in the chat.';
    case 'newer': return 'That message is newer than the thread on this page; reopen the Chat tab and try again.';
    default: return 'Couldn\'t load the earlier messages to reach it. Try again.';
  }
}
