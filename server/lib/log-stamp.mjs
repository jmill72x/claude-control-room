// Puts the time at the start of every line the service logs. The service log
// (~/Library/Logs/control-room.log, written by launchd from stdout and stderr)
// had no times at all, so neither a restart ("control room on") nor a
// `watchdog:` exit could be dated, which left the 2026-09-28 to 10-02 deaf
// spell with nothing to line up against (NEXT.md §2).
//
// UTC in ISO 8601, the same clock as the board's history file names.
export const stamp = (now = Date.now()) => new Date(now).toISOString();

// Wraps log, info, warn and error on `target` so each call's output starts with
// the time. The arguments are passed through untouched after it, so an Error
// still prints with its stack. Idempotent: wrapping twice stamps once.
export function installLogStamps(target = console, clock = Date.now) {
  if (target.__stamped) return target;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = target[level].bind(target);
    target[level] = (...args) => original(stamp(clock()), ...args);
  }
  Object.defineProperty(target, '__stamped', { value: true });
  return target;
}

// The same for text written straight to the log, such as the Discord poster's
// output, which arrives as whole lines: each non-empty line gets the time.
export const stampLines = (text, now = Date.now()) =>
  String(text ?? '').replace(/^(?=.)/gm, `${stamp(now)} `);
