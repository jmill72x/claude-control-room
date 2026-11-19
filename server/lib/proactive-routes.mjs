// GET /api/proactive: the proactive check's current hits (lib/proactive.mjs, view), for
// the page's Heads up and, later, the morning brief. Read-only, with exactly the Feed's
// rule (lib/feed-routes.mjs, deviceReadGuard): a paired device's cookie, and the owner's
// tailnet login when config's `chat.login` is set. With the chat off there are no
// devices, so nobody can read it. Not in /api/dashboard, which any tailnet browser
// reads: an expiry hit names a Shortcut key.
import { json, HttpError } from '../routes.mjs';
import { deviceReadGuard } from './feed-routes.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };
export const PROACTIVE_PATH = '/api/proactive';

export function createProactiveRoutes({ view, devices = null, login = null, log = console.error }) {
  const requireReader = deviceReadGuard({ devices, login });

  async function handler(req, res) {
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'the proactive check is read-only');
      requireReader(req);
      return json(res, 200, view(), NO_STORE);
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) log('proactive: a read failed', err?.code ?? err?.name ?? 'error');
      if (res.headersSent) return res.end();
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) }, NO_STORE);
    }
  }

  const owns = path => path === PROACTIVE_PATH;
  return { handler, owns };
}
