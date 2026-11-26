// Local alerts (board 5f892918, 2026-11-19): a way for a script on this machine to
// reach the owner's paired devices without Discord. The lead's start script and the
// routines alert to Discord first; when Discord is the thing that is down (or the lead,
// who reads the fallback inbox, is), nothing reached a phone. Here a local program
// posts `{ title, body?, severity?, kind? }` to the ingest socket
// (`POST /api/ingest/local-alert`, routes.mjs), and the server:
//
//   - sends it as a Web Push to every paired device (lib/chat-push.mjs, localAlert):
//     the alert's own title and body, urgent unless `severity` is "info", a tap opening
//     the Overview, kept by the push service for ALERT_TTL_S when a phone is away;
//   - shows it in the page's alert strip and in Needs you, as kind `local`, for
//     KEEP_MS or until acknowledged (lib/acks.mjs takes `local` like a down service);
//     `kind: "jarvis-down"` also gets the "Bring Jarvis Back" button there, and its
//     push ends with the line that brings him back (lib/recover-command.mjs).
//
// What keeps it narrow:
//
//   - The way in is the ingest socket alone (0600 in the owner's 0700 folder,
//     lib/ingest-socket.mjs), the pattern every local caller here uses; the TCP port
//     that Tailscale Serve shares refuses the route unread, from loopback too. The
//     socket's file mode is the shared secret: a process that can open it runs as the
//     owner and could read any token file as well (the 2026-11-12 choice of the socket
//     over a token, lib/ingest-socket.mjs). On top of that the route refuses a request
//     carrying any header a proxy adds (lib/local-caller.mjs, PROXY_HEADERS), so a
//     forwarder in front of the socket can't pass a tailnet request through it.
//   - Plain text, bounded: the title is one line of at most TITLE_MAX characters, the
//     body at most BODY_MAX, both with the hidden characters taken out
//     (lib/hidden-chars.mjs; the body keeps its line breaks). Longer text is cut, not
//     refused, because a failing script's alert should still arrive. Text shaped like a
//     credential (lib/secret-shape.mjs) is withheld, and the answer names the pattern,
//     never the match. The page draws it as text; nothing is parsed as Markup.
//   - One alert per condition (Ultron's M1, 2026-11-19): its key is
//     `local:<kind>:<hash of the cleaned title>`, so a script that repeats an alert
//     updates one entry, whose `since` (what an ack is keyed on) stays the first time it
//     was raised. One ack covers every repeat until the ack runs out, or until the
//     alert has been quiet for KEEP_MS and is forgotten. A repeat of an acked alert is
//     shown (as acked) and never pushed.
//   - Limits, in memory, so a restart starts them again: an alert identical to one taken
//     in the last DEDUPE_MS (same key, severity and body) whose push reached a device is
//     answered as a duplicate with that push's outcome; one whose push reached nobody is
//     taken again, so it gets another try. At most PER_HOUR are taken in any hour, of
//     which JARVIS_DOWN_RESERVE only a "jarvis-down" alert may use (Ultron's L5); past
//     that the alert is still shown, with no push, and the answer is 429 with
//     Retry-After. Pushes have caps of their own, below the intake: PUSH_PER_HOUR an
//     hour and PUSH_PER_DAY a day, with a reserve for "jarvis-down" too
//     (PUSH_RESERVE_HOUR, PUSH_RESERVE_DAY); an alert past them is shown and not pushed.
//   - "Jarvis is back" ends the down alerts (board 80bd2708; the 11-26 Overview kept
//     "Jarvis is not answering" and its card 40 minutes after he answered). A
//     "jarvis-down" alert goes from the strip, Needs you and the "Jarvis is down" card
//     (resolveDown) once, after it was last raised, the lead writes a chat message
//     (server.mjs hears the chat store) or a `kind: "jarvis-back"` alert comes (the
//     watches' all-clear). The entry is dropped, so a later repeat is a new instance:
//     shown and pushed again. An info alert (an all-clear such as "Jarvis is answering
//     again") is a notice: it leaves the strip INFO_KEEP_MS after it was last raised.
//   - A kill file: `local-alerts-off` in the state folder (`killed()`, checked on every
//     post). While it is there an alert is shown and never pushed.
//   - Kept in memory only, at most KEEP_MAX. The body is never logged or written to a
//     file: the log line names the alert's id, kind and severity and the push's counts.
//     The notifier's file (data/notified.json) never sees these alerts, and neither do
//     ntfy, #pepper or the events: the caller's own Discord post is the other path.
import { createHash } from 'node:crypto';
import { stripHiddenChars } from './hidden-chars.mjs';
import { secretShapes } from './secret-shape.mjs';
import { PROXY_HEADERS } from './local-caller.mjs';
import { RECOVER_LINE } from './recover-command.mjs';

