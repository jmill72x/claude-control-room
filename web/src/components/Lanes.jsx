import { useEffect, useState } from 'react';

const LANES = [
  { key: 'idea', title: 'Idea', placeholder: '+ new idea', mark: ' ', next: 'doing', edge: 'var(--n400)', box: 'transparent' },
  { key: 'doing', title: 'Doing', placeholder: '+ start something', mark: '›', next: 'done', edge: 'var(--ink)', box: 'var(--n500)' },
  { key: 'done', title: 'Done', placeholder: '+ log something done', mark: '✓', next: 'idea', edge: 'var(--n300)', box: 'var(--ink)' }
];

export function Lanes() {
  const [todos, setTodos] = useState([]);
  const [error, setError] = useState(null);

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
        if (!cancelled) { setTodos(body); setError(null); }
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
      } catch {
        setTodos(previous); // server unreachable: no write landed, snapshot is correct
      }
      setError('could not save');
      return false;
    }
  };

  // randomUUID exists only in a secure context. localhost and the HTTPS
  // tunnel both qualify, but a bare-LAN-IP page over plain HTTP does not —
  // and calling it there throws synchronously, outside save()'s try, so the
  // failure would be silent: no optimistic update, no revert, no error
  // banner, nothing. Fall back to a non-crypto unique-enough id.
  const newId = () =>
    globalThis.crypto?.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const add = (lane, text) => save([...todos, { id: newId(), text, lane, tag: 'Note' }]);
  const advance = (id, next) => save(todos.map(t => (t.id === id ? { ...t, lane: next } : t)));
  const remove = id => save(todos.filter(t => t.id !== id));

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
              <span className="num" style={{ fontSize: 11, fontWeight: 700, color: 'var(--n600)' }}>{items.length}</span>
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
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{
                    fontSize: 13, fontWeight: 600, lineHeight: 1.35, textWrap: 'pretty',
                    color: lane.key === 'done' ? 'var(--n500)' : 'var(--ink)',
                    textDecoration: lane.key === 'done' ? 'line-through' : 'none'
                  }}>{t.text}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: 'var(--n600)'
                  }}>{t.tag ?? 'Note'}</span>
                </span>
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
