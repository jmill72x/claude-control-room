import { StatusNote } from './StatusNote.jsx';
import { envelopeOf } from '../lib/format.js';

// `envelope && <StatusNote/>` was falsy for a missing envelope, so the one case
// that most needed a marker — no payload at all — was the one case that showed
// none, and the children rendered their zeros underneath. Normalise first: a
// missing envelope is an unavailable envelope.
export function Panel({ label, envelope, note, children }) {
  const env = envelopeOf(envelope);
  const unavailable = env.status === 'unavailable';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="section-label">{label}</div>
      <StatusNote {...env} />
      {!unavailable && note}
      {!unavailable && children}
    </div>
  );
}
