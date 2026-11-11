// The Chat tab's pure logic (jarvis-os-chat-spec.md, C5): merging what the
// server sends with what the page has, the ticks, the status banner, the photo
// resize and the retry-safe ids. Checked by web/test/orbit-chat.test.js; the
// components in src/orbit/Chat.jsx only render what these return.

export const PERMISSION_TTL_MS = 10 * 60e3;
export const SLOW_AFTER_MS = 10 * 60e3;
export const PHOTO_LONG_EDGE = 1568;
export const PHOTO_QUALITY = 0.85;
export const MAX_TEXT = 8000;
export const PAGE = 50;

const pad2 = n => String(n).padStart(2, '0');
// HH:MM in local time, as the banner and the timestamps say it.
export const hhmm = at => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '--:--' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// ---- the message list ----

// An id for a send, unique per page load: the server dedups on it, so a retry of
// the same message after a lost answer never doubles it.
export function newClientId(now = Date.now(), rand = Math.random) {
  return `p_${now.toString(36)}_${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

// The list after `incoming` (from a page of history, a replay or one live event)
// joins it: each seq once, in seq order, the newer copy of a seq winning (an
// edit or a state change arrives as the whole message again). A message the page
// sent and still shows as pending (no seq yet, a `clientId` of its own) is
// replaced by the server's copy when one arrives with the same clientId, which
// the send's answer `{id}` ties to it (`pendingId`).
export function mergeMessages(list, incoming, { pendingId = null, clientId = null } = {}) {
  const bySeq = new Map();
  const pending = [];
  for (const m of list) {
    if (Number.isInteger(m.seq)) bySeq.set(m.seq, m);
    else pending.push(m);
  }
  const add = Array.isArray(incoming) ? incoming : [incoming];
  let resolved = null;
  for (const m of add) {
    if (!m || !Number.isInteger(m.seq)) continue;
    bySeq.set(m.seq, m);
    if (pendingId !== null && m.id === pendingId) resolved = clientId;
  }
  const keep = pending.filter(p => p.clientId !== resolved && !add.some(m => m && m.id === p.id));
  return [...[...bySeq.values()].sort((a, b) => a.seq - b.seq), ...keep];
}

// An edit or a state event names one message; the rest stay as they were.
export function applyEdit(list, { id, text, editedAt }) {
  return list.map(m => (m.id === id ? { ...m, text, editedAt: editedAt ?? m.editedAt ?? null } : m));
}
export function applyState(list, { id, state }) {
  return list.map(m => (m.id === id && m.state !== state ? { ...m, state } : m));
}

// The seq to resume a stream from: the highest the page holds (0 for none).
export const lastSeq = list => list.reduce((best, m) => (Number.isInteger(m.seq) && m.seq > best ? m.seq : best), 0);

// The oldest message's id, for `?before=` when the viewer scrolls up.
export const oldestId = list => { const first = list.find(m => Number.isInteger(m.seq)); return first ? first.id : null; };

// ---- ticks (§2.6: one when delivered, two when answered) ----

// `sending`: the page hasn't heard back (an optimistic bubble); `failed`: the send
// was refused or the network dropped (a Retry); `queued`: the server has it but
// the channel hasn't; `delivered`: one tick; `answered`: two, once the lead's
// next chat message (a higher seq) exists. Only the owner's chat messages have ticks.
export function tickFor(m, list) {
  if (!m || m.from !== 'jeff' || m.kind !== 'chat') return null;
  if (m.failed) return 'failed';
  if (!Number.isInteger(m.seq)) return 'sending';
  if (list.some(x => x.from === 'jarvis' && x.kind === 'chat' && Number.isInteger(x.seq) && x.seq > m.seq)) return 'answered';
  return m.state === 'delivered' ? 'delivered' : 'queued';
}

export const TICK_MARKS = { sending: '…', failed: '!', queued: '', delivered: '✓', answered: '✓✓' };
export const TICK_WORDS = { sending: 'Sending', failed: 'Not sent', queued: 'Sent', delivered: 'Delivered', answered: 'Answered' };

// ---- the status banner (§2.6) ----

// What the strip over the composer says. `status` is /api/chat/status's answer
// (or the `status` SSE event); null while unknown.
export function bannerFor(status, now = Date.now()) {
  if (!status) return { tone: 'quiet', text: 'Connecting…' };
  const state = status.state;
  if (state === 'offline') {
    const since = Number.isFinite(status.since) ? ` since ${hhmm(status.since)}` : '';
    return { tone: 'offline', text: `Jarvis is offline${since}. Messages wait here and reach him when he's back.` };
  }
  if (state === 'waiting on you') return { tone: 'waiting', text: 'Jarvis is waiting on you: a permission request is open.' };
  if (state === 'slow') {
    const mins = Number.isFinite(status.since) ? Math.max(1, Math.floor((now - status.since) / 60e3)) : null;
    return { tone: 'slow', text: `Delivered ${mins === null ? 'a while' : `${mins} m`} ago, no answer yet` };
  }
  return { tone: 'online', text: 'Jarvis is online' };
}

