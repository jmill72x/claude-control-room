import { heat, formatUntil, paceNote } from '../lib/format.js';
import { Sparkline } from './Sparkline.jsx';

export function LimitBars({ limits, threshold, now, historyStatus = null }) {
  const historyBroken = historyStatus && historyStatus.ok === false
    ? (historyStatus.readError ?? historyStatus.writeError ?? 'read or write failed')
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {limits.map(l => {
        const color = heat(l.pct, threshold);
        const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : null;
        const pace = l.pace;
        // The tick is clamped to the bar even when the projection is not — the
        // credits bar already draws this distinction between mark and figure.
        const tick = Number.isFinite(pace?.expectedPct) ? Math.min(100, Math.max(0, pace.expectedPct)) : null;
        // With no reset time there is no window to observe the length of, so
        // "window length not yet observed" repeats the line above it while
        // implying that waiting will fix it. The missing reset clause is the
        // whole story; say it once.
        const showPace = pace && !(pace.state === 'unknown-window' && !resetsAt);
        return (
          <div key={l.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{l.label}</span>
              <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>{l.pct}%</span>
            </div>
            <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, l.pct)}%`, background: color }} />
              {tick !== null && (
                // Ahead of pace at a low percentage — the ordinary early-window
                // state, and the one where "you are burning ahead" matters most —
                // puts the tick INSIDE a fill that heat() also paints in --ink.
                // A one-pixel --ground halo separates the ink core from the fill
                // it stands on, while the core itself carries the contrast
                // against the --n300 track. Readable in both directions.
                <div title="expected at this point in the window"
                     style={{
                       position: 'absolute', top: -2, bottom: -2, left: `${tick}%`,
                       width: 2, background: 'var(--ink)', boxShadow: '0 0 0 1px var(--ground)'
                     }} />
              )}
            </div>
            <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
              {resetsAt ? `resets ${formatUntil(resetsAt - now)}` : 'no reset time reported'}
            </div>
            {showPace && (
              <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
                {paceNote(pace)}
              </div>
            )}
            <Sparkline series={l.series} color={color} unavailable={historyBroken} />
          </div>
        );
      })}
    </div>
  );
}
