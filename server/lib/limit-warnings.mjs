// Limit warnings: a push before a Claude limit runs out.
//
// The alert bar's `limit` line (lib/alerts.mjs, config's `warnThreshold`) says a limit
// is high and reached only ntfy and #pepper. These are the steps that reach the paired
// devices too (lib/chat-push.mjs) and the lead (lib/events.mjs): the session limit at
// 80% and at 95%, each weekly limit at 90%. One alert per limit, named by the highest
// step it has reached, so a jump past two steps is one message.
//
// Each step is told once per window. The key holds the window's reset time, and the
// notifier keeps a told key until that time has passed (lib/push-alerts.mjs, prune),
// so a reading that dips under the step and comes back tells nothing twice. A limit
// read under RESET_BELOW_PCT has been reset, whatever its printed time says, and its
// told keys are forgotten then, so the window that follows can warn.
//
// `/usage` prints a window's reset a minute apart from one poll to the next (5:29pm,
// then 5:30pm; every reset in three months of history sat within a minute of a
// 10-minute mark), so the window is named by its reset rounded to 10 minutes of local
// time. Keyed on the printed minute, one window would warn again on every flip.
//
// The words are built here from typed fields only (a fixed scope, a number, a clock
// time), and WARNING_BODY is their shape: the push and the event check a line against
// it before it leaves, so nothing else can travel as a limit warning.
//
// At 100% (FULL_STEP) a limit that stops the lead says so in fixed words instead
// (board 1e2d7926, Ultron's 11-19 M5): "Jarvis is at the session limit until 5:30 pm".
// Only the session and "Weekly · all models" have that step: a model's own weekly limit
// stops only the runs on that model, and the lead runs on the default model. The full
// line is pushed to the devices and posted to #jarvis, never made an event (the lead is
// the one at the limit); once every limit that was full has reset, one fixed line,
// BACK_TEXT, goes to the devices and one event asks the lead to look for what came in
// meanwhile (collectors/notifier.mjs). FULL_BODY is the full line's shape, and
// isLimitPush what the push lets through: a step's line, a full line or BACK_TEXT.

export const SESSION_STEPS = Object.freeze([80, 95]);
export const WEEKLY_STEPS = Object.freeze([90]);
export const FULL_STEP = 100;
export const WINDOW_GRID_MIN = 10;
export const KIND = 'limit-step';

const SESSION_LABEL = 'Current session';
const WEEKLY_PREFIX = 'Weekly · ';
// The weekly limit that covers every model: at 100% the lead stops, whatever he runs on.
const WEEKLY_ALL = 'Weekly · all models';
// What a weekly limit covers, as it may appear in a warning: "all models" or a model's
// name, plain ASCII and short. Anything else from the panel is said as "one model".
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const WARNING_BODY = /^Claude (?:session|week \([A-Za-z0-9][A-Za-z0-9 .-]{0,23}\)) at \d{1,4}%(?:, resets (?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?(?:[1-9]|1[0-2]):[0-5]\d [ap]m)?$/;
export const FULL_BODY = /^Jarvis is at the (?:session|weekly) limit(?: until (?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]), )?(?:[1-9]|1[0-2]):[0-5]\d [ap]m)?$/;
export const BACK_TEXT = 'Jarvis is back under the limit';
// What the devices' push may carry as a limit line: nothing else is sent.
export const isLimitPush = body => typeof body === 'string' && (WARNING_BODY.test(body) || FULL_BODY.test(body) || body === BACK_TEXT);

// The steps a limit warns at and how it is named, by the label lib/parse-usage.mjs
// gives it; null for a label with no steps. `full` names the limit as the full line
// says it, for a limit whose 100% stops the lead; null for the others.
export function ruleFor(label) {
  if (label === SESSION_LABEL) return { steps: SESSION_STEPS, name: 'session', full: 'session' };
  if (typeof label !== 'string' || !label.startsWith(WEEKLY_PREFIX)) return null;
  const who = label.slice(WEEKLY_PREFIX.length);
  return { steps: WEEKLY_STEPS, name: `week (${MODEL_NAME.test(who) ? who : 'one model'})`, full: label === WEEKLY_ALL ? 'weekly' : null };
}

