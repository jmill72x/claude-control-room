import { homedir } from 'node:os';
import { join } from 'node:path';

export const TRANSCRIPT_ROOTS = [
  { root: join(homedir(), '.claude', 'projects'), surface: 'Code' },
  {
    root: join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    surface: 'Cowork'
  }
];

// `cache_read_input_tokens` is deliberately excluded. A cache read is the same
// conversation context being re-served on every request in a session, not new
// work — counting it equally with fresh tokens makes the figure track session
// length rather than actual usage, and on a real week of transcripts it was
// ~96% of the grand total (roughly a 25x inflation over new-token volume).
// input + output + cache_creation is "new tokens": text actually generated or
// newly written into the cache this turn.
export function totalTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
}

// Cache-read volume is real data, kept alongside `totalTokens` rather than
// discarded — it may be worth surfacing later (e.g. as a "context replay"
// figure) even though today's panels only render new-token totals.
export function cacheReadTokens(usage) {
  if (!usage) return 0;
  return usage.cache_read_input_tokens ?? 0;
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
    const cacheRead = cacheReadTokens(message.usage);
    // A row with no new tokens but real cache-read volume (e.g. a turn that
    // only replayed context) still carries data worth keeping, so the gate
    // checks both fields rather than `tokens` alone.
    if (tokens <= 0 && cacheRead <= 0) continue;
    const ts = Date.parse(d.timestamp ?? '');
    if (!Number.isFinite(ts)) continue;
    records.push({ ts, model: message.model ?? 'unknown', tokens, cacheReadTokens: cacheRead });
  }

  return { sessionId, title, surface, cwd, gitBranch, records };
}
