import { heat } from '../lib/format.js';

export function SessionRows({ sessions, threshold }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sessions.map((s, i) => {
        const color = heat(s.pct, threshold);
        // when+title collides for two untitled sessions in the same project in
        // the same minute: React keeps one row and drops the other, so real
        // usage silently vanishes from the list. aggregate() derives s.id from
        // the transcript's file path (unique per file, stable across polls),
        // falling back to sessionId and then null only for producers that
        // supply neither; the index here is a last resort for that null case.
        return (
          <div key={s.id ?? `${s.when}-${s.title}-${i}`} style={{
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