// A window's name: its reset time in milliseconds, rounded to 10 minutes of local
// time; null when the reading has no reset.
export function windowOf(resetsAt) {
  const t = typeof resetsAt === 'string' ? Date.parse(resetsAt) : resetsAt;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setMinutes(Math.round(d.getMinutes() / WINDOW_GRID_MIN) * WINDOW_GRID_MIN, 0, 0);
  return d.getTime();
}

export const warningKey = (label, step, win) => `${KIND}:${label}:${step}:${win ?? '-'}`;

// What a warning's key names: its limit, its step and its window's reset (null for a
// reading that had none); null for any other key.
export function keyParts(key) {
  const m = typeof key === 'string' ? key.match(/^limit-step:(.*):(\d+):(\d+|-)$/) : null;
  return m ? { label: m[1], step: Number(m[2]), window: m[3] === '-' ? null : Number(m[3]) } : null;
}
export const keyWindow = key => keyParts(key)?.window ?? null;

// ---- the backstop (the notifier keeps the list; collectors/notifier.mjs) ----
//
// The keys above tell each step once per window. These caps hold whatever the keys
// miss (a reset time that starts to move off its 10-minute mark, a reading with no
// reset that comes and goes): one telling per limit in 30 minutes unless its step
// rises, and at most six tellings a step in any 24 hours, for the steps that limit has
// (dailyMax): 18 for the session (80%, 95% and the full step), 12 for the all-models week
// (90% and full), 6 for a model's week (90%). Six because 24 hours touch at most six
// session windows: exactly what the session can honestly need, and room to spare for a
// week (Ultron's 11-20 L5: one 18 for every limit would let a weekly limit flap that
// often). A telling over a cap is put off, not dropped: it goes on the first pass that
// has room.
export const REPEAT_MS = 30 * 60e3;
export const DAILY_WINDOWS = 6;
export const DAY_MS = 24 * 3600e3;
// A told key with no reset in it is kept this long (lib/push-alerts.mjs, prune): about
// one session window, so a reading that comes and goes is one telling.
export const NO_RESET_KEEP_MS = 5 * 3600e3;
// A told key, with a reset time in it or without, is forgotten once its limit is read
// under this: the limit has been reset, and the key would hide the next window's
// warning. With no reset time every window has the one key; with one, a limit reset
// before its printed time keeps the old key's window (once in 85,254 readings,
// 2026-10-19). Half the lowest step: in the history no limit that had reached a step
// was read this low again inside the same window, but for that early reset. A dip
// that stays at or over it forgets nothing.
export const RESET_BELOW_PCT = 40;
// How many later tries a device gets that the push service did not take a warning for,
// and how far apart at least: two passes can be seconds apart (one follows each usage
// poll, one runs on the notifier's own timer), and a push service that is down for a
// moment is still down a second later.
export const DEVICE_RETRIES = 3;
export const DEVICE_RETRY_GAP_MS = 4 * 60e3;

// The limits read under RESET_BELOW_PCT now, by label: those whose window has reset.
// From the readings given and nothing else: never from the history of readings.
export function resetLabels(limits) {
  return new Set((Array.isArray(limits) ? limits : []).filter(l => Number.isFinite(l?.pct) && l.pct < RESET_BELOW_PCT).map(l => l.label));
}

// A limit's tellings allowed in any 24 hours: six for each of its steps, the full step
// counted; none for a label with no steps.
export function dailyMax(label) {
  const rule = ruleFor(label);
  return rule ? DAILY_WINDOWS * (rule.steps.length + (rule.full ? 1 : 0)) : 0;
}

// Whether `{ label, step }` may be told at `now`, given the tellings so far
// (`[{ at, label, step }]`, in any order): not when this limit was told at this step
// or a higher one in the last 30 minutes, nor when it has had its day's tellings.
export function mayTell(told, { label, step }, now) {
  const mine = (Array.isArray(told) ? told : []).filter(t => t?.label === label && now - t.at < DAY_MS);
  if (mine.length >= dailyMax(label)) return false;
  return !mine.some(t => now - t.at < REPEAT_MS && t.step >= step);
}

const clockOf = d => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
const sameDay = (d, n) => d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();

// "5:30 pm" for a reset later today, "Mon 7:00 pm" for another day, in local time.
export function resetWords(win, now) {
  const d = new Date(win);
  return sameDay(d, new Date(now)) ? clockOf(d) : `${DAYS[d.getDay()]} ${clockOf(d)}`;
}

