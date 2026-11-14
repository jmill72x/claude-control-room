// The live agents panel on the Overview (war room slice 1): plain functions over
// the `liveAgents` block the server builds from the transcripts
// (server/lib/live-agents.mjs), checked by web/test/orbit-live.test.js. Read-only.
import { compactTokens } from './page.js';
import { agentOf } from './board.js';
import { DIRECT_RUN, NO_BRIEF } from './agents.js';

// A run that has written nothing for this long is marked quiet: a long tool call,
// or a run stopped from outside that the server drops when its window passes.
export const QUIET_MS = 2 * 60 * 1000;
export const UNNAMED_SESSION = 'unnamed session';

// How long, as the panel says it: 40 s, 12 min, 1 h 05 min.
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const MODELS = { opus: 'Opus', fable: 'Fable', sonnet: 'Sonnet', haiku: 'Haiku' };

export function liveRows({ live, roster, now }) {
  const runs = Array.isArray(live?.runs) ? live.runs.filter(r => Number.isFinite(r?.start)) : [];
  return runs.map((r, i) => {
    // A subagent of a type not on the roster goes by its type (general-purpose, Explore).
    const agent = r.agent ? agentOf(r.agent, roster) : { key: null, name: r.type ?? 'subagent', index: -1 };
    const last = Number.isFinite(r.last) ? r.last : r.start;
    const quietFor = now - last;
    return {
      key: r.id ?? `${r.type}-${r.start}-${i}`,
      agent,
      name: agent.name,
      task: r.task ?? (r.direct ? DIRECT_RUN : NO_BRIEF),
      running: duration(now - r.start),
      model: MODELS[r.model] ?? null,
      tokens: Number.isFinite(r.tokens) ? `${compactTokens(r.tokens)} tokens` : null,
      session: r.direct ? DIRECT_RUN.toLowerCase() : `in ${r.session ?? UNNAMED_SESSION}`,
      quiet: quietFor >= QUIET_MS ? `quiet ${duration(quietFor)}` : null
    };
  });
}

// The panel's subtitle: how many are running, and how many the list leaves out.
export function liveSummary(live) {
  const shown = Array.isArray(live?.runs) ? live.runs.length : 0;
  const total = shown + (Number.isFinite(live?.more) ? live.more : 0);
  if (total === 0) return 'none running';
  return `${total} running${total > shown ? `, ${shown} shown` : ''}`;
}
