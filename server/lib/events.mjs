// Events (Jarvis OS pillar 3, slice 1: "a failed job wakes Jarvis"). An event is a
// short line from `system` in the chat store (kind `event`) that the channel hands to
// the lead's live session. Design: ~/.local/state/jarvis/designs/2026-11-11-jos-pillar3-events.md,
// sections 6 and 7 (Ultron's review and the owner's decisions).
//
// What may make one, and what it may say:
// - The notifier, after acks: only `cron:launchd:*` failures and `service:*` outages,
//   never the lead's own session (`service:session:*`), never an ingested cron and
//   never the needs-you, limit, projection, board or credits alerts.
// - The event socket (lib/event-socket.mjs): a typed body from a source on config's
//   allowlist, empty by default.
// The words come from fixed templates with typed fields only. A job is named only by
// config's own `jobs` entry for its label (Ultron's M1, 11-11: a launchd label is a plist
// file name any same-user program can choose); otherwise "a launchd job". A cron's `last`
// words, a label, a log line or any other outside text never go in.
//
// Limits, all enforced here, on the server:
// - Dedupe by alert key while the condition lives (a ledger of its own, data/events.json,
//   separate from the push ledger so neither failing blocks the other).
// - A burst within 60 s of a source's last event is coalesced into one event at the
//   window's end; the candidates of one pass are one event.
// - At most 6 an hour per source and 30 a day in all (rolling). Past that the candidate
//   is held and counted; once the source is under its caps again, one "N held back"
//   summary goes out, which counts toward no cap and never starts another summary.
// - Quiet hours 22:00-07:00 (local) hold events that are not failures until 07:00.
//   Slice 1 has only failures; the hook is there for the counted sources.
// - The kill switch, a file (`~/.local/state/jarvis-os/events-off`): while it exists
//   nothing is delivered (checked at delivery), and what would have been made is only
//   counted: at most one "N suppressed" line an hour, stored `off`, never delivered, even
//   after the file goes (Ultron's L5).
// - At delivery an event must be under 2 h old and, if it came from an alert, at least
//   one of its alert keys must still be live (unacked and present at the last pass).
// - A daily triage budget (`takeTriage`), for slice 2's headless runs.
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { prune as pruneKeys } from './push-alerts.mjs';
import { clockTime } from './chat-socket.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
export const COALESCE_MS = 60e3;
export const PER_SOURCE_HOURLY = 6;
export const DAILY_TOTAL = 30;
export const EVENT_TTL_MS = 2 * HOUR;
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;
export const TRIAGE_PER_DAY = 10;
export const REF_TTL_MS = DAY;
// How many names one coalesced event lists before "and N more".
export const LIST_MAX = 8;
// Quiet-held candidates kept at most; past this they count as held back (Ultron's L5).
export const QUIET_MAX = 100;
// One "suppressed" line at most this often while the kill switch is on.
export const SUPPRESSED_EVERY_MS = HOUR;

// A source name on the socket's allowlist, and the in-process ones.
export const SOURCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const ALERT_SOURCES = Object.freeze({ launchd: 'job failure', service: 'service outage' });
// Presence (lib/shortcut-routes.mjs): what a paired Shortcut may report, each a fixed
// word. The Shortcut sends the name alone; no text of its own ever reaches an event.
export const PRESENCE_SOURCE = 'presence';
export const PRESENCE_EVENTS = Object.freeze({ 'arrived-home': 'arrived home' });
// A name that may appear in an event's words: plain ASCII, one short line.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,59}$/;
const SAFE_REF = /^[A-Za-z0-9_-]{1,64}$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeName = v => (typeof v === 'string' && SAFE_NAME.test(v.trim()) ? v.trim() : null);

// An alert key as it may leave this process: a short hash, never the key (which holds
// the label as launchd read it).
export const keyHash = key => createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

export const isQuiet = (at, start = QUIET_START_HOUR, end = QUIET_END_HOUR) => {
  const h = new Date(at).getHours();
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
};

// ---- the templates ----

// A job's name in an event: config's own entry for the label (never an inherited
// property: 'constructor' is no job), when it is a plain name; else nothing, and the
// caller says "a launchd job". The label itself is never used.
export function jobName(label, { jobNames = {} } = {}) {
  if (typeof label !== 'string' || !isObject(jobNames) || !Object.hasOwn(jobNames, label)) return null;
  const entry = jobNames[label];
  return isObject(entry) && Object.hasOwn(entry, 'name') ? safeName(entry.name) : null;
}

