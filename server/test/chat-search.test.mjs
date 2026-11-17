// Chat search (lib/chat-search.mjs and GET /api/chat/search in lib/chat-routes.mjs):
// the query rules, what is searched (message text of chat and event lines only, never
// attachments, approvals or notices), the snippet and its marks, the limits, and the
// route's read rule (a paired device, with the owner's login when configured, the
// same as /api/feed). Every message and name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSearchQuery, searchMessages, searchAnswer, foldText,
  SEARCH_Q_MIN, SEARCH_Q_MAX, SEARCH_TERMS_MAX, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_SCAN_MAX, SNIPPET_CHARS, SNIPPET_BEFORE
} from '../lib/chat-search.mjs';
import { makeChatEnv } from './helpers/chat-env.mjs';

let n = 0;
const msg = (text, extra = {}) => { n++; return { seq: n, id: `m_${String(n).padStart(6, '0')}`, at: 1794380000000 + n * 1000, from: 'jarvis', kind: 'chat', text, ...extra }; };

test('the limits are what the docs say', () => {
  assert.equal(SEARCH_Q_MIN, 2);
  assert.equal(SEARCH_Q_MAX, 100);
  assert.equal(SEARCH_TERMS_MAX, 8);
  assert.equal(SEARCH_LIMIT_DEFAULT, 20);
  assert.equal(SEARCH_LIMIT_MAX, 50);
  assert.equal(SEARCH_SCAN_MAX, 20000);
});

test('a query: trimmed, at least 2 and at most 100 characters, at most 8 distinct words, folded to lower case with plain quotes', () => {
  assert.deepEqual(parseSearchQuery('  Backup  failed '), { ok: true, terms: ['backup', 'failed'] });
  assert.deepEqual(parseSearchQuery('Ann\u2019s \u201cplan\u201d'), { ok: true, terms: ["ann's", '"plan"'] });
  assert.deepEqual(parseSearchQuery('ab'), { ok: true, terms: ['ab'] });
  assert.deepEqual(parseSearchQuery('a a A'), { ok: true, terms: ['a'] }, 'the same word twice counts once');
  assert.equal(parseSearchQuery(undefined).ok, false);
  assert.equal(parseSearchQuery(null).ok, false);
  assert.equal(parseSearchQuery('').ok, false);
  assert.equal(parseSearchQuery(' a ').ok, false, 'one character after trimming');
  assert.match(parseSearchQuery('a').error, /at least 2/);
  assert.equal(parseSearchQuery('x'.repeat(100)).ok, true);
  assert.equal(parseSearchQuery('x'.repeat(101)).ok, false);
  assert.match(parseSearchQuery('x'.repeat(101)).error, /at most 100/);
  assert.equal(parseSearchQuery('a b c d e f g h').ok, true);
  assert.equal(parseSearchQuery('a b c d e f g h i').ok, false);
  assert.match(parseSearchQuery('a b c d e f g h i').error, /at most 8 words/);
  // A single emoji is two UTF-16 units but one character: still too short.
  assert.equal(parseSearchQuery(String.fromCodePoint(0x1f600)).ok, false);
});

test('foldText keeps every folded position pointing at its original character, even where lower case is longer', () => {
  const plain = foldText('Hello World');
  assert.equal(plain.folded, 'hello world');
  assert.equal(plain.at(6), 6);
  const curly = foldText('It\u2019s');
  assert.equal(curly.folded, "it's");
  // U+0130 (capital I with dot) lowers to two units: positions after it shift by one.
  const longer = foldText(`${String.fromCodePoint(0x130)}stanbul trip`);
  assert.equal(longer.folded.length, 'istanbul trip'.length + 1);
  const at = longer.folded.indexOf('trip');
  assert.equal(longer.at(at), 9, 'trip starts at index 9 of the original');
  assert.equal(longer.at(at + 4), 13, 'and ends at its end');
});

