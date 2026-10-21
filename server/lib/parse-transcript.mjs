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

  return {
    line(line) {
      if (!line.trim()) return;
      let d;
      try { d = JSON.parse(line); } catch { return; }
      // A line that holds JSON's null, or any other non-object, carries nothing
      // to read. Reading a field off null used to throw and fail the whole pass.
      if (d === null || typeof d !== 'object') return;

      if (d.sessionId && !sessionId) sessionId = d.sessionId;
      if (d.type === 'ai-title' && d.aiTitle) { title = d.aiTitle; return; }
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
      return { sessionId, title, surface, cwd, gitBranch, records };
    }
  };
}

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
export async function parseTranscriptStream(chunks, surface, { maxLineBytes = MAX_LINE_BYTES } = {}) {
  const parser = createTranscriptParser(surface);
  let parts = [];
  let length = 0;
  let dropping = false;
  let oversizedLines = 0;
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
    }
  }
  endLine(); // the last line, which may have no newline after it
  return { ...parser.result(), oversizedLines };
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
