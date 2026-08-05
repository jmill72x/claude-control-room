export function AlertBar({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '10px 32px', background: 'var(--accent)', color: 'var(--a100)',
      borderBottom: 'var(--rule-strong)'
    }}>
      <span style={{
        fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
        fontWeight: 800, padding: '3px 8px', background: 'var(--ink)'
      }}>Attention</span>
      {alerts.map((a, i) => (
        <span key={i} style={{ fontSize: 13, fontWeight: 600 }}>{a.text}</span>
      ))}
    </div>
  );
}
