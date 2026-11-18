// Read aloud in the Mac's own voice (lib/chat-speech.mjs and its route in
// lib/chat-routes.mjs): the config rule, the voice list and the pick from it, the
// words `say` gets, the one process it starts and how, the cache, the limits, and who
// may ask. `say` itself is faked here except in the last test, which runs the real one
// where there is one. Every message and name is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, lstat, utimes, symlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  createSpeech, readSpeechConfig, clearSpeechCache, parseVoices, resolveVoice, voiceBase, speakable, parseRange, isVoiceName,
  SAY, DEFAULT_VOICE, BUILT_IN_VOICES, SPEECH_TEXT_MAX, RENDER_TIMEOUT_MS, VOICES_TTL_MS, RENDERS_WAITING_MAX,
  RENDERS_PER_WINDOW, RENDER_WINDOW_MS, RENDERS_PER_DAY, FAILED_TTL_MS, FAILED_MAX, FAIL_LOG_MS, SWEEP_EVERY_MS, LIST_FAILS_MAX, CACHE_VERSION,
  AUDIO_MAX_BYTES, CACHE_MAX_BYTES, CACHE_MAX_FILES, CACHE_MAX_AGE_MS, WORK_MAX_AGE_MS, AUDIO_TYPE
} from '../lib/chat-speech.mjs';
import * as speechConfig from '../lib/chat-speech-config.mjs';
import { speechText, SAMPLE_WORDS } from '../../web/src/lib/orbit/speech.js';
import { makeChatEnv } from './helpers/chat-env.mjs';
import { SERVER_PATHS } from '../lib/heal-programs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cp = (...codes) => String.fromCodePoint(...codes);
const pause = ms => new Promise(r => setTimeout(r, ms));
// Waits until `fn()` is true, for 5 s at most (a loaded machine is slow, never wrong).
const until = async fn => { for (let i = 0; i < 250; i++) { if (await fn()) return true; await pause(20); } return Boolean(await fn()); };
// The smallest thing the module takes for an MPEG-4 file: a size, then `ftyp`.
const fakeAudio = (label = 'x') => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypM4A '), Buffer.from(`audio:${label}:`), Buffer.alloc(40, 7)]);
const LIST = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Daniel              en_GB    # Hello! My name is Daniel.',
  'Eddy (English (US)) en_US    # Hello! My name is Eddy.',
  'Grandma (English (UK)) en_GB    # Hello! My name is Grandma.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Tingting            zh_CN    # Hello! My name is Tingting.',
  ''
].join('\n');
const LIST_WITH_EVAN = `Evan (Enhanced)     en_US    # Hello! My name is Evan.\n${LIST}`;

// A fake `say`: answers the voice list, and for a render reads the words file, notes
// what it was given and writes the audio. `gate` holds renders until released.
function fakeSay({ list = LIST, audio = words => fakeAudio(words.slice(0, 12)) } = {}) {
  const fake = {
    list, calls: [], lists: 0, active: 0, most: 0, gate: null, fail: null,
    release() { const g = fake.gate; fake.gate = null; g?.open(); },
    hold() { let open; const wait = new Promise(r => { open = r; }); fake.gate = { wait, open }; },
    async run(file, args, options) {
      if (args[0] === '-v' && args[1] === '?') { fake.lists++; if (fake.list instanceof Error) throw fake.list; return fake.list; }
      fake.active++;
      fake.most = Math.max(fake.most, fake.active);
      try {
        const src = args[args.indexOf('-f') + 1];
        const out = args[args.indexOf('-o') + 1];
        const words = await readFile(src, 'utf8');
        fake.calls.push({ file, args, options, words, srcMode: (await lstat(src)).mode & 0o777, folderMode: (await lstat(dirname(src))).mode & 0o777 });
        if (fake.gate) await fake.gate.wait;
        if (fake.fail) throw fake.fail;
        const data = audio(words);
        if (data !== null) await writeFile(out, data);
        return '';
      } finally { fake.active--; }
    }
  };
  return fake;
}

