import { loopsView } from '../lib/orbit/loops.js';
import { Note } from './Note.jsx';

// The Loops panel (docs/design/2026-11-12-self-healing-loops.md, §6): the self-healing
// loops open now with their four steps, the jobs marked quiet, what the kill switch or
// config holds, what closed in the last week and how often each class healed. Read-only:
// it has no buttons, and the kill switch is a file the page can't touch. The logic is in
// src/lib/orbit/loops.js. A server from before the loops sends nothing, and then there is
// no panel.
export function Loops({ payload, now }) {
  const v = loopsView(payload?.loops, now);
  if (!v) return null;
  return (
    <section aria-labelledby="o-loops" className="o-panel o-loops">
      <div className="o-panel-head">
        <h2 id="o-loops" className="o-h2 o-h2-day">Loops</h2>
        <span className="o-sub">{v.sub}</span>
        <span className={`o-loop-chip o-tone-${v.chip.tone}`} title={v.chip.why ?? undefined}>{v.chip.label}</span>
      </div>
      {v.chip.why && v.chip.tone !== 'ok' && <Note>{v.chip.label}: {v.chip.why}.</Note>}
      {v.empty && <Note>Nothing has needed a heal this week.</Note>}
      {v.open.length > 0 && (
        <ol className="o-loop-list" aria-label="Loops open now">
          {v.open.map(o => (
            <li key={o.key} className="o-loop">
              <span className="o-loop-name">{o.name} <span className="o-mono o-loop-tier">{o.tier}</span></span>
              <span className="o-loop-what">{o.what} · {o.when}{o.held ? ` · ${o.held}` : ''}</span>
              <span className="o-loop-steps" role="img" aria-label={`Steps: ${o.steps.map(s => `${s.name} ${s.mark}`).join(', ')}`}>
                {o.steps.map(s => <span key={s.name} className={`o-loop-step o-loop-step-${s.mark}`}><span aria-hidden="true" />{s.name}</span>)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {(v.quiet.length > 0 || v.held.length > 0) && (
        <ul className="o-loop-rows" aria-label="Quiet and held">
          {v.quiet.map(q => (
            <li key={q.key} className="o-loop-row o-tone-idle">
              <span className="o-loop-mark" aria-hidden="true">○</span>
              <span className="o-loop-row-name">{q.name}</span>
              <span className="o-loop-row-line">{q.line}</span>
            </li>
          ))}
          {v.held.map(h => (
            <li key={h.key} className="o-loop-row o-tone-idle">
              <span className="o-loop-mark" aria-hidden="true">‖</span>
              <span className="o-loop-row-name">{h.name}</span>
              <span className="o-loop-row-line">{h.line}</span>
            </li>
          ))}
        </ul>
      )}
      {v.recent.length > 0 && (
        <>
          <h3 className="o-mono o-loop-h3">Last 7 days</h3>
          <ul className="o-loop-rows" aria-label="Loops closed in the last 7 days">
            {v.recent.map(r => (
              <li key={r.key} className={`o-loop-row o-tone-${r.tone}`}>
                <span className="o-loop-mark" aria-hidden="true">{r.mark}</span>
                <span className="o-loop-row-name">{r.name} <span className="o-mono o-loop-tier">{r.tier}</span></span>
                <span className="o-loop-row-line">{r.line} <span className="o-mono o-loop-when">{r.when}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}
      {v.weeks.length > 0 && (
        <>
          <h3 className="o-mono o-loop-h3">Keeps happening · 4 weeks</h3>
          <ul className="o-loop-rows" aria-label="Heals per week, oldest week first">
            {v.weeks.map(w => (
              <li key={w.key} className="o-loop-row o-loop-week">
                <span className="o-loop-row-name">{w.label}</span>
                <span className="o-mono o-loop-counts">{w.counts.join(' · ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
