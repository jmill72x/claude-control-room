// Restart Jarvis from the page (board 98a30b15; server/lib/jarvis-recover.mjs). When the
// lead is down, a card under the alert strip offers "Restart Jarvis": Face ID (the Stop's
// passkey), then the Mac mini runs the run sheet's one line, jarvis-recover, and the card
// shows how it ended (OK or NOT OK, and the script's last line). The card, the Chat
// banner's button and the Chat menu all open one sheet. The plain logic is here; checked
// by web/test/orbit-recover.test.js.
import { clock } from './page.js';
import { isLeadDownAlert } from './runbook.js';
import { QUIET_MS, duration } from './live.js';

// The one line, word for word as the server's (server/lib/recover-command.mjs; a server
// test keeps the two equal), for pasting in a terminal when the button can't be used.
export const RECOVER_COMMAND = 'cd ~/Projects && ~/Projects/.worktrees/jarvis-release/bin/jarvis-recover';
export const RECOVER_WHERE = 'In a terminal on the mini (Terminal or Termius), outside the jarvis tmux session:';
// What a Needs you card for the lead down says to do (waiting.js, local-alerts.js): the
// card at the top, or the line in a terminal.
export const RECOVER_WHAT = `To bring him back, tap Restart Jarvis at the top of the page (Face ID), or paste this in a terminal on the mini, outside the jarvis tmux session:\n${RECOVER_COMMAND}`;
// How long a finished run's result stays on the card, and how often a run going is read.
export const RESULT_SHOW_MS = 30 * 60e3;
export const POLL_MS = 3000;
// After an OK, the strip's alert can outlive him being back by a poll or two of the
// health panel, so for this long an OK card offers no second restart.
export const OK_GRACE_MS = 5 * 60e3;

// The strip's alert that says the lead is down (lib/orbit/runbook.js: his session five
// minutes down, or a start script's "jarvis-down" alert), or null.
export function leadDownAlert(alerts, services, leadName) {
  return (Array.isArray(alerts) ? alerts : []).find(a => isLeadDownAlert(a, services, leadName)) ?? null;
}

// A run's result in two words, and whether it counts as OK. "OK, degraded" is OK: he is
// back, missing what the line names.
export function verdictWords(verdict) {
  if (verdict === 'ok' || verdict === 'degraded') return { ok: true, label: 'OK' };
  if (verdict === 'not-ok') return { ok: false, label: 'NOT OK' };
  return { ok: false, label: 'No answer' };
}

// What the status read says the button may do. `status` is null before the read, or
// `{ usable: false }` when the read was refused (an unpaired or non-approver device, the
// chat off) or failed; else the server's answer. `show`: a Restart button at all;
// `can`: it may be tapped now, else `why`.
export function buttonState(status) {
  if (!status || status.usable !== true) return { show: false, can: false, why: null };
  if (status.on !== true) return { show: false, can: false, why: status.blocked ?? 'Restarting Jarvis from this page is off.' };
  if (status.running) return { show: true, can: false, why: 'A restart is going now.' };
  if (status.blocked) return { show: true, can: false, why: status.blocked };
  return { show: true, can: true, why: null };
}

// The card under the strip, or null: a run going, a result under RESULT_SHOW_MS old that
// this page hasn't put away (`dismissed`, the run's id), or the lead down.
export function recoverCard({ down = null, status = null, now = Date.now(), dismissed = null } = {}) {
  const usable = status?.usable === true;
  const running = usable ? status.running : null;
  if (running) {
    return { phase: 'running', title: 'Restarting Jarvis…', text: `Asked from ${running.by} at ${clock(running.startedAt)}. jarvis-recover takes a minute or two; the result shows here.` };
  }
  const last = usable ? status.last : null;
  if (last && Number.isFinite(last.finishedAt) && now - last.finishedAt < RESULT_SHOW_MS && last.id !== dismissed) {
    const v = verdictWords(last.verdict);
    return {
      phase: 'done', ok: v.ok, runId: last.id,
      title: `Jarvis restart: ${v.label}`,
      line: last.line || '(no line)',
      text: `Asked from ${last.by} at ${clock(last.startedAt)}, ended ${clock(last.finishedAt)}.`,
      // Still down after a NOT OK, or down again a while after an OK: the button is back.
      down: down !== null && (!v.ok || now - last.finishedAt >= OK_GRACE_MS)
    };
  }
  if (down) return { phase: 'down', title: 'Jarvis is down', text: 'Restart him from here with Face ID: the Mac mini runs jarvis-recover, which fixes what has stopped him before and restarts him.' };
  return null;
}

