// The Feed (Jarvis OS Phase 2): the lead's discord-post keeps each post it sends in
// <feed dir>/<agent>.jsonl, and lib/feed.mjs reads those files, read-only, for
// GET /api/feed. Every agent key, title and text here is invented; nothing reads
// the real feed folder or touches :8322.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, chmod, symlink, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedReader, readFeedConfig, DEFAULT_FEED_DIR, PER_AGENT, TEXT_MAX, TITLE_MAX, LINE_MAX, READ_MAX, TOTAL_TEXT_MAX, FUTURE_SLACK_MS } from '../lib/feed.mjs';
import { link } from 'node:fs/promises';
import { createFeedRoutes } from '../lib/feed-routes.mjs';
import { makeChatEnv } from './helpers/chat-env.mjs';

const KEYS = ['lead', 'builder', 'scout'];
const T0 = Date.parse('2026-11-09T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const line = (o) => JSON.stringify(o) + '\n';
const post = (agent, n, extra = {}) => ({ ts: iso(T0 + n * 60e3), agent, title: `Title ${n}`, text: `Post ${n} from ${agent}`, ...extra });

async function makeDir() {
  const top = await mkdtemp(join(tmpdir(), 'feed-test-'));
  const dir = join(top, 'feed');
  await mkdir(dir, { mode: 0o700 });
  return { top, dir, cleanup: () => rm(top, { recursive: true, force: true }) };
}
const reader = (dir, opts = {}) => createFeedReader({ dir, agents: KEYS, lead: 'lead', minReadMs: 0, ...opts });

test('posts come newest first across the agents on the roster, each with the agent its file names', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1)) + line(post('builder', 4)), { mode: 0o600 });
  await writeFile(join(dir, 'scout.jsonl'), line(post('scout', 2)) + line(post('scout', 3, { title: null })), { mode: 0o600 });
  // Not on the roster: never read, never named.
  await writeFile(join(dir, 'stranger.jsonl'), line(post('stranger', 9)), { mode: 0o600 });
  const feed = await reader(dir).read();
  assert.equal(feed.status, 'ok');
  assert.deepEqual(feed.posts.map(p => [p.agent, p.text]), [
    ['builder', 'Post 4 from builder'], ['scout', 'Post 3 from scout'], ['scout', 'Post 2 from scout'], ['builder', 'Post 1 from builder']
  ]);
  assert.equal(feed.posts[1].title, null);
  assert.equal(feed.posts[0].at, T0 + 4 * 60e3);
  assert.deepEqual(Object.keys(feed.posts[0]).sort(), ['agent', 'at', 'id', 'text', 'title']);
  assert.deepEqual(feed.agents, [
    { key: 'lead', count: 0, latestAt: null },
    { key: 'builder', count: 2, latestAt: T0 + 4 * 60e3 },
    { key: 'scout', count: 2, latestAt: T0 + 3 * 60e3 }
  ]);
  assert.equal(JSON.stringify(feed).includes('stranger'), false);
  assert.deepEqual(feed.pinned, { brief: null, digest: null });
});

test('ids are stable from one read to the next and differ between posts, even identical ones', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  const same = line(post('builder', 1));
  await writeFile(join(dir, 'builder.jsonl'), same + same + line(post('builder', 2)), { mode: 0o600 });
  const r = reader(dir);
  const a = (await r.read()).posts.map(p => p.id);
  await appendFile(join(dir, 'builder.jsonl'), line(post('builder', 3)));
  const b = (await r.read()).posts.map(p => p.id);
  assert.equal(new Set(a).size, 3);
  assert.deepEqual(b.slice(1), a);
  for (const id of b) assert.match(id, /^[0-9a-f]{16}(?:-\d+)?$/);
});

