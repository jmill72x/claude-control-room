// Read aloud in the Mac's own voice (GET /api/chat/speech/<message id>). A web page on
// iPhone, iPad or Safari is offered only the voices that ship with the system, never a
// downloaded Enhanced or Premium one, so the words are spoken here, by macOS's `say`,
// into an audio file the page plays. Nothing leaves this machine but the audio, to a
// paired device: no cloud voice and no network speech service.
//
// This starts a process on text the lead wrote (which may quote anything), so it is
// kept narrow:
// - the request names a message by its id, or the fixed sample; it never carries text,
//   a voice, a format or a path. Only one of the lead's own chat messages is read;
// - the words are the message without its Markdown, by the page's own function
//   (web/src/lib/orbit/speech.js, speechText: one source for what is spoken), then
//   made plain here (speakable): no control or invisible characters, and no square or
//   angle brackets in any spelling, because `say` obeys commands written in its input,
//   both [[slnc 5000]] and <break time="5s"/> (measured 2026-11-17);
// - `say` by its absolute path, arguments as a list (no shell), an empty environment,
//   a time limit after which it is killed. The words go in through a file (`-f`),
//   never the argument list. The voice is one that `say -v ?` itself listed, named by
//   config (never the request) and given as one `--voice=` argument;
// - one render at a time, a few waiting, the rest refused; each device may start only
//   so many renders in a window, and all of them together only so many in a day. A
//   message already rendered costs none of these, and one that just failed is not
//   tried again for a while;
// - the audio is kept in a 0700 folder under the state folder, named by a hash of the
//   voice and the words (so an edited message is a new file), capped by age, count and
//   bytes. The work happens in a new 0700 folder inside it, removed afterwards.
// A voice that is not installed is never passed on: `say` would not fail, it would
// quietly read in the system voice. So the list is read first, and the answer says
// which voice is in use (info()). The list is all there is to go by: `say` gives no
// sign of the voice it used, and a listed voice that can't write a file (the Eloquence
// ones: Eddy, Flo and the like, checked 2026-11-17) is quietly replaced by its
// language's default. The stand-ins here are voices that do write files.
//
// THE TWO PAGE FILES THIS LOADS ARE SERVER CODE. web/src/lib/orbit/speech.js and the
// markdown.js it imports run inside the server once read aloud is on: a change to
// either needs the same review as a change under server/, and a restart to take
// effect here (loop 3's restart card counts them: SERVER_PATHS in heal-programs.mjs). They must stay free of imports other than each other
// (test/chat-speech.test.mjs holds the import graph to exactly those two files).
// server.mjs loads this module only when config has `chat.speech`, with `await
// import()` in a try/catch, so a broken page file can turn read aloud off but never
// stop the server; what the server needs at every start is in chat-speech-config.mjs.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, chmod, mkdtemp, writeFile, readFile, lstat, rename, rm, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { json, HttpError } from '../routes.mjs';
import { isMessageId } from './chat-store.mjs';
import { oneLine } from './chat-events.mjs';
import { SAY, DEFAULT_VOICE, CACHE_FILE, WORK_DIR, isVoiceName } from './chat-speech-config.mjs';
import { speechText, SAMPLE_WORDS } from '../../web/src/lib/orbit/speech.js';

export { SAY, DEFAULT_VOICE, isVoiceName, readSpeechConfig, clearSpeechCache } from './chat-speech-config.mjs';
// Tried in this order when the wanted voice is not installed; both ship with macOS.
export const BUILT_IN_VOICES = Object.freeze(['Samantha', 'Daniel']);
// The words of one message, after its Markdown is gone. About eleven minutes of speech.
export const SPEECH_TEXT_MAX = 12000;
export const RENDER_TIMEOUT_MS = 45e3;
export const LIST_TIMEOUT_MS = 10e3;
export const VOICES_TTL_MS = 10 * 60e3;
export const RENDERS_WAITING_MAX = 3;
export const RENDERS_PER_WINDOW = 12;
export const RENDER_WINDOW_MS = 5 * 60e3;
// Every device together, per local day: about ten times a heavy day's listening.
export const RENDERS_PER_DAY = 300;
// A render that failed is not tried again this long: the same answer, no process.
export const FAILED_TTL_MS = 10 * 60e3;
export const FAILED_MAX = 100;
// The log's "failed" line is written at most once in this long.
export const FAIL_LOG_MS = 60e3;
// While read aloud is on the cache is swept this often, played or not.
export const SWEEP_EVERY_MS = 3600e3;
// This many failed reads of the voice list in a row, and the voice is no longer known.
export const LIST_FAILS_MAX = 2;
export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
export const CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const CACHE_MAX_FILES = 400;
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600e3;
export const WORK_MAX_AGE_MS = 10 * 60e3;
export const AUDIO_TYPE = 'audio/mp4';
// Part of every cache name: raise it when the format or the text rules change.
export const CACHE_VERSION = 1;
// Why a render failed, as one fixed word a caller may log: an error's `reason`.
export const REASONS = Object.freeze(['timeout', 'failed', 'too large']);
const REASON_WORDS = Object.freeze({ timeout: 'the voice took too long', failed: 'the voice could not read this', 'too large': 'the audio is too large' });

