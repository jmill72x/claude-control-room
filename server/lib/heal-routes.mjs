// The taps on a heal card: loop 2's (lib/heal-missed.mjs) and loop 3's
// (lib/heal-restart.mjs); design §5.5. The only writes the loops have:
//
//   POST /api/loops/<id>/approve   { "action": "rerun-job" | "ack-until-next-run" | "restart-control-room" }
//   POST /api/loops/<id>/decline   {}   (Not now)
//
// Served by the chat's router, behind its checks, in this order: the write guard
// (same origin, JSON), no Authorization header (a Shortcut key never acts), a paired
// device by its cookie and the owner's login header, the page's own https Origin on an
// allowed host (the approvals rule), and an approver device (`bin/chat-pair approver`).
// A request with an Authorization header is refused before the device is looked at, and
// alerted only once the login header has passed (board fe4d2bfe), so a caller that can
// reach the port but isn't the owner can't raise pushes with it.
// Then at most TAPS_PER_MINUTE taps in all. The id is the card's one-time id (32 hex
// characters, made by the server); the body names an action and nothing else. What
// runs, on what, comes from the catalog and config, never from the request.
//
// Each accepted tap is logged and alerted like an approval's verdict (lib/chat-events.mjs,
// `heal-tap`, board e8d3ef26): the device, the job's name from config and the card's
// kind. An action names its loop; Not now goes to the loop whose card has that id.
//
// Loop 3's answer goes out before its restart: the loop runs launchctl a few seconds
// after it returns (lib/heal-restart.mjs, KICK_DELAY_MS), so this response, its log line
// and its alert are sent while the process is still here.
import { json, readBody, guardWrite, HttpError } from '../routes.mjs';
import { verdictOriginProblem } from './approvals.mjs';
import { ACTIONS as MISSED_ACTIONS } from './heal-missed.mjs';
import { ACTIONS as RESTART_ACTIONS } from './heal-restart.mjs';
import { oneLine } from './chat-events.mjs';

export const ACTIONS = Object.freeze([...MISSED_ACTIONS, ...RESTART_ACTIONS]);

export const TAPS_PER_MINUTE = 6;
const ROUTE = /^\/api\/loops\/([a-f0-9]{32})\/(approve|decline)$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const TAP_BODY_MAX = 1024;

// `loops` is { missed, restart } (either may be missing), or one loop for both (tests).
export function createHealTaps({ loops, now = () => Date.now(), onEvent = () => {}, log: logLine = console.log }) {
  const missed = loops?.missed ?? (loops?.approve ? loops : null);
  const restart = loops?.restart ?? (loops?.approve ? loops : null);
  const NOT_OPEN = { status: 404, error: 'that card is no longer open; the page shows the ones that are' };
  const loopFor = action => (RESTART_ACTIONS.includes(action) ? restart : missed);
  const decline = (id, by) => {
    if (restart && restart !== missed && restart.has?.(id)) return restart.decline(id, by);
    return missed ? missed.decline(id, by) : NOT_OPEN;
  };
  // Every line here can hold a device name read back from devices.json: one line (L3).
  const log = line => logLine(oneLine(line));
  let recent = [];
  // `/api/loops` itself (the read) stays with the main handler.
  const owns = path => path.startsWith('/api/loops/');

  async function handle(req, res, path, { requireDevice, requireLogin, notifyHosts }) {
    // The login check is required (L10): without it a key's refusal would alert for anyone.
    if (typeof requireLogin !== 'function') throw new Error('the heal routes need the login check');
    const m = ROUTE.exec(path);
    if (req.method !== 'POST' || !m) throw new HttpError(404, 'not found');
    guardWrite(req);
    // The two refusals that mean someone tried more than a slip of the finger are
    // alerted (`heal-tap-refused`, capped like the Shortcut kinds: lib/chat-alert-limit.mjs), L5.
    // A key's refusal is alerted only from the owner's login (fe4d2bfe): anyone else is
    // refused by the login check, unalerted.
    if (req.headers?.authorization !== undefined) {
      requireLogin(req);
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
      const loop = loopFor(action);
      r = loop ? await loop.approve(id, action, device.name) : NOT_OPEN;
    } else {
      r = await decline(id, device.name);
    }
    if (!r.ok) {
      log(`heal: a tap from ${device.name} was refused (${r.status}: ${r.error})`);
      return json(res, r.status, { error: r.error }, NO_STORE);
    }
    log(`heal: ${r.action} tapped by ${device.name} for ${r.name}`);
    onEvent({ kind: 'heal-tap', device: device.name, action: r.action, name: r.name, ...(r.card === 'restart-due' ? { card: 'restart-due' } : {}) });
    const { status, ok, ...rest } = r;
    return json(res, status, { ok, ...rest }, NO_STORE);
  }

  return { owns, handle };
}
