export const WEEKLY_FALLBACK_MS = 7 * 24 * 3600 * 1000;

// Below this fraction of the window, dividing by `elapsed` produces wild
// figures. A projection that cries wolf trains the reader to ignore the one
// signal that matters, so we decline to project instead.
export const MIN_ELAPSED_FOR_PROJECTION = 0.10;

// A pace band either side of the expected position. Without it, "on pace"
// would essentially never occur and every bar would read as ahead or under.
const ON_PACE_BAND = 5;

const MINUTE = 60 * 1000;

// The history store deliberately admits any JSON object with a finite `t`, so
// `limits` may be absent or not an array at all. Reading it is a per-record
// concern everywhere: one bad line costs that line, never the panel.
export const limitsOf = record => (Array.isArray(record?.limits) ? record.limits : []);

// The shortest window Anthropic actually operates is measured in hours, so
// anything shorter than this is not a window at all. It is the printed reset
// FLAPPING by a minute between polls — a real, observed behaviour of `/usage`
// (`07:49:00` and `07:50:00` both appear in the same session's history). Without
// this floor, a rollover first caught at the low value and then "recovering" to
// the high one fabricates a one-minute window, which on a weekly limit then
// overrides the correct seven-day fallback and persists for up to a week.
export const MIN_PLAUSIBLE_WINDOW_MS = 30 * MINUTE;

// `/usage` reports when a window ENDS, never how long it is. A rollover moves
// the reset forward, so the length is observable rather than assumed — but a
// forward jump is NOT automatically one window length. Session windows are
// user-initiated and therefore not contiguous: after an idle spell the new
// window starts when the next message is sent, so the jump is `idle + window`.
// Three rules separate evidence from coincidence, and anything that survives
// none of them leaves the length unobserved rather than guessed:
//
//   1. GAP RULE — a jump is only evidence of a rollover if we were watching
//      closely enough to have seen it happen. The straddling gap is measured
//      from the reading that set the current baseline, and must be SMALLER than
//      the jump. If we may have slept through a whole window, the jump spans
//      more than one thing and is not a window length.
//   2. PLAUSIBILITY FLOOR — see MIN_PLAUSIBLE_WINDOW_MS.
//   3. REPETITION — a length observed twice is far likelier to be real than a
//      single sighting, so the most frequently seen candidate wins; ties break
//      towards the most recent. Candidates are rounded to the minute first, so
//      the one-minute flap cannot split an otherwise repeated observation.
//
// PRECONDITION: `records` must be in ascending `t` order. The history store
// guarantees this; a caller that does not would get a plausible wrong answer
// rather than an error, because the walk is order-sensitive by construction.
export function inferWindowMs(records, label) {
  let previous = null;   // highest reset seen so far
  let previousT = null;  // the record timestamp that set it
  const candidates = []; // rounded lengths, in observation order

  for (const record of records) {
    const limit = limitsOf(record).find(l => l?.label === label);
    if (!limit?.resetsAt) continue;
    const resetsAt = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAt)) continue;
    const t = Number.isFinite(record?.t) ? record.t : null;

    if (previous !== null && resetsAt > previous) {
      const jump = resetsAt - previous;
      // A reading with no usable timestamp cannot establish that we were
      // watching, so it cannot support a window length either.
      const gap = t !== null && previousT !== null ? t - previousT : null;
      const watched = gap !== null && gap < jump;
      if (watched && jump >= MIN_PLAUSIBLE_WINDOW_MS) {
        candidates.push(Math.round(jump / MINUTE) * MINUTE);
      }
    }
    // Only ever advance the baseline. Lowering it on a backward blip (a stale or
    // duplicated poll) would make a later RECOVERY to the original value look
    // like a rollover, manufacturing a window length that never occurred. The
    // baseline advances even for a jump we refused to trust: it is where the
    // reset now is, which is a separate question from how long the window is.
    if (previous === null || resetsAt > previous) {
      previous = resetsAt;
      previousT = t;
    }
  }

  if (candidates.length === 0) return null;

  const groups = new Map();
  candidates.forEach((ms, index) => {
    const seen = groups.get(ms) ?? { count: 0, last: -1 };
    groups.set(ms, { count: seen.count + 1, last: index });
  });

  let best = null;
  for (const [ms, g] of groups) {
    if (!best || g.count > best.count || (g.count === best.count && g.last > best.last)) {
      best = { ms, ...g };
    }
  }
  return best.ms;
}

export function computePace({ pct, resetsAt, windowMs, now }) {
  const none = { state: 'unknown-window', elapsed: null, expectedPct: null, projectedPct: null };
  if (!windowMs || windowMs <= 0 || !resetsAt) return none;

  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return none;

  const start = end - windowMs;
  const elapsed = Math.min(1, Math.max(0, (now - start) / windowMs));
  const expectedPct = Math.round(elapsed * 100);

  // The reset we are holding has already passed, so this reading belongs to a
  // window that no longer exists. Clamping `elapsed` to 1 and printing
  // "projected N% by reset" claims a forecast for a deadline that is behind us,
  // and contradicts the 00:00 countdown printed beside it. Say what is true:
  // the window ended and no fresher reading has arrived yet.
  if (now >= end) {
    return { state: 'window-ended', elapsed, expectedPct, projectedPct: null };
  }

  if (elapsed < MIN_ELAPSED_FOR_PROJECTION) {
    return { state: 'too-early', elapsed, expectedPct, projectedPct: null };
  }

  // Not clamped: a projection of 180% is real information. The caller clamps
  // the tick MARK to the bar's width, exactly as the credits bar already does.
  const projectedPct = Math.round(pct / elapsed);

  const delta = pct - expectedPct;
  const state = delta > ON_PACE_BAND ? 'ahead' : delta < -ON_PACE_BAND ? 'under' : 'on';
  return { state, elapsed, expectedPct, projectedPct };
}
