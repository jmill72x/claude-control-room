// Read aloud (src/lib/orbit/speech.js): a message's Markdown as words to speak, cut
// into pieces a speech engine takes whole, and the speaker that keeps one message
// speaking at a time over a fake speechSynthesis. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  speechText, speechChunks, createSpeaker, pickLocalVoice, CODE_WORDS, CHUNK_MAX,
  voiceChoices, langLabel, createVoiceStore, VOICE_KEY, VOICE_URI_MAX, NO_VOICES, SAMPLE_ID, SAMPLE_WORDS,
  ENGINE_KEY, MINI, SPEECH_PATH, REMOTE_START_MS, REMOTE_RETRY_MS, speechUrl, shortVoiceName, miniVoice
} from '../src/lib/orbit/speech.js';

test('Markdown markers are dropped: emphasis, inline code and headings read as their words', () => {
  assert.equal(speechText('**Bold** and _it_ and `npm test`'), 'Bold and it and npm test.');
  assert.equal(speechText('# Title\nSome text\nover two lines'), 'Title. Some text over two lines.');
  assert.equal(speechText('Done!'), 'Done!');
  assert.equal(speechText('Ready?'), 'Ready?');
  assert.equal(speechText('Three things:'), 'Three things:');
  assert.equal(speechText('  '), '');
  assert.equal(speechText(''), '');
  assert.equal(speechText(null), '');
  assert.equal(speechText(42), '');
});

test('a code block is never read as symbols: it is named and skipped', () => {
  assert.equal(CODE_WORDS, 'Code block skipped.');
  assert.equal(speechText('Run this:\n```sh\nnpm test -- --watch && echo ok\n```\nThen tell me.'), 'Run this: Code block skipped. Then tell me.');
  assert.ok(!speechText('```\n`~!@#$%^&*()\n```').includes('$'));
});

test('links read by their text, a bare address as "a link to" its host, never the address', () => {
  assert.equal(speechText('See [the board](https://x.example/b?id=1) now'), 'See the board now.');
  assert.equal(speechText('Mail [me](mailto:a@b.example)'), 'Mail me.');
  const bare = speechText('Open https://x.example/path/to/page?q=1 please');
  assert.equal(bare, 'Open a link to x.example please.');
  assert.ok(!bare.includes('https'));
  assert.equal(speechText('[**the** plan](https://x.example/p)'), 'the plan.');
});

test('list items each end as a sentence; numbers are left out', () => {
  assert.equal(speechText('- one\n- two\n\n3. three\n4. four!'), 'one. two. three. four!');
  assert.equal(speechText('- outer\n  - inner'), 'outer. inner.');
});

test('chunks: whole sentences up to the limit, long ones cut at a space, a long word cut hard', () => {
  assert.equal(CHUNK_MAX, 220);
  assert.deepEqual(speechChunks('', 50), []);
  assert.deepEqual(speechChunks('One. Two. Three.', 50), ['One. Two. Three.']);
  assert.deepEqual(speechChunks('First sentence here. Second one is here.', 25), ['First sentence here.', 'Second one is here.']);
  assert.deepEqual(speechChunks('Aaaa. Bbbb.', 11), ['Aaaa. Bbbb.'], 'exactly the limit still joins');
  assert.deepEqual(speechChunks('Aaaa. Bbbb.', 10), ['Aaaa.', 'Bbbb.']);
  assert.deepEqual(speechChunks('Aa. Bbbbbb cc.', 10), ['Aa.', 'Bbbbbb cc.'], 'a sentence end before a space that fits');
  assert.deepEqual(speechChunks('x'.repeat(40), 40), ['x'.repeat(40)], 'exactly the limit is not cut');
  const long = 'word '.repeat(30).trim();
  const parts = speechChunks(long, 40);
  assert.ok(parts.every(p => p.length <= 40), JSON.stringify(parts));
  assert.equal(parts.join(' '), long, 'nothing lost or doubled');
  const hard = speechChunks('x'.repeat(95), 40);
  assert.deepEqual(hard.map(p => p.length), [40, 40, 15]);
  // A pair is never cut in half.
  const smile = String.fromCodePoint(0x1f600);
  for (const p of speechChunks(`a${smile.repeat(60)}`, 40)) assert.equal(p, p.toWellFormed());
  assert.ok(speechChunks('A. '.repeat(500), CHUNK_MAX).every(p => p.length <= CHUNK_MAX));
});

// A local (on-device) voice and a network one, as Chrome on a Mac lists them.
const LOCAL = { name: 'Samantha', lang: 'en-US', localService: true, default: false, voiceURI: 'Samantha' };
const CLOUD = { name: 'Google US English', lang: 'en-US', localService: false, default: false, voiceURI: 'Google US English' };

function fakeSynth(voices = [LOCAL]) {
  const synth = {
    queue: [], spoken: [], cancels: 0, voices, handlers: [],
    getVoices() { return synth.voices; },
    addEventListener(type, fn) { if (type === 'voiceschanged') synth.handlers.push(fn); },
    removeEventListener(type, fn) { synth.handlers = synth.handlers.filter(h => h !== fn); },
    // The browser's list changes and it says so.
    changeVoices(list) { synth.voices = list; for (const fn of [...synth.handlers]) fn({ type: 'voiceschanged' }); },
    get speaking() { return synth.queue.length > 0; },
    get pending() { return synth.queue.length > 1; },
    speak(u) { synth.queue.push(u); synth.spoken.push(u.text); },
    cancel() { synth.cancels++; const q = synth.queue; synth.queue = []; for (const u of q) u.onerror?.({ error: 'canceled' }); },
    // The engine finishes the utterance at the head of its queue.
    finishOne() { const u = synth.queue.shift(); u?.onend?.({}); },
    failOne(error = 'synthesis-failed') { const u = synth.queue[0]; u?.onerror?.({ error }); }
  };
  return synth;
}
class FakeUtterance { constructor(text) { this.text = text; this.onend = null; this.onerror = null; } }

test('the speaker: not supported without speechSynthesis or its utterance', () => {
  assert.equal(createSpeaker({}).supported, false);
  assert.equal(createSpeaker({ synth: fakeSynth() }).supported, false);
  const off = createSpeaker({ Utterance: FakeUtterance });
  assert.equal(off.supported, false);
  assert.equal(off.toggle('m_1', 'hello'), false);
  assert.equal(createSpeaker({ synth: fakeSynth(), Utterance: FakeUtterance }).supported, true);
  // Without getVoices the page can't tell an on-device voice from a network one.
  const blind = fakeSynth();
  delete blind.getVoices;
  const sp = createSpeaker({ synth: blind, Utterance: FakeUtterance });
  assert.equal(sp.supported, false);
  assert.equal(sp.canSpeak(), false);
  assert.equal(sp.toggle('m_1', 'hello'), false);
  assert.equal(blind.spoken.length, 0);
});

test('the speaker: a tap queues every piece at once (the tap is what lets a phone speak), the last one\'s end clears it', () => {
  const synth = fakeSynth();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, chunkMax: 20 });
  const seen = [];
  const off = sp.subscribe(() => seen.push(sp.current()));
  assert.equal(sp.toggle('m_1', 'First part here. Second part here.'), true);
  assert.deepEqual(synth.spoken, ['First part here.', 'Second part here.']);
  assert.equal(sp.current(), 'm_1');
  synth.finishOne();
  assert.equal(sp.current(), 'm_1', 'still speaking the second piece');
  synth.finishOne();
  assert.equal(sp.current(), null);
  assert.deepEqual(seen, ['m_1', null]);
  off();
  sp.toggle('m_1', 'again');
  assert.deepEqual(seen, ['m_1', null], 'unsubscribed');
});

test('the speaker: tapping the same message again stops it; another message replaces it (one at a time)', () => {
  const synth = fakeSynth();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  sp.toggle('m_1', 'one');
  assert.equal(sp.toggle('m_1', 'one'), false);
  assert.equal(sp.current(), null);
  assert.equal(synth.cancels, 1);
  assert.equal(synth.queue.length, 0);

  sp.toggle('m_1', 'one');
  sp.toggle('m_2', 'two');
  assert.equal(sp.current(), 'm_2');
  assert.equal(synth.cancels, 2, 'the first was cancelled before the second was queued');
  assert.deepEqual(synth.queue.map(u => u.text), ['two.']);
  synth.finishOne();
  assert.equal(sp.current(), null);
});