test('garbage, partial and misfiled lines are skipped and counted, and the good ones still show', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  const bad = [
    'not json at all\n',
    '[1,2,3]\n',
    'null\n',
    line({ ...post('builder', 1), ts: 'yesterday' }),
    line({ ...post('builder', 1), ts: 12 }),
    line({ ...post('builder', 1), ts: '2026-11-09' }), // a date alone: not the writer's
    line({ ...post('builder', 1), ts: 'Mon, 09 Nov 2026 12:00:00 GMT' }),
    line({ ...post('builder', 1), text: '' }),
    line({ ...post('builder', 1), text: '   \n ' }),
    line({ ...post('builder', 1), text: 42 }),
    line({ ...post('builder', 1), title: { html: '<b>' } }),
    line({ ...post('scout', 1) }), // in builder's file, says scout
    '\n'
  ];
  const good = line(post('builder', 5));
  // The last line has no newline yet: a write still landing, or a torn file.
  await writeFile(join(dir, 'builder.jsonl'), bad.join('') + good + '{"ts":"2026-11-09T12:', { mode: 0o600 });
  const feed = await reader(dir).read();
  assert.deepEqual(feed.posts.map(p => p.text), ['Post 5 from builder']);
  assert.equal(feed.skipped, 13, 'the blank line is not counted; the partial last line is');
});

test('at most PER_AGENT posts an agent, its newest', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  assert.equal(PER_AGENT, 50);
  await writeFile(join(dir, 'builder.jsonl'), Array.from({ length: 70 }, (_, n) => line(post('builder', n))).join(''), { mode: 0o600 });
  await writeFile(join(dir, 'scout.jsonl'), line(post('scout', 1)), { mode: 0o600 });
  const feed = await reader(dir).read();
  const builder = feed.posts.filter(p => p.agent === 'builder');
  assert.equal(builder.length, 50);
  assert.equal(builder[0].text, 'Post 69 from builder');
  assert.equal(builder.at(-1).text, 'Post 20 from builder');
  assert.equal(feed.agents.find(a => a.key === 'builder').count, 50);
  assert.equal(feed.posts.filter(p => p.agent === 'scout').length, 1, 'one busy agent never crowds out another');
  const small = await reader(dir, { perAgent: 3 }).read();
  assert.equal(small.posts.filter(p => p.agent === 'builder').length, 3);
});

test('the newest brief and digest from the lead are pinned and kept out of the list', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  const lines = [
    line(post('lead', 1, { kind: 'digest', title: 'Old digest' })),
    line(post('lead', 2, { kind: 'brief', title: 'Old brief' })),
    line(post('lead', 3, { kind: 'digest', title: 'Weekly digest' })),
    line(post('lead', 4, { kind: 'brief', title: 'Morning brief' })),
    line(post('lead', 5, { title: 'An alert' })),
    line(post('lead', 6, { kind: 'bulletin', title: 'Unknown kind' }))
  ];
  // A kind in another agent's file pins nothing: only the lead's routines write it.
  await writeFile(join(dir, 'lead.jsonl'), lines.join(''), { mode: 0o600 });
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 9, { kind: 'brief', title: 'Not a brief' })), { mode: 0o600 });
  const feed = await reader(dir).read();
  assert.equal(feed.pinned.brief.title, 'Morning brief');
  assert.equal(feed.pinned.brief.kind, 'brief');
  assert.equal(feed.pinned.digest.title, 'Weekly digest');
  assert.equal(feed.pinned.digest.kind, 'digest');
  const titles = feed.posts.map(p => p.title);
  assert.deepEqual(titles, ['Not a brief', 'Unknown kind', 'An alert', 'Old brief', 'Old digest']);
  assert.equal(feed.posts[0].kind, undefined, "another agent's kind is dropped");
  assert.equal(feed.posts[1].kind, undefined, 'an unknown kind is dropped');
  assert.equal(feed.posts.find(p => p.title === 'Old brief').kind, 'brief', 'an older brief stays in the list, marked');
  assert.equal(feed.agents.find(a => a.key === 'lead').count, 6, 'the pins count as the lead\'s posts');
});

