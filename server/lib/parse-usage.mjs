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
// Shared by the top-level requests/sessions counts and by parseFactors below —
// both read the same "Last 24h · N requests · N sessions" line, so one regex
// keeps them from silently diverging if the format ever changes.
const WINDOW_COUNTS_RE = /^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions/;
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

const BEHAVIOUR_RE = /^(\d+)%\s+of your usage\s+(?:came from|was at)\s+(.+?)\s*$/;
const TOP_RE = /^Top\s+([^:]+):\s*(.+?)\s*$/;
const ENTRY_RE = /^(.*?)\s+(\d+)%$/;

const num = s => Number(String(s).replace(/,/g, ''));

// Deliberately lenient, unlike the limit parsing above. The factors block is
// supplementary; a format change here must never take down the primary numbers.
// Anything unrecognised is skipped, and a block that yields nothing usable
// returns null rather than an empty shape that would read as "no drivers".
//
// The returned shape is PARTIAL: { '24h'?: Window, '7d'?: Window }, not both
// keys guaranteed, and a present window is not guaranteed to carry content
// either:
//   - A window key is present if and only if its "Last 24h"/"Last 7d" header
//     line parsed. Format drift on one header, or an account with no 7-day
//     history yet, legitimately produces a result with only one key.
//   - A present window may still have zero behaviours and zero top entries —
//     its requests/sessions counts are genuinely scraped from the header
//     line and are kept even when nothing below that line parsed, because
//     dropping the window would discard real data along with the absence.
//   - `factors` as a whole is null only when NO window, across both, yielded
//     any behaviour or top entry — usable-ness is judged over the whole
//     block, not per window.
// Consumers must therefore defend against three states per window: absent,
// present-but-empty, and present-with-content. Treating "key present" as a
// promise of meaningful content will render a blank section with no code
// path expecting it.
function parseFactors(text) {
  const windows = {};
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const w = line.match(WINDOW_COUNTS_RE);
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
      // The format is comma-separated, so a name that itself contains a comma
      // is inherently ambiguous — it cannot be recovered, only guessed at.
      // A single unparseable fragment therefore invalidates the whole line:
      // keeping the fragments that happened to parse would produce a
      // truncated name presented as fact, which is worse than no entry at
      // all because nothing marks it as suspect.
      const entries = [];
      let allMatched = true;
      for (const part of t[2].split(',')) {
        const e = part.trim().match(ENTRY_RE);
        if (!e) { allMatched = false; break; }
        entries.push({ name: e[1].trim(), pct: Number(e[2]) });
      }
      if (allMatched && entries.length > 0) current.top.push({ category: t[1].trim(), entries });
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
    const cm = trimmed.match(WINDOW_COUNTS_RE);
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
