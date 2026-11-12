// An ack's notices (lib/acks.mjs, ackNotice), limited so a loop of renewals can't
// flood the phone or spend the push budget (Ultron's 11-12 mediums). ntfy.sh allows 250
// messages a day per home IP, and the mini shares that with the Pi: renewals of even two
// alerts could spend the day's budget, and every real outage alert after them would
// fail. Each #pepper notice also starts a `discord-post`, against #pepper's webhook limit.
//
// The two channels are limited apart, because they say different things:
//
// - **#pepper, per alert key** (createAckNoticeLimiter). Its notice names who, the kind,
//   until when and the renewal count, so it is grouped per key. Nothing is dropped, only
//   gathered, as lib/chat-alert-limit.mjs does for the chat: the first notice for a key
//   goes out at once and opens a 10-minute window; later notices for that key in the
//   window are held and counted, the latest kept. The count goes out with the key's next
//   notice after the window, or, if none comes, when the window ends, carried by the
//   latest held notice. Either push begins a new window.
// - **ntfy, one budget across every key** (createAckNtfyBudget). Its words are generic
//   ("details in #pepper"), so grouping keys loses nothing. At most one push an hour,
//   gathered the same way (first at once, the rest counted into the next or the hour's
//   end), and at most ACK_NTFY_DAY_MAX a day. The day's last allowed push carries one more
//   line, ACK_NTFY_LAST_LINE; after it, ack notices go to #pepper only until the day
//   ends. **A day is the server's local calendar day** (the mini's time zone; it ends at
//   local midnight, so a daylight-saving day is 23 or 25 hours). Notices that come while
//   the day's ntfy budget is spent are not held for the next day: #pepper has them.
//
// createAckNotices runs both for each notice. The service log keeps a line per ack either
// way (routes.mjs, ackLogLine). Checked by test/ack-notice-limit.test.mjs.

export const ACK_NOTICE_WINDOW_MS = 10 * 60e3;
export const ACK_NTFY_WINDOW_MS = 60 * 60e3;
export const ACK_NTFY_DAY_MAX = 12;
export const ACK_NTFY_LAST_LINE = 'Ack notices are Discord-only until tomorrow.';

const minutes = ms => `${Math.round(ms / 60e3)} minutes`;
// On the key's next notice after a window that held some back.
export const carriedSuffix = (n, windowMs = ACK_NOTICE_WINDOW_MS) =>
  ` (and ${n} more for this alert held back in the last ${minutes(windowMs)})`;
// On the latest held notice, sent when the window ends.
export const flushSuffix = (n, windowMs = ACK_NOTICE_WINDOW_MS) =>
  ` (the latest of ${n} for this alert held back in the last ${minutes(windowMs)})`;
// The same two for ntfy's window, which spans every alert.
export const ntfyCarriedSuffix = (n, windowMs = ACK_NTFY_WINDOW_MS) =>
  ` (and ${n} more in the last ${minutes(windowMs)})`;
export const ntfyFlushSuffix = (n, windowMs = ACK_NTFY_WINDOW_MS) =>
  ` (the latest of ${n} in the last ${minutes(windowMs)})`;

// The server's local calendar day of a moment, as a comparable string.
export const localDay = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

const unrefTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

// #pepper's limit. `send(notice)` posts one notice (only `message` is #pepper's);
// `setTimer(fn, ms)` schedules a window's end (unref'd, so it never keeps the process
// up); `onError` hears a failed timed push, which has no caller to throw to.
export function createAckNoticeLimiter({
  send,
  windowMs = ACK_NOTICE_WINDOW_MS,
  clock = () => Date.now(),
  setTimer = unrefTimer,
  onError = () => {}
} = {}) {
  // key -> { start, held, latest }: when the window's push went out, how many were
  // held back since, and the latest of them. Every window's end is scheduled when it
  // opens.
  const state = new Map();
  const withSuffix = (notice, suffix) => ({ ...notice, message: notice.message + suffix });

  const open = key => {
    const w = { start: clock(), held: 0, latest: null };
    state.set(key, w);
    setTimer(() => flush(key, w), windowMs);
  };

  // The end of one window. A timer that outlived its window (a notice after the
  // window already carried the count and began a new one) finds another window and
  // does nothing, so it can't push the new window's holds early. A window that held
  // nothing is forgotten, so the map keeps only keys with a live window.
  const flush = async (key, window) => {
    const s = state.get(key);
    if (!s || s !== window) return;
    if (s.held === 0) { state.delete(key); return; }
    const { held, latest } = s;
    // This push is the next window's, so a notice right after it waits.
    open(key);
    try { await send(withSuffix(latest, flushSuffix(held, windowMs))); } catch (err) { onError(err); }
  };

  return {
    // Answers { sent, held }: whether this one went out now, and how many are held
    // for the key in its current window (0 when it went out). A failed send throws.
    async notice(key, notice) {
      const now = clock();
      const s = state.get(key);
      if (s && now - s.start < windowMs) {
        s.held++;
        s.latest = notice;
        return { sent: false, held: s.held };
      }
      const carried = s?.held ?? 0;
      open(key);
      await send(carried > 0 ? withSuffix(notice, carriedSuffix(carried, windowMs)) : notice);
      return { sent: true, held: 0 };
    },
    // The timer's job for a key, run now: for the tests.
    flushNow: key => flush(key, state.get(key)),
    // For the tests: how many are held for a key right now, and how many keys have a window.
    held: key => state.get(key)?.held ?? 0,
    size: () => state.size
  };
}

