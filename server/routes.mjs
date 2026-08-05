import { buildAlerts } from './lib/alerts.mjs';

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); }
    catch (err) { reject(err); }
  });
  req.on('error', reject);
});

const PANELS = ['usage', 'sessions', 'agents', 'crons', 'ingestCrons', 'ingestProjects', 'ingestCredits'];

export function createHandler({ cache, todos, config }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/dashboard') {
      const now = Date.now();
      const payload = {};
      for (const key of PANELS) payload[key] = cache.get(key, now);
      payload.config = { data: config, fetchedAt: now, status: 'ok', error: null };
      payload.alerts = config.showAlertBanner ? buildAlerts(payload, config, now) : [];
      payload.serverTime = now;
      return json(res, 200, payload);
    }

    if (path === '/api/todos') {
      if (req.method === 'GET') return json(res, 200, await todos.read());
      if (req.method === 'PUT') {
        try {
          return json(res, 200, await todos.write(await readBody(req)));
        } catch (err) {
          return json(res, 400, { error: String(err.message) });
        }
      }
    }

    const ingest = path.match(/^\/api\/ingest\/(crons|projects|credits)$/);
    if (ingest && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const key = 'ingest' + ingest[1][0].toUpperCase() + ingest[1].slice(1);
        cache.set(key, body);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    return json(res, 404, { error: 'not found' });
  };
}
