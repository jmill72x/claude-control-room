import { useState } from 'react';

// Sort is a per-viewer choice kept in this browser. Storage can be missing or
// throw (a private window, blocked site data), so every touch is guarded.
const SORT_KEY = 'ccr.orbit.sortBy';
const readSort = () => { try { return localStorage.getItem(SORT_KEY) === 'due' ? 'due' : 'priority'; } catch { return 'priority'; } };
const writeSort = v => { try { localStorage.setItem(SORT_KEY, v); } catch { /* a per-viewer convenience only */ } };

// The Board tab's filters, shared by the band in the header (owner chips) and
// the tab below it.
export function useBoardFilters() {
  const [owner, setOwner] = useState(null);
  const [priority, setPriority] = useState(null);
  const [sort, setSortState] = useState(readSort);
  const [ideasAll, setIdeasAll] = useState(false);
  const setSort = v => { setSortState(v); writeSort(v); };
  return { owner, setOwner, priority, setPriority, sort, setSort, ideasAll, setIdeasAll };
}