// The chat routes with speech on, over a fake `say`. `speechOpts` override createSpeech's.
async function makeEnv(t, { say = fakeSay(), speechOpts = {}, routes = {}, start = true, envOpts = {} } = {}) {
  const lines = [];
  const kill = { on: false };
  let env = null;
  const cache = await mkdtemp(join(tmpdir(), 'speech-cache-'));
  const dir = join(cache, 'speech-cache');
  const speech = createSpeech({
    store: { get: id => env.store.get(id) }, dir, voice: 'Evan (Enhanced)', killed: () => kill.on, now: () => env.clock.t,
    log: line => lines.push(line), run: (...a) => say.run(...a), ...speechOpts
  });
  env = await makeChatEnv({ routes: { speech, ...routes }, ...envOpts });
  t.after(async () => { speech.stop(); say.release(); await env.close(); await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  if (start) { await speech.start(); await speech.refresh(); }
  const dev = await env.pair('Test Phone');
  // The audio answers are bytes: fetch them whole.
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${env.port}${path}`, { headers: { cookie: dev.cookie, ...headers } }).then(async r => ({
    status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer())
  }));
  const jarvis = text => env.store.append({ from: 'jarvis', kind: 'chat', text });
  return { env, speech, say, lines, kill, dir, dev, get, jarvis };
}
const audioFiles = async dir => (await readdir(dir)).filter(n => /^[a-f0-9]{64}\.m4a$/.test(n));

test('the limits are what the docs say', () => {
  assert.equal(SAY, '/usr/bin/say');
  assert.equal(DEFAULT_VOICE, 'Evan (Enhanced)');
  assert.deepEqual([...BUILT_IN_VOICES], ['Samantha', 'Daniel']);
  assert.equal(SPEECH_TEXT_MAX, 12000);
  assert.equal(RENDER_TIMEOUT_MS, 45e3);
  assert.equal(VOICES_TTL_MS, 10 * 60e3);
  assert.equal(RENDERS_WAITING_MAX, 3);
  assert.equal(RENDERS_PER_WINDOW, 12);
  assert.equal(RENDER_WINDOW_MS, 5 * 60e3);
  assert.equal(RENDERS_PER_DAY, 300);
  assert.equal(FAILED_TTL_MS, 10 * 60e3);
  assert.equal(FAILED_MAX, 100);
  assert.equal(FAIL_LOG_MS, 60e3);
  assert.equal(SWEEP_EVERY_MS, 3600e3);
  assert.equal(LIST_FAILS_MAX, 2);
  assert.equal(AUDIO_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(CACHE_MAX_BYTES, 200 * 1024 * 1024);
  assert.equal(CACHE_MAX_FILES, 400);
  assert.equal(CACHE_MAX_AGE_MS, 7 * 24 * 3600e3);
  assert.equal(WORK_MAX_AGE_MS, 10 * 60e3);
  assert.equal(AUDIO_TYPE, 'audio/mp4');
});

test('config: off without a chat.speech object; a voice is a plain name, never an option', () => {
  for (const config of [undefined, null, {}, { chat: {} }, { chat: { speech: null } }, { chat: { speech: false } }]) {
    assert.deepEqual(readSpeechConfig(config), { on: false, voice: null, fallback: null, problems: [] });
  }
  assert.deepEqual(readSpeechConfig({ chat: { speech: {} } }), { on: true, voice: 'Evan (Enhanced)', fallback: null, problems: [] });
  assert.deepEqual(readSpeechConfig({ chat: { speech: { voice: ' Ava (Premium) ', fallback: 'Daniel' } } }), { on: true, voice: 'Ava (Premium)', fallback: 'Daniel', problems: [] });
  for (const speech of [true, 'Evan (Enhanced)', ['Evan'], 7]) {
    const r = readSpeechConfig({ chat: { speech } });
    assert.equal(r.on, false);
    assert.equal(r.voice, null);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /chat\.speech must be an object/);
  }
  for (const voice of ['-v Zarvox', '--voice=Zarvox', '', '   ', 'a/b', 'x;y', 'a\nb', '$(id)', '`id`', 'x'.repeat(61), 7, {}, ['Samantha'], '?']) {
    const r = readSpeechConfig({ chat: { speech: { voice } } });
    assert.equal(r.on, false, `voice ${JSON.stringify(voice)}`);
    assert.equal(r.voice, null);
    assert.match(r.problems[0], /chat\.speech\.voice must be a voice's name/);
    const f = readSpeechConfig({ chat: { speech: { fallback: voice } } });
    assert.equal(f.on, false, `fallback ${JSON.stringify(voice)}`);
    assert.equal(f.voice, null, 'a bad fallback leaves no voice either');
    assert.match(f.problems[0], /chat\.speech\.fallback must be a voice's name/);
  }
  assert.equal(isVoiceName('x'.repeat(60)), true);
  assert.equal(isVoiceName(`Am${cp(0xe9)}lie`), true);
  assert.equal(isVoiceName("O'Neil Jr."), true);
});

test('the voice list: a name, a language, then a # and a sample; a long name has one space after it', () => {
  assert.deepEqual(parseVoices(LIST), [
    { name: 'Albert', lang: 'en_US' }, { name: 'Daniel', lang: 'en_GB' }, { name: 'Eddy (English (US))', lang: 'en_US' },
    { name: 'Grandma (English (UK))', lang: 'en_GB' }, { name: 'Samantha', lang: 'en_US' }, { name: 'Tingting', lang: 'zh_CN' }
  ]);
  assert.deepEqual(parseVoices('Evan (Enhanced)     en_US    # Hello! My name is Evan.'), [{ name: 'Evan (Enhanced)', lang: 'en_US' }]);
  assert.deepEqual(parseVoices('Bad News            en_US    # Hello! My name is Bad News.\nMajed ar_001 # x\nLana sr_Latn_RS'), [
    { name: 'Bad News', lang: 'en_US' }, { name: 'Majed', lang: 'ar_001' }, { name: 'Lana', lang: 'sr_Latn_RS' }
  ]);
  // The sample sentence is never part of the name, even when it looks like a language.
  assert.deepEqual(parseVoices('Fred en_US # I say fr_FR and en_GB'), [{ name: 'Fred', lang: 'en_US' }]);
  for (const junk of [undefined, null, '', '\n\n', 'no language here', 'en_US', '   en_US # x', '-v Zarvox en_US # an option is no name', 'a;b en_US # x']) {
    assert.deepEqual(parseVoices(junk), [], JSON.stringify(junk));
  }
});

test('the voice in use: the wanted one when installed, else a stand-in in order; always a name from the list', () => {
  const voices = parseVoices(LIST);
  const evan = parseVoices(LIST_WITH_EVAN);
  assert.deepEqual(resolveVoice(evan, 'Evan (Enhanced)', ['Daniel']), { voice: 'Evan (Enhanced)', wanted: 'Evan (Enhanced)', exact: true });
  // Not installed: config's fallbacks first, then the built-in ones in their order.
  assert.deepEqual(resolveVoice(voices, 'Evan (Enhanced)'), { voice: 'Samantha', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(voices, 'Evan (Enhanced)', ['Daniel']), { voice: 'Daniel', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(voices, 'Evan (Enhanced)', ['Nobody', 'Albert']), { voice: 'Albert', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(voices, 'Evan (Enhanced)', ['Nobody']), { voice: 'Samantha', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(voices.filter(v => v.name !== 'Samantha'), 'Evan (Enhanced)'), { voice: 'Daniel', wanted: 'Evan (Enhanced)', exact: false });
  // Case is forgiven, and the name passed on is the list's own spelling.
  assert.deepEqual(resolveVoice(evan, 'evan (enhanced)'), { voice: 'Evan (Enhanced)', wanted: 'evan (enhanced)', exact: true });
  assert.deepEqual(resolveVoice(voices, 'nobody', ['DANIEL']), { voice: 'Daniel', wanted: 'nobody', exact: false });
  // An exact spelling wins over one that differs in case.
  assert.equal(resolveVoice([{ name: 'ALBERT' }, { name: 'Albert' }], 'Albert').voice, 'Albert');
  // A voice installed in two sizes is listed with its language in brackets: a plain
  // name finds it as a stand-in, and the list's own name is what is passed on.
  const twoSizes = parseVoices('Daniel (English (UK)) en_GB    # Hello!\nDaniel (English (UK)) en_GB    # Hello!\nSamantha (English (US)) en_US    # Hello!\nSamantha (English (US)) en_US    # Hello!\nSam en_US # x');
  assert.deepEqual(twoSizes.map(v => v.name), ['Daniel (English (UK))', 'Samantha (English (US))', 'Sam'], 'each name once');
  assert.deepEqual(resolveVoice(twoSizes, 'Evan (Enhanced)'), { voice: 'Samantha (English (US))', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(twoSizes, 'Evan (Enhanced)', ['daniel']), { voice: 'Daniel (English (UK))', wanted: 'Evan (Enhanced)', exact: false });
  // The wanted voice's plain name stands in before the built-in ones, and is never called exact.
  const plainEvan = parseVoices(`Evan                en_US    # Hello!\n${LIST}`);
  assert.deepEqual(resolveVoice(plainEvan, 'Evan (Enhanced)'), { voice: 'Evan', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(parseVoices(`Evan (Premium)      en_US    # Hello!\n${LIST}`), 'Evan (Enhanced)'), { voice: 'Evan (Premium)', wanted: 'Evan (Enhanced)', exact: false });
  assert.deepEqual(resolveVoice(plainEvan, 'Evan (Enhanced)', ['Daniel']), { voice: 'Daniel', wanted: 'Evan (Enhanced)', exact: false }, 'config\'s fallback first');
  // A name given with brackets is that voice or nothing: "Daniel (Enhanced)" is not plain Daniel's stand-in rule.
  assert.equal(resolveVoice(parseVoices('Daniel en_GB # x'), 'Zoe (Premium)', ['Daniel (Enhanced)']).voice, 'Daniel', 'found only as the built-in Daniel');
  assert.equal(resolveVoice(parseVoices('Tom (Enhanced) en_US # x'), 'Zoe (Premium)', ['Tom (Premium)']), null);
  // A plain wanted name is exact only as itself.
  assert.deepEqual(resolveVoice(twoSizes, 'Samantha'), { voice: 'Samantha (English (US))', wanted: 'Samantha', exact: false });
  assert.deepEqual(resolveVoice(twoSizes, 'Sam'), { voice: 'Sam', wanted: 'Sam', exact: true }, 'never a longer name that merely starts the same');
  const novelty = parseVoices('Zarvox              en_US    # Hello!\nSamantha Fox en_US # x');
  assert.equal(resolveVoice(novelty, 'Evan (Enhanced)', ['Nobody']), null);
  assert.equal(resolveVoice([], 'Samantha', ['Samantha']), null);
  assert.equal(resolveVoice(null, 'Samantha', ['Samantha']), null);
  assert.equal(resolveVoice(voices.filter(v => !['Samantha', 'Daniel'].includes(v.name)), null, [null, 7, '']), null);
  assert.equal(voiceBase('Evan (Enhanced)'), 'Evan');
  assert.equal(voiceBase('Samantha (English (US))'), 'Samantha');
  assert.equal(voiceBase('Bad News'), 'Bad News');
  assert.equal(voiceBase(undefined), '');
});

test('the words say gets: no square or angle brackets in any spelling (its command syntax), no control or invisible characters, one space between words', () => {
  assert.equal(speakable('Hello [[slnc 5000]] world.'), 'Hello slnc 5000 world.');
  // Brackets in other spellings are made plain first (NFKC), then go like the rest:
  // fullwidth (U+FF3B, U+FF3D) and the vertical presentation forms (U+FE47, U+FE48).
  assert.equal(speakable(`Hello ${cp(0xff3b, 0xff3b)}slnc 60000${cp(0xff3d, 0xff3d)} world.`), 'Hello slnc 60000 world.');
  assert.equal(speakable(`Hello ${cp(0xfe47, 0xfe47)}slnc 60000${cp(0xfe48, 0xfe48)} world.`), 'Hello slnc 60000 world.');
  for (const c of [0xff3b, 0xff3d, 0xfe47, 0xfe48]) {
    assert.equal(speakable(`a${cp(c)}b`), 'a b', `U+${c.toString(16)}`);
    assert.ok(!/[[\]]/.test(speakable(cp(c, c))), `U+${c.toString(16)}`);
  }
  // A tag is obeyed too (<break time="60s"/> is a minute of silence): no angle bracket is left,
  // in the plain spelling, the fullwidth one (U+FF1C, U+FF1E) or the small one (U+FE64, U+FE65).
  assert.equal(speakable('Hello <break time="60s"/> world.'), 'Hello break time="60s"/ world.');
  assert.equal(speakable('<speak>Hi <prosody rate="x-slow">there</prosody></speak>'), 'speak Hi prosody rate="x-slow" there /prosody /speak');
  assert.equal(speakable(`a${cp(0xff1c)}break time="60s"/${cp(0xff1e)}b`), 'a break time="60s"/ b');
  assert.equal(speakable(`a${cp(0xfe64)}b${cp(0xfe65)}c`), 'a b c');
  assert.ok(!/[<>]/.test(speakable(`<<a>> ${cp(0xff1c, 0xfe64, 0xff1e, 0xfe65)} 1 < 2 > 0`)));
  // A bracket with a stroke through it (U+226E, U+226F) is a bracket and a combining
  // stroke (U+0338): taken apart, never put together, so neither spelling leaves one.
  const struck = speakable(`${cp(0x226e)}break time="5s"/>`);
  assert.ok(!/[<>]/.test(struck) && !struck.includes(cp(0x226e)), JSON.stringify(struck));
  assert.equal(struck.replace(cp(0x338), ''), 'break time="5s"/');
  for (const tag of [`<${cp(0x338)}break time="5s"/>${cp(0x338)}`, `${cp(0x226e)}break time="5s"/${cp(0x226f)}`, `${cp(0xff1c, 0x338)}break time="5s"/${cp(0xff1e, 0x338)}`]) {
    const out = speakable(`Hello ${tag} world.`);
    assert.ok(![...out].some(ch => ['<', '>', cp(0x226e), cp(0x226f)].includes(ch)), JSON.stringify(out));
    assert.ok(![...out.normalize('NFKC')].some(ch => ['<', '>', cp(0x226e), cp(0x226f)].includes(ch)), 'nor once composed again');
    assert.equal(out.replaceAll(cp(0x338), '').replace(/\s+/g, ' '), 'Hello break time="5s"/ world.');
  }
  // Accented letters come out whole (composed), however they came in.
  assert.equal(speakable(`Cafe${cp(0x301)} and Caf${cp(0xe9)}`), `Caf${cp(0xe9)} and Caf${cp(0xe9)}`);
  // The compatibility form also plains other look-alikes, which only helps a voice.
  assert.equal(speakable(`${cp(0xff28, 0xff49)} ${cp(0xfb01)}ne`), 'Hi fine');
  assert.equal(speakable('[[rate 60]][[inpt PHON]]a]b[c'), 'rate 60 inpt PHON a b c');
  assert.ok(!/[[\]]/.test(speakable('[[[ ]]] [ [x] ]')));
  assert.equal(speakable(`a${cp(0)}b${cp(7)}c${cp(0x1b)}[0m d${cp(0x7f)}e`), 'a b c 0m d e');
  assert.equal(speakable(`left${cp(0x202e)}right${cp(0x200b)}zero${cp(0x2066)}iso${cp(0xfeff)}bom`), 'left right zero iso bom');
  assert.equal(speakable(`line${cp(0x2028)}sep${cp(0x2029)}para\ttab\r\nend`), 'line sep para tab end');
  assert.equal(speakable(`lone${cp(0x61)}${String.fromCharCode(0xd800)}surrogate`), `lonea${cp(0xfffd)}surrogate`);
  assert.equal(speakable(`private${cp(0xe000)}use`), 'private use');
  assert.equal(speakable('  many   spaces \n here  '), 'many spaces here');
  assert.equal(speakable(`Caf${cp(0xe9)} na${cp(0xef)}ve ${cp(0x2014)} done ${cp(0x1f44d)}`), `Caf${cp(0xe9)} na${cp(0xef)}ve ${cp(0x2014)} done ${cp(0x1f44d)}`);
  for (const not of [undefined, null, 7, {}, ['a']]) assert.equal(speakable(not), '');
  assert.equal(speakable(''), '');
  assert.equal(speakable(' [ ] '), '');
});

test('a Range header: one range of bytes, clamped to the body; anything else sends it whole', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange('bytes=-', 100), null);
  assert.equal(parseRange('bytes=0-1,5-9', 100), null, 'several ranges: the whole body');
  assert.equal(parseRange('bytes=9-5', 100), null, 'backwards: the whole body');
  assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange(' bytes=0-1 ', 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=40-', 100), { start: 40, end: 99 });
  assert.deepEqual(parseRange('bytes=40-4000', 100), { start: 40, end: 99 });
  assert.deepEqual(parseRange('bytes=99-99', 100), { start: 99, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=100-200', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
  assert.equal(parseRange(`bytes=${'9'.repeat(16)}-`, 100), null, 'a number too long to be a size');
});

test('the route: a paired device gets the audio of one of the lead\'s own messages, read once and kept', async t => {
  const { env, say, get, jarvis, dir, lines } = await makeEnv(t);
  const m = await jarvis('**Done.** The [[slnc 9000]] backup ran, see [the log](https://x.example/log).\n```sh\nrm -r build\n```');
  const r = await get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mp4');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(Number(r.headers.get('content-length')), r.buf.length);
  assert.equal(r.buf.toString('latin1', 4, 8), 'ftyp');
  // One process, and exactly this one: say by its path, the list's own voice name in
  // one argument, the words in a file, an empty environment, a time limit, SIGKILL.
  assert.equal(say.calls.length, 1);
  const c = say.calls[0];
  assert.equal(c.file, '/usr/bin/say');
  assert.equal(c.args.length, 7);
  assert.equal(c.args[0], '--voice=Samantha', 'the wanted voice is not installed, so the installed fallback, never the missing name');
  assert.deepEqual([c.args[1], c.args[3], c.args[4], c.args[5]], ['-o', '--file-format=m4af', '--data-format=aac', '-f']);
  assert.ok(c.args[2].startsWith(`${dir}/work-`) && c.args[2].endsWith('/out.m4a'));
  assert.ok(c.args[6].startsWith(`${dir}/work-`) && c.args[6].endsWith('/in.txt'));
  assert.deepEqual(c.options.env, {});
  assert.equal(c.options.timeout, 45e3);
  assert.equal(c.options.killSignal, 'SIGKILL');
  assert.equal(c.options.shell, undefined);
  assert.equal(c.options.cwd, dirname(c.args[6]));
  assert.equal(c.srcMode, 0o600);
  assert.equal(c.folderMode, 0o700);
  // The words: the page's own text for speech, then made plain. Never in the arguments.
  assert.equal(c.words, 'Done. The slnc 9000 backup ran, see the log. Code block skipped.');
  assert.equal(c.words, speakable(speechText(m.text)));
  assert.ok(!c.args.join(' ').includes('backup'));
  // Kept: one file in a private folder, the work folder gone; the next ask starts nothing.
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(dir)).filter(n => n.startsWith('work-')), []);
  const files = await audioFiles(dir);
  assert.equal(files.length, 1);
  assert.equal((await lstat(join(dir, files[0]))).mode & 0o077, 0, 'no group or world bits');
  assert.ok((await readFile(join(dir, files[0]))).equals(r.buf));
  const again = await get(`/api/chat/speech/${m.id}`);
  assert.equal(again.status, 200);
  assert.ok(again.buf.equals(r.buf));
  assert.equal(say.calls.length, 1, 'served from the cache');
  // The log says how much and for whom, never the words.
  const line = lines.find(l => /^speech: read /.test(l));
  assert.match(line, new RegExp(`^speech: read ${c.words.length} characters in Samantha for Test Phone \\(\\d+ ms, \\d+ bytes\\)$`));
  assert.ok(!lines.join('\n').includes('backup'));
});

test('the route: byte ranges, as Safari asks for them', async t => {
  const { get, jarvis } = await makeEnv(t);
  const m = await jarvis('A short reply.');
  const whole = await get(`/api/chat/speech/${m.id}`);
  const size = whole.buf.length;
  const probe = await get(`/api/chat/speech/${m.id}`, { range: 'bytes=0-1' });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), `bytes 0-1/${size}`);
  assert.equal(probe.headers.get('content-type'), 'audio/mp4');
  assert.equal(probe.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(probe.headers.get('content-length'), '2');
  assert.ok(probe.buf.equals(whole.buf.subarray(0, 2)));
  const rest = await get(`/api/chat/speech/${m.id}`, { range: `bytes=4-` });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('content-range'), `bytes 4-${size - 1}/${size}`);
  assert.ok(rest.buf.equals(whole.buf.subarray(4)));
  const tail = await get(`/api/chat/speech/${m.id}`, { range: 'bytes=-5' });
  assert.equal(tail.status, 206);
  assert.ok(tail.buf.equals(whole.buf.subarray(size - 5)));
  const past = await get(`/api/chat/speech/${m.id}`, { range: `bytes=${size}-` });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${size}`);
  assert.equal(past.buf.length, 0);
  const several = await get(`/api/chat/speech/${m.id}`, { range: 'bytes=0-1,3-4' });
  assert.equal(several.status, 200);
  assert.ok(several.buf.equals(whole.buf));
});

test('the route: only a paired device, as the owner, from the page itself, with GET', async t => {
  const { env, say, get, jarvis, dev } = await makeEnv(t, { routes: { config: { chat: { login: 'owner@example.test' } } } });
  const login = { 'tailscale-user-login': 'owner@example.test' };
  const m = await jarvis('Hello there.');
  const path = `/api/chat/speech/${m.id}`;
  assert.equal((await env.call({ path, headers: login })).status, 401, 'no cookie');
  assert.equal((await env.call({ path, headers: { cookie: 'jos_device=nope', ...login } })).status, 401);
  assert.equal((await env.call({ path, headers: { cookie: dev.cookie } })).status, 403, 'no login header');
  assert.equal((await env.call({ path, headers: { cookie: dev.cookie, 'tailscale-user-login': 'other@example.test' } })).status, 403);
  // An unpaired caller learns nothing about which paths or messages exist.
  assert.equal((await env.call({ path: '/api/chat/speech/m_nosuchmessage', headers: login })).status, 401);
  assert.equal((await env.call({ path: '/api/chat/speech/anything/else', headers: login })).status, 401);
  for (const site of ['cross-site', 'same-site', 'none', '']) {
    const r = await env.call({ path, headers: { cookie: dev.cookie, ...login, 'sec-fetch-site': site } });
    assert.equal(r.status, 403, `sec-fetch-site ${site}`);
    assert.match(r.json.error, /the chat page itself/);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const r = await env.call({ method, path, headers: { cookie: dev.cookie, ...login } });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET');
  }
  assert.equal(say.calls.length, 0, 'none of those started anything');
  const ok = await get(path, { ...login, 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.equal(say.calls.length, 1);
  await env.devices.revoke(dev.id, 'test');
  assert.equal((await get(path, login)).status, 401, 'a revoked device gets nothing, cached or not');
});

test('the route: the request names a message and nothing else', async t => {
  const { env, say, get, jarvis } = await makeEnv(t);
  const mine = await env.store.append({ from: 'jeff', kind: 'chat', text: 'Read this back to me.', device: 'Test Phone', state: 'queued' });
  const event = await env.store.append({ from: 'system', kind: 'event', text: 'A job failed.' });
  const notice = await env.store.append({ from: 'system', kind: 'notice', text: 'Jarvis restarted.' });
  const verdict = await env.store.append({ from: 'jarvis', kind: 'verdict', text: 'allowed' });
  for (const m of [mine, event, notice, verdict]) {
    const r = await get(`/api/chat/speech/${m.id}`);
    assert.equal(r.status, 403, `${m.from} ${m.kind}`);
    assert.match(JSON.parse(r.buf).error, /only the lead's own messages/);
  }
  assert.equal((await get('/api/chat/speech/m_nosuchmessage')).status, 404);
  for (const path of ['/api/chat/speech', '/api/chat/speech/', '/api/chat/speech/M_ABCDEF', '/api/chat/speech/m_abc', '/api/chat/speech/..%2Fx', '/api/chat/speech/sample/x', '/api/chat/speech/samples', `/api/chat/speech/m_abcdef0/in.txt`, '/api/chat/speechless']) {
    assert.equal((await get(path)).status, 404, path);
  }
  // Nothing in the query changes what is read, in which voice or to where.
  const m = await jarvis('The real words.');
  const r = await get(`/api/chat/speech/${m.id}?text=other+words&voice=Zarvox&v=Zarvox&o=/tmp/x&f=/etc/passwd&format=WAVE`);
  assert.equal(r.status, 200);
  assert.equal(say.calls.length, 1);
  assert.equal(say.calls[0].words, 'The real words.');
  assert.equal(say.calls[0].args[0], '--voice=Samantha');
  assert.equal(say.calls[0].args.length, 7);
  // Nothing to say: only brackets and invisible characters are left.
  const empty = await jarvis(`[ ] ${cp(0x200b)}`);
  const none = await get(`/api/chat/speech/${empty.id}`);
  assert.equal(none.status, 422);
  for (const text of ['', '...', '?!', '- [ ]', `${cp(0x2014)} ${cp(0x2026)}`]) {
    const blank = await env.store.append({ from: 'jarvis', kind: 'chat', text });
    assert.equal((await get(`/api/chat/speech/${blank.id}`)).status, 422, JSON.stringify(text));
  }
  assert.equal(say.calls.length, 1);
  // A digit or an emoji alone is something to say.
  for (const text of ['7', cp(0x1f44d)]) {
    const short = await jarvis(text);
    assert.equal((await get(`/api/chat/speech/${short.id}`)).status, 200, JSON.stringify(text));
  }
  assert.equal(say.calls.length, 3);
});

test('the route: a message too long is refused before anything starts; at the limit it is read', async t => {
  const { say, get, jarvis } = await makeEnv(t, { speechOpts: { textMax: 40 } });
  const at = await jarvis(`${'a'.repeat(39)}.`);
  const over = await jarvis(`${'a'.repeat(40)}.`);
  const long = await get(`/api/chat/speech/${over.id}`);
  assert.equal(long.status, 413);
  assert.match(JSON.parse(long.buf).error, /too long for the Mac's voice/);
  assert.equal(say.calls.length, 0);
  assert.equal((await get(`/api/chat/speech/${at.id}`)).status, 200);
  assert.equal(say.calls[0].words.length, 40);
});

test('the sample: fixed words of the server\'s own, cached like a message', async t => {
  const { say, get } = await makeEnv(t);
  const r = await get('/api/chat/speech/sample?text=say+this+instead');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mp4');
  assert.equal(say.calls[0].words, SAMPLE_WORDS);
  assert.equal((await get('/api/chat/speech/sample')).status, 200);
  assert.equal(say.calls.length, 1);
});

test('an edited message is read again; the same words in another message are not', async t => {
  const { env, say, get, jarvis, dir } = await makeEnv(t);
  const m = await jarvis('First version.');
  await get(`/api/chat/speech/${m.id}`);
  const twin = await jarvis('First version.');
  assert.equal((await get(`/api/chat/speech/${twin.id}`)).status, 200);
  assert.equal(say.calls.length, 1, 'named by the words, not the id');
  await env.store.edit(m.id, 'Second version.');
  const r = await get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 200);
  assert.equal(say.calls.length, 2);
  assert.equal(say.calls[1].words, 'Second version.');
  assert.ok(r.buf.includes('Second'), 'the new audio, not the old file');
  assert.equal((await audioFiles(dir)).length, 2);
});

test('the voice: the list is read first, a missing voice is never passed on, and a later download is found without a restart', async t => {
  const say = fakeSay();
  const { env, speech, get, jarvis, lines } = await makeEnv(t, { say });
  assert.deepEqual(speech.info(), { voice: 'Samantha', wanted: 'Evan (Enhanced)', exact: false });
  assert.ok(lines.includes('speech: Evan (Enhanced) is not installed on this Mac, so reading in Samantha'));
  const status = await env.call({ path: '/api/chat/status', headers: { cookie: (await env.pair('Test Pad')).cookie } });
  assert.deepEqual(status.json.speech, { voice: 'Samantha', wanted: 'Evan (Enhanced)', exact: false });
  const a = await jarvis('One.');
  await get(`/api/chat/speech/${a.id}`);
  assert.equal(say.calls[0].args[0], '--voice=Samantha');
  // The voice arrives. Within the list's life nothing is read again...
  say.list = LIST_WITH_EVAN;
  const lists = say.lists;
  env.clock.t += VOICES_TTL_MS;
  assert.equal(speech.info().voice, 'Samantha');
  assert.equal(say.lists, lists);
  // ...after it, the next ask reads the list, and the same words are made again in the new voice.
  env.clock.t += 1;
  const r = await get(`/api/chat/speech/${a.id}`);
  assert.equal(r.status, 200);
  assert.equal(say.lists, lists + 1);
  assert.equal(say.calls.length, 2);
  assert.equal(say.calls[1].args[0], '--voice=Evan (Enhanced)');
  assert.deepEqual(speech.info(), { voice: 'Evan (Enhanced)', wanted: 'Evan (Enhanced)', exact: true });
  assert.ok(lines.includes('speech: reading in Evan (Enhanced)'));
  // One list that can't be read keeps the voice that was known.
  say.list = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
  env.clock.t += VOICES_TTL_MS + 1;
  assert.equal((await get(`/api/chat/speech/${a.id}`)).status, 200);
  assert.equal(speech.info().voice, 'Evan (Enhanced)');
  assert.ok(lines.includes('speech: the voice list could not be read (ENOENT)'));
  // The same voice read again is not announced again, and the count of failures starts over.
  say.list = LIST_WITH_EVAN;
  env.clock.t += VOICES_TTL_MS + 1;
  assert.equal((await get(`/api/chat/speech/${a.id}`)).status, 200);
  assert.equal(say.lists, lists + 3);
  assert.equal(lines.filter(l => l === 'speech: reading in Evan (Enhanced)').length, 1);
  assert.equal(lines.filter(l => /is not installed on this Mac/.test(l)).length, 1);
  say.list = Object.assign(new Error('timed out'), { killed: true });
  env.clock.t += VOICES_TTL_MS + 1;
  assert.equal((await get(`/api/chat/speech/${a.id}`)).status, 200, 'one failure after a good read: still known');
  assert.ok(lines.includes('speech: the voice list could not be read (timeout)'));
  // A second failure in a row: the voice may be gone, so nothing is read, cached or not.
  env.clock.t += VOICES_TTL_MS + 1;
  const unknown = await get(`/api/chat/speech/${a.id}`);
  assert.equal(unknown.status, 503);
  assert.match(JSON.parse(unknown.buf).error, /no voice to read in can be found/);
  assert.equal(speech.info(), null);
  assert.equal((await env.call({ path: '/api/chat/status', headers: { cookie: (await env.pair('Test Mac')).cookie } })).json.speech, null);
  assert.equal(lines.filter(l => l === 'speech: 2 reads of the voice list failed in a row, so the voice is unknown; read aloud on the Mac is off until one works').length, 1);
  assert.equal(say.calls.length, 2, 'no render with an unknown voice');
  // A third failure says nothing new; the first good read brings the voice back, and says so.
  env.clock.t += VOICES_TTL_MS + 1;
  assert.equal((await get(`/api/chat/speech/${a.id}`)).status, 503);
  assert.equal(lines.filter(l => /failed in a row/.test(l)).length, 1);
  say.list = LIST_WITH_EVAN;
  env.clock.t += VOICES_TTL_MS + 1;
  assert.equal((await get(`/api/chat/speech/${a.id}`)).status, 200);
  assert.deepEqual(speech.info(), { voice: 'Evan (Enhanced)', wanted: 'Evan (Enhanced)', exact: true });
  assert.equal(lines.filter(l => l === 'speech: reading in Evan (Enhanced)').length, 2);
});

test('the voice: config\'s fallback comes before the built-in ones; with none installed it is off', async t => {
  const first = await makeEnv(t, { speechOpts: { fallback: 'Daniel' } });
  assert.deepEqual(first.speech.info(), { voice: 'Daniel', wanted: 'Evan (Enhanced)', exact: false });
  const none = await makeEnv(t, { say: fakeSay({ list: 'Zarvox              en_US    # Hello! My name is Zarvox.\n' }) });
  assert.equal(none.speech.info(), null);
  const m = await none.jarvis('Hello.');
  const r = await none.get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 503);
  assert.match(JSON.parse(r.buf).error, /no voice to read in/);
  assert.equal(none.say.calls.length, 0, 'never the novelty voice that happens to be there');
  assert.ok(none.lines.includes('speech: none of Evan (Enhanced), Evan, Samantha, Daniel is installed; read aloud on the Mac is off'));
  // Lists that then can't be read change nothing here: no voice was known, so none is said to be lost.
  none.say.list = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
  for (let i = 0; i < 3; i++) {
    none.env.clock.t += VOICES_TTL_MS + 1;
    assert.equal((await none.get(`/api/chat/speech/${m.id}`)).status, 503);
  }
  assert.equal(none.lines.filter(l => /could not be read/.test(l)).length, 3);
  assert.equal(none.lines.filter(l => /failed in a row/.test(l)).length, 0);
});

test('the kill file: off at once, in the status and on the route, and back on when it goes', async t => {
  const { env, speech, kill, say, get, jarvis, dev } = await makeEnv(t);
  const m = await jarvis('Hello.');
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 200);
  kill.on = true;
  assert.equal(speech.info(), null);
  assert.equal((await env.call({ path: '/api/chat/status', headers: { cookie: dev.cookie } })).json.speech, null);
  const r = await get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 503, 'even what is cached');
  assert.match(JSON.parse(r.buf).error, /read aloud on the Mac is off/);
  kill.on = false;
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 200);
  assert.equal(say.calls.length, 1);
});

test('before start() nothing is read, and the status says off; without speech the status says null and the path is a 404', async t => {
  const { env, speech, say, get, jarvis, dev } = await makeEnv(t, { start: false });
  const m = await jarvis('Hello.');
  assert.equal(speech.info(), null);
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 503);
  assert.equal(say.calls.length, 0);
  assert.equal(say.lists, 0);
  assert.equal((await env.call({ path: '/api/chat/status', headers: { cookie: dev.cookie } })).json.speech, null);
  const plain = await makeChatEnv();
  t.after(() => plain.close());
  const d = await plain.pair('Test Phone');
  const s = await plain.call({ path: '/api/chat/status', headers: { cookie: d.cookie } });
  assert.equal(s.json.speech, null);
  assert.ok('speech' in s.json);
  assert.equal((await plain.call({ path: '/api/chat/speech/sample', headers: { cookie: d.cookie } })).status, 404);
});

test('one render at a time; the same words asked twice at once are made once; a full queue is refused', async t => {
  const say = fakeSay();
  const { get, jarvis, speech, lines } = await makeEnv(t, { say, speechOpts: { waitingMax: 2 } });
  const ms = [];
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) ms.push(await jarvis(text));
  say.hold();
  // One after the other, each seen to arrive: separate connections land in any order.
  const first = get(`/api/chat/speech/${ms[0].id}`);
  assert.ok(await until(() => say.calls.length === 1), 'the first render started');
  const same = get(`/api/chat/speech/${ms[0].id}`);
  const range = get(`/api/chat/speech/${ms[0].id}`, { range: 'bytes=0-1' });
  const second = get(`/api/chat/speech/${ms[1].id}`);
  assert.ok(await until(() => speech.waiting() === 1), 'the second waits its turn');
  const third = get(`/api/chat/speech/${ms[2].id}`);
  assert.ok(await until(() => speech.waiting() === 2), 'and the third behind it');
  await pause(60);
  assert.equal(say.calls.length, 1, 'the twin and the range ask join the first');
  assert.equal(speech.waiting(), 2);
  const full = await get(`/api/chat/speech/${ms[3].id}`);
  assert.equal(full.status, 503);
  assert.equal(full.headers.get('retry-after'), '5');
  assert.match(JSON.parse(full.buf).error, /the voice is busy/);
  // A join is not refused by a full queue.
  const joined = get(`/api/chat/speech/${ms[1].id}`);
  await pause(40);
  say.release();
  const all = await Promise.all([first, same, range, second, third, joined]);
  assert.deepEqual(all.map(r => r.status), [200, 200, 206, 200, 200, 200]);
  assert.ok(all[0].buf.equals(all[1].buf));
  assert.equal(say.calls.length, 3);
  assert.equal(say.most, 1, 'never two at once');
  assert.deepEqual(say.calls.map(c => c.words), ['One.', 'Two.', 'Three.']);
  assert.equal(speech.waiting(), 0);
  // The refused one is read once there is room.
  assert.equal((await get(`/api/chat/speech/${ms[3].id}`)).status, 200);
  assert.equal(lines.filter(l => /^speech: read /.test(l)).length, 4);
});

test('each device may start so many renders in a window; cached audio and other devices are not counted', async t => {
  const { env, say, get, jarvis } = await makeEnv(t, { speechOpts: { perWindow: 2, windowMs: 60e3 } });
  const ms = [];
  for (const text of ['One.', 'Two.', 'Three.', 'Four.']) ms.push(await jarvis(text));
  assert.equal((await get(`/api/chat/speech/${ms[0].id}`)).status, 200);
  env.clock.t += 20e3;
  assert.equal((await get(`/api/chat/speech/${ms[1].id}`)).status, 200);
  const r = await get(`/api/chat/speech/${ms[2].id}`);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '40', 'until the oldest of its renders leaves the window');
  assert.match(JSON.parse(r.buf).error, /too many messages read aloud/);
  assert.equal(say.calls.length, 2);
  // What is already made plays, however often.
  for (let i = 0; i < 5; i++) assert.equal((await get(`/api/chat/speech/${ms[0].id}`)).status, 200);
  // Another device has its own count.
  const other = await env.pair('Test Pad');
  const asOther = await fetch(`http://127.0.0.1:${env.port}/api/chat/speech/${ms[2].id}`, { headers: { cookie: other.cookie } });
  assert.equal(asOther.status, 200);
  await asOther.arrayBuffer();
  assert.equal(say.calls.length, 3);
  // A refusal is not itself counted: one second before the window's end, still refused; at its end, read.
  env.clock.t += 39e3;
  assert.equal((await get(`/api/chat/speech/${ms[3].id}`)).status, 429);
  env.clock.t += 1e3;
  assert.equal((await get(`/api/chat/speech/${ms[3].id}`)).status, 200);
  assert.equal((await get(`/api/chat/speech/${ms[3].id}`)).status, 200);
  assert.equal(say.calls.length, 4);
});

