// A card answered somewhere else closes within seconds (board 48308589). The sessions pass
// (lib/answered-elsewhere.mjs, `pass`) closes a card once every thread it may be is past
// it, but it runs each minute and reads each changed transcript whole; this watch reads
// only the new bytes of the lead's transcripts, every WATCH_EVERY_MS while a card is open,
// and closes a card (`closeAnswered`) as soon as those bytes show its call answered.
//
// What "answered" means here is what the transcript can show, and nothing earlier:
//
//   a tool_result for the call    allowed and run, or denied (the result is written at
//                                 once for a denial, when the tool finishes for an Allow)
//   a new response in its thread  Claude Code sends the next request only once every
//                                 call of the last one has its result
//   an interruption mark          Esc at the prompt, or the run stopped (TaskStop)
//
// Which calls, in any thread of the lead's (his own file and each subagent's
// agent-<id>.jsonl):
//
//   still open    every call of the card's tool written up to CARD_SKEW_MS after the card
//                 was relayed, however old. One holds the card. A prompt opens when the
//                 call before it in the same response has run, not when its own call was
//                 written: two Bash calls in one response, the first taking 5 minutes,
//                 relay the second's card 5 minutes after its call (board 48308589,
//                 Ultron's H1; 10 such responses in 10 days, the widest 449 s apart).
//   answered      a call of the card's tool written from CARD_NEAR_MS before the relay to
//                 CARD_SKEW_MS after (the window lib/approval-wait.mjs's cardThreads uses
//                 for a session that is not current) whose answer (its result line, the
//                 next response, the interruption mark) is timestamped after the relay. A
//                 call answered before the card came can't be the card's.
//
// The card closes only once none of its tool is open and at least one such answered call
// is seen, so a second thread's call of the same tool finishing (the lead's own Bash while
// a subagent's Bash waits at its prompt) never closes it. No answered call seen: no word
// (the sessions pass decides, as before).
//
// It never closes early, so it would rather say nothing:
// - A card is judged only once the transcripts were read from SETTLE_MS after the end of
//   its window: every call that could be the card's was written by then.
// - Only the lead's sessions written since the channel's current process said hello
//   (the store's `permissionSessionAt`; one of his own files now, or any of the session's
//   files at the last pass): an open card was relayed by that process, so a session that
//   wrote nothing since is an older process's, whose calls are not the card's (and whose
//   calls left open when it ended stay open in its files for good). A session the last
//   sessions pass has not read yet (a new process's first minute) is not known here, so a
//   top-level transcript in the lead's project folder that the pass doesn't know (`known`)
//   and that was written since that hello holds every card.
// - Each file of a current session is visited every time, written lately or not (one
//   lstat while it is quiet): an old call still open in it holds the cards. It is read on
//   from where the last sessions pass ended (`seedFor`: its byte offset and the calls open
//   there), or from its start when the pass never read it and it is small (a new
//   subagent). A file that can't be read that way (too big and not read by the pass,
//   replaced, cut short, a line over LINE_MAX, not a regular file, more unread than the
//   TICK_READ_MAX left this time, a seed the parser cut) could hold an open call of any
//   age, so it holds every card until it can be read. A file read before that is gone,
//   replaced or cut short since (or no longer listed) took calls with it that are not
//   known now: it holds every card for as long as cards are open.
// - A line still being written (no '\n' yet) is kept and read whole next time.
//
// Cost: nothing while no card is open (it forgets every file then). With a card open, one
// readdir per current lead session and an lstat per file each time; only files with new
// bytes are opened, only those bytes read (at most TICK_READ_MAX over all files in one
// tick; a file past that is behind and holds the cards until the next), and only lines
// that can change a call's state (assistant lines, tool results, interruption marks) are
// parsed.
import { open as fsOpen, lstat as fsLstat, readdir as fsReaddir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { INTERRUPTED, isInterruption, OPEN_TOOL_NAME_MAX } from './parse-transcript.mjs';
import { CARD_NEAR_MS, CARD_SKEW_MS } from './approval-wait.mjs';

const MIB = 1024 * 1024;
export const WATCH_EVERY_MS = 2e3;
export const SETTLE_MS = 2e3;
export const NEW_FILE_MAX = 8 * MIB;
// Bytes read in one tick, over every file.
export const TICK_READ_MAX = 32 * MIB;
export const LINE_MAX = 64 * MIB;
export const READ_CHUNK = MIB;
export const SUBAGENT_FILES_MAX = 500;
// More open calls than this in one thread: something is off, and the thread is not judged.
export const TRACK_OPEN_MAX = 200;
// Answered calls kept a thread, newest first (only the ones in an open card's window are kept).
export const DONE_MAX = 200;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const AGENT_FILE = /^agent-[^/]+\.jsonl$/;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const realFs = { open: fsOpen, lstat: fsLstat, readdir: fsReaddir };

// One thread's calls: id -> { name, at, done, doneAt }. Fed the same lines and in the same way as
// the parser's open tool uses (lib/parse-transcript.mjs): a tool use is open from its line,
// its result ends it, a new response (a new message id) or an interruption mark ends every
// one; a line with no time adds none; a line with no message id ends none. Unlike the
// parser it keeps the answered ones (`done`), since a card asks whether every call in its
// window is answered, with when (`doneAt`: the time on the line that ended it, NaN for a
// line with none), and it never drops an open one (past TRACK_OPEN_MAX it is `unsure`).
// `open` and `response` are the parser's `openTools` and `openResponse` where a read
// ended; `cut` is its `openCut` (it dropped some), which leaves this unsure until every
// call is ended.
export function createThreadUses({ open = [], response = null, cut = false } = {}) {
  const uses = new Map();
  let current = typeof response === 'string' && response !== '' ? response : null;
  let unsure = cut === true;
  for (const u of Array.isArray(open) ? open : []) {
    if (!isObject(u) || typeof u.id !== 'string' || typeof u.name !== 'string' || u.name === '' || !Number.isFinite(u.at)) continue;
    uses.set(u.id, { name: u.name.slice(0, OPEN_TOOL_NAME_MAX), at: u.at, done: false, doneAt: NaN });
  }
  const end = (u, ts) => { if (!u.done) { u.done = true; u.doneAt = ts; } };
  const endAll = ts => { for (const u of uses.values()) end(u, ts); unsure = false; };
  const openCount = () => { let n = 0; for (const u of uses.values()) if (!u.done) n++; return n; };

  function line(d) {
    if (d === null || typeof d !== 'object') return;
    const ts = Date.parse(d.timestamp ?? '');
    if (d.type === 'assistant' && d.message && typeof d.message === 'object') {
      const m = d.message;
      const id = typeof m.id === 'string' && m.id !== '' ? m.id : null;
      if (id !== null && id !== current) { endAll(ts); current = id; }
      if (!Number.isFinite(ts) || !Array.isArray(m.content)) return;
      for (const c of m.content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string' || typeof c.name !== 'string' || c.name === '') continue;
        uses.delete(c.id);
        uses.set(c.id, { name: c.name.slice(0, OPEN_TOOL_NAME_MAX), at: ts, done: false, doneAt: NaN });
      }
      if (openCount() > TRACK_OPEN_MAX) unsure = true;
    } else if (d.type === 'user' && d.message && typeof d.message === 'object') {
      if (Number.isFinite(ts) && isInterruption(d.message)) { endAll(ts); return; }
      if (!Array.isArray(d.message.content)) return;
      for (const c of d.message.content) {
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const u = uses.get(c.tool_use_id);
        if (u) end(u, ts);
      }
    }
  }
  // Answered calls written before `from` can't be in any open card's window.
  function prune(from) {
    const done = [];
    for (const [id, u] of uses) {
      if (!u.done) continue;
      if (!(u.at >= from)) uses.delete(id);
      else done.push([id, u.at]);
    }
    if (done.length > DONE_MAX) {
      done.sort((a, b) => a[1] - b[1]);
      for (const [id] of done.slice(0, done.length - DONE_MAX)) uses.delete(id);
    }
  }
  // The calls of `tool` written from `from` to `to`, both ends in: [{ at, done, doneAt }].
  const calls = (tool, from, to) => [...uses.values()].filter(u => u.name === tool && u.at >= from && u.at <= to).map(u => ({ at: u.at, done: u.done, doneAt: u.doneAt }));
  return { line, prune, calls, get unsure() { return unsure; }, get size() { return uses.size; } };
}

// A file read on from `offset`, a piece at a time: `read()` answers the whole lines written
// since (a last line with no '\n' is held for the next read) and `status`: `ok` (read to
// the end), `behind` (more than maxBytes were new: the rest next time), `reset` (another
// file at the path now, or shorter than what was read), `broken` (a line over LINE_MAX:
// dropped, so what it said is not known) or `gone` (no regular file to open). Opened
// without following a symlink and without waiting on a FIFO, then checked (as
// collectors/sessions.mjs reads a meta file).
export function createFileTail({ path, ino, offset = 0, fs = realFs, lineMax = LINE_MAX, chunk = READ_CHUNK }) {
  let pos = offset;
  let parts = [], partLen = 0;
  async function read(maxBytes = TICK_READ_MAX) {
    let fh;
    try { fh = await fs.open(path, OPEN_FLAGS); } catch { return { status: 'gone', lines: [] }; }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return { status: 'gone', lines: [] };
      if (st.ino !== ino || st.size < pos) return { status: 'reset', lines: [] };
      const end = Math.min(st.size, pos + maxBytes);
      const lines = [];
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunk, end - pos)));
      while (pos < end) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
        if (!(bytesRead > 0)) break;
        const piece = buf.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const nl = piece.indexOf(0x0a, start);
          const stop = nl === -1 ? piece.length : nl;
          if (partLen + (stop - start) > lineMax) return { status: 'broken', lines: [] };
          if (stop > start) { parts.push(Buffer.from(piece.subarray(start, stop))); partLen += stop - start; }
          if (nl === -1) break;
          if (partLen > 0) lines.push((parts.length === 1 ? parts[0] : Buffer.concat(parts, partLen)).toString('utf8'));
          parts = []; partLen = 0;
          start = nl + 1;
        }
        pos += bytesRead;
      }
      return { status: pos < st.size ? 'behind' : 'ok', lines };
    } finally {
      await fh.close().catch(() => {});
    }
  }
  return { read, get offset() { return pos; }, get ino() { return ino; } };
}

