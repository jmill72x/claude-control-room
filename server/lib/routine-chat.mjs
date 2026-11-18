// A routine's message in the chat (the morning brief and the weekly digest). The
// routines run headless from launchd, outside the lead's session, so they have no
// channel to reply through; until now their text reached Discord only. Here a local
// program posts the text to the ingest socket (`POST /api/ingest/routine-chat`,
// routes.mjs) and it is added to the chat as one of the lead's messages: the paired
// devices see it, it is pushed like any reply ("New message", never its text), and
// read aloud works on it.
//
// What keeps that narrow:
//   - The way in is the ingest socket alone (0600 in the owner's 0700 folder,
//     lib/ingest-socket.mjs); the TCP port refuses the route like every other ingest
//     post, so nothing on the tailnet can reach it.
//   - `kind` is one of a fixed list, and the kind alone picks the title that opens the
//     message. The body is `{ kind, text, id? }` and nothing else: no sender, no
//     reply-to, no file, no field that reaches `meta` but the kind.
//   - The text is data. It is stored as text and drawn by the page's Markdown, which
//     makes no raw HTML; the hidden characters (lib/hidden-chars.mjs: controls, the
//     ones that reorder or hide text, tag characters) are taken out first, and text
//     shaped like a credential is refused (lib/secret-shape.mjs, by the pattern's name,
//     never the match).
//   - It is display and push only. The message is the lead's (`from: "jarvis"`), and
//     the channel's inbound stream carries only the owner's messages, verdicts, events
//     and stops (lib/chat-socket.mjs, toInbound), so it never reaches the lead's
//     session as a turn. `meta.routine` marks it, and a marked message answers nothing:
//     the owner's unanswered messages stay unanswered (lib/chat-store.mjs, answersOwner;
//     the page's ticks, web/src/lib/orbit/chat.js). The page draws a small "routine" mark
//     on it from the mark alone, and the channel's history call hands it to the lead as
//     `system`'s, never as the lead's own words (lib/chat-socket.mjs, historyMessage).
//   - At most ROUTINE_PER_DAY of a kind in any 24 hours, counted from the store itself,
//     so a restart forgets nothing. A post with an `id` seen before for its kind is
//     answered as a duplicate and adds nothing. The ids live under a client-id prefix
//     no other sender may use (ROUTINE_ID_PREFIX; lib/chat-store.mjs, isClientId).
//   - The file `routine-chat-off` beside the sockets refuses every post at once, with
//     no restart.
import { secretShapes } from './secret-shape.mjs';
import { stripHiddenChars } from './hidden-chars.mjs';

// The kinds, and the title each opens with (the words the routine's Discord post uses).
export const ROUTINE_KINDS = Object.freeze({ brief: 'Morning brief', digest: 'Weekly digest' });
// As long as the Mac's voice reads (lib/chat-speech.mjs, SPEECH_TEXT_MAX, less the
// title's room); a brief is about 3,000 characters and a digest about 4,500.
export const ROUTINE_TEXT_MAX = 11900;
// The request's body: the text as JSON (a character is at most six bytes escaped) with room for the rest.
export const ROUTINE_BODY_MAX = 96 * 1024;
export const ROUTINE_PER_DAY = 3;
export const ROUTINE_WINDOW_MS = 24 * 3600e3;
const ROUTINE_ID = /^[A-Za-z0-9_.-]{1,40}$/;
// A routine message's client id is `routine:<kind>:<id>`. The other ways into the store
// (the page, a Shortcut key, the channel's reply) refuse an id that starts so.
export const ROUTINE_ID_PREFIX = 'routine:';
const FIELDS = new Set(['kind', 'text', 'id']);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isRoutineKind = v => typeof v === 'string' && Object.hasOwn(ROUTINE_KINDS, v);
// One of these messages, as the store and the page tell it from the lead's own replies.
export const isRoutineMessage = m => Boolean(m) && m.from === 'jarvis' && m.kind === 'chat' && isRoutineKind(m.meta?.routine);

// Taken out of the text: the shared set of hidden characters (lib/hidden-chars.mjs:
// controls, format characters such as the direction marks, overrides and zero-width
// characters, and whatever a renderer draws as nothing, the tag characters among them).
// Kept: tab and newline, and the two characters emoji are made of, the zero-width
// joiner (U+200D) and the emoji variation selector (U+FE0F). Written as numbers, never
// typed characters (a typed one has turned into the real character in this repo).
export const ROUTINE_KEEP = new Set([0x09, 0x0a, 0x200d, 0xfe0f]);
// The line and paragraph separators, U+2028 and U+2029, become plain newlines.
const SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'gu');

