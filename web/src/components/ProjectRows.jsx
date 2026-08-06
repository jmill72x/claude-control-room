export function ProjectRows({ projects }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {projects.map(p => {
        const dot = p.running ? 'var(--accent)' : 'var(--n400)';
        const isCode = p.tool === 'Code';
        return (
          <div key={`${p.tool}-${p.name}`} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center',
            gap: 12, padding: '11px 0', borderBottom: 'var(--rule-fine)'
          }}>
            <span style={{ width: 10, height: 10, display: 'block', background: dot, border: '1px solid var(--ink)' }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>{p.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: '2px 6px',
                  background: isCode ? 'var(--ink)' : 'var(--n300)',
                  color: isCode ? 'var(--ground)' : 'var(--ink)'
                }}>{p.tool}</span>
                {/* p.detail always embeds a relative-time number ("edited 4m ago"): tabular-nums keeps it steady. */}
                <span className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>{p.detail}</span>
              </span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              <span style={{
                fontSize: 11, fontWeight: 800, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: dot
              }}>{p.running ? 'Running' : 'Idle'}</span>
              {/* tasks has no verified data source yet (always null server-side): omit the
                  line entirely rather than ever rendering a fabricated "0 open". null and 0
                  are different facts — null means no data source, 0 means a real known-empty
                  count — so this must distinguish "missing" from "falsy", not collapse them.
                  `p.tasks && <JSX>` would still be wrong even so: it short-circuits to the
                  bare number 0 itself (not null), and React renders that as a stray, unstyled
                  text node outside the span. Test for null explicitly so a real 0 gets the
                  row's own styling via the span, same as any other value. */}
              {p.tasks != null && <span className="num" style={{ fontSize: 11, color: 'var(--n600)' }}>{p.tasks}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
