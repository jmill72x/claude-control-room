import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// What the pages may load (the 2026-10-21 security review, before Orbit Phase 5):
// this server's own files and API and nothing else, no plugins, no <base> to re-point
// relative links, no page of another site framing them, and no form submitted
// anywhere (default-src doesn't cover forms). The build needs nothing looser: it has
// no inline <script>, <style> or style="" (React's style props go through the CSSOM,
// which a policy doesn't block), no data: or blob: URL and no eval, it fetches only
// /api/, and its one form (the Board's New item) is handled in the page, which stops
// the browser's own submit. nosniff makes the browser keep to the Content-Type, so
// nothing runs as a script or applies as a style unless it was sent as one. Both go
// with every answer below: the pages, their assets, the fallback and the refusals.
export const CONTENT_SECURITY_POLICY = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export const PAGE_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff'
});

// `join(WEB_DIR, req.url.slice(1))` served any file the service user could read:
// `curl --path-as-is 'http://127.0.0.1:8322/../../server/config.json'` returned it,
// as did /etc/passwd and dotfiles in the home directory. Browsers collapse `..`
// before sending, which is exactly why this was invisible in normal use — every
// non-browser client (curl, a script, anything on the tunnel) does not.
//
// The check is on the RESOLVED path, not the raw URL: a string test for '..' is
// defeated by encodings, and a bare `startsWith(root)` is defeated by a sibling
// directory whose name merely begins with the root's ('/web/dist-old').
export function resolveStaticPath(webDir, url) {
  const root = resolve(webDir);
  const raw = String(url ?? '').split('?')[0].split('#')[0];

  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded.includes('\0')) return null;

  const rel = decoded.replace(/^\/+/, '');
  const full = resolve(root, rel === '' ? 'index.html' : rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function createStaticHandler(webDir) {
  const indexPath = resolve(webDir, 'index.html');

  return async function serveStatic(req, res) {
    const file = resolveStaticPath(webDir, req.url);
    if (file === null) {
      res.writeHead(403, { 'Content-Type': 'text/plain', ...PAGE_HEADERS });
      return res.end('forbidden');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...PAGE_HEADERS });
      return res.end(body);
    } catch {
      // Single-page app: an unknown path is a client route, not a missing file.
      // The page is read before any header goes out: headers go once, so with no
      // build a 200 written first turned the 404 below into an empty page.
      let shell;
      try {
        shell = await readFile(indexPath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...PAGE_HEADERS });
        return res.end('not built');
      }
      res.writeHead(200, { 'Content-Type': 'text/html', ...PAGE_HEADERS });
      return res.end(shell);
    }
  };
}
