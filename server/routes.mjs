import { buildAlerts } from './lib/alerts.mjs';
import { validateIngest } from './lib/validate-ingest.mjs';
import { localCaller, PROXY_HEADERS } from './lib/local-caller.mjs';
import { nextRenewalDate } from './lib/renewal.mjs';
import { StaleRevisionError, InvalidBoardError } from './todos.mjs';
import { readRoster } from './lib/roster.mjs';
import {
  applyAcks, decoratePayload, checkAckRequest, makeAck, isAckKey, ACK_MAX_BODY, ackLogLine, unackLogLine, ackNotice
} from './lib/acks.mjs';
import { checkNeedsYou, needsYouLogLine, BLOCK_EVENTS } from './lib/needs-you.mjs';
import { checkExactReport } from './lib/exact-commands.mjs';

// 256 KB is far more than any real feed and small enough that a hostile or
// buggy client cannot buffer the process to death. Before this, a 20 MB body
// was read into memory in full.
const MAX_BODY = 256 * 1024;
// The board is the one body that grows without end: every PUT carries every
// item ever written, Done included, and on 2026-10-21 it was 30% of 256 KB and
// growing by a few KB a day. It gets 1 MiB of its own. The `board` panel
// (server.mjs) reports its size against this, and past 75% an alert says so.
export const BOARD_MAX_BODY = 1024 * 1024;
// A hook's report of one Bash command (lib/exact-commands.mjs caps the text at 4,000
// characters; as JSON with every character escaped that is under 32 KB).
const EXACT_MAX_BODY = 32 * 1024;

// nosniff on every answer (the 2026-10-21 security review): a browser keeps to the
// JSON type, so no answer, a board item's text included, is ever read as a page.
const API_HEADERS = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };

