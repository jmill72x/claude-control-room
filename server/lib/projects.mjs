import { basename } from 'node:path';
import { formatRelative } from './humanize.mjs';

export function buildProjects({ agents = [], coworkSessions = [], transcripts = [] }, now = Date.now()) {
  const projects = new Map();

  const touch = (name, tool) => {
    if (!projects.has(name)) {
      projects.set(name, { name, tool, running: false, lastTs: null, branch: null, tasks: null });
    }
    return projects.get(name);
  };

  for (const a of agents) {
    if (!a.cwd) continue;
    const p = touch(basename(a.cwd), 'Code');
    if (a.status === 'busy') p.running = true;
  }

  for (const t of transcripts) {
    if (!t.cwd) continue;
    const p = touch(basename(t.cwd), 'Code');
    if (p.lastTs === null || t.lastTs > p.lastTs) p.lastTs = t.lastTs;
    if (t.gitBranch) p.branch = t.gitBranch;
  }

  for (const s of coworkSessions) {
    if (s.archived || !s.folder) continue;
    const p = touch(basename(s.folder), 'Cowork');
    if (p.lastTs === null || (s.lastActivityAt ?? 0) > p.lastTs) p.lastTs = s.lastActivityAt;
  }

  return [...projects.values()]
    .map(p => {
      const edited = p.lastTs ? `edited ${formatRelative(now - p.lastTs)}` : 'no recent activity';
      return {
        name: p.name,
        tool: p.tool,
        running: p.running,
        detail: p.branch ? `${edited} · ${p.branch}` : edited,
        tasks: p.tasks
      };
    })
    .sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1));
}
