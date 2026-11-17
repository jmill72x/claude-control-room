// Read aloud on the lead's chat bubbles: the browser's own speech engine
// (window.speechSynthesis), on the page alone. No server change and no network call
// from here (a system voice may itself be a network voice; that is the browser's
// choice). Checked by web/test/orbit-speech.test.js.
//
// What is spoken is the message's words without its Markdown: the same parser as the
// bubble (markdown.js), so emphasis, headings and inline code read as their words, a
// link by its label, a bare address as "a link to <host>", and a fenced code block is
// named and skipped (symbols read one by one help nobody). Each block ends as a
// sentence, so the voice pauses between paragraphs and list items.
//
// The speaker holds one message at a time. A tap queues every piece of the message at
// once, inside the tap (mobile Safari speaks only from a user gesture), the pieces at
// most CHUNK_MAX characters (some engines cut a long utterance short). A second tap on
// the same message stops it; a tap on another stops the first and starts the second.
// The Chat tab stops it when it is left or the page is hidden.
import { parseMarkdown } from './markdown.js';

export const CODE_WORDS = 'Code block skipped.';
export const CHUNK_MAX = 220;

const ENDS = /[.!?:;\u2026]$/;
const sentence = s => { const t = s.replace(/\s+/g, ' ').trim(); return t === '' || ENDS.test(t) ? t : `${t}.`; };

// A written link carries its host from the parser; a bare address (only http and
// https are made links) doesn't, so it is read from the URL.
const URLISH = /^(https?:|mailto:)/i;
function hostOf(href) {
  try { return new URL(href).host; } catch { return null; }
}

function inlineWords(nodes) {
  return nodes.map(n => {
    if (n.type === 'text' || n.type === 'codespan') return n.text;
    if (n.type === 'link') {
      const label = inlineWords(n.children).trim();
      // A bare address shown as its own label: say where it goes, not its characters.
      if (label === '' || URLISH.test(label)) { const host = n.host ?? hostOf(n.href); return host ? `a link to ${host}` : 'a link'; }
      return label;
    }
    return Array.isArray(n.children) ? inlineWords(n.children) : '';
  }).join('');
}

function blockWords(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'code') out.push(CODE_WORDS);
    else if (b.type === 'ul' || b.type === 'ol') for (const item of b.items) out.push(...blockWords(item));
    else if (Array.isArray(b.children)) out.push(sentence(inlineWords(b.children)));
  }
  return out.filter(Boolean);
}

// A message's Markdown as the words to speak, or '' when there are none.
// parseMarkdown answers an empty tree for anything but a non-empty string.
export function speechText(md) {
  return blockWords(parseMarkdown(md).children).join(' ');
}

const isHigh = c => c >= 0xd800 && c <= 0xdbff;

// One sentence longer than `max`, cut at the last space that fits, or hard at `max`
// (never between the halves of a pair).
function cutLong(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    if (space > 0) { out.push(rest.slice(0, space)); rest = rest.slice(space + 1); continue; }
    let cut = max;
    if (isHigh(rest.charCodeAt(cut - 1))) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

// The text in pieces of at most `max` characters: whole sentences joined while they fit.
export function speechChunks(text, max = CHUNK_MAX) {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (t === '') return [];
  const out = [];
  let cur = '';
  for (const s of t.split(/(?<=[.!?\u2026])\s+/)) {
    for (const piece of cutLong(s, max)) {
      if (cur === '') cur = piece;
      else if (cur.length + 1 + piece.length <= max) cur += ` ${piece}`;
      else { out.push(cur); cur = piece; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// The speaker over a speechSynthesis (`synth`) and its utterance class. `current()` is
// the id of the message speaking, or null; `subscribe(fn)` calls fn on every change.
// Each start takes a new token, and an utterance's late end or error (a cancelled
// message's) acts only while its own token is the current one.
export function createSpeaker({ synth = null, Utterance = null, chunkMax = CHUNK_MAX } = {}) {
  const supported = Boolean(synth && typeof synth.speak === 'function' && typeof synth.cancel === 'function' && typeof Utterance === 'function');
  const listeners = new Set();
  let current = null; // { id, token }
  let token = 0;
  const emit = () => { for (const fn of [...listeners]) fn(); };
  const cancel = () => { try { synth.cancel(); } catch { /* nothing to stop */ } };

  function stop() {
    if (!current) return;
    current = null;
    token++;
    cancel();
    emit();
  }

  function toggle(id, md) {
    if (!supported) return false;
    if (current && current.id === id) { stop(); return false; }
    const chunks = speechChunks(speechText(md), chunkMax);
    if (chunks.length === 0) return false;
    // One at a time: whatever speaks now (this speaker's, or anything else on the page) stops first.
    if (current || synth.speaking || synth.pending) { current = null; token++; cancel(); }
    const mine = ++token;
    current = { id, token: mine };
    const isMine = () => current !== null && current.token === mine;
    try {
      chunks.forEach((text, i) => {
        const u = new Utterance(text);
        // An engine error ends the whole message, its later pieces too.
        u.onerror = () => { if (!isMine()) return; current = null; cancel(); emit(); };
        if (i === chunks.length - 1) u.onend = () => { if (!isMine()) return; current = null; emit(); };
        synth.speak(u);
      });
    } catch {
      current = null;
      token++;
      cancel();
      emit();
      return false;
    }
    emit();
    return true;
  }

  return {
    supported, toggle, stop,
    current: () => (current ? current.id : null),
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
  };
}
