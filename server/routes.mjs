import { buildAlerts } from './lib/alerts.mjs';
import { validateIngest } from './lib/validate-ingest.mjs';

// 256 KB is far more than any real feed and small enough that a hostile or
// buggy client cannot buffer the process to death. Before this, a 20 MB body
// was read into memory in full.
const MAX_BODY = 256 * 1024;

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const readBody = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let settled = false;
  const stop = (fn, arg) => {
    if (settled) return;
    settled = true;
    fn(arg);
  };

  req.on('data', c => {
    if (settled) return;
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += buf.length;
    if (size > limit) {
      // Stop reading, but do not destroy the socket: killing it here means the
      // client gets no response at all, only a dropped connection. The 413 goes
      // out first and the connection is closed with it.
      req.unpipe?.();
      req.pause?.();
      return stop(reject, new HttpError(413, `body exceeds ${limit} bytes`));
    }
    chunks.push(buf);
  });
  req.on('end', () => {
    if (settled) return;
    try {
      stop(resolve, JSON.parse(Buffer.concat(chunks).toString() || 'null'));
    } catch (err) {
      stop(reject, new HttpError(400, `invalid JSON: ${err.message}`));
    }
  });
  req.on('error', err => stop(reject, new HttpError(400, String(err?.message ?? err))));
});

// `Content-Type: text/plain` makes a POST a CORS *simple* request: no preflight,
// so any page the user happens to be visiting could write to these endpoints
// from their browser. Requiring JSON forces a preflight, and rejecting a
// non-same-origin `Origin` closes the path outright. The service binds to
// 127.0.0.1, so a legitimate request either carries no Origin (curl, a script)
// or carries this server's own.
const isJson = req =>
  String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

const isCrossOrigin = req => {
  const origin = req.headers?.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  try {
    return new URL(origin).host !== req.headers?.host;
  } catch {
    return true;
  }
};

const guardWrite = req => {
  if (isCrossOrigin(req)) throw new HttpError(403, 'cross-origin write refused');
  if (!isJson(req)) throw new HttpError(415, 'Content-Type must be application/json');
};

const PANELS = ['usage', 'sessions', 'agents', 'crons', 'plan', 'ingestCrons', 'ingestProjects', 'ingestCredits'];

export function createHandler({ cache, todos, config }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/api/dashboard') {
        const now = Date.now();
        const payload = {};
        for (const key of PANELS) payload[key] = cache.get(key, now);
        // A hardcoded 'ok' claimed a source that may not exist: with no
        // config.json the plan and credits panels rendered nothing at all under
        // their labels, with no marker saying why.
        const missing = config?.present === false;
        payload.config = {
          data: config,
          fetchedAt: now,
          status: missing ? 'unavailable' : 'ok',
          error: missing
            ? (config.error ?? 'no config.json on this machine — plan and credits have no source')
            : null
        };
        payload.alerts = config.showAlertBanner ? buildAlerts(payload, config, now) : [];
        payload.serverTime = now;
        return json(res, 200, payload);
      }

      if (path === '/api/todos') {
        if (req.method === 'GET') return json(res, 200, await todos.read());
        if (req.method === 'PUT') {
          guardWrite(req);
          return json(res, 200, await todos.write(await readBody(req)));
        }
      }

      const ingest = path.match(/^\/api\/ingest\/(crons|projects|credits)$/);
      if (ingest && req.method === 'POST') {
        guardWrite(req);
        const body = await readBody(req);
        const checked = validateIngest(ingest[1], body);
        if (!checked.ok) throw new HttpError(400, checked.error);
        const key = 'ingest' + ingest[1][0].toUpperCase() + ingest[1].slice(1);
        cache.set(key, checked.value);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      // Anything that reaches here is a bug or a rejected request — either way
      // it answers with a status code. It must never propagate out of the
      // handler, where an unhandled rejection would take the process (and the
      // whole in-memory cache) down with it.
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('api error', path, err);
      if (status === 413) {
        // The client is still uploading; answer and hang up rather than
        // reading the rest of a body already refused.
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        return res.end(JSON.stringify({ error: String(err.message) }));
      }
      return json(res, status, { error: String(err?.message ?? err) });
    }
  };
}
