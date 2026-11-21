// The proactive check's rules and words (docs/design/2026-11-18-proactive-check.md).
//
// RULES holds every threshold: constants, not config, like the limit warnings' steps.
// checkHit keeps only the typed fields of a hit, each checked: a board id of an
// opaque shape, a priority, a lane, a whole number, a date, a name from config, a limit's
// fixed name, a key name that is a plain name. Anything else from outside (a board
// title, an ask's words, a launchd label, a log line) never passes, and a field that
// fails its check is said in generic words instead. proactiveText builds the event's
// words from checked hits only, and the events module (lib/events.mjs) checks each
// item again on its way out (any caller may hand it hits).
//
// Nothing here imports lib/events.mjs: that module imports this one.
import { resetWords, WEEKLY_STEPS } from './limit-warnings.mjs';

export const RULES = Object.freeze({
  // An open P0 or P1 item the check has seen unchanged this many days.
  staleDays: Object.freeze({ P0: 2, P1: 7 }),
  // An open item whose ask (its words and kind) has stood this many days.
  askDays: 3,
  // One launchd job failing on this many distinct runs, or one heal target healed this
  // many times, within repeatDays.
  repeatCount: 3,
  repeatDays: 14,
  // A weekly limit projected over this by its reset, once this share of the week is gone.
  weekProjectedPct: 100,
  weekMinElapsed: 0.25,
  // The session limit at this or more.
  sessionPct: 75,
  // A working Shortcut key this many days or fewer from its idle expiry.
  expiryDays: 7
});

// The order the rules are said in, the event's and the page's.
export const RULE_ORDER = Object.freeze(['due', 'ask', 'stale', 'fails', 'heals', 'week', 'session', 'expiry']);
// At most this many named per rule ("and N more"), and this many characters in all.
export const PER_RULE = 5;
export const TEXT_MAX = 1200;

// A board id the page may link to: only an opaque shape (Ultron's M1, 11-18: the board
// takes any non-empty id, and a plain-looking one such as
// "Jarvis-system-note.approve-pending-pairing" would reach the lead verbatim). A UUID
// (the page's and Jarvis's) or a 13-digit time and a short random part (the mod's
// fallback when randomUUID is missing). Any other id is "an item", and the page and the
// lead find it by its other fields. The 8-hex and short-number shapes went (Ultron's N1,
// 11-18): no writer makes them (only the empty board's seed numbers its three items).
// On 2026-11-19 every open live item was a UUID (226) or the mod's shape (17).
export const OPAQUE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{13}-[a-z0-9]{6,12})$/;
export const opaqueId = v => (typeof v === 'string' && OPAQUE_ID.test(v) ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How the lead's event says an id (Ultron's N1, 11-18): a UUID whole; the mod's shape by
// its 13-digit time only, since its random part may be up to 12 letters, enough for a
// word ("1763452800000-approvenowxx"). The page's view keeps the whole id for its link.
export const saidId = v => (typeof v !== 'string' ? null : UUID.test(v) ? v : OPAQUE_ID.test(v) ? v.slice(0, 13) : null);
// A name as it may be said: the events module's own rule (lib/events.mjs, SAFE_NAME).
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,59}$/;
// A limit's name as lib/limit-warnings.mjs's ruleFor makes it.
const LIMIT_NAME = /^(?:session|week \([A-Za-z0-9][A-Za-z0-9 .-]{0,23}\))$/;
const DAY_TEXT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const LANES = new Set(['idea', 'doing']);
const ASK_KINDS = new Set(['decide', 'do']);
const STALE_PRIORITIES = new Set(Object.keys(RULES.staleDays));

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const time = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const pick = (v, ok) => (ok(v) ? v : null);
const name = v => (typeof v === 'string' && SAFE_NAME.test(v) ? v : null);
const priority = v => pick(v, x => PRIORITIES.has(x));

