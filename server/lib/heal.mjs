// Self-healing loops (Jarvis OS 6), the pure parts. Design:
// docs/design/2026-11-12-self-healing-loops.md. Loop 1 is built here and in
// lib/heal-runner.mjs: a job whose only fault is an old log (job-status's log-age
// rule) is marked "quiet, ran clean" when launchd's own run counter rose between two
// readings and its last exit was 0 at both. The shared parts the later loops use are
// here too: the tiers, the verb floors, the catalog and its loader, the config block,
// the ledger's lines and the page's view.
//
// Guardrails this file holds (design §4):
// - A catalog entry's tier is never below the floor of the verbs it declares; the
//   loader refuses a catalog that undercuts it, or that names a verb it doesn't know.
// - An action is handed only the tools for the verbs it declares (toolsFor), so its
//   verb list can't understate what it does.
// - Targets come from config's `heal.targets` only, looked up by own keys.
import { LAUNCHD_LABEL, jobDisplayName } from './health.mjs';
import { sameSince } from './acks.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- tiers and verbs ----

export const TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);
const rank = tier => TIERS.indexOf(tier);

// Each verb's floor: the lowest tier an action that uses it may sit in. Reads are T0.
// Saying an alarm is false changes what Jeff is told, so it is T1, never T0. Everything
// on the design's "ask Jeff first" list is T2. T3 never acts, so no verb has it.
export const VERB_FLOORS = Object.freeze({
  'launchctl:print': 'T0',
  'launchctl:list': 'T0',
  'job-status:read': 'T0',
  'missed-runs:read': 'T0',
  'git:rev-parse': 'T0',
  'log:read': 'T0',
  'alert:mark-quiet': 'T1',
  'launchctl:kickstart': 'T2',
  'launchctl:load': 'T2',
  'launchctl:unload': 'T2',
  'launchctl:bootstrap': 'T2',
  'launchctl:bootout': 'T2',
  'launchctl:enable': 'T2',
  'launchctl:disable': 'T2',
  'plist:write': 'T2',
  'tailscale:change': 'T2',
  'cloudflared:change': 'T2',
  'git:commit': 'T2',
  'git:push': 'T2',
  'deploy:web-build': 'T2',
  'fs:delete': 'T2',
  'money:spend': 'T2',
  'discord:change': 'T2',
  'host:reboot': 'T2',
  'host:remote': 'T2',
  'keychain:read': 'T2',
  'sudo:run': 'T2',
  'alert:ack': 'T2'
});

// The highest floor among the verbs, or null when one is unknown.
export function floorOf(verbs) {
  let floor = 'T0';
  for (const v of verbs) {
    if (typeof v !== 'string' || !Object.hasOwn(VERB_FLOORS, v)) return null;
    if (rank(VERB_FLOORS[v]) > rank(floor)) floor = VERB_FLOORS[v];
  }
  return floor;
}

// ---- the catalog ----

// The push for an alert a loop is checking waits at most this long (design §5.2).
export const SETTLE_MAX_MS = 10 * MIN;
// The second reading of an interval job comes this long after one interval, and of a
// calendar job this long after its next due time: the job's own run may take a while.
export const INTERVAL_MARGIN_MS = 60e3;
export const CALENDAR_GRACE_MS = 2 * MIN;
// Rate limits (design §4.6).
export const PER_TARGET_DAY = 3;
export const PER_DAY = 20;
export const COMEBACK_MS = HOUR;

// The reviewed catalog. Code, so changing an entry is a commit through C&P, and
// Ultron reviews each new one. Loop 2 and loop 3 add theirs here.
export const CATALOG = Object.freeze([
  Object.freeze({
    id: 'mark-quiet',
    class: 'stale-log',
    tier: 'T1',
    targetKind: 'job',
    verbs: Object.freeze(['launchctl:print', 'alert:mark-quiet']),
    settleMs: SETTLE_MAX_MS
  })
]);

const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const CLASS_ID = /^[a-z][a-z0-9-]{0,39}$/;
const TARGET_KINDS = new Set(['job']);

