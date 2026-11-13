// A small, strict reader for `multipart/form-data` (RFC 7578), for the one route that
// takes a form: a Shortcut's send (lib/shortcut-routes.mjs). iOS Shortcuts' "Get
// Contents of URL" sends this when its Request Body is Form and a field holds a file.
//
// The body is held whole (the caller bounds it), and a part's bytes are a view into
// it, never a copy. Strict on purpose: anything this does not expect is an error, and
// the caller answers 400. No preamble but line breaks, at most `maxParts` parts, a
// part's headers at most `maxHeaderBytes`, and no transfer encoding but the plain ones.
// `filename*` is not read (RFC 7578 tells senders not to use it); a file name here is
// outside text, and the caller cleans it before it is kept.

export class MultipartError extends Error {}

// RFC 2046's boundary characters, less the space: 1 to 70 of them.
const BOUNDARY = /^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/;
const CR = 13, LF = 10, DASH = 45, SPACE = 32, TAB = 9;

// A Content-Type's own type, lower case, without its parameters.
export const mediaType = contentType => String(contentType ?? '').split(';')[0].trim().toLowerCase();

// The boundary a `multipart/form-data` Content-Type names, or null.
export function formBoundary(contentType) {
  const [, ...params] = String(contentType ?? '').split(';');
  if (mediaType(contentType) !== 'multipart/form-data') return null;
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = p.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return BOUNDARY.test(value) ? value : null;
  }
  return null;
}

// `form-data; name="…"; filename="…"`: the two names, or null when it is anything else.
export function readDisposition(value) {
  const v = String(value ?? '');
  const kind = /^[A-Za-z-]+/.exec(v)?.[0] ?? '';
  if (kind.toLowerCase() !== 'form-data') return null;
  let i = kind.length;
  const space = () => { while (v[i] === ' ' || v[i] === '\t') i++; };
  const seen = new Map();
  for (;;) {
    space();
    if (i >= v.length) break;
    if (v[i] !== ';') return null;
    i++;
    space();
    let key = '';
    while (i < v.length && /[A-Za-z*]/.test(v[i])) key += v[i++];
    if (key === '') return null;
    space();
    if (v[i] !== '=') return null;
    i++;
    space();
    let val = '';
    if (v[i] === '"') {
      i++;
      for (;;) {
        if (i >= v.length) return null; // no closing quote
        const c = v[i++];
        if (c === '"') break;
        // Only `\"` and `\\` are escapes: a lone backslash is itself.
        if (c === '\\' && (v[i] === '"' || v[i] === '\\')) val += v[i++];
        else val += c;
      }
    } else {
      while (i < v.length && v[i] !== ';' && v[i] !== ' ' && v[i] !== '\t' && v[i] !== '"') val += v[i++];
    }
    key = key.toLowerCase();
    if (seen.has(key)) return null;
    seen.set(key, val);
  }
  if (!seen.has('name')) return null;
  return { name: seen.get('name'), filename: seen.has('filename') ? seen.get('filename') : null };
}

function readHeaders(buf) {
  let name = null, filename = null, type = null;
  const text = buf.toString('utf8');
  for (const line of text === '' ? [] : text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new MultipartError('a part has a header that is not one');
    const header = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (header === 'content-disposition') {
      if (name !== null) throw new MultipartError('a part names itself twice');
      const d = readDisposition(value);
      if (!d) throw new MultipartError('a part is not form-data with a name');
      ({ name, filename } = d);
    } else if (header === 'content-type') {
      if (type !== null) throw new MultipartError('a part gives its type twice');
      type = mediaType(value);
    } else if (header === 'content-transfer-encoding') {
      if (!/^(?:binary|8bit|7bit)$/i.test(value)) throw new MultipartError('a part is encoded, which is not taken');
    }
  }
  if (name === null) throw new MultipartError('a part has no name');
  return { name, filename, type: type || null };
}

// The parts of a body, in order: `{ name, filename, type, data }`. `filename` and
// `type` are null when the part gave none. Throws MultipartError on anything else.
export function parseMultipart(body, boundary, { maxParts = 16, maxHeaderBytes = 4096 } = {}) {
  if (!Buffer.isBuffer(body) || typeof boundary !== 'string' || !BOUNDARY.test(boundary)) throw new MultipartError('not a multipart body');
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  const next = Buffer.from(`\r\n--${boundary}`, 'latin1');
  // The first boundary, after nothing but line breaks.
  let pos = 0;
  while (body[pos] === CR || body[pos] === LF) pos++;
  if (body.indexOf(delim, pos) !== pos) throw new MultipartError('the body does not begin with its boundary');
  pos += delim.length;
  const parts = [];
  for (;;) {
    // After a boundary: `--` ends the body (anything after it is ignored), or the
    // line ends and a part begins.
    if (body[pos] === DASH && body[pos + 1] === DASH) return parts;
    while (body[pos] === SPACE || body[pos] === TAB) pos++;
    if (body[pos] !== CR || body[pos + 1] !== LF) throw new MultipartError('a boundary line is not one');
    pos += 2;
    if (parts.length >= maxParts) throw new MultipartError(`more than ${maxParts} parts`);
    let headEnd, dataStart;
    if (body[pos] === CR && body[pos + 1] === LF) {
      headEnd = pos;
      dataStart = pos + 2;
    } else {
      headEnd = body.indexOf('\r\n\r\n', pos, 'latin1');
      if (headEnd < 0 || headEnd - pos > maxHeaderBytes) throw new MultipartError('a part has no end to its headers, or too many');
      dataStart = headEnd + 4;
    }
    // The blank line's own break may be the one before the next boundary (an empty
    // part): `end` is then before `dataStart`, and the view is empty.
    const end = body.indexOf(next, dataStart - 2);
    if (end < 0) throw new MultipartError('a part has no end');
    parts.push({ ...readHeaders(body.subarray(pos, headEnd)), data: body.subarray(dataStart, end) });
    pos = end + next.length;
  }
}
