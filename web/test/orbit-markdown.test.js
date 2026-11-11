// The chat's Markdown subset (src/lib/orbit/markdown.js): a parser that returns plain
// objects, which Markdown.jsx turns into React elements. Nothing here is ever HTML:
// every piece of the message reaches the page as a text node or an href that passed
// the scheme check. Every message here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, safeHref, markdownPlain, MD_MAX_INPUT, MD_MAX_DEPTH, MD_MAX_INLINE_DEPTH } from '../src/lib/orbit/markdown.js';
import { quoteLine } from '../src/lib/orbit/chat.js';

const t = text => ({ type: 'text', text });
const p = (...children) => ({ type: 'p', children });
const one = src => parseMarkdown(src).children;

// Every string anywhere in the tree, and every node type, so a test can say "no
// node but these" and "this text is still there, as text".
const walk = (node, fn) => {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
  for (const item of node.items ?? []) for (const c of item) walk(c, fn);
};
const typesIn = tree => { const s = new Set(); walk(tree, n => s.add(n.type)); return s; };
const linksIn = tree => { const out = []; walk(tree, n => { if (n.type === 'link') out.push(n.href); }); return out; };
const ALLOWED_TYPES = new Set(['root', 'p', 'h', 'code', 'ul', 'ol', 'text', 'strong', 'em', 'codespan', 'link']);

test('plain text is one paragraph of one text node, its line breaks kept', () => {
  assert.deepEqual(one('hello'), [p(t('hello'))]);
  assert.deepEqual(one('line one\nline two'), [p(t('line one\nline two'))]);
  assert.deepEqual(one('a\r\nb'), [p(t('a\nb'))]);
  assert.deepEqual(one('one\n\n\ntwo'), [p(t('one')), p(t('two'))]);
  assert.deepEqual(one(''), []);
  assert.deepEqual(one('   \n\n'), []);
});

test('bold and italic, with stars and underscores', () => {
  assert.deepEqual(parseInline('**bold** text'), [{ type: 'strong', children: [t('bold')] }, t(' text')]);
  assert.deepEqual(parseInline('__bold__'), [{ type: 'strong', children: [t('bold')] }]);
  assert.deepEqual(parseInline('an *em* word'), [t('an '), { type: 'em', children: [t('em')] }, t(' word')]);
  assert.deepEqual(parseInline('an _em_ word'), [t('an '), { type: 'em', children: [t('em')] }, t(' word')]);
  assert.deepEqual(parseInline('***both***'), [{ type: 'em', children: [{ type: 'strong', children: [t('both')] }] }]);
  assert.deepEqual(parseInline('**bold with *em* inside**'),
    [{ type: 'strong', children: [t('bold with '), { type: 'em', children: [t('em')] }, t(' inside')] }]);
});

test('underscores inside a word stay literal; stars around spaces open nothing', () => {
  assert.deepEqual(parseInline('snake_case_name'), [t('snake_case_name')]);
  assert.deepEqual(parseInline('5 * 3 * 2'), [t('5 * 3 * 2')]);
  assert.deepEqual(parseInline('a ** b'), [t('a ** b')]);
  assert.deepEqual(parseInline('foo_bar baz_ qux'), [t('foo_bar baz_ qux')], 'an underscore inside a word opens nothing');
  assert.deepEqual(parseInline('****a****'), [t('****a****')], 'a run of four or more is literal');
});

test('unclosed and crossed markers stay literal, never swallow the rest', () => {
  assert.deepEqual(parseInline('**not closed'), [t('**not closed')]);
  assert.deepEqual(parseInline('*a'), [t('*a')]);
  assert.deepEqual(parseInline('**a*'), [t('*'), { type: 'em', children: [t('a')] }]);
  // Crossed: the star pair wins, the underscore that opened inside it is literal.
  const crossed = parseInline('*a _b* c_');
  assert.deepEqual(crossed, [{ type: 'em', children: [t('a _b')] }, t(' c_')]);
  assert.deepEqual(parseInline('`a'), [t('`a')]);
  // An unclosed link is no link; its bare URL is still one.
  assert.deepEqual(parseInline('[a](https://x.example'), [t('[a]('), { type: 'link', href: 'https://x.example/', children: [t('https://x.example/')] }]);
});

