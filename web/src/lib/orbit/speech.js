// Read aloud on the lead's chat bubbles, in one of two voices. The Mac's own voice,
// where the server offers it: the words are spoken on the Mac and played here as audio
// (see "the Mac's own voice" below; the request names a message, never its text). Or
// the browser's own speech engine (window.speechSynthesis), on the page alone: only an
// on-device voice is used (localService true), set on every piece, so Jarvis's words
// never go to a network voice such as Chrome's "Google US English" (option (a),
// 2026-11-16). Where neither is there the speaker can't speak and the page shows no
// button. Checked by web/test/orbit-speech.test.js.
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

// The device's saved choices, in this browser's localStorage: the on-device voice (a
// voiceURI under VOICE_KEY, or null for Automatic) and which side reads (ENGINE_KEY:
// 'device' for the device's own voice, or nothing for the default, which is the Mac's
// voice wherever the server offers one). `getStorage` hands over the storage and may
// throw or answer nothing (a private window, blocked site data); either way the read
// or write throws here and is caught. Each choice is read once and then kept here, so
// where storage is missing or refuses a write, a pick still holds until the page is
// closed, and the next visit starts on the defaults.
export const VOICE_KEY = 'jos.chat.voice';
export const ENGINE_KEY = 'jos.chat.voice.engine';
export function createVoiceStore(getStorage = () => null) {
  let choice = null;
  let loaded = false;
  let engine = null;
  let engineLoaded = false;
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
    },
    engine() {
      if (!engineLoaded) {
        engineLoaded = true;
        try { engine = getStorage().getItem(ENGINE_KEY) === 'device' ? 'device' : null; } catch { engine = null; }
      }
      return engine;
    },
    setEngine(value) {
      engineLoaded = true;
      engine = value === 'device' ? 'device' : null;
      try {
        if (engine === null) getStorage().removeItem(ENGINE_KEY);
        else getStorage().setItem(ENGINE_KEY, engine);
      } catch { /* kept here for this visit only */ }
      return engine;
    }
  };
}

// ---- the Mac's own voice ----
//
// A page on iPhone, iPad or Safari is offered only the voices that ship with the
// system, so the better ones are out of its reach. Where the server offers it
// (server/lib/chat-speech.mjs; the chat status says so), the words are spoken on the
// Mac and played here as audio: the request names the message by its id and carries
// no text. That is the default wherever it is offered; the device's own voice is the
// other choice in the picker, and what reads when the Mac can't (offline, a refusal,
// too slow): after a failure the device's own voice takes over for RETRY_MS, so the
// next tap speaks at once, inside the tap.

// The picker's value for the Mac's voice (no voiceURI begins like this).
export const MINI = ':mini';
export const SPEECH_PATH = '/api/chat/speech/';
// How long the Mac's audio may take to start before the device's own voice reads.
export const REMOTE_START_MS = 20e3;
export const REMOTE_RETRY_MS = 30e3;

// Where the audio of a message (or of the sample) is, or null for an id the server
// would not know: a message not yet sent has no id of the server's.
export function speechUrl(id) {
  if (id === SAMPLE_ID) return `${SPEECH_PATH}sample`;
  return typeof id === 'string' && /^m_[a-z0-9]{6,24}$/.test(id) ? `${SPEECH_PATH}${id}` : null;
}