const jobPart = c => `${c.subject ?? 'a launchd job'}${Number.isInteger(c.exit) ? ` (exit ${c.exit})` : ''} at ${clockTime(c.since)}`;
const servicePart = c => `${c.subject ?? 'a service'} since ${clockTime(c.since)}`;
const presencePart = c => `${PRESENCE_EVENTS[c.what] ?? 'a report'} at ${clockTime(c.since)} (from ${c.subject ? `the Shortcut key ${c.subject}` : 'a Shortcut key'})`;

const listed = (items, part) => {
  const shown = items.slice(0, LIST_MAX).map(part);
  const more = items.length - shown.length;
  return shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
};

// The words for one event made of one or more candidates of one source.
export function eventText(source, items, { title = null } = {}) {
  const n = items.length;
  if (source === 'launchd') {
    if (n === 1) {
      const c = items[0];
      return `Job ${c.subject ?? 'a launchd job'} failed${Number.isInteger(c.exit) ? ` (exit ${c.exit})` : ''} at ${clockTime(c.since)}`;
    }
    return `${n} jobs failed: ${listed(items, jobPart)}`;
  }
  if (source === 'service') {
    if (n === 1) return `Service ${items[0].subject ?? 'a service'} is down since ${clockTime(items[0].since)}`;
    return `${n} services are down: ${listed(items, servicePart)}`;
  }
  if (source === PRESENCE_SOURCE) {
    if (n === 1) return `Presence: ${presencePart(items[0])}`;
    return `${n} presence reports: ${listed(items, presencePart)}`;
  }
  // A counted source from the socket: the count is all it carries.
  const total = items.reduce((sum, c) => sum + (Number.isInteger(c.count) ? c.count : 0), 0);
  const name = safeName(title) ?? source;
  return `${name}: ${total} new at ${clockTime(items[items.length - 1].since)}`;
}

export const heldText = (source, n, since, word = ALERT_SOURCES[source] ?? `${source} event`) =>
  `${n} more ${word}${n === 1 ? '' : 's'} held back since ${clockTime(since)} (limits: ${PER_SOURCE_HOURLY} an hour per source, ${DAILY_TOTAL} a day)`;
export const suppressedText = (n, since) => `${n} event${n === 1 ? '' : 's'} suppressed since ${clockTime(since)}: events were off`;

// ---- the notifier's candidates ----

// The alerts (after acks) that may become events, each with typed fields only.
export function candidatesFromAlerts(alerts, { jobNames = {}, serviceNames = new Set(), excludeKeys = new Set(), now = Date.now() } = {}) {
  const out = [];
  for (const a of alerts ?? []) {
    const key = a?.key;
    if (typeof key !== 'string' || excludeKeys.has(key)) continue;
    const since = Number.isFinite(a.since) ? a.since : now;
    if (a.kind === 'cron' && key.startsWith('cron:launchd:')) {
      const label = key.slice('cron:launchd:'.length);
      out.push({ source: 'launchd', key, failure: true, subject: jobName(label, { jobNames }), exit: Number.isInteger(a.exit) ? a.exit : null, since });
    } else if (a.kind === 'service' && key.startsWith('service:') && !key.startsWith('service:session:')) {
      // `service:<kind>:<name>` (lib/health.mjs): the name only when config lists it.
      const name = key.split(':').slice(2).join(':');
      out.push({ source: 'service', key, failure: true, subject: serviceNames.has(name) ? safeName(name) : null, since });
    }
  }
  return out;
}

// ---- the socket's sources (config `events.sources`) ----

