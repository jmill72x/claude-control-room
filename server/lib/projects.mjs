import { basename } from 'node:path';
import { formatRelative } from './humanize.mjs';

// `agentsAvailable: false` means `claude agents --json` could not be read. That
// is not "nothing is running" — it is "we do not know what is running", and the
// two must not collapse into the same `running: false` the page prints as Idle
// against every project at once. It also fires at startup by construction:
// registry.startAll runs every collector in the same tick, so the first sessions
// run always reads an empty agents cache.
// Only a current, successful read of `claude agents --json` says anything
// about what is running now. `stale` covers both a refresh that FAILED after
// once succeeding (data kept, error set) and one that simply aged out; either
// way the list is a memory, not an observation, and must read as unknown.
export const agentsReadable = envelope => envelope?.status === 'ok';

export function buildProjects(
  { agents = [], agentsAvailable = true, coworkSessions = [], transcripts = [] },
  now = Date.now()
) {
  const projects = new Map();
  const unknown = !agentsAvailable;

  // Keyed by tool AND name: /Projects/docs (Code) and /CoworkSpace/docs (Cowork)
  // are different projects that happen to share a basename.
  const touch = (name, tool) => {
    const key = `${tool}:${name}`;
    if (!projects.has(key)) {
      projects.set(key, { name, tool, running: unknown ? null : false, lastTs: null, branch: null, tasks: null });
    }
    return projects.get(key);
  };

  // A missing timestamp must never be written into lastTs.
  const noteActivity = (p, ts) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    if (p.lastTs === null || ts > p.lastTs) p.lastTs = ts;
  };

  for (const a of agents) {
    if (!a.cwd) continue;
    const p = touch(basename(a.cwd), 'Code');
    if (a.status === 'busy') p.running = true;
  }

  for (const t of transcripts) {
    if (!t.cwd) continue;
    // Use the transcript's OWN surface. Hardcoding 'Code' files every Cowork
    // transcript under a Code project named after Cowork's internal directory.
    const p = touch(basename(t.cwd), t.surface ?? 'Code');
    noteActivity(p, t.lastTs);
    if (t.gitBranch) p.branch = t.gitBranch;
  }

  for (const s of coworkSessions) {
    if (s.archived || !s.folder) continue;
    const p = touch(basename(s.folder), 'Cowork');
    noteActivity(p, s.lastActivityAt);
  }

  return [...projects.values()]
    .map(p => {
      const edited = p.lastTs ? `edited ${formatRelative(now - p.lastTs)}` : 'no recent activity';
      return {
        name: p.name,
        tool: p.tool,
        running: p.running,
        detail: p.branch ? `${edited} · ${p.branch}` : edited,
        tasks: p.tasks,
        lastTs: p.lastTs
      };
    })
    .sort((a, b) => {
      if (a.running !== b.running) return a.running === true ? -1 : 1;
      return (b.lastTs ?? -Infinity) - (a.lastTs ?? -Infinity);
    })
    .map(({ lastTs, ...rest }) => rest);
}
