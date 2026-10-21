// The agent views on the Orbit Overview: the agent work map, Today agent by
// agent and Latest runs. Plain functions over the `agentWork` block the server
// builds from the transcripts (server/lib/agent-work.mjs), checked by
// web/test/orbit-agents.test.js. "Today" is the viewer's local day.
import { clock, compactTokens, agentColors } from './page.js';
import { agentOf } from './board.js';

const HOUR = 3600 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A pulse on the map means a request within this long.
export const ACTIVE_MS = HOUR;
// What a run with no task line says: a run started on its own with
// `claude -p --agent` that no scheduled job accounts for, or a subagent whose
// brief had no one-line description.
export const DIRECT_RUN = 'Direct run';
export const NO_BRIEF = 'No brief line';
const taskOf = r => r.task ?? (r.direct ? DIRECT_RUN : NO_BRIEF);

const startOfDay = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nextMidnight = now => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); };
const runsOf = work => (Array.isArray(work?.runs) ? work.runs.filter(r => Number.isFinite(r?.start)) : []);
const ready = (work, roster) => Boolean(work && work.lead && (roster?.agents ?? []).length > 0);

// ---- the agent work map ----

// The design's geometry, in percent of a square box: the lead at (50, 47), the
// others evenly round a circle of radius 34, clockwise from the top. A node's
// diameter runs from 8% to 15% of the box, its area following its tokens over
// 7 days, so an idle agent keeps the floor; the lead's is fixed at 23%.
export const MAP = { cx: 50, cy: 47, r: 34, min: 8, max: 15, lead: 23 };

export function mapView({ work, roster, now }) {
  if (!ready(work, roster)) return null;
  const agents = roster.agents;
  const index = agents.findIndex(a => a.key === work.lead);
  if (index < 0) return null;
  const today = startOfDay(now);
  const todays = runsOf(work).filter(r => r.start >= today);
  const tokensOf = key => (Number.isFinite(work.agents?.[key]?.tokens7d) ? work.agents[key].tokens7d : 0);
  const activeOf = key => {
    const last = work.agents?.[key]?.lastActivity;
    return Number.isFinite(last) && now - last <= ACTIVE_MS;
  };
  const others = agents.map((a, i) => ({ ...a, index: i })).filter(a => a.key !== work.lead);
  const most = Math.max(0, ...others.map(a => tokensOf(a.key)));
  const nodes = others.map((a, k) => {
    const angle = ((-90 + (k * 360) / others.length) * Math.PI) / 180;
    const tokens = tokensOf(a.key);
    return {
      key: a.key, name: a.name, index: a.index,
      x: MAP.cx + MAP.r * Math.cos(angle),
      y: MAP.cy + MAP.r * Math.sin(angle),
      size: MAP.min + (most > 0 ? (MAP.max - MAP.min) * Math.sqrt(tokens / most) : 0),
      tokens,
      runs: todays.filter(r => r.agent === a.key).length,
      active: activeOf(a.key),
      color: agentColors(a.index).night
    };
  });
  return {
    lead: {
      key: work.lead, name: agents[index].name, index, size: MAP.lead,
      tokens: tokensOf(work.lead),
      // The lead's badge counts every run today, since it started them all.
      runs: todays.length,
      active: activeOf(work.lead),
      color: agentColors(index).night
    },
    nodes,
    activeNames: nodes.filter(n => n.active).map(n => n.name)
  };
}

// ---- Today, agent by agent ----

// "Mon 5:30 AM", or just the time when it is today.
const whenLabel = (t, now) => (t >= startOfDay(now) && t < nextMidnight(now) ? clock(t) : `${WEEKDAYS[new Date(t).getDay()]} ${clock(t)}`);

export function todayView({ work, roster, crons, jobs, now }) {
  if (!ready(work, roster)) return null;
  const agents = roster.agents;
  const start = startOfDay(now);
  const end = nextMidnight(now);
  const span = end - start;
  const pos = t => `${(((t - start) / span) * 100).toFixed(2)}%`;
  const todays = runsOf(work).filter(r => r.start >= start && r.start < end);
  const largest = Math.max(0, ...todays.map(r => r.tokens ?? 0));
  const mark = r => ({
    left: pos(r.start),
    d: 8 + 20 * Math.sqrt(largest > 0 ? (r.tokens ?? 0) / largest : 0),
    title: `${clock(r.start)} · ${taskOf(r)} · ${compactTokens(r.tokens)} tokens`
  });
  const cronList = Array.isArray(crons) ? crons : [];
  const nextJob = key => {
    let best = null;
    for (const c of cronList) {
      const job = jobs?.[c?.label];
      if (job?.owner !== key || !Number.isFinite(c.nextRunAt) || c.nextRunAt <= now) continue;
      if (!best || c.nextRunAt < best.t) best = { t: c.nextRunAt, name: job.name };
    }
    return best;
  };
  const lane = (agent, name, runs) => {
    const next = runs.length === 0 ? nextJob(agent.key) : null;
    return {
      key: `agent-${agent.key}`, name, agent, color: agentColors(agent.index).day,
      count: runs.length, marks: runs.map(mark), scheduled: false,
      note: runs.length > 0 ? '' : `No runs today${next ? ` · next: ${next.name}, ${whenLabel(next.t, now)}` : ''}`
    };
  };

  const lead = { ...agents.find(a => a.key === work.lead), index: agents.findIndex(a => a.key === work.lead) };
  const lanes = [lane(lead, `${lead.name ?? work.lead} helpers`, todays.filter(r => r.agent === work.lead))];
  agents.forEach((a, index) => {
    if (a.key !== work.lead) lanes.push(lane({ ...a, index }, a.name, todays.filter(r => r.agent === a.key)));
  });
  // Scheduled: each calendar job's due times so far today. Whether it then ran
  // comes with the health strip; until then these show the schedule only.
  const due = [];
  for (const c of cronList) {
    for (const t of Array.isArray(c?.dueAt) ? c.dueAt : []) {
      if (Number.isFinite(t) && t >= start && t <= now) due.push({ t, name: jobs?.[c.label]?.name ?? c.name ?? c.label });
    }
  }
  due.sort((a, b) => a.t - b.t);
  lanes.push({
    key: 'scheduled', name: 'Scheduled', agent: null, color: '#4E5872', scheduled: true, count: due.length, note: '',
    marks: due.map(e => ({ left: pos(e.t), d: 10, title: `${clock(e.t)} · ${e.name} · scheduled` }))
  });

  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => {
    const d = new Date(start);
    d.setHours(h, 0, 0, 0);
    const label = h % 24 === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`;
    return { label, left: pos(d.getTime()), align: h === 0 ? 'start' : h === 24 ? 'end' : 'center' };
  });
  return { lanes, total: todays.length, nowLeft: pos(now), nowLabel: clock(now), hours };
}

// ---- Latest runs ----

export function latestRuns({ work, roster, now, limit = 10 }) {
  const today = startOfDay(now);
  return runsOf(work)
    .slice()
    .sort((a, b) => b.start - a.start)
    .slice(0, limit)
    .map(r => {
      const agent = agentOf(r.agent, roster) ?? { key: r.agent, name: String(r.agent), index: -1 };
      return {
        key: `${r.agent}-${r.start}`,
        day: r.start >= today ? null : WEEKDAYS[new Date(r.start).getDay()],
        time: clock(r.start),
        agent,
        name: r.helper ? `${agent.name} helper` : agent.name,
        task: taskOf(r),
        tokens: compactTokens(r.tokens)
      };
    });
}
