// The characters no person should have to trust their eyes about (Ultron's A3,
// 2026-11-12): one set for every place that shows outside text, the approval cards
// (lib/approvals.mjs, which add more: below) and the one-line log and alert guard (`oneLine`, branch
// jos/verdict-alerts-csp's lib/chat-events.mjs and its copy on jos/ack-notice).
//
// The cards' first set listed ranges by hand and missed the tag characters
// (U+E0000-E007F, which can spell a hidden message), the variation selectors, the C1
// controls (U+0085 is a line break to some readers) and the line and paragraph
// separators (U+2028, U+2029). This set is built from Unicode's own categories, so
// nothing has to be listed:
//
//   Cc  controls, C0 and C1 (tab and newline included: a caller that keeps them says so)
//   Cf  format characters: direction marks, overrides and isolates, zero-width
//       characters, the byte-order mark, soft hyphen, tag characters
//   Zl  the line separator, U+2028
//   Zp  the paragraph separator, U+2029
//   Cs  a lone surrogate (JSON's "\ud800" makes one), which shows as nothing or as junk
//   Default_Ignorable_Code_Point: what a renderer is told to draw as nothing; it holds
//       the variation selectors (U+FE00-FE0F, U+E0100-E01EF, Mongolian U+180B-180F),
//       the whole tag block (U+E0000-E0FFF, unassigned ones too), the combining
//       grapheme joiner and the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0)
//
// The approval cards take a wider set (`card: true`; Ultron's 11-12 low), for what
// looks like something else or like nothing on a card a person approves from, while
// the one-line guard keeps the set above (a log line or an alert may carry these
// harmlessly):
//
//   Zs but U+0020  the other spaces: no-break (U+00A0), figure (U+2007), narrow
//                  no-break (U+202F), ideographic (U+3000), the en/em/thin/hair
//                  spaces and the rest, which look like a plain space or like nothing
//   U+2800         the braille blank, drawn as an empty cell
//   Co             private-use characters, drawn by whatever font claims them
//   Cn             unassigned code points (to this Node's tables), the noncharacters
//                  (U+FDD0-FDEF, U+xFFFE and U+xFFFF) among them
//
// The tables are the JavaScript engine's (Node's ICU), so a newer Node knows newer
// characters, and a character newer than this Node's tables reads as unassigned (a
// card with one is Deny-only until Node catches up). Built from property escapes,
// never typed characters (a typed one has turned into the real character in this repo
// before); the card set's space rule is a set difference, so the `v` flag.

const CLASS = '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}\\p{Default_Ignorable_Code_Point}';
const CARD_CLASS = `${CLASS}[\\p{Zs}--[\\x20]]\\u{2800}\\p{Co}\\p{Cn}`;
const SETS = {
  line: { one: new RegExp(`^[${CLASS}]$`, 'u'), any: new RegExp(`[${CLASS}]`, 'u'), each: new RegExp(`[${CLASS}]`, 'gu') },
  card: { one: new RegExp(`^[${CARD_CLASS}]$`, 'v'), any: new RegExp(`[${CARD_CLASS}]`, 'v'), each: new RegExp(`[${CARD_CLASS}]`, 'gv') }
};
const setFor = card => (card === true ? SETS.card : SETS.line);

// Whether one code point is in the set (the cards' wider one with `card: true`).
export const isHiddenCodePoint = (c, { card = false } = {}) =>
  Number.isInteger(c) && c >= 0 && c <= 0x10ffff && setFor(card).one.test(String.fromCodePoint(c));

// How a hidden code point is shown: ⟦U+XXXX⟧, four to six hex digits.
export const hiddenMarker = c => `⟦U+${c.toString(16).toUpperCase().padStart(4, '0')}⟧`;

// `s` with each hidden code point shown as its marker, except the ones in `keep` (a
// Set of code points: the cards keep tab and newline). `card: true` takes the cards' set.
export function revealHiddenChars(s, { keep = null, card = false } = {}) {
  return String(s ?? '').replace(setFor(card).each, ch => {
    const c = ch.codePointAt(0);
    return keep?.has(c) ? ch : hiddenMarker(c);
  });
}

// Whether `s` holds a hidden code point not in `keep` (`card` as above).
export function hasHiddenChars(s, { keep = null, card = false } = {}) {
  const text = String(s ?? '');
  const set = setFor(card);
  if (!keep) return set.any.test(text);
  for (const m of text.matchAll(set.each)) if (!keep.has(m[0].codePointAt(0))) return true;
  return false;
}
