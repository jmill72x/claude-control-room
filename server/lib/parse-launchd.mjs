import { formatSchedule } from './humanize.mjs';

export function parseLaunchctlList(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\t+|\s{2,}/);
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, label] = parts;
    if (label === 'Label' || !label) continue;
    map.set(label, {
      pid: pidRaw === '-' ? null : Number(pidRaw),
      status: statusRaw === '-' ? null : Number(statusRaw)
    });
  }
  return map;
}

const has = v => Number.isInteger(v);

// launchd treats every OMITTED StartCalendarInterval key as a wildcard, so
// `{Minute: 30}` means hourly at :30 — not "00:30 daily", which is what
// defaulting Hour to 0 produced (and which made the countdown wrong by up to
// 24 hours). Walk forward from now to the first moment matching every key that
// IS specified, skipping whole months, days or hours that cannot match, so even
// a once-a-year job costs a few hundred iterations rather than half a million.
export function nextRun(cal, now) {
  if (Array.isArray(cal)) {
    // Array form: the job fires at whichever entry comes first.
    const times = cal.map(c => nextRun(c, now)).filter(t => t !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }
  if (!cal || typeof cal !== 'object') return null;
  const { Minute, Hour, Weekday, Day, Month } = cal;
  if (![Minute, Hour, Weekday, Day, Month].some(has)) return null;

  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // never return a moment that has already passed
  const limit = now + 400 * 24 * 3600 * 1000;

  while (d.getTime() <= limit) {
    if (has(Month) && d.getMonth() + 1 !== Month) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (has(Day) && d.getDate() !== Day) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (has(Weekday) && d.getDay() !== Weekday) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (has(Hour) && d.getHours() !== Hour) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (has(Minute) && d.getMinutes() !== Minute) {
      d.setMinutes(d.getMinutes() + ((Minute - d.getMinutes() + 60) % 60), 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}

// Each time a calendar job was due in (from, to], oldest first, at most `cap`
// of them: a calendar that names only a weekday is due every minute of that day,
// so the walk stops rather than list 1,440. These are the times launchd was due
// to start the job, not proof that it ran: a Mac asleep at that minute starts
// it on waking.
export function dueBetween(cal, from, to, cap = 200) {
  const out = [];
  for (let t = from; out.length < cap;) {
    const next = nextRun(cal, t);
    if (next === null || next > to) break;
    out.push(next);
    t = next;
  }
  return out;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

// The crons panel's order: failed first, then by next run. Used again after
// job-status's verdicts are laid over launchd's (lib/health.mjs), since a
// verdict can move a job between the two.
export function cronOrder(a, b) {
  if (a.ok !== b.ok) return a.ok ? 1 : -1;
  return (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
}

function readableName(label) {
  const tail = label.split('.').pop();
  return tail || label;
}

export function buildCron({ label, plist, statusRow }, now = Date.now()) {
  const cal = plist?.StartCalendarInterval ?? null;
  const interval = plist?.StartInterval ?? null;
  const status = statusRow?.status ?? null;
  // No status row, or a row with no exit code, means launchd has never recorded
  // a completed run: the job is loaded and pending. That is not a failure — but
  // it is not the confirmed success that "OK" claims either, so it gets its own
  // state and the panel renders it differently.
  const neverRan = status === null;
  const ok = neverRan || status === 0;
  return {
    name: readableName(label),
    label,
    schedule: formatSchedule(cal, interval),
    nextRunAt: nextRun(cal, now),
    // When it was due over the last 7 days: the Orbit page's Scheduled lane
    // shows today's, and the agent views name a routine's runs from them.
    dueAt: cal ? dueBetween(cal, now - WEEK_MS, now) : [],
    ok,
    state: neverRan ? 'never' : ok ? 'ok' : 'failed',
    last: neverRan ? 'Not yet run' : ok ? 'OK' : `Failed · ${status}`
  };
}
