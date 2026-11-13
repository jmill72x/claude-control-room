// The Shortcut routes (docs/design/2026-11-12-jarvis-os-shortcuts.md): how an iPhone
// Shortcut sends into the chat. Two sides, one router, all under `/api/shortcut/`:
//
// - **The Shortcut's side** takes no cookie and refuses a browser outright (any
//   `Origin` or `Sec-Fetch-Site` header: a Shortcut sends neither, a page always
//   does). `pair` trades the one-time code for the key; `send` and `event` take the
//   key (`Authorization: Bearer`, lib/shortcut-keys.mjs).
// - **The page's side** takes a paired device's cookie, like the chat: make the code
//   for a new key, list the keys, revoke one.
//
// Every route also needs the owner's tailnet login from the proxy, as the chat does.
//
// What a key can do, and nothing else:
// - `send`: one chat message from the owner, appended to the same store by the same
//   call the page's route makes (`from: jeff`, `kind: chat`, `state: queued`), so the
//   channel gets it down the same stream. Its `device` is the key's name with
//   "(Shortcut…)", which the channel shows the lead. It carries no reply target.
//   **What the owner typed or dictated (`text`) is the message; what he shared is
//   outside content:** a single short http(s) link to a public host name
//   goes in the text as `URL` rebuilt it, under the fixed line "Shared link, outside
//   content:"; any other shared text (a long link, one to an address or to this machine
//   included) becomes a `text/plain` attachment, which the channel already marks as
//   data (`attachments_are_data`), never as his words. **A shared photo or file** comes
//   as a form (`multipart/form-data`, what a Shortcut's "Get Contents of URL" sends for
//   a Form body with a File field; a JSON body can't carry one): up to FILES_MAX `file`
//   parts beside the same text fields, each kept as an attachment by the chat's own
//   store, with its types and its 10 MB cap. The bytes decide what a file is; one
//   whose name or declared type says another kind is refused, a HEIC photo is made a
//   JPEG first (lib/heic-convert.mjs) or refused in words that say what to do, and a
//   file's name is cleaned and given the ending of what it is. The send route alone
//   takes a form: it still needs the key, which no page's form can carry, and still
//   refuses any request with an `Origin` or `Sec-Fetch-Site` header. No route takes
//   `application/x-www-form-urlencoded` (a Shortcut never sends it, and Node's reader
//   for it is slow enough on a large body to stop the server: Ultron's M1).
// - `event`: a presence report by name (`arrived-home`). No text travels: the words
//   are a template's (lib/events.mjs), it reaches the lead as an event (data, from
//   `system`, never the owner), and the event caps and kill switch apply.
//
// Limits per key, in memory: 20 messages in 10 minutes and 100 a day; the same message
// again within 15 s is answered as the first (a retry never doubles it); the same
// presence report within 10 minutes is a duplicate; 6 reports a day. Each is counted
// in the same step as its check, before anything awaits, so requests in flight
// together can't all pass; a send that then fails gives its count back. Files count
// too: FILE_BYTES_PER_DAY of them per key a day (the larger of what came and what is
// kept, for each file), counted in the same step; a form's body is FORM_BODY_MAX at
// most and must arrive within FORM_TIMEOUT_MS, and a key has UPLOADS_AT_ONCE forms in
// flight at most, which bounds the memory a key can hold. A HEIC photo to convert is
// counted too (CONVERSIONS_PER_WINDOW, CONVERSIONS_PER_DAY), and that count is never
// given back, so photos that fail to convert can't be sent without end. The kill
// switch and the key are looked at again after the body is read, just before the
// message is made: a key revoked while its share was on the way makes nothing. A key over a
// limit, and a run of refused pairing tries, are reported (rate-limited), not logged
// line by line. A key that made no message and no report for 30 days has expired
// (lib/shortcut-keys.mjs): it is refused like one that is not paired, in words that say
// so, and reported once a day while it keeps being tried. Only a message or a report
// that was made counts as a use (`keys.used`): a refused request, or a repeat answered
// as the first, never keeps a key alive. Every answer has
// a `say` line the Shortcut can show or speak as it is. Nothing here logs or echoes a
// message's text. A kill file (`~/.local/state/jarvis-os/shortcuts-off`) refuses every
// Shortcut-side route and new codes at once; listing and revoking still work.
//
// **Every request is logged in one line of fixed words and numbers** (`requestLine`):
// the route, the status, a refusal's own fixed reason, what kind of body the request
// said it had and how long, how many bytes of it were read, and for a form how many
// parts of each kind it held and what each file part's first bytes are, with its size.
// Never a name, a text, a key or a byte of the body. **A refusal is answered only when
// the request's body is in** (`drain`): an answer written while a phone is still
// uploading reaches it as "The network connection was lost", never as the answer.
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { json, readBody, guardWrite, guardDelete, HttpError } from '../routes.mjs';
import { isClientId, sniffType, MAX_PAGE_TEXT, ATTACHMENT_MAX_BYTES } from './chat-store.mjs';
import { formBoundary, parseMultipart, mediaType, MultipartError } from './multipart.mjs';
import { PRESENCE_EVENTS } from './events.mjs';
import { proxyAddress, KEY_IDLE_DAYS } from './shortcut-keys.mjs';
import { oneLine } from './chat-events.mjs';
import { isHiddenCodePoint } from './hidden-chars.mjs';
import { REASONS } from './heic-convert.mjs';

