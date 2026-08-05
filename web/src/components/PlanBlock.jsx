export function PlanBlock({ plan }) {
  if (!plan) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>{plan.name}</div>
        <div style={{ fontSize: 12, color: 'var(--n700)', fontWeight: 600 }}>{plan.price}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: 'var(--rule-fine)' }}>
        <div style={{ padding: '8px 12px 8px 0', borderRight: 'var(--rule-fine)' }}>
          <div className="section-label">Renews</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{plan.renews}</div>
        </div>
        <div style={{ padding: '8px 0 8px 12px' }}>
          <div className="section-label">Seats · Extra</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{plan.seats}</div>
        </div>
      </div>
    </div>
  );
}