test('a brief further back than the last PER_AGENT posts is still pinned', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  const lines = [line(post('lead', 0, { kind: 'brief', title: 'Morning brief' }))];
  for (let n = 1; n <= 80; n++) lines.push(line(post('lead', n, { title: `Alert ${n}` })));
  await writeFile(join(dir, 'lead.jsonl'), lines.join(''), { mode: 0o600 });
  const feed = await reader(dir).read();
  assert.equal(feed.pinned.brief?.title, 'Morning brief');
  assert.equal(feed.posts.length, 50);
});

test('the rolled file, <agent>.1.jsonl, holds the older posts and can hold the pins', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'lead.1.jsonl'), line(post('lead', 1, { kind: 'digest', title: 'Weekly digest' })) + line(post('lead', 2)), { mode: 0o600 });
  await writeFile(join(dir, 'lead.jsonl'), line(post('lead', 3)), { mode: 0o600 });
  await writeFile(join(dir, 'builder.1.jsonl'), Array.from({ length: 60 }, (_, n) => line(post('builder', n))).join(''), { mode: 0o600 });
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 100)), { mode: 0o600 });
  const feed = await reader(dir).read();
  assert.equal(feed.pinned.digest.title, 'Weekly digest');
  assert.deepEqual(feed.posts.filter(p => p.agent === 'lead').map(p => p.text), ['Post 3 from lead', 'Post 2 from lead']);
  const builder = feed.posts.filter(p => p.agent === 'builder');
  assert.equal(builder.length, 50);
  assert.equal(builder[0].text, 'Post 100 from builder');
  assert.equal(builder.at(-1).text, 'Post 11 from builder');
});

test('text, titles and lines are capped; a lone surrogate never breaks the answer', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  assert.equal(TEXT_MAX, 16384);
  assert.equal(TITLE_MAX, 200);
  const lines = [
    line(post('builder', 1, { text: 'x'.repeat(TEXT_MAX + 10) })),
    line(post('builder', 2, { title: 't'.repeat(500) })),
    line(post('builder', 3, { text: 'half \ud83d emoji', truncated: true })),
    line(post('builder', 4, { text: 'y'.repeat(LINE_MAX) })) // the line itself is too long
  ];
  await writeFile(join(dir, 'builder.jsonl'), lines.join(''), { mode: 0o600 });
  const feed = await reader(dir).read();
  const by = n => feed.posts.find(p => p.at === T0 + n * 60e3);
  assert.equal(by(1).text.length, TEXT_MAX);
  assert.equal(by(1).truncated, true);
  assert.equal(by(2).title.length, TITLE_MAX);
  assert.equal(by(2).truncated, true);
  assert.equal(by(3).text, 'half � emoji');
  assert.equal(by(3).truncated, true, "the writer's own flag is kept");
  assert.equal(by(4), undefined);
  assert.equal(feed.skipped, 1);
  JSON.parse(JSON.stringify(feed));
});

test('only the last READ_MAX bytes of a file are read, from the first whole line in them', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  const one = line(post('builder', 1, { text: 'z'.repeat(9000) }));
  const count = Math.ceil((READ_MAX * 1.5) / one.length);
  const lines = Array.from({ length: count }, (_, n) => line(post('builder', n, { text: `${n} ` + 'z'.repeat(9000) })));
  await writeFile(join(dir, 'builder.jsonl'), lines.join(''), { mode: 0o600 });
  const feed = await reader(dir, { perAgent: 1000, totalMax: Infinity }).read(); // this test is about READ_MAX alone
  const kept = feed.posts.length;
  assert.ok(kept < count && kept >= Math.floor(READ_MAX / one.length) - 1, `${kept} of ${count}`);
  assert.equal(feed.skipped, 0, 'the line cut by the window is dropped, not counted as garbage');
  assert.equal(feed.posts[0].text.startsWith(`${count - 1} `), true);
});

test('no folder yet is not an error: the writer has not posted', async t => {
  const { top, dir, cleanup } = await makeDir();
  t.after(cleanup);
  await rm(dir, { recursive: true });
  const feed = await reader(dir).read();
  assert.equal(feed.status, 'missing');
  assert.deepEqual(feed.posts, []);
  assert.equal(JSON.stringify(feed).includes(top), false, 'the path never reaches the page');
});

