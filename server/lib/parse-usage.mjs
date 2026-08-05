export class UsageParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageParseError';
  }
}

const LIMIT_RE = /^(Current session|Current week \(([^)]+)\)):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/;
// Any line that opens like a limit line, whether or not it goes on to match
// LIMIT_RE in full. Used to catch a limit line whose format has drifted —
// e.g. a changed suffix — so it is never silently dropped.
const LOOKS_LIKE_LIMIT_RE = /^(Current session|Current week)\b/;
const COUNTS_RE = /^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions/;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// A generous plausibility bound, not a 0-100 clamp: credit-spend limits on
// real accounts legitimately exceed 100%. This exists only to catch garbled
// or concatenated digit strings, not to police normal overage.
const MAX_PLAUSIBLE_PCT = 1000;

function label(raw, scope) {
  if (raw === 'Current session') return 'Current session';
  return `Weekly · ${scope}`;
}

// "Aug 5 at 12:09pm (America/New_York)" -> ISO string.
// The printed zone is assumed to match the host zone; when it does not, we
// return null rather than silently shifting the countdown by hours.
function resolveReset(clause, now) {
  if (!clause) return null;
  const m = clause.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  const [, mon, day, hourRaw, minRaw, meridiem, zone] = m;
  if (zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone) return null;
  const monthIndex = MONTHS.indexOf(mon.slice(0, 1).toUpperCase() + mon.slice(1, 3).toLowerCase());
  if (monthIndex < 0) return null;
  let hour = Number(hourRaw) % 12;
  if (meridiem.toLowerCase() === 'pm') hour += 12;
  let d = new Date(now.getFullYear(), monthIndex, Number(day), hour, Number(minRaw ?? 0), 0, 0);
  // A reset well in the past means the printed date belongs to next year.
  if (d.getTime() < now.getTime() - 30 * 24 * 3600 * 1000) d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

export function parseUsage(text, now = new Date()) {
  const limits = [];
  const requests = { last24h: null, last7d: null };
  const sessions = { last24h: null, last7d: null };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const lm = trimmed.match(LIMIT_RE);
    if (lm) {
      const pct = Number(lm[3]);
      if (pct > MAX_PLAUSIBLE_PCT) {
        throw new UsageParseError(`implausible percentage in limit line: ${trimmed}`);
      }
      limits.push({
        label: label(lm[1], lm[2]),
        pct,
        resetsAt: resolveReset(lm[4], now)
      });
      continue;
    }
    if (LOOKS_LIKE_LIMIT_RE.test(trimmed)) {
      // Starts like a limit line but didn't fully match LIMIT_RE: the format
      // has drifted. Throwing here beats silently dropping a limit, which
      // would leave the dashboard showing fewer bars than the account has
      // with no signal that anything was lost.
      throw new UsageParseError(`malformed limit line: ${trimmed}`);
    }
    const cm = trimmed.match(COUNTS_RE);
    if (cm) {
      const key = cm[1] === '24h' ? 'last24h' : 'last7d';
      requests[key] = Number(cm[2].replace(/,/g, ''));
      sessions[key] = Number(cm[3].replace(/,/g, ''));
    }
  }

  if (limits.length === 0) {
    throw new UsageParseError('no limit lines found in /usage output');
  }
  return { limits, requests, sessions };
}