test('the speaker: one at a time even where the engine says it is idle while speaking', () => {
  const synth = fakeSynth();
  Object.defineProperty(synth, 'speaking', { get: () => false });
  Object.defineProperty(synth, 'pending', { get: () => false });
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  sp.toggle('m_1', 'one');
  sp.toggle('m_2', 'two');
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.queue.map(u => u.text), ['two.']);
});

test('the speaker: a cancelled message\'s late events never clear the one speaking now', () => {
  const synth = fakeSynth();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  sp.toggle('m_1', 'one');
  const old = synth.queue[0];
  sp.toggle('m_2', 'two');
  old.onend?.({});
  old.onerror?.({ error: 'interrupted' });
  assert.equal(sp.current(), 'm_2');
});

test('the speaker: an engine error stops the rest of that message', () => {
  const synth = fakeSynth();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, chunkMax: 20 });
  sp.toggle('m_1', 'First part here. Second part here.');
  synth.failOne();
  assert.equal(sp.current(), null);
  assert.equal(synth.queue.length, 0, 'the second piece is dropped too');
});

test('the speaker: stop() ends whatever is speaking; with nothing speaking it does nothing', () => {
  const synth = fakeSynth();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  sp.stop();
  assert.equal(synth.cancels, 0);
  sp.toggle('m_1', 'hello');
  sp.stop();
  assert.equal(sp.current(), null);
  assert.equal(synth.cancels, 1);
});

test('the speaker: a message with nothing to say starts nothing; a throwing engine leaves it idle', () => {
  const synth = fakeSynth();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  assert.equal(sp.toggle('m_1', '   '), false);
  assert.equal(sp.current(), null);
  assert.equal(synth.spoken.length, 0);
  const broken = { speak() { throw new Error('no voice'); }, cancel() {} };
  const sp2 = createSpeaker({ synth: broken, Utterance: FakeUtterance });
  assert.equal(sp2.toggle('m_1', 'hello'), false);
  assert.equal(sp2.current(), null);
});

test('the speaker: something else speaking on the page is cancelled before a new message starts', () => {
  const synth = fakeSynth();
  synth.queue.push(new FakeUtterance('someone else'));
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  sp.toggle('m_1', 'mine');
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.queue.map(u => u.text), ['mine.']);
});

// ---- on-device voices only (Jeff's option (a), 2026-11-16) ----
// Jarvis's words never go to a network voice: the speaker picks a voice whose
// localService is true and sets it on every piece, and with none it can't speak.

const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, localService: true, default: false, ...extra });

test('pickLocalVoice: never a network voice, even the default one', () => {
  const cloudDefault = { ...CLOUD, default: true };
  assert.equal(pickLocalVoice([cloudDefault, LOCAL], ['en-US']), LOCAL);
  assert.equal(pickLocalVoice([cloudDefault, CLOUD], ['en-US']), null);
  // Only a real true counts: a missing, string or numeric flag is not on-device.
  assert.equal(pickLocalVoice([{ ...LOCAL, localService: 'true' }, { ...LOCAL, localService: 1 }, { name: 'x', lang: 'en-US' }], ['en-US']), null);
  assert.equal(pickLocalVoice([], ['en-US']), null);
  assert.equal(pickLocalVoice(null, ['en-US']), null);
  assert.equal(pickLocalVoice(undefined), null);
  assert.equal(pickLocalVoice([null, 7, 'Samantha'], ['en-US']), null);
});

test('pickLocalVoice: the default local voice first, then the language, then any local one', () => {
  const fr = v('Thomas', 'fr-FR');
  const gb = v('Daniel', 'en-GB');
  const us = v('Samantha', 'en-US');
  const defFr = v('Amelie', 'fr-CA', { default: true });
  assert.equal(pickLocalVoice([fr, us, defFr], ['en-US']), defFr, 'the default local voice wins');
  assert.equal(pickLocalVoice([fr, gb, us], ['en-US', 'en']), us, 'an exact language match before a near one');
  assert.equal(pickLocalVoice([fr, gb], ['en-US']), gb, 'the same language in another region next');
  assert.equal(pickLocalVoice([fr, gb, us], ['en', 'fr']), gb, 'a bare language tag matches its regions');
  assert.equal(pickLocalVoice([fr, gb, us], ['fr-FR', 'en-US']), fr, 'the first wanted language decides');
  const android = v('Alex', 'en_us');
  assert.equal(pickLocalVoice([gb, android], ['EN-US']), android, 'an underscore tag (Android) and case are the same tag');
  assert.equal(pickLocalVoice([fr, v('Kyoko', 'ja-JP')], ['en-US']), fr, 'no match: the first local voice');
  assert.equal(pickLocalVoice([CLOUD, fr], ['', null, 'en-US']), fr, 'empty wants are skipped');
  assert.equal(pickLocalVoice([CLOUD, fr]), fr, 'no languages given');
});

test('the speaker: every piece is spoken in the chosen on-device voice, never left to the browser', () => {
  const synth = fakeSynth([{ ...CLOUD, default: true }, LOCAL]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, chunkMax: 20, langs: ['en-US'] });
  assert.equal(sp.canSpeak(), true);
  sp.toggle('m_1', 'First part here. Second part here.');
  assert.equal(synth.queue.length, 2);
  for (const u of synth.queue) {
    assert.equal(u.voice, LOCAL);
    assert.equal(u.lang, 'en-US');
  }
});

