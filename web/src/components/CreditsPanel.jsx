import { heat, formatDate } from '../lib/format.js';

const DAY = 86400000;
const money = n => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);

export function CreditsPanel({ credits, threshold, now }) {
  if (!credits) return null;
  const pct = credits.monthlyLimit > 0 ? Math.round((credits.spent / credits.monthlyLimit) * 100) : 0;
  const color = heat(pct, threshold);
  const updated = credits.updatedAt ? Date.parse(credits.updatedAt) : null;
  const ageDays = updated ? Math.floor((now - updated) / DAY) : null;
  const aged = ageDays !== null && ageDays > 7;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>{money(credits.balance)}</div>
        <div style={{ fontSize: 12, color: 'var(--n700)', fontWeight: 600 }}>balance</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span className="num" style={{ fontSize: 13, fontWeight: 700 }}>
          {money(credits.spent)} of {money(credits.monthlyLimit)}
        </span>
        <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>{pct}%</span>
      </div>
      <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, pct)}%`, background: color }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: 'var(--rule-fine)' }}>
        <div style={{ padding: '8px 12px 8px 0', borderRight: 'var(--rule-fine)' }}>
          <div className="section-label">Resets</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{formatDate(credits.resetsOn)}</div>
        </div>
        <div style={{ padding: '8px 0 8px 12px' }}>
          <div className="section-label">Promo expires</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{formatDate(credits.promoExpiresOn)}</div>
        </div>
      </div>
      <div className="num" style={{ fontSize: 10, color: aged ? 'var(--accent)' : 'var(--n600)', fontWeight: aged ? 700 : 500 }}>
        {ageDays === null ? 'never updated' : `updated ${ageDays} day${ageDays === 1 ? '' : 's'} ago`}
      </div>
    </div>
  );
}
