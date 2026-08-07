import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from './lib/static.mjs';
import { createHistory } from './history.mjs';
import { inferWindowMs, computePace, WEEKLY_FALLBACK_MS } from './lib/pace.mjs';
import { createCache } from './cache.mjs';
import { createRegistry } from './collectors/registry.mjs';
import { collectUsage } from './collectors/usage.mjs';
import { collectAgents } from './collectors/agents.mjs';
import { collectPlan } from './collectors/plan.mjs';
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

const config = await loadConfig(join(HERE, 'config.json'));
const cache = createCache();
const todos = createTodoStore(join(HERE, 'todos.json'));
const registry = createRegistry(cache);

const HOUR = 3600000, DAY = 24 * HOUR;
const history = createHistory({ dir: join(HERE, 'data') });
await history.warm();

// Percentages reset to zero each window, so one range for every bar would render
// the session limit as ~144 sawtooth spikes across a month. Each sparkline spans
// its own limit's natural period instead.
const seriesRangeMs = label => (label === 'Current session' ? DAY : 30 * DAY);

registry.register('usage', async () => {
  const parsed = await collectUsage({ history });
  const now = Date.now();
  const records = history.recent(now - 30 * DAY);

  const limits = parsed.limits.map(limit => {
    const observed = inferWindowMs(records, limit.label);
    const windowMs = observed ?? (limit.label.startsWith('Weekly') ? WEEKLY_FALLBACK_MS : null);
    const since = now - seriesRangeMs(limit.label);
    const series = records
      .filter(r => r.t >= since)
      .map(r => ({ t: r.t, pct: r.limits.find(l => l.label === limit.label)?.pct }))
      .filter(p => Number.isFinite(p.pct));
    return {
      ...limit,
      pace: computePace({ pct: limit.pct, resetsAt: limit.resetsAt, windowMs, now }),
      series
    };
  });

  return { ...parsed, limits };
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
      agentsAvailable: agentsEnvelope.status !== 'unavailable',
      coworkSessions,
      transcripts
    }, now)
  };
}, 60 * 1000);

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
