// The chat store (~/Projects/jarvis/docs/jarvis-os-chat-spec.md, §2.1): messages
// between the owner and the lead agent, in `server/data/chat/messages-YYYY-MM.jsonl`
// (append-only, fsynced, gitignored with the rest of data/), loaded into memory at
// start. Every message has a sequence number; the channel plugin and the page both
// resume from one (`?after=<seq>`, SSE's Last-Event-ID). Sequence numbers are never
// reused: the next seq is the highest on file plus one, and `epoch` (a random id
// written beside the cursor when the store is first created) tells a client when
// it is talking to a store that was emptied and started again.
//
// Permission requests and verdicts are messages too (kinds `permission` and
// `verdict`), so replay carries them; the open requests also live in memory with
// their state, expire as long after the channel relayed them as the channel says it
// holds one (`setPermissionHold`, from its hello; 10 minutes when it doesn't say), and
// lose their input preview after 24 h (the approvals rules: lib/approvals.mjs).
// The open ones are also written to `permissions.json` (0600) with the channel process
// that relayed them, so a restart of this server can put them back when that same
// process says hello again (board ee0bd552; "permissions across a restart" below).
// Attachments are files under `files/<random id>`, named only by that id.
import { open, readFile, writeFile, mkdir, readdir, rename, stat, unlink, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { capField, parsePreview, shownHash, isWhyLine, TOOL_MAX, LATE_AFTER_MS } from './approvals.mjs';
import { secretShapes } from './secret-shape.mjs';
import { isRoutineMessage, ROUTINE_ID_PREFIX } from './routine-chat.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
// `event` (lib/events.mjs): a templated line from `system` for the lead's session.
// `stop` is a stop request from a paired approver device (lib/agent-stop.mjs): typed
// fields in meta, fixed words in text, and only the owner's side makes one.
export const CHAT_KINDS = new Set(['chat', 'permission', 'verdict', 'notice', 'event', 'stop']);
export const CHAT_FROM = new Set(['jeff', 'jarvis', 'system']);
// A chat message of the owner's: from the page or a Shortcut. Not a verdict, a stop, an
// event (always `system`), a routine's post or the lead's own (both `jarvis`). The idle
// wake-up's back-off starts again on one (lib/proactive.mjs; board e10a01ed).
export const isOwnerChat = m => isObject(m) && m.from === 'jeff' && m.kind === 'chat';
export const MAX_TEXT = 32000;
export const MAX_PAGE_TEXT = 8000;
export const EDIT_WINDOW_MS = DAY;
// How long the page can answer a request, counted from `relayedAt` (board 94b380fd).
// Claude Code's own prompt and Discord's buttons have no limit; the page's limit is
// the channel's, which forgets a request after a while (`PERM_FORGET_MS` in the lead's
// repo) and then drops a verdict for it. So the page answers for as long as the
// channel says at hello that it holds one (`permHoldMs`), less a minute, and never
// more than 12 hours. A channel that doesn't say (0.4.10 and older forget after 11
// minutes) gets PERMISSION_TTL_MS, the old 10 minutes.
export const PERMISSION_TTL_MS = 10 * 60e3;
export const PERMISSION_HOLD_MAX_MS = 12 * HOUR;
export const PERMISSION_HOLD_MARGIN_MS = 60e3;
export function permissionWindow(holdMs) {
  if (!Number.isSafeInteger(holdMs) || holdMs <= 0) return PERMISSION_TTL_MS;
  return Math.max(0, Math.min(holdMs - PERMISSION_HOLD_MARGIN_MS, PERMISSION_HOLD_MAX_MS));
}
// At most this many open at once, as the channel (PENDING_PERMS_MAX): past it the
// oldest open one ends here, as the channel forgets it there. And at most this many
// kept in all (open or not; the oldest closed ones go first).
export const OPEN_PERMISSIONS_MAX = 50;
export const PERMISSIONS_KEPT_MAX = 500;
// A channel with no hello or heartbeat for this long is gone (a session killed with no
// SessionEnd and no bye): the requests it relayed end here.
export const CHANNEL_GONE_MS = 10 * 60e3;
// A request that timed out here is still sent to a page that connects up to this long
// after it timed out (as a card that can't be answered here).
export const CARD_REPLAY_MS = 50 * 60e3;
export const PREVIEW_TTL_MS = DAY;
// The open requests on file for the next start (board ee0bd552): `permissions.json` in
// the chat folder. A card put back waits, unseen and unanswerable, for a sessions pass
// that read the transcripts after it (lib/answered-elsewhere.mjs, `pass`); one that no
// pass has judged within this long is let go.
export const PERMISSIONS_FILE = 'permissions.json';
export const PERMISSIONS_FILE_VERSION = 1;
export const PERMISSIONS_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const RESTORE_JUDGE_MS = 3 * 60e3;
// What the chat log keeps in place of a description that looks like it holds a secret.
export const SECRET_STAND_IN = 'Jarvis asked for a permission (its summary looked like it held a secret, so it is not kept)';
export const UNANSWERED_WINDOW_MS = DAY;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TTL_MS = 90 * DAY;
export const ORPHAN_AFTER_MS = 3600e3;
export const ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf', 'text/plain', 'text/markdown']);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MESSAGE_ID = /^m_[a-z0-9]{6,24}$/;
const ATTACHMENT_ID = /^[a-f0-9]{32}$/;

export const isMessageId = v => typeof v === 'string' && MESSAGE_ID.test(v);
// What a sender may name (the page, a Shortcut key, the channel's reply): never an id
// under the routines' prefix, which only lib/routine-chat.mjs writes.
export const isClientId = v => typeof v === 'string' && CLIENT_ID.test(v) && !v.startsWith(ROUTINE_ID_PREFIX);
export const isRequestId = v => typeof v === 'string' && REQUEST_ID.test(v);
export const isAttachmentId = v => typeof v === 'string' && ATTACHMENT_ID.test(v);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// `m_<time in base 36><6 random base-36 characters>`: sortable by eye, never guessable.
export function newMessageId(now = Date.now()) {
  const rand = randomBytes(6).readUIntBE(0, 6).toString(36).padStart(8, '0').slice(-8);
  return `m_${now.toString(36)}${rand}`;
}

// What a file's first bytes say it is; a file that says nothing is refused.
export function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heif)$/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/heic';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

