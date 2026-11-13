// The Chat tab's pure logic (jarvis-os-chat-spec.md, C5): merging what the
// server sends with what the page has, the ticks, the status banner, the photo
// resize and the retry-safe ids. Checked by web/test/orbit-chat.test.js; the
// components in src/orbit/Chat.jsx only render what these return.

import { markdownPlain } from './markdown.js';

// A card's window when the server sends no `expiresAt` (an older server): the old
// 10 minutes. A server now sends how long the channel holds the request, up to 12 h.
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

// ---- pairing ----

// The pairing screen's name box starts filled (2026-11-11): with only a
// placeholder, "Get a code" stayed greyed out and looked broken. From the user
// agent: iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad.
export function defaultDeviceName({ userAgent = '', maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent);
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\bMacintosh\b/.test(ua)) return Number(maxTouchPoints) > 1 ? 'iPad' : 'Mac';
  return 'This device';
}

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
// The lead's reply to an event (its replyTo names one) answers the event, not the
// owner, as the server's unanswered() reads it.
export function tickFor(m, list) {
  if (!m || m.from !== 'jeff' || m.kind !== 'chat') return null;
  if (m.failed) return 'failed';
  if (!Number.isInteger(m.seq)) return 'sending';
  const toEvent = x => Boolean(x.replyTo) && list.some(e => e.id === x.replyTo && e.kind === 'event');
  if (list.some(x => x.from === 'jarvis' && x.kind === 'chat' && Number.isInteger(x.seq) && x.seq > m.seq && !toEvent(x))) return 'answered';
  return m.state === 'delivered' ? 'delivered' : 'queued';
}

export const TICK_MARKS = { sending: '…', failed: '!', queued: '', delivered: '✓', answered: '✓✓' };
export const TICK_WORDS = { sending: 'Sending', failed: 'Not sent', queued: 'Sent', delivered: 'Delivered', answered: 'Answered' };

// ---- refusals ----

// The tab's phase after a refusal: 401 not paired, 403 not the owner (or the Host
// check), 404 the chat is off on this server; anything else is a passing error.
export function phaseFor(err) {
  if (err?.status === 401) return 'unpaired';
  if (err?.status === 403) return 'forbidden';
  if (err?.status === 404) return 'off';
  return 'error';
}

// After the stream gave up and /api/chat/status refused too: a passing error opens
// the stream again in a few seconds; a refusal that will not change by itself
// (401, 403, 404) stops here with its phase, instead of asking every 3 s forever.
export function afterStreamRefusal(err) {
  const phase = phaseFor(err);
  return phase === 'error' ? { reopen: true, phase: null } : { reopen: false, phase };
}

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
// open cards decide "waiting on you" here, at once, both ways. Offline wins: a
// card left open while the channel is gone can't be answered through it.
export function effectiveStatus(status, permissions, now = Date.now()) {
  const open = [...(permissions?.values?.() ?? [])].some(p => permissionView(p, now)?.view === 'open');
  if (!status) return status;
  if (status.state === 'offline') return status;
  if (open) return status.state === 'waiting on you' ? status : { ...status, state: 'waiting on you' };
  if (status.state === 'waiting on you') return { ...status, state: status.channelConnected === false ? 'offline' : 'online' };
  return status;
}

// ---- permission cards ----

