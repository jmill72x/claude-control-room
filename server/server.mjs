import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createStaticHandler } from './lib/static.mjs';
import { createAvatarHandler } from './lib/avatars.mjs';
import { readRoster } from './lib/roster.mjs';
import { createHistory, RETENTION_MS } from './history.mjs';
import { buildUsagePanel } from './lib/usage-panel.mjs';
import { createCache } from './cache.mjs';
import { createRegistry } from './collectors/registry.mjs';
import { collectUsage } from './collectors/usage.mjs';
import { collectPlan, PLAN_INTERVAL_MS } from './collectors/plan.mjs';
import { collectSessions } from './collectors/sessions.mjs';
import { collectCrons } from './collectors/crons.mjs';
import { createHealth } from './collectors/health.mjs';
import { readHealthConfig } from './lib/health.mjs';
import { createToPush } from './collectors/to-push.mjs';
import { readToPushConfig } from './lib/to-push.mjs';
import { vetPrograms } from './lib/program-check.mjs';
import { collectAccountCredits } from './collectors/account-credits.mjs';
import { runNotifier } from './collectors/notifier.mjs';
import { getTopic, sendAlert } from './notify.mjs';
import { createTodoStore } from './todos.mjs';
import { createAckStore } from './acks.mjs';
import { loadConfig } from './lib/config.mjs';
import { createHandler, BOARD_MAX_BODY } from './routes.mjs';
import { createWatchdog } from './lib/watchdog.mjs';
import { readAllowedHosts, allowedHostSet, withHostGuard } from './lib/host-guard.mjs';
import { get } from 'node:http';
import { aggregate } from './lib/aggregate.mjs';
import { buildHourly } from './lib/hourly.mjs';
import { buildAgentWork } from './lib/agent-work.mjs';
import { buildProjects } from './lib/projects.mjs';
import { installLogStamps } from './lib/log-stamp.mjs';

// Before anything logs, so every line in the service log carries its time.
installLogStamps();
// When this run of the server began, for the Control Room chip on the health strip.
const STARTED_AT = Date.now();

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8322);
const WEB_DIR = join(HERE, '..', 'web', 'dist');

const config = await loadConfig(join(HERE, 'config.json'));
// The agents' names, the avatar folder and the job names (lib/roster.mjs). A bad
// entry is left out; say which, once, so a typo in config.json doesn't just vanish.
const roster = readRoster(config);
for (const problem of roster.problems) console.error(`config: ${problem}`);
// The health strip's job-status path, services and the Pi watch's files
// (lib/health.mjs), checked the same way.
const healthSettings = readHealthConfig(config);
for (const problem of healthSettings.problems) console.error(`config: ${problem}`);
// The To push tile's git-read path and repos (lib/to-push.mjs), checked the same way.
const toPushSettings = readToPushConfig(config, roster.agents.map(a => a.key));
for (const problem of toPushSettings.problems) console.error(`config: ${problem}`);
// The Host allowlist (lib/host-guard.mjs): loopback on this port, plus the names in
// config's `allowedHosts` (the Tailscale Serve name). `hostCheck` is "log" until a
// day of logs shows the list is right, then "enforce".
const hosts = readAllowedHosts(config);
for (const problem of hosts.problems) console.error(`config: ${problem}`);
if (hosts.names.length === 0) console.error('config: allowedHosts names no host, so only 127.0.0.1 and localhost on this port pass the Host check');
// job-status and git-read run on a timer, so each must be a program only this user
// can change (lib/program-check.mjs). One that isn't is left out like a bad entry,
// and that feature reads "not set up" until it is fixed and the service restarts.
const programProblems = await vetPrograms([
  ['health.jobStatus', healthSettings, 'jobStatus'],
  ['toPush.gitRead', toPushSettings, 'gitRead']
]);
for (const problem of programProblems) console.error(`config: ${problem}`);
const cache = createCache();
const todos = createTodoStore(join(HERE, 'todos.json'));
// Acknowledged alerts (lib/acks.mjs), beside notified.json; gitignored with it.
const ackStore = createAckStore(join(HERE, 'data', 'acks.json'));
const registry = createRegistry(cache);

const history = createHistory({ dir: join(HERE, 'data') });
await history.warm();

