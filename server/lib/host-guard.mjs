// The Host allowlist (the 2026-11-10 security review): every request, before any
// route, must name this server by a host it answers to. Without it, DNS rebinding
// passes the origin check on every write: a page on an attacker's domain whose name
// is re-pointed at 127.0.0.1 sends `Origin: http://attacker.example` with
// `Host: attacker.example:8322`, and the two match. The server binds loopback, so a
// real request names `127.0.0.1:<port>` or `localhost:<port>` (curl, the watchdog, a
// script), or the Tailscale Serve name, which the proxy passes through unchanged.
// That name lives in config.json (`allowedHosts`), never in the repo.
//
// `allowedHosts` is a list of host names, each with or without a port. A name
// given without one also matches the ports a browser leaves out (80 and 443).
// `hostCheck` says what happens to a Host that isn't listed: `"log"` (the default)
// logs it and lets the request through, so the list can be proven against a day of
// real traffic first (what Host the Serve proxy passes is read from the log, not
// assumed); `"enforce"` refuses it with 421. Any other value is a config problem
// and enforces: a typo in the setting must never leave the check off.

const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/i;
const HOST_PORT = /^(.*?)(?::(\d{1,5}))?$/;
const MAX_LOGGED = 20;
export const HOST_CHECK_MODES = ['log', 'enforce'];

// What the config says, checked: the names that pass, the mode, and the problems
// to log once. An unknown mode enforces, never the looser default.
export function readAllowedHosts(config) {
  const problems = [];
  const names = [];
  let mode = 'log';
  const rawMode = config?.hostCheck;
  if (rawMode !== undefined) {
    if (HOST_CHECK_MODES.includes(rawMode)) mode = rawMode;
    else {
      mode = 'enforce';
      problems.push(`hostCheck must be one of ${HOST_CHECK_MODES.join(', ')}; an unknown value enforces`);
    }
  }
  const raw = config?.allowedHosts;
  if (raw === undefined) return { names, mode, problems };
  if (!Array.isArray(raw)) {
    problems.push('allowedHosts is not a list');
    return { names, mode, problems };
  }
  raw.forEach((v, i) => {
    const m = typeof v === 'string' ? HOST_PORT.exec(v.trim().toLowerCase()) : null;
    const name = m?.[1] ?? '';
    const port = m?.[2];
    if (!m || !HOST_NAME.test(name) || name.length > 253 || (port !== undefined && Number(port) > 65535)) {
      problems.push(`allowedHosts[${i}] is not a host name (with an optional port)`);
      return;
    }
    names.push(port === undefined ? name : `${name}:${port}`);
  });
  return { names, mode, problems };
}

// The exact Host values this server answers to: loopback on its own port, plus
// each configured name as given, and the browser's bare form of a name given
// without a port (its port 80 and 443 spellings too).
export function allowedHostSet(port, names = []) {
  const out = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  for (const n of names) {
    out.add(n);
    if (!/:\d+$/.test(n)) {
      out.add(`${n}:80`);
      out.add(`${n}:443`);
    }
  }
  return out;
}

// Whether a request's Host header is one of ours. Case doesn't matter in a host
// name; nothing else is normalised, so an odd spelling is simply not ours.
export const hostAllowed = (header, allowed) =>
  typeof header === 'string' && header !== '' && allowed.has(header.trim().toLowerCase());

// A Host value fit for the service log: printable ASCII, cut short. It is the
// client's own text, so it is quoted, never trusted.
const forLog = header => JSON.stringify(String(header ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 80));

// The handler wrapped: a request with a Host that isn't ours is logged, and in
// enforce mode gets 421 and goes no further. Each unlisted Host is logged once,
// the first 20 distinct ones, so a missing config entry (the Serve name) is found
// in the log, and a flood isn't.
export function withHostGuard(handler, allowed, { mode = 'log', log = console.error } = {}) {
  const seen = new Set();
  const enforce = mode === 'enforce';
  return function guarded(req, res) {
    const host = req.headers?.host;
    if (hostAllowed(host, allowed)) return handler(req, res);
    const key = String(host ?? '').slice(0, 80);
    if (!seen.has(key) && seen.size < MAX_LOGGED) {
      seen.add(key);
      const what = host === undefined ? 'no Host' : forLog(host);
      log(enforce
        ? `host: refused a request for ${what}; allowedHosts in config.json names what this server answers to`
        : `host: a request for ${what} is not in allowedHosts (let through: hostCheck is "log")`);
    }
    if (!enforce) return handler(req, res);
    res.writeHead(421, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    res.end(JSON.stringify({ error: 'this server does not answer to that Host' }));
    return undefined;
  };
}
