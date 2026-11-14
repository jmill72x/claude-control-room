// The merged home screen (board f74ca819, 2026-11-14): eleven Overview sections become
// five. Plain functions for the order, the Agents card's tabs, the Usage card's fold,
// Today's schedule and where the loops go, checked by web/test/orbit-home.test.js.
// The panels' own logic stays where it was (agents.js, live.js, overview.js,
// routines.js, loops.js); nothing here changes what any of them shows.
import { compactTokens } from './page.js';
import { hasOpen, loopsView } from './loops.js';
import { routinesSummary } from './routines.js';

// ---- the order ----

// Needs you, the Agents card, Usage, Today's schedule, and Loops only while a loop is
// open. With none open, the loops' state is one line at the foot of Today's schedule.
export function homeSections(loops) {
  const keys = ['waiting', 'usage', 'schedule', 'agents'];
  if (hasOpen(loops)) keys.push('loops');
  return keys;
}

// ---- the Agents card: Now, Today, Recent ----

// Now: the live agents with their Stop buttons (war room). Today: the lanes and the
// work map. Recent: the latest runs. Now is where the card opens.
export const AGENT_TABS = [
  { key: 'now', label: 'Now' },
  { key: 'today', label: 'Today' },
  { key: 'recent', label: 'Recent' }
];
export const DEFAULT_AGENT_TAB = 'now';
export const agentTab = v => (AGENT_TABS.some(t => t.key === v) ? v : DEFAULT_AGENT_TAB);

// Each tab's words: "Now · 3" while three run, "Today · 6" for six runs today. A count
// the page doesn't have (a server from before the live agents, no runs block) is left
// off, never shown as 0.
export function agentTabLabels({ live, todayTotal }) {
  const running = live && Array.isArray(live.runs)
    ? live.runs.length + (Number.isFinite(live.more) ? live.more : 0)
    : null;
  const counts = { now: running, today: Number.isFinite(todayTotal) ? todayTotal : null, recent: null };
  return AGENT_TABS.map(t => ({ ...t, count: counts[t.key], text: counts[t.key] === null ? t.label : `${t.label} · ${counts[t.key]}` }));
}

// The keys of the WAI-ARIA tabs pattern: the arrows move along the tabs and wrap round,
// Home and End go to the ends. Any other key is not the tabs' (null).
export function tabAfterKey(current, key) {
  const keys = AGENT_TABS.map(t => t.key);
  const i = Math.max(0, keys.indexOf(current));
  switch (key) {
    case 'ArrowRight': return keys[(i + 1) % keys.length];
    case 'ArrowLeft': return keys[(i - 1 + keys.length) % keys.length];
    case 'Home': return keys[0];
    case 'End': return keys[keys.length - 1];
    default: return null;
  }
}

// ---- the Usage card's fold ----

// The button under the rings. Closed, it carries the last hour's tokens, so the number
// Burn led with is still on the first screen; open, it says how to close.
export function usageFoldLabel(open, hourly) {
  if (open) return 'Hide burn and hour by hour';
  return Number.isFinite(hourly?.lastHour)
    ? `Burn: ${compactTokens(hourly.lastHour)} tokens in the last hour · hour by hour`
    : 'Burn and hour by hour';
}

// ---- folds remembered per viewer ----

// Open or closed, kept in this browser only. Storage can be missing or throw (a private
// window, blocked site data), so every touch is guarded and a fold reads closed then.
export const FOLD_KEYS = { usage: 'ccr.orbit.usage-more', loops: 'ccr.orbit.loops-more' };
export function readFold(storage, key) {
  try { return storage?.getItem(key) === 'open'; } catch { return false; }
}
export function writeFold(storage, key, open) {
  try { storage?.setItem(key, open ? 'open' : 'closed'); } catch { /* a per-viewer convenience only */ }
}

// ---- Today's schedule: Today's routines and Next 24 hours in one card ----

// "2 ran · 2 due · 5 in the next 24 h": the routines' own summary, then the timeline's
// count, which also holds limit resets and the items waiting on you.
export function scheduleSub({ routines, events, cronsUnavailable }) {
  const ahead = Array.isArray(events) ? events.length : 0;
  const next = `${ahead} in the next 24 h`;
  if (cronsUnavailable) return next;
  const today = routinesSummary(routines);
  return `${today.replace(/\.$/, '')} · ${next}`;
}

// The loops' one line at the foot of Today's schedule while none is open: the status
// chip's words and the panel's own summary. Null when a loop is open (it has its own
// section then) or the server sends no loops at all.
export function loopsLine(loops, now) {
  if (hasOpen(loops)) return null;
  const v = loopsView(loops, now);
  return v ? `${v.chip.label} · ${v.sub}` : null;
}
