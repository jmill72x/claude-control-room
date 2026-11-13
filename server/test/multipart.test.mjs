// The multipart reader (lib/multipart.mjs): what a Shortcut's Form body looks like on
// the wire, and everything the reader refuses. Every name and byte here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formBoundary, mediaType, readDisposition, parseMultipart, MultipartError } from '../lib/multipart.mjs';

const B = 'Boundary-7MA4YWxkTrZu0gW';
const CRLF = '\r\n';
// A body from parts: `[headers, data]`, with the line breaks the wire has.
const body = (parts, { boundary = B, close = `--${boundary}--${CRLF}` } = {}) => Buffer.concat([
  ...parts.flatMap(([headers, data]) => [Buffer.from(`--${boundary}${CRLF}${headers.join(CRLF)}${CRLF}${CRLF}`), Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from(CRLF)]),
  Buffer.from(close)
]);
const field = (name, value) => [[`Content-Disposition: form-data; name="${name}"`], value];
const file = (name, filename, type, data) => [[`Content-Disposition: form-data; name="${name}"; filename="${filename}"`, `Content-Type: ${type}`], data];
const fails = (buf, words, options) => assert.throws(() => parseMultipart(buf, B, options), err => err instanceof MultipartError && (words ? words.test(err.message) : true));

test('mediaType and formBoundary: the type without its parameters, and the boundary of a form only', () => {
  assert.equal(mediaType('Multipart/Form-Data; boundary=x'), 'multipart/form-data');
  assert.equal(mediaType(undefined), '');
  assert.equal(formBoundary(`multipart/form-data; boundary=${B}`), B);
  assert.equal(formBoundary(`multipart/form-data; charset=utf-8; BOUNDARY="${B}"`), B);
  assert.equal(formBoundary(`Multipart/Form-Data;boundary=${B}`), B);
  assert.equal(formBoundary(`multipart/mixed; boundary=${B}`), null, 'not a form');
  assert.equal(formBoundary(`application/json; boundary=${B}`), null);
  assert.equal(formBoundary('multipart/form-data'), null, 'no boundary');
  assert.equal(formBoundary('multipart/form-data; boundary='), null);
  assert.equal(formBoundary('multipart/form-data; boundary="a b"'), null, 'a space');
  assert.equal(formBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`), null, '70 at most');
  assert.equal(formBoundary(`multipart/form-data; boundary=${'x'.repeat(70)}`), 'x'.repeat(70));
  assert.equal(formBoundary(undefined), null);
});

test('readDisposition: form-data with a name, a file name when there is one, and nothing else', () => {
  assert.deepEqual(readDisposition('form-data; name="text"'), { name: 'text', filename: null });
  assert.deepEqual(readDisposition('form-data; name="file"; filename="IMG 1.jpeg"'), { name: 'file', filename: 'IMG 1.jpeg' });
  assert.deepEqual(readDisposition('Form-Data;name=file;filename=a.pdf'), { name: 'file', filename: 'a.pdf' });
  assert.deepEqual(readDisposition('form-data; name="file"; filename=""'), { name: 'file', filename: '' });
  // A quote and a backslash inside a quoted name; a semicolon inside one is part of it.
  assert.deepEqual(readDisposition('form-data; name="file"; filename="a\\"b;c\\\\d.txt"'), { name: 'file', filename: 'a"b;c\\d.txt' });
  assert.deepEqual(readDisposition('form-data; name="file"; filename="C:\\dir\\x.png"'), { name: 'file', filename: 'C:\\dir\\x.png' });
  // `filename*` is read as its own key and not used.
  assert.deepEqual(readDisposition('form-data; name="file"; filename*=UTF-8\'\'x.png'), { name: 'file', filename: null });
  // The keys in any case.
  assert.deepEqual(readDisposition('form-data; Name="a"; FILENAME="b"'), { name: 'a', filename: 'b' });
  for (const bad of ['attachment; name="x"', 'form-data', 'form-data; filename="x"', 'form-data; name="a"; name="b"', 'form-data; name="open', 'form-data name="x"', 'form-data; ="x"', 'form-data; name', 'form-data; name="x" junk', '', undefined,
    'form-data; name="x",filename="y"', 'form-data; name="a"; ="b"', 'form-data; name=a"b"', 'form-data; name=x junk', 'form-data; name=x\tjunk']) {
    assert.equal(readDisposition(bad), null, String(bad));
  }
});

test('parseMultipart: fields and files in order, the bytes untouched and never copied', () => {
  // A file whose bytes hold line breaks, dashes and a near-boundary: none of it ends the part.
  // The whole boundary in the middle of a line is not one either.
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 13, 10]), Buffer.from(`${CRLF}--${CRLF}--Boundary${CRLF}--${B.slice(0, -1)}${CRLF}inline--${B}--inline`), Buffer.from([13, 10, 45, 45])]);
  const buf = body([field('text', 'Worth a look?'), field('via', 'share'), file('file', 'IMG_1.PNG', 'image/png', bytes), file('file', 'notes.md', 'text/markdown; charset=utf-8', '# Title\r\n')]);
  const parts = parseMultipart(buf, B);
  assert.deepEqual(parts.map(p => [p.name, p.filename, p.type]), [['text', null, null], ['via', null, null], ['file', 'IMG_1.PNG', 'image/png'], ['file', 'notes.md', 'text/markdown']]);
  assert.equal(parts[0].data.toString(), 'Worth a look?');
  assert.ok(parts[2].data.equals(bytes), 'the file is whole');
  assert.equal(parts[3].data.toString(), '# Title\r\n', 'a file may end in a line break of its own');
  // Views into the body, never copies: a byte changed in the body is changed in the part.
  for (const p of parts) {
    const at = buf.indexOf(p.data);
    buf[at] ^= 0xff;
    assert.equal(p.data[0], buf[at], p.name);
    buf[at] ^= 0xff;
  }
});

test('parseMultipart: an empty part in both spellings, line breaks before the first boundary, and anything after the last', () => {
  const usual = parseMultipart(body([field('text', ''), field('via', 'share')]), B);
  assert.deepEqual(usual.map(p => [p.name, p.data.length]), [['text', 0], ['via', 5]]);
  // Some writers let the blank line's own break be the one before the boundary.
  const short = Buffer.from(`--${B}${CRLF}Content-Disposition: form-data; name="file"; filename=""${CRLF}${CRLF}--${B}${CRLF}Content-Disposition: form-data; name="via"${CRLF}${CRLF}share${CRLF}--${B}--`);
  assert.deepEqual(parseMultipart(short, B).map(p => [p.name, p.filename, p.data.toString()]), [['file', '', ''], ['via', null, 'share']]);
  // A part with no headers at all has no name.
  fails(Buffer.from(`--${B}${CRLF}${CRLF}data${CRLF}--${B}--`), /no name/);
  const padded = Buffer.concat([Buffer.from(`${CRLF}${CRLF}`), body([field('text', 'hi')], { close: `--${B}--${CRLF}whatever comes after${CRLF}--${B}${CRLF}` })]);
  assert.deepEqual(parseMultipart(padded, B).map(p => p.data.toString()), ['hi']);
  // Spaces after a boundary, before its line break, are allowed.
  const spaced = Buffer.from(`--${B} \t${CRLF}Content-Disposition: form-data; name="text"${CRLF}${CRLF}hi${CRLF}--${B}--`);
  assert.equal(parseMultipart(spaced, B)[0].data.toString(), 'hi');
  assert.deepEqual(parseMultipart(Buffer.from(`--${B}--`), B), [], 'a form with nothing in it');
});

test('parseMultipart refuses what it does not expect', () => {
  const one = body([field('text', 'hi')]);
  fails(Buffer.concat([Buffer.from('preamble words'), Buffer.from(CRLF), one]), /does not begin/);
  fails(Buffer.alloc(0), /does not begin/);
  fails(Buffer.from('{"text":"hi"}'), /does not begin/);
  fails(body([field('text', 'hi')], { close: '' }), /no end/);
  fails(Buffer.from(`--${B}${CRLF}Content-Disposition: form-data; name="text"${CRLF}`), /no end to its headers/);
  fails(Buffer.from(`--${B}X${CRLF}Content-Disposition: form-data; name="text"${CRLF}${CRLF}hi${CRLF}--${B}--`), /boundary line/);
  // Half a line break after a boundary, either half, and one dash where two end the body.
  fails(Buffer.from(`--${B}\rContent-Disposition: form-data; name="text"${CRLF}${CRLF}hi${CRLF}--${B}--`), /boundary line/);
  fails(Buffer.from(`--${B}X\nContent-Disposition: form-data; name="text"${CRLF}${CRLF}hi${CRLF}--${B}--`), /boundary line/);
  fails(body([field('text', 'hi')], { close: `--${B}-x${CRLF}` }), /boundary line/);
  // A boundary inside the data that is followed by something else ends the part badly.
  fails(body([field('text', `a${CRLF}--${B}tail`)]), /boundary line/);
  fails(body([[['Content-Disposition: form-data; name="a"', 'Content-Disposition: form-data; name="b"'], 'x']]), /twice/);
  fails(body([[['Content-Disposition: form-data; name="a"', 'Content-Type: text/plain', 'Content-Type: image/png'], 'x']]), /type twice/);
  fails(body([[['Content-Type: text/plain'], 'x']]), /no name/);
  fails(body([[['Content-Disposition: attachment; filename="x"'], 'x']]), /not form-data/);
  fails(body([[['no colon here'], 'x']]), /header that is not one/);
  fails(body([[['Content-Disposition: form-data; name="a"', ': a value with no name'], 'x']]), /header that is not one/);
  // A type that says nothing is no type.
  assert.equal(parseMultipart(body([[['Content-Disposition: form-data; name="a"', 'Content-Type:'], 'x']]), B)[0].type, null);
  fails(body([[['Content-Disposition: form-data; name="a"', 'Content-Transfer-Encoding: base64'], 'aGk=']]), /encoded/);
  assert.equal(parseMultipart(body([[['Content-Disposition: form-data; name="a"', 'Content-Transfer-Encoding: binary', 'X-Other: kept out of it'], 'x']]), B)[0].name, 'a');
  // Too many parts, and headers too long.
  const many = n => body(Array.from({ length: n }, (_, i) => field('text', String(i))));
  assert.equal(parseMultipart(many(16), B).length, 16);
  fails(many(17), /more than 16/);
  assert.equal(parseMultipart(many(3), B, { maxParts: 3 }).length, 3);
  fails(many(3), /more than 2/, { maxParts: 2 });
  // A part's headers: 4096 bytes to the byte.
  const long = n => body([[[`Content-Disposition: form-data; name="a"; filename="${'x'.repeat(n)}"`], 'x']]);
  const around = 'Content-Disposition: form-data; name="a"; filename=""'.length;
  assert.equal(parseMultipart(long(4096 - around), B)[0].filename.length, 4096 - around);
  fails(long(4096 - around + 1), /too many/);
  assert.equal(parseMultipart(long(100 - around), B, { maxHeaderBytes: 100 }).length, 1);
  fails(long(100 - around + 1), /too many/, { maxHeaderBytes: 100 });
  // Not a body, or not a boundary: said before anything is looked for.
  const notOne = (buf, boundary) => assert.throws(() => parseMultipart(buf, boundary), err => err instanceof MultipartError && err.message === 'not a multipart body');
  notOne('text', B);
  notOne(one.toString('latin1'), B);
  notOne(one, 'a b');
  notOne(one, '');
  notOne(one, [B]);
});
