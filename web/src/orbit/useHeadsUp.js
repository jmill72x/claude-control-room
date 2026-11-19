import { useCallback, useEffect, useRef, useState } from 'react';
import { getHeadsUp } from './proactiveApi.js';
import { HEADS_POLL_MS } from '../lib/orbit/headsup.js';

// Heads up's answer: read when the Overview shows, then once a minute while it stays in
// view, and again when the page comes back into view. Any refusal or failure (an
// unpaired device, a server from before the check, the network) leaves no answer, and
// the section simply isn't drawn: Heads up is a convenience, the event is the signal.
export function useHeadsUp({ active }) {
  const [answer, setAnswer] = useState(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setAnswer(await getHeadsUp());
    } catch {
      setAnswer(null);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, HEADS_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, load]);

  return answer;
}
