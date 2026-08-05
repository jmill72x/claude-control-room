import { heat } from '../lib/format.js';

export function SessionRows({ sessions, threshold }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sessions.map(s => {
        const color = heat(s.pct, threshold);
        return (
          <div key={`${s.when}-${s.title}`} style={{
            display: 'grid', gridTemplateColumns: '48px 1fr auto', alignItems: 'center',
            gap: 10, padding: '7px 0', borderBottom: 'var(--rule-hair)'
          }}>
            <span className="num" style={{ fontSize: 11, fontWeight: 600, color: 'var(--n600)' }}>{s.when}</span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{s.title}</span>
              <span style={{ fontSize: 10, color: 'var(--n600)' }}>{s.surface} · {s.model}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 56, height: 6, background: 'var(--n300)', position: 'relative', display: 'block' }}>
                <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${s.pct}%`, background: color, display: 'block' }} />
              </span>
              <span className="num" style={{ fontSize: 11, fontWeight: 800, width: 32, textAlign: 'right' }}>{s.pct}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