test('a render that fails leaves nothing behind and says so plainly: timeout, failure, no file, not audio, too large', async t => {
  const say = fakeSay();
  // failLogMs 0: every failure's line is written, where the log holds it to one a minute.
  const { get, jarvis, dir, lines } = await makeEnv(t, { say, speechOpts: { failLogMs: 0 } });
  let n = 0;
  const next = async () => { n++; return jarvis(`Attempt ${n} of the secret plan.`); };
  const ask = async () => { const m = await next(); const r = await get(`/api/chat/speech/${m.id}`); return { status: r.status, error: JSON.parse(r.buf).error }; };
  say.fail = Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
  assert.deepEqual(await ask(), { status: 504, error: 'the voice took too long' });
  say.fail = Object.assign(new Error('Command failed: /usr/bin/say secret plan /private/path'), { code: 1 });
  assert.deepEqual(await ask(), { status: 502, error: 'the voice could not read this' });
  say.fail = null;
  for (const audio of [() => null, () => Buffer.alloc(0), () => Buffer.from('<html>not audio at all</html>'), () => Buffer.from('ftyp')]) {
    const bad = fakeSay({ audio });
    say.run = bad.run;
    assert.deepEqual(await ask(), { status: 502, error: 'the voice could not read this' });
  }
  assert.deepEqual(await readdir(dir), [], 'no audio kept, no work folder left');
  const reasons = lines.filter(l => /failed/.test(l));
  assert.equal(reasons.length, 6);
  assert.match(reasons[5], /failed \(failed\)$/);
  assert.equal(reasons[0], `speech: a render of ${'Attempt 1 of the secret plan.'.length} characters for Test Phone failed (timeout)`);
  assert.match(reasons[1], /failed \(failed\)$/);
  assert.ok(!lines.join('\n').includes('secret'), 'never the words, the command or a path');
  assert.ok(!lines.join('\n').includes('/private/path'));
});