const MIN = 60e3, DAY = 24 * 3600e3;
export const SHARED_MAX = 100000;
// A shared link longer than this is attached like other shared text, never inline.
export const LINK_INLINE_MAX = 300;
// 100,000 characters of shared text as JSON, with room for escapes.
export const SEND_BODY_MAX = 768 * 1024;
export const SMALL_BODY_MAX = 2048;
export const SENDS_PER_WINDOW = 20;
export const SEND_WINDOW_MS = 10 * MIN;
export const SENDS_PER_DAY = 100;
export const DUPLICATE_MS = 15e3;
export const EVENT_DEBOUNCE_MS = 10 * MIN;
// Few on purpose: every event counts toward the 30 a day all sources share
// (lib/events.mjs), and a job's failure must never be the one held back.
export const EVENTS_PER_DAY = 6;
// Wrong or missing keys in 10 minutes before it is reported (once per window).
export const REFUSALS_REPORTED_AT = 5;
export const CLIENT_ID_MAX = 60;
// How a send says where it came from, and what the message's device then reads.
export const VIAS = Object.freeze({ share: ' (Shortcut, share)', siri: ' (Shortcut, Siri)' });
const VIA_NONE = ' (Shortcut)';
const SEND_FIELDS = new Set(['text', 'shared', 'via', 'clientId']);
// ---- shared files (a form) ----
// As many as a page's message may carry (lib/chat-routes.mjs).
export const FILES_MAX = 4;
// A form's whole body: the files together, their part headers and the note.
export const FORM_BODY_MAX = 25 * 1024 * 1024;
// A body over FORM_BODY_MAX is still read to its end, and dropped, up to this: the
// refusal then reaches the Shortcut as an answer it can show. Past it the connection
// is cut, and the phone shows its own error.
export const FORM_DRAIN_MAX = 64 * 1024 * 1024;
// A key's files in a day, as uploaded.
export const FILE_BYTES_PER_DAY = 200 * 1024 * 1024;
// Forms being read or kept at once, per key.
export const UPLOADS_AT_ONCE = 2;
// A form's body must have arrived within this, whatever the server's own limit is.
export const FORM_TIMEOUT_MS = 120e3;
// HEIC photos a key may have converted. Counted when the share is taken and never
// given back, also when the conversion fails.
export const CONVERSIONS_PER_WINDOW = 30;
export const CONVERSIONS_PER_DAY = 200;
export const FILE_NAME_MAX = 60;
// A form's text fields in bytes, looked at before a field is decoded: four times each
// one's limit in characters, which is the most UTF-8 can need for it.
export const FIELD_BYTES_MAX = new Map([['text', 4 * MAX_PAGE_TEXT], ['shared', 4 * SHARED_MAX], ['via', 4 * 16], ['clientId', 4 * CLIENT_ID_MAX]]);
const MULTIPART_TYPE = 'multipart/form-data';
// What a file is, by the ending of its name and by the type its part declares. Maps,
// so a name like "constructor" finds nothing.
const EXT_OF = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/heic', 'heic'], ['application/pdf', 'pdf'], ['text/plain', 'txt'], ['text/markdown', 'md']]);
const KIND_BY_EXT = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['heic', 'image/heic'], ['heif', 'image/heic'], ['pdf', 'application/pdf'], ['txt', 'text/plain'], ['text', 'text/plain'], ['md', 'text/markdown'], ['markdown', 'text/markdown']]);
const KIND_BY_TYPE = new Map([['image/png', 'image/png'], ['image/jpeg', 'image/jpeg'], ['image/jpg', 'image/jpeg'], ['image/webp', 'image/webp'], ['image/heic', 'image/heic'], ['image/heif', 'image/heic'], ['application/pdf', 'application/pdf'], ['text/plain', 'text/plain'], ['text/markdown', 'text/markdown'], ['text/x-markdown', 'text/markdown']]);
// A declared type that says nothing: the name's ending is then what the file claims.
const NO_CLAIM = new Set(['', 'application/octet-stream']);
const family = kind => (kind.startsWith('image/') ? 'image' : kind.startsWith('text/') ? 'text' : 'pdf');
const BASE_NAME = Object.freeze({ image: 'photo', pdf: 'file', text: 'shared' });
// What the Shortcut shows for a file that is refused.
export const FILE_SAY = Object.freeze({
  takes: 'Jarvis OS takes photos (PNG, JPEG, WebP, HEIC), PDFs and text or Markdown files. It can\'t take that one.',
  takesNoHeic: 'Jarvis OS takes photos (PNG, JPEG, WebP), PDFs and text or Markdown files. It can\'t take that one.',
  spoofed: 'Jarvis OS refused that file: it is not what its name or type says it is.',
  text: 'Jarvis OS could not read that text file: it must be plain UTF-8 text.',
  empty: 'That file is empty, so nothing was sent.',
  noFile: 'No file reached Jarvis OS, so nothing was sent. In the Shortcut, check that the form\'s file field holds what you shared.',
  fileTooBig: 'Too big for Jarvis OS: a file can be 10 MB at most.',
  tooBig: 'Too big for Jarvis OS: one share can be 25 MB at most, and each file 10 MB.',
  tooMany: `Too many files: Jarvis OS takes ${FILES_MAX} in one share.`,
  unread: 'Jarvis OS could not read that share.',
  busy: 'Jarvis OS is still taking an earlier share from this Shortcut. Try again in a moment.',
  budget: 'Too many files from this Shortcut today. Use the Jarvis OS app for now.',
  heicOff: 'Jarvis OS does not take HEIC photos. In the share sheet tap Options, choose Most Compatible, and share again.',
  heicFailed: 'Jarvis OS could not convert that HEIC photo. In the share sheet tap Options, choose Most Compatible, and share again.',
  conversions: 'Too many HEIC photos from this Shortcut for now. In the share sheet tap Options, choose Most Compatible, and share again.',
  slow: 'That share took too long to reach Jarvis OS. Try again on a better connection.',
  kept: 'Jarvis OS could not keep that file.'
});
const SHORTCUT_SIDE = new Set(['/api/shortcut/pair', '/api/shortcut/send', '/api/shortcut/event']);
const SHARED_NAME = 'shared-text.txt';
export const SHARED_WORDS = 'Shared from the share sheet: the text is attached.';
// The message's text when he shared files and wrote no note: fixed words and a count,
// never a file's name.
export const attachedWords = n => (n === 1 ? 'Shared from the share sheet: a file is attached.' : `Shared from the share sheet: ${n} files are attached.`);
// The fixed line over a shared link in a message's text: the link is not his words.
export const SHARED_LINK_WORDS = 'Shared link, outside content:';
const NO_STORE = { 'Cache-Control': 'no-store' };
// What the Setup Shortcut shows when its code is refused.
const PAIR_SAY = Object.freeze({
  400: 'Wrong code. Check the code in Jarvis OS and run Setup again.',
  404: 'No code is waiting. In Jarvis OS open Chat, the dots, Shortcut keys, and make a new one.',
  409: 'Jarvis OS has too many Shortcut keys. Revoke one and run Setup again.',
  429: 'Too many wrong codes. Make a new code in Jarvis OS.'
});
const NUL = String.fromCharCode(0);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A refusal the Shortcut can show or speak: `say` rides beside `error`.
class Refusal extends HttpError {
  constructor(status, message, say) { super(status, message); this.say = say; }
}

// What config says: on only with `chat.shortcuts: true` (the chat itself must be on;
// server.mjs checks that). Anything else but absent or false is a problem, and off.
// `chat.shortcutHeic` says what happens to a shared HEIC photo: "refuse" (the default:
// the Shortcut is told to share it as Most Compatible; the phone's own Convert Image
// step is how a photo is meant to arrive, as a JPEG) or "convert" (made a JPEG on this
// machine, lib/heic-convert.mjs, which runs the system's image decoder on bytes from
// outside with no sandbox, so only config can turn it on). Anything else is a problem,
// and refuses.
export const HEIC_MODES = Object.freeze(['convert', 'refuse']);
export function readShortcutsConfig(config) {
  const raw = config?.chat?.shortcuts;
  const problems = [];
  const mode = config?.chat?.shortcutHeic;
  let heic = 'refuse';
  if (mode !== undefined && mode !== null) {
    if (typeof mode === 'string' && HEIC_MODES.includes(mode)) heic = mode;
    else problems.push('chat.shortcutHeic must be "convert" or "refuse"; HEIC photos are refused');
  }
  if (raw === undefined || raw === null || raw === false) return { on: false, heic, problems };
  if (raw === true) return { on: true, heic, problems };
  return { on: false, heic, problems: ['chat.shortcuts must be true or false; Shortcut keys stay off', ...problems] };
}

