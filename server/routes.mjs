import { buildAlerts } from './lib/alerts.mjs';
import { validateIngest } from './lib/validate-ingest.mjs';
import { nextRenewalDate } from './lib/renewal.mjs';
import { StaleRevisionError, InvalidBoardError } from './todos.mjs';
import { readRoster } from './lib/roster.mjs';

// 256 KB is far more than any real feed and small enough that a hostile or
// buggy client cannot buffer the process to death. Before this, a 20 MB body
// was read into memory in full.
const MAX_BODY = 256 * 1024;
// The board is the one body that grows without end: every PUT carries every
// item ever written, Done included, and on 2026-10-21 it was 30% of 256 KB and
// growing by a few KB a day. It gets 1 MiB of its own. The `board` panel
// (server.mjs) reports its size against this, and past 75% an alert says so.
export const BOARD_MAX_BODY = 1024 * 1024;

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
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

// The board's revision travels as an HTTP entity tag, so the body stays the
// bare list it has always been: a plain `curl` GET-modify-PUT never sees it.
const etag = revision => (revision ? `"${revision}"` : null);
const boardHeaders = revision => ({
  // A tab that re-reads the board must get the board, never a cached copy.
  'Cache-Control': 'no-store',
  ...(revision ? { ETag: etag(revision) } : {})
});

// If-Match as RFC 9110 writes it: `*`, or a comma list of entity tags, each
// possibly weak (`W/"…"`). Returns null when the header is absent, 'any' for
// `*`, else the list of revisions it names.
export function parseIfMatch(header) {
  if (header === undefined || header === null) return null;
  const value = String(header).trim();
  if (value === '') return null;
  if (value === '*') return 'any';
  const tags = [...value.matchAll(/(?:W\/)?"([^"]*)"/g)].map(m => m[1]);
  // A header that names no well-formed tag still asked for a check; it can
  // match nothing, so it gets a 409 rather than being read as "no check".
  return tags.length ? tags : [''];
}

const PANELS = ['usage', 'sessions', 'agents', 'crons', 'plan', 'accountCredits', 'ingestCrons', 'ingestProjects', 'ingestCredits', 'board', 'health', 'toPush'];

// What of config.json the page gets: only the fields it shows. The page used to
// get the whole object, so anything added to config.json (a path, a command, a
// topic) reached every device on the tailnet. Plan and credits keep their
// documented fields; the roster sends names and keys, never the avatar folder.
const PLAN_FIELDS = ['price', 'renews', 'cycle', 'seats', 'nextRenewal'];
const CREDIT_FIELDS = ['balance', 'spent', 'monthlyLimit', 'resetsOn', 'promoAmount', 'promoExpiresOn', 'updatedAt'];
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const pick = (obj, keys) => (isObject(obj) ? Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]])) : null);

export function pageConfig(config, planData) {
  const roster = readRoster(config);
  return {
    warnThreshold: config?.warnThreshold,
    showAlertBanner: config?.showAlertBanner,
    plan: pick(planData, PLAN_FIELDS),
    credits: pick(config?.credits, CREDIT_FIELDS),
    roster: { agents: roster.agents, tagOwners: roster.tagOwners },
    jobs: roster.jobs
  };
}

export function createHandler({ cache, todos, config }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      // The watchdog's self-check. Touches nothing but the listener itself:
      // the question it answers is "is anyone answering this port".
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

      if (req.method === 'GET' && path === '/api/dashboard') {
        const now = Date.now();
        const payload = {};
        for (const key of PANELS) payload[key] = cache.get(key, now);
        // A hardcoded 'ok' claimed a source that may not exist: with no
        // config.json the plan and credits panels rendered nothing at all under
        // their labels, with no marker saying why.
        const missing = config?.present === false;
        // `plan.renews` in config is an anchor date, not necessarily the next
        // real renewal — it can be (and today, is) in the future, or it can
        // be a date that has since passed. The next-on-or-after date is
        // computed once, here, server-side where it is unit-testable, and
        // shipped as `plan.nextRenewal` so the client renders one
        // already-resolved value instead of recomputing (and potentially
        // re-deriving it wrong) on every device that opens the page.
        const planData = config?.plan
          ? { ...config.plan, nextRenewal: nextRenewalDate(config.plan.renews, config.plan.cycle, now) }
          : null;
        payload.config = {
          data: pageConfig(config, planData),
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
        if (req.method === 'GET') {
          const { todos: list, revision } = await todos.readState();
          return json(res, 200, list, boardHeaders(revision));
        }
        if (req.method === 'PUT') {
          guardWrite(req);
          const ifMatch = parseIfMatch(req.headers?.['if-match']);
          // A browser always sends Origin on a PUT; curl, Node's and Bun's
          // fetch (Jarvis, the Claude Code mod) do not. So a browser write
          // with no revision is a page built before revisions existed, the
          // very stale tab that kept reverting Jarvis's edits: refuse it.
          // Its old code re-reads the board on any failed save, so the tab
          // shows the current board instead of saving its old one.
          if (ifMatch === null && req.headers?.origin) {
            throw new HttpError(428, 'this page is out of date: reload it before editing the board');
          }
          const body = await readBody(req, BOARD_MAX_BODY);
          try {
            const saved = await todos.save(body, { ifMatch: Array.isArray(ifMatch) ? ifMatch : null });
            return json(res, 200, saved.todos, boardHeaders(saved.revision));
          } catch (err) {
            // A board that cannot be held (unknown lane, bad priority, a due
            // date that is not YYYY-MM-DD) is the caller's mistake: say what
            // is wrong, write nothing.
            if (err instanceof InvalidBoardError) throw new HttpError(400, err.message);
            if (!(err instanceof StaleRevisionError)) throw err;
            return json(res, 409, { error: 'the board changed since this copy was read', revision: err.current },
              boardHeaders(err.current));
          }
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
