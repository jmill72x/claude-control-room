import { useEffect, useRef, useState } from 'react';
import { useTick } from '../hooks/useTick.js';
import { byDue, dueChip, localToday } from '../lib/due.js';

const LANES = [
  { key: 'idea', title: 'Idea', placeholder: '+ new idea', mark: ' ', next: 'doing', edge: 'var(--n400)', box: 'transparent' },
  { key: 'doing', title: 'Doing', placeholder: '+ start something', mark: '›', next: 'done', edge: 'var(--ink)', box: 'var(--n500)' },
  { key: 'done', title: 'Done', placeholder: '+ log something done', mark: '✓', next: 'idea', edge: 'var(--n300)', box: 'var(--ink)' }
];
const LANE_BY_KEY = Object.fromEntries(LANES.map(l => [l.key, l]));

// Clicking the chip walks this list and then clears. The server refuses
// anything outside it, so a stray value can never sort as though it ranked.
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const rank = p => (PRIORITIES.includes(p) ? PRIORITIES.indexOf(p) : PRIORITIES.length);
const CHIP = {
  P0: { bg: 'var(--accent)', fg: 'var(--ground)', border: 'var(--accent)', style: 'solid' },
  P1: { bg: 'transparent', fg: 'var(--ink)', border: 'var(--ink)', style: 'solid' },
  P2: { bg: 'transparent', fg: 'var(--n700)', border: 'var(--n400)', style: 'solid' },
  P3: { bg: 'transparent', fg: 'var(--n500)', border: 'var(--n300)', style: 'solid' },
  // Not set. A dashed chip and a dash, never a default rank.
  none: { bg: 'transparent', fg: 'var(--n400)', border: 'var(--n300)', style: 'dashed' }
};

// Tags are typed freehand, so "Pi" and "pi" are the same group.
const tagKey = t => (t ?? '').trim().toLowerCase();

// Which axis the column is grouped on is a per-browser convenience, not
// data: it lives in localStorage, which can be absent or throw (private
// windows, blocked site data), so every touch is guarded.
const GROUP_KEY = 'ccr.todos.groupBy';
const readGroupBy = () => {
  try { return localStorage.getItem(GROUP_KEY) === 'tag' ? 'tag' : 'stage'; } catch { return 'stage'; }
};
const writeGroupBy = v => { try { localStorage.setItem(GROUP_KEY, v); } catch { /* per-viewer convenience only */ } };
// "Sort by due" is the same kind of per-viewer choice. The default is the
// board's usual order (priority, then the order items were added).
const SORT_KEY = 'ccr.todos.sortBy';
const readSortBy = () => {
  try { return localStorage.getItem(SORT_KEY) === 'due' ? 'due' : 'priority'; } catch { return 'priority'; }
};
const writeSortBy = v => { try { localStorage.setItem(SORT_KEY, v); } catch { /* per-viewer convenience only */ } };

// The due chip's colours. Overdue is the page's red; due soon is a quiet amber
// outline, so it is noticed without competing with the red.
const DUE_CHIP = {
  overdue: { fg: 'var(--ground)', bg: 'var(--accent)', border: 'var(--accent)' },
  soon: { fg: 'var(--warn)', bg: 'transparent', border: 'var(--warn)' },
  later: { fg: 'var(--n700)', bg: 'transparent', border: 'var(--n300)' },
  done: { fg: 'var(--n500)', bg: 'transparent', border: 'var(--n300)' }
};

// While the tab is open and visible, the board is re-read this often, so a
// page left open on the iPad catches up with Jarvis's writes without a tap.
const REFRESH_MS = 60 * 1000;
const STALE_MESSAGE = 'The board changed elsewhere, so that change was not saved. This is the current board; make it again.';