// A shared value that is one short http(s) link to a public host name and nothing
// else, as `URL` rebuilt it; else null, and the caller attaches it as text like any
// other shared content (Ultron's M3). Short: at most LINK_INLINE_MAX characters as
// rebuilt (percent-escapes counted), so a link can't carry a paragraph. Public: a DNS name with a dot whose last label is
// letters (so no IPv4 or IPv6 literal, in any spelling `URL` folds to one) and is not a
// name for this machine or a private network. No white space, no credentials.
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|invalid|onion)$/;
export function publicHostName(hostname) {
  const h = typeof hostname === 'string' ? hostname.toLowerCase().replace(/\.$/, '') : '';
  if (h === '' || h.length > 253) return false;
  // Plain labels only, which a bracketed IPv6 literal never is.
  const labels = h.split('.');
  if (labels.length < 2 || labels.some(l => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  // A lettered last label, which no IPv4 address has (`URL` folds every spelling of one,
  // hex and single-number forms too, to four numbers).
  const tld = labels.at(-1);
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(tld)) return false;
  return !PRIVATE_SUFFIX.test(h);
}
export function sharedLink(shared) {
  const s = typeof shared === 'string' ? shared.trim() : '';
  if (s === '' || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!publicHostName(u.hostname)) return null;
  return u.href.length <= LINK_INLINE_MAX ? u.href : null;
}

// What a send's body must be: `{ text?, shared?, via?, clientId? }` and nothing else,
// with something to say in `text` or `shared` (or `files` of them beside it, in a form).
export function checkSend(body, { files = 0 } = {}) {
  if (!isObject(body)) return { ok: false, error: 'the body must be an object' };
  for (const k of Object.keys(body)) if (!SEND_FIELDS.has(k)) return { ok: false, error: 'the body may hold only text, shared, via and clientId' };
  const text = body.text ?? '';
  const shared = body.shared ?? '';
  if (typeof text !== 'string' || text.length > MAX_PAGE_TEXT) return { ok: false, error: `text must be a string of at most ${MAX_PAGE_TEXT} characters` };
  if (typeof shared !== 'string' || shared.length > SHARED_MAX) return { ok: false, error: `shared must be a string of at most ${SHARED_MAX} characters` };
  const via = body.via ?? null;
  if (via !== null && (typeof via !== 'string' || !Object.hasOwn(VIAS, via))) return { ok: false, error: `via must be one of ${Object.keys(VIAS).join(', ')}` };
  const clientId = body.clientId ?? null;
  if (clientId !== null && (!isClientId(clientId) || clientId.length > CLIENT_ID_MAX)) return { ok: false, error: `clientId must be an id of at most ${CLIENT_ID_MAX} characters` };
  if (text.trim() === '' && shared.trim() === '' && files === 0) return { ok: false, error: 'a message needs text or something shared' };
  return { ok: true, text: text.trim(), shared: shared.trim(), via, clientId };
}

// A file name's last part and its ending: no folders, and an ending only when it looks
// like one (letters and digits, 8 at most).
export function splitFileName(filename) {
  const raw = typeof filename === 'string' ? filename.normalize('NFC') : '';
  const leaf = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  const dot = leaf.lastIndexOf('.');
  const ext = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,8}$/.test(ext) ? { base: leaf.slice(0, dot), ext } : { base: leaf, ext: '' };
}

// The name a shared file is kept under. A file's name is outside text that the lead
// and the page both see. A text file gets a fixed name, `shared.txt` or `shared.md`:
// the lead reads it as words, and its own name would be more of someone else's words
// beside them. A photo's or a PDF's name loses every hidden code point first
// (lib/hidden-chars.mjs: controls, direction and zero-width characters, half a
// surrogate pair, and what draws as nothing, the Hangul fillers among them, which are
// letters to Unicode); then only letters, digits, spaces and `. _ ( ) -` stay,
// FILE_NAME_MAX at most, and the ending is the one for what the file is, never the one
// it came with.
export function cleanFileName(filename, kind) {
  if (family(kind) === 'text') return `${BASE_NAME.text}.${EXT_OF.get(kind)}`;
  const seen = Array.from(splitFileName(filename).base).filter(ch => !isHiddenCodePoint(ch.codePointAt(0))).join('');
  const kept = Array.from(seen.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/_{2,}/g, '_')).slice(0, FILE_NAME_MAX).join('').replace(/^[ ._]+|[ ._]+$/g, '');
  return `${kept || BASE_NAME[family(kind)]}.${EXT_OF.get(kind)}`;
}

// What a shared file is: `{ ok: true, kind }`, or the refusal. **The bytes decide**
// (the chat store's `sniffType`); the name and the declared type only say what the
// file claims to be, and a claim of another family (a photo, a PDF, text) than the
// bytes is refused as dressed up. Text has no first bytes to go by, so a file is text
// only when it claims to be, is valid UTF-8 and holds no NUL. A declared type outside
// the list is refused whatever the bytes are.
export function classifyFile({ filename = null, type = null, data }, { heic = true } = {}) {
  const no = (status, error, say) => ({ ok: false, status, error, say });
  if (!Buffer.isBuffer(data) || data.length === 0) return no(400, 'a shared file is empty', FILE_SAY.empty);
  if (data.length > ATTACHMENT_MAX_BYTES) return no(413, 'a shared file is over 10 MB', FILE_SAY.fileTooBig);
  const declared = typeof type === 'string' ? type : '';
  const { ext } = splitFileName(filename);
  const wrong = no(415, 'a shared file is not a png, jpeg, webp, heic, pdf, txt or md', heic ? FILE_SAY.takes : FILE_SAY.takesNoHeic);
  const spoofed = no(415, 'a shared file is not what its name or type says', FILE_SAY.spoofed);
  let claim;
  if (KIND_BY_TYPE.has(declared)) claim = KIND_BY_TYPE.get(declared);
  else if (NO_CLAIM.has(declared)) claim = KIND_BY_EXT.get(ext) ?? null;
  else return wrong;
  const sniffed = sniffType(data);
  let kind;
  if (sniffed) {
    if (claim && family(claim) !== family(sniffed)) return spoofed;
    kind = sniffed;
  } else if (!claim) {
    return wrong;
  } else if (family(claim) !== 'text') {
    return spoofed;
  } else {
    if (data.includes(0) || !isUtf8(data)) return no(415, 'a shared text file is not UTF-8 text', FILE_SAY.text);
    kind = claim === 'text/markdown' || KIND_BY_EXT.get(ext) === 'text/markdown' ? 'text/markdown' : 'text/plain';
  }
  if (kind === 'image/heic' && !heic) return no(415, 'HEIC photos are not taken here', FILE_SAY.heicOff);
  return { ok: true, kind };
}