// What the sheet adds before Face ID (Ultron's Q1, 2026-11-20): a restart runs whether or
// not the health strip says he is down, so it says when he looks up, and when the stop
// flag is there (jarvis-recover removes it). `status.jarvis` is the server's
// `{ health, stopped }`; a status without it adds nothing.
export const STOPPED_NOTE = 'Jarvis was stopped on purpose; this restart clears that.';
export const LOOKS_UP_NOTE = 'Jarvis looks up; this ends his current turn.';
export function sheetNotes(status) {
  const j = status?.usable === true ? status.jarvis : null;
  const out = [];
  if (j?.stopped === true) out.push(STOPPED_NOTE);
  if (j?.health === 'up') out.push(LOOKS_UP_NOTE);
  return out;
}

// The sheet's step, from what it is doing (`local`: 'working' while Face ID is up, 'code'
// once a passkey waits for its code), the run it started (`mine`, a run id) and the
// status: a run going, then the end of its own run, then Face ID set up or not.
export function sheetPhase(local, status, mine = null) {
  if (local === 'working' || local === 'code') return local;
  if (status === null) return 'loading';
  if (status.usable === true && status.running) return 'running';
  if (mine !== null && status.usable === true && status.last?.id === mine) return 'done';
  if (status.usable !== true) return 'unusable';
  if (status.passkey !== true) return status.pending === true ? 'pending' : 'setup';
  return 'confirm';
}

// Agent runs a restart would stop (board d8f27c49, after 2026-11-20 16:14, when a tap
// ended two runs mid-work). A restart ends the lead's session and every subagent run in
// it; the status's `agents` lists them (server/lib/jarvis-recover.mjs, runsAtRisk:
// `{ known, runs: [{ id, name, last }] }`). The sheet says so before Face ID, with Cancel
// as its default, and the restart sends `stopRuns`: the ids it named, and UNSEEN when it
// said the runs can't be seen. The server refuses (409) a restart that doesn't name each
// run live then, so a page whose status is old can't skip this.
export const UNSEEN = 'unseen';
export const RUN_NAMES_SHOWN = 6;
export const RUNS_CHANGED = 'The agent runs going changed since this opened. Read the list again before you restart.';
const plural = (n, one, many) => (n === 1 ? one : many);

// The runs by name, a quiet one marked as the live agents pane marks it (live.js), at
// most RUN_NAMES_SHOWN of them.
export function runNames(runs, now = Date.now()) {
  const words = runs.map(r => {
    const name = typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : 'subagent';
    return Number.isFinite(r.last) && now - r.last >= QUIET_MS ? `${name} (quiet ${duration(now - r.last)})` : name;
  });
  const shown = words.slice(0, RUN_NAMES_SHOWN).join(', ');
  return words.length > RUN_NAMES_SHOWN ? `${shown} and ${words.length - RUN_NAMES_SHOWN} more` : shown;
}

// The sheet's warning, or null when the status says no run is going. A status with no
// `agents` (a server from before this) can't say, so it warns as one that can't see.
export function runsWarning(status, now = Date.now()) {
  if (status?.usable !== true) return null;
  const a = status.agents;
  const known = a?.known === true;
  const runs = Array.isArray(a?.runs) ? a.runs.filter(r => r && typeof r.id === 'string') : [];
  if (known && runs.length === 0) return null;
  const n = runs.length;
  const ids = runs.map(r => r.id);
  if (!known) ids.push(UNSEEN);
  let text;
  if (known) text = `${n} agent ${plural(n, 'run is', 'runs are')} going (${runNames(runs, now)}). Restarting stops ${plural(n, 'it', 'them')}.`;
  else if (n > 0) text = `${n} agent ${plural(n, 'run was', 'runs were')} going at the last check (${runNames(runs, now)}), and the Control Room can't see the runs now. Restarting stops any still going.`;
  else text = 'The Control Room can\'t see whether agent runs are going. Restarting stops any that are.';
  return { text, ids, count: n, known };
}
