import { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboard } from '../hooks/useDashboard.js';
import { useTick } from '../hooks/useTick.js';
import { useBoard } from './useBoard.js';
import { parseRoute, routeHash, freshness, headerDate } from '../lib/orbit/page.js';
import { boardTotals } from '../lib/orbit/board.js';
import { Overview } from './Overview.jsx';
import { HealthChips, HealthDetail } from './Health.jsx';
import { NowChip, NowDetail } from './Now.jsx';
import { nowFromPayload } from '../lib/orbit/now.js';
import { AlertStrip } from './Acks.jsx';
import { unack } from './ackApi.js';
import { BoardBand, BoardTab } from './Board.jsx';
import { useBoardFilters } from './useBoardFilters.js';
import { ChatTab } from './Chat.jsx';
import { useChat } from './useChat.js';
import { useUnseen } from './useUnseen.js';
import { useSwipeTabs } from './useSwipeTabs.js';
import { navStuck } from '../lib/orbit/nav.js';
import { badgeText, chatTabLabel } from '../lib/orbit/unseen.js';

const EMPTY_ROSTER = { agents: [], tagOwners: {} };

// The tab lives in the address (#overview, #board, #board/<id>, #chat), so Back
// works and a link can open the board on one item.
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

// The tabs stay in reach: once their place in the header scrolls away, the same
// nav is pinned to the top of the screen. Fixed, so nothing below it moves: its
// empty slot keeps the nav's height (CSS) and width (measured here as it leaves),
// or on a phone the title row would close up and the page jump.
function useStuckNav() {
  const slotRef = useRef(null);
  const [stuck, setStuck] = useState(null); // null, or the slot's width when it emptied
  useEffect(() => {
    const el = slotRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(entries => {
      const e = entries[entries.length - 1];
      const now = navStuck({ isIntersecting: e.isIntersecting, top: e.boundingClientRect.top });
      setStuck(was => (!now ? null : was ?? { width: e.boundingClientRect.width }));
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [slotRef, stuck];
}

export function OrbitApp() {
  const { payload, error, receivedAt, refresh } = useDashboard();
  const board = useBoard();
  const filters = useBoardFilters();
  const [route, go] = useRoute();
  // Every second for the countdown on the Overview; on the Board, every 10 s is
  // enough for "Updated", and typing stays smooth (the design pauses it there).
  // The Chat's ages and its pairing countdown move by the second too.
  const now = useTick(route.tab === 'board' ? 10_000 : 1000);
  // The chat's state lives only while its tab is open: the stream closes with it.
  const chat = useChat({ active: route.tab === 'chat' });
  // The badge on the Chat tab: the lead's messages this device hasn't shown yet.
  const unseen = useUnseen({ onChat: route.tab === 'chat', messages: chat.messages });
  useSwipeTabs({ tab: route.tab, go });
  const [navSlot, stuckNav] = useStuckNav();
  const navIsStuck = stuckNav !== null;
  // Why the board was opened on an item: just added on this page, or from
  // Waiting on you. A link from anywhere else is a "Linked item".
  const [focusFrom, setFocusFrom] = useState(null);
  // Waiting on you's picked tile, opened card and "Show all", kept here so Back
  // from the board finds the panel as it was.
  const [waiting, setWaiting] = useState({ filter: null, open: null, all: false });
  // The health chip whose details are open, if any. Escape closes them.
  const [chip, setChip] = useState(null);
  useEffect(() => {
    if (!chip) return undefined;
    const onKey = e => { if (e.key === 'Escape') setChip(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chip]);

  const config = payload?.config?.data ?? null;
  const roster = config?.roster ?? EMPTY_ROSTER;
  const lead = roster.agents[0] ?? null;
  const fresh = freshness({ serverTime: payload?.serverTime, receivedAt, error, now });
  const totals = boardTotals(board.todos);
  const isBoard = route.tab === 'board';
  const isChat = route.tab === 'chat';
  // The badge's count is in the link's name too ("Chat, 3 unread messages").
  const showBadge = !isChat && unseen.count > 0;
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  // The Now chip (Now.jsx), rebuilt each tick: its ages move by the second.
  const nowChip = isBoard || isChat ? null : nowFromPayload({ payload, roster, now });

  useEffect(() => {
    document.title = isBoard ? 'Board · Control Room' : isChat ? 'Chat · Control Room' : 'Control Room';
  }, [isBoard, isChat]);

  const openItem = (id, why) => {
    setFocusFrom(why === 'added' || why === 'waiting' ? { id, why } : null);
    go({ tab: 'board', item: id });
  };
  const focusWhy = route.item !== null && route.item === focusFrom?.id ? focusFrom.why : 'link';

  return (
    <div className={`o-page${isChat ? ' o-page-chat' : ''}${navIsStuck ? ' o-page-stuck' : ''}`}>
      <header className={`o-band${isBoard ? ' o-band-board' : ''}`}>
        <div className="o-wrap o-band-inner">
          <div className="o-titlebar">
            <div className="o-title">
              <h1>Control Room</h1>
              <span className="o-mono o-date">{lead ? `${lead.name} · ` : ''}{headerDate(now)}</span>
            </div>
            <div className="o-tabs-slot" ref={navSlot} style={navIsStuck ? { minWidth: `min(${stuckNav.width}px, 100%)` } : undefined}>
              <nav aria-label="Views" className={`o-tabs${navIsStuck ? ' o-tabs-stuck' : ''}`}>
                <a className="o-tab" href="#overview" aria-current={isBoard || isChat ? undefined : 'page'}>Overview</a>
                <a className="o-tab" href="#board" aria-current={isBoard ? 'page' : undefined}>
                  Board · {board.loaded ? totals.open : '—'}
                </a>
                <a className="o-tab" href="#chat" aria-current={isChat ? 'page' : undefined}
                  aria-label={showBadge ? chatTabLabel(unseen.count, unseen.more) : undefined}>
                  Chat{showBadge && <span className="o-tab-badge" aria-hidden="true">{badgeText(unseen.count, unseen.more)}</span>}
                </a>
              </nav>
            </div>
          </div>
          <div className="o-statusrow" role="group" aria-label="System health">
            <HealthChips env={payload?.health} fresh={fresh} open={chip} detailId="o-health-detail"
              onToggle={key => setChip(open => (open === key ? null : key))} />
            <span className={`o-mono o-updated o-updated-${fresh.tone}`} role="status">
              <span className="o-dot" aria-hidden="true" />{fresh.label}
            </span>
          </div>
          {chip && chip !== 'now' && <HealthDetail env={payload?.health} fresh={fresh} open={chip} now={now} id="o-health-detail"
            onUnack={async key => { await unack(key); await refresh(); }} />}
          {nowChip && (
            <div className="o-nowrow">
              <NowChip chip={nowChip} open={chip === 'now'} detailId="o-now-detail" onToggle={() => setChip(open => (open === 'now' ? null : 'now'))} />
            </div>
          )}
          {chip === 'now' && nowChip && <NowDetail chip={nowChip} now={now} id="o-now-detail" />}
          {isBoard && <BoardBand board={board} roster={roster} totals={totals} filters={filters} />}
        </div>
      </header>

      <AlertStrip alerts={alerts} now={now} onChanged={refresh} />

      {isChat && <ChatTab chat={chat} now={now} lead={lead} />}
      {isBoard && <BoardTab board={board} roster={roster} filters={filters} focus={route.item} focusWhy={focusWhy}
            onOpen={openItem} onCloseFocus={() => go({ tab: 'board' })} />}
      {!isBoard && !isChat && <Overview payload={payload} now={now} roster={roster} board={board} waiting={waiting} setWaiting={setWaiting}
            onOpenItem={id => openItem(id, 'waiting')} onChanged={refresh} />}
    </div>
  );
}
