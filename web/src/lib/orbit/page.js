// Page-wide helpers for the Orbit page: times, token figures, the tab in the
// address, the "Updated" line and the agents' colours. Checked by
// web/test/orbit-page.test.js.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');

// 9:05 AM. With `short`, a time on the hour drops its minutes: 8 PM.
export function clock(ts, { short = false } = {}) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return short && d.getMinutes() === 0 ? `${h} ${ampm}` : `${h}:${pad(d.getMinutes())} ${ampm}`;
}

// The header's date line: Tue 10-21 · 9:05 AM
export const headerDate = now => {
  const d = new Date(now);
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${clock(now)}`;
};

// Token figures to two or three significant digits: 950, 1.2K, 58K, 445M, 4.2B.
export function compactTokens(n) {
  if (!Number.isFinite(n)) return '—';
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, unit] of units) {
    if (Math.abs(n) >= size) {
      const x = n / size;
      return `${x < 10 ? Number(x.toFixed(1)) : Math.round(x)}${unit}`;
    }
  }
  return String(Math.round(n));
}

// ---- the tab in the address: #overview, #board, #board/<id> ----

export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (raw === 'board') return { tab: 'board', item: null };
  if (raw.startsWith('board/')) {
    let item = null;
    try { item = decodeURIComponent(raw.slice('board/'.length)) || null; } catch { item = null; }
    return { tab: 'board', item };
  }
  return { tab: 'overview', item: null };
}

export function routeHash({ tab, item = null }) {
  if (tab !== 'board') return '#overview';
  return item === null || item === undefined || item === '' ? '#board' : `#board/${encodeURIComponent(String(item))}`;
}

// ---- "Updated N s ago" ----

// Past this, the figures on the page are not current, and the line turns amber.
export const STALE_AFTER_MS = 3 * 60 * 1000;

const ago = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

// How fresh the page is: the worse of the server's own time and when the answer
// arrived, so neither a slept tab nor a cached answer passes as live. Red when
// the last poll failed, amber past 3 minutes.
export function freshness({ serverTime = null, receivedAt = null, error = null, now }) {
  const stamps = [serverTime, receivedAt].filter(Number.isFinite);
  if (stamps.length === 0) {
    return error ? { tone: 'down', label: "Can't reach the server" } : { tone: 'waiting', label: 'Loading…' };
  }
  const age = Math.max(...stamps.map(t => now - t));
  if (error) return { tone: 'down', label: `Can't reach the server · last update ${ago(age)}` };
  if (age > STALE_AFTER_MS) return { tone: 'stale', label: `Updated ${ago(age)} · not current` };
  return { tone: 'ok', label: `Updated ${ago(age)}` };
}

// ---- the agents' colours ----

// By place in config's roster: the design's eight, in the order it drew its
// agents. `night` is for the navy header, `day` for the paper panels. An agent
// the roster doesn't know is grey.
const NIGHT = ['#5EDCF0', '#B5E86A', '#F59AC8', '#F5C860', '#B9A6FB', '#FF9F6E', '#FF8F8F', '#F8F7F3'];
const DAY = ['#0E7490', '#4D7C0F', '#BE185D', '#A16207', '#6D28D9', '#C2410C', '#B91C1C', '#3D4F7A'];
export function agentColors(index) {
  if (!Number.isInteger(index) || index < 0) return { night: '#A9B4CB', day: '#4E5872' };
  return { night: NIGHT[index % NIGHT.length], day: DAY[index % DAY.length] };
}

// The neutral stand-in for an avatar: the first letter of the name or key.
export const initialOf = name => (Array.from(String(name ?? '').trim())[0] ?? '?').toUpperCase();