test('a render that failed is not tried again for ten minutes: the same answer, no process; then it is', async t => {
  const say = fakeSay();
  const { env, get, jarvis, lines, dir } = await makeEnv(t, { say, speechOpts: { audioMaxBytes: 200, perWindow: 3, windowMs: 3600e3 } });
  const slow = await jarvis('This one takes too long.');
  const broken = await jarvis('This one cannot be read.');
  const big = await jarvis('This one is too large.');
  const ask = async m => { const r = await get(`/api/chat/speech/${m.id}`); return { status: r.status, error: JSON.parse(r.buf).error }; };
  say.fail = Object.assign(new Error('killed'), { killed: true });
  assert.deepEqual(await ask(slow), { status: 504, error: 'the voice took too long' });
  say.fail = Object.assign(new Error('exit 1'), { code: 1 });
  assert.deepEqual(await ask(broken), { status: 502, error: 'the voice could not read this' });
  say.fail = null;
  const large = fakeSay({ audio: () => Buffer.concat([fakeAudio('x'), Buffer.alloc(300)]) });
  say.run = large.run;
  assert.deepEqual(await ask(big), { status: 413, error: 'the audio is too large' });
  // The voice works again, and still: each gets its own answer back, with nothing started,
  // nothing logged, and nothing counted against the device (its three starts are spent).
  const good = fakeSay();
  say.run = good.run;
  const logged = lines.length;
  env.clock.t += FAILED_TTL_MS - 1;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await ask(slow), { status: 504, error: 'the voice took too long' });
    assert.deepEqual(await ask(broken), { status: 502, error: 'the voice could not read this' });
    assert.deepEqual(await ask(big), { status: 413, error: 'the audio is too large' });
  }
  assert.equal(good.calls.length, 0);
  assert.equal(lines.length, logged);
  assert.deepEqual(await readdir(dir), []);
  // Ten minutes after the failure it is tried again (the window is an hour here, so the
  // device's own limit answers first: move past that too).
  env.clock.t += 1;
  assert.equal((await get(`/api/chat/speech/${slow.id}`)).status, 429, 'tried: the device limit is what answers now');
  env.clock.t += 3600e3;
  assert.equal((await get(`/api/chat/speech/${slow.id}`)).status, 200);
  assert.equal(good.calls.length, 1);
  assert.equal(good.calls[0].words, 'This one takes too long.');
});

