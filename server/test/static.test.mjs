import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { resolveStaticPath, createStaticHandler } from '../lib/static.mjs';

// A web root with a sibling directory holding a secret, mirroring the real
// layout (web/dist next to server/config.json).
const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'ccr-static-'));
  const dist = join(base, 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html>page');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  mkdirSync(join(base, 'server'), { recursive: true });
  writeFileSync(join(base, 'server', 'config.json'), '{"secret":true}');
  // A sibling whose name merely starts with the web root's, which a naive
  // startsWith check on the resolved path would let through.
  mkdirSync(`${dist}-old`, { recursive: true });
  writeFileSync(join(`${dist}-old`, 'leak.txt'), 'leaked');
  return { base, dist };
};

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: null };
  res.writeHead = (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body === undefined ? '' : String(body); };
  return res;
};

const get = async (dist, url) => {
  const res = mockRes();
  await createStaticHandler(dist)({ url, method: 'GET', headers: {} }, res);
  return res;
};

const ESCAPES = [
  '/../../server/config.json',
  '/../../../../../../etc/passwd',
  '/../../../.zshrc',
  '/%2e%2e/%2e%2e/server/config.json',
  '/%2E%2E%2F%2E%2E%2Fserver/config.json',
  '/assets/../../../server/config.json',
  '/..%2f..%2fserver/config.json',
  '/../dist-old/leak.txt'
];

test('every traversal encoding resolves outside the web root and is refused', async () => {
  const { dist } = fixture();
  for (const url of ESCAPES) {
    assert.equal(resolveStaticPath(dist, url), null, `expected ${url} to be rejected`);
    const res = await get(dist, url);
    assert.equal(res.statusCode, 403, `expected 403 for ${url}`);
    assert.ok(!String(res.body).includes('secret'), `${url} served the config file`);
    assert.ok(!String(res.body).includes('leaked'), `${url} served the sibling directory`);
  }
});

test('a NUL byte in the path is refused rather than passed to the filesystem', () => {
  const { dist } = fixture();
  assert.equal(resolveStaticPath(dist, '/index.html%00.png'), null);
});

test('a path that cannot be percent-decoded is refused', () => {
  const { dist } = fixture();
  assert.equal(resolveStaticPath(dist, '/%ZZ'), null);
});

test('legitimate assets still serve with their content type', async () => {
  const { dist } = fixture();
  const index = await get(dist, '/');
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /doctype/);
  assert.equal(index.headers['Content-Type'], 'text/html');

  const asset = await get(dist, '/assets/app.js');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.body, /console\.log/);
  assert.equal(asset.headers['Content-Type'], 'text/javascript');

  const query = await get(dist, '/assets/app.js?v=123');
  assert.equal(query.statusCode, 200);
  assert.match(query.body, /console\.log/);
});

test('a traversal that stays inside the root is allowed', () => {
  const { dist } = fixture();
  const p = resolveStaticPath(dist, '/assets/../index.html');
  assert.equal(p, resolve(dist, 'index.html'));
});

test('an unknown in-root path falls back to the SPA shell, not to a 403', async () => {
  const { dist } = fixture();
  const res = await get(dist, '/some/client/route');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /doctype/);
});

test('resolved paths never leave the web root', () => {
  const { dist } = fixture();
  const root = resolve(dist);
  // Neither of the last two is a traversal on this platform — '....' and a
  // backslash are ordinary filename characters — so they must resolve INSIDE
  // the root (and 404 to the SPA shell), never outside it.
  for (const url of ['/', '/index.html', '/assets/app.js', '/a/b/c', '/....//....//server/config.json', '/..\\..\\server/config.json']) {
    const p = resolveStaticPath(dist, url);
    if (p === null) continue;
    assert.ok(p === root || p.startsWith(root + sep), `${url} resolved to ${p}`);
  }
});
