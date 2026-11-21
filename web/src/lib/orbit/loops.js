// The Loops panel's logic (docs/design/2026-11-12-self-healing-loops.md, §6): the
// server's `loops` view (server/lib/heal-runner.mjs, server/lib/heal-missed.mjs) turned
// into words. The panel itself has no buttons: the T2 cards (loop 2's missed runs and
// loop 3's restart), the only ones that act, sit in Needs you (healCards, below), and the
// kill switch is a file the page can't
// touch. Checked by web/test/orbit-loops.test.js.
import { when } from './health.js';
import { clock } from './page.js';

export const STEPS = ['detect', 'diagnose', 'act', 'verify'];
const STEP_INDEX = { detected: 0, diagnosing: 1, acting: 2, verifying: 3 };
const list = v => (Array.isArray(v) ? v : []);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The status chip: what the runner is doing at all.
export function statusChip(loops) {
  switch (loops?.status) {
    case 'on': return { label: 'Heals on', tone: 'ok' };
    case 'killed': return { label: 'Heals off', tone: 'idle', why: 'the kill switch is on' };
    case 'off': return { label: 'Heals off', tone: 'idle', why: loops.why ?? null };
    default: return { label: 'Not set up', tone: 'idle', why: loops?.why ?? null };
  }
}

// Each step's mark: done, the current one, or still ahead.
export function stepMarks(step) {
  const at = STEP_INDEX[step] ?? 0;
  return STEPS.map((name, i) => ({ name, mark: i < at ? 'done' : i === at ? 'now' : 'ahead' }));
}

const RECENT_TONE = { healed: 'ok', escalated: 'bad', relapsed: 'bad', cleared: 'idle', declined: 'idle', expired: 'idle', acked: 'idle' };
// Outcomes whose why only repeats what was tapped.
const SAID_BY_TAP = new Set(['healed', 'acked', 'declined']);

// An open loop's second line: loop 1's next reading, loop 2's wait for a tap and its
// check of the run a tap started, or loop 3's restart and the new server's check of it.
function openWhen(o, now) {
  if (o.waiting === true) return 'waiting on you (Needs you)';
  if (o.restarting === true) return 'restarting now';
  if (o.restarted === true && Number.isFinite(o.checkBy)) return `restarted, checked by ${when(o.checkBy, now)}`;
  if (Number.isFinite(o.checkBy)) return `run started, checked by ${when(o.checkBy, now)}`;
  return Number.isFinite(o.nextCheckAt) ? `second reading ${when(o.nextCheckAt, now)}` : 'checking';
}

// Loop 3's closed loops carry the commit it ran and the one it came back on (7 hex).
const SHORT = /^[0-9a-f]{7}$/;
const commits = r => (SHORT.test(r?.from ?? '') && SHORT.test(r?.to ?? '') ? `, ${r.from} → ${r.to}` : '');
// And the collectors whose first run failed after it, by their code names.
const COLLECTOR = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const failedNames = r => {
  const n = list(r?.failed).filter(x => typeof x === 'string' && COLLECTOR.test(x));
  return n.length ? `; failed: ${n.join(', ')}` : '';
};

// When a quiet mark ends at the latest (the server's `endsBy`, the quiet ceiling: board
// 08469021 and 0b0dcf81): the log's write plus min(max(24 h, 4x its allowance), 7 days).
// It can end sooner (the log is written again, or a re-check fails); at `endsBy` the job
// goes red again, which the server's next pass does, so a moment already past says so.
// A server from before the ceiling sends none, and the line is as it was.
const quietEnds = (endsBy, now) => {
  if (!Number.isFinite(endsBy)) return '';
  return endsBy > now ? `; the quiet ends by ${when(endsBy, now)}` : '; the quiet ends at the next check';
};

// Whether a loop is open: the phone shows the panel above the fold only then.
export const hasOpen = loops => list(loops?.open).length > 0;