test('the speaker: with only network voices it can\'t speak, and says so', () => {
  const synth = fakeSynth([CLOUD]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  assert.equal(sp.supported, true, 'the engine is there');
  assert.equal(sp.canSpeak(), false, 'but no voice it may use, so no button');
  assert.equal(sp.toggle('m_1', 'hello'), false);
  assert.equal(synth.spoken.length, 0);
  assert.equal(synth.cancels, 0, 'a refused tap touches nothing on the engine');
  assert.equal(sp.current(), null);
});

test('the speaker: an empty list at first load fills in later (voiceschanged)', () => {
  const synth = fakeSynth([]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  const seen = [];
  sp.subscribe(() => seen.push(sp.canSpeak()));
  assert.equal(sp.canSpeak(), false);
  synth.changeVoices([CLOUD]);
  assert.equal(sp.canSpeak(), false, 'a network voice alone still is not enough');
  synth.changeVoices([CLOUD, LOCAL]);
  assert.equal(sp.canSpeak(), true);
  assert.equal(seen.at(-1), true, 'subscribers hear of it, so the button appears');
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice, LOCAL);
});

test('the speaker: a list filled in without the event is read again on subscribe and on a tap', () => {
  const synth = fakeSynth([]);
  synth.addEventListener = undefined;
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  assert.equal(sp.canSpeak(), false);
  synth.voices = [LOCAL];
  const off = sp.subscribe(() => {});
  assert.equal(sp.canSpeak(), true, 'subscribing looked again');
  off();
  synth.voices = [CLOUD];
  assert.equal(sp.toggle('m_1', 'hello'), false, 'the tap looked again and found no local voice');
  assert.equal(synth.spoken.length, 0);
  assert.equal(sp.canSpeak(), false);
  synth.voices = [CLOUD, LOCAL];
  assert.equal(sp.toggle('m_1', 'hello'), true);
  assert.equal(synth.queue[0].voice, LOCAL);
});

test('the speaker: onvoiceschanged is used where the engine has no addEventListener, and an old handler is kept', () => {
  const synth = fakeSynth([]);
  synth.addEventListener = undefined;
  synth.onvoiceschanged = null;
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  assert.equal(typeof synth.onvoiceschanged, 'function');
  synth.voices = [LOCAL];
  synth.onvoiceschanged({ type: 'voiceschanged' });
  assert.equal(sp.canSpeak(), true);

  const other = fakeSynth([]);
  other.addEventListener = undefined;
  let theirs = 0;
  const before = () => { theirs++; };
  other.onvoiceschanged = before;
  const sp2 = createSpeaker({ synth: other, Utterance: FakeUtterance });
  assert.equal(other.onvoiceschanged, before, 'someone else\'s handler is not replaced');
  assert.equal(sp2.canSpeak(), false);
  other.voices = [LOCAL];
  other.onvoiceschanged({ type: 'voiceschanged' });
  assert.equal(theirs, 1);
  assert.equal(sp2.toggle('m_1', 'hello'), true, 'the tap reads the list again instead');
});

test('the speaker: losing the last local voice while speaking stops it', () => {
  const synth = fakeSynth([LOCAL]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  sp.toggle('m_1', 'hello');
  assert.equal(sp.current(), 'm_1');
  synth.changeVoices([CLOUD]);
  assert.equal(sp.current(), null);
  assert.equal(sp.canSpeak(), false);
  assert.equal(synth.queue.length, 0);
});

test('the speaker: a getVoices that throws or answers nonsense leaves it unable to speak', () => {
  const synth = fakeSynth();
  synth.getVoices = () => { throw new Error('not yet'); };
  const sp = createSpeaker({ synth, Utterance: FakeUtterance });
  assert.equal(sp.canSpeak(), false);
  assert.equal(sp.toggle('m_1', 'hello'), false);
  synth.getVoices = () => 'Samantha';
  assert.equal(sp.toggle('m_1', 'hello'), false);
  assert.equal(synth.spoken.length, 0);
});

// ---- the voice picker (2026-11-16): the device's own choice of on-device voice ----
// Chat settings lists the on-device voices; the pick is kept per device, by voiceURI.
// Automatic is the order above. Every voice here is invented.

test('pickLocalVoice: the saved voice wins while it is listed and on-device', () => {
  const us = v('Samantha', 'en-US');
  const fr = v('Thomas', 'fr-FR');
  const def = v('Daniel', 'en-GB', { default: true });
  assert.equal(pickLocalVoice([def, us, fr], ['en-US'], 'Thomas'), fr, 'over the default and the language');
  assert.equal(pickLocalVoice([def, us, fr], ['en-US'], 'Karen'), def, 'gone: the automatic order');
  assert.equal(pickLocalVoice([us, fr], ['fr-FR'], 'Karen'), fr, 'gone: the language still counts');
  // A saved voice that is now a network one is never used.
  const cloudNow = { ...fr, localService: false };
  assert.equal(pickLocalVoice([us, cloudNow], ['en-US'], 'Thomas'), us);
  assert.equal(pickLocalVoice([cloudNow], ['en-US'], 'Thomas'), null);
  // The address is matched whole and as written.
  assert.equal(pickLocalVoice([us, fr], ['en-US'], 'thomas'), us);
  assert.equal(pickLocalVoice([us, fr], ['en-US'], 'Thom'), us);
  // Two voices can share a name (compact and enhanced): the address decides.
  const compact = v('Ava', 'en-US', { voiceURI: 'voice.compact.Ava' });
  const enhanced = v('Ava', 'en-US', { voiceURI: 'voice.enhanced.Ava' });
  assert.equal(pickLocalVoice([compact, enhanced], ['en-US'], 'voice.enhanced.Ava'), enhanced);
  // Anything but a real address is no choice at all.
  const noUri = { name: 'Bare', lang: 'fr-FR', localService: true, default: false };
  for (const bad of [null, undefined, '', 7, {}, ['Thomas'], true]) assert.equal(pickLocalVoice([noUri, us, fr], ['en-US'], bad), us, String(bad));
  const long = 'x'.repeat(VOICE_URI_MAX + 1);
  assert.equal(pickLocalVoice([us, v('Long', 'fr-FR', { voiceURI: long })], ['en-US'], long), us, 'an over-long address is not a choice');
  const most = 'y'.repeat(VOICE_URI_MAX);
  const atMax = v('Most', 'fr-FR', { voiceURI: most });
  assert.equal(pickLocalVoice([us, atMax], ['en-US'], most), atMax, 'exactly the limit is');
});

test('voiceChoices: on-device voices only, each once, with a name and a language', () => {
  assert.deepEqual(voiceChoices([CLOUD, LOCAL], ['en-US']), [{ uri: 'Samantha', name: 'Samantha', lang: 'en-US', mine: true }]);
  assert.deepEqual(voiceChoices([CLOUD], ['en-US']), []);
  assert.deepEqual(voiceChoices([{ ...LOCAL, localService: 'true' }, { ...LOCAL, localService: 1 }], ['en-US']), [], 'only a real true is on-device');
  for (const bad of [null, undefined, 'Samantha', 7, {}, new Set([LOCAL])]) assert.deepEqual(voiceChoices(bad, ['en-US']), []);
  assert.equal(pickLocalVoice(new Set([LOCAL]), ['en-US']), null, 'only a real list is a voice list');
  assert.deepEqual(voiceChoices([null, 7, 'x', LOCAL], ['en-US']).map(c => c.uri), ['Samantha']);
  // A voice with no address can't be saved, so it isn't offered (Automatic may still use it).
  const noUri = { name: 'Bare', lang: 'en-US', localService: true };
  const emptyUri = v('Empty', 'en-US', { voiceURI: '' });
  const numUri = v('Num', 'en-US', { voiceURI: 7 });
  const longUri = v('Long', 'en-US', { voiceURI: 'x'.repeat(VOICE_URI_MAX + 1) });
  assert.deepEqual(voiceChoices([noUri, emptyUri, numUri, longUri, LOCAL], ['en-US']).map(c => c.uri), ['Samantha']);
  // The same address listed twice is one choice: the first.
  const twice = voiceChoices([v('Ava', 'en-US', { voiceURI: 'a' }), v('Ava again', 'en-GB', { voiceURI: 'a' })], ['en-US']);
  assert.deepEqual(twice, [{ uri: 'a', name: 'Ava', lang: 'en-US', mine: true }]);
  // Names are tidied; a voice with none shows its address. An Android tag reads as a tag.
  const odd = voiceChoices([v('  Spaced  out ', ' en_us ', { voiceURI: 'u1' }), v('', 'fr-FR', { voiceURI: 'u2' }), { voiceURI: 'u3', localService: true }, v('N'.repeat(200), 'de-DE', { voiceURI: 'u4' }), v(7, 'it-IT', { voiceURI: 'u5' })], []);
  assert.deepEqual(odd.map(c => [c.uri, c.name, c.lang]), [['u3', 'u3', ''], ['u4', 'N'.repeat(80), 'de-DE'], ['u1', 'Spaced out', 'en-us'], ['u2', 'u2', 'fr-FR'], ['u5', 'u5', 'it-IT']]);
  assert.ok(odd.every(c => c.mine === false), 'no language asked for: none is "mine"');
});

const FR_FIRST = v('Thomas', 'fr-FR');
const US_SECOND = v('Samantha', 'en-US');

test('voiceChoices: the page or browser language first, then the rest by language and name', () => {
  const list = [
    v('Thomas', 'fr-FR'), v('Zoe', 'en-US'), v('Daniel', 'en-GB'), v('Anna', 'de-DE'), v('Samantha', 'en-US'),
    v('Karen', 'en-AU'), v('Amelie', 'fr-CA'), v('alex', 'en-US'), v('Kyoko', 'ja-JP'), v('Plain', 'en')
  ];
  // The page says "en", the browser "en-US" then "en": as the Chat tab passes them.
  const got = voiceChoices(list, ['en', 'en-US', 'en', 'en-US']);
  assert.deepEqual(got.map(c => `${c.name}|${c.lang}|${c.mine ? 'mine' : 'other'}`), [
    'Plain|en|mine',
    'alex|en-US|mine', 'Samantha|en-US|mine', 'Zoe|en-US|mine',
    'Karen|en-AU|mine', 'Daniel|en-GB|mine',
    'Anna|de-DE|other', 'Amelie|fr-CA|other', 'Thomas|fr-FR|other', 'Kyoko|ja-JP|other'
  ]);
  // The order of the wanted languages decides between two exact matches, and between two near ones.
  assert.deepEqual(voiceChoices(list, ['fr-FR', 'en-GB']).map(c => c.name).slice(0, 4), ['Thomas', 'Daniel', 'Amelie', 'Plain']);
  assert.deepEqual(voiceChoices(list, ['ja', 'fr']).map(c => c.name).slice(0, 3), ['Kyoko', 'Amelie', 'Thomas']);
  // An exact match always comes before a near one, whatever the order asked.
  assert.deepEqual(voiceChoices([v('Daniel', 'en-GB'), v('Thomas', 'fr-FR')], ['en', 'fr-FR']).map(c => c.name), ['Thomas', 'Daniel']);
  // Case and Android's underscore don't matter; empty wants are skipped.
  assert.deepEqual(voiceChoices([v('Anna', 'de-DE'), v('Alex', 'en_US'), v('Nolang', '')], ['', null, 'EN-us']).map(c => `${c.name}|${c.mine}`), ['Alex|true', 'Nolang|false', 'Anna|false']);
  // Nothing asked for: by language, then name, and the listed order for a tie.
  assert.deepEqual(voiceChoices([v('B', 'fr-FR', { voiceURI: 'b1' }), v('B', 'fr-FR', { voiceURI: 'b2' }), v('a', 'fr-FR'), v('C', 'de-DE')]).map(c => c.uri), ['C', 'a', 'b1', 'b2']);
  for (const notList of ['en-US', new Set(['en-US']), { 0: 'en-US', length: 1 }]) assert.deepEqual(voiceChoices(list, notList).map(c => c.mine), list.map(() => false), 'languages that are not a list are none');
  assert.equal(pickLocalVoice([FR_FIRST, US_SECOND], new Set(['en-US'])), FR_FIRST);
});

test('langLabel: the language by its name where the browser can name it, else its tag', () => {
  const names = { of: tag => ({ 'en-US': 'English (United States)', 'fr-FR': 'French (France)' })[tag] };
  assert.equal(langLabel('en-US', names), 'English (United States)');
  assert.equal(langLabel('en_US', names), 'English (United States)', 'an underscore tag is looked up as a tag');
  assert.equal(langLabel(' fr-FR ', names), 'French (France)');
  assert.equal(langLabel('xx-YY', names), 'xx-YY', 'unknown to the browser: the tag itself');
  assert.equal(langLabel('en-US'), 'en-US');
  assert.equal(langLabel('en-US', null), 'en-US');
  assert.equal(langLabel('en-US', { of: () => { throw new RangeError('bad tag'); } }), 'en-US');
  assert.equal(langLabel('en-US', { of: () => '  ' }), 'en-US');
  assert.equal(langLabel('en-US', { of: () => 7 }), 'en-US');
  for (const none of ['', '  ', null, undefined, 7]) assert.equal(langLabel(none, names), '');
});

// A localStorage stand-in that records what was asked of it.
function fakeStorage(initial = {}) {
  const st = {
    data: { ...initial }, gets: 0, sets: 0, removes: 0,
    getItem(k) { st.gets++; return Object.hasOwn(st.data, k) ? st.data[k] : null; },
    setItem(k, val) { st.sets++; st.data[k] = String(val); },
    removeItem(k) { st.removes++; delete st.data[k]; }
  };
  return st;
}

test('the voice store: the saved choice is read once and written through', () => {
  assert.equal(VOICE_KEY, 'jos.chat.voice');
  const st = fakeStorage({ [VOICE_KEY]: 'Samantha' });
  const store = createVoiceStore(() => st);
  assert.equal(store.get(), 'Samantha');
  assert.equal(store.get(), 'Samantha');
  assert.equal(st.gets, 1, 'read once, then kept');
  assert.equal(store.set('Thomas'), 'Thomas');
  assert.equal(st.data[VOICE_KEY], 'Thomas');
  assert.equal(store.get(), 'Thomas');
  assert.equal(store.set(null), null, 'Automatic');
  assert.equal(Object.hasOwn(st.data, VOICE_KEY), false, 'Automatic leaves nothing saved');
  assert.equal(st.removes, 1);
  assert.equal(store.get(), null);
  assert.equal(st.gets, 1);
  // A set before any read never reads an older value back over it.
  const st2 = fakeStorage({ [VOICE_KEY]: 'Old' });
  const store2 = createVoiceStore(() => st2);
  store2.set('New');
  assert.equal(store2.get(), 'New');
  assert.equal(st2.gets, 0);
  // Another page of the same app sees it at its next start.
  assert.equal(createVoiceStore(() => st2).get(), 'New');
});

test('the voice store: what is saved must look like a voice address, or it is Automatic', () => {
  for (const bad of ['', 'x'.repeat(VOICE_URI_MAX + 1)]) assert.equal(createVoiceStore(() => fakeStorage({ [VOICE_KEY]: bad })).get(), null);
  assert.equal(createVoiceStore(() => ({ getItem: () => 7 })).get(), null);
  assert.equal(createVoiceStore(() => ({ getItem: () => ({ voiceURI: 'x' }) })).get(), null);
  assert.equal(createVoiceStore(() => fakeStorage({ [VOICE_KEY]: 'y'.repeat(VOICE_URI_MAX) })).get(), 'y'.repeat(VOICE_URI_MAX));
  const st = fakeStorage({ [VOICE_KEY]: 'Samantha' });
  const store = createVoiceStore(() => st);
  for (const bad of ['', 7, {}, undefined, 'x'.repeat(VOICE_URI_MAX + 1)]) {
    store.set('Thomas');
    assert.equal(store.set(bad), null, String(bad).slice(0, 20));
    assert.equal(store.get(), null);
    assert.equal(Object.hasOwn(st.data, VOICE_KEY), false, 'nothing unusable is ever written');
  }
});

test('the voice store: with no storage, or one that throws, it is Automatic and a pick lasts for the visit', () => {
  const broken = [
    undefined,
    () => null,
    () => undefined,
    () => { throw new Error('SecurityError: storage is blocked'); },
    () => ({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('denied'); } }),
    () => ({})
  ];
  for (const getStorage of broken) {
    const store = createVoiceStore(getStorage);
    assert.equal(store.get(), null);
    assert.equal(store.set('Thomas'), 'Thomas');
    assert.equal(store.get(), 'Thomas', 'kept in memory');
    assert.equal(store.set(null), null);
    assert.equal(store.get(), null);
  }
  // A store that reads but can't write (a full or private one) keeps the pick for the visit.
  const st = fakeStorage({ [VOICE_KEY]: 'Samantha' });
  st.setItem = () => { throw new Error('QuotaExceededError'); };
  const store = createVoiceStore(() => st);
  assert.equal(store.get(), 'Samantha');
  store.set('Thomas');
  assert.equal(store.get(), 'Thomas');
  assert.equal(st.data[VOICE_KEY], 'Samantha');
});

const US = v('Samantha', 'en-US');
const GB = v('Daniel', 'en-GB');
const FR = v('Thomas', 'fr-FR');
const memoryStore = saved => createVoiceStore(() => fakeStorage(saved ? { [VOICE_KEY]: saved } : {}));

test('the speaker: speaks in the saved voice, every piece', () => {
  const synth = fakeSynth([CLOUD, US, GB, FR]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, chunkMax: 20, langs: ['en-US'], store: memoryStore('Thomas') });
  sp.toggle('m_1', 'First part here. Second part here.');
  assert.equal(synth.queue.length, 2);
  for (const u of synth.queue) { assert.equal(u.voice, FR); assert.equal(u.lang, 'fr-FR'); }
  assert.deepEqual(sp.voices(), {
    choices: [{ uri: 'Samantha', name: 'Samantha', lang: 'en-US', mine: true }, { uri: 'Daniel', name: 'Daniel', lang: 'en-GB', mine: true }, { uri: 'Thomas', name: 'Thomas', lang: 'fr-FR', mine: false }],
    saved: 'Thomas', picked: 'Thomas', auto: 'Samantha', mini: null, engine: 'device'
  });
});