// `.then(r => r.json())` accepted any body the server sent, including a 500's
// `{error}` object, which then reached `todos.filter` and threw during render —
// taking the entire page down. Check the status, then check the shape.
async function fetchBoard() {
  const res = await fetch('/api/todos', { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('the server did not return a list');
  return { list: body, etag: res.headers.get('ETag') };
}

export function Lanes() {
  const [todos, setTodos] = useState([]);
  const [error, setError] = useState(null);
  // Until the list has actually been read, `todos` is an empty array we chose,
  // not an empty backlog we found: the lane counts must say so rather than
  // print a confident 0 next to a load error.
  const [loaded, setLoaded] = useState(false);
  const [groupBy, setGroupBy] = useState(readGroupBy);
  const [sortBy, setSortBy] = useState(readSortBy);
  // Re-render once a minute so "today", and with it the overdue colour, turns
  // over at midnight on a page left open.
  const today = localToday(new Date(useTick(60 * 1000)));
  // The id being edited, and the draft being typed. `draft` is deliberately
  // separate from `todos` so Escape can restore without a server round-trip.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ text: '', tag: '', due: '' });
  // Enter fires a commit, and the resulting blur fires another. Without a
  // guard the second one saves a stale draft over the first one's result.
  const committing = useRef(false);

  // The board's revision (its ETag) as of the list on screen. Every save sends
  // it as If-Match, and the server refuses a save made from an older board
  // with a 409, so a tab opened this morning can no longer write its copy over
  // the boards Jarvis saved since (NEXT.md §8.1).
  const etag = useRef(null);
  // Bumped whenever the list on screen is replaced from the server. A save
  // queued behind one that failed was made from the list that was just
  // replaced, so it is dropped rather than sent with the new revision.
  const epoch = useRef(0);
  // Saves go out one at a time, each with the revision the one before it
  // returned; two in flight at once would refuse each other.
  const chain = useRef(Promise.resolve());
  const inFlight = useRef(0);

  const adopt = ({ list, etag: tag }) => {
    etag.current = tag;
    epoch.current += 1;
    setTodos(list);
    setLoaded(true);
  };

  // Re-read the board, unless a save is under way (its answer brings the
  // revision) or nothing has changed since the last read.
  const refresh = async () => {
    if (inFlight.current > 0) return;
    try {
      const board = await fetchBoard();
      if (inFlight.current > 0) return;
      if (board.etag && board.etag === etag.current) return;
      adopt(board);
      setError(e => (e?.startsWith('could not load') ? null : e));
    } catch {
      // A failed background re-read leaves the list as it is; the next save
      // or the first load says what is wrong.
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const board = await fetchBoard();
        if (!cancelled) { adopt(board); setError(null); }
      } catch (e) {
        if (!cancelled) setError(`could not load: ${e.message}`);
      }
    })();
    // Coming back to the tab (switching apps on the iPad, waking the screen,
    // returning to a page from history) re-reads the board, and so does a
    // slow timer while the tab is in view.
    const onShow = () => { if (document.visibilityState === 'visible') refreshRef.current(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    window.addEventListener('pageshow', onShow);
    const timer = setInterval(onShow, REFRESH_MS);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
      window.removeEventListener('pageshow', onShow);
      clearInterval(timer);
    };
  }, []);

  // Returns true/false so callers (the Enter-to-add input) know whether the
  // write actually landed — an optimistic update that always looks like a
  // success would let a failed add clear the field as if it had saved.
  const save = next => {
    const previous = todos;
    const madeAt = epoch.current;
    setTodos(next); // optimistic
    inFlight.current += 1;
    const run = chain.current.then(() => send(next, previous, madeAt));
    chain.current = run.catch(() => {});
    return run.finally(() => { inFlight.current -= 1; });
  };

  const send = async (next, previous, madeAt) => {
    // The list this save was made from has been replaced since (an earlier
    // save was refused and the board re-read): it is not sent.
    if (epoch.current !== madeAt) return false;
    try {
      const res = await fetch('/api/todos', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          // No revision on record means the board was empty when read; `*`
          // still marks this as a page that checks revisions.
          'If-Match': etag.current ?? '*'
        },
        body: JSON.stringify(next)
      });
      if (res.status === 409 || res.status === 428) {
        // Someone else saved first. Show what the server holds now.
        try { adopt(await fetchBoard()); } catch { setTodos(previous); }
        setError(STALE_MESSAGE);
        return false;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      etag.current = res.headers.get('ETag') ?? etag.current;
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
        adopt(await fetchBoard());
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

  // A due date is only written when one was picked: an item without one has no
  // `due` key at all, the same shape it had before due dates existed.
  const withDue = (t, due) => {
    const { due: _dropped, ...rest } = t;
    return due ? { ...rest, due } : rest;
  };
  const add = (lane, text, due) => save([...todos, withDue({ id: newId(), text, lane, tag: 'Note' }, due)]);
  const advance = (id, next) => save(todos.map(t => (t.id === id ? { ...t, lane: next } : t)));
  const remove = id => save(todos.filter(t => t.id !== id));
  const cyclePriority = id => save(todos.map(t => {
    if (t.id !== id) return t;
    const i = PRIORITIES.indexOf(t.priority);
    // Past P3 the key is dropped rather than set to null, so an item that
    // has never been ranked and one that was un-ranked look the same on disk.
    if (i === PRIORITIES.length - 1) { const { priority: _dropped, ...rest } = t; return rest; }
    return { ...t, priority: PRIORITIES[i + 1] };
  }));

  const chooseGroupBy = v => { setGroupBy(v); writeGroupBy(v); };
  const chooseSortBy = v => { setSortBy(v); writeSortBy(v); };

  const beginEdit = t => {
    setEditingId(t.id);
    setDraft({ text: t.text ?? '', tag: t.tag ?? '', due: t.due ?? '' });
  };

  const cancelEdit = () => {
    // Unmounting a focused input fires a native blur, and that blur reaches the
    // onBlur handler holding the PRE-commit closure — same todos, same draft.
    // Hold the guard across that turn so the stale handler cannot re-commit a
    // draft we just saved, or re-commit one the user just discarded with Escape.
    committing.current = true;
    setEditingId(null);
    setDraft({ text: '', tag: '', due: '' });
    setTimeout(() => { committing.current = false; }, 0);
  };

  const commitEdit = async id => {
    if (committing.current) return;
    const text = draft.text.trim();
    const tag = draft.tag.trim();
    const due = draft.due;
    const original = todos.find(t => t.id === id);

    // Blanking the text and tabbing away must not erase the item — `×` is what
    // deletion is for. Treat an empty text exactly as Escape does.
    if (!original || !text) { cancelEdit(); return; }

    // Nothing changed: close without a write. A no-op PUT would still be a
    // write that could fail and raise an error banner for no reason.
    if (text === original.text && tag === (original.tag ?? '') && due === (original.due ?? '')) { cancelEdit(); return; }

    committing.current = true;
    const ok = await save(todos.map(t => {
      if (t.id !== id) return t;
      // An unchanged date is left exactly as it was on disk (even an empty
      // string Jarvis wrote); a changed one is set, or its key dropped.
      return due === (t.due ?? '') ? { ...t, text, tag } : withDue({ ...t, text, tag }, due);
    }));
    // Stay in edit mode when the write failed, so what was typed is not lost.
    // `save()` has already reverted the list and shown the error. cancelEdit()
    // re-arms the guard and schedules its own release, so do NOT clear it here
    // on the success path — clearing before the unmount is what let the phantom
    // blur through.
    if (ok) { cancelEdit(); return; }
    committing.current = false;
  };

  // Sort is stable, so items of equal priority keep the order they were added in.
  const byPriority = (a, b) => rank(a.priority) - rank(b.priority);
  // With "sort by due" on, dated items come first, soonest first, and the rest
  // keep the usual order. Both sorts are stable, so this second pass only
  // moves items whose dates differ.
  const order = items => (sortBy === 'due' ? items.sort(byDue) : items);

  // Both views render the same group shape: a header, sorted items, and
  // optionally an add box. Grouping by stage is the three lanes. Grouping by
  // tag lifts them: one section per tag, ordered by its best OPEN priority
  // (a tag whose only P0 is already done should not float to the top), done
  // items sinking to the bottom of their tag so the stage still reads.
  const groups = groupBy === 'stage'
    ? LANES.map(lane => ({
        key: lane.key, title: lane.title,
        items: order(todos.filter(t => t.lane === lane.key).sort(byPriority)),
        addLane: lane
      }))
    : (() => {
        const map = new Map();
        for (const t of todos) {
          const k = tagKey(t.tag);
          // First-seen casing names the group; it renders uppercase anyway.
          if (!map.has(k)) map.set(k, { key: `tag:${k}`, title: t.tag?.trim() || 'No tag', items: [] });
          map.get(k).items.push(t);
        }
        return [...map.values()]
          .map(g => {
            g.items.sort((a, b) => (a.lane === 'done') - (b.lane === 'done') || byPriority(a, b));
            // Done items stay at the bottom of their tag whichever way it is sorted.
            if (sortBy === 'due') g.items.sort((a, b) => (a.lane === 'done') - (b.lane === 'done') || byDue(a, b));
            const open = g.items.filter(t => t.lane !== 'done');
            g.best = open.length ? Math.min(...open.map(t => rank(t.priority))) : PRIORITIES.length + 1;
            return g;
          })
          .sort((a, b) => a.best - b.best || a.title.localeCompare(b.title));
      })();

  // The add box. Open lanes get an optional date beside it; the Done lane
  // logs what already happened, so it has none.
  const addInput = lane => {
    const dated = lane.key !== 'done';
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        <input
          type="text"
          className="ccr-lane-input"
          placeholder={lane.placeholder}
          onKeyDown={async e => {
            if (e.key !== 'Enter') return;
            const input = e.target;
            const v = input.value.trim();
            if (!v) return;
            const dateInput = dated ? input.parentElement.querySelector('input[type="date"]') : null;
            // Clear only once the write has actually landed — clearing
            // synchronously (as the brief does) would empty the field
            // even when the save fails and reverts, making a dropped
            // write look identical to a successful one.
            const ok = await add(lane.key, v, dateInput?.value || '');
            if (ok) {
              input.value = '';
              if (dateInput) dateInput.value = '';
            }
          }}
          style={{
            fontFamily: 'inherit', fontSize: 12, fontWeight: 500, padding: '8px 10px',
            border: 'var(--rule-fine)', background: 'transparent', color: 'var(--ink)',
            flex: '1 1 auto', minWidth: 0
          }}
        />
        {dated && (
          <input
            type="date"
            className="ccr-lane-input ccr-due-input num"
            aria-label={`Due date for a new ${lane.title} item (optional)`}
            title="Due date (optional)"
            style={{
              fontFamily: 'inherit', fontSize: 12, fontWeight: 500, padding: '0 8px',
              border: 'var(--rule-fine)', background: 'transparent', color: 'var(--ink)',
              flex: '0 0 auto', width: 128
            }}
          />
        )}
      </div>
    );
  };

  const segment = (current, choose, value, label, first) => (
    <button
      className="ccr-lane-seg"
      aria-pressed={current === value}
      onClick={() => choose(value)}
      style={{
        fontFamily: 'inherit', cursor: 'pointer', fontSize: 10, fontWeight: 800,
        letterSpacing: '0.12em', textTransform: 'uppercase', padding: '5px 10px',
        border: '1px solid var(--ink)', borderLeft: first ? '1px solid var(--ink)' : 0,
        background: current === value ? 'var(--ink)' : 'transparent',
        color: current === value ? 'var(--ground)' : 'var(--ink)'
      }}
    >{label}</button>
  );

  return (
    <>
      {error && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{error}</div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: -8 }}>
        <span className="section-label">Group by</span>
        <div style={{ display: 'flex' }}>
          {segment(groupBy, chooseGroupBy, 'stage', 'Stage', true)}
          {segment(groupBy, chooseGroupBy, 'tag', 'Tag')}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: -8 }}>
        <span className="section-label">Sort by</span>
        <div style={{ display: 'flex' }}>
          {segment(sortBy, chooseSortBy, 'priority', 'Priority', true)}
          {segment(sortBy, chooseSortBy, 'due', 'Due')}
        </div>
      </div>
      {groups.map(group => (
        <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            gap: 8, borderBottom: '1px solid var(--ink)', paddingBottom: 5
          }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              {group.title}
            </span>
            <span className="num" style={{ fontSize: 11, fontWeight: 700, color: 'var(--n600)' }}>
              {loaded ? group.items.length : '—'}
            </span>
          </div>
          {group.items.map(t => {
            const lane = LANE_BY_KEY[t.lane];
            const chip = CHIP[t.priority] ?? CHIP.none;
            const due = dueChip(t.due, t.lane, today);
            return (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'start',
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
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className="section-label" style={{ fontSize: 9 }}>Due</span>
                      <input
                        type="date"
                        className="ccr-lane-input ccr-due-input num"
                        value={draft.due}
                        onChange={e => setDraft(d => ({ ...d, due: e.target.value }))}
                        aria-label="Due date"
                        style={{
                          fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: '0 4px',
                          border: 'var(--rule-fine)', background: 'var(--ground)', color: 'var(--ink)',
                          width: 132
                        }}
                      />
                      {draft.due && (
                        <button
                          type="button"
                          className="ccr-lane-seg"
                          // Keep focus in the card, so pressing this is not
                          // read as leaving it (which would save first).
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => setDraft(d => ({ ...d, due: '' }))}
                          aria-label="Clear the due date"
                          style={{
                            fontFamily: 'inherit', cursor: 'pointer', fontSize: 9, fontWeight: 800,
                            letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 8px',
                            border: '1px solid var(--n400)', background: 'transparent', color: 'var(--n700)'
                          }}
                        >Clear</button>
                      )}
                    </div>
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
                    {(t.tag || due) && (
                      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        {t.tag && (
                          <span style={{
                            fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                            textTransform: 'uppercase', color: 'var(--n600)'
                          }}>{t.tag}</span>
                        )}
                        {due && (
                          <span
                            className="ccr-due-chip num"
                            data-state={due.state}
                            title={due.title}
                            style={{
                              fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', lineHeight: '13px',
                              textTransform: 'uppercase', whiteSpace: 'nowrap', padding: '0 5px',
                              border: `1px solid ${DUE_CHIP[due.state].border}`,
                              background: DUE_CHIP[due.state].bg, color: DUE_CHIP[due.state].fg
                            }}
                          >{due.label}</span>
                        )}
                      </span>
                    )}
                  </span>
                )}
                <button
                  className="ccr-lane-prio num"
                  onClick={() => cyclePriority(t.id)}
                  title={t.priority ? `Priority ${t.priority} — click to change` : 'No priority — click to set'}
                  aria-label={t.priority ? `Priority ${t.priority}, click to change` : 'No priority, click to set'}
                  style={{
                    fontFamily: 'inherit', cursor: 'pointer', marginTop: 1, padding: '1px 5px',
                    fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', lineHeight: '14px',
                    border: `1px ${chip.style} ${chip.border}`, background: chip.bg, color: chip.fg
                  }}
                >{t.priority ?? '—'}</button>
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
            );
          })}
          {group.addLane && addInput(group.addLane)}
        </div>
      ))}
      {/* Grouped by tag there is no lane to add into, so one box at the
          bottom adds to Idea — the same place a card starts in stage view. */}
      {groupBy === 'tag' && loaded && addInput(LANE_BY_KEY.idea)}
    </>
  );
}