test('every word must appear, in any case; newest first; only chat and event lines; never attachments, approvals, verdicts or notices', () => {
  n = 0;
  const list = [
    msg('The nightly backup failed at 02:00'),
    msg('backup ok', { from: 'jeff' }),
    msg('Backup FAILED again', { kind: 'event', from: 'system' }),
    msg('please allow rm backup failed', { kind: 'permission' }),
    msg('backup failed', { kind: 'verdict', from: 'jeff' }),
    msg('backup failed', { kind: 'notice', from: 'system' }),
    msg('here is the photo', { attachments: [{ id: 'a'.repeat(32), name: 'backup failed.png', type: 'image/png', bytes: 9 }] }),
    msg(null),
    msg('Failed: the backup')
  ];
  const r = searchMessages(list, ['backup', 'failed'], { limit: 10 });
  assert.deepEqual(r.results.map(x => x.seq), [9, 3, 1]);
  assert.equal(r.more, false);
  assert.deepEqual(Object.keys(r.results[0]).sort(), ['at', 'cutEnd', 'cutStart', 'from', 'id', 'kind', 'marks', 'seq', 'snippet']);
  assert.equal(r.results[1].kind, 'event');
  assert.equal(r.results[1].from, 'system');
  assert.deepEqual(searchMessages(list, ['backup', 'ok'], { limit: 10 }).results.map(x => x.seq), [2], 'the owner\'s own messages too');
  assert.deepEqual(searchMessages(list, ['photo'], { limit: 10 }).results.map(x => x.seq), [7]);
  assert.deepEqual(searchMessages(list, ['png'], { limit: 10 }).results, [], 'an attachment name is not message text');
  assert.deepEqual(searchMessages(list, ['allow'], { limit: 10 }).results, [], 'an approval request is not searched');
});

test('the limit stops the scan and says there is more', () => {
  n = 0;
  const list = Array.from({ length: 7 }, (_, i) => msg(`deploy number ${i + 1}`));
  const r = searchMessages(list, ['deploy'], { limit: 3 });
  assert.deepEqual(r.results.map(x => x.seq), [7, 6, 5]);
  assert.equal(r.more, true);
  const all = searchMessages(list, ['deploy'], { limit: 7 });
  assert.equal(all.results.length, 7);
  assert.equal(all.more, false, 'exactly the limit: nothing more');
});

test('the snippet: a window around the first match, whitespace made spaces, marks on every word inside it, cut flags', () => {
  n = 0;
  const long = `${'a'.repeat(300)} needle\nhere ${'b'.repeat(300)}`;
  const [r] = searchMessages([msg(long)], ['needle', 'here'], { limit: 1 }).results;
  assert.equal(r.snippet.length, SNIPPET_CHARS);
  assert.equal(r.cutStart, true);
  assert.equal(r.cutEnd, true);
  assert.equal(r.snippet.indexOf('needle'), SNIPPET_BEFORE, 'the first match sits 60 characters in');
  assert.ok(!/\n/.test(r.snippet), 'no line breaks in a snippet');
  assert.deepEqual(r.marks, [[SNIPPET_BEFORE, SNIPPET_BEFORE + 6], [SNIPPET_BEFORE + 7, SNIPPET_BEFORE + 11]]);
  for (const [s, e] of r.marks) assert.equal(r.snippet.slice(s, e).toLowerCase().trim().length, e - s);

  const [short] = searchMessages([msg('Short Note about the Deploy')], ['deploy', 'note'], { limit: 1 }).results;
  assert.equal(short.snippet, 'Short Note about the Deploy');
  assert.equal(short.cutStart, false);
  assert.equal(short.cutEnd, false);
  assert.deepEqual(short.marks, [[6, 10], [21, 27]], 'sorted by position, whatever the word order');

  // A match near the end still gets a full-size window, moved back.
  const [end] = searchMessages([msg(`${'c'.repeat(400)} tail`)], ['tail'], { limit: 1 }).results;
  assert.equal(end.snippet.length, SNIPPET_CHARS);
  assert.ok(end.snippet.endsWith(' tail'));
  assert.equal(end.cutEnd, false);

  // Overlapping words make one mark; repeats are each marked.
  const [over] = searchMessages([msg('abcabc')], ['abc', 'bca'], { limit: 1 }).results;
  assert.deepEqual(over.marks, [[0, 6]]);
  const [inner] = searchMessages([msg('abcd')], ['abcd', 'bc'], { limit: 1 }).results;
  assert.deepEqual(inner.marks, [[0, 4]], 'a word inside another keeps the outer end');
  const [touch] = searchMessages([msg('abcabc')], ['abc'], { limit: 1 }).results;
  assert.deepEqual(touch.marks, [[0, 6]], 'touching marks join too');

  // A word that appears again past the window is marked only inside it; one that runs
  // over the window's end is cut there.
  const [inside] = searchMessages([msg(`${'a'.repeat(300)} needle here ${'b'.repeat(300)} here needle`)], ['needle', 'here'], { limit: 1 }).results;
  assert.ok(inside.marks.every(([s, e]) => s >= 0 && e <= inside.snippet.length && s < e), JSON.stringify(inside.marks));
  assert.deepEqual(inside.marks.map(([s, e]) => inside.snippet.slice(s, e)), ['needle', 'here']);
  const [edge] = searchMessages([msg(`${'a'.repeat(300)} cut${' '.repeat(116)}cutting`)], ['cut'], { limit: 1 }).results;
  assert.equal(edge.snippet.length, SNIPPET_CHARS);
  assert.deepEqual(edge.marks, [[SNIPPET_BEFORE, SNIPPET_BEFORE + 3], [SNIPPET_CHARS - 1, SNIPPET_CHARS]], 'the second one cut at the end');
});

