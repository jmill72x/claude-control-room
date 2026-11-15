// Self-healing loop 2 (design §7, "Loop 2"): a scheduled run missed during a restart.
// T2: the loop proposes, and only the owner's tap acts.
//
//   1. Detect. the machine's read-only `missed-runs --since boot --json` runs at the
//      server's start (the first time it sees this boot) and then once a day. A job it
//      lists in `needs_look` whose last missed fire fell in a restart or a sleep gap,
//      and that has not run since, is one instance: its config target plus the missed
//      fire's time. Only jobs config lists as heal targets count.
//   2. Diagnose (T0). One `launchctl print` of the job: its run counter, kept as the
//      proof that it has not run since. A job launchd can't be read for gets no card.
//   3. Propose. A card in Needs you: "Run it now" for a target whose actions list
//      `rerun-job`, "Ack until its next run" for one that lists `ack-until-next-run`,
//      and "Not now". It is pushed once (counted, never named), except between 22:00
//      and 07:00, when it waits for the morning. It expires 2 hours after its push.
//      A run of the job in the meantime (the counter rose) closes it as cleared.
//   4. Act, on a tap only (lib/heal-routes.mjs checks the device). Run it now re-reads
//      launchd (the counter must not have moved, and the job must not be running),
//      writes a `tapped` ledger line, then runs the catalog's fixed program:
//      `launchctl kickstart gui/<uid>/<label>` (no -k), the label from config. Ack
//      writes the ledger line, then the ack, by "heal", until the next run plus 2 hours.
//   5. Verify. Within the entry's 10 minutes, the counter must rise and the job end with
//      exit 0: healed. Otherwise the loop goes to T3: a high-priority push.
//
// Guardrails (design §4): no model and no text from outside in the action path (the
// label is config's, the program is the catalog's); one attempt per instance (the id is
// spent on the tap, and the ledger's `tapped` line survives a restart); at most 3 T2
// actions per target and 20 in all in 24 hours, and loop 1's heal caps; the kill switch
// and config's `heal.enabled` hold every tap and every read; "can't tell" never acts.
import { randomBytes } from 'node:crypto';
import { sameSince, makeAck } from './acks.mjs';
import { oneLine } from './chat-events.mjs';
import { parseLaunchctlPrint, LAUNCHD_LABEL } from './health.mjs';
import {
  CATALOG, loadCatalog, toolsFor, capStop, targetName, CLOSING, CLASS_WORDS, WHY_WORDS, t2ActsToday,
  PROPOSAL_MS, QUIET_FROM_HOUR, QUIET_UNTIL_HOUR, PER_TARGET_DAY, PER_DAY
} from './heal.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const CLASS = 'missed-run';
export const RERUN = 'rerun-job';
export const ACK = 'ack-until-next-run';
export const ACTIONS = Object.freeze([RERUN, ACK]);
export const SCAN_EVERY_MS = DAY;
export const SCAN_RETRY_MS = 10 * MIN;
// The outages a missed fire may fall in for a card: a restart (the runs are lost for
// good) or a gap in the heartbeat with no run after it. "No run logged" with no outage
// is a failure of another kind (class 1), and an "uncertain" gap may have run on wake.
export const MISSED_WHYS = Object.freeze(['restart', 'gap']);
export const ACK_NOTE = 'missed during a restart: Ack until its next run, from the Loops card';

// The pushes. Counted, never named (README, "Push notifications"); the page names the job.
export const proposalPush = n => `${n} scheduled run${n === 1 ? '' : 's'} missed during a restart ${n === 1 ? 'waits' : 'wait'} for your tap: Needs you on the Control Room.`;
export const PAGE_PUSH = "A missed-run heal needs a look: a job didn't run clean after Run it now. The Loops panel on the Control Room says which.";

// "2026-11-06T16:45" as missed-runs writes it (local time, no zone), in ms, or null.
const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
export function localTime(s) {
  const m = LOCAL_ISO.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, m[6] === undefined ? 0 : Number(m[6]));
  // A time that rolled over is not the one written. A day past the month's end or a
  // month past 12 moves the month, and an hour past 23 or a minute past 59 moves the
  // hour (two digits at most), so the month and the hour are enough.
  if (t.getMonth() !== mo - 1 || t.getHours() !== h) return null;
  return t.getTime();
}

