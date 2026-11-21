// The proactive check (docs/design/2026-11-18-proactive-check.md; board a77b4757): a
// pass every 5 minutes with no model and no network, over what this server already
// has. It finds hits (an aging board item, a job that keeps failing, a limit heading
// over, a key about to expire), tells each one once, in one event for the lead
// (lib/events.mjs, `proactive`), and shows the current ones on the page's Heads up
// (GET /api/proactive, lib/proactive-routes.mjs). It never writes the board, never
// pushes to a device and never starts anything.
//
// The rules' numbers and the words are in lib/proactive-text.mjs. What this module adds:
// - Detectors, each a plain function over one source.
// - The bookkeeping: a hit's key names its subject; it is told once, until the
//   condition clears (the key is forgotten) or changes materially (its fingerprint
//   changes). A source that can't be read this pass keeps its keys and its last hits.
// - Quiet hours (22:00-07:00 local, the events module's): hits found then are held, and
//   the first pass from 07:00 tells every held hit still current, with anything new, in
//   one event. server.mjs also runs a pass at 07:00 (nextQuietEnd).
// - The state file, data/proactive.json, written by lib/sent-store.mjs (0600, a temp file
//   and a rename).
import { createHash } from 'node:crypto';
import { isQuiet, keyHash, jobName, QUIET_START_HOUR, QUIET_END_HOUR } from './events.mjs';
import { ruleFor, windowOf, SESSION_STEPS, NO_RESET_KEEP_MS } from './limit-warnings.mjs';
import { distinctHeals } from './heal.mjs';
import { isDueDate } from '../todos.mjs';
import { RULES, RULE_ORDER, opaqueId, SAFE_NAME, checkHit, checkIdle, IDLE } from './proactive-text.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const CHECK_EVERY_MS = 5 * MIN;
// Two run times within this are one run: job-status's times wobble by up to 36 s.
export const SAME_RUN_MS = 2 * MIN;
// What the state file keeps at most; past this the oldest go.
export const STATE_MAX = Object.freeze({ board: 3000, jobs: 300, runs: 64, hits: 1000 });
// A told weekly key with no reset in it is kept this long (a session's: NO_RESET_KEEP_MS).
export const WEEK_NO_RESET_KEEP_MS = DAY;
export const STATE_VERSION = 1;
// The board file unreadable on more passes in a row than this is said once in the log
// (Ultron's L6, 11-18); its last hits stay meanwhile.
export const BOARD_MISSES_SAID = 3;
// What events.proactive answers when it took the hits (Ultron's L1, 11-18). `held` (the
// caps) and `off` (the kill switch) took nothing, so those hits stay unsent and are
// offered again on the next pass. `coalescing` no longer counts (Ultron's N2, 11-18): a
// batch waiting out a window could still be held, dropped or fail, and the events module
// no longer coalesces heads-ups anyway, so only an event that exists is sent.
export const SENT_STATUSES = Object.freeze(['made']);

const OPEN_LANES = new Set(['idea', 'doing']);
// A launchd job's alert key's prefix (lib/alerts.mjs): `cron:launchd:<label>`.
const LAUNCHD_KEY = 'cron:launchd:';
const ASK_KINDS = new Set(['decide', 'do']);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