// A voice's name without the brackets the Mac's list adds: "Evan (Enhanced)" is Evan.
export const shortVoiceName = name => (typeof name === 'string' ? name.split('(')[0].replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

// What the chat status says of the Mac's voice (`speech`), checked: the voice in use,
// its short name, the one asked for, and whether they are the same. null when the
// server offers none.
export function miniVoice(info) {
  if (info === null || typeof info !== 'object' || typeof info.voice !== 'string') return null;
  const voice = info.voice.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  const short = shortVoiceName(voice);
  if (voice === '' || short === '') return null;
  const wanted = typeof info.wanted === 'string' && info.wanted.trim() !== '' ? info.wanted.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : voice;
  return { voice, short, wanted, exact: info.exact === true };
}

// What the picker shows: the choices, the saved address (`saved`), the on-device voice
// in use (`picked`: null is Automatic, also while the saved voice is not listed), the
// name of the voice Automatic uses now (`auto`: null when no voice is on-device), the
// Mac's voice where the server offers one (`mini`, as miniVoice answers) and which
// side reads (`engine`: 'mini' or 'device').
export const NO_VOICES = Object.freeze({ choices: Object.freeze([]), saved: null, picked: null, auto: null, mini: null, engine: 'device' });

// The sample the picker plays: one sentence, held by the speaker under an id no
// message has. The server reads the same sentence for the Mac's voice.
export const SAMPLE_ID = ':voice-sample';
export const SAMPLE_WORDS = 'This is the voice that reads replies aloud on this device.';

// The speaker over a speechSynthesis (`synth`) and its utterance class, and over an
// audio element for the Mac's voice (`makeAudio`, which makes one). `current()` is the
// id of the message speaking, or null; `loading()` the id whose audio has been asked
// for and has not started; `canSpeak()` says whether there is a voice to speak in;
// `voices()` is what the picker shows (the same object until something in it
// changes); `subscribe(fn)` calls fn on every change of any of them. `setVoice(value)`
// saves the device's choice in `store` (MINI for the Mac's voice; null or '' for the
// device's own, Automatic; else a voiceURI) and `sample()` speaks one sentence in it.
// `setRemote(info)` takes what the chat status says of the Mac's voice. Each start
// takes a new token, and a late end or error (a cancelled message's) acts only while
// its own token is the current one.
//
// The voice list can be empty at first load (Chrome fills it in later and says so with
// `voiceschanged`; some engines fill it without the event), so it is read again on
// that event, on every subscribe and on every tap. Without getVoices there is no way
// to tell an on-device voice from a network one, so that engine counts as none.
export function createSpeaker({
  synth = null, Utterance = null, chunkMax = CHUNK_MAX, langs = [], store = createVoiceStore(),
  makeAudio = null, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  startMs = REMOTE_START_MS, retryMs = REMOTE_RETRY_MS
} = {}) {
  const supported = Boolean(synth && typeof synth.speak === 'function' && typeof synth.cancel === 'function'
    && typeof synth.getVoices === 'function' && typeof Utterance === 'function');
  const remoteSupported = typeof makeAudio === 'function';
  const listeners = new Set();
  let current = null; // { id, token, engine: 'device' | 'mini' }
  let loading = null; // the id whose audio from the Mac has not started yet
  let token = 0;
  let voice = null;
  let remote = null;  // the Mac's voice, as miniVoice answers
  let retryAt = 0;    // until then the device's own voice reads (the Mac's just failed)
  let el = null;      // the one audio element, made at the first use
  let timer = null;
  let view = NO_VOICES;
  let viewKey = JSON.stringify(view);
  const emit = () => { for (const fn of [...listeners]) fn(); };
  const cancel = () => { try { synth.cancel(); } catch { /* nothing to stop */ } };
  // The Mac's audio, stopped and let go: nothing of it plays or loads on.
  function haltAudio() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (el === null) return;
    el.onplaying = null; el.onended = null; el.onpause = null; el.onerror = null;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* nothing loaded */ }
  }
  // Which side reads: the Mac's voice wherever it is offered, unless this device chose its own.
  const engineNow = () => (remoteSupported && remote !== null && store.engine() !== 'device' ? 'mini' : 'device');

  // Reads the list again. Losing the last on-device voice stops what it is speaking.
  function refreshVoice() {
    if (!supported && !remoteSupported) return;
    let list = [];
    if (supported) { try { list = synth.getVoices(); } catch { list = []; } }
    const saved = store.get();
    voice = supported ? pickLocalVoice(list, langs, saved) : null;
    const auto = supported ? pickLocalVoice(list, langs) : null;
    const next = {
      choices: supported ? voiceChoices(list, langs) : [],
      saved,
      picked: voice !== null && voice.voiceURI === saved ? saved : null,
      auto: auto === null ? null : nameOf(auto, 'an on-device voice'),
      mini: remoteSupported ? remote : null,
      engine: engineNow()
    };
    // Compared by content: the browser hands out new voice objects for the same list.
    // `auto` is null exactly when no voice is on-device, so this also tells of a
    // first or last voice.
    const nextKey = JSON.stringify(next);
    const changed = nextKey !== viewKey;
    if (changed) { view = next; viewKey = nextKey; }
    if (voice === null && current && current.engine === 'device') { current = null; token++; cancel(); emit(); return; }
    if (changed) emit();
  }

  if (supported) {
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refreshVoice);
    else if (synth.onvoiceschanged == null) synth.onvoiceschanged = refreshVoice;
    refreshVoice();
  }

  function stop() {
    if (!current) return;
    const was = current;
    current = null;
    loading = null;
    token++;
    if (was.engine === 'mini') haltAudio(); else cancel();
    emit();
  }

  // Speaks `words` under `id` in the device's own voice.
  function speakLocal(id, words) {
    if (!supported || voice === null) return false;
    const chunks = speechChunks(words, chunkMax);
    if (chunks.length === 0) return false;
    // One at a time: whatever speaks now (this speaker's, or anything else on the page) stops first.
    if (current || synth.speaking || synth.pending) {
      if (current?.engine === 'mini') haltAudio();
      current = null; loading = null; token++; cancel();
    }
    const mine = ++token;
    current = { id, token: mine, engine: 'device' };
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

  // Plays the Mac's audio for `id` from `url`: asked for and started inside the tap
  // (mobile Safari plays only from a user gesture). Whatever keeps it from starting
  // (no answer, a refusal, an audio the browser can't play, startMs gone by) hands the
  // message to the device's own voice and keeps to it for retryMs. Audio that breaks
  // off after it started just stops: starting over in another voice helps nobody.
  function playRemote(id, words, url) {
    // One at a time, as above. `current` goes first: a cancelled utterance reports an
    // error, which must find nothing of its own to end.
    const was = current;
    current = null;
    token++;
    if (was?.engine === 'mini') haltAudio();
    else if (supported && (was || synth.speaking || synth.pending)) cancel();
    const mine = ++token;
    current = { id, token: mine, engine: 'mini' };
    loading = id;
    const isMine = () => current !== null && current.token === mine;
    let started = false;
    const finish = () => { if (!isMine()) return; haltAudio(); current = null; loading = null; emit(); };
    const failed = () => {
      if (!isMine()) return;
      if (started) { finish(); return; }
      haltAudio();
      current = null;
      loading = null;
      retryAt = now() + retryMs;
      if (!speakLocal(id, words)) emit();
    };
    try {
      if (el === null) { el = makeAudio(); el.preload = 'auto'; }
      el.onplaying = () => { if (!isMine() || started) return; started = true; if (timer !== null) { clearTimer(timer); timer = null; } loading = null; emit(); };
      // The end, or a pause that is not this speaker's (the system's, a headset's).
      el.onended = finish;
      el.onpause = finish;
      el.onerror = failed;
      timer = setTimer(() => { timer = null; failed(); }, startMs);
      el.src = url;
      const playing = el.play();
      if (playing && typeof playing.then === 'function') playing.then(undefined, failed);
    } catch {
      failed();
      return current !== null && current.id === id;
    }
    emit();
    return true;
  }

  // Starts `words` under `id`, or stops it when it is what is speaking now. `url` is
  // where the Mac's audio for it is, or null when there is none to ask for.
  function say(id, words, url) {
    if (!supported && !remoteSupported) return false;
    if (current && current.id === id) { stop(); return false; }
    refreshVoice();
    // After a failure the device's own voice reads for a while, where it has one.
    const useRemote = url !== null && engineNow() === 'mini' && (now() >= retryAt || voice === null);
    if (!useRemote) return speakLocal(id, words);
    if (speechChunks(words, chunkMax).length === 0) return false;
    return playRemote(id, words, url);
  }

  const toggle = (id, md) => say(id, speechText(md), speechUrl(id));
  const sample = () => say(SAMPLE_ID, SAMPLE_WORDS, speechUrl(SAMPLE_ID));

  // The device's choice: MINI for the Mac's voice (only while the server offers it);
  // null or '' for the device's own voice, Automatic; else the address of a voice on
  // the list as it is now. Whatever is speaking was started under the old choice, so
  // it stops. An on-device pick also says "the device's own voice reads" only where
  // the Mac's voice was on offer: a pick made before the server offered it stays what
  // reads when the Mac can't.
  function setVoice(value) {
    if (!supported && !remoteSupported) return false;
    refreshVoice();
    if (value === MINI) {
      if (view.mini === null) return false;
      store.setEngine(null);
      retryAt = 0;
      stop();
      refreshVoice();
      return true;
    }
    if (!supported) return false;
    const want = value === '' ? null : value;
    if (want !== null && !view.choices.some(c => c.uri === want)) return false;
    store.set(want);
    if (view.mini !== null) store.setEngine('device');
    stop();
    refreshVoice();
    return true;
  }

  // What the chat status says of the Mac's voice: null when the server offers none.
  // Without an audio element to play it the offer is never shown or used (the view and
  // engineNow see to that); the same answer again changes nothing in the view.
  function setRemote(info) {
    remote = miniVoice(info);
    refreshVoice();
  }

  return {
    supported, toggle, stop, sample, setVoice, setRemote,
    current: () => (current ? current.id : null),
    loading: () => loading,
    canSpeak: () => engineNow() === 'mini' || (supported && voice !== null),
    voices: () => view,
    subscribe(fn) { listeners.add(fn); refreshVoice(); return () => { listeners.delete(fn); }; }
  };
}
