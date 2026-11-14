// Stop buttons (war room slice 2, option B with Face ID; docs/design/2026-11-13-war-room-stop.md).
// The page's Stop on a live row asks the server, the server puts a typed `stop` line on
// the channel's stream, and the lead (Jarvis) matches it against its own background
// tasks and calls TaskStop. Nothing here stops anything itself.
//
//   POST /api/agents/<id>/stop/challenge  a Face ID challenge for that row
//   POST /api/agents/<id>/stop            the Face ID answer; the stop goes to the lead
//   GET  /api/stepup/status               whether this device has Face ID for stops
//   POST /api/stepup/register/options     start a Face ID set-up (lib/stepup.mjs)
//   POST /api/stepup/register             the made passkey; answers the code to confirm
//
// Every route: the write guard and the Origin rule (except the status read), no Authorization header (a Shortcut key
// never stops anything, C3), a paired device by its cookie and the login header, the
// page's own https Origin and same-origin fetch, and an approver device (C4). A stop
// also needs: a row id of 16 hex characters that is live now and marked `stoppable`
// (lib/live-agents.mjs), a channel that said at hello it takes stops, no stop for that
// row in the last minute (C5) and at most STOPS_PER_MINUTE in all, and a Face ID
// answer to a challenge issued for this device and this row.
//
// What reaches the lead is the store message's typed fields: the row id, the roster
// key and the start time (C1). Its text is fixed words from the same fields, for the
// page's thread; the brief line and the session name never go into it.
import { json, readBody, guardWrite, HttpError } from '../routes.mjs';
import { verdictOriginProblem } from './approvals.mjs';
import { STOP_ROW_RE, isStopMeta } from './chat-socket.mjs';

export const STOP_ROW_WAIT_MS = 60e3;
export const STOPS_PER_MINUTE = 6;
const ROUTE = /^\/api\/agents\/([^/]+)\/stop(\/challenge)?$/;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const NO_STORE = { 'Cache-Control': 'no-store' };

