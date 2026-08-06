import { formatDate } from '../lib/format.js';

// `tier` comes from the `plan` envelope (the API, via `claude auth status
// --json`), never from config — see App.jsx. `price` is no longer derivable
// from anything real: Anthropic exposes no pricing API, and hardcoding a
// tier→price table here would fabricate a number the moment pricing changes.
// It renders only when config supplies one by hand, and the element is
// omitted entirely otherwise rather than showing a blank.
export function PlanBlock({ tier, price, renews, seats }) {
  if (!tier) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>{tier}</div>
        {price && <div style={{ fontSize: 12, color: 'var(--n700)', fontWeight: 600 }}>{price}</div>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: 'var(--rule-fine)' }}>
        <div style={{ padding: '8px 12px 8px 0', borderRight: 'var(--rule-fine)' }}>
          <div className="section-label">Renews</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{formatDate(renews)}</div>
        </div>
        <div style={{ padding: '8px 0 8px 12px' }}>
          <div className="section-label">Seats · Extra</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{seats}</div>
        </div>
      </div>
    </div>
  );
}
