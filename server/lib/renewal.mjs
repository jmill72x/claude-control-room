// Anthropic subscriptions bill on the monthly anniversary of the renewal
// date, not on a fixed 30-day cadence — 4 Sep rolls to 4 Oct, not "roughly a
// month later". `cycle: '30d'` exists only so a future correction (if the
// user finds the billing model actually is fixed-length) is one config edit,
// never a code change.
//
// All arithmetic here runs on plain (year, month, day) integers, never on a
// `Date` parsed from 'YYYY-MM-DD' text — V8 treats a bare date string as UTC
// midnight, which prints as the previous day anywhere west of Greenwich.
// Month-length lookups use `Date.UTC`, which is timezone-inert (the same
// (y, m, d) always maps to the same instant everywhere), and "today" is read
// off the caller's clock via local getters (`getFullYear`/`getMonth`/
// `getDate`), never a UTC-shifted one.

const ANCHOR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year, month1) {
  // Date.UTC(year, month1, 0) is "day 0" of the 1-indexed month `month1`,
  // i.e. the last day of the (0-indexed) month before it — which is exactly
  // month `month1`. This is timezone-inert: it never touches local time.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function parseAnchor(renews) {
  if (typeof renews !== 'string') return null;
  const m = ANCHOR_RE.exec(renews);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

// Reads today's calendar date off the caller's clock using *local* wall-clock
// getters — this machine's notion of "today", not a UTC-shifted one.
function localYmd(now) {
  const d = now instanceof Date ? now : new Date(now);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

const key = ({ year, month, day }) => year * 10000 + month * 100 + day;
const pad = n => String(n).padStart(2, '0');
const iso = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;

function nextMonthly(anchor, today) {
  const anchorTotal = anchor.year * 12 + (anchor.month - 1);
  const todayTotal = today.year * 12 + (today.month - 1);
  const diff = todayTotal - anchorTotal;

  // The candidate for a given "total months since epoch" is the anchor's day
  // of month, clamped to however many days that target month actually has —
  // this is the month-end clamp: a 31st anchor becomes the 30th in April,
  // the 28th (or 29th) in February, never overflowing into the next month.
  const candidateFor = totalMonths => {
    const year = Math.floor(totalMonths / 12);
    const month = totalMonths - year * 12 + 1;
    const day = Math.min(anchor.day, daysInMonth(year, month));
    return { year, month, day };
  };

  // Start at the candidate in today's own month. If the anchor's (clamped)
  // day within that month has already passed today, the next real
  // occurrence is one month further out — never more than one, since a
  // later month is unconditionally later than any day in today's month.
  let candidate = candidateFor(anchorTotal + diff);
  if (key(candidate) < key(today)) candidate = candidateFor(anchorTotal + diff + 1);
  return candidate;
}

function epochDay({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function fromEpochDay(days) {
  const d = new Date(days * 86400000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function next30d(anchor, today) {
  const anchorDay = epochDay(anchor);
  const todayDay = epochDay(today);
  if (todayDay <= anchorDay) return anchor;
  const cycles = Math.ceil((todayDay - anchorDay) / 30);
  return fromEpochDay(anchorDay + cycles * 30);
}

// Resolves `plan.renews` (an anchor date — not necessarily the next actual
// renewal) plus `plan.cycle` ('monthly', the default, or '30d') into the
// next renewal on or after `now`, as a 'YYYY-MM-DD' string. Returns null
// rather than guessing when the anchor is missing or not a real calendar
// date — callers must render "unknown", never a fabricated countdown.
export function nextRenewalDate(renews, cycle, now = new Date()) {
  const anchor = parseAnchor(renews);
  if (!anchor) return null;
  const today = localYmd(now);
  const result = cycle === '30d' ? next30d(anchor, today) : nextMonthly(anchor, today);
  return iso(result);
}
