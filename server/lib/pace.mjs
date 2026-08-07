export const WEEKLY_FALLBACK_MS = 7 * 24 * 3600 * 1000;

// Below this fraction of the window, dividing by `elapsed` produces wild
// figures. A projection that cries wolf trains the reader to ignore the one
// signal that matters, so we decline to project instead.
export const MIN_ELAPSED_FOR_PROJECTION = 0.10;

// A pace band either side of the expected position. Without it, "on pace"
// would essentially never occur and every bar would read as ahead or under.
const ON_PACE_BAND = 5;

// `/usage` reports when a window ENDS, never how long it is. But when a window
// rolls over, the new reset jumps forward by exactly one window length — so the
// length is observable rather than assumed, and self-corrects if it ever changes.
export function inferWindowMs(records, label) {
  let previous = null;
  let inferred = null;

  for (const record of records) {
    const limit = (record?.limits ?? []).find(l => l?.label === label);
    if (!limit?.resetsAt) continue;
    const resetsAt = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAt)) continue;

    if (previous !== null && resetsAt > previous) inferred = resetsAt - previous;
    previous = resetsAt;
  }
  return inferred;
}

export function computePace({ pct, resetsAt, windowMs, now }) {
  const none = { state: 'unknown-window', elapsed: null, expectedPct: null, projectedPct: null };
  if (!windowMs || windowMs <= 0 || !resetsAt) return none;

  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return none;

  const start = end - windowMs;
  const elapsed = Math.min(1, Math.max(0, (now - start) / windowMs));
  const expectedPct = Math.round(elapsed * 100);

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
