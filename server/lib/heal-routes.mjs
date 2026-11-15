// The taps on a loop 2 card (lib/heal-missed.mjs; design §5.5). The only writes the
// loops have:
//
//   POST /api/loops/<id>/approve   { "action": "rerun-job" | "ack-until-next-run" }
//   POST /api/loops/<id>/decline   {}   (Not now)
//
// Served by the chat's router, behind its checks, in this order: the write guard
// (same origin, JSON), no Authorization header (a Shortcut key never acts), a paired
// device by its cookie and the owner's login header, the page's own https Origin on an
// allowed host (the approvals rule), and an approver device (`bin/chat-pair approver`).
// Then at most TAPS_PER_MINUTE taps in all. The id is the card's one-time id (32 hex
// characters, made by the server); the body names an action and nothing else. What
// runs, on what, comes from the catalog and config, never from the request.
//
// Each accepted tap is logged and alerted like an approval's verdict (lib/chat-events.mjs,
// `heal-tap`, board e8d3ef26): the device and the job's name from config.
import { json, readBody, guardWrite, HttpError } from '../routes.mjs';
import { verdictOriginProblem } from './approvals.mjs';
import { ACTIONS } from './heal-missed.mjs';
import { oneLine } from './chat-events.mjs';

export const TAPS_PER_MINUTE = 6;
const ROUTE = /^\/api\/loops\/([a-f0-9]{32})\/(approve|decline)$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const TAP_BODY_MAX = 1024;

export function createHealTaps({ loops, now = () => Date.now(), onEvent = () => {}, log: logLine = console.log }) {
  // Every line here can hold a device name read back from devices.json: one line (L3).
  const log = line => logLine(oneLine(line));
  let recent = [];
  // `/api/loops` itself (the read) stays with the main handler.
  const owns = path => path.startsWith('/api/loops/');

  async function handle(req, res, path, { requireDevice, notifyHosts }) {
    const m = ROUTE.exec(path);
    if (req.method !== 'POST' || !m) throw new HttpError(404, 'not found');
    guardWrite(req);
    // The two refusals that mean someone tried more than a slip of the finger are
    // alerted (`heal-tap-refused`, capped like the Shortcut kinds: lib/chat-alert-limit.mjs), L5.
    if (req.headers?.authorization !== undefined) {
      onEvent({ kind: 'heal-tap-refused', why: 'key' });
      throw new HttpError(403, 'a Shortcut key can never answer a heal');
    }
    const device = requireDevice(req);
    const problem = verdictOriginProblem(req.headers, notifyHosts);
    if (problem) throw new HttpError(403, problem.replace('a verdict', 'a heal tap'));
    if (device.approver !== true) {
      onEvent({ kind: 'heal-tap-refused', why: 'not-approver', device: device.name });
      throw new HttpError(403, 'only a device marked approver can answer a heal (bin/chat-pair approver, on the machine)');
    }
    const at = now();
    recent = recent.filter(t => at - t < 60e3);
    if (recent.length >= TAPS_PER_MINUTE) throw new HttpError(429, 'too many heal taps this minute; wait a moment');
    recent.push(at);
    const body = await readBody(req, TAP_BODY_MAX);
    const [, id, verb] = m;
    let r;
    if (verb === 'approve') {
      const action = isObject(body) ? body.action : null;
      if (!ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${ACTIONS.join(', ')}`);
      r = await loops.approve(id, action, device.name);
    } else {
      r = await loops.decline(id, device.name);
    }
    if (!r.ok) {
      log(`heal: a tap from ${device.name} was refused (${r.status}: ${r.error})`);
      return json(res, r.status, { error: r.error }, NO_STORE);
    }
    log(`heal: ${r.action} tapped by ${device.name} for ${r.name}`);
    onEvent({ kind: 'heal-tap', device: device.name, action: r.action, name: r.name });
    const { status, ok, ...rest } = r;
    return json(res, status, { ok, ...rest }, NO_STORE);
  }

  return { owns, handle };
}
