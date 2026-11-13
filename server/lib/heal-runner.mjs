// The heal runner (design §5.3): a module in the server that runs catalog actions.
// Loop 1 only, so far: the stale-log false "overdue" (T1, `mark-quiet`).
//
// Each crons pass hands it the panel after job-status's overlay (lib/health.mjs). A
// job that job-status calls failed for its log's age alone (`staleLog`), and that
// config lists as a heal target, opens a loop for that instance (its alert key plus
// `since`, the same pair an ack uses):
//
//   1. First reading: `launchctl print` (read-only). Its run counter, and a last exit
//      of 0. No counter, or another exit, escalates at once.
//   2. Second reading, one interval later (launchd's own `run interval`, plus a
//      minute), or for a calendar job after its next due time (plus two minutes).
//   3. The counter rose and the last exit was 0 at both: the ledger gets a line, then
//      the alert is marked quiet ("ran clean, its log is old"). Anything else escalates:
//      the alert stays as it was, red, and pushes.
//   4. While quiet, the same check repeats at every interval or due time. A failed
//      re-check lifts the quiet (`relapsed`), and that instance is never healed again.
//
// While a loop is checking, its alert carries `holdUntil` (at most 10 minutes after it
// was detected), and the notifier holds its push and event until then
// (collectors/notifier.mjs). A heal that works means no push and no event at all.
//
// Off unless config's `heal.enabled` is true. While the kill switch file exists, nothing
// is read or marked, every quiet mark is lifted at once, and the targets it would check
// show as held; the alert then pushes as it always has. "Can't tell" never acts: an
// unreadable launchd, a counter that went back (a reload) or a ledger that can't be
// written each leave the alert red.
import { sameSince } from './acks.mjs';
import { parseLaunchctlPrint } from './health.mjs';
import { cronOrder } from './parse-launchd.mjs';
import {
  CATALOG, loadCatalog, toolsFor, judgeReadings, parseRunInterval, capStop, buildLoopsView, STATUS_WHY,
  INTERVAL_MARGIN_MS, CALENDAR_GRACE_MS
} from './heal.mjs';

const DAY = 24 * 3600e3;
export const QUIET_WORDS = 'Quiet · ran clean';

// A crons-panel entry that loop 1 may look at: failed, for its log's age alone, with
// a known instance.
export const isStaleLogCandidate = c =>
  c?.state === 'failed' && c.ok === false && c.staleLog === true && typeof c.label === 'string' && Number.isFinite(c.lastRunAt);

