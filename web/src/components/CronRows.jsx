import { cronState } from '../lib/format.js';

// Mirrors server/lib/humanize.mjs formatShort, but must live client-side: this
// countdown re-renders every second off the live `now` tick, not off server data.
// The only call site already guards null/undefined with `c.nextRunAt ? short(...) : '—'`.
const short = ms => {
  const total = Math.max(0, ms);
  const d = Math.floor(total / 86400000);
  const h = Math.floor((total % 86400000) / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
};

const EDGE = { ok: 'var(--ink)', failed: 'var(--accent)', never: 'var(--n400)', unknown: 'var(--n400)' };
const TEXT = { ok: 'var(--ink)', failed: 'var(--accent)', never: 'var(--n500)', unknown: 'var(--n500)' };
const FALLBACK = { ok: 'OK', failed: 'Failed', never: 'Not yet run', unknown: 'Unknown' };

export function CronRows({ crons, now }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {crons.map(c => {
        const state = cronState(c);
        const edge = EDGE[state];
        return (
          <div key={c.label ?? c.name} style={{
            display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 12,
            padding: '11px 10px 11px 12px', borderBottom: 'var(--rule-fine)',
            background: state === 'failed' ? 'var(--a100)' : 'transparent',
            borderLeft: `3px solid ${edge}`
          }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</span>
              {/* schedule is a human string that always embeds a clock time ("Every day, 02:00"). */}
              <span className="num" style={{ fontSize: 11, color: 'var(--n700)', fontWeight: 500 }}>{c.schedule}</span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              {/* A missing nextRunAt must render '—', never a computed countdown from a null base. */}
              <span className="num" style={{ fontSize: 13, fontWeight: 800 }}>
                {c.nextRunAt ? short(c.nextRunAt - now) : '—'}
              </span>
              <span className="num" style={{
                fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: TEXT[state]
              }}>{c.last ?? FALLBACK[state]}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