// A form's parts as a send: the same four text fields, and `file` parts. An empty
// field is one the Shortcut left empty: it counts as absent. **A form is how a file is
// sent, so one with no file in it is refused,** in words that say so: a Shortcut whose
// file field is blank would send its note alone, and "Sent" would be wrong, since what
// was shared did not come. Words alone go as JSON. Answers what `checkSend` answers,
// with `files` (each `{ filename, data, kind }`), or the refusal with its own `status`
// and `say`.
export function checkSendForm(parts, { heic = true } = {}) {
  const fields = {};
  const files = [];
  let blank = false;
  for (const p of parts) {
    if (p.name === 'file') {
      if (p.data.length === 0 && !p.filename) { blank = true; continue; }
      if (files.length >= FILES_MAX) return { ok: false, error: `a share holds at most ${FILES_MAX} files`, say: FILE_SAY.tooMany };
      const c = classifyFile(p, { heic });
      if (!c.ok) return c;
      files.push({ filename: p.filename, data: p.data, kind: c.kind });
      continue;
    }
    if (!SEND_FIELDS.has(p.name) || p.filename !== null) return { ok: false, error: 'the form may hold only text, shared, via and clientId, and file parts' };
    if (Object.hasOwn(fields, p.name)) return { ok: false, error: `the form holds ${p.name} twice` };
    // Too many bytes to be within its limit in characters: refused before it is decoded.
    if (p.data.length > FIELD_BYTES_MAX.get(p.name)) return { ok: false, error: `${p.name} is too long` };
    if (!isUtf8(p.data)) return { ok: false, error: `${p.name} must be UTF-8 text` };
    fields[p.name] = p.data.toString('utf8');
  }
  if (files.length === 0) return { ok: false, error: blank ? 'the form\'s file part is empty' : 'the form holds no file part', say: FILE_SAY.noFile };
  const checked = checkSend(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '')), { files: files.length });
  return checked.ok ? { ...checked, files } : checked;
}

// ---- one log line per request ----
// What a request's log line may say of its Content-Type: one of these, or "other". The
// header is outside text, so it is looked up, never printed.
const LOGGED_TYPES = new Set([MULTIPART_TYPE, 'application/json', 'application/x-www-form-urlencoded', 'application/octet-stream', 'multipart/mixed', 'multipart/related',
  'text/plain', 'text/markdown', 'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif', 'image/tiff', 'video/quicktime', 'video/mp4']);
const LOGGED_METHODS = new Set(['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']);
const routeName = path => (SHORTCUT_SIDE.has(path) ? path.slice('/api/shortcut/'.length) : path === '/api/shortcut/keys' ? 'keys' : /^\/api\/shortcut\/keys\/[a-f0-9]{16}$/.test(path) ? 'key' : 'other');
// What a form held, for the line: how many parts are files (a part named `file`, or
// one with a file name) and how many are text fields, and for each file part what its
// first bytes say it is ("png", "jpg", "webp", "heic", "pdf", or "unknown": text has
// no first bytes to go by) with its size. Counts and fixed words only.
export function partsSeen(parts) {
  const files = parts.filter(p => p.name === 'file' || p.filename !== null);
  return { files: files.map(p => ({ kind: EXT_OF.get(sniffType(p.data)) ?? 'unknown', bytes: p.data.length })), fields: parts.length - files.length };
}
// The line itself. `seen` is what the route learnt of the body: `read` (bytes), `form`
// (whether it was taken as a form) and `parts` (`partsSeen`, once a form was parsed).
// `reason` must be fixed words: a refusal's own message, which never holds a name, a
// text or a key (the handler passes nothing else).
export function requestLine({ method, path, headers = {}, status, reason = 'ok', seen = {} }) {
  const type = mediaType(headers['content-type']);
  const length = headers['content-length'];
  const yes = v => (v ? 'yes' : 'no');
  const parts = seen.parts
    ? ` parts=${seen.parts.files.length} file, ${seen.parts.fields} text${seen.parts.files.length > 0 ? ` files=${seen.parts.files.map(f => `${f.kind}:${f.bytes}`).join(',')}` : ''}`
    : seen.form ? ' parts=unread' : '';
  return `shortcut: request ${LOGGED_METHODS.has(method) ? method : 'OTHER'} ${routeName(path)} ${status} (${reason})`
    + ` type=${type === '' ? 'none' : LOGGED_TYPES.has(type) ? type : 'other'} length=${length === undefined ? 'none' : /^\d{1,15}$/.test(length) ? length : 'odd'}`
    + ` chunked=${yes(/chunked/i.test(String(headers['transfer-encoding'] ?? '')))} expect=${yes(headers.expect !== undefined)} form=${yes(seen.form)} read=${seen.read ?? 0}${parts}`;
}
// The request with its bytes counted into `seen.read` as they are read, once.
function counted(req, seen) {
  if (!seen.counting) {
    seen.counting = true;
    req.on('data', c => { seen.read += c.length; });
  }
  return req;
}
// Before a refusal is answered: the rest of the request's body is read and dropped,
// so the answer goes out when the phone has finished sending. A phone that gets an
// answer while it is still uploading shows "The network connection was lost" and not
// the answer's words (the proxy in front, or the phone's own HTTP, drops the rest).
// Up to `limit` bytes in all and `timeoutMs`, like a form's own read. Resolves to
// whether the whole body is in: when it is not (too long, too slow, or the phone hung
// up), the answer goes as it is, and the connection goes with it.
const drain = (req, seen, limit, timeoutMs) => new Promise(resolve => {
  if (req.readableEnded) return resolve(true);
  // Gone, or already cut off past `limit` (by what it said, or as it came): no waiting.
  if (req.destroyed || Number(req.headers?.['content-length']) > limit || seen.read > limit) return resolve(false);
  let settled = false;
  const over = whole => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!whole) req.pause?.();
    resolve(whole);
  };
  // Like a form's own timer: it never keeps the process alive.
  const timer = setTimeout(() => over(false), timeoutMs);
  timer.unref();
  counted(req, seen).on('data', () => { if (seen.read > limit) over(false); });
  req.on('end', () => over(true));
  for (const gone of ['error', 'close']) req.on(gone, () => over(false));
  req.resume();
});