export const LOCAL_ALERT_ROUTE = '/api/ingest/local-alert';
export const TITLE_MAX = 120;
export const BODY_MAX = 1000;
// The request: two short texts as JSON (a character is at most six bytes escaped).
export const LOCAL_ALERT_BODY_MAX = 16 * 1024;
export const DEDUPE_MS = 10 * 60e3;
export const PER_HOUR = 10;
// Of the hour's intake, how many only a "jarvis-down" alert may take, so a chatty other
// kind can't starve it (Ultron's L5).
export const JARVIS_DOWN_RESERVE = 2;
// Pushes, below the intake (Ultron's M1): at most this many an hour and a day, of which
// the reserves are a "jarvis-down" alert's alone.
export const PUSH_PER_HOUR = 3;
export const PUSH_PER_DAY = 12;
export const PUSH_RESERVE_HOUR = 1;
export const PUSH_RESERVE_DAY = 3;
export const DAY_MS = 24 * 3600e3;
// The kill file's name, beside the sockets (server.mjs checks it on every post).
export const KILL_FILE = 'local-alerts-off';
export const HOUR_MS = 3600e3;
export const KEEP_MS = 24 * 3600e3;
export const KEEP_MAX = 20;
// How long the route waits for the pushes before it answers anyway.
export const PUSH_WAIT_MS = 15e3;
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
export const DEFAULT_SEVERITY = 'warning';
// The request's `kind`: "jarvis-down" (the lead is not running or started degraded)
// adds the run sheet's button on the page; "jarvis-back" (he is answering again) ends
// every "jarvis-down" alert raised before it; anything else is "other".
export const LOCAL_KINDS = Object.freeze(['jarvis-down', 'jarvis-back', 'other']);
// An info alert is shown this long after it was last raised.
export const INFO_KEEP_MS = 3600e3;
export const DEFAULT_KIND = 'other';
const FIELDS = new Set(['title', 'body', 'severity', 'kind']);

// Built from code points, never typed (a typed one has turned into the real
// character in this repo before).
const ELLIPSIS = String.fromCodePoint(0x2026);
const SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'gu');
const KEEP_NEWLINE = new Set([0x0a]);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = error => ({ ok: false, error });

// At most `max` code points: cut, with an ellipsis as the last one.
export function cut(s, max) {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join('').trimEnd() + ELLIPSIS;
}

// One line: line breaks and tabs become spaces, hidden characters go, runs of spaces
// become one. Not yet cut.
export function cleanTitle(raw) {
  const flat = String(raw).toWellFormed().replace(/[\r\n\t]/g, ' ').replace(SEPARATORS, ' ');
  return stripHiddenChars(flat).text.replace(/\s+/gu, ' ').trim();
}