test('failures remembered: at most so many, the oldest forgotten first; one seen again counts as new', async t => {
  const say = fakeSay();
  const { get, jarvis } = await makeEnv(t, { say, speechOpts: { failedMax: 2 } });
  const ms = [];
  for (const text of ['Failure one.', 'Failure two.', 'Failure three.']) ms.push(await jarvis(text));
  const flaky = fakeSay();
  flaky.fail = Object.assign(new Error('exit 1'), { code: 1 });
  say.run = flaky.run;
  for (const m of ms) assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 502);
  assert.equal(flaky.calls.length, 3);
  // Three failed and two are remembered: the first is tried again (and fails again, which
  // makes it the newest and pushes the second out).
  assert.equal((await get(`/api/chat/speech/${ms[2].id}`)).status, 502);
  assert.equal(flaky.calls.length, 3, 'the third is remembered');
  assert.equal((await get(`/api/chat/speech/${ms[0].id}`)).status, 502);
  assert.equal(flaky.calls.length, 4, 'the first was forgotten, so tried');
  assert.equal((await get(`/api/chat/speech/${ms[2].id}`)).status, 502);
  assert.equal((await get(`/api/chat/speech/${ms[0].id}`)).status, 502);
  assert.equal(flaky.calls.length, 4, 'the third and the first are the two remembered now');
  assert.equal((await get(`/api/chat/speech/${ms[1].id}`)).status, 502);
  assert.equal(flaky.calls.length, 5, 'the second was pushed out, so tried');
});

test('the cache folder gone while the server runs is made again, as at start, and the render goes through', async t => {
  const say = fakeSay();
  const { env, get, jarvis, dir, lines } = await makeEnv(t, { say, speechOpts: { perWindow: 2, windowMs: 3600e3, perDay: 3 } });
  // Removed by hand (the rollback's `rm -r`), or by another server's start with read aloud off.
  await rm(dir, { recursive: true, force: true });
  const m = await jarvis('The folder is gone.');
  const r = await get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.buf.includes('audio:The folder i'));
  assert.equal((await lstat(dir)).mode & 0o777, 0o700, 'made again, private');
  assert.equal((await audioFiles(dir)).length, 1);
  assert.deepEqual(lines.filter(l => /cache folder|failed/.test(l)), ['speech: the cache folder was gone; made it again']);
  assert.equal(say.calls.length, 1, 'nothing was started before the folder was back');
  // Gone while `say` runs: the render is made a second time, and counted once.
  const mid = await jarvis('Gone while it was read.');
  say.hold();
  const asked = get(`/api/chat/speech/${mid.id}`);
  assert.ok(await until(() => say.calls.length === 2), 'the render started');
  await rm(dir, { recursive: true, force: true });
  say.release();
  const again = await asked;
  assert.equal(again.status, 200);
  assert.equal(say.calls.length, 3, 'the first try lost its folder; the second made the audio');
  assert.equal(lines.filter(l => l === 'speech: the cache folder was gone; made it again').length, 2);
  assert.equal(lines.filter(l => /failed/.test(l)).length, 0);
  assert.deepEqual((await readdir(dir)).filter(n => n.startsWith('work-')), []);
  // Two renders were charged, no more: the device's window of two is spent, the day's three is not.
  const third = await jarvis('A third message.');
  const limited = await get(`/api/chat/speech/${third.id}`);
  assert.equal(limited.status, 429);
  assert.match(JSON.parse(limited.buf).error, /too many messages read aloud/);
  const other = await env.pair('Test Pad');
  const fromPad = await fetch(`http://127.0.0.1:${env.port}/api/chat/speech/${third.id}`, { headers: { cookie: other.cookie } });
  assert.equal(fromPad.status, 200, 'the day had one render left');
  await fromPad.arrayBuffer();
});

test('`say` left no file because the folder went: the folder is blamed, not `say`', async t => {
  const say = fakeSay();
  const { get, jarvis, dir, lines } = await makeEnv(t, { say });
  const m = await jarvis('No file, no folder.');
  // A `say` that ends well and writes nothing, as it would with its folder pulled away.
  let runs = 0;
  const quiet = fakeSay({ audio: () => null });
  say.run = async (file, args, options) => {
    if (args[0] !== '-v') { runs++; if (runs === 1) { await rm(dir, { recursive: true, force: true }); return ''; } }
    return (runs === 1 ? quiet : fakeSay()).run(file, args, options);
  };
  const r = await get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 200, 'tried again in the folder made anew');
  assert.equal(runs, 2);
  assert.equal(lines.filter(l => /failed/.test(l)).length, 0);
  // With the folder in place, no file is `say`'s failure, as before.
  const quietOnly = fakeSay({ audio: () => null });
  say.run = quietOnly.run;
  const n = await jarvis('No file, folder there.');
  assert.equal((await get(`/api/chat/speech/${n.id}`)).status, 502);
  assert.equal(quietOnly.calls.length, 1, 'not tried a second time');
  assert.ok(lines.some(l => /failed \(failed\)$/.test(l)));
  // A render past its time limit is a timeout whatever became of the folder: `say` is
  // not given the same words and another 45 s.
  let slow = 0;
  say.run = async (file, args) => {
    if (args[0] === '-v') return LIST;
    slow++;
    await rm(dir, { recursive: true, force: true });
    throw Object.assign(new Error('killed'), { killed: true });
  };
  const late = await jarvis('Too slow, and the folder went.');
  assert.equal((await get(`/api/chat/speech/${late.id}`)).status, 504);
  assert.equal(slow, 1);
});

test('a failure of the server\'s own takes back that render\'s start and no other', async t => {
  const say = fakeSay();
  const { env, speech, get, jarvis, dir, lines } = await makeEnv(t, { say, speechOpts: { perWindow: 2, windowMs: 60e3 } });
  const ms = [];
  for (const text of ['First.', 'Second, never kept.', 'Third.', 'Fourth.', 'Fifth.']) ms.push(await jarvis(text));
  const ask = m => get(`/api/chat/speech/${m.id}`);
  assert.equal((await ask(ms[0])).status, 200);
  // The second can't be kept: a folder sits where its audio would go, so the move into
  // the cache fails after `say` has done its part. The server's trouble, not `say`'s.
  const name = `${createHash('sha256').update([CACHE_VERSION, 'Samantha', 'Second, never kept.'].join(String.fromCharCode(0))).digest('hex')}.m4a`;
  await mkdir(join(dir, name));
  await writeFile(join(dir, name, 'in the way'), 'x');
  env.clock.t += 50e3;
  say.hold();
  const second = ask(ms[1]);
  assert.ok(await until(() => say.calls.length === 2), 'the second render started');
  // While it is held its own start leaves the window (and the first's with it), and
  // the device starts a third, which waits its turn.
  env.clock.t += 61e3;
  const third = ask(ms[2]);
  assert.ok(await until(() => speech.waiting() === 1), 'the third waits');
  say.release();
  assert.equal((await second).status, 502);
  assert.equal((await third).status, 200);
  assert.equal(lines.filter(l => /failed/.test(l)).length, 1);
  assert.ok(!lines.some(l => /made it again/.test(l)), 'the folder was there all along');
  // The third's start still counts (the second's was already out of the window, so
  // there was nothing of its own to take back): one more fits, then the limit.
  assert.equal((await ask(ms[3])).status, 200);
  const over = await ask(ms[4]);
  assert.equal(over.status, 429);
  assert.match(JSON.parse(over.buf).error, /too many messages read aloud/);
});

