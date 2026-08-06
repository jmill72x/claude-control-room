const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const minutes = ms => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

// Distinct from AlertBar (accent ground, account-level warnings): this one is
// about the page itself, so it is inked. Nothing below it can be trusted as live
// while it is showing.
export function ConnectionBar({ error, capturedAt, ageMs }) {
  if (!error && ageMs == null) return null;
  const detail = error
    ? (capturedAt
      ? `Cannot reach the server. Nothing below is live — the last response was at ${clock(capturedAt)}.`
      : 'Cannot reach the server. No data has been received, so no figure on this page is real.')
    : `The last response is ${minutes(ageMs)} old. Figures below are not current.`;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '10px 32px', background: 'var(--ink)', color: 'var(--ground)',
      borderBottom: 'var(--rule-strong)'
    }}>
      <span style={{
        fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
        fontWeight: 800, padding: '3px 8px', background: 'var(--accent)', color: 'var(--a100)'
      }}>{error ? 'No server' : 'Stale page'}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{detail}</span>
    </div>
  );
}