test('a snippet never cuts a character in half', () => {
  n = 0;
  const smile = String.fromCodePoint(0x1f600);
  // The dots move the window's ends onto either half of a pair, at the start and the end.
  let widened = 0;
  for (const a of ['', '.']) {
    for (const b of ['', '.', '..']) {
      for (let pad = 50; pad < 54; pad++) {
        const text = `${smile.repeat(pad)}${a}find${b}${smile.repeat(200)}`;
        const [r] = searchMessages([msg(text)], ['find'], { limit: 1 }).results;
        assert.equal(r.snippet, r.snippet.toWellFormed(), `pad ${pad} a "${a}" b "${b}"`);
        if (r.snippet.length > SNIPPET_CHARS) widened++;
        const [s, e] = r.marks[0];
        assert.equal(r.snippet.slice(s, e), 'find');
      }
    }
  }
  assert.ok(widened > 0, 'some windows did fall on a pair');
});

test('marks keep pointing at the right characters when lower case is longer', () => {
  n = 0;
  const [r] = searchMessages([msg(`${String.fromCodePoint(0x130)}stanbul Trip`)], ['trip'], { limit: 1 }).results;
  const [s, e] = r.marks[0];
  assert.equal(r.snippet.slice(s, e), 'Trip');
});

test('searchAnswer: reads at most the newest 20,000 messages, clamps the limit, refuses a bad query, and says what it searched', () => {
  n = 0;
  const list = Array.from({ length: 60 }, (_, i) => msg(`item ${i}`));
  const asked = [];
  const store = { newest: k => { asked.push(k); return list.slice(-k); }, size: 60, seq: 60, epoch: 'e-test' };
  const q = s => new URLSearchParams(s);
  const a = searchAnswer(store, q('q=item'));
  assert.deepEqual(asked, [SEARCH_SCAN_MAX]);
  assert.equal(a.results.length, SEARCH_LIMIT_DEFAULT);
  assert.equal(a.more, true);
  assert.equal(a.scanned, 60);
  assert.equal(a.truncated, false);
  assert.equal(a.seq, 60);
  assert.equal(a.epoch, 'e-test');
  assert.equal(searchAnswer(store, q('q=item&limit=5')).results.length, 5);
  assert.equal(searchAnswer(store, q('q=item&limit=500')).results.length, 50, 'clamped to 50');
  assert.equal(searchAnswer(store, q('q=item&limit=0')).results.length, 1);
  assert.equal(searchAnswer(store, q('q=item&limit=x')).results.length, SEARCH_LIMIT_DEFAULT);
  // A smaller cap, as the route could be given: the oldest are left out and it says so.
  const capped = searchAnswer(store, q('q=item&limit=50'), { scanMax: 10 });
  assert.equal(capped.scanned, 10);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.results.map(x => x.seq), [60, 59, 58, 57, 56, 55, 54, 53, 52, 51]);
  for (const bad of ['', 'q=', 'q=a', `q=${'x'.repeat(101)}`, 'q=a+b+c+d+e+f+g+h+i']) {
    assert.throws(() => searchAnswer(store, q(bad)), err => err.status === 400, bad);
  }
});

