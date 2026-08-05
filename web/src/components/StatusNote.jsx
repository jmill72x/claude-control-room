export function StatusNote({ status, error, fetchedAt }) {
  if (status === 'ok') return null;
  const label = status === 'unavailable' ? 'No data source' : 'Stale';
  const detail = status === 'unavailable'
    ? (error ?? 'nothing has reported yet')
    : `last read ${fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown'}`;
  return (
    <div style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: status === 'unavailable' ? 'var(--n500)' : 'var(--accent)',
      padding: '4px 0'
    }}>
      {label} · <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>{detail}</span>
    </div>
  );
}
