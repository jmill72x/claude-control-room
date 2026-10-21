// The Orbit page's board logic: plain functions over the board's items, with no
// React and no DOM, so `node --test` checks them (web/test/orbit-board.test.js).
import { dueChip } from '../due.js';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const rank = p => (PRIORITIES.includes(p) ? PRIORITIES.indexOf(p) : PRIORITIES.length);
export const LANE_NAMES = { idea: 'Ideas', doing: 'Doing', done: 'Done' };
export const IDEAS_SHOWN = 8;
export const DONE_SHOWN = 8;
export const TITLE_MAX = 120;
const FALLBACK_MAX = 72;

const chars = s => Array.from(String(s ?? ''));
const tagKey = t => (typeof t === 'string' ? t.trim().toLowerCase() : '');

// ---- titles ----

// A card's title when the item has none of its own: the first sentence of its
// text, cut at a word boundary to 72 characters, with an ellipsis. A sentence
// ends at . ! or ? followed by a capital, a digit or the end, so "e.g. the" and
// "v1.2" don't end one. A title has no closing full stop.
export function firstSentence(text, max = FALLBACK_MAX) {
  const line = String(text ?? '').trim().split('\n')[0].trim();
  const m = /^(.+?[.!?])(?=\s+["'“([]?[A-Z0-9]|\s*$)/.exec(line);
  const sentence = (m ? m[1] : line).replace(/\.$/, '');
  const all = chars(sentence);
  if (all.length <= max) return sentence;
  const cut = all.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.—–-]+$/, '')}…`;
}

export function cardTitle(item) {
  const own = typeof item?.title === 'string' ? item.title.trim() : '';
  return own ? { text: own, fallback: false } : { text: firstSentence(item?.text), fallback: true };
}

// True when `text` opens with `title` as a sentence or a line of its own, so the
// detail can leave the repeat off. "Renew the domain before it lapses" doesn't
// repeat the title "Renew the domain": the sentence runs on.
function repeats(text, title) {
  const t = String(text ?? '').trim();
  if (!title || title.endsWith('…') || !t.startsWith(title)) return false;
  return /^([.!?:;—–]|\s*\n|\s*$)/.test(t.slice(title.length));
}

// The opened card's detail: the item's text, less a leading repeat of its title.
// Only the screen leaves it off; the text on disk keeps it.
export function cardDetail(item) {
  const text = String(item?.text ?? '').trim();
  const { text: title } = cardTitle(item);
  return repeats(text, title) ? text.slice(title.length).replace(/^[\s.!?:;,—–-]+/, '').trim() : text;
}

// ---- editing ----

// Text from a title and a detail: "Title. Detail", or the title alone.
export function joinTitleDetail(title, detail) {
  const t = String(title ?? '').trim();
  const d = String(detail ?? '').trim();
  if (!t) return d;
  if (!d) return t;
  return `${t}${/[.!?:]$/.test(t) ? '' : '.'} ${d}`;
}

// What Edit text starts with. Title edits `title`, Detail edits `text` and Area
// edits `tag`. When the text opens with the item's own title, Detail holds the
// rest, and a changed title or detail is put back together as "Title. Detail".
// An item with no title of its own starts with an empty Title (the fallback is
// only a placeholder), so saving an untouched form writes no title.
export function editFields(item) {
  const title = typeof item?.title === 'string' ? item.title.trim() : '';
  const repeat = repeats(item?.text, title);
  return { title, detail: repeat ? cardDetail(item) : String(item?.text ?? '').trim(), tag: item?.tag ?? '', repeat };
}

// The item after an edit, or null when nothing changed or nothing would be left
// of it: blanking every field never erases an item. Only what changed is
// touched, so a new area leaves the text exactly as it was on disk.
export function applyEdit(item, draft) {
  const start = editFields(item);
  const title = chars(String(draft?.title ?? '').trim()).slice(0, TITLE_MAX).join('');
  const detail = String(draft?.detail ?? '').trim();
  const tag = String(draft?.tag ?? '').trim();
  const wordsChanged = title !== start.title || detail !== start.detail;
  if (!wordsChanged && tag === String(start.tag).trim()) return null;
  let text = item.text;
  if (wordsChanged) text = (start.repeat ? joinTitleDetail(title, detail) : detail) || title;
  if (!String(text ?? '').trim()) return null;
  const { title: _old, ...rest } = item;
  return { ...rest, text, tag, ...(title ? { title } : {}) };
}

// A new item from the form: `title` from Title, and `text` from the title
// followed by the detail. No priority or date key unless one was picked.
export function newItem(form, id) {
  const title = chars(String(form?.title ?? '').trim()).slice(0, TITLE_MAX).join('');
  if (!title) return null;
  const item = { id, text: joinTitleDetail(title, form.detail), title, lane: form.lane === 'doing' ? 'doing' : 'idea', tag: String(form.tag ?? '').trim() };
  if (PRIORITIES.includes(form.priority)) item.priority = form.priority;
  if (form.due) item.due = form.due;
  return item;
}

// The board's priority, set from a chip; 'none' drops the key, the shape an item
// that was never ranked has.
export function withPriority(item, p) {
  const { priority: _old, ...rest } = item;
  return PRIORITIES.includes(p) ? { ...rest, priority: p } : rest;
}

// A due date is written only when one is picked; clearing drops the key.
export function withDue(item, due) {
  const { due: _old, ...rest } = item;
  return due ? { ...rest, due } : rest;
}

// The Area choices: the tags in use, most used first, so an item tagged with a
// rare tag keeps it when edited. The item's own tag is always offered.
export function areaOptions(items, current = '') {
  const counts = new Map();
  for (const t of items ?? []) {
    const tag = typeof t.tag === 'string' ? t.tag.trim() : '';
    if (!tag) continue;
    const k = tagKey(tag);
    const seen = counts.get(k);
    counts.set(k, { tag: seen?.tag ?? tag, n: (seen?.n ?? 0) + 1 });
  }
  const own = String(current ?? '').trim();
  if (own && !counts.has(tagKey(own))) counts.set(tagKey(own), { tag: own, n: 0 });
  return [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map(x => x.tag);
}

// ---- owners ----

// An item's owner: the agent it names, or else the agent whose area its tag is.
// null when neither says, and the card then shows a neutral initial.
export function ownerOf(item, roster) {
  if (typeof item?.owner === 'string' && item.owner) return item.owner;
  const owners = roster?.tagOwners ?? {};
  const k = tagKey(item?.tag);
  if (!k) return null;
  for (const [tag, key] of Object.entries(owners)) if (tagKey(tag) === k) return key;
  return null;
}

// The roster entry for a key, with its place in the roster (which picks its
// colour); a key the roster doesn't know gets index -1 and its key as a name.
export function agentOf(key, roster) {
  if (!key) return null;
  const agents = roster?.agents ?? [];
  const index = agents.findIndex(a => a.key === key);
  return index >= 0 ? { ...agents[index], index } : { key, name: key, index: -1 };
}

// ---- the summary band ----

export function boardTotals(items) {
  const list = items ?? [];
  const open = list.filter(t => t.lane !== 'done');
  const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0, none: 0 };
  for (const t of open) byPriority[PRIORITIES.includes(t.priority) ? t.priority : 'none'] += 1;
  return {
    open: open.length,
    doing: list.filter(t => t.lane === 'doing').length,
    done: list.filter(t => t.lane === 'done').length,
    byPriority
  };
}

// One chip per agent that owns an open item, the most open items first.
export function ownerChips(items, roster) {
  const counts = new Map();
  for (const t of items ?? []) {
    if (t.lane === 'done') continue;
    const key = ownerOf(t, roster);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (roster?.agents ?? [])
    .map((a, index) => ({ ...a, index, open: counts.get(a.key) ?? 0 }))
    .filter(a => a.open > 0)
    .sort((a, b) => b.open - a.open || a.index - b.index);
}

// ---- the lanes ----

const dueKey = t => (/^\d{4}-\d{2}-\d{2}$/.test(t.due ?? '') ? t.due : '9999-99-99');
const byPriority = (a, b) => rank(a.priority) - rank(b.priority) || dueKey(a).localeCompare(dueKey(b)) || a.order - b.order;
const byDueDate = (a, b) => dueKey(a).localeCompare(dueKey(b)) || rank(a.priority) - rank(b.priority) || a.order - b.order;
const doneTime = t => {
  const ms = Date.parse(t.doneAt ?? '');
  return Number.isFinite(ms) ? ms : null;
};

// What each lane shows under the owner and priority filters: Doing in full,
// Ideas' top 8 unless all are asked for, and Done's 8 finished most recently.
// Done items with a doneAt come first, newest first; those finished before it
// existed follow, the newest added first.
export function boardView(items, { owner = null, priority = null, sort = 'priority', ideasAll = false, roster = null } = {}) {
  const list = (items ?? []).map((t, order) => ({ ...t, order }));
  const passes = t => (!owner || ownerOf(t, roster) === owner)
    && (!priority || (priority === 'none' ? !PRIORITIES.includes(t.priority) : t.priority === priority));
  const strip = ({ order: _o, ...t }) => t;
  const sorter = sort === 'due' ? byDueDate : byPriority;
  const doing = list.filter(t => t.lane === 'doing' && passes(t)).sort(sorter);
  const ideas = list.filter(t => t.lane === 'idea' && passes(t)).sort(sorter);
  const done = list.filter(t => t.lane === 'done' && passes(t)).sort((a, b) => {
    const ta = doneTime(a), tb = doneTime(b);
    if (ta !== null && tb !== null) return tb - ta || b.order - a.order;
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    return b.order - a.order;
  });
  const shownIdeas = ideasAll ? ideas : ideas.slice(0, IDEAS_SHOWN);
  const open = list.filter(t => t.lane !== 'done');
  return {
    doing: doing.map(strip),
    ideas: { shown: shownIdeas.map(strip), total: ideas.length, more: ideas.length > IDEAS_SHOWN },
    done: { shown: done.slice(0, DONE_SHOWN).map(strip), total: done.length, older: Math.max(0, done.length - DONE_SHOWN) },
    showing: { open: open.filter(passes).length, total: open.length, filtered: Boolean(owner || priority) }
  };
}

// The priority filter: All, P1 to P3, and P0 or None only when an open item has one.
export function priorityFilters(items) {
  const { byPriority } = boardTotals(items);
  return [
    { key: null, label: 'All' },
    ...(byPriority.P0 > 0 ? [{ key: 'P0', label: 'P0' }] : []),
    { key: 'P1', label: 'P1' }, { key: 'P2', label: 'P2' }, { key: 'P3', label: 'P3' },
    ...(byPriority.none > 0 ? [{ key: 'none', label: 'None' }] : [])
  ];
}

// The move buttons on an opened card, the main one first.
export function moves(lane) {
  if (lane === 'idea') return [{ label: 'Start it', to: 'doing', main: true }, { label: 'Mark done', to: 'done', main: false }];
  if (lane === 'doing') return [{ label: 'Mark done', to: 'done', main: true }, { label: 'Back to ideas', to: 'idea', main: false }];
  return [{ label: 'Reopen', to: 'idea', main: false }];
}

// The card's due chip: today's rules (lib/due.js), as a tone the page colours.
export function dueLook(item, today) {
  const chip = dueChip(item?.due, item?.lane, today);
  return chip ? { label: chip.label, tone: chip.state, title: chip.title } : null;
}

// "Showing 12 of 86 open items, plus the done ones that match." / "All 86 open items."
export function showingLine({ open, total, filtered }) {
  return filtered
    ? `Showing ${open} of ${total} open item${total === 1 ? '' : 's'}, plus the done ones that match.`
    : `All ${total} open item${total === 1 ? '' : 's'}.`;
}
