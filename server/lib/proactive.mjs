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
import { RULES, RULE_ORDER, opaqueId, SAFE_NAME, checkHit } from './proactive-text.mjs';

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
// offered again on the next pass.
export const SENT_STATUSES = Object.freeze(['made', 'coalescing']);

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
  for (const k of Object.keys(raw)) if (k !== 'enabled') problems.push(`proactive.${k} is not a setting (only "enabled"); it is ignored`);
  if (raw.enabled === true) return { on: true, state: 'on', problems };
  if (raw.enabled !== false && raw.enabled !== undefined) problems.push('proactive.enabled must be true or false; the proactive check stays off');
  return { on: false, state: 'off', problems };
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
  return { run: true, line: `proactive: on, every ${CHECK_EVERY_MS / MIN} min, quiet ${hh(QUIET_START_HOUR)}-${hh(QUIET_END_HOUR)} held to ${hh(QUIET_END_HOUR)}; ${where}${kill}` };
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
      hits.push({ key: `week:${l.label}:${win ?? '-'}`, fp: '1', rule: 'week', limit: rule.name, projected: Math.round(p.projectedPct), resetsAt: win, keepUntil: win ?? now + WEEK_NO_RESET_KEEP_MS });
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

const emptyState = () => ({ board: new Map(), jobs: new Map(), hits: new Map() });
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
  return s;
}
const stateToFile = s => ({ v: STATE_VERSION, board: [...s.board], jobs: [...s.jobs], hits: [...s.hits] });

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
  clock = () => Date.now(),
  log = console.log
}) {
  let state = emptyState();
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
  // The last status that left hits unsent, so the log says each spell once.
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
            // Unsent: the next pass tries again.
            log(`proactive: the event was not made (${err?.code ?? err?.name ?? 'error'}); tried again next pass`);
          }
          if (status !== null) {
            lastDelivery = { at: now, count: due.length, status };
            const n = `${due.length} heads-up${due.length === 1 ? '' : 's'}`;
            if (SENT_STATUSES.includes(status)) {
              // Sent means handed to the events module, which made the event or will at
              // its coalesce window's end; not that the lead has read it.
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
      delivery: lastDelivery,
      hits,
      generatedAt: now
    };
  }

  return { load, pass, view, get state() { return state; } };
}