// "2026-11-18", the local day of `at`.
export function localDay(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Whole days from one local day to a later one (dates only, no clock: DST-proof).
export function daysBetween(from, to) {
  const ms = d => { const [y, m, x] = d.split('-').map(Number); return Date.UTC(y, m - 1, x); };
  return Math.round((ms(to) - ms(from)) / DAY);
}
// The band a count is told at: 3, 6, 12, 24, ... (a hit fires again only on a new band).
export function band(count, first = RULES.repeatCount) {
  if (!Number.isInteger(count) || count < first) return null;
  let b = first;
  while (b * 2 <= count) b *= 2;
  return b;
}
// The next 07:00 local after `now`, plus a few seconds so the pass is past the edge.
export function nextQuietEnd(now, end = QUIET_END_HOUR) {
  const d = new Date(now);
  d.setHours(end, 0, 5, 0);
  if (d.getTime() <= now) { d.setDate(d.getDate() + 1); d.setHours(end, 0, 5, 0); }
  return d.getTime();
}

// config.proactive = { "enabled": true }. Absent is unset (off); false is off.
export function readProactiveConfig(config) {
  const problems = [];
  const raw = config?.proactive;
  if (raw === undefined || raw === null) return { on: false, state: 'unset', problems };
  if (!isObject(raw)) { problems.push('proactive is not an object; the proactive check stays off'); return { on: false, state: 'off', problems }; }
  for (const k of Object.keys(raw)) if (k !== 'enabled' && k !== 'idle') problems.push(`proactive.${k} is not a setting (only "enabled" and "idle"); it is ignored`);
  const idle = readIdleConfig(raw.idle, problems);
  if (raw.enabled === true) return { on: true, state: 'on', idle, problems };
  if (raw.enabled !== false && raw.enabled !== undefined) problems.push('proactive.enabled must be true or false; the proactive check stays off');
  return { on: false, state: 'off', idle, problems };
}

// proactive.idle = { "enabled": true, "quietHours": true }: the idle wake-up. Absent or
// not enabled, none goes. `quietHours` (true unless it is exactly false) keeps
// 22:00-07:00 free of them; false lets them go at night too.
function readIdleConfig(raw, problems) {
  const off = { on: false, quietHours: true };
  if (raw === undefined || raw === null) return off;
  if (!isObject(raw)) { problems.push('proactive.idle is not an object; the idle wake-up stays off'); return off; }
  for (const k of Object.keys(raw)) if (k !== 'enabled' && k !== 'quietHours') problems.push(`proactive.idle.${k} is not a setting (only "enabled" and "quietHours"); it is ignored`);
  if (raw.quietHours !== undefined && typeof raw.quietHours !== 'boolean') problems.push('proactive.idle.quietHours must be true or false; quiet hours stay on');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push('proactive.idle.enabled must be true or false; the idle wake-up stays off');
  return { on: raw.enabled === true, quietHours: raw.quietHours !== false };
}

// Whether passes run, and the start line (Ultron's L5, 11-18). A hit reaches someone
// only through the events path (the lead) or GET /api/proactive (a paired device); the
// server makes both only with the chat on, so with neither there is nobody to tell and
// no pass runs, rather than a page nobody can read.
const hh = h => `${String(h).padStart(2, '0')}:00`;
export function proactiveStart({ settings, events = false, devices = false, killFile = false }) {
  if (!settings?.on) return { run: false, line: `proactive: ${settings?.state ?? 'off'}` };
  if (!events && !devices) return { run: false, line: 'proactive: on in config, but no passes run: the chat is off, so there is no events path and no paired device to read the hits' };
  const where = events ? 'events on' : "events off: hits show only on a paired device's Heads up";
  const kill = killFile ? ' (the kill file is there: no passes)' : '';
  const idle = !settings.idle?.on ? 'idle wake-up off' : `idle wake-up on (${settings.idle.quietHours ? `not ${hh(QUIET_START_HOUR)}-${hh(QUIET_END_HOUR)}` : 'nights too'})`;
  return { run: true, line: `proactive: on, every ${CHECK_EVERY_MS / MIN} min, quiet ${hh(QUIET_START_HOUR)}-${hh(QUIET_END_HOUR)} held to ${hh(QUIET_END_HOUR)}; ${where}; ${idle}${kill}` };
}

// ---- the detectors ----

// An item's fingerprint for "unchanged": every field a writer edits.
const itemPrint = t => hash([t.text ?? null, t.title ?? null, t.lane ?? null, t.tag ?? null, t.priority ?? null, t.owner ?? null, t.due ?? null, t.ask ?? null]);
const askPrint = ask => hash([ask.what, ask.kind ?? null]);

// The board's hits, and what the check keeps of it for next time. `seen` is a Map of
// item id to { fp, since, ask, askSince } from the last pass (only open P0/P1 items and
// open items with an ask are kept). A fingerprint first seen now starts its clock now.
export function boardHits({ todos, seen = new Map(), now }) {
  const next = new Map();
  const hits = [];
  const today = localDay(now);
  for (const t of Array.isArray(todos) ? todos : []) {
    if (!isObject(t) || !OPEN_LANES.has(t.lane)) continue;
    const key = typeof t.id === 'number' && Number.isFinite(t.id) ? String(t.id) : t.id;
    if (typeof key !== 'string' || key === '' || next.has(key)) continue;
    // Said only when it has an opaque shape (proactive-text.mjs, OPAQUE_ID): the key
    // stays the id, so the bookkeeping is the same either way.
    const item = opaqueId(key);
    const priority = ['P0', 'P1', 'P2', 'P3'].includes(t.priority) ? t.priority : null;
    if (isDueDate(t.due) && t.due < today) {
      hits.push({ key: `due:${key}`, fp: t.due, rule: 'due', item, priority, due: t.due, late: daysBetween(t.due, today) });
    }
    const prev = seen.get(key);
    const entry = {};
    if (Object.hasOwn(RULES.staleDays, priority ?? '')) {
      const fp = itemPrint(t);
      entry.fp = fp;
      entry.since = prev && prev.fp === fp && finite(prev.since) && prev.since <= now ? prev.since : now;
      const days = Math.floor((now - entry.since) / DAY);
      if (days >= RULES.staleDays[priority]) hits.push({ key: `stale:${key}`, fp: priority, rule: 'stale', item, priority, lane: t.lane, days });
    }
    if (isObject(t.ask) && typeof t.ask.what === 'string' && t.ask.what.trim() !== '') {
      const fp = askPrint(t.ask);
      entry.ask = fp;
      entry.askSince = prev && prev.ask === fp && finite(prev.askSince) && prev.askSince <= now ? prev.askSince : now;
      const days = Math.floor((now - entry.askSince) / DAY);
      if (days >= RULES.askDays) hits.push({ key: `ask:${key}`, fp, rule: 'ask', item, priority, kind: ASK_KINDS.has(t.ask.kind) ? t.ask.kind : null, days });
    }
    if (entry.fp !== undefined || entry.ask !== undefined) next.set(key, entry);
  }
  return { hits, seen: next };
}

// Failed runs per launchd job (the crons panel after the overlay and the heal runner).
// `jobs` is a Map of label hash to { failing, lastRun, runs } from the last pass. A failed
// run is a row with ok false and no heal hold ahead, counted once per run time (two
// within SAME_RUN_MS are one), or, with no run time, once per turn from not failing to
// failing. A job missing from the panel keeps its record until its runs age out. A job
// whose alert key (`cron:launchd:<label>`) is in config's `events.excludeKeys` is not
// counted at all and its record goes, as the events module skips it (Ultron's L3, 11-18).
export function jobHits({ crons, jobs = new Map(), now, jobNames = {}, excludeKeys = new Set() }) {
  const excluded = new Set();
  for (const k of excludeKeys) if (typeof k === 'string' && k.startsWith(LAUNCHD_KEY)) excluded.add(keyHash(k.slice(LAUNCHD_KEY.length)));
  const next = new Map();
  for (const [h, st] of jobs) if (!excluded.has(h)) next.set(h, { failing: st.failing, lastRun: st.lastRun, runs: [...st.runs] });
  const named = new Map();
  for (const c of Array.isArray(crons) ? crons : []) {
    if (!isObject(c) || typeof c.label !== 'string' || c.label === '') continue;
    const h = keyHash(c.label);
    if (excluded.has(h)) continue;
    named.set(h, c.label);
    const st = next.get(h) ?? { failing: false, lastRun: null, runs: [] };
    const held = finite(c.holdUntil) && c.holdUntil > now;
    if (c.ok === false && !held) {
      const run = finite(c.lastRunAt) ? c.lastRunAt : null;
      let fresh;
      if (run === null) fresh = !st.failing;
      else if (st.lastRun === null) fresh = !st.failing;
      else fresh = Math.abs(run - st.lastRun) > SAME_RUN_MS;
      if (fresh) st.runs.push(run ?? now);
      if (run !== null) st.lastRun = run;
      st.failing = true;
    } else if (c.ok === true) {
      st.failing = false;
    }
    next.set(h, st);
  }
  const hits = [];
  for (const [h, st] of next) {
    st.runs = st.runs.filter(t => finite(t) && now - t < RULES.repeatDays * DAY && t <= now + MIN).sort((a, b) => a - b).slice(-STATE_MAX.runs);
    if (st.runs.length === 0 && !st.failing) { next.delete(h); continue; }
    const b = band(st.runs.length);
    if (b === null) continue;
    hits.push({ key: `fails:${h}`, fp: String(b), rule: 'fails', job: named.has(h) ? jobName(named.get(h), { jobNames }) : null, count: st.runs.length });
  }
  return { hits, jobs: next };
}

// The heal ledger's healed instances (lib/heal.mjs, distinctHeals) per target in the
// last 14 days: the self-healing design's "3 in 14 days" (§5.6). `nameOf(target)` is
// the target's name from config, or null.
export function healHits({ lines, now, nameOf = () => null }) {
  const counts = new Map();
  for (const l of distinctHeals(Array.isArray(lines) ? lines : [])) {
    if (!finite(l.at) || now - l.at >= RULES.repeatDays * DAY || typeof l.target !== 'string') continue;
    counts.set(l.target, (counts.get(l.target) ?? 0) + 1);
  }
  const hits = [];
  for (const [target, count] of counts) {
    const b = band(count);
    if (b === null) continue;
    hits.push({ key: `heals:${target}`, fp: String(b), rule: 'heals', target: nameOf(target), count });
  }
  return hits;
}

// The usage panel's limits ({ label, pct, resetsAt, pace }). A told usage key is kept
// until its window ends (`keepUntil`), so a reading that dips and returns tells nothing
// twice. A session hit at a limit warning's first step or over is `silent`: that warning
// already makes the lead's event (lib/limit-warnings.mjs), and the phone's push.
export function usageHits({ limits, now }) {
  const hits = [];
  for (const l of Array.isArray(limits) ? limits : []) {
    const rule = ruleFor(l?.label);
    if (!rule || !finite(l.pct)) continue;
    const win = windowOf(l.resetsAt);
    if (win !== null && win <= now) continue;
    if (rule.name === 'session') {
      if (l.pct < RULES.sessionPct) continue;
      hits.push({ key: `session:${win ?? '-'}`, fp: '1', rule: 'session', pct: Math.round(l.pct), resetsAt: win, keepUntil: win ?? now + NO_RESET_KEEP_MS, silent: l.pct >= SESSION_STEPS[0] });
    } else {
      const p = l.pace;
      if (!finite(p?.projectedPct) || !(p.projectedPct > RULES.weekProjectedPct) || !finite(p.elapsed) || p.elapsed < RULES.weekMinElapsed) continue;
      // With the span of the recent rate it rests on, when it does (lib/pace.mjs).
      const rateHours = p.basis === 'recent' && p.basisMs > 0 ? Math.max(1, Math.round(p.basisMs / HOUR)) : null;
      hits.push({ key: `week:${l.label}:${win ?? '-'}`, fp: '1', rule: 'week', limit: rule.name, projected: Math.round(p.projectedPct), rateHours, resetsAt: win, keepUntil: win ?? now + WEEK_NO_RESET_KEEP_MS });
    }
  }
  return hits;
}

// Working Shortcut keys (lib/shortcut-keys.mjs, list) whose idle expiry is near.
export function expiryHits({ keys, now }) {
  const hits = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!isObject(k) || k.revokedAt || k.expired || !finite(k.expiresAt) || typeof k.id !== 'string' || k.id === '') continue;
    const left = k.expiresAt - now;
    if (left <= 0 || left > RULES.expiryDays * DAY) continue;
    hits.push({ key: `key-expiry:${k.id}`, fp: localDay(k.expiresAt), rule: 'expiry', what: 'shortcut-key', name: typeof k.name === 'string' && SAFE_NAME.test(k.name) ? k.name : null, expiresAt: k.expiresAt, days: Math.ceil(left / DAY) });
  }
  return hits;
}