test('inline code is literal inside: no markers, no links', () => {
  assert.deepEqual(parseInline('run `npm test` now'), [t('run '), { type: 'codespan', text: 'npm test' }, t(' now')]);
  assert.deepEqual(parseInline('`**x** [a](https://x.example)`'), [{ type: 'codespan', text: '**x** [a](https://x.example)' }]);
  assert.deepEqual(parseInline('``a ` b``'), [{ type: 'codespan', text: 'a ` b' }]);
  assert.deepEqual(parseInline('` `` `'), [{ type: 'codespan', text: '``' }]);
  assert.deepEqual(parseInline('`<script>alert(1)</script>`'), [{ type: 'codespan', text: '<script>alert(1)</script>' }]);
});

test('backslash escapes a marker', () => {
  assert.deepEqual(parseInline('\\*not em\\*'), [t('*not em*')]);
  assert.deepEqual(parseInline('a\\b'), [t('a\\b')], 'a backslash before a letter stays');
});

test('fenced code blocks keep their text exactly, and an unclosed fence runs to the end', () => {
  assert.deepEqual(one('```js\nconst a = 1 < 2;\n**x**\n```'), [{ type: 'code', text: 'const a = 1 < 2;\n**x**' }]);
  assert.deepEqual(one('before\n~~~\n<b>hi</b>\n~~~\nafter'), [p(t('before')), { type: 'code', text: '<b>hi</b>' }, p(t('after'))]);
  assert.deepEqual(one('```\nopen\n\nstill code'), [{ type: 'code', text: 'open\n\nstill code' }]);
  assert.deepEqual(one('````\n```\n````'), [{ type: 'code', text: '```' }], 'a shorter fence does not close');
});

test('bulleted and numbered lists, nested by indent, interrupting a paragraph', () => {
  assert.deepEqual(one('- one\n- **two**'), [{ type: 'ul', items: [[p(t('one'))], [p({ type: 'strong', children: [t('two')] })]] }]);
  assert.deepEqual(one('* a\n+ b'), [{ type: 'ul', items: [[p(t('a'))]] }, { type: 'ul', items: [[p(t('b'))]] }], 'a new bullet character starts a new list');
  assert.deepEqual(one('3. three\n4) four'), [{ type: 'ol', start: 3, items: [[p(t('three'))]] }, { type: 'ol', start: 4, items: [[p(t('four'))]] }]);
  assert.deepEqual(one('1. a\n2. b'), [{ type: 'ol', start: 1, items: [[p(t('a'))], [p(t('b'))]] }]);
  assert.deepEqual(one('Plan:\n- a\n- b'), [p(t('Plan:')), { type: 'ul', items: [[p(t('a'))], [p(t('b'))]] }]);
  assert.deepEqual(one('Year\n2026. was long'), [p(t('Year\n2026. was long'))], 'only a list starting at 1 interrupts a paragraph');
  assert.deepEqual(one('- a\n  - b\n  - c\n- d'), [{ type: 'ul', items: [
    [p(t('a')), { type: 'ul', items: [[p(t('b'))], [p(t('c'))]] }],
    [p(t('d'))]
  ] }]);
  assert.deepEqual(one('1. a\n   continued\n2. b'), [{ type: 'ol', start: 1, items: [[p(t('a\ncontinued'))], [p(t('b'))]] }]);
  assert.deepEqual(one('- a\n\n- b'), [{ type: 'ul', items: [[p(t('a'))], [p(t('b'))]] }], 'a blank line between items keeps one list');
  assert.deepEqual(one('- a\nafter'), [{ type: 'ul', items: [[p(t('a'))]] }, p(t('after'))]);
  assert.deepEqual(one('**bold** start'), [p({ type: 'strong', children: [t('bold')] }, t(' start'))], 'a bold start is not a bullet');
});

test('headings show as headings (bold lines), closing hashes dropped', () => {
  assert.deepEqual(one('## Status ##'), [{ type: 'h', level: 2, children: [t('Status')] }]);
  assert.deepEqual(one('#hashtag'), [p(t('#hashtag'))]);
});

test('links: http, https and mailto only, with their text parsed', () => {
  assert.deepEqual(parseInline('see [the **docs**](https://docs.example/a?b=1)'),
    [t('see '), { type: 'link', href: 'https://docs.example/a?b=1', children: [t('the '), { type: 'strong', children: [t('docs')] }], host: 'docs.example' }]);
  assert.deepEqual(parseInline('[mail](mailto:someone@example.com)'), [{ type: 'link', href: 'mailto:someone@example.com', children: [t('mail')], host: 'someone@example.com' }]);
  assert.deepEqual(parseInline('[](https://x.example/)'), [{ type: 'link', href: 'https://x.example/', children: [t('https://x.example/')] }]);
  assert.deepEqual(parseInline('[see https://a.example](https://b.example/)'), [{ type: 'link', href: 'https://b.example/', children: [t('see https://a.example')], host: 'b.example' }], 'no link inside a link');
  assert.deepEqual(parseInline('[a [b] c](http://x.example/)'), [{ type: 'link', href: 'http://x.example/', children: [t('a [b] c')], host: 'x.example' }]);
});

