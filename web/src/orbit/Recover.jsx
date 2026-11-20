// Restart Jarvis from the page (board 98a30b15; server/lib/jarvis-recover.mjs). One
// provider in OrbitApp holds the status read and the one sheet, so the sheet outlives the
// alert that opened it (Jarvis coming back clears the alert while the sheet still waits
// for the result). The card sits under the alert strip on every tab; the Chat banner and
// the Chat menu open the same sheet. The logic is in src/lib/orbit/recover.js.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { recoverStatus, restartJarvis } from './recoverApi.js';
import { setUpFaceId } from './stopApi.js';
import { faceIdError } from '../lib/orbit/stop.js';
import { RECOVER_COMMAND, RECOVER_WHERE, POLL_MS, buttonState, recoverCard, sheetPhase, sheetNotes, verdictWords } from '../lib/orbit/recover.js';
import { clock } from '../lib/orbit/page.js';
import { RunbookLink } from './Runbook.jsx';

const RecoverContext = createContext(null);
const useRecover = () => useContext(RecoverContext);

// `down` is the strip's alert that says the lead is down, or null (recover.js,
// leadDownAlert). The status is read once on load, again whenever he goes down or the
// sheet opens, and every POLL_MS while a run is going.
export function RecoverProvider({ down, children }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  const read = useCallback(async () => {
    try {
      const s = await recoverStatus();
      setStatus({ ...s, usable: true });
    } catch {
      setStatus({ usable: false });
    }
  }, []);
  const isDown = down !== null;
  useEffect(() => { read(); }, [read, isDown]);
  const running = status?.usable === true && Boolean(status.running);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, [running, read]);
  const value = {
    status, read, setStatus, down, dismissed,
    dismiss: setDismissed,
    open: () => { setOpen(true); read(); }
  };
  return (
    <RecoverContext.Provider value={value}>
      {children}
      {open && <RecoverSheet onClose={() => setOpen(false)} />}
    </RecoverContext.Provider>
  );
}

// The one line, with Copy: the way back when the button can't be used.
export function CommandLine() {
  const [copied, setCopied] = useState(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RECOVER_COMMAND);
      setCopied('Copied');
    } catch {
      setCopied('Copy failed: select the line instead');
    }
  };
  return (
    <div className="o-recover-cmd">
      <p className="o-recover-where">{RECOVER_WHERE}</p>
      <div className="o-recover-cmdrow">
        <code className="o-mono o-recover-code">{RECOVER_COMMAND}</code>
        <button type="button" className="o-btn o-recover-copy" onClick={copy} aria-label="Copy the command">{copied === 'Copied' ? 'Copied' : 'Copy'}</button>
      </div>
      {copied && copied !== 'Copied' && <p className="o-recover-why" role="status">{copied}</p>}
    </div>
  );
}

// The card under the alert strip: the lead down, a restart going, or how the last one
// ended (for half an hour, until put away).
export function RecoverCard({ now }) {
  const ctx = useRecover();
  if (!ctx) return null;
  const card = recoverCard({ down: ctx.down, status: ctx.status, now, dismissed: ctx.dismissed });
  if (!card) return null;
  const btn = buttonState(ctx.status);
  const offer = card.phase === 'down' || card.down === true;
  const tone = card.phase === 'done' ? (card.ok ? 'ok' : 'bad') : card.phase;
  return (
    <section className={`o-recover o-recover-${tone}`} aria-labelledby="o-recover-title">
      <div className="o-wrap o-recover-inner">
        <div className="o-recover-main">
          <h2 id="o-recover-title" className="o-recover-title">{card.title}</h2>
          {card.line && <p className="o-mono o-recover-line" role="status">{card.line}</p>}
          <p className="o-recover-text">{card.text}</p>
          {offer && btn.show && !btn.can && btn.why && <p className="o-recover-why">{btn.why}</p>}
        </div>
        <div className="o-recover-actions">
          {offer && btn.show && <button type="button" className="o-btn o-btn-accent" onClick={ctx.open} disabled={!btn.can}>Restart Jarvis</button>}
          {card.phase === 'running' && <button type="button" className="o-btn" onClick={ctx.open}>Show</button>}
          {offer && <RunbookLink className="o-btn o-runbook-btn" />}
          {card.phase === 'done' && <button type="button" className="o-btn" onClick={() => ctx.dismiss(card.runId)}>Done</button>}
        </div>
        {offer && <CommandLine />}
      </div>
    </section>
  );
}

// A "Restart Jarvis" button that opens the sheet (the Chat banner), shown only on a
// device that may restart.
export function RecoverButton({ className }) {
  const ctx = useRecover();
  if (!ctx || !buttonState(ctx.status).show) return null;
  return <button type="button" className={className} onClick={ctx.open}>Restart Jarvis</button>;
}

// The Chat menu's item: always there on a device that may restart, for a Jarvis who is
// stuck in a way nothing on the page has noticed.
export function RecoverMenuItem({ onClose }) {
  const ctx = useRecover();
  if (!ctx || !buttonState(ctx.status).show) return null;
  return <button type="button" role="menuitem" className="o-chat-menuitem" onClick={() => { onClose(); ctx.open(); }}>Restart Jarvis…</button>;
}

