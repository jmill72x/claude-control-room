// The chat's pushed alerts, rate-limited where a loop could flood the phone. A
// channel that keeps restarting while another holds the socket is refused on every
// try (`client-refused`), and two that keep taking the socket from each other are a
// takeover each time (`client-replaced`). Those two kinds push at most once per kind
// per 10 minutes; the rest are held back and counted, and the count goes out either
// on the kind's next push after the window or, if none comes, when the window ends.
// Four Shortcut-key kinds are limited the same way (a key used from a new address, a
// burst of wrong keys, a key over a limit, a burst of refused pairing tries). Every other kind (pairings, revokes, verdicts) pushes each time. The service log
// keeps a line per event either way (server.mjs). Checked by
// test/chat-alert-limit.test.mjs.

export const CHAT_ALERT_WINDOW_MS = 10 * 60e3;
// The limited kinds, with the words for a count of them.
export const LIMITED_KINDS = Object.freeze({
  'client-refused': 'refused second chat channels',
  'client-replaced': 'chat channel takeovers',
  // A key in use from a fifth address is reported on each use, and wrong keys in every
  // window they come in: both could loop.
  'shortcut-new-address': 'Shortcut key uses from a new address',
  'shortcut-refused': 'bursts of wrong Shortcut keys',
  'shortcut-over-limit': 'Shortcut keys over a limit',
  'shortcut-pair-refused': 'bursts of refused Shortcut pairing tries'
});

const minutes = ms => `${Math.round(ms / 60e3)} minutes`;
export const heldSuffix = (n, windowMs = CHAT_ALERT_WINDOW_MS) => ` (and ${n} more held back in the last ${minutes(windowMs)})`;
export const heldSummary = (kind, n, windowMs = CHAT_ALERT_WINDOW_MS, kinds = LIMITED_KINDS) =>
  `${n} more ${kinds[kind] ?? `chat events (${kind})`} held back in the last ${minutes(windowMs)}`;

// `send(message)` pushes one alert; `setTimer(fn, ms)` schedules the end-of-window
// count (unref'd, so it never keeps the process up); `onError` hears a failed timed
// push, which has no caller to throw to.
export function createAlertLimiter({
  send,
  windowMs = CHAT_ALERT_WINDOW_MS,
  kinds = LIMITED_KINDS,
  clock = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  onError = () => {}
} = {}) {
  // kind -> { start, held, timer }: when the window's push went out, how many were
  // held back since, and whether the end-of-window count is scheduled.
  const state = new Map();

  // The end of one window. A timer that outlived its window (a push after the window
  // already carried the count and began a new one) finds another window and does
  // nothing, so it can't push the new window's holds early.
  const flush = async (kind, window) => {
    const s = state.get(kind);
    if (!s || s !== window) return;
    if (s.held === 0) return;
    const n = s.held;
    // The count is this window's push, so the next event waits out a new window.
    state.set(kind, { start: clock(), held: 0, timer: false });
    try { await send(heldSummary(kind, n, windowMs, kinds)); } catch (err) { onError(err); }
  };

  return {
    // Answers { sent, held }: whether this one went out, and how many are held back
    // in the kind's current window (0 when it went out). A failed send throws.
    async alert(kind, message) {
      if (!Object.hasOwn(kinds, kind)) { await send(message); return { sent: true, held: 0 }; }
      const now = clock();
      const s = state.get(kind);
      if (s && now - s.start < windowMs) {
        s.held++;
        if (!s.timer) { s.timer = true; setTimer(() => flush(kind, s), s.start + windowMs - now); }
        return { sent: false, held: s.held };
      }
      const carried = s?.held ?? 0;
      state.set(kind, { start: now, held: 0, timer: false });
      await send(carried > 0 ? message + heldSuffix(carried, windowMs) : message);
      return { sent: true, held: 0 };
    },
    // The timer's job, run now: for the tests.
    flushNow: kind => flush(kind, state.get(kind)),
    // For the tests and the log: how many are held back for a kind right now.
    held: kind => state.get(kind)?.held ?? 0
  };
}
