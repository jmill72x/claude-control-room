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

export function HealthDetail({ env, fresh, open, now, id }) {
  const d = healthDetail(env, open, fresh, now);
  if (!d) return null;
  return (
    <section id={id} className="o-health-detail" aria-label={`${d.title}: details`}>
      <div className="o-health-head">
        <h2 className="o-mono">{d.title}</h2>
        {d.note && <span>{d.note}</span>}
      </div>
      {d.rows.map((r, i) => (
        <div key={i} className={`o-health-row o-tone-${r.tone}`}>
          <span className="o-hchip-dot" aria-hidden="true" />
          <span className="o-health-what"><b>{r.name}</b>{r.when ? <span> · {r.when}</span> : null}</span>
          <span className="o-mono o-health-state">{r.state}</span>
        </div>
      ))}
    </section>
  );
}
