import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { AGENT_KEY } from './roster.mjs';

// /avatars/<key>.png: the agents' pictures for the Orbit page, read from the one
// folder config.json names (roster.avatarDir). The folder stays out of this
// public repo, and its path never reaches the page.
//
// What the route can read, and nothing else:
//   - the name comes from the raw request path, never decoded, so an escape such
//     as %2e%2e or %2f can't match, and it must be on the roster as well as match
//     the agent-key pattern; the file read is <folder>/<key>.png;
//   - the open refuses a symlink (O_NOFOLLOW) and can't wait on a FIFO
//     (O_NONBLOCK); only a regular file of at most 2 MB that starts with the PNG
//     signature is sent.
// Everything else is a 404 that says nothing about why.
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ROUTE = /^\/avatars\/([a-z0-9-]{1,40})\.png$/;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function createAvatarHandler({ dir = null, keys = [] } = {}) {
  const home = typeof dir === 'string' && isAbsolute(dir) ? dir : null;
  const allowed = new Set(keys.filter(k => typeof k === 'string' && AGENT_KEY.test(k)));

  return async function serveAvatar(req, res) {
    const refuse = (status, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
      res.end(status === 405 ? 'method not allowed' : 'not found');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, { Allow: 'GET, HEAD' });
    const match = ROUTE.exec(String(req.url ?? '').split('?')[0]);
    const key = match?.[1];
    if (!home || !key || !AGENT_KEY.test(key) || !allowed.has(key)) return refuse(404);

    let file;
    try {
      file = await open(join(home, `${key}.png`), FLAGS);
      const info = await file.stat();
      if (!info.isFile() || info.size < PNG_SIGNATURE.length || info.size > MAX_AVATAR_BYTES) return refuse(404);
      const body = await file.readFile();
      if (body.length > MAX_AVATAR_BYTES || !body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return refuse(404);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': body.length,
        'Cache-Control': 'max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return refuse(404);
    } finally {
      await file?.close().catch(() => {});
    }
  };
}
