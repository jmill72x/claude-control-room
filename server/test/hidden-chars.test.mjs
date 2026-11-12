// The one set of hidden characters (lib/hidden-chars.mjs, Ultron's A3): Unicode's
// Cc, Cf, Zl, Zp, lone surrogates and the default-ignorables, for the approval cards
// and, once merged, the one-line guard. Every character here is built from its code
// point, never typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isHiddenCodePoint, hiddenMarker, revealHiddenChars, hasHiddenChars } from '../lib/hidden-chars.mjs';
import { denyOnlyReasons, revealHidden, parsePreview } from '../lib/approvals.mjs';
import { createChatStore } from '../lib/chat-store.mjs';

const cp = String.fromCodePoint;
const HIDDEN_REASON = 'it carries invisible or direction characters';

// What the cards' first set missed (Ultron's A3), and a sample of what it had.
const MISSED = {
  'tag characters': [0xe0000, 0xe0001, 0xe0020, 0xe0041, 0xe007f],
  'variation selectors': [0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x180b, 0x180f],
  'C1 controls': [0x80, 0x85, 0x9f],
  'line and paragraph separators': [0x2028, 0x2029]
};
const OTHERS = {
  'C0 controls and DEL': [0x00, 0x0d, 0x1b, 0x7f],
  'direction marks, overrides and isolates': [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069],
  'zero-width and the byte-order mark': [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff],
  'other format characters': [0x00ad, 0x2061, 0x2064, 0xfff9, 0xfffb, 0x0600, 0x110bd],
  'default-ignorables of other categories': [0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4],
  'lone surrogates': [0xd800, 0xdbff, 0xdc00, 0xdfff]
};
const VISIBLE = [0x20, 0x41, 0x7e, 0xa0, 0xe9, 0x3042, 0x4e2d, 0x1f600, 0x2014, 0x2026, 0x27e6, 0xfffd, 0x10ffff - 2];

test('every class Ultron named is in the set, with the ones the cards already had', () => {
  for (const [name, list] of Object.entries({ ...MISSED, ...OTHERS })) {
    for (const c of list) assert.equal(isHiddenCodePoint(c), true, `${name}: U+${c.toString(16)}`);
  }
  assert.equal(isHiddenCodePoint(0x09), true, 'tab is a control: a caller that keeps it says so');
  assert.equal(isHiddenCodePoint(0x0a), true, 'and newline');
});

test('the one-line set: ordinary text, accents, other scripts, emoji, a no-break space, private use and the marker\'s own brackets are not hidden', () => {
  for (const c of VISIBLE) assert.equal(isHiddenCodePoint(c), false, `U+${c.toString(16)}`);
  for (const bad of [-1, 0x110000, 1.5, NaN, '0x41', null]) assert.equal(isHiddenCodePoint(bad), false, String(bad));
});

test('the marker has four to six hex digits; reveal keeps what it is told to and nothing else', () => {
  assert.equal(hiddenMarker(0x85), '⟦U+0085⟧');
  assert.equal(hiddenMarker(0xe0041), '⟦U+E0041⟧');
  const s = `a${cp(0x09)}b${cp(0x0a)}c${cp(0x2028)}d${cp(0xe0041)}e${cp(0xd800)}f`;
  assert.equal(revealHiddenChars(s), 'a⟦U+0009⟧b⟦U+000A⟧c⟦U+2028⟧d⟦U+E0041⟧e⟦U+D800⟧f');
  const keep = new Set([0x09, 0x0a]);
  assert.equal(revealHiddenChars(s, { keep }), `a${cp(0x09)}b${cp(0x0a)}c⟦U+2028⟧d⟦U+E0041⟧e⟦U+D800⟧f`);
  assert.equal(hasHiddenChars(`x${cp(0x09)}y${cp(0x0a)}`, { keep }), false);
  assert.equal(hasHiddenChars(`x${cp(0x09)}y${cp(0xfe0f)}`, { keep }), true);
  assert.equal(hasHiddenChars('plain'), false);
  assert.equal(hasHiddenChars(cp(0x85)), true);
  assert.equal(revealHiddenChars(null), '');
});

