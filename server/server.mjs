import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createStaticHandler } from './lib/static.mjs';
import { createHistory, RETENTION_MS } from './history.mjs';
import { buildUsagePanel } from './lib/usage-panel.mjs';
import { createCache } from './cache.mjs';
import { createRegistry } from './collectors/registry.mjs';
import { collectUsage } from './collectors/usage.mjs';
import { collectAgents } from './collectors/agents.mjs';
import { collectPlan } from './collectors/plan.mjs';
import { collectSessions } from './collectors/sessions.mjs';
import { collectCrons } from './collectors/crons.mjs';
import { runNotifier } from './collectors/notifier.mjs';
import { getTopic, publish } from './notify.mjs';
import { createTodoStore } from './todos.mjs';
import { loadConfig } from './lib/config.mjs';
import { createHandler } from './routes.mjs';
import { aggregate } from './lib/aggregate.mjs';
import { buildProjects, agentsReadable } from './lib/projects.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8322);
const WEB_DIR = join(HERE, '..', 'web', 'dist');

const config = await loadConfig(join(HERE, 'config.json'));
const cache = createCache();
const todos = createTodoStore(join(HERE, 'todos.json'));
const registry = createRegistry(cache);

const history = createHistory({ dir: join(HERE, 'data') });
await history.warm();

registry.register('usage', async () => {
  const parsed = await collectUsage({ history });
  const now = Date.now();
  // RETENTION_MS, not a local 30 days: the store's in-memory window, the span
  // asked for here and the sparkline range in usage-panel.mjs are one setting.
  return buildUsagePanel({
    parsed,
    records: history.recent(now - RETENTION_MS),
    now,
    historyStatus: history.status()
  });
}, 5 * 60 * 1000);
registry.register('agents', () => collectAgents(), 30 * 1000);
registry.register('crons', () => collectCrons(), 60 * 1000);
// The subscription tier changes rarely — hourly is plenty, and it keeps
// `claude auth status` off the CLI's back next to the 30s agents poll.
registry.register('plan', () => collectPlan(), 60 * 60 * 1000);
registry.register('sessions', async () => {
  const { transcripts, coworkSessions, unavailableRoots, unreadablePaths } = await collectSessions();
  const now = Date.now();
  // `?? []` collapsed "the agents source is unreadable" into "no agent is
  // running", which made every project read Idle as a statement of fact while
  // the header still said ok. Pass the distinction through instead.
  const agentsEnvelope = cache.get('agents', now);
  return {
    ...aggregate(transcripts, now),
    unavailableRoots,
    unreadablePaths,
    projects: buildProjects({
      agents: agentsEnvelope.data ?? [],
      agentsAvailable: agentsReadable(agentsEnvelope),
      coworkSessions,
      transcripts
    }, now)
  };
}, 60 * 1000);

const SENT_PATH = join(HERE, 'data', 'notified.json');
const readSent = async () => {
  try { return JSON.parse(await readFile(SENT_PATH, 'utf8')); } catch { return {}; }
};
const writeSent = async next => {
  await mkdir(dirname(SENT_PATH), { recursive: true });
  await writeFile(SENT_PATH, JSON.stringify(next, null, 2));
};

registry.register('notifier', async () => {
  const topic = await getTopic();
  // Not configured is a normal state — the dashboard works without it.
  if (!topic) return { configured: false, sent: 0 };
  const now = Date.now();
  const out = await runNotifier({
    snapshot: cache.snapshot(now),
    config,
    now,
    readSent,
    writeSent,
    send: entry => publish({ topic, title: entry.title, message: entry.message })
  });
  return { configured: true, ...out };
}, 5 * 60 * 1000);

const api = createHandler({ cache, todos, config });
const serveStatic = createStaticHandler(WEB_DIR);

// A rejection nobody catches used to take the whole process down; launchd then
// restarted it with an empty cache, so every panel dropped to unavailable and
// usage stayed blank for up to five minutes. Log and keep serving.
process.on('unhandledRejection', err => {
  console.error('unhandled rejection (ignored, process kept alive)', err);
});

createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await api(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    console.error('request failed', req.method, req.url, err);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
}).listen(PORT, '127.0.0.1', () => {
  registry.startAll();
  console.log(`control room on http://127.0.0.1:${PORT}`);
});
