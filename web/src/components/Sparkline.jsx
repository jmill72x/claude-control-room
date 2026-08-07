const W = 120, H = 18;

export function Sparkline({ series, color = 'var(--n500)' }) {
  // A flat line would read as "usage was zero", which is a different claim from
  // "we have not been running long enough to know". Say the latter.
  if (!Array.isArray(series) || series.length < 2) {
    return (
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--n500)' }}>
        Not enough history yet
      </div>
    );
  }

  const t0 = series[0].t;
  const tSpan = Math.max(1, series[series.length - 1].t - t0);
  const maxPct = Math.max(100, ...series.map(p => p.pct));

  const points = series
    .map(p => `${((p.t - t0) / tSpan) * W},${H - (p.pct / maxPct) * H}`)
    .join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         style={{ display: 'block' }} aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
