import { basename } from 'node:path';
import { formatRelative } from './humanize.mjs';

// Projects for the classic page's column 02, from transcripts and Cowork
// session metadata only. Whether a project is running used to come from
// `claude agents --json`, polled every 30 s; that poll was dropped on
// 2026-10-30 because each run started a short-lived `claude` that loads the
// shared sign-in (README, "How often the server starts claude"). So these rows
// carry no `running` field at all: absent means "not tracked", which the page
// shows as no state, unlike `null` (an ingested project whose state is unknown).
export function buildProjects({ coworkSessions = [], transcripts = [] }, now = Date.now()) {
  const projects = new Map();
  // Keyed by tool AND name: /Projects/docs (Code) and /CoworkSpace/docs (Cowork)
  // are different projects that happen to share a basename.
  const touch = (name, tool) => {
    const key = `${tool}:${name}`;
    if (!projects.has(key)) {
      projects.set(key, { name, tool, lastTs: null, branch: null, tasks: null });
    }
    return projects.get(key);
  };

  // A missing timestamp must never be written into lastTs.
  const noteActivity = (p, ts) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    if (p.lastTs === null || ts > p.lastTs) p.lastTs = ts;
  };

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
        detail: p.branch ? `${edited} · ${p.branch}` : edited,
        tasks: p.tasks,
        lastTs: p.lastTs
      };
    })
    .sort((a, b) => (b.lastTs ?? -Infinity) - (a.lastTs ?? -Infinity))
    .map(({ lastTs, ...rest }) => rest);
}
