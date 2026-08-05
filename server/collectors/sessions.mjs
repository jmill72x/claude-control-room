import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TRANSCRIPT_ROOTS, parseTranscript } from '../lib/parse-transcript.mjs';
import { parseCoworkSession } from '../lib/cowork.mjs';

async function walk(dir, match, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, match, out, depth + 1);
    else if (match(e.name)) out.push(full);
  }
  return out;
}

export async function collectSessions({ roots = TRANSCRIPT_ROOTS, maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const transcripts = [];
  const coworkSessions = [];
  const unavailableRoots = [];

  for (const { root, surface } of roots) {
    // A root that cannot be read is NOT the same as a root with no sessions.
    // One missing root is legitimate (Cowork may not be installed); every root
    // failing means a moved home directory or a permissions problem, and must
    // surface as `unavailable` rather than as "you used Claude zero times".
    try {
      await stat(root);
    } catch {
      unavailableRoots.push(root);
      continue;
    }
    for (const file of await walk(root, n => n.endsWith('.jsonl'))) {
      let info;
      try { info = await stat(file); } catch { continue; }
      if (info.mtimeMs < cutoff) continue;
      const parsed = parseTranscript(await readFile(file, 'utf8'), surface);
      if (parsed.records.length === 0) continue;
      parsed.lastTs = Math.max(...parsed.records.map(r => r.ts));
      transcripts.push(parsed);
    }
    if (surface !== 'Cowork') continue;
    for (const file of await walk(root, n => n.startsWith('local_') && n.endsWith('.json'))) {
      try {
        coworkSessions.push(parseCoworkSession(JSON.parse(await readFile(file, 'utf8'))));
      } catch { /* a malformed session file must not sink the collector */ }
    }
  }

  if (unavailableRoots.length === roots.length) {
    throw new Error(`no transcript root is readable: ${unavailableRoots.join(', ')}`);
  }
  // A partially-read set understates every total, so say so rather than
  // presenting the remainder as complete.
  return { transcripts, coworkSessions, unavailableRoots };
}
