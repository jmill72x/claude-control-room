// The chat's Markdown subset: bold, italic, inline code, fenced code blocks, bulleted
// and numbered lists, headings (shown as bold lines) and links. Escaping first: the
// parser returns plain objects, never HTML, and Markdown.jsx turns them into React
// elements, so every character of a message reaches the page as a text node. The
// only attribute a message can set is a link's href, and only after safeHref has
// passed it (http, https or mailto, parsed by URL and rebuilt from it).
//
// Left out on purpose: raw HTML (shown as the text it is), images (`![a](u)` stays
// literal text), block quotes, tables, autolinks for anything but a bare http(s) URL.
//
// Linear time: no regex here can backtrack on a long line (each is anchored and
// bounded, or replaced by a hand-written scan), code span closers are found from a
// table of backtick runs, link brackets from one stack pass, URL ends from a
// precomputed "next stop" table, and emphasis from one stack per marker (an opener
// is pushed and popped once). Nesting is capped (lists MD_MAX_DEPTH, emphasis
// MD_MAX_INLINE_DEPTH) so a hostile message can't build a tree deep enough to blow
// the stack when it is rendered, and anything over MD_MAX_INPUT is one plain
// paragraph. The tests (web/test/orbit-markdown.test.js) time pathological shapes.

export const MD_MAX_INPUT = 64000; // the server keeps 32,000 characters at most
export const MD_MAX_DEPTH = 6;
export const MD_MAX_INLINE_DEPTH = 8;
const MAX_HREF = 2048;

const text = t => ({ type: 'text', text: t });

// A link target the page may use, rebuilt by URL, or null. The raw text must start
// with the scheme itself (no leading space or control character for the URL parser
// to strip) and hold no whitespace or control character anywhere. `host` is what the
// page shows after a link's label so a label can't pass for another place: the real
// host as URL spells it (punycode, its port if any), or a mailto's address. A
// mailto keeps only its address: a query (`?subject=…&body=…`) is dropped.
export function linkTarget(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_HREF) return null;
  if (!/^(?:https?:\/\/|mailto:)/i.test(raw)) return null;
  for (let k = 0; k < raw.length; k++) {
    const c = raw.charCodeAt(k);
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return null;
  }
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.href.length > MAX_HREF) return null;
  if (url.protocol === 'mailto:') return url.pathname ? { href: `mailto:${url.pathname}`, host: url.pathname } : null;
  // A special scheme's URL always has a host (`https://` alone throws above).
  if (url.protocol === 'http:' || url.protocol === 'https:') return { href: url.href, host: url.host };
  return null;
}

export const safeHref = raw => linkTarget(raw)?.href ?? null;

// Characters that change how a label reads without showing: the bidi embeddings,
// overrides and isolates (U+202A-202E, U+2066-2069) and the zero-width ones (U+200B-
// 200D, U+FEFF). They are dropped from a link's label. Built from code points, so no
// invisible character sits in this file.
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]);
const dropInvisible = str => {
  let out = '';
  for (let k = 0; k < str.length; k++) if (!INVISIBLE.has(str.charCodeAt(k))) out += str[k];
  return out;
};
const cleanLabel = nodes => nodes.flatMap(n => {
  if (n.type === 'text' || n.type === 'codespan') {
    const t = dropInvisible(n.text);
    return t ? [{ ...n, text: t }] : [];
  }
  const children = cleanLabel(n.children);
  return children.length ? [{ ...n, children }] : [];
});

// ---- blocks ----

const isBlank = line => line.trim() === '';
const indentOf = line => { let i = 0; while (i < line.length && line[i] === ' ') i++; return i; };
// Leading tabs become spaces to the next multiple of four.
const expandTabs = line => {
  if (!line.startsWith('\t') && !line.startsWith(' \t') && !line.startsWith('  \t') && !line.startsWith('   \t')) return line;
  let out = '';
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') out += ' '.repeat(4 - (out.length % 4));
    else out += ' ';
    i++;
  }
  return out + line.slice(i);
};

// A list item's first line: its kind, number, and where its content starts.
const ITEM = /^( {0,3})([-*+]|(\d{1,9})([.)]))( +|$)/;
function itemStart(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2].length;
  const spaces = m[5].length;
  const col = indent + marker + (spaces >= 1 && spaces <= 4 ? spaces : 1);
  const content = line.slice(Math.min(col, line.length));
  const ordered = m[3] !== undefined;
  const start = ordered ? Number(m[3]) : null;
  return {
    indent, col, content, ordered, start,
    key: ordered ? m[4] : m[2],
    // A bullet, or a numbered list starting at 1, may follow a paragraph line directly.
    canInterrupt: content.trim() !== '' && (!ordered || start === 1)
  };
}

