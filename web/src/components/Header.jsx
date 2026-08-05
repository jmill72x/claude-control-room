import { formatCountdown } from '../lib/format.js';

export function Header({ usage, now }) {
  const session = usage?.data?.limits?.find(l => l.label === 'Current session');
  const resetsAt = session?.resetsAt ? Date.parse(session.resetsAt) : null;
  return (
    <header className="ccr-header">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="eyebrow">Anthropic account snapshot</div>
        <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
          Control Room
        </h1>
      </div>
      <div className="ccr-header-stats">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="section-label">Session resets in</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>
            {resetsAt ? formatCountdown(resetsAt - now) : '—'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="section-label">Synced</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 800 }}>
            {usage?.fetchedAt
              ? new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '—'}
          </div>
        </div>
      </div>
    </header>
  );
}
