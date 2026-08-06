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
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('forbidden');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(body);
    } catch {
      // Single-page app: an unknown path is a client route, not a missing file.
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(await readFile(indexPath));
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not built');
      }
    }
  };
}
