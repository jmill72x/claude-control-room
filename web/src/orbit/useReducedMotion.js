import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';
const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null);

// True while the viewer has Reduce Motion on. CSS animations follow it through
// orbit.css; SVG's own animation elements don't, so the map leaves them out.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => Boolean(query()?.matches));
  useEffect(() => {
    const mq = query();
    if (!mq?.addEventListener) return undefined;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
