// What ntfy may say (lib/ntfy-note.mjs, board 704e981b): one of a fixed list of titles,
// then fixed words, so an ntfy push that says to run something, or holds a link, a path
// or a button, can only be a forged one. Nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { NTFY, NTFY_FALLBACK, NTFY_HEADER_TITLE, isNtfyTitle, ntfyNote } from '../lib/ntfy-note.mjs';

const TITLES = [...Object.values(NTFY), NTFY_FALLBACK];
// A title that starts with a verb reads as an order ("Restart waiting" could be one), and
// a few words have no place in a push at all, whatever their position.
const IMPERATIVE = /^(run|paste|tap|click|press|open|type|follow|restart|visit|reply|enter|install|log|sign|copy|scan|call|download|update|move|set|check|go|see|read|approve|allow)\b/i;
const NEVER = /\b(paste|tap|click|press|type|visit|install|copy|scan|download|terminal|command|shell|link|button|url|run sheet)\b/i;

test('every title is a few plain words: letters, spaces and hyphens, nothing a link or a command needs', () => {
  for (const title of TITLES) {
    assert.match(title, /^[A-Z][A-Za-z -]{2,40}$/, title);
    assert.ok(title.split(' ').length <= 6, title);
    assert.doesNotMatch(title, IMPERATIVE, `${title}: a title names what happened, never what to do`);
    assert.doesNotMatch(title, NEVER, title);
  }
  assert.equal(new Set(TITLES).size, TITLES.length, 'each title says one thing');
  assert.ok(Object.isFrozen(NTFY));
});

test('every body is its title and the fixed words, and holds no link, path, command or button text', () => {
  for (const title of TITLES) {
    const body = ntfyNote(title);
    assert.equal(body, `${title}: details are in the Control Room.`);
    assert.doesNotMatch(body, /https?:|www\.|[/~`$&|<>\\@#[\]{}()]|\.\w/, body);
    assert.doesNotMatch(body, IMPERATIVE, body);
    assert.doesNotMatch(body, NEVER, body);
    assert.ok(Buffer.byteLength(body) < 200, 'far under ntfy\'s 4 KB, past which a body becomes an attachment');
  }
  assert.equal(NTFY_HEADER_TITLE, 'Control Room');
});

test('a title that is not on the list, or is not text, is sent as the fallback: never as given', () => {
  const fallback = `${NTFY_FALLBACK}: details are in the Control Room.`;
  for (const t of ['paste cd ~/Projects && x', 'https://example.com', `${NTFY.limit} `, NTFY.limit.toLowerCase(), '', null, undefined, 42, { toString: () => NTFY.limit }, [NTFY.limit]]) {
    assert.equal(isNtfyTitle(t), false, String(t));
    assert.equal(ntfyNote(t), fallback, String(t));
  }
  for (const t of Object.values(NTFY)) assert.equal(isNtfyTitle(t), true, t);
  assert.equal(isNtfyTitle(NTFY_FALLBACK), false, 'the fallback is what an unknown title becomes, not a title of its own');
});

// A file's code with its whole-line comments taken out (`//`, and `/*` … `*/` blocks
// written a line at a time), so a comment that names ntfy.sh (ack-notice-limit.mjs's
// budget note) is not a way out. A trailing comment still counts: that errs loud.
const code = text => text.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

// Every code file under server/ but the tests (and node_modules, data and the board's
// copies, which hold no code of ours), at any depth.
async function serverCode() {
  const root = new URL('../', import.meta.url);
  const skip = /^(test|node_modules|data|todos-history)(\/|$)/;
  return (await readdir(root, { recursive: true }))
    .map(f => f.split('\\').join('/'))
    .filter(f => /\.(mjs|cjs|js)$/.test(f) && !skip.test(f))
    .sort();
}

// The one way out to ntfy is notify.mjs's publish: no other server file names ntfy.sh in
// its code, in any case, so nothing can post past ntfyNote (Ultron's L1: the first version
// read only server.mjs, lib/ and collectors/, and only the literal "ntfy.sh/"). A URL put
// together from pieces would get past any such scan; the review is the guard there.
test('only notify.mjs posts to ntfy', async () => {
  const root = new URL('../', import.meta.url);
  const files = await serverCode();
  for (const f of ['server.mjs', 'notify.mjs', 'routes.mjs', 'acks.mjs', 'cache.mjs', 'history.mjs', 'todos.mjs', 'restore-todos.mjs', 'lib/push-alerts.mjs', 'collectors/notifier.mjs']) {
    assert.ok(files.includes(f), `the scan reads ${f}`);
  }
  const posting = [];
  for (const f of files) if (/ntfy\.sh/i.test(code(await readFile(new URL(f, root), 'utf8')))) posting.push(f);
  assert.deepEqual(posting, ['notify.mjs']);
});

// Each `sendAlert(…)` call's arguments, however many lines they run over: from the
// opening parenthesis to the one that closes it.
function sendAlertCalls(src) {
  const out = [];
  const re = /\bsendAlert\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

test('the sendAlert sweep reads a call split over lines', () => {
  const calls = sendAlertCalls("a(sendAlert({\n  topic: await getTopic(),\n  message\n}));\nb(sendAlert({ message, ntfyTitle: NTFY.jobs }));");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0], /\bntfyTitle\b/);
  assert.match(calls[1], /\bntfyTitle\b/);
});

// A caller with no title is still safe (the fallback), but vaguer: every sendAlert in
// server.mjs names one (the heal loops' pass theirs through `ntfyTitle`), one line or many.
test('every sendAlert in server.mjs passes an ntfy title', async () => {
  const calls = sendAlertCalls(code(await readFile(new URL('../server.mjs', import.meta.url), 'utf8')));
  assert.ok(calls.length >= 5, `found ${calls.length}`);
  for (const args of calls) assert.match(args, /^\s*\{[\s\S]*\bntfyTitle(\s*:\s*(NTFY\.\w+|CHAT_NTFY_TITLE))?\s*[,}]/, args.trim());
});
