import { useState } from 'react';

// The phone's "More" disclosure (docs/design/2026-11-10-jarvis-os-home.md, §5.5):
// open or closed, remembered per viewer in this browser. Storage can be missing
// or throw (a private window, blocked site data), so every touch is guarded, and
// the fold renders closed without it.
const KEY = 'ccr.orbit.more';
const read = () => { try { return localStorage.getItem(KEY) === 'open'; } catch { return false; } };
const write = open => { try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch { /* a per-viewer convenience only */ } };

export function useMore() {
  const [open, setOpenState] = useState(read);
  const setOpen = v => { setOpenState(v); write(v); };
  return [open, setOpen];
}
