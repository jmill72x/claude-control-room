// What the server needs of read aloud (lib/chat-speech.mjs) whether or not it is on:
// the config rule, and the clean-up of the audio cache when it is off. This file imports
// no page code and nothing of its own, so server.mjs loads it at every start; the
// module that renders (and with it the two page files it shares, see there) is loaded
// only when config turns read aloud on.
import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SAY = '/usr/bin/say';
export const DEFAULT_VOICE = 'Evan (Enhanced)';
// The cache's own two kinds of names: a rendered audio file, and a render's work folder.
export const CACHE_FILE = /^[a-f0-9]{64}\.m4a$/;
export const WORK_DIR = /^work-[A-Za-z0-9]{6}$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// A voice's name as config may give it: letters, digits, spaces and a little
// punctuation, starting with a letter or digit (so never an option).
const VOICE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ()._'-]{0,59}$/u;
export const isVoiceName = v => typeof v === 'string' && VOICE_NAME.test(v);

// What config says about read aloud, checked: on only with a `chat.speech` object.
// `voice` is the voice to read in (DEFAULT_VOICE when left out) and `fallback` one to
// use while that is not installed; a bad value keeps speech off and says why.
export function readSpeechConfig(config) {
  const speech = config?.chat?.speech;
  if (speech === undefined || speech === null || speech === false) return { on: false, voice: null, fallback: null, problems: [] };
  if (!isObject(speech)) return { on: false, voice: null, fallback: null, problems: ['chat.speech must be an object such as { "voice": "Evan (Enhanced)" }; read aloud on the Mac stays off'] };
  const problems = [];
  const read = (key, missing) => {
    if (speech[key] === undefined || speech[key] === null) return missing;
    const v = typeof speech[key] === 'string' ? speech[key].trim() : speech[key];
    if (isVoiceName(v)) return v;
    problems.push(`chat.speech.${key} must be a voice's name as \`say -v ?\` lists it; read aloud on the Mac stays off`);
    return null;
  };
  const voice = read('voice', DEFAULT_VOICE);
  const fallback = read('fallback', null);
  return { on: problems.length === 0, voice: problems.length === 0 ? voice : null, fallback: problems.length === 0 ? fallback : null, problems };
}

// Read aloud is off at this start: whatever audio an earlier run left in the cache
// folder goes, so turning the feature off (config key removed, then a restart) leaves
// none of the lead's replies behind as speech. Only the cache's own two kinds of names
// are removed, a link is never followed, and the folder itself goes when that left it
// empty. Answers { removed, left }: how many went, and how many other things stayed
// (null when there is no such folder, or it is not a real folder).
export async function clearSpeechCache(dir) {
  let info;
  try { info = await lstat(dir); } catch { return null; }
  if (!info.isDirectory()) return null;
  let names;
  try { names = await readdir(dir); } catch { return null; }
  let removed = 0, left = 0;
  for (const name of names) {
    const path = join(dir, name);
    let entry;
    try { entry = await lstat(path); } catch { continue; }
    if (CACHE_FILE.test(name) && entry.isFile()) { try { await rm(path, { force: true }); removed++; } catch { left++; } continue; }
    if (WORK_DIR.test(name) && entry.isDirectory()) { try { await rm(path, { recursive: true, force: true }); removed++; } catch { left++; } continue; }
    left++;
  }
  if (left === 0) await rmdir(dir).catch(() => {});
  return { removed, left };
}
