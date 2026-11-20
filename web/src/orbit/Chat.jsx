import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useReducedMotion } from './useReducedMotion.js';
import { Avatar } from './Avatar.jsx';
import Markdown from './Markdown.jsx';
import { attachmentUrl } from './chatApi.js';
import { prepareFile } from './photo.js';
import * as push from './pushApi.js';
import { holdReload } from './buildWatch.js';
import { ChatSearch } from './ChatSearch.jsx';
import { getSpeaker, useCanSpeak, useMiniVoice, useSpeaking, useSpeechLoading, useStopSpeechWhenAway, useVoices } from './useSpeaker.js';
import { langLabel, MINI, SAMPLE_ID } from '../lib/orbit/speech.js';
import { reachProblem } from '../lib/orbit/chat-search.js';
import { pushView } from '../lib/orbit/push.js';
import { clock } from '../lib/orbit/page.js';
import {
  threadRows, tickFor, TICK_MARKS, TICK_WORDS, bannerFor, effectiveStatus, permissionView, cardFields, exactRows, spacesMark, spacesLabel, markerSegments, hasMarker, shownInput, armedCopy, ALLOW_ARM_MS, sentLine, cardGone, DENY_ONLY_LEAD,
  quoted, quoteLine, fileSize, hhmm, MAX_TEXT,
  MAX_FILES, PDF_TYPE, ACCEPT, intake, transferFiles, dragHasFiles, defaultDeviceName, eventLine, quoteWho,
  isPhotoType, fileWord, viaWords, routineWord, unsentWords, writtenWords, keyLine, keyRows, keyGone, codeState, KEY_IDLE_DAYS, ageLine, expiredLine
} from '../lib/orbit/chat.js';
import { RunbookLink } from './Runbook.jsx';
import { RecoverButton, RecoverMenuItem } from './Recover.jsx';
import { noteQueued } from '../lib/orbit/runbook.js';

// The Chat tab (jarvis-os-chat-spec.md, C5): the pairing screen when this device
// holds no cookie, else the thread with the owner on the right and the lead on
// the left, the status banner, the permission cards, the composer and the
// settings sheet. Phone first; on a wide screen the thread sits centred at a
// reading width. Nothing here carries an inline style attribute: the policy has
// no 'unsafe-inline', and the few sizes set at runtime go through the CSSOM.

const HOW_TO_APPROVE = 'Approve it from a device that is already paired (Settings in its Chat tab), or on the machine run';

export function ChatTab({ chat, now, lead }) {
  const [settings, setSettings] = useState(false);
  if (chat.phase === 'checking') return <div className="o-wrap o-chat o-chat-note" role="status">Opening the chat…</div>;
  if (chat.phase === 'unpaired') return <Pairing chat={chat} now={now} />;
  if (chat.phase === 'off') return <div className="o-wrap o-chat o-chat-note">The chat isn't switched on on this server yet.</div>;
  if (chat.phase === 'forbidden') return <div className="o-wrap o-chat o-chat-note">The chat is reachable only as the owner, through the tailnet.</div>;
  if (chat.phase === 'error') {
    return (
      <div className="o-wrap o-chat o-chat-note">
        <p>Couldn't open the chat: {chat.problem ?? 'unknown problem'}.</p>
        <button type="button" className="o-cbtn" onClick={chat.reload}>Try again</button>
      </div>
    );
  }
  return (
    <>
      <Thread chat={chat} now={now} lead={lead} onSettings={() => setSettings(true)} />
      {settings && <SettingsSheet chat={chat} now={now} onClose={() => setSettings(false)} />}
    </>
  );
}

// ---- pairing (§2.2) ----