// Between 22:00 and 07:00 by the server's clock, a card waits without a push.
export function inQuietHours(ms) {
  const h = new Date(ms).getHours();
  return h >= QUIET_FROM_HOUR || h < QUIET_UNTIL_HOUR;
}

// The instances a missed-runs report holds: [{ label, missedAt, why, count }], one per
// job, its latest missed fire. Throws when the report isn't one.
export function missedFromReport(report) {
  if (!isObject(report) || !Array.isArray(report.jobs) || !Array.isArray(report.needs_look)) throw new Error('not a missed-runs report');
  const look = new Set(report.needs_look.filter(l => typeof l === 'string'));
  const out = [];
  const seen = new Set();
  for (const j of report.jobs) {
    if (!isObject(j) || typeof j.label !== 'string' || !LAUNCHD_LABEL.test(j.label) || !look.has(j.label) || seen.has(j.label)) continue;
    // Not loaded: launchd won't run it, so a kickstart can't help (another class).
    if (j.loaded === false) continue;
    const r = j.result;
    if (!isObject(r) || r.unresolved !== true || !Array.isArray(r.missed) || r.missed.length === 0) continue;
    const last = r.missed[r.missed.length - 1];
    if (!isObject(last) || !MISSED_WHYS.includes(last.why) || last.uncertain === true) continue;
    const missedAt = localTime(last.at);
    if (missedAt === null) continue;
    const lastRun = localTime(j.last_run);
    const count = r.missed.filter(m => isObject(m) && localTime(m.at) !== null && (lastRun === null || localTime(m.at) > lastRun)).length;
    seen.add(j.label);
    out.push({ label: j.label, missedAt, why: last.why, count: Math.max(1, count) });
  }
  return out;
}

// One launchd reading, or null when there is none to trust.
const reading = raw => {
  const p = parseLaunchctlPrint(raw);
  return Number.isInteger(p.runs) ? { runs: p.runs, lastExit: p.lastExit, running: p.state === 'running' } : null;
};