test('a folder others can change, or one owned by another user, is refused with fixed words', async t => {
  const { top, dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1)), { mode: 0o600 });
  await chmod(dir, 0o770);
  const logged = [];
  const r = reader(dir, { log: l => logged.push(l) });
  const feed = await r.read();
  assert.equal(feed.status, 'refused');
  assert.deepEqual(feed.posts, []);
  assert.equal(JSON.stringify(feed).includes(top), false);
  await r.read();
  assert.equal(logged.length, 1, 'logged once, not every read');
  assert.match(logged[0], /^feed: .*group- or world-writable/);
  await chmod(dir, 0o700);
  assert.equal((await r.read()).status, 'ok');
  const other = await reader(dir, { uid: process.getuid() + 1 }).read();
  assert.equal(other.status, 'refused');
});

test('a file that is a symlink, a FIFO, a folder or loosely writable is skipped, and nothing hangs', async t => {
  const { top, dir, cleanup } = await makeDir();
  t.after(cleanup);
  const elsewhere = join(top, 'elsewhere.jsonl');
  await writeFile(elsewhere, line(post('builder', 1)), { mode: 0o600 });
  await symlink(elsewhere, join(dir, 'builder.jsonl'));
  execFileSync('/usr/bin/mkfifo', [join(dir, 'scout.jsonl')]);
  await mkdir(join(dir, 'lead.jsonl'));
  await writeFile(join(dir, 'lead.1.jsonl'), line(post('lead', 2)), { mode: 0o666 });
  await chmod(join(dir, 'lead.1.jsonl'), 0o666);
  const feed = await reader(dir).read();
  assert.equal(feed.status, 'ok');
  assert.deepEqual(feed.posts, []);
  assert.equal(feed.unreadable, 4);
});

test('a file that has not changed is not parsed again', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1)), { mode: 0o600 });
  await writeFile(join(dir, 'scout.jsonl'), line(post('scout', 2)), { mode: 0o600 });
  const r = reader(dir);
  const a = await r.read();
  await appendFile(join(dir, 'scout.jsonl'), line(post('scout', 3)));
  const b = await r.read();
  const builder = feed => feed.posts.find(p => p.agent === 'builder');
  const scout2 = feed => feed.posts.find(p => p.text === 'Post 2 from scout');
  assert.equal(builder(b), builder(a), 'the same object: read from the cache');
  assert.notEqual(scout2(b), scout2(a), 'the changed file was parsed again');
  assert.deepEqual(scout2(b), scout2(a));
});

test('a read inside minReadMs answers from the last one; a changed file is read again after it', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1)), { mode: 0o600 });
  let t1 = T0;
  const r = reader(dir, { minReadMs: 5000, now: () => t1 });
  const a = await r.read();
  await appendFile(join(dir, 'builder.jsonl'), line(post('builder', 2)));
  t1 += 4000;
  assert.equal(await r.read(), a);
  t1 += 2000;
  assert.equal((await r.read()).posts.length, 2);
});

test('reads at the same time share one read', async t => {
  // Ultron 11-11 (L7): a second request while a read is on its way waits for it.
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1)), { mode: 0o600 });
  const r = reader(dir);
  const [a, b, c] = await Promise.all([r.read(), r.read(), r.read()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.notEqual(await r.read(), a, 'a later read is a new one (minReadMs is 0 here)');
});

