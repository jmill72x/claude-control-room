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
// agent's scheduled job that fell due just before it started, if one did. Its
// `model` is the family of its latest request (lib/hourly.mjs, as Burn classifies
// them), and `leadModel` is the same for the lead's own session: the Now chip
// says which model the lead runs on from the transcript, not from a setting.
import { familyOf } from './hourly.mjs';

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

// The roster's rules, ready for ownerOf: null when the roster names no agent.
function ownerRules(roster, sessionNames) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const lead = agents[0] ?? null;
  if (!lead) return null;
  const leadNames = new Set([fold(lead.name), fold(lead.key)]);
  return { lead, onRoster: new Set(agents.map(a => a.key)), isLead: name => leadNames.has(fold(name)), sessionNames };
}

// Whose tokens a transcript's are, by the rules at the top of this file: a run of
// `agent` (a helper of the lead's when `helper`), the lead's own session (`own`), or
// null for a transcript these views leave out. One function, so the agent views and
// the OpenTelemetry cross-check (agentHours, lib/otel.mjs) can never count apart.
function ownerOf(t, rules) {
  if (t.subagent) {
    if (!t.meta) return null;
    if (rules.onRoster.has(t.meta.agentType)) return { agent: t.meta.agentType, helper: false, own: false };
    if (rules.isLead(rules.sessionNames?.get?.(t.sessionId))) return { agent: rules.lead.key, helper: true, own: false };
    return null;
  }
  if (rules.onRoster.has(t.agentSetting)) return { agent: t.agentSetting, helper: false, own: false };
  if (rules.isLead(t.agentName)) return { agent: rules.lead.key, helper: false, own: true };
  return null;
}

const HOUR = 3600 * 1000;
// The cross-check's reach: a day's window, plus a week of hours the panel's 7-day
// figures could ever ask for, plus one for the hour in progress.
export const HOURS_KEPT = 8 * 24;

// Each roster agent's new tokens by the hour (keys are the hours' starts, in ms), by
// exactly the attribution the agent views use, and `all`: every Claude Code transcript's
// (Cowork's left out, since the desktop app's agent sends no metrics here). For the
// OpenTelemetry cross-check (lib/otel.mjs). Hours older than HOURS_KEPT are left out.
export function agentHours({ transcripts, sessionNames, roster, now = Date.now() }) {
  const rules = ownerRules(roster, sessionNames);
  const byAgent = Object.fromEntries((rules ? roster.agents : []).map(a => [a.key, {}]));
  const all = {};
  const from = Math.floor(now / HOUR) * HOUR - (HOURS_KEPT - 1) * HOUR;
  const add = (into, hour, n) => { into[hour] = (into[hour] ?? 0) + n; };
  for (const t of Array.isArray(transcripts) ? transcripts : []) {
    const records = Array.isArray(t?.records) ? t.records.filter(r => Number.isFinite(r?.ts) && Number.isFinite(r?.tokens) && r.ts >= from && r.ts <= now) : [];
    if (records.length === 0) continue;
    const owner = rules ? ownerOf(t, rules) : null;
    for (const r of records) {
      const hour = Math.floor(r.ts / HOUR) * HOUR;
      if (t.surface !== 'Cowork') add(all, hour, r.tokens);
      if (owner) add(byAgent[owner.agent], hour, r.tokens);
    }
  }
  return { byAgent, all };
}

export function buildAgentWork({ transcripts, sessionNames, roster, crons, now = Date.now() }) {
  const rules = ownerRules(roster, sessionNames);
  if (!rules) return { lead: null, leadModel: null, leadLast: null, agents: {}, runs: [] };
  const agents = roster.agents;
  const lead = rules.lead;
  const dueByLabel = new Map();
  for (const c of Array.isArray(crons) ? crons : []) {
    if (typeof c?.label === 'string' && Array.isArray(c.dueAt)) dueByLabel.set(c.label, c.dueAt.filter(Number.isFinite));
  }

  const totals = Object.fromEntries(agents.map(a => [a.key, { tokens7d: 0, lastActivity: null }]));
  let leadModel = null, leadLast = null;
  const latestOf = records => records.reduce((best, r) => (best === null || r.ts > best.ts ? r : best), null);
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

    const owner = ownerOf(t, rules);
    if (!owner) continue;
    if (owner.own) {
      count(lead.key, records);
      const latest = latestOf(records);
      if (latest && (leadLast === null || latest.ts > leadLast)) { leadLast = latest.ts; leadModel = familyOf(latest.model); }
      continue;
    }
    const { agent, helper } = owner;
    let task = t.subagent ? taskLine(t.meta.description) : null;

    count(agent, records);
    let start = Infinity, last = -Infinity, tokens = 0;
    for (const r of records) {
      start = Math.min(start, r.ts);
      last = Math.max(last, r.ts);
      tokens += r.tokens;
    }
    if (start < now - WEEK) continue;
    if (!t.subagent) task = routineFor(agent, start, roster.jobs, dueByLabel);
    runs.push({ agent, helper, direct: !t.subagent, task, tokens, start, last, model: familyOf(latestOf(records).model) });
  }

  runs.sort((a, b) => b.start - a.start);
  return { lead: lead.key, leadModel, leadLast, agents: totals, runs: runs.slice(0, MAX_RUNS) };
}
