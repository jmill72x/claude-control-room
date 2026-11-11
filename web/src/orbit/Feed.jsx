// The Feed tab (Jarvis OS Phase 2): what each agent and job posted to its feed, newest
// first, a filter by agent, and the lead's newest morning brief and weekly digest
// pinned on top. Every text is remote-derived (web summaries, CBS notes): it goes
// through the chat's Markdown component, which builds only its own elements and
// shows each link's real destination. Nothing here sets HTML.
import { useState } from 'react';
import { Avatar } from './Avatar.jsx';
import Markdown from './Markdown.jsx';
import { ago } from '../lib/orbit/page.js';
import { feedView, agentFor, bodyOf, isLong, dayLabel, whenLabel, emptyWords, droppedWords } from '../lib/orbit/feed.js';

function Post({ post, roster, now, open, onToggle, pinned = false }) {
  const agent = agentFor(post.agent, roster);
  const body = bodyOf(post);
  const long = isLong(body);
  const folded = long && !open;
  const bodyId = `o-feed-body-${post.id}`;
  return (
    <article className={`o-feed-card${pinned ? ' o-feed-pin' : ''}`} aria-label={`${pinned ? `${post.label}, ` : ''}${agent.name}, ${whenLabel(post.at, now)}`}>
      <header className="o-feed-head">
        <Avatar agent={agent} size={28} />
        <span className="o-feed-who">{agent.name}</span>
        {pinned && <span className="o-feed-kind">{post.label}</span>}
        <time className="o-feed-when" dateTime={new Date(post.at).toISOString()}>{whenLabel(post.at, now)}</time>
      </header>
      {post.title && <h3 className="o-feed-title">{post.title}</h3>}
      {body && (
        <div id={bodyId} className={`o-feed-body${folded ? ' o-feed-folded' : ''}`}>
          <Markdown text={body} className="o-md o-feed-text" />
        </div>
      )}
      {(long || post.truncated) && (
        <div className="o-feed-foot">
          {long && <button type="button" className="o-cbtn o-cbtn-small" aria-expanded={!folded} aria-controls={bodyId} onClick={onToggle}>{folded ? 'Show all' : 'Show less'}</button>}
          {post.truncated && <span className="o-chat-sub">Cut short in the feed log; the full text is in Discord.</span>}
        </div>
      )}
    </article>
  );
}

export function FeedTab({ feed, now, roster, filter, setFilter }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = id => setOpen(was => { const next = new Set(was); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (feed.phase === 'loading' && !feed.feed) return <div className="o-wrap o-chat o-chat-note" role="status">Loading the feeds…</div>;
  if (feed.phase === 'unpaired') {
    return (
      <div className="o-wrap o-chat o-chat-note">
        <p>The feeds open on a paired device. Pair this one in the Chat tab, then come back.</p>
        <a className="o-cbtn" href="#chat">Go to Chat</a>
      </div>
    );
  }
  if (feed.phase === 'forbidden') return <div className="o-wrap o-chat o-chat-note">The feeds are readable only as the owner, through the tailnet.</div>;
  if (feed.phase === 'error' && !feed.feed) {
    return (
      <div className="o-wrap o-chat o-chat-note">
        <p>Couldn't load the feeds: {feed.problem ?? 'unknown problem'}.</p>
        <button type="button" className="o-cbtn" onClick={feed.reload}>Try again</button>
      </div>
    );
  }

  const view = feedView(feed.feed, { filter, roster });
  let lastDay = null;
  return (
    <div className="o-chat o-feed">
      <div className="o-feed-wrap">
        <div className="o-feed-bar">
          <h2 className="o-chat-h2">Feed</h2>
          <span className="o-chat-sub" role="status">
            {feed.phase === 'error' ? `Not updated: ${feed.problem ?? 'unknown problem'}` : feed.loadedAt ? `Updated ${ago(now - feed.loadedAt)}` : ''}
          </span>
        </div>
        <div className="o-feed-filters" role="group" aria-label="Show posts from">
          {view.filters.map(f => (
            <button key={f.key ?? '*'} type="button" className="o-feed-filter" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.name} <span className="o-feed-count">{f.count}</span>
            </button>
          ))}
        </div>
        {view.pins.length > 0 && (
          <section className="o-feed-pins" aria-label="Pinned">
            {view.pins.map(x => <Post key={`pin-${x.id}`} post={x} roster={roster} now={now} pinned open={open.has(x.id)} onToggle={() => toggle(x.id)} />)}
          </section>
        )}
        {view.posts.length === 0 && view.pins.length === 0 && <p className="o-feed-empty">{emptyWords(feed.feed?.status)}</p>}
        {view.posts.length > 0 && (
          <ol className="o-feed-list" aria-label="Posts, newest first">
            {view.posts.map(x => {
              const day = dayLabel(x.at, now);
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <li key={x.id}>
                  {showDay && <div className="o-chat-day"><span>{day}</span></div>}
                  <Post post={x} roster={roster} now={now} open={open.has(x.id)} onToggle={() => toggle(x.id)} />
                </li>
              );
            })}
          </ol>
        )}
        {filter === null && droppedWords(feed.feed?.dropped) && <p className="o-feed-empty">{droppedWords(feed.feed.dropped)}</p>}
      </div>
    </div>
  );
}
