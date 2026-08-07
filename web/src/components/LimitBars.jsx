import { heat, formatUntil, paceNote } from '../lib/format.js';
import { Sparkline } from './Sparkline.jsx';

export function LimitBars({ limits, threshold, now }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {limits.map(l => {
        const color = heat(l.pct, threshold);
        const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : null;
        const pace = l.pace;
        // The tick is clamped to the bar even when the projection is not — the
        // credits bar already draws this distinction between mark and figure.
        const tick = Number.isFinite(pace?.expectedPct) ? Math.min(100, Math.max(0, pace.expectedPct)) : null;
        return (
          <div key={l.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{l.label}</span>
              <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>{l.pct}%</span>
            </div>
            <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, l.pct)}%`, background: color }} />
              {tick !== null && (
                <div title="expected at this point in the window"
                     style={{ position: 'absolute', top: -2, bottom: -2, left: `${tick}%`, width: 2, background: 'var(--ink)' }} />
              )}
            </div>
            <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
              {resetsAt ? `resets ${formatUntil(resetsAt - now)}` : 'no reset time reported'}
            </div>
            {pace && (
              <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
                {paceNote(pace)}
              </div>
            )}
            <Sparkline series={l.series} color={color} />
          </div>
        );
      })}
    </div>
  );
}
