const PALETTE = ['var(--ink)', 'var(--accent)', 'var(--n300)', 'var(--n500)'];
const FG = ['var(--ground)', 'var(--a100)', 'var(--ink)', 'var(--ground)'];

// A segment is drawable only if it is not flagged unmeasurable AND carries a real
// number. Testing `measurable !== false` alone fails OPEN: a segment arriving without
// the flag and without a pct would render as a phantom bar showing a bare '%'.
const isDrawable = s => s.measurable !== false && typeof s.pct === 'number';

export function StackedBar({ segments }) {
  const measurable = segments.filter(isDrawable);
  const unmeasurable = segments.filter(s => !isDrawable(s));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', height: 26, border: '1px solid var(--ink)' }}>
        {measurable.map((s, i) => (
          <div key={s.name} style={{
            flex: Math.max(s.pct, 1), background: PALETTE[i % PALETTE.length],
            display: 'flex', alignItems: 'center', paddingLeft: 6, overflow: 'hidden'
          }}>
            <span className="num" style={{ fontSize: 10, fontWeight: 800, color: FG[i % FG.length], letterSpacing: '0.04em' }}>
              {s.pct}%
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {measurable.map((s, i) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, background: PALETTE[i % PALETTE.length], border: '1px solid var(--ink)' }} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>{s.name}</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--n600)' }}>{s.display ?? ''}</span>
          </div>
        ))}
        {unmeasurable.map(s => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 9, height: 9, border: '1px solid var(--n400)',
              background: 'repeating-linear-gradient(45deg, var(--n300) 0 2px, transparent 2px 4px)'
            }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--n500)' }}>{s.name}</span>
            <span style={{ fontSize: 11, color: 'var(--n500)' }}>not measurable locally</span>
          </div>
        ))}
      </div>
    </div>
  );
}