export const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { ...API_HEADERS, ...headers });
  res.end(JSON.stringify(body));
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const readBody = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
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
    } catch {
      // Fixed words: the parser's message quotes the body around the fault, which
      // could be a credential or a board item's text (the 2026-11-11 review, 5).
      stop(reject, new HttpError(400, 'invalid JSON'));
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

export const isCrossOrigin = req => {
  const origin = req.headers?.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  try {
    return new URL(origin).host !== req.headers?.host;
  } catch {
    return true;
  }
};

export const guardWrite = req => {
  if (isCrossOrigin(req)) throw new HttpError(403, 'cross-origin write refused');
  if (!isJson(req)) throw new HttpError(415, 'Content-Type must be application/json');
};
// A DELETE has no body, so no content type to require; a browser never sends one
// without a preflight, which the same-origin rule then refuses.
export const guardDelete = req => {
  if (isCrossOrigin(req)) throw new HttpError(403, 'cross-origin write refused');
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

const PANELS = ['usage', 'sessions', 'crons', 'plan', 'accountCredits', 'ingestCrons', 'ingestProjects', 'ingestCredits', 'board', 'health', 'toPush'];

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

// Acks (POST /api/acks) allowed in any one minute before a 429 (createHandler); an
// un-ack is never limited.
export const ACK_WRITES_PER_MINUTE = 10;

// The acks (lib/acks.mjs) when the server runs without a store: nothing is
// acknowledged, and a POST says so.
const NO_ACKS = { read: async () => [], add: null, remove: null };
// The waits (lib/needs-you.mjs) without a store: none, and the ingest says so.
const NO_NEEDS_YOU = { view: () => [], record: null };

// The ingest (README "What the ingest endpoints require"). What it takes becomes
// alerts, pushes and the approvals gate's inputs, so since 2026-11-12 it is served on
// a Unix socket of its own (lib/ingest-socket.mjs, createIngestHandler below), 0600 in
// the owner's 0700 folder: the file's mode keeps every other user out, whatever
// Tailscale Serve or any local forwarder does with the TCP port (Ultron's M1 on the
// loopback guard, 2026-11-11). The TCP port refuses every ingest post, except the
// needs-you route while `ingest.tcp` is "legacy" (the default until the owner's hooks
// have moved): that one keeps the loopback guard, and each post is reported to
// `onIngestTcp` (logged and alerted, lib/ingest-socket.mjs).
export const INGEST_ROUTES = new Set(['/api/ingest/needs-you', '/api/ingest/exact-command', '/api/ingest/crons', '/api/ingest/projects', '/api/ingest/credits']);
export const LEGACY_TCP_ROUTES = new Set(['/api/ingest/needs-you']);
export const INGEST_TCP_MODES = Object.freeze(['legacy', 'off']);

// config's `ingest` block: { tcp: "legacy" | "off" }. Absent means "legacy"; anything
// it can't read closes the TCP route and says why in a `config:` line.
export function readIngestConfig(config) {
  const raw = config?.ingest;
  if (raw === undefined || raw === null) return { tcp: 'legacy', problems: [] };
  if (!isObject(raw)) return { tcp: 'off', problems: ['ingest must be an object like {"tcp": "off"}; the TCP ingest stays closed'] };
  const tcp = raw.tcp === undefined ? 'legacy' : raw.tcp;
  if (!INGEST_TCP_MODES.includes(tcp)) return { tcp: 'off', problems: ['ingest.tcp must be "legacy" or "off"; the TCP ingest stays closed'] };
  return { tcp, problems: [] };
}

// Any error a handler meets, as an answer. It must never propagate out of the
// handler, where an unhandled rejection would take the process (and the whole
// in-memory cache) down with it.
const answerError = (res, path, err) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error('api error', path, err);
  if (status === 413 || err?.close) {
    // The client is still uploading; answer and hang up rather than
    // reading the rest of a body already refused.
    res.writeHead(status, { ...API_HEADERS, Connection: 'close' });
    return res.end(JSON.stringify({ error: String(err.message) }));
  }
  return json(res, status, { error: String(err?.message ?? err) });
};

// The ingest routes themselves, shared by the socket and the TCP route's transition.
// Answers and returns true for a POST to an ingest route; false for anything else.
// `onBlock` hears a classifier block from the needs-you ingest (lib/approvals.mjs), and
// `onExact` a Bash command's exact text from the exact-command ingest; it answers
// "kept", "other" (not the lead's session) or "off".
// `onMoved` hears each needs-you event that is neither a block nor refused
// (lib/answered-elsewhere.mjs closes the page's cards when the lead's session moved on).
function createIngestRoutes({ cache, needsYou = NO_NEEDS_YOU, log = console.log, onBlock = null, onExact = null, onMoved = null }) {
  return async function ingest(req, res, path) {
    if (req.method !== 'POST' || !INGEST_ROUTES.has(path)) return false;
    // A Claude Code hook posting that a session waits for a person, or moved on
    // (lib/needs-you.mjs). The body is the hook's own JSON, of which four fields are
    // read and the session's id is the only one kept (with the newest `at` per
    // session, to drop a post that arrives out of order).
    if (path === '/api/ingest/needs-you') {
      guardWrite(req);
      if (!needsYou.record) throw new HttpError(503, 'needs-you is not set up on this server');
      const checked = checkNeedsYou(await readBody(req));
      if (!checked.ok) throw new HttpError(400, checked.error);
      if (BLOCK_EVENTS.has(checked.value.event)) {
        // Log only, for the approvals gate: no wait opens or clears.
        // `true`: the Deny-only window opened; "parity": the lead's block, kept only as
        // the next card's reason for asking (lib/approvals.mjs, parity with the relay).
        const answer = onBlock ? onBlock(checked.value) : false;
        const took = answer === true;
        log(`needs-you: ${checked.value.event}${checked.value.tool ? ` (${checked.value.tool})` : ''}, ${took ? 'page approvals are Deny only for 15 minutes' : answer === 'parity' ? 'noted; no Deny-only window (approvals follow the relay)' : 'not the lead\'s session or approvals off, noted only'}`);
        json(res, 200, { ok: true, block: took });
        return true;
      }
      const { open, stale } = needsYou.record(checked.value, Date.now());
      log(needsYouLogLine(checked.value, open, stale));
      // A post that arrived out of order still says when its hook ran, which is all
      // the cards' close reads; a failure here never fails the hook's post.
      try { onMoved?.(checked.value); } catch (err) { log(`needs-you: the cards' close failed (${err?.code ?? err?.name ?? 'error'})`); }
      json(res, 200, stale ? { ok: true, open, stale: true } : { ok: true, open });
      return true;
    }

    // The report-only PermissionRequest hook (README "Approvals as buttons"): the exact
    // text of a Bash command the lead's session is about to ask about, for the
    // approvals gate to match to the relayed request (lib/exact-commands.mjs). The
    // command is kept in memory for two minutes when the gate wants it, and is never
    // logged: the log line says only what became of it.
    if (path === '/api/ingest/exact-command') {
      guardWrite(req);
      const checked = checkExactReport(await readBody(req, EXACT_MAX_BODY));
      if (!checked.ok) throw new HttpError(400, checked.error);
      let took = 'off';
      try { took = onExact ? onExact(checked.value) : 'off'; } catch { took = 'off'; }
      log(`exact-command: a Bash report, ${took === 'kept' ? 'from the lead\'s session, kept for 2 minutes' : took === 'other' ? 'not from the lead\'s session, dropped' : 'dropped (approvals for Bash are not in "exact" mode)'}`);
      json(res, 200, { ok: true, kept: took === 'kept' });
      return true;
    }

    const feed = path.slice('/api/ingest/'.length);
    guardWrite(req);
    const body = await readBody(req);
    const checked = validateIngest(feed, body);
    if (!checked.ok) throw new HttpError(400, checked.error);
    cache.set('ingest' + feed[0].toUpperCase() + feed.slice(1), checked.value);
    json(res, 200, { ok: true });
    return true;
  };
}

// The ingest socket's handler (lib/ingest-socket.mjs listens with it): the ingest
// routes and nothing else. No loopback guard: only a process running as the owner can
// open the socket, which is the whole check.
export function createIngestHandler(deps) {
  const ingest = createIngestRoutes(deps);
  return async function ingestHandler(req, res) {
    const path = new URL(req.url, 'http://unix').pathname;
    try {
      if (await ingest(req, res, path)) return;
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return answerError(res, path, err);
    }
  };
}

// `onIngestTcp(path, { taken, proxied })` hears each post to the needs-you route on
// the TCP port in the "legacy" transition: whether the loopback guard let it in, and
// whether it carried a header a proxy adds.
// `onAckNotice(notice, key)` hears the notice for each ack and renewal (lib/acks.mjs,
// ackNotice) with the alert's key, and pushes it through the notice limits
// (lib/ack-notice-limit.mjs, server.mjs); it is not awaited, so a slow push never holds
// the answer, and a failure is logged. `clock` is the write limit's time, for the tests.
// `loops()` is the heal runner's view (lib/heal-runner.mjs), read-only: GET /api/loops,
// and `loops` in /api/dashboard. Without it, both say the loops are not set up.
export function createHandler({ cache, todos, config, acks = NO_ACKS, needsYou = NO_NEEDS_YOU, log = console.log, onBlock = null, onExact = null, onMoved = null, onIngestTcp = null, onAckNotice = null, loops = null, clock = () => Date.now() }) {
  const loopsView = () => (loops ? loops() : { status: 'unset', why: 'this server has no heal runner', open: [], quiet: [], held: [], recent: [], weeks: [], generatedAt: Date.now() });
  const ingest = createIngestRoutes({ cache, needsYou, log, onBlock, onExact, onMoved });
  const ingestTcp = readIngestConfig(config).tcp;
  const panels = now => {
    const payload = {};
    for (const key of PANELS) payload[key] = cache.get(key, now);
    // The sessions waiting on a person (lib/needs-you.mjs): who, kind, since and a
    // key, nothing else. Built here, not cached, so a cleared wait goes at once.
    payload.needsYou = needsYou.view(now);
    return payload;
  };
  // The alerts as raised, before any acknowledgement, from the panels alone.
  const rawAlerts = now => buildAlerts(panels(now), config, now);
  // An ingest post on this port is refused before its body is read, and answered with
  // Connection: close (like a 413), so the unread body is never drained. Each route and
  // reason is logged once, the first 20, so a flood doesn't fill the log; the line
  // names a header, never its value.
  const refusedSeen = new Set();
  const refuse = (path, why, line, words) => {
    const key = `${path} ${why}`;
    if (!refusedSeen.has(key) && refusedSeen.size < 20) {
      refusedSeen.add(key);
      log(line);
    }
    const refused = new HttpError(403, words);
    refused.close = true;
    throw refused;
  };
  // The transition route takes posts from this machine only (lib/local-caller.mjs):
  // Serve puts this port on the tailnet. This guard holds only while Serve proxies at
  // the HTTP layer, which is why the socket replaces it.
  const guardLocal = (req, path) => {
    const why = localCaller(req);
    if (!why) return;
    refuse(path, why, `ingest: refused a post to ${path} that did not come from this machine (${why})`, 'the ingest takes posts from this machine only');
  };
  const SOCKET_ONLY = 'the ingest takes posts on its Unix socket only (README, "What the ingest endpoints require")';

  // A plain limit on acks (POST /api/acks), Ultron's 11-12 medium: at most
  // ACK_WRITES_PER_MINUTE in any minute, then a 429 with Retry-After and words the page
  // shows ("Couldn't save: …"). Counted after the origin guard and before the body is
  // read, refused ones included, so a loop of bad requests is held too. An un-ack
  // (DELETE) is never limited or counted (Ultron's 11-12 low): it only makes an alert
  // visible again, and a local loop must never stop the page from un-acking. The
  // notices have their own limits on top.
  const ackWrites = [];
  const ackWriteRefusal = () => {
    const now = clock();
    while (ackWrites.length && now - ackWrites[0] >= 60e3) ackWrites.shift();
    if (ackWrites.length >= ACK_WRITES_PER_MINUTE) {
      return Math.max(1, Math.ceil((ackWrites[0] + 60e3 - now) / 1000));
    }
    ackWrites.push(now);
    return 0;
  };
  // Logged at most once a minute, so a flood doesn't fill the log either.
  let ackRefusalLoggedAt = -Infinity;
  const tooManyAckWrites = (res, wait) => {
    const now = clock();
    if (now - ackRefusalLoggedAt >= 60e3) {
      ackRefusalLoggedAt = now;
      log(`ack: refusing acks, more than ${ACK_WRITES_PER_MINUTE} in a minute`);
    }
    return json(res, 429, { error: `too many acknowledgements this minute (at most ${ACK_WRITES_PER_MINUTE}); try again in ${wait} s` },
      { 'Retry-After': String(wait), Connection: 'close' });
  };

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      // The watchdog's self-check. Touches nothing but the listener itself:
      // the question it answers is "is anyone answering this port".
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

      if (req.method === 'GET' && path === '/api/dashboard') {
        const now = Date.now();
        let payload = panels(now);
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
        // An acknowledged alert (lib/acks.mjs) leaves `alerts` for `acked`, each
        // with its ack, and the covered cron, job and service entries gain `ack`.
        // Their verdicts don't change: `ok` stays false, `state` stays failed.
        const active = await acks.read(now);
        const { alerts, acked } = applyAcks(buildAlerts(payload, config, now), active, now);
        payload = decoratePayload(payload, acked, readRoster(config).jobs);
        payload.alerts = config.showAlertBanner ? alerts : [];
        payload.acked = config.showAlertBanner ? acked : [];
        payload.acks = active;
        payload.loops = loopsView();
        payload.serverTime = now;
        return json(res, 200, payload);
      }

      // The self-healing loops (docs/design/2026-11-12-self-healing-loops.md, §6): what
      // is open, quiet, held and recently closed. Read-only; names only, no labels.
      if (req.method === 'GET' && path === '/api/loops') return json(res, 200, loopsView(), { 'Cache-Control': 'no-store' });

      // Acknowledging a known miss (docs/design/2026-11-10-jarvis-os-home.md, §6).
      // Anyone who reaches the page may ack: the tailnet, which is the owner's own
      // devices, and a script on this machine. The board's guards, a 4 KB body, and
      // the key must name an alert raised NOW, so nothing can be acked in advance.
      if (path === '/api/acks') {
        if (req.method === 'GET') return json(res, 200, await acks.read(Date.now()));
        if (req.method === 'POST') {
          guardWrite(req);
          if (!acks.add) throw new HttpError(503, 'acknowledgements are not set up on this server');
          const wait = ackWriteRefusal();
          if (wait) return tooManyAckWrites(res, wait);
          // A browser sends Origin on every POST; a script on this machine sends none.
          const checked = checkAckRequest(await readBody(req, ACK_MAX_BODY), { fromPage: Boolean(req.headers?.origin) });
          if (!checked.ok) throw new HttpError(400, checked.error);
          const now = Date.now();
          const alert = rawAlerts(now).find(a => a.key === checked.value.key) ?? null;
          if (!alert) throw new HttpError(404, 'no such alert is raised now: only a live alert can be acknowledged');
          const made = makeAck(alert, checked.value, now);
          if (!made.ok) throw new HttpError(400, made.error);
          const list = await acks.add(made.value, now);
          // The entry as stored: addAck counts a renewal of the same failure.
          const stored = list.find(a => a.key === made.value.key) ?? made.value;
          log(ackLogLine(stored));
          if (onAckNotice) {
            Promise.resolve()
              .then(() => onAckNotice(ackNotice(stored, now), stored.key))
              .catch(err => log(`ack: the notice failed (${err?.code ?? err?.name ?? 'error'})`));
          }
          return json(res, 200, list);
        }
      }
      const unack = path.match(/^\/api\/acks\/(.+)$/);
      if (unack && req.method === 'DELETE') {
        guardDelete(req);
        if (!acks.remove) throw new HttpError(503, 'acknowledgements are not set up on this server');
        let key;
        try { key = decodeURIComponent(unack[1]); } catch { throw new HttpError(400, 'the key is not valid URL encoding'); }
        if (!isAckKey(key)) throw new HttpError(400, 'the key must be one line of at most 200 characters');
        const list = await acks.remove(key, Date.now());
        log(unackLogLine(key));
        return json(res, 200, list);
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

      // The ingest lives on its socket (createIngestHandler). Here, only the needs-you
      // route in the "legacy" transition, from this machine; every other ingest post is
      // refused unread, and a GET falls through to the 404.
      if (req.method === 'POST' && INGEST_ROUTES.has(path)) {
        if (ingestTcp === 'legacy' && LEGACY_TCP_ROUTES.has(path)) {
          // Every post here is reported, taken or refused, with whether it carried a
          // proxy header (lib/ingest-socket.mjs, createLegacyNotice; Ultron's 4-M2).
          const refusedWhy = localCaller(req);
          const proxied = PROXY_HEADERS.some(name => req.headers?.[name] !== undefined);
          try { onIngestTcp?.(path, { taken: refusedWhy === null, proxied }); } catch { /* a notice never fails the post */ }
          guardLocal(req, path);
          if (await ingest(req, res, path)) return;
        }
        refuse(path, 'socket only', `ingest: refused a post to ${path} on the TCP port (the ingest takes posts on its Unix socket only)`, SOCKET_ONLY);
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      // Anything that reaches here is a bug or a rejected request: either way it
      // answers with a status code (answerError).
      return answerError(res, path, err);
    }
  };
}
