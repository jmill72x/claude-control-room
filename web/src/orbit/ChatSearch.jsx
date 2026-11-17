import { useEffect, useRef, useState } from 'react';
import { searchMessages } from './chatApi.js';
import { hhmm } from '../lib/orbit/chat.js';
import { searchable, snippetParts, resultWho, searchSummary, SEARCH_DEBOUNCE_MS } from '../lib/orbit/chat-search.js';

// The Chat tab's search sheet (reached from the thread's ⋮ menu): a box, the matching
// messages newest first, and a tap on one closes the sheet and brings that message
// into view in the thread (useChat's `reach` loads older history as needed). A snippet
// is the message's raw text cut anywhere, so it is shown as plain text: text nodes,
// with <mark> around the words that matched, never parsed as Markdown.
const when = at => `${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hhmm(at)}`;

export function ChatSearch({ initial = '', onQuery, onPick, onClose }) {
  const [q, setQ] = useState(initial);
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const asked = useRef(0); // only the newest query's answer is shown

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const id = ++asked.current;
    if (!searchable(q)) { setAnswer(null); setError(null); setBusy(false); return undefined; }
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await searchMessages(q.trim());
        if (id !== asked.current) return;
        setAnswer(r);
        setError(null);
      } catch (err) {
        if (id !== asked.current) return;
        setAnswer(null);
        setError(String(err?.message ?? err));
      } finally {
        if (id === asked.current) setBusy(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const status = error ? `Couldn't search: ${error}` : busy ? 'Searching…' : answer ? searchSummary(answer) : q.trim() ? 'Type at least 2 characters.' : 'Words from any message, yours or Jarvis\'s.';
  return (
    <div className="o-chat o-chat-sheet-back" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="o-chat-sheet o-chat-search" role="dialog" aria-modal="true" aria-label="Search messages">
        <div className="o-chat-sheet-head">
          <h2 className="o-chat-h2">Search messages</h2>
          <button type="button" className="o-chat-iconbtn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <form role="search" onSubmit={e => e.preventDefault()}>
          <input ref={inputRef} type="search" className="o-input o-chat-input o-chat-search-input" value={q} maxLength={100} autoComplete="off" autoCapitalize="none" spellCheck={false}
            enterKeyHint="search" placeholder="Search" aria-label="Search messages" onChange={e => { setQ(e.target.value); onQuery?.(e.target.value); }} />
        </form>
        <p className={`o-chat-sub${error ? ' o-chat-card-error' : ''}`} role="status">{status}</p>
        {answer?.results?.length > 0 && (
          <ul className="o-chat-results" aria-label="Matching messages">
            {answer.results.map(r => (
              <li key={r.id}>
                <button type="button" className="o-chat-result" onClick={() => onPick(r)}>
                  <span className="o-chat-result-head">
                    <span className="o-chat-quote-who">{resultWho(r)}</span>
                    <time className="o-mono" dateTime={new Date(r.at).toISOString()}>{when(r.at)}</time>
                  </span>
                  <span className="o-chat-result-text">
                    {r.cutStart && '… '}
                    {snippetParts(r.snippet, r.marks).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    {r.cutEnd && ' …'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