// Only these lines can change a call's state; the rest are not parsed.
export const mayMatter = line => line.includes('"assistant"') || line.includes('"tool_result"') || line.includes(INTERRUPTED);

// The watch. `store` is the chat store (closablePermissions, permissionSessionAt).
// `leads()` answers the lead's sessions as the last sessions pass named them: [{ sessionId,
// mains: [his own transcript's paths], writtenAt: the newest mtime of any of the session's
// files then }]. `seedFor(path)` answers where that pass's read of a file ended: { ino,
// offset, open, response, cut } (the parser's endOffset, openTools, openResponse, openCut)
// or null; `known(path)` whether that pass read a file at all. `closeAnswered(ids)` closes
// the cards (answered-elsewhere's). `readMax` and `lineMax` are TICK_READ_MAX and LINE_MAX
// (smaller in tests). Answers { tick, start, stop, size, calls }.
export function createCardWatch({ store, leads = () => [], seedFor = () => null, known = () => false, closeAnswered = () => 0, now = () => Date.now(), log = console.log, fs = realFs, everyMs = WATCH_EVERY_MS, readMax = TICK_READ_MAX, lineMax = LINE_MAX } = {}) {
  const files = new Map();   // path -> { tail, uses }
  const broken = new Map();  // path -> { ino, at }: a line over lineMax read up to `at`
  let lost = false;          // a file read before and lost since: held until no card is open
  const forget = () => { files.clear(); broken.clear(); lost = false; };
  const said = new Set();
  let running = false, timer = null;
  const say = (key, line) => { if (!said.has(key)) { said.add(key); log(line); } };

  async function tick() {
    if (running) return 0;
    running = true;
    try { return await step(); } catch (err) {
      say('failed', `card-watch: a read failed (${err?.code ?? err?.name ?? 'error'}); open cards wait for the sessions pass`);
      return 0;
    } finally { running = false; }
  }

  async function step() {
    let cards = [];
    try { cards = store.closablePermissions() ?? []; } catch { cards = []; }
    if (!Array.isArray(cards) || cards.length === 0) { forget(); said.clear(); return 0; }
    const helloAt = store.permissionSessionAt;
    if (!Number.isFinite(helloAt)) return 0;
    const live = cards.filter(c => isObject(c) && typeof c.requestId === 'string' && typeof c.tool === 'string' && c.tool !== '' && Number.isFinite(c.relayedAt) && c.relayedAt >= helloAt);
    if (live.length === 0) { forget(); return 0; }
    const readAt = now();
    const from = Math.min(...live.map(c => c.relayedAt)) - CARD_NEAR_MS;
    // `hold`: something could not be read as it should, so what it holds is not known (it
    // could be an open call of any age): no card is judged this time. `budget`: the bytes
    // this tick may still read.
    const run = { hold: false, budget: readMax };
    const seen = new Set();

    let sessions = [];
    try { sessions = leads() ?? []; } catch { sessions = []; }
    const leadMains = new Set(), projects = new Set();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!isObject(s) || typeof s.sessionId !== 'string' || s.sessionId === '' || !Array.isArray(s.mains)) continue;
      const mains = s.mains.filter(p => typeof p === 'string');
      let current = Number.isFinite(s.writtenAt) && s.writtenAt >= helloAt;
      for (const p of mains) {
        leadMains.add(p);
        projects.add(dirname(p));
        let st = null;
        try { st = await fs.lstat(p); } catch { st = null; }
        if (st?.isFile() && st.mtimeMs >= helloAt) current = true;
      }
      if (!current) continue;
      const paths = [...mains];
      for (const dir of new Set(mains.map(p => join(dirname(p), s.sessionId, 'subagents')))) {
        let names = [];
        try { names = await fs.readdir(dir); } catch (err) {
          if (err?.code !== 'ENOENT') { run.hold = true; say(`dir:${dir}`, `card-watch: a subagents folder of the lead's could not be listed (${err?.code ?? 'error'}); open cards wait for the sessions pass`); }
          continue;
        }
        const agents = names.filter(n => typeof n === 'string' && AGENT_FILE.test(n));
        if (agents.length > SUBAGENT_FILES_MAX) { run.hold = true; say(`many:${dir}`, `card-watch: more than ${SUBAGENT_FILES_MAX} subagent transcripts in one of the lead's sessions; open cards wait for the sessions pass`); continue; }
        for (const n of agents) paths.push(join(dir, n));
      }
      for (const p of paths) await visit(p, run, seen);
    }
    for (const p of files.keys()) if (!seen.has(p)) { files.delete(p); lost = true; }
    if (lost) run.hold = true;
    // A session the last pass has not read: its calls are not watched here, so once it wrote
    // since the hello (a new process of the lead's, most likely) it holds every card.
    for (const dir of projects) {
      let names = [];
      try { names = await fs.readdir(dir); } catch { run.hold = true; continue; }
      for (const n of names) {
        if (typeof n !== 'string' || !n.endsWith('.jsonl')) continue;
        const p = join(dir, n);
        let isKnown = true;
        try { isKnown = leadMains.has(p) || known(p) === true; } catch { isKnown = false; }
        if (isKnown) continue;
        let st = null;
        try { st = await fs.lstat(p); } catch { st = null; }
        if (st?.isFile() && st.mtimeMs >= helloAt) { run.hold = true; say('new', 'card-watch: a session the sessions pass has not read yet wrote since the channel\'s hello; open cards wait for that pass'); }
      }
    }

    const answered = new Set();
    if (!run.hold) {
      for (const c of live) {
        if (c.relayedAt + CARD_SKEW_MS + SETTLE_MS > readAt) continue;
        const lo = c.relayedAt - CARD_NEAR_MS, hi = c.relayedAt + CARD_SKEW_MS;
        let n = 0, open = 0;
        for (const f of files.values()) {
          for (const u of f.uses.calls(c.tool, -Infinity, hi)) {
            if (!u.done) open++;
            else if (u.at >= lo && u.doneAt > c.relayedAt) n++;
          }
        }
        if (n > 0 && open === 0) answered.add(c.requestId);
      }
    }
    for (const f of files.values()) f.uses.prune(from);
    if (answered.size === 0) return 0;
    let closed = 0;
    try { closed = closeAnswered(answered) ?? 0; } catch { closed = 0; }
    return closed;
  }

  // One file of a current lead session: read on, or begin, or say it can't be.
  async function visit(path, run, seen) {
    let st;
    try { st = await fs.lstat(path); } catch { st = null; }
    let f = files.get(path) ?? null;
    if (!st || !st.isFile()) {
      // A thread read before that is no file now: what it held is not known. One that is
      // no regular file (a symlink, a FIFO), even from the start, is never opened, and
      // what it holds is not known either (board 8d73e1dd, Ultron's L2): it holds every
      // card while it is there. One never read and gone is no file: nothing to hold.
      if (f) { files.delete(path); lost = true; }
      if (st) { run.hold = true; say(`odd:${path}`, 'card-watch: a transcript of the lead\'s is not a regular file (a symlink or a special file); open cards wait for the sessions pass'); }
      return;
    }
    if (!f) {
      const b = broken.get(path);
      const blocked = b !== undefined && b.ino === st.ino;
      let seed = null;
      try { seed = seedFor(path); } catch { seed = null; }
      const seedOk = isObject(seed) && seed.ino === st.ino && Number.isSafeInteger(seed.offset) && seed.offset >= 0 && seed.offset <= st.size && !(blocked && seed.offset <= b.at);
      if (seedOk) f = { tail: createFileTail({ path, ino: st.ino, offset: seed.offset, fs, lineMax }), uses: createThreadUses({ open: seed.open, response: seed.response, cut: seed.cut }) };
      else if (st.size <= NEW_FILE_MAX && !blocked) f = { tail: createFileTail({ path, ino: st.ino, offset: 0, fs, lineMax }), uses: createThreadUses() };
      else {
        run.hold = true;
        say(`seed:${path}:${st.ino}`, `card-watch: a transcript of the lead's has no place to read on from (not read by the last sessions pass, and over ${NEW_FILE_MAX / MIB} MiB); open cards wait for that pass`);
        return;
      }
      files.set(path, f);
    }
    seen.add(path);
    if (st.size !== f.tail.offset) {
      // The tick's bytes are spent: the rest next time, and the cards wait for it.
      if (run.budget <= 0) { run.hold = true; return; }
      const at = f.tail.offset;
      const r = await f.tail.read(run.budget);
      run.budget -= Math.max(0, f.tail.offset - at);
      for (const line of r.lines) {
        if (!mayMatter(line)) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        f.uses.line(d);
      }
      if (r.status !== 'ok' && r.status !== 'behind') {
        files.delete(path);
        seen.delete(path);
        // A line too long: what it said is not known until a pass reads past it. Another
        // file at the path now, cut short, or gone between the lstat and the open: lost.
        if (r.status === 'broken') broken.set(path, { ino: st.ino, at: f.tail.offset }); else lost = true;
        run.hold = true;
        return;
      }
      if (r.status === 'behind') run.hold = true;
    }
    if (f.uses.unsure) run.hold = true;
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(() => { void tick(); }, everyMs);
    timer.unref?.();
  }
  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }
  // How many files it follows, and how many calls it keeps (open and answered).
  return { tick, start, stop, size: () => files.size, calls: () => [...files.values()].reduce((n, f) => n + f.uses.size, 0) };
}

