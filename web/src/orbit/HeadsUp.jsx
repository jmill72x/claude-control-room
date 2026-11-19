// Heads up (the proactive check, board a77b4757; docs/design/2026-11-18-proactive-check.md):
// what the server's check found and has sent to Jarvis, or will at 07:00. Read-only: a
// board row opens its item, nothing else is a button. Shown only while there is a hit
// (lib/orbit/home.js, homeSections). The logic is in src/lib/orbit/headsup.js.
export function HeadsUp({ view, onOpenItem }) {
  if (!view) return null;
  return (
    <section aria-labelledby="o-heads" className="o-panel o-heads">
      <div className="o-panel-head">
        <h2 id="o-heads" className="o-h2 o-h2-day">Heads up</h2>
        <span className="o-sub">{view.sub}</span>
      </div>
      <ul className="o-loop-rows" aria-label="What the proactive check found">
        {view.rows.map(r => (
          <li key={r.key} className={`o-loop-row o-tone-${r.tone}${r.stale ? ' o-heads-stale' : ''}`}>
            <span className="o-loop-mark" aria-hidden="true">{r.mark}</span>
            <span className="o-loop-row-name">
              {r.itemId !== null
                ? <button type="button" className="o-heads-open" onClick={() => onOpenItem(r.itemId)}>{r.name}</button>
                : r.name}
            </span>
            <span className="o-loop-row-line">{r.line} <span className="o-mono o-loop-when">{r.state}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
