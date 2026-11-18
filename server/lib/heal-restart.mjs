// Self-healing loop 3 (design §7, "Loop 3"): a restart of this server due after a merge.
// T2: the loop proposes, and only the owner's tap acts.
//
//   1. Detect. At start the server reads its checkout's HEAD (git-read, read-only): the
//      commit this process runs. Every 5 minutes it reads the checkout again (git status:
//      HEAD, the branch, tracked changes), and when the server's files differ between
//      the two commits (server/, plus the two page files read aloud runs in the server:
//      SERVER_PATHS in lib/heal-programs.mjs), a restart is due. A merge that touches
//      only the rest of web/ or docs/ opens nothing (the page is read from disk on every
//      request).
//   2. Propose. One card in Needs you, "Restart the Control Room (N merges)", N being the
//      commits on main's first-parent line since then that touch those files. A restart is
//      offered only for a checkout that is fit to run (Ultron's M1, 11-15): on `main`,
//      no tracked change or conflict, and HEAD a descendant of the running commit. One
//      that isn't (a feature branch, a rebase, a conflicted merge, a reset) shows the
//      card with its button off and the reason. A tappable card is pushed once, counted,
//      never from 22:00 to 07:00, and at most 1 an hour and 3 a day across cards (L6).
//      It stays until it is answered or the change is gone; a restart only gets more
//      due, so it never expires. Not now parks it until HEAD moves.
//   3. Act, on a tap only (lib/heal-routes.mjs checks the device). The card is taken at
//      once (before anything waits); the checkout is read again (fit, and still the HEAD
//      the card showed, else 409 "it moved", L5); launchd's own record of the job must
//      name this process's pid (`launchctl print`, a T0 read, L9); then a `verifying`
//      ledger line goes in with the expected commit, a one-time ref and the collectors
//      already failing (L3); the tap is answered; and a few seconds later (so the answer
//      and its alert go out first) the checkout is read once more (L1: moved or unfit
//      means no restart, and the card comes back) and the catalog's fixed program runs:
//      `launchctl kickstart -k gui/<uid>/<label>`, the label config's `self` target,
//      which must be the job launchd started this process as (XPC_SERVICE_NAME, and
//      launchd as the parent). launchd kills this process and starts it again.
//   4. Verify, in the new process. At its start it reads its own HEAD, finds the open
//      `verifying` line, and closes the loop as healed (old and new short hashes on the
//      Loops panel) once HEAD is the expected commit, the checkout is fit, and its first
//      collector pass ended with no failure that wasn't already there at the tap, all
//      within 10 minutes of the tap. Anything else is T3: one high-priority push. If
//      the old process is still here a minute after launchctl said yes (or launchctl
//      timed out), or launchctl failed, the old process pages. If no process comes
//      back at all, the channel's silent alert and the NAS box's page check notice.
//
// Guardrails (design §4): no model and no outside text in the action path (the label is
// config's and must be this process's own, the program is the catalog's); one attempt
// per instance (this process's commit and the HEAD it was offered); at most 3 restarts
// in 24 hours, and the day's 20 T2 actions across the loops; a restart is never offered
// while a restart is being checked, and only a tap ever starts one, so a HEAD that keeps
// moving costs cards, never restarts; the kill switch and config's `heal.enabled` hold
// every read and every tap; "can't tell" never acts.
import { randomBytes } from 'node:crypto';
import { oneLine } from './chat-events.mjs';
import { inQuietHours } from './heal-missed.mjs';
import { parseLaunchdPid } from './health.mjs';
import {
  CATALOG, loadCatalog, toolsFor, CLASS_WORDS, WHY_WORDS, PER_DAY, RESTARTS_PER_DAY, SETTLE_MAX_MS, shortCommit, t2ActsToday
} from './heal.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const CLASS = 'restart-due';
export const RESTART = 'restart-control-room';
export const ACTIONS = Object.freeze([RESTART]);
export const NAME = 'Control Room';
export const CHECK_EVERY_MS = 5 * MIN;
// The tap's answer, its log line and its alert go out before launchd kills this process.
export const KICK_DELAY_MS = 3e3;
// launchctl said yes (or timed out) and this process is still here: the restart didn't happen.
export const NO_RESTART_MS = MIN;
// The new process must have checked the restart within this long of the tap.
export const VERIFY_MS = SETTLE_MAX_MS;
// Card pushes across cards (L6): at most this many an hour and a day.
export const PUSHES_PER_HOUR = 1;
export const PUSHES_PER_DAY = 3;
const COLLECTOR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const names = list => list.filter(n => typeof n === 'string' && COLLECTOR_NAME.test(n)).slice(0, 10);