function Pairing({ chat, now }) {
  const [name, setName] = useState(() => defaultDeviceName(window.navigator));
  const p = chat.pairing;
  const submit = e => {
    e.preventDefault();
    if (name.trim()) chat.startPairing(name.trim());
  };
  const left = p?.expiresAt ? Math.max(0, Math.ceil((p.expiresAt - now) / 1000)) : null;
  return (
    <div className="o-wrap o-chat">
      <div className="o-chat-pair" role="region" aria-label="Pair this device">
        <h2 className="o-chat-h2">Pair this device</h2>
        {!p && (
          <form className="o-chat-pair-form" onSubmit={submit}>
            <p className="o-chat-p">Messages with Jarvis stay on the tailnet. Give this device a name, then approve the code it shows.</p>
            <label className="o-field">
              <span className="o-chat-label">Device name</span>
              <input className="o-input o-chat-input" value={name} maxLength={40} autoComplete="off" placeholder="iPhone" onChange={e => setName(e.target.value)} />
            </label>
            <button type="submit" className="o-cbtn o-cbtn-primary" disabled={!name.trim()}>Get a code</button>
          </form>
        )}
        {p && p.state === 'starting' && <p className="o-chat-p" role="status">Asking for a code…</p>}
        {p && p.code && (p.state === 'pending' || p.state === 'error') && (
          <div className="o-chat-pair-code" role="status">
            <span className="o-chat-label">Code for {p.name}</span>
            <span className="o-mono o-chat-code" aria-label={`Pairing code ${p.code.split('').join(' ')}`}>{p.code}</span>
            <p className="o-chat-p">
              {HOW_TO_APPROVE} <code className="o-mono o-chat-cmd">bin/chat-pair {p.code}</code>.
              {left !== null && <> The code lasts {left > 60 ? `${Math.floor(left / 60)} more minutes` : `${left} s`}.</>}
            </p>
            <p className="o-chat-sub">{p.state === 'error' ? `Couldn't check: ${p.error}` : 'Waiting for the approval…'}</p>
            <button type="button" className="o-cbtn" onClick={chat.cancelPairing}>Start over</button>
          </div>
        )}
        {p && !p.code && p.state === 'pending' && (
          <div className="o-chat-pair-code" role="status">
            <p className="o-chat-p">A pairing from this device is waiting for its approval (the code was shown before this page reloaded). {HOW_TO_APPROVE} <code className="o-mono o-chat-cmd">bin/chat-pair &lt;CODE&gt;</code>.</p>
            <button type="button" className="o-cbtn" onClick={chat.cancelPairing}>Start over</button>
          </div>
        )}
        {p && !p.code && p.state === 'error' && (
          <div className="o-chat-pair-code" role="alert">
            <p className="o-chat-p">Couldn't start the pairing: {p.error}.</p>
            <button type="button" className="o-cbtn" onClick={chat.cancelPairing}>Try again</button>
          </div>
        )}
        {p && (p.state === 'expired' || p.state === 'none') && (
          <div className="o-chat-pair-code" role="alert">
            <p className="o-chat-p">That code has expired. Start again for a new one.</p>
            <button type="button" className="o-cbtn" onClick={chat.cancelPairing}>Start over</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- the thread ----

const NEAR_BOTTOM_PX = 160;
const scroller = () => document.scrollingElement ?? document.documentElement;
const distanceFromBottom = () => { const s = scroller(); return s.scrollHeight - s.scrollTop - window.innerHeight; };

function Thread({ chat, now, lead, onSettings }) {
  const reduced = useReducedMotion();
  const coarse = useMediaQuery('(pointer: coarse)');
  const [replyTo, setReplyTo] = useState(null);
  const [viewing, setViewing] = useState(null);
  // The ⋮ menu (search, settings), the search sheet with its last query, and a jump
  // to a search result: `target` waits for the message's row to render, `found` marks
  // it for a moment, `jump` says the page is loading history or why it couldn't.
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState('');
  const [target, setTarget] = useState(null);
  const [found, setFound] = useState(null);
  const [jump, setJump] = useState(null); // { busy: true } | { problem }
  const menuBtnRef = useRef(null);
  const speaking = useSpeaking();
  const speechLoading = useSpeechLoading();
  const canSpeak = useCanSpeak();
  // The Mac's own voice, where the server offers it (the status's `speech`).
  useMiniVoice(chat.status?.speech ?? null);
  useStopSpeechWhenAway();
  const { messages, hasOlder, loadingOlder } = chat;
  const topRef = useRef(null);
  const keep = useRef(null);        // scrollHeight before an older page, to hold the view
  const lastSeqRef = useRef(null);
  const firstRef = useRef(true);
  const addRef = useRef(null);      // the composer's way in for a dropped file
  const [dragging, setDragging] = useState(0);
  const rows = threadRows(messages, now);

  // A file dropped anywhere on the thread or the composer joins the message, as
  // if picked. Only a drag that carries files is taken; dragged text is left to
  // the box. The counter rides out the enter/leave pairs of the children.
  const onDragEnter = e => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setDragging(n => n + 1); };
  const onDragOver = e => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const onDragLeave = e => { if (!dragHasFiles(e.dataTransfer)) return; setDragging(n => Math.max(0, n - 1)); };
  const onDrop = e => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(0);
    addRef.current?.(transferFiles(e.dataTransfer));
  };

  // Keep the view where it was when older history lands above it.
  useLayoutEffect(() => {
    if (keep.current === null) return;
    const s = scroller();
    s.scrollTop += s.scrollHeight - keep.current;
    keep.current = null;
  }, [messages]);

  // Follow the thread: on first load jump to the end; afterwards only when the
  // viewer was near the end, or sent the newest message themselves.
  useEffect(() => {
    const last = messages[messages.length - 1] ?? null;
    const key = last ? `${last.seq}:${last.clientId ?? ''}` : null;
    if (key === lastSeqRef.current) return;
    const wasFirst = firstRef.current;
    const mine = last?.from === 'jeff' && !Number.isInteger(last?.seq);
    lastSeqRef.current = key;
    if (!last) return;
    if (wasFirst || mine || distanceFromBottom() < NEAR_BOTTOM_PX) {
      firstRef.current = false;
      window.scrollTo({ top: scroller().scrollHeight, behavior: wasFirst || reduced ? 'auto' : 'smooth' });
    }
  }, [messages, reduced]);

  // Older history when the top comes into view.
  useEffect(() => {
    const el = topRef.current;
    if (!el || !hasOlder || loadingOlder || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      keep.current = scroller().scrollHeight;
      chat.loadOlder().then(n => { if (!n) keep.current = null; });
    }, { rootMargin: '200px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [chat, hasOlder, loadingOlder, messages.length]);

  // A search result picked: load older history until its message is on the page,
  // then bring it into view.
  const pick = async r => {
    setSearching(false);
    setJump({ busy: true });
    const outcome = await chat.reach({ id: r.id, seq: r.seq });
    // Refused: an earlier jump is still loading, and its own outcome lands.
    if (outcome === 'busy') return;
    const problem = reachProblem(outcome);
    if (problem) { setJump({ problem }); return; }
    setJump(null);
    setTarget(r.id);
  };
  useEffect(() => {
    if (!target) return;
    const sel = `[data-mid="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(target) : target}"]`;
    const el = document.querySelector(sel);
    if (!el) return; // the render that holds it comes with `messages`
    // Smooth only over a short way: a long glide (thousands of rows) takes seconds and
    // shows nothing, and the mark would fade before it landed.
    const far = Math.abs(el.getBoundingClientRect().top - window.innerHeight / 2) > 2 * window.innerHeight;
    el.scrollIntoView({ block: 'center', behavior: reduced || far ? 'auto' : 'smooth' });
    setFound(target);
    setTarget(null);
  }, [target, messages, reduced]);
  useEffect(() => {
    if (!found) return undefined;
    const t = setTimeout(() => setFound(null), 2600);
    return () => clearTimeout(t);
  }, [found]);

  // When this page first saw each of the owner's messages queued, on this device's
  // clock, while the stream is open and the channel connected (lib/orbit/runbook.js,
  // noteQueued); the stuck banner measures from there, never from the server's `at`.
  const queuedRef = useRef(null);
  const watching = chat.stream === 'open' && chat.status?.channelConnected === true && chat.status?.state !== 'offline';
  queuedRef.current = noteQueued(queuedRef.current, messages, now, watching);
  const banner = bannerFor(effectiveStatus(chat.status, chat.permissions, now), now, messages, queuedRef.current);
  // Every card but a closed one past its time (lib/orbit/chat.js, cardGone): an
  // answered card stays to say what was sent, until dismissed.
  const approvalContext = { approver: chat.device?.approver === true, approvals: chat.status?.approvals ?? null };
  const cards = [...chat.permissions.values()].map(p => permissionView(p, now, approvalContext))
    .filter(p => p && !cardGone(p, now));

  return (
    <div className={`o-chat o-chat-thread-page${dragging > 0 ? ' o-chat-dropping' : ''}`} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragging > 0 && <div className="o-chat-dropzone" aria-hidden="true"><span>Drop to attach (photos and PDFs)</span></div>}
      <div className="o-chat-wrap">
        <div className={`o-chat-banner o-chat-banner-${banner.tone}`} role="status">
          <span className="o-chat-banner-dot" aria-hidden="true" />
          <span className="o-chat-banner-text">
            {banner.text}
            {/* "Bring Jarvis Back" (lib/orbit/runbook.js): a button under the words when
                the channel is gone or stuck, a quiet link after them when he is silent. */}
            {/* Restart Jarvis first (Recover.jsx), on a device that may restart. */}
            {banner.runbook === 'loud' && (
              <span className="o-chat-loudrow">
                <RecoverButton className="o-chat-runbook o-chat-runbook-loud o-chat-recover" />
                <RunbookLink className="o-chat-runbook o-chat-runbook-loud" />
              </span>
            )}
            {banner.runbook === 'quiet' && <> · Silent too long? <RunbookLink className="o-chat-runbook" /></>}
          </span>
          {chat.stream !== 'open' && <span className="o-chat-banner-sub">reconnecting…</span>}
          <span className="o-chat-menuwrap">
            <button ref={menuBtnRef} type="button" className="o-chat-iconbtn o-chat-menubtn" aria-label="Chat menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(v => !v)}>
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.2" /><circle cx="10" cy="4" r="1.6" /><circle cx="10" cy="16" r="1.6" /></svg>
            </button>
            {menu && <ChatMenu anchorRef={menuBtnRef} onClose={() => setMenu(false)}
              onSearch={() => { setMenu(false); setJump(null); setSearching(true); }}
              onSettings={() => { setMenu(false); onSettings(); }} />}
          </span>
        </div>
        {jump && (
          <div className={`o-chat-jumpnote${jump.problem ? ' o-chat-jumpnote-problem' : ''}`} role="status">
            <span>{jump.busy ? 'Loading earlier messages to reach it…' : jump.problem}</span>
            {jump.problem && <button type="button" className="o-chat-iconbtn" aria-label="Dismiss" onClick={() => setJump(null)}>×</button>}
          </div>
        )}
        <ol className="o-chat-list" aria-label="Messages">
          <li ref={topRef} className="o-chat-top" aria-hidden="true">
            {loadingOlder ? 'Loading earlier messages…' : hasOlder ? '' : messages.length ? 'The start of the conversation' : ''}
          </li>
          {messages.length === 0 && <li className="o-chat-empty">No messages yet. Say hello.</li>}
          {rows.map(row => (row.type === 'day'
            ? <li key={row.key} className="o-chat-day"><span>{row.label}</span></li>
            : <Row key={row.key} m={row.message} list={messages} lead={lead} chat={chat} onReply={setReplyTo} onView={setViewing} speaking={speaking} speechLoading={speechLoading} canSpeak={canSpeak} found={found === row.message.id} />))}
        </ol>
        <div className="o-chat-bottom">
          {cards.length > 0 && (
            <div className="o-chat-cards" role="region" aria-label="Permission requests">
              {cards.map(p => <PermissionCard key={p.requestId} p={p} chat={chat} now={now} />)}
            </div>
          )}
          <Composer chat={chat} coarse={coarse} replyTo={quoted(messages, replyTo)} onClearReply={() => setReplyTo(null)} addRef={addRef} />
        </div>
      </div>
      {viewing && <ImageViewer attachment={viewing} onClose={() => setViewing(null)} />}
      {searching && <ChatSearch initial={lastQuery} onQuery={setLastQuery} onPick={pick} onClose={() => { setSearching(false); menuBtnRef.current?.focus(); }} />}
    </div>
  );
}

// The ⋮ menu: its items (Restart Jarvis only on a device that may restart). Arrow keys move between them, Escape or a tap outside closes
// it and gives the focus back to the button.
function ChatMenu({ anchorRef, onSearch, onSettings, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const items = () => [...(ref.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    items()[0]?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); anchorRef.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = items();
      const i = list.indexOf(document.activeElement);
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    };
    const onDown = e => { if (!ref.current?.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [anchorRef, onClose]);
  return (
    <div ref={ref} className="o-chat-menu" role="menu" aria-label="Chat menu">
      <button type="button" role="menuitem" className="o-chat-menuitem" onClick={onSearch}>Search messages</button>
      <button type="button" role="menuitem" className="o-chat-menuitem" onClick={onSettings}>Chat settings</button>
      <RecoverMenuItem onClose={onClose} />
      <RunbookLink className="o-chat-menuitem o-chat-menulink" role="menuitem" onClick={onClose} />
    </div>
  );
}

// Read aloud on one of the lead's bubbles (src/lib/orbit/speech.js). Shown only where
// there is a voice to read in: the Mac's, or an on-device one of the browser's
// (`canSpeak`). The tap itself starts the speech or the audio (mobile Safari does
// either from a user gesture only). While the Mac's audio is on its way the button
// pulses (`loading`); a tap then stops it like any other.
function SpeakButton({ m, speaking, loading, canSpeak }) {
  const sp = getSpeaker();
  if (!canSpeak) return null;
  const on = speaking === m.id;
  const busy = on && loading === m.id;
  return (
    <button type="button" className={`o-chat-speakbtn${on ? ' o-chat-speaking' : ''}${busy ? ' o-chat-speakloading' : ''}`} aria-label={busy ? 'Read aloud, loading' : 'Read aloud'} aria-pressed={on} aria-busy={busy || undefined} onClick={() => sp.toggle(m.id, m.text)}>
      {on
        ? <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
        : <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7.5h3l4-3.5v12l-4-3.5H3Z" /><path d="M13 7a4 4 0 0 1 0 6M15.2 5a7 7 0 0 1 0 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
    </button>
  );
}

function Row({ m, list, lead, chat, onReply, onView, speaking, speechLoading, canSpeak, found }) {
  // A notice carries its own time in its words ("… restarted 08:06").
  const mid = m.id ?? undefined;
  const foundClass = found ? ' o-chat-found' : '';
  if (m.kind === 'notice') return <li data-mid={mid} className={`o-chat-notice${foundClass}`}><span>{m.text}</span></li>;
  // An event (server lib/events.mjs): a notice line, its words as plain text.
  if (m.kind === 'event') {
    const ev = eventLine(m);
    return <li data-mid={mid} className={`o-chat-notice o-chat-event${foundClass}`}><span>{ev.text}</span>{ev.note && <span>{ev.note}</span>}<time className="o-mono">{hhmm(m.at)}</time></li>;
  }
  if (m.kind === 'permission') {
    return <li data-mid={mid} className={`o-chat-notice${foundClass}`}><span>Jarvis asked for a permission{m.meta?.tool ? ` (${m.meta.tool})` : ''}: {m.text}</span><time className="o-mono">{hhmm(m.at)}</time></li>;
  }
  // A stop asked from the war room (server lib/agent-stop.mjs): fixed words; Jarvis answers in the thread.
  if (m.kind === 'stop') {
    return <li data-mid={mid} className={`o-chat-notice${foundClass}`}><span>{m.text}{m.device ? ` (from ${m.device})` : ''}{m.state === 'undelivered' ? '. Not delivered: Jarvis\'s channel did not take it in time' : ''}</span><time className="o-mono">{hhmm(m.at)}</time></li>;
  }
  if (m.kind === 'verdict') {
    const word = m.meta?.behavior === 'allow' || m.text === 'allow' ? 'Allowed' : 'Denied';
    return <li data-mid={mid} className={`o-chat-notice${foundClass}`}><span>{word}{m.device ? ` from ${m.device}` : ''}</span><time className="o-mono">{hhmm(m.at)}</time></li>;
  }
  const mine = m.from === 'jeff';
  const tick = tickFor(m, list);
  const quote = m.replyTo ? quoted(list, m.replyTo) : null;
  const pending = !Number.isInteger(m.seq);
  // A failed send's words: an old one says when it was written and asks for Send now;
  // a message that arrived late says when it was written (lib/orbit/chat.js).
  const unsent = m.failed ? unsentWords(m) : null;
  const written = writtenWords(m);
  return (
    <li data-mid={pending ? undefined : mid} className={`o-chat-row ${mine ? 'o-chat-mine' : 'o-chat-theirs'}${m.failed ? ' o-chat-failed' : ''}${pending ? ' o-chat-pending' : ''}${foundClass}`}>
      {!mine && <span className="o-chat-avatar"><Avatar agent={lead} fallback="J" size={28} tone="day" /></span>}
      <div className="o-chat-bubble">
        {(m.replyTo || quote) && <blockquote className="o-chat-quote"><span className="o-chat-quote-who">{quoteWho(quote)}</span>{quoteLine(quote)}</blockquote>}
        {m.attachments?.length > 0 && (
          <div className="o-chat-photos">
            {m.attachments.map((a, i) => (a.id && !pending
              ? (!isPhotoType(a.type)
                // A PDF or a text file is a chip that downloads (the server sends
                // it as an attachment), never rendered in the page.
                ? <a key={a.id} className="o-chat-file o-chat-pdf" href={attachmentUrl(a.id)} download={a.name} aria-label={`Download ${a.name}, ${fileWord(a.type)}, ${fileSize(a.bytes)}`}>{a.type === PDF_TYPE && <PdfIcon />}<span className="o-chat-pdf-name">{a.name}</span><span className="o-chat-pdf-size">{fileSize(a.bytes)}</span></a>
                : <button key={a.id} type="button" className="o-chat-photo" onClick={() => onView(a)} aria-label={`Open ${a.name}`}><img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" /></button>)
              : <span key={a.id ?? i} className="o-chat-file">{a.type === PDF_TYPE && <PdfIcon />}{a.name} · {fileSize(a.bytes)}{pending && !m.failed ? ' · uploading…' : ''}</span>))}
          </div>
        )}
        {m.text && <Markdown text={m.text} className="o-chat-text o-md" />}
        <div className="o-chat-meta">
          {!mine && !pending && m.kind === 'chat' && m.text && <SpeakButton m={m} speaking={speaking} loading={speechLoading} canSpeak={canSpeak} />}
          <time className="o-mono" dateTime={new Date(m.at).toISOString()}>{clock(m.at)}</time>
          {m.editedAt && <span className="o-chat-edited">edited</span>}
          {written && <span className="o-chat-via o-chat-written">{written}</span>}
          {mine && viaWords(m) && <span className="o-chat-via">via {viaWords(m)}</span>}
          {routineWord(m) && <span className="o-chat-via o-chat-routine">{routineWord(m)}</span>}
          {tick && <span className={`o-chat-tick o-chat-tick-${tick}`} role="img" aria-label={TICK_WORDS[tick]}>{TICK_MARKS[tick]}</span>}
        </div>
        {unsent && (
          <div className="o-chat-retry" role="alert">
            <span>{unsent.line}</span>
            <button type="button" className="o-cbtn o-cbtn-small" onClick={() => chat.retry(m.clientId)}>{unsent.action}</button>
            <button type="button" className="o-cbtn o-cbtn-small" onClick={() => chat.discard(m.clientId)}>Discard</button>
          </div>
        )}
      </div>
      {!pending && <button type="button" className="o-chat-replybtn" aria-label="Reply to this message" onClick={() => onReply(m.id)}>
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5 3 10l5 5v-3.2c4 0 7 1 9 4-.6-4.2-3.4-7.8-9-8.3Z" /></svg>
      </button>}
    </li>
  );
}

// ---- permission cards (approvals design §5.3) ----

// One field of the preview, as text: what Claude Code marked as hidden is set
// apart (never rendered as anything but text).
function FieldText({ text }) {
  return markerSegments(text).map((seg, i) => (seg.marker
    ? <mark key={i} className="o-chat-card-marker">{seg.text}</mark>
    : <span key={i}>{seg.text}</span>));
}

function PermissionCard({ p, chat, now }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // The card as this render shows it (what a verdict hashes), and the armed Allow as
  // { at, shown }: armed on that copy only. A redraw that changes the copy (a gained
  // exact text, a mark) disarms it at once, here and in the effect below, so a second
  // tap never allows a card that changed after the first (Ultron's L2, 11-13).
  const shown = shownInput(p);
  const [armed, setArmed] = useState(null);
  const armedNow = armed !== null && armed.shown === shown;
  useEffect(() => { setArmed(null); }, [shown]);
  // The armed Allow falls back after 4 s, re-rendered by its own timer.
  useEffect(() => {
    if (armed === null) return undefined;
    const t = setTimeout(() => setArmed(null), ALLOW_ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const age = Math.max(0, Math.floor((now - (p.relayedAt ?? p.openedAt)) / 1000));
  // `copy` is the card the tap was made on: this render's for Deny, the armed one for Allow.
  const answer = async (behavior, copy) => {
    setBusy(behavior);
    setError(null);
    setArmed(null);
    const r = await chat.verdict(p.requestId, behavior, copy);
    setBusy(null);
    if (!r.ok) setError(r.error);
  };
  const onAllow = () => {
    const copy = armedCopy(armed, shown, Date.now());
    if (copy !== null) answer('allow', copy);
    else setArmed({ at: Date.now(), shown });
  };
  // Enter never answers a card: only a tap (or Space) does.
  const noEnter = e => { if (e.key === 'Enter') e.preventDefault(); };
  const fields = cardFields(p);
  const exact = exactRows(p.exact);
  const label = p.state === 'elsewhere' ? 'Answered elsewhere' : ({ open: 'Jarvis asks', expired: 'Too late to answer here', terminal: 'Answer at the terminal', closed: 'Answered here' }[p.view] ?? 'Jarvis asks');
  return (
    <section className={`o-chat-card${p.view !== 'open' ? ' o-chat-card-expired' : ''}`} aria-label={`Permission request: ${p.tool}`} onKeyDown={noEnter}>
      <div className="o-chat-card-head">
        <span className="o-chat-label">{label}</span>
        <span className="o-chat-sub">{ageLine(age)}</span>
      </div>
      <h3 className="o-chat-card-tool o-mono">{p.tool}</h3>
      {p.why && <p className="o-chat-card-why">{p.why}</p>}
      {exact.length > 0 && (
        // The command's exact text, from Claude Code's hook: one row per line, each
        // line break and tab drawn, so two lines never read as one, and runs of spaces
        // marked with their count. Text nodes only.
        <div className="o-chat-card-field">
          <span className="o-chat-card-key">Exact command, {exact.length === 1 ? 'one line' : `${exact.length} lines`}</span>
          <div className="o-mono o-chat-card-input o-chat-card-exact" role="group" tabIndex={0} aria-label={`The exact command, ${exact.length === 1 ? 'one line' : `${exact.length} lines`}`}>
            {exact.map((row, i) => (
              <div key={i} className="o-chat-card-line">
                {row.parts.map((part, j) => (part.tab
                  ? <span key={j} className="o-chat-card-break" role="img" aria-label="tab">⇥</span>
                  : part.spaces
                    ? <span key={j} className="o-chat-card-break" role="img" aria-label={spacesLabel(part.spaces)}>{spacesMark(part.spaces)}</span>
                    : <span key={j}>{part.text}</span>))}
                {row.end && <span className="o-chat-card-break" role="img" aria-label="line break">↵</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {fields.length
        ? fields.map(([k, v]) => (
          <div key={k} className="o-chat-card-field">
            <span className="o-chat-card-key o-mono">{k === 'command' && exact.length > 0 ? 'command, as relayed (spacing may differ)' : k}</span>
            <pre className="o-mono o-chat-card-input" tabIndex={0} aria-label={`The ${k}`}><FieldText text={v} /></pre>
          </div>
        ))
        : <p className="o-chat-sub">No input preview.</p>}
      {/* Parity: two different exact copies of this command were reported, so the card
          shows the relayed preview and says so (a mark, never a gate). */}
      {p.exactNote && <p className="o-chat-card-hidden">{p.exactNote}</p>}
      {hasMarker(p) && <p className="o-chat-card-hidden">{p.view === 'open' && p.canAllow
        ? 'Part of this request is hidden, masked or cut short: this card does not show all of it.'
        : 'Part of this request is hidden or cut short, so it can only be denied here.'}</p>}
      {p.description && (
        <div className="o-chat-card-summary">
          <span className="o-chat-card-key">Jarvis's own summary</span>
          <p className="o-chat-card-desc">{p.description}</p>
        </div>
      )}
      {p.view === 'closed' && (
        <div className="o-chat-card-expired-note">
          <span>{sentLine(p)}</span>
          <button type="button" className="o-cbtn o-cbtn-small" onClick={() => chat.dismissPermission(p.requestId)}>Dismiss</button>
        </div>
      )}
      {p.view === 'expired' && (
        <div className="o-chat-card-expired-note">
          <span>{expiredLine(p)}</span>
          <button type="button" className="o-cbtn o-cbtn-small" onClick={() => chat.dismissPermission(p.requestId)}>Dismiss</button>
        </div>
      )}
      {p.view === 'terminal' && (
        <div className="o-chat-card-expired-note">
          <span>{p.state === 'late' ? 'This one reached the page late.' : 'This request repeats an earlier one.'} It can only be answered at the terminal.</span>
          <button type="button" className="o-cbtn o-cbtn-small" onClick={() => chat.dismissPermission(p.requestId)}>Dismiss</button>
        </div>
      )}
      {p.view === 'open' && (
        <>
          {!p.canAllow && (
            <div className="o-chat-card-denyonly">
              <span>{DENY_ONLY_LEAD}</span>
              {p.denyOnly?.length > 0 && <><span className="o-chat-card-key">Why</span><ul>{p.denyOnly.map(r => <li key={r}>{r}</li>)}</ul></>}
            </div>
          )}
          <div className="o-chat-card-actions">
            <button type="button" className="o-cbtn o-cbtn-deny" disabled={busy !== null} onClick={() => answer('deny', shown)}>{busy === 'deny' ? 'Denying…' : 'Deny'}</button>
            {p.canAllow && (
              <button type="button" className={`o-cbtn o-cbtn-allow${armedNow ? ' o-cbtn-armed' : ''}`} disabled={busy !== null} onClick={onAllow}>
                {busy === 'allow' ? 'Allowing…' : armedNow ? 'Tap again to allow' : 'Allow once'}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="o-chat-card-error" role="alert">Couldn't answer: {error}</p>}
    </section>
  );
}

const PdfIcon = () => (
  <svg className="o-chat-pdf-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l4.2 4.2V20a1.2 1.2 0 0 1-1.2 1.2H6A1.2 1.2 0 0 1 4.8 20V4A1.2 1.2 0 0 1 6 2.8Z M14 2.8V7h4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 13h8M8 16.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);

// ---- the composer ----

function Composer({ chat, coarse, replyTo, onClearReply, addRef }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [preparing, setPreparing] = useState(0);
  const [note, setNote] = useState(null);
  const areaRef = useRef(null);
  const fileRef = useRef(null);
  const offline = chat.status?.state === 'offline';

  // The box grows with its lines, up to a third of the screen (a CSSOM size).
  const fit = useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, []);
  useEffect(fit, [text, fit]);
  // A new build's reload (buildWatch.js) waits while anything here is unsent.
  const unsent = text !== '' || files.length > 0 || preparing > 0;
  useEffect(() => {
    holdReload('composer', unsent);
    return () => holdReload('composer', false);
  }, [unsent]);

  const canSend = (text.trim().length > 0 || files.length > 0) && preparing === 0 && text.length <= MAX_TEXT;
  const send = () => {
    if (!canSend) return;
    chat.send({ text: text.trim(), replyTo: replyTo?.id ?? null, files });
    setText('');
    setFiles([]);
    onClearReply();
    areaRef.current?.focus();
  };
  const onKey = e => {
    // Enter sends where there is a keyboard; on a phone the button does, and
    // Enter makes a new line. Shift+Enter is a new line everywhere.
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent?.isComposing) { e.preventDefault(); send(); }
  };
  // Picked, pasted or dropped, a file goes the same way: photos are resized to a
  // JPEG, PDFs go as they are, four at most across both (those still being
  // prepared count too), and what was left out is said.
  const heldRef = useRef(0);
  heldRef.current = files.length + preparing;
  const addFiles = useCallback(async list => {
    const { take, note: left } = intake(list, heldRef.current);
    setNote(left);
    if (take.length === 0) return;
    heldRef.current += take.length;
    setPreparing(n => n + take.length);
    for (const { file, kind } of take) {
      try {
        const ready = await prepareFile(file, kind);
        setFiles(have => (have.length < MAX_FILES ? [...have, ready] : have));
      } catch (err) {
        setNote(`Couldn't read ${file.name}: ${err?.message ?? err}`);
      } finally {
        setPreparing(n => n - 1);
      }
    }
  }, []);
  useEffect(() => {
    if (!addRef) return undefined;
    addRef.current = addFiles;
    return () => { addRef.current = null; };
  }, [addRef, addFiles]);
  const pick = e => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = '';
    if (picked.length > 0) addFiles(picked);
  };
  // A paste that holds a file (a screenshot, a copied photo or PDF) attaches it;
  // a text paste goes into the box as ever.
  const onPaste = e => {
    const pasted = transferFiles(e.clipboardData);
    if (pasted.length === 0) return;
    e.preventDefault();
    addFiles(pasted);
  };

  return (
    <div className="o-chat-composer">
      {replyTo && (
        <div className="o-chat-replying">
          <span className="o-chat-quote-who">Replying to {replyTo.from === 'jeff' ? 'yourself' : 'Jarvis'}</span>
          <span className="o-chat-replying-text">{quoteLine(replyTo)}</span>
          <button type="button" className="o-chat-iconbtn" aria-label="Cancel the reply" onClick={onClearReply}>×</button>
        </div>
      )}
      {(files.length > 0 || preparing > 0) && (
        <ul className="o-chat-files" aria-label="Files to send">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="o-chat-file">
              <span>{f.kind === 'pdf' && <PdfIcon />}{f.name} · {fileSize(f.blob.size)}{f.width ? ` · ${f.width}×${f.height}` : ''}</span>
              <button type="button" className="o-chat-iconbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(list => list.filter((_, j) => j !== i))}>×</button>
            </li>
          ))}
          {preparing > 0 && <li className="o-chat-file o-chat-sub">Preparing {preparing} file{preparing > 1 ? 's' : ''}…</li>}
        </ul>
      )}
      {note && <p className="o-chat-sub" role="alert">{note}</p>}
      <div className="o-chat-composer-row">
        <input ref={fileRef} type="file" accept={ACCEPT} multiple className="o-chat-filepick" onChange={pick} aria-label="Choose photos or PDFs" tabIndex={-1} />
        <button type="button" className="o-chat-iconbtn o-chat-attach" aria-label="Attach a photo or PDF" disabled={files.length + preparing >= MAX_FILES} onClick={() => fileRef.current?.click()}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.2 12.3 19.4a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <textarea ref={areaRef} className="o-input o-chat-area" rows={1} value={text} maxLength={MAX_TEXT} placeholder={offline ? 'Message (waits for Jarvis)' : 'Message'}
          aria-label="Message" enterKeyHint={coarse ? 'enter' : 'send'} onChange={e => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        <button type="button" className="o-cbtn o-cbtn-primary o-chat-send" disabled={!canSend} onClick={send} aria-label="Send">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10 17 3l-3.2 14-4.3-5.2Zm7 1.8L13 15l2-9.4-9.6 4.6Z" /></svg>
          <span>Send</span>
        </button>
      </div>
      {text.length > MAX_TEXT - 500 && <p className="o-chat-sub">{MAX_TEXT - text.length} characters left</p>}
    </div>
  );
}

// ---- the settings sheet ----

function SettingsSheet({ chat, now, onClose }) {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [code, setCode] = useState('');
  const [approved, setApproved] = useState(null);
  const load = useCallback(() => chat.devices().then(setDevices).catch(err => setError(String(err?.message ?? err))), [chat]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const revoke = async id => {
    setError(null);
    try {
      await chat.revoke(id);
      setConfirm(null);
      // Revoking this device ends the session: the pairing screen replaces the
      // sheet, and the list would only answer 401 now.
      if (id !== chat.device?.id) load();
    } catch (err) { setError(String(err?.message ?? err)); }
  };
  const approve = async e => {
    e.preventDefault();
    setError(null);
    setApproved(null);
    try { const r = await chat.approve(code.trim().toUpperCase()); setApproved(r.name); setCode(''); } catch (err) { setError(String(err?.message ?? err)); }
  };
  const when = at => (at ? `${hhmm(at)} ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'never');
  void now;
  return (
    <div className="o-chat o-chat-sheet-back" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="o-chat-sheet" role="dialog" aria-modal="true" aria-label="Chat settings">
        <div className="o-chat-sheet-head">
          <h2 className="o-chat-h2">Chat settings</h2>
          <button type="button" className="o-chat-iconbtn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <h3 className="o-chat-label">Paired devices</h3>
        {!devices && !error && <p className="o-chat-sub">Loading…</p>}
        {devices && (
          <ul className="o-chat-devices">
            {devices.map(d => (
              <li key={d.id} className={`o-chat-device${d.revokedAt ? ' o-chat-device-revoked' : ''}`}>
                <div className="o-chat-device-main">
                  <span className="o-chat-device-name">{d.name}{chat.device?.id === d.id && <span className="o-chat-this">this device</span>}{!d.revokedAt && d.push && <span className="o-chat-this">notifications</span>}</span>
                  <span className="o-chat-sub">{d.revokedAt ? `revoked ${when(d.revokedAt)}` : `paired ${when(d.createdAt)} · seen ${when(d.lastSeenAt)}`}</span>
                </div>
                {!d.revokedAt && (confirm === d.id
                  ? <span className="o-chat-device-actions"><button type="button" className="o-cbtn o-cbtn-deny o-cbtn-small" onClick={() => revoke(d.id)}>Confirm revoke</button><button type="button" className="o-cbtn o-cbtn-small" onClick={() => setConfirm(null)}>Keep</button></span>
                  : <button type="button" className="o-cbtn o-cbtn-small" onClick={() => setConfirm(d.id)}>Revoke</button>)}
              </li>
            ))}
            {devices.length === 0 && <li className="o-chat-sub">No devices.</li>}
          </ul>
        )}
        <Notifications onChange={load} />
        <VoicePicker />
        {chat.shortcutsOn && <ShortcutKeys chat={chat} when={when} />}
        <h3 className="o-chat-label">Approve another device</h3>
        <form className="o-chat-approve" onSubmit={approve}>
          <input className="o-input o-chat-input o-mono" value={code} maxLength={6} autoComplete="off" autoCapitalize="characters" placeholder="6-letter code" aria-label="Pairing code" onChange={e => setCode(e.target.value)} />
          <button type="submit" className="o-cbtn o-cbtn-primary" disabled={code.trim().length !== 6}>Approve</button>
        </form>
        {approved && <p className="o-chat-sub" role="status">Approved: {approved} can finish pairing now.</p>}
        {error && <p className="o-chat-card-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

// ---- Shortcut keys: what an iPhone Shortcut holds to send into the chat ----

// Shown only when the server has Shortcut keys on. The page makes a one-time code
// for a new key; the Setup Shortcut asks for it and gets the key itself, which never
// passes through this page.
function ShortcutKeys({ chat, when }) {
  const [data, setData] = useState(undefined); // undefined: loading; null: off on the server
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [name, setName] = useState('iPhone');
  const [made, setMade] = useState(null); // { code, name, expiresAt, before: the key ids then }
  const load = useCallback(() => chat.shortcutKeys().then(setData).catch(err => setError(String(err?.message ?? err))), [chat]);
  useEffect(() => { load(); }, [load]);
  // While a code is showing, look every 3 s for the key it becomes.
  const state = codeState(made, data);
  useEffect(() => {
    if (state !== 'waiting') return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [state, load]);
  if (data === undefined || data === null) return null;
  const make = async e => {
    e.preventDefault();
    setError(null);
    setMade(null);
    try {
      const before = (data.keys ?? []).map(k => k.id);
      const r = await chat.newShortcutCode(name.trim());
      // The list first, so the code never shows against a list that lacks it.
      await load();
      setMade({ ...r, before });
    } catch (err) { setError(String(err?.message ?? err)); }
  };
  const revoke = async id => {
    setError(null);
    try { await chat.revokeShortcutKey(id); setConfirm(null); setMade(null); load(); } catch (err) { setError(String(err?.message ?? err)); }
  };
  const rows = keyRows(data.keys);
  return (
    <div className="o-chat-keys" role="region" aria-label="Shortcut keys">
      <h3 className="o-chat-label">Shortcut keys</h3>
      <p className="o-chat-sub">A key lets an iPhone Shortcut send Jarvis a message from you, or say you arrived home. It can&apos;t read the chat or answer an approval. Revoking a device revokes the keys made from it. A key not used for {KEY_IDLE_DAYS} days stops working.{data.off ? ' They are switched off on the server now.' : ''}</p>
      <ul className="o-chat-devices">
        {rows.map(k => (
          <li key={k.id} className={`o-chat-device${keyGone(k) ? ' o-chat-device-revoked' : ''}`}>
            <div className="o-chat-device-main">
              <span className="o-chat-device-name">{k.name}</span>
              <span className="o-chat-sub">{keyLine(k, when)}</span>
            </div>
            {!k.revokedAt && (confirm === k.id
              ? <span className="o-chat-device-actions"><button type="button" className="o-cbtn o-cbtn-deny o-cbtn-small" onClick={() => revoke(k.id)}>Confirm revoke</button><button type="button" className="o-cbtn o-cbtn-small" onClick={() => setConfirm(null)}>Keep</button></span>
              : <button type="button" className="o-cbtn o-cbtn-small" aria-label={`Revoke the Shortcut key ${k.name}`} onClick={() => setConfirm(k.id)}>Revoke</button>)}
          </li>
        ))}
        {rows.length === 0 && <li className="o-chat-sub">No keys yet.</li>}
      </ul>
      <form className="o-chat-approve o-chat-newkey" onSubmit={make}>
        <input className="o-input o-chat-input" value={name} maxLength={22} autoComplete="off" placeholder="Name (plain letters)" aria-label="A name for the new Shortcut key, plain letters and digits" onChange={e => setName(e.target.value)} />
        <button type="submit" className="o-cbtn o-cbtn-primary" aria-label="Make a code for a new Shortcut key" disabled={name.trim() === '' || data.off}>New key</button>
      </form>
      {state === 'waiting' && (
        <p className="o-chat-keycode" role="status">
          <span className="o-mono o-chat-keycode-code">{made.code}</span>
          <span className="o-chat-sub">Run the Jarvis Setup Shortcut and enter this code before {when(made.expiresAt)}. It works once.</span>
        </p>
      )}
      {state === 'paired' && <p className="o-chat-sub" role="status">Paired: the Shortcut key {made.name} is ready.</p>}
      {state === 'gone' && <p className="o-chat-sub" role="status">That code is no longer waiting (wrong tries, or its 10 minutes ran out). Make a new one.</p>}
      {!made && data.waiting && <p className="o-chat-sub" role="status">A code for {data.waiting.name} is waiting for its Shortcut until {when(data.waiting.expiresAt)}. A new one replaces it.</p>}
      {error && <p className="o-chat-card-error" role="alert">{error}</p>}
    </div>
  );
}

// ---- notifications (Web Push) for this device ----

function Notifications({ onChange }) {
  const [support] = useState(() => push.support());
  const [permission, setPermission] = useState(() => push.permission());
  const [server, setServer] = useState('checking'); // checking | on | off | error
  const [key, setKey] = useState(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (support !== 'ok') return undefined;
    let alive = true;
    // The key and the browser's subscription are read before any tap, so the tap
    // goes straight to the permission prompt with nothing to wait for.
    push.pushKey().then(async r => {
      const sub = await push.currentSubscription().catch(() => null);
      if (!alive) return;
      setKey(r.key);
      setSubscribed(Boolean(r.subscribed && sub));
      setServer('on');
    }).catch(err => { if (alive) { setServer(err?.status === 503 ? 'off' : 'error'); if (err?.status !== 503) setError(String(err?.message ?? err)); } });
    return () => { alive = false; };
  }, [support]);
  const view = pushView({ support, permission, subscribed, server: server === 'checking' ? 'on' : server });
  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      if (view.action === 'on') {
        const r = await push.turnOn(key);
        setPermission(r.permission);
        setSubscribed(r.subscribed);
      } else {
        await push.turnOff();
        setSubscribed(false);
      }
      onChange?.();
    } catch (err) {
      setError(String(err?.message ?? err));
      setPermission(push.permission());
    } finally { setBusy(false); }
  };
  return (
    <>
      <h3 className="o-chat-label">Notifications</h3>
      <p className="o-chat-sub o-chat-push-text" role="status">{server === 'checking' && support === 'ok' ? 'Checking…' : view.text}</p>
      {view.action && server === 'on' && (
        <button type="button" className={`o-cbtn${view.action === 'on' ? ' o-cbtn-primary' : ''}`} disabled={busy || !key} onClick={act}>
          {view.action === 'on' ? 'Turn on notifications' : 'Turn off notifications'}
        </button>
      )}
      {error && <p className="o-chat-card-error" role="alert">{error}</p>}
    </>
  );
}

// ---- the read-aloud voice for this device ----

// The browser's names for languages ("English (United States)"), or null where it has none.
function languageNames() {
  try { return new Intl.DisplayNames(navigator.languages?.length ? [...navigator.languages] : undefined, { type: 'language', languageDisplay: 'standard' }); } catch { return null; }
}

// Which voice reads replies aloud here (src/lib/orbit/speech.js). On top, where the
// server offers it, the Mac's own voice: the words are spoken on the Mac and played
// here, and it is what a device uses until it chooses otherwise. Then the browser's
// own on-device voices, this device's language first, with Automatic above them; the
// one picked there also reads whenever the Mac can't. The pick is kept in this browser
// only. The sample plays from its own tap (mobile Safari plays from a user gesture
// only) and stops with the sheet.
function VoicePicker() {
  const sp = getSpeaker();
  const view = useVoices();
  const sampling = useSpeaking() === SAMPLE_ID;
  const sampleLoading = useSpeechLoading() === SAMPLE_ID;
  const mini = view.mini;
  const onMini = view.engine === 'mini';
  const names = useMemo(languageNames, []);
  useEffect(() => () => { if (sp.current() === SAMPLE_ID) sp.stop(); }, [sp]);
  const option = c => <option key={c.uri} value={c.uri}>{c.name}{c.lang ? ` · ${langLabel(c.lang, names)}` : ''}</option>;
  const mine = view.choices.filter(c => c.mine);
  const others = view.choices.filter(c => !c.mine);
  // The on-device voice that reads when the Mac can't: the one picked here, else Automatic's.
  const fallbackName = view.choices.find(c => c.uri === view.picked)?.name ?? view.auto;
  return (
    <div className="o-chat-voice" role="group" aria-labelledby="o-chat-voice-label">
      <h3 className="o-chat-label" id="o-chat-voice-label">Read-aloud voice</h3>
      {view.auto === null && mini === null
        ? <p className="o-chat-sub">This browser offers no on-device voice, so read aloud is off here.</p>
        : (
          <>
            <div className="o-chat-voice-row">
              <select className="o-input o-chat-input o-chat-voice-select" aria-labelledby="o-chat-voice-label" value={onMini ? MINI : view.picked ?? ''} onChange={e => sp.setVoice(e.target.value)}>
                {mini !== null && <option value={MINI}>Mac mini voice ({mini.short})</option>}
                {view.auto !== null && <option value="">{mini !== null ? `This device, automatic (${view.auto})` : `Automatic (${view.auto})`}</option>}
                {mine.length > 0 && others.length > 0
                  ? <><optgroup label="Your language">{mine.map(option)}</optgroup><optgroup label="Other languages">{others.map(option)}</optgroup></>
                  : view.choices.map(option)}
              </select>
              <button type="button" className="o-cbtn o-chat-voice-sample" aria-pressed={sampling} aria-busy={sampleLoading || undefined} onClick={() => sp.sample()}>{sampling ? 'Stop' : 'Play a sample'}</button>
            </div>
            {onMini && (
              <p className="o-chat-sub o-chat-voice-mini" role="status">
                {mini.exact
                  ? `Replies are read in ${mini.voice}, spoken on the Mac mini and played here.`
                  : `${mini.wanted} is not installed on the Mac mini yet, so it reads in ${mini.short} for now.`}
                {view.auto !== null ? ` If the mini can't be reached, this device reads in ${fallbackName}.` : ' This browser has no voice of its own to read when the mini can\'t be reached.'}
              </p>
            )}
            {view.saved !== null && view.picked === null && <p className="o-chat-sub" role="status">The voice chosen here before is not on this device now, so Automatic is used.</p>}
            {mini !== null
              ? <p className="o-chat-sub">On iPhone and iPad, a device&apos;s own list holds only Apple&apos;s built-in voices (no downloaded Enhanced, Premium or Siri voices), which is why the Mac mini reads by default. On the Mac, restart Chrome if a newly downloaded voice is missing.</p>
              : <p className="o-chat-sub">On iPhone and iPad, web apps are offered only Apple&apos;s built-in voices; downloaded Enhanced and Premium voices and Siri voices can&apos;t be used here. On the Mac, restart Chrome if a newly downloaded voice is missing.</p>}
          </>
        )}
    </div>
  );
}

// ---- a photo, full size ----

function ImageViewer({ attachment, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="o-chat-viewer" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={onClose}>
      <img src={attachmentUrl(attachment.id)} alt={attachment.name} />
      <button type="button" className="o-chat-iconbtn o-chat-viewer-close" aria-label="Close" onClick={onClose}>×</button>
    </div>
  );
}
