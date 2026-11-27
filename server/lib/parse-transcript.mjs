import { homedir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';

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

const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

// Claude Code writes one API response as several transcript lines, one per
// content block (thinking, text, each tool call), and every one of them
// repeats the response's usage. Summing lines counted a response once per
// block: the week to 2026-10-20 read 3x its real new-token figure. A response
// is named by the `requestId` Claude Code stamps on each line plus the API's
// message id. A line lacking either can't be matched to its siblings, so it
// counts on its own, as every line used to. JSON keeps the pair unambiguous.
export function requestKey(entry) {
  const requestId = entry?.requestId;
  const messageId = entry?.message?.id;
  if (typeof requestId !== 'string' || requestId === '') return null;
  if (typeof messageId !== 'string' || messageId === '') return null;
  return JSON.stringify([requestId, messageId]);
}

// Whether an assistant line ends its run: the model stopped on its own (a final
// answer), or it called SubagentHandback, the tool an agent of Jarvis's ends its
// run with (its result line follows, and nothing after it). A line that stopped
// to call any other tool, or has no stop reason yet, leaves the run going.
const FINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal']);
export function endsRun(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  if (content.some(c => c?.type === 'tool_use' && c.name === 'SubagentHandback')) return true;
  return FINAL_STOPS.has(message?.stop_reason);
}

// Whether a user line is Claude Code's interruption mark ("[Request interrupted by user]",
// or "... for tool use"): what a run's transcript gets when it is stopped from outside
// (TaskStop, Esc), as a text block the harness writes, never a tool's result. Seen as a
// stopped subagent's last line on 2026-11-14 and 11-18 (board 2c49fcfa).
export const INTERRUPTED = '[Request interrupted by user';
export function isInterruption(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.startsWith(INTERRUPTED);
  return Array.isArray(content) && content.some(c => c?.type === 'text' && typeof c.text === 'string' && c.text.startsWith(INTERRUPTED));
}

// One transcript's parser, fed a line at a time, so that no transcript has to be
// held whole. A long session's file outgrows what one string can hold: Node stops
// at about 512 MiB, and Jarvis's transcript was 145 MB after 31 hours on
// 2026-10-20, so reading it whole would have failed within the week and dropped
// his session out of every total. parseTranscript (a string) and
// parseTranscriptStream (a file's bytes) both feed this, so the same bytes give
// the same result either way.
export function createTranscriptParser(surface) {
  const requests = [];
  const byKey = new Map();
  let sessionId = null, title = null, cwd = null, gitBranch = null;
  // Who the session is, for the agent views (lib/agent-work.mjs). A run started
  // as `claude -p --agent <slug>` opens with an `agent-setting` line naming the
  // agent; a session started as `claude -n <name>` writes `agent-name` lines,
  // again whenever it is renamed, so the latest one is its name now.
  let agentSetting = null, agentName = null;
  // Whether the run is still going, for the live agents panel (lib/live-agents.mjs):
  // the latest time on any line (a request being sent, a tool's result), and whether
  // the latest assistant line ended the run (see endsRun).
  let lastLineTs = null, ended = false;
  // When the thread last stopped, for the needs-you asks (lib/needs-you.mjs, endThreads):
  // the time of an assistant line that ended the run or of an interruption mark, and
  // null again once an assistant line goes on. `ended` ignores the mark, so the live
  // agents panel and Restart Jarvis's warning still keep a stopped run until its window
  // lapses (counting one too many is their safe side).
  let stoppedAt = null;
  // The newest response's tool uses that have no result yet, for which thread a
  // permission card is (lib/answered-elsewhere.mjs; board 28644093): a thread stopped at
  // a prompt has its tool use written and no result. A running tool looks the same, so
  // this alone never says a prompt waits. By the tool use's id: { name, at } (the line's
  // time). A new response clears them (Claude Code sends the next request only once every
  // tool use has its result), and so does an interruption mark. The ids, the newest
  // response's id and whether the list was cut (more than OPEN_TOOLS_MAX open) also go out,
  // so lib/card-watch.mjs can carry on from where this read ended (`endOffset` below).
  const openUses = new Map();
  let openResponse = null, openCut = false;

  return {
    line(line) {
      if (!line.trim()) return;
      let d;
      try { d = JSON.parse(line); } catch { return; }
      // A line that holds JSON's null, or any other non-object, carries nothing
      // to read. Reading a field off null used to throw and fail the whole pass.
      if (d === null || typeof d !== 'object') return;

      const lineTs = Date.parse(d.timestamp ?? '');
      if (Number.isFinite(lineTs) && (lastLineTs === null || lineTs > lastLineTs)) lastLineTs = lineTs;
      if (d.type === 'assistant' && d.message && typeof d.message === 'object') {
        ended = endsRun(d.message);
        stoppedAt = ended && Number.isFinite(lineTs) ? lineTs : null;
        noteToolUses(d.message, lineTs);
      } else if (d.type === 'user' && d.message && typeof d.message === 'object') {
        if (Number.isFinite(lineTs) && isInterruption(d.message)) { stoppedAt = lineTs; openUses.clear(); openCut = false; }
        else noteToolResults(d.message);
      }

      if (d.sessionId && !sessionId) sessionId = d.sessionId;
      if (d.type === 'ai-title' && d.aiTitle) { title = d.aiTitle; return; }
      if (d.type === 'agent-setting') {
        if (agentSetting === null && typeof d.agentSetting === 'string') agentSetting = d.agentSetting;
        return;
      }
      if (d.type === 'agent-name') {
        if (typeof d.agentName === 'string') agentName = d.agentName;
        return;
      }
      if (d.cwd && !cwd) cwd = d.cwd;
      if (d.gitBranch && gitBranch === null) gitBranch = d.gitBranch === 'HEAD' ? null : d.gitBranch;

      const message = d.message;
      if (!message || typeof message !== 'object' || !message.usage) return;
      const ts = Date.parse(d.timestamp ?? '');
      if (!Number.isFinite(ts)) return;
      const key = requestKey(d);
      const seen = key === null ? undefined : byKey.get(key);
      if (seen) {
        // A response's lines can be written mid-stream: on 2026-10-20, 266 of
        // 7,433 multi-line responses had a smaller output_tokens on their early
        // lines, never a larger one. Each field's largest reading is the final usage.
        for (const f of USAGE_FIELDS) seen.usage[f] = Math.max(seen.usage[f], message.usage[f] ?? 0);
        return;
      }
      // The request keeps its first line's time and model. That time is also what
      // tells an original from a copy in another file (see dropCopiedRequests).
      const request = { ts, model: message.model ?? 'unknown', requestKey: key, usage: {} };
      for (const f of USAGE_FIELDS) request.usage[f] = message.usage[f] ?? 0;
      requests.push(request);
      if (key !== null) byKey.set(key, request);
    },

    result() {
      const records = [];
      for (const { ts, model, requestKey: key, usage } of requests) {
        const tokens = totalTokens(usage);
        const cacheRead = cacheReadTokens(usage);
        // A row with no new tokens but real cache-read volume (e.g. a turn that
        // only replayed context) still carries data worth keeping, so the gate
        // checks both fields rather than `tokens` alone.
        if (tokens <= 0 && cacheRead <= 0) continue;
        records.push({ ts, model, tokens, cacheReadTokens: cacheRead, requestKey: key });
      }
      const openTools = [...openUses].map(([id, u]) => ({ id, ...u }));
      return { sessionId, title, surface, cwd, gitBranch, agentSetting, agentName, records, lastLineTs, ended, stoppedAt, openTools, openResponse, openCut };
    }
  };

  function noteToolUses(message, lineTs) {
    const id = typeof message.id === 'string' && message.id !== '' ? message.id : null;
    if (id !== null && id !== openResponse) { openUses.clear(); openResponse = id; openCut = false; }
    if (!Number.isFinite(lineTs) || !Array.isArray(message.content)) return;
    for (const c of message.content) {
      if (c?.type !== 'tool_use' || typeof c.id !== 'string' || typeof c.name !== 'string' || c.name === '') continue;
      openUses.delete(c.id);
      openUses.set(c.id, { name: c.name.slice(0, OPEN_TOOL_NAME_MAX), at: lineTs });
      while (openUses.size > OPEN_TOOLS_MAX) { openUses.delete(openUses.keys().next().value); openCut = true; }
    }
  }
  function noteToolResults(message) {
    if (!Array.isArray(message.content)) return;
    for (const c of message.content) if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') openUses.delete(c.tool_use_id);
  }
}
// At most this many open tool uses a thread (one response's parallel calls), each name cut here.
export const OPEN_TOOLS_MAX = 20;
export const OPEN_TOOL_NAME_MAX = 200;

export function parseTranscript(text, surface) {
  const parser = createTranscriptParser(surface);
  for (const line of text.split('\n')) parser.line(line);
  return parser.result();
}

// The longest line that can still be decoded into one string.
export const MAX_LINE_BYTES = bufferConstants.MAX_STRING_LENGTH;

// A transcript read from its bytes (a file's read stream, or any async iterable
// of Buffers), one line at a time. Lines are cut at '\n' bytes, as
// text.split('\n') cuts the string: a newline byte never occurs inside a
// multi-byte UTF-8 character, so each line decodes exactly as it would inside the
// whole file, and a '\r' before the '\n' stays on its line (JSON.parse reads it as
// whitespace). A line longer than maxLineBytes can't become a string either. It
// is dropped and counted in `oversizedLines`, so the caller can report the file
// as not fully read, and every other line of the file still counts.
//
// `endOffset` is the byte just after the last '\n' read: where a later read of only the
// new bytes picks up (lib/card-watch.mjs). A last line with no '\n' after it is parsed
// here and read again from there, which changes nothing in what that read keeps; one that
// was still being written fails to parse here and is read whole from there.
export async function parseTranscriptStream(chunks, surface, { maxLineBytes = MAX_LINE_BYTES } = {}) {
  const parser = createTranscriptParser(surface);
  let parts = [];
  let length = 0;
  let dropping = false;
  let oversizedLines = 0;
  let base = 0, endOffset = 0;
  const endLine = () => {
    if (dropping) oversizedLines += 1;
    else if (length > 0) parser.line((parts.length === 1 ? parts[0] : Buffer.concat(parts, length)).toString('utf8'));
    parts = [];
    length = 0;
    dropping = false;
  };

  for await (const chunk of chunks) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const newline = buf.indexOf(0x0a, start);
      const end = newline === -1 ? buf.length : newline;
      if (!dropping && end > start) {
        if (length + (end - start) > maxLineBytes) {
          dropping = true;
          parts = [];
          length = 0;
        } else {
          parts.push(buf.subarray(start, end));
          length += end - start;
        }
      }
      if (newline === -1) break;
      endLine();
      start = newline + 1;
      endOffset = base + start;
    }
    base += buf.length;
  }
  endLine(); // the last line, which may have no newline after it
  return { ...parser.result(), oversizedLines, endOffset };
}

// One transcript file, read in 1 MiB pieces. An open or read error rejects.
export function parseTranscriptFile(path, surface, options) {
  return parseTranscriptStream(createReadStream(path, { highWaterMark: 1024 * 1024 }), surface, options);
}

// The same request can also sit in two files. A forked subagent's transcript
// opens with a copy of the parent's line that launched it: same ids, same
// usage, same timestamp as that line (seen twice on 2026-10-16). Count each
// request once across every transcript read, in the one that wrote it first.
// A copy is never written before its original, and a request's time is its
// first line's, so the earliest record is the original; a tie goes to the
// transcript earlier in the list. Records without a requestKey are all kept.
// Returns new transcript objects for the ones that lost a record.
export function dropCopiedRequests(transcripts) {
  const first = new Map();
  for (const t of transcripts) {
    for (const r of t.records) {
      if (r.requestKey == null) continue;
      const seen = first.get(r.requestKey);
      if (!seen || r.ts < seen.ts) first.set(r.requestKey, r);
    }
  }
  return transcripts.map(t => {
    const records = t.records.filter(r => r.requestKey == null || first.get(r.requestKey) === r);
    return records.length === t.records.length ? t : { ...t, records };
  });
}
