import { basename } from 'node:path';
import { formatRelative } from './humanize.mjs';

export function buildProjects({ agents = [], coworkSessions = [], transcripts = [] }, now = Date.now()) {
  const projects = new Map();

  // Keyed by tool AND name: /Projects/docs (Code) and /CoworkSpace/docs (Cowork)
  // are different projects that happen to share a basename.
  const touch = (name, tool) => {
    const key = `${tool}:${name}`;
    if (!projects.has(key)) {
      projects.set(key, { name, tool, running: false, lastTs: null, branch: null, tasks: null });
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
    const p = touch(basename(t.cwd), 'Code');
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
      if (a.running !== b.running) return a.running ? -1 : 1;
      return (b.lastTs ?? -Infinity) - (a.lastTs ?? -Infinity);
    })
    .map(({ lastTs, ...rest }) => rest);
}