test('a cache folder that can\'t be made again is a plain 502: no path in the answer or the log, nothing remembered, nothing charged', async t => {
  const say = fakeSay();
  const { env, get, jarvis, dir, lines } = await makeEnv(t, { say, speechOpts: { perWindow: 1, windowMs: 3600e3, perDay: 1 } });
  // A file where the folder was: it can't be made, and must not be used.
  await rm(dir, { recursive: true, force: true });
  await writeFile(dir, 'not a folder');
  const m = await jarvis('The folder is a file now.');
  for (let i = 0; i < 3; i++) {
    // A minute apart, so each failure has its own log line (the line is held to one a minute).
    env.clock.t += FAIL_LOG_MS;
    const r = await get(`/api/chat/speech/${m.id}`);
    assert.equal(r.status, 502, `ask ${i}`);
    assert.equal(JSON.parse(r.buf).error, 'the voice could not read this');
    assert.ok(!r.buf.toString().includes('/'), 'no path');
  }
  assert.equal(say.calls.length, 0, 'no process without a folder to work in');
  const failed = lines.filter(l => /failed/.test(l));
  assert.equal(failed.length, 3, 'each ask tried: the failure was not remembered');
  assert.match(failed[0], new RegExp(`^speech: a render of ${'The folder is a file now.'.length} characters for Test Phone failed \\((EEXIST|ENOTDIR|error)\\)$`));
  assert.ok(!lines.join('\n').includes(dir), 'no path in the log');
  assert.equal(lines.filter(l => /made it again/.test(l)).length, 0, 'not said to be made when it was not');
  // A link in its place is refused the same way, and what it points at is left alone.
  await rm(dir, { force: true });
  const elsewhere = join(dirname(dir), 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, dir);
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 502);
  assert.equal(say.calls.length, 0);
  assert.deepEqual(await readdir(elsewhere), []);
  // Put right, the same device reads at once: none of the four tries used up its one
  // render in the window, or the day's one.
  await rm(dir, { force: true });
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 200);
  assert.equal(say.calls.length, 1);
  const next = await jarvis('One too many.');
  assert.equal((await get(`/api/chat/speech/${next.id}`)).status, 429, 'and that one render was charged');
});

test('the log\'s "failed" line is written at most once a minute, and the next one says how many went unsaid', async t => {
  const say = fakeSay();
  const { env, get, jarvis, dir, lines } = await makeEnv(t, { say });
  // A file where the cache folder was: every ask fails as the server's own trouble,
  // which is not remembered, so each ask is a failure of its own.
  await rm(dir, { recursive: true, force: true });
  await writeFile(dir, 'not a folder');
  const m = await jarvis('Asked again and again.');
  const ask = async () => assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 502);
  const failed = () => lines.filter(l => /failed/.test(l));
  const LINE = `speech: a render of ${'Asked again and again.'.length} characters for Test Phone failed \\((?:EEXIST|ENOTDIR|error)\\)`;
  for (let i = 0; i < 3; i++) await ask();
  assert.equal(failed().length, 1, 'three failures in one moment, one line');
  assert.match(failed()[0], new RegExp(`^${LINE}$`));
  env.clock.t += FAIL_LOG_MS - 1;
  await ask();
  assert.equal(failed().length, 1, 'a millisecond short of the minute');
  env.clock.t += 1;
  await ask();
  assert.equal(failed().length, 2);
  assert.match(failed()[1], new RegExp(`^${LINE}; 3 more failed since the last such line$`));
  // The minute runs from the line just written.
  env.clock.t += FAIL_LOG_MS - 1;
  await ask();
  assert.equal(failed().length, 2);
  env.clock.t += 1;
  await ask();
  assert.match(failed()[2], new RegExp(`^${LINE}; 1 more failed since the last such line$`));
  // Nothing unsaid, nothing added.
  env.clock.t += FAIL_LOG_MS;
  await ask();
  assert.match(failed()[3], new RegExp(`^${LINE}$`));
  // A clock set back never holds the line; the minute then runs from the new time.
  env.clock.t -= 3600e3;
  await ask();
  assert.equal(failed().length, 5);
  await ask();
  env.clock.t += FAIL_LOG_MS - 1;
  await ask();
  assert.equal(failed().length, 5);
  env.clock.t += 1;
  await ask();
  assert.match(failed()[5], new RegExp(`^${LINE}; 2 more failed since the last such line$`));
  assert.equal(say.calls.length, 0);
});

test('the day\'s count never goes under zero: starts either side of midnight, both taken back, leave the new day its full limit and no more', async t => {
  // Half a minute to local midnight, whatever the zone.
  const start = new Date(2026, 10, 16, 23, 59, 30).getTime();
  const say = fakeSay();
  const { env, speech, get, jarvis, dir } = await makeEnv(t, { say, speechOpts: { perDay: 2 }, envOpts: { start } });
  const texts = ['Started before midnight, never kept.', 'Started after midnight, never kept.', 'Third.', 'Fourth.', 'Fifth.'];
  const ms = [];
  for (const text of texts) ms.push(await jarvis(text));
  const ask = m => get(`/api/chat/speech/${m.id}`);
  // Neither of the first two can be kept: a folder sits where each one's audio would
  // go, so the move into the cache fails after `say` has done its part. The server's
  // own trouble, so each start is taken back.
  for (const text of texts.slice(0, 2)) {
    const name = `${createHash('sha256').update([CACHE_VERSION, 'Samantha', text].join(String.fromCharCode(0))).digest('hex')}.m4a`;
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'in the way'), 'x');
  }
  say.hold();
  const first = ask(ms[0]);
  assert.ok(await until(() => say.calls.length === 1), 'the first render started, the day before');
  env.clock.t += 60e3;
  const second = ask(ms[1]);
  assert.ok(await until(() => speech.waiting() === 1), 'the second started in the new day, and waits its turn');
  say.release();
  assert.equal((await first).status, 502);
  assert.equal((await second).status, 502);
  // The new day: two renders, its limit, and the third is refused.
  assert.equal((await ask(ms[2])).status, 200);
  assert.equal((await ask(ms[3])).status, 200);
  const over = await ask(ms[4]);
  assert.equal(over.status, 429);
  assert.match(JSON.parse(over.buf).error, /read its fill for today/);
});