// The catalog as the runner may use it, or a throw naming the first fault. A tier
// below its verbs' floor, an unknown verb, a T3 entry (T3 never acts), a repeated id
// or a settle time past the design's 10 minutes refuses the whole catalog.
export function loadCatalog(entries) {
  if (!Array.isArray(entries)) throw new Error('the catalog is not a list');
  const byId = new Map();
  for (const [i, e] of entries.entries()) {
    const where = `catalog[${i}]`;
    if (!isObject(e)) throw new Error(`${where} is not an object`);
    if (typeof e.id !== 'string' || !ACTION_ID.test(e.id)) throw new Error(`${where} has no usable id`);
    if (byId.has(e.id)) throw new Error(`${where}: ${e.id} is listed twice`);
    if (typeof e.class !== 'string' || !CLASS_ID.test(e.class)) throw new Error(`${e.id}: no usable class`);
    if (!TIERS.includes(e.tier)) throw new Error(`${e.id}: tier must be one of ${TIERS.join(', ')}`);
    if (e.tier === 'T3') throw new Error(`${e.id}: a T3 entry never acts, so it has no place in the catalog`);
    if (!TARGET_KINDS.has(e.targetKind)) throw new Error(`${e.id}: unknown target kind`);
    if (!Array.isArray(e.verbs) || e.verbs.length === 0) throw new Error(`${e.id}: declares no verbs`);
    if (new Set(e.verbs).size !== e.verbs.length) throw new Error(`${e.id}: a verb is listed twice`);
    const floor = floorOf(e.verbs);
    if (floor === null) throw new Error(`${e.id}: declares a verb the floor table doesn't know`);
    if (rank(e.tier) < rank(floor)) throw new Error(`${e.id}: tier ${e.tier} is below its verbs' floor of ${floor}`);
    if (!Number.isInteger(e.settleMs) || e.settleMs <= 0 || e.settleMs > SETTLE_MAX_MS) throw new Error(`${e.id}: settle time must be 1 ms to 10 minutes`);
    byId.set(e.id, Object.freeze({ ...e, verbs: Object.freeze([...e.verbs]), floor }));
  }
  return byId;
}

// The tools an entry may use: those for its declared verbs, and nothing else. A
// declared verb with no tool is a fault in the runner's wiring, so it throws.
export function toolsFor(entry, tools) {
  const out = {};
  for (const verb of entry.verbs) {
    if (!isObject(tools) || !Object.hasOwn(tools, verb) || typeof tools[verb] !== 'function') {
      throw new Error(`${entry.id}: no tool for its verb ${verb}`);
    }
    out[verb] = tools[verb];
  }
  return Object.freeze(out);
}

// ---- config ----

const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The block in config.json (gitignored: the real labels live there):
//
//   "heal": {
//     "enabled": true,
//     "targets": { "nas-mount": { "label": "com.example.nas-mount", "actions": ["mark-quiet"] } },
//     "off": []
//   }
//
// Off unless `enabled` is exactly true. A target names one launchd label and the
// catalog actions it allows; nothing heals a job that isn't listed. `off` turns single
// catalog entries off. A bad entry is left out and described in `problems`.
export function readHealConfig(config, catalog = loadCatalog(CATALOG)) {
  const problems = [];
  const out = { enabled: false, targets: new Map(), off: new Set(), problems };
  const raw = config?.heal;
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    problems.push('heal is not an object');
    return out;
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') problems.push('heal.enabled must be true or false');
  out.enabled = raw.enabled === true;
  if (raw.off !== undefined) {
    if (!Array.isArray(raw.off)) problems.push('heal.off is not a list');
    else for (const id of raw.off) {
      if (typeof id === 'string' && catalog.has(id)) out.off.add(id);
      else problems.push(`heal.off: ${JSON.stringify(id)} is not a catalog action`);
    }
  }
  if (raw.targets === undefined) return out;
  if (!isObject(raw.targets)) {
    problems.push('heal.targets is not an object');
    return out;
  }
  for (const id of Object.keys(raw.targets)) {
    const where = `heal.targets.${id}`;
    if (!TARGET_ID.test(id)) { problems.push(`heal.targets: ${JSON.stringify(id)} is not a usable id`); continue; }
    const t = raw.targets[id];
    if (!isObject(t)) { problems.push(`${where} is not an object`); continue; }
    if (typeof t.label !== 'string' || !LAUNCHD_LABEL.test(t.label)) { problems.push(`${where}: label is not a launchd label`); continue; }
    if (out.targets.has(t.label)) { problems.push(`${where}: its label is listed for another target`); continue; }
    if (!Array.isArray(t.actions)) { problems.push(`${where}: actions must be a list of catalog actions`); continue; }
    const actions = new Set();
    for (const a of t.actions) {
      if (typeof a === 'string' && catalog.has(a) && catalog.get(a).targetKind === 'job') actions.add(a);
      else problems.push(`${where}: ${JSON.stringify(a)} is not a catalog action for a job`);
    }
    out.targets.set(t.label, Object.freeze({ id, label: t.label, actions }));
  }
  return out;
}

