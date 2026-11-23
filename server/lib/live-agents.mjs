// The live agents panel on the Overview (war room slice 1, board 83daafe7): the
// agent runs going right now, from the transcripts the sessions collector already
// reads each minute. No `claude` is started for it: the `claude agents --json` poll
// was dropped on 2026-10-30 (README, "How often the server starts `claude`"), and it
// listed sessions, not the subagents inside them.
//
// A run is a subagent (<session>/subagents/agent-*.jsonl, named by its .meta.json)
// or a run started as `claude -p --agent <slug>` for an agent on the roster. It is
// live while its latest assistant line has not ended it (lib/parse-transcript.mjs,
// endsRun) and some line was written within LIVE_WINDOW_MS. A run stopped from
// outside (its session closed, a task stopped) writes no final answer, so the window
// is what drops it; until then the page marks it quiet. A stopped task may write an
// interruption mark (seen 2026-11-14 and 11-18), but whether every mark ends a subagent
// is unchecked and the restart warning's safe side is one run too many, so the panel
// doesn't count it as an end; the needs-you asks do (endedThreads, below), since an
// ask made before the mark is over either way.
//
// What the page gets is read-only and says no more than the Latest runs panel does:
// the agent's type, the brief's one-line description (never the prompt), when the
// run started and last wrote, its model family, its new tokens, and the name of
// the session that started it. No path, session id or prompt text. `id` is a hash
// of the transcript's path, a stable key for the page's list and the one handle a
// stop names (war room slice 2, lib/agent-stop.mjs): the lead hashes its own
// subagent paths the same way to find the run (C2).
//
// `stoppable` marks the rows a Stop button may show on: a background subagent (its
// meta says `requestShape: "background"`; a foreground one can't be stopped, its
// parent takes no turn until it returns) of an agent on the roster, in a session
// named as the lead's. The name is only what the page offers: anyone can name a
// session so (Ultron's L4). What a stop can reach is decided by the lead itself,
// which matches the id against its own session's files and stops only its own tasks.
import { createHash } from 'node:crypto';
import { familyOf } from './hourly.mjs';
import { taskLine } from './agent-work.mjs';
import { agentKey, NEEDS_YOU_TTL_MS } from './needs-you.mjs';

// A tool call can run 10 minutes (Bash's longest timeout) without a line written,
// so the window is longer than that.
export const LIVE_WINDOW_MS = 15 * 60 * 1000;
// Only bounds a runaway; Jarvis runs a handful at a time.
export const MAX_LIVE = 20;
const LABEL_MAX = 40;

const fold = v => (typeof v === 'string' ? v.trim().toLowerCase() : null);
// A short label: one plain line (taskLine drops controls and reordering marks),
// cut to LABEL_MAX characters.
function label(value) {
  const line = taskLine(value);
  if (line === null) return null;
  const chars = [...line];
  return chars.length <= LABEL_MAX ? line : `${chars.slice(0, LABEL_MAX - 1).join('').trimEnd()}…`;
}

// A run's latest time: its newest request, or a later line (a tool's result).
function lastOf(records, t) {
  let last = -Infinity;
  for (const r of records) last = Math.max(last, r.ts);
  return Number.isFinite(t?.lastLineTs) ? Math.max(last, t.lastLineTs) : last;
}

const idOf = file => (typeof file === 'string' ? createHash('sha256').update(file).digest('hex').slice(0, 16) : null);

