import { basename } from 'node:path';

const WEEK = 7 * 24 * 3600 * 1000;

const MODEL_NAMES = [
  [/opus/i, 'Opus'], [/sonnet/i, 'Sonnet'], [/haiku/i, 'Haiku'], [/fable/i, 'Fable']
];

function prettyModel(id) {
  for (const [re, name] of MODEL_NAMES) if (re.test(id)) return name;
  return id;
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// Day bucketing is by CALENDAR day, not elapsed milliseconds. An elapsed-hours
// floor mislabels Mon 23:00 as "Yest" when read on Wed 01:00 — only ~26h have
// passed, but it is two calendar days back.
function calendarDaysBetween(ts, now) {
  const a = new Date(ts), b = new Date(now);
  const dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((dayB - dayA) / (24 * 3600 * 1000));
}

function whenLabel(ts, now) {
  const days = calendarDaysBetween(ts, now);
  const d = new Date(ts);
  if (days === 0) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (days === 1) return 'Yest';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

export function aggregate(sessions, now = Date.now(), opts = {}) {
  const cutoff = now - (opts.windowMs ?? WEEK);

  const live = sessions.map(s => ({
    ...s,
    records: s.records.filter(r => r.ts >= cutoff)
  })).filter(s => s.records.length > 0);

  const grandTotal = live.reduce((sum, s) => sum + s.records.reduce((a, r) => a + r.tokens, 0), 0);

  const modelTotals = new Map();
  const surfaceTotals = new Map();
  const projectTotals = new Map();

  for (const s of live) {
    const sessionTokens = s.records.reduce((a, r) => a + r.tokens, 0);
    for (const r of s.records) {
      const m = prettyModel(r.model);
      modelTotals.set(m, (modelTotals.get(m) ?? 0) + r.tokens);
    }
    surfaceTotals.set(s.surface, (surfaceTotals.get(s.surface) ?? 0) + sessionTokens);
    const project = s.cwd ? basename(s.cwd) : 'unknown';
    projectTotals.set(project, (projectTotals.get(project) ?? 0) + sessionTokens);
  }

  const byModel = [...modelTotals.entries()]
    .map(([name, tokens]) => ({ name, tokens, pct: pct(tokens, grandTotal) }))
    .sort((a, b) => b.tokens - a.tokens);

  const measurableTotal = (surfaceTotals.get('Cowork') ?? 0) + (surfaceTotals.get('Code') ?? 0);
  const bySurface = [
    { name: 'Cowork', tokens: surfaceTotals.get('Cowork') ?? 0, measurable: true },
    { name: 'Code', tokens: surfaceTotals.get('Code') ?? 0, measurable: true },
    { name: 'Chat', tokens: null, measurable: false }
  ].map(s => ({ ...s, pct: s.measurable ? pct(s.tokens, measurableTotal) : null }));

  const ranked = [...projectTotals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const byProject = top.map(([name, tokens]) => ({ name, tokens, pct: pct(tokens, grandTotal) }));
  if (rest.length > 0) {
    const tokens = rest.reduce((a, [, t]) => a + t, 0);
    byProject.push({ name: 'Other', tokens, pct: pct(tokens, grandTotal) });
  }

  const recentSessions = live
    .map(s => {
      const tokens = s.records.reduce((a, r) => a + r.tokens, 0);
      const last = Math.max(...s.records.map(r => r.ts));
      const model = prettyModel(s.records[s.records.length - 1].model);
      return {
        when: whenLabel(last, now),
        title: s.title ?? (s.cwd ? basename(s.cwd) : 'Untitled'),
        surface: s.surface,
        model,
        tokens,
        pct: pct(tokens, grandTotal),
        ts: last
      };
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);

  return { byModel, bySurface, byProject, recentSessions };
}