// What the panel shows. `null` from a server without the loops (no `loops` at all).
export function loopsView(loops, now) {
  if (!loops || typeof loops !== 'object') return null;
  const open = list(loops.open).map(o => ({
    key: `open-${o.name}-${o.detectedAt}`,
    name: o.name,
    tier: o.tier,
    what: o.classLabel ?? o.class,
    steps: stepMarks(o.step),
    when: openWhen(o, now),
    held: Number.isFinite(o.holdUntil) && o.holdUntil > now ? `alert held until ${when(o.holdUntil, now)}` : null
  }));
  const quiet = list(loops.quiet).map(q => ({
    key: `quiet-${q.name}`,
    name: q.name,
    tier: q.tier,
    line: `quiet, ran clean${Number.isFinite(q.checkedAt) ? ` (checked ${when(q.checkedAt, now)})` : ''}: its log is old${quietEnds(q.endsBy, now)}`
  }));
  const held = list(loops.held).map((h, i) => ({ key: `held-${h.name}-${i}`, name: h.name, line: h.why ? `held: ${h.why}` : 'held' }));
  const recent = list(loops.recent).map((r, i) => ({
    key: `recent-${r.at}-${i}`,
    name: r.name,
    tier: r.tier,
    tone: RECENT_TONE[r.outcome] ?? 'idle',
    mark: r.outcome === 'healed' ? '✓' : RECENT_TONE[r.outcome] === 'bad' ? '✕' : '·',
    line: `${r.classLabel ?? r.class}: ${r.words ?? r.outcome}${commits(r)}${r.why && !SAID_BY_TAP.has(r.outcome) ? ` (${r.why})` : ''}${failedNames(r)}`,
    when: when(r.at, now)
  }));
  const weeks = list(loops.weeks).map(w => ({ key: w.class, label: w.label ?? w.class, counts: list(w.counts) }));
  const healedWeek = list(loops.recent).filter(r => r.outcome === 'healed').length;
  const sub = [
    open.length ? `${plural(open.length, 'loop', 'loops')} open` : 'nothing open',
    quiet.length ? `${quiet.length} quiet` : null,
    `${healedWeek} healed this week`
  ].filter(Boolean).join(' · ');
  return { chip: statusChip(loops), open, quiet, held, recent, weeks, sub, empty: !open.length && !quiet.length && !held.length && !recent.length };
}

// ---- the T2 cards, for Needs you ----

// The buttons' words, in the order the card shows them. Not now is always there.
export const HEAL_ACTIONS = [
  { action: 'rerun-job', label: 'Run it now' },
  { action: 'ack-until-next-run', label: 'Ack until its next run' }
];
export const RESTART_ACTION = { action: 'restart-control-room', label: 'Restart it' };
const RESTART_CLASS = 'restart-due';
// After a Restart tap the page waits this long before it reloads: the server is gone
// for a few seconds (it restarts 3 s after its answer).
export const RESTART_RELOAD_MS = 12e3;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayTime = ts => `${WEEKDAYS[new Date(ts).getDay()]} ${clock(ts)}`;
const capital = s => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : s);

// One card per proposal (the server's `loops.proposals`): what was missed and why, the
// buttons it offers, and whether they work now. A server from before loop 2 sends none.
export function healCards(loops, now) {
  return list(loops?.proposals).filter(p => typeof p?.id === 'string' && typeof p.name === 'string').map(p => {
    if (p.class === RESTART_CLASS) return restartCard(p);
    const offered = HEAL_ACTIONS.filter(a => list(p.actions).includes(a.action));
    const runs = offered.some(a => a.action === 'rerun-job');
    const more = Number.isInteger(p.missedCount) && p.missedCount > 1 ? ` (${p.missedCount - 1} more before it)` : '';
    const what = runs
      ? 'Run it now starts it once, the way launchd would have; the card checks the run within 10 minutes. Ack until its next run keeps its alert quiet until then. Not now leaves it as it is.'
      : "A late run of this one is no use, so the card offers no run. Ack until its next run keeps its alert quiet until then, or Not now leaves it as it is.";
    const next = Number.isFinite(p.nextRunAt) ? ` Its next run is ${when(p.nextRunAt, now)}.` : '';
    const meta = p.state === 'acting' ? 'answering…'
      : Number.isFinite(p.expiresAt) ? `card open until ${clock(p.expiresAt)}`
      : 'no push at night: it waits for the morning';
    return {
      key: `heal:${p.id}`,
      group: 'heals',
      look: 'alert',
      chip: 'Missed run',
      title: `${p.name}: missed ${Number.isFinite(p.missedAt) ? dayTime(p.missedAt) : 'a run'}${more}`,
      what: `${what}${next}`,
      why: p.fingerprint ? `${capital(p.fingerprint)} when it was due, and it hasn't run since.` : "It hasn't run since.",
      owner: null,
      fallback: '⟳',
      meta: `${p.tier ?? 'T2'} · ${meta}`,
      itemId: null,
      alert: null,
      heal: {
        id: p.id,
        name: p.name,
        actions: offered,
        canAct: p.canAct === true,
        blocked: p.canAct === true ? null : (typeof p.blocked === 'string' && p.blocked ? p.blocked : 'heals are off')
      }
    };
  });
}