// The words the page's thread shows; built from typed fields only.
export function stopText({ agent, start }) {
  return `Stop asked: ${agent}'s background run, started ${new Date(start).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function createAgentStop({ stepUp, liveRuns, socket, store, now = () => Date.now(), onEvent = () => {}, log = console.log }) {
  const lastByRow = new Map(); // row id -> when its last stop went
  let recent = [];             // when each stop went, the last minute

  const owns = path => path.startsWith('/api/agents/') || path.startsWith('/api/stepup/');

  // The checks every route shares; the device, and the page's origin.
  function gate(req, { requireDevice, notifyHosts, write = true }) {
    if (write) guardWrite(req);
    if (req.headers?.authorization !== undefined) throw new HttpError(403, 'a Shortcut key can never stop or step up anything');
    const device = requireDevice(req);
    // A browser sends no Origin on a same-origin GET, so the status read (which changes
    // nothing and says only whether this device has a passkey) goes on the cookie alone.
    if (write) {
      const problem = verdictOriginProblem(req.headers, notifyHosts);
      if (problem) throw new HttpError(403, problem.replace('a verdict', 'a stop'));
    }
    if (device.approver !== true) throw new HttpError(403, 'only an approver device can stop a run');
    return { device, origin: write ? new URL(req.headers.origin).origin : null };
  }

  // The live row a stop names, or the reason there is none. "Not live" is reported,
  // never retried (C5): the run may have finished.
  function rowFor(id) {
    if (typeof id !== 'string' || !STOP_ROW_RE.test(id)) throw new HttpError(404, 'no such run');
    let runs;
    try { runs = liveRuns(); } catch { runs = null; }
    const row = Array.isArray(runs) ? runs.find(r => r?.id === id) : undefined;
    if (!row) throw new HttpError(404, 'that run is not live now; it may have finished');
    if (row.stoppable !== true || !isStopMeta({ row: id, agent: row.agent, start: row.start })) throw new HttpError(403, 'that run can\'t be stopped from here (only the lead\'s background agents can)');
    if (!socket.stopsOk()) throw new HttpError(503, 'Jarvis\'s channel is not taking stops now; stop it at the terminal');
    return row;
  }

  function limited(id, at) {
    recent = recent.filter(t => at - t < 60e3);
    const last = lastByRow.get(id);
    if (last !== undefined && at - last < STOP_ROW_WAIT_MS) return `a stop for this run went ${Math.round((at - last) / 1000)} s ago; Jarvis answers in the chat`;
    if (recent.length >= STOPS_PER_MINUTE) return 'too many stops this minute; wait a moment';
    return null;
  }

  async function handle(req, res, path, ctx) {
    if (req.method === 'GET' && path === '/api/stepup/status') {
      const { device } = gate(req, { ...ctx, write: false });
      const until = stepUp.pendingFor(device.id);
      return json(res, 200, { passkey: stepUp.has(device.id), pending: until !== null, pendingUntil: until }, NO_STORE);
    }
    if (req.method === 'POST' && path === '/api/stepup/register/options') {
      const { device, origin } = gate(req, ctx);
      const r = stepUp.registerOptions(device, origin);
      if (!r.ok) throw new HttpError(r.status, r.error);
      log(`stop: ${device.name} started a Face ID set-up`);
      return json(res, 200, { publicKey: r.options }, NO_STORE);
    }
    if (req.method === 'POST' && path === '/api/stepup/register') {
      const { device, origin } = gate(req, ctx);
      const body = await readBody(req);
      const r = stepUp.register(device, isObject(body) ? body : null, origin);
      if (!r.ok) { log(`stop: a Face ID set-up from ${device.name} was refused (${r.error})`); throw new HttpError(r.status, r.error); }
      log(`stop: ${device.name} made a Face ID passkey; waiting for its code at chat-pair`);
      return json(res, 200, { code: r.code, expiresAt: r.expiresAt }, NO_STORE);
    }
    const m = ROUTE.exec(path);
    if (req.method !== 'POST' || !m) throw new HttpError(404, 'not found');
    let id;
    try { id = decodeURIComponent(m[1]); } catch { throw new HttpError(404, 'no such run'); }
    const { device, origin } = gate(req, ctx);
    rowFor(id);
    const at = now();
    const wait = limited(id, at);
    if (wait) throw new HttpError(429, wait);
    if (m[2]) {
      const r = stepUp.challenge(device.id, `stop:${id}`, origin);
      if (!r.ok) throw new HttpError(r.status, r.error);
      return json(res, 200, { publicKey: r.publicKey }, NO_STORE);
    }
    const body = await readBody(req);
    const v = await stepUp.verifyAssertion(device.id, `stop:${id}`, isObject(body) ? body : null, origin);
    if (!v.ok) { log(`stop: a stop from ${device.name} was refused (${v.error})`); throw new HttpError(v.status, v.error); }
    // Looked up again after the Face ID wait: the run may have ended, or the channel gone.
    const still = rowFor(id);
    const again = limited(id, now());
    if (again) throw new HttpError(429, again);
    lastByRow.set(id, now());
    recent.push(now());
    for (const [k, t] of lastByRow) if (now() - t > STOP_ROW_WAIT_MS) lastByRow.delete(k);
    const stop = { row: id, agent: still.agent, start: still.start };
    const msg = await store.append({ from: 'jeff', kind: 'stop', text: stopText(stop), device: device.name, meta: { stop } });
    log(`stop: ${device.name} asked to stop a ${still.agent} run (row ${id}); sent to the lead as message ${msg.id}`);
    onEvent({ kind: 'stop-asked', device: device.name, agent: still.agent });
    return json(res, 202, { ok: true, id: msg.id, note: 'Sent to Jarvis. It stops the run at its next turn and answers in the chat.' }, NO_STORE);
  }

  return { owns, handle };
}