// The sheet: a confirm, Face ID, then the run going and its end. Without a passkey it
// sets one up (the Stop's own), and shows the code to confirm at the Mac mini.
function RecoverSheet({ onClose }) {
  const ctx = useRecover();
  const [local, setLocal] = useState(null);
  const [mine, setMine] = useState(null);
  const [code, setCode] = useState(null);
  const [error, setError] = useState(null);
  const [settingUp, setSettingUp] = useState(false);
  const status = ctx.status;
  const phase = sheetPhase(local, status, mine);
  const busy = local === 'working' || settingUp;
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  const btn = buttonState(status);
  const go = async () => {
    setLocal('working');
    setError(null);
    try {
      const r = await restartJarvis();
      setMine(r.run?.id ?? null);
      ctx.setStatus(s => ({ ...s, running: r.run, blocked: 'A restart is going now.' }));
      setLocal(null);
      ctx.read();
    } catch (err) {
      setLocal(null);
      setError(err?.status ? err.message : faceIdError(err));
      ctx.read();
    }
  };
  const setUp = async () => {
    setSettingUp(true);
    setError(null);
    try {
      const r = await setUpFaceId();
      setCode(r.code);
      setLocal('code');
      ctx.read();
    } catch (err) {
      setError(err?.status ? err.message : faceIdError(err));
    } finally {
      setSettingUp(false);
    }
  };
  const last = status?.last ?? null;
  const result = phase === 'done' && last ? verdictWords(last.verdict) : null;
  const pendingUntil = Number.isFinite(status?.pendingUntil) ? clock(status.pendingUntil) : null;
  return (
    <div className="o-chat o-chat-sheet-back" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="o-chat-sheet o-stop-sheet o-recover-sheet" role="dialog" aria-modal="true" aria-labelledby="o-recover-sheet-title">
        <div className="o-chat-sheet-head">
          <h2 id="o-recover-sheet-title" className="o-chat-h2">{phase === 'setup' || phase === 'pending' || phase === 'code' ? 'Face ID for restarts' : 'Restart Jarvis'}</h2>
          <button type="button" className="o-chat-iconbtn" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </div>
        {phase === 'loading' && <p className="o-stop-small">Checking…</p>}
        {(phase === 'confirm' || phase === 'working') && (
          <>
            <p className="o-stop-detail">The Mac mini runs jarvis-recover: it fixes what has stopped Jarvis before, then restarts him. A turn he is in ends. It takes a minute or two.</p>
            {sheetNotes(status).map(note => <p key={note} className="o-recover-note" role="status">{note}</p>)}
            {!btn.can && btn.why && <p className="o-stop-error" role="status">{btn.why}</p>}
          </>
        )}
        {phase === 'setup' && <p className="o-stop-detail">A restart needs Face ID on this device (the same passkey as Stop). Set it up once: make the passkey here, then confirm its code at the Mac mini.</p>}
        {phase === 'pending' && <p className="o-stop-detail">A Face ID set-up from this device is waiting for its code at the Mac mini{pendingUntil ? ` until ${pendingUntil}` : ''}. Confirm it there, then come back.</p>}
        {phase === 'code' && (
          <>
            <p className="o-stop-detail">At the Mac mini, within 10 minutes, run:</p>
            <p className="o-mono o-stop-code">bin/chat-pair passkey {code}</p>
            <p className="o-stop-small">It shows this device's name; type it to confirm. Then come back and tap Restart Jarvis again.</p>
          </>
        )}
        {phase === 'running' && (
          <p className="o-stop-detail" role="status">Restarting Jarvis… asked from {status.running.by} at {clock(status.running.startedAt)}. It takes a minute or two. You can close this: the card at the top shows the result.</p>
        )}
        {phase === 'done' && result && (
          <div className={`o-recover-result o-recover-result-${result.ok ? 'ok' : 'bad'}`} role="status">
            <p className="o-recover-result-label">{result.label}</p>
            <p className="o-mono o-recover-line">{last.line || '(no line)'}</p>
          </div>
        )}
        {phase === 'unusable' && <p className="o-stop-detail">This device can't restart Jarvis: only a paired device marked approver can, with Face ID.</p>}
        {error && <p className="o-stop-error" role="alert">{error}</p>}
        <CommandLine />
        <div className="o-stop-actions">
          {(phase === 'confirm' || phase === 'working') && (
            <button type="button" className="o-stop-go" onClick={go} disabled={busy || !btn.can}>{busy ? 'Waiting for Face ID…' : 'Restart with Face ID'}</button>
          )}
          {phase === 'setup' && (
            <button type="button" className="o-stop-go o-stop-setup" onClick={setUp} disabled={busy}>{settingUp ? 'Waiting for Face ID…' : 'Set up Face ID'}</button>
          )}
          <button type="button" className="o-stop-cancel" onClick={onClose} disabled={busy}>{phase === 'confirm' || phase === 'setup' ? 'Cancel' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}
