// Picking up a new build (lib/orbit/build.js), the pairing screen's default name
// (lib/orbit/chat.js) and the manifest's icons: the 2026-11-11 polish batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBuild, reloadDecision, hasUnsent, isTyping } from '../src/lib/orbit/build.js';
import { defaultDeviceName } from '../src/lib/orbit/chat.js';

test('parseBuild: the id from build.json, and nothing from the page the fallback sends', () => {
  assert.equal(parseBuild('application/json', '{"build":"mh2x9k-1a2b3c4d"}\n'), 'mh2x9k-1a2b3c4d');
  assert.equal(parseBuild('application/json; charset=utf-8', '{"build":"abc"}'), 'abc');
  // No build.json yet: the single-page fallback answers with index.html.
  assert.equal(parseBuild('text/html', '<!doctype html>'), null);
  assert.equal(parseBuild('text/html', '{"build":"abc"}'), null);
  assert.equal(parseBuild(null, '{"build":"abc"}'), null);
  assert.equal(parseBuild('application/json', 'not json'), null);
  assert.equal(parseBuild('application/json', '{"build":null}'), null);
  assert.equal(parseBuild('application/json', '{"build":42}'), null);
  assert.equal(parseBuild('application/json', '{"build":""}'), null);
  assert.equal(parseBuild('application/json', '{"build":"has space"}'), null);
  assert.equal(parseBuild('application/json', `{"build":"${'a'.repeat(65)}"}`), null);
});

test('reloadDecision: a new id reloads, unless something is unsent, which makes it wait', () => {
  assert.equal(reloadDecision({ mine: 'a', served: 'b' }), 'reload');
  assert.equal(reloadDecision({ mine: 'a', served: 'b', busy: true }), 'wait');
  assert.equal(reloadDecision({ mine: 'a', served: 'b', busy: false, reloadedFor: 'z' }), 'reload', 'an older reload is no reason to stop');
});

test('reloadDecision: the same id, no id, or the dev server: nothing', () => {
  assert.equal(reloadDecision({ mine: 'a', served: 'a' }), 'none');
  assert.equal(reloadDecision({ mine: 'a', served: 'a', busy: true }), 'none');
  assert.equal(reloadDecision({ mine: 'a', served: null }), 'none');
  assert.equal(reloadDecision({ mine: null, served: 'b' }), 'none', 'the dev server has no id');
});

test('reloadDecision: once per new build, never a loop when a reload brings the old page back', () => {
  // The tab reloaded for b, but a cache handed it the page with id a again.
  assert.equal(reloadDecision({ mine: 'a', served: 'b', reloadedFor: 'b' }), 'none');
  // A later build c is another chance.
  assert.equal(reloadDecision({ mine: 'a', served: 'c', reloadedFor: 'b' }), 'reload');
});

test('hasUnsent: a message still going or failed holds the reload; one the server took does not', () => {
  assert.equal(hasUnsent([]), false);
  assert.equal(hasUnsent(undefined), false);
  assert.equal(hasUnsent([{ id: 'm1', seq: 4 }]), false);
  assert.equal(hasUnsent([{ id: 'm1', seq: 4 }, { clientId: 'c', id: null, seq: null }]), true, 'uploading or sending');
  assert.equal(hasUnsent([{ clientId: 'c', id: null, seq: null, failed: true }]), true, 'failed, not yet retried or discarded');
  assert.equal(hasUnsent([{ clientId: 'c', id: 'm2', seq: null }]), false, 'taken, waiting for its live event');
});

test('isTyping: a focused text field with something in it', () => {
  assert.equal(isTyping(null), false);
  assert.equal(isTyping({ tagName: 'BODY' }), false);
  assert.equal(isTyping({ tagName: 'TEXTAREA', value: '' }), false);
  assert.equal(isTyping({ tagName: 'TEXTAREA', value: 'half a thought' }), true);
  assert.equal(isTyping({ tagName: 'INPUT', type: 'text', value: 'x' }), true);
  assert.equal(isTyping({ tagName: 'INPUT', type: 'search', value: 'x' }), true);
  assert.equal(isTyping({ tagName: 'INPUT', type: 'text', value: '' }), false);
  assert.equal(isTyping({ tagName: 'INPUT', type: 'checkbox', value: 'on' }), false);
  assert.equal(isTyping({ tagName: 'BUTTON', value: 'x' }), false);
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
});

const UA = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
  iPadOld: 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
};

test('defaultDeviceName: iPhone, iPad (also the iPad that says it is a Mac), Mac, else This device', () => {
  assert.equal(defaultDeviceName({ userAgent: UA.iPhone, maxTouchPoints: 5 }), 'iPhone');
  assert.equal(defaultDeviceName({ userAgent: UA.iPadOld, maxTouchPoints: 5 }), 'iPad');
  assert.equal(defaultDeviceName({ userAgent: UA.mac, maxTouchPoints: 5 }), 'iPad', 'iPadOS sends a Mac user agent');
  assert.equal(defaultDeviceName({ userAgent: UA.mac, maxTouchPoints: 0 }), 'Mac');
  assert.equal(defaultDeviceName({ userAgent: UA.android, maxTouchPoints: 5 }), 'This device');
  assert.equal(defaultDeviceName({ userAgent: UA.windows }), 'This device');
  assert.equal(defaultDeviceName({}), 'This device');
  assert.equal(defaultDeviceName(), 'This device');
});

test('defaultDeviceName: every answer fits the name box and enables Get a code', () => {
  for (const ua of [...Object.values(UA), '']) {
    for (const maxTouchPoints of [0, 5]) {
      const name = defaultDeviceName({ userAgent: ua, maxTouchPoints });
      assert.ok(name.trim().length > 0 && name.length <= 40, name);
    }
  }
});

// The size of a PNG, from its IHDR chunk.
const pngSize = buf => {
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
};

test('manifest: lists 192 and 512 px icons beside the 180, and each file is the size it claims', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  const sizes = manifest.icons.map(i => i.sizes);
  for (const want of ['180x180', '192x192', '512x512']) assert.ok(sizes.includes(want), want);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    assert.match(icon.src, /^\/[a-z0-9-]+\.png$/);
    const file = readFileSync(new URL(`../public${icon.src}`, import.meta.url));
    assert.equal(pngSize(file), icon.sizes, icon.src);
  }
});
