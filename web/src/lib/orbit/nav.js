// Moving between the tabs: the swipe (any width, any device with touch) and the
// sticky tab bar's "stuck" test. Checked by web/test/orbit-nav.test.js.
//
// There was no swipe of the page's own before 2026-11-11: what worked on the
// iPhone was iOS's back/forward edge swipe through the tabs' #hash history, which
// starts only at the screen's very edge and only goes where the history already
// went. This swipe goes by tab order from anywhere on the page, and leaves the
// edges to the system, so the two never both fire.

// Feed (2026-11-11) went last: the Chat keeps the place Jeff's thumb already knows.
export const TAB_ORDER = ['overview', 'board', 'chat', 'feed'];

// A swipe starting this close to the screen's left or right edge is the system's.
export const EDGE_PX = 24;
// How far the finger must travel sideways, how long it may take, and how much
// sideways it must be (dx at least twice dy): anything else is a scroll or a tap.
export const MIN_DX = 60;
export const MAX_MS = 700;

// The tab a finished gesture moves to, or null. A swipe to the left (dx < 0)
// shows the next tab, as paging does on iOS.
export function swipeTab({ tab, startX, dx, dy, ms, width }) {
  const at = TAB_ORDER.indexOf(tab);
  if (at < 0) return null;
  if (!(startX >= EDGE_PX && startX <= width - EDGE_PX)) return null;
  if (!(Math.abs(dx) >= MIN_DX) || Math.abs(dx) < 2 * Math.abs(dy) || !(ms <= MAX_MS)) return null;
  return TAB_ORDER[at + (dx < 0 ? 1 : -1)] ?? null;
}

const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const SCROLLS = new Set(['auto', 'scroll']);

// Whether a touch that started on `node` belongs to something else: a field,
// editable text, a dialog, an area marked data-noswipe, or anything that scrolls
// sideways now (the Board's lanes when they overflow). `styleOf` is
// getComputedStyle, passed in so the test needs no DOM.
export function blocksSwipe(node, styleOf) {
  for (let n = node; n; n = n.parentElement) {
    const attr = name => n.getAttribute?.(name) ?? null;
    if (FIELDS.has(n.tagName) || n.isContentEditable) return true;
    if (attr('role') === 'dialog' || attr('aria-modal') === 'true' || attr('data-noswipe') !== null) return true;
    if (n.scrollWidth > n.clientWidth + 1 && SCROLLS.has(styleOf(n)?.overflowX)) return true;
  }
  return false;
}

// The tab bar is pinned to the top once its place in the header has scrolled
// fully above the viewport (an IntersectionObserver entry's isIntersecting and
// boundingClientRect.top).
export const navStuck = entry => Boolean(entry) && !entry.isIntersecting && entry.top < 0;