// Why a restart card wasn't pushed (the server's `pushWait`).
const RESTART_WAIT = {
  night: 'no push at night: it waits for the morning',
  cap: 'not pushed: restart pushes are capped at 1 an hour and 3 a day',
  blocked: "not pushed: it can't be restarted as the checkout stands"
};

// Loop 3's card: a restart of this server, due after merges that change server/.
function restartCard(p) {
  const n = Number.isInteger(p.merges) && p.merges > 0 ? p.merges : null;
  const short = v => (typeof v === 'string' && /^[0-9a-f]{7}$/.test(v) ? v : null);
  const from = short(p.from), to = short(p.to);
  const onto = to ? ` on ${to}` : ' on the new commit';
  const meta = p.state === 'acting' ? 'answering…'
    : p.state === 'restarting' ? 'restarting…'
    : Number.isFinite(p.announcedAt) ? `pushed ${clock(p.announcedAt)}`
    : Object.hasOwn(RESTART_WAIT, p.pushWait ?? '') ? RESTART_WAIT[p.pushWait] : 'not pushed yet';
  return {
    key: `heal:${p.id}`,
    group: 'heals',
    look: 'alert',
    chip: 'Restart due',
    title: `Restart the Control Room${n ? ` (${n} merge${n === 1 ? '' : 's'})` : ''}`,
    what: `Restart it starts the Control Room again${onto}. The page drops for a few seconds; the new server checks it came back${onto} with a clean first pass, and the Loops panel shows the result. Not now leaves it until the next merge.`,
    why: `${n ? `${n} merge${n === 1 ? '' : 's'}` : 'Merges'} since this server started${from ? ` (on ${from})` : ''} change files the server runs, and it only runs new code after a restart.`,
    owner: null,
    fallback: '⟳',
    meta: `${p.tier ?? 'T2'} · ${meta}`,
    itemId: null,
    alert: null,
    heal: {
      id: p.id,
      name: p.name,
      actions: list(p.actions).includes(RESTART_ACTION.action) ? [RESTART_ACTION] : [],
      canAct: p.canAct === true,
      canDecline: p.canDecline === true,
      blocked: p.canAct === true ? null : p.state === 'restarting' ? 'it is restarting now' : (typeof p.blocked === 'string' && p.blocked ? p.blocked : 'heals are off')
    }
  };
}

// A tap's answer in words, for the line under the buttons.
export function tapDone(action, answer, now) {
  if (action === RESTART_ACTION.action) return `Restarting${typeof answer?.to === 'string' && /^[0-9a-f]{7}$/.test(answer.to) ? ` onto ${answer.to}` : ''}. The page drops for a few seconds; the Loops panel then shows the check.`;
  if (action === 'rerun-job') return Number.isFinite(answer?.checkBy) ? `Started. The Loops panel shows the check, done by ${when(answer.checkBy, now)}.` : 'Started.';
  if (action === 'ack-until-next-run') return Number.isFinite(answer?.until) ? `Acked until ${when(answer.until, now)}.` : 'Acked.';
  return 'Left as it is.';
}