// ---- launchctl print, the two readings ----

// launchd's own interval for a StartInterval job: "\trun interval = 180 seconds",
// top level only (one tab in). Anything outside 10 s to 31 days reads as none.
const RUN_INTERVAL = /^\trun interval = (\d+) seconds?\s*$/m;
export function parseRunInterval(raw) {
  const m = RUN_INTERVAL.exec(String(raw ?? ''));
  if (!m) return null;
  const s = Number(m[1]);
  return s >= 10 && s <= 31 * 24 * 3600 ? s : null;
}

// Two readings of one job: is there proof that it ran, and ran clean, in between?
//   clean       the run counter rose and the last exit was 0 at both
//   unreadable  either reading has no counter
//   exit        a last exit that isn't 0 (a signal reads as no exit, so not 0 either)
//   reset       the counter went down: launchd loaded the job again in between
//   flat        the counter didn't move: no run since the first reading
// A crash-looping job raises the counter too, which is why the exit counts at both.
export function judgeReadings(a, b) {
  if (!Number.isInteger(a?.runs) || !Number.isInteger(b?.runs)) return 'unreadable';
  if (a.lastExit !== 0 || b.lastExit !== 0) return 'exit';
  if (b.runs < a.runs) return 'reset';
  if (b.runs === a.runs) return 'flat';
  return 'clean';
}

// ---- the ledger's lines (data/heals.json) ----

export const LEDGER_KEEP_MS = 30 * DAY;
export const LEDGER_MAX = 2000;
export const OUTCOMES = Object.freeze(['healed', 'escalated', 'relapsed', 'cleared']);

// Why a loop closed as it did, in fixed words. A ledger line holds the key; the page
// gets the words.
export const WHY_WORDS = Object.freeze({
  clean: "launchd's run counter rose and its last exit was 0",
  unreadable: "launchd couldn't be read",
  exit: 'its last exit was not 0',
  flat: "launchd's run counter didn't move",
  reset: 'launchd loaded it again in between, so the counter proves nothing',
  'no-schedule': 'no schedule to check it against',
  'cap-target': `it was already healed ${PER_TARGET_DAY} times in 24 hours`,
  'cap-day': `the day's ${PER_DAY} heals are used`,
  'came-back': 'it came back within an hour of a heal',
  ledger: "the heal ledger couldn't be written",
  'log-written': 'its log was written again'
});

const isLine = l => isObject(l) && Number.isFinite(l.at) && typeof l.target === 'string' && OUTCOMES.includes(l.outcome) &&
  typeof l.action === 'string' && typeof l.class === 'string' && TIERS.includes(l.tier);

// What a ledger file holds, read defensively: well-formed lines of the last 30 days,
// oldest first, at most LEDGER_MAX of them.
export function keptLines(list, now) {
  if (!Array.isArray(list)) return [];
  return list.filter(l => isLine(l) && now - l.at <= LEDGER_KEEP_MS).sort((a, b) => a.at - b.at).slice(-LEDGER_MAX);
}

// Healed lines, one per instance (target and since), the first of each: the same
// instance checked again after a restart (the quiet marks live in memory) or after the
// kill switch is not a second heal, for the caps or for the weekly counts.
export function distinctHeals(lines) {
  const out = [];
  for (const l of lines) {
    if (l.outcome !== 'healed') continue;
    if (out.some(o => o.target === l.target && sameSince(o.since, l.since))) continue;
    out.push(l);
  }
  return out;
}