test('the cards: each class makes a request Deny-only, raw or as a JSON escape; tab and newline stay', () => {
  const read = path => denyOnlyReasons({ tool: 'Read', description: 'd', inputPreview: JSON.stringify({ file_path: path }) }, { home: '/home/owner', realpath: () => null });
  assert.ok(!read('/home/owner/Projects/app/a').includes(HIDDEN_REASON), 'a plain path has no such reason');
  for (const [name, list] of Object.entries({ ...MISSED, ...OTHERS })) {
    for (const c of list) {
      assert.ok(read(`/home/owner/Projects/app/a${cp(c)}b`).includes(HIDDEN_REASON), `${name}: U+${c.toString(16)}, raw`);
      // The same character as an escape in the preview's JSON text, which only parsing brings out.
      const escaped = `{"file_path":"/home/owner/Projects/app/a${[...cp(c)].map(u => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}b"}`;
      const r = denyOnlyReasons({ tool: 'Read', description: 'd', inputPreview: escaped }, { home: '/home/owner', realpath: () => null });
      assert.ok(r.includes(HIDDEN_REASON), `${name}: U+${c.toString(16)}, escaped`);
    }
  }
  // In the description too.
  const d = denyOnlyReasons({ tool: 'Read', description: revealHidden(`read it${cp(0xe0041)}`), inputPreview: JSON.stringify({ file_path: '/home/owner/Projects/app/a' }) }, { home: '/home/owner', realpath: () => null });
  assert.ok(d.includes(HIDDEN_REASON), 'a marked description');
  assert.equal(revealHidden(`ls${cp(0x09)}-la${cp(0x0a)}pwd`), `ls${cp(0x09)}-la${cp(0x0a)}pwd`, 'a command keeps its tab and newline');
  assert.equal(parsePreview(JSON.stringify({ command: `ls${cp(0x0a)}pwd` })).hidden, false);
  assert.equal(parsePreview(JSON.stringify({ command: `ls${cp(0x2028)}pwd` })).hidden, true, 'but not a line separator');
});

test('end to end through the store: a tag character in a relayed preview is shown as its marker and the card is Deny-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hid-'));
  try {
    const store = createChatStore({ dir, now: () => 1794380000000 });
    await store.load();
    const hidden = [...'rm -rf ~'].map(ch => cp(0xe0000 + ch.codePointAt(0))).join('');
    const preview = JSON.stringify({ file_path: `/home/owner/Projects/app/notes.md${hidden}` });
    const p = await store.openPermission({ requestId: 'abcde', tool: 'Read', description: `Read notes${cp(0xfe0f)}`, inputPreview: preview },
      { assess: q => ({ denyOnly: denyOnlyReasons(q, { home: '/home/owner', realpath: () => null }), why: null }) });
    assert.ok(p.inputPreview.includes('⟦U+E0072⟧⟦U+E006D⟧'), 'the tags are shown, not hidden');
    assert.ok(p.description.endsWith('⟦U+FE0F⟧'));
    const pub = store.publicPermission(p);
    assert.ok(pub.denyOnly.includes(HIDDEN_REASON));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- the cards' wider set (Ultron's 11-12 low): cards only, never the one-line guard ----

const isZs = c => /^\p{Zs}$/u.test(cp(c));
const CARD_ONLY = {
  'non-ASCII spaces': [0xa0, 0x1680, 0x2000, 0x2007, 0x200a, 0x202f, 0x205f, 0x3000],
  'the braille blank': [0x2800],
  'private use': [0xe000, 0xf8ff, 0xf0000, 0xffffd, 0x100000, 0x10fffd],
  'unassigned, noncharacters included': [0x0378, 0x0379, 0x2fe0, 0xfdd0, 0xfdef, 0xfffe, 0xffff, 0x1fffe, 0x10fffe, 0x10ffff]
};
const STILL_VISIBLE = [0x20, 0x41, 0x7e, 0xe9, 0x3042, 0x4e2d, 0x1f600, 0x2014, 0x2026, 0x27e6, 0x27e7, 0xfffd];