// What `say -v ?` printed, as [{ name, lang }], each name once: each line is the name,
// the language and, after a #, a sample sentence. A long name is followed by a single
// space, so the language is read as the last word before the #. (A voice installed in
// two sizes is listed twice under one name, such as "Samantha (English (US))".)
export function parseVoices(out) {
  const voices = [];
  const seen = new Set();
  for (const line of String(out ?? '').split('\n')) {
    const hash = line.indexOf('#');
    const left = (hash < 0 ? line : line.slice(0, hash)).trimEnd();
    const m = /^(.*\S)\s+([A-Za-z]{2,3}[_-][A-Za-z0-9_-]{2,12})$/.exec(left);
    if (!m) continue;
    const name = m[1].trim();
    if (!isVoiceName(name) || seen.has(name)) continue;
    seen.add(name);
    voices.push({ name, lang: m[2] });
  }
  return voices;
}

// A voice's name without what the list puts in brackets after it: "Evan (Enhanced)"
// and "Samantha (English (US))" are Evan and Samantha.
export const voiceBase = name => (typeof name === 'string' ? name.split(' (')[0].trim() : '');

// The voice to read in: `wanted` when a voice of exactly that name is installed (case
// aside), else a stand-in: the first installed one of `fallbacks`, then of the built-in
// ones, each found by its name or as the name before the list's brackets (the list calls
// Samantha "Samantha (English (US))" once she is installed in two sizes; a stand-in
// given with brackets of its own can only match whole, since no plain name has any).
// The wanted voice's own plain name is tried before the built-in ones, so a plain Evan
// stands in for a missing "Evan (Enhanced)". Always a name the list itself printed, or
// null when none of them is there.
export function resolveVoice(voices, wanted, fallbacks = []) {
  const names = (Array.isArray(voices) ? voices : []).map(v => v?.name).filter(n => typeof n === 'string');
  const same = want => names.find(n => n === want) ?? names.find(n => n.toLowerCase() === want.toLowerCase()) ?? null;
  const exact = typeof wanted === 'string' ? same(wanted) : null;
  if (exact !== null) return { voice: exact, wanted, exact: true };
  const standIn = want => {
    if (typeof want !== 'string' || want === '') return null;
    return same(want) ?? names.find(n => voiceBase(n).toLowerCase() === want.toLowerCase()) ?? null;
  };
  for (const f of [...fallbacks, voiceBase(wanted), ...BUILT_IN_VOICES]) { const hit = standIn(f); if (hit !== null) return { voice: hit, wanted, exact: false }; }
  return null;
}

// Control, format (invisible, direction), separator, surrogate, private-use and
// unassigned characters: none of them is a word to say.
const UNSPEAKABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]/gu;
// The words as `say` gets them. Square and angle brackets go: `say` reads [[...]] as a
// command (a silence of any length, a rate, a phoneme mode) and obeys tags such as
// <break time="60s"/> too, and nobody misses a bracket read aloud. The text is taken
// apart first (NFKD), so a bracket in another spelling is the plain one by the time it
// is looked for: the fullwidth, small and vertical forms, and the two signs that are a
// bracket with a stroke through it (U+226E, U+226F, which the composed form NFKC would
// have made out of a plain bracket and U+0338, and let through). Put together again
// afterwards (NFC), so accented letters reach the voice whole. Then the characters
// above, and runs of spaces.
export function speakable(words) {
  if (typeof words !== 'string') return '';
  return words.toWellFormed().normalize('NFKD').replace(/[[\]<>]/g, ' ').normalize('NFC').replace(UNSPEAKABLE, ' ').replace(/\s+/g, ' ').trim();
}

