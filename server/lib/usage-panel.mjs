import { inferWindowMs, computePace, WEEKLY_FALLBACK_MS } from './pace.mjs';

const DAY = 24 * 3600 * 1000;

// Percentages reset to zero each window, so one range for every bar would render
// the session limit as ~144 sawtooth spikes across a month. Each sparkline spans
// its own limit's natural period instead.
export const seriesRangeMs = label => (label === 'Current session' ? DAY : 30 * DAY);

// `records` MUST already be in ascending `t` order — inferWindowMs depends on it
// and the history store guarantees it. Do not sort here.
export function buildUsagePanel({ parsed, records, now }) {
  const limits = parsed.limits.map(limit => {
    const observed = inferWindowMs(records, limit.label);
    // Weekly windows may fall back to seven days because the label says so. The
    // session window gets no fallback: substituting a plausible default is the
    // one thing this design forbids.
    const windowMs = observed ?? (limit.label.startsWith('Weekly') ? WEEKLY_FALLBACK_MS : null);
    const since = now - seriesRangeMs(limit.label);
    const series = records
      .filter(r => r.t >= since)
      .map(r => ({ t: r.t, pct: r.limits.find(l => l.label === limit.label)?.pct }))
      .filter(p => Number.isFinite(p.pct));
    return {
      ...limit,
      pace: computePace({ pct: limit.pct, resetsAt: limit.resetsAt, windowMs, now }),
      series
    };
  });
  return { ...parsed, limits };
}
