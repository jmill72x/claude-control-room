// The avatar route, /avatars/<key>.png. It serves one folder named in config,
// and only files named for an agent on the roster. Every file here is made up
// in a temp folder; no real avatar is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createAvatarHandler, MAX_AVATAR_BYTES } from '../lib/avatars.mjs';

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccr-avatars-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'ccr-outside-')), 'secret.png');
  writeFileSync(outside, PNG);
  writeFileSync(join(dir, 'lead.png'), PNG);
  writeFileSync(join(dir, 'other.png'), PNG); // a valid file for an agent not on the roster
  writeFileSync(join(dir, 'notpng.png'), 'this is text, not an image');
  writeFileSync(join(dir, 'big.png'), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_AVATAR_BYTES)]));
  symlinkSync(outside, join(dir, 'link.png'));
  mkdirSync(join(dir, 'dir.png'));
  execFileSync('mkfifo', [join(dir, 'fifo.png')]);
  return dir;
};
const KEYS = ['lead', 'notpng', 'big', 'link', 'dir', 'fifo'];

const call = async (handler, url, method = 'GET') => {
  const res = { headers: {}, body: undefined, statusCode: 0 };
  res.writeHead = (code, h) => { res.statusCode = code; Object.assign(res.headers, h ?? {}); };
  res.end = b => { res.body = b; };
  // A FIFO opened for reading would wait for a writer: never let a test hang on it.
  await Promise.race([
    handler({ method, url, headers: {} }, res),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${url} hung`)), 2000).unref())
  ]);
  return res;
};

test('serves an agent\'s avatar as a PNG, cached for a day, and HEAD without a body', async () => {
  const dir = folder();
  const serve = createAvatarHandler({ dir, keys: KEYS });
  const res = await call(serve, '/avatars/lead.png');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['Cache-Control'], 'max-age=86400');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(res.body, readFileSync(join(dir, 'lead.png')));
  assert.equal((await call(serve, '/avatars/lead.png?v=2')).statusCode, 200);
  const head = await call(serve, '/avatars/lead.png', 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);
});

test('any name outside the pattern, or not on the roster, is a 404, and nothing is decoded', async () => {
  const serve = createAvatarHandler({ dir: folder(), keys: KEYS });
  for (const url of [
    '/avatars/other.png', '/avatars/sheet.png', '/avatars/Lead.png', '/avatars/lead.PNG', '/avatars/lead.png.png',
    '/avatars/lead', '/avatars/', '/avatars/.png', '/avatars/-lead.png', '/avatars/a/lead.png', '/avatars/../lead.png',
    '/avatars/../../server/config.json', '/avatars/%2e%2e/lead.png', '/avatars/lead%2Epng', '/avatars/%6cead.png',
    '/avatars/lead.png%00', '/avatars//lead.png', '/avatars/lead.png/', `/avatars/${'a'.repeat(41)}.png`
  ]) {
    const res = await call(serve, url);
    assert.equal(res.statusCode, 404, url);
    assert.notEqual(res.headers['Content-Type'], 'image/png', url);
  }
});

test('a file that is not a regular PNG of a sane size is a 404: text, a symlink, a folder, a FIFO, a huge file', async () => {
  const serve = createAvatarHandler({ dir: folder(), keys: KEYS });
  for (const name of ['notpng', 'link', 'dir', 'fifo', 'big']) {
    assert.equal((await call(serve, `/avatars/${name}.png`)).statusCode, 404, name);
  }
});

test('with no folder configured, or a relative one, nothing is served', async () => {
  assert.equal((await call(createAvatarHandler({ dir: null, keys: KEYS }), '/avatars/lead.png')).statusCode, 404);
  // A relative path that does lead to a real folder of avatars from here.
  const rel = relative(process.cwd(), folder());
  assert.equal(isAbsolute(rel), false);
  assert.equal((await call(createAvatarHandler({ dir: rel, keys: KEYS }), '/avatars/lead.png')).statusCode, 404);
  assert.equal((await call(createAvatarHandler({ dir: folder(), keys: [] }), '/avatars/lead.png')).statusCode, 404);
});

test('only GET and HEAD', async () => {
  const serve = createAvatarHandler({ dir: folder(), keys: KEYS });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await call(serve, '/avatars/lead.png', method);
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers.Allow, 'GET, HEAD');
  }
});