// The month file a message goes in, from its time.
const monthFile = at => {
  const d = new Date(at);
  return `messages-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
};

async function appendLine(path, line) {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.appendFile(line + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// What the page and the channel get of a message: everything but the client id.
export const publicMessage = m => ({
  seq: m.seq, id: m.id, at: m.at, from: m.from, kind: m.kind, text: m.text,
  replyTo: m.replyTo ?? null, device: m.device ?? null,
  attachments: (m.attachments ?? []).map(a => ({ id: a.id, name: a.name, type: a.type, bytes: a.bytes })),
  editedAt: m.editedAt ?? null, state: m.state ?? null, meta: m.meta ?? null
});

export function createChatStore({ dir, now = () => Date.now(), log = () => {} }) {
  const messages = [];          // in seq order
  const byId = new Map();
  const byClientId = new Map();
  const permissions = new Map(); // uid -> request (see "permissions" below)
  const listeners = new Set();
  let seq = 0;
  let epoch = null;
  let deliveredSeq = 0;
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };
  const cursorPath = join(dir, 'cursor.json');
  const filesDir = join(dir, 'files');

  const emit = event => { for (const fn of listeners) { try { fn(event); } catch { /* a listener's problem */ } } };

  function take(m) {
    messages.push(m);
    byId.set(m.id, m);
    if (m.clientId) byClientId.set(m.clientId, m);
    if (m.seq > seq) seq = m.seq;
  }

  async function load() {
    // mkdir's mode applies only to a folder it creates; one left looser by an
    // earlier run or by hand is tightened here, every start.
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await chmod(filesDir, 0o700);
    let names = [];
    try { names = (await readdir(dir)).filter(n => /^messages-\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch { names = []; }
    for (const name of names) {
      const raw = await readFile(join(dir, name), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!isObject(rec)) continue;
        if (rec.op === 'message' && Number.isInteger(rec.seq) && isMessageId(rec.id) && !byId.has(rec.id)) {
          const { op, ...m } = rec;
          void op;
          take(m);
        } else if (rec.op === 'edit' && byId.has(rec.id)) {
          const m = byId.get(rec.id);
          m.text = rec.text;
          m.editedAt = rec.editedAt;
        } else if (rec.op === 'state' && byId.has(rec.id)) {
          byId.get(rec.id).state = rec.state;
        }
      }
    }
    messages.sort((a, b) => a.seq - b.seq);
    let cursor = null;
    try { cursor = JSON.parse(await readFile(cursorPath, 'utf8')); } catch { cursor = null; }
    if (isObject(cursor) && typeof cursor.epoch === 'string' && cursor.epoch) {
      epoch = cursor.epoch;
      deliveredSeq = Number.isInteger(cursor.deliveredSeq) ? Math.min(cursor.deliveredSeq, seq) : 0;
    } else {
      epoch = randomBytes(8).toString('hex');
      deliveredSeq = 0;
      await writeJson(cursorPath, { epoch, deliveredSeq, createdAt: new Date(now()).toISOString() });
    }
    // The last process's open requests, held until the channel's first hello says whether
    // the process that relayed them is still the one connected (channelHello). Nothing is
    // written to the file before that hello, so a start that never gets one keeps it.
    pendingSnapshot = await readPermissionSnapshot();
    return { messages: messages.length, seq, epoch, deliveredSeq, permissionsOnFile: pendingSnapshot ? pendingSnapshot.cards.length : 0 };
  }

  // One message appended: validated here once, written with its seq, then announced.
  function append({ from, kind = 'chat', text = '', replyTo = null, device = null, clientId = null, attachments = [], meta = null, state = null }) {
    return serial(async () => {
      if (!CHAT_FROM.has(from)) throw new Error('from must be jeff, jarvis or system');
      if (!CHAT_KINDS.has(kind)) throw new Error('kind is not one of the chat kinds');
      if (kind === 'event' && from !== 'system') throw new Error('only system makes events');
      if (kind === 'stop' && (from !== 'jeff' || typeof device !== 'string' || !device)) throw new Error('only a paired device makes stops');
      if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error(`text must be a string of at most ${MAX_TEXT} characters`);
      if (replyTo !== null && !isMessageId(replyTo)) throw new Error('replyTo must be a message id');
      if (clientId !== null && !(typeof clientId === 'string' && CLIENT_ID.test(clientId))) throw new Error('clientId must be an id of at most 80 characters');
      if (clientId !== null && byClientId.has(clientId)) return byClientId.get(clientId);
      const at = now();
      const m = {
        seq: seq + 1, id: newMessageId(at), at, from, kind, text,
        replyTo, device: typeof device === 'string' ? device.slice(0, 40) : null, clientId,
        attachments: attachments.map(a => ({ id: a.id, name: a.name, type: a.type, bytes: a.bytes, sha256: a.sha256 })),
        meta: isObject(meta) ? meta : null, state
      };
      await appendLine(join(dir, monthFile(at)), JSON.stringify({ op: 'message', ...m }));
      take(m);
      emit({ type: 'message', message: m });
      return m;
    });
  }

  // An edit of one of the lead's own messages, within 24 hours; nothing else moves.
  // A routine's message (the brief, the digest: lib/routine-chat.mjs) is `jarvis`'s
  // too, but it isn't the lead's own words, so the lead can't rewrite it (board
  // c73778aa).
  function edit(id, text) {
    return serial(async () => {
      const m = byId.get(id);
      if (!m) return { ok: false, status: 404, error: 'no such message' };
      if (m.from !== 'jarvis' || m.kind !== 'chat') return { ok: false, status: 403, error: 'only the lead\'s own chat messages can be edited' };
      if (isRoutineMessage(m)) return { ok: false, status: 403, error: 'a routine\'s message can\'t be edited' };
      if (now() - m.at > EDIT_WINDOW_MS) return { ok: false, status: 403, error: 'a message can be edited for 24 hours' };
      if (typeof text !== 'string' || text.length > MAX_TEXT) return { ok: false, status: 400, error: `text must be a string of at most ${MAX_TEXT} characters` };
      const editedAt = now();
      await appendLine(join(dir, monthFile(m.at)), JSON.stringify({ op: 'edit', id, text, editedAt }));
      m.text = text;
      m.editedAt = editedAt;
      emit({ type: 'edit', message: m });
      return { ok: true, message: m };
    });
  }

  // Inside the queue already: never call through `serial` from here.
  async function applyState(m, state) {
    if (!m || m.state === state) return m ?? null;
    await appendLine(join(dir, monthFile(m.at)), JSON.stringify({ op: 'state', id: m.id, state }));
    m.state = state;
    emit({ type: 'state', message: m });
    return m;
  }
  const setState = (id, state) => serial(() => applyState(byId.get(id), state));

  // The messages after a seq (oldest first), or before a message id (the `limit`
  // newest before it, oldest first), at most 100 a page.
  function list({ after = null, before = null, limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 20));
    if (before !== null) {
      const at = byId.get(before);
      const cut = at ? messages.findIndex(m => m.seq === at.seq) : messages.length;
      return messages.slice(Math.max(0, cut - n), cut);
    }
    const from = Number.isInteger(after) ? after : 0;
    const out = [];
    for (const m of messages) {
      if (m.seq > from) out.push(m);
      if (out.length >= n) break;
    }
    return out;
  }

  // Whether one of the lead's messages answers the owner: a reply to an event
  // (replyTo an event's id) answers the event, not anything the owner said, and a
  // routine's message (the brief, the digest: lib/routine-chat.mjs) answers nothing.
  const answersOwner = m => m.from === 'jarvis' && !isRoutineMessage(m) && !(m.replyTo && byId.get(m.replyTo)?.kind === 'event');

  // The owner's chat messages after the lead's last answer to the owner, within 24
  // hours, oldest first. Events are never the owner's, and the lead's replies to them
  // answer nothing here. What the channel reads after a restart is cut from this list
  // by lib/chat-catchup.mjs (the newest first, to fit the channel's room).
  function unanswered() {
    const at = now();
    let lastJarvis = 0;
    for (const m of messages) if (answersOwner(m) && m.seq > lastJarvis) lastJarvis = m.seq;
    return messages.filter(m => m.seq > lastJarvis && m.from === 'jeff' && m.kind === 'chat' && at - m.at <= UNANSWERED_WINDOW_MS);
  }

  const lastFrom = (who, ok = () => true) => messages.reduce((best, m) => (m.from === who && ok(m) && m.at > best ? m.at : best), 0) || null;

  function ack(n) {
    return serial(async () => {
      if (!Number.isInteger(n) || n < deliveredSeq || n > seq) return deliveredSeq;
      deliveredSeq = n;
      await writeJson(cursorPath, { epoch, deliveredSeq });
      for (const m of messages) if (m.seq <= n && m.from === 'jeff' && m.state === 'queued') await applyState(m, 'delivered');
      return deliveredSeq;
    });
  }

  // ---- permissions ----
  // A request is keyed by the channel session it came in on and its id (L7): a new
  // channel session (`newPermissionSession`, a hello from a new process, or the
  // channel's bye) expires every open request, and an id seen again in the same
  // session opens a fresh entry marked `repeat`, which nobody can answer here (Claude
  // Code drops channel verdicts for a repeated id). The routes find a request by id:
  // always its newest entry. An expired request says why in `ended`: `timeout` (its
  // window ran out; also `timedOut`), `channel` (its channel ended or went silent) or
  // `crowded` (more than OPEN_PERMISSIONS_MAX were open).

  let permSession = 0;
  // When the current channel session began (its process's first hello): every card open
  // now was relayed by a process that started by then, so lib/card-watch.mjs reads only the
  // lead's sessions whose transcript was written since. Null before any hello.
  let permSessionAt = null;
  let permUid = 0;
  let permWindow = PERMISSION_TTL_MS; // for requests opened from now on
  let channelSeenAt = null;           // the channel's last hello or heartbeat
  const latest = new Map();   // requestId -> uid of its newest entry
  const seenIds = new Set();  // `${session}:${requestId}`, this session's only

  // ---- permissions across a restart (board ee0bd552) ----
  // The page's open cards lived in memory only, so a restart of this server lost every
  // one while the channel still held the requests and would take a verdict for them. The
  // L7 rule (a new channel process ends every card) can't tell a new process from the
  // same one meeting a new server, so the channel's identity is kept with the cards:
  // `permissions.json` holds the process that relayed them (its pid and its own start
  // time, from its hello), when its session began here, the ids it relayed, and each open
  // request as relayed (tool, description, preview, times, its message). Never the exact
  // command, which stays in memory only; never a request whose description or preview
  // looks like it holds a secret (secret-shape.mjs). Written on each change once a hello
  // has come; the file holds only open requests, so a card that closes leaves it.
  //
  // At the next start the file is read, and at the channel's first hello (channelHello):
  // - another process (pid or start differ, or not given): the L7 rule, nothing comes back;
  // - the same process: its session goes on (its start time and ids here too), and each
  //   request still inside its window, with its message on file and no verdict to it in
  //   the chat log, is held back as `restoring`: not shown, not answerable.
  // A sessions pass that began reading after that (lib/answered-elsewhere.mjs, `pass`)
  // then decides each one: shown again only when a thread of the lead's still has the
  // card's call open (cardThreads) and is not past it; a call answered at the terminal or
  // in Discord while this server was down has its result there, and its card goes.
  // Undecided for RESTORE_JUDGE_MS, a held one goes too, as it does with a bye, a new
  // process, the end of its window or the lead's SessionEnd.
  let channelId = null;         // { pid, startedAt } of the process whose session this is
  let pendingSnapshot = null;   // the last process's file, until the first hello
  const restoring = new Map();  // requestId -> a request held back until a pass judges it
  let permSaveArmed = false;    // nothing is written before the first hello
  let permSaveQueued = false;
  let permSaveSaid = false;
  let permSaveChain = Promise.resolve();
  // Whether the file on disk may hold a card: a file with none brings nothing back, so
  // while there is still none to write, nothing is written (true at load when a file is
  // there at all, so a stale one is always overwritten).
  let fileMayHoldCards = false;
  const permsPath = join(dir, PERMISSIONS_FILE);
  const looksSecret = p => secretShapes(p.description).length > 0 || secretShapes(p.inputPreview ?? '').length > 0;
  const fileCard = p => ({ requestId: p.requestId, tool: p.tool, description: p.description, inputPreview: p.inputPreview, cut: Boolean(p.cut), relayedAt: p.relayedAt, openedAt: p.openedAt, windowMs: p.windowMs, messageId: p.messageId, why: typeof p.why === 'string' ? p.why : null });
  function permissionSnapshot() {
    const cards = [];
    // (An open card is always this session's: a new one ends every open card. One whose
    // message is still being written goes with a null message id, which a start refuses.)
    for (const p of permissions.values()) if (p.state === 'open' && !looksSecret(p)) cards.push(fileCard(p));
    for (const r of restoring.values()) if (!looksSecret(r)) cards.push(fileCard(r));
    const seen = [...seenIds].map(k => k.slice(k.indexOf(':') + 1)).slice(-PERMISSIONS_KEPT_MAX);
    return { version: PERMISSIONS_FILE_VERSION, at: now(), channel: channelId ? { pid: channelId.pid, startedAt: channelId.startedAt, sessionAt: permSessionAt } : null, seen, cards: channelId ? cards : [] };
  }
  // A write after every change, one at a time; the newest state is the one written.
  function permChanged() {
    if (!permSaveArmed || permSaveQueued) return;
    permSaveQueued = true;
    permSaveChain = permSaveChain.then(async () => {
      permSaveQueued = false;
      try {
        const snap = permissionSnapshot();
        if (snap.cards.length === 0 && !fileMayHoldCards) return;
        await writeJson(permsPath, snap);
        fileMayHoldCards = snap.cards.length > 0;
        permSaveSaid = false;
      } catch (err) {
        if (!permSaveSaid) log(`chat: the open permission requests could not be written for the next start (${err?.code ?? err?.name ?? 'error'})`);
        permSaveSaid = true;
      }
    });
  }
  // The file as the last process left it, or null: a regular file, small, version 1, a
  // channel named, each card in shape, inside its window, its message on file and never
  // answered from the page (a verdict to it in the log: the write after it may not have
  // landed before the stop).
  // The file as the last process left it, checked (`checkPermissionFile`); a file that
  // brings back no card is removed, so nothing stale waits in it, and temp files an
  // interrupted write left are swept (Ultron's L3).
  async function readPermissionSnapshot() {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.startsWith(`${PERMISSIONS_FILE}.tmp-`)) await unlink(join(dir, name)).catch(() => {});
    }
    let info;
    try { info = await stat(permsPath); } catch { return null; }
    const snap = await checkPermissionFile(info);
    // (A folder or other non-file in its place can't be unlinked, and holds no card.)
    if (snap === null || snap.cards.length === 0) {
      await unlink(permsPath).catch(() => {});
      return null;
    }
    fileMayHoldCards = true;
    return snap;
  }
  async function checkPermissionFile(info) {
    let raw;
    try {
      if (!info.isFile() || info.size > PERMISSIONS_FILE_MAX_BYTES) return null;
      raw = JSON.parse(await readFile(permsPath, 'utf8'));
    } catch { return null; }
    if (!isObject(raw) || raw.version !== PERMISSIONS_FILE_VERSION || !isObject(raw.channel)) return null;
    const { pid, startedAt, sessionAt } = raw.channel;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(sessionAt)) return null;
    const at = now();
    // A verdict answers a card by replying to its message (answerPermission writes it so).
    const answeredIds = new Set(messages.filter(m => m.kind === 'verdict' && isMessageId(m.replyTo)).map(m => m.replyTo));
    const cards = [];
    const ids = new Set();
    for (const c of Array.isArray(raw.cards) ? raw.cards : []) {
      if (cards.length >= OPEN_PERMISSIONS_MAX) break;
      if (!isObject(c) || !isRequestId(c.requestId) || ids.has(c.requestId)) continue;
      if (typeof c.tool !== 'string' || typeof c.description !== 'string' || typeof c.inputPreview !== 'string') continue;
      if (!Number.isSafeInteger(c.relayedAt) || !Number.isSafeInteger(c.openedAt) || c.relayedAt > at || c.openedAt > at) continue;
      if (!Number.isSafeInteger(c.windowMs) || c.windowMs <= 0 || c.windowMs > PERMISSION_HOLD_MAX_MS || at - c.relayedAt >= c.windowMs) continue;
      if (at - c.openedAt >= PREVIEW_TTL_MS) continue;
      // The card's own message (the chat log's line for it, written when it opened, the
      // lead's) must carry the hash of the card as relayed (Ultron's M1: the file is any
      // of the owner's processes' to write, so a tool, description or preview rewritten
      // there must never reach a card). The hash covers the tool and the real description,
      // so a card given the secret stand-in never matches; a message from before the seal
      // has none, so its card never comes back.
      const m = isMessageId(c.messageId) ? byId.get(c.messageId) : null;
      if (!m || m.kind !== 'permission' || m.from !== 'jarvis' || m.meta?.requestId !== c.requestId) continue;
      if (typeof m.meta?.relayed !== 'string' || m.meta.relayed !== shownHash(c.tool, c.description, c.inputPreview)) continue;
      if (c.why !== undefined && c.why !== null && !isWhyLine(c.why, c.tool)) continue;
      if (answeredIds.has(c.messageId)) continue;
      // (Its fields are the ones relayed, capped when the card opened: the seal says so.)
      ids.add(c.requestId);
      cards.push({ requestId: c.requestId, tool: c.tool, description: c.description, inputPreview: c.inputPreview, cut: c.cut === true, relayedAt: c.relayedAt, openedAt: c.openedAt, windowMs: c.windowMs, messageId: c.messageId, why: typeof c.why === 'string' ? c.why : null });
    }
    const seen = (Array.isArray(raw.seen) ? raw.seen : []).filter(isRequestId).slice(-PERMISSIONS_KEPT_MAX);
    return { channel: { pid, startedAt, sessionAt }, seen, cards };
  }

  const endPermission = (p, ended) => {
    p.state = 'expired';
    p.ended = ended;
    if (ended === 'timeout') p.timedOut = true;
    emit({ type: 'permission-closed', request: p });
    permChanged();
  };
  const forget = (uid, p) => {
    permissions.delete(uid);
    if (latest.get(p.requestId) === uid) latest.delete(p.requestId);
  };

  function prunePermissions() {
    const at = now();
    const gone = channelSeenAt !== null && at - channelSeenAt >= CHANNEL_GONE_MS;
    for (const [uid, p] of permissions) {
      if (p.state === 'open' && at - p.relayedAt >= p.windowMs) endPermission(p, 'timeout');
      else if (p.state === 'open' && gone) endPermission(p, 'channel');
      // A closed request drops its exact command at the next look (any read prunes).
      if (p.state !== 'open') { p.exact = null; p.exactWas = null; p.exactGained = false; }
      if (at - p.openedAt >= PREVIEW_TTL_MS) p.inputPreview = null;
      if (at - p.openedAt >= 7 * DAY) forget(uid, p);
    }
    // A held-back request goes at the end of its window, with a silent channel, or when no
    // pass has judged it in time (fail closed: it never shows).
    let letGo = false;
    for (const [id, r] of restoring) {
      if (at - r.relayedAt >= r.windowMs || gone || at - r.restoredAt >= RESTORE_JUDGE_MS) { restoring.delete(id); letGo = true; }
    }
    if (letGo) permChanged();
    // The count bound: the oldest that are no longer open go first (at most
    // OPEN_PERMISSIONS_MAX are open, so there is always one).
    if (permissions.size > PERMISSIONS_KEPT_MAX) {
      for (const [uid, p] of permissions) {
        if (permissions.size <= PERMISSIONS_KEPT_MAX) break;
        if (p.state !== 'open') forget(uid, p);
      }
    }
  }

  // A new channel session: every open request expires (its channel process, and the
  // prompt ids it knew, are gone or can't be told from a new one's). The ids seen in
  // the old session can never match again, so they are let go.
  function newPermissionSession() {
    permSession++;
    permSessionAt = now();
    seenIds.clear();
    channelId = null;
    pendingSnapshot = null;
    restoring.clear();
    permSaveArmed = true;
    for (const p of permissions.values()) if (p.state === 'open') endPermission(p, 'channel');
    permChanged();
    return permSession;
  }

  // A hello from a channel process that this server did not know (lib/chat-socket.mjs:
  // no session token of this process's). `pid` and `startedAt` are what the hello says of
  // the process (its pid, checked by lib/chat-verify.mjs when the server knows the
  // channel's path, and the process's own start in ms). A new session always begins (L7:
  // every open request here ends). At this server's first hello, the last process's file
  // comes back only if it was written for this same process: then its session goes on
  // (its start and ids), and each request still inside its window is held back until a
  // sessions pass judges it (`restoringPermissions`, `settleRestored`). Answers
  // { session, restored, dropped, why } (why: the words for a file that didn't come back).
  function channelHello({ pid = null, startedAt = null } = {}) {
    const snap = pendingSnapshot;
    newPermissionSession();
    const id = Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(startedAt) && startedAt > 0 ? { pid, startedAt } : null;
    channelId = id;
    const out = { session: permSession, restored: 0, dropped: 0, why: null };
    if (snap && snap.cards.length > 0) {
      const same = id !== null && snap.channel.pid === id.pid && snap.channel.startedAt === id.startedAt;
      if (!same) {
        out.dropped = snap.cards.length;
        out.why = id === null ? 'the channel\'s hello did not say its pid and start' : 'a different channel process said hello';
      } else {
        const at = now();
        if (snap.channel.sessionAt <= at) permSessionAt = snap.channel.sessionAt;
        for (const s of snap.seen) seenIds.add(`${permSession}:${s}`);
        // (`seen` holds every id the session relayed, the held ones too.)
        for (const c of snap.cards) {
          if (at - c.relayedAt >= c.windowMs) { out.dropped++; continue; }
          restoring.set(c.requestId, { ...c, restoredAt: at });
          out.restored++;
        }
        if (out.dropped > 0) out.why = 'their window had ended';
      }
    }
    // (newPermissionSession above queued the write; it takes the state as it is now.)
    return out;
  }

  // The held-back requests, as copies for lib/answered-elsewhere.mjs to judge:
  // { requestId, tool, relayedAt, restoredAt }.
  const restoringPermissions = () => { prunePermissions(); return [...restoring.values()].map(r => ({ requestId: r.requestId, tool: r.tool, relayedAt: r.relayedAt, restoredAt: r.restoredAt })); };

  // A pass's word on held-back requests: `decisions` is a Map of request id to true (its
  // call still waits in the lead's transcripts: shown again) or false (let go). A request
  // shown again is open once more under this session, inside the smaller of its own window
  // and the channel's current one, with the gate's reasons worked out again by `assess`
  // (lib/approvals.mjs; the exact command is gone with the old process, so a Bash card
  // shows the relayed preview). Answers { opened, dropped } (request ids).
  function settleRestored(decisions, { assess = () => ({ denyOnly: [], why: null }) } = {}) {
    prunePermissions();
    const opened = [], dropped = [];
    if (!(decisions instanceof Map)) return { opened, dropped };
    const at = now();
    for (const [rid, keep] of decisions) {
      const r = restoring.get(rid);
      if (!r) continue;
      restoring.delete(rid);
      const windowMs = Math.min(r.windowMs, permWindow);
      const newer = findPermission(rid);
      const openCount = [...permissions.values()].filter(q => q.state === 'open').length;
      if (keep !== true || at - r.relayedAt >= windowMs || (newer && newer.openedAt >= r.openedAt) || openCount >= OPEN_PERMISSIONS_MAX) { dropped.push(rid); continue; }
      const p = {
        requestId: r.requestId, tool: r.tool, description: r.description, inputPreview: r.inputPreview, cut: r.cut,
        openedAt: r.openedAt, relayedAt: r.relayedAt, session: permSession, windowMs, state: 'open',
        answeredBy: null, answeredAt: null, messageId: r.messageId, denyOnly: [], why: r.why ?? null, exact: null, restored: true
      };
      // The gate's Deny-only reasons are worked out again; its "why it is asking" line is
      // the one the card had (a block seen by this process is not this card's; L1).
      try {
        const a = assess(p) ?? {};
        p.denyOnly = Array.isArray(a.denyOnly) ? a.denyOnly : [];
        p.exact = typeof a.exact === 'string' ? a.exact : null;
      } catch { p.denyOnly = ['it could not be checked']; p.exact = null; }
      const uid = ++permUid;
      permissions.set(uid, p);
      latest.set(rid, uid);
      seenIds.add(`${permSession}:${rid}`);
      emit({ type: 'permission', request: p });
      opened.push(rid);
    }
    permChanged();
    return { opened, dropped };
  }

  // From the channel's hello: how long it holds a request (`permHoldMs`; anything but
  // a positive whole number means it doesn't say). Applies to requests opened from now
  // on. Answers the page's window.
  function setPermissionHold(holdMs) {
    permWindow = permissionWindow(holdMs);
    return permWindow;
  }
  // The channel said hello or sent a heartbeat (lib/chat-socket.mjs).
  function noteChannelAlive(at = now()) { channelSeenAt = at; }

  // `assess(p)` (lib/approvals.mjs) answers { denyOnly, why } for the stored fields.
  // Fields are kept whole up to FIELD_MAX code points; a longer one is cut, marked and
  // flagged. `relayedAt` is when the channel got the prompt: expiry counts from it,
  // and a request older than LATE_AFTER_MS on arrival is `late` (answer at the terminal).
  async function openPermission({ requestId, tool, description, inputPreview, relayedAt = null, cut = false }, { assess = () => ({ denyOnly: [], why: null }) } = {}) {
    if (!isRequestId(requestId)) throw new Error('requestId must be an id of at most 64 characters');
    prunePermissions();
    const at = now();
    const key = `${permSession}:${requestId}`;
    const repeat = seenIds.has(key);
    seenIds.add(key);
    const t = capField(tool, TOOL_MAX), d = capField(description), ip = capField(inputPreview);
    // When the channel had it: never later than now, and a clock far ahead is ignored.
    const ra = Number.isSafeInteger(relayedAt) && relayedAt <= at + 5e3 ? Math.min(relayedAt, at) : at;
    const late = at - ra > LATE_AFTER_MS;
    const p = {
      requestId, tool: t.text, description: d.text, inputPreview: ip.text,
      cut: Boolean(cut) || t.cut || d.cut || ip.cut,
      openedAt: at, relayedAt: ra, session: permSession, windowMs: permWindow,
      state: repeat ? 'repeat' : late ? 'late' : 'open',
      answeredBy: null, answeredAt: null, messageId: null, denyOnly: [], why: null, exact: null
    };
    // `exact` is a Bash command's exact text, when the gate matched the hook's report
    // to this request: shown on the card, covered by the hash, kept in memory only and
    // dropped once the request has closed (prunePermissions, on the next read).
    try {
      const a = assess(p) ?? {};
      p.denyOnly = Array.isArray(a.denyOnly) ? a.denyOnly : [];
      p.why = typeof a.why === 'string' ? a.why : null;
      p.exact = typeof a.exact === 'string' ? a.exact : null;
    } catch { p.denyOnly = ['it could not be checked']; p.exact = null; }
    const uid = ++permUid;
    permissions.set(uid, p);
    latest.set(requestId, uid);
    // Past OPEN_PERMISSIONS_MAX the oldest open ones end, as the channel forgets them.
    if (p.state === 'open') {
      let over = [...permissions.values()].filter(q => q.state === 'open').length - OPEN_PERMISSIONS_MAX;
      for (const q of permissions.values()) {
        if (over <= 0) break;
        if (q.state === 'open' && q !== p) { endPermission(q, 'crowded'); over--; }
      }
    }
    // The description is model text: one that looks like it holds a secret never
    // reaches the disk (L12); the card still shows it from memory.
    const onDisk = secretShapes(p.description).length ? SECRET_STAND_IN : p.description;
    // `relayed`: the hash of the card as relayed (tool, description, preview: shownHash
    // without the exact command), the chat log's seal for a card that comes back after a
    // restart (permissions.json is checked against it; board ee0bd552, Ultron's M1). The
    // same kind of hash a verdict already carries as `shown`.
    const m = await append({ from: 'jarvis', kind: 'permission', text: onDisk, meta: { requestId, tool: p.tool, relayed: shownHash(p.tool, p.description, p.inputPreview) } });
    p.messageId = m.id;
    emit({ type: 'permission', request: p });
    permChanged();
    return p;
  }

  const findPermission = id => { const uid = latest.get(id); return uid === undefined ? null : permissions.get(uid) ?? null; };
  // What answered-elsewhere may close: an open request, or one that timed out here
  // unanswered (it may still wait in Claude Code).
  const closable = p => p.state === 'open' || (p.state === 'expired' && p.timedOut === true);
  // Those requests, for lib/answered-elsewhere.mjs to say whose each is: { requestId, tool,
  // relayedAt } copies (it closes them only through closePermissionsElsewhere).
  const closablePermissions = () => { prunePermissions(); return [...permissions.values()].filter(closable).map(p => ({ requestId: p.requestId, tool: p.tool, relayedAt: p.relayedAt })); };

  // The lead's session moved on (lib/answered-elsewhere.mjs): every request the channel
  // relayed before `upTo` that is still open here, or timed out here unanswered, was
  // answered somewhere else (Claude Code's own prompt, Discord) or dropped with its
  // turn. Claude Code sends a channel no word of that, so this is the page's only
  // close for them. State `elsewhere`: no verdict is written, nothing goes to the
  // channel, and a later tap answers 409. `ids` (a Set of request ids), when given, closes
  // only those (lib/answered-elsewhere.mjs: the cards whose own thread moved on). Answers
  // the ids it closed.
  function closePermissionsElsewhere({ upTo = now(), event = null, ids = null } = {}) {
    prunePermissions();
    const closed = [];
    for (const p of permissions.values()) {
      if (!closable(p)) continue;
      if (ids !== null && !(ids instanceof Set && ids.has(p.requestId))) continue;
      // (An `upTo` that is no number compares false, so it closes nothing.)
      if (typeof upTo !== 'number' || !(p.relayedAt < upTo)) continue;
      p.state = 'elsewhere';
      p.closedAt = now();
      p.closedBy = typeof event === 'string' ? event.slice(0, 40) : null;
      closed.push(p.requestId);
      emit({ type: 'permission-closed', request: p });
    }
    // Every card at once (the lead's SessionEnd, or his turn with no pass to say whose a
    // card is): the held-back ones go too, unseen.
    if (ids === null && typeof upTo === 'number') for (const [rid, r] of restoring) if (r.relayedAt < upTo) restoring.delete(rid);
    permChanged();
    return closed;
  }

  // First answer wins; an unknown, closed, late or repeated id answers nothing.
  // `shown` must be the hash of what the card showed; `allowOk(p)` answers null or
  // the reason Allow is out (the gate's), checked here, inside the store's order.
  async function answerPermission(requestId, behavior, by, { shown = null, requireShown = false, allowProblem = () => null } = {}) {
    prunePermissions();
    const p = findPermission(requestId);
    if (!p) return { ok: false, status: 404, error: 'no such request' };
    if (p.state === 'repeat' || p.state === 'late') return { ok: false, status: 409, error: 'this one can only be answered at the terminal' };
    if (p.state === 'elsewhere') return { ok: false, status: 409, error: 'already answered somewhere else, or no longer asked: Jarvis has moved on' };
    if (p.state !== 'open') return { ok: false, status: 409, error: `already ${p.state}${p.answeredBy ? ` by ${p.answeredBy}` : ''}` };
    if (behavior !== 'allow' && behavior !== 'deny') return { ok: false, status: 400, error: 'behavior must be allow or deny' };
    const hash = shownHash(p.tool, p.description, p.inputPreview, p.exact, p.exactNote);
    // A tap made on the card as it was before the gate changed its exact text: it took a
    // disputed text off (`exactWas`; the card it was on had no note), or the hook's report
    // came after the card opened and gave it a text or, in parity, a conflict's note
    // (`exactGained`: the card was drawn with neither; lib/approvals.mjs). A card can be
    // both (gained, then disputed): a tap on either earlier card is on an old card.
    // A Deny counts (Ultron's L2: Deny always works); an Allow is refused as `changed`,
    // with the request, so the route sends the page the card as it is now and doesn't
    // count the tap as a refusal (L1). Any other hash is a plain refusal.
    if ((requireShown || shown !== null) && shown !== hash) {
      const earlier = [];
      if (typeof p.exactWas === 'string') earlier.push(shownHash(p.tool, p.description, p.inputPreview, p.exactWas));
      if (p.exactGained === true) earlier.push(shownHash(p.tool, p.description, p.inputPreview));
      if (!earlier.includes(shown)) return { ok: false, status: 409, error: 'the request changed; reload' };
      if (behavior !== 'deny') return { ok: false, status: 409, error: 'the request changed; reload', changed: true, request: p };
    }
    if (behavior === 'allow') {
      const why = allowProblem(p);
      if (why) return { ok: false, status: 403, error: why };
    }
    p.state = behavior === 'allow' ? 'allowed' : 'denied';
    p.answeredBy = typeof by === 'string' ? by.slice(0, 40) : null;
    p.answeredAt = now();
    await append({ from: 'jeff', kind: 'verdict', text: behavior, replyTo: p.messageId, device: p.answeredBy, meta: { requestId, behavior, answeredAt: p.answeredAt, tool: p.tool, shown: hash, denyOnly: p.denyOnly.length > 0 } });
    emit({ type: 'permission-closed', request: p });
    permChanged();
    return { ok: true, request: p };
  }

  const openPermissions = () => { prunePermissions(); return [...permissions.values()].filter(p => p.state === 'open'); };
  // The gate changed an open card (an exact-command mark, or an exact text that came
  // after it opened; lib/approvals.mjs): every page gets it again. A request that is not
  // open, or not this store's, sends nothing; nor does one whose own first send is still
  // to come (no message yet: that send carries the change).
  const redrawPermission = p => {
    if (!p || p.state !== 'open' || findPermission(p.requestId) !== p || p.messageId === null) return false;
    emit({ type: 'permission', request: p });
    return true;
  };
  // What a page gets when its stream opens: the open requests, and those that timed
  // out here unanswered in the last CARD_REPLAY_MS and may still be waiting in Claude
  // Code. A page that was away for the request's whole window then shows where to
  // answer it instead of nothing. One closed any other way is not replayed.
  const cardPermissions = () => {
    prunePermissions();
    const at = now();
    return [...permissions.values()].filter(p => p.state === 'open' || (p.state === 'expired' && p.timedOut === true && at - (p.relayedAt + p.windowMs) < CARD_REPLAY_MS));
  };
  const publicPermission = p => {
    const parsed = parsePreview(p.inputPreview);
    return {
      requestId: p.requestId, tool: p.tool, description: p.description, inputPreview: p.inputPreview,
      fields: parsed ? parsed.fields : null, cut: Boolean(p.cut), why: p.why ?? null, denyOnly: p.denyOnly ?? [],
      exact: typeof p.exact === 'string' ? p.exact : null,
      openedAt: p.openedAt, relayedAt: p.relayedAt ?? p.openedAt, expiresAt: (p.relayedAt ?? p.openedAt) + p.windowMs,
      state: p.state, answeredBy: p.answeredBy, answeredAt: p.answeredAt, messageId: p.messageId,
      ...(p.state === 'elsewhere' ? { closedAt: p.closedAt ?? null } : {}),
      ...(p.state === 'expired' ? { ended: p.ended ?? null } : {})
    };
  };

  // ---- attachments ----

  // `textOnly`: the caller holds text and nothing else (text shared through a Shortcut),
  // so the bytes are not sniffed: words that begin like a PDF or a picture are still a
  // text file, and are never stored or served as anything else.
  async function putAttachment({ name, type, data, textOnly = false }) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw Object.assign(new Error('the file is empty'), { status: 400 });
    if (data.length > ATTACHMENT_MAX_BYTES) throw Object.assign(new Error('the file is over 10 MB'), { status: 413 });
    const sniffed = textOnly ? null : sniffType(data);
    const declared = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
    const kind = sniffed ?? (declared === 'text/plain' || declared === 'text/markdown' ? declared : null);
    if (!kind || !ATTACHMENT_TYPES.has(kind)) throw Object.assign(new Error('the file is not a png, jpeg, webp, heic, pdf, txt or md'), { status: 415 });
    if ((kind === 'text/plain' || kind === 'text/markdown') && data.includes(0)) throw Object.assign(new Error('a text file may not hold NUL bytes'), { status: 415 });
    const id = randomBytes(16).toString('hex');
    // Cut by code points, never UTF-16 units: half a surrogate pair is not text, and
    // encodeURIComponent throws on it when the name is served (dispositionFor).
    const safeName = Array.from(String(name ?? 'file').toWellFormed().replace(/[\\/\u0000-\u001f\u007f]/g, '_')).slice(0, 120).join('') || 'file';
    await writeFile(join(filesDir, id), data, { mode: 0o600, flag: 'wx' });
    return { id, name: safeName, type: kind, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  // The attachment's file and type, by id, when a message carries it.
  function attachment(id) {
    if (!isAttachmentId(id)) return null;
    for (const m of messages) {
      const a = (m.attachments ?? []).find(x => x.id === id);
      if (a) return { ...a, path: join(filesDir, id) };
    }
    return null;
  }

  // An upload never sent with a message: its file goes now (a pending upload that
  // expired, lib/chat-routes.mjs). A file a message carries is never removed here.
  async function removeAttachment(id) {
    if (!isAttachmentId(id) || attachment(id)) return false;
    try { await unlink(join(filesDir, id)); return true; } catch { return false; }
  }

  // At start: a file no message carries and older than an hour is an upload that was
  // never sent (the pending list lives in memory and died with the last run), so it
  // goes. A younger one is left for the next start, in case a clock or a slow
  // write says otherwise. Answers how many went.
  async function pruneOrphans({ olderThanMs = ORPHAN_AFTER_MS } = {}) {
    const at = now();
    const carried = new Set(messages.flatMap(m => (m.attachments ?? []).map(a => a.id)));
    let gone = 0;
    for (const name of await readdir(filesDir).catch(() => [])) {
      if (!isAttachmentId(name) || carried.has(name)) continue;
      const path = join(filesDir, name);
      try {
        const info = await stat(path);
        if (at - info.mtimeMs > olderThanMs) { await unlink(path); gone++; }
      } catch { /* already gone */ }
    }
    return gone;
  }

  // Files older than 90 days go; the message keeps its record of them.
  async function pruneAttachments() {
    const at = now();
    let gone = 0;
    for (const name of await readdir(filesDir).catch(() => [])) {
      if (!isAttachmentId(name)) continue;
      const path = join(filesDir, name);
      try {
        const info = await stat(path);
        if (at - info.mtimeMs > ATTACHMENT_TTL_MS) { await unlink(path); gone++; }
      } catch { /* already gone */ }
    }
    return gone;
  }

  return {
    load, append, edit, setState, list, unanswered, ack,
    get: id => byId.get(id) ?? null,
    byClientId: id => byClientId.get(id) ?? null,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    get seq() { return seq; },
    get epoch() { return epoch; },
    get deliveredSeq() { return deliveredSeq; },
    get size() { return messages.length; },
    // The newest `n` messages, oldest first, as a copy (the search, lib/chat-search.mjs).
    newest: n => (Number.isInteger(n) && n > 0 ? messages.slice(-n) : []),
    // The page's "slow" state: an answer to an event is not an answer to the owner.
    lastJarvisAt: () => lastFrom('jarvis', answersOwner),
    lastJeffAt: () => lastFrom('jeff'),
    // The times of the first and the last of the owner's chat messages after `after`
    // (isOwnerChat), or null when there is none, for the idle wake-up's reset
    // (lib/proactive.mjs, `ownerChat`).
    ownerChatAfter: after => {
      let first = null, last = null;
      for (const m of messages) {
        if (!isOwnerChat(m) || !(typeof m.at === 'number' && m.at > after)) continue;
        if (first === null || m.at < first) first = m.at;
        if (last === null || m.at > last) last = m.at;
      }
      return first === null ? null : { first, last };
    },
    openPermission, answerPermission, openPermissions, redrawPermission, publicPermission, newPermissionSession, closePermissionsElsewhere, closablePermissions, cardPermissions,
    setPermissionHold, noteChannelAlive, channelHello, restoringPermissions, settleRestored,
    // The last write of permissions.json done (tests, and a clean stop).
    flushPermissions: () => permSaveChain,
    permission: id => { prunePermissions(); return findPermission(id); },
    get permissionSession() { return permSession; },
    get permissionSessionAt() { return permSessionAt; },
    putAttachment, attachment, pruneAttachments, pruneOrphans, removeAttachment,
    attachmentPath: id => (isAttachmentId(id) ? join(filesDir, id) : null)
  };
}
