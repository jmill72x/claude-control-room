// Read aloud on the lead's chat bubbles: the browser's own speech engine
// (window.speechSynthesis), on the page alone. No server change and no network call
// from here. Only an on-device voice is used (localService true), set on every piece,
// so Jarvis's words never go to a network voice such as Chrome's "Google US English"
// (option (a), 2026-11-16). Where the browser lists no on-device voice the speaker
// can't speak and the page shows no button. Checked by web/test/orbit-speech.test.js.
//
// Which on-device voice is the device's own choice (Chat settings, 2026-11-16): the
// list there is voiceChoices(), the pick is kept in this browser's localStorage by the
// voice's voiceURI (createVoiceStore), and "Automatic" is the order pickLocalVoice
// always used. A web page is never offered the system's Siri voices, and the system's
// own default-voice setting doesn't reach the `default` flag a page sees, which is
// why the page has its own list.
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

// The on-device voices of a getVoices() answer (anything but a list has none), and the
// wanted languages as tags to compare.
const isLocal = v => v !== null && typeof v === 'object' && v.localService === true;
const localOf = voices => (Array.isArray(voices) ? voices : []).filter(isLocal);
const wantsOf = langs => (Array.isArray(langs) ? langs : []).map(tagOf).filter(Boolean);

// A voice's address (its voiceURI) as it may be saved: a string, not empty, not huge.
export const VOICE_URI_MAX = 300;
const cleanUri = u => (typeof u === 'string' && u !== '' && u.length <= VOICE_URI_MAX ? u : null);

// The voice to speak in, from speechSynthesis.getVoices(): on-device ones only (a
// real `localService === true`). The device's saved choice (`saved`, a voiceURI) when
// that voice is still listed and on-device; else the automatic order: the default one
// first, then the first of `langs` (the page's language, then the browser's) matched
// exactly, then by language alone (en-US finds en-GB), then any. null when none is
// on-device.
export function pickLocalVoice(voices, langs = [], saved = null) {
  const local = localOf(voices);
  if (local.length === 0) return null;
  const want = cleanUri(saved);
  if (want !== null) { const mine = local.find(v => v.voiceURI === want); if (mine) return mine; }
  const preferred = local.find(v => v.default === true);
  if (preferred) return preferred;
  const wants = wantsOf(langs);
  for (const w of wants) { const hit = local.find(v => tagOf(v.lang) === w); if (hit) return hit; }
  for (const w of wants) {
    const base = w.split('-')[0];
    const hit = local.find(v => tagOf(v.lang).split('-')[0] === base);
    if (hit) return hit;
  }
  return local[0];
}

// ---- the voice picker ----

const NAME_MAX = 80;
// A voice's name as shown: tidied and capped, or `fallback` when it has none.
function nameOf(v, fallback) {
  const n = typeof v.name === 'string' ? v.name.replace(/\s+/g, ' ').trim() : '';
  return n === '' ? fallback : n.slice(0, NAME_MAX);
}
// A language tag as shown: Android's underscore becomes the hyphen every tag has.
const tidyTag = t => (typeof t === 'string' ? t.trim().replace(/_/g, '-') : '');

// The voices the picker offers, from speechSynthesis.getVoices(): on-device ones with
// an address to save them by, each address once, as { uri, name, lang, mine }. `mine`
// marks a voice in one of `langs` (the page's language, then the browser's). Those
// come first: an exact match in the order of `langs`, then the same language in
// another region; then every other voice. Within each, by language tag, then name.
export function voiceChoices(voices, langs = []) {
  const wants = wantsOf(langs);
  const seen = new Set();
  const rows = [];
  for (const v of localOf(voices)) {
    const uri = cleanUri(v.voiceURI);
    if (uri === null || seen.has(uri)) continue;
    seen.add(uri);
    const tag = tagOf(v.lang);
    const exact = wants.indexOf(tag);
    const near = wants.findIndex(w => w.split('-')[0] === tag.split('-')[0]);
    const rank = exact !== -1 ? exact : near !== -1 ? wants.length + near : Infinity;
    const name = nameOf(v, uri);
    rows.push({ choice: { uri, name, lang: tidyTag(v.lang), mine: rank !== Infinity }, rank, tag, key: name.toLowerCase() });
  }
  // Array.prototype.sort is stable: voices alike in all three stay in the listed order.
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => order(a.rank, b.rank) || order(a.tag, b.tag) || order(a.key, b.key));
  return rows.map(r => r.choice);
}

// A language tag by its name ("English (United States)") where `names` (an
// Intl.DisplayNames for languages) knows it; else the tag itself, which is '' for no
// tag (the browser's `of` throws on one it can't read, an empty one included).
export function langLabel(lang, names = null) {
  const tag = tidyTag(lang);
  let n = null;
  try { n = names?.of(tag); } catch { /* not a tag this browser can name */ }
  return typeof n === 'string' && n.trim() !== '' ? n : tag;
}

