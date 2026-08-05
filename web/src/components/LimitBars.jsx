import { heat, formatCountdown } from '../lib/format.js';

export function LimitBars({ limits, threshold, now }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {limits.map(l => {
        const color = heat(l.pct, threshold);
        const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : null;
        return (
          <div key={l.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{l.label}</span>
              <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>{l.pct}%</span>
            </div>
            <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, l.pct)}%`, background: color }} />
            </div>
            <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
              {resetsAt ? `resets ${formatCountdown(resetsAt - now)}` : 'no reset time reported'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
