import { useEffect, useRef, useState } from 'react';
import * as api from './chatApi.js';
import { lastSeq } from '../lib/orbit/chat.js';
import { SEEN_KEY, parseSeen, reconcile, markSeen, appBadgeCount, applyAppBadge, pollDelay } from '../lib/orbit/unseen.js';

// The badge on the Chat tab, and the same count on the app's icon: how many of the
// lead's messages and event lines this device has not shown on its Chat tab yet
// (src/lib/orbit/unseen.js).
//
// "Seen now" is the Chat tab, with the page visible. Then the tab's badge and the
// icon's are cleared, and the mark follows the thread the tab shows. Any other time
// (another tab, or the page hidden, on any tab) the page asks: every 30 s while
// visible, every minute while hidden, and at once on coming back. /api/pair/status
// first, which answers 200 to any device, and only on a paired device
// /api/chat/messages?after=<mark>. Each answer sets the icon (navigator.setAppBadge)
// as well as the tab's badge. When the page isn't running (iOS freezes a hidden
// one), a Web Push sets the icon instead (public/sw.js). The mark is in this
// browser's storage; where storage fails, the badge still works for the visit.
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
const isVisible = () => document.visibilityState === 'visible';
const setIcon = count => applyAppBadge(window.navigator, count);

function useVisible() {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const on = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', on);
    window.addEventListener('pageshow', on);
    return () => {
      document.removeEventListener('visibilitychange', on);
      window.removeEventListener('pageshow', on);
    };
  }, []);
  return visible;
}

export function useUnseen({ onChat, messages }) {
  const visible = useVisible();
  const seenNow = onChat && visible;
  const [badge, setBadge] = useState(ZERO);
  // The store's seq at the last poll: opening the Chat tab marks it seen at once,
  // even before the thread has loaded.
  const latestRef = useRef(0);

  // Seen now: no badge on the tab or the icon, and what the tab shows is seen.
  useEffect(() => {
    if (!seenNow) return;
    setBadge(ZERO);
    setIcon(0);
    const seen = readSeen();
    const next = markSeen(seen, Math.max(lastSeq(messages), latestRef.current));
    if (!sameSeen(seen, next)) writeSeen(next);
  }, [seenNow, messages]);

  // Not seen now: poll.
  useEffect(() => {
    if (seenNow) return undefined;
    let alive = true;
    let timer = null;
    let busy = false;
    const show = (count, more) => {
      setBadge(b => (b.count === count && b.more === more ? b : { count, more }));
      setIcon(appBadgeCount({ seenNow: false, count }));
    };
    const poll = async () => {
      if (busy) return; // the poll in flight sets the next timer
      clearTimeout(timer);
      busy = true;
      try {
        const p = await api.pairStatus();
        if (!alive) return;
        if (p.state !== 'paired') { show(0, false); } else {
          const seen = readSeen();
          const answer = seen ? await api.messagesAfter(seen.seq, 100) : await api.latestMessages(1);
          if (!alive) return;
          const r = reconcile(seen, answer);
          if (Number.isInteger(answer?.seq)) latestRef.current = answer.seq;
          if (!sameSeen(seen, r.seen)) writeSeen(r.seen);
          show(r.count, r.more);
        }
      } catch (err) {
        if (alive && err?.status === 401) show(0, false);
        // Anything else (offline, a restart): keep the badge as it was.
      } finally {
        busy = false;
        if (alive) timer = setTimeout(poll, pollDelay(isVisible()));
      }
    };
    const onVisible = () => { if (isVisible()) poll(); };
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
  }, [seenNow]);

  return badge;
}
