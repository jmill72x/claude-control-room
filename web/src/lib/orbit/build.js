// Picking up a new build (2026-11-11). The home-screen app on an iPhone stays
// alive in the background, so after a build it kept showing the old page until
// it was swiped away. Each build now carries an id, compiled into the page and
// written beside it as /build.json; the page reads that file now and then, and
// when the id there is another one it reloads itself, once, at a safe moment.
// The DOM side is orbit/buildWatch.js; these are the decisions, kept pure.

// The id in /build.json's answer, or null. With no build.json (a build from
// before this change) the server's single-page fallback answers with the page
// itself, as text/html, which must read as "no id", never as a new one.
export function parseBuild(contentType, text) {
  if (!/^application\/json\b/i.test(String(contentType ?? ''))) return null;
  try {
    const id = JSON.parse(text)?.build;
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// What to do with what the server says: 'none', 'wait' (a newer build, but now
// is not the moment) or 'reload'.
// - mine: this page's own id; null in the dev server, which never reloads.
// - served: the id from /build.json, null when unknown.
// - reloadedFor: the id this tab last reloaded for. If the reload still brought
//   back the old page (a cache in between), it doesn't try again for that id:
//   one reload per new build, never a loop.
// - busy: something unsent on the page (the composer, an upload, a field being
//   typed in). The reload waits for it.
// The caller reloads only once it has stored `served` as reloadedFor (session
// storage): if it can't, a stale cache could loop the page.
export function reloadDecision({ mine, served, reloadedFor = null, busy = false }) {
  if (!mine || !served || served === mine) return 'none';
  if (reloadedFor === served) return 'none';
  return busy ? 'wait' : 'reload';
}

// A message of this device's that hasn't reached the server: still uploading or
// sending, or failed and waiting for Retry or Discard. A reload would lose it
// (the files live only in this page). One the server has taken has an id.
export function hasUnsent(messages) {
  return (messages ?? []).some(m => !Number.isInteger(m?.seq) && !m?.id);
}

// A text field with something typed in it has the focus (the Board's New item,
// an edit, the pairing name): reloading would throw that away.
export function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return String(el.value ?? '') !== '';
  if (tag !== 'INPUT') return false;
  const type = String(el.type ?? 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'image'].includes(type) && String(el.value ?? '') !== '';
}
