// The Orbit Overview's logic: the usage rings, Next 24 hours, Burn and the
// week's heat map. Plain functions over the /api/dashboard payload, checked by
// web/test/orbit-overview.test.js.
import { clock, compactTokens } from './page.js';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- Usage limits ----

// Outer to inner: the session, the week, then the model-scoped weekly limit.
export const RINGS = [
  { r: 88, color: '#FF7A45' },
  { r: 70, color: '#F8F7F3' },
  { r: 52, color: '#A9B4CB' }
];
export const circumference = r => 2 * Math.PI * r;

// "Current session" is the Session; "Weekly · all models" the Week; any other
// weekly limit is named for its model ("Weekly · Fable" is Fable).
export function ringLabel(label) {
  if (label === 'Current session') return 'Session';
  if (label === 'Weekly · all models') return 'Week';
  const tail = String(label ?? '').split('·').pop().trim();
  return tail || String(label ?? '');
}

// When a limit resets: the time of day within a day, else the weekday and time.
export function resetNote(resetsAt, now) {
  const at = Date.parse(resetsAt ?? '');
  if (!Number.isFinite(at)) return 'no reset reported';
  if (at - now < DAY) return `resets ${clock(at)}`;
  const d = new Date(at);
  return `resets ${WEEKDAYS[d.getDay()]} ${clock(at, { short: true })}`;
}

export function ringView(limits, now) {
  return (Array.isArray(limits) ? limits : []).slice(0, RINGS.length).map((limit, i) => {
    const { r, color } = RINGS[i];
    const circ = circumference(r);
    const pct = Number.isFinite(limit?.pct) ? limit.pct : null;
    const last = Number.isFinite(limit?.lastWindowPct) ? limit.lastWindowPct : null;
    const session = limit?.label === 'Current session';
    return {
      key: limit?.label ?? String(i),
      label: ringLabel(limit?.label),
      r, color, circ,
      pct,
      pctLabel: pct === null ? '—' : `${Math.round(pct)}%`,
      arc: pct === null ? 0 : (clamp(pct, 0, 100) / 100) * circ,
      ghost: last === null ? null : (clamp(last, 0, 100) / 100) * circ,
      note: resetNote(limit?.resetsAt, now),
      ghostLabel: last === null ? '' : `${session ? 'last window' : 'last week'} ${Math.round(last)}%`
    };
  });
}

