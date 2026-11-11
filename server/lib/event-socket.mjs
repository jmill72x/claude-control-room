// The event socket (Jarvis OS pillar 3, Ultron's M4): a Unix socket of its own,
// `~/.local/state/jarvis-os/events.sock` (0600 in the 0700 folder), apart from the
// channel's and the admin socket. It offers one route, `POST /v1/event`, whose body is
// typed per source: `{ source, count, ref? }`, where `source` must be on config's
// `events.sources` allowlist (empty by default, so slice 1 refuses every post). There
// is no free text: the words are built here from a template (lib/events.mjs), and the
// caps, dedupe, quiet hours and kill switch apply as for the notifier's events.
// Any process running as the owner may post (the owner's decision 5, 2026-11-11); the
// socket's mode keeps everyone else out. Errors are `{error}` with fixed words.
import { json, readBody, HttpError } from '../routes.mjs';
import { checkEventBody } from './events.mjs';

// A typed body is a few dozen bytes; anything near this is not one.
export const EVENT_BODY_MAX = 1024;

export function createEventSocketRouter({ events, sources = new Map(), log = console.log }) {
  return async function handler(req, res) {
    const path = new URL(req.url, 'http://unix').pathname;
    try {
      if (path !== '/v1/event') return json(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return json(res, 405, { error: 'only POST' }, { Allow: 'POST' });
      const body = await readBody(req, EVENT_BODY_MAX);
      const checked = checkEventBody(body, sources);
      if (!checked.ok) {
        log(`events: a post on the event socket was refused (${checked.status})`);
        throw new HttpError(checked.status, checked.error);
      }
      const r = await events.post(checked);
      log(`events: ${checked.source} posted (${r.status})`);
      return json(res, r.status === 'made' ? 201 : 202, { status: r.status });
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error('event socket error', err?.message ?? err);
      if (res.headersSent) return res.end();
      // readBody's 413 and invalid-JSON words are fixed; anything else is ours.
      return json(res, code, { error: code === 500 ? 'internal error' : String(err.message) });
    }
  };
}
