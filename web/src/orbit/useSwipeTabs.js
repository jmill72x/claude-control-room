import { useEffect, useRef } from 'react';
import { swipeTab, blocksSwipe } from '../lib/orbit/nav.js';

// A sideways swipe anywhere on the page moves to the next or previous tab
// (src/lib/orbit/nav.js has the rules). Touch events only, all passive: the page
// never cancels a scroll, so the Board's lanes and every other scroller keep
// their own sideways scroll, and a mouse or trackpad drag never changes the tab.
// Nothing here depends on the screen's width, so the iPad swipes like the iPhone.
export function useSwipeTabs({ tab, go }) {
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    let start = null;
    const onStart = e => {
      // One finger, and not over a dialog, a field or something that scrolls sideways.
      if (e.touches.length !== 1 || document.querySelector('[aria-modal="true"]') || blocksSwipe(e.target, n => window.getComputedStyle(n))) { start = null; return; }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, at: e.timeStamp, scrollX: window.scrollX };
    };
    const onMove = e => { if (start && e.touches.length !== 1) start = null; };
    const onEnd = e => {
      const s = start;
      start = null;
      if (!s || e.changedTouches.length !== 1) return;
      // A long press that selected text, a page zoomed in (a one-finger drag pans
      // it), or a page that itself scrolled sideways is not a swipe.
      if (String(window.getSelection?.() ?? '') !== '' || (window.visualViewport?.scale ?? 1) > 1.01 || window.scrollX !== s.scrollX) return;
      const t = e.changedTouches[0];
      const next = swipeTab({ tab: tabRef.current, startX: s.x, dx: t.clientX - s.x, dy: t.clientY - s.y, ms: e.timeStamp - s.at, width: window.innerWidth });
      if (next) goRef.current({ tab: next });
    };
    const onCancel = () => { start = null; };
    const opts = { passive: true };
    window.addEventListener('touchstart', onStart, opts);
    window.addEventListener('touchmove', onMove, opts);
    window.addEventListener('touchend', onEnd, opts);
    window.addEventListener('touchcancel', onCancel, opts);
    return () => {
      window.removeEventListener('touchstart', onStart, opts);
      window.removeEventListener('touchmove', onMove, opts);
      window.removeEventListener('touchend', onEnd, opts);
      window.removeEventListener('touchcancel', onCancel, opts);
    };
  }, []);
}