// H:MM:SS until the session resets, or null when no session window is open.
export function sessionCountdown(limits, now) {
  const session = (Array.isArray(limits) ? limits : []).find(l => l?.label === 'Current session');
  const at = Date.parse(session?.resetsAt ?? '');
  if (!Number.isFinite(at)) return null;
  const total = Math.max(0, Math.floor((at - now) / 1000));
  const p = n => String(n).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

// ---- Next 24 hours ----

const resetName = label => (label === 'Current session' ? 'Session resets' : label === 'Weekly · all models' ? 'Week resets' : `${ringLabel(label)} week resets`);

// The next run of each calendar job within 24 hours, and any limit that resets
// in that time, soonest first. A job that runs every few minutes (launchd's
// StartInterval) has no fixed next run, so it never appears. Names come from
// config's `jobs` block, else the job's own short name; owner colours the dot.
// `extra` holds events worked out elsewhere: Jeff's own items (waiting.js,
// youEvents), each { t, name, owner, kind }.
// Labels alternate above and below the line so neighbours don't collide, and
// a label near either end lines up inward so the box doesn't clip it.
export const EDGE_PCT = 9;
export function next24({ crons, limits, jobs, now, extra = [] }) {
  const end = now + DAY;
  const within = t => Number.isFinite(t) && t > now && t <= end;
  const events = [];
  for (const c of Array.isArray(crons) ? crons : []) {
    if (!within(c?.nextRunAt)) continue;
    const named = jobs?.[c.label];
    events.push({ t: c.nextRunAt, name: named?.name ?? c.name ?? c.label, owner: named?.owner ?? null, kind: 'job' });
  }
  const resets = [];
  for (const l of Array.isArray(limits) ? limits : []) {
    const t = Date.parse(l?.resetsAt ?? '');
    if (within(t)) resets.push({ t, label: l.label });
  }
  // Two weekly limits resetting in the same minute are one event.
  const weekly = resets.filter(r => r.label !== 'Current session');
  for (const r of resets) {
    const twin = r.label !== 'Current session' && weekly.filter(w => Math.abs(w.t - r.t) < 2 * MIN).length > 1;
    if (twin) {
      if (!events.some(e => e.kind === 'reset' && e.name === 'Weekly limits reset' && Math.abs(e.t - r.t) < 2 * MIN)) {
        events.push({ t: r.t, name: 'Weekly limits reset', owner: null, kind: 'reset' });
      }
    } else {
      events.push({ t: r.t, name: resetName(r.label), owner: null, kind: 'reset' });
    }
  }
  for (const e of Array.isArray(extra) ? extra : []) if (within(e?.t)) events.push(e);
  events.sort((a, b) => a.t - b.t);
  const placed = events.map((e, i) => {
    const pct = ((e.t - now) / DAY) * 100;
    return {
      ...e,
      at: clock(e.t),
      left: `${pct.toFixed(2)}%`,
      row: i % 2 === 0 ? 'top' : 'bottom',
      align: pct < EDGE_PCT ? 'start' : pct > 100 - EDGE_PCT ? 'end' : 'center'
    };
  });
  const ticks = [];
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  for (; d.getTime() <= end; d.setHours(d.getHours() + 1)) {
    if (d.getHours() % 6 !== 0) continue;
    ticks.push({ label: clock(d.getTime(), { short: true }), left: `${(((d.getTime() - now) / DAY) * 100).toFixed(2)}%` });
  }
  return { events: placed, ticks };
}

// ---- Burn ----

export const FAMILY_ORDER = ['opus', 'fable', 'sonnet', 'haiku', 'other'];
export const FAMILY_NAMES = { opus: 'Opus', fable: 'Fable', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };
export const FAMILY_COLORS = { opus: '#F8F7F3', fable: '#FF7A45', sonnet: '#7CC4FF', haiku: '#3FCB82', other: '#B9A6FB' };

const hourTotal = h => FAMILY_ORDER.reduce((s, f) => s + (h?.[f] ?? 0), 0);

// 24 stacked bars, each scaled to the busiest hour (which reaches 96% of the
// height). An empty hour is a stub, not a missing bar.
export function burnBars(last24h) {
  const hours = Array.isArray(last24h) ? last24h : [];
  const max = Math.max(0, ...hours.map(hourTotal));
  return hours.map(h => {
    const total = hourTotal(h);
    if (!(total > 0) || !(max > 0)) return { start: h?.start, total: 0, segs: [] };
    const height = (total / max) * 96;
    return {
      start: h.start,
      total,
      segs: FAMILY_ORDER.filter(f => h[f] > 0).map(f => ({ family: f, color: FAMILY_COLORS[f], h: `${((height * h[f]) / total).toFixed(2)}%` }))
    };
  });
}

// "98%", "1.8%", "<0.1%": shares to one decimal under 10%, and never a 0% for a
// family that was used at all.
export function shareLabel(p) {
  if (!(p > 0)) return '0%';
  if (p < 0.1) return '<0.1%';
  if (p < 10) return `${Number(p.toFixed(1))}%`;
  return `${Math.round(p)}%`;
}

export function burnShares(last24h) {
  const totals = Object.fromEntries(FAMILY_ORDER.map(f => [f, 0]));
  for (const h of Array.isArray(last24h) ? last24h : []) for (const f of FAMILY_ORDER) totals[f] += h?.[f] ?? 0;
  const all = FAMILY_ORDER.reduce((s, f) => s + totals[f], 0);
  return {
    total: all,
    families: all > 0
      ? FAMILY_ORDER.filter(f => totals[f] > 0).map(f => {
          const p = (totals[f] / all) * 100;
          return { family: f, name: FAMILY_NAMES[f], color: FAMILY_COLORS[f], tokens: totals[f], share: shareLabel(p), width: `${p.toFixed(2)}%` };
        })
      : []
  };
}

// ---- This week, hour by hour ----

export const SHADES = ['#ECE9E1', '#C9CFDC', '#8794B4', '#3D4F7A', '#0D2045'];
// The mock stepped at fixed figures that assumed cache reads were counted. Here
// the steps are the same fractions of the week's busiest hour (its 25, 75 and
// 150 against a peak of 332), so the shades follow whatever the figures are.
export const STEPS = [25 / 332, 75 / 332, 150 / 332];

export function shadeLevel(tokens, peak) {
  if (!(tokens > 0) || !(peak > 0)) return 0;
  const r = tokens / peak;
  return r <= STEPS[0] ? 1 : r <= STEPS[1] ? 2 : r <= STEPS[2] ? 3 : 4;
}

const weekdayOf = date => {
  const [y, m, d] = String(date).split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const hourLabel = h => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;

export function heatRows(week) {
  const days = Array.isArray(week?.days) ? week.days : [];
  const peak = week?.peak ?? null;
  const busiest = Math.max(0, ...days.map(d => d.total ?? 0));
  const rows = days.map(d => ({
    date: d.date,
    label: weekdayOf(d.date),
    total: compactTokens(d.total ?? 0),
    strong: busiest > 0 && (d.total ?? 0) >= busiest / 2,
    cells: (d.hours ?? []).map((tokens, hour) => ({
      hour, tokens, level: shadeLevel(tokens, peak?.tokens),
      peak: Boolean(peak) && peak.date === d.date && peak.hour === hour
    }))
  }));
  return {
    rows,
    total: days.reduce((s, d) => s + (d.total ?? 0), 0),
    peakLabel: peak ? `${weekdayOf(peak.date)} ${hourLabel(peak.hour)}` : null
  };
}