// M2 (Ultron 11-11): a link must not read as somewhere it doesn't go. A bare or <...>
// URL is shown as URL rebuilt it; a written label is followed by the real host.
const RLO = String.fromCharCode(0x202e);
const link = (href, label, host) => ({ type: 'link', href, children: [t(label)], ...(host ? { host } : {}) });
test('deceptive links: the label never hides where a link goes', () => {
  assert.deepEqual(parseInline('[https://bank.example/login](https://evil.example/x)'),
    [link('https://evil.example/x', 'https://bank.example/login', 'evil.example')], 'a URL-shaped label still shows the real host');
  assert.deepEqual(parseInline("[the board](https://evil.example/)"), [link('https://evil.example/', 'the board', 'evil.example')]);
  assert.deepEqual(parseInline('[x](https://evil.example:8443/a)'), [link('https://evil.example:8443/a', 'x', 'evil.example:8443')], 'the port too');
  assert.deepEqual(parseInline('[https://x.example/](https://x.example/)'), [link('https://x.example/', 'https://x.example/')], 'no suffix when the label is the href');
  assert.deepEqual(parseInline('https://\u0430pple.com'), [link('https://xn--pple-43d.com/', 'https://xn--pple-43d.com/')], 'a Cyrillic look-alike shows as punycode');
  assert.deepEqual(parseInline('<https://\u0430pple.com>'), [link('https://xn--pple-43d.com/', 'https://xn--pple-43d.com/')]);
  assert.deepEqual(parseInline('[apple](https://\u0430pple.com)'), [link('https://xn--pple-43d.com/', 'apple', 'xn--pple-43d.com')]);
  assert.deepEqual(parseInline('https://a.com\u3002evil.com'), [link('https://a.com.evil.com/', 'https://a.com.evil.com/')], 'an ideographic full stop is a dot');
  assert.deepEqual(parseInline('https://evil.com\\@good.com'), [link('https://evil.com/@good.com', 'https://evil.com/@good.com')], 'a backslash is a slash: the host is evil.com');
  assert.deepEqual(parseInline(`https://x.example/a${RLO}gpj.exe`), [link('https://x.example/a%E2%80%AEgpj.exe', 'https://x.example/a%E2%80%AEgpj.exe')], 'a bidi override in a path is percent-encoded');
});

test('bidi controls and zero-width characters are dropped from a link label', () => {
  const hidden = [0x200b, 0x200c, 0x200d, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff].map(c => String.fromCharCode(c));
  for (const ch of hidden) {
    assert.deepEqual(parseInline(`[a${ch}b](https://x.example/)`), [link('https://x.example/', 'ab', 'x.example')], ch.charCodeAt(0).toString(16));
  }
  assert.deepEqual(parseInline(`[**a${RLO}**](https://x.example/)`), [{ type: 'link', href: 'https://x.example/', children: [{ type: 'strong', children: [t('a')] }], host: 'x.example' }]);
  assert.deepEqual(parseInline(`[\`${RLO}\`](https://x.example/)`), [link('https://x.example/', 'https://x.example/')], 'a label of nothing but them shows the href');
  assert.deepEqual(parseInline(`plain${RLO}text`), [t(`plain${RLO}text`)], 'outside a link label, text is left as written');
});

test('a mailto link keeps only its address', () => {
  assert.deepEqual(parseInline('[mail](mailto:a@b.example?subject=hi&body=x)'), [link('mailto:a@b.example', 'mail', 'a@b.example')]);
  assert.deepEqual(parseInline('[mail](mailto:a@b.example#x)'), [link('mailto:a@b.example', 'mail', 'a@b.example')]);
  assert.equal(safeHref('mailto:a@b.example?cc=c@d.example'), 'mailto:a@b.example');
});

