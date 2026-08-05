import { formatTokens } from '../lib/format.js';

export function ModelRows({ models }) {
  const max = Math.max(1, ...models.map(m => m.pct));
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {models.map(m => (
        <div key={m.name} style={{
          display: 'grid', gridTemplateColumns: '70px 1fr 52px', alignItems: 'center',
          gap: 10, padding: '5px 0', borderBottom: 'var(--rule-hair)'
        }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{m.name}</span>
          <span style={{ height: 6, background: 'var(--n300)', position: 'relative', display: 'block' }}>
            <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${(m.pct / max) * 100}%`, background: 'var(--ink)', display: 'block' }} />
          </span>
          <span className="num" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', color: 'var(--n700)' }}>
            {formatTokens(m.tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}
