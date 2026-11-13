// The Loops panel's logic (docs/design/2026-11-12-self-healing-loops.md, §6): the
// server's `loops` view (server/lib/heal-runner.mjs) turned into words. Read-only: the
// panel has no buttons until the T2 loops, and the kill switch is a file the page can't
// touch. Checked by web/test/orbit-loops.test.js.
import { when } from './health.js';

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

const RECENT_TONE = { healed: 'ok', escalated: 'bad', relapsed: 'bad', cleared: 'idle' };

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
    when: Number.isFinite(o.nextCheckAt) ? `second reading ${when(o.nextCheckAt, now)}` : 'checking',
    held: Number.isFinite(o.holdUntil) && o.holdUntil > now ? `alert held until ${when(o.holdUntil, now)}` : null
  }));
  const quiet = list(loops.quiet).map(q => ({
    key: `quiet-${q.name}`,
    name: q.name,
    tier: q.tier,
    line: `quiet, ran clean${Number.isFinite(q.checkedAt) ? ` (checked ${when(q.checkedAt, now)})` : ''}: its log is old`
  }));
  const held = list(loops.held).map((h, i) => ({ key: `held-${h.name}-${i}`, name: h.name, line: h.why ? `held: ${h.why}` : 'held' }));
  const recent = list(loops.recent).map((r, i) => ({
    key: `recent-${r.at}-${i}`,
    name: r.name,
    tier: r.tier,
    tone: RECENT_TONE[r.outcome] ?? 'idle',
    mark: r.outcome === 'healed' ? '✓' : r.outcome === 'cleared' ? '·' : '✕',
    line: `${r.classLabel ?? r.class}: ${r.words ?? r.outcome}${r.why && r.outcome !== 'healed' ? ` (${r.why})` : ''}`,
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