// The status as the page shows it: the server's `status` event comes with each
// ping (20 s), but a permission request opens and closes between pings, so the
// open cards decide "waiting on you" here, at once, both ways.
export function effectiveStatus(status, permissions, now = Date.now()) {
  const open = [...(permissions?.values?.() ?? [])].some(p => permissionView(p, now)?.view === 'open');
  if (!status) return status;
  if (open) return status.state === 'waiting on you' ? status : { ...status, state: 'waiting on you' };
  if (status.state === 'waiting on you') return { ...status, state: status.channelConnected === false ? 'offline' : 'online' };
  return status;
}

// ---- permission cards ----

// A card's state as the page shows it: `open` with Allow and Deny, `expired` with
// the note that Discord may have answered it, or `closed` (allowed or denied; the
// card goes). `now` decides expiry on the page too, between the server's events.
export function permissionView(p, now = Date.now()) {
  if (!p) return null;
  const state = p.state === 'open' && now - p.openedAt >= PERMISSION_TTL_MS ? 'expired' : p.state;
  if (state === 'allowed' || state === 'denied') return { ...p, view: 'closed', state };
  return { ...p, view: state === 'expired' ? 'expired' : 'open', state };
}

// The map of requests after an event: a new or changed request replaces its row.
export function upsertPermission(map, p) {
  if (!p?.requestId) return map;
  const next = new Map(map);
  next.set(p.requestId, p);
  return next;
}

// ---- photos (§2.5) ----

// The size a photo is drawn at: the long edge at most 1568 px, the aspect kept,
// never scaled up.
export function resizeTarget(width, height, longEdge = PHOTO_LONG_EDGE) {
  const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
  const long = Math.max(w, h);
  if (long <= longEdge) return { width: w, height: h, scaled: false };
  const k = longEdge / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: true };
}

// 820 KB, 2.3 MB: what the composer shows beside a file's name before it goes.
export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- the thread's rows ----

// Messages with a day line before the first of each day: Today, Yesterday, or
// Tue 11-10 for older days.
export function dayLabel(at, now = Date.now()) {
  const d = new Date(at), n = new Date(now);
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function threadRows(list, now = Date.now()) {
  const rows = [];
  let last = null;
  for (const m of list) {
    const at = Number.isFinite(m.at) ? m.at : now;
    const label = dayLabel(at, now);
    if (label !== last) { rows.push({ type: 'day', key: `day-${label}`, label }); last = label; }
    rows.push({ type: 'message', key: m.id ?? m.clientId, message: m });
  }
  return rows;
}

// The message a reply quotes, by id, when the page holds it.
export const quoted = (list, id) => (id ? list.find(m => m.id === id) ?? null : null);

// A quote's one line: the first 90 characters, newlines folded.
export const quoteLine = m => {
  if (!m) return 'an earlier message';
  const text = String(m.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  return m.attachments?.length ? `Photo${m.attachments.length > 1 ? 's' : ''}` : 'an earlier message';
};