// Line ends made `\n`, tabs made spaces, hidden characters out (newline kept), trailing
// spaces off each line, at most one blank line in a row, the ends trimmed. Not yet cut.
export function cleanBody(raw) {
  const lines = String(raw).toWellFormed().replace(/\r\n?/g, '\n').replace(SEPARATORS, '\n').replace(/\t/g, ' ');
  const kept = stripHiddenChars(lines, { keep: KEEP_NEWLINE }).text;
  return kept.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The words that stand in for withheld text.
export const WITHHELD_TITLE = 'Local alert (its title was withheld)';
export const withheldBody = names => `The text was withheld: it looked like ${names.join(', ')}. The script's own log has it.`;

// The checked request: `{ ok, value: { title, body, severity, kind, withheld } }`, or
// `{ ok: false, error }` in fixed words that never repeat the text.
export function checkLocalAlert(body) {
  if (!isObject(body)) return fail('the body must be an object');
  if (Object.keys(body).some(k => !FIELDS.has(k))) return fail('the body takes only title, body, severity and kind');
  if (typeof body.title !== 'string') return fail('title must be text');
  if (body.body !== undefined && body.body !== null && typeof body.body !== 'string') return fail('body must be text, or left out');
  const severity = body.severity === undefined || body.severity === null ? DEFAULT_SEVERITY : body.severity;
  if (!SEVERITIES.includes(severity)) return fail(`severity must be one of ${SEVERITIES.join(', ')}`);
  const kind = body.kind === undefined || body.kind === null ? DEFAULT_KIND : body.kind;
  if (!LOCAL_KINDS.includes(kind)) return fail(`kind must be one of ${LOCAL_KINDS.join(', ')}`);
  const title = cleanTitle(body.title);
  if (title === '') return fail('title must hold some visible text');
  const text = cleanBody(body.body ?? '');
  // Checked before the cut, so a credential the cut would split is still found.
  const titleShapes = secretShapes(title);
  const withheld = [...new Set([...titleShapes, ...secretShapes(text)])];
  return {
    ok: true,
    value: {
      title: titleShapes.length ? WITHHELD_TITLE : cut(title, TITLE_MAX),
      body: withheld.length ? withheldBody(withheld) : cut(text, BODY_MAX),
      severity,
      kind,
      withheld
    }
  };
}

// The first proxy header a request carries, or null.
export const proxyHeaderOf = req => PROXY_HEADERS.find(h => req?.headers?.[h] !== undefined) ?? null;

// One alert's key: its kind and a short hash of its cleaned title, so repeats of one
// condition share it (and an ack), whatever their body or severity says.
export const alertKey = (kind, title) => `local:${kind}:${createHash('sha256').update(title).digest('hex').slice(0, 12)}`;

const NO_DEVICES = Object.freeze({ tried: 0, reached: 0 });

// The store and the route's work. `push()` returns the push service's `localAlert`
// (lib/chat-push.mjs) or null while the chat or push is off; it is asked on each post,
// because the chat starts after the routes are made. `killed()` says whether the kill
// file is there; `isAcked(alert)` (may be async) whether an active ack covers the alert
// as the page sees it ({ key, kind, since }). A failure of either reads as "no".
export function createLocalAlerts({ now = () => Date.now(), push = () => null, killed = () => false, isAcked = () => false, log = console.log, pushWaitMs = PUSH_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const kept = new Map(); // key -> { key, id, kind, title, body, severity, since, at, sig, takenAt, last }
  const taken = [];       // { at, kind } for each alert taken in the last hour
  const pushed = [];      // { at, kind } for each push tried in the last day
  let quietUntil = -Infinity;
  const prune = t => {
    for (const [key, a] of kept) if (t - a.at >= (a.severity === 'info' ? INFO_KEEP_MS : KEEP_MS)) kept.delete(key);
    while (taken.length && t - taken[0].at >= HOUR_MS) taken.shift();
    while (pushed.length && t - pushed[0].at >= DAY_MS) pushed.shift();
  };
  // A refusal or duplicate is logged at most once a minute, so a loop doesn't fill the log.
  const logQuietly = (t, line) => {
    if (t < quietUntil) return;
    quietUntil = t + 60e3;
    log(line);
  };
  const ask = async (fn, arg) => {
    try { return (await fn(arg)) === true; } catch { return false; }
  };

  // Whether a `kind` alert may be taken, or pushed, under a cap with a reserve only a
  // "jarvis-down" alert may use: the count of all in the window under `cap`, and the
  // other kinds' under `cap - reserve`. `inWindow` is the window's entries already:
  // `taken` holds the last hour and `pushed` the last day (prune), and the hourly push
  // cap filters `pushed` to the hour.
  const room = (inWindow, cap, reserve, kind) => {
    if (inWindow.length >= cap) return false;
    if (kind === 'jarvis-down') return true;
    return inWindow.filter(e => e.kind !== 'jarvis-down').length < cap - reserve;
  };

  async function pushOut(alert) {
    const send = push();
    if (typeof send !== 'function') return { push: 'off', devices: NO_DEVICES };
    let timer = null;
    const late = new Promise(resolve => {
      timer = setTimer(() => resolve('late'), pushWaitMs);
      timer?.unref?.();
    });
    try {
      const r = await Promise.race([Promise.resolve().then(() => send(alert)), late]);
      if (r === 'late') return { push: 'pending', devices: NO_DEVICES };
      const tried = Number.isInteger(r?.tried) && r.tried > 0 ? r.tried : 0;
      const reached = Number.isInteger(r?.reached) && r.reached > 0 ? Math.min(r.reached, tried) : 0;
      return { push: r?.off ? 'off' : 'on', devices: { tried, reached } };
    } catch (err) {
      log(`local-alert: the push failed (${err?.code ?? err?.name ?? 'error'})`);
      return { push: 'failed', devices: NO_DEVICES };
    } finally {
      clearTimer(timer);
    }
  }

  // The entry for this alert, made or brought up to date: `since` stays the first time
  // it was raised, everything else is this post's. The oldest entry goes past KEEP_MAX.
  function remember(value, key, sig, t) {
    const before = kept.get(key);
    const entry = {
      key, id: key.slice(key.lastIndexOf(':') + 1), kind: value.kind, title: value.title, body: value.body, severity: value.severity,
      since: before ? before.since : t, at: t, sig, takenAt: before?.takenAt ?? null, last: before?.last ?? null
    };
    kept.delete(key);
    kept.set(key, entry);
    while (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value);
    return entry;
  }

  const view1 = a => ({ text: a.title, kind: 'local', key: a.key, since: a.since, at: a.at, severity: a.severity, about: a.kind, body: a.body });

  // Takes a checked alert (checkLocalAlert's value). Answers `{ status, body, headers? }`.
  async function post(value) {
    const t = now();
    prune(t);
    const key = alertKey(value.kind, value.title);
    const sig = JSON.stringify([value.severity, value.body]);
    const before = kept.get(key);
    // A duplicate only of one whose push reached a device: one that reached nobody is
    // taken again, so it gets another try.
    // (An entry never taken, made only by a refusal below, has no push that reached anyone.)
    if (before && before.sig === sig && t - before.takenAt < DEDUPE_MS && (before.last?.devices.reached ?? 0) > 0) {
      before.at = t;
      logQuietly(t, `local-alert: a duplicate of ${before.id} within ${DEDUPE_MS / 60e3} minutes, not pushed again`);
      return { status: 200, body: { ok: true, id: before.id, key, duplicate: true, push: before.last.push, devices: { ...before.last.devices } } };
    }
    const entry = remember(value, key, sig, t);
    if (value.kind === 'jarvis-back') resolveDown(t, 'a jarvis-back alert came');
    const withheld = value.withheld?.length ? { withheld: value.withheld } : {};
    if (!room(taken, PER_HOUR, JARVIS_DOWN_RESERVE, value.kind)) {
      const oldest = taken.find(e => value.kind === 'jarvis-down' || e.kind !== 'jarvis-down') ?? taken[0];
      const wait = Math.max(1, Math.ceil((oldest.at + HOUR_MS - t) / 1000));
      logQuietly(t, `local-alert: over the hour's limit (${PER_HOUR}, ${JARVIS_DOWN_RESERVE} kept for jarvis-down); alerts are shown, not pushed`);
      return {
        status: 429,
        body: { error: `at most ${PER_HOUR} local alerts an hour (${PER_HOUR - JARVIS_DOWN_RESERVE} for kinds other than jarvis-down); it is shown on the page but not pushed; try again in ${wait} s`, id: entry.id, key, shown: true, ...withheld },
        headers: { 'Retry-After': String(wait) }
      };
    }
    taken.push({ at: t, kind: value.kind });
    entry.takenAt = t;
    let out;
    if (await ask(isAcked, view1(entry))) out = { push: 'acked', devices: NO_DEVICES };
    else if (await ask(killed)) out = { push: 'killed', devices: NO_DEVICES };
    else if (!room(pushed.filter(e => t - e.at < HOUR_MS), PUSH_PER_HOUR, PUSH_RESERVE_HOUR, value.kind) || !room(pushed, PUSH_PER_DAY, PUSH_RESERVE_DAY, value.kind)) {
      out = { push: 'capped', devices: NO_DEVICES };
    } else {
      // A "jarvis-down" alert's push ends with the line that brings him back (fixed words,
      // never cut: lib/chat-push.mjs, alertPayload's tail; board 98a30b15).
      out = await pushOut({ title: entry.title, body: entry.body, severity: entry.severity, ...(entry.kind === 'jarvis-down' ? { tail: RECOVER_LINE } : {}) });
      if (out.push !== 'off') pushed.push({ at: t, kind: value.kind });
    }
    // The entry may have been replaced by a newer post while the push went out.
    if (kept.get(key) === entry) entry.last = out;
    const counts = {
      on: `pushed to ${out.devices.reached} of ${out.devices.tried} device${out.devices.tried === 1 ? '' : 's'}`,
      pending: `the push was still going after ${pushWaitMs / 1000} s`,
      failed: 'the push failed',
      off: 'push is off',
      acked: 'not pushed: it is acknowledged',
      killed: `not pushed: the kill file (${KILL_FILE}) is there`,
      capped: `not pushed: over the push limit (${PUSH_PER_HOUR} an hour, ${PUSH_PER_DAY} a day)`
    }[out.push];
    log(`local-alert: ${entry.kind} ${entry.severity} alert ${entry.id} taken${value.withheld?.length ? ' (its text was withheld)' : ''}; ${counts}`);
    return { status: 200, body: { ok: true, id: entry.id, key, push: out.push, devices: out.devices, ...withheld } };
  }

  // The alerts as the strip and Needs you take them (lib/alerts.mjs's shape), the one
  // seen last first. `since` is the instance an ack is keyed on (lib/acks.mjs); `at` is
  // when it was last raised.
  function view(t = now()) {
    prune(t);
    return [...kept.values()].reverse().map(view1);
  }

  // Jarvis is back (`why`, fixed words for the log): every "jarvis-down" alert last
  // raised at or before `upTo` goes. Answers how many went.
  function resolveDown(upTo, why = 'Jarvis is back') {
    if (!Number.isFinite(upTo)) return 0;
    let gone = 0;
    for (const [key, a] of kept) if (a.kind === 'jarvis-down' && a.at <= upTo) { kept.delete(key); gone++; }
    if (gone > 0) log(`local-alert: ${gone} jarvis-down alert${gone === 1 ? '' : 's'} resolved (${why})`);
    return gone;
  }

  return { post, view, resolveDown };
}
