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
// so a reading that dips under the step and comes back tells nothing twice.
//
// `/usage` prints a window's reset a minute apart from one poll to the next (5:29pm,
// then 5:30pm; every reset in three months of history sat within a minute of a
// 10-minute mark), so the window is named by its reset rounded to 10 minutes of local
// time. Keyed on the printed minute, one window would warn again on every flip.
//
// The words are built here from typed fields only (a fixed scope, a number, a clock
// time), and WARNING_BODY is their shape: the push and the event check a line against
// it before it leaves, so nothing else can travel as a limit warning.

export const SESSION_STEPS = Object.freeze([80, 95]);
export const WEEKLY_STEPS = Object.freeze([90]);
export const WINDOW_GRID_MIN = 10;
export const KIND = 'limit-step';

const SESSION_LABEL = 'Current session';
const WEEKLY_PREFIX = 'Weekly · ';
// What a weekly limit covers, as it may appear in a warning: "all models" or a model's
// name, plain ASCII and short. Anything else from the panel is said as "one model".
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const WARNING_BODY = /^Claude (?:session|week \([A-Za-z0-9][A-Za-z0-9 .-]{0,23}\)) at \d{1,4}%(?:, resets (?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?(?:[1-9]|1[0-2]):[0-5]\d [ap]m)?$/;

// The steps a limit warns at and how it is named, by the label lib/parse-usage.mjs
// gives it; null for a label with no steps.
export function ruleFor(label) {
  if (label === SESSION_LABEL) return { steps: SESSION_STEPS, name: 'session' };
  if (typeof label !== 'string' || !label.startsWith(WEEKLY_PREFIX)) return null;
  const who = label.slice(WEEKLY_PREFIX.length);
  return { steps: WEEKLY_STEPS, name: `week (${MODEL_NAME.test(who) ? who : 'one model'})` };
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
// rises, and 12 per limit in any 24 hours. Twelve is one more than a limit can
// honestly need: 24 hours touch at most six session windows of two steps each. A
// telling over a cap is put off, not dropped: it goes on the first pass that has room.
export const REPEAT_MS = 30 * 60e3;
export const DAILY_MAX = 12;
export const DAY_MS = 24 * 3600e3;
// A told key with no reset in it is kept this long (lib/push-alerts.mjs, prune): about
// one session window, so a reading that comes and goes is one telling.
export const NO_RESET_KEEP_MS = 5 * 3600e3;
// How many later passes try again a device the push service did not take a warning for.
export const DEVICE_RETRIES = 3;

// Whether `{ label, step }` may be told at `now`, given the tellings so far
// (`[{ at, label, step }]`, in any order): not when this limit was told at this step
// or a higher one in the last 30 minutes, nor when it has been told 12 times today.
export function mayTell(told, { label, step }, now) {
  const mine = (Array.isArray(told) ? told : []).filter(t => t?.label === label && now - t.at < DAY_MS);
  if (mine.length >= DAILY_MAX) return false;
  return !mine.some(t => now - t.at < REPEAT_MS && t.step >= step);
}

// "5:30 pm" for a reset later today, "Mon 7:00 pm" for another day, in local time.
export function resetWords(win, now) {
  const d = new Date(win), n = new Date(now);
  const h = d.getHours();
  const clock = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return today ? clock : `${DAYS[d.getDay()]} ${clock}`;
}

export const warningText = (name, pct, win, now) =>
  `Claude ${name} at ${pct}%${win === null ? '' : `, resets ${resetWords(win, now)}`}`;

// The warnings live now, from the usage panel's limits ({ label, pct, resetsAt }).
// `covers` are the keys of the lower steps this one has passed: told with it.
export function limitWarnings(limits, now = Date.now()) {
  const out = [];
  for (const l of Array.isArray(limits) ? limits : []) {
    const rule = ruleFor(l?.label);
    if (!rule || !Number.isFinite(l.pct)) continue;
    const reached = rule.steps.filter(step => l.pct >= step);
    if (reached.length === 0) continue;
    const win = windowOf(l.resetsAt);
    // A reading whose window has already ended says nothing about the one running now.
    if (win !== null && win <= now) continue;
    const keys = reached.map(step => warningKey(l.label, step, win));
    out.push({
      kind: KIND,
      key: keys.at(-1),
      covers: keys.slice(0, -1),
      text: warningText(rule.name, Math.round(l.pct), win, now),
      label: l.label,
      step: reached.at(-1),
      resetsAt: win
    });
  }
  return out;
}