export function buildLiveAgents({ transcripts, sessionNames, roster, now = Date.now() }) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const byWord = new Map();
  for (const a of agents) {
    byWord.set(fold(a.key), a);
    byWord.set(fold(a.name), a);
  }
  const rosterAgent = word => byWord.get(fold(word)) ?? null;
  const lead = agents[0] ?? null;
  const isLeadName = name => lead !== null && name !== null && name !== undefined && (fold(name) === fold(lead.name) || fold(name) === fold(lead.key));
  // The session a subagent belongs to, by its `claude -n` name: the roster's
  // spelling when it is an agent's, else the name itself; null when unnamed.
  const sessionOf = id => {
    const name = sessionNames?.get?.(id);
    return rosterAgent(name)?.name ?? label(name);
  };

  const live = [];
  // Live subagent runs with no .meta.json: not shown (no type or brief to show), but
  // counted in `unplaced` below, since nothing says whose they are (Ultron's L1 on §28).
  let bare = 0;
  for (const t of Array.isArray(transcripts) ? transcripts : []) {
    if (!t || t.ended) continue;
    const records = Array.isArray(t.records) ? t.records.filter(r => Number.isFinite(r?.ts) && Number.isFinite(r?.tokens)) : [];
    if (records.length === 0) continue;

    let row;
    if (t.subagent) {
      if (!t.meta) {
        if (now - lastOf(records, t) <= LIVE_WINDOW_MS) bare += 1;
        continue;
      }
      const agent = rosterAgent(t.meta.agentType);
      const stoppable = agent !== null && agent !== lead && t.meta.requestShape === 'background' && isLeadName(sessionNames?.get?.(t.sessionId));
      row = { agent: agent?.key ?? null, type: label(t.meta.agentType), direct: false, task: taskLine(t.meta.description), session: sessionOf(t.sessionId), stoppable };
    } else {
      const agent = typeof t.agentSetting === 'string' ? agents.find(a => a.key === t.agentSetting) : null;
      if (!agent) continue;
      row = { agent: agent.key, type: agent.key, direct: true, task: null, session: null, stoppable: false };
    }

    let start = Infinity, tokens = 0, latest = null;
    for (const r of records) {
      start = Math.min(start, r.ts);
      tokens += r.tokens;
      if (latest === null || r.ts > latest.ts) latest = r;
    }
    const last = lastOf(records, t);
    if (now - last > LIVE_WINDOW_MS) continue;
    live.push({ id: idOf(t.filePath), ...row, start, last, tokens, model: familyOf(latest.model) });
  }

  live.sort((a, b) => b.start - a.start);
  // `unplaced`: live subagent runs in no named session. A subagent is placed in its
  // session by that session's `claude -n` name alone, so the lead's current session before
  // its first name line (or with that line unread) puts his runs here, not under his name.
  // Restart Jarvis can't tell those from another terminal's, so any counts as "not known"
  // (lib/jarvis-recover.mjs, runsAtRisk; board 54b191ec, Ultron's M1). Over all live
  // runs, not only the MAX_LIVE sent, and with the live runs that have no meta file (in
  // any session: unshown, so no confirm can name them).
  const unplaced = live.filter(r => !r.direct && r.session === null).length + bare;
  return { windowMs: LIVE_WINDOW_MS, more: Math.max(0, live.length - MAX_LIVE), runs: live.slice(0, MAX_LIVE), unplaced };
}

// The subagent threads that have stopped, for the needs-you asks (lib/needs-you.mjs,
// endThreads; board 2c49fcfa, Ultron's L1 on §28): Map<session id, Map<agentKey of the
// agent id, when it stopped>>. A subagent's transcript is <session>/subagents/
// agent-<agent id>.jsonl, the id its hooks send as `agent_id`; it stopped at its final
// answer or at an interruption mark (lib/parse-transcript.mjs, stoppedAt). A stop older
// than an ask's lapse can end no ask, so it is left out.
const AGENT_FILE = /(?:^|\/)agent-([^/]+)\.jsonl$/;
export function endedThreads(transcripts, now = Date.now()) {
  const out = new Map();
  for (const t of Array.isArray(transcripts) ? transcripts : []) {
    if (!t?.subagent || typeof t.sessionId !== 'string' || !Number.isFinite(t.stoppedAt)) continue;
    if (now - t.stoppedAt >= NEEDS_YOU_TTL_MS) continue;
    const id = typeof t.filePath === 'string' ? AGENT_FILE.exec(t.filePath)?.[1] : null;
    if (!id) continue;
    if (!out.has(t.sessionId)) out.set(t.sessionId, new Map());
    out.get(t.sessionId).set(agentKey(id), t.stoppedAt);
  }
  return out;
}
