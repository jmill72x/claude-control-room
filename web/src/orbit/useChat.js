import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './chatApi.js';
import { mergeMessages, applyEdit, applyState, lastSeq, oldestId, newClientId, upsertPermission, withStatus, phaseFor, afterStreamRefusal, PAGE } from '../lib/orbit/chat.js';

// The Chat tab's state (jarvis-os-chat-spec.md, C5): whether this device is
// paired, the thread, the open permission requests, the status, and the stream.
//
// The stream is an EventSource on /api/chat/stream. On its own reconnects the
// browser sends Last-Event-ID (each message event's id is its seq) and the server
// replays after it. iOS suspends a background tab's connections without an error,
// so when the page becomes visible again the stream is closed and opened anew
// from the highest seq the page holds (`?after=`), which replays whatever was
// missed. A stream the server ends (a revoke sends one last `revoked` event, and
// a later open gets 401) sends the page back to the pairing screen.
//
// A send is optimistic: the bubble appears at once with a `clientId`, the server
// dedups on that id, so a retry after a lost answer never doubles the message.
const REOPEN_MS = 3000;
const PAIR_POLL_MS = 2000;

export function useChat({ active }) {
  const [phase, setPhase] = useState('checking'); // checking | unpaired | paired | off | forbidden | error
  const [device, setDevice] = useState(null);
  const [status, setStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [permissions, setPermissions] = useState(() => new Map());
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [stream, setStream] = useState('closed'); // closed | open
  const [problem, setProblem] = useState(null);
  const [pairing, setPairing] = useState(null); // { name, code, expiresAt, state }
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const esRef = useRef(null);
  const reopenRef = useRef(null);
  const aliveRef = useRef(true);
  const pairingRef = useRef(null); // the pairing poll's timer
  const pollRef = useRef(null);    // the poll itself, for a pairing resumed after a reload

  const closeStream = useCallback(() => {
    clearTimeout(reopenRef.current);
    reopenRef.current = null;
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setStream('closed');
  }, []);

  // A refusal that means "this device is not paired" ends the session here, and
  // nothing of it stays behind: a later pairing starts from an empty thread.
  const unpaired = useCallback(() => {
    closeStream();
    setDevice(null);
    setMessages([]);
    setPermissions(new Map());
    setStatus(null);
    setHasOlder(false);
    setPhase('unpaired');
  }, [closeStream]);

  // A status (an event or /api/chat/status's answer) also clears the open cards
  // the server no longer counts.
  const applyStatus = useCallback(s => {
    setStatus(s);
    setPermissions(map => withStatus(map, s));
  }, []);

  const openStream = useCallback(() => {
    if (!aliveRef.current) return;
    closeStream();
    const es = new EventSource(api.streamUrl(lastSeq(messagesRef.current)));
    esRef.current = es;
    // The server replays every open request on connect, so the cards start over
    // with each stream: one answered while the page was away doesn't linger.
    setPermissions(new Map());
    const parse = e => { try { return JSON.parse(e.data); } catch { return null; } };
    es.addEventListener('open', () => setStream('open'));
    es.addEventListener('status', e => { const s = parse(e); if (s) applyStatus(s); });
    es.addEventListener('message', e => { const m = parse(e); if (m) setMessages(list => mergeMessages(list, m)); });
    es.addEventListener('edit', e => { const m = parse(e); if (m) setMessages(list => applyEdit(list, m)); });
    es.addEventListener('state', e => { const s = parse(e); if (s) setMessages(list => applyState(list, s)); });
    es.addEventListener('permission', e => { const p = parse(e); if (p) setPermissions(map => upsertPermission(map, p)); });
    es.addEventListener('permission-closed', e => { const p = parse(e); if (p) setPermissions(map => upsertPermission(map, p)); });
    es.addEventListener('revoked', () => unpaired());
    es.addEventListener('error', () => {
      // The browser retries by itself while the connection merely dropped; once it
      // gives up (an HTTP error, such as 401 after a revoke), ask the status route
      // why, and open again in 3 s unless the answer is a refusal that stays
      // (not paired, not the owner, or the chat turned off).
      if (es.readyState !== EventSource.CLOSED) { setStream('closed'); return; }
      if (esRef.current !== es) return;
      esRef.current = null;
      setStream('closed');
      api.chatStatus().then(s => {
        if (!aliveRef.current) return;
        applyStatus(s);
        reopenRef.current = setTimeout(openStream, REOPEN_MS);
      }).catch(err => {
        if (!aliveRef.current) return;
        const next = afterStreamRefusal(err);
        if (next.reopen) { reopenRef.current = setTimeout(openStream, REOPEN_MS); return; }
        if (next.phase === 'unpaired') { unpaired(); return; }
        setPhase(next.phase);
        setProblem(String(err?.message ?? err));
      });
    });
  }, [closeStream, unpaired, applyStatus]);

  // The thread's first load: the status (which also says whether this device is
  // paired), the latest page, then the stream.
  const load = useCallback(async () => {
    setProblem(null);
    try {
      // /api/pair/status answers 200 to any device: paired (its own name), or
      // none, pending or expired, so an unpaired device never takes a 401 here.
      const p = await api.pairStatus();
      if (!aliveRef.current) return;
      if (p.state !== 'paired') {
        if (p.state === 'pending') {
          // A pairing started before a reload: its cookie lives on, so keep polling.
          setPairing(prev => prev ?? { name: null, code: null, expiresAt: p.expiresAt ?? null, state: 'pending', error: null });
          clearTimeout(pairingRef.current);
          pairingRef.current = setTimeout(() => pollRef.current?.(), PAIR_POLL_MS);
        }
        unpaired();
        return;
      }
      const s = await api.chatStatus();
      if (!aliveRef.current) return;
      applyStatus(s);
      setDevice(s.device ?? null);
      const page = await api.latestMessages(PAGE);
      if (!aliveRef.current) return;
      setMessages(list => mergeMessages(list, page.messages));
      setHasOlder(page.messages.length >= PAGE);
      setPhase('paired');
      openStream();
    } catch (err) {
      if (!aliveRef.current) return;
      const next = phaseFor(err);
      setPhase(next);
      if (next === 'unpaired') unpaired();
      else setProblem(String(err?.message ?? err));
    }
  }, [openStream, unpaired, applyStatus]);

  useEffect(() => {
    aliveRef.current = true;
    if (!active) return undefined;
    load();
    return () => { aliveRef.current = false; closeStream(); };
  }, [active, load, closeStream]);

  // Back from the background: open the stream anew from where the page is.
  useEffect(() => {
    if (!active) return undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (phase === 'paired') openStream();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, [active, phase, openStream]);

  // ---- older history (scroll-up) ----
  const loadOlder = useCallback(async () => {
    const before = oldestId(messagesRef.current);
    if (!before || loadingOlder) return 0;
    setLoadingOlder(true);
    try {
      const page = await api.messagesBefore(before, PAGE);
      if (!aliveRef.current) return 0;
      setMessages(list => mergeMessages(list, page.messages));
      setHasOlder(page.messages.length >= PAGE);
      return page.messages.length;
    } catch (err) {
      if (err?.status === 401) unpaired();
      return 0;
    } finally {
      if (aliveRef.current) setLoadingOlder(false);
    }
  }, [loadingOlder, unpaired]);

  // ---- sending ----
  const setPending = (clientId, patch) => setMessages(list => list.map(m => (m.clientId === clientId && !Number.isInteger(m.seq) ? { ...m, ...patch } : m)));

  // `files` are { name, blob } already resized by the composer; each is uploaded
  // first (its id kept on the bubble, so a retry uploads only what failed).
  const deliver = useCallback(async pending => {
    const { clientId } = pending;
    setPending(clientId, { failed: false, error: null });
    try {
      const ids = [...(pending.attachmentIds ?? [])];
      const files = pending.files ?? [];
      for (let i = ids.length; i < files.length; i++) {
        const up = await api.uploadAttachment(files[i].blob, files[i].name);
        ids.push(up.id);
        setPending(clientId, { attachmentIds: [...ids], attachments: files.map((f, j) => ({ id: ids[j] ?? null, name: f.name, type: f.blob.type, bytes: f.blob.size })) });
      }
      const r = await api.sendMessage({ clientId, text: pending.text, replyTo: pending.replyTo, attachmentIds: ids });
      if (!aliveRef.current) return;
      setMessages(list => {
        // The live event may have come first: then the bubble just goes.
        if (list.some(m => m.id === r.id && Number.isInteger(m.seq))) return list.filter(m => !(m.clientId === clientId && !Number.isInteger(m.seq)));
        return list.map(m => (m.clientId === clientId && !Number.isInteger(m.seq) ? { ...m, id: r.id } : m));
      });
    } catch (err) {
      if (!aliveRef.current) return;
      if (err?.status === 401) { unpaired(); return; }
      setPending(clientId, { failed: true, error: String(err?.message ?? err) });
    }
  }, [unpaired]);

  const send = useCallback(({ text, replyTo = null, files = [] }) => {
    const clientId = newClientId();
    const pending = {
      clientId, id: null, seq: null, at: Date.now(), from: 'jeff', kind: 'chat', text, replyTo,
      device: device?.name ?? null, attachments: files.map(f => ({ id: null, name: f.name, type: f.blob.type, bytes: f.blob.size })),
      editedAt: null, state: null, failed: false, error: null, files, attachmentIds: []
    };
    setMessages(list => [...list, pending]);
    deliver(pending);
    return clientId;
  }, [device, deliver]);

  const retry = useCallback(clientId => {
    const pending = messagesRef.current.find(m => m.clientId === clientId && !Number.isInteger(m.seq));
    if (pending) deliver(pending);
  }, [deliver]);

  const discard = useCallback(clientId => setMessages(list => list.filter(m => !(m.clientId === clientId && !Number.isInteger(m.seq)))), []);

  // ---- verdicts ----
  const verdict = useCallback(async (requestId, behavior) => {
    try {
      const r = await api.answerPermission(requestId, behavior);
      setPermissions(map => { const p = map.get(requestId); return p ? upsertPermission(map, { ...p, state: r.state }) : map; });
      return { ok: true };
    } catch (err) {
      if (err?.status === 401) unpaired();
      // 409: already answered (in Discord, or on another device); the server's
      // own event tells the card what happened.
      return { ok: false, error: String(err?.message ?? err) };
    }
  }, [unpaired]);
  const dismissPermission = useCallback(requestId => setPermissions(map => { const next = new Map(map); next.delete(requestId); return next; }), []);

  // ---- pairing (§2.2) ----
  useEffect(() => () => clearTimeout(pairingRef.current), []);
  const pollPairing = useCallback(async () => {
    try {
      const r = await api.pairStatus();
      if (!aliveRef.current) return;
      if (r.state === 'paired') { setPairing(null); load(); return; }
      setPairing(p => (p ? { ...p, state: r.state } : p));
      if (r.state === 'pending') pairingRef.current = setTimeout(pollPairing, PAIR_POLL_MS);
    } catch (err) {
      if (!aliveRef.current) return;
      setPairing(p => (p ? { ...p, state: 'error', error: String(err?.message ?? err) } : p));
    }
  }, [load]);
  pollRef.current = pollPairing;
  const startPairing = useCallback(async name => {
    clearTimeout(pairingRef.current);
    setPairing({ name, code: null, expiresAt: null, state: 'starting', error: null });
    try {
      const r = await api.pairStart(name);
      if (!aliveRef.current) return;
      setPairing({ name, code: r.code, expiresAt: r.expiresAt, state: 'pending', error: null });
      pairingRef.current = setTimeout(pollPairing, PAIR_POLL_MS);
    } catch (err) {
      if (!aliveRef.current) return;
      setPairing({ name, code: null, expiresAt: null, state: 'error', error: String(err?.message ?? err) });
    }
  }, [pollPairing]);
  const cancelPairing = useCallback(() => { clearTimeout(pairingRef.current); setPairing(null); }, []);

  // ---- devices ----
  const devices = useCallback(() => api.listDevices().then(r => r.devices), []);
  const revoke = useCallback(async id => {
    await api.revokeDevice(id);
    if (device && id === device.id) unpaired();
  }, [device, unpaired]);
  const approve = useCallback(code => api.pairApprove(code), []);

  return {
    phase, problem, device, status, messages, permissions, hasOlder, loadingOlder, stream,
    reload: load, loadOlder, send, retry, discard, verdict, dismissPermission,
    pairing, startPairing, cancelPairing, pollPairing, devices, revoke, approve
  };
}