// ntfy's budget, one for every key. `send({ message, priority })` pushes one line to
// ntfy (the notice's `ntfyMessage` and `priority`); `dayOf(ms)` names the day a moment
// falls in (the server's local day); the rest as above.
export function createAckNtfyBudget({
  send,
  windowMs = ACK_NTFY_WINDOW_MS,
  dayMax = ACK_NTFY_DAY_MAX,
  clock = () => Date.now(),
  dayOf = localDay,
  setTimer = unrefTimer,
  onError = () => {}
} = {}) {
  let day = null; // the day `pushed` counts
  let pushed = 0; // ntfy pushes made that day
  let window = null; // { start, held, latest } since the last push

  const spent = now => {
    const d = dayOf(now);
    if (d !== day) { day = d; pushed = 0; }
    return pushed >= dayMax;
  };

  // One push, if the day allows it; it opens the next window. The day's last allowed
  // push says so on a line of its own.
  const push = async (notice, suffix) => {
    const now = clock();
    if (spent(now)) { window = null; return false; }
    pushed++;
    const w = { start: now, held: 0, latest: null };
    window = w;
    setTimer(() => flush(w), windowMs);
    const words = (notice.ntfyMessage ?? notice.message) + suffix;
    await send({ message: pushed === dayMax ? `${words}\n${ACK_NTFY_LAST_LINE}` : words, priority: notice.priority });
    return true;
  };

  // The end of one window: as #pepper's, a stale timer does nothing, and so does one
  // whose window held nothing (the next notice finds the window over and goes out).
  const flush = async w => {
    if (window !== w || w.held === 0) return;
    try { await push(w.latest, ntfyFlushSuffix(w.held, windowMs)); } catch (err) { onError(err); }
  };

  return {
    // Answers { sent, held, spent }: whether it went out now, how many wait in the
    // current window, and whether the day's budget was already spent (then it is
    // #pepper's only, and not held). A failed send throws.
    async notice(notice) {
      const now = clock();
      if (spent(now)) return { sent: false, held: 0, spent: true };
      if (window && now - window.start < windowMs) {
        window.held++;
        window.latest = notice;
        return { sent: false, held: window.held, spent: false };
      }
      const carried = window?.held ?? 0;
      await push(notice, carried > 0 ? ntfyCarriedSuffix(carried, windowMs) : '');
      return { sent: true, held: 0, spent: false };
    },
    // For the tests: the timer's job now, what is held, and the day's count.
    flushNow: () => flush(window),
    held: () => window?.held ?? 0,
    pushedToday: () => { spent(clock()); return pushed; }
  };
}

// Both limits for each notice: #pepper per key, ntfy across keys. Both are tried even
// when one fails; a failure then throws (routes.mjs logs it).
export function createAckNotices({ sendPepper, sendNtfy, clock, setTimer, dayOf, onError } = {}) {
  const shared = Object.fromEntries(Object.entries({ clock, setTimer, dayOf, onError }).filter(([, v]) => v !== undefined));
  const pepper = createAckNoticeLimiter({ send: sendPepper, ...shared });
  const ntfy = createAckNtfyBudget({ send: sendNtfy, ...shared });
  return {
    pepper,
    ntfy,
    async notice(key, notice) {
      const [p, n] = await Promise.allSettled([pepper.notice(key, notice), ntfy.notice(notice)]);
      for (const r of [p, n]) if (r.status === 'rejected') throw r.reason;
      return { pepper: p.value, ntfy: n.value };
    }
  };
}
