import { heat } from '../lib/format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;
const money = v => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');

// Local date of a full timestamp. formatDate() takes a bare YYYY-MM-DD and
// would misread an instant like 2026-11-05T07:59Z, which is Nov 5 here but
// could be Nov 4 elsewhere.
const when = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

// Figures read automatically from the account's own usage response. Each
// grant shows what is LEFT, since that is what can still be spent; a figure the
// response did not carry prints as a dash, never as zero.
export function AccountCreditsPanel({ credits, threshold, now }) {
  const grants = credits?.grants ?? [];
  const balance = credits?.usageCredits?.balance;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {grants.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--n600)', fontWeight: 600 }}>No included or promotional credit on the account</div>
      )}
      {grants.map(g => {
        const usedPct = g.limit > 0 && typeof g.used === 'number' ? Math.round((g.used / g.limit) * 100) : null;
        const expires = Date.parse(g.expiresAt);
        const days = Number.isFinite(expires) ? Math.ceil((expires - now) / DAY) : null;
        const soon = days !== null && days <= 7;
        return (
          <div key={g.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{g.label}</div>
              <div className="num" style={{ fontSize: 13, fontWeight: 700 }}>
                {money(g.remaining)} <span style={{ color: 'var(--n600)', fontWeight: 600 }}>of {money(g.limit)} left</span>
              </div>
            </div>
            <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
              {usedPct !== null && (
                <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, usedPct)}%`, background: heat(usedPct, threshold) }} />
              )}
            </div>
            <div className="num" style={{ fontSize: 10, fontWeight: soon ? 700 : 500, color: soon ? 'var(--accent)' : 'var(--n600)' }}>
              {g.expiresAt ? `expires ${when(g.expiresAt)}${days !== null && days >= 0 ? ` · ${days} day${days === 1 ? '' : 's'} left` : ''}` : 'no expiry reported'}
            </div>
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, borderTop: 'var(--rule-fine)', paddingTop: 8 }}>
        <div className="section-label">Usage credits</div>
        <div className="num" style={{ fontSize: 13, fontWeight: 700 }}>
          {typeof balance === 'number' ? money(balance) : <span style={{ color: 'var(--n500)', fontWeight: 600 }}>none reported</span>}
        </div>
      </div>
    </div>
  );
}
