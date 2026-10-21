import { useCallback, useEffect, useRef, useState } from 'react';

// The board for the Orbit page: read once for both tabs, and saved with the
// classic page's protections (components/Lanes.jsx, which this copies while the
// two pages live side by side):
//   - every PUT carries the revision it was made from (If-Match), so a tab left
//     open since this morning can't write its copy over newer boards;
//   - saves go out one at a time, each with the revision the last one returned;
//   - a 409 or 428 re-reads the board and says the change was not saved;
//   - the board is re-read when the tab comes back into view, and every minute
//     while it is visible.
// One thing is new: after a save, the page takes the list the server returns,
// since the server may have added a `doneAt`. Not while another save is queued
// behind it, though: that one was made from the list on screen and brings its
// own answer.

const REFRESH_MS = 60 * 1000;
export const STALE_MESSAGE = 'The board changed elsewhere, so that change was not saved. This is the current board; make it again.';

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

// randomUUID exists only in a secure context, and the tailnet serves this page
// over plain HTTP, so there is a fallback (see Lanes.jsx).
export const newId = () =>
  globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function useBoard() {
  const [todos, setTodos] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  // The list as of the last change, optimistic ones included, for the next save
  // to build on even before React re-renders.
  const latest = useRef([]);
  const etag = useRef(null);
  const epoch = useRef(0);
  const chain = useRef(Promise.resolve());
  const inFlight = useRef(0);

  const show = list => { latest.current = list; setTodos(list); };
  const adopt = ({ list, etag: tag }) => {
    etag.current = tag;
    epoch.current += 1;
    show(list);
    setLoaded(true);
  };

  const refresh = async () => {
    if (inFlight.current > 0) return;
    try {
      const board = await fetchBoard();
      if (inFlight.current > 0) return;
      if (board.etag && board.etag === etag.current) return;
      adopt(board);
      setError(e => (e?.startsWith('Could not load') ? null : e));
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
        if (!cancelled) setError(`Could not load the board: ${e.message}`);
      }
    })();
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

  const send = async (next, previous, madeAt) => {
    // The list this save was made from was replaced since (an earlier save was
    // refused and the board re-read), so it is not sent.
    if (epoch.current !== madeAt) return false;
    try {
      const res = await fetch('/api/todos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag.current ?? '*' },
        body: JSON.stringify(next)
      });
      if (res.status === 409 || res.status === 428) {
        try { adopt(await fetchBoard()); } catch { show(previous); }
        setError(STALE_MESSAGE);
        return false;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      etag.current = res.headers.get('ETag') ?? etag.current;
      if (inFlight.current === 1 && Array.isArray(body)) show(body);
      setError(null);
      return true;
    } catch (e) {
      // Ask the server what is true rather than rewinding: only when it can't
      // be reached at all did no write land, and the list before is right.
      try { adopt(await fetchBoard()); } catch { show(previous); }
      setError(`Not saved: ${e.message}`);
      return false;
    }
  };

  // `change` takes the current list and returns the next one (or null for no
  // change). Resolves true when the server took it.
  const save = useCallback(change => {
    const previous = latest.current;
    const next = change(previous);
    if (!Array.isArray(next) || next === previous) return Promise.resolve(false);
    const madeAt = epoch.current;
    show(next);
    inFlight.current += 1;
    const run = chain.current.then(() => send(next, previous, madeAt));
    chain.current = run.catch(() => {});
    return run.finally(() => { inFlight.current -= 1; });
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { todos, loaded, error, save, clearError };
}
