export class UsageParseError extends Error {}

const LIMIT_RE = /^(Current session|Current week \(([^)]+)\)):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/;
const COUNTS_RE = /^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions/;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

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
      limits.push({
        label: label(lm[1], lm[2]),
        pct: Number(lm[3]),
        resetsAt: resolveReset(lm[4], now)
      });
      continue;
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