// Every five minutes: the usage bars track a five-hour window, so an hourly
// poll was tried and rejected (2026-10-30). The pace code and the credits
// cache's 30-minute limit are both built on this cadence.
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
// The health strip (collectors/health.mjs): job-status every minute, whose
// verdicts the crons panel then takes over launchd's own, so the morning brief,
// the page, the mod and the alerts agree on every job.
const health = createHealth({ settings: healthSettings, jobNames: roster.jobs, cache, startedAt: STARTED_AT });
registry.register('crons', async () => health.overlay(await collectCrons()), 60 * 1000);
registry.register('health', () => health.collect(), 60 * 1000);
// Waiting on you's To push tile (collectors/to-push.mjs): git-read on each repo
// in config, one after another, every 5 minutes. Counts and branch names only.
const toPush = createToPush({ settings: toPushSettings });
registry.register('toPush', () => toPush.collect(), 5 * 60 * 1000);
// Credits come from the CLI's cached usage response, which the usage collector's
// own `/usage` poll refreshes every five minutes. Reading a local file is cheap,
// so poll it every minute; the parser refuses a cache older than 30 minutes.
registry.register('accountCredits', () => collectAccountCredits(), 60 * 1000);
// The subscription tier changes rarely, and the CLI itself lags a plan change by
// days, so once a day (and once at start) is plenty. Each run is a short-lived
// `claude` that loads the shared sign-in (README, "How often the server starts
// claude"); nothing else reads this panel on a clock.
registry.register('plan', () => collectPlan(), PLAN_INTERVAL_MS);
// Kept from pass to pass, so each minute reads only the transcripts that changed.
const transcriptCache = new Map();
registry.register('sessions', async () => {
  const { transcripts, coworkSessions, unavailableRoots, unreadablePaths, sessionNames } = await collectSessions({ cache: transcriptCache });
  const now = Date.now();
  return {
    ...aggregate(transcripts, now),
    // Burn and the week's heat map on the Orbit page (lib/hourly.mjs).
    hourly: buildHourly(transcripts, now),
    // The agent views on the Orbit page (lib/agent-work.mjs). The schedules name
    // a routine's runs; before the first crons pass they are not read yet, and
    // those runs go unnamed for that minute.
    agentWork: buildAgentWork({ transcripts, sessionNames, roster, crons: cache.get('crons', now).data, now }),
    unavailableRoots,
    unreadablePaths,
    projects: buildProjects({
      coworkSessions,
      transcripts
    }, now)
  };
}, 60 * 1000);

// The board's size against its PUT cap (routes.mjs), so an alert warns at 75%
// while there is still room to archive the done lane. A stat, nothing more.
registry.register('board', async () => ({ bytes: await todos.size(), cap: BOARD_MAX_BODY }), 60 * 1000);

const SENT_PATH = join(HERE, 'data', 'notified.json');
const readSent = async () => {
  try { return JSON.parse(await readFile(SENT_PATH, 'utf8')); } catch { return {}; }
};
const writeSent = async next => {
  await mkdir(dirname(SENT_PATH), { recursive: true });
  await writeFile(SENT_PATH, JSON.stringify(next, null, 2));
};

registry.register('notifier', async () => {
  // No ntfy topic is a normal state, and no longer a reason to skip the run:
  // every alert also goes to #pepper, which needs no topic, and publish() turns
  // a missing one into a not-sent result. `configured` still means ntfy's topic.
  const topic = await getTopic();
  const now = Date.now();
  const out = await runNotifier({
    snapshot: cache.snapshot(now),
    config,
    now,
    readSent,
    writeSent,
    acks: await ackStore.read(now),
    send: entry => sendAlert({ topic, title: entry.title, message: entry.message })
  });
  return { configured: Boolean(topic), ...out };
}, 5 * 60 * 1000);

const api = createHandler({ cache, todos, config, acks: ackStore });
const serveStatic = createStaticHandler(WEB_DIR);
const serveAvatar = createAvatarHandler({ dir: roster.avatarDir, keys: roster.agents.map(a => a.key) });

// A rejection nobody catches used to take the whole process down; launchd then
// restarted it with an empty cache, so every panel dropped to unavailable and
// usage stayed blank for up to five minutes. Log and keep serving.
process.on('unhandledRejection', err => {
  console.error('unhandled rejection (ignored, process kept alive)', err);
});

// The Host check comes first, before any route, API or page alike.
const routes = withHostGuard(async (req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  if (req.url.startsWith('/avatars/')) return serveAvatar(req, res);
  return serveStatic(req, res);
}, allowedHostSet(PORT, hosts.names), { mode: hosts.mode });

const server = createServer(async (req, res) => {
  try {
    await routes(req, res);
  } catch (err) {
    console.error('request failed', req.method, req.url, err);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

const selfCheck = () => new Promise((resolve, reject) => {
  const req = get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 5000, agent: false }, res => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', reject);
});

// Exit, don't limp: launchd's KeepAlive restarts an exited process within
// seconds, which is the whole recovery. Exiting is also the only way the
// failure reaches the log at all — the deaf state on 2026-10-02 wrote nothing.
const watchdog = createWatchdog({
  probe: selfCheck,
  onDead: reason => {
    console.error(`watchdog: ${reason}; exiting so launchd restarts the service`);
    process.exit(1);
  }
});

server.on('close', () => {
  console.error('watchdog: HTTP listener closed; exiting so launchd restarts the service');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  registry.startAll();
  setInterval(() => watchdog.tick(), 60 * 1000).unref();
  console.log(`control room on http://127.0.0.1:${PORT}`);
});
