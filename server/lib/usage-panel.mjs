import {
  inferWindowMs, computePace, WEEKLY_FALLBACK_MS, limitsOf, MIN_PLAUSIBLE_WINDOW_MS, MAX_ROLLOVER_LATENESS_MS
} from './pace.mjs';
import { RETENTION_MS } from '../history.mjs';

const DAY = 24 * 3600 * 1000;

// A weekly sparkline wants a month of context, but it can never show more than
// the store keeps in memory — asking for 30 days of a 7-day window would draw a
// line that silently starts wherever the data happens to begin. Tied to the
// store's constant so widening retention widens the series too.
const WEEKLY_SERIES_MS = Math.min(30 * DAY, RETENTION_MS);

// Percentages reset to zero each window, so one range for every bar would render
// the session limit as ~144 sawtooth spikes across a month. Each sparkline spans
// its own limit's natural period instead.
export const seriesRangeMs = label => (label === 'Current session' ? DAY : WEEKLY_SERIES_MS);

// The sparkline is 120 CSS pixels wide. At a poll every five minutes a 30-day
// weekly series reaches ~8,600 points — roughly 72 per pixel, all of them drawn
// on top of each other and every one of them shipped over the wire every 30
// seconds. Two points per pixel is already more resolution than the SVG can
// express, so anything beyond this cap is pure payload.
export const MAX_SERIES_POINTS = 240;

// Decimation must not invent, smooth or shift a reading: every point returned is
// a point that was actually recorded. Each bucket contributes its lowest and
// highest reading, so the sawtooth peaks and troughs that carry the meaning
// survive, and the newest reading is always kept — it is the one the eye reads
// against the bar above it.
export function decimate(points, max = MAX_SERIES_POINTS) {
  if (!Array.isArray(points)) return [];
  if (points.length <= max || max < 4) return points;

  const middle = points.slice(1, -1);
  const buckets = Math.floor((max - 2) / 2);
  const size = middle.length / buckets;
  const out = [points[0]];

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(middle.length, Math.floor((b + 1) * size));
    if (end <= start) continue;
    let lo = middle[start], hi = middle[start];
    for (let i = start + 1; i < end; i++) {
      if (middle[i].pct < lo.pct) lo = middle[i];
      if (middle[i].pct > hi.pct) hi = middle[i];
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo.t <= hi.t ? [lo, hi] : [hi, lo]));
  }

  out.push(points[points.length - 1]);
  return out;
}

// Where the window before this one ended: the faint arc on the Orbit page's
// rings. It is the newest reading of an earlier window, and it counts only as
// that window's final figure when it was taken within 15 minutes of the
// window's reset (three polls). A reading from hours before the reset (the
// server was down) is a figure the window may have grown past, so the answer is
// then unknown (null), and so it is when the history holds no earlier window.
//
// "Earlier" means a reset more than half an hour before the current one: the
// printed reset flaps by a minute between polls (see pace.mjs). A lapsed
// session prints no reset at all, and then any window that has ended counts.
// A weekly window follows the one before it, so for a weekly limit the earlier
// reset must be about a week before the current one, or a whole week went
// unread. `records` are in ascending `t` order, as the store keeps them.
export function lastWindowPct(records, limit, now) {
  const current = Date.parse(limit?.resetsAt ?? '');
  for (let i = (records?.length ?? 0) - 1; i >= 0; i--) {
    const r = records[i];
    const seen = limitsOf(r).find(l => l?.label === limit.label);
    if (!seen || !Number.isFinite(seen.pct)) continue;
    const reset = Date.parse(seen.resetsAt ?? '');
    if (!Number.isFinite(reset)) continue; // no window was open at this reading
    if (Number.isFinite(current) && reset > current - MIN_PLAUSIBLE_WINDOW_MS) continue; // this window
    // Not its final reading. This also means the window has ended: the reading
    // was taken by now, so its reset is at most 15 minutes past now.
    if (Math.abs(reset - r.t) > MAX_ROLLOVER_LATENESS_MS) return null;
    if (Number.isFinite(current) && String(limit.label).startsWith('Weekly')
      && current - reset > WEEKLY_FALLBACK_MS + MIN_PLAUSIBLE_WINDOW_MS) return null; // a week unread
    return seen.pct;
  }
  return null;
}

// `records` MUST already be in ascending `t` order — inferWindowMs depends on it
// and the history store guarantees it. Do not sort here.
export function buildUsagePanel({ parsed, records, now, historyStatus = null }) {
  const limits = parsed.limits.map(limit => {
    const observed = inferWindowMs(records, limit.label);
    // Weekly windows may fall back to seven days because the label says so. The
    // session window gets no fallback: substituting a plausible default is the
    // one thing this design forbids.
    const windowMs = observed ?? (limit.label.startsWith('Weekly') ? WEEKLY_FALLBACK_MS : null);
    const since = now - seriesRangeMs(limit.label);
    const series = records
      .filter(r => r?.t >= since)
      // `r.limits` is optional by contract: the store deliberately admits any
      // JSON object with a finite `t`, so one hand-edited or truncated line must
      // cost that line — not throw and take the entire usage panel, pace,
      // sparklines and drivers included, permanently unavailable. limitsOf() is
      // the same guard inferWindowMs uses, so both halves tolerate the same input.
      .map(r => ({ t: r.t, pct: limitsOf(r).find(l => l?.label === limit.label)?.pct }))
      .filter(p => Number.isFinite(p.pct));
    const last = lastWindowPct(records, limit, now);
    return {
      ...limit,
      pace: computePace({ pct: limit.pct, resetsAt: limit.resetsAt, windowMs, now }),
      series: decimate(series),
      // Left out, not zero, when it isn't known.
      ...(last === null ? {} : { lastWindowPct: last })
    };
  });
  // Carried onto the panel so the UI can distinguish "no readings yet" (wait and
  // it fills) from "we could not read or write the history" (waiting fixes
  // nothing). Spec §10.
  return { ...parsed, limits, history: historyStatus };
}
