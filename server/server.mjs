import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCache } from './cache.mjs';
import { createRegistry } from './collectors/registry.mjs';
import { collectUsage } from './collectors/usage.mjs';
import { collectAgents } from './collectors/agents.mjs';
import { collectSessions } from './collectors/sessions.mjs';
import { collectCrons } from './collectors/crons.mjs';
import { createTodoStore } from './todos.mjs';
import { loadConfig } from './lib/config.mjs';
import { createHandler } from './routes.mjs';
import { aggregate } from './lib/aggregate.mjs';
import { buildProjects } from './lib/projects.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8322);
const WEB_DIR = join(HERE, '..', 'web', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const config = await loadConfig(join(HERE, 'config.json'));
const cache = createCache();
const todos = createTodoStore(join(HERE, 'todos.json'));
const registry = createRegistry(cache);

registry.register('usage', () => collectUsage(), 5 * 60 * 1000);
registry.register('agents', () => collectAgents(), 30 * 1000);
registry.register('crons', () => collectCrons(), 60 * 1000);
registry.register('sessions', async () => {
  const { transcripts, coworkSessions } = await collectSessions();
  const now = Date.now();
  return {
    ...aggregate(transcripts, now),
    projects: buildProjects({
      agents: cache.get('agents', now).data ?? [],
      coworkSessions,
      transcripts
    }, now)
  };
}, 60 * 1000);

const api = createHandler({ cache, todos, config });

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  try {
    const rel = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
    const body = await readFile(join(WEB_DIR, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(await readFile(join(WEB_DIR, 'index.html')));
    } catch {
      res.writeHead(404); res.end('not built');
    }
  }
}).listen(PORT, '127.0.0.1', () => {
  registry.startAll();
  console.log(`control room on http://127.0.0.1:${PORT}`);
});
