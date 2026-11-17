// GET /api/chat/search?q=<words>&limit=<n>: the Chat tab's search over the chat
// store, read-only. The route itself is three lines in lib/chat-routes.mjs, behind
// requireDevice: a paired device's cookie, with the owner's tailnet login when
// config's `chat.login` is set, the same read rule as /api/feed (lib/feed-routes.mjs).
//
// What is searched: the `text` of chat messages (both sides) and event lines, and
// nothing else. Never an attachment (its name or its bytes), an approval request (its
// text is a tool's input), a verdict, a notice or a stop. Every word of the query
// must appear, in any case; the match is a plain substring test (no regex built from
// the query, no diacritic folding: "cafe" does not find it with an accent).
//
// Limits: a query of 2 to 100 characters and at most 8 distinct words; at most 50
// results (20 unless asked), newest first, with `more` when the scan stopped early;
// only the newest 20,000 messages are read (the store holds them all in memory, so
// the scan is a loop over strings, no file read), and `truncated` says when older
// ones were left out. No rate limit: /api/feed has none either, and its read costs
// more (files) than this one (memory). The query is never logged.
//
// Each result carries a snippet: about 180 characters of the raw text around the
// first match, line breaks made spaces, never a half character, with `marks` (the
// [start, end) of every query word inside it) so the page can highlight with text
// nodes alone. The text is the message's own Markdown, cut anywhere: the page shows it
// as plain text, never as markup.
import { HttpError } from '../routes.mjs';

export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 100;
export const SEARCH_TERMS_MAX = 8;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_SCAN_MAX = 20000;
export const SNIPPET_CHARS = 180;
export const SNIPPET_BEFORE = 60;
const MARKS_MAX = 50;
const SEARCHED_KINDS = new Set(['chat', 'event']);

// Curly quotes fold to straight ones (a phone types a curly apostrophe, a keyboard a straight one), one unit for
// one unit, so positions never move.
const QUOTES = { 0x2018: "'", 0x2019: "'", 0x201b: "'", 0x201c: '"', 0x201d: '"', 0x201e: '"' };
const foldQuotes = s => s.replace(/[\u2018\u2019\u201b\u201c\u201d\u201e]/g, c => QUOTES[c.charCodeAt(0)]);

// A text in lower case with plain quotes, and `at(j)`: the original index of folded
// index j (j may be the folded length, for a match's end). Lower case keeps the length
// for nearly every text; where it doesn't (U+0130 lowers to two units), each code
// point is folded alone and its origin kept.
export function foldText(text) {
  const lower = foldQuotes(text.toLowerCase());
  if (lower.length === text.length) return { folded: lower, at: j => j };
  let folded = '';
  const map = [];
  let i = 0;
  for (const ch of text) {
    const f = foldQuotes(ch.toLowerCase());
    folded += f;
    for (let k = 0; k < f.length; k++) map.push(i);
    i += ch.length;
  }
  map.push(text.length);
  return { folded, at: j => map[j] };
}

// The query's words, folded, or why it is refused.
export function parseSearchQuery(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'q is required' };
  const q = raw.trim();
  const chars = [...q].length;
  if (chars < SEARCH_Q_MIN) return { ok: false, error: `q must be at least ${SEARCH_Q_MIN} characters` };
  if (chars > SEARCH_Q_MAX) return { ok: false, error: `q must be at most ${SEARCH_Q_MAX} characters` };
  const terms = [...new Set(foldQuotes(q.toLowerCase()).split(/\s+/).filter(Boolean))];
  if (terms.length > SEARCH_TERMS_MAX) return { ok: false, error: `q must be at most ${SEARCH_TERMS_MAX} words` };
  return { ok: true, terms };
}

const isHigh = c => c >= 0xd800 && c <= 0xdbff;
const isLow = c => c >= 0xdc00 && c <= 0xdfff;

function snippetFor(text, f, terms, first) {
  const len = text.length;
  const start = f.at(first);
  let s = Math.max(0, start - SNIPPET_BEFORE);
  let e = Math.min(len, s + SNIPPET_CHARS);
  if (e - s < SNIPPET_CHARS) s = Math.max(0, e - SNIPPET_CHARS);
  // Never half a character: widen to take the whole pair.
  if (s > 0 && isLow(text.charCodeAt(s))) s--;
  if (e < len && isHigh(text.charCodeAt(e - 1))) e++;
  // The window starts at or before the earliest match of any word, so no occurrence
  // lies before it; one may run over its end, and is cut there.
  const spans = [];
  for (const term of terms) {
    for (let j = f.folded.indexOf(term); j !== -1; j = f.folded.indexOf(term, j + 1)) {
      const a = f.at(j), b = f.at(j + term.length);
      if (a >= e) break;
      spans.push([a - s, Math.min(b, e) - s]);
    }
  }
  spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const marks = [];
  for (const span of spans) {
    const last = marks[marks.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else if (marks.length < MARKS_MAX) marks.push([...span]);
  }
  return { snippet: text.slice(s, e).replace(/\s/g, ' '), marks, cutStart: s > 0, cutEnd: e < len };
}

// The messages of `list` (oldest first) that hold every term, newest first, at most
// `limit`, and whether more would have followed.
export function searchMessages(list, terms, { limit = SEARCH_LIMIT_DEFAULT } = {}) {
  const results = [];
  let more = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!SEARCHED_KINDS.has(m?.kind) || typeof m.text !== 'string') continue;
    const f = foldText(m.text);
    let first = Infinity;
    let all = true;
    for (const term of terms) {
      const j = f.folded.indexOf(term);
      if (j === -1) { all = false; break; }
      if (j < first) first = j;
    }
    if (!all) continue;
    if (results.length >= limit) { more = true; break; }
    results.push({ seq: m.seq, id: m.id, at: m.at, from: m.from, kind: m.kind, ...snippetFor(m.text, f, terms, first) });
  }
  return { results, more };
}

// The route's answer for a query string, or an HttpError(400).
export function searchAnswer(store, params, { scanMax = SEARCH_SCAN_MAX } = {}) {
  const parsed = parseSearchQuery(params.get('q'));
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const asked = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isInteger(asked) ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, asked)) : SEARCH_LIMIT_DEFAULT;
  const list = store.newest(scanMax);
  const { results, more } = searchMessages(list, parsed.terms, { limit });
  return { results, more, scanned: list.length, truncated: store.size > list.length, seq: store.seq, epoch: store.epoch };
}
