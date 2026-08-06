import { useEffect, useState } from 'react';

export function useDashboard(intervalMs = 30000) {
  const [state, setState] = useState({ payload: null, error: null, receivedAt: null });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setState({ payload: data, error: null, receivedAt: Date.now() });
      } catch (err) {
        // Keep the last payload: a failed poll makes panels stale, never blank.
        // But the error must reach the UI — a page still showing the last good
        // numbers while the server is gone is the exact lie this project exists
        // to prevent, so `error` is part of the returned state and App renders a
        // banner off it.
        if (!cancelled) setState(prev => ({ ...prev, error: String(err.message) }));
      }
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return state;
}
