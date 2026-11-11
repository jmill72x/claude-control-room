// A chat message's Markdown as React elements (the parser is src/lib/orbit/markdown.js).
// Only elements built here reach the page: text goes in as text children, which React
// escapes, and the one attribute taken from a message is a link's href, which the
// parser has already passed through safeHref. No dangerouslySetInnerHTML anywhere.
import { useMemo } from 'react';
import { parseMarkdown } from '../lib/orbit/markdown.js';

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text': return n.text;
      case 'strong': return <strong key={i}><Inline nodes={n.children} /></strong>;
      case 'em': return <em key={i}><Inline nodes={n.children} /></em>;
      case 'codespan': return <code key={i} className="o-md-code">{n.text}</code>;
      // The destination's host follows a written label, muted, so the label can't
      // pass for another place ("the board (evil.example)").
      case 'link': return (
        <a key={i} href={n.href} target="_blank" rel="noopener noreferrer"><Inline nodes={n.children} />{n.host && <span className="o-md-host"> ({n.host})</span>}</a>
      );
      default: return null;
    }
  });
}

function Blocks({ blocks }) {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'p': return <p key={i} className="o-md-p"><Inline nodes={b.children} /></p>;
      case 'h': return <p key={i} className="o-md-p o-md-h"><strong><Inline nodes={b.children} /></strong></p>;
      case 'code': return <pre key={i} className="o-md-pre"><code>{b.text}</code></pre>;
      case 'ul': return <ul key={i} className="o-md-list">{b.items.map((item, k) => <li key={k}><Blocks blocks={item} /></li>)}</ul>;
      case 'ol': return <ol key={i} className="o-md-list" start={b.start}>{b.items.map((item, k) => <li key={k}><Blocks blocks={item} /></li>)}</ol>;
      default: return null;
    }
  });
}

export default function Markdown({ text, className }) {
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return <div className={className}><Blocks blocks={tree.children} /></div>;
}
