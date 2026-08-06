// `label` and `detail` let a caller name a different kind of doubt — an ignored
// feed, an unknown running state — in the idiom the panel already uses, rather
// than inventing a second visual language for it. Neither overrides an envelope
// spread: `<StatusNote {...envelope} />` behaves exactly as before.
export function StatusNote({ status, error, fetchedAt, label, detail }) {
  if (status === 'ok') return null;
  const heading = label ?? (status === 'unavailable' ? 'No data source' : 'Stale');
  const text = detail ?? (status === 'unavailable'
    ? (error ?? 'nothing has reported yet')
    : `last read ${fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown'}`);
  return (
    <div style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: status === 'unavailable' ? 'var(--n500)' : 'var(--accent)',
      padding: '4px 0'
    }}>
      {heading} · <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>{text}</span>
    </div>
  );
}