// `status()` is the heal runner's (lib/heal-runner.mjs): one switch for both loops.
// `launchctlPrint(label)` is the read; `runProgram(entry, { uid, label })` runs the
// entry's catalog program (lib/heal-programs.mjs); `missedRuns()` answers the report; `addAck(ack, now)` stores an
// ack (server/acks.mjs). `notify(message, { priority })` pushes; `onAck(stored)` hears
// each ack made, for its log line and notice.
export function createMissedRunLoops({
  settings,
  ledger,
  status,
  launchctlPrint,
  runProgram,
  missedRuns = null,
  addAck,
  // This process's own uid, never a fallback: heal-programs.mjs checks it again at use.
  uid = process.getuid(),
  catalogEntries = CATALOG,
  jobNames = {},
  now = () => Date.now(),
  log = console.error,
  notify = async () => ({ sent: false }),
  onAck = () => {},
  autoScan = true
}) {
  let catalogProblem = null;
  let rerun = null, ack = null, rerunTools = null, ackTools = null;
  try {
    const catalog = loadCatalog(catalogEntries);
    rerun = catalog.get(RERUN) ?? null;
    ack = catalog.get(ACK) ?? null;
    if (!rerun || !ack) throw new Error('the catalog has no rerun-job or ack-until-next-run entry');
    rerunTools = toolsFor(rerun, {
      'launchctl:print': label => launchctlPrint(label),
      // The only launchctl write in this file: the catalog's own arguments, filled in
      // with this user's uid and the label from config (lib/heal.mjs, programArgs).
      'launchctl:kickstart': label => runProgram(rerun, { uid, label })
    });
    ackTools = toolsFor(ack, { 'alert:ack': (made, at) => addAck(made, at) });
  } catch (err) {
    catalogProblem = err?.message ?? String(err);
  }

  let found = new Map();       // label -> the last scan's instance
  const proposals = new Map(); // id -> the card
  const verifying = new Map(); // label -> a run started by a tap
  const unreadable = new Set(); // labels whose first reading failed (logged once)
  let lastCrons = new Map();
  let scanDueAt = -Infinity;
  let scanning = null;
  let resumed = false;

  const on = () => !catalogProblem && settings?.enabled === true && status().status === 'on';
  const targetFor = label => settings?.targets?.get?.(label) ?? null;
  const nameOf = id => targetName(id, settings, jobNames);
  const offeredFor = t => ACTIONS.filter(a => t.actions.has(a) && !settings.off.has(a));

  async function read(label) {
    try { return reading(await rerunTools['launchctl:print'](label)); } catch { return null; }
  }

  const linesOf = (targetId, since) => ledger.lines().filter(l => l.class === CLASS && l.target === targetId && sameSince(l.since, since));
  // One attempt per instance: a closed one has its closing line, and a started run has
  // its `tapped` line (written before the program runs). The card loop also skips a run
  // in `verifying`, and an instance closed in this run (`closedHere`).
  const spent = (targetId, since) => linesOf(targetId, since).some(l => CLOSING.includes(l.outcome) || l.outcome === 'tapped');

  const lineOf = (p, action, tier, outcome, why, at, extra = {}) => ({
    at, class: CLASS, action, tier, target: p.target, since: p.missedAt, detectedAt: p.detectedAt, outcome, why, ...extra
  });

  // A loop's last line, then gone. A line that can't be written is logged; the card or
  // the run is gone from memory either way, and the instance is never offered again in
  // this run.
  const closedHere = new Set(); // `${target}@${since}` closed in this run, whatever the ledger says
  const instanceKey = (target, since) => `${target}@${since}`;
  async function closeProposal(p, outcome, why, at, extra = {}) {
    proposals.delete(p.id);
    closedHere.add(instanceKey(p.target, p.missedAt));
    log(`heal: missed run for ${p.target} ${outcome} (${why})`);
    // An escalation from a card is a page (T3); every other close stays T2.
    try { await ledger.append(lineOf(p, extra.action ?? p.offered[0], outcome === 'escalated' ? 'T3' : 'T2', outcome, why, at, extra.line ?? {})); } catch (err) {
      log(`heal: the ledger line could not be written (${err?.code ?? err?.name ?? 'error'})`);
    }
  }
  async function page(why) {
    try { await notify(PAGE_PUSH, { priority: 'high' }); } catch (err) { log(`heal: the page could not be sent (${err?.code ?? err?.name ?? why})`); }
  }
  async function closeRun(v, outcome, why, at, after = null) {
    verifying.delete(v.label);
    closedHere.add(instanceKey(v.target, v.missedAt));
    const tier = outcome === 'healed' ? 'T2' : 'T3';
    log(`heal: ${RERUN} ${outcome} for ${v.target} (${why})${tier === 'T3' ? '; paged' : ''}`);
    try {
      await ledger.append({ at, class: CLASS, action: RERUN, tier, target: v.target, since: v.missedAt, detectedAt: v.detectedAt, outcome, why, runs: [v.before, Number.isInteger(after?.runs) ? after.runs : null] });
    } catch (err) {
      log(`heal: the ledger line could not be written (${err?.code ?? err?.name ?? 'error'})`);
    }
    if (tier === 'T3') await page(why);
  }

  // After a restart: a run started (`tapped`) with no closing line is checked again if
  // its 10 minutes aren't up, else it goes to T3 (nobody saw it end).
  async function resume(at) {
    resumed = true;
    const lines = ledger.lines().filter(l => l.class === CLASS);
    for (const l of lines) {
      if (l.outcome !== 'tapped') continue;
      const rest = lines.filter(x => x.target === l.target && sameSince(x.since, l.since) && x.at >= l.at && x !== l);
      if (rest.some(x => CLOSING.includes(x.outcome))) continue;
      const t = [...(settings?.targets?.values?.() ?? [])].find(x => x.id === l.target);
      if (!t) continue;
      const v = { label: t.label, target: t.id, missedAt: l.since, detectedAt: l.detectedAt ?? l.at, before: Array.isArray(l.runs) ? l.runs[0] : null, startedAt: l.at, deadline: l.at + rerun.settleMs };
      if (!Number.isInteger(v.before) || at >= v.deadline) await closeRun(v, 'escalated', 'unverified', at);
      else verifying.set(t.label, v);
    }
  }

  async function verify(v, at) {
    const r = await read(v.label);
    if (r && r.runs < v.before) return closeRun(v, 'escalated', 'reset', at, r);
    if (r && r.runs > v.before && !r.running) return closeRun(v, r.lastExit === 0 ? 'healed' : 'escalated', r.lastExit === 0 ? 'clean' : 'exit', at, r);
    if (at < v.deadline) return null;
    if (!r) return closeRun(v, 'escalated', 'unreadable', at);
    return closeRun(v, 'escalated', r.runs > v.before ? 'still-running' : 'flat', at, r);
  }

  // The rate limits for a tap (design §4.6): T2 actions per target and in all, and for
  // a run, loop 1's heal caps (a heal of this target within the hour, the day's 20).
  function tapStop(p, action, at) {
    const lines = ledger.lines();
    // The day's 20 count every loop's T2 actions (L11, the shared helper); the 3 per target, this loop's.
    const acts = t2ActsToday(lines, at);
    if (acts.length >= PER_DAY) return 'cap-day';
    if (acts.filter(l => l.class === CLASS && l.target === p.target).length >= PER_TARGET_DAY) return 'cap-target';
    return action === RERUN ? capStop(lines, p.target, at, null, p.missedAt) : null;
  }

  async function scan() {
    if (!missedRuns || !on()) return null;
    try {
      const list = missedFromReport(await missedRuns());
      found = new Map(list.filter(m => targetFor(m.label) && offeredFor(targetFor(m.label)).length).map(m => [m.label, m]));
      scanDueAt = now() + SCAN_EVERY_MS;
      log(`heal: missed-runs read, ${found.size} missed run${found.size === 1 ? '' : 's'} for a heal target`);
      return found.size;
    } catch (err) {
      scanDueAt = now() + SCAN_RETRY_MS;
      log(`heal: missed-runs could not be read (${err?.code ?? err?.name ?? 'error'}); tried again in 10 minutes`);
      return null;
    }
  }

  return {
    catalogProblem: () => catalogProblem,
    scan,
    // For tests: the scan a pass started, if one is going.
    scanning: () => scanning,

    // One crons pass (every minute). Makes the cards the last scan found, closes those
    // whose job has run since or whose 2 hours are up, pushes new ones (not at night),
    // and checks the runs a tap started. Nothing is read while heals are off.
    async pass(crons) {
      const at = now();
      if (Array.isArray(crons)) lastCrons = new Map(crons.filter(c => typeof c?.label === 'string').map(c => [c.label, c]));
      if (!on()) return;
      if (!resumed) await resume(at);
      if (autoScan && missedRuns && at >= scanDueAt && !scanning) {
        scanning = scan().finally(() => { scanning = null; });
      }

      const live = new Set([...proposals.values()].map(p => p.label));
      const made = new Set(); // cards made in this pass were read just now
      for (const m of found.values()) {
        const t = targetFor(m.label);
        // Two guards for one rule (Ultron's M1): a run in flight is in `verifying`, and its
        // `tapped` line makes it `spent`. Each is tested apart (heal-missed.test.mjs).
        if (!t || live.has(m.label) || verifying.has(m.label)) continue;
        if (closedHere.has(instanceKey(t.id, m.missedAt)) || spent(t.id, m.missedAt)) continue;
        const r = await read(m.label);
        if (!r) {
          if (!unreadable.has(m.label)) log(`heal: launchd couldn't be read for ${t.id}; no card until it can`);
          unreadable.add(m.label);
          continue;
        }
        unreadable.delete(m.label);
        const pushed = linesOf(t.id, m.missedAt).find(l => l.outcome === 'proposed');
        const p = {
          // The label the card reads and runs is config's target's (L7), never the report's.
          id: randomBytes(16).toString('hex'), label: t.label, target: t.id, missedAt: m.missedAt, why: m.why, count: m.count,
          runs: r.runs, offered: offeredFor(t), state: 'waiting', detectedAt: at, announcedAt: pushed ? pushed.at : null
        };
        proposals.set(p.id, p);
        made.add(p.id);
        live.add(m.label);
        log(`heal: a card for ${t.id}'s missed run (${m.why})`);
      }

      const announce = [];
      for (const p of [...proposals.values()]) {
        if (p.state !== 'waiting') continue;
        const r = made.has(p.id) ? null : await read(p.label);
        // A tap may have taken the card while launchd was read (M1).
        if (p.state !== 'waiting' || !proposals.has(p.id)) continue;
        if (r && r.runs !== p.runs) { await closeProposal(p, 'cleared', 'ran-since', at); continue; }
        if (p.announcedAt !== null && at - p.announcedAt >= PROPOSAL_MS) { await closeProposal(p, 'expired', 'no-tap', at); continue; }
        if (p.announcedAt === null && !inQuietHours(at)) announce.push(p);
      }
      // The mark first, so a restart doesn't push the same card again; then one push.
      let told = 0;
      for (const p of announce) {
        try {
          await ledger.append(lineOf(p, p.offered[0], 'T2', 'proposed', p.why, at));
          p.announcedAt = at;
          told++;
        } catch (err) {
          log(`heal: the ledger line could not be written (${err?.code ?? err?.name ?? 'error'}); the card's push waits`);
        }
      }
      if (told) {
        try { await notify(proposalPush(told), { priority: 'default' }); } catch (err) { log(`heal: the card's push failed (${err?.code ?? err?.name ?? 'error'})`); }
      }

      for (const v of [...verifying.values()]) await verify(v, at);
    },

    // A tap: `action` is rerun-job or ack-until-next-run; `by` the device's name.
    // Answers { status, ok, error?, name?, ... } for the route.
    async approve(id, action, by) {
      const at = now();
      if (catalogProblem || settings?.enabled !== true) return { status: 503, error: 'heals are not set up on this server' };
      const st = status();
      if (st.status !== 'on') return { status: 503, error: `heals are off: ${st.why ?? 'not on'}` };
      // A Map has no inherited keys, and the route takes only 32 hex characters.
      const p = proposals.get(id);
      if (!p) return { status: 404, error: 'that card is no longer open; the page shows the ones that are' };
      if (p.state !== 'waiting') return { status: 409, error: 'that card was already answered' };
      if (!ACTIONS.includes(action) || !p.offered.includes(action)) return { status: 400, error: 'that card does not offer that action' };
      if (settings.off.has(action)) return { status: 403, error: `${action} is off in config.json` };
      const name = nameOf(p.target);
      const capped = tapStop(p, action, at);
      if (capped) return { status: 429, error: `not now: ${WHY_WORDS[capped]}`, name };
      // Spent here, before anything waits: a second tap, from any device, finds it taken.
      p.state = 'acting';
      const back = () => { if (proposals.has(p.id)) p.state = 'waiting'; };

      if (action === ACK) {
        const cron = lastCrons.get(p.label) ?? null;
        // Without the job's instance and next run, "until its next run" means nothing (L2).
        if (!Number.isFinite(cron?.lastRunAt) || !Number.isFinite(cron?.nextRunAt)) {
          back();
          return { status: 409, error: "its next run isn't known; ack it from the alert", name };
        }
        const made = makeAck({ kind: 'cron', key: `cron:launchd:${p.label}`, since: cron?.lastRunAt, nextRunAt: cron?.nextRunAt }, { by: 'heal', note: ACK_NOTE }, at);
        if (!made.ok) { back(); return { status: 409, error: made.error, name }; }
        try {
          await ledger.append(lineOf(p, ACK, 'T2', 'acked', 'acked', at, { by, until: made.value.until }));
        } catch {
          back();
          return { status: 503, error: "the heal ledger couldn't be written, so nothing was acked" };
        }
        proposals.delete(p.id);
        closedHere.add(instanceKey(p.target, p.missedAt));
        let list;
        try {
          list = await ackTools['alert:ack'](made.value, at);
        } catch (err) {
          log(`heal: the ack for ${p.target} could not be saved (${err?.code ?? err?.name ?? 'error'})`);
          try { await ledger.append(lineOf(p, ACK, 'T3', 'escalated', 'ack-failed', at)); } catch { /* logged above */ }
          await page('ack-failed');
          return { status: 500, error: "the acknowledgement couldn't be saved", name };
        }
        const stored = Array.isArray(list) ? list.find(a => a.key === made.value.key) ?? made.value : made.value;
        log(oneLine(`heal: ${ACK} for ${p.target} by ${by}`));
        try { onAck(stored); } catch { /* the notice is best effort */ }
        return { status: 200, ok: true, name, action, until: stored.until };
      }

      // Run it now: the precondition again, then the line, then the program.
      const r = await read(p.label);
      if (!on()) { back(); return { status: 503, error: `heals are off: ${status().why ?? 'not on'}` }; }
      if (!r) {
        await closeProposal(p, 'escalated', 'unreadable', at, { action: RERUN });
        await page('unreadable');
        return { status: 503, error: "launchd couldn't be read, so it wasn't run; run it at the terminal", name };
      }
      if (r.runs !== p.runs) {
        await closeProposal(p, 'cleared', 'ran-since', at, { action: RERUN });
        return { status: 409, error: 'it has run since the card was made, so it was not run again', name };
      }
      if (r.running) { back(); return { status: 409, error: 'it is running now; try again when it ends', name }; }
      try {
        await ledger.append(lineOf(p, RERUN, 'T2', 'tapped', 'tapped', at, { by, runs: [r.runs, null] }));
      } catch {
        back();
        return { status: 503, error: "the heal ledger couldn't be written, so it wasn't run" };
      }
      // In flight before anything waits (M1): a pass during the program's run finds the
      // instance in `verifying` (and its `tapped` line) and makes no second card.
      const v = { label: p.label, target: p.target, missedAt: p.missedAt, detectedAt: p.detectedAt, before: r.runs, startedAt: at, deadline: at + rerun.settleMs };
      verifying.set(p.label, v);
      proposals.delete(p.id);
      try {
        await rerunTools['launchctl:kickstart'](p.label);
      } catch (err) {
        log(`heal: the catalog's program for ${RERUN} failed for ${p.target} (${err?.code ?? err?.signal ?? 'error'})`);
        await closeRun(v, 'escalated', 'start-failed', at);
        return { status: 502, error: "launchd wouldn't start it; it needs a look at the terminal", name };
      }
      log(oneLine(`heal: ${RERUN} started for ${p.target} by ${by}`));
      return { status: 202, ok: true, name, action, checkBy: at + rerun.settleMs };
    },

    // Not now: the card closes, and this instance is never offered again.
    async decline(id, by) {
      const at = now();
      if (catalogProblem || settings?.enabled !== true) return { status: 503, error: 'heals are not set up on this server' };
      const p = proposals.get(id);
      if (!p) return { status: 404, error: 'that card is no longer open; the page shows the ones that are' };
      if (p.state !== 'waiting') return { status: 409, error: 'that card was already answered' };
      p.state = 'acting';
      await closeProposal(p, 'declined', 'not-now', at, { line: { by } });
      return { status: 200, ok: true, name: nameOf(p.target), action: 'not-now' };
    },

    // The page's part (lib/heal.mjs, withMissedRuns): names only, no label or reading.
    view() {
      const at = now();
      const st = status();
      const live = on();
      const blocked = live ? null : catalogProblem ? 'the catalog was refused at start' : (st.why ?? 'heals are off');
      const cards = [...proposals.values()].sort((a, b) => a.missedAt - b.missedAt);
      return {
        proposals: cards.map(p => ({
          id: p.id,
          name: nameOf(p.target),
          class: CLASS,
          classLabel: CLASS_WORDS[CLASS],
          tier: 'T2',
          missedAt: p.missedAt,
          missedCount: p.count,
          why: p.why,
          fingerprint: WHY_WORDS[p.why] ?? null,
          actions: [...p.offered],
          state: p.state,
          proposedAt: p.detectedAt,
          expiresAt: p.announcedAt === null ? null : p.announcedAt + PROPOSAL_MS,
          nextRunAt: Number.isFinite(lastCrons.get(p.label)?.nextRunAt) ? lastCrons.get(p.label).nextRunAt : null,
          canAct: live && p.state === 'waiting',
          blocked
        })),
        open: [
          ...cards.map(p => ({ name: nameOf(p.target), class: CLASS, classLabel: CLASS_WORDS[CLASS], action: p.offered[0], tier: 'T2', step: 'acting', waiting: true, detectedAt: p.detectedAt, nextCheckAt: null, holdUntil: null })),
          ...[...verifying.values()].map(v => ({ name: nameOf(v.target), class: CLASS, classLabel: CLASS_WORDS[CLASS], action: RERUN, tier: 'T2', step: 'verifying', detectedAt: v.detectedAt, nextCheckAt: null, holdUntil: null, checkBy: v.deadline }))
        ],
        generatedAt: at
      };
    }
  };
}
