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

const WINDOW_RE = /^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions/;
const BEHAVIOUR_RE = /^(\d+)%\s+of your usage\s+(?:came from|was at)\s+(.+?)\s*$/;
const TOP_RE = /^Top\s+([^:]+):\s*(.+?)\s*$/;
const ENTRY_RE = /^(.*?)\s+(\d+)%$/;

const num = s => Number(String(s).replace(/,/g, ''));

// Deliberately lenient, unlike the limit parsing above. The factors block is
// supplementary; a format change here must never take down the primary numbers.
// Anything unrecognised is skipped, and a block that yields nothing usable
// returns null rather than an empty shape that would read as "no drivers".
function parseFactors(text) {
  const windows = {};
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const w = line.match(WINDOW_RE);
    if (w) {
      current = { requests: num(w[2]), sessions: num(w[3]), behaviours: [], top: [] };
      windows[w[1]] = current;
      continue;
    }
    if (!current) continue;

    const b = line.match(BEHAVIOUR_RE);
    if (b) {
      current.behaviours.push({ pct: Number(b[1]), text: b[2] });
      continue;
    }

    const t = line.match(TOP_RE);
    if (t) {
      const entries = [];
      for (const part of t[2].split(',')) {
        const e = part.trim().match(ENTRY_RE);
        if (e) entries.push({ name: e[1].trim(), pct: Number(e[2]) });
      }
      if (entries.length > 0) current.top.push({ category: t[1].trim(), entries });
    }
  }

  const usable = Object.values(windows).some(w => w.behaviours.length > 0 || w.top.length > 0);
  return usable ? windows : null;
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

  // Guarded twice over: parseFactors already skips what it cannot read, and a
  // throw from it must still not sink the limits the caller actually needs.
  let factors = null;
  try {
    factors = parseFactors(text);
  } catch {
    factors = null;
  }

  return { limits, requests, sessions, factors };
}