// A form's body as bytes. One over `limit` is still read to its end and dropped, so
// the refusal is an answer the Shortcut can show; one over `drainLimit` (by its own
// count, or as it arrives) is cut off, and `Connection: close` goes with the answer.
// The body has `timeoutMs` to arrive, by a timer of this read's own (the server's
// limit for a whole request is longer, and not this code's to rely on); a body still
// on its way then is stopped, and the connection goes with the answer. A request that
// closes or fails before its end is over too, so nothing waits on it for good.
// (Settling twice is harmless: a promise keeps its first answer.) `seen.read` counts
// the bytes as they come, for the request's log line.
const readForm = (req, limit, drainLimit, timeoutMs, seen = { read: 0 }) => new Promise((resolve, reject) => {
  const tooBig = () => new Refusal(413, `a share is at most ${Math.round(limit / 1024 / 1024)} MB`, FILE_SAY.tooBig);
  // The timer never keeps the process alive, and ends with the read however it ends.
  const timer = setTimeout(() => { req.pause?.(); reject(new Refusal(408, `a share must arrive within ${Math.round(timeoutMs / 1000)} s`, FILE_SAY.slow)); }, timeoutMs);
  timer.unref();
  const over = (settle, value) => { clearTimeout(timer); settle(value); };
  const cut = () => { req.pause?.(); over(reject, tooBig()); };
  if (Number(req.headers?.['content-length']) > drainLimit) return cut();
  // `chunks` is null from the first byte over `limit`: nothing of such a body is kept.
  let chunks = [];
  counted(req, seen).on('data', c => {
    if (seen.read > drainLimit) return cut();
    if (seen.read > limit) chunks = null; else chunks.push(c);
  });
  req.on('end', () => (chunks === null ? over(reject, tooBig()) : over(resolve, Buffer.concat(chunks))));
  // The phone hung up half-way, or the server ended the request: an error when there
  // is one, and a close with no end before it.
  for (const gone of ['error', 'close']) req.on(gone, () => over(reject, new HttpError(400, 'the request ended early')));
});

