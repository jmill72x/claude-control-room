// Watches for a new build and reloads the page once it's safe (lib/orbit/build.js
// has the why and the rules). It looks when the page starts, whenever it comes
// back into view (the home-screen app resuming), and every minute while it's
// shown; while a reload is waiting on something unsent, every 5 s.
import { parseBuild, reloadDecision, isTyping } from '../lib/orbit/build.js';

/* global __BUILD_ID__ */
const MINE = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : null;
const KEY = 'jos-reloaded-for';
const EVERY_MS = 60_000;
const WAIT_MS = 5_000;

const holds = new Set();
let timer = null;
let started = false;

// Parts of the page with something unsent say so here (the composer, the chat's
// sending messages); a reload waits until every hold is let go.
export function holdReload(key, on) {
  if (on) holds.add(key);
  else holds.delete(key);
}

function remembered() {
  try { return window.sessionStorage.getItem(KEY); } catch { return null; }
}
function remember(id) {
  try { window.sessionStorage.setItem(KEY, id); return window.sessionStorage.getItem(KEY) === id; } catch { return false; }
}

async function served() {
  try {
    const r = await fetch('/build.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    return parseBuild(r.headers.get('Content-Type'), await r.text());
  } catch {
    return null;
  }
}

function later(ms) {
  clearTimeout(timer);
  timer = document.visibilityState === 'hidden' ? null : setTimeout(check, ms);
}

async function check() {
  const id = await served();
  const busy = holds.size > 0 || isTyping(document.activeElement);
  const what = reloadDecision({ mine: MINE, served: id, reloadedFor: remembered(), busy });
  if (what === 'reload' && remember(id)) {
    window.location.reload();
    return;
  }
  later(what === 'wait' ? WAIT_MS : EVERY_MS);
}

export function watchBuild() {
  if (started || !MINE) return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
    else { clearTimeout(timer); timer = null; }
  });
  window.addEventListener('pageshow', e => { if (e.persisted) check(); });
  check();
}