// A Range header against a body of `size` bytes: null (send it whole: no header, not
// bytes, or several ranges), { start, end } inclusive, or 'unsatisfiable'. Safari
// asks for `bytes=0-1` first and plays only what answers 206.
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    return n === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return end < start ? null : { start, end };
}

const runFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});
// The message never holds a path, the words or the tool's output.
const fail = reason => Object.assign(new Error(REASON_WORDS[reason]), { reason });
const AUDIO_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin', 'Accept-Ranges': 'bytes'
};
// The local day `at` falls in, as one number (20261117).
const dayOf = at => { const d = new Date(at); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const nextMidnight = at => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
const ROUTE = /^\/api\/chat\/speech\/(sample|m_[a-z0-9]{6,24})$/;
// Something a voice can say: a letter, a digit or a pictograph (an emoji is read by its
// name). Punctuation alone is nothing to read.
const HAS_WORDS = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

// `store` is the chat store (get(id)); `dir` the cache folder; `voice` and `fallback`
// are config's; `killed()` true turns it off without a restart (the `speech-off` file).
// `run` and `say` are replaced in tests.
export function createSpeech({
  store, dir, voice: wanted = DEFAULT_VOICE, fallback = null, killed = () => false, now = () => Date.now(), log: logLine = console.log,
  say = SAY, run = runFile, timeoutMs = RENDER_TIMEOUT_MS, textMax = SPEECH_TEXT_MAX, waitingMax = RENDERS_WAITING_MAX,
  perWindow = RENDERS_PER_WINDOW, windowMs = RENDER_WINDOW_MS, perDay = RENDERS_PER_DAY, failedTtlMs = FAILED_TTL_MS, failedMax = FAILED_MAX, failLogMs = FAIL_LOG_MS,
  audioMaxBytes = AUDIO_MAX_BYTES, cacheMaxBytes = CACHE_MAX_BYTES, cacheMaxFiles = CACHE_MAX_FILES, cacheMaxAgeMs = CACHE_MAX_AGE_MS, sweepEveryMs = SWEEP_EVERY_MS
}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createSpeech needs dir');
  const log = line => logLine(oneLine(line));
  const fallbacks = fallback ? [fallback] : [];
  let resolved = null;     // { voice, wanted, exact } or null
  let said;                // the voice last logged (null for none), so each change is logged once
  let listedAt = null;     // when the voice list was last read
  let listing = null;      // a read of the list under way
  let listFails = 0;       // failed reads of the list in a row
  let ready = false;       // the cache folder is ours and private
  let sweeper = null;      // the hourly sweep's timer
  const inflight = new Map(); // cache name -> the render under way
  const starts = new Map();   // device id -> when its renders started, within the window
  const failures = new Map(); // cache name -> { reason, at }: renders that just failed, oldest first
  const day = { of: null, count: 0, said: false }; // render starts in the local day, every device's
  const failLog = { at: -Infinity, unsaid: 0 };    // when the last "failed" line was written, and failures unsaid since
  let running = false;
  const waiting = [];

  // The voice list, read again: a voice downloaded later is found without a restart.
  // One failed read keeps what was known; LIST_FAILS_MAX in a row and the voice is
  // no longer known (it may have been removed since), so read aloud is off until a
  // read works again.
  function refresh() {
    if (listing) return listing;
    listing = (async () => {
      try {
        const out = await run(say, ['-v', '?'], { env: {}, timeout: LIST_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 512 * 1024 });
        const next = resolveVoice(parseVoices(out), wanted, fallbacks);
        // Said once per change, the first answer included (even "none").
        if ((next?.voice ?? null) !== said) {
          said = next?.voice ?? null;
          log(next === null ? `speech: none of ${[...new Set([wanted, ...fallbacks, voiceBase(wanted), ...BUILT_IN_VOICES])].join(', ')} is installed; read aloud on the Mac is off`
            : next.exact ? `speech: reading in ${next.voice}`
            : `speech: ${wanted} is not installed on this Mac, so reading in ${next.voice}`);
        }
        resolved = next;
        listFails = 0;
      } catch (err) {
        listFails++;
        log(`speech: the voice list could not be read (${err?.killed === true ? 'timeout' : err?.code ?? 'error'})`);
        if (listFails === LIST_FAILS_MAX && resolved !== null) {
          resolved = null;
          said = undefined;
          log(`speech: ${LIST_FAILS_MAX} reads of the voice list failed in a row, so the voice is unknown; read aloud on the Mac is off until one works`);
        }
      }
      listedAt = now();
      listing = null;
      return resolved;
    })();
    return listing;
  }
  const stale = () => listedAt === null || now() - listedAt > VOICES_TTL_MS;
  const currentVoice = async () => (stale() ? refresh() : resolved);

  // The cache folder: made 0700, and used only when it is a real folder (no link)
  // with no group or world bits. Answers whether it had to be made.
  async function ensureFolder() {
    const made = await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory()) throw new Error('the speech cache is not a folder');
    await chmod(dir, 0o700);
    return made !== undefined;
  }
  // At start. Leftovers go: files past their age, then the oldest until count and
  // bytes fit, and work folders a crash left behind.
  async function prepare() {
    await ensureFolder();
    ready = true;
    await sweep();
  }
  async function sweep() {
    let names;
    try { names = await readdir(dir); } catch { return 0; }
    const at = now();
    const files = [];
    let gone = 0;
    for (const name of names) {
      const path = join(dir, name);
      let info;
      try { info = await lstat(path); } catch { continue; }
      if (WORK_DIR.test(name) && info.isDirectory()) {
        if (at - info.mtimeMs > WORK_MAX_AGE_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (!CACHE_FILE.test(name) || !info.isFile()) continue;
      if (at - info.mtimeMs > cacheMaxAgeMs) { await rm(path, { force: true }).catch(() => {}); gone++; continue; }
      files.push({ path, bytes: info.size, at: info.mtimeMs });
    }
    files.sort((a, b) => a.at - b.at);
    let bytes = files.reduce((sum, f) => sum + f.bytes, 0);
    while (files.length > 0 && (files.length > cacheMaxFiles || bytes > cacheMaxBytes)) {
      const oldest = files.shift();
      bytes -= oldest.bytes;
      await rm(oldest.path, { force: true }).catch(() => {});
      gone++;
    }
    return gone;
  }

  const nameFor = (voice, words) => `${createHash('sha256').update(`${CACHE_VERSION}\0${voice}\0${words}`).digest('hex')}.m4a`;
  // The audio already made under this name, or null. A read marks it used (its age
  // is counted from the last time it was played).
  async function cached(name) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) return null;
      const data = await readFile(path);
      const at = new Date(now());
      utimes(path, at, at).catch(() => {});
      return data;
    } catch { return null; }
  }

  // One render: the words into a file, `say` into another, the result checked (an
  // MPEG-4 file, not empty, not huge) and moved into the cache under its name. Where
  // `say` fails or leaves no file, the work folder is looked at before `say` is
  // blamed: if it is gone (the cache folder was removed under the render), that is
  // the server's trouble, and the error says ENOENT like any other missing path here.
  async function workOnce(name, voice, words) {
    const folder = await mkdtemp(join(dir, 'work-'));
    try {
      const src = join(folder, 'in.txt');
      const out = join(folder, 'out.m4a');
      await writeFile(src, words, { mode: 0o600 });
      try {
        await run(say, [`--voice=${voice}`, '-o', out, '--file-format=m4af', '--data-format=aac', '-f', src], { cwd: folder, env: {}, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
      } catch (err) {
        if (err?.killed === true) throw fail('timeout');
        await lstat(folder);
        throw fail('failed');
      }
      let info;
      try { info = await lstat(out); } catch { await lstat(folder); throw fail('failed'); }
      if (!info.isFile() || info.size === 0) throw fail('failed');
      if (info.size > audioMaxBytes) throw fail('too large');
      const data = await readFile(out);
      if (data.length < 12 || data.toString('latin1', 4, 8) !== 'ftyp') throw fail('failed');
      await chmod(out, 0o600);
      await rename(out, join(dir, name));
      return data;
    } finally {
      await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
  // The render. The cache folder can go while the server runs (removed by hand, or by
  // another server's start with read aloud off), so before every render it is checked
  // as at start, and made again when missing; a file or a link in its place fails the
  // render as the server's own trouble, with no process started. And once more when a
  // path went missing under the render itself: checked again, and tried a second time.
  async function folderReady() {
    if (await ensureFolder()) log('speech: the cache folder was gone; made it again');
  }
  async function work(name, voice, words) {
    await folderReady();
    try { return await workOnce(name, voice, words); } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      await folderReady();
      return workOnce(name, voice, words);
    }
  }

  // A turn at the one voice: the rest wait in the order they came.
  const turn = () => new Promise(resolve => { if (!running) { running = true; resolve(); } else waiting.push(resolve); });
  const done = () => { const next = waiting.shift(); if (next) next(); else running = false; };

  // Whether `deviceId` may start another render now; null, or the seconds to wait.
  function limited(deviceId, at) {
    const mine = (starts.get(deviceId) ?? []).filter(t => at - t < windowMs);
    if (mine.length === 0) starts.delete(deviceId); else starts.set(deviceId, mine);
    return mine.length >= perWindow ? Math.max(1, Math.ceil((mine[0] + windowMs - at) / 1000)) : null;
  }

  // A render of this name that failed within failedTtlMs, or null. `say` took its time
  // (up to the whole limit) to fail on these words; asking again at once would only
  // spend that again. At most failedMax are remembered, the oldest dropped first.
  function failedLately(name, at) {
    const f = failures.get(name);
    if (!f) return null;
    if (at - f.at < failedTtlMs) return f;
    failures.delete(name);
    return null;
  }
  // A name is never here already when it is noted: a render ran, so it was not remembered.
  function noteFailure(name, reason, at) {
    failures.set(name, { reason, at });
    while (failures.size > failedMax) failures.delete(failures.keys().next().value);
  }

  // Whether one more render may start in the local day `at` falls in; null, or the
  // seconds to its end. Said in the log once a day, when the limit is first met.
  function dayFull(at) {
    const today = dayOf(at);
    if (day.of !== today) { day.of = today; day.count = 0; day.said = false; }
    if (day.count < perDay) return null;
    if (!day.said) { day.said = true; log(`speech: ${perDay} renders today, the day's limit; pages read in their own voice until midnight`); }
    return Math.max(1, Math.ceil((nextMidnight(at) - at) / 1000));
  }

  // A render start taken back: off the device's window (if it is still in it) and off
  // the day's count. A start taken back after midnight comes off the new day's count,
  // which is one render's worth of slack on a limit of hundreds. It stops at zero: two
  // starts either side of midnight, both taken back, would else leave the new day's
  // count at one under, and the day one render over its limit.
  function uncharge(deviceId, at) {
    const mine = starts.get(deviceId) ?? [];
    const i = mine.indexOf(at);
    if (i !== -1) mine.splice(i, 1);
    day.count = Math.max(0, day.count - 1);
  }

  // The "failed" line, at most one in failLogMs: a failure of the server's own is not
  // remembered, so a page that keeps asking would write one a request. The next line
  // says how many went unsaid. (A clock set back says the line again, never holds it.)
  function logFailed(line, at) {
    const since = at - failLog.at;
    if (since >= 0 && since < failLogMs) { failLog.unsaid++; return; }
    log(failLog.unsaid ? `${line}; ${failLog.unsaid} more failed since the last such line` : line);
    failLog.at = at;
    failLog.unsaid = 0;
  }

  // The audio for `words` in `voice`: from a render already under way for the same
  // words, from the cache, or from a new render, which is the only one of the three
  // that counts against the device, the queue and the day. The render under way is
  // looked for first and again after the cache: the cache is read with an await, and a
  // render that began or ended meanwhile must not be started a second time.
  async function audioFor(device, voice, words) {
    const name = nameFor(voice, words);
    const under = inflight.get(name);
    if (under) return under;
    const had = await cached(name);
    if (had) return had;
    const joined = inflight.get(name);
    if (joined) return joined;
    const at = now();
    const failed = failedLately(name, at);
    if (failed) throw fail(failed.reason);
    const wait = limited(device.id, at);
    if (wait !== null) throw Object.assign(new HttpError(429, 'too many messages read aloud at once; this device\'s own voice reads meanwhile'), { retryAfter: wait });
    if (running && waiting.length >= waitingMax) throw Object.assign(new HttpError(503, 'the voice is busy; this device\'s own voice reads meanwhile'), { retryAfter: 5 });
    const tomorrow = dayFull(at);
    if (tomorrow !== null) throw Object.assign(new HttpError(429, 'the Mac has read its fill for today; this device\'s own voice reads until tomorrow'), { retryAfter: tomorrow });
    day.count++;
    starts.set(device.id, [...(starts.get(device.id) ?? []), at]);
    const job = (async () => {
      await turn();
      const began = now();
      try {
        const data = await work(name, voice, words);
        log(`speech: read ${words.length} characters in ${voice} for ${device.name} (${now() - began} ms, ${data.length} bytes)`);
        return data;
      } catch (err) {
        const known = REASONS.includes(err?.reason);
        // What `say` could not do is remembered, and stays counted. A failure of the
        // server's own (the cache folder gone for good) is neither: the message may be
        // fine, and the device did nothing to spend a turn on.
        if (known) noteFailure(name, err.reason, now());
        else uncharge(device.id, at);
        logFailed(`speech: a render of ${words.length} characters for ${device.name} failed (${known ? err.reason : err?.code ?? 'error'})`, now());
        throw err;
      } finally {
        done();
        inflight.delete(name);
        sweep().catch(() => {});
      }
    })();
    inflight.set(name, job);
    return job;
  }

  function send(req, res, data) {
    const range = parseRange(req.headers?.range, data.length);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...AUDIO_HEADERS, 'Content-Range': `bytes */${data.length}`, 'Content-Length': 0 });
      return res.end();
    }
    if (range === null) {
      res.writeHead(200, { ...AUDIO_HEADERS, 'Content-Type': AUDIO_TYPE, 'Content-Length': data.length });
      return res.end(data);
    }
    const part = data.subarray(range.start, range.end + 1);
    res.writeHead(206, { ...AUDIO_HEADERS, 'Content-Type': AUDIO_TYPE, 'Content-Length': part.length, 'Content-Range': `bytes ${range.start}-${range.end}/${data.length}` });
    return res.end(part);
  }

  const owns = path => path === '/api/chat/speech' || path.startsWith('/api/chat/speech/');

  // GET /api/chat/speech/<message id> or /api/chat/speech/sample: the audio, to a
  // paired device asking from the page itself. `ctx.requireDevice` is the chat's.
  async function handle(req, res, path, { requireDevice }) {
    const device = requireDevice(req);
    const m = ROUTE.exec(path);
    if (!m) throw new HttpError(404, 'not found');
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET', 'Content-Length': 0 }); return res.end(); }
    // A browser says where a request came from: another site's page (its <audio>, a
    // link) is refused. A client that sends no such header (curl) has the cookie.
    const site = req.headers?.['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'read aloud is asked for by the chat page itself');
    if (!ready || killed()) throw new HttpError(503, 'read aloud on the Mac is off');
    const which = await currentVoice();
    if (which === null) throw new HttpError(503, 'no voice to read in can be found on the Mac');
    let words;
    if (m[1] === 'sample') words = speakable(SAMPLE_WORDS);
    else {
      const message = isMessageId(m[1]) ? store.get(m[1]) : null;
      if (!message) throw new HttpError(404, 'no such message');
      if (message.from !== 'jarvis' || message.kind !== 'chat') throw new HttpError(403, 'only the lead\'s own messages are read aloud');
      words = speakable(speechText(message.text));
    }
    if (!HAS_WORDS.test(words)) throw new HttpError(422, 'there is nothing to read aloud in this message');
    if (words.length > textMax) throw new HttpError(413, 'this message is too long for the Mac\'s voice; this device\'s own voice reads it');
    let data;
    try { data = await audioFor(device, which.voice, words); } catch (err) {
      if (err instanceof HttpError && err.retryAfter) return json(res, err.status, { error: err.message }, { 'Retry-After': String(err.retryAfter) });
      if (err instanceof HttpError) throw err;
      // The render's own log line has the reason; the answer is the page's cue to read in its own voice.
      throw new HttpError(err?.reason === 'timeout' ? 504 : err?.reason === 'too large' ? 413 : 502, REASONS.includes(err?.reason) ? err.message : REASON_WORDS.failed);
    }
    // Asked again: a render can take most of a minute behind others, and a device
    // revoked meanwhile gets nothing.
    requireDevice(req);
    return send(req, res, data);
  }

  // What the page is told (the chat status): the voice in use, the one config wants,
  // and whether they are the same; null while read aloud on the Mac is off.
  function info() {
    if (!ready || killed()) return null;
    if (stale()) refresh().catch(() => {});
    return resolved === null ? null : { voice: resolved.voice, wanted: resolved.wanted, exact: resolved.exact };
  }

  // Makes the cache folder, then reads the voice list without holding the caller up
  // (the server's start never waits on `say`); info() is null until the list is in.
  // From then on the cache is swept every sweepEveryMs, so audio ages out on a quiet
  // day too; the timer never keeps the process alive.
  async function start() {
    await prepare();
    refresh().catch(() => {});
    if (sweeper === null) {
      sweeper = setInterval(() => { sweep().catch(() => {}); }, sweepEveryMs);
      sweeper.unref?.();
    }
  }
  // Ends the sweep's timer (tests).
  function stop() {
    if (sweeper !== null) { clearInterval(sweeper); sweeper = null; }
  }

  return { owns, handle, info, start, stop, refresh, sweep, waiting: () => waiting.length };
}
