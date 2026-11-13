// HEIC to JPEG, for a photo shared through a Shortcut (lib/shortcut-routes.mjs). An
// iPhone's camera writes HEIC unless it is set to "Most Compatible", and the lead can't
// open one: the model reads JPEG, PNG and WebP. So the server converts it once, here,
// with macOS's own `sips`, and the message carries a JPEG.
//
// This runs an image decoder on bytes from outside, so it is kept narrow:
// - `sips` by its absolute path, with arguments as a list (no shell), an empty
//   environment, and a time limit after which it is killed;
// - at most RUNS_AT_ONCE conversions run at a time, whoever asks: the rest wait their
//   turn;
// - the photo's size is read first (`sips -g`, which parses the file's container but
//   decodes no pixels), and one over PIXELS_MAX is refused before its pixels are decoded;
// - the work happens in a new 0700 folder under the temp folder, removed afterwards
//   whatever happened;
// - the result must begin like a JPEG and fit `maxBytes`. A photo that is too large as
//   a JPEG is made again with its long side at FIT_PX, and refused if that is still
//   too large.
// The caller has already checked that the bytes begin like a HEIC file, and counts how
// many conversions each key asks for.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SIPS = '/usr/bin/sips';
export const CONVERT_TIMEOUT_MS = 20e3;
// An iPhone's largest photo is 48 megapixels; this leaves room and stops a small file
// that claims to be enormous.
export const PIXELS_MAX = 120e6;
export const FIT_PX = 4096;
export const JPEG_QUALITY = 85;
export const RUNS_AT_ONCE = 2;
// Why a conversion failed, as one fixed word a caller may log: an error's `reason`.
export const REASONS = Object.freeze(['timeout', 'unreadable', 'too large', 'failed']);

const runFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});
// The message never holds a path or the tool's output; `reason` is one of REASONS.
const fail = (reason, message) => Object.assign(new Error(message), { reason });
// execFile marks the error of a child it killed at the time limit.
const timedOut = err => err?.killed === true;
const TOO_SLOW = 'the photo took too long to convert';

// What `sips -g pixelWidth -g pixelHeight` printed, as numbers, or null.
export function readPixels(out) {
  const w = /^\s*pixelWidth:\s*(\d{1,7})\s*$/m.exec(String(out ?? ''));
  const h = /^\s*pixelHeight:\s*(\d{1,7})\s*$/m.exec(String(out ?? ''));
  if (!w || !h) return null;
  const width = Number(w[1]), height = Number(h[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

// `convert(data)` answers the JPEG's bytes or throws an error with a `reason`.
export function createHeicConverter({ sips = SIPS, dir = tmpdir(), timeoutMs = CONVERT_TIMEOUT_MS, maxBytes, atOnce = RUNS_AT_ONCE, run = runFile } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('createHeicConverter needs maxBytes');
  const options = work => ({ cwd: work, env: {}, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  // A turn: `atOnce` hold one at a time, and the rest wait in the order they came. A
  // turn that ends hands itself to the first one waiting.
  let running = 0;
  const waiting = [];
  const turn = () => new Promise(resolve => { if (running < atOnce) { running++; resolve(); } else waiting.push(resolve); });
  const done = () => { const next = waiting.shift(); if (next) next(); else running--; };

  async function work(data) {
    const folder = await mkdtemp(join(dir, 'jos-heic-'));
    try {
      const src = join(folder, 'in.heic');
      await writeFile(src, data, { mode: 0o600 });
      let size;
      try { size = readPixels(await run(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', src], options(folder))); } catch (err) {
        if (timedOut(err)) throw fail('timeout', TOO_SLOW);
        size = null;
      }
      if (!size) throw fail('unreadable', 'the photo could not be read');
      if (size.width * size.height > PIXELS_MAX) throw fail('too large', 'the photo is too large to convert');
      // As it is first; when that is too many bytes, with the long side at FIT_PX
      // (`-Z` also enlarges, so only a photo that is larger gets the second try).
      for (const fit of Math.max(size.width, size.height) > FIT_PX ? [null, FIT_PX] : [null]) {
        const out = join(folder, fit ? 'fit.jpg' : 'out.jpg');
        try {
          await run(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), ...(fit ? ['-Z', String(fit)] : []), src, '--out', out], options(folder));
        } catch (err) { throw timedOut(err) ? fail('timeout', TOO_SLOW) : fail('failed', 'the photo could not be converted'); }
        let info;
        try { info = await lstat(out); } catch { throw fail('failed', 'the photo could not be converted'); }
        if (!info.isFile()) throw fail('failed', 'the photo could not be converted');
        if (info.size > maxBytes) continue;
        const jpeg = await readFile(out);
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw fail('failed', 'the photo could not be converted');
        return jpeg;
      }
      throw fail('too large', 'the photo is too large as a JPEG');
    } finally {
      await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }

  return async function convert(data) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw fail('unreadable', 'no photo to convert');
    await turn();
    try { return await work(data); } finally { done(); }
  };
}
