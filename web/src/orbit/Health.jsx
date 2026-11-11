import { useState } from 'react';
import { healthChips, healthDetail } from '../lib/orbit/health.js';
import { unavailable } from '../lib/orbit/page.js';

// The health strip under the title (Orbit plan, Phase 2): Jobs, then each
// always-on service, from the server's `health` panel. A chip opens its
// details below the strip, one at a time. A server from before the strip sends
// no panel, and then there is no strip.
export function HealthChips({ env, fresh, open, onToggle, detailId }) {
  if (!env) return null;
  const chips = healthChips(env, fresh);
  if (chips.length === 0) return <span className="o-health-none">Health: {unavailable(env)}</span>;
  return chips.map(c => (
    <button key={c.key} type="button" className={`o-hchip o-tone-${c.tone}${open === c.key ? ' o-hchip-open' : ''}`}
      aria-expanded={open === c.key} aria-controls={open === c.key ? detailId : undefined} onClick={() => onToggle(c.key)}>
      <span className="o-hchip-dot" aria-hidden="true" />
      <span className="o-hchip-label">{c.label}</span>
      <span className="o-hchip-value">{c.value}</span>
    </button>
  ));
}

// `onUnack(key)` deletes an acknowledgement (server/lib/acks.mjs) and refreshes;
// a row with `ack` shows the button. A failed un-ack is said in the panel's note.
export function HealthDetail({ env, fresh, open, now, id, onUnack }) {
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(null);
  const d = healthDetail(env, open, fresh, now);
  if (!d) return null;
  const unack = async key => {
    setBusy(key);
    setProblem(null);
    try { await onUnack(key); } catch (err) { setProblem(`Couldn't un-ack: ${err?.message ?? err}`); } finally { setBusy(null); }
  };
  return (
    <section id={id} className="o-health-detail" aria-label={`${d.title}: details`}>
      <div className="o-health-head">
        <h2 className="o-mono">{d.title}</h2>
        {(problem || d.note) && <span role={problem ? 'status' : undefined}>{problem ?? d.note}</span>}
      </div>
      {d.rows.map((r, i) => (
        <div key={i} className={`o-health-row o-tone-${r.tone}${r.ack ? ' o-health-row-ack' : ''}`}>
          <span className="o-hchip-dot" aria-hidden="true" />
          <span className="o-health-what"><b>{r.name}</b>{r.when ? <span> · {r.when}</span> : null}</span>
          <span className="o-mono o-health-state">{r.state}</span>
          {r.ack && onUnack && (
            <button type="button" className="o-unack" disabled={busy === r.ack.key} onClick={() => unack(r.ack.key)}
              aria-label={`Un-ack ${r.name}`}>{busy === r.ack.key ? '…' : 'Un-ack'}</button>
          )}
        </div>
      ))}
    </section>
  );
}