test('every device together may start so many renders in a local day; said once in the log; the next day starts over', async t => {
  // 23:00 local time, whatever the zone: an hour to midnight.
  const start = new Date(2026, 10, 16, 23, 0, 0).getTime();
  const { env, say, get, jarvis, lines } = await makeEnv(t, { speechOpts: { perDay: 3 }, envOpts: { start } });
  const ms = [];
  for (const text of ['One.', 'Two.', 'Three.', 'Four.', 'Five.']) ms.push(await jarvis(text));
  const other = await env.pair('Test Pad');
  const asOther = async id => { const r = await fetch(`http://127.0.0.1:${env.port}/api/chat/speech/${id}`, { headers: { cookie: other.cookie } }); return { status: r.status, retry: r.headers.get('retry-after'), body: Buffer.from(await r.arrayBuffer()) }; };
  assert.equal((await get(`/api/chat/speech/${ms[0].id}`)).status, 200);
  assert.equal((await asOther(ms[1].id)).status, 200);
  assert.equal((await get(`/api/chat/speech/${ms[2].id}`)).status, 200);
  assert.equal(lines.filter(l => /the day's limit/.test(l)).length, 0, 'at the limit, not past it');
  const r = await get(`/api/chat/speech/${ms[3].id}`);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '3600', 'until local midnight');
  assert.match(JSON.parse(r.buf).error, /read its fill for today/);
  const fromPad = await asOther(ms[4].id);
  assert.equal(fromPad.status, 429, 'whichever device asks');
  assert.equal(fromPad.retry, '3600');
  assert.equal(say.calls.length, 3);
  assert.deepEqual(lines.filter(l => /the day's limit/.test(l)), ['speech: 3 renders today, the day\'s limit; pages read in their own voice until midnight']);
  // What was made today still plays.
  assert.equal((await asOther(ms[0].id)).status, 200);
  // One second before midnight: still refused. At midnight: a new day.
  env.clock.t += 3599e3;
  const late = await get(`/api/chat/speech/${ms[3].id}`);
  assert.equal(late.status, 429);
  assert.equal(late.headers.get('retry-after'), '1');
  env.clock.t += 1e3;
  assert.equal((await get(`/api/chat/speech/${ms[3].id}`)).status, 200);
  assert.equal((await asOther(ms[4].id)).status, 200);
  assert.equal(say.calls.length, 5);
  assert.equal(lines.filter(l => /the day's limit/.test(l)).length, 1);
});

test('a device revoked while its render was under way gets nothing; the audio is still made', async t => {
  const say = fakeSay();
  const { env, get, jarvis, dev, dir } = await makeEnv(t, { say });
  const m = await jarvis('Rendered for a device that is gone by the end.');
  say.hold();
  const asked = get(`/api/chat/speech/${m.id}`);
  assert.ok(await until(() => say.calls.length === 1), 'the render started');
  await env.devices.revoke(dev.id, 'test');
  say.release();
  const r = await asked;
  assert.equal(r.status, 401);
  assert.ok(!r.buf.includes('ftyp'), 'no audio in the answer');
  assert.ok(await until(async () => (await audioFiles(dir)).length === 1), 'kept for the devices still paired');
  const other = await env.pair('Test Pad');
  const again = await fetch(`http://127.0.0.1:${env.port}/api/chat/speech/${m.id}`, { headers: { cookie: other.cookie } });
  assert.equal(again.status, 200);
  await again.arrayBuffer();
  assert.equal(say.calls.length, 1);
});

test('a render under way is joined before the cache is read, and looked for again after it: the same words are never rendered twice at once', async t => {
  const say = fakeSay();
  const { speech, get, jarvis, dir } = await makeEnv(t, { say });
  // Before the cache: while a render runs, a file under its own name is what a twin
  // render ending would leave. An ask that read the cache first would take that file
  // (and, a moment earlier, would have found nothing and rendered again); the ask joins
  // the render instead.
  const m = await jarvis('Under way.');
  const path = `/api/chat/speech/${m.id}`;
  say.hold();
  const first = get(path);
  assert.ok(await until(() => say.calls.length === 1), 'the render started');
  const name = `${createHash('sha256').update([CACHE_VERSION, 'Samantha', 'Under way.'].join(String.fromCharCode(0))).digest('hex')}.m4a`;
  await writeFile(join(dir, name), fakeAudio('planted'));
  const second = get(path);
  await pause(150);
  say.release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.ok(a.buf.includes('audio:Under way.') && b.buf.equals(a.buf), 'the second got the render it joined, not the file');
  assert.equal(say.calls.length, 1);
  assert.ok((await readFile(join(dir, name))).equals(a.buf), 'and the cache holds the render (the name is the one the module uses)');
  // After the cache: two asks in one tick both find no render and both miss the cache;
  // the one that comes back second finds the first's render and joins it.
  const twin = await jarvis('Twice in one tick.');
  const direct = () => { const res = { status: null, body: null, writeHead(code) { res.status = code; }, end(data) { res.body = data ?? null; } }; return res; };
  const ctx = { requireDevice: () => ({ id: 'direct', name: 'Direct' }) };
  const [r1, r2] = [direct(), direct()];
  await Promise.all([r1, r2].map(res => speech.handle({ method: 'GET', headers: {} }, res, `/api/chat/speech/${twin.id}`, ctx)));
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  assert.ok(r1.body.equals(r2.body));
  assert.equal(say.calls.length, 2, 'one render for the two');
});

test('audio over the size limit is refused and not kept; at the limit it is served', async t => {
  const size = fakeAudio('Just right.').length;
  const { say, get, jarvis, dir, lines } = await makeEnv(t, { speechOpts: { audioMaxBytes: size } });
  const fits = await jarvis('Just right.');
  assert.equal((await get(`/api/chat/speech/${fits.id}`)).status, 200);
  say.run = fakeSay({ audio: () => Buffer.concat([fakeAudio('Just right.'), Buffer.alloc(1)]) }).run;
  const over = await jarvis('One byte more.');
  const r = await get(`/api/chat/speech/${over.id}`);
  assert.equal(r.status, 413);
  assert.equal(JSON.parse(r.buf).error, 'the audio is too large');
  assert.equal((await audioFiles(dir)).length, 1);
  assert.ok(lines.some(l => /failed \(too large\)$/.test(l)));
});

test('a real process past its time limit is killed, even one that ignores a polite stop', async t => {
  const bin = await mkdtemp(join(tmpdir(), 'speech-slow-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const slow = join(bin, 'slow-say');
  // Answers the voice list at once; a render hangs, and SIGTERM is ignored.
  await writeFile(slow, '#!/bin/sh\nif [ "$1" = "-v" ]; then echo "Samantha            en_US    # Hello"; exit 0; fi\ntrap "" TERM\nexec /bin/sleep 30\n');
  await chmod(slow, 0o700);
  const { get, jarvis, dir } = await makeEnv(t, { speechOpts: { say: slow, run: undefined, timeoutMs: 300 } });
  const m = await jarvis('This one hangs.');
  const began = Date.now();
  const r = await get(`/api/chat/speech/${m.id}`);
  assert.equal(r.status, 504);
  assert.ok(Date.now() - began < 5000, 'ended by the limit, not the 30 s sleep');
  assert.deepEqual(await readdir(dir), []);
});

test('the cache: old audio goes, then the oldest until count and bytes fit; nothing else in the folder is touched', async t => {
  const { env, speech, dir, get, jarvis } = await makeEnv(t, { speechOpts: { cacheMaxAgeMs: 3600e3, cacheMaxFiles: 3, cacheMaxBytes: 250 } });
  const name = i => `${String(i).repeat(64)}.m4a`;
  const put = async (file, bytes, ageMs) => {
    await writeFile(join(dir, file), Buffer.alloc(bytes, 1));
    const at = new Date(env.clock.t - ageMs);
    await utimes(join(dir, file), at, at);
  };
  await put(name(1), 10, 3600e3 + 1000);  // past its age
  await put(name(2), 10, 3600e3 - 60e3);  // inside it, the oldest kept
  await put(name(3), 10, 30 * 60e3);
  await put(name(4), 10, 20 * 60e3);
  await put(name(5), 10, 10 * 60e3);
  await put('notes.txt', 10, 9 * 3600e3);
  await put(`${'a'.repeat(63)}.m4a`, 10, 9 * 3600e3);
  await put(`${'A'.repeat(64)}.m4a`, 10, 9 * 3600e3);
  await mkdir(join(dir, `${'b'.repeat(64)}.m4a`));
  const outside = join(dirname(dir), 'outside.m4a');
  await writeFile(outside, 'keep me');
  await symlink(outside, join(dir, name(6)));
  const old = new Date(env.clock.t - 9 * 3600e3);
  await utimes(join(dir, name(6)), old, old).catch(() => {});
  await mkdir(join(dir, 'work-abc123'));
  await writeFile(join(dir, 'work-abc123', 'in.txt'), 'left by a crash');
  await utimes(join(dir, 'work-abc123'), new Date(env.clock.t - WORK_MAX_AGE_MS - 1000), new Date(env.clock.t - WORK_MAX_AGE_MS - 1000));
  await mkdir(join(dir, 'work-fresh1'));
  await utimes(join(dir, 'work-fresh1'), new Date(env.clock.t - 60e3), new Date(env.clock.t - 60e3));
  assert.equal(await speech.sweep(), 2, 'the one past its age, and the oldest of four for the count of three');
  const kept = async () => (await readdir(dir)).sort();
  const others = ['notes.txt', `${'a'.repeat(63)}.m4a`, `${'A'.repeat(64)}.m4a`, `${'b'.repeat(64)}.m4a`, name(6), 'work-fresh1'];
  assert.deepEqual(await kept(), [name(3), name(4), name(5), ...others].sort());
  assert.equal(await readFile(outside, 'utf8'), 'keep me', 'a link is not followed');
  // Bytes: 3 x 10 fit in 250; a new 245-byte file pushes all three older ones out.
  await put(name(7), 245, 0);
  assert.equal(await speech.sweep(), 3);
  assert.deepEqual(await kept(), [name(7), ...others].sort());
  // A render sweeps too: the new audio stays and the big older file goes for the bytes.
  const m = await jarvis('Hello.');
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 200);
  const mineNow = async () => (await audioFiles(dir)).filter(n => !others.includes(n));
  assert.ok(await until(async () => (await mineNow()).length === 1), 'the sweep after the render ran');
  const left = await mineNow();
  assert.notEqual(left[0], name(7));
  // Playing a file makes it young again: 5 s before its age, played, then 6 s on.
  const stamp = new Date(env.clock.t - 3600e3 + 5000);
  await utimes(join(dir, left[0]), stamp, stamp);
  env.clock.t += 4000;
  assert.equal((await get(`/api/chat/speech/${m.id}`)).status, 200);
  // The mark is written without holding the answer up: wait for it (a play that left no mark never passes).
  assert.ok(await until(async () => (await lstat(join(dir, left[0]))).mtimeMs === env.clock.t), 'played, so marked used now');
  env.clock.t += 2000;
  assert.equal(await speech.sweep(), 0);
  assert.deepEqual((await audioFiles(dir)).filter(n => !others.includes(n)), left);
  env.clock.t += 3600e3;
  assert.equal(await speech.sweep(), 1, 'and an hour unplayed, it goes');
});

test('while it is on the cache is swept on a timer, played or not; the timer holds nothing up and stops', async t => {
  const root = await mkdtemp(join(tmpdir(), 'speech-timer-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dir = join(root, 'cache');
  const say = fakeSay();
  const sp = createSpeech({ store: { get: () => null }, dir, run: say.run, log: () => {}, sweepEveryMs: 30, cacheMaxAgeMs: 3600e3 });
  t.after(() => sp.stop());
  const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  const before = timers();
  await sp.start();
  await sp.refresh();
  assert.equal(timers(), before, 'the sweep\'s timer does not keep the process alive');
  const old = join(dir, `${'c'.repeat(64)}.m4a`);
  const put = async () => { await writeFile(old, 'x'); const at = new Date(Date.now() - 2 * 3600e3); await utimes(old, at, at); };
  await put();
  assert.ok(await until(() => !existsSync(old)), 'gone without a request or a render');
  // start() again adds no second timer, and stop() ends the one there is.
  await sp.start();
  assert.equal(timers(), before);
  sp.stop();
  await put();
  await pause(150);
  assert.ok(existsSync(old), 'no sweep once stopped');
  sp.stop();
});

test('off at start: the audio an earlier run cached goes, and nothing else does', async t => {
  const root = await mkdtemp(join(tmpdir(), 'speech-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(clearSpeechCache, speechConfig.clearSpeechCache, 'the one function, from the module the server loads at every start');
  assert.equal(await clearSpeechCache(join(root, 'none')), null, 'no folder: nothing to do');
  await writeFile(join(root, 'a-file'), 'x');
  assert.equal(await clearSpeechCache(join(root, 'a-file')), null);
  // Only audio and work folders: all go, and the folder with them.
  const only = join(root, 'only');
  await mkdir(join(only, 'work-abc123'), { recursive: true });
  await writeFile(join(only, 'work-abc123', 'in.txt'), 'words');
  await writeFile(join(only, `${'1'.repeat(64)}.m4a`), 'a');
  await writeFile(join(only, `${'2'.repeat(64)}.m4a`), 'b');
  assert.deepEqual(await clearSpeechCache(only), { removed: 3, left: 0 });
  assert.ok(!existsSync(only));
  // Anything else stays, and so does the folder.
  const mixed = join(root, 'mixed');
  await mkdir(mixed);
  await writeFile(join(mixed, `${'3'.repeat(64)}.m4a`), 'c');
  await writeFile(join(mixed, 'notes.txt'), 'keep');
  await writeFile(join(mixed, `${'4'.repeat(63)}.m4a`), 'keep');
  await mkdir(join(mixed, `${'5'.repeat(64)}.m4a`));
  await mkdir(join(mixed, 'work-toolong1'));
  await writeFile(join(mixed, 'work-file01'), 'a file, not a work folder');
  const outside = join(root, 'outside.m4a');
  await writeFile(outside, 'keep me');
  await symlink(outside, join(mixed, `${'6'.repeat(64)}.m4a`));
  await symlink(root, join(mixed, 'work-linked'));
  assert.deepEqual(await clearSpeechCache(mixed), { removed: 1, left: 7 });
  assert.deepEqual((await readdir(mixed)).sort(), ['notes.txt', `${'4'.repeat(63)}.m4a`, `${'5'.repeat(64)}.m4a`, `${'6'.repeat(64)}.m4a`, 'work-file01', 'work-linked', 'work-toolong1'].sort());
  assert.equal(await readFile(outside, 'utf8'), 'keep me');
  // A link where the folder should be is left alone, and what it points at too.
  const target = join(root, 'target');
  await mkdir(target);
  await writeFile(join(target, `${'7'.repeat(64)}.m4a`), 'd');
  await symlink(target, join(root, 'linked'));
  assert.equal(await clearSpeechCache(join(root, 'linked')), null);
  assert.equal((await readdir(target)).length, 1);
});

test('the cache folder must be a real folder: a link in its place keeps speech off', async t => {
  const root = await mkdtemp(join(tmpdir(), 'speech-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'elsewhere'));
  await writeFile(join(root, 'a-file'), 'x');
  const say = fakeSay();
  const viaFile = createSpeech({ store: { get: () => null }, dir: join(root, 'a-file'), run: say.run, log: () => {} });
  await assert.rejects(viaFile.start());
  assert.equal(viaFile.info(), null);
  await symlink(join(root, 'elsewhere'), join(root, 'linked'));
  const viaLink = createSpeech({ store: { get: () => null }, dir: join(root, 'linked'), run: say.run, log: () => {} });
  await assert.rejects(viaLink.start(), /not a folder/);
  assert.equal(viaLink.info(), null);
  assert.deepEqual(await readdir(join(root, 'elsewhere')), []);
  assert.throws(() => createSpeech({ store: { get: () => null }, dir: '' }), /needs dir/);
  // A folder that was there with wider bits is made private.
  await mkdir(join(root, 'wide'), { mode: 0o755 });
  await chmod(join(root, 'wide'), 0o755);
  const wide = createSpeech({ store: { get: () => null }, dir: join(root, 'wide'), run: say.run, log: () => {} });
  t.after(() => wide.stop());
  await wide.start();
  assert.equal((await lstat(join(root, 'wide'))).mode & 0o777, 0o700);
});

// The files a module imports, as written: static imports and re-exports, and dynamic
// import() calls apart. Comments are dropped first.
const SERVER = join(HERE, '..');
const REPO = join(SERVER, '..');
async function importsOf(file) {
  const src = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fixed = [...src.matchAll(/^\s*(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm), ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
  const lazy = [...src.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)].map(m => m[1].trim());
  return { fixed, lazy };
}
// Every file reached from `entry` through static relative imports, as paths from the repo's root.
async function staticGraph(entry) {
  const seen = new Set();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of (await importsOf(file)).fixed) if (spec.startsWith('.')) todo.push(resolve(dirname(file), spec));
  }
  return [...seen].map(f => relative(REPO, f)).sort();
}
const PAGE_FILES = ['web/src/lib/orbit/markdown.js', 'web/src/lib/orbit/speech.js'];

test('the import reader these tests lean on sees every spelling of an import', async t => {
  const root = await mkdtemp(join(tmpdir(), 'speech-imports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'sample.mjs');
  await writeFile(file, [
    "import a from './a.js';", "import { b,", "  c } from \"./b.js\";", "import './c.js';", "export { d } from './d.js';", "export * from 'node:path';",
    "// import z from './commented.js';", "/* import('./commented-too.js') */",
    "const one = () => import('./e.js');", "const two = () => import ('./f.js');", "const three = () => import\n  ( './g.js' );", "const four = await import(`./h.js`);"
  ].join('\n'));
  const { fixed, lazy } = await importsOf(file);
  assert.deepEqual(fixed.sort(), ['./a.js', './b.js', './c.js', './d.js', 'node:path']);
  assert.deepEqual(lazy, ["'./e.js'", "'./f.js'", "'./g.js'", '`./h.js`']);
});

test('server.mjs: speech is loaded only when config turns it on, in a try/catch; kept under the state folder; handed to the chat routes', async () => {
  const src = (await readFile(join(SERVER, 'server.mjs'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  const wired = [
    [/const speechSettings = readSpeechConfig\(config\);/, 'config is checked'],
    [/import \{ readSpeechConfig, clearSpeechCache, SAY \} from '\.\/lib\/chat-speech-config\.mjs';/, 'what every start needs comes from the module with no page code'],
    [/else if \(speechSettings\.on\) \{\s*const speechOffPath = join\(stateDir, 'speech-off'\);\s*try \{\s*const \{ createSpeech \} = await import\('\.\/lib\/chat-speech\.mjs'\);/, 'the module is loaded inside the try, and only when config turns speech on'],
    [/createSpeech\(\{\s*store: chatStore,\s*dir: speechCachePath,\s*voice: speechSettings\.voice,\s*fallback: speechSettings\.fallback,\s*killed: \(\) => existsSync\(speechOffPath\)\s*\}\)/, 'the chat\'s own store, the cache folder, config\'s voice, the kill file'],
    [/const speechCachePath = join\(stateDir, 'speech-cache'\);/, 'the cache under the 0700 state folder'],
    [/await made\.start\(\);\s*speech = made;\s*console\.log\(`speech: on, [^\n]*\n\s*\} catch \(err\) \{ console\.error\(`speech: could not be loaded or started \(\$\{err\?\.code \?\? err\?\.name \?\? 'error'\}\); read aloud on the Mac stays off`\); \}/, 'a failure to load or start is one line, and speech stays off'],
    [/if \(speech === null\) \{\s*const cleared = await clearSpeechCache\(speechCachePath\)\.catch\(\(\) => null\);/, 'off at start, the old audio goes'],
    [/createChatRoutes\(\{[^}]*\bspeech\b[^}]*\}\);/, 'behind the chat router']
  ];
  for (const [re, what] of wired) assert.ok(re.test(src), what);
  const { fixed, lazy } = await importsOf(join(SERVER, 'server.mjs'));
  assert.ok(!fixed.some(f => f.includes('chat-speech.mjs')), 'never a static import of the module that loads page code');
  assert.deepEqual(lazy.filter(l => l.includes('speech')), ["'./lib/chat-speech.mjs'"], 'one dynamic import, of a fixed path');
});

test('what the server loads of the page: nothing at a plain start, and exactly two files once speech is on', async () => {
  // A start with speech off: the whole static graph of server.mjs stays under server/.
  const plain = await staticGraph(join(SERVER, 'server.mjs'));
  assert.ok(plain.length > 40, `${plain.length} files`);
  assert.ok(plain.includes('server/lib/chat-speech-config.mjs'));
  assert.ok(!plain.includes('server/lib/chat-speech.mjs'));
  assert.deepEqual(plain.filter(f => !f.startsWith('server/')), [], 'no page code can stop the server\'s start');
  assert.deepEqual((await importsOf(join(SERVER, 'lib', 'chat-speech-config.mjs'))).fixed.sort(), ['node:fs/promises', 'node:path']);
  // With speech on: chat-speech.mjs reaches into web/ for the two files, and no further.
  const on = await staticGraph(join(SERVER, 'lib', 'chat-speech.mjs'));
  assert.deepEqual(on.filter(f => !f.startsWith('server/')), PAGE_FILES);
  // Loop 3's restart card counts a change to each of them as server code (board 2703904f).
  assert.deepEqual(SERVER_PATHS.filter(p => p !== 'server').sort(), on.filter(f => !f.startsWith('server/')), 'SERVER_PATHS names every page file the server runs');
  assert.deepEqual((await importsOf(join(SERVER, 'lib', 'chat-speech.mjs'))).fixed.filter(f => f.includes('web/')), ['../../web/src/lib/orbit/speech.js']);
  // The two page files import each other and nothing else: no package, no node module, nothing loaded later.
  assert.deepEqual((await importsOf(join(REPO, 'web/src/lib/orbit/speech.js'))), { fixed: ['./markdown.js'], lazy: [] });
  assert.deepEqual((await importsOf(join(REPO, 'web/src/lib/orbit/markdown.js'))), { fixed: [], lazy: [] });
  assert.deepEqual((await importsOf(join(SERVER, 'lib', 'chat-speech.mjs'))).lazy, []);
});

test('the module and the two page files it runs start no shell, read no environment and reach for nothing outside', async () => {
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lib = strip(await readFile(join(SERVER, 'lib', 'chat-speech.mjs'), 'utf8'));
  const NO_SHELL = /shell\s*:|(?<![.\w])exec\(|\bexecSync\(|\bspawn\(|\bspawnSync\(|process\.env/;
  assert.ok(!NO_SHELL.test(lib), 'execFile only, with no shell and none of the server\'s environment');
  assert.equal(lib.match(/\brun\(say, /g).length, 2, 'two calls of say: the list and the render');
  assert.ok(!NO_SHELL.test(strip(await readFile(join(SERVER, 'lib', 'chat-speech-config.mjs'), 'utf8'))));
  // The page files run inside the server: the same rules, and none of the things a
  // server file could do that a text function has no business doing.
  for (const file of PAGE_FILES) {
    const page = strip(await readFile(join(REPO, file), 'utf8'));
    assert.ok(!NO_SHELL.test(page), `${file}: no process, no environment`);
    assert.ok(!/\bprocess\b|\brequire\(|\bchild_process\b|['"`]node:|\beval\(|new Function\b|\bglobalThis\b|\bfetch\(|\bXMLHttpRequest\b|\bWebSocket\b|import\.meta/.test(page), `${file}: nothing of Node's, nothing evaluated, nothing fetched`);
  }
});

test('the real say, where there is one: a short reply becomes an MPEG-4 audio file', { skip: process.platform !== 'darwin' || !existsSync(SAY) ? 'no /usr/bin/say here' : false }, async t => {
  const lines = [];
  let env = null;
  const cache = await mkdtemp(join(tmpdir(), 'speech-real-'));
  const speech = createSpeech({ store: { get: id => env.store.get(id) }, dir: join(cache, 'c'), voice: 'No Such Voice Anywhere', log: l => lines.push(l) });
  env = await makeChatEnv({ routes: { speech } });
  t.after(async () => { speech.stop(); await env.close(); await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await speech.start();
  const which = await speech.refresh();
  if (which === null) { t.skip('neither built-in voice is installed here'); return; }
  assert.equal(which.exact, false);
  assert.ok(BUILT_IN_VOICES.includes(voiceBase(which.voice)), which.voice);
  const dev = await env.pair('Test Phone');
  // Three ways to ask the voice for a minute of silence: its own command, the same in
  // fullwidth brackets, and a tag. Each obeyed would add well over 200 KB; with the
  // brackets taken out they are a few words.
  const text = `This is a **test** of [[slnc 60000]] the voice, ${cp(0xff3b, 0xff3b)}slnc 60000${cp(0xff3d, 0xff3d)} and <break time="60s"/> done.`;
  const m = await env.store.append({ from: 'jarvis', kind: 'chat', text });
  const r = await fetch(`http://127.0.0.1:${env.port}/api/chat/speech/${m.id}`, { headers: { cookie: dev.cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.equal(buf.toString('latin1', 4, 8), 'ftyp');
  assert.ok(buf.length > 2000, 'more than a header');
  assert.ok(buf.length < 150 * 1024, `${buf.length} bytes`);
});