// The full line's time: "5:30 pm" today, "Mon Nov 23, 7:00 pm" on another day (the
// date too, since a weekly reset can be most of a week away), in local time.
export function untilWords(win, now) {
  const d = new Date(win);
  return sameDay(d, new Date(now)) ? clockOf(d) : `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${clockOf(d)}`;
}

export const warningText = (name, pct, win, now) =>
  `Claude ${name} at ${pct}%${win === null ? '' : `, resets ${resetWords(win, now)}`}`;
// The full line: which limit, and until when (nothing when the reading has no reset).
export const fullText = (full, win, now) =>
  `Jarvis is at the ${full} limit${win === null ? '' : ` until ${untilWords(win, now)}`}`;

// The warnings live now, from the usage panel's limits ({ label, pct, resetsAt }).
// `covers` are the keys of the lower steps this one has passed: told with it. A full
// one (`full: true`, a limit that stops the lead read at 100% or more) has the full
// line for its text and goes to #jarvis (`feed`) where the others go to #pepper.
export function limitWarnings(limits, now = Date.now()) {
  const out = [];
  for (const l of Array.isArray(limits) ? limits : []) {
    const rule = ruleFor(l?.label);
    if (!rule || !Number.isFinite(l.pct)) continue;
    const reached = rule.steps.filter(step => l.pct >= step);
    if (rule.full && l.pct >= FULL_STEP) reached.push(FULL_STEP);
    if (reached.length === 0) continue;
    const win = windowOf(l.resetsAt);
    // A reading whose window has already ended says nothing about the one running now.
    if (win !== null && win <= now) continue;
    const keys = reached.map(step => warningKey(l.label, step, win));
    const full = reached.at(-1) === FULL_STEP;
    out.push({
      kind: KIND,
      key: keys.at(-1),
      covers: keys.slice(0, -1),
      text: full ? fullText(rule.full, win, now) : warningText(rule.name, Math.round(l.pct), win, now),
      label: l.label,
      step: reached.at(-1),
      resetsAt: win,
      ...(full ? { full: true, feed: 'jarvis' } : {})
    });
  }
  return out;
}

// ---- after the full line: back under the limit (collectors/notifier.mjs) ----
//
// The notifier keeps `out`, by label, the limits told full and not yet read reset
// (`{ win, at }`: the told window, null when the reading had no reset, and when it was
// told). A limit is back when this pass reads it under FULL_STEP and its window has
// turned over: the told reset has passed, or the reading names another window, or it
// is read under RESET_BELOW_PCT (an early reset, or a told window with no reset time).
// A reading of no window (no reset time, or one that did not parse) names no other
// window: only the mark or the told reset's passing can say it is back (Ultron's 11-20
// L2). A reading that dips to 99% inside the told window is not back: none has been
// seen in the history, but "back" followed by silence would be worse than waiting for
// the reset.
// A limit with no reading this pass waits. One kept longer than OUT_MAX_MS (a week and
// a day: the longest window is a week) is dropped without a word: a back line that late
// says nothing true.
export const OUT_MAX_MS = 8 * DAY_MS;
export function backFrom(out, limits, now) {
  const readings = new Map((Array.isArray(limits) ? limits : []).filter(l => typeof l?.label === 'string').map(l => [l.label, l]));
  const still = {}, back = [], dropped = [];
  for (const [label, told] of Object.entries(out ?? {})) {
    if (now - told.at >= OUT_MAX_MS) { dropped.push(label); continue; }
    const l = readings.get(label);
    const win = windowOf(l?.resetsAt);
    const turned = Number.isFinite(l?.pct) && l.pct < FULL_STEP
      && (l.pct < RESET_BELOW_PCT || (told.win !== null && (now >= told.win || (win !== null && win !== told.win))));
    if (turned) back.push(label);
    else still[label] = told;
  }
  return { still, back, dropped };
}

// Whether any limit with a full step reads at it now: then nobody is back, whatever
// `out` says (Ultron's 11-20 L1: a full line that failed to send is in no `out`).
export const fullNow = limits => (Array.isArray(limits) ? limits : []).some(l => ruleFor(l?.label)?.full && Number.isFinite(l.pct) && l.pct >= FULL_STEP);
