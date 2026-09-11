const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const pad = n => String(n).padStart(2, '0');
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatShort(ms) {
  const total = Math.max(0, ms);
  const d = Math.floor(total / DAY);
  const h = Math.floor((total % DAY) / HOUR);
  const m = Math.floor((total % HOUR) / MIN);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatRelative(ms) {
  const total = Math.max(0, ms);
  if (total < HOUR) return `${Math.floor(total / MIN)}m ago`;
  if (total < DAY) return `${Math.floor(total / HOUR)}h ago`;
  return `${Math.floor(total / DAY)}d ago`;
}

const has = v => Number.isInteger(v);

// An omitted StartCalendarInterval key is a wildcard to launchd, not a zero.
// `{Minute: 30}` runs hourly at :30; printing "Every day, 00:30" states a
// schedule the job does not keep. Each partial case gets its own wording rather
// than being filled in with a number nobody specified.
function calendarPhrase(cal) {
  const { Hour, Minute, Weekday } = cal;
  const day = has(Weekday) ? (DAYS[Weekday] ?? 'Weekly') : null;

  if (has(Hour) && has(Minute)) {
    const time = `${pad(Hour)}:${pad(Minute)}`;
    return day ? `${day}, ${time}` : `Every day, ${time}`;
  }
  if (has(Minute)) {
    const every = `every hour at :${pad(Minute)}`;
    return day ? `${day}, ${every}` : `Every hour at :${pad(Minute)}`;
  }
  if (has(Hour)) {
    const window = `${pad(Hour)}:00–${pad(Hour)}:59, every minute`;
    return day ? `${day}, ${window}` : `Every day, ${window}`;
  }
  if (day) return `${day}, every minute`;
  return 'Every minute';
}

// launchd also accepts an ARRAY of calendar dictionaries (08:00 and 20:00).
// An array is an object too, so it used to fall into the single-dictionary
// path with every key undefined and print "Every minute". Each entry gets its
// own phrase; an empty array specifies nothing, which is on-demand.
export function formatSchedule(cal, intervalSec) {
  if (Array.isArray(cal)) {
    const entries = cal.filter(c => c && typeof c === 'object');
    if (entries.length > 0) return entries.map(calendarPhrase).join(' · ');
  } else if (cal && typeof cal === 'object') {
    return calendarPhrase(cal);
  }
  if (intervalSec) {
    if (intervalSec % 3600 === 0) {
      const h = intervalSec / 3600;
      return h === 1 ? 'Every hour' : `Every ${h} hours`;
    }
    const m = Math.round(intervalSec / 60);
    return m === 1 ? 'Every minute' : `Every ${m} minutes`;
  }
  return 'On demand';
}
