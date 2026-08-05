import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TRANSCRIPT_ROOTS, parseTranscript } from '../lib/parse-transcript.mjs';
import { parseCoworkSession } from '../lib/cowork.mjs';

// `failures` collects every directory we could not list. Swallowing these
// silently is what let an unreadable tree look like an empty one: stat()
// succeeding proves nothing, since a chmod 311 directory stats fine and then
// throws EACCES on readdir.
async function walk(dir, match, out = [], failures = [], depth = 0) {
  if (depth > 8) return out;
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

export async function collectSessions({ roots = TRANSCRIPT_ROOTS, maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const transcripts = [];
  const coworkSessions = [];
  const unavailableRoots = [];
  const unreadablePaths = [];

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
      try { info = await stat(file); } catch { continue; }
      if (info.mtimeMs < cutoff) continue;
      const parsed = parseTranscript(await readFile(file, 'utf8'), surface);
      if (parsed.records.length === 0) continue;
      parsed.lastTs = Math.max(...parsed.records.map(r => r.ts));
      transcripts.push(parsed);
    }
    if (surface === 'Cowork') {
      for (const file of await walk(root, n => n.startsWith('local_') && n.endsWith('.json'), [], failures)) {
        try {
          coworkSessions.push(parseCoworkSession(JSON.parse(await readFile(file, 'utf8'))));
        } catch { /* a malformed session file must not sink the collector */ }
      }
    }
    // Captured after both walks for this root so Cowork-walk failures are
    // included, not just the jsonl walk's.
    unreadablePaths.push(...failures);
  }

  if (roots.length > 0 && unavailableRoots.length === roots.length) {
    throw new Error(`no transcript root is readable: ${unavailableRoots.join(', ')}`);
  }
  // A partially-read set understates every total, so say so rather than
  // presenting the remainder as complete.
  return { transcripts, coworkSessions, unavailableRoots, unreadablePaths };
}
