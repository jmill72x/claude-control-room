import { useEffect, useState } from 'react';

const LANES = [
  { key: 'idea', title: 'Idea', placeholder: '+ new idea', mark: ' ', next: 'doing', edge: 'var(--n400)', box: 'transparent' },
  { key: 'doing', title: 'Doing', placeholder: '+ start something', mark: '›', next: 'done', edge: 'var(--ink)', box: 'var(--n500)' },
  { key: 'done', title: 'Done', placeholder: '+ log something done', mark: '✓', next: 'idea', edge: 'var(--n300)', box: 'var(--ink)' }
];

export function Lanes() {
  const [todos, setTodos] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/todos').then(r => r.json()).then(setTodos).catch(e => setError(String(e.message)));
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
      setTodos(previous); // a failed save must not look like a success
      setError('could not save');
      return false;
    }
  };

  // crypto.randomUUID over Date.now(): the brief's Date.now() id is unique in
  // practice but not guaranteed — two adds in the same millisecond (e.g. two
  // browser tabs) would collide and violate the stable-unique-key rule.
  const add = (lane, text) => save([...todos, { id: crypto.randomUUID(), text, lane, tag: 'Note' }]);
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