// The device's saved choice of voice: a voiceURI under VOICE_KEY in this browser's
// localStorage, or null for Automatic. `getStorage` hands over the storage and may
// throw or answer nothing (a private window, blocked site data); either way the read
// or write throws here and is caught. The choice is read once and then kept here, so
// where storage is missing or refuses a write, a pick still holds until the page is
// closed, and the next visit starts on Automatic.
export const VOICE_KEY = 'jos.chat.voice';
export function createVoiceStore(getStorage = () => null) {
  let choice = null;
  let loaded = false;
  return {
    get() {
      if (!loaded) {
        loaded = true;
        try { choice = cleanUri(getStorage().getItem(VOICE_KEY)); } catch { choice = null; }
      }
      return choice;
    },
    set(uri) {
      loaded = true;
      choice = cleanUri(uri);
      try {
        if (choice === null) getStorage().removeItem(VOICE_KEY);
        else getStorage().setItem(VOICE_KEY, choice);
      } catch { /* kept here for this visit only */ }
      return choice;
    }
  };
}

// What the picker shows: the choices, the saved address (`saved`), the one in use
// (`picked`: null is Automatic, also while the saved voice is not listed) and the name
// of the voice Automatic uses now (`auto`: null when no voice is on-device).
export const NO_VOICES = Object.freeze({ choices: Object.freeze([]), saved: null, picked: null, auto: null });

// The sample the picker plays: one sentence, held by the speaker under an id no
// message has.
export const SAMPLE_ID = ':voice-sample';
export const SAMPLE_WORDS = 'This is the voice that reads replies aloud on this device.';

// The speaker over a speechSynthesis (`synth`) and its utterance class. `current()` is
// the id of the message speaking, or null; `canSpeak()` says whether an on-device voice
// is there to speak in; `voices()` is what the picker shows (the same object until
// something in it changes); `subscribe(fn)` calls fn on every change of any of them.
// `setVoice(uri)` saves the device's choice in `store` (null or '' is Automatic) and
// `sample()` speaks one sentence in it. Each start takes a new token, and an
// utterance's late end or error (a cancelled message's) acts only while its own token
// is the current one.
//
// The voice list can be empty at first load (Chrome fills it in later and says so with
// `voiceschanged`; some engines fill it without the event), so it is read again on
// that event, on every subscribe and on every tap. Without getVoices there is no way
// to tell an on-device voice from a network one, so that engine counts as none.
export function createSpeaker({ synth = null, Utterance = null, chunkMax = CHUNK_MAX, langs = [], store = createVoiceStore() } = {}) {
  const supported = Boolean(synth && typeof synth.speak === 'function' && typeof synth.cancel === 'function'
    && typeof synth.getVoices === 'function' && typeof Utterance === 'function');
  const listeners = new Set();
  let current = null; // { id, token }
  let token = 0;
  let voice = null;
  let view = NO_VOICES;
  let viewKey = JSON.stringify(view);
  const emit = () => { for (const fn of [...listeners]) fn(); };
  const cancel = () => { try { synth.cancel(); } catch { /* nothing to stop */ } };

  // Reads the list again. Losing the last on-device voice stops what is speaking.
  function refreshVoice() {
    if (!supported) return;
    let list = [];
    try { list = synth.getVoices(); } catch { list = []; }
    const saved = store.get();
    voice = pickLocalVoice(list, langs, saved);
    const auto = pickLocalVoice(list, langs);
    const next = {
      choices: voiceChoices(list, langs),
      saved,
      picked: voice !== null && voice.voiceURI === saved ? saved : null,
      auto: auto === null ? null : nameOf(auto, 'an on-device voice')
    };
    // Compared by content: the browser hands out new voice objects for the same list.
    // `auto` is null exactly when no voice is on-device, so this also tells of a
    // first or last voice.
    const nextKey = JSON.stringify(next);
    const changed = nextKey !== viewKey;
    if (changed) { view = next; viewKey = nextKey; }
    if (voice === null && current) { current = null; token++; cancel(); emit(); return; }
    if (changed) emit();
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

  // Starts `words` under `id`, or stops it when it is what is speaking now.
  function say(id, words) {
    if (!supported) return false;
    if (current && current.id === id) { stop(); return false; }
    refreshVoice();
    if (voice === null) return false;
    const chunks = speechChunks(words, chunkMax);
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

  const toggle = (id, md) => say(id, speechText(md));
  const sample = () => say(SAMPLE_ID, SAMPLE_WORDS);

  // The device's choice: null or '' for Automatic, else the address of a voice on the
  // list as it is now. Whatever is speaking was queued in the old voice, so it stops.
  function setVoice(uri) {
    if (!supported) return false;
    refreshVoice();
    const want = uri === '' ? null : uri;
    if (want !== null && !view.choices.some(c => c.uri === want)) return false;
    store.set(want);
    stop();
    refreshVoice();
    return true;
  }

  return {
    supported, toggle, stop, sample, setVoice,
    current: () => (current ? current.id : null),
    canSpeak: () => supported && voice !== null,
    voices: () => view,
    subscribe(fn) { listeners.add(fn); refreshVoice(); return () => { listeners.delete(fn); }; }
  };
}
