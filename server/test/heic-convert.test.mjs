// HEIC to JPEG (lib/heic-convert.mjs): how sips is run, what is refused before and
// after it, and that the work folder never outlives a call. The first tests use a fake
// `run`; the last ones run the real /usr/bin/sips on a photo made here, and are
// skipped where it is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile, chmod, stat, symlink, rm } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHeicConverter, readPixels, SIPS, CONVERT_TIMEOUT_MS, PIXELS_MAX, FIT_PX, JPEG_QUALITY, RUNS_AT_ONCE, REASONS } from '../lib/heic-convert.mjs';

const JPEG = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, n - 4), 7)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from('ftypheic'), Buffer.alloc(40, 1)]);
const pixels = (w, h) => `/some/in.heic\n  pixelWidth: ${w}\n  pixelHeight: ${h}\n`;

// A real PNG of one colour band, w by h.
function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = x % 256; row[2 + x * 3] = 80; row[3 + x * 3] = 200; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'heic-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

// A fake sips: answers the size, then writes what `jpegs` says for each conversion.
function fakeRun({ size = pixels(4032, 3024), jpegs = [JPEG(2000)] } = {}) {
  const calls = [];
  let made = 0;
  const run = async (file, args, options) => {
    calls.push({ file, args, options, work: options.cwd, src: await readFile(join(options.cwd, 'in.heic')).catch(() => null), modes: [(await stat(options.cwd)).mode & 0o777, (await stat(join(options.cwd, 'in.heic'))).mode & 0o777] });
    if (args[0] === '-g') {
      if (size instanceof Error) throw size;
      return size;
    }
    const next = jpegs[made++];
    if (next instanceof Error) throw next;
    if (next === 'a folder') await mkdir(args.at(-1));
    else if (typeof next === 'string') await symlink(next, args.at(-1));
    else if (next !== null) await writeFile(args.at(-1), next);
    return '';
  };
  return { run, calls };
}

