import { useEffect, useState } from 'react';

export function useDashboard(intervalMs = 30000) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setPayload(data); setError(null); }
      } catch (err) {
        // Keep the last payload: a failed poll makes panels stale, never blank.
        if (!cancelled) setError(String(err.message));
      }
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return { payload, error };
}
