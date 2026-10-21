import { useCallback, useEffect, useState } from 'react';
import { useDashboard } from '../hooks/useDashboard.js';
import { useTick } from '../hooks/useTick.js';
import { useBoard } from './useBoard.js';
import { parseRoute, routeHash, freshness, headerDate } from '../lib/orbit/page.js';
import { boardTotals } from '../lib/orbit/board.js';
import { Overview } from './Overview.jsx';
import { BoardBand, BoardTab } from './Board.jsx';
import { useBoardFilters } from './useBoardFilters.js';

const EMPTY_ROSTER = { agents: [], tagOwners: {} };

// The tab lives in the address (#overview, #board, #board/<id>), so Back works
// and a link can open the board on one item.
function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback(next => {
    const hash = routeHash(next);
    if (hash !== window.location.hash) window.location.hash = hash;
  }, []);
  return [route, go];
}

export function OrbitApp() {
  const { payload, error, receivedAt } = useDashboard();
  const board = useBoard();
  const filters = useBoardFilters();
  const [route, go] = useRoute();
  // Every second for the countdown on the Overview; on the Board, every 10 s is
  // enough for "Updated", and typing stays smooth (the design pauses it there).
  const now = useTick(route.tab === 'board' ? 10_000 : 1000);
  // The item this page just added, so the board can say "Just added" when it
  // opens on that one, and "Linked item" for any other link.
  const [justAdded, setJustAdded] = useState(null);

  const config = payload?.config?.data ?? null;
  const roster = config?.roster ?? EMPTY_ROSTER;
  const lead = roster.agents[0] ?? null;
  const fresh = freshness({ serverTime: payload?.serverTime, receivedAt, error, now });
  const totals = boardTotals(board.todos);
  const isBoard = route.tab === 'board';
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];

  useEffect(() => {
    document.title = isBoard ? 'Board · Control Room' : 'Control Room';
  }, [isBoard]);

  const openItem = (id, why) => {
    setJustAdded(why === 'added' ? id : null);
    go({ tab: 'board', item: id });
  };
  const focusWhy = route.item !== null && route.item === justAdded ? 'added' : 'link';

  return (
    <div className="o-page">
      <header className={`o-band${isBoard ? ' o-band-board' : ''}`}>
        <div className="o-wrap o-band-inner">
          <div className="o-titlebar">
            <div className="o-title">
              <h1>Control Room</h1>
              <span className="o-mono o-date">{lead ? `${lead.name} · ` : ''}{headerDate(now)}</span>
            </div>
            <nav aria-label="Views" className="o-tabs">
              <a className="o-tab" href="#overview" aria-current={isBoard ? undefined : 'page'}>Overview</a>
              <a className="o-tab" href="#board" aria-current={isBoard ? 'page' : undefined}>
                Board · {board.loaded ? totals.open : '—'}
              </a>
            </nav>
          </div>
          <div className="o-statusrow">
            <span className={`o-mono o-updated o-updated-${fresh.tone}`} role="status">
              <span className="o-dot" aria-hidden="true" />{fresh.label}
            </span>
          </div>
          {isBoard && <BoardBand board={board} roster={roster} totals={totals} filters={filters} />}
        </div>
      </header>

      {alerts.length > 0 && (
        <div className="o-alerts" role="alert">
          <div className="o-wrap o-alerts-inner">
            <span className="o-mono o-alerts-tag">Attention</span>
            {alerts.map((a, i) => <span key={i}>{a.text}</span>)}
          </div>
        </div>
      )}

      {isBoard
        ? <BoardTab board={board} roster={roster} filters={filters} focus={route.item} focusWhy={focusWhy}
            onOpen={openItem} onCloseFocus={() => go({ tab: 'board' })} />
        : <Overview payload={payload} now={now} roster={roster} />}
    </div>
  );
}