test('readPixels: the two numbers sips prints, or nothing', () => {
  assert.deepEqual(readPixels(pixels(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(readPixels('  pixelHeight: 5\n  pixelWidth: 7'), { width: 7, height: 5 });
  for (const bad of ['', undefined, '  pixelWidth: 10', '  pixelWidth: 0\n  pixelHeight: 10', '  pixelWidth: 10\n  pixelHeight: 0', '  pixelWidth: <nil>\n  pixelHeight: <nil>', '  pixelWidth: -4\n  pixelHeight: 4', '  pixelWidth: 12345678\n  pixelHeight: 4', 'x pixelWidth: 4\n  pixelHeight: 4', '  pixelWidth: 4 px\n  pixelHeight: 4', '  pixelWidth: 4\n  pixelHeight: 4 px', '  pixelWidth: 4\nx pixelHeight: 4']) {
    assert.equal(readPixels(bad), null, String(bad));
  }
});

test('convert: sips by its own path with a list of arguments, an empty environment and a time limit; the size is read first', async t => {
  const dir = await scratch(t);
  const fake = fakeRun();
  const convert = createHeicConverter({ dir, maxBytes: 5000, run: fake.run });
  const out = await convert(HEIC);
  assert.ok(out.equals(JPEG(2000)));
  assert.equal(SIPS, '/usr/bin/sips');
  assert.deepEqual([CONVERT_TIMEOUT_MS, PIXELS_MAX, FIT_PX, JPEG_QUALITY], [20e3, 120e6, 4096, 85]);
  assert.equal(fake.calls.length, 2);
  const [look, make] = fake.calls;
  const work = look.work;
  assert.equal(dirname(work), dir);
  assert.match(basename(work), /^jos-heic-/);
  assert.deepEqual([look.file, look.args], ['/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(work, 'in.heic')]]);
  assert.deepEqual([make.file, make.args], ['/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', join(work, 'in.heic'), '--out', join(work, 'out.jpg')]]);
  for (const c of fake.calls) {
    assert.deepEqual(c.options, { cwd: work, env: {}, timeout: 20e3, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    assert.ok(c.src.equals(HEIC), 'the photo is in the work folder, whole');
    assert.deepEqual(c.modes, [0o700, 0o600], 'the folder and the photo are this user\'s alone');
  }
  assert.deepEqual(await readdir(dir), [], 'the work folder is gone');
  // Another path for the tool and another limit, when given.
  const other = fakeRun();
  await createHeicConverter({ dir, maxBytes: 5000, sips: '/opt/x/sips', timeoutMs: 500, run: other.run })(HEIC);
  assert.deepEqual([other.calls[1].file, other.calls[1].options.timeout], ['/opt/x/sips', 500]);
  assert.throws(() => createHeicConverter({ dir }), /maxBytes/);
  assert.throws(() => createHeicConverter({ dir, maxBytes: 0 }), /maxBytes/);
});

test('convert: a photo too large as a JPEG is made again at 4096 on its long side, only when it is larger than that', async t => {
  const dir = await scratch(t);
  // Tall and over 4096: the second try fits.
  const tall = fakeRun({ size: pixels(3000, 6000), jpegs: [JPEG(5001), JPEG(4000)] });
  const out = await createHeicConverter({ dir, maxBytes: 5000, run: tall.run })(HEIC);
  assert.equal(out.length, 4000);
  assert.equal(tall.calls.length, 3);
  assert.deepEqual(tall.calls[2].args.slice(0, 8), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '4096']);
  assert.equal(basename(tall.calls[2].args.at(-1)), 'fit.jpg');
  // Exactly the limit is kept as it is.
  const exact = fakeRun({ size: pixels(8000, 6000), jpegs: [JPEG(5000)] });
  assert.equal((await createHeicConverter({ dir, maxBytes: 5000, run: exact.run })(HEIC)).length, 5000);
  assert.equal(exact.calls.length, 2);
  // Still too large after the second try.
  const huge = fakeRun({ size: pixels(8000, 6000), jpegs: [JPEG(5001), JPEG(5001)] });
  await assert.rejects(createHeicConverter({ dir, maxBytes: 5000, run: huge.run })(HEIC), /too large as a JPEG/);
  assert.equal(huge.calls.length, 3);
  // Not larger than 4096 either way: `-Z` would enlarge it, so there is no second try.
  for (const [w, h] of [[4096, 3072], [3072, 4096], [640, 480]]) {
    const small = fakeRun({ size: pixels(w, h), jpegs: [JPEG(5001), JPEG(10)] });
    await assert.rejects(createHeicConverter({ dir, maxBytes: 5000, run: small.run })(HEIC), /too large as a JPEG/, `${w}x${h}`);
    assert.equal(small.calls.length, 2, `${w}x${h}`);
  }
  // One more pixel on the long side, wide or tall, and it gets the second try.
  for (const [w, h] of [[4097, 100], [100, 4097]]) {
    const edge = fakeRun({ size: pixels(w, h), jpegs: [JPEG(5001), JPEG(10)] });
    assert.equal((await createHeicConverter({ dir, maxBytes: 5000, run: edge.run })(HEIC)).length, 10, `${w}x${h}`);
  }
  assert.deepEqual(await readdir(dir), []);
});

test('convert refuses a photo it can\'t size, one that claims too many pixels, and whatever sips fails on; nothing is left behind', async t => {
  const dir = await scratch(t);
  // Each failure says why in one fixed word (`reason`), and its message never holds a
  // path or the tool's name or output.
  assert.deepEqual(REASONS, ['timeout', 'unreadable', 'too large', 'failed']);
  const tryWith = async (fake, words, reason, data = HEIC) => {
    await assert.rejects(createHeicConverter({ dir, maxBytes: 5000, run: fake.run })(data), err => words.test(err.message) && err.reason === reason && !err.message.includes(dir) && !err.message.includes('sips'), `${words} ${reason}`);
    assert.deepEqual(await readdir(dir), [], `${words}: the work folder is gone`);
    return fake.calls.length;
  };
  // What execFile's error looks like when it killed the tool at the time limit.
  const killedAtLimit = () => Object.assign(new Error(`Command failed: /usr/bin/sips ${dir}/in.heic`), { killed: true, signal: 'SIGKILL' });
  // The size can't be read: no pixel is decoded.
  assert.equal(await tryWith(fakeRun({ size: new Error(`Error: Cannot extract image from file ${dir}/x via sips`) }), /could not be read/, 'unreadable'), 1);
  assert.equal(await tryWith(fakeRun({ size: Object.assign(new Error('it ended by itself'), { killed: false }) }), /could not be read/, 'unreadable'), 1);
  assert.equal(await tryWith(fakeRun({ size: 'no numbers here' }), /could not be read/, 'unreadable'), 1);
  assert.equal(await tryWith(fakeRun({ size: killedAtLimit() }), /took too long/, 'timeout'), 1);
  // 120 megapixels is the most; one pixel row more is refused before sips decodes a pixel.
  assert.equal(await tryWith(fakeRun({ size: pixels(12000, 10001) }), /too large to convert/, 'too large'), 1);
  const most = fakeRun({ size: pixels(12000, 10000) });
  assert.ok((await createHeicConverter({ dir, maxBytes: 5000, run: most.run })(HEIC)).length > 0);
  // sips fails, runs out of time, writes nothing, or writes something that is not a file.
  assert.equal(await tryWith(fakeRun({ jpegs: [new Error(`sips died in ${dir}`)] }), /could not be converted/, 'failed'), 2);
  assert.equal(await tryWith(fakeRun({ jpegs: [killedAtLimit()] }), /took too long/, 'timeout'), 2);
  assert.equal(await tryWith(fakeRun({ jpegs: [null] }), /could not be converted/, 'failed'), 2);
  assert.equal(await tryWith(fakeRun({ jpegs: ['a folder'] }), /could not be converted/, 'failed'), 2);
  // Too many bytes as a JPEG, twice.
  assert.equal(await tryWith(fakeRun({ size: pixels(8000, 6000), jpegs: [JPEG(5001), JPEG(5001)] }), /too large as a JPEG/, 'too large'), 3);
  // A link where the JPEG should be is not followed, even to a real JPEG.
  const outside = join(await scratch(t), 'elsewhere.jpg');
  await writeFile(outside, JPEG(2000));
  assert.equal(await tryWith(fakeRun({ jpegs: [outside] }), /could not be converted/, 'failed'), 2);
  // What sips wrote does not begin like a JPEG.
  const PNG_HEAD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
  for (const notJpeg of [PNG_HEAD, Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xd8, 0x00, 0x00]), Buffer.from([0xff, 0x00, 0xff, 0x00]), Buffer.from([0x00, 0xd8, 0xff, 0x00])]) {
    assert.equal(await tryWith(fakeRun({ jpegs: [notJpeg] }), /could not be converted/, 'failed'), 2);
  }
  // Nothing to convert.
  for (const none of [Buffer.alloc(0), 'not bytes', null]) await assert.rejects(createHeicConverter({ dir, maxBytes: 5000, run: fakeRun().run })(none), err => /no photo/.test(err.message) && err.reason === 'unreadable');
  assert.deepEqual(await readdir(dir), []);
});

test('at most two conversions run at once, whoever asks; the rest wait their turn in order, and a failure hands its turn on', async t => {
  const dir = await scratch(t);
  assert.equal(RUNS_AT_ONCE, 2);
  // A fake sips that takes a while to size a photo, and counts how many photos are in work.
  const slow = ({ failAt = [] } = {}) => {
    const state = { active: 0, most: 0, started: [], n: 0 };
    const run = async (file, args, options) => {
      if (args[0] === '-g') {
        const mine = state.n++;
        state.started.push((await readFile(join(options.cwd, 'in.heic')))[12]);
        state.active++;
        state.most = Math.max(state.most, state.active);
        await new Promise(r => setTimeout(r, 25));
        if (failAt.includes(mine)) { state.active--; throw new Error('no size'); }
        return pixels(40, 30);
      }
      await writeFile(args.at(-1), JPEG(100));
      state.active--;
      return '';
    };
    return { run, state };
  };
  // Each photo carries its number, so the order they start in can be read back.
  const photo = n => Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from('ftypheic'), Buffer.alloc(40, n)]);
  const within = (p, ms = 3000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('still waiting')), ms))]);
  const a = slow();
  const convert = createHeicConverter({ dir, maxBytes: 5000, run: a.run });
  const all = await within(Promise.all([0, 1, 2, 3, 4, 5, 6].map(n => convert(photo(n)))));
  // (Two in work together may start in either order; one at a time, below, shows the order.)
  assert.deepEqual([all.length, all.every(j => j.length === 100), a.state.most, [...a.state.started].sort((x, y) => x - y)], [7, true, 2, [0, 1, 2, 3, 4, 5, 6]]);
  // The turns were all handed back: seven more go through, two at a time again.
  await within(Promise.all([7, 8, 9, 10, 11, 12, 13].map(n => convert(photo(n)))));
  assert.deepEqual([a.state.most, a.state.active, a.state.started.length], [2, 0, 14]);
  // One at a time when told so; and a conversion that fails hands its turn on.
  const b = slow({ failAt: [0, 2] });
  const single = createHeicConverter({ dir, maxBytes: 5000, atOnce: 1, run: b.run });
  const done = await within(Promise.allSettled([0, 1, 2, 3].map(n => single(photo(n)))));
  assert.deepEqual([done.map(d => d.status), b.state.most, b.state.started], [['rejected', 'fulfilled', 'rejected', 'fulfilled'], 1, [0, 1, 2, 3]]);
  assert.equal((await within(single(photo(9)))).length, 100, 'and the turn is free afterwards');
  // Bytes that are no photo take no turn.
  await assert.rejects(single(Buffer.alloc(0)), /no photo/);
  assert.deepEqual(await readdir(dir), []);
});

