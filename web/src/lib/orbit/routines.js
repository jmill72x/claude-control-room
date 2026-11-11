// Today's routines (docs/design/2026-11-10-jarvis-os-home.md, §5.4): a phone-readable
// list of the calendar jobs due today, each with its verdict, then the next one.
// Plain functions over the crons panel and config's `jobs`, checked by
// web/test/orbit-routines.test.js. "Today" is the viewer's local day.
import { clock } from './page.js';
import { RAN_GRACE_MS } from './agents.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const startOfDay = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = now => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); };

// The verdict on one due time of one job:
//   ran        its log was written at or after the due time (the lane's filled mark)
//   due        the time hasn't come yet
//   acked      no run since, but the job's failure is acknowledged
//   missed     no run since, and job-status says the job failed
//   late       no run since, the time has passed, and the job is not (yet) failed
//   scheduled  no run time is known at all (no job-status overlay)
export function verdictFor(cron, dueAt, now) {
  if (dueAt > now) return 'due';
  const last = Number.isFinite(cron?.lastRunAt) ? cron.lastRunAt : null;
  if (last === null) return 'scheduled';
  if (last >= dueAt - RAN_GRACE_MS) return 'ran';
  if (cron.ack) return 'acked';
  if (cron.ok === false || cron.state === 'failed') return 'missed';
  return 'late';
}

export const VERDICT_WORDS = {
  ran: { word: 'ran', tone: 'ok' },
  due: { word: 'due', tone: 'idle' },
  acked: { word: 'acked', tone: 'idle' },
  missed: { word: 'missed', tone: 'bad' },
  late: { word: 'no run yet', tone: 'idle' },
  scheduled: { word: 'scheduled', tone: 'idle' }
};

// The rows: every due time today of every calendar job (`dueAt`, which interval
// jobs never have), in time order, named from config. Then the next run after
// the last of today's, from `nextRunAt`.
export function routinesView({ crons, jobs, now }) {
  const start = startOfDay(now), end = endOfDay(now);
  const list = Array.isArray(crons) ? crons : [];
  const rows = [];
  for (const c of list) {
    const name = jobs?.[c?.label]?.name ?? c?.name ?? c?.label ?? 'a job';
    for (const t of Array.isArray(c?.dueAt) ? c.dueAt : []) {
      if (!Number.isFinite(t) || t < start || t >= end) continue;
      const verdict = verdictFor(c, t, now);
      rows.push({ key: `${c.label ?? name}-${t}`, t, time: clock(t), name, verdict, ...VERDICT_WORDS[verdict] });
    }
  }
  rows.sort((a, b) => a.t - b.t || a.name.localeCompare(b.name));
  // Later today too: a job whose next run is today but not in `dueAt` yet.
  for (const c of list) {
    const t = c?.nextRunAt;
    if (!Number.isFinite(t) || t <= now || t >= end) continue;
    const name = jobs?.[c?.label]?.name ?? c?.name ?? c?.label ?? 'a job';
    if (rows.some(r => r.name === name && Math.abs(r.t - t) < 60e3)) continue;
    rows.push({ key: `${c.label ?? name}-${t}`, t, time: clock(t), name, verdict: 'due', ...VERDICT_WORDS.due });
  }
  rows.sort((a, b) => a.t - b.t || a.name.localeCompare(b.name));
  let next = null;
  for (const c of list) {
    const t = c?.nextRunAt;
    if (!Number.isFinite(t) || t < end) continue;
    if (!next || t < next.t) next = { t, name: jobs?.[c?.label]?.name ?? c?.name ?? c?.label ?? 'a job' };
  }
  if (next) next = { ...next, text: `${WEEKDAYS[new Date(next.t).getDay()]} ${clock(next.t)} ${next.name}` };
  const counts = { ran: 0, due: 0, missed: 0, acked: 0 };
  for (const r of rows) if (r.verdict in counts) counts[r.verdict]++;
  return { rows, next, counts };
}

// The panel's one-line summary: "3 ran · 1 due · 1 missed".
export function routinesSummary(view) {
  if (!view || view.rows.length === 0) return 'No calendar job runs today.';
  const c = view.counts;
  const parts = [];
  if (c.ran) parts.push(`${c.ran} ran`);
  if (c.due) parts.push(`${c.due} due`);
  if (c.missed) parts.push(`${c.missed} missed`);
  if (c.acked) parts.push(`${c.acked} acked`);
  return parts.join(' · ') || `${view.rows.length} scheduled`;
}
