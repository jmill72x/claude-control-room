// GET /api/feed: the Feed tab's one route (lib/feed.mjs reads the files). The feed
// holds what the agents posted, the morning brief included, so it gets exactly the
// chat's read rule (requireDevice in lib/chat-routes.mjs), not the dashboard's: a
// paired device's cookie, with the owner's tailnet login when config's `chat.login` is
// set. No shortcut for a program on this machine (Ultron 11-11, L6). With the chat off
// there are no devices, so nobody can read it.
import { json, HttpError } from '../routes.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function createFeedRoutes({ feed, devices = null, login = null, log = console.error }) {
  const owner = typeof login === 'string' && login.trim() ? login.trim().toLowerCase() : null;

  function requireReader(req) {
    if (owner !== null) {
      const seen = req.headers?.['tailscale-user-login'];
      if (typeof seen !== 'string' || seen.trim().toLowerCase() !== owner) throw new HttpError(403, 'the request did not come as the owner through the tailnet');
    }
    if (!devices || !devices.authenticate(req.headers?.cookie)) throw new HttpError(401, 'this device is not paired');
  }

  async function handler(req, res) {
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'the feed is read-only');
      requireReader(req);
      return json(res, 200, await feed.read(), NO_STORE);
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) log('feed: a read failed', err?.code ?? err?.name ?? 'error');
      if (res.headersSent) return res.end();
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) }, NO_STORE);
    }
  }

  const owns = path => path === '/api/feed';
  return { handler, owns };
}
