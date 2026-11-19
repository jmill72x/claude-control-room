// Text a reader may be shown must hold no control character, invisible character or
// character that changes text direction (the 2026-10-21 security review). The board's
// titles (todos.mjs) and the acks' notes (lib/acks.mjs) share this one rule.
// C0 and C1 control characters (a newline, a tab, an escape), the ones that
// reorder text (U+202A-202E, U+2066-2069), and since the 2026-10-21 security
// review the invisible ones: the zero-width space (U+200B), the word joiner
// (U+2060), the byte-order mark (U+FEFF) and the direction marks (U+200E, U+200F,
// U+061C). A title and an ask are one-line labels; a direction override can make
// one read as something else, and an invisible character can hide text inside it.
// The joiners U+200C and U+200D stay allowed: U+200D sits inside combined emoji (a
// person and a laptop make one picture), so refusing it would bounce an ordinary
// edit. The detail text may hold any of them. Since board 32769ce5 (2026-11-19) the
// line and paragraph separators (U+2028, U+2029) are refused too: a one-line label
// has no use for a line break, and some readers (JavaScript source, some log viewers)
// break the line there. The wider shared set (lib/hidden-chars.mjs) is for tags and
// log lines; a title keeps this narrower one so an emoji with a joiner or a
// variation selector still saves.
export const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2028\u2029\u2066-\u2069\ufeff]/;
export const UNSAFE_SAYS = 'must not hold control characters, invisible characters or characters that change text direction';