test('the speaker: no store, or nothing saved, is Automatic', () => {
  const synth = fakeSynth([FR, { ...GB, default: true }, US]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-US'] });
  assert.deepEqual({ ...sp.voices(), choices: null }, { choices: null, saved: null, picked: null, auto: 'Daniel', mini: null, engine: 'device' });
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice.name, 'Daniel');
  // Even with no store a pick works, for the visit.
  assert.equal(sp.setVoice('Thomas'), true);
  sp.toggle('m_2', 'hello');
  assert.equal(synth.queue[0].voice, FR);
  const sp2 = createSpeaker({ synth: fakeSynth([FR, US]), Utterance: FakeUtterance, langs: ['en-US'], store: memoryStore(null) });
  assert.equal(sp2.voices().picked, null);
  assert.equal(sp2.voices().auto, 'Samantha');
  // A choice saved on a browser that now lists no on-device voice at all.
  const sp3 = createSpeaker({ synth: fakeSynth([CLOUD]), Utterance: FakeUtterance, langs: ['en-US'], store: memoryStore('Thomas') });
  assert.deepEqual(sp3.voices(), { choices: [], saved: 'Thomas', picked: null, auto: null, mini: null, engine: 'device' });
  assert.equal(sp3.canSpeak(), false);
});

test('the speaker: a saved voice that is gone falls back to Automatic, and comes back with the voice', () => {
  const synth = fakeSynth([US, GB]);
  const store = memoryStore('Thomas');
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-GB'], store });
  const seen = [];
  sp.subscribe(() => seen.push(sp.voices().picked));
  assert.equal(sp.voices().saved, 'Thomas', 'the choice is kept');
  assert.equal(sp.voices().picked, null, 'but Automatic is what is used');
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice, GB);
  assert.equal(store.get(), 'Thomas', 'falling back never erases the choice');
  sp.stop();
  synth.changeVoices([US, GB, FR]);
  assert.equal(sp.voices().picked, 'Thomas');
  assert.equal(seen.at(-1), 'Thomas', 'subscribers hear of it');
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice, FR);
  // Listed again, but as a network voice: still Automatic.
  sp.stop();
  synth.changeVoices([US, GB, { ...FR, localService: false }]);
  assert.equal(sp.voices().picked, null);
  assert.deepEqual(sp.voices().choices.map(c => c.uri), ['Daniel', 'Samantha']);
});

