const W = 120, H = 18;

const NOTE = {
  fontSize: 9, fontWeight: 600, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--n500)'
};

// `unavailable` carries the history store's own failure reason, or null. It is a
// different claim from "not enough history yet": that one promises the line will
// fill in if you wait, and when the store cannot read or write its files,
// waiting fixes nothing. Saying the wrong one is a reassuring message standing
// in for "we could not find out".
export function Sparkline({ series, color = 'var(--n500)', unavailable = null }) {
  // Filter BEFORE counting: a point without finite numbers is not a point.
  // Keeping one would either poison maxPct with NaN — blanking the whole line
  // silently — or, for null, coerce to 0 and draw a fabricated "zero usage"
  // reading, which is precisely the lie the no-history state exists to avoid.
  // StackedBar guards the same class of input the same way.
  const points = Array.isArray(series)
    ? series.filter(p => Number.isFinite(p?.t) && Number.isFinite(p?.pct))
    : [];

  const note = unavailable
    ? <div style={{ ...NOTE, color: 'var(--accent)' }}>History unavailable · {unavailable}</div>
    : null;

  // A flat line would read as "usage was zero", which is a different claim from
  // "we have not been running long enough to know". Say the latter.
  if (points.length < 2) {
    return note ?? <div style={NOTE}>Not enough history yet</div>;
  }

  const t0 = points[0].t;
  const tSpan = Math.max(1, points[points.length - 1].t - t0);
  const maxPct = Math.max(100, ...points.map(p => p.pct));

  const coords = points
    .map(p => `${((p.t - t0) / tSpan) * W},${H - (p.pct / maxPct) * H}`)
    .join(' ');

  // The points we do have are real readings, so they still get drawn — the note
  // below says the line is knowingly incomplete rather than merely short.
  return (
    <div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           style={{ display: 'block' }} aria-hidden="true">
        <polyline points={coords} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      {note}
    </div>
  );
}