test('a bare http(s) URL becomes a link, its trailing punctuation left out', () => {
  assert.deepEqual(parseInline('go to https://x.example/a.'), [t('go to '), { type: 'link', href: 'https://x.example/a', children: [t('https://x.example/a')] }, t('.')]);
  assert.deepEqual(parseInline('(https://x.example/a)'), [t('('), { type: 'link', href: 'https://x.example/a', children: [t('https://x.example/a')] }, t(')')]);
  assert.deepEqual(parseInline('**https://x.example/**'), [{ type: 'strong', children: [{ type: 'link', href: 'https://x.example/', children: [t('https://x.example/')] }] }]);
  assert.deepEqual(parseInline('xhttps://x.example'), [t('xhttps://x.example')], 'only at a word start');
  assert.deepEqual(parseInline('a <https://x.example/b> c'), [t('a '), { type: 'link', href: 'https://x.example/b', children: [t('https://x.example/b')] }, t(' c')]);
  assert.deepEqual(parseInline('<javascript:alert(1)>'), [t('<javascript:alert(1)>')]);
  assert.deepEqual(parseInline('javascript:alert(1)'), [t('javascript:alert(1)')]);
  assert.deepEqual(parseInline('data:text/html,<script>alert(1)</script>'), [t('data:text/html,<script>alert(1)</script>')]);
});

test('safeHref passes http, https and mailto, and nothing else', () => {
  assert.equal(safeHref('https://x.example/'), 'https://x.example/');
  assert.equal(safeHref('HTTP://X.EXAMPLE/a'), 'http://x.example/a');
  assert.equal(safeHref('mailto:a@b.example'), 'mailto:a@b.example');
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', '\u0001javascript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', 'file:///etc/passwd', '//evil.example/', '/relative', 'x.example',
    '&#106;avascript:alert(1)', 'https://x.example/a b', 'https:', 'https://', 'blob:https://x.example/1', 'mailto:', `https://x.example/${'a'.repeat(3000)}`, '', null, 7
  ]) assert.equal(safeHref(bad), null, String(bad).slice(0, 40));
});

test('hostile links never become links: their text stays as text', () => {
  for (const src of [
    '[click](javascript:alert(1))', '[click](JAVASCRIPT:alert(1))', '[click](data:text/html,x)', '[click](vbscript:x)',
    '[click](//evil.example)', '[click](/api/todos)', '[click]( javascript:alert(1))', '[click](&#106;avascript:alert(1))'
  ]) {
    const tree = parseMarkdown(src);
    assert.deepEqual(linksIn(tree), [], src);
    assert.ok(markdownPlain(src).includes('click'), src);
  }
  assert.deepEqual(linksIn(parseMarkdown('![alt](https://x.example/p.png)')), [], 'no images, and no link made of one either');
  assert.deepEqual(linksIn(parseMarkdown('[https://ok.example](javascript:alert(1))')), [], 'a refused link is all text, its label too');
  assert.equal(markdownPlain('[*a*](javascript:x)'), '[*a*](javascript:x)');
  assert.equal(markdownPlain('![alt](https://x.example/p.png)'), '![alt](https://x.example/p.png)');
});

test('raw HTML, scripts and on* attributes are only ever text', () => {
  const hostile = '<script>alert(1)</script> <img src=x onerror="alert(1)"> <a href="javascript:alert(1)">x</a> <iframe srcdoc="<b>">';
  const tree = parseMarkdown(hostile);
  for (const type of typesIn(tree)) assert.ok(ALLOWED_TYPES.has(type), type);
  assert.deepEqual(linksIn(tree), []);
  assert.equal(markdownPlain(hostile), hostile, 'every character still there, as text');
  // Not a single node anywhere carries anything but the known fields.
  walk(tree, n => {
    for (const k of Object.keys(n)) assert.ok(['type', 'children', 'items', 'text', 'href', 'level', 'start', 'host'].includes(k), k);
  });
});

test('every link in any parse has a checked href', () => {
  const mixed = '[a](https://ok.example) [b](javascript:x) https://bare.example [c](mailto:x@y.example) [d](data:x) <https://angle.example>';
  for (const href of linksIn(parseMarkdown(mixed))) assert.equal(safeHref(href), href);
  assert.deepEqual(linksIn(parseMarkdown(mixed)), ['https://ok.example/', 'https://bare.example/', 'mailto:x@y.example', 'https://angle.example/']);
});