test('the speaker: setVoice saves the pick, uses it at once and stops what was speaking', () => {
  const synth = fakeSynth([US, GB, FR]);
  const st = fakeStorage();
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-US'], store: createVoiceStore(() => st) });
  let calls = 0;
  sp.subscribe(() => { calls++; });
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice, US);
  const before = calls;
  assert.equal(sp.setVoice('Daniel'), true);
  assert.equal(st.data[VOICE_KEY], 'Daniel');
  assert.equal(sp.current(), null, 'the message in the old voice stops');
  assert.equal(synth.queue.length, 0);
  assert.ok(calls > before, 'subscribers hear of it');
  assert.equal(sp.voices().picked, 'Daniel');
  assert.equal(sp.voices().saved, 'Daniel');
  assert.equal(sp.voices().auto, 'Samantha', 'what Automatic would use is still named');
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice, GB);
  // Back to Automatic: null or the list's empty value.
  sp.stop();
  assert.equal(sp.setVoice(''), true);
  assert.equal(Object.hasOwn(st.data, VOICE_KEY), false);
  assert.equal(sp.voices().picked, null);
  assert.equal(sp.voices().saved, null);
  sp.toggle('m_1', 'hello');
  assert.equal(synth.queue[0].voice, US);
  sp.stop();
  sp.setVoice('Thomas');
  assert.equal(sp.setVoice(null), true);
  assert.equal(sp.voices().saved, null);
});

test('the speaker: setVoice takes only a voice on the list', () => {
  const synth = fakeSynth([US, CLOUD, FR]);
  const st = fakeStorage({ [VOICE_KEY]: 'Thomas' });
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-US'], store: createVoiceStore(() => st) });
  sp.toggle('m_1', 'hello');
  for (const bad of ['Google US English', 'Karen', 7, {}, undefined, 'thomas']) {
    assert.equal(sp.setVoice(bad), false, String(bad));
    assert.equal(st.data[VOICE_KEY], 'Thomas');
    assert.equal(sp.voices().picked, 'Thomas');
  }
  assert.equal(sp.current(), 'm_1', 'a refused pick stops nothing');
  // The list is read again first: a voice that just arrived can be picked, one that just left can't.
  synth.voices = [US, FR, GB];
  assert.equal(sp.setVoice('Daniel'), true);
  synth.voices = [US, FR];
  assert.equal(sp.setVoice('Daniel'), false, 'the saved voice itself, once it has left');
  assert.equal(sp.voices().picked, null);
  assert.equal(sp.voices().saved, 'Daniel');
  synth.voices = [US, GB];
  assert.equal(sp.setVoice('Thomas'), false);
  // No engine: nothing to pick.
  const off = createSpeaker({ Utterance: FakeUtterance, store: createVoiceStore(() => st) });
  assert.equal(off.setVoice(null), false);
  assert.equal(off.sample(), false);
  assert.equal(off.voices(), NO_VOICES);
  assert.equal(st.data[VOICE_KEY], 'Daniel');
});

