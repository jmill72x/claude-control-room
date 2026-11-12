// The Chat tab's unseen badge: what counts, the per-device "seen up to" mark, and a
// poll's answer reconciled against it. Checked by web/test/orbit-unseen.test.js.
//
// The mark lives in this browser's storage (one per device, which is enough: each
// device has its own badge). It is the highest seq the Chat tab has shown here,
// with the store's epoch, so a store that was emptied and started again resets it
// rather than hiding new messages behind an old, higher seq.

export const SEEN_KEY = 'jos.chat.seen';

// The lead's messages (chat and approval requests) and event lines are news; the
// owner's own messages (from any device), verdicts and system notices are not.
// A presence event (the owner's own Shortcut said he arrived home) is his own doing,
// like his own message, and is no news to him.
const ownReport = m => m.kind === 'event' && m.meta?.event?.source === 'presence';
export const countsAsUnseen = m => Boolean(m) && Number.isInteger(m.seq) && (m.from === 'jarvis' || m.kind === 'event') && !ownReport(m);

export const unseenAfter = (messages, seq) => (Array.isArray(messages) ? messages.filter(m => countsAsUnseen(m) && m.seq > seq).length : 0);

export function parseSeen(raw) {
  if (typeof raw !== 'string') return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Number.isInteger(v.seq) || v.seq < 0) return null;
  return { epoch: typeof v.epoch === 'string' ? v.epoch : null, seq: v.seq };
}

// A poll's answer (`/api/chat/messages?after=<seen.seq>`: messages, seq, epoch)
// against the mark: the mark to keep and how many unseen messages lie past it.
// No mark yet, another epoch, or a store whose seq is now below the mark: start
// from the store's seq, with no badge. A full page (100) may have more behind it.
export function reconcile(seen, answer) {
  const nothing = { seen, count: 0, more: false };
  if (!answer || !Array.isArray(answer.messages) || !Number.isInteger(answer.seq)) return nothing;
  const epoch = typeof answer.epoch === 'string' ? answer.epoch : null;
  if (!seen || (seen.epoch !== null && seen.epoch !== epoch) || answer.seq < seen.seq) {
    return { seen: { epoch, seq: answer.seq }, count: 0, more: false };
  }
  const last = answer.messages.reduce((best, m) => (Number.isInteger(m?.seq) && m.seq > best ? m.seq : best), seen.seq);
  return {
    seen: seen.epoch === null ? { epoch, seq: seen.seq } : seen,
    count: unseenAfter(answer.messages, seen.seq),
    more: answer.messages.length >= 100 && last < answer.seq
  };
}

// The Chat tab showed up to `seq`: the mark only moves forward.
export function markSeen(seen, seq) {
  const base = seen ?? { epoch: null, seq: 0 };
  return Number.isInteger(seq) && seq > base.seq ? { epoch: base.epoch, seq } : { epoch: base.epoch, seq: base.seq };
}

const CAP = 99;
export function badgeText(count, more = false) {
  if (!count) return '';
  if (count > CAP) return `${CAP}+`;
  return more ? `${count}+` : String(count);
}

export function chatTabLabel(count, more = false) {
  if (!count) return 'Chat';
  if (count > CAP || more) return `Chat, more than ${Math.min(count, CAP)} unread messages`;
  return `Chat, ${count} unread message${count === 1 ? '' : 's'}`;
}