function fenceOpen(line) {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const ch = line[indent];
  if (ch !== '`' && ch !== '~') return null;
  let n = indent;
  while (line[n] === ch) n++;
  const len = n - indent;
  if (len < 3) return null;
  if (ch === '`' && line.indexOf('`', n) !== -1) return null;
  return { ch, len, indent };
}

const isFenceClose = (line, fence) => {
  const indent = indentOf(line);
  if (indent > 3) return false;
  let n = indent;
  while (line[n] === fence.ch) n++;
  return n - indent >= fence.len && line.slice(n).trim() === '';
};

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
function heading(line) {
  const m = HEADING.exec(line);
  if (!m) return null;
  let rest = line.slice(m[0].length).trim();
  // Closing hashes go when a space sits before them (or they are all there is).
  if (rest.endsWith('#')) {
    let j = rest.length;
    while (j > 0 && rest[j - 1] === '#') j--;
    if (j === 0) rest = '';
    else if (rest[j - 1] === ' ' || rest[j - 1] === '\t') rest = rest.slice(0, j).trim();
  }
  return { type: 'h', level: m[1].length, children: parseInline(rest) };
}

function readFence(lines, i, fence, out) {
  const body = [];
  let j = i + 1;
  while (j < lines.length && !isFenceClose(lines[j], fence)) {
    const line = lines[j];
    body.push(line.slice(Math.min(fence.indent, indentOf(line))));
    j++;
  }
  out.push({ type: 'code', text: body.join('\n') });
  return j < lines.length ? j + 1 : j;
}

function readList(lines, i, first, depth, out) {
  const items = [];
  const open = it => ({ lines: [it.content], col: it.col, indent: it.indent });
  // A line indented this far belongs to the item: its content column, or two past
  // the marker's indent, whichever is less (a nested list under "1. " is often
  // indented two, not three).
  const reach = item => Math.min(item.col, item.indent + 2);
  const sameList = it => it && it.key === first.key && it.ordered === first.ordered;
  let cur = open(first);
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k >= lines.length) break;
      const next = lines[k];
      if (indentOf(next) >= reach(cur) || sameList(itemStart(next))) {
        for (let b = j; b < k; b++) cur.lines.push('');
        j = k;
        continue;
      }
      break;
    }
    const ind = indentOf(line);
    if (ind >= reach(cur)) {
      cur.lines.push(line.slice(Math.min(ind, cur.col)));
      j++;
      continue;
    }
    const it = itemStart(line);
    if (sameList(it)) {
      items.push(cur);
      cur = open(it);
      j++;
      continue;
    }
    break;
  }
  items.push(cur);
  const children = item => {
    if (depth + 1 < MD_MAX_DEPTH) return parseBlocks(item.lines, depth + 1);
    const flat = item.lines.join('\n');
    return flat.trim() === '' ? [] : [{ type: 'p', children: [text(flat)] }];
  };
  const list = items.map(children);
  out.push(first.ordered ? { type: 'ol', start: first.start, items: list } : { type: 'ul', items: list });
  return j;
}