// `convertHeic` makes a HEIC photo's bytes a JPEG's (lib/heic-convert.mjs); without
// one (the default), a shared HEIC photo is refused in words that say to share it as
// Most Compatible.
// `fileBytesPerDay` is FILE_BYTES_PER_DAY but in a test, which can't send 200 MB, and
// `formTimeoutMs` FORM_TIMEOUT_MS but in a test, which can't wait two minutes.
export function createShortcutRoutes({
  keys, devices, store, events = null, socket = null, login = null,
  now = () => Date.now(), log: logLine = console.log, onEvent = () => {}, killed = () => false, convertHeic = null, fileBytesPerDay = FILE_BYTES_PER_DAY, formTimeoutMs = FORM_TIMEOUT_MS
}) {
  // A key's name is cleaned when it pairs; one read back from the file was not.
  const log = line => logLine(oneLine(line));
  const owner = typeof login === 'string' && login.trim() ? login.trim().toLowerCase() : null;
  const sends = new Map();     // key id -> times of its sends in the last day
  const fileBytes = new Map(); // key id -> [{ at, bytes }]: its files in the last day
  const conversions = new Map(); // key id -> times of the HEIC photos it had converted in the last day
  const uploading = new Map(); // key id -> forms of its being read or kept right now
  const reports = new Map();   // key id -> times of its presence reports in the last day
  const lastSend = new Map();  // key id -> { hash, at, done: resolves to { id, seq } or null }
  const lastReport = new Map(); // `${key id}:${event}` -> when
  const overAt = new Map();    // `${key id}:${limit}` -> when it was last reported
  const expiredAt = new Map(); // key id -> when its use after expiry was last reported
  let refusals = { start: 0, n: 0 };
  let pairRefusals = { start: 0, n: 0 };

  function requireLogin(req) {
    if (owner === null) return;
    const seen = req.headers?.['tailscale-user-login'];
    if (typeof seen !== 'string' || seen.trim().toLowerCase() !== owner) throw new Refusal(403, 'the request did not come as the owner through the tailnet', 'Jarvis OS refused this: it did not come through the tailnet as the owner.');
  }
  function requireDevice(req) {
    requireLogin(req);
    const device = devices?.authenticate(req.headers?.cookie);
    if (!device) throw new HttpError(401, 'this device is not paired');
    return device;
  }
  const switchedOff = () => new Refusal(503, 'Shortcut keys are switched off on the server', 'Shortcuts are switched off in Jarvis OS for now.');
  const notPaired = () => new Refusal(401, 'this Shortcut is not paired', 'This Shortcut is not paired with Jarvis OS. Run the Jarvis Setup Shortcut.');
  // The Shortcut's side: never a browser, JSON only, the owner's login, not switched off.
  // `forms` (the send route alone): a `multipart/form-data` body is taken too, which is
  // how a Shortcut sends a file. A form needs no preflight from a page, so the JSON rule
  // is not what keeps a page out here: the line above it is (any Origin or
  // Sec-Fetch-Site header), and the key in `Authorization`, which no page's form can
  // set. Answers whether the body is a form.
  function requireShortcutCaller(req, { forms = false } = {}) {
    if (req.headers?.origin !== undefined || req.headers?.['sec-fetch-site'] !== undefined) throw new Refusal(403, 'this route is for a Shortcut, never a page', 'Jarvis OS refused this: the route is for a Shortcut.');
    const form = forms && mediaType(req.headers?.['content-type']) === MULTIPART_TYPE;
    if (!form) guardWrite(req);
    requireLogin(req);
    if (killed()) throw switchedOff();
    return form;
  }
  // The same two looks again, for a send that has waited since: reading a body takes
  // time (a form has two minutes) and so does a conversion, and the switch may have
  // been thrown, or the key revoked or run out, meanwhile. Made as soon as a form's body
  // is in, before each conversion, and last just before the message. Not counted with
  // the wrong keys: the request carried a key that worked.
  function stillAllowed(key) {
    if (killed()) throw switchedOff();
    if (!keys.list().some(k => k.id === key.id && !k.revokedAt && !k.expired)) throw notPaired();
  }
  // The key behind a request, or a 401. Wrong keys are counted, and the fifth in 10
  // minutes is reported once. An expired key is a 401 of its own: the answer says to
  // pair again, and it is reported once a day per key however often it is tried (an
  // automation shows nothing on the phone, so the report is how its owner hears).
  function requireKey(req) {
    const { key, expired } = keys.check(req.headers?.authorization, { addr: proxyAddress(req.headers) });
    if (key) return key;
    const at = now();
    if (expired) {
      const last = expiredAt.get(expired.id);
      if (last === undefined || at - last >= DAY) {
        expiredAt.set(expired.id, at);
        onEvent({ kind: 'shortcut-expired', key: { id: expired.id, name: expired.name }, days: KEY_IDLE_DAYS });
      }
      throw new Refusal(401, `this Shortcut key expired after ${KEY_IDLE_DAYS} days without use`, `This Shortcut is not paired with Jarvis OS any more: its key expired after ${KEY_IDLE_DAYS} days without use. Make a new code in Jarvis OS and run the Jarvis Setup Shortcut.`);
    }
    if (at - refusals.start >= SEND_WINDOW_MS) refusals = { start: at, n: 0 };
    refusals.n++;
    if (refusals.n === REFUSALS_REPORTED_AT) onEvent({ kind: 'shortcut-refused', count: refusals.n });
    throw notPaired();
  }
  // The times a key acted in the last day: one array per key, pruned in place, so
  // every request in flight sees, and adds to, the same one (Ultron's M2: a new array
  // each call let requests in flight together count on copies).
  const recent = (map, id, at) => {
    let times = map.get(id);
    if (!times) { times = []; map.set(id, times); }
    let old = 0;
    while (old < times.length && at - times[old] >= DAY) old++;
    if (old > 0) times.splice(0, old);
    return times;
  };
  const takeBack = (times, at) => { const i = times.lastIndexOf(at); if (i >= 0) times.splice(i, 1); };
  // The files a key sent in the last day: one list per key, pruned in place, like `recent`.
  const spentBytes = (id, at) => {
    let list = fileBytes.get(id);
    if (!list) { list = []; fileBytes.set(id, list); }
    let old = 0;
    while (old < list.length && at - list[old].at >= DAY) old++;
    if (old > 0) list.splice(0, old);
    return list;
  };
  const online = () => socket?.status?.().channelConnected === true;
  // A key over a limit is reported once per key and limit in 10 minutes, however often
  // it is refused: the event is the log line, and the alert kind is rate-limited too.
  function overLimit(key, what, at) {
    const mark = `${key.id}:${what}`;
    const last = overAt.get(mark);
    if (last !== undefined && at - last < SEND_WINDOW_MS) return;
    overAt.set(mark, at);
    onEvent({ kind: 'shortcut-over-limit', key: { id: key.id, name: key.name }, what });
  }
  // A refused pairing try (a wrong code, or none waiting): the first in 10 minutes is
  // logged, the fifth reported, the rest only counted.
  function pairRefused(status) {
    const at = now();
    if (at - pairRefusals.start >= SEND_WINDOW_MS) pairRefusals = { start: at, n: 0 };
    pairRefusals.n++;
    if (pairRefusals.n === 1) log(`shortcut: a pairing try was refused (${status}); more in the next 10 minutes are counted, not logged`);
    if (pairRefusals.n === REFUSALS_REPORTED_AT) onEvent({ kind: 'shortcut-pair-refused', count: pairRefusals.n });
  }

  async function send(req, res, seen) {
    const form = requireShortcutCaller(req, { forms: true });
    seen.form = form;
    const key = requireKey(req);
    if (!form) {
      const checked = checkSend(await readBody(counted(req, seen), SEND_BODY_MAX));
      if (!checked.ok) throw new Refusal(400, checked.error, 'Jarvis OS could not read that message.');
      return json(res, 200, await deliver(key, { ...checked, files: [] }), NO_STORE);
    }
    // A form, which may carry files: a key has UPLOADS_AT_ONCE of them in flight at
    // most, from before the body is read until the message is made or refused. That
    // bounds what a key can hold in memory, and how many conversions it has running.
    // Counted in the same step as its check; nothing awaits between.
    const inFlight = uploading.get(key.id) ?? 0;
    if (inFlight >= UPLOADS_AT_ONCE) {
      overLimit(key, 'uploads', now());
      throw new Refusal(429, `a Shortcut key has at most ${UPLOADS_AT_ONCE} shares in flight at once`, FILE_SAY.busy);
    }
    uploading.set(key.id, inFlight + 1);
    let answer;
    try {
      const raw = await readForm(req, FORM_BODY_MAX, FORM_DRAIN_MAX, formTimeoutMs, seen);
      // Before anything is made of the body: it may have been two minutes.
      stillAllowed(key);
      const boundary = formBoundary(req.headers?.['content-type']);
      if (boundary === null) throw new Refusal(400, 'the form names no boundary', FILE_SAY.unread);
      let parts;
      try { parts = parseMultipart(raw, boundary); } catch (err) {
        if (!(err instanceof MultipartError)) throw err;
        throw new Refusal(400, `the form could not be read: ${err.message}`, FILE_SAY.unread);
      }
      // For the log line, before anything is refused: counts, kinds and sizes only.
      seen.parts = partsSeen(parts);
      const checked = checkSendForm(parts, { heic: convertHeic !== null });
      if (!checked.ok) throw new Refusal(checked.status ?? 400, checked.error, checked.say ?? 'Jarvis OS could not read that message.');
      answer = await deliver(key, checked);
    } finally {
      uploading.set(key.id, uploading.get(key.id) - 1);
    }
    // The place is free before the answer goes (a refusal's too: it is written by the
    // handler, after this), so a Shortcut that has its answer can send the next share.
    return json(res, 200, answer, NO_STORE);
  }

  // One checked send becomes one message: answers what the Shortcut is told (for a
  // repeat, the first one's answer), or throws the refusal.
  async function deliver(key, { text, shared, via, clientId: givenId, files }) {
    const label = `${key.name}${via ? VIAS[via] : VIA_NONE}`;
    const duplicate = m => ({ ok: true, id: m.id, seq: m.seq, duplicate: true, online: online(), say: 'Already sent to Jarvis.' });
    // A given clientId is the key's own: it can never name a page's message.
    const clientId = givenId ? `sc.${key.id}.${givenId}` : null;
    const had = clientId ? store.byClientId(clientId) : null;
    if (had) return duplicate(had);
    // The same words again within 15 s: a retry, answered as the first, also while the
    // first is still being written (it waits for it).
    // "The same" covers the files: each by the hash of its bytes as they came.
    const hash = createHash('sha256').update(JSON.stringify([via, text, shared, ...files.map(f => createHash('sha256').update(f.data).digest('hex'))])).digest('hex');
    const last = lastSend.get(key.id);
    if (last && last.hash === hash && now() - last.at < DUPLICATE_MS) {
      const first = await last.done;
      if (first) return duplicate(first);
      // The first try failed, so this one stands on its own.
    }
    // From here to `sent.push` nothing awaits: the check and the count are one step,
    // so sends in flight together can't all pass the check before any is counted.
    const at = now();
    const sent = recent(sends, key.id, at);
    if (sent.length >= SENDS_PER_DAY || sent.filter(t => at - t < SEND_WINDOW_MS).length >= SENDS_PER_WINDOW) {
      overLimit(key, 'message', at);
      throw new Refusal(429, `a Shortcut key sends at most ${SENDS_PER_WINDOW} messages in 10 minutes and ${SENDS_PER_DAY} a day`, 'Too many messages from this Shortcut. Use the Jarvis OS app for now.');
    }
    // His files count against the key's day too, in the same step and as uploaded.
    const incoming = files.reduce((n, f) => n + f.data.length, 0);
    const spent = spentBytes(key.id, at);
    if (spent.reduce((n, e) => n + e.bytes, 0) + incoming > fileBytesPerDay) {
      overLimit(key, 'files', at);
      throw new Refusal(429, `a Shortcut key sends at most ${Math.round(fileBytesPerDay / 1024 / 1024)} MB of files a day`, FILE_SAY.budget);
    }
    // And the HEIC photos among them, each a conversion: this count is never given
    // back, whatever becomes of the share, so failing conversions can't go on for free.
    const heics = files.filter(f => f.kind === 'image/heic').length;
    const converted = recent(conversions, key.id, at);
    if (converted.length + heics > CONVERSIONS_PER_DAY || converted.filter(t => at - t < SEND_WINDOW_MS).length + heics > CONVERSIONS_PER_WINDOW) {
      overLimit(key, 'conversions', at);
      throw new Refusal(429, `a Shortcut key has at most ${CONVERSIONS_PER_WINDOW} HEIC photos converted in 10 minutes and ${CONVERSIONS_PER_DAY} a day`, FILE_SAY.conversions);
    }
    for (let i = 0; i < heics; i++) converted.push(at);
    sent.push(at);
    const entry = { at, bytes: incoming };
    spent.push(entry);
    const giveBack = () => {
      takeBack(sent, at);
      const i = spent.indexOf(entry);
      if (i >= 0) spent.splice(i, 1);
    };
    let settle;
    const mine = { hash, at, done: new Promise(resolve => { settle = resolve; }) };
    lastSend.set(key.id, mine);
    // What he shared: a short public link in the text under a fixed line, anything else
    // a text file (data to the lead); and his files, each an attachment.
    const link = sharedLink(shared);
    const attachments = [];
    const what = [];
    let body = text;
    let m = null;
    try {
      if (link) {
        body = `${text ? `${text}\n\n` : ''}${SHARED_LINK_WORDS}\n${link}`;
        what.push('a link');
      } else if (shared !== '') {
        // `textOnly`: the words decide nothing about the file's type. Text that begins
        // like a PDF or a picture is still kept, and served, as text/plain (Ultron's L5).
        try { attachments.push(await store.putAttachment({ name: SHARED_NAME, type: 'text/plain', data: Buffer.from(shared.replaceAll(NUL, ''), 'utf8'), textOnly: true })); } catch (err) { throw new Refusal(err.status ?? 400, 'the shared text could not be kept', 'Jarvis OS could not keep the shared text.'); }
        body = text || SHARED_WORDS;
        what.push('shared text, attached');
      }
      let kept = 0;
      for (const f of files) {
        let { data, kind } = f;
        if (kind === 'image/heic') {
          // Made a JPEG before it is kept: the lead can't open a HEIC. What comes back
          // is checked here, by its first bytes, like anything else from outside. A
          // conversion that fails is logged in one of the converter's fixed words,
          // never its error's own, which could hold a path or the tool's output.
          // No conversion is started for a key or a switch that changed while this
          // share waited (for its body, or for the photo before this one).
          stillAllowed(key);
          let why = null;
          try {
            data = await convertHeic(data);
            if (sniffType(data) !== 'image/jpeg') why = 'failed';
          } catch (err) { why = REASONS.includes(err?.reason) ? err.reason : 'failed'; }
          if (why !== null) {
            log(`shortcut: ${label}: a HEIC photo could not be converted (${why})`);
            throw new Refusal(415, 'a HEIC photo could not be converted', FILE_SAY.heicFailed);
          }
          kind = 'image/jpeg';
        }
        // The store goes by the first bytes again, and agrees: a text file's begin
        // like no picture and no PDF, or classifyFile had called it one.
        let a;
        try { a = await store.putAttachment({ name: cleanFileName(f.filename, kind), type: kind, data }); } catch (err) {
          throw new Refusal(err.status ?? 400, 'a shared file could not be kept', err.status === 413 ? FILE_SAY.fileTooBig : FILE_SAY.kept);
        }
        attachments.push(a);
        // Against the day's bytes: the larger of what came and what is kept (a JPEG
        // can be several times its HEIC).
        kept += Math.max(f.data.length, a.bytes);
      }
      entry.bytes = kept;
      if (files.length > 0) {
        if (!link && text === '') body = attachedWords(attachments.length);
        what.push(`${files.length} file${files.length === 1 ? '' : 's'}, attached`);
      }
      // Nothing awaits between this look and the message.
      stillAllowed(key);
      m = await store.append({ from: 'jeff', kind: 'chat', text: body, replyTo: null, device: label, clientId, attachments, state: 'queued', meta: { shortcut: { key: key.id, via: via ?? 'shortcut' } } });
    } catch (err) {
      // Not sent: the counts go back, and so do the files. The retry mark needs no
      // undoing: it resolves to nothing below, and a send that finds it goes on alone.
      giveBack();
      for (const a of attachments) await store.removeAttachment(a.id);
      throw err;
    } finally {
      settle(m ? { id: m.id, seq: m.seq } : null);
    }
    // The store answered with an earlier message of this clientId (two of them in
    // flight together): this one made nothing, so its files and its counts go back.
    if (attachments.length > 0 && !m.attachments.some(a => a.id === attachments[0].id)) {
      giveBack();
      for (const a of attachments) await store.removeAttachment(a.id);
      return duplicate(m);
    }
    // A message was made: that is a use, and the key's idle clock starts again.
    keys.used(key.id);
    log(`shortcut: ${label} sent a message (${what.length > 0 ? what.join(' and ') : 'text'})`);
    const up = online();
    return { ok: true, id: m.id, seq: m.seq, online: up, say: up ? 'Sent to Jarvis. His answer comes to Jarvis OS.' : 'Sent. Jarvis is offline now; he gets it when he is back.' };
  }

  async function event(req, res, seen) {
    requireShortcutCaller(req);
    const key = requireKey(req);
    const body = await readBody(counted(req, seen), SMALL_BODY_MAX);
    if (!isObject(body) || Object.keys(body).some(k => k !== 'event') || typeof body.event !== 'string' || !Object.hasOwn(PRESENCE_EVENTS, body.event)) {
      throw new Refusal(400, `the body must be {"event": …} with one of ${Object.keys(PRESENCE_EVENTS).join(', ')}`, 'Jarvis OS does not know that event.');
    }
    if (!events) throw new Refusal(503, 'events are off on the server', 'Events are off in Jarvis OS.');
    const at = now();
    const words = PRESENCE_EVENTS[body.event];
    const mark = `${key.id}:${body.event}`;
    const before = lastReport.get(mark);
    // A geofence flaps: the same report again within 10 minutes is the first one.
    if (before !== undefined && at - before < EVENT_DEBOUNCE_MS) return json(res, 200, { ok: true, status: 'duplicate', say: `Already noted: ${words}.` }, NO_STORE);
    const made = recent(reports, key.id, at);
    if (made.length >= EVENTS_PER_DAY) {
      overLimit(key, 'presence', at);
      throw new Refusal(429, `a Shortcut key reports at most ${EVENTS_PER_DAY} presence events a day`, 'Too many reports from this Shortcut today.');
    }
    // Counted and marked before the first await, like a send: reports in flight
    // together find the mark and are duplicates.
    made.push(at);
    lastReport.set(mark, at);
    let r;
    try {
      r = await events.presence({ what: body.event, subject: key.name });
    } catch (err) {
      // Not made: the count and the mark go back. An earlier mark needs no restoring:
      // this report got past it, so it had run out.
      takeBack(made, at);
      if (lastReport.get(mark) === at) lastReport.delete(mark);
      throw err;
    }
    // The report was taken: a use, like a message.
    keys.used(key.id);
    log(`shortcut: ${key.name} reported ${body.event} (${r.status})`);
    return json(res, 200, { ok: true, status: r.status, say: `Noted: ${words}.` }, NO_STORE);
  }

  async function handler(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    // What is learnt of the request's body on the way, for its one log line.
    const seen = { read: 0, form: false, parts: null };
    const logged = (status, reason) => log(requestLine({ method: req.method, path, headers: req.headers, status, reason, seen }));
    try {
      await route(req, res, path, seen);
      const status = res.statusCode ?? res.status ?? 0;
      logged(status, status === 404 ? 'not found' : 'ok');
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('shortcut route error', path, err?.message ?? err);
      // A refusal's message is fixed words (and counts); a fault's own is never logged here.
      const reason = code === 500 ? 'internal error' : String(err.message).slice(0, 120);
      if (res.headersSent) { logged(code, reason); return res.end(); }
      const answer = { error: code === 500 ? 'internal error' : String(err.message) };
      // The Shortcut's side always gets a line to show, whatever refused it.
      if (err instanceof Refusal) answer.say = err.say;
      else if (SHORTCUT_SIDE.has(path)) answer.say = code === 500 ? 'Jarvis OS had a problem. Try again.' : 'Jarvis OS could not take that request.';
      // The answer waits for the rest of the body (`drain`), but for a read that ran out
      // of time. A body that was cut off (413, 408), or is not all in, leaves unread
      // bytes on the connection, which then goes with the answer.
      const whole = code === 408 ? false : await drain(req, seen, FORM_DRAIN_MAX, formTimeoutMs);
      logged(code, reason);
      return json(res, code, answer, code === 413 || !whole ? { ...NO_STORE, Connection: 'close' } : NO_STORE);
    }
  }

  async function route(req, res, path, seen) {
    // ---- the Shortcut's side ----
    if (req.method === 'POST' && path === '/api/shortcut/pair') {
      requireShortcutCaller(req);
      const body = await readBody(counted(req, seen), SMALL_BODY_MAX);
      const r = await keys.claim(isObject(body) ? body.code : null, { addr: proxyAddress(req.headers) });
      if (!r.ok) {
        pairRefused(r.status);
        throw new Refusal(r.status, r.error, PAIR_SAY[r.status] ?? 'Jarvis OS could not pair this Shortcut.');
      }
      log(`shortcut: a Shortcut collected its key (${r.name})`);
      return json(res, 200, { key: r.key, name: r.name, say: 'Paired with Jarvis OS.' }, NO_STORE);
    }
    if (req.method === 'POST' && path === '/api/shortcut/send') return await send(req, res, seen);
    if (req.method === 'POST' && path === '/api/shortcut/event') return await event(req, res, seen);

    // ---- the page's side ----
    if (req.method === 'GET' && path === '/api/shortcut/keys') {
      requireDevice(req);
      return json(res, 200, { keys: keys.list(), waiting: keys.waiting(), off: killed() }, NO_STORE);
    }
    // A code for one new key: shown on this page, typed into the Shortcut.
    if (req.method === 'POST' && path === '/api/shortcut/keys') {
      guardWrite(req);
      const device = requireDevice(req);
      if (killed()) throw new HttpError(503, 'Shortcut keys are switched off on the server');
      const body = await readBody(counted(req, seen), SMALL_BODY_MAX);
      const r = await keys.mint(isObject(body) ? body.name : null, { by: device.name, byId: device.id });
      if (!r.ok) throw new HttpError(r.status, r.error);
      return json(res, 200, { code: r.code, name: r.name, expiresAt: r.expiresAt }, NO_STORE);
    }
    const one = /^\/api\/shortcut\/keys\/([a-f0-9]{16})$/.exec(path);
    if (req.method === 'DELETE' && one) {
      guardDelete(req);
      const device = requireDevice(req);
      const r = await keys.revoke(one[1], device.name);
      if (!r.ok) throw new HttpError(r.status, r.error);
      return json(res, 200, { ok: true }, NO_STORE);
    }
    return json(res, 404, { error: 'not found' }, NO_STORE);
  }

  const owns = path => path.startsWith('/api/shortcut/');
  return { handler, owns };
}