// ---- the idle wake-up (docs/design/2026-11-19-dynamic-projection-idle-wake.md) ----

// Whether the board sits idle with room to work, from this pass's readings: `sessions`
// and `usage` are the cache's panels ({ status, data }), `todos` the board file's list
// or null when it could not be read. The answer is `{ state }`, the first of these that
// holds, and with `idle` the wake-up's `fields` (lib/proactive-text.mjs, checkIdle):
//   sessions-not-current  the live agents list was not read this pass
//   running               an agent run is live (lib/live-agents.mjs)
//   usage-not-current     the usage panel was not read this pass, or has no session
//                         limit, or no weekly limit with a percent (Ultron's L1, 11-19)
//   session-high          the session limit is at IDLE.sessionPct or over (with its `pct`)
//   week-high             a weekly limit is at IDLE.weekPct or over now (Jeff, 11-21: no
//                         projection, no reserve, no pace); `limit` is the highest: its
//                         name (lib/limit-warnings.mjs, ruleFor) and pct, for the log
//                         line (heldWords)
//   board-unreadable      the board file could not be read
//   no-work               no open item (idea or doing) without an ask
// A source that can't be read never reads as idle. The lead's own session is not read
// (board 638d21d2, 11-20): a lead talking with the owner still gets the cue, since the
// runs it starts are what burn the board down.
export function idleCheck({ sessions, usage, todos, now }) {
  const live = sessions?.status === 'ok' ? sessions.data?.liveAgents : null;
  if (!isObject(live) || !Array.isArray(live.runs)) return { state: 'sessions-not-current' };
  if (live.runs.length > 0) return { state: 'running' };

  const limits = usage?.status === 'ok' && Array.isArray(usage.data?.limits) ? usage.data.limits : null;
  const session = limits?.find(l => ruleFor(l?.label)?.name === 'session');
  if (!finite(session?.pct)) return { state: 'usage-not-current' };
  if (session.pct >= IDLE.sessionPct) return { state: 'session-high', pct: session.pct };
  let week = null, high = null;
  for (const l of limits) {
    const rule = ruleFor(l?.label);
    if (!rule || rule.name === 'session' || !finite(l.pct)) continue;
    if (l.pct >= IDLE.weekPct && (high === null || l.pct > high.pct)) high = { name: rule.name, pct: l.pct };
    week = Math.max(week ?? 0, l.pct);
  }
  if (week === null) return { state: 'usage-not-current' };
  if (high) return { state: 'week-high', limit: high };

  if (!Array.isArray(todos)) return { state: 'board-unreadable' };
  const fields = { workable: 0, p0: 0, p1: 0, doing: 0, session: Math.round(session.pct), week: Math.round(week) };
  for (const t of todos) {
    if (!isObject(t) || !OPEN_LANES.has(t.lane) || (t.ask !== undefined && t.ask !== null)) continue;
    fields.workable++;
    if (t.priority === 'P0') fields.p0++;
    if (t.priority === 'P1') fields.p1++;
    if (t.lane === 'doing') fields.doing++;
  }
  return fields.workable === 0 ? { state: 'no-work' } : { state: 'idle', fields };
}