function parseBlocks(lines, depth) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push({ type: 'p', children: parseInline(para.join('\n')) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { flush(); i++; continue; }
    const fence = fenceOpen(line);
    if (fence) { flush(); i = readFence(lines, i, fence, out); continue; }
    const h = heading(line);
    if (h) { flush(); out.push(h); i++; continue; }
    const item = itemStart(line);
    if (item && (para.length === 0 || item.canInterrupt)) { flush(); i = readList(lines, i, item, depth, out); continue; }
    para.push(line.trimStart());
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src) {
  if (typeof src !== 'string' || src === '') return { type: 'root', children: [] };
  if (src.length > MD_MAX_INPUT) return { type: 'root', children: [{ type: 'p', children: [text(src)] }] };
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  return { type: 'root', children: parseBlocks(lines, 0) };
}

// ---- inline ----

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const isWs = ch => ch === undefined || /\s/.test(ch);
const isPunct = ch => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
const isWordChar = ch => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
const URL_TRAIL = new Set(['.', ',', ':', ';', '!', '?', "'", '"', '*', '_', '~', ']']);

// For each index, the first index at or after it where `stop` holds (or the length).
function nextStops(s, stop) {
  const out = new Int32Array(s.length + 1);
  out[s.length] = s.length;
  for (let k = s.length - 1; k >= 0; k--) out[k] = stop(s[k]) ? k : out[k + 1];
  return out;
}

// One pass for the backtick runs (a backslash-escaped backtick starts none) and the
// bracket pairs (escaped brackets take no part).
function scanMarks(s) {
  const runs = new Map(); // start -> { len, next } where next is the next run of that length
  const lastOfLen = new Map();
  const close = new Int32Array(s.length).fill(-1);
  const stack = [];
  for (let k = 0; k < s.length;) {
    const ch = s[k];
    if (ch === '\\' && ASCII_PUNCT.test(s[k + 1] ?? '')) { k += 2; continue; }
    if (ch === '`') {
      let n = k;
      while (s[n] === '`') n++;
      const run = { start: k, len: n - k, next: null };
      const prev = lastOfLen.get(run.len);
      if (prev) prev.next = run;
      lastOfLen.set(run.len, run);
      runs.set(k, run);
      k = n;
      continue;
    }
    if (ch === '[') stack.push(k);
    else if (ch === ']' && stack.length) close[stack.pop()] = k;
    k++;
  }
  return { runs, close };
}

const OTHER = { '*': '_', _: '*' };

export function parseInline(src, { links = true } = {}) {
  if (typeof src !== 'string' || src === '') return [];
  const { runs, close } = scanMarks(src);
  const urlEnd = nextStops(src, ch => isWs(ch) || ch === '<' || ch === '>' || ch === '`');
  const targetEnd = links ? nextStops(src, ch => ch === ')' || isWs(ch)) : null;
  const tokens = [];
  let buf = '';
  const flush = () => { if (buf) { tokens.push({ kind: 'text', text: buf }); buf = ''; } };
  const stacks = { '*': [], _: [] };
  let seq = 0;
  let pairId = 0;

  // `[label](target)` starting at the bracket at `b`: where it ends and its href
  // (null when the target is not one the page may use), or null when it isn't
  // link syntax at all.
  const linkAt = b => {
    const c = close[b];
    if (c === -1 || src[c + 1] !== '(') return null;
    const start = c + 2;
    const end = targetEnd[start];
    if (src[end] !== ')') return null;
    const target = end - start <= MAX_HREF ? linkTarget(src.slice(start, end)) : null;
    return { label: src.slice(b + 1, c), end: end + 1, href: target?.href ?? null, host: target?.host ?? null };
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && ASCII_PUNCT.test(src[i + 1] ?? '')) { buf += src[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const run = runs.get(i);
      if (run && run.next) {
        let code = src.slice(i + run.len, run.next.start).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
        flush();
        tokens.push({ kind: 'node', node: { type: 'codespan', text: code } });
        i = run.next.start + run.next.len;
        continue;
      }
      const len = run ? run.len : 1;
      buf += '`'.repeat(len);
      i += len;
      continue;
    }
    if (links && ch === '!' && src[i + 1] === '[') {
      // No images: the whole of `![alt](url)` stays as the text it is.
      const link = linkAt(i + 1);
      if (link) { buf += src.slice(i, link.end); i = link.end; continue; }
      buf += '!';
      i++;
      continue;
    }
    if (links && ch === '[') {
      const link = linkAt(i);
      if (link && link.href) {
        // The label is the author's; the host after it is the truth (shown unless the
        // label is the href itself).
        const label = cleanLabel(parseInline(link.label, { links: false }));
        const node = { type: 'link', href: link.href, children: label.length ? label : [text(link.href)] };
        if (label.length && inlinePlain(label) !== link.href) node.host = link.host;
        flush();
        tokens.push({ kind: 'node', node });
        i = link.end;
        continue;
      }
      if (link) { buf += src.slice(i, link.end); i = link.end; continue; }
      buf += '[';
      i++;
      continue;
    }
    if (links && ch === '<' && /^https?:\/\//i.test(src.slice(i + 1, i + 9))) {
      // `<https://…>`: the brackets go, the URL inside is a link if it passes.
      const end = urlEnd[i + 1];
      const href = src[end] === '>' ? safeHref(src.slice(i + 1, end)) : null;
      if (href) {
        flush();
        tokens.push({ kind: 'node', node: { type: 'link', href, children: [text(href)] } });
        i = end + 1;
        continue;
      }
    }
    if (links && (ch === 'h' || ch === 'H') && !isWordChar(src[i - 1])) {
      const head = src.slice(i, i + 8).toLowerCase();
      if (head.startsWith('http://') || head === 'https://') {
        let end = urlEnd[i];
        if (end - i <= MAX_HREF * 2) {
          let opens = 0, closes = 0;
          for (let k = i; k < end; k++) { if (src[k] === '(') opens++; else if (src[k] === ')') closes++; }
          while (end > i) {
            const last = src[end - 1];
            if (URL_TRAIL.has(last)) { end--; continue; }
            if (last === ')' && closes > opens) { closes--; end--; continue; }
            break;
          }
        }
        const candidate = src.slice(i, end);
        const href = safeHref(candidate);
        if (href) {
          flush();
          // Shown as URL rebuilt it (punycode host, odd characters percent-encoded),
          // never as typed, so a look-alike can't pass for the real address.
          tokens.push({ kind: 'node', node: { type: 'link', href, children: [text(href)] } });
        } else buf += candidate;
        i = end;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      let n = i;
      while (src[n] === ch) n++;
      const count = n - i;
      const prev = src[i - 1];
      const next = src[n];
      const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      let canOpen = ch === '*' ? left : left && (!right || isPunct(prev));
      let canClose = ch === '*' ? right : right && (!left || isPunct(next));
      if (count > 3) canOpen = canClose = false;
      flush();
      const d = { kind: 'delim', ch, count, seq: seq++, opens: [], closes: [] };
      tokens.push(d);
      if (canClose) {
        const own = stacks[ch];
        const other = stacks[OTHER[ch]];
        while (d.count > 0 && own.length) {
          const o = own[own.length - 1];
          // An opener of the other marker inside this pair can no longer close.
          while (other.length && other[other.length - 1].seq > o.seq) other.pop();
          const use = o.count >= 2 && d.count >= 2 ? 2 : 1;
          const id = pairId++;
          o.count -= use;
          d.count -= use;
          o.opens.push({ id, use, type: use === 2 ? 'strong' : 'em' });
          d.closes.push({ id, use });
          if (o.count === 0) own.pop();
        }
      }
      if (d.count > 0 && canOpen) stacks[ch].push(d);
      i = n;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return buildTree(tokens);
}

// The flat tokens to a tree. Pairs nest by construction; past the depth cap a pair
// is shown as the markers it was made of.
function buildTree(tokens) {
  const root = { children: [] };
  const stack = [{ node: root, id: null }];
  const literal = new Set();
  const append = node => {
    const kids = stack[stack.length - 1].node.children;
    const last = kids[kids.length - 1];
    if (node.type === 'text') {
      if (!node.text) return;
      if (last && last.type === 'text') { last.text += node.text; return; }
    }
    kids.push(node);
  };
  for (const tok of tokens) {
    if (tok.kind === 'text') { append(text(tok.text)); continue; }
    if (tok.kind === 'node') { append(tok.node); continue; }
    for (const c of tok.closes) {
      if (literal.has(c.id)) { append(text(tok.ch.repeat(c.use))); continue; }
      const top = stack.pop();
      append(top.node);
    }
    if (tok.count > 0) append(text(tok.ch.repeat(tok.count)));
    for (let k = tok.opens.length - 1; k >= 0; k--) {
      const o = tok.opens[k];
      if (stack.length > MD_MAX_INLINE_DEPTH) {
        literal.add(o.id);
        append(text(tok.ch.repeat(o.use)));
        continue;
      }
      stack.push({ node: { type: o.type, children: [] }, id: o.id });
    }
  }
  // Every opener recorded is closed by construction; close anything left anyway.
  while (stack.length > 1) append(stack.pop().node);
  return root.children;
}

// ---- plain text ----

const inlinePlain = nodes => nodes.map(n => (n.type === 'text' || n.type === 'codespan' ? n.text : inlinePlain(n.children))).join('');
const blocksPlain = blocks => blocks.map(b => {
  if (b.type === 'code') return b.text;
  if (b.type === 'ul' || b.type === 'ol') return b.items.map(blocksPlain).join('\n');
  return inlinePlain(b.children);
}).join('\n');

// A message's words without its markers (the reply quote's one line).
export const markdownPlain = src => blocksPlain(parseMarkdown(src).children);