const HAS_SIPS = existsSync(SIPS);
const sips = args => new Promise((resolve, reject) => execFile(SIPS, args, err => (err ? reject(err) : resolve())));

test('the real sips: a HEIC photo becomes a JPEG of the same size, and bytes that are no photo are refused', { skip: !HAS_SIPS && 'no /usr/bin/sips here' }, async t => {
  const dir = await scratch(t);
  const src = join(dir, 'src.png'), heicPath = join(dir, 'src.heic'), check = join(dir, 'check.jpg');
  await writeFile(src, png(96, 64));
  await sips(['-s', 'format', 'heic', src, '--out', heicPath]);
  const heic = await readFile(heicPath);
  assert.equal(heic.subarray(4, 8).toString('latin1'), 'ftyp', 'sips made a HEIC to test with');
  const work = join(dir, 'work');
  await mkdir(work);
  const convert = createHeicConverter({ dir: work, maxBytes: 10 * 1024 * 1024 });
  const jpeg = await convert(heic);
  assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  await writeFile(check, jpeg);
  const size = await new Promise((resolve, reject) => execFile(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', check], (err, out) => (err ? reject(err) : resolve(readPixels(out)))));
  assert.deepEqual(size, { width: 96, height: 64 }, 'the size is kept, never enlarged');
  // Bytes that only begin like a HEIC.
  await assert.rejects(convert(Buffer.concat([Buffer.from([0, 0, 0, 0x24]), Buffer.from('ftypheic'), Buffer.alloc(200, 3)])), err => /could not be read/.test(err.message) && err.reason === 'unreadable');
  assert.deepEqual(await readdir(work), [], 'nothing is left in the work folder');
});

test('a sips that hangs is killed at the time limit, even one that ignores a polite stop', async t => {
  const dir = await scratch(t);
  const tool = join(dir, 'slow-sips');
  // Ignored signals pass through exec, so only SIGKILL ends this.
  await writeFile(tool, '#!/bin/sh\ntrap \'\' TERM\nexec /bin/sleep 20\n');
  await chmod(tool, 0o700);
  const work = join(dir, 'work');
  await mkdir(work);
  const started = Date.now();
  await assert.rejects(createHeicConverter({ dir: work, maxBytes: 5000, sips: tool, timeoutMs: 300 })(HEIC), err => /took too long/.test(err.message) && err.reason === 'timeout');
  assert.ok(Date.now() - started < 5000, 'it did not wait for the tool');
  assert.deepEqual(await readdir(work), []);
  // One that sizes the photo and then hangs on the conversion.
  const half = join(dir, 'half-sips');
  await writeFile(half, '#!/bin/sh\nif [ "$1" = "-g" ]; then echo "  pixelWidth: 10"; echo "  pixelHeight: 10"; exit 0; fi\ntrap \'\' TERM\nexec /bin/sleep 20\n');
  await chmod(half, 0o700);
  const again = Date.now();
  await assert.rejects(createHeicConverter({ dir: work, maxBytes: 5000, sips: half, timeoutMs: 300 })(HEIC), err => /took too long/.test(err.message) && err.reason === 'timeout');
  assert.ok(Date.now() - again < 5000);
  // A tool that fails by itself did not run out of time.
  await assert.rejects(createHeicConverter({ dir: work, maxBytes: 5000, sips: '/usr/bin/false', timeoutMs: 300 })(HEIC), err => err.reason === 'unreadable');
  assert.deepEqual(await readdir(work), []);
});
