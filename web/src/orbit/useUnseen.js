import { useEffect, useRef, useState } from 'react';
import * as api from './chatApi.js';
import { lastSeq } from '../lib/orbit/chat.js';
import { SEEN_KEY, parseSeen, reconcile, markSeen } from '../lib/orbit/unseen.js';

// The badge on the Chat tab: how many of the lead's messages and event lines this
// device has not shown on its Chat tab yet (src/lib/orbit/unseen.js).
//
// Off the Chat tab, the page asks every 30 s while it is visible (and at once on
// coming back to it): /api/pair/status first, which answers 200 to any device, and
// only on a paired device /api/chat/messages?after=<mark>. On the Chat tab the badge
// is cleared and the mark follows the thread the tab shows. The mark is in this
// browser's storage; where storage fails, the badge still works for the visit.
const POLL_MS = 30_000;
const ZERO = { count: 0, more: false };

let memorySeen = null; // when storage throws (a private window)
function readSeen() {
  try { return parseSeen(window.localStorage.getItem(SEEN_KEY)); } catch { return memorySeen; }
}
function writeSeen(seen) {
  memorySeen = seen;
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* memory only */ }
}
const sameSeen = (a, b) => a?.epoch === b?.epoch && a?.seq === b?.seq;

export function useUnseen({ onChat, messages }) {
  const [badge, setBadge] = useState(ZERO);
  // The store's seq at the last poll: opening the Chat tab marks it seen at once,
  // even before the thread has loaded.
  const latestRef = useRef(0);

  // On the Chat tab: no badge, and what it shows (while the page is visible) is seen.
  useEffect(() => {
    if (!onChat) return undefined;
    setBadge(ZERO);
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      const seen = readSeen();
      const next = markSeen(seen, Math.max(lastSeq(messages), latestRef.current));
      if (!sameSeen(seen, next)) writeSeen(next);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [onChat, messages]);

  // Off the Chat tab: poll.
  useEffect(() => {
    if (onChat) return undefined;
    let alive = true;
    let timer = null;
    let busy = false;
    const poll = async () => {
      if (busy) return; // the poll in flight sets the next timer
      clearTimeout(timer);
      if (document.visibilityState === 'visible') {
        busy = true;
        try {
          const p = await api.pairStatus();
          if (!alive) return;
          if (p.state !== 'paired') { setBadge(ZERO); } else {
            const seen = readSeen();
            const answer = seen ? await api.messagesAfter(seen.seq, 100) : await api.latestMessages(1);
            if (!alive) return;
            const r = reconcile(seen, answer);
            if (Number.isInteger(answer?.seq)) latestRef.current = answer.seq;
            if (!sameSeen(seen, r.seen)) writeSeen(r.seen);
            setBadge(b => (b.count === r.count && b.more === r.more ? b : { count: r.count, more: r.more }));
          }
        } catch (err) {
          if (alive && err?.status === 401) setBadge(ZERO);
          // Anything else (offline, a restart): keep the badge as it was.
        } finally {
          busy = false;
        }
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    // Another tab of this browser moved the mark.
    const onStorage = e => { if (e.key === SEEN_KEY) poll(); };
    poll();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [onChat]);

  return badge;
}
