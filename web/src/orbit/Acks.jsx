import { useState } from 'react';
import { canAck, untilChoices, ackBody } from '../lib/orbit/acks.js';
import { ack } from './ackApi.js';

// Acknowledging a known miss (docs/design/2026-11-10-jarvis-os-home.md, §6). The
// red strip under the header keeps its alerts; a failed job or a down service gets
// an Acknowledge button, which opens a two-field form (a note, and until when) in
// the strip. Saving POSTs to /api/acks and asks the page to reload the payload:
// the alert then leaves the strip and the Jobs chip reads "all OK · 1 ack".

// `variant` is 'strip' (white on the red strip) or 'card' (in a Needs you card).
export function AckForm({ alert, now, onDone, onCancel, variant = 'strip' }) {
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState('next');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const choices = untilChoices(alert, now);

  // The browser's own submit is stopped here: the policy allows no form action.
  const submit = async e => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ack(ackBody(alert, { note, choice }, Date.now()));
      onDone();
    } catch (err) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  };

  return (
    <form className={`o-ack-form${variant === 'card' ? ' o-ack-form-card' : ''}`} onSubmit={submit} aria-label={`Acknowledge: ${alert.text}`}>
      <span className="o-ack-what">Acknowledge: {alert.text}</span>
      <label className="o-ack-field">
        <span className="o-ack-label">Note</span>
        <input className="o-input o-ack-input" value={note} maxLength={200} autoComplete="off"
          placeholder="what happened (optional)" onChange={e => setNote(e.target.value)} />
      </label>
      <div className="o-ack-choices" role="radiogroup" aria-label="Silence it">
        {choices.map(c => (
          <label key={c.id} className="o-ack-choice">
            <input type="radio" name="ack-until" value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} />
            {c.label}
          </label>
        ))}
      </div>
      <div className="o-ack-actions">
        <button type="submit" className="o-ack-btn o-ack-save" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="o-ack-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {error && <span className="o-ack-error" role="status">Couldn't save: {error}</span>}
    </form>
  );
}

export function AlertStrip({ alerts, now, onChanged }) {
  const [open, setOpen] = useState(null);
  if (!alerts?.length) return null;
  const opened = open ? alerts.find(a => a.key === open) : null;
  return (
    <div className="o-alerts" role="alert">
      <div className="o-wrap o-alerts-inner">
        <span className="o-mono o-alerts-tag">Attention</span>
        {alerts.map((a, i) => (
          <span key={a.key ?? i} className="o-alert">
            <span>{a.text}</span>
            {canAck(a) && open !== a.key && (
              <button type="button" className="o-ack-btn" onClick={() => setOpen(a.key)}>Acknowledge</button>
            )}
          </span>
        ))}
        {opened && (
          <AckForm key={opened.key} alert={opened} now={now} onCancel={() => setOpen(null)}
            onDone={() => { setOpen(null); onChanged?.(); }} />
        )}
      </div>
    </div>
  );
}