export const restartPush = n => `A Control Room restart waits for your tap (${n} merge${n === 1 ? '' : 's'} since it started): Needs you on the Control Room.`;
export const RESTART_PAGE = "A Control Room restart needs a look: it didn't come back as expected. The Loops panel on the Control Room says why.";

// `status()` is the heal runner's (lib/heal-runner.mjs): one switch for every loop.
// `git` is lib/heal-programs.mjs's checkout reader ({ head(), checkout(from),
// changed(from, to) }), or null when git-read isn't set up. `launchctlPrint(label)` is
// the read-only `launchctl print`. `runProgram(entry, { uid, label })` runs the entry's
// catalog program (runSelfRestart). `self` is what this process knows of itself:
// `label` (launchd's XPC_SERVICE_NAME), `launchd` (its parent is launchd) and `pid`.
// `firstPass()` resolves with the registry's first pass ({ failed: [names] });
// `failingNow()` names the collectors failing at this moment. `defer(fn, ms)` is
// setTimeout; `notify(message, { priority })` pushes.
export function createRestartLoop({
  settings,
  ledger,
  status,
  git = null,
  launchctlPrint = async () => { throw new Error('no launchctl print'); },
  runProgram,
  self = { label: null, launchd: false, pid: process.pid },
  firstPass = () => new Promise(() => {}),
  failingNow = () => [],
  uid = process.getuid(),
  catalogEntries = CATALOG,
  startedAt = Date.now(),
  now = () => Date.now(),
  log = console.error,
  notify = async () => ({ sent: false }),
  defer = (fn, ms) => setTimeout(fn, ms)
}) {
  let catalogProblem = null;
  let entry = null, tools = null;
  try {
    const catalog = loadCatalog(catalogEntries);
    entry = catalog.get(RESTART) ?? null;
    if (!entry) throw new Error('the catalog has no restart-control-room entry');
    tools = toolsFor(entry, {
      'git:read': (what, from, to) => (what === 'head' ? git.head() : what === 'checkout' ? git.checkout(from) : git.changed(from, to)),
      'launchctl:print': label => launchctlPrint(label),
      // The only launchctl write in this file: the catalog's own arguments, filled in with
      // this user's uid and config's self target's label (lib/heal.mjs, programArgs).
      'launchctl:kickstart-kill': label => runProgram(entry, { uid, label })
    });
  } catch (err) {
    catalogProblem = err?.message ?? String(err);
  }

  let startCommit = null;   // the commit this process runs, read at start
  let started = false;      // start() has read it (or failed to)
  let checked = false;      // start() has dealt with any restart to check
  let card = null;          // the one card: { id, head, merges, files, blockedWhy, state, detectedAt, announcedAt }
  let restarting = null;    // this process, after a tap: { ref, expected, at }
  let verifying = null;     // the new process, checking a restart: { ref, expected, from, at, deadline }
  let checking = false;     // a pass is reading git
  let declinedHead = null;  // Not now parks the card until HEAD moves
  const spentHeads = new Set(); // one attempt per instance: the HEADs a tap was spent on
  const said = new Set();   // log lines said once

  const target = () => [...(settings?.targets?.values?.() ?? [])].find(t => t.kind === 'self' && t.actions.has(RESTART)) ?? null;
  const selfOk = t => Boolean(t) && self?.launchd === true && typeof self?.label === 'string' && self.label === t.label;
  const ready = () => !catalogProblem && settings?.enabled === true && git !== null && started && checked;
  const on = () => ready() && status().status === 'on' && !settings.off.has(RESTART) && selfOk(target()) && startCommit !== null;
  const once = line => { if (!said.has(line)) { said.add(line); log(line); } };

  // A line about the card (its marks and the closes that page no one), so always T2.
  const lineOf = (outcome, why, at, extra = {}) => ({
    at, class: CLASS, action: RESTART, tier: 'T2', target: target().id, since: startedAt, detectedAt: card.detectedAt, outcome, why, ...extra
  });
  async function append(line) {
    try { await ledger.append(line); return true; } catch (err) {
      log(`heal: the ledger line could not be written (${err?.code ?? err?.name ?? 'error'})`);
      return false;
    }
  }
  async function page(why) {
    try { await notify(RESTART_PAGE, { priority: 'high' }); } catch (err) { log(`heal: the page could not be sent (${err?.code ?? err?.name ?? why})`); }
  }

  async function closeCard(outcome, why, at, extra = {}) {
    const line = lineOf(outcome, why, at, { from: startCommit, expected: card.head, ...extra });
    card = null;
    log(`heal: ${RESTART} ${outcome} (${why})`);
    await append(line);
  }

  // A restart's last line: written before the page, so a process that dies after it
  // never pages twice. `r` holds the ref that pairs it with its `verifying` line.
  // `paged: false` leaves the page to the caller (resume sends one for all, L7).
  async function closeRestart(r, outcome, why, at, extra = {}, { paged = true } = {}) {
    if (restarting === r) restarting = null;
    if (verifying === r) verifying = null;
    if (card?.state === 'restarting') card = null;
    log(`heal: ${RESTART} ${outcome} (${why})${outcome === 'escalated' && paged ? '; paged' : ''}`);
    await append({
      at, class: CLASS, action: RESTART, tier: outcome === 'escalated' ? 'T3' : 'T2', target: r.target, since: r.since,
      detectedAt: r.detectedAt, outcome, why, ref: r.ref, from: r.from, expected: r.expected, ...extra
    });
    if (outcome === 'escalated' && paged) await page(why);
  }

  // The new process: the restart a tap started, if its line has no closing line yet.
  // Every line it closes as escalated shares one page (L7).
  async function resume() {
    const lines = ledger.lines().filter(l => l.class === CLASS && typeof l.ref === 'string');
    const closed = new Set(lines.filter(l => l.outcome !== 'verifying').map(l => l.ref));
    const open = lines.filter(l => l.outcome === 'verifying' && !closed.has(l.ref));
    if (!open.length) return;
    const rec = l => ({
      ref: l.ref, target: l.target, since: l.since, detectedAt: l.detectedAt, from: l.from, expected: l.expected,
      before: Array.isArray(l.failing) ? l.failing : [], at: l.at, deadline: l.at + VERIFY_MS
    });
    let escalated = 0;
    const close = async (v, outcome, why, at, extra) => {
      if (outcome === 'escalated') escalated++;
      await closeRestart(v, outcome, why, at, extra, { paged: false });
    };
    try {
      // Heals that can't run here can't check it: say so once, and close it (L4).
      const st = catalogProblem ? 'off' : status().status;
      if (st !== 'on' && st !== 'killed') {
        log(`heal: a restart can't be checked: heals are ${st}`);
        for (const l of open) await close(rec(l), 'escalated', 'heals-off-unchecked', now());
        return;
      }
      // Only the newest can be this restart; an older open one was never checked.
      for (const l of open.slice(0, -1)) await close(rec(l), 'escalated', 'not-checked', now());
      const v = rec(open[open.length - 1]);
      verifying = v;
      const at = now();
      if (at > v.deadline) return await close(v, 'escalated', 'not-checked', at, { got: startCommit });
      if (startCommit === null) return await close(v, 'escalated', 'git-unreadable', at);
      if (startCommit !== v.expected) return await close(v, 'escalated', 'wrong-commit', at, { got: startCommit });
      // HEAD alone isn't enough (M1): the checkout it came back on must be fit to run.
      let fit;
      try { fit = await tools['git:read']('checkout', startCommit); } catch {
        return await close(v, 'escalated', 'git-unreadable', now(), { got: startCommit });
      }
      if (fit.why) return await close(v, 'escalated', fit.why, now(), { got: startCommit });
      log(`heal: ${RESTART}: back on ${shortCommit(startCommit)}; waiting for the first pass`);
      let timer = null;
      const late = new Promise(resolve => { timer = defer(() => resolve(null), v.deadline - at); });
      const pass = await Promise.race([Promise.resolve().then(firstPass).catch(() => ({ failed: null })), late]);
      clearTimeout(timer);
      const end = now();
      if (!pass) return await close(v, 'escalated', 'slow-start', end, { got: startCommit });
      // Decided on the raw list (L2): anything but a list is a failure, and so is any name
      // not already failing at the tap (L3). Only clean names reach the ledger.
      const raw = Array.isArray(pass.failed) ? pass.failed : null;
      const fresh = raw === null ? ['unknown'] : raw.filter(n => !v.before.includes(n));
      const failed = raw === null ? ['unknown'] : names(raw);
      if (fresh.length) return await close(v, 'escalated', 'first-pass', end, { got: startCommit, failed: failed.length ? failed : ['unknown'] });
      return await close(v, 'healed', 'restarted', end, { got: startCommit, ...(failed.length ? { failed } : {}) });
    } finally {
      if (escalated) await page('resume');
    }
  }

  // The checkout as a restart needs it (M1), or null when it can't be read.
  async function readCheckout() {
    try { return await tools['git:read']('checkout', startCommit); } catch (err) {
      once(`heal: the checkout could not be read (${err?.code ?? err?.name ?? 'error'}); no restart until it can`);
      return null;
    }
  }

  // After a tap, a few seconds on: the precondition once more (L1), then the program.
  async function kick(r) {
    if (restarting !== r) return;
    // on() holds the self check too; runSelfRestart checks the label at use.
    if (!on()) {
      // Switched off in the seconds before it ran: no attempt was made, so the card may
      // come back once heals are on again.
      spentHeads.delete(r.expected);
      return closeRestart(r, 'cleared', 'heals-off', now());
    }
    const co = await readCheckout();
    if (!co || co.head !== r.expected || co.why) {
      spentHeads.delete(r.expected);
      return closeRestart(r, 'cleared', !co ? 'git-unreadable' : co.why ?? 'moved', now(), co ? { got: co.head } : {});
    }
    try {
      await tools['launchctl:kickstart-kill'](target().label);
    } catch (err) {
      // A launchctl that took too long may still be restarting this process: leave the
      // tap open, and let the minute's check or the new process decide (L8).
      if (err?.code !== 'timeout') {
        log(`heal: the catalog's program for ${RESTART} failed (${err?.code ?? err?.signal ?? 'error'})`);
        return closeRestart(r, 'escalated', err?.code === 'not-self' ? 'not-self' : 'restart-failed', now());
      }
      log(`heal: launchctl took too long for ${RESTART}; waiting to see whether this process is restarted`);
    }
    // Normally this process is gone before it gets here. Nothing else closes this
    // restart in this process, so no check of `restarting`.
    defer(() => closeRestart(r, 'escalated', 'no-restart', now()).catch(() => {}), NO_RESTART_MS);
  }

  // The rate limits for a tap (design §4.6).
  function tapStop(at) {
    const lines = ledger.lines();
    if (t2ActsToday(lines, at).length >= PER_DAY) return 'cap-day';
    if (lines.filter(l => l.class === CLASS && l.outcome === 'verifying' && at - l.at < DAY).length >= RESTARTS_PER_DAY) return 'cap-restarts';
    return null;
  }

  // Card pushes, counted by the ledger's `proposed` marks so a restart doesn't reset them (L6).
  function pushWait(at) {
    if (inQuietHours(at)) return 'night';
    const pushes = ledger.lines().filter(l => l.class === CLASS && l.outcome === 'proposed');
    if (pushes.filter(l => at - l.at < HOUR).length >= PUSHES_PER_HOUR) return 'cap';
    if (pushes.filter(l => at - l.at < DAY).length >= PUSHES_PER_DAY) return 'cap';
    return null;
  }

  return {
    catalogProblem: () => catalogProblem,
    commit: () => startCommit,

    // Once, at start, after the ledger is loaded: this process's commit, then any
    // restart to check. Not awaited by the server (the check waits for the first pass).
    async start() {
      if (git && !catalogProblem) {
        try { startCommit = await tools['git:read']('head'); } catch (err) {
          log(`heal: the checkout's commit could not be read at start (${err?.code ?? err?.name ?? 'error'}); no restart cards in this run`);
        }
      }
      started = true;
      try { await resume(); } finally { checked = true; }
      const t = target();
      if (t && settings?.enabled === true && !catalogProblem) {
        if (!git) log(`heal: ${RESTART} needs toPush.gitRead (git-read) to read the checkout; no restart cards`);
        else if (!selfOk(t)) log(`heal: this server is not running as the launchd job heal.targets.${t.id} names; no restart cards`);
        else if (startCommit) log(`heal: ${RESTART} watches the checkout from ${shortCommit(startCommit)}`);
      }
    },

    // Every 5 minutes: is a restart due? Nothing is read while heals are off.
    async pass() {
      // While a restart is being checked, on() is false (start() hasn't finished).
      if (!on() || restarting || checking) return;
      checking = true;
      try {
        const at = now();
        const co = await readCheckout();
        if (!co) return;
        // A tap may have taken the card while git was read (M1 of loop 2).
        if (!on() || (card && card.state !== 'waiting')) return;
        const head = co.head;
        if (head === startCommit) {
          if (card) await closeCard('cleared', 'back-on-start', at);
          return;
        }
        let changed;
        try { changed = await tools['git:read']('changed', startCommit, head); } catch (err) {
          once(`heal: what changed in the checkout could not be read (${err?.code ?? err?.name ?? 'error'})`);
          return;
        }
        if (!on() || (card && card.state !== 'waiting')) return;
        if (changed.files === 0) {
          if (card) await closeCard('cleared', 'no-server-change', at, { expected: head });
          return;
        }
        if (head === declinedHead || spentHeads.has(head)) return;
        const fields = { head, merges: changed.merges, files: changed.files, blockedWhy: co.why ?? null };
        if (!card) {
          card = { id: randomBytes(16).toString('hex'), ...fields, state: 'waiting', detectedAt: at, announcedAt: null, pushWait: null };
          log(`heal: a restart card: ${changed.merges} merge${changed.merges === 1 ? '' : 's'} since ${shortCommit(startCommit)} touch the server's files${co.why ? ` (blocked: ${co.why})` : ''}`);
        } else {
          Object.assign(card, fields);
        }
        // Only a card that can be tapped is pushed, and not past the caps.
        if (card.announcedAt === null && !card.blockedWhy) {
          card.pushWait = pushWait(at);
          if (card.pushWait === null && await append(lineOf('proposed', 'due', at, { expected: head }))) {
            card.announcedAt = at;
            try { await notify(restartPush(card.merges), { priority: 'default' }); } catch (err) { log(`heal: the card's push failed (${err?.code ?? err?.name ?? 'error'})`); }
          }
        }
      } finally {
        checking = false;
      }
    },

    // Whether a card with this id is this loop's (the routes ask, for Not now).
    has: id => card !== null && card.id === id,

    // A tap on Restart. Answers { status, ok, error?, name?, ... } for the route.
    async approve(id, action, by) {
      const at = now();
      if (catalogProblem || settings?.enabled !== true) return { status: 503, error: 'heals are not set up on this server' };
      const st = status();
      if (st.status !== 'on') return { status: 503, error: `heals are off: ${st.why ?? 'not on'}` };
      if (!card || card.id !== id) return { status: 404, error: 'that card is no longer open; the page shows the ones that are' };
      if (card.state !== 'waiting') return { status: 409, error: 'that card was already answered' };
      if (action !== RESTART) return { status: 400, error: 'that card does not offer that action' };
      if (settings.off.has(RESTART)) return { status: 403, error: `${RESTART} is off in config.json` };
      const capped = tapStop(at);
      if (capped) return { status: 429, error: `not now: ${WHY_WORDS[capped]}`, name: NAME };
      // Taken here, before anything waits: a second tap, from any device, finds it taken,
      // and a pass during the reads below leaves it alone (loop 2's M1).
      const c = card;
      c.state = 'acting';
      const back = () => { if (card === c) c.state = 'waiting'; };

      let co, changed, pid;
      try {
        co = await tools['git:read']('checkout', startCommit);
        if (co.head !== startCommit) changed = await tools['git:read']('changed', startCommit, co.head);
      } catch {
        back();
        return { status: 503, error: "the checkout couldn't be read, so nothing was restarted", name: NAME };
      }
      // launchd's own record of the job must name this process (L9). A T0 read.
      try { pid = parseLaunchdPid(await tools['launchctl:print'](target().label)); } catch { pid = null; }
      if (!on()) { back(); return { status: 503, error: `heals are off: ${status().why ?? 'not on'}` }; }
      const head = co.head;
      if (head === startCommit) {
        await closeCard('cleared', 'back-on-start', at);
        return { status: 409, error: 'the checkout is back on the commit this server runs, so no restart is needed', name: NAME };
      }
      if (changed.files === 0) {
        await closeCard('cleared', 'no-server-change', at, { expected: head });
        return { status: 409, error: "the new commits change none of the server's files, so no restart is needed", name: NAME };
      }
      const moved = head !== c.head;
      Object.assign(c, { head, merges: changed.merges, files: changed.files, blockedWhy: co.why ?? null });
      if (co.why) { back(); return { status: 409, error: `not restarted: ${WHY_WORDS[co.why]}`, name: NAME }; }
      if (moved) { back(); return { status: 409, error: 'it moved: another merge came in since the card was drawn; look again', name: NAME }; }
      if (pid !== self.pid) { back(); return { status: 409, error: `not restarted: ${WHY_WORDS['not-own-pid']}`, name: NAME }; }
      const r = { ref: randomBytes(8).toString('hex'), target: target().id, since: startedAt, detectedAt: c.detectedAt, from: startCommit, expected: head, at };
      // The line first: the new process checks the restart by it. The collectors failing
      // now go in it, so the new process pages only for new failures (L3).
      let failing = [];
      try { failing = names(Array.isArray(failingNow()) ? failingNow() : []); } catch { failing = []; }
      if (!(await append({ ...lineOf('verifying', 'tapped', at), ref: r.ref, from: startCommit, expected: head, merges: changed.merges, by, failing }))) {
        back();
        return { status: 503, error: "the heal ledger couldn't be written, so nothing was restarted" };
      }
      spentHeads.add(head);
      c.state = 'restarting';
      restarting = r;
      defer(() => kick(r).catch(err => log(`heal: the restart failed (${err?.message ?? err})`)), KICK_DELAY_MS);
      log(oneLine(`heal: ${RESTART} tapped by ${by}: restarting from ${shortCommit(startCommit)} onto ${shortCommit(head)} in ${KICK_DELAY_MS / 1000} s`));
      return { status: 202, ok: true, name: NAME, action: RESTART, card: CLASS, from: shortCommit(startCommit), to: shortCommit(head), checkBy: at + VERIFY_MS };
    },

    // Not now: the card closes until HEAD moves again.
    async decline(id, by) {
      const at = now();
      if (catalogProblem || settings?.enabled !== true) return { status: 503, error: 'heals are not set up on this server' };
      if (!card || card.id !== id) return { status: 404, error: 'that card is no longer open; the page shows the ones that are' };
      if (card.state !== 'waiting') return { status: 409, error: 'that card was already answered' };
      card.state = 'acting';
      declinedHead = card.head;
      await closeCard('declined', 'not-now', at, { by });
      return { status: 200, ok: true, name: NAME, action: 'not-now', card: CLASS };
    },

    // The page's part (lib/heal.mjs, withLoopParts): no label, path or hash past 7 characters.
    view() {
      const at = now();
      const live = on();
      const st = status();
      const off = live ? null : catalogProblem ? 'the catalog was refused at start' : (st.status !== 'on' ? (st.why ?? 'heals are off') : 'heals are off');
      const base = { name: NAME, class: CLASS, classLabel: CLASS_WORDS[CLASS], action: RESTART, tier: 'T2', nextCheckAt: null, holdUntil: null };
      const open = [];
      if (card) open.push({ ...base, step: 'acting', ...(card.state === 'restarting' ? { restarting: true } : { waiting: true }), detectedAt: card.detectedAt });
      if (verifying) open.push({ ...base, step: 'verifying', restarted: true, detectedAt: verifying.detectedAt, checkBy: verifying.deadline });
      return {
        proposals: card ? [{
          id: card.id,
          name: NAME,
          class: CLASS,
          classLabel: CLASS_WORDS[CLASS],
          tier: 'T2',
          merges: card.merges,
          files: card.files,
          from: shortCommit(startCommit),
          to: shortCommit(card.head),
          actions: [RESTART],
          state: card.state,
          proposedAt: card.detectedAt,
          announcedAt: card.announcedAt,
          pushWait: card.announcedAt === null ? (card.blockedWhy ? 'blocked' : card.pushWait) : null,
          expiresAt: null,
          canAct: live && card.state === 'waiting' && !card.blockedWhy,
          // Not now stays on while the checkout blocks Restart, so a blocked card can be
          // dismissed (Jeff, 2026-11-15: option b). It still parks the card until HEAD moves.
          canDecline: live && card.state === 'waiting',
          blocked: off ?? (card.blockedWhy ? WHY_WORDS[card.blockedWhy] : null)
        }] : [],
        open,
        generatedAt: at
      };
    }
  };
}
