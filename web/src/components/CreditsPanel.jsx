import { heat, formatDate } from '../lib/format.js';

const DAY = 86400000;
const HATCH = 'repeating-linear-gradient(45deg, var(--n300) 0 2px, transparent 2px 4px)';

const num = v => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};
const money = v => (num(v) === null ? '—' : `$${num(v).toFixed(2)}`);

export function CreditsPanel({ credits, threshold, now }) {
  if (!credits) return null;

  // A missing monthlyLimit used to fall through to `pct = 0`, which draws an
  // empty bar and a confident "0%" — a claim that nothing has been spent. A
  // missing `spent` was worse: NaN% and `width: NaN%`. Neither figure exists
  // here, so neither is drawn.
  const limit = num(credits.monthlyLimit);
  const spent = num(credits.spent);
  const pct = limit !== null && limit > 0 && spent !== null
    ? Math.round((spent / limit) * 100)
    : null;
  const color = pct === null ? 'var(--n500)' : heat(pct, threshold);
  const updated = credits.updatedAt ? Date.parse(credits.updatedAt) : null;
  const ageDays = Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / DAY)) : null;
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
        <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>
          {pct === null ? '—' : `${pct}%`}
        </span>
      </div>
      {pct === null
        ? <div style={{ height: 10, background: HATCH, border: '1px solid var(--n400)' }} />
        : (
          <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, pct)}%`, background: color }} />
          </div>
        )}
      {pct === null && (
        <div style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--n500)'
        }}>
          Spend against limit ·{' '}
          <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
            not known — {limit === null || limit <= 0 ? 'no monthly limit recorded' : 'no spend figure recorded'}
          </span>
        </div>
      )}
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