export function createHealRunner({
  settings,
  catalogEntries = CATALOG,
  ledger,
  launchctlPrint,
  killed = () => false,
  jobNames = {},
  now = () => Date.now(),
  log = console.error
}) {
  let catalogProblem = null;
  let entry = null;
  let tools = null;
  const loops = new Map(); // label -> the open or quiet loop of its current instance
  const closed = new Map(); // label -> { since, at, outcome }: one attempt per instance
  const ended = new Map(); // target id -> when its last quiet loop ended
  let ledgerOk = false;
  let held = [];

  try {
    const catalog = loadCatalog(catalogEntries);
    entry = catalog.get('mark-quiet') ?? null;
    if (!entry) throw new Error('the catalog has no mark-quiet entry');
    tools = toolsFor(entry, {
      'launchctl:print': label => launchctlPrint(label),
      'alert:mark-quiet': (loop, at) => { loop.state = 'quiet'; loop.checkedAt = at; }
    });
  } catch (err) {
    catalogProblem = err?.message ?? String(err);
  }

  const isKilled = () => {
    try { return Boolean(killed()); } catch { return true; }
  };

  function status() {
    if (!settings?.enabled) return { status: 'unset', why: STATUS_WHY.unset };
    if (catalogProblem) return { status: 'off', why: STATUS_WHY.catalog };
    if (!ledgerOk) return { status: 'off', why: STATUS_WHY.ledger };
    if (isKilled()) return { status: 'killed', why: STATUS_WHY.killed };
    return { status: 'on', why: null };
  }

  async function read(label) {
    try {
      const raw = await tools['launchctl:print'](label);
      const p = parseLaunchctlPrint(raw);
      return { runs: p.runs, lastExit: p.lastExit, interval: parseRunInterval(raw) };
    } catch {
      return null;
    }
  }

  // When the next reading is due: one interval and a minute on, or two minutes past
  // the calendar's next due time. Null when neither is known.
  function nextDue(reading, cron, at) {
    if (Number.isInteger(reading?.interval)) return at + reading.interval * 1000 + INTERVAL_MARGIN_MS;
    if (Number.isFinite(cron?.nextRunAt) && cron.nextRunAt > at) return cron.nextRunAt + CALENDAR_GRACE_MS;
    return null;
  }

  const lineOf = (loop, outcome, why, at, b = null) => ({
    at, class: entry.class, action: entry.id, tier: entry.tier, target: loop.target,
    since: loop.since, detectedAt: loop.detectedAt, outcome, why,
    runs: [Number.isInteger(loop.a?.runs) ? loop.a.runs : null, Number.isInteger(b?.runs) ? b.runs : null]
  });

  // Close a loop: one ledger line, one log line, and (unless the instance is gone)
  // a record that this instance had its one attempt.
  async function close(loop, outcome, why, at, b = null) {
    loops.delete(loop.label);
    if (outcome !== 'cleared') closed.set(loop.label, { since: loop.since, at, outcome });
    log(`heal: ${entry.id} ${outcome} for ${loop.target} (${why})`);
    try {
      await ledger.append(lineOf(loop, outcome, why, at, b));
    } catch (err) {
      log(`heal: the ledger line could not be written (${err?.code ?? err?.name ?? 'error'})`);
    }
  }

  function apply(crons, at) {
    let changed = false;
    // Every loop left here is for a candidate's current instance: the pass removed the
    // others before it got this far.
    const out = crons.map(c => {
      const loop = loops.get(c?.label);
      if (!loop) return c;
      if (loop.state === 'quiet') {
        changed = true;
        return { ...c, ok: true, state: 'quiet', last: QUIET_WORDS, exit: null, quietAt: loop.checkedAt };
      }
      const holdUntil = loop.detectedAt + entry.settleMs;
      if (holdUntil <= at) return c;
      changed = true;
      return { ...c, holdUntil };
    });
    return changed ? out.sort(cronOrder) : crons;
  }

  const targetOf = c => {
    const t = settings?.targets?.get?.(c.label) ?? null;
    return t && t.actions.has(entry?.id) ? t : null;
  };

  return {
    // Reads the ledger. Until it has been read, and when it can't be, heals stay off.
    async load() {
      try {
        const n = await ledger.load();
        ledgerOk = true;
        return n;
      } catch (err) {
        ledgerOk = false;
        log(`heal: the ledger could not be read (${err?.code ?? err?.name ?? 'error'}); heals stay off`);
        return null;
      }
    },
    status,
    catalogProblem: () => catalogProblem,

    // One crons pass. Returns the panel with quiet marks and push holds applied.
    // `acked(cron)` says whether an ack covers that instance: an acked alert opens no loop.
    async pass(crons, { acked = () => false } = {}) {
      if (!Array.isArray(crons)) return crons;
      const at = now();
      const s = status().status;
      const candidates = crons.filter(isStaleLogCandidate);
      held = [];
      for (const [label, rec] of closed) if (at - rec.at > DAY) closed.delete(label);

      if (s !== 'on') {
        loops.clear();
        if (s !== 'unset') {
          for (const c of candidates) {
            const t = targetOf(c);
            if (t) held.push({ target: t.id, why: status().why });
          }
        }
        return crons;
      }

      // A loop whose instance is gone: the log was written (the alert cleared, or it
      // came back with a new `since`). A quiet one already has its line.
      for (const [label, loop] of [...loops]) {
        const c = candidates.find(x => x.label === label);
        if (c && sameSince(loop.since, c.lastRunAt)) continue;
        if (loop.state === 'quiet') {
          loops.delete(label);
          ended.set(loop.target, at);
        } else {
          await close(loop, 'cleared', 'log-written', at);
        }
      }

      for (const c of candidates) {
        const target = targetOf(c);
        if (!target) continue;
        if (settings.off.has(entry.id)) {
          held.push({ target: target.id, why: `${entry.id} is off in config.json` });
          continue;
        }
        if (acked(c)) continue;
        const rec = closed.get(c.label);
        if (rec && sameSince(rec.since, c.lastRunAt)) continue;

        let loop = loops.get(c.label);
        if (!loop) {
          loop = { label: c.label, target: target.id, since: c.lastRunAt, detectedAt: at, state: 'checking', a: null, dueAt: null, checkedAt: null };
          const stop = capStop(ledger.lines(), target.id, at, ended.get(target.id), c.lastRunAt);
          if (stop) { await close(loop, 'escalated', stop, at); continue; }
          if (isKilled()) { loops.clear(); return crons; }
          const a = await read(c.label);
          loop.a = a;
          if (!a || !Number.isInteger(a.runs)) { await close(loop, 'escalated', 'unreadable', at); continue; }
          if (a.lastExit !== 0) { await close(loop, 'escalated', 'exit', at); continue; }
          loop.dueAt = nextDue(a, c, at);
          if (loop.dueAt === null) { await close(loop, 'escalated', 'no-schedule', at); continue; }
          loops.set(c.label, loop);
          continue;
        }
        if (at < loop.dueAt) continue;

        if (isKilled()) { loops.clear(); return crons; }
        const b = await read(c.label);
        const verdict = judgeReadings(loop.a, b);
        if (verdict !== 'clean') {
          await close(loop, loop.state === 'quiet' ? 'relapsed' : 'escalated', verdict, at, b);
          continue;
        }
        const due = nextDue(b, c, at);
        if (due === null) {
          await close(loop, loop.state === 'quiet' ? 'relapsed' : 'escalated', 'no-schedule', at, b);
          continue;
        }
        if (loop.state === 'checking') {
          // The kill switch, once more after the reading: a kill that comes during the
          // ledger's write itself is honoured at the next pass, within a minute.
          if (isKilled()) { loops.clear(); return crons; }
          // The line first, then the mark: a heal the ledger can't record doesn't happen.
          try {
            await ledger.append(lineOf(loop, 'healed', 'clean', at, b));
          } catch (err) {
            log(`heal: the ledger line could not be written (${err?.code ?? err?.name ?? 'error'}); left as it was`);
            loops.delete(c.label);
            closed.set(c.label, { since: loop.since, at, outcome: 'escalated' });
            continue;
          }
          tools['alert:mark-quiet'](loop, at);
          log(`heal: ${entry.id} healed for ${loop.target} (${verdict})`);
        } else {
          loop.checkedAt = at;
        }
        loop.a = b;
        loop.dueAt = due;
      }
      return apply(crons, at);
    },

    // For the health strip's Jobs list: this instance is quiet now.
    quietOf(label, since) {
      if (status().status !== 'on') return null;
      const loop = loops.get(label);
      return loop?.state === 'quiet' && sameSince(loop.since, since) ? { at: loop.checkedAt } : null;
    },

    view() {
      const at = now();
      const { status: s, why } = status();
      const open = [], quiet = [];
      if (s === 'on') {
        for (const loop of loops.values()) {
          if (loop.state === 'quiet') quiet.push({ target: loop.target, since: loop.since, checkedAt: loop.checkedAt, tier: entry.tier });
          else open.push({ target: loop.target, class: entry.class, action: entry.id, tier: entry.tier, step: 'diagnosing', detectedAt: loop.detectedAt, nextCheckAt: loop.dueAt, holdUntil: loop.detectedAt + entry.settleMs });
        }
      }
      return buildLoopsView({ status: s, why, open, quiet, held, lines: ledger.lines(), settings, jobNames, now: at });
    }
  };
}