// A card's state as the page shows it (approvals design §5.3):
//   open      Deny, and Allow once when `canAllow` (below)
//   expired   at `expiresAt` (as long as the channel holds it, up to 12 hours after
//             it relayed it), on the page too; or ended by the server: `ended` says
//             why (`timeout`, `channel` or `crowded`; `expiredLine` words it)
//   terminal  late on arrival or a repeated id: shown, answered only at the terminal
//   closed    allowed or denied: the "sent" line (`sentLine`) and a Dismiss; also
//             `elsewhere`: the server heard Jarvis's session move on, so the request
//             was answered in another place (Claude Code's own prompt, Discord) or
//             is no longer asked. Nothing was sent from here.
// `approver` is this device's mark and `approvals` the status's `{ mode,
// denyOnlyUntil }`: Allow is offered only when the server says the request may be
// allowed, this device is an approver, and no Deny-only window is running now.
export function permissionView(p, now = Date.now(), { approver = false, approvals = null } = {}) {
  if (!p) return null;
  const expiresAt = Number.isFinite(p.expiresAt) ? p.expiresAt : (p.relayedAt ?? p.openedAt) + PERMISSION_TTL_MS;
  const state = p.state === 'open' && now >= expiresAt ? 'expired' : p.state;
  if (state === 'allowed' || state === 'denied' || state === 'elsewhere') return { ...p, view: 'closed', state, canAllow: false };
  if (state === 'late' || state === 'repeat') return { ...p, view: 'terminal', state, canAllow: false };
  if (state === 'expired') return { ...p, view: 'expired', state, canAllow: false };
  const windowOn = Number.isFinite(approvals?.denyOnlyUntil) && approvals.denyOnlyUntil > now;
  const reasons = [...(Array.isArray(p.denyOnly) ? p.denyOnly : [])];
  if (windowOn && !reasons.some(r => /auto mode blocked/.test(r))) reasons.push('auto mode blocked something in the last 15 minutes');
  if (approvals?.mode === 'deny' && !reasons.length) reasons.push('approvals are Deny only for now');
  // The server would take an Allow for this one, but not from this device: say so,
  // or the card's "Why" would be empty.
  if (p.canAllow === true && approver !== true && !reasons.length) reasons.push(NOT_APPROVER);
  const canAllow = p.canAllow === true && approver === true && approvals?.mode !== 'deny' && !windowOn && reasons.length === 0;
  return { ...p, view: 'open', state, canAllow, denyOnly: reasons };
}

// What a card shows of the preview: its fields as the server parsed them (what
// runs or changes first), or the whole text under "input" when it isn't JSON.
export function cardFields(p) {
  if (Array.isArray(p?.fields) && p.fields.length) return p.fields.filter(f => Array.isArray(f) && f.length === 2).map(([k, v]) => [String(k), String(v)]);
  return p?.inputPreview ? [['input', String(p.inputPreview)]] : [];
}

// The parts of a field the page can't vouch for, split out so the card can mark
// them: Claude Code's elision, its credential mask and unserializable value, and
// the channel's and the server's cuts, and a hidden character the server made
// visible (⟦U+202E⟧).
const MARKER = /(⋯ \d+ code points elided ⋯|\[REDACTED\]|\(value unserializable\)|⋯ \d+ code points cut by the (?:channel|Control Room) ⋯|⟦U\+[0-9A-F]{4,6}⟧)/;
export function markerSegments(text) {
  const parts = String(text ?? '').split(MARKER);
  return parts.map((t, i) => ({ text: t, marker: i % 2 === 1 })).filter(x => x.text !== '');
}
export const hasMarker = p => cardFields(p).some(([, v]) => MARKER.test(v)) || MARKER.test(String(p?.description ?? ''));

// What the server compares a verdict against (Ultron L11): the fields exactly as
// they were delivered, never as rendered.
// When the card also showed a Bash command's exact text (`exact`, from the hook's
// report), the hash covers it as a fourth item, as the server's does.
export const shownInput = p => JSON.stringify([p?.tool ?? '', p?.description ?? '', p?.inputPreview ?? '', ...(typeof p?.exact === 'string' ? [p.exact] : [])]);

// The exact command as rows the card draws with every line break and tab visible:
// one row per line, `end` true where a line break follows it, each row's text split
// at its tabs. A last row left empty by a final line break is not drawn: the mark on
// the row before it says the break is there.
export function exactRows(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  const rows = lines.map((line, i) => ({
    parts: line.split('\t').flatMap((t, j) => [...(j > 0 ? [{ tab: true }] : []), ...(t !== '' ? [{ text: t }] : [])]),
    end: i < lines.length - 1
  }));
  if (rows.length > 1 && rows[rows.length - 1].parts.length === 0) rows.pop();
  return rows;
}
export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('this page cannot check what it showed here (no secure context)');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Allow once is a two-step press: the first tap arms it for 4 seconds, and only a
// tap while armed sends.
export const ALLOW_ARM_MS = 4000;
export const allowArmed = (armedAt, now = Date.now()) => Number.isFinite(armedAt) && now - armedAt >= 0 && now - armedAt < ALLOW_ARM_MS;

