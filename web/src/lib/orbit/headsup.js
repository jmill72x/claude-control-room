// Heads up on the Overview (the proactive check, board a77b4757;
// docs/design/2026-11-18-proactive-check.md): what the page makes of GET /api/proactive
// (server/lib/proactive.mjs, view). Read-only. The answer is checked again here, hit
// by hit, so one bad entry is left out rather than shown broken. A board hit carries
// the item's id only; its title comes from the board the page already has. Checked
// by web/test/orbit-headsup.test.js.
import { ago } from './page.js';
import { cardTitle } from './board.js';

export const HEADS_POLL_MS = 60_000;
export const RULE_ORDER = ['due', 'ask', 'stale', 'fails', 'heals', 'week', 'session', 'expiry'];
// A board title longer than this is cut on the row (the board has the rest).
export const TITLE_CHARS = 90;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const whole = v => Number.isInteger(v) && v >= 0;
const text = v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cut = s => { const c = Array.from(s); return c.length > TITLE_CHARS ? `${c.slice(0, TITLE_CHARS - 1).join('')}…` : s; };

// The rules' numbers the server sent, or the ones it was built with.
const DEFAULT_RULES = { staleDays: { P0: 2, P1: 7 }, askDays: 3, repeatCount: 3, repeatDays: 14, sessionPct: 75, expiryDays: 7 };
const rulesOf = answer => ({ ...DEFAULT_RULES, ...(isObject(answer?.rules) ? answer.rules : {}) });

// "Nov 17" from "2026-11-17", read as a plain date (never through Date's UTC parse).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayWords(day) {
  const m = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// A board item's name on a row: its title from the board, else "Item <id>".
function itemName(id, byId) {
  const item = id !== null ? byId.get(id) : undefined;
  if (item) {
    const t = cardTitle(item).text;
    if (text(t)) return cut(text(t));
  }
  return id !== null ? `Item ${id}` : 'A board item';
}

// Where a hit stands: sent, waiting for 07:00, or not sent (no events path, the events'
// caps or kill switch). "Sent" is handed to the events path, not read by Jarvis.
export function stateWords(h, now) {
  if (h.silent && Number.isFinite(h.toldAt)) return 'sent by the limit warning';
  if (Number.isFinite(h.toldAt)) return `sent ${ago(now - h.toldAt)}`;
  if (Number.isFinite(h.heldAt)) return 'waits for 07:00';
  return 'not sent yet';
}

// A hit whose source the server could not read on its last check: the row is from an
// earlier read, and says so. Only an explicit false marks it (an older server sends none).
export function staleWords(h, now) {
  if (h.current !== false) return null;
  return Number.isFinite(h.readAt) ? `as of ${ago(now - h.readAt)}, not read since` : 'not current';
}

// One row, or null for a hit this page doesn't know or can't read.
export function rowOf(h, { byId = new Map(), rules = DEFAULT_RULES, now }) {
  // An unknown rule falls to the switch's default (null).
  if (!isObject(h) || typeof h.id !== 'string') return null;
  const item = typeof h.item === 'string' && h.item !== '' ? h.item : null;
  const old = staleWords(h, now);
  const base = { key: h.id, rule: h.rule, itemId: null, stale: old !== null, state: old !== null ? `${old} · ${stateWords(h, now)}` : stateWords(h, now) };
  switch (h.rule) {
    case 'due': {
      const day = dayWords(h.due);
      if (!day || !whole(h.late)) return null;
      return { ...base, mark: '!', tone: 'bad', itemId: item, name: itemName(item, byId), line: `past due: due ${day}, ${plural(h.late, 'day')} late${h.priority ? ` · ${h.priority}` : ''}` };
    }
    case 'ask':
      if (!whole(h.days)) return null;
      return { ...base, mark: '?', tone: 'warn', itemId: item, name: itemName(item, byId), line: `an ask${h.kind ? ` (${h.kind})` : ''} waiting ${plural(h.days, 'day')}${h.priority ? ` · ${h.priority}` : ''}` };
    case 'stale':
      if (!whole(h.days) || typeof h.priority !== 'string') return null;
      return { ...base, mark: '~', tone: 'warn', itemId: item, name: itemName(item, byId), line: `${h.priority} unchanged for ${plural(h.days, 'day')}${h.lane ? ` · ${h.lane}` : ''}` };
    case 'fails':
      if (!whole(h.count)) return null;
      return { ...base, mark: '×', tone: 'bad', name: text(h.job) ?? 'A launchd job', line: `failed ${h.count} times in ${rules.repeatDays} days` };
    case 'heals':
      if (!whole(h.count)) return null;
      return { ...base, mark: '↻', tone: 'warn', name: text(h.target) ?? 'A heal target', line: `healed ${h.count} times in ${rules.repeatDays} days: a lasting fix is due` };
    case 'week':
      if (!whole(h.projected) || !text(h.limit)) return null;
      // `rateHours`: the span of the recent rate the projection rests on, when it does.
      return { ...base, mark: '%', tone: 'warn', name: `Claude ${h.limit}`, line: `projected at ${h.projected}% by its reset${whole(h.rateHours) && h.rateHours > 0 ? ` at the last ${h.rateHours} h rate` : ''}` };
    case 'session':
      if (!whole(h.pct)) return null;
      return { ...base, mark: '%', tone: 'warn', name: 'Claude session', line: `at ${h.pct}%` };
    case 'expiry':
      if (!whole(h.days)) return null;
      return { ...base, mark: '◔', tone: 'warn', name: `Shortcut key ${text(h.name) ?? '(unnamed)'}`, line: `stops working in ${plural(h.days, 'day')} unless used` };
    default:
      return null;
  }
}

// The section, or null when there is nothing to show: the check off, killed or unset,
// no hits, or an answer that isn't one. Rows in the rules' order, as the server sent.
export function headsUpView(answer, { todos = [], now }) {
  if (!isObject(answer) || answer.status !== 'on' || !Array.isArray(answer.hits)) return null;
  const byId = new Map((Array.isArray(todos) ? todos : []).filter(isObject).map(t => [String(t.id), t]));
  const rules = rulesOf(answer);
  const order = new Map(RULE_ORDER.map((r, i) => [r, i]));
  const rows = answer.hits.map(h => rowOf(h, { byId, rules, now })).filter(Boolean)
    .sort((a, b) => order.get(a.rule) - order.get(b.rule));
  if (rows.length === 0) return null;
  const parts = [plural(rows.length, 'heads-up')];
  if (Number.isFinite(answer.checkedAt)) parts.push(`checked ${ago(now - answer.checkedAt)}`);
  if (answer.quiet?.now === true) parts.push('quiet hours: new ones wait for 07:00');
  if (answer.events === false) parts.push('Jarvis is not told while the chat is off');
  return { rows, sub: parts.join(' · ') };
}
