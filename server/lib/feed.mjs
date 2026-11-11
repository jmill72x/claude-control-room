// The Feed (Jarvis OS Phase 2, design doc 5.7): what each agent and job posted to its
// Discord feed, read from the copies the lead's `discord-post` keeps, one JSON line a
// post, in <folder>/<agent>.jsonl (rolled to <agent>.1.jsonl past 1 MB):
//
//   {"ts": "2026-11-09T12:00:00.000Z", "agent": "<key>", "title": "…" | null,
//    "text": "…", "kind": "brief" | "digest" (optional), "truncated": true (optional)}
//
// Read-only, and nothing here trusts the files: the folder must pass the program
// check's folder rule (owned by this user, nobody else can write it or a folder above
// it); a file is opened without following a symlink and without blocking (a FIFO
// would otherwise hang the read), and read only if it is a regular file of this
// user's that nobody else can write. Only the last READ_MAX bytes of a file are read,
// and only files named for an agent on config's roster: a name never comes from the
// folder. A line that isn't a whole, well-formed post is skipped and counted. Text
// stays text: the page renders it with the chat's Markdown component, never as HTML.
//
// The newest "brief" and "digest" in the lead's own files are pinned; a kind anywhere
// else is dropped. A file with a second hard link is not read, and a post stamped more
// than a day ahead is skipped. The answer holds about 1 MB of text at most, the oldest
// posts dropped first and the pins always kept, and never a path. GET /api/feed serves
// it (lib/feed-routes.mjs) to a paired device only; it is never part of /api/dashboard,
// which any tailnet device can read.
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { checkFolder } from './program-check.mjs';

export const DEFAULT_FEED_DIR = join(homedir(), '.local', 'state', 'jarvis', 'feed');
export const PER_AGENT = 50;         // posts an agent, its newest
export const TEXT_MAX = 16384;       // characters, as the writer caps them
export const TITLE_MAX = 200;
export const LINE_MAX = 128 * 1024;  // bytes; the writer's longest line is well under
export const READ_MAX = 2 * 1024 * 1024; // bytes read from the end of each file
export const MIN_READ_MS = 5000;     // reads closer together than this share one answer
export const TOTAL_TEXT_MAX = 1_000_000; // characters of text and titles in one answer
export const FUTURE_SLACK_MS = 24 * 3600e3; // a post stamped further ahead than this is skipped
const KINDS = new Set(['brief', 'digest']);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// config.json's optional `feed` block: `{ "dir": "/absolute/folder" }` moves the
// folder, `{ "off": true }` turns the feed off. No block means the default folder.
export function readFeedConfig(config) {
  const feed = config?.feed;
  if (feed === undefined || feed === null) return { dir: DEFAULT_FEED_DIR, problems: [] };
  if (!isObject(feed)) return { dir: null, problems: ['feed must be an object; the Feed tab stays empty'] };
  if (feed.off === true) return { dir: null, problems: [] };
  if (feed.dir === undefined) return { dir: DEFAULT_FEED_DIR, problems: [] };
  if (typeof feed.dir === 'string' && isAbsolute(feed.dir)) return { dir: feed.dir, problems: [] };
  return { dir: null, problems: ['feed.dir must be an absolute path; the Feed tab stays empty'] };
}

const cut = (s, max) => (s.length > max ? [s.slice(0, max), true] : [s, false]);

// One line as a post, or null. The agent is the file's, and the line must agree.
function parseLine(raw, key, lead) {
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!isObject(o) || o.agent !== key) return null;
  if (typeof o.ts !== 'string' || !ISO.test(o.ts)) return null;
  const at = Date.parse(o.ts);
  if (!Number.isFinite(at)) return null;
  if (typeof o.text !== 'string' || o.text.trim() === '') return null;
  if (o.title !== undefined && o.title !== null && typeof o.title !== 'string') return null;
  const [text, longText] = cut(o.text.toWellFormed(), TEXT_MAX);
  const [title, longTitle] = typeof o.title === 'string' && o.title.trim() !== '' ? cut(o.title.toWellFormed(), TITLE_MAX) : [null, false];
  const post = { id: createHash('sha256').update(`${key}\n${raw}`).digest('hex').slice(0, 16), agent: key, at, title, text };
  if (key === lead && KINDS.has(o.kind)) post.kind = o.kind;
  if (o.truncated === true || longText || longTitle) post.truncated = true;
  return post;
}