// The rate limits for a new loop on `target` (design §4.6), as the WHY key that stops
// it, or null. `endedAt` is when this target's last healed loop ended, if known. A
// comeback is another instance (`since`) healed within the hour: the same instance
// checked again (after the kill switch, or a restart) is no comeback.
export function capStop(lines, target, now, endedAt = null, since = null) {
  const healed = distinctHeals(lines).filter(l => now - l.at < DAY);
  if (healed.length >= PER_DAY) return 'cap-day';
  const mine = healed.filter(l => l.target === target);
  if (mine.length >= PER_TARGET_DAY) return 'cap-target';
  const lastHeal = mine.filter(l => !sameSince(l.since, since)).reduce((m, l) => Math.max(m, l.at), -Infinity);
  if (now - lastHeal < COMEBACK_MS || (Number.isFinite(endedAt) && now - endedAt < COMEBACK_MS)) return 'came-back';
  return null;
}

// ---- the page's view (GET /api/loops, and `loops` in /api/dashboard) ----

export const RECENT_MS = 7 * DAY;
export const RECENT_MAX = 20;
export const CLASS_WORDS = Object.freeze({ 'stale-log': 'stale log' });
export const OUTCOME_WORDS = Object.freeze({
  healed: 'quiet, ran clean',
  escalated: 'left as it was',
  relapsed: 'quiet lifted',
  cleared: 'cleared on its own'
});
export const STATUS_WHY = Object.freeze({
  unset: 'heal.enabled is not true in config.json',
  killed: 'the kill switch is on (the heal-off file is there)',
  catalog: 'the catalog was refused at start',
  ledger: "the heal ledger couldn't be read at start"
});

// A target's name on the page: config's job name for its label, else the label's last
// part, as the health strip names jobs. A target no longer in config goes by its id.
export function targetName(id, settings, jobNames = {}) {
  for (const t of settings?.targets?.values?.() ?? []) if (t.id === id) return jobDisplayName(t.label, jobNames);
  return id;
}

// Healed loops per class, per week, oldest week first, the last of them ending now.
export function weeklyCounts(lines, now, weeks = 4) {
  const out = new Map();
  for (const l of distinctHeals(lines)) {
    const back = Math.floor((now - l.at) / (7 * DAY));
    if (back < 0 || back >= weeks) continue;
    if (!out.has(l.class)) out.set(l.class, new Array(weeks).fill(0));
    out.get(l.class)[weeks - 1 - back]++;
  }
  return [...out].map(([cls, counts]) => ({ class: cls, label: CLASS_WORDS[cls] ?? cls, counts }));
}

// Built field by field: no label, path or reading leaves this function.
export function buildLoopsView({ status, why = null, open = [], quiet = [], held = [], lines = [], settings, jobNames = {}, now }) {
  const name = id => targetName(id, settings, jobNames);
  const recent = lines.filter(l => now - l.at <= RECENT_MS).sort((a, b) => b.at - a.at).slice(0, RECENT_MAX).map(l => ({
    name: name(l.target),
    class: l.class,
    classLabel: CLASS_WORDS[l.class] ?? l.class,
    action: l.action,
    tier: l.tier,
    outcome: l.outcome,
    words: OUTCOME_WORDS[l.outcome],
    why: typeof l.why === 'string' && Object.hasOwn(WHY_WORDS, l.why) ? WHY_WORDS[l.why] : null,
    at: l.at
  }));
  return {
    status,
    why,
    open: open.map(o => ({
      name: name(o.target), class: o.class, classLabel: CLASS_WORDS[o.class] ?? o.class, action: o.action, tier: o.tier,
      step: o.step, detectedAt: o.detectedAt, nextCheckAt: o.nextCheckAt, holdUntil: o.holdUntil
    })),
    quiet: quiet.map(q => ({ name: name(q.target), since: q.since, checkedAt: q.checkedAt, tier: q.tier })),
    held: held.map(h => ({ name: name(h.target), why: h.why })),
    recent,
    weeks: weeklyCounts(lines, now),
    generatedAt: now
  };
}
