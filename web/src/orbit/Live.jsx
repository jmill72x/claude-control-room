// Live agents, on the Overview under Usage limits (war room): the agent runs going
// right now, from the `liveAgents` block in the sessions panel. Slice 2 adds a Stop
// button on the lead's background agents, for an approver device only: a confirm
// sheet, then Face ID, then the server asks Jarvis to stop the run (server
// lib/agent-stop.mjs). The logic is in src/lib/orbit/live.js and stop.js.
import { useEffect, useState } from 'react';
import { envelopeOf } from '../lib/format.js';
import { liveRows, liveSummary } from '../lib/orbit/live.js';
import { stopQuestion, faceIdError } from '../lib/orbit/stop.js';
import { unavailable, PARTIAL } from '../lib/orbit/page.js';
import { stepUpStatus, setUpFaceId, stopRun } from './stopApi.js';
import { Avatar } from './Avatar.jsx';
import { Note } from './Note.jsx';

export function LiveAgents({ payload, now, roster }) {
  const env = envelopeOf(payload?.sessions);
  const live = env.data?.liveAgents ?? null;
  const partial = (env.data?.unreadablePaths?.length ?? 0) > 0;
  const rows = live ? liveRows({ live, roster, now }) : [];
  const anyStoppable = rows.some(r => r.stoppable);
  // Whether this device may stop (an approver) and has Face ID set up: asked once,
  // and only when a row could show a Stop.
  const [step, setStep] = useState(null);
  const [sheet, setSheet] = useState(null);
  useEffect(() => {
    if (!anyStoppable || step !== null) return;
    let gone = false;
    stepUpStatus().then(s => { if (!gone) setStep({ ok: true, passkey: s.passkey === true, pendingUntil: s.pending === true ? s.pendingUntil : null }); })
      .catch(() => { if (!gone) setStep({ ok: false }); });
    return () => { gone = true; };
  }, [anyStoppable, step]);
  let note = null;
  if (env.status === 'unavailable' && !live) note = unavailable(env);
  else if (env.data && !live) note = 'The server running now does not send live agents. They arrive with its next restart.';
  else if (!env.data) note = 'Nothing to show yet.';
  else if (rows.length === 0) note = 'No agents running.';
  return (
    <section aria-labelledby="o-live" className="o-panel o-live">
      <div className="o-panel-head o-panel-head-base">
        <h2 id="o-live" className="o-h2 o-h2-day">Live agents</h2>
        {live && <span className="o-sub">{liveSummary(live)} · each minute</span>}
      </div>
      {note ? <Note>{note}</Note> : (
        <ul className="o-live-list">
          {rows.map(r => (
            <li key={r.key} className="o-live-row">
              <Avatar agent={r.agent} size={32} />
              <div className="o-live-body">
                <p className="o-live-top">
                  <b className="o-live-name">{r.name}</b>
                  {r.model && <span className="o-live-model">{r.model}</span>}
                  <span className="o-mono o-live-for">{r.running}</span>
                </p>
                <p className="o-live-task">{r.task}</p>
                <p className="o-live-meta">
                  {[r.tokens, r.session].filter(Boolean).join(' · ')}
                  {r.quiet && <span className="o-live-quiet">{r.quiet}</span>}
                </p>
              </div>
              {r.stoppable && step?.ok && (
                <button type="button" className="o-live-stop" onClick={() => setSheet(r)} aria-label={`Stop ${r.name}`}>Stop</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {live && partial && <Note>{PARTIAL}</Note>}
      {sheet && <StopSheet row={sheet} step={step} onStep={setStep} onClose={() => setSheet(null)} />}
    </section>
  );
}

// The confirm sheet: two taps and Face ID. Without a passkey yet, it sets one up and
// shows the code to confirm at the Mac mini instead.
function StopSheet({ row, step, onStep, onClose }) {
  const [state, setState] = useState({ phase: step.passkey ? 'confirm' : 'setup' });
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const q = stopQuestion(row);
  const busy = state.phase === 'working';
  const go = async () => {
    setState({ phase: 'working' });
    try {
      const r = await stopRun(row.id);
      setState({ phase: 'sent', text: r.note });
    } catch (err) {
      setState({ phase: 'confirm', error: err?.status ? err.message : faceIdError(err) });
    }
  };
  const setUp = async () => {
    setState({ phase: 'working' });
    try {
      const r = await setUpFaceId();
      onStep({ ...step, pendingUntil: r.expiresAt });
      setState({ phase: 'code', code: r.code });
    } catch (err) {
      setState({ phase: 'setup', error: err?.status ? err.message : faceIdError(err) });
    }
  };
  return (
    <div className="o-chat o-chat-sheet-back" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="o-chat-sheet o-stop-sheet" role="dialog" aria-modal="true" aria-labelledby="o-stop-title">
        <div className="o-chat-sheet-head">
          <h2 id="o-stop-title" className="o-chat-h2">{state.phase === 'setup' || state.phase === 'code' ? 'Face ID for stops' : q.title}</h2>
          <button type="button" className="o-chat-iconbtn" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </div>
        {(state.phase === 'confirm' || state.phase === 'working') && step.passkey && (
          <>
            <p className="o-stop-detail">{q.detail}</p>
            <p className="o-stop-small">Jarvis stops it at its next turn and answers in the chat. A stop ends the run; it does not undo what the run already did.</p>
          </>
        )}
        {(state.phase === 'setup' || (state.phase === 'working' && !step.passkey)) && (
          <p className="o-stop-detail">{step.pendingUntil
            ? `A Face ID set-up from this device is waiting for its code at the Mac mini until ${new Date(step.pendingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Confirm it there, then tap Stop again.`
            : 'A stop needs Face ID on this device. Set it up once: make the passkey here, then confirm its code at the Mac mini.'}</p>
        )}
        {state.phase === 'code' && (
          <>
            <p className="o-stop-detail">At the Mac mini, within 10 minutes, run:</p>
            <p className="o-mono o-stop-code">bin/chat-pair passkey {state.code}</p>
            <p className="o-stop-small">It shows this device's name; type it to confirm. Then come back and tap Stop again.</p>
          </>
        )}
        {state.phase === 'sent' && <p className="o-stop-detail">{state.text}</p>}
        {state.error && <p className="o-stop-error" role="alert">{state.error}</p>}
        <div className="o-stop-actions">
          {step.passkey && (state.phase === 'confirm' || state.phase === 'working') && (
            <button type="button" className="o-stop-go" onClick={go} disabled={busy}>{busy ? 'Waiting for Face ID…' : 'Stop with Face ID'}</button>
          )}
          {!step.passkey && !step.pendingUntil && (state.phase === 'setup' || state.phase === 'working') && (
            <button type="button" className="o-stop-go o-stop-setup" onClick={setUp} disabled={busy}>{busy ? 'Waiting for Face ID…' : 'Set up Face ID'}</button>
          )}
          <button type="button" className="o-stop-cancel" onClick={onClose} disabled={busy}>{state.phase === 'sent' || state.phase === 'code' ? 'Done' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}
