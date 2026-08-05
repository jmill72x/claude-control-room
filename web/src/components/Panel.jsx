import { StatusNote } from './StatusNote.jsx';

export function Panel({ label, envelope, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="section-label">{label}</div>
      {envelope && <StatusNote {...envelope} />}
      {envelope?.status !== 'unavailable' && children}
    </div>
  );
}
