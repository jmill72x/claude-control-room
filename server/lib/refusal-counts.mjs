// How often the TCP port refuses an ingest post, per route and reason (Ultron's 11-11
// L5, board 1ba66c95). Before this, each route and reason was logged once and then
// never again, so a hook posting to the wrong place, or a tailnet device trying, went
// on unseen. Now the first refusal of a key still gets its line at once, and later
// ones are counted: at most one line per key an hour, written at the hour's end when
// any were held, with the count since the last line and since the start.
//
// The lines carry only the route and the reason, which are fixed words (routes.mjs,
// lib/local-caller.mjs: a reason names a header, never its value). No body, header
// value, address or token ever reaches a line. Keys are few (seven routes, a dozen
// reasons), but a cap keeps the map bounded anyway: past `maxKeys`, refusals are
// counted together under one "other" line.
//
// The chat's login 403s are counted the same way (board 261d8525, Ultron's 11-23 L1 on
// eae9efd): `words` gives their lines (lib/chat-routes.mjs), the default is the ingest's.

export const REFUSAL_LOG_EVERY_MS = 60 * 60 * 1000;
export const REFUSAL_MAX_KEYS = 20;

const posts = n => `${n} ${n === 1 ? 'post' : 'posts'}`;

export function refusalCountLine(path, reason, count, total) {
  return `ingest: refused ${count} more ${count === 1 ? 'post' : 'posts'} to ${path} ${reason} since the last such line (${total} since the start)`;
}
export function refusalOtherLine(count, total, first, maxKeys = REFUSAL_MAX_KEYS) {
  return `ingest: refused ${posts(count)} on other routes and reasons ${first ? 'past the first' : 'since the last such line'} (${total} since the start; the log names ${maxKeys} routes and reasons at most)`;
}

export const INGEST_REFUSAL_WORDS = Object.freeze({ count: refusalCountLine, other: refusalOtherLine });

export function createRefusalCounts({
  log = console.log,
  clock = () => Date.now(),
  everyMs = REFUSAL_LOG_EVERY_MS,
  maxKeys = REFUSAL_MAX_KEYS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  words = INGEST_REFUSAL_WORDS
} = {}) {
  const keys = new Map(); // `${path} ${reason}` -> { path, reason, loggedAt, count, total, timer }
  const other = { loggedAt: null, count: 0, total: 0, timer: false };
  const write = (seen, now) => {
    log(seen === other ? words.other(seen.count, seen.total, seen.loggedAt === null, maxKeys) : words.count(seen.path, seen.reason, seen.count, seen.total));
    seen.loggedAt = now;
    seen.count = 0;
    seen.timer = false;
  };
  // The hour's end. A timer from an hour already written (a refusal after the hour
  // wrote the line at once) finds a newer line and does nothing.
  const flush = (seen, since) => {
    if (seen.loggedAt !== since) return;
    seen.timer = false;
    if (seen.count > 0) write(seen, clock());
  };
  const held = (seen, now) => {
    seen.count += 1;
    seen.total += 1;
    if (seen.loggedAt === null || now - seen.loggedAt >= everyMs) write(seen, now);
    else if (!seen.timer) {
      seen.timer = true;
      const since = seen.loggedAt;
      setTimer(() => flush(seen, since), since + everyMs - now);
    }
  };
  // `firstLine` is the full line for a key's first refusal (routes.mjs words it).
  function refused(path, reason, firstLine) {
    const now = clock();
    const key = `${path} ${reason}`;
    const seen = keys.get(key);
    if (seen) return held(seen, now);
    if (keys.size >= maxKeys) return held(other, now);
    keys.set(key, { path, reason, loggedAt: now, count: 0, total: 1, timer: false });
    log(firstLine);
  }
  // Totals since the start, per key, for the tests (and a health field, if one is
  // ever wanted): [{ path, reason, total }], then { other } when any went there.
  refused.totals = () => {
    const out = [...keys.values()].map(({ path, reason, total }) => ({ path, reason, total }));
    if (other.total > 0) out.push({ other: other.total });
    return out;
  };
  return refused;
}
