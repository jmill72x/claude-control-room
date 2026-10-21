// Waiting on you (Orbit plan, Phase 4): the count, the three tiles and the
// cards at the top of the Overview, and Jeff's own items on Next 24 hours.
// Plain functions over the board's items and the server's `toPush` panel,
// checked by web/test/orbit-waiting.test.js.
import { dayNumber } from '../due.js';
import { PRIORITIES, rank, cardTitle, ownerOf, agentOf } from './board.js';
import { clock, unavailable } from './page.js';

export const WAIT_SHOWN = 9;
export const DUE_SOON_DAYS = 7;
const DAY = 24 * 3600 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DUE = /^(\d{4})-(\d{2})-(\d{2})$/;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

// An open item waits on Jeff when it carries an ask: what he does, and whether
// it is a decision or a task. The server checks the shape on every write.
export const waits = t => Boolean(t) && t.lane !== 'done' && t.ask !== null && typeof t.ask === 'object'
  && text(t.ask.what) !== null && (t.ask.kind === 'decide' || t.ask.kind === 'do');

// "10 AM", "4:30 PM" from an ask's 24-hour "HH:MM"; null for none.
export function askTime(hhmm) {
  const m = HHMM.exec(String(hhmm ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}${m[2] === '00' ? '' : `:${m[2]}`} ${h < 12 ? 'AM' : 'PM'}`;
}

// When an item with an ask is due soon (its `due` within 7 days, or past): the
// card's chip and how loud it is. Dark (hot) when due today or tomorrow, or
// overdue. null when it has no date or the date is further out.
export function dueSoon(item, today) {
  const d = dayNumber(item?.due);
  const t = dayNumber(today);
  if (d === null || t === null) return null;
  const diff = d - t;
  if (diff > DUE_SOON_DAYS) return null;
  const weekday = WEEKDAYS[((d % 7) + 7 + 4) % 7]; // 1970-01-01 was a Thursday
  const time = askTime(item?.ask?.time);
  const at = time ? ` ${time}` : '';
  let chip;
  if (diff < 0) chip = `Overdue ${weekday} ${item.due.slice(5)}`;
  else if (diff === 0) chip = `Today${at}`;
  else if (diff === DUE_SOON_DAYS) chip = `Next ${weekday}${at}`; // today's weekday, a week on
  else chip = `${weekday}${at}`;
  return { chip, diff, look: diff <= 1 ? 'hot' : 'soon' };
}

// ---- To push ----

// A repo counts when its branch has an upstream and it has staged changes or
// commits the upstream doesn't have. A branch with no upstream never counts, so
// a build branch that is deliberately unpushed stays quiet (and a detached head
// never has one).
export const toPush = r => r?.state === 'ok' && r.upstream === true && ((r.staged ?? 0) > 0 || (r.ahead ?? 0) > 0);

function pushCard(r, roster) {
  const branch = r.branch ?? 'a branch with no name';
  const staged = r.staged ?? 0;
  const ahead = r.ahead ?? 0;
  const files = plural(staged, 'staged file', 'staged files');
  const commits = plural(ahead, 'commit', 'commits');
  const parts = [];
  if (staged > 0) parts.push(`${staged}${r.partial ? '+' : ''} staged`);
  if (ahead > 0) parts.push(`${commits} to push`);
  // The card states the facts and never asks for the go itself: a commit's go
  // answers a message that shows its status and diff stat (Ultron, 2026-10-21).
  const notYet = `The ${files} on ${branch} ${staged === 1 ? "isn't" : "aren't"} committed yet`;
  const gate = 'The commit waits for its status and diff stat, then your C&P.';
  let what;
  if (staged > 0 && ahead > 0) what = `${notYet}, and it is already ${commits} ahead. ${gate}`;
  else if (staged > 0) what = `${notYet}. ${gate}`;
  else what = `Push ${branch}: ${ahead === 1 ? "1 commit isn't" : `${ahead} commits aren't`} on its upstream yet.`;
  if ((r.behind ?? 0) > 0) what += ` It is also ${plural(r.behind, 'commit', 'commits')} behind, so it needs a pull first.`;
  return {
    key: `repo:${r.name}`,
    group: 'push',
    look: 'push',
    chip: staged > 0 ? 'Staged' : 'Push',
    title: `${r.name}: ${parts.join(', ')}`,
    what,
    why: "Until it's pushed, this work lives on one disk only.",
    owner: agentOf(r.owner, roster),
    fallback: r.name,
    meta: `${branch}${Number.isFinite(r.checkedAt) ? ` · checked ${clock(r.checkedAt)}` : ''}`,
    itemId: null
  };
}

// The To push tile from the server's `toPush` panel: its cards, whether its
// count is known, and the lines it adds when picked. A server from before this
// panel sends none at all.
export function pushView(env, roster) {
  if (!env) return { known: false, cards: [], notes: ["The server running now doesn't check the repos. That arrives with its next restart."] };
  const data = env.data;
  if (!data || !Array.isArray(data.repos)) return { known: false, cards: [], notes: [`To push: ${unavailable(env)}`] };
  if (data.configured === false) return { known: false, cards: [], notes: ['To push is not set up: config.json names no repos to check.'] };
  const repos = data.repos.filter(r => typeof r?.name === 'string');
  const cards = repos.filter(toPush).sort((a, b) => a.name.localeCompare(b.name)).map(r => pushCard(r, roster));
  const notes = [];
  if (env.status === 'stale') notes.push(`These are from an earlier check: ${env.error ?? 'the last one failed'}.`);
  const unread = repos.filter(r => r.state !== 'ok');
  if (unread.length > 0) notes.push(`Not read: ${unread.map(r => `${r.name} (${r.why ?? 'could not be read'})`).join('; ')}.`);
  const quiet = repos.filter(r => r.state === 'ok' && r.upstream !== true);
  if (quiet.length > 0) {
    notes.push(`Not counted, with no upstream to push to: ${quiet.map(r => `${r.name} on ${r.detached ? 'a detached head' : r.branch ?? 'a branch with no name'}`).join(', ')}.`);
  }
  return { known: true, cards, notes };
}

// ---- the cards ----

function itemCard(t, order, roster, soon) {
  const pri = PRIORITIES.includes(t.priority) ? t.priority : null;
  const tag = text(t.tag);
  return {
    key: `item:${t.id}`,
    group: soon ? 'due' : 'decide',
    look: soon ? soon.look : 'decide',
    chip: soon ? soon.chip : t.ask.kind === 'decide' ? 'Decide' : 'Do',
    title: cardTitle(t).text || '(no text)',
    what: text(t.ask.what),
    why: text(t.ask.why),
    owner: agentOf(ownerOf(t, roster), roster),
    fallback: tag ?? '',
    meta: `${pri ?? 'No priority'} · ${tag ?? 'No area'}`,
    itemId: String(t.id),
    sort: { diff: soon?.diff ?? 0, time: HHMM.test(t.ask.time ?? '') ? t.ask.time : '99:99', rank: rank(pri), lane: t.lane === 'doing' ? 0 : 1, order }
  };
}

// Every card, by tile. Due soon: the soonest first (an overdue item before
// all), then by the ask's time and priority. Decide or do: by priority, the
// ones in Doing first. To push: by repo name.
export function waitingCards({ items, today, roster, toPushEnv }) {
  const due = [];
  const decide = [];
  (Array.isArray(items) ? items : []).forEach((t, order) => {
    if (!waits(t)) return;
    const soon = dueSoon(t, today);
    (soon ? due : decide).push(itemCard(t, order, roster, soon));
  });
  due.sort((a, b) => a.sort.diff - b.sort.diff || a.sort.time.localeCompare(b.sort.time) || a.sort.rank - b.sort.rank || a.sort.order - b.sort.order);
  decide.sort((a, b) => a.sort.rank - b.sort.rank || a.sort.lane - b.sort.lane || a.sort.order - b.sort.order);
  const push = pushView(toPushEnv, roster);
  return { due, decide, push: push.cards, pushKnown: push.known, pushNotes: push.notes };
}

const TILE_WORDS = { due: 'due soon', decide: 'to decide or do', push: 'to push' };

// What the panel shows: the count, the tiles, and the cards of the picked tile
// (or all of them: due soon, then to push, then decide or do), the first 9
// unless all are asked for.
export function waitingView(cards, { filter = null, all = false } = {}) {
  const total = cards.due.length + cards.decide.length + cards.push.length;
  const list = filter === 'due' ? cards.due : filter === 'decide' ? cards.decide : filter === 'push' ? cards.push : [...cards.due, ...cards.push, ...cards.decide];
  const shown = all ? list : list.slice(0, WAIT_SHOWN);
  const capped = shown.length < list.length;
  // Without a To push reading its count is unknown, never a zero: the tile
  // shows a dash, and its notes (pushView) say why.
  const unknown = filter === 'push' && !cards.pushKnown;
  let showing;
  if (unknown) showing = `To push is unknown. Tap the tile again for all ${total}.`;
  else if (filter) showing = `Showing ${shown.length}${capped ? ` of ${list.length}` : ''} ${TILE_WORDS[filter]}. Tap the tile again for all ${total}.`;
  else showing = capped ? `Showing ${shown.length} of ${total}.` : `Showing all ${total}.`;
  return {
    total,
    tiles: [
      { id: 'due', label: 'Due soon', n: cards.due.length },
      { id: 'decide', label: 'Decide or do', n: cards.decide.length },
      { id: 'push', label: 'To push', n: cards.pushKnown ? cards.push.length : null }
    ],
    shown,
    more: capped ? list.length : 0,
    fewer: all && list.length > WAIT_SHOWN,
    showing,
    empty: shown.length > 0 || unknown ? null : !filter && !cards.pushKnown ? EMPTY.board : EMPTY[filter ?? 'all']
  };
}

const EMPTY = {
  all: 'Nothing is waiting on you.',
  board: 'Nothing on the board is waiting on you.',
  due: 'Nothing that waits on you is due in the next 7 days.',
  decide: 'No decision or task is waiting on you.',
  push: 'Nothing is staged to commit, and nothing is waiting to be pushed.'
};

// ---- Next 24 hours ----

// "You: <title>" for each item that waits on Jeff whose `due` date and ask's
// time fall within the next 24 hours, in the viewer's local time.
export function youEvents(items, now) {
  const end = now + DAY;
  const out = [];
  for (const t of Array.isArray(items) ? items : []) {
    if (!waits(t)) continue;
    const d = DUE.exec(String(t.due ?? ''));
    const h = HHMM.exec(String(t.ask.time ?? ''));
    if (!d || !h) continue;
    const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(h[1]), Number(h[2])).getTime();
    if (at > now && at <= end) out.push({ t: at, name: `You: ${cardTitle(t).text}`, owner: null, kind: 'you' });
  }
  return out;
}