test('GET /api/chat/search: 401 for an unpaired device, 403 without the owner\'s login, 400 for a bad query, else the answer, never cached', async () => {
  const env = await makeChatEnv({ routes: { config: { chat: { login: 'owner@example.test' } } } });
  try {
    const login = { 'tailscale-user-login': 'owner@example.test' };
    await env.store.append({ from: 'jarvis', kind: 'chat', text: 'The *backup* ran fine' });
    await env.store.append({ from: 'jeff', kind: 'chat', text: 'thanks, backup noted', device: 'Phone', state: 'queued' });
    await env.store.append({ from: 'system', kind: 'notice', text: 'backup restarted' });
    const dev = await env.pair('Phone');
    const path = '/api/chat/search?q=backup';

    const anon = await env.call({ path, headers: login });
    assert.equal(anon.status, 401);
    const noLogin = await env.call({ path, headers: { cookie: dev.cookie } });
    assert.equal(noLogin.status, 403);
    const otherLogin = await env.call({ path, headers: { cookie: dev.cookie, 'tailscale-user-login': 'someone@example.test' } });
    assert.equal(otherLogin.status, 403);

    const ok = await env.call({ path, headers: { cookie: dev.cookie, ...login } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(ok.json.results.map(r => [r.seq, r.from]), [[2, 'jeff'], [1, 'jarvis']]);
    assert.equal(ok.json.results[1].snippet, 'The *backup* ran fine', 'the raw text, for the page to show as plain text');
    assert.equal(ok.json.more, false);
    assert.equal(ok.json.scanned, 3);
    assert.equal(ok.json.truncated, false);
    assert.equal(ok.json.seq, env.store.seq);
    assert.equal(ok.json.epoch, env.store.epoch);

    const short = await env.call({ path: '/api/chat/search?q=b', headers: { cookie: dev.cookie, ...login } });
    assert.equal(short.status, 400);
    assert.match(short.json.error, /at least 2/);
    const missing = await env.call({ path: '/api/chat/search', headers: { cookie: dev.cookie, ...login } });
    assert.equal(missing.status, 400);

    const post = await env.call({ method: 'POST', path, headers: { cookie: dev.cookie, ...login }, body: {} });
    assert.equal(post.status, 404, 'read-only: no other method');

    await env.devices.revoke(dev.id, 'test');
    const revoked = await env.call({ path, headers: { cookie: dev.cookie, ...login } });
    assert.equal(revoked.status, 401);
  } finally {
    await env.close();
  }
});

test('the store hands the search its newest messages, oldest first', async () => {
  const env = await makeChatEnv();
  try {
    for (let i = 1; i <= 5; i++) await env.store.append({ from: 'jarvis', kind: 'chat', text: `m${i}` });
    assert.deepEqual(env.store.newest(3).map(m => m.text), ['m3', 'm4', 'm5']);
    assert.equal(env.store.newest(10).length, 5);
    assert.deepEqual(env.store.newest(0), []);
    const copy = env.store.newest(5);
    copy.pop();
    assert.equal(env.store.newest(5).length, 5, 'a copy: the caller can\'t change the store');
  } finally {
    await env.close();
  }
});
