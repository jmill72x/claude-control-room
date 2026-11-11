// Whether a request came from a program on this machine, not through a proxy (the
// 2026-11-11 review, H1). The server binds 127.0.0.1, but Tailscale Serve, also on
// this machine, passes the tailnet's requests to that same port, so the socket's
// address alone says nothing: every request through Serve arrives from 127.0.0.1.
// What Serve does that a local program doesn't: it sets X-Forwarded-For,
// X-Forwarded-Host and (over HTTPS) X-Forwarded-Proto on every request it passes on,
// and adds Tailscale-User-Login, -Name and -Profile-Pic for a device a person owns
// (after dropping any the client sent). The proxy headers are the layer that holds
// against Serve: Serve passes on whatever Host the client sent, so a tailnet client
// can send `Host: 127.0.0.1:8322`. The Host check is there for DNS rebinding (a page
// on another domain re-pointed at 127.0.0.1 names its own host). So a local caller
// is one that:
//
//   - arrived on a loopback socket (127.0.0.1, or ::1),
//   - names a loopback Host (127.0.0.1, localhost or [::1], any port), and
//   - carries none of the headers a proxy adds (PROXY_HEADERS), not even empty.
//
// The ingest routes (/api/ingest/*) take posts from local callers only: what they
// accept becomes alerts and pushes, and every real poster runs on this machine (the
// Claude Code hook and curl, README "What the ingest endpoints require"). A program
// on this machine can still post, which is the same trust as the files the
// collectors read.

export const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-funnel-request',
  'tailscale-headers-info',
  'via'
];

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

// null when the request is local; otherwise why not, in fixed words that name a
// header but never repeat what it held.
export function localCaller(req) {
  const headers = req?.headers ?? {};
  for (const name of PROXY_HEADERS) {
    if (headers[name] !== undefined) return `it came through a proxy (${name})`;
  }
  if (!LOOPBACK_ADDRESSES.has(req?.socket?.remoteAddress)) return 'its address is not loopback';
  const host = headers.host;
  if (typeof host !== 'string' || !LOOPBACK_HOST.test(host.trim())) return 'its host is not loopback';
  return null;
}
