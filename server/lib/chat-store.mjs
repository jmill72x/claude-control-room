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
// their state, expire after 10 minutes, and lose their input preview after 24 h.
// Attachments are files under `files/<random id>`, named only by that id.
import { open, readFile, writeFile, mkdir, readdir, rename, stat, unlink, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const HOUR = 3600e3, DAY = 24 * HOUR;
export const CHAT_KINDS = new Set(['chat', 'permission', 'verdict', 'notice']);
export const CHAT_FROM = new Set(['jeff', 'jarvis', 'system']);
export const MAX_TEXT = 32000;
export const MAX_PAGE_TEXT = 8000;
export const EDIT_WINDOW_MS = DAY;
export const PERMISSION_TTL_MS = 10 * 60e3;
export const PREVIEW_TTL_MS = DAY;
export const UNANSWERED_WINDOW_MS = DAY;
export const UNANSWERED_MAX = 10;
export const UNANSWERED_BYTES = 8 * 1024;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TTL_MS = 90 * DAY;
export const ORPHAN_AFTER_MS = 3600e3;
export const ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf', 'text/plain', 'text/markdown']);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MESSAGE_ID = /^m_[a-z0-9]{6,24}$/;
const ATTACHMENT_ID = /^[a-f0-9]{32}$/;

export const isMessageId = v => typeof v === 'string' && MESSAGE_ID.test(v);
export const isClientId = v => typeof v === 'string' && CLIENT_ID.test(v);
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

export function createChatStore({ dir, now = () => Date.now() }) {
  const messages = [];          // in seq order
  const byId = new Map();
  const byClientId = new Map();
  const permissions = new Map(); // requestId -> request
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
    return { messages: messages.length, seq, epoch, deliveredSeq };
  }

  // One message appended: validated here once, written with its seq, then announced.
  function append({ from, kind = 'chat', text = '', replyTo = null, device = null, clientId = null, attachments = [], meta = null, state = null }) {
    return serial(async () => {
      if (!CHAT_FROM.has(from)) throw new Error('from must be jeff, jarvis or system');
      if (!CHAT_KINDS.has(kind)) throw new Error('kind is not one of the chat kinds');
      if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error(`text must be a string of at most ${MAX_TEXT} characters`);
      if (replyTo !== null && !isMessageId(replyTo)) throw new Error('replyTo must be a message id');
      if (clientId !== null && !isClientId(clientId)) throw new Error('clientId must be an id of at most 80 characters');
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
  function edit(id, text) {
    return serial(async () => {
      const m = byId.get(id);
      if (!m) return { ok: false, status: 404, error: 'no such message' };
      if (m.from !== 'jarvis' || m.kind !== 'chat') return { ok: false, status: 403, error: 'only the lead\'s own chat messages can be edited' };
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

  // The owner's messages after the lead's last one, within 24 hours, at most 10
  // messages or 8 KB of text: what the channel reads after a restart.
  function unanswered() {
    const at = now();
    let lastJarvis = 0;
    for (const m of messages) if (m.from === 'jarvis' && m.seq > lastJarvis) lastJarvis = m.seq;
    const out = [];
    let bytes = 0;
    for (const m of messages) {
      if (m.seq <= lastJarvis || m.from !== 'jeff' || m.kind !== 'chat' || at - m.at > UNANSWERED_WINDOW_MS) continue;
      bytes += Buffer.byteLength(m.text);
      if (out.length >= UNANSWERED_MAX || bytes > UNANSWERED_BYTES) break;
      out.push(m);
    }
    return out;
  }

  const lastFrom = who => messages.reduce((best, m) => (m.from === who && m.at > best ? m.at : best), 0) || null;

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

  function prunePermissions() {
    const at = now();
    for (const [id, p] of permissions) {
      if (p.state === 'open' && at - p.openedAt >= PERMISSION_TTL_MS) { p.state = 'expired'; emit({ type: 'permission-closed', request: p }); }
      if (at - p.openedAt >= PREVIEW_TTL_MS) p.inputPreview = null;
      if (at - p.openedAt >= 7 * DAY) permissions.delete(id);
    }
  }

  async function openPermission({ requestId, tool, description, inputPreview }) {
    if (!isRequestId(requestId)) throw new Error('requestId must be an id of at most 64 characters');
    if (permissions.has(requestId)) return permissions.get(requestId);
    const clean = v => (typeof v === 'string' ? Array.from(v).slice(0, 3500).join('') : '');
    const p = { requestId, tool: clean(tool).slice(0, 200), description: clean(description), inputPreview: clean(inputPreview), openedAt: now(), state: 'open', answeredBy: null, answeredAt: null, messageId: null };
    permissions.set(requestId, p);
    const m = await append({ from: 'jarvis', kind: 'permission', text: p.description, meta: { requestId, tool: p.tool } });
    p.messageId = m.id;
    emit({ type: 'permission', request: p });
    return p;
  }

  // First answer wins; an unknown, expired or repeated id answers nothing.
  async function answerPermission(requestId, behavior, by) {
    prunePermissions();
    const p = permissions.get(requestId);
    if (!p) return { ok: false, status: 404, error: 'no such request' };
    if (p.state !== 'open') return { ok: false, status: 409, error: `already ${p.state}` };
    if (behavior !== 'allow' && behavior !== 'deny') return { ok: false, status: 400, error: 'behavior must be allow or deny' };
    p.state = behavior === 'allow' ? 'allowed' : 'denied';
    p.answeredBy = typeof by === 'string' ? by.slice(0, 40) : null;
    p.answeredAt = now();
    await append({ from: 'jeff', kind: 'verdict', text: behavior, replyTo: p.messageId, device: p.answeredBy, meta: { requestId, behavior } });
    emit({ type: 'permission-closed', request: p });
    return { ok: true, request: p };
  }

  const openPermissions = () => { prunePermissions(); return [...permissions.values()].filter(p => p.state === 'open'); };
  const publicPermission = p => ({ requestId: p.requestId, tool: p.tool, description: p.description, inputPreview: p.inputPreview, openedAt: p.openedAt, state: p.state, answeredBy: p.answeredBy, answeredAt: p.answeredAt, messageId: p.messageId });

  // ---- attachments ----

  async function putAttachment({ name, type, data }) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw Object.assign(new Error('the file is empty'), { status: 400 });
    if (data.length > ATTACHMENT_MAX_BYTES) throw Object.assign(new Error('the file is over 10 MB'), { status: 413 });
    const sniffed = sniffType(data);
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
    lastJarvisAt: () => lastFrom('jarvis'),
    lastJeffAt: () => lastFrom('jeff'),
    openPermission, answerPermission, openPermissions, publicPermission,
    permission: id => { prunePermissions(); return permissions.get(id) ?? null; },
    putAttachment, attachment, pruneAttachments, pruneOrphans, removeAttachment,
    attachmentPath: id => (isAttachmentId(id) ? join(filesDir, id) : null)
  };
}