// A span as the log says it: "40 min", "2 h", "2 h 35 min" (whole minutes, rounded).
export function spanWords(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const tenth = v => Math.round(v * 10) / 10;

// What holds the idle wake-up, as the log line says it (board 5c27ade0): the reason's
// numbers from this pass, never a name or a title from outside. `found` is idleCheck's
// answer, or for the step's own reasons `{ state, nextAt, unanswered, now }`.
export function heldWords(found) {
  switch (found?.state) {
    case 'killed': return 'the kill file idle-off is there';
    case 'sessions-not-current': return 'the live agents list was not read this pass';
    case 'usage-not-current': return 'the usage panel was not read this pass, or has no session or weekly percent';
    case 'session-high': return `the session limit at ${tenth(found.pct)}%, its bar ${IDLE.sessionPct}%`;
    case 'week-high': return `${found.limit?.name ?? 'a weekly limit'} at ${tenth(found.limit?.pct)}%, its bar ${IDLE.weekPct}%`;
    case 'board-unreadable': return 'the board file could not be read';
    case 'no-work': return 'no open item without an ask';
    case 'quiet-hours': return `quiet ${hh(QUIET_START_HOUR)}-${hh(QUIET_END_HOUR)}, nights off in config; the ${hh(QUIET_END_HOUR)} pass decides afresh`;
    case 'waiting': return `${found.unanswered === 0 ? 'a run followed the last one' : `${found.unanswered} unanswered since the last run`}; the next in ${spanWords(found.nextAt - found.now)}`;
    case 'no-events': return 'the events module is off';
    default: return found?.state ?? 'unknown';
  }
}

// The reasons that hold the wake-up and are logged once a spell. Not here: `running`
// (the burn-down is working, and the spell it interrupts goes on when it ends),
// `settling` (one pass by design after any run), `off` (said at start), and `sent` /
// `not-sent`, which have their own lines.
export const HELD_STATES = Object.freeze(['killed', 'sessions-not-current', 'usage-not-current', 'session-high', 'week-high', 'board-unreadable', 'no-work', 'quiet-hours', 'waiting', 'no-events']);

// A heal target's name for a hit (config's `heal.targets`, a Map by label of { id,
// label }): its job's name from config's `jobs`, else its id when that is a plain name.
export function targetNamer(targets, jobNames = {}) {
  return id => {
    if (typeof id !== 'string') return null;
    for (const t of targets?.values?.() ?? []) {
      if (t?.id !== id) continue;
      return jobName(t.label, { jobNames }) ?? (SAFE_NAME.test(id) ? id : null);
    }
    return null;
  };
}

// Which source a key belongs to, for "could it be seen this pass".
const SOURCE_OF = { due: 'board', ask: 'board', stale: 'board', fails: 'jobs', heals: 'heals', week: 'usage', session: 'usage', 'key-expiry': 'keys' };
export const sourceOf = key => { const kind = String(key).split(':')[0]; return Object.hasOwn(SOURCE_OF, kind) ? SOURCE_OF[kind] : null; };

// ---- the state file ----

const emptyIdle = () => ({ since: null, sentAt: null, unanswered: 0 });
const emptyState = () => ({ board: new Map(), jobs: new Map(), hits: new Map(), idle: emptyIdle() });
const entries = v => (Array.isArray(v) ? v.filter(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && isObject(e[1])) : []);
const timeOrNull = v => (finite(v) ? v : null);

// The file's contents, cleaned entry by entry; anything unreadable is left out.
export function cleanState(raw) {
  const s = emptyState();
  if (!isObject(raw) || raw.v !== STATE_VERSION) return s;
  for (const [id, e] of entries(raw.board).slice(-STATE_MAX.board)) {
    const out = {};
    if (typeof e.fp === 'string' && finite(e.since)) { out.fp = e.fp; out.since = e.since; }
    if (typeof e.ask === 'string' && finite(e.askSince)) { out.ask = e.ask; out.askSince = e.askSince; }
    if (out.fp !== undefined || out.ask !== undefined) s.board.set(id, out);
  }
  for (const [h, e] of entries(raw.jobs).slice(-STATE_MAX.jobs)) {
    if (!/^[0-9a-f]{16}$/.test(h)) continue;
    s.jobs.set(h, { failing: e.failing === true, lastRun: timeOrNull(e.lastRun), runs: (Array.isArray(e.runs) ? e.runs : []).filter(finite).slice(-STATE_MAX.runs) });
  }
  for (const [key, e] of entries(raw.hits).slice(-STATE_MAX.hits)) {
    if (sourceOf(key) === null || typeof e.fp !== 'string' || !finite(e.firstAt)) continue;
    s.hits.set(key, { fp: e.fp, firstAt: e.firstAt, toldAt: timeOrNull(e.toldAt), heldAt: timeOrNull(e.heldAt), keepUntil: timeOrNull(e.keepUntil), silent: e.silent === true });
  }
  // The idle wake-up's: since when the board has sat idle, when the last one went, and
  // how many went since a run was last seen.
  if (isObject(raw.idle)) s.idle = { since: timeOrNull(raw.idle.since), sentAt: timeOrNull(raw.idle.sentAt), unanswered: Number.isInteger(raw.idle.unanswered) && raw.idle.unanswered > 0 ? Math.min(raw.idle.unanswered, 1000) : 0 };
  return s;
}
const stateToFile = s => ({ v: STATE_VERSION, board: [...s.board], jobs: [...s.jobs], hits: [...s.hits], idle: { ...s.idle } });

// ---- the check ----

// `readBoard()` gives the board file's text (never the board store, whose read can
// write); `snapshot()` the cache's panels; `healLines()` the heal ledger's lines;
// `healTargetName(id)` a target's name from config; `shortcutKeys()` the keys' list or
// null; `store` { read, write } (lib/sent-store.mjs); `events()` the events module or
// null (the chat off); `excludeKeys` config's `events.excludeKeys`; `killed()` the kill
// file.
export function createProactive({
  settings = { on: false, state: 'unset' },
  readBoard,
  snapshot = () => ({}),
  healLines = () => [],
  healTargetName = () => null,
  shortcutKeys = () => null,
  store,
  events = () => null,
  jobNames = {},
  excludeKeys = new Set(),
  killed = () => false,
  // The idle wake-up's own kill file (`idle-off`).
  idleKilled = () => false,
  clock = () => Date.now(),
  log = console.log
}) {
  let state = emptyState();
  const idleSettings = settings.idle ?? { on: false, quietHours: true };
  // What the idle rule found on the last pass, for the view; and the last status that
  // left a wake-up unsent, so the log says each spell once.
  let idleNow = { state: idleSettings.on ? 'not checked yet' : 'off' };
  let idleUnsentSaid = null;
  // The spell the wake-up is held in (board 5c27ade0): its reason, when it was first seen
  // and whether a line said it. A held line when the reason changes and the new one holds
  // a second pass in a row, a "no longer held" line when a wake-up is next offered;
  // nothing on the passes between. `heard` is a new reason seen on one pass: a reason that
  // flips back and forth (usage-not-current and week-high, Ultron's 11-21 low) or lasts one
  // pass is never said, and the passes the spell does not count (a run, the settle) neither
  // confirm nor forget it. A wake-up sent opens the waiting spell unsaid (its own line gives
  // the next time). In memory only, so the second pass after a restart says what holds it.
  // A said spell that a one-pass reason keeps interrupting is said once more after
  // FLIPS_SAID such flips, naming both (Ultron's 11-21 L1), so a flip is not invisible.
  // The waiting spell a wake-up opens unsaid keeps no count.
  let held = null;
  let heard = null;
  const FLIPS_SAID = 6;
  function holdFor(found, now) {
    if (held?.reason === found.state) {
      if (heard && finite(held.flips) && !held.flipSaid && ++held.flips >= FLIPS_SAID) {
        held.flipSaid = true;
        log(`proactive: the idle wake-up is held (${held.reason}), flipping pass to pass with ${heard.reason}`);
      }
      heard = null;
      return;
    }
    if (heard?.reason !== found.state) { heard = { reason: found.state, since: now }; return; }
    held = { reason: found.state, since: heard.since, said: true, flips: 0, flipSaid: false };
    log(`proactive: the idle wake-up is held (${found.state}): ${heldWords(found)}`);
  }
  function holdEnds(now) {
    if (held?.said) log(`proactive: the idle wake-up is no longer held (${held.reason}, first seen ${spanWords(now - held.since)} ago)`);
    held = null;
    heard = null;
  }
  // This pass's board list (null when unreadable) and panels, for the idle rule.
  let boardNow = null;
  let snapNow = {};
  let loaded = false;
  let savedText = null;
  // Each source's hits from the last pass that could read it, for the page while it can't.
  const lastHits = { board: [], jobs: [], heals: [], usage: [], keys: [] };
  const sources = { board: 'not read yet', jobs: 'not read yet', heals: 'not read yet', usage: 'not read yet', keys: 'not read yet' };
  // When each source was last read, for a row the page shows from an earlier read.
  const readAt = { board: null, jobs: null, heals: null, usage: null, keys: null };
  // Passes in a row the board file could not be read, and whether that was said.
  let boardMisses = 0;
  let boardSaid = false;
  let checkedAt = null;
  let lastDelivery = null;
  // The last status that left hits unsent (or 'error' when the event could not be
  // made), so the log says each spell once (Ultron's N3, 11-18, for the error).
  let unsentSaid = null;
  let current = [];
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  async function load() {
    try { state = cleanState(await store.read()); } catch { state = emptyState(); }
    savedText = JSON.stringify(stateToFile(state));
    loaded = true;
  }

  async function save() {
    const text = JSON.stringify(stateToFile(state));
    if (text === savedText) return;
    try {
      await store.write(stateToFile(state));
      savedText = text;
    } catch (err) {
      // The state in memory stands; the next pass writes it again.
      log(`proactive: the state was not saved (${err?.code ?? err?.name ?? 'error'})`);
    }
  }

  // Read every source; a source that can't be read keeps its last hits.
  async function gather(now) {
    let todos = null;
    let why = 'not a list';
    try {
      const parsed = JSON.parse(await readBoard());
      if (Array.isArray(parsed)) todos = parsed;
    } catch (err) { why = err?.code ?? err?.name ?? 'error'; }
    boardNow = todos;
    if (todos) {
      const r = boardHits({ todos, seen: state.board, now });
      state.board = r.seen;
      lastHits.board = r.hits;
      sources.board = 'ok';
      if (boardSaid) log('proactive: the board file can be read again');
      boardMisses = 0;
      boardSaid = false;
    } else {
      sources.board = 'unreadable';
      boardMisses++;
      // Said once a spell, by its error's code or name only (never the file's text).
      if (boardMisses > BOARD_MISSES_SAID && !boardSaid) {
        boardSaid = true;
        log(`proactive: the board file could not be read on ${boardMisses} passes in a row (${why}); its last hits stay until it can`);
      }
    }

    const snap = snapshot() ?? {};
    snapNow = snap;
    const crons = snap.crons;
    if (crons?.status === 'ok' && Array.isArray(crons.data)) {
      const r = jobHits({ crons: crons.data, jobs: state.jobs, now, jobNames, excludeKeys });
      state.jobs = r.jobs;
      lastHits.jobs = r.hits;
      sources.jobs = 'ok';
    } else sources.jobs = 'not current';

    try {
      lastHits.heals = healHits({ lines: healLines(), now, nameOf: healTargetName });
      sources.heals = 'ok';
    } catch { sources.heals = 'unreadable'; }

    const usage = snap.usage;
    if (usage?.status === 'ok' && Array.isArray(usage.data?.limits)) {
      lastHits.usage = usageHits({ limits: usage.data.limits, now });
      sources.usage = 'ok';
    } else sources.usage = 'not current';

    // No list (the Shortcut keys off) is none: their hits clear. A list that throws is
    // not current: their hits stay (Ultron's L4, 11-18).
    try {
      const keys = shortcutKeys();
      lastHits.keys = keys ? expiryHits({ keys, now }) : [];
      sources.keys = keys ? 'ok' : 'none';
    } catch { sources.keys = 'not current'; }

    for (const src of Object.keys(sources)) if (isCurrent(src)) readAt[src] = now;

    // Only hits whose fields pass the words' checks go anywhere.
    return Object.values(lastHits).flat().filter(h => checkHit(h) !== null);
  }

  // Whether a source was read this pass (none, for the keys, is a reading too).
  const isCurrent = src => sources[src] === 'ok' || (src === 'keys' && sources.keys === 'none');

  // The idle rule, after the hits: at most one wake-up, when the board has sat idle
  // with room to work for IDLE.settleMs, whatever the lead's own session is doing (board
  // 638d21d2). Not at night unless config says so, and never held for the morning: the
  // 07:00 pass decides afresh. After a wake-up a run followed, the next waits IDLE.gapMs;
  // after one no run followed, IDLE.everyMs, doubling (to IDLE.backoffMax times) with
  // each further one. A run seen live sets the count back to none.
  async function idleStep(now) {
    if (!idleSettings.on) return { state: 'off' };
    const r = await idleRule(now);
    if (HELD_STATES.includes(r.state)) holdFor(r.state === 'waiting' ? { state: 'waiting', nextAt: r.nextAt, unanswered: r.unanswered, now } : r.found ?? r, now);
    return r.found ? { state: r.state } : r;
  }

  // The rule itself: its state for the view, and for a state idleCheck gave, `found`.
  async function idleRule(now) {
    const idle = state.idle;
    if (idleKilled()) { idle.since = null; return { state: 'killed' }; }
    const found = idleCheck({ sessions: snapNow.sessions, usage: snapNow.usage, todos: boardNow, now });
    if (found.state === 'running') idle.unanswered = 0;
    // The view gets the state only; the log line its numbers too.
    if (found.state !== 'idle') { idle.since = null; return { state: found.state, found }; }
    if (!finite(idle.since) || idle.since > now) idle.since = now;
    const base = { since: idle.since, ...found.fields, unanswered: idle.unanswered };
    if (now - idle.since < IDLE.settleMs) return { state: 'settling', ...base };
    if (idleSettings.quietHours && isQuiet(now)) return { state: 'quiet-hours', ...base };
    // A quarter of an hour after one a run followed; one hour after one none did, two
    // after a second, then four.
    const wait = idle.unanswered === 0 ? IDLE.gapMs : IDLE.everyMs * Math.min(IDLE.backoffMax, 2 ** (idle.unanswered - 1));
    if (finite(idle.sentAt) && idle.sentAt <= now && now - idle.sentAt < wait) return { state: 'waiting', ...base, nextAt: idle.sentAt + wait };
    const ev = events();
    if (!ev) return { state: 'no-events', ...base };
    // Offered: whatever held it is over.
    holdEnds(now);
    let status;
    try {
      const r = await ev.idle(checkIdle({ ...found.fields, unanswered: idle.unanswered }), { nights: !idleSettings.quietHours });
      status = typeof r?.status === 'string' ? r.status : 'unknown';
    } catch (err) {
      status = 'error';
      if (idleUnsentSaid !== 'error') log(`proactive: the idle wake-up was not made (${err?.code ?? err?.name ?? 'error'}); tried again each pass`);
    }
    if (SENT_STATUSES.includes(status)) {
      idle.sentAt = now;
      idle.unanswered++;
      idleUnsentSaid = null;
      const backoff = IDLE.everyMs * Math.min(IDLE.backoffMax, 2 ** (idle.unanswered - 1));
      log(`proactive: an idle wake-up to the lead's event (${status}): ${found.fields.workable} open item${found.fields.workable === 1 ? '' : 's'} with no ask; the next no sooner than ${spanWords(IDLE.gapMs)} on if a run follows, else ${spanWords(backoff)}`);
      held = { reason: 'waiting', since: now, said: false };
      return { state: 'sent', ...base, sentAt: now };
    }
    if (status !== 'error' && idleUnsentSaid !== status) log(`proactive: the idle wake-up was not sent (${status}); offered again each pass`);
    idleUnsentSaid = status;
    return { state: 'not-sent', ...base, why: status };
  }

  // One pass: read, keep the books, tell what is new (or hold it for the night).
  function pass() {
    return serial(async () => {
      if (!settings.on) return { status: settings.state ?? 'off' };
      if (killed()) return { status: 'killed' };
      if (!loaded) await load();
      const now = clock();
      const found = await gather(now);
      checkedAt = now;
      const byKey = new Map(found.map(h => [h.key, h]));
      // Forget what cleared: not found now, its source seen this pass, and past any keep.
      for (const [key, e] of state.hits) {
        if (byKey.has(key)) continue;
        if (isCurrent(sourceOf(key)) && !(finite(e.keepUntil) && now < e.keepUntil)) state.hits.delete(key);
      }
      for (const h of found) {
        const e = state.hits.get(h.key);
        if (!e) state.hits.set(h.key, { fp: h.fp, firstAt: now, toldAt: null, heldAt: null, keepUntil: finite(h.keepUntil) ? h.keepUntil : null, silent: false });
        else if (e.fp !== h.fp) Object.assign(e, { fp: h.fp, toldAt: null, heldAt: null, silent: false });
      }
      while (state.hits.size > STATE_MAX.hits) {
        const oldest = [...state.hits].filter(([k]) => !byKey.has(k)).sort((a, b) => a[1].firstAt - b[1].firstAt)[0];
        if (!oldest) break;
        state.hits.delete(oldest[0]);
      }
      current = found;
      // Untold hits: a silent one is told by its limit warning; the rest go now, or wait
      // for 07:00.
      const untold = found.filter(h => state.hits.get(h.key).toldAt === null);
      for (const h of untold.filter(x => x.silent)) Object.assign(state.hits.get(h.key), { toldAt: now, heldAt: null, silent: true });
      const due = untold.filter(h => !h.silent);
      let told = 0;
      if (due.length > 0 && isQuiet(now)) {
        for (const h of due) { const e = state.hits.get(h.key); e.heldAt ??= now; }
      } else if (due.length > 0) {
        const ev = events();
        if (ev) {
          let status = null;
          try {
            const r = await ev.proactive(due.map(checkHit));
            status = typeof r?.status === 'string' ? r.status : 'unknown';
          } catch (err) {
            // Unsent: the next pass tries again. Said once a spell, not every 5 minutes.
            if (unsentSaid !== 'error') log(`proactive: the event was not made (${err?.code ?? err?.name ?? 'error'}); tried again each pass`);
            unsentSaid = 'error';
          }
          if (status !== null) {
            lastDelivery = { at: now, count: due.length, status };
            const n = `${due.length} heads-up${due.length === 1 ? '' : 's'}`;
            if (SENT_STATUSES.includes(status)) {
              // Sent means the events module made the event (it is stored and goes to
              // the lead's channel), not that the lead has read it.
              for (const h of due) Object.assign(state.hits.get(h.key), { toldAt: now, heldAt: null });
              told = due.length;
              unsentSaid = null;
              log(`proactive: ${n} to the lead's event (${status})`);
            } else if (unsentSaid !== status) {
              unsentSaid = status;
              log(`proactive: ${n} not sent (${status}); offered again each pass`);
            }
          }
        }
      }
      idleNow = await idleStep(now);
      await save();
      return { status: 'on', hits: found.length, told, waiting: due.length - told, quiet: isQuiet(now) };
    });
  }

  // The read-only view for GET /api/proactive and the page: typed fields only, a key
  // only as its hash.
  function view() {
    const now = clock();
    const status = !settings.on ? (settings.state ?? 'off') : killed() ? 'killed' : 'on';
    const why = status === 'unset' ? 'config has no proactive block'
      : status === 'off' ? 'config turns the proactive check off'
      : status === 'killed' ? 'the kill file proactive-off is there'
      : null;
    const order = new Map(RULE_ORDER.map((r, i) => [r, i]));
    // A usage hit whose window has ended says nothing true, whatever the last pass found.
    // A hit from a source this pass could not read is marked, with when it was read
    // (Ultron's L4, 11-18).
    const hits = status !== 'on' ? [] : current
      .map(h => {
        const e = state.hits.get(h.key);
        const fields = checkHit(h);
        if (!fields || !e || (finite(fields.resetsAt) && fields.resetsAt <= now)) return null;
        const src = sourceOf(h.key);
        return { id: keyHash(h.key), ...fields, firstAt: e.firstAt, toldAt: e.toldAt, heldAt: e.heldAt, silent: e.silent, current: isCurrent(src), readAt: readAt[src] };
      })
      .filter(Boolean)
      .sort((a, b) => order.get(a.rule) - order.get(b.rule) || (a.firstAt - b.firstAt));
    return {
      status, why, checkedAt, every: CHECK_EVERY_MS,
      quiet: { start: QUIET_START_HOUR, end: QUIET_END_HOUR, now: isQuiet(now) },
      events: Boolean(events()),
      sources: { ...sources },
      rules: RULES,
      // The idle wake-up: its switch, what the last pass found (a state and whole numbers
      // only), when one last went, and its numbers.
      idle: { on: idleSettings.on, quietHours: idleSettings.quietHours, ...(status === 'on' ? idleNow : { state: idleSettings.on ? status : 'off' }), lastSentAt: state.idle.sentAt, rules: IDLE },
      delivery: lastDelivery,
      hits,
      generatedAt: now
    };
  }

  return { load, pass, view, get state() { return state; } };
}