// config.events = { sources: { "<name>": { "title": "NAS drop", "failure": false } },
//                   excludeKeys: ["service:launchd:X"], triagePerDay: 10 }
export function readEventsConfig(config) {
  const problems = [];
  const out = { sources: new Map(), excludeKeys: new Set(), triagePerDay: TRIAGE_PER_DAY, problems };
  const raw = config?.events;
  if (raw === undefined || raw === null) return out;
  if (!isObject(raw)) { problems.push('events is not an object'); return out; }
  if (raw.sources !== undefined && !isObject(raw.sources)) problems.push('events.sources is not an object');
  for (const [name, s] of Object.entries(isObject(raw.sources) ? raw.sources : {})) {
    if (!SOURCE_NAME.test(name) || Object.hasOwn(ALERT_SOURCES, name) || name === PRESENCE_SOURCE) { problems.push(`events.sources: ${JSON.stringify(name)} is not a source name (a-z, 0-9 and -, not launchd, service or presence)`); continue; }
    const title = safeName(s?.title);
    if (!title) { problems.push(`events.sources.${name}: title must be a plain name of at most 60 characters`); continue; }
    out.sources.set(name, { title, failure: s.failure === true });
  }
  if (raw.excludeKeys !== undefined) {
    if (!Array.isArray(raw.excludeKeys)) problems.push('events.excludeKeys is not a list');
    else for (const k of raw.excludeKeys) if (typeof k === 'string' && k) out.excludeKeys.add(k);
  }
  if (raw.triagePerDay !== undefined) {
    if (Number.isInteger(raw.triagePerDay) && raw.triagePerDay >= 0 && raw.triagePerDay <= 200) out.triagePerDay = raw.triagePerDay;
    else problems.push('events.triagePerDay must be a whole number from 0 to 200');
  }
  return out;
}

// What a socket body must be: `{ source, count, ref? }` and nothing else.
export const EVENT_FIELDS = new Set(['source', 'count', 'ref']);
export const COUNT_MAX = 10000;
export function checkEventBody(body, sources) {
  if (!isObject(body)) return { ok: false, status: 400, error: 'the body must be an object' };
  for (const k of Object.keys(body)) if (!EVENT_FIELDS.has(k)) return { ok: false, status: 400, error: 'the body may hold only source, count and ref' };
  if (typeof body.source !== 'string' || !SOURCE_NAME.test(body.source) || !sources.has(body.source)) return { ok: false, status: 403, error: 'not a source on the allowlist' };
  if (!Number.isInteger(body.count) || body.count < 1 || body.count > COUNT_MAX) return { ok: false, status: 400, error: `count must be a whole number from 1 to ${COUNT_MAX}` };
  if (body.ref !== undefined && (typeof body.ref !== 'string' || !SAFE_REF.test(body.ref))) return { ok: false, status: 400, error: 'ref must be an opaque id (letters, digits, _ and -, at most 64)' };
  return { ok: true, source: body.source, count: body.count, ref: body.ref ?? null };
}

// ---- the ledger and the limiter ----

const emptyLedger = () => ({ v: 1, keys: {}, refs: {}, made: [], held: {}, quiet: [], quietOver: {}, suppressed: { n: 0, since: null, lineAt: null }, triage: { day: null, used: 0 } });

function cleanLedger(raw) {
  const l = emptyLedger();
  if (!isObject(raw)) return l;
  if (isObject(raw.keys)) for (const [k, v] of Object.entries(raw.keys)) if (Number.isFinite(v?.at)) l.keys[k] = { at: v.at };
  if (isObject(raw.refs)) for (const [k, v] of Object.entries(raw.refs)) if (Number.isFinite(v)) l.refs[k] = v;
  if (Array.isArray(raw.made)) l.made = raw.made.filter(e => isObject(e) && typeof e.source === 'string' && Number.isFinite(e.at)).map(e => ({ source: e.source, at: e.at }));
  if (isObject(raw.held)) for (const [s, h] of Object.entries(raw.held)) if (Number.isInteger(h?.n) && h.n > 0 && Number.isFinite(h.since)) l.held[s] = { n: h.n, since: h.since };
  if (Array.isArray(raw.quiet)) l.quiet = raw.quiet.filter(c => isObject(c) && typeof c.source === 'string').slice(0, QUIET_MAX);
  if (isObject(raw.quietOver)) for (const [s, h] of Object.entries(raw.quietOver)) if (Number.isInteger(h?.n) && h.n > 0 && Number.isFinite(h.since)) l.quietOver[s] = { n: h.n, since: h.since };
  if (isObject(raw.suppressed) && Number.isInteger(raw.suppressed.n) && raw.suppressed.n >= 0) {
    l.suppressed = { n: raw.suppressed.n, since: Number.isFinite(raw.suppressed.since) ? raw.suppressed.since : null, lineAt: Number.isFinite(raw.suppressed.lineAt) ? raw.suppressed.lineAt : null };
  }
  if (isObject(raw.triage) && Number.isInteger(raw.triage.used)) l.triage = { day: typeof raw.triage.day === 'string' ? raw.triage.day : null, used: raw.triage.used };
  return l;
}