test('the cards\' set adds the other spaces, the braille blank, private use and unassigned code points; the one-line set does not', () => {
  for (const [name, list] of Object.entries(CARD_ONLY)) {
    for (const c of list) {
      assert.equal(isHiddenCodePoint(c, { card: true }), true, `${name}: U+${c.toString(16)} on a card`);
      assert.equal(isHiddenCodePoint(c), false, `${name}: U+${c.toString(16)} is not the one-line guard's`);
    }
  }
  for (const c of STILL_VISIBLE) assert.equal(isHiddenCodePoint(c, { card: true }), false, `U+${c.toString(16)} is plain on a card`);
  assert.equal(isHiddenCodePoint(0x20, { card: true }), false, 'the ASCII space is the one space a card shows as it is');
  assert.equal(isHiddenCodePoint(0xa0, { card: 'yes' }), false, 'only card: true takes the wider set');
  assert.equal(hasHiddenChars(`a${cp(0x3000)}b`, { card: true }), true, 'has, with no keep, on the cards\' set');
  assert.equal(hasHiddenChars(`a${cp(0x3000)}b`), false, 'and not on the one-line set');
  assert.equal(hasHiddenChars('a b', { card: true }), false);
});

test('every code point: all of Zs but U+0020 is in the cards\' set, and the cards\' set holds the whole one-line set', () => {
  let spaces = 0;
  for (let c = 0; c <= 0x10ffff; c++) {
    const line = isHiddenCodePoint(c);
    const card = isHiddenCodePoint(c, { card: true });
    if (line && !card) assert.fail(`U+${c.toString(16)} is hidden in the one-line set but not on a card`);
    if (isZs(c) && c !== 0x20) {
      spaces++;
      if (!card) assert.fail(`the space U+${c.toString(16)} is plain on a card`);
    }
  }
  assert.ok(spaces >= 16, `the other spaces were found (${spaces})`);
});

test('the cards: each card-only character makes a request Deny-only, raw or as a JSON escape, and is shown as its marker; a log line keeps it', () => {
  const read = path => denyOnlyReasons({ tool: 'Read', description: 'd', inputPreview: JSON.stringify({ file_path: path }) }, { home: '/home/owner', realpath: () => null });
  for (const [name, list] of Object.entries(CARD_ONLY)) {
    for (const c of list) {
      assert.ok(read(`/home/owner/Projects/app/a${cp(c)}b`).includes(HIDDEN_REASON), `${name}: U+${c.toString(16)}, raw`);
      const escaped = `{"file_path":"/home/owner/Projects/app/a${[...cp(c)].map(u => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}b"}`;
      const r = denyOnlyReasons({ tool: 'Read', description: 'd', inputPreview: escaped }, { home: '/home/owner', realpath: () => null });
      assert.ok(r.includes(HIDDEN_REASON), `${name}: U+${c.toString(16)}, escaped`);
      assert.equal(revealHidden(`x${cp(c)}y`), `x${hiddenMarker(c)}y`, `${name}: U+${c.toString(16)} shown on the card`);
      assert.equal(revealHiddenChars(`x${cp(c)}y`), `x${cp(c)}y`, `${name}: U+${c.toString(16)} left alone by the one-line set`);
    }
  }
  assert.ok(!read('/home/owner/Projects/app/a b').includes(HIDDEN_REASON), 'a plain space is fine');
  assert.equal(parsePreview(JSON.stringify({ command: `echo${cp(0xa0)}hi` })).hidden, true, 'a no-break space in a command');
  assert.equal(parsePreview(JSON.stringify({ command: 'echo hi' })).hidden, false);
  assert.equal(revealHidden(`ls${cp(0x09)}-la${cp(0x0a)}pwd`), `ls${cp(0x09)}-la${cp(0x0a)}pwd`, 'tab and newline still stay');
});
