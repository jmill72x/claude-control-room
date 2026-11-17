// Read aloud (src/lib/orbit/speech.js): a message's Markdown as words to speak, cut
// into pieces a speech engine takes whole, and the speaker that keeps one message
// speaking at a time over a fake speechSynthesis. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechText, speechChunks, createSpeaker, CODE_WORDS, CHUNK_MAX } from '../src/lib/orbit/speech.js';

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

function fakeSynth() {
  const synth = {
    queue: [], spoken: [], cancels: 0,
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
