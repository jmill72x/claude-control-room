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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ordinal = n => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;
};
const listed = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// Weekdays as said: "Mondays", "Mondays and Thursdays", "Mondays to Fridays"
// (three or more in a row).
function weekdaysPhrase(days) {
  if (days.length === 0) return null;
  const names = days.map(d => DAYS[d] ?? 'Weekly');
  const inRow = days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  return inRow ? `${names[0]} to ${names[names.length - 1]}` : listed(names);
}

// The days an entry fires on, or null for every day. `months` and `weekdays`
// are the entry's own, or those of several entries that differ in nothing else.
function daysPhrase(cal, months, weekdays) {
  const weekday = weekdaysPhrase(weekdays);
  const inMonths = months.length > 0 ? listed(months.map(m => MONTHS[m - 1] ?? `month ${m}`)) : null;
  if (has(cal.Day)) {
    const date = `${ordinal(cal.Day)} of ${inMonths ?? 'each month'}`;
    return weekday ? `${weekday} on the ${date}` : date;
  }
  if (inMonths) return `${weekday ?? 'Every day'} in ${inMonths}`;
  return weekday;
}

// An omitted StartCalendarInterval key is a wildcard to launchd, not a zero.
// `{Minute: 30}` runs hourly at :30; printing "Every day, 00:30" states a
// schedule the job does not keep. Each partial case gets its own wording rather
// than being filled in with a number nobody specified. Day and Month count too:
// a job for the 1st of the month read "Every day" until 2026-10-21.
function calendarPhrase(cal, months = has(cal.Month) ? [cal.Month] : [], weekdays = has(cal.Weekday) ? [cal.Weekday] : []) {
  const { Hour, Minute } = cal;
  const day = daysPhrase(cal, months, weekdays);

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
// own phrase; an empty array specifies nothing, which is on-demand. Entries
// that differ only in their Month share one phrase ("1st of Jan, Apr, Jul and
// Oct, 06:30"), as do entries that differ only in their Weekday ("Mondays to
// Fridays, 07:30"), and a repeated entry is said once.
function arrayPhrase(entries) {
  const groups = new Map();
  for (const c of entries) {
    const vary = has(c.Month) && !has(c.Weekday) ? 'Month' : has(c.Weekday) && !has(c.Month) ? 'Weekday' : null;
    const key = JSON.stringify([vary, c.Minute, c.Hour, c.Day, vary ? null : c.Month, vary ? null : c.Weekday]);
    if (!groups.has(key)) groups.set(key, { cal: c, vary, values: [] });
    if (vary) groups.get(key).values.push(c[vary]);
  }
  const phrases = [...groups.values()].map(g => {
    const values = [...new Set(g.values)].sort((a, b) => a - b);
    if (g.vary === 'Month') return calendarPhrase(g.cal, values);
    if (g.vary === 'Weekday') return calendarPhrase(g.cal, [], values);
    return calendarPhrase(g.cal);
  });
  return phrases.join(' · ');
}

export function formatSchedule(cal, intervalSec) {
  if (Array.isArray(cal)) {
    const entries = cal.filter(c => c && typeof c === 'object' && !Array.isArray(c));
    if (entries.length > 0) return arrayPhrase(entries);
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
