import { useCallback, useEffect, useRef, useState } from 'react';
import { getFeed } from './feedApi.js';
import { FEED_POLL_MS, phaseForStatus } from '../lib/orbit/feed.js';

// The Feed tab's state: read when the tab opens, then once a minute while it stays
// open and the page is in view, and again when the page comes back into view. The
// last answer is kept when the tab closes, so going back shows it at once while the
// next read is on its way. No push, no stream: the feed is for reading.
export function useFeed({ active }) {
  const [phase, setPhase] = useState('loading'); // loading | ok | unpaired | forbidden | error
  const [feed, setFeed] = useState(null);
  const [problem, setProblem] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const body = await getFeed();
      setFeed(body);
      setPhase('ok');
      setProblem(null);
      setLoadedAt(Date.now());
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 0;
      setPhase(phaseForStatus(status));
      setProblem(status ? String(err.message) : 'the server could not be reached');
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, FEED_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, load]);

  return { phase, feed, problem, loadedAt, reload: load };
}
