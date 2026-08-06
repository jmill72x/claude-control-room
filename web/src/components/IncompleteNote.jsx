// The collector already knows which roots it could not list and which files it
// could not read; until this existed that knowledge died at the JSON boundary
// and the page printed a partial sum as if it were the whole. Same visual idiom
// as StatusNote: this is the third status a panel can be in — present, but
// knowably incomplete.

// Name the source without printing a home directory: the last two segments are
// enough to identify which tree failed.
const tail = p => String(p).split('/').filter(Boolean).slice(-2).join('/') || String(p);

export function IncompleteNote({ roots = [], paths = [], what = 'these figures' }) {
  const safeRoots = Array.isArray(roots) ? roots : [];
  const safePaths = Array.isArray(paths) ? paths : [];
  if (safeRoots.length === 0 && safePaths.length === 0) return null;

  const named = [...safeRoots, ...safePaths].map(tail);
  const shown = named.slice(0, 3);
  const extra = named.length - shown.length;
  const rootNote = safeRoots.length > 0
    ? ` A whole transcript root is unreadable, so ${what} exclude everything under it.`
    : '';

  return (
    <div style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'var(--accent)', padding: '4px 0'
    }}>
      Incomplete ·{' '}
      <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
        could not read {shown.join(', ')}{extra > 0 ? ` and ${extra} more` : ''}.
        {rootNote} Totals below are understated.
      </span>
    </div>
  );
}