// The admin socket's side (`bin/chat-pair shortcut-code …` on the machine): make the
// code for a new key, list the keys, revoke one by id or exact name. Reachable only
// through the 0600 admin socket.
export function createShortcutAdminRouter({ keys, killed = () => false }) {
  const owns = path => path === '/admin/shortcuts' || path.startsWith('/admin/shortcut/');
  async function handler(req, res) {
    const path = new URL(req.url, 'http://unix').pathname;
    try {
      if (req.method === 'GET' && path === '/admin/shortcuts') return json(res, 200, { keys: keys.list(), waiting: keys.waiting() });
      if (req.method === 'POST' && path === '/admin/shortcut/code') {
        // The kill file stops new codes from the machine too; listing and revoking go on.
        if (killed()) throw new HttpError(503, 'Shortcut keys are switched off on the server (remove the kill file first)');
        const body = await readBody(req, SMALL_BODY_MAX);
        const r = await keys.mint(isObject(body) ? body.name : null, { by: 'chat-pair on this machine' });
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true, code: r.code, name: r.name, expiresAt: r.expiresAt });
      }
      if (req.method === 'POST' && path === '/admin/shortcut/revoke') {
        const body = await readBody(req, SMALL_BODY_MAX);
        const r = await keys.revoke(isObject(body) ? body.key : null, 'chat-pair on this machine');
        if (!r.ok) throw new HttpError(r.status, r.error);
        return json(res, 200, { ok: true, key: r.key });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('shortcut admin error', path, err?.message ?? err);
      if (res.headersSent) return res.end();
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
    }
  }
  return { handler, owns };
}