test('the answer holds about 1 MB of text at most: the oldest posts go first, the pins stay', async t => {
  // Ultron 11-11 (L8).
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  assert.equal(TOTAL_TEXT_MAX, 1_000_000);
  const big = n => 'w'.repeat(15000) + ` ${n}`;
  await writeFile(join(dir, 'lead.jsonl'), line(post('lead', -1000, { kind: 'brief', title: 'Morning brief', text: big('brief') })), { mode: 0o600 });
  await writeFile(join(dir, 'builder.jsonl'), Array.from({ length: 50 }, (_, n) => line(post('builder', 2 * n, { text: big(n) }))).join(''), { mode: 0o600 });
  await writeFile(join(dir, 'scout.jsonl'), Array.from({ length: 50 }, (_, n) => line(post('scout', 2 * n + 1, { text: big(n) }))).join(''), { mode: 0o600 });
  const feed = await reader(dir).read();
  const size = p => p.text.length + (p.title ?? '').length;
  const total = feed.posts.reduce((n, p) => n + size(p), 0) + size(feed.pinned.brief);
  assert.ok(total <= TOTAL_TEXT_MAX, String(total));
  assert.equal(feed.pinned.brief.title, 'Morning brief', 'the pin is kept, though it is the oldest');
  assert.ok(feed.posts.length > 50 && feed.posts.length < 100, String(feed.posts.length));
  assert.equal(feed.dropped, 100 - feed.posts.length);
  const oldestKept = Math.min(...feed.posts.map(p => p.at));
  assert.equal(feed.posts.length, 100 - (oldestKept - T0) / 60e3, 'exactly the oldest went');
  const counts = Object.fromEntries(feed.agents.map(a => [a.key, a.count]));
  assert.equal(counts.builder + counts.scout, feed.posts.length, 'the counts are of what is sent');
  assert.equal(counts.lead, 1);
  const small = await reader(dir, { perAgent: 3 }).read();
  assert.equal(small.dropped, 0);
});

test('a post stamped more than 24 hours ahead is skipped', async t => {
  // Ultron 11-11 (L9): a forged far-future post would otherwise sit on top forever.
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  assert.equal(FUTURE_SLACK_MS, 24 * 3600e3);
  const at = ms => ({ ...post('builder', 0), ts: iso(ms), text: `at ${ms - T0}` });
  await writeFile(join(dir, 'builder.jsonl'), [at(T0 + 25 * 3600e3), at(T0 + 23 * 3600e3), at(T0)].map(line).join(''), { mode: 0o600 });
  const feed = await reader(dir, { now: () => T0 }).read();
  assert.deepEqual(feed.posts.map(p => p.text), [`at ${23 * 3600e3}`, 'at 0']);
  assert.equal(feed.skipped, 1);
});

test('a file with a second hard link is not read', async t => {
  // Ultron 11-11 (L10).
  const { top, dir, cleanup } = await makeDir();
  t.after(cleanup);
  const elsewhere = join(top, 'elsewhere.jsonl');
  await writeFile(elsewhere, line(post('builder', 1)), { mode: 0o600 });
  await link(elsewhere, join(dir, 'builder.jsonl'));
  const feed = await reader(dir).read();
  assert.deepEqual(feed.posts, []);
  assert.equal(feed.unreadable, 1);
});

test('readFeedConfig: the default folder, an absolute override, and anything else refused', () => {
  assert.equal(DEFAULT_FEED_DIR, join(homedir(), '.local', 'state', 'jarvis', 'feed'));
  assert.deepEqual(readFeedConfig({}), { dir: DEFAULT_FEED_DIR, problems: [] });
  assert.deepEqual(readFeedConfig({ feed: { dir: '/var/feed-test' } }), { dir: '/var/feed-test', problems: [] });
  for (const feed of [{ dir: 'relative/feed' }, { dir: 7 }, 'a string', [1]]) {
    const r = readFeedConfig({ feed });
    assert.equal(r.dir, null, JSON.stringify(feed));
    assert.equal(r.problems.length, 1);
  }
  assert.deepEqual(readFeedConfig({ feed: { off: true } }), { dir: null, problems: [] });
});

// ---- the route ----

