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
//
// The lateness rule below CANNOT catch that case and this floor is the only
// thing that does: a flap observed seconds after the reset it supersedes is, by
// construction, a maximally punctual sighting. The live history contains
// exactly that — a 44-second poll gap across a one-minute change of the printed
// reset. There is a test that isolates this; if it is ever deleted, the floor
// will look unused and it is not.
export const MIN_PLAUSIBLE_WINDOW_MS = 30 * MINUTE;

// How late a rollover may be first seen and still measure its own window. The
// collector polls every five minutes, so this is three polls: enough to survive
// a missed poll or two around the rollover, and small enough that the resulting
// error is bounded at 15 minutes on a window measured in hours. See the proof
// below — this number IS the worst-case error, not a confidence heuristic.
export const MAX_ROLLOVER_LATENESS_MS = 15 * MINUTE;

// `/usage` reports when a window ENDS, never how long it is. A rollover moves
// the reset forward, so the length is observable rather than assumed — but a
// forward jump is NOT automatically one window length. Session windows are
// user-initiated and therefore not contiguous: after an idle spell the new
// window starts when the next message is sent, so the jump is `idle + window`.
//
// WHY LATENESS — AND WHY THE POLL GAP THIS RULE REPLACED COULD NEVER WORK.
//
// Write `R1` for the reset we were holding, `S` for the start of the new
// window, `W` for its length, and `t2` for the reading that first showed the
// new reset `R2 = S + W`. Then
//
//     jump = R2 - R1 = W + (S - R1)      i.e.      W = jump - (S - R1).
//
// The entire question is how much of the jump is idle. We never observe `S`,
// but we bound it exactly: the old window ended at `R1`, and the new one had
// certainly started by the time we saw its reset, so `R1 <= S <= t2`, hence
//
//     jump - (t2 - R1) <= W <= jump.
//
// The error in reading `jump` as `W` is AT MOST the lateness of the sighting,
// `t2 - R1` — an exact bound computed from two numbers we actually hold. A
// sighting that is punctual is therefore accurate, as a matter of arithmetic
// rather than of judgement.
//
// The rule this replaced compared the straddling poll gap `t2 - t1` against the
// jump and accepted when `gap < jump`. Substituting the identity above, that
// rule rejects only when `(t2 - S) + (R1 - t1) > W`. When the rollover is
// caught promptly `t2 - S` is nearly zero, so rejection then requires
// `R1 - t1 > W`: the baseline reading would have to precede the old reset by
// more than a whole window, which cannot happen. So the gap rule could only
// ever reject when the baseline happened to be set at the very start of the
// previous window — on the live history its entire margin was 33 seconds. It
// was a proxy for lateness that goes blind in precisely the case it was written
// for, and it fabricated 14.5h from an ordinary overnight poll gap. Measure the
// quantity that bounds the error, not one correlated with it.
//
// The bound is applied symmetrically. A "rollover" first seen BEFORE the old
// reset (`t2 < R1`) is not a rollover at all — that window had not ended yet —
// so its jump stands in no relation to any window length and is refused for the
// same reason, not tolerated because its lateness is negative.
//
// Three rules; anything surviving none of them leaves the length unobserved
// rather than guessed:
//
//   1. LATENESS — `|t2 - R1| <= MAX_ROLLOVER_LATENESS_MS`, per the proof above.
//      A reading with no usable timestamp has no measurable lateness and so
//      cannot support a length either.
//   2. PLAUSIBILITY FLOOR — see MIN_PLAUSIBLE_WINDOW_MS.
//   3. RECENCY WINS — the most recent accepted observation is the answer. Spec
//      §4 promises inference is self-correcting: if Anthropic changes a window,
//      the next rollover reflects it. A previous round preferred the most
//      REPEATED length instead, which silently traded that away — five hours
//      seen ten times outvoted three hours seen cleanly three times, so a
//      genuine change stayed misreported for half the retention window.
//      Repetition was standing in for filtering that rule 1 now does exactly,
//      so it buys nothing and costs the promise. Candidates are still rounded
//      to the minute, since the printed reset only has minute resolution.
//
// PRECONDITION: `records` must be in ascending `t` order. The history store
// guarantees this; a caller that does not would get a plausible wrong answer
// rather than an error, because the walk is order-sensitive by construction.
export function inferWindowMs(records, label) {
  let previous = null;   // highest reset seen so far — the `R1` above
  let observed = null;   // most recently accepted window length

  for (const record of records) {
    const limit = limitsOf(record).find(l => l?.label === label);
    if (!limit?.resetsAt) continue;
    const resetsAt = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAt)) continue;
    const t = Number.isFinite(record?.t) ? record.t : null;

    // Because the baseline only advances, this is the FIRST sighting of a reset
    // beyond it — which is what makes `t` the `t2` the bound is stated in.
    if (previous !== null && resetsAt > previous) {
      const jump = resetsAt - previous;
      const lateness = t === null ? null : Math.abs(t - previous);
      if (lateness !== null && lateness <= MAX_ROLLOVER_LATENESS_MS && jump >= MIN_PLAUSIBLE_WINDOW_MS) {
        observed = Math.round(jump / MINUTE) * MINUTE;
      }
    }
    // Only ever advance the baseline. Lowering it on a backward blip (a stale or
    // duplicated poll) would make a later RECOVERY to the original value look
    // like a rollover, manufacturing a window length that never occurred. The
    // baseline advances even for a jump we refused to trust: it is where the
    // reset now is, which is a separate question from how long the window is.
    if (previous === null || resetsAt > previous) previous = resetsAt;
  }

  return observed;
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
