// Read aloud on the lead's chat bubbles: the browser's own speech engine
// (window.speechSynthesis), on the page alone. No server change and no network call
// from here. Only an on-device voice is used (localService true), set on every piece,
// so Jarvis's words never go to a network voice such as Chrome's "Google US English"
// (option (a), 2026-11-16). Where the browser lists no on-device voice the speaker
// can't speak and the page shows no button. Checked by web/test/orbit-speech.test.js.
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

// A language tag compared loosely: case and Android's underscore don't matter.
const tagOf = t => (typeof t === 'string' ? t.trim().toLowerCase().replace(/_/g, '-') : '');

// The voice to speak in, from speechSynthesis.getVoices(): on-device ones only (a
// real `localService === true`), the default one first, then the first of `langs`
// (the page's language, then the browser's) matched exactly, then by language alone
// (en-US finds en-GB), then any. null when none is on-device.
export function pickLocalVoice(voices, langs = []) {
  const local = (Array.isArray(voices) ? voices : []).filter(v => v !== null && typeof v === 'object' && v.localService === true);
  if (local.length === 0) return null;
  const preferred = local.find(v => v.default === true);
  if (preferred) return preferred;
  const wants = (Array.isArray(langs) ? langs : []).map(tagOf).filter(Boolean);
  for (const w of wants) { const hit = local.find(v => tagOf(v.lang) === w); if (hit) return hit; }
  for (const w of wants) {
    const base = w.split('-')[0];
    const hit = local.find(v => tagOf(v.lang).split('-')[0] === base);
    if (hit) return hit;
  }
  return local[0];
}

// The speaker over a speechSynthesis (`synth`) and its utterance class. `current()` is
// the id of the message speaking, or null; `canSpeak()` says whether an on-device voice
// is there to speak in; `subscribe(fn)` calls fn on every change of either. Each start
// takes a new token, and an utterance's late end or error (a cancelled message's) acts
// only while its own token is the current one.
//
// The voice list can be empty at first load (Chrome fills it in later and says so with
// `voiceschanged`; some engines fill it without the event), so it is read again on
// that event, on every subscribe and on every tap. Without getVoices there is no way
// to tell an on-device voice from a network one, so that engine counts as none.
export function createSpeaker({ synth = null, Utterance = null, chunkMax = CHUNK_MAX, langs = [] } = {}) {
  const supported = Boolean(synth && typeof synth.speak === 'function' && typeof synth.cancel === 'function'
    && typeof synth.getVoices === 'function' && typeof Utterance === 'function');
  const listeners = new Set();
  let current = null; // { id, token }
  let token = 0;
  let voice = null;
  const emit = () => { for (const fn of [...listeners]) fn(); };
  const cancel = () => { try { synth.cancel(); } catch { /* nothing to stop */ } };

  // Reads the list again. Losing the last on-device voice stops what is speaking.
  function refreshVoice() {
    if (!supported) return;
    let list = [];
    try { list = synth.getVoices(); } catch { list = []; }
    const had = voice !== null;
    voice = pickLocalVoice(list, langs);
    if (voice === null && current) { current = null; token++; cancel(); emit(); return; }
    if (had !== (voice !== null)) emit();
  }

  if (supported) {
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refreshVoice);
    else if (synth.onvoiceschanged == null) synth.onvoiceschanged = refreshVoice;
    refreshVoice();
  }

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
    refreshVoice();
    if (voice === null) return false;
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
        // Always named: left unset, the browser may pick a network voice.
        u.voice = voice;
        if (typeof voice.lang === 'string' && voice.lang) u.lang = voice.lang;
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
    canSpeak: () => supported && voice !== null,
    subscribe(fn) { listeners.add(fn); refreshVoice(); return () => { listeners.delete(fn); }; }
  };
}
