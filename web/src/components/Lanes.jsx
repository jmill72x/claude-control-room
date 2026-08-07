import { useEffect, useRef, useState } from 'react';

const LANES = [
  { key: 'idea', title: 'Idea', placeholder: '+ new idea', mark: ' ', next: 'doing', edge: 'var(--n400)', box: 'transparent' },
  { key: 'doing', title: 'Doing', placeholder: '+ start something', mark: '›', next: 'done', edge: 'var(--ink)', box: 'var(--n500)' },
  { key: 'done', title: 'Done', placeholder: '+ log something done', mark: '✓', next: 'idea', edge: 'var(--n300)', box: 'var(--ink)' }
];

export function Lanes() {
  const [todos, setTodos] = useState([]);
  const [error, setError] = useState(null);
  // Until the list has actually been read, `todos` is an empty array we chose,
  // not an empty backlog we found: the lane counts must say so rather than
  // print a confident 0 next to a load error.
  const [loaded, setLoaded] = useState(false);
  // The id being edited, and the draft being typed. `draft` is deliberately
  // separate from `todos` so Escape can restore without a server round-trip.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ text: '', tag: '' });
  // Enter fires a commit, and the resulting blur fires another. Without a
  // guard the second one saves a stale draft over the first one's result.
  const committing = useRef(false);

  // `.then(r => r.json())` accepted any body the server sent, including a 500's
  // `{error}` object, which then reached `todos.filter` and threw during render —
  // taking the entire page down. Check the status, then check the shape.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/todos');
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const body = await res.json();
        if (!Array.isArray(body)) throw new Error('the server did not return a list');
        if (!cancelled) { setTodos(body); setLoaded(true); setError(null); }
      } catch (e) {
        if (!cancelled) setError(`could not load: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Returns true/false so callers (the Enter-to-add input) know whether the
  // write actually landed — an optimistic update that always looks like a
  // success would let a failed add clear the field as if it had saved.
  const save = async next => {
    const previous = todos;
    setTodos(next); // optimistic
    try {
      const res = await fetch('/api/todos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setError(null);
      return true;
    } catch (e) {
      // On failure, ask the server what is actually true rather than
      // rewinding to the pre-request snapshot. With two saves in flight,
      // `previous` can predate a write a *different* save already landed
      // (e.g. this one advances an item while a faster, later one deletes a
      // different item) — restoring `previous` would silently resurrect
      // that deleted item, which is the never-fabricate rule in reverse:
      // the client showing state the server does not have. Only fall back
      // to `previous` if the server itself is unreachable, in which case no
      // write landed at all and the pre-request snapshot is correct — this
      // is exactly the server-down case, so that path is unchanged.
      try {
        const res = await fetch('/api/todos');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body)) throw new Error('not a list');
        setTodos(body);
        setLoaded(true);
      } catch {
        setTodos(previous); // server unreachable: no write landed, snapshot is correct
      }
      setError('could not save');
      return false;
    }
  };

  // randomUUID exists only in a secure context. localhost and an HTTPS
  // tunnel both qualify, but plain HTTP does not — and that is not a
  // hypothetical edge case: the recommended remote-access route
  // (`tailscale serve --bg --http=80 8322`, see README) serves the
  // dashboard over plain HTTP inside the tailnet's WireGuard tunnel until
  // HTTPS certs are turned on for the tailnet, so this fallback is exercised
  // on every real tailnet visit today. Calling randomUUID in a non-secure
  // context throws synchronously, outside save()'s try, so the failure would
  // be silent: no optimistic update, no revert, no error banner, nothing.
  // Fall back to a non-crypto unique-enough id.
  const newId = () =>
    globalThis.crypto?.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const add = (lane, text) => save([...todos, { id: newId(), text, lane, tag: 'Note' }]);
  const advance = (id, next) => save(todos.map(t => (t.id === id ? { ...t, lane: next } : t)));
  const remove = id => save(todos.filter(t => t.id !== id));

  const beginEdit = t => {
    setEditingId(t.id);
    setDraft({ text: t.text ?? '', tag: t.tag ?? '' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft({ text: '', tag: '' });
  };

  const commitEdit = async id => {
    if (committing.current) return;
    const text = draft.text.trim();
    const tag = draft.tag.trim();
    const original = todos.find(t => t.id === id);

    // Blanking the text and tabbing away must not erase the item — `×` is what
    // deletion is for. Treat an empty text exactly as Escape does.
    if (!original || !text) { cancelEdit(); return; }

    // Nothing changed: close without a write. A no-op PUT would still be a
    // write that could fail and raise an error banner for no reason.
    if (text === original.text && tag === (original.tag ?? '')) { cancelEdit(); return; }

    committing.current = true;
    const ok = await save(todos.map(t => (t.id === id ? { ...t, text, tag } : t)));
    committing.current = false;
    // Stay in edit mode when the write failed, so what was typed is not lost.
    // `save()` has already reverted the list and shown the error.
    if (ok) cancelEdit();
  };

  return (
    <>
      {error && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{error}</div>}
      {LANES.map(lane => {
        const items = todos.filter(t => t.lane === lane.key);
        return (
          <div key={lane.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 8, borderBottom: '1px solid var(--ink)', paddingBottom: 5
            }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                {lane.title}
              </span>
              <span className="num" style={{ fontSize: 11, fontWeight: 700, color: 'var(--n600)' }}>
                {loaded ? items.length : '—'}
              </span>
            </div>
            {items.map(t => (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'start',
                gap: 10, padding: '9px 10px', background: 'var(--surface)',
                borderLeft: `3px solid ${lane.edge}`
              }}>
                <button
                  onClick={() => advance(t.id, lane.next)}
                  title={`Move to ${lane.next}`}
                  style={{
                    fontFamily: 'inherit', cursor: 'pointer', width: 16, height: 16, marginTop: 1,
                    padding: 0, background: lane.box, border: '1.5px solid var(--ink)',
                    color: 'var(--ground)', fontSize: 10, fontWeight: 800, lineHeight: 1
                  }}
                >{lane.mark}</button>
                {editingId === t.id ? (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit(t.id); }
                      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                    }}
                    onBlur={e => {
                      // Tabbing from the text field to the tag field is a blur on
                      // the text field. Commit only when focus leaves the CARD,
                      // not when it moves within it.
                      const card = e.currentTarget;
                      if (card.contains(e.relatedTarget)) return;
                      // relatedTarget is null when focus goes somewhere
                      // unfocusable, or in Safari. Re-check once the browser has
                      // settled who actually has focus.
                      if (e.relatedTarget === null) {
                        setTimeout(() => {
                          if (!card.contains(document.activeElement)) commitEdit(t.id);
                        }, 0);
                        return;
                      }
                      commitEdit(t.id);
                    }}
                  >
                    <input
                      className="ccr-lane-input"
                      value={draft.text}
                      autoFocus
                      onFocus={e => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
                      onChange={e => setDraft(d => ({ ...d, text: e.target.value }))}
                      aria-label="Edit text"
                      style={{
                        fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: '2px 4px',
                        border: 'var(--rule-fine)', background: 'var(--ground)', color: 'var(--ink)',
                        width: '100%'
                      }}
                    />
                    <input
                      className="ccr-lane-input"
                      value={draft.tag}
                      onChange={e => setDraft(d => ({ ...d, tag: e.target.value }))}
                      placeholder="tag"
                      aria-label="Edit tag"
                      style={{
                        fontFamily: 'inherit', fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                        textTransform: 'uppercase', padding: '2px 4px',
                        border: 'var(--rule-fine)', background: 'var(--ground)', color: 'var(--n600)',
                        width: '100%'
                      }}
                    />
                  </div>
                ) : (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <button
                      className="ccr-lane-text"
                      onClick={() => beginEdit(t)}
                      title="Edit"
                      style={{
                        fontSize: 13, fontWeight: 600, lineHeight: 1.35, textWrap: 'pretty',
                        color: lane.key === 'done' ? 'var(--n500)' : 'var(--ink)',
                        textDecoration: lane.key === 'done' ? 'line-through' : 'none'
                      }}
                    >{t.text}</button>
                    {/* Render the tag only when there is one. The old `?? 'Note'`
                        printed a label the item did not carry — now that tags are
                        editable and meaningful, that is a value being invented. */}
                    {t.tag && (
                      <span style={{
                        fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: 'var(--n600)'
                      }}>{t.tag}</span>
                    )}
                  </span>
                )}
                <button
                  className="ccr-lane-delete"
                  onClick={() => remove(t.id)}
                  title="Delete"
                  style={{
                    fontFamily: 'inherit', cursor: 'pointer', background: 'transparent',
                    border: 0, padding: '0 2px', fontSize: 14, lineHeight: 1, color: 'var(--n500)'
                  }}
                >×</button>
              </div>
            ))}
            <input
              type="text"
              className="ccr-lane-input"
              placeholder={lane.placeholder}
              onKeyDown={async e => {
                if (e.key !== 'Enter') return;
                const input = e.target;
                const v = input.value.trim();
                if (!v) return;
                // Clear only once the write has actually landed — clearing
                // synchronously (as the brief does) would empty the field
                // even when the save fails and reverts, making a dropped
                // write look identical to a successful one.
                const ok = await add(lane.key, v);
                if (ok) input.value = '';
              }}
              style={{
                fontFamily: 'inherit', fontSize: 12, fontWeight: 500, padding: '8px 10px',
                border: 'var(--rule-fine)', background: 'transparent', color: 'var(--ink)',
                width: '100%'
              }}
            />
          </div>
        );
      })}
    </>
  );
}
