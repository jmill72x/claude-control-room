// The /usage contributing-factors block, surfaced instead of discarded.
//
// Two things shape this component:
//
// 1. These percentages are NOT parts of a whole — Anthropic's own output says
//    "Behaviors are independent characteristics, not a breakdown." They do not
//    sum to 100. A stacked bar or pie would misrepresent them, so every row
//    gets its own independent track (the model-rows idiom already used by
//    ModelRows elsewhere in column 01).
//
// 2. This whole block is local-machine-only and approximate, while the limit
//    percentages above it in the same column are account-wide. Anthropic's
//    own text: "Approximate, based on local sessions on this machine — does
//    not include other devices or claude.ai." Two figures of different
//    provenance sitting in one column without that caveat would mislead a
//    reader into comparing them directly — the caveat below is mandatory,
//    not decorative.
//
// `factors` is partial per window (Task 1): a window key exists if and only
// if its `Last …` header line parsed. A present window may still carry zero
// behaviours and zero top entries while its requests/sessions counts are
// real — so `w` being truthy does not imply it has rows to draw. That case
// is handled explicitly below, distinct from the "window missing entirely"
// case.
export function DriversPanel({ factors, window = '7d' }) {
  const w = factors?.[window];
  if (!w) {
    return (
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--n500)' }}>
        No data source · the usage breakdown was not readable
      </div>
    );
  }

  // Behaviours and top entries share one list of independent tracks, but they
  // come from two different namespaces: a behaviour's only identifier is its
  // free-text `text`, while a top entry's is its `category: name` pair. Either
  // could in principle collide with the other (or, within a category, with a
  // sibling entry that happens to repeat a name) — prefixing each key by its
  // source keeps behaviours and top entries from colliding with each other,
  // which a bare `r.name` key (as text) would not guard against.
  const rows = [
    ...w.behaviours.map(b => ({ key: `behaviour:${b.text}`, name: b.text, pct: b.pct })),
    ...w.top.flatMap(t => t.entries.map(e => ({
      key: `top:${t.category}:${e.name}`,
      name: `${t.category}: ${e.name}`,
      pct: e.pct
    })))
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
        {w.requests} requests · {w.sessions} sessions
      </div>

      {rows.length === 0
        ? (
          // A present-but-empty window: the header line parsed (counts above
          // are real), but nothing below it did. Silence here would read as a
          // bug, not as "no characteristics were recorded" — say so.
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--n500)' }}>
            No characteristics or top entries recorded for this window
          </div>
        )
        : (() => {
          const max = Math.max(1, ...rows.map(r => r.pct));
          return rows.map(r => (
            <div key={r.key} style={{
              display: 'grid', gridTemplateColumns: '1fr 60px 40px', alignItems: 'center',
              gap: 10, padding: '4px 0', borderBottom: 'var(--rule-hair)'
            }}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{r.name}</span>
              <span style={{ height: 6, background: 'var(--n300)', position: 'relative', display: 'block' }}>
                <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${(r.pct / max) * 100}%`, background: 'var(--ink)', display: 'block' }} />
              </span>
              <span className="num" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', color: 'var(--n700)' }}>
                {r.pct}%
              </span>
            </div>
          ));
        })()}

      {/* Mandatory, not decorative: the percentages above this panel are
          account-wide, these are local-machine-only. Two figures of different
          provenance in one column without the distinction would mislead. */}
      <div style={{ fontSize: 10, color: 'var(--n500)', fontWeight: 500, lineHeight: 1.4 }}>
        Local sessions on this machine only — excludes other devices and claude.ai.
        Characteristics are independent and do not sum to 100%.
      </div>
    </div>
  );
}
