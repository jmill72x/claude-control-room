import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createStaticHandler, setBaseHeaders } from './lib/static.mjs';
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
import { createHealth, JOB_STATUS_TIMEOUT_MS, runLaunchctlPrint } from './collectors/health.mjs';
import { readHealConfig } from './lib/heal.mjs';
import { createHealLedger } from './lib/heal-ledger.mjs';
import { createHealRunner } from './lib/heal-runner.mjs';
import { matchingAck } from './lib/acks.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readHealthConfig } from './lib/health.mjs';
import { createToPush } from './collectors/to-push.mjs';
import { readToPushConfig } from './lib/to-push.mjs';
import { vetPrograms } from './lib/program-check.mjs';
import { collectAccountCredits } from './collectors/account-credits.mjs';
import { runNotifier } from './collectors/notifier.mjs';
import { getTopic, sendAlert, sendAckPepper, sendAckNtfy } from './notify.mjs';
import { createChatEventHandler, NTFY_WORDS } from './lib/chat-events.mjs';
import { createAnsweredElsewhere } from './lib/answered-elsewhere.mjs';
import { createAckNotices } from './lib/ack-notice-limit.mjs';
import { createTodoStore } from './todos.mjs';
import { createAckStore } from './acks.mjs';
import { loadConfig } from './lib/config.mjs';
import { createHandler, createIngestHandler, readIngestConfig, BOARD_MAX_BODY } from './routes.mjs';
import { startIngestSocket, createLegacyNotice } from './lib/ingest-socket.mjs';
import { createWatchdog } from './lib/watchdog.mjs';
import { readAllowedHosts, allowedHostSet, withHostGuard } from './lib/host-guard.mjs';
import { createNeedsYouStore } from './lib/needs-you.mjs';
import { createChatStore, ATTACHMENT_MAX_BYTES } from './lib/chat-store.mjs';
import { createDeviceStore } from './lib/chat-devices.mjs';
import { createSocketRouter } from './lib/chat-socket.mjs';
import { createChatRoutes, createAdminRouter, readChatConfig } from './lib/chat-routes.mjs';
import { prepareSocketPath } from './lib/chat-listen.mjs';
import { createEvents, readEventsConfig } from './lib/events.mjs';
import { createEventSocketRouter } from './lib/event-socket.mjs';
import { createChannelVerifier, readChannelServer } from './lib/chat-verify.mjs';
import { createPushService, loadVapid } from './lib/chat-push.mjs';
import { parityStartLine, createApprovals, readApprovalsConfig } from './lib/approvals.mjs';
import { createFeedReader, readFeedConfig } from './lib/feed.mjs';
import { createFeedRoutes } from './lib/feed-routes.mjs';
import { createShortcutKeys } from './lib/shortcut-keys.mjs';
import { createShortcutRoutes, createShortcutAdminRouter, readShortcutsConfig } from './lib/shortcut-routes.mjs';
import { createHeicConverter, SIPS } from './lib/heic-convert.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chmod } from 'node:fs/promises';
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
// The self-healing loops (lib/heal-runner.mjs; docs/design/2026-11-12-self-healing-loops.md):
// loop 1 marks a job quiet when job-status calls it overdue for its log's age alone and
// launchd's run counter shows it ran clean. Off unless config's `heal.enabled` is true;
// the kill switch is the file `heal-off` beside the chat's sockets (no restart needed).
// Its only launchd call is `launchctl print`, the same read-only call the health strip makes.
const healSettings = readHealConfig(config);
for (const problem of healSettings.problems) console.error(`config: ${problem}`);
const healOffPath = join(homedir(), '.local', 'state', 'jarvis-os', 'heal-off');
const heal = createHealRunner({
  settings: healSettings,
  ledger: createHealLedger({ path: join(HERE, 'data', 'heals.json') }),
  launchctlPrint: runLaunchctlPrint,
  killed: () => existsSync(healOffPath),
  jobNames: roster.jobs
});
await heal.load();
if (heal.catalogProblem()) console.error(`heal: the catalog was refused (${heal.catalogProblem()}); heals stay off`);
{
  const { status, why } = heal.status();
  console.log(`heal: ${status}${why ? ` (${why})` : ''}, ${healSettings.targets.size} target${healSettings.targets.size === 1 ? '' : 's'}`);
}
const health = createHealth({ settings: healthSettings, jobNames: roster.jobs, cache, startedAt: STARTED_AT, quietOf: (label, since) => heal.quietOf(label, since) });
// The first crons pass waits for job-status's first answer (whenAsked), or its
// overlay misses the times an ack is matched by; the timeout is job-status's own.
// Then the heal runner sees the overlaid panel (an acked instance opens no loop).
registry.register('crons', async () => {
  const crons = await collectCrons();
  await Promise.race([health.whenAsked(), delay(JOB_STATUS_TIMEOUT_MS + 5e3, null, { ref: false })]);
  const overlaid = health.overlay(crons);
  const now = Date.now();
  let acks = [];
  try { acks = await ackStore.read(now); } catch { acks = []; }
  // A fault in the runner never costs the crons panel: the panel goes out as overlaid.
  try {
    return await heal.pass(overlaid, {
      acked: c => Boolean(matchingAck({ kind: 'cron', key: `cron:launchd:${c.label}`, since: c.lastRunAt }, acks, now))
    });
  } catch (err) {
    console.error(`heal: the pass failed (${err?.message ?? err})`);
    return overlaid;
  }
}, 60 * 1000);
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
// Which roster agent each top-level session is, by its id: the session named for
// the lead (`agent-name`), or a `--agent` run (`agent-setting`). For the waits
// (lib/needs-you.mjs), whose hook names a session, never an agent.
const sessionAgents = new Map();
const rosterName = word => {
  const w = String(word ?? '').trim().toLowerCase();
  return roster.agents.find(a => a.key.toLowerCase() === w || a.name.toLowerCase() === w)?.name ?? null;
};
const needsYou = createNeedsYouStore({ whoFor: id => sessionAgents.get(id) ?? null });
registry.register('sessions', async () => {
  const { transcripts, coworkSessions, unavailableRoots, unreadablePaths, sessionNames } = await collectSessions({ cache: transcriptCache });
  const now = Date.now();
  sessionAgents.clear();
  for (const t of transcripts) {
    if (t.subagent || !t.sessionId) continue;
    const name = rosterName(t.agentName) ?? rosterName(t.agentSetting);
    if (name) sessionAgents.set(t.sessionId, name);
  }
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

// Events (lib/events.mjs): made from the notifier's alerts after acks, once the chat
// is on (below). Until then, and with the chat off, the hook is absent.
let events = null;
const eventsSettings = readEventsConfig(config);
for (const problem of eventsSettings.problems) console.error(`config: ${problem}`);
const serviceNames = new Set(healthSettings.services.map(s => s.name));

registry.register('notifier', async () => {
  // No ntfy topic is a normal state, and no longer a reason to skip the run:
  // every alert also goes to #pepper, which needs no topic, and publish() turns
  // a missing one into a not-sent result. `configured` still means ntfy's topic.
  const topic = await getTopic();
  const now = Date.now();
  const out = await runNotifier({
    // The waits (lib/needs-you.mjs) ride along as a panel the alerts read.
    snapshot: { ...cache.snapshot(now), needsYou: { status: 'ok', data: needsYou.view(now), fetchedAt: now, error: null } },
    config,
    now,
    readSent,
    writeSent,
    acks: await ackStore.read(now),
    send: entry => sendAlert({ topic, title: entry.title, message: entry.message }),
    events: events && ((alerts, info) => events.fromAlerts(alerts, { ...info, jobNames: roster.jobs, serviceNames, excludeKeys: eventsSettings.excludeKeys }))
  });
  return { configured: Boolean(topic), ...out };
}, 5 * 60 * 1000);

// Approvals (lib/approvals.mjs): the mode from config (off unless "deny" or "on"), the
// kill file beside the sockets, and the classifier-block window fed by the needs-you
// ingest. Made once the chat is on; until then a block is only logged.
let approvals = null;
const onBlock = value => approvals?.noteBlock(value) ?? false;
// A Bash command's exact text from the report-only hook (lib/exact-commands.mjs).
const onExact = value => approvals?.noteExact(value) ?? 'off';
// The lead's session moved on (lib/answered-elsewhere.mjs): the page's cards for the
// prompts before that moment close. Made once the chat is on; a no-op until then.
// Guarded by a source test (test/answered-elsewhere.test.mjs): a merge must keep
// `onMoved` on both ingest handlers below.
let answeredElsewhere = null;
const onMoved = value => answeredElsewhere?.(value) ?? 0;
// The ingest is served on its own socket (below); the TCP port keeps only the
// needs-you route while config's `ingest.tcp` is "legacy" (routes.mjs), each post
// there logged and, once a day, alerted (lib/ingest-socket.mjs).
const ingestSettings = readIngestConfig(config);
for (const problem of ingestSettings.problems) console.error(`config: ${problem}`);
const ingestTcpNotice = createLegacyNotice({
  alert: async message => sendAlert({ topic: await getTopic(), title: 'Control Room', message }),
  onError: err => console.error('ingest: alert failed', err?.message ?? err)
});
const ackNotices = createAckNotices({
  sendPepper: notice => sendAckPepper(notice),
  sendNtfy: push => sendAckNtfy(push),
  onError: err => console.error('ack: the notice failed', err?.code ?? err?.name ?? 'error')
});
const api = createHandler({
  cache, todos, config, acks: ackStore, needsYou, onBlock, onExact, onMoved, onIngestTcp: ingestTcpNotice,
  // Each ack and renewal (lib/acks.mjs, ackNotice; notify.mjs, sendAckPepper and
  // sendAckNtfy): #pepper gets the details, limited per alert key (the first at once,
  // later ones for the key in 10 minutes counted and sent with the next or at the
  // window's end); ntfy gets generic words at low priority, at most one an hour across
  // every key and 12 a local day (lib/ack-notice-limit.mjs). Guarded by a source test
  // (test/ack-notice-limit.test.mjs): a merge must keep this line.
  onAckNotice: (notice, key) => ackNotices.notice(key, notice),
  // GET /api/loops and the dashboard's `loops` (lib/heal-runner.mjs, view).
  loops: () => heal.view()
});

// The chat (jarvis-os-chat-spec.md): on only when config has a `chat` block with the
// owner's `login` and the Host check enforces (lib/chat-routes.mjs, readChatConfig);
// anything less is a `config:` line and the chat stays off. Its store under data/chat
// (0700), the channel's Unix socket and the admin socket under ~/.local/state/jarvis-os
// (0700, sockets 0600; an override's folder is checked the same way, and a socket a
// live server answers on is never unlinked: lib/chat-listen.mjs), each with its own
// router; the page routes join the TCP router below, behind the Host check. Pairings,
// verdicts, a refused second channel and a takeover are logged and pushed like an alert;
// the last two at most once per kind per 10 minutes, with a count of those held back.
let chat = null;
// The Shortcut routes (lib/shortcut-routes.mjs): made with the chat, and only when
// config's `chat.shortcuts` is true. Null otherwise, and /api/shortcut/* is a 404.
let shortcuts = null;
let chatDevicesForFeed = null; // the Feed's reads take the chat's device cookie
const chatSettings = readChatConfig(config, hosts.mode);
for (const problem of chatSettings.problems) console.error(`config: ${problem}`);
const stateDir = join(homedir(), '.local', 'state', 'jarvis-os');
const channelSocketPath = process.env.JARVIS_OS_SOCKET || join(stateDir, 'channel.sock');
const adminSocketPath = process.env.JARVIS_OS_ADMIN_SOCKET || join(stateDir, 'admin.sock');
// The event socket (lib/event-socket.mjs) and the kill switch (lib/events.mjs).
const eventSocketPath = process.env.JARVIS_OS_EVENTS_SOCKET || join(stateDir, 'events.sock');
const eventsOffPath = join(stateDir, 'events-off');
// Who may say hello after a bye (lib/chat-verify.mjs): config's `chat.channelServer` and
// the lead's launcher's `launch.json`.
const channelServer = readChannelServer(config);
if (chatSettings.on) for (const problem of channelServer.problems) console.error(`config: ${problem}`);
const launchPath = join(stateDir, 'launch.json');
// The ingest's socket (lib/ingest-socket.mjs): every /api/ingest/* route, 0600 in the
// 0700 state folder, whether or not the chat is on. A problem keeps it off and says why.
const ingestSocketPath = process.env.JARVIS_OS_INGEST_SOCKET || join(stateDir, 'ingest.sock');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);
// Tried at once and then every 10 s, four tries in all (startIngestSocket); not
// awaited, so a slow socket never holds the dashboard's start. Off after the last
// try: one alert to #pepper (fixed words; ntfy generic), and while it stays off with
// the TCP route closed, the page's approvals are Deny-only (`ingestOk`, below). Once
// on, a close, an error or a removed or replaced socket file turns it off the same way,
// with its own alert words (INGEST_LOST_ALERT), once per run.
const ingestSocket = startIngestSocket({
  path: ingestSocketPath,
  handler: createIngestHandler({ cache, needsYou, onBlock, onExact, onMoved }),
  onOff: async (_, words) => sendAlert({ topic: await getTopic(), title: 'Control Room', message: words, ntfyMessage: 'The Control Room ingest socket is off: details in #pepper' })
});
ingestSocket.done.then(s => {
  if (s.on) console.log(`ingest: socket at ${ingestSocketPath}; the TCP port ${ingestSettings.tcp === 'legacy' ? 'still takes needs-you posts from this machine (ingest.tcp "legacy")' : 'takes no ingest posts'}`);
});
// Whether the hooks' posts reach the server: Ultron's 4-M1, guarded by a source test
// (test/ingest-socket.test.mjs). `check()` lstats the socket file on each approval
// (its device and inode against the ones bound), first, so a lost socket is noticed
// and alerted even while the TCP route is "legacy".
const ingestOk = () => ingestSocket.check() || ingestSettings.tcp === 'legacy';
let socketsReady = false;
if (chatSettings.on) {
  // The channel refuses a socket looser than 0600 in a folder looser than 0700; the
  // default folder is made so here, every start, and any folder is then checked.
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const prepared = [];
  for (const path of [channelSocketPath, adminSocketPath]) prepared.push(await prepareSocketPath(path));
  for (const problem of prepared.flatMap(p => p.problems)) console.error(`chat: ${problem}; the chat stays off`);
  socketsReady = prepared.every(p => p.ok);
}
if (chatSettings.on && socketsReady) {
  const chatDir = join(HERE, 'data', 'chat');
  await mkdir(chatDir, { recursive: true, mode: 0o700 });
  await chmod(chatDir, 0o700);
  // Each chat event is one log line, and the alerted kinds push too: #pepper the words,
  // ntfy generic ones (it shows on a lock screen, L10). The words, the one-line guard
  // and the alerted kinds are in lib/chat-events.mjs; a refused channel or a takeover
  // pushes at most once per kind per 10 minutes (lib/chat-alert-limit.mjs).
  const chatEvents = createChatEventHandler({
    send: async message => sendAlert({ topic: await getTopic(), title: 'Control Room', message, ntfyMessage: NTFY_WORDS })
  });
  const chatStore = createChatStore({ dir: chatDir });
  const loaded = await chatStore.load();
  console.log(`chat: ${loaded.messages} messages on file, seq ${loaded.seq}, epoch ${loaded.epoch}`);
  await chatStore.pruneAttachments();
  // Uploads never sent before the last stop: no message carries them, so after an
  // hour they go (lib/chat-store.mjs, pruneOrphans).
  const orphans = await chatStore.pruneOrphans();
  if (orphans) console.log(`chat: removed ${orphans} unsent upload${orphans === 1 ? '' : 's'} left from before the start`);
  // A revoked device takes the Shortcut keys it made with it (set below, once the
  // keys exist; lib/shortcut-keys.mjs, revokeMadeBy).
  let onDeviceRevoked = null;
  const chatDevices = createDeviceStore({
    path: join(chatDir, 'devices.json'),
    onEvent: event => {
      const logged = chatEvents(event);
      if (event?.kind === 'revoked') onDeviceRevoked?.(event.device);
      return logged;
    }
  });
  await chatDevices.load();
  chatDevicesForFeed = chatDevices;
  events = createEvents({ store: chatStore, ledgerPath: join(HERE, 'data', 'events.json'), killSwitchPath: eventsOffPath, sources: eventsSettings.sources, triagePerDay: eventsSettings.triagePerDay });
  await events.load();
  console.log(`events: on${events.killed() ? ' (the kill switch is on: events are stored, never delivered)' : ''}, ${eventsSettings.sources.size} socket source${eventsSettings.sources.size === 1 ? '' : 's'} allowed`);
  // Blocks count from the lead's session, or from one the sessions panel can't name;
  // another agent's own run (`--agent`) is not the lead's prompt.
  const leadName = roster.agents[0]?.name ?? null;
  const approvalSettings = readApprovalsConfig(config);
  for (const problem of approvalSettings.problems) console.error(`config: ${problem}`);
  approvals = createApprovals({
    mode: approvalSettings.mode, patterns: approvalSettings.patterns, killPath: join(stateDir, 'approvals-off'), onEvent: chatEvents,
    bash: approvalSettings.bash, bashCommands: approvalSettings.bashCommands,
    writeFolders: approvalSettings.writeFolders, writeProtected: approvalSettings.writeProtected,
    isLead: id => { const who = sessionAgents.get(id) ?? null; return who === null || who === leadName; },
    // Exact-command reports count from the lead's session by name only.
    isLeadSession: id => leadName !== null && (sessionAgents.get(id) ?? null) === leadName,
    // "parity": Allow wherever the channel's relay offers it (lib/approvals.mjs, header).
    rules: approvalSettings.rules, hidden: approvalSettings.hidden,
    // Deny-only while the ingest socket is off and the TCP route closed (4-M1).
    ingestOk
  });
  answeredElsewhere = createAnsweredElsewhere({ store: chatStore, isLeadSession: id => leadName !== null && (sessionAgents.get(id) ?? null) === leadName });
  approvals.killed();
  // `serverMode` is config and the kill file; `mode` also needs the channel's word, which comes with its hello.
  console.log(`chat: approvals ${approvals.configured}${approvals.serverMode() !== approvals.configured ? ' (the kill file holds them off)' : ''}; Bash ${approvalSettings.bash === 'exact' ? `by the hook's exact command (${approvalSettings.bashCommands.length} listed)` : 'Deny-only'}; ${approvalSettings.writeFolders.length} write folder${approvalSettings.writeFolders.length === 1 ? '' : 's'}, ${approvalSettings.writeProtected.length} protected place${approvalSettings.writeProtected.length === 1 ? '' : 's'} inside them`);
  // Parity says so in a line of its own: the line above then describes rules that are not applied.
  if (approvals.rules === 'parity') console.log(parityStartLine(approvals));
  // The accepted write folders, by name, so a start shows what the page may allow writes in.
  if (approvals.configured !== 'off') console.log(`chat: approvals write folders: ${approvalSettings.writeFolders.length ? approvalSettings.writeFolders.join(', ') : 'none'}`);
  // Alerted at every start with approvals on, and at any start whose mode differs from
  // the last start's (kept in data/chat/approvals-mode.json), off included.
  const modePath = join(chatDir, 'approvals-mode.json');
  let lastMode = null;
  try { lastMode = JSON.parse(await readFile(modePath, 'utf8'))?.mode ?? null; } catch { lastMode = null; }
  if (approvals.configured !== 'off' || (lastMode !== null && lastMode !== approvals.configured)) {
    await chatEvents({ kind: 'approvals-mode', mode: approvals.serverMode(), previous: lastMode, rules: approvals.rules, hidden: approvals.hidden });
  }
  if (lastMode !== approvals.configured) await writeFile(modePath, JSON.stringify({ mode: approvals.configured }), { mode: 0o600 }).catch(err => console.error(`chat: could not note the approvals mode (${err?.code ?? err})`));
  const socketRouter = createSocketRouter({ store: chatStore, events, approvals, onEvent: chatEvents, verifyRestart: createChannelVerifier({ channelServer: channelServer.path, launchPath }), verifyEveryHello: Boolean(channelServer.path) });
  // Web Push (lib/chat-push.mjs): on with config's `push.subject` and the VAPID key
  // in the Keychain; otherwise a `push:` line says why and the chat runs without it.
  const { vapid, problems: pushProblems } = await loadVapid({ config });
  for (const problem of pushProblems) console.error(`push: ${problem}`);
  if (vapid) console.log('push: notifications on');
  const push = createPushService({ devices: chatDevices, store: chatStore, socket: socketRouter, lastStream: id => chat?.lastStream(id) ?? null, vapid, onEvent: chatEvents });
  const shortcutSettings = readShortcutsConfig(config);
  for (const problem of shortcutSettings.problems) console.error(`config: ${problem}`);
  chat = createChatRoutes({ store: chatStore, devices: chatDevices, socket: socketRouter, config, onEvent: chatEvents, push, approvals, shortcutKeys: shortcutSettings.on });
  const listenUnix = async (path, handler, name) => {
    const s = createServer(async (req, res) => {
      try { await handler(req, res); } catch (err) { console.error(`chat ${name} failed`, err); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise((resolve, reject) => s.listen(path, resolve).on('error', reject));
    await chmod(path, 0o600);
    console.log(`chat: ${name} socket at ${path}`);
    return s;
  };
  // Shortcut keys (docs/design/2026-11-12-jarvis-os-shortcuts.md): off unless config's
  // `chat.shortcuts` is true. A key sends one message as the owner, appended by the same
  // store call as the page's, or one presence event; it reads and approves nothing. The
  // kill file beside the sockets refuses every send at once, with no restart. Guarded
  // by a source test (test/shortcuts.test.mjs): the routes get the chat's own store,
  // devices, events and login.
  const adminRouter = createAdminRouter({ devices: chatDevices, onEvent: chatEvents });
  let adminHandler = adminRouter;
  if (shortcutSettings.on) {
    const shortcutsOffPath = join(stateDir, 'shortcuts-off');
    const shortcutsOff = () => existsSync(shortcutsOffPath);
    const shortcutKeys = createShortcutKeys({ path: join(chatDir, 'shortcut-keys.json'), onEvent: chatEvents });
    // A keys file that can't be read, or can't be set aside when it is not a list of
    // keys, is never written over: Shortcut keys stay off for this run, and say why.
    let keyCount = null;
    try { keyCount = await shortcutKeys.load(); } catch (err) { console.error(`shortcuts: the keys file could not be read (${err?.code ?? err?.name ?? 'error'}); Shortcut keys stay off`); }
    if (keyCount !== null) {
      // A shared HEIC photo is refused (the Shortcut is told to share it as Most
      // Compatible) unless config's `chat.shortcutHeic` is "convert" and sips is there:
      // then it is made a JPEG with macOS's own sips (lib/heic-convert.mjs).
      const convertHeic = shortcutSettings.heic === 'convert' && existsSync(SIPS) ? createHeicConverter({ maxBytes: ATTACHMENT_MAX_BYTES }) : null;
      shortcuts = createShortcutRoutes({ keys: shortcutKeys, devices: chatDevices, store: chatStore, events, socket: socketRouter, login: chatSettings.login, onEvent: chatEvents, killed: shortcutsOff, convertHeic });
      const shortcutAdmin = createShortcutAdminRouter({ keys: shortcutKeys, killed: shortcutsOff });
      adminHandler = (req, res) => (shortcutAdmin.owns(new URL(req.url, 'http://unix').pathname) ? shortcutAdmin.handler(req, res) : adminRouter(req, res));
      onDeviceRevoked = device => {
        shortcutKeys.revokeMadeBy(device?.id, `the revoke of the device ${device?.name ?? '?'}`)
          .catch(err => console.error(`shortcuts: the keys a revoked device made could not be revoked (${err?.code ?? err?.name ?? 'error'})`));
      };
      console.log(`shortcuts: on, ${keyCount} key${keyCount === 1 ? '' : 's'} on file${shortcutsOff() ? ' (the kill file is there: every send is refused)' : ''}`);
      console.log(`shortcuts: a shared HEIC photo is ${convertHeic ? 'converted to JPEG here' : shortcutSettings.heic === 'convert' ? `refused (${SIPS} is not there)` : 'refused (chat.shortcutHeic is not "convert")'}`);
    }
  }
  await listenUnix(channelSocketPath, socketRouter.handler, 'channel');
  await listenUnix(adminSocketPath, adminHandler, 'admin');
  // The event socket is apart from the other two; a problem with its path keeps it
  // off and leaves the chat (and the notifier's events) running.
  const eventPrep = await prepareSocketPath(eventSocketPath);
  for (const problem of eventPrep.problems) console.error(`events: ${problem}; the event socket stays off`);
  if (eventPrep.ok) {
    await listenUnix(eventSocketPath, createEventSocketRouter({ events, sources: eventsSettings.sources }), 'event')
      .catch(err => console.error(`events: the event socket did not start (${err?.code ?? err?.message ?? err})`));
  }
}
// The Feed (lib/feed.mjs, lib/feed-routes.mjs): what each agent posted to its Discord
// feed, read from the copies the lead's discord-post keeps, for the roster's agents
// only, the lead's brief and digest pinned. Read-only, on request, at most every 5 s;
// a paired device may read it (the chat's rule), so with the chat off nobody can.
const feedSettings = readFeedConfig(config);
for (const problem of feedSettings.problems) console.error(`config: ${problem}`);
const feedRoutes = createFeedRoutes({
  feed: createFeedReader({ dir: feedSettings.dir, agents: roster.agents.map(a => a.key), lead: roster.agents[0]?.key ?? null }),
  devices: chatDevicesForFeed,
  login: chatSettings.on ? chatSettings.login : null
});
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
  if (shortcuts && shortcuts.owns(new URL(req.url, 'http://localhost').pathname)) return shortcuts.handler(req, res);
  if (chat && chat.owns(new URL(req.url, 'http://localhost').pathname)) return chat.handler(req, res);
  if (feedRoutes.owns(new URL(req.url, 'http://localhost').pathname)) return feedRoutes.handler(req, res);
  if (req.url.startsWith('/api/')) return api(req, res);
  if (req.url.startsWith('/avatars/')) return serveAvatar(req, res);
  return serveStatic(req, res);
}, allowedHostSet(PORT, hosts.names), { mode: hosts.mode });

const server = createServer(async (req, res) => {
  // A policy that runs nothing on every answer; the pages send their own (lib/static.mjs).
  setBaseHeaders(res);
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
