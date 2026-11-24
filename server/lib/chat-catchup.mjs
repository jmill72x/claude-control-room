// The restart catch-up (GET /v1/unanswered): which of the owner's unanswered messages
// the channel lists for the lead after a restart, and how they fit (board e0f5a95d,
// Ultron's L4 on NEXT §41, 2026-11-24).
//
// Before, the store added up each message's bytes, oldest first, and stopped once the
// total passed 8 KB, even on the first message. So one large non-ASCII message (2,049
// emoji are past 8 KB) came back as an empty list and the lead got no catch-up at all,
// and an overflow dropped the newest messages, the ones most likely still open. The
// late note (lib/chat-late.mjs leadText, 100 to 130 characters) wasn't counted either.
//
// Now:
// - Only what the channel will list counts: messages it has been handed (seq at or
//   under the delivery cursor, `upTo`). The channel drops the rest itself (its inbound
//   stream replays them from the cursor), so they would only take room, and a note on
//   one of them would be lost. The server's cursor (`store.deliveredSeq` when the
//   catch-up is asked for) equals the cursor the channel got from its hello only
//   because the channel awaits catchUp() before it opens the inbound stream
//   (jarvis-channel server.mjs connectOnce, about :1543-1556), so no ack can move it in
//   between. A channel that asked after opening the stream could see messages it was
//   just handed counted as not yet handed, and left out without a note.
// - The newest come first: the list fills from the newest end, at most CATCHUP_MAX, and
//   stops at the first that doesn't fit, so what is left out is always the oldest run.
// - It is never empty when anything is unanswered: a newest message too big for the
//   room on its own goes in cut down, its start kept (where a late note sits), ending
//   in a note that says how much was shown and to read it whole with fetch_history.
// - The lead is told when messages were left out: the oldest message listed starts with
//   a note giving the count, and the answer carries `omitted` for a channel that reads it.
//
// The room is counted the way the jarvis channel counts its catch-up (jarvis-channel
// server.mjs catchUpContent and capContent): code points, one line per message,
// `[ISO time] jeff: text (id: …, +Natt)` under a header line, the whole cut at
// CHANNEL_CONTENT_MAX from the end. That cut would drop the newest line, so the room
// here stays under it: a line break is counted as 3 (the channel folds it to " ⏎ "), a
// `<` as 4 (it may become "&lt;"), and everything the channel strips still counts.
// The words are the lead's copy (historyMessage, so leadText's late note is counted).

export const CATCHUP_MAX = 10;              // the channel lists at most 10 (catchUp .slice(0, 10))
export const CHANNEL_CONTENT_MAX = 8000;    // the channel's cap on the whole catch-up, code points
export const CATCHUP_CHARS = 7600;          // the room used here: under the channel's cap, with slack
export const HEADER_RESERVE = 200;          // the channel's header line (about 117 code points today)

const BREAKS = new Set(['\n', '\r', ' ', ' ']);
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// An upper bound on the code points `s` takes in the channel's catch-up text.
export function channelCost(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += BREAKS.has(ch) ? 3 : ch === '<' ? 4 : 1;
  return n;
}

// The channel's line around a message's text: `[` + 24-character ISO time + `] jeff: `,
// then ` (id: <id>, +Natt)`, and the line break that joins it to the next.
export function lineFrame(m) {
  const n = Array.isArray(m.attachments) ? m.attachments.length : 0;
  return 33 + ` (id: ${String(m.id)}${n ? `, +${n}att` : ''})`.length + 1;
}

export const leftOutNote = k =>
  `[Catch-up: ${k} older unanswered message${k === 1 ? '' : 's'} left out to fit. fetch_history with before set to this message's id lists them.]`;
export const cutNote = (shown, total) =>
  ` … [Cut to fit the catch-up: the first ${shown} of ${total} characters. Read the whole message with fetch_history before acting on it.]`;
const LEAD_GAP = '\n\n'; // between the left-out note and the message, as leadText's late note

// The start of `text`, whole characters only (an emoji sequence is never split), that
// with the cut note costs at most `room`.
function cutText(text, room) {
  const total = Array.from(text).length;
  const avail = room - channelCost(cutNote(total, total));
  let shown = '', cost = 0, count = 0;
  for (const { segment } of graphemes.segment(text)) {
    const c = channelCost(segment);
    if (cost + c > avail) break;
    shown += segment;
    cost += c;
    count += Array.from(segment).length;
  }
  return shown + cutNote(count, total);
}

// `list`: the unanswered messages in the lead's form (historyMessage), oldest first.
// Answers `{ messages, omitted }`: what fits, oldest first, and how many were left out.
export function fitCatchUp(list, { upTo = Infinity } = {}) {
  const pool = list.filter(m => !(Number.isSafeInteger(m.seq) && m.seq > upTo));
  const fit = room => {
    const out = [];
    let used = 0;
    for (let i = pool.length - 1; i >= 0 && out.length < CATCHUP_MAX; i--) {
      const m = pool[i];
      const cost = lineFrame(m) + channelCost(m.text);
      if (used + cost <= room) {
        out.unshift(m);
        used += cost;
        continue;
      }
      if (!out.length) out.unshift({ ...m, text: cutText(String(m.text ?? ''), room - lineFrame(m)) });
      break;
    }
    return out;
  };
  const room = CATCHUP_CHARS - HEADER_RESERVE;
  let messages = fit(room);
  if (messages.length < pool.length) {
    // Fit again with room kept for the note (its count can only be smaller than pool's).
    messages = fit(room - channelCost(leftOutNote(pool.length) + LEAD_GAP));
    const omitted = pool.length - messages.length;
    messages[0] = { ...messages[0], text: `${leftOutNote(omitted)}${LEAD_GAP}${messages[0].text}` };
  }
  return { messages, omitted: pool.length - messages.length };
}
