import { nowDetail } from '../lib/orbit/now.js';

// The Now chip in the band (docs/design/2026-11-10-jarvis-os-home.md, §5.1): the
// lead's session and model, who is working this minute, and the next job. It opens
// details under the band like a health chip (OrbitApp keeps which chip is open).
// The logic, and `nowFromPayload` that builds the chip, are in src/lib/orbit/now.js.

export function NowChip({ chip, open, onToggle, detailId }) {
  if (!chip) return null;
  return (
    <button type="button" className={`o-now-chip o-tone-${chip.tone}${open ? ' o-hchip-open' : ''}`}
      aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
      <span className="o-mono o-now-tag" aria-hidden="true">Now</span>
      <span className="o-hchip-dot" aria-hidden="true" />
      <span className="o-now-text">{chip.text}</span>
    </button>
  );
}

export function NowDetail({ chip, now, id }) {
  const d = nowDetail(chip, now);
  if (!d) return null;
  return (
    <section id={id} className="o-health-detail" aria-label="Now: details">
      <div className="o-health-head">
        <h2 className="o-mono">{d.title}</h2>
        <span>{d.note}</span>
      </div>
      {d.rows.map((r, i) => (
        <div key={i} className={`o-health-row o-tone-${r.tone}`}>
          <span className="o-hchip-dot" aria-hidden="true" style={r.color ? { background: r.color } : undefined} />
          <span className="o-health-what"><b>{r.name}</b>{r.when ? <span> · {r.when}</span> : null}</span>
          <span className="o-mono o-health-state">{r.state}</span>
        </div>
      ))}
    </section>
  );
}