// The text as it is stored: line ends made `\n`, a lone surrogate made U+FFFD, the
// characters above removed, and the ends trimmed. `removed` counts what was taken out.
export function cleanRoutineText(text) {
  const lines = String(text).toWellFormed().replace(/\r\n?/g, '\n').replace(SEPARATORS, '\n');
  const { text: cleaned, removed } = stripHiddenChars(lines, { keep: ROUTINE_KEEP });
  return { text: cleaned.trim(), removed };
}

const fail = error => ({ ok: false, error });

// The post's body, checked: `{ ok, value: { kind, text, id, removed } }` or
// `{ ok: false, error }`. An error never repeats any of the text.
export function checkRoutinePost(body) {
  if (!isObject(body)) return fail('the body must be an object like {"kind": "brief", "text": "..."}');
  for (const key of Object.keys(body)) if (!FIELDS.has(key)) return fail('the body holds only kind, text and id');
  if (!isRoutineKind(body.kind)) return fail(`kind must be one of: ${Object.keys(ROUTINE_KINDS).join(', ')}`);
  if (typeof body.text !== 'string') return fail('text must be a string');
  if (body.text.length > ROUTINE_TEXT_MAX) return fail(`text must be at most ${ROUTINE_TEXT_MAX} characters`);
  const id = body.id ?? null;
  if (id !== null && !(typeof id === 'string' && ROUTINE_ID.test(id))) return fail('id must be 1 to 40 letters, digits, dots, dashes or underscores');
  const { text, removed } = cleanRoutineText(body.text);
  if (text === '') return fail('text must not be blank');
  const shapes = secretShapes(text);
  if (shapes.length) return fail(`the text looks like it holds ${shapes.join(', ')}; it was not added`);
  return { ok: true, value: { kind: body.kind, text, id, removed } };
}

// The message's text: the kind's title in bold, a blank line, the text.
export const routineText = (kind, text) => `**${ROUTINE_KINDS[kind]}**\n\n${text}`;

// `post(value)` takes a checked post and resolves to `{ ok: true, id, seq, removed }`
// (with `duplicate: true` for an id seen before) or `{ ok: false, status, error }`
// (with `retryAfter`, in seconds, for the limit). `store` is the chat's (lib/chat-store.mjs);
// `killed()` says whether the kill file is there. Posts run one at a time, so two at
// once can't both slip under the limit.
export function createRoutineChat({ store, killed = () => false, now = () => Date.now(), log = console.log, perDay = ROUTINE_PER_DAY, windowMs = ROUTINE_WINDOW_MS }) {
  let tail = Promise.resolve();
  async function add({ kind, text, id, removed }) {
    if (killed()) {
      log(`routine-chat: refused a ${kind} (the kill file routine-chat-off is there)`);
      return { ok: false, status: 503, error: 'routine messages are switched off (the kill file)' };
    }
    const clientId = id === null ? null : `${ROUTINE_ID_PREFIX}${kind}:${id}`;
    const had = clientId === null ? null : store.byClientId(clientId);
    // A duplicate only when the earlier message is this kind's own routine message.
    if (had && isRoutineMessage(had) && had.meta.routine === kind) {
      log(`routine-chat: the ${kind} with that id is in the chat already (seq ${had.seq}); nothing added`);
      return { ok: true, id: had.id, seq: had.seq, removed: 0, duplicate: true };
    }
    const at = now();
    const mine = store.newest(store.size).filter(m => isRoutineMessage(m) && m.meta.routine === kind && at - m.at < windowMs);
    if (mine.length >= perDay) {
      const retryAfter = Math.ceil((mine[mine.length - perDay].at + windowMs - at) / 1000); // over 0: the oldest counted is under 24 hours old
      log(`routine-chat: refused a ${kind} (${perDay} in the last 24 hours already)`);
      return { ok: false, status: 429, error: `at most ${perDay} ${kind} messages in 24 hours`, retryAfter };
    }
    // Some other message holds the id (none can take one since the other senders refuse
    // the prefix; one from before that rule could): the store would answer with that
    // message and add nothing, so this one goes in without the id, and says so.
    if (had) log(`routine-chat: the id given for this ${kind} is held by a message that is not a ${kind}; it goes in without the id`);
    const m = await store.append({ from: 'jarvis', kind: 'chat', text: routineText(kind, text), clientId: had ? null : clientId, meta: { routine: kind } });
    log(`routine-chat: the ${kind} is in the chat (seq ${m.seq}, ${text.length} characters${removed ? `, ${removed} hidden or control character${removed === 1 ? '' : 's'} removed` : ''})`);
    return { ok: true, id: m.id, seq: m.seq, removed };
  }
  return {
    post: value => {
      const run = tail.then(() => add(value));
      tail = run.catch(() => {});
      return run;
    }
  };
}