const localDay = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function createEvents({
  store,
  ledgerPath,
  killSwitchPath,
  sources = new Map(),
  triagePerDay = TRIAGE_PER_DAY,
  clock = () => Date.now(),
  log = console.log,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  killed = () => existsSync(killSwitchPath)
}) {
  let ledger = emptyLedger();
  const lastAt = new Map();      // source -> when its last event was made (this run)
  const pending = new Map();     // source -> { items, timer } waiting out a coalesce window
  let queue = Promise.resolve();
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

  async function save() {
    if (!ledgerPath) return;
    const tmp = `${ledgerPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await mkdir(dirname(ledgerPath), { recursive: true });
      await writeFile(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(tmp, ledgerPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      // The ledger in memory stands; the next pass writes it again.
      log(`events: the ledger was not saved (${err?.code ?? err?.message ?? err})`);
    }
  }

  async function load() {
    if (!ledgerPath) return ledger;
    try { ledger = cleanLedger(JSON.parse(await readFile(ledgerPath, 'utf8'))); } catch (err) {
      if (err?.code !== 'ENOENT') log('events: the ledger could not be read; starting from an empty one');
      ledger = emptyLedger();
    }
    return ledger;
  }

  const trimMade = at => { ledger.made = ledger.made.filter(e => at - e.at < DAY); };
  const capped = (source, at) => {
    trimMade(at);
    const hour = ledger.made.filter(e => e.source === source && at - e.at < HOUR).length;
    return hour >= PER_SOURCE_HOURLY || ledger.made.length >= DAILY_TOTAL;
  };

  const titleOf = source => sources.get(source)?.title ?? null;

  // One stored event. `counted` events go toward the caps; a summary does not.
  async function append({ source, type, text, items = [], state = null, counted = true }) {
    const at = clock();
    const keys = items.map(c => c.key).filter(Boolean).map(keyHash);
    const meta = { event: { v: 1, source, type, count: type === 'count' ? items.reduce((s, c) => s + (c.count ?? 0), 0) : items.length, keys, live: keys.length > 0 } };
    // Live before it is stored: the channel's stream checks liveness as the store
    // announces it, which is now. If the store refuses it, those keys go again, so the
    // next pass tries anew rather than deduping a failure nobody heard of (Ultron's L2).
    const added = [];
    for (const c of items) if (c.key && !Object.hasOwn(ledger.keys, c.key)) { ledger.keys[c.key] = { at }; added.push(c.key); }
    let m;
    try {
      m = await store.append({ from: 'system', kind: 'event', text, meta, state });
    } catch (err) {
      for (const k of added) delete ledger.keys[k];
      throw err;
    }
    if (counted && state !== 'off') ledger.made.push({ source, at });
    lastAt.set(source, at);
    return m;
  }

  // A presence event is named by what it reports, when every item says the same.
  const typeFor = (source, items = []) => {
    if (source === 'launchd') return 'job-failed';
    if (source === 'service') return 'service-down';
    if (source !== PRESENCE_SOURCE) return 'count';
    const whats = new Set(items.map(c => c.what));
    return whats.size === 1 && Object.hasOwn(PRESENCE_EVENTS, items[0].what) ? items[0].what : 'presence';
  };

  // The kill switch is on: nothing is made, only counted (and deduped, so a condition
  // that lives on doesn't count again each pass). `flushSuppressed` writes the line.
  function suppress(items) {
    const at = clock();
    for (const c of items) if (c.key) ledger.keys[c.key] = { at };
    if (ledger.suppressed.n === 0) ledger.suppressed.since = at;
    ledger.suppressed.n += Math.max(1, items.length);
  }

  // At most one "suppressed" line an hour while the switch is on, and the rest once it
  // is off. Stored `off`: never delivered, counted toward no cap.
  async function flushSuppressed() {
    const at = clock();
    const s = ledger.suppressed;
    if (s.n === 0) return 0;
    if (killed() && s.lineAt !== null && at - s.lineAt < SUPPRESSED_EVERY_MS) return 0;
    const n = s.n;
    const since = s.since ?? at;
    ledger.suppressed = { n: 0, since: null, lineAt: at };
    await append({ source: 'events', type: 'suppressed', text: suppressedText(n, since), counted: false, state: 'off' });
    return 1;
  }

  // Candidates of one source, past dedupe and the kill switch: coalesce, quiet hours, caps.
  async function admit(source, items) {
    const at = clock();
    if (items.length === 0) return { made: 0, held: 0, waiting: 0 };
    // Not a failure, in quiet hours: kept until 07:00 (flush releases it). A presence
    // report is never kept: an arrival told the next morning says nothing true.
    const atOnce = c => c.failure || c.immediate === true || !isQuiet(at);
    const loud = items.filter(atOnce);
    const hushed = items.filter(c => !atOnce(c));
    for (const c of hushed) {
      if (ledger.quiet.length < QUIET_MAX) { ledger.quiet.push(c); continue; }
      // Bounded: one past the limit is only counted, and at 07:00 the count joins the
      // held-back summary (so a flood at night is one line in the morning, not many).
      const h = ledger.quietOver[source] ?? { n: 0, since: at };
      h.n += 1;
      ledger.quietOver[source] = h;
    }
    if (loud.length === 0) return { made: 0, held: 0, waiting: 0, quiet: hushed.length };
    // Within 60 s of this source's last event: wait out the window, then one event.
    const last = lastAt.get(source);
    if (last !== undefined && at - last < COALESCE_MS) {
      const p = pending.get(source) ?? { items: [], timer: null };
      p.items.push(...loud);
      if (!p.timer) p.timer = setTimer(() => { flushSource(source).catch(err => log(`events: a coalesced event failed (${err?.message ?? err})`)); }, last + COALESCE_MS - at);
      pending.set(source, p);
      return { made: 0, held: 0, waiting: loud.length };
    }
    return make(source, loud);
  }

  async function make(source, items) {
    const at = clock();
    if (capped(source, at)) {
      // Counted by what it would have said: a coalesced event of three failures is three.
      const h = ledger.held[source] ?? { n: 0, since: at };
      h.n += items.length;
      ledger.held[source] = h;
      log(`events: a ${source} event held back by the caps (${h.n} held)`);
      return { made: 0, held: 1, waiting: 0 };
    }
    await append({ source, type: typeFor(source, items), text: eventText(source, items, { title: titleOf(source) }), items });
    return { made: 1, held: 0, waiting: 0 };
  }

  // A coalesce window's end: what gathered becomes one event.
  const flushSource = source => serial(async () => {
    const p = pending.get(source);
    pending.delete(source);
    if (!p || p.items.length === 0) return { made: 0 };
    if (killed()) {
      suppress(p.items);
      await flushSuppressed();
      await save();
      return { made: 0, off: 1 };
    }
    // Deduped only once made (or held): a refused append has already taken its keys
    // back, and they must not come back here (Ultron's final read, L-b).
    const r = await make(source, p.items);
    for (const c of p.items) if (c.key) ledger.keys[c.key] = { at: clock() };
    await save();
    return r;
  });

  // Held summaries once a source is under its caps again, and quiet events after 07:00.
  async function release() {
    const at = clock();
    let summaries = 0;
    for (const [source, h] of Object.entries(ledger.held)) {
      if (capped(source, at)) continue;
      delete ledger.held[source];
      // While the switch is on, the held count joins the suppressed one.
      if (killed()) { ledger.suppressed.n += h.n; ledger.suppressed.since ??= h.since; continue; }
      const word = ALERT_SOURCES[source] ?? `${titleOf(source) ?? source} event`;
      // Never held and never counted, so it can't start another summary.
      await append({ source, type: 'held-back', text: heldText(source, h.n, h.since, word), counted: false });
      summaries++;
    }
    if (!isQuiet(at)) {
      for (const [source, over] of Object.entries(ledger.quietOver)) {
        const h = ledger.held[source] ?? { n: 0, since: over.since };
        h.n += over.n;
        ledger.held[source] = h;
      }
      ledger.quietOver = {};
    }
    if (ledger.quiet.length > 0 && !isQuiet(at)) {
      const bySource = new Map();
      for (const c of ledger.quiet) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
      ledger.quiet = [];
      for (const [source, items] of bySource) {
        if (killed()) suppress(items);
        else await make(source, items);
      }
    }
    await flushSuppressed();
    return summaries;
  }

  const isPending = key => [...pending.values()].some(p => p.items.some(c => c.key === key));

  // The notifier's pass: `alerts` after acks, `observable` the sources it could see.
  function fromAlerts(alerts, { observable = new Set(), jobNames = {}, serviceNames = new Set(), excludeKeys = new Set() } = {}) {
    return serial(async () => {
      const at = clock();
      // A key whose condition cleared (and whose source could be seen) is forgotten,
      // so a return is new again; an acked alert is absent, so it is forgotten too.
      ledger.keys = pruneKeys(ledger.keys, alerts, observable);
      const fresh = candidatesFromAlerts(alerts, { jobNames, serviceNames, excludeKeys, now: at })
        .filter(c => !Object.hasOwn(ledger.keys, c.key) && !isPending(c.key));
      const out = { made: 0, held: 0, waiting: 0, off: 0, summaries: 0 };
      const bySource = new Map();
      for (const c of fresh) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
      for (const [source, items] of bySource) {
        if (killed()) {
          suppress(items);
          out.off++;
          continue;
        }
        const r = await admit(source, items);
        out.made += r.made; out.held += r.held; out.waiting += r.waiting;
      }
      // Dedupe from now on, except what waits out a coalesce window: its keys go in
      // when it is made, so a restart inside the window finds it new again.
      for (const c of fresh) if (!isPending(c.key)) ledger.keys[c.key] = { at };
      out.summaries = await release();
      await save();
      return out;
    });
  }

  // A post on the event socket, already checked (checkEventBody).
  function post({ source, count, ref = null }) {
    return serial(async () => {
      const at = clock();
      for (const [k, t] of Object.entries(ledger.refs)) if (at - t >= REF_TTL_MS) delete ledger.refs[k];
      const refKey = ref ? `${source}:${ref}` : null;
      if (refKey && Object.hasOwn(ledger.refs, refKey)) return { status: 'duplicate' };
      if (refKey) ledger.refs[refKey] = at;
      const item = { source, failure: sources.get(source)?.failure === true, count, since: at };
      let status;
      if (killed()) {
        suppress([item]);
        await flushSuppressed();
        status = 'off';
      } else {
        const r = await admit(source, [item]);
        status = r.made ? 'made' : r.held ? 'held' : r.waiting ? 'coalescing' : 'quiet';
        await release();
      }
      await save();
      return { status };
    });
  }

  // A presence report from a paired Shortcut (lib/shortcut-routes.mjs, which has
  // already checked `what` and debounced it). Typed fields only: the fixed word and
  // the key's name when it is a plain one. The caps, the coalesce window and the kill
  // switch apply; quiet hours do not.
  function presence({ what, subject = null }) {
    return serial(async () => {
      if (!Object.hasOwn(PRESENCE_EVENTS, what)) return { status: 'refused' };
      const item = { source: PRESENCE_SOURCE, failure: false, immediate: true, what, subject: safeName(subject), since: clock() };
      let status;
      if (killed()) {
        suppress([item]);
        await flushSuppressed();
        status = 'off';
      } else {
        const r = await admit(PRESENCE_SOURCE, [item]);
        status = r.made ? 'made' : r.held ? 'held' : 'coalescing';
        await release();
      }
      await save();
      return { status };
    });
  }

  // Whether a stored event may go to the channel now (chat-socket's toInbound).
  function deliverable(m, at = clock()) {
    if (m?.kind !== 'event' || m.from !== 'system') return false;
    if (m.state === 'off' || m.state === 'undelivered') return false;
    if (killed()) return false;
    if (!(at - m.at < EVENT_TTL_MS)) return false;
    const ev = m.meta?.event;
    if (ev?.live) {
      const live = new Set(Object.keys(ledger.keys).map(keyHash));
      if (!(ev.keys ?? []).some(h => live.has(h))) return false;
    }
    return true;
  }

  // One headless triage run's worth of today's budget (slice 2), or false.
  function takeTriage() {
    return serial(async () => {
      const day = localDay(clock());
      if (ledger.triage.day !== day) ledger.triage = { day, used: 0 };
      if (ledger.triage.used >= triagePerDay) return false;
      ledger.triage.used++;
      await save();
      return true;
    });
  }

  return {
    load, fromAlerts, post, presence, deliverable, takeTriage, killed,
    flushNow: source => flushSource(source),
    release: () => serial(async () => { const n = await release(); await save(); return n; }),
    get ledger() { return ledger; }
  };
}