export function createFeedReader({ dir, agents = [], lead = null, perAgent = PER_AGENT, totalMax = TOTAL_TEXT_MAX, minReadMs = MIN_READ_MS, now = Date.now, uid = process.getuid(), log = console.error } = {}) {
  const files = new Map(); // path -> { stamp, posts, skipped }: a file read again only when it changed
  let last = null;         // { at, value }
  let logged = null;       // the folder problem last logged, so it is logged once

  // A file's posts in file order, or 'missing', or 'unreadable'.
  async function readFile(path, key) {
    let fh;
    try { fh = await open(path, OPEN_FLAGS); } catch (err) { return err?.code === 'ENOENT' ? 'missing' : 'unreadable'; }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o022)) return 'unreadable';
      const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      const known = files.get(path);
      if (known?.stamp === stamp) return known;
      const start = Math.max(0, st.size - READ_MAX);
      const buf = Buffer.alloc(st.size - start);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const lines = buf.subarray(0, got).toString('utf8').split('\n');
      const tail = lines.pop();     // after the last newline: '' or a line still landing
      if (start > 0) lines.shift(); // cut by the window: not garbage, just not ours
      let skipped = tail === '' ? 0 : 1;
      const posts = [];
      for (const raw of lines) {
        if (raw === '') continue;
        const post = Buffer.byteLength(raw) > LINE_MAX ? null : parseLine(raw, key, lead);
        if (post) posts.push(post); else skipped++;
      }
      const entry = { stamp, posts, skipped };
      files.set(path, entry);
      return entry;
    } finally {
      await fh.close();
    }
  }

  const empty = status => ({ status, posts: [], pinned: { brief: null, digest: null }, agents: agents.map(key => ({ key, count: 0, latestAt: null })), skipped: 0, unreadable: 0, dropped: 0 });
  const size = p => p.text.length + (p.title ?? '').length;

  async function readAll(at) {
    if (!dir) return empty('off');
    try { await lstat(dir); } catch (err) { if (err?.code === 'ENOENT') return empty('missing'); }
    const { real, problem } = await checkFolder(dir, { uid });
    if (problem) {
      if (logged !== problem) log(`feed: the feed folder ${problem}; the Feed tab stays empty`);
      logged = problem;
      return empty('refused');
    }
    logged = null;
    const out = empty('ok');
    const all = [];
    for (const key of agents) {
      let posts = [];
      for (const name of [`${key}.1.jsonl`, `${key}.jsonl`]) {
        const r = await readFile(join(real, name), key);
        if (r === 'unreadable') out.unreadable++;
        if (typeof r !== 'object') continue;
        out.skipped += r.skipped;
        // Checked here, not when parsing, so the file cache never depends on the clock.
        const due = r.posts.filter(p => p.at <= at + FUTURE_SLACK_MS);
        out.skipped += r.posts.length - due.length;
        posts = posts.concat(due);
      }
      // Identical lines share a hash: the second and later get -1, -2, … in file
      // order, which keeps every id stable as the file grows.
      const seen = new Map();
      posts = posts.map(p => {
        const n = seen.get(p.id) ?? 0;
        seen.set(p.id, n + 1);
        return n === 0 ? p : { ...p, id: `${p.id}-${n}` };
      });
      posts.sort((a, b) => a.at - b.at); // stable: file order breaks a tie
      if (key === lead) {
        for (const kind of KINDS) {
          const pin = posts.findLast(p => p.kind === kind) ?? null;
          out.pinned[kind] = pin;
          if (pin) posts = posts.filter(p => p !== pin);
        }
      }
      all.push(...posts.slice(-perAgent));
    }
    // About 1 MB of text at most: the pins first, then the posts newest first until
    // the budget runs out; the rest are dropped and counted.
    all.sort((a, b) => b.at - a.at);
    const pins = Object.values(out.pinned).filter(Boolean);
    let budget = totalMax - pins.reduce((n, p) => n + size(p), 0);
    let kept = 0;
    while (kept < all.length && size(all[kept]) <= budget) budget -= size(all[kept++]);
    out.posts = all.slice(0, kept);
    out.dropped = all.length - kept;
    out.agents = agents.map(key => {
      const mine = [...out.posts, ...pins].filter(p => p.agent === key);
      return { key, count: mine.length, latestAt: mine.length ? Math.max(...mine.map(p => p.at)) : null };
    });
    return out;
  }

  // A read already on its way is shared, so a burst of requests costs one read.
  let pending = null;
  function read() {
    const at = now();
    if (last && at - last.at < minReadMs) return Promise.resolve(last.value);
    if (pending) return pending;
    pending = readAll(at)
      .then(value => { last = { at, value }; return value; })
      .finally(() => { pending = null; });
    return pending;
  }

  return { read };
}