// "Deny sent from iPhone at 14:02. ..." The page can't know more: Claude Code
// never says whether it used the answer.
export function sentLine(p) {
  if (p?.state === 'elsewhere') {
    const when = Number.isFinite(p?.closedAt) ? ` at ${hhmm(p.closedAt)}` : '';
    return `Jarvis moved on${when}: this was answered in Claude Code or Discord, or is no longer asked. Nothing was sent from here.`;
  }
  const word = p?.state === 'allowed' ? 'Allow' : 'Deny';
  const from = p?.answeredBy ? ` from ${p.answeredBy}` : '';
  const at = Number.isFinite(p?.answeredAt) ? ` at ${hhmm(p.answeredAt)}` : '';
  return `${word} sent${from}${at}. Claude Code uses it if the prompt was still open.`;
}

// A card's age, from seconds: "40 s ago", "12 min ago", then hours past two.
export function ageLine(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s} s ago`;
  if (s < 120 * 60) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// A span of time in words: "10 minutes", "90 minutes", "12 hours".
const spanWords = ms => {
  const min = Math.round(ms / 60e3);
  if (min < 120) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `${h} hours`;
};

// Why an expired card can't be answered here, and where to answer it.
const ELSEWHERE_HINT = 'If Jarvis is still waiting on it, answer in Claude Code or in Discord.';
export function expiredLine(p) {
  if (p?.ended === 'channel') return 'Jarvis\'s session or its channel ended, so this page can no longer answer it. If a prompt is still open, answer it in Claude Code.';
  if (p?.ended === 'crowded') return `Too many requests were waiting at once, so this page let the oldest go. ${ELSEWHERE_HINT}`;
  const from = p?.relayedAt ?? p?.openedAt;
  const span = Number.isFinite(p?.expiresAt) && Number.isFinite(from) && p.expiresAt > from ? p.expiresAt - from : PERMISSION_TTL_MS;
  return `This page could answer it for ${spanWords(span)}. ${ELSEWHERE_HINT}`;
}

// How long a closed card stays before it goes by itself: an answer sent from here for
// 10 minutes (it says what was sent), one closed elsewhere for a minute.
export const CLOSED_CARD_MS = 10 * 60e3;
export const ELSEWHERE_CARD_MS = 60e3;
export function cardGone(p, now = Date.now()) {
  if (p?.view !== 'closed') return false;
  if (p.state === 'elsewhere') return now - (p.closedAt ?? p.openedAt) >= ELSEWHERE_CARD_MS;
  return now - (p.answeredAt ?? p.openedAt) >= CLOSED_CARD_MS;
}

// Whether a request the server sent belongs on the page: one the viewer dismissed
// stays gone when a new stream replays it (a request that timed out here is replayed
// for an hour), unless it is open, which has no Dismiss.
export const keepCard = (p, dismissed) => Boolean(p?.requestId) && (p.state === 'open' || !dismissed?.has?.(p.requestId));

export const NOT_APPROVER = 'this device is not marked as one that may allow (bin/chat-pair approver, on the machine)';

// What a card that can only be denied here says first: where Allow is. In parity
// (`rules: "parity"` in the status) the page offers what the relay offers, so a
// Deny-only card is the exception and its reasons say why.
export const DENY_ONLY_LEAD = 'This page can only deny this one. To allow it, answer in Claude Code or in Discord.';

// The map of requests after a status: when the server counts no open request, a
// card the page still shows as open missed its close (answered on Discord while
// the stream was down, say) and goes. Expired and closed cards stay.
export function withStatus(map, status, now = Date.now()) {
  if (status?.openPermissions !== 0) return map;
  const stale = [...map].filter(([, p]) => permissionView(p, now)?.view === 'open').map(([id]) => id);
  if (stale.length === 0) return map;
  const next = new Map(map);
  for (const id of stale) next.delete(id);
  return next;
}

// The map of requests after an event: a new or changed request replaces its row.
export function upsertPermission(map, p) {
  if (!p?.requestId) return map;
  const next = new Map(map);
  next.set(p.requestId, p);
  return next;
}

// A verdict refused because the card changed under the tap (409 with `changed`):
// the card as the server has it now, when the answer carries this request's; else null.
export function changedCard(err, requestId) {
  const card = err?.status === 409 && err?.body?.changed === true ? err.body.request : null;
  return card && typeof card === 'object' && card.requestId === requestId ? card : null;
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

// ---- files to send: picked, pasted or dropped ----

export const MAX_FILES = 4;                    // per message, photos and PDFs together
export const FILE_MAX_BYTES = 10 * 1024 * 1024; // the server's cap
export const PDF_TYPE = 'application/pdf';
export const ACCEPT = 'image/*,application/pdf';
// A sent file is a picture to show, or a chip that downloads (a PDF, a text file).
export const isPhotoType = type => typeof type === 'string' && type.toLowerCase().startsWith('image/');
export const fileWord = type => (type === PDF_TYPE ? 'PDF' : type === 'text/plain' || type === 'text/markdown' ? 'text file' : 'file');

// ---- Shortcut keys (server/lib/shortcut-routes.mjs) ----

// How a message came, when a Shortcut sent it: the words for its small mark, or null.
// The server writes `meta.shortcut.via`; anything it doesn't name is just "Shortcut".
const VIA_WORDS = { siri: 'Siri Shortcut', share: 'share sheet' };
export function viaWords(m) {
  const sc = m?.meta?.shortcut;
  if (!sc || typeof sc !== 'object') return null;
  return Object.hasOwn(VIA_WORDS, sc.via) ? VIA_WORDS[sc.via] : 'Shortcut';
}

// One key's line in the settings sheet: when it was made and from which device's
// code (revoking that device revokes the key), its use, and when it expires unless it
// is used first (the server stops a key 30 days after its last use, and says when in
// `expiresAt`; an older server says nothing, and neither does the line).
// The server's KEY_IDLE_DAYS (server/lib/shortcut-keys.mjs), for the page's words only.
export const KEY_IDLE_DAYS = 30;
const isTime = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
export function keyLine(k, when = at => String(at)) {
  if (!k) return '';
  if (k.revokedAt) return `revoked ${when(k.revokedAt)}`;
  if (k.expired === true) return `expired${isTime(k.expiresAt) ? ` ${when(k.expiresAt)}` : ''} after ${KEY_IDLE_DAYS} days without use · make a new key and run Jarvis Setup again`;
  const uses = Number.isInteger(k.uses) ? k.uses : 0;
  const by = typeof k.madeBy === 'string' && k.madeBy ? ` from ${k.madeBy}` : '';
  const until = isTime(k.expiresAt) ? ` · expires ${when(k.expiresAt)} if unused` : '';
  return `made ${when(k.createdAt)}${by} · ${uses === 0 ? 'never used' : `last used ${when(k.lastUsedAt)} · ${uses} use${uses === 1 ? '' : 's'}`}${until}`;
}
// A key that no longer works: revoked, or expired. Its row is greyed. An expired key
// keeps its Revoke: only a revoke is on file (expiry is worked out from the clock).
export const keyGone = k => Boolean(k?.revokedAt) || k?.expired === true;
// After a code was made: the key it became, once the list holds a working key of that
// name that was not there before (`before`: the ids listed when the code was made).
export function pairedSince(before, keys, name) {
  const had = new Set(Array.isArray(before) ? before : []);
  return (Array.isArray(keys) ? keys : []).find(k => k && !keyGone(k) && k.name === name && !had.has(k.id)) ?? null;
}
// What the sheet says under a code it made: still waiting (show it), paired, or gone
// (used up by wrong tries, replaced or timed out).
export function codeState(made, data) {
  if (!made) return null;
  if (pairedSince(made.before, data?.keys, made.name)) return 'paired';
  return data?.waiting && data.waiting.name === made.name ? 'waiting' : 'gone';
}
// The keys to list: the ones that work, then the three that most recently stopped
// (revoked or expired), newest first.
const goneAt = k => (k.revokedAt ? k.revokedAt : isTime(k.expiresAt) ? k.expiresAt : 0);
export function keyRows(keys) {
  const list = Array.isArray(keys) ? keys.filter(k => k && typeof k.id === 'string') : [];
  const gone = list.filter(keyGone).sort((a, b) => goneAt(b) - goneAt(a)).slice(0, 3);
  return [...list.filter(k => !keyGone(k)), ...gone];
}

// What a file goes up as: a `photo` (resized to a JPEG first), a `pdf` (sent as
// is), or null (refused here: no text or other files from the page). A file from
// a drag can come with no type at all, so its name decides then.
export function fileKind(file) {
  if (!file) return null;
  const type = String(file.type ?? '').toLowerCase();
  const name = String(file.name ?? '');
  if (type.startsWith('image/')) return 'photo';
  if (type === PDF_TYPE) return 'pdf';
  if (type === '' && /\.pdf$/i.test(name)) return 'pdf';
  if (type === '' && /\.(heic|heif)$/i.test(name)) return 'photo';
  return null;
}

// The files a paste or a drop carries (a DataTransfer): `files` when the browser
// fills it, else the file items. An empty list means a plain text paste, which
// the box handles as ever.
export function transferFiles(dt) {
  if (!dt) return [];
  const files = [...(dt.files ?? [])];
  if (files.length > 0) return files;
  return [...(dt.items ?? [])].filter(i => i?.kind === 'file').map(i => i.getAsFile?.()).filter(Boolean);
}

// Whether a drag carries files at all (dragover can't read them yet, only the types).
export const dragHasFiles = dt => [...(dt?.types ?? [])].includes('Files');

// Which of `files` to take, given how many are already on the message (`held`,
// counting those still being prepared): photos and PDFs only, a PDF under 10 MB,
// at most four in all. `note` says what was left out, or is null.
export function intake(files, held = 0) {
  const take = [];
  let wrongType = 0, tooBig = 0, overCap = 0;
  for (const f of files ?? []) {
    const kind = fileKind(f);
    if (!kind) { wrongType++; continue; }
    if (kind === 'pdf' && f.size > FILE_MAX_BYTES) { tooBig++; continue; }
    if (held + take.length >= MAX_FILES) { overCap++; continue; }
    take.push({ file: f, kind });
  }
  const parts = [];
  if (wrongType) parts.push(`only photos and PDFs can be sent (${wrongType} left out)`);
  if (tooBig) parts.push(`a PDF must be under 10 MB (${tooBig} left out)`);
  if (overCap) parts.push(`at most ${MAX_FILES} files a message (${overCap} left out)`);
  const note = parts.length ? parts.join('; ').replace(/^./, c => c.toUpperCase()) + '.' : null;
  return { take, note };
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

// An event's notice line (server lib/events.mjs): the server's template words, as
// plain text (React escapes them; nothing here is ever HTML), and whether it was
// kept from the lead because the kill switch was on when it was made.
// `note`: why the lead never got it, when it didn't: made while events were off, or
// skipped at delivery (too old, cleared, the switch on, or a channel without events).
export function eventLine(m) {
  const text = String(m?.text ?? '').replace(/\s+/g, ' ').trim() || 'An event';
  const off = m?.state === 'off';
  const note = off ? 'Not sent to Jarvis: events were off' : m?.state === 'undelivered' ? 'Not delivered to Jarvis' : null;
  return { text, off, note };
}

// Who a quote is from, in the reply's header.
export const quoteWho = q => (!q ? 'Reply' : q.from === 'jeff' ? 'You' : q.kind === 'event' ? 'Event' : 'Jarvis');

// The message a reply quotes, by id, when the page holds it.
export const quoted = (list, id) => (id ? list.find(m => m.id === id) ?? null : null);

// A quote's one line: the first 90 characters, newlines folded, a chat message's
// Markdown markers dropped (an event's words are plain text and stay as they are).
export const quoteLine = m => {
  if (!m) return 'an earlier message';
  const raw = String(m.text ?? '');
  const text = (m.kind === 'event' ? raw : markdownPlain(raw)).replace(/\s+/g, ' ').trim();
  if (text) return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  return m.attachments?.length ? `Photo${m.attachments.length > 1 ? 's' : ''}` : 'an earlier message';
};