// A hit's typed fields for its rule, each checked, or null when the hit is not one this
// module knows (an unknown rule, or a field the rule can't do without).
export function checkHit(h) {
  if (!isObject(h) || typeof h.rule !== 'string') return null;
  switch (h.rule) {
    case 'due':
      if (typeof h.due !== 'string' || !DAY_TEXT.test(h.due) || !whole(h.late, 1, 100000)) return null;
      return { rule: 'due', item: opaqueId(h.item), priority: priority(h.priority), due: h.due, late: h.late };
    case 'ask':
      if (!whole(h.days, RULES.askDays, 100000)) return null;
      return { rule: 'ask', item: opaqueId(h.item), priority: priority(h.priority), kind: pick(h.kind, x => ASK_KINDS.has(x)), days: h.days };
    case 'stale':
      if (!STALE_PRIORITIES.has(h.priority) || !LANES.has(h.lane) || !whole(h.days, RULES.staleDays[h.priority], 100000)) return null;
      return { rule: 'stale', item: opaqueId(h.item), priority: h.priority, lane: h.lane, days: h.days };
    case 'fails':
      if (!whole(h.count, RULES.repeatCount, 100000)) return null;
      return { rule: 'fails', job: name(h.job), count: h.count };
    case 'heals':
      if (!whole(h.count, RULES.repeatCount, 100000)) return null;
      return { rule: 'heals', target: name(h.target), count: h.count };
    case 'week':
      if (typeof h.limit !== 'string' || !LIMIT_NAME.test(h.limit) || h.limit === 'session' || !whole(h.projected, RULES.weekProjectedPct + 1, 100000)) return null;
      // `rateHours`: the span of the recent rate the projection rests on (lib/pace.mjs), in
      // whole hours; null for the straight line.
      return { rule: 'week', limit: h.limit, projected: h.projected, resetsAt: time(h.resetsAt), rateHours: whole(h.rateHours, 1, 10000) ? h.rateHours : null };
    case 'session':
      if (!whole(h.pct, RULES.sessionPct, 1000)) return null;
      return { rule: 'session', pct: h.pct, resetsAt: time(h.resetsAt) };
    case 'expiry':
      if (h.what !== 'shortcut-key' || time(h.expiresAt) === null || !whole(h.days, 0, RULES.expiryDays)) return null;
      return { rule: 'expiry', what: 'shortcut-key', name: name(h.name), expiresAt: h.expiresAt, days: h.days };
    default:
      return null;
  }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const resets = (at, now) => (at === null ? '' : `, resets ${resetWords(at, now)}`);
// An item with no opaque id is "an item", and its details say where to find it; one
// of the mod's shape is named by the time its id starts with.
const itemPart = (h, details) => {
  const said = saidId(h.item);
  if (said === null) return `an item (${details}; see Heads up)`;
  return said === h.item ? `${said} (${details})` : `the item whose id starts ${said} (${details})`;
};

// The words for one rule's hits (all of one rule, at least one), at most PER_RULE named.
function rulePart(rule, hits, now) {
  const shown = hits.slice(0, PER_RULE);
  const more = hits.length - shown.length;
  const tail = more > 0 ? `; and ${more} more` : '';
  const list = (head, part) => `${head}: ${shown.map(part).join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
  switch (rule) {
    case 'due':
      return list(`${plural(hits.length, 'board item')} past due`, h => itemPart(h, `${h.priority ?? 'no priority'}, due ${h.due}`));
    case 'ask':
      return list(`${plural(hits.length, 'ask')} waiting ${RULES.askDays}+ days`, h => itemPart(h, `${h.priority ?? 'no priority'}, ${h.kind ?? 'ask'}, ${h.days} d`));
    case 'stale':
      return list(`${plural(hits.length, 'P0/P1 item')} unchanged`, h => itemPart(h, `${h.priority}, ${h.lane}, ${h.days} d`));
    case 'fails':
      return shown.map(h => `job ${h.job ?? 'a launchd job'} failed ${h.count} times in ${RULES.repeatDays} days`).join('; ') + tail;
    case 'heals':
      return shown.map(h => `${h.target ?? 'a heal target'} healed ${h.count} times in ${RULES.repeatDays} days (a lasting fix is due)`).join('; ') + tail;
    case 'week':
      return shown.map(h => `Claude ${h.limit} projected at ${h.projected}% by its reset${h.rateHours === null ? '' : ` at the last ${h.rateHours} h rate`}${resets(h.resetsAt, now)}`).join('; ') + tail;
    case 'session':
      return shown.map(h => `Claude session at ${h.pct}%${resets(h.resetsAt, now)}`).join('; ') + tail;
    case 'expiry':
      return shown.map(h => `Shortcut key ${h.name ?? 'a Shortcut key'} stops working in ${plural(h.days, 'day')} unless used`).join('; ') + tail;
    default:
      return '';
  }
}

const MORE = '; and more on the page (Heads up)';

// One event's words for a batch of hits: "Heads up (N): " and one part per rule, in
// RULE_ORDER. Every hit is checked here; one that fails is left out and not counted.
// Cut at a rule's boundary to TEXT_MAX; null when no hit passes.
export function proactiveText(hits, { now = Date.now() } = {}) {
  const checked = (Array.isArray(hits) ? hits : []).map(checkHit).filter(Boolean);
  if (checked.length === 0) return null;
  const head = `Heads up (${checked.length}): `;
  const parts = RULE_ORDER
    .map(rule => checked.filter(h => h.rule === rule))
    .filter(list => list.length > 0)
    .map(list => rulePart(list[0].rule, list, now));
  let text = head + parts.join('; ');
  if (text.length <= TEXT_MAX) return text;
  // Whole parts while they fit with room for the closing words.
  text = head;
  let used = 0;
  for (const p of parts) {
    const next = `${text}${used ? '; ' : ''}${p}`;
    if (next.length + MORE.length > TEXT_MAX) break;
    text = next;
    used++;
  }
  // Not even the first part fits (it can't, with PER_RULE named): cut it.
  if (used === 0) text = (head + parts[0]).slice(0, TEXT_MAX - MORE.length);
  return text + MORE;
}

// ---- the idle wake-up (docs/design/2026-11-19-dynamic-projection-idle-wake.md) ----

const MIN_MS = 60e3;
// Its numbers: constants, like RULES. A wake-up goes when no agent run is live, the
// session limit is under `sessionPct`, every weekly limit is under `weekPct` (the limit
// warnings' weekly step) now and a day from now (`aheadMs`) at its pace, the board holds
// an open item with no ask, and all of that has held for `settleMs`. Whatever the lead's
// own session is doing (board 638d21d2, 11-20): a lead busy talking still gets the cue
// to start the next run.
//
// A day ahead, not the projection to the reset (board 8a13e971, 11-20): a busy day of
// runs puts the 24-hour rate up, so the projection to the reset passed 100% and the
// wake-up stopped itself for the rest of the day, with a third of the week left. The
// step a day ahead still closes the gate before a limit nears the step, a day early at
// the pace it is going.
//
// The spacing: `gapMs` after a wake-up a run followed (the cue worked, so the next may
// come once the board is idle again), `everyMs` after one no run followed, the wait
// doubling after each further one up to `backoffMax` times `everyMs`.
export const IDLE = Object.freeze({
  sessionPct: RULES.sessionPct,
  weekPct: WEEKLY_STEPS[0],
  aheadMs: 24 * 60 * MIN_MS,
  settleMs: 5 * MIN_MS,
  gapMs: 15 * MIN_MS,
  everyMs: 60 * MIN_MS,
  backoffMax: 4
});

// A wake-up's fields, each a whole number in its range, or null when one is not:
// `workable` open items with no ask, `p0` and `p1` of them, `doing` of them in that
// lane, the `session` percent, the highest weekly percent `week` and the highest
// weekly percent a day from now `ahead` (a wake-up always has both: with no weekly limit
// read there is none; Ultron's L1, 11-19; both said rounded, so up to the step itself),
// and `unanswered`, the wake-ups made since a run was last seen. No id, no word from
// the board.
export function checkIdle(f) {
  if (!isObject(f) || !whole(f.workable, 1, 100000)) return null;
  for (const k of ['p0', 'p1', 'doing']) if (!whole(f[k], 0, f.workable)) return null;
  if (!whole(f.session, 0, IDLE.sessionPct - 1) || !whole(f.unanswered, 0, 100000)) return null;
  if (!whole(f.ahead, 0, IDLE.weekPct) || !whole(f.week, 0, f.ahead)) return null;
  return { workable: f.workable, p0: f.p0, p1: f.p1, doing: f.doing, session: f.session, week: f.week, ahead: f.ahead, unanswered: f.unanswered };
}

// The wake-up's words: facts in a fixed order, numbers only; null for fields that fail.
export function idleText(fields) {
  const f = checkIdle(fields);
  if (!f) return null;
  const urgent = [f.p0 > 0 ? `${f.p0} P0` : null, f.p1 > 0 ? `${f.p1} P1` : null].filter(Boolean).join(', ');
  const detail = [urgent, f.doing > 0 ? `${f.doing} in doing` : ''].filter(Boolean).join('; ');
  return `Idle: no agent run is live. ${plural(f.workable, 'open board item')} ${f.workable === 1 ? 'has' : 'have'} no ask${detail ? ` (${detail})` : ''}. `
    + `Session at ${f.session}%; weekly limits at most ${f.week}% now and ${f.ahead}% a day from now at their pace.`
    + (f.unanswered > 0 ? ` ${plural(f.unanswered, 'idle event')} since the last run.` : '');
}