// ---- from the sessions pass (server.mjs) ----

// Where the pass's read of a file ended, from its cache entry (collectors/sessions.mjs):
// none for a read that dropped a line too long to decode.
export function seedOf(entry) {
  if (!isObject(entry) || entry.oversizedLines !== 0 || !isObject(entry.transcript)) return null;
  const t = entry.transcript;
  if (!Number.isSafeInteger(t.endOffset) || !Number.isFinite(entry.ino)) return null;
  return { ino: entry.ino, offset: t.endOffset, open: t.openTools, response: t.openResponse, cut: t.openCut === true };
}

// The lead's sessions and their own transcripts, from the pass's cache: [{ sessionId,
// mains, writtenAt }] for `sessions` (his session ids). `writtenAt` is the newest mtime of
// any of the session's files (his own and his subagents') as the pass found them.
export function leadFiles(cache, sessions) {
  const want = new Set(Array.isArray(sessions) ? sessions : []);
  const mains = new Map(), written = new Map();
  if (!(cache instanceof Map) || want.size === 0) return [];
  for (const [path, entry] of cache) {
    const t = entry?.transcript;
    if (!isObject(t) || !want.has(t.sessionId)) continue;
    if (Number.isFinite(entry.mtimeMs) && !(written.get(t.sessionId) >= entry.mtimeMs)) written.set(t.sessionId, entry.mtimeMs);
    if (t.subagent) continue;
    if (!mains.has(t.sessionId)) mains.set(t.sessionId, []);
    mains.get(t.sessionId).push(path);
  }
  return [...mains].map(([sessionId, paths]) => ({ sessionId, mains: paths, writtenAt: written.get(sessionId) ?? null }));
}
