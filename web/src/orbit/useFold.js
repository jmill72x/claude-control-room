import { useState } from 'react';
import { readFold, writeFold } from '../lib/orbit/home.js';

// A fold on the Overview (Usage's Burn and hour by hour, the loops' line in Today's
// schedule): open or closed, remembered per viewer in this browser under its own key
// (lib/orbit/home.js, FOLD_KEYS). Storage can be missing or throw (a private window,
// blocked site data); the guards are in readFold and writeFold, and the fold renders
// closed without it.
const storage = () => { try { return globalThis.localStorage; } catch { return null; } };

export function useFold(key) {
  const [open, setOpenState] = useState(() => readFold(storage(), key));
  const setOpen = v => { setOpenState(v); writeFold(storage(), key, v); };
  return [open, setOpen];
}