test('the speaker: voices() is the same object until something in it changes', () => {
  assert.deepEqual(NO_VOICES, { choices: [], saved: null, picked: null, auto: null, mini: null, engine: 'device' });
  const synth = fakeSynth([]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-US'], store: memoryStore(null) });
  let calls = 0;
  sp.subscribe(() => { calls++; });
  assert.deepEqual(sp.voices(), NO_VOICES);
  const empty = sp.voices();
  synth.changeVoices([CLOUD]);
  assert.equal(sp.voices(), empty, 'a network voice changes nothing on the list');
  assert.equal(calls, 0);
  synth.changeVoices([CLOUD, US]);
  const one = sp.voices();
  assert.notEqual(one, empty);
  assert.equal(calls, 1);
  assert.equal(one.auto, 'Samantha');
  // The browser hands out new voice objects with the same content: no change, no re-render.
  synth.changeVoices([{ ...CLOUD }, { ...US }]);
  sp.subscribe(() => {})();
  sp.toggle('m_1', 'hello');
  sp.stop();
  assert.equal(sp.voices(), one);
  // A voice downloaded since: a new list.
  const at = calls;
  synth.changeVoices([US, FR]);
  assert.notEqual(sp.voices(), one);
  assert.deepEqual(sp.voices().choices.map(c => c.uri), ['Samantha', 'Thomas']);
  assert.equal(calls, at + 1);
  // What Automatic would use changes with the default flag alone.
  const two = sp.voices();
  synth.changeVoices([US, { ...FR, default: true }]);
  assert.notEqual(sp.voices(), two);
  assert.equal(sp.voices().auto, 'Thomas');
  // An on-device voice with no address: Automatic can use it, the list can't offer it.
  synth.changeVoices([{ name: 'Bare', lang: 'en-US', localService: true }]);
  assert.deepEqual(sp.voices(), { choices: [], saved: null, picked: null, auto: 'Bare', mini: null, engine: 'device' });
  assert.equal(sp.canSpeak(), true);
  synth.changeVoices([{ lang: 'en-US', localService: true }]);
  assert.equal(sp.voices().auto, 'an on-device voice', 'a voice with no name still gets words');
});

test('the speaker: the sample is one short sentence in the chosen voice, from the call itself', () => {
  assert.ok(SAMPLE_WORDS.length > 10 && SAMPLE_WORDS.length <= CHUNK_MAX && /[.]$/.test(SAMPLE_WORDS), 'one piece, one sentence');
  assert.ok(!/^m_/.test(SAMPLE_ID), 'never a message id');
  const synth = fakeSynth([US, GB, FR]);
  const sp = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-US'], store: memoryStore('Daniel') });
  const seen = [];
  sp.subscribe(() => seen.push(sp.current()));
  sp.toggle('m_1', 'a message');
  assert.equal(sp.sample(), true);
  assert.deepEqual(synth.queue.map(u => [u.text, u.voice.name]), [[SAMPLE_WORDS, 'Daniel']], 'the message stopped, the sample queued before the call returned');
  assert.equal(sp.current(), SAMPLE_ID);
  // A second tap stops it.
  assert.equal(sp.sample(), false);
  assert.equal(sp.current(), null);
  assert.equal(synth.queue.length, 0);
  // It ends by itself, and follows a new pick.
  sp.setVoice('Thomas');
  sp.sample();
  assert.equal(synth.queue[0].voice, FR);
  synth.finishOne();
  assert.equal(sp.current(), null);
  assert.deepEqual(seen.filter(Boolean), ['m_1', SAMPLE_ID, SAMPLE_ID]);
  // With no on-device voice there is nothing to sample.
  const none = createSpeaker({ synth: fakeSynth([CLOUD]), Utterance: FakeUtterance });
  assert.equal(none.sample(), false);
});

// ---- the Mac's own voice ----

// An <audio> element stand-in: records what was asked of it, and the test plays the
// browser's part (starts, ends, fails, pauses).
function fakeAudio({ rejectPlay = null, throwPlay = false } = {}) {
  const a = {
    src: null, preload: null, plays: 0, pauses: 0, loads: 0, srcs: [], pending: [],
    onplaying: null, onended: null, onpause: null, onerror: null,
    play() {
      a.plays++;
      a.srcs.push(a.src);
      if (throwPlay) throw new Error('play is not allowed');
      if (rejectPlay) return Promise.reject(rejectPlay);
      return new Promise((resolve, reject) => { a.pending.push({ resolve, reject }); });
    },
    pause() { a.pauses++; },
    removeAttribute(name) { if (name === 'src') a.src = null; },
    load() { a.loads++; },
    // The browser's side.
    starts() { a.onplaying?.({ type: 'playing' }); },
    ends() { a.onpause?.({ type: 'pause' }); a.onended?.({ type: 'ended' }); },
    fails() { a.onerror?.({ type: 'error' }); },
    systemPause() { a.onpause?.({ type: 'pause' }); }
  };
  return a;
}
// Timers the test fires by hand.
function fakeTimers() {
  const t = {
    list: [], n: 0,
    set(fn, ms) { const id = ++t.n; t.list.push({ id, fn, ms }); return id; },
    clear(id) { t.list = t.list.filter(x => x.id !== id); },
    fire() { const due = t.list; t.list = []; for (const x of due) x.fn(); }
  };
  return t;
}
const MINI_INFO = { voice: 'Evan (Enhanced)', wanted: 'Evan (Enhanced)', exact: true };
const tick = () => new Promise(r => setImmediate(r));
// A speaker with the Mac's voice on offer, an on-device voice behind it, and a clock.
function miniSpeaker({ voices = [US, GB], storage = fakeStorage(), audioOpts = {}, info = MINI_INFO, synth = fakeSynth(voices), withSynth = true } = {}) {
  const audios = [];
  const timers = fakeTimers();
  const clock = { t: 1000 };
  const sp = createSpeaker({
    ...(withSynth ? { synth, Utterance: FakeUtterance } : {}), langs: ['en-US'], store: createVoiceStore(() => storage),
    makeAudio: () => { const a = fakeAudio(audioOpts); audios.push(a); return a; },
    now: () => clock.t, setTimer: timers.set, clearTimer: timers.clear
  });
  let calls = 0;
  sp.subscribe(() => { calls++; });
  if (info) sp.setRemote(info);
  return { sp, synth, audios, timers, clock, storage, calls: () => calls, audio: () => audios[0] };
}

test('where the Mac\'s audio is: a message by its id, the sample, and nothing for an id the server would not know', () => {
  assert.equal(SPEECH_PATH, '/api/chat/speech/');
  assert.equal(speechUrl('m_abc123def456'), '/api/chat/speech/m_abc123def456');
  assert.equal(speechUrl(SAMPLE_ID), '/api/chat/speech/sample');
  for (const id of [null, undefined, '', 7, 'local-1', 'm_', 'm_ABCDEF', 'm_abc', 'm_abcdef/../x', 'm_abcdef?x=1', 'sample', `m_${'a'.repeat(25)}`, ' m_abcdef']) {
    assert.equal(speechUrl(id), null, JSON.stringify(id));
  }
  assert.equal(REMOTE_START_MS, 20e3);
  assert.equal(REMOTE_RETRY_MS, 30e3);
  assert.equal(MINI, ':mini');
});

test('what the status says of the Mac\'s voice is checked before it is shown', () => {
  assert.deepEqual(miniVoice(MINI_INFO), { voice: 'Evan (Enhanced)', short: 'Evan', wanted: 'Evan (Enhanced)', exact: true });
  assert.deepEqual(miniVoice({ voice: ' Samantha  (English (US)) ', wanted: 'Evan (Enhanced)', exact: false }), { voice: 'Samantha (English (US))', short: 'Samantha', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(miniVoice({ voice: 'Daniel' }), { voice: 'Daniel', short: 'Daniel', wanted: 'Daniel', exact: false });
  assert.equal(miniVoice({ voice: 'Daniel', exact: 'yes' }).exact, false, 'only a real true');
  assert.equal(miniVoice({ voice: 'x'.repeat(200) }).voice.length, 80);
  assert.equal(miniVoice({ voice: 'Daniel', wanted: 'y'.repeat(200) }).wanted.length, 80);
  for (const bad of [null, undefined, 'Evan', 7, [], {}, { voice: '' }, { voice: '   ' }, { voice: 7 }, { voice: ' (Enhanced)' }]) assert.equal(miniVoice(bad), null, JSON.stringify(bad));
  assert.equal(shortVoiceName('Evan (Enhanced)'), 'Evan');
  assert.equal(shortVoiceName('Samantha (English (US))'), 'Samantha');
  assert.equal(shortVoiceName('Bad  News'), 'Bad News');
  assert.equal(shortVoiceName(null), '');
});

test('the voice store: which side reads is kept under its own key, read once, and only "device" is ever written', () => {
  assert.equal(ENGINE_KEY, 'jos.chat.voice.engine');
  const st = fakeStorage({ [ENGINE_KEY]: 'device', [VOICE_KEY]: 'Thomas' });
  const store = createVoiceStore(() => st);
  assert.equal(store.engine(), 'device');
  assert.equal(store.engine(), 'device');
  assert.equal(st.gets, 1, 'read once');
  assert.equal(store.setEngine(null), null);
  assert.ok(!Object.hasOwn(st.data, ENGINE_KEY));
  assert.equal(st.data[VOICE_KEY], 'Thomas', 'the on-device voice is left alone');
  assert.equal(store.setEngine('device'), 'device');
  assert.equal(st.data[ENGINE_KEY], 'device');
  for (const odd of ['mini', '', 'DEVICE', 7, {}, undefined]) {
    assert.equal(store.setEngine(odd), null, JSON.stringify(odd));
    assert.ok(!Object.hasOwn(st.data, ENGINE_KEY));
  }
  for (const saved of ['mini', 'Device', '', 'x'.repeat(400)]) {
    assert.equal(createVoiceStore(() => fakeStorage({ [ENGINE_KEY]: saved })).engine(), null, JSON.stringify(saved));
  }
  // Storage that throws or is missing: the default, and a choice still holds for the visit.
  const broken = createVoiceStore(() => { throw new Error('blocked'); });
  assert.equal(broken.engine(), null);
  assert.equal(broken.setEngine('device'), 'device');
  assert.equal(broken.engine(), 'device');
  const none = createVoiceStore();
  assert.equal(none.engine(), null);
  assert.equal(none.setEngine('device'), 'device');
  assert.equal(none.engine(), 'device');
});

test('the Mac\'s voice is the default where the server offers it: a tap asks for the audio inside the tap, by the message\'s id', () => {
  const { sp, synth, audios, timers, calls } = miniSpeaker();
  assert.deepEqual({ mini: sp.voices().mini, engine: sp.voices().engine }, { mini: { voice: 'Evan (Enhanced)', short: 'Evan', wanted: 'Evan (Enhanced)', exact: true }, engine: 'mini' });
  assert.equal(sp.canSpeak(), true);
  assert.equal(audios.length, 0, 'no audio element until the first tap');
  const before = calls();
  assert.equal(sp.toggle('m_abc123def456', '**Hello** there.'), true);
  // All of it happened before toggle returned: that is "inside the tap".
  assert.equal(audios.length, 1);
  const a = audios[0];
  assert.equal(a.plays, 1);
  assert.deepEqual(a.srcs, ['/api/chat/speech/m_abc123def456']);
  assert.equal(a.preload, 'auto');
  assert.equal(synth.spoken.length, 0, 'the device\'s own voice says nothing');
  assert.equal(sp.current(), 'm_abc123def456');
  assert.equal(sp.loading(), 'm_abc123def456');
  assert.equal(calls(), before + 1);
  assert.deepEqual(timers.list.map(t => t.ms), [20e3]);
  // It starts: no longer loading, the start timer gone.
  a.starts();
  assert.equal(sp.loading(), null);
  assert.equal(sp.current(), 'm_abc123def456');
  assert.equal(timers.list.length, 0);
  assert.equal(calls(), before + 2);
  a.starts();
  assert.equal(calls(), before + 2, 'a second playing event (after a stall) changes nothing');
  // It ends: idle, and the element let go.
  a.ends();
  assert.equal(sp.current(), null);
  assert.equal(a.src, null);
  assert.equal(calls(), before + 3);
  // The next message reuses the one element.
  sp.toggle('m_zzz999yyy888', 'Next.');
  assert.equal(audios.length, 1);
  assert.deepEqual(a.srcs, ['/api/chat/speech/m_abc123def456', '/api/chat/speech/m_zzz999yyy888']);
});

test('the Mac\'s voice: a second tap stops it, loading or playing; another message takes over; stop() is the hook\'s way out', () => {
  const { sp, synth, audio, timers } = miniSpeaker();
  sp.toggle('m_aaaaaa1', 'One.');
  const a = audio();
  assert.equal(sp.toggle('m_aaaaaa1', 'One.'), false, 'stopped while loading');
  assert.equal(sp.current(), null);
  assert.equal(sp.loading(), null);
  assert.equal(a.pauses, 1);
  assert.equal(a.src, null);
  assert.equal(a.loads, 1, 'the download is dropped');
  assert.equal(timers.list.length, 0);
  assert.equal(a.onplaying, null);
  assert.equal(synth.cancels, 0);
  // The stopped request's play() promise rejects late: nothing happens.
  sp.toggle('m_aaaaaa1', 'One.');
  a.starts();
  sp.toggle('m_bbbbbb2', 'Two.');
  assert.equal(sp.current(), 'm_bbbbbb2');
  assert.equal(sp.loading(), 'm_bbbbbb2');
  assert.equal(a.src, '/api/chat/speech/m_bbbbbb2');
  assert.equal(a.pauses, 2, 'the first was stopped before the second was asked for');
  sp.stop();
  assert.equal(sp.current(), null);
  assert.equal(a.pauses, 3);
  sp.stop();
  assert.equal(a.pauses, 3, 'nothing to stop');
  // A system pause (a headset, the lock screen) ends it too.
  sp.toggle('m_cccccc3', 'Three.');
  a.starts();
  a.systemPause();
  assert.equal(sp.current(), null);
});

test('the Mac\'s voice: a late event of a stopped or replaced message changes nothing', async () => {
  const { sp, audio, synth } = miniSpeaker();
  sp.toggle('m_aaaaaa1', 'One.');
  const a = audio();
  const first = { playing: a.onplaying, ended: a.onended, error: a.onerror, pending: a.pending[0] };
  sp.toggle('m_bbbbbb2', 'Two.');
  // The first request's promise rejects as its load is dropped, and its old handlers fire late.
  first.pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  first.error?.({});
  first.ended?.({});
  first.playing?.({});
  await tick();
  assert.equal(sp.current(), 'm_bbbbbb2');
  assert.equal(sp.loading(), 'm_bbbbbb2');
  assert.equal(synth.spoken.length, 0, 'no fallback for a message the user moved on from');
});

test('the Mac can\'t: the device\'s own voice reads the same message, and keeps reading for a while', async () => {
  for (const how of ['error', 'reject', 'timeout', 'throw']) {
    const { sp, synth, audios, timers, clock, calls } = miniSpeaker({ audioOpts: how === 'reject' ? { rejectPlay: Object.assign(new Error('no'), { name: 'NotSupportedError' }) } : how === 'throw' ? { throwPlay: true } : {} });
    const started = sp.toggle('m_aaaaaa1', 'Hello **there**. Second sentence.');
    const a = audios[0];
    if (how === 'error') a.fails();
    if (how === 'timeout') timers.fire();
    await tick();
    assert.equal(started, true, how);
    assert.deepEqual(synth.spoken, ['Hello there. Second sentence.'], `${how}: the same words, in the device's voice`);
    assert.equal(synth.queue[0].voice, US);
    assert.equal(sp.current(), 'm_aaaaaa1', how);
    assert.equal(sp.loading(), null, how);
    assert.equal(a.src, null, `${how}: the audio is let go`);
    assert.equal(timers.list.length, 0, how);
    // Both an error event and a rejected promise for one failure: read once.
    a.fails();
    await tick();
    assert.equal(synth.spoken.length, 1, how);
    const n = calls();
    synth.finishOne();
    assert.equal(sp.current(), null);
    assert.equal(calls(), n + 1);
    // For 30 s the next taps go straight to the device's voice (inside the tap)...
    clock.t += 29999;
    sp.toggle('m_bbbbbb2', 'Again.');
    assert.equal(a.plays, 1, how);
    assert.deepEqual(synth.spoken, ['Hello there. Second sentence.', 'Again.']);
    synth.finishOne();
    // ...then the Mac is asked again.
    clock.t += 1;
    sp.toggle('m_cccccc3', 'Later.');
    assert.equal(a.plays, 2, how);
    assert.equal(a.srcs[1], '/api/chat/speech/m_cccccc3');
  }
});

test('the Mac\'s audio breaks off after it started: it stops, and is not started over in another voice', () => {
  const { sp, synth, audio, clock } = miniSpeaker();
  sp.toggle('m_aaaaaa1', 'Hello.');
  const a = audio();
  a.starts();
  a.fails();
  assert.equal(sp.current(), null);
  assert.equal(synth.spoken.length, 0);
  // And the Mac is still asked next time: that was no failure to start.
  clock.t += 1;
  sp.toggle('m_bbbbbb2', 'Next.');
  assert.equal(a.plays, 2);
});

test('the Mac can\'t and the device has no voice of its own: the button goes idle, and the Mac is asked again at once', () => {
  for (const withSynth of [true, false]) {
    const { sp, synth, audio } = miniSpeaker({ voices: [CLOUD], withSynth });
    assert.equal(sp.canSpeak(), true, 'the Mac\'s voice alone is enough for the button');
    assert.equal(sp.voices().auto, null);
    assert.equal(sp.toggle('m_aaaaaa1', 'Hello.'), true);
    const a = audio();
    a.fails();
    assert.equal(sp.current(), null);
    assert.equal(sp.loading(), null);
    assert.equal(synth.spoken.length, 0);
    sp.toggle('m_aaaaaa1', 'Hello.');
    assert.equal(a.plays, 2, 'no 30 s of silence where nothing else can read');
  }
});

test('the device\'s own voice reads when the server offers none, the id is not the server\'s, or there is nothing to say', () => {
  const none = miniSpeaker({ info: null });
  assert.equal(none.sp.voices().engine, 'device');
  none.sp.toggle('m_aaaaaa1', 'Hello.');
  assert.equal(none.audios.length, 0);
  assert.deepEqual(none.synth.spoken, ['Hello.']);
  // No audio element class in this browser: the offer is ignored.
  const synth = fakeSynth([US]);
  const noAudio = createSpeaker({ synth, Utterance: FakeUtterance, langs: ['en-US'] });
  noAudio.setRemote(MINI_INFO);
  assert.equal(noAudio.voices().mini, null);
  assert.equal(noAudio.voices().engine, 'device');
  assert.equal(noAudio.setVoice(MINI), false);
  noAudio.toggle('m_aaaaaa1', 'Hello.');
  assert.deepEqual(synth.spoken, ['Hello.']);
  // A message the server has no id for (not sent yet) is read here.
  const local = miniSpeaker();
  local.sp.toggle('local-17', 'Draft.');
  assert.equal(local.audios.length, 0);
  assert.deepEqual(local.synth.spoken, ['Draft.']);
  // Nothing to say: nothing is asked of the Mac either.
  const empty = miniSpeaker();
  assert.equal(empty.sp.toggle('m_aaaaaa1', '   '), false);
  assert.equal(empty.audios.length, 0);
  assert.equal(empty.sp.current(), null);
});

test('the offer comes and goes with the status: the view follows, and what is playing is left to finish', () => {
  const { sp, audio, calls, synth } = miniSpeaker({ info: null });
  assert.equal(sp.voices().mini, null);
  let n = calls();
  sp.setRemote({ voice: 'Samantha (English (US))', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(sp.voices().mini, { voice: 'Samantha (English (US))', short: 'Samantha', wanted: 'Evan (Enhanced)', exact: false });
  assert.equal(sp.voices().engine, 'mini');
  assert.equal(calls(), n + 1);
  const view = sp.voices();
  sp.setRemote({ voice: 'Samantha (English (US))', wanted: 'Evan (Enhanced)', exact: false });
  assert.equal(sp.voices(), view, 'the same answer again changes nothing');
  assert.equal(calls(), n + 1);
  // The voice is downloaded on the Mac: the next status names it.
  sp.setRemote(MINI_INFO);
  assert.equal(sp.voices().mini.short, 'Evan');
  assert.equal(calls(), n + 2);
  sp.toggle('m_aaaaaa1', 'Hello.');
  audio().starts();
  n = calls();
  sp.setRemote(null);
  assert.equal(sp.voices().mini, null);
  assert.equal(sp.voices().engine, 'device');
  assert.equal(sp.current(), 'm_aaaaaa1', 'still playing');
  assert.equal(calls(), n + 1);
  audio().ends();
  sp.toggle('m_bbbbbb2', 'Next.');
  assert.equal(audio().plays, 1);
  assert.deepEqual(synth.spoken, ['Next.']);
  sp.setRemote('nonsense');
  assert.equal(sp.voices().mini, null);
});

test('the picker\'s choice: the Mac\'s voice or the device\'s own, kept apart from which on-device voice', () => {
  const storage = fakeStorage({ [VOICE_KEY]: 'Daniel' });
  const { sp, synth, audio, clock } = miniSpeaker({ storage });
  // A voice picked before the Mac's was on offer stays the one that reads when the Mac can't.
  assert.deepEqual({ engine: sp.voices().engine, saved: sp.voices().saved, picked: sp.voices().picked }, { engine: 'mini', saved: 'Daniel', picked: 'Daniel' });
  sp.toggle('m_aaaaaa1', 'Hello.');
  audio().fails();
  assert.equal(synth.queue[0].voice, GB);
  synth.finishOne();
  // Picking an on-device voice while the Mac's is on offer says: the device reads.
  sp.toggle('m_bbbbbb2', 'Playing.');
  assert.equal(sp.setVoice('Samantha'), true);
  assert.equal(sp.current(), null, 'a pick stops what is speaking');
  assert.equal(storage.data[ENGINE_KEY], 'device');
  assert.equal(storage.data[VOICE_KEY], 'Samantha');
  assert.equal(sp.voices().engine, 'device');
  clock.t += 60e3;
  sp.toggle('m_cccccc3', 'Local.');
  assert.equal(audio().plays, 1, 'the Mac is not asked');
  assert.equal(synth.queue[0].voice, US);
  synth.finishOne();
  // Automatic on the device is a choice of the device too.
  assert.equal(sp.setVoice(''), true);
  assert.equal(storage.data[ENGINE_KEY], 'device');
  assert.ok(!Object.hasOwn(storage.data, VOICE_KEY));
  // Back to the Mac's voice: the on-device pick is kept, and a failure's wait is forgotten.
  sp.setVoice('Daniel');
  assert.equal(sp.setVoice(MINI), true);
  assert.ok(!Object.hasOwn(storage.data, ENGINE_KEY));
  assert.equal(storage.data[VOICE_KEY], 'Daniel');
  assert.equal(sp.voices().engine, 'mini');
  sp.toggle('m_dddddd4', 'Mac.');
  audio().fails();
  synth.finishOne();
  assert.equal(sp.setVoice(MINI), true);
  sp.toggle('m_eeeeee5', 'Mac again.');
  assert.equal(audio().src, '/api/chat/speech/m_eeeeee5', 'asked at once after the pick');
  sp.stop();
  // Picking the Mac's voice stops what the device's own voice is saying.
  sp.setVoice('');
  sp.toggle('m_gggggg7', 'Said on the device.');
  assert.equal(sp.current(), 'm_gggggg7');
  assert.equal(sp.setVoice(MINI), true);
  assert.equal(sp.current(), null);
  assert.equal(synth.queue.length, 0);
  // A device that chose its own voice keeps it across visits.
  sp.setVoice('Samantha');
  const next = miniSpeaker({ storage });
  assert.equal(next.sp.voices().engine, 'device');
  next.sp.toggle('m_ffffff6', 'Local.');
  assert.equal(next.audios.length, 0);
});

test('a pick made while the server offers no Mac voice is not a choice against it', () => {
  const storage = fakeStorage();
  const { sp } = miniSpeaker({ storage, info: null });
  assert.equal(sp.setVoice(MINI), false, 'nothing to pick');
  assert.equal(sp.setVoice('Daniel'), true);
  assert.ok(!Object.hasOwn(storage.data, ENGINE_KEY));
  sp.setRemote(MINI_INFO);
  assert.equal(sp.voices().engine, 'mini');
  assert.equal(sp.voices().picked, 'Daniel');
});

test('the sample plays in the voice in use: the Mac\'s fixed sentence, or the device\'s own', () => {
  const { sp, synth, audio } = miniSpeaker();
  assert.equal(sp.sample(), true);
  assert.equal(audio().src, '/api/chat/speech/sample');
  assert.equal(sp.current(), SAMPLE_ID);
  assert.equal(sp.loading(), SAMPLE_ID);
  assert.equal(sp.sample(), false, 'a second tap stops it');
  sp.sample();
  audio().fails();
  assert.deepEqual(synth.spoken, [SAMPLE_WORDS], 'the Mac can\'t: the same sentence here');
});

test('one at a time across both voices: the Mac\'s audio stops the device\'s voice and the other way round', () => {
  const { sp, synth, audio, clock } = miniSpeaker();
  sp.toggle('local-1', 'A draft read on the device.');
  assert.equal(synth.queue.length, 1);
  sp.toggle('m_aaaaaa1', 'From the Mac.');
  assert.equal(synth.cancels, 1);
  assert.equal(synth.queue.length, 0);
  assert.equal(sp.current(), 'm_aaaaaa1');
  audio().starts();
  sp.toggle('local-2', 'Another draft.');
  assert.equal(audio().src, null);
  assert.equal(audio().pauses, 1);
  assert.equal(sp.current(), 'local-2');
  assert.equal(sp.loading(), null);
  synth.finishOne();
  // Something else on the page is speaking: it is cancelled before the Mac's audio starts.
  synth.speak(new FakeUtterance('someone else'));
  const cancels = synth.cancels;
  clock.t += 1;
  sp.toggle('m_bbbbbb2', 'Mac.');
  assert.equal(synth.cancels, cancels + 1);
  // Losing the last on-device voice does not stop the Mac's audio.
  synth.changeVoices([CLOUD]);
  assert.equal(sp.current(), 'm_bbbbbb2');
});
