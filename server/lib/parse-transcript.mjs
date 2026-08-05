import { homedir } from 'node:os';
import { join } from 'node:path';

export const TRANSCRIPT_ROOTS = [
  { root: join(homedir(), '.claude', 'projects'), surface: 'Code' },
  {
    root: join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    surface: 'Cowork'
  }
];

export function totalTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
}

export function parseTranscript(text, surface) {
  const records = [];
  let sessionId = null, title = null, cwd = null, gitBranch = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (d.sessionId && !sessionId) sessionId = d.sessionId;
    if (d.type === 'ai-title' && d.aiTitle) { title = d.aiTitle; continue; }
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.gitBranch && gitBranch === null) gitBranch = d.gitBranch === 'HEAD' ? null : d.gitBranch;

    const message = d.message;
    if (!message || typeof message !== 'object' || !message.usage) continue;
    const tokens = totalTokens(message.usage);
    if (tokens <= 0) continue;
    const ts = Date.parse(d.timestamp ?? '');
    if (!Number.isFinite(ts)) continue;
    records.push({ ts, model: message.model ?? 'unknown', tokens });
  }

  return { sessionId, title, surface, cwd, gitBranch, records };
}