async function feedEnv(t, { devices = true, login = null } = {}) {
  const env = await makeChatEnv();
  const { dir, cleanup } = await makeDir();
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1, { text: 'A <b>bold</b> claim' })), { mode: 0o600 });
  const routes = createFeedRoutes({ feed: reader(dir), devices: devices ? env.devices : null, login });
  env.extra.push(async (req, res) => (routes.owns(new URL(req.url, 'http://x').pathname) ? (await routes.handler(req, res), true) : false));
  t.after(async () => { await env.close(); await cleanup(); });
  return env;
}
const SERVE = { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': 'mini.example-tailnet.ts.net', 'x-forwarded-proto': 'https' };

test('GET /api/feed answers a paired device, uncached, as JSON', async t => {
  const env = await feedEnv(t);
  const { cookie } = await env.pair('Test phone');
  const r = await env.call({ path: '/api/feed', headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(r.json.posts[0].text, 'A <b>bold</b> claim', 'text as written: the page renders it as text');
});

test('through Serve, the feed needs a paired device, and the owner\'s login when one is set', async t => {
  const env = await feedEnv(t, { login: 'owner@example.com' });
  const { cookie } = await env.pair('Test phone');
  assert.equal((await env.call({ path: '/api/feed', headers: { ...SERVE, 'tailscale-user-login': 'owner@example.com' } })).status, 401);
  assert.equal((await env.call({ path: '/api/feed', headers: { ...SERVE, 'tailscale-user-login': 'owner@example.com', cookie: 'cr_device=forged' } })).status, 401);
  assert.equal((await env.call({ path: '/api/feed', headers: { ...SERVE, 'tailscale-user-login': 'someone@example.com', cookie } })).status, 403);
  assert.equal((await env.call({ path: '/api/feed', headers: { ...SERVE, cookie } })).status, 403);
  const ok = await env.call({ path: '/api/feed', headers: { ...SERVE, 'tailscale-user-login': 'owner@example.com', cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.posts.length, 1);
  // A loopback Host through Serve is still Serve (lib/local-caller.mjs).
  assert.equal((await env.call({ path: '/api/feed', headers: { ...SERVE, host: '127.0.0.1' } })).status, 403);
});

test('a program on this machine gets no shortcut: the same device rule as the chat\'s reads', async t => {
  // Ultron 11-11 (L6): /api/feed requires exactly what /api/chat/messages does.
  const env = await feedEnv(t);
  const r = await env.call({ path: '/api/feed' });
  assert.equal(r.status, 401);
  assert.equal(r.json.posts, undefined);
});

test('with the chat off there are no devices, so nobody may read the feed', async t => {
  const env = await feedEnv(t, { devices: false });
  for (const headers of [{}, SERVE]) {
    const r = await env.call({ path: '/api/feed', headers });
    assert.equal(r.status, 401);
    assert.equal(r.json.posts, undefined);
  }
});

test('only GET; any other method is a 405, and other paths are not the feed\'s', async t => {
  const env = await feedEnv(t);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await env.call({ method, path: '/api/feed', body: {} });
    assert.equal(r.status, 405, method);
  }
  const routes = createFeedRoutes({ feed: { read: async () => ({}) }, devices: null });
  assert.equal(routes.owns('/api/feed'), true);
  assert.equal(routes.owns('/api/feedx'), false);
  assert.equal(routes.owns('/api/feed/x'), false);
});

test('a read that throws is a 500 with fixed words, never the error\'s text', async t => {
  const env = await makeChatEnv();
  t.after(() => env.close());
  const routes = createFeedRoutes({ feed: { read: async () => { throw new Error('/secret/path/feed boom'); } }, devices: env.devices, log: () => {} });
  env.extra.push(async (req, res) => (routes.owns(new URL(req.url, 'http://x').pathname) ? (await routes.handler(req, res), true) : false));
  const { cookie } = await env.pair('Test phone');
  const r = await env.call({ path: '/api/feed', headers: { cookie } });
  assert.equal(r.status, 500);
  assert.equal(r.text.includes('secret'), false);
});

test('the reader never writes: the folder holds what it held', async t => {
  const { dir, cleanup } = await makeDir();
  t.after(cleanup);
  await writeFile(join(dir, 'builder.jsonl'), line(post('builder', 1)), { mode: 0o600 });
  await reader(dir).read();
  assert.deepEqual(await readdir(dir), ['builder.jsonl']);
});
