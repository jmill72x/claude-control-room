import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { constants as bufferConstants } from 'node:buffer';
import { parseTranscript, parseTranscriptStream, parseTranscriptFile } from '../lib/parse-transcript.mjs';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// Hands the bytes over in pieces of `size`, so line ends and multi-byte
// characters fall on every kind of boundary.
async function* pieces(bytes, size) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const streamed = (bytes, size, surface = 'Code', options) => parseTranscriptStream(pieces(bytes, size), surface, options);
const withoutCount = ({ oversizedLines, ...rest }) => rest;
const sum = records => records.reduce((a, r) => a + r.tokens, 0);

// Synthetic lines with invented ids, never a copy of a real transcript. The text
// carries accents, an arrow and an emoji, so some of the cuts land inside a
// character's bytes.
const usageLine = (id, ts, usage) => JSON.stringify({
  type: 'assistant', timestamp: ts, sessionId: 'sess-1', cwd: '/Users/example/Projects/demo', requestId: `req_${id}`,
  message: { id: `msg_${id}`, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'naïve café → ✓ 🚀' }], usage }
});
const MIXED = [
  JSON.stringify({ type: 'user', sessionId: 'sess-1', cwd: '/Users/example/Projects/demo', gitBranch: 'main', message: { role: 'user', content: 'héllo — wörld 🌍' } }),
  usageLine('A', '2026-10-20T10:00:00.000Z', { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000 }),
  usageLine('A', '2026-10-20T10:00:01.000Z', { input_tokens: 3, output_tokens: 480, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000 }),
  '',
  'not json at all',
  'null',
  JSON.stringify({ type: 'ai-title', aiTitle: 'Démo ✓', sessionId: 'sess-1' }),
  usageLine('B', '2026-10-20T10:01:00.000Z', { input_tokens: 10, output_tokens: 20 }) + '\r', // a CRLF line end
  JSON.stringify({ timestamp: '2026-10-20T10:02:00.000Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 7 } } }), // no ids
  usageLine('C', '2026-10-20T10:03:00.000Z', { input_tokens: 1, output_tokens: 2 }) // the last line, with no newline after it
].join('\n');

test('a transcript read as a stream gives what the whole string gives, however its bytes are cut', async () => {
  const cases = [
    ['transcript-code.jsonl', 'Code', readFileSync(fixture('transcript-code.jsonl'))],
    ['transcript-cowork.jsonl', 'Cowork', readFileSync(fixture('transcript-cowork.jsonl'))],
    ['synthetic', 'Code', Buffer.from(MIXED)]
  ];
  for (const [name, surface, bytes] of cases) {
    const expected = parseTranscript(bytes.toString('utf8'), surface);
    assert.ok(expected.records.length > 0, `${name} has records to compare`);
    for (const size of [1, 2, 3, 7, 64, 4096, bytes.length]) {
      const out = await streamed(bytes, size, surface);
      assert.equal(out.oversizedLines, 0);
      assert.deepEqual(withoutCount(out), expected, `${name} in pieces of ${size} bytes`);
    }
  }
});

test('the synthetic transcript reads as expected: one record per request, the title, the first branch', () => {
  const out = parseTranscript(MIXED, 'Code');
  assert.equal(out.records.length, 4);
  assert.equal(sum(out.records), (3 + 480 + 1000) + 30 + 7 + 3);
  assert.equal(out.title, 'Démo ✓');
  assert.equal(out.gitBranch, 'main');
  assert.equal(out.cwd, '/Users/example/Projects/demo');
});

test('a transcript file read in pieces gives what reading the whole file gives', async () => {
  for (const name of ['transcript-code.jsonl', 'transcript-cowork.jsonl']) {
    const out = await parseTranscriptFile(fixture(name), 'Code');
    assert.equal(out.oversizedLines, 0);
    assert.deepEqual(withoutCount(out), parseTranscript(readFileSync(fixture(name), 'utf8'), 'Code'), name);
  }
});

// The reason for the stream: a long session's transcript outgrows what one
// string can hold, and reading it whole then fails, which used to drop the whole
// session out of every total. These bytes come from a generator, never a file.
test('a transcript larger than one string can hold is read to its end, every request counted', async () => {
  const limit = bufferConstants.MAX_STRING_LENGTH;
  // A 1 MiB line with no usage, the way a long tool result looks.
  const filler = Buffer.alloc(1024 * 1024, 'a');
  filler.write('{"type":"user","sessionId":"sess-1","pad":"', 0);
  filler.write('"}\n', filler.length - 3);
  const fillerLines = Math.ceil(limit / filler.length) + 4;
  const line = (id, minute) => usageLine(id, `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`, { input_tokens: 1, output_tokens: 2 });
  let bytes = 0;
  async function* huge() {
    const first = Buffer.from(line('first', 0) + '\n');
    bytes += first.length;
    yield first;
    for (let i = 0; i < fillerLines; i++) {
      if (i === Math.floor(fillerLines / 2)) {
        const middle = Buffer.from(line('middle', 1) + '\n');
        bytes += middle.length;
        yield middle;
      }
      bytes += filler.length;
      yield filler;
    }
    const last = Buffer.from(line('last', 2)); // no newline after the last line
    bytes += last.length;
    yield last;
  }

  const out = await parseTranscriptStream(huge(), 'Code');
  assert.ok(bytes > limit, `${bytes} bytes is more than the ${limit} one string can hold`);
  assert.deepEqual(out.records.map(r => r.requestKey), ['first', 'middle', 'last'].map(id => JSON.stringify([`req_${id}`, `msg_${id}`])));
  assert.equal(sum(out.records), 9);
  assert.equal(out.oversizedLines, 0);
});

test('a line too long to decode is dropped and counted, and the rest of the transcript still counts', async () => {
  const one = usageLine('one', '2026-10-20T10:00:00.000Z', { input_tokens: 4, output_tokens: 4 });
  const two = usageLine('two', '2026-10-20T10:01:00.000Z', { input_tokens: 5, output_tokens: 5 });
  const bytes = Buffer.from(`${one}\n${'x'.repeat(5000)}\n${two}\n`);
  for (const size of [1, 7, 4096]) {
    const out = await streamed(bytes, size, 'Code', { maxLineBytes: 1000 });
    assert.equal(out.oversizedLines, 1, `pieces of ${size}`);
    assert.equal(sum(out.records), 18);
  }
  // A line exactly at the limit is still read.
  const exact = await streamed(Buffer.from(`${one}\n`), 7, 'Code', { maxLineBytes: Buffer.byteLength(one) });
  assert.equal(exact.oversizedLines, 0);
  assert.equal(sum(exact.records), 8);
});

test('a line holding JSON null is skipped, not fatal', () => {
  const text = ['null', usageLine('A', '2026-10-20T10:00:00.000Z', { input_tokens: 2, output_tokens: 3 })].join('\n');
  assert.equal(sum(parseTranscript(text, 'Code').records), 5);
});
