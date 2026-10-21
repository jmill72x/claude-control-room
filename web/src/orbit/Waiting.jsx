import { localToday } from '../lib/due.js';
import { waitingCards, waitingView } from '../lib/orbit/waiting.js';
import { Avatar } from './Avatar.jsx';

// Waiting on you, at the top of the Overview (Orbit plan, Phase 4): the count,
// three tiles that each show only their cards, and cards that open in place.
// Items come from the board (their `ask`), and To push from the server's
// `toPush` panel. `state` lives in OrbitApp, so Back from the board finds the
// panel as it was left.

const ICONS = {
  due: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  decide: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7" /><path d="M18 10.5c0 4-6 3.5-11 5.5" /></>,
  push: <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>
};

const domId = key => `o-wait-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;

function WaitCard({ card, open, onToggle, onOpenItem }) {
  const bodyId = domId(card.key);
  const tone = card.look === 'hot' ? 'night' : 'day';
  return (
    <div className={`o-wcard o-wcard-${card.look}${open ? ' o-wcard-open' : ''}`}>
      <button type="button" className="o-wcard-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle}>
        <span className="o-wcard-top">
          <span className="o-mono o-wchip">{card.chip}</span>
          <span className="o-wcard-icons">
            <Avatar agent={card.owner} fallback={card.fallback} size={26} tone={tone} />
            <svg className="o-wcard-turn" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </span>
        </span>
        <span className="o-wcard-title">{card.title}</span>
      </button>
      {open && (
        <div className="o-wcard-body" id={bodyId}>
          <div className="o-wcard-cols">
            <div className="o-wcard-col">
              <h3 className="o-mono o-wcard-h">What you do</h3>
              <p>{card.what}</p>
            </div>
            {card.why && (
              <div className="o-wcard-col">
                <h3 className="o-mono o-wcard-h">Why it matters</h3>
                <p>{card.why}</p>
              </div>
            )}
          </div>
          <div className="o-wcard-foot">
            <span className="o-wcard-who">
              <Avatar agent={card.owner} fallback={card.fallback} size={22} tone={tone} />
              <b>{card.owner?.name ?? 'No owner'}</b>
              <span>{card.meta}</span>
            </span>
            {card.itemId !== null && (
              <button type="button" className="o-btn o-wcard-board" onClick={() => onOpenItem(card.itemId)}>
                Open on the board
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Waiting({ board, payload, roster, now, state, setState, onOpenItem }) {
  const cards = waitingCards({ items: board.todos, today: localToday(new Date(now)), roster, toPushEnv: payload?.toPush });
  const view = waitingView(cards, { filter: state.filter, all: state.all });
  const loading = !board.loaded;
  const pick = id => setState(s => ({ filter: s.filter === id ? null : id, open: null, all: false }));
  // What To push could not count, and why, shows when its tile is picked.
  const notes = state.filter === 'push' ? cards.pushNotes : [];

  return (
    <section aria-labelledby="o-wait" className="o-panel o-wait">
      <div className="o-wait-head">
        <div className="o-wait-count">
          <span className="o-wait-big">{loading ? '—' : view.total}</span>
          <h2 id="o-wait" className="o-h2 o-h2-accent o-wait-title">Waiting<br />on you</h2>
        </div>
        <div role="group" aria-label="Show only" className="o-wait-tiles">
          {view.tiles.map(t => (
            <button key={t.id} type="button" aria-pressed={state.filter === t.id} className={`o-wtile o-wtile-${t.id}`} onClick={() => pick(t.id)}>
              <span className="o-wtile-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICONS[t.id]}</svg>
              </span>
              <span className="o-wtile-text">
                <span className="o-wtile-n">{loading || t.n === null ? '—' : t.n}</span>
                <span className="o-mono o-wtile-label">{t.label}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {loading ? <p className="o-note">{board.error ?? 'Loading the board…'}</p> : (
        <>
          {view.total > 0 && (
            <div className="o-showing">
              <span>{view.showing}</span>
              <span>Tap a card for details. Tap a tile to show only those.</span>
            </div>
          )}
          <div className="o-wcards">
            {view.shown.map(c => (
              <WaitCard key={c.key} card={c} open={state.open === c.key} onOpenItem={onOpenItem}
                onToggle={() => setState(s => ({ ...s, open: s.open === c.key ? null : c.key }))} />
            ))}
            {view.empty && (
              <div className="o-wempty">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1E7A4B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                <span>{view.empty}</span>
              </div>
            )}
          </div>
          {(view.more > 0 || view.fewer) && (
            <button type="button" className="o-btn o-btn-quiet o-more" onClick={() => setState(s => ({ ...s, all: !s.all, open: null }))}>
              {view.fewer ? 'Show fewer' : `Show all ${view.more}`}
            </button>
          )}
          {notes.map(n => <p key={n} className="o-note">{n}</p>)}
        </>
      )}
    </section>
  );
}
