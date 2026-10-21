import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TRANSCRIPT_ROOTS, parseTranscriptFile, dropCopiedRequests } from '../lib/parse-transcript.mjs';
import { parseCoworkSession } from '../lib/cowork.mjs';

// `failures` collects every directory we could not list. Swallowing these
// silently is what let an unreadable tree look like an empty one: stat()
// succeeding proves nothing, since a chmod 311 directory stats fine and then
// throws EACCES on readdir.
//
// Cowork transcripts already sit ~6 levels below their root, so a cap of 8 was
// uncomfortably close to legitimate depth. Truncation is recorded rather than
// silent: a tree we stopped short of is not a tree we found nothing in.
const MAX_DEPTH = 12;

async function walk(dir, match, out = [], failures = [], depth = 0) {
  if (depth > MAX_DEPTH) {
    failures.push(dir);
    return out;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    failures.push(dir);
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, match, out, failures, depth + 1);
    else if (match(e.name)) out.push(full);
  }
  return out;
}

// A subagent's transcript is <session>/subagents/agent-<id>.jsonl, and Claude
// Code writes a .meta.json beside it naming the agent (`agentType`, such as an
// agent file's slug, or general-purpose) and the one-line brief it was given
// (`description`). Only those two fields are kept. No meta file is no meta,
// not a failure: the run just can't be put to an agent. One that can't be read
// or parsed throws, and the caller reports it.
const MAX_META_BYTES = 64 * 1024;
const isSubagentFile = file => basename(dirname(file)) === 'subagents' && basename(file).startsWith('agent-');
const field = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
export async function readSubagentMeta(file) {
  const path = file.replace(/\.jsonl$/, '.meta.json');
  let text;
  try {
    if ((await stat(path)).size > MAX_META_BYTES) throw new Error(`${path} is larger than a meta file should be`);
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const d = JSON.parse(text);
  if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${path} is not an object`);
  return { agentType: field(d.agentType, 200), description: field(d.description, 1000) };
}

// Each transcript is read as a stream, a line at a time (parseTranscriptFile),
// never whole: one string can't hold more than about 512 MiB, and a long-running
// session's file grows past that within a week.
//
// `cache` is a Map the caller keeps from one pass to the next (server.mjs holds
// one) so that a pass reads only the transcripts that changed since the last. Of
// the week's files on 2026-10-20, 174 carried usage and 2,000 more were the
// dashboard's own /usage polls, and nearly all of them were finished. An entry
// keeps the file's size, mtime and inode as stat gave them before the read, plus
// what the read found, and any difference in the three reads the file again.
// Taking the stat before the read means a file written to during the read is
// read again on the next pass, never kept short. A file that fails to read is not
// kept, so it is tried and reported again every pass. With no cache, every file
// is read every pass, as before.
//
// A subagent's meta file is read along with its transcript, so only when the
// transcript is. One that fails is reported and its entry not kept, so it is
// tried and reported again next pass, as a failed transcript is.
//
// `sessionNames` maps each top-level session's id to its latest `agent-name`
// (a session started as `claude -n <name>`), from every transcript read,
// including those with no usage. A subagent's lines carry its parent's
// sessionId, so this is how a subagent finds the session that started it.
export async function collectSessions({
  roots = TRANSCRIPT_ROOTS,
  maxAgeMs = 7 * 24 * 3600 * 1000,
  cache = null,
  readTranscript = parseTranscriptFile,
  readMeta = readSubagentMeta
} = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const transcripts = [];
  const coworkSessions = [];
  const unavailableRoots = [];
  const unreadablePaths = [];
  const sessionNames = new Map();
  const seen = new Set();

  for (const { root, surface } of roots) {
    const failures = [];
    const jsonlFiles = await walk(root, n => n.endsWith('.jsonl'), [], failures);
    // The root itself being unlistable means this whole surface is unreadable,
    // not empty. A failure deeper in the tree costs us one project's sessions,
    // which understates totals — reported, but not fatal.
    if (failures.includes(root)) {
      unavailableRoots.push(root);
      continue;
    }
    for (const file of jsonlFiles) {
      let info;
      try { info = await stat(file); } catch { failures.push(file); continue; }
      if (info.mtimeMs < cutoff) continue;
      seen.add(file);
      let entry = cache?.get(file);
      if (!entry || entry.size !== info.size || entry.mtimeMs !== info.mtimeMs || entry.ino !== info.ino) {
        // One unreadable file must cost us that file, not the whole panel.
        let read;
        try {
          read = await readTranscript(file, surface);
        } catch {
          cache?.delete(file);
          failures.push(file);
          continue;
        }
        const { oversizedLines = 0, ...parsed } = read;
        const subagent = isSubagentFile(file);
        let meta = null, metaFailed = false;
        if (subagent) {
          try {
            meta = await readMeta(file);
          } catch {
            metaFailed = true;
            failures.push(file.replace(/\.jsonl$/, '.meta.json'));
          }
        }
        // Claude Code writes one transcript FILE per parent session plus one
        // more per sub-agent it spawns, and every one of those files carries
        // the SAME sessionId. collectSessions emits one entry per file, so
        // sessionId alone cannot key these entries uniquely downstream — the
        // file path can: readdir never yields the same path twice in a walk,
        // and it is stable across polls (same file, same path) so a session
        // row does not needlessly remount while nothing about it changed.
        entry = { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, oversizedLines, transcript: { ...parsed, filePath: file, subagent, meta } };
        if (metaFailed) cache?.delete(file);
        else cache?.set(file, entry);
      }
      if (!entry.transcript.subagent && entry.transcript.sessionId && entry.transcript.agentName) {
        sessionNames.set(entry.transcript.sessionId, entry.transcript.agentName);
      }
      // A line too long to decode is a part of this file that went unread.
      if (entry.oversizedLines > 0) failures.push(file);
      if (entry.transcript.records.length === 0) continue;
      transcripts.push(entry.transcript);
    }
    if (surface === 'Cowork') {
      for (const file of await walk(root, n => n.startsWith('local_') && n.endsWith('.json'), [], failures)) {
        // A malformed session file and one we are not allowed to open are
        // different problems with the same consequence — a project missing from
        // the panel — so both are recorded, exactly as the .jsonl path does.
        // The single catch swallowed EACCES as if it were bad JSON and reported
        // neither, which is how a whole unreadable Cowork tree looked empty.
        let text;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          failures.push(file);
          continue;
        }
        try {
          coworkSessions.push(parseCoworkSession(JSON.parse(text)));
        } catch {
          failures.push(file);
        }
      }
    }
    // Captured after both walks for this root so Cowork-walk failures are
    // included, not just the jsonl walk's. Deduped: the jsonl and Cowork
    // walks both traverse the whole tree (only file selection differs), so
    // an unreadable subdirectory under a Cowork root is hit by readdir
    // twice and would otherwise be double-counted.
    for (const path of failures) {
      if (!unreadablePaths.includes(path)) unreadablePaths.push(path);
    }
  }

  // Forget the files that are gone or have aged out, so the cache never holds
  // more than the week's files. Not after a pass that couldn't list a root: its
  // files went unseen, not missing, and dropping them would mean reading them all
  // again once the root is back.
  if (cache && unavailableRoots.length === 0) {
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
  }

  if (roots.length > 0 && unavailableRoots.length === roots.length) {
    throw new Error(`no transcript root is readable: ${unavailableRoots.join(', ')}`);
  }
  // A request copied into a second file (a forked subagent's transcript opens
  // with the parent's launching line) counts once, so this runs over every
  // file read, not per file. lastTs comes after it, from the records kept, and
  // a file left with no request of its own drops out as an empty one does.
  const counted = dropCopiedRequests(transcripts)
    .filter(t => t.records.length > 0)
    .map(t => ({ ...t, lastTs: t.records.reduce((max, r) => Math.max(max, r.ts), -Infinity) }));
  // A partially-read set understates every total, so say so rather than
  // presenting the remainder as complete.
  return { transcripts: counted, coworkSessions, unavailableRoots, unreadablePaths, sessionNames };
}
