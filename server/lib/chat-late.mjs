// A message from the page that reaches the server long after it was written
// (board 89248590, 2026-11-20). Two iPad messages written 8 s apart at 12:10
// during an outage arrived at 15:38, 8 ms apart, as the page woke, with no tap.
// Nothing on the page re-sends by itself (it sends once, and again only on a Retry
// tap), so the two requests most likely sat in the iPad's network layer while the
// page slept. The server stamped them with the arrival time, and the lead read
// them as new.
//
// So the page says when a message was written (`composedAt`, the device's clock at
// the Send tap), and the server decides, since only it sees when a request lands:
//
// - A first attempt written more than STALE_SEND_MS ago is not stored. The answer
//   is 409 `{stale: true, composedAt}`, and the page turns the bubble into
//   "Written 12:10, not sent" with Send now and Discard.
// - A send the owner tapped (Retry or Send now: `confirmed: true`) goes through
//   whatever its age.
// - A message stored more than STALE_SEND_MS after it was written keeps
//   `meta.composedAt`, the page shows "written 12:10" under it, and the lead's
//   inbound line starts with a note saying when it was written and when it arrived.
//
// A page built before this change sends no `composedAt`; its clientId
// (`p_<ms in base 36>_<6 random>`, web lib/orbit/chat.js newClientId) carries the
// same moment, so a request such a page left in flight is caught too.
//
// The device's clock is trusted to within the window: a time ahead of the server's
// counts as now (fails open, the old behaviour), and a device more than 5 minutes
// slow would need a tap on every send (iOS sets its clock from the network).
export const STALE_SEND_MS = 5 * 60e3;

const CLIENT_ID_STAMP = /^p_([0-9a-z]{1,11})_[0-9a-z]{6}$/;
const FLOOR = Date.UTC(2020, 0, 1);

// The moment the message was written, from the body, at most `now`; null when
// unknown. A `composedAt` of the wrong type is the caller's to refuse (badTime).
export function composedAtOf(body, now) {
  let t = null;
  if (body?.composedAt !== undefined && body?.composedAt !== null) t = body.composedAt;
  else {
    const m = CLIENT_ID_STAMP.exec(typeof body?.clientId === 'string' ? body.clientId : '');
    if (m) t = Number.parseInt(m[1], 36);
  }
  if (!Number.isSafeInteger(t) || t < FLOOR) return null;
  return Math.min(t, now);
}

// Why the timing fields are refused, or null.
export function badTime(body) {
  const c = body?.composedAt;
  if (c !== undefined && c !== null && !(Number.isSafeInteger(c) && c > 0)) return 'composedAt must be a time in ms';
  const k = body?.confirmed;
  if (k !== undefined && k !== null && typeof k !== 'boolean') return 'confirmed must be true or false';
  return null;
}

// A first attempt (no tap) written longer ago than the window.
export const staleSend = ({ composedAt, confirmed = false }, now) =>
  confirmed !== true && Number.isSafeInteger(composedAt) && now - composedAt > STALE_SEND_MS;

// Stored late: what goes in the message's meta, or null.
export const lateMeta = (composedAt, at) =>
  (Number.isSafeInteger(composedAt) && at - composedAt > STALE_SEND_MS ? { composedAt } : null);

const pad2 = n => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// HH:MM in the server's local time, with the day in front when it isn't `ref`'s.
export function when(at, ref = at) {
  const d = new Date(at);
  const r = new Date(ref);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === r.getFullYear() && d.getMonth() === r.getMonth() && d.getDate() === r.getDate();
  return sameDay ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}
export function lateBy(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

// The line in front of a late message on the lead's inbound stream (the stored
// text stays as typed). Server-made words; the owner's own text follows it.
export const lateNote = (composedAt, at) =>
  `[Written ${when(composedAt, at)}, delivered ${when(at)}: ${lateBy(at - composedAt)} late. Read it as of when it was written.]`;

// The composedAt of a stored message that arrived late, or null.
export function lateComposedAt(m) {
  const c = m?.meta?.composedAt;
  return Number.isSafeInteger(c) && Number.isSafeInteger(m?.at) && m.at - c > STALE_SEND_MS ? c : null;
}