// Pathological input: each case is built to make a backtracking or quadratic parser
// crawl. 60k characters must parse well inside a second; the same shape at a tenth
// of the size must not be much more than a tenth of the time.
const timed = fn => { const t0 = performance.now(); fn(); return performance.now() - t0; };
const SHAPES = {
  stars: n => '*a '.repeat(n),
  'open strong': n => '**a '.repeat(n),
  'mixed delims': n => '*_'.repeat(n) + 'x' + '_*'.repeat(n),
  backticks: n => Array.from({ length: n }, (_, i) => '`'.repeat((i % 7) + 1) + 'a').join(' '),
  brackets: n => '['.repeat(n) + 'a' + ']'.repeat(n),
  'link opens': n => '[a]('.repeat(n),
  'link no close': n => '[a](https://x.example/' + 'b'.repeat(n),
  'bare urls': n => 'https://'.repeat(n),
  'angle urls': n => '<https://'.repeat(n),
  'heading spaces': n => '# ' + ' '.repeat(n) + 'x',
  'heading hashes': n => '# ' + ' #'.repeat(n) + ' x',
  bullets: n => '- a\n'.repeat(n),
  'nested bullets': n => Array.from({ length: n }, (_, i) => ' '.repeat((i % 30) * 2) + '- a').join('\n'),
  fences: n => '```\n'.repeat(n),
  'unclosed fences': n => Array.from({ length: n }, (_, i) => '`'.repeat(3 + (i % 9)) + '\nx').join('\n'),
  blanks: n => '- a\n' + '\n'.repeat(n) + 'b',
  escapes: n => '\\'.repeat(n) + '*',
  underscores: n => 'a_'.repeat(n)
};
test('pathological input parses in linear time', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const big = make(20000).slice(0, 60000);
    const small = big.slice(0, 6000);
    parseMarkdown(small); // warm up
    const tBig = timed(() => parseMarkdown(big));
    const tSmall = Math.max(timed(() => parseMarkdown(small)), 0.5);
    assert.ok(tBig < 1000, `${name}: ${tBig.toFixed(0)} ms for ${big.length} characters`);
    assert.ok(tBig < tSmall * 40, `${name}: ${tBig.toFixed(1)} ms vs ${tSmall.toFixed(1)} ms at a tenth of the size`);
  }
});

test('nesting is capped: deep lists and deep emphasis stay bounded', () => {
  const depthOf = (node, d = 0) => {
    let max = d;
    for (const c of node.children ?? []) max = Math.max(max, depthOf(c, d + 1));
    for (const item of node.items ?? []) for (const c of item) max = Math.max(max, depthOf(c, d + 1));
    return max;
  };
  const deepList = Array.from({ length: 200 }, (_, i) => ' '.repeat(i * 2) + '- a').join('\n');
  assert.ok(depthOf(parseMarkdown(deepList)) <= MD_MAX_DEPTH * 2 + 4, 'list depth');
  assert.ok(markdownPlain(deepList).split('a').length - 1 === 200, 'nothing lost past the cap');
  const deepEm = '*_'.repeat(5000) + 'x' + '_*'.repeat(5000);
  assert.ok(depthOf(parseMarkdown(deepEm)) <= MD_MAX_INLINE_DEPTH + 3, 'emphasis depth');
  assert.equal(markdownPlain(deepEm).replace(/[*_]/g, ''), 'x');
  // Pairs that really nest, 2,000 deep: the cap shows the rest as their markers.
  const nested = '*a _a '.repeat(1000) + 'a_ a* '.repeat(1000);
  assert.ok(depthOf(parseMarkdown(nested)) <= MD_MAX_INLINE_DEPTH + 3, 'nested emphasis depth');
  assert.equal(markdownPlain(nested).replace(/[*_]/g, ''), nested.replace(/[*_]/g, ''));
});

test('input over the cap is one plain paragraph', () => {
  const huge = '**a** '.repeat(Math.ceil(MD_MAX_INPUT / 6) + 10);
  assert.deepEqual(parseMarkdown(huge).children, [p(t(huge))]);
  assert.equal(parseMarkdown(null).children.length, 0);
});

test('markdownPlain drops the markers and keeps the words (the reply quote uses it)', () => {
  assert.equal(markdownPlain('**Bold** and _em_ and `code` and [link](https://x.example)'), 'Bold and em and code and link');
  assert.equal(markdownPlain('- a\n- b'), 'a\nb');
  assert.equal(quoteLine({ text: '**Done:** shipped `v2` to [prod](https://x.example)' }), 'Done: shipped v2 to prod');
  assert.equal(quoteLine({ kind: 'event', text: 'job_a_b failed *twice*' }), 'job_a_b failed *twice*', 'an event quote stays as it is');
});
