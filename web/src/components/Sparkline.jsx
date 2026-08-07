const W = 120, H = 18;

export function Sparkline({ series, color = 'var(--n500)' }) {
  // Filter BEFORE counting: a point without finite numbers is not a point.
  // Keeping one would either poison maxPct with NaN — blanking the whole line
  // silently — or, for null, coerce to 0 and draw a fabricated "zero usage"
  // reading, which is precisely the lie the no-history state exists to avoid.
  // StackedBar guards the same class of input the same way.
  const points = Array.isArray(series)
    ? series.filter(p => Number.isFinite(p?.t) && Number.isFinite(p?.pct))
    : [];

  // A flat line would read as "usage was zero", which is a different claim from
  // "we have not been running long enough to know". Say the latter.
  if (points.length < 2) {
    return (
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--n500)' }}>
        Not enough history yet
      </div>
    );
  }

  const t0 = points[0].t;
  const tSpan = Math.max(1, points[points.length - 1].t - t0);
  const maxPct = Math.max(100, ...points.map(p => p.pct));

  const coords = points
    .map(p => `${((p.t - t0) / tSpan) * W},${H - (p.pct / maxPct) * H}`)
    .join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         style={{ display: 'block' }} aria-hidden="true">
      <polyline points={coords} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
