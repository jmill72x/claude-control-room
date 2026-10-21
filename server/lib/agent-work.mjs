// The agent views on the Orbit page (the agent work map, Today agent by agent
// and Latest runs), built from the transcripts the sessions collector already
// reads. Who ran comes from what Claude Code writes, never from guessing:
//
//   - A subagent (<session>/subagents/agent-*.jsonl) is the run of the agent its
//     .meta.json names (`agentType`), when that agent is on the roster.
//   - Any other subagent under the lead's own session (general-purpose, Explore,
//     a fork) is a helper of the lead's. The lead is the roster's first agent,
//     and its session is the top-level one whose `agent-name` is the lead's name
//     or key (it was started as `claude -n <name>`).
//   - A top-level run started as `claude -p --agent <slug>` (its `agent-setting`
//     line) is that agent's run, when the agent is on the roster.
//   - The lead's own session counts towards the lead's tokens, but is not a run.
//   - Anything else (another agent, an unnamed session, a subagent whose meta
//     file is missing) is left out of these views. The totals elsewhere on the
//     page still count it.
//
// `direct` marks a run started on its own (`claude -p --agent`), not by a
// session; with no routine named, the page calls it a direct run.
//
// A run's time is its first request and its tokens the sum of its requests,
// each request counted once (collectSessions has dropped the copies). Its task
// is the brief's one-line description; for a --agent run, the name of the
// agent's scheduled job that fell due just before it started, if one did.

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
// How long after a job falls due its run may start and still be named for it:
// launchd starts a job within seconds, and the routine reads its files first.
export const ROUTINE_WINDOW_MS = 15 * 60 * 1000;
// A week of runs is about 130; this only bounds a runaway.
const MAX_RUNS = 500;
const TASK_MAX = 120;

// C0 and C1 controls, and the characters that reorder text (U+202A-202E,
// U+2066-2069): a brief's line is shown as text, so none of them may arrive.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// One plain line of at most 120 characters, or null when nothing is left.
export function taskLine(value) {
  if (typeof value !== 'string') return null;
  const line = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  const chars = [...line];
  return chars.length <= TASK_MAX ? line : `${chars.slice(0, TASK_MAX - 1).join('').trimEnd()}…`;
}

const fold = v => (typeof v === 'string' ? v.trim().toLowerCase() : null);

// The routine a --agent run belongs to: of the jobs the agent owns, the one
// that fell due most recently at or before the run started, within the window.
function routineFor(agent, start, jobs, dueByLabel) {
  let best = null;
  for (const [label, job] of Object.entries(jobs ?? {})) {
    if (job?.owner !== agent) continue;
    for (const due of dueByLabel.get(label) ?? []) {
      if (due <= start && start - due <= ROUTINE_WINDOW_MS && (!best || due > best.due)) best = { due, name: job.name };
    }
  }
  return best?.name ?? null;
}

export function buildAgentWork({ transcripts, sessionNames, roster, crons, now = Date.now() }) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const lead = agents[0] ?? null;
  if (!lead) return { lead: null, agents: {}, runs: [] };

  const onRoster = new Set(agents.map(a => a.key));
  const leadNames = new Set([fold(lead.name), fold(lead.key)]);
  const isLead = name => leadNames.has(fold(name));
  const dueByLabel = new Map();
  for (const c of Array.isArray(crons) ? crons : []) {
    if (typeof c?.label === 'string' && Array.isArray(c.dueAt)) dueByLabel.set(c.label, c.dueAt.filter(Number.isFinite));
  }

  const totals = Object.fromEntries(agents.map(a => [a.key, { tokens7d: 0, lastActivity: null }]));
  const count = (key, records) => {
    const t = totals[key];
    for (const r of records) {
      if (r.ts >= now - WEEK) t.tokens7d += r.tokens;
      if (t.lastActivity === null || r.ts > t.lastActivity) t.lastActivity = r.ts;
    }
  };

  const runs = [];
  for (const t of Array.isArray(transcripts) ? transcripts : []) {
    const records = Array.isArray(t?.records) ? t.records.filter(r => Number.isFinite(r?.ts) && Number.isFinite(r?.tokens)) : [];
    if (records.length === 0) continue;

    let agent = null, helper = false, task = null;
    if (t.subagent) {
      if (!t.meta) continue;
      if (onRoster.has(t.meta.agentType)) agent = t.meta.agentType;
      else if (isLead(sessionNames?.get?.(t.sessionId))) { agent = lead.key; helper = true; }
      else continue;
      task = taskLine(t.meta.description);
    } else if (onRoster.has(t.agentSetting)) {
      agent = t.agentSetting;
    } else if (isLead(t.agentName)) {
      count(lead.key, records);
      continue;
    } else {
      continue;
    }

    count(agent, records);
    let start = Infinity, last = -Infinity, tokens = 0;
    for (const r of records) {
      start = Math.min(start, r.ts);
      last = Math.max(last, r.ts);
      tokens += r.tokens;
    }
    if (start < now - WEEK) continue;
    if (!t.subagent) task = routineFor(agent, start, roster.jobs, dueByLabel);
    runs.push({ agent, helper, direct: !t.subagent, task, tokens, start, last });
  }

  runs.sort((a, b) => b.start - a.start);
  return { lead: lead.key, agents: totals, runs: runs.slice(0, MAX_RUNS) };
}
