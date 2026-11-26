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
import { createHealth, JOB_STATUS_TIMEOUT_MS, runLaunchctlPrint, untilCached } from './collectors/health.mjs';
import { readHealConfig, withLoopParts, killFileThere } from './lib/heal.mjs';
import { createHealLedger } from './lib/heal-ledger.mjs';
import { createHealRunner } from './lib/heal-runner.mjs';
import { createMissedRunLoops } from './lib/heal-missed.mjs';
import { runCatalogProgram, runMissedRuns, runSelfRestart, createCheckoutReader } from './lib/heal-programs.mjs';
import { createRestartLoop, CHECK_EVERY_MS as RESTART_CHECK_MS } from './lib/heal-restart.mjs';
import { createHealTaps } from './lib/heal-routes.mjs';
import { matchingAck, ackLogLine, ackNotice } from './lib/acks.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readHealthConfig } from './lib/health.mjs';
import { createToPush } from './collectors/to-push.mjs';
import { readToPushConfig } from './lib/to-push.mjs';
import { vetPrograms } from './lib/program-check.mjs';
import { collectAccountCredits } from './collectors/account-credits.mjs';
import { runNotifier, entrySender } from './collectors/notifier.mjs';
import { createSentStore } from './lib/sent-store.mjs';
import { getTopic, sendAlert, entryAlert, sendAckPepper, sendAckNtfy } from './notify.mjs';
import { createChatEventHandler, CHAT_NTFY_TITLE, oneLine } from './lib/chat-events.mjs';
import { NTFY } from './lib/ntfy-note.mjs';
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
import { createChatStore, isOwnerChat, ATTACHMENT_MAX_BYTES } from './lib/chat-store.mjs';
import { createRoutineChat, isRoutineMessage } from './lib/routine-chat.mjs';
import { createDeviceStore } from './lib/chat-devices.mjs';
import { createSocketRouter } from './lib/chat-socket.mjs';
import { createChatRoutes, createAdminRouter, readChatConfig } from './lib/chat-routes.mjs';
import { prepareSocketPath } from './lib/chat-listen.mjs';
import { createEvents, readEventsConfig, isQuiet } from './lib/events.mjs';
import { threadTimes, describeWait, approvalWaits, createApprovalReminders, fileView, toolLabel } from './lib/approval-wait.mjs';
import { createEventSocketRouter } from './lib/event-socket.mjs';
import { createChannelVerifier, readChannelServer } from './lib/chat-verify.mjs';
import { createPushService, loadVapid } from './lib/chat-push.mjs';
import { parityStartLine, createApprovals, readApprovalsConfig } from './lib/approvals.mjs';
import { createFeedReader, readFeedConfig } from './lib/feed.mjs';
import { createFeedRoutes } from './lib/feed-routes.mjs';
import { createProactive, createSoonPass, readProactiveConfig, proactiveStart, targetNamer, nextQuietEnd, CHECK_EVERY_MS as PROACTIVE_EVERY_MS } from './lib/proactive.mjs';
import { IDLE } from './lib/proactive-text.mjs';
import { createProactiveRoutes } from './lib/proactive-routes.mjs';
import { createShortcutKeys } from './lib/shortcut-keys.mjs';
import { createShortcutRoutes, createShortcutAdminRouter, readShortcutsConfig, SERVER_REQUEST_TIMEOUT_MS } from './lib/shortcut-routes.mjs';
import { createHeicConverter, SIPS } from './lib/heic-convert.mjs';
import { readSpeechConfig, clearSpeechCache, SAY } from './lib/chat-speech-config.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chmod } from 'node:fs/promises';
import { get } from 'node:http';
import { aggregate } from './lib/aggregate.mjs';
import { buildHourly } from './lib/hourly.mjs';
import { buildAgentWork, agentHours } from './lib/agent-work.mjs';
import { readOtelConfig, createOtelStore, createOtelReceiver, buildOtelPanel, createCheckLog } from './lib/otel.mjs';
import { buildLiveAgents, endedThreads } from './lib/live-agents.mjs';
import { createStepUp, deviceEvent } from './lib/stepup.mjs';
import { createAgentStop } from './lib/agent-stop.mjs';
import { createRecover, readRecoverConfig, leadHealth, KILL_FILE as RECOVER_KILL_FILE } from './lib/jarvis-recover.mjs';
import { buildProjects } from './lib/projects.mjs';
import { installLogStamps } from './lib/log-stamp.mjs';
import { createLocalAlerts, KILL_FILE as LOCAL_ALERTS_KILL_FILE } from './lib/local-alerts.mjs';
import { readBoardArchiveConfig, createArchiveSweeper } from './lib/board-archive.mjs';

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
// Usage by agent from OpenTelemetry (lib/otel.mjs): off unless config's `otel.enabled` is
// true. Its receiver is a listener of its own on loopback, never this port or the tailnet.
const otelSettings = readOtelConfig(config, { dashboardPort: PORT });
for (const problem of otelSettings.problems) console.error(`config: ${problem}`);
const cache = createCache();
// The board's file: the store's, and the proactive check's read (one path, Ultron's L6).
const TODOS_PATH = join(HERE, 'todos.json');
const todos = createTodoStore(TODOS_PATH);
// The done-lane archive (board 17924110; lib/board-archive.mjs): off unless config's
// `board.archiveDays` is set. Its file is the store's default, data/todos-archive.json
// beside the other runtime data (gitignored), the path restore-todos.mjs names too.
const archiveSettings = readBoardArchiveConfig(config);
for (const problem of archiveSettings.problems) console.error(`config: ${problem}`);
const archiveSweeper = archiveSettings.on ? createArchiveSweeper({ store: todos, days: archiveSettings.days }) : null;
if (archiveSweeper) {
  archiveSweeper.start();
  console.log(`board: the done-lane archive is on: Done items finished ${archiveSettings.days} or more days ago move to data/todos-archive.json (checked hourly)`);
} else {
  console.log(`board: the done-lane archive is off${archiveSettings.state === 'unset' ? ' (no board block in config)' : ''}`);
}
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
  // A notifier pass follows each reading at once (collectors/registry.mjs, `then`): a
  // limit warning is then as late as the poll, not the poll plus the notifier's tick.
}, 5 * 60 * 1000, { then: 'notifier' });
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
// Loop 2's detector, the machine's read-only missed-runs, runs on a timer like job-status, so
// it must pass the same ownership rule (a script with no package beside it).
for (const problem of await vetPrograms([['heal.missedRuns', healSettings, 'missedRuns', { standalone: true }]])) console.error(`config: ${problem}`);
const healOffPath = join(homedir(), '.local', 'state', 'jarvis-os', 'heal-off');
// One ledger for every loop: the caps count across them.
const healLedger = createHealLedger({ path: join(HERE, 'data', 'heals.json') });
const heal = createHealRunner({
  settings: healSettings,
  ledger: healLedger,
  launchctlPrint: runLaunchctlPrint,
  killed: () => killFileThere(healOffPath),
  jobNames: roster.jobs
});
// Loop 2 (lib/heal-missed.mjs): a run missed during a restart gets a card in Needs you,
// and only a tap on it acts (lib/heal-routes.mjs, through the chat's device rules). Its
// one launchctl write is the catalog's `kickstart gui/<uid>/<label>` (no -k), the label
// from config; its ack goes in by "heal" and is noticed like any other. It shares loop
// 1's switch (`heal.status()`: config, the ledger, the kill switch).
const missed = createMissedRunLoops({
  settings: healSettings,
  ledger: healLedger,
  status: () => heal.status(),
  launchctlPrint: runLaunchctlPrint,
  runProgram: (entry, target) => runCatalogProgram(entry, target),
  missedRuns: healSettings.missedRuns ? () => runMissedRuns(healSettings.missedRuns) : null,
  addAck: (ack, now) => ackStore.add(ack, now),
  jobNames: roster.jobs,
  notify: async (message, { priority = 'default', ntfyTitle = null } = {}) => sendAlert({ topic: await getTopic(), title: 'Control Room', message, ntfyTitle, priority }),
  onAck: stored => {
    console.log(ackLogLine(stored));
    ackNotices.notice(stored.key, ackNotice(stored, Date.now(), { via: 'heal-card' }));
  }
});
if (missed.catalogProblem()) console.error(`heal: loop 2's catalog entries were refused (${missed.catalogProblem()}); no missed-run cards`);
// Loop 3 (lib/heal-restart.mjs): a merge that changes server/ gets a Restart card, and only
// a tap acts: the catalog's `kickstart -k` on config's self target, which must be the job
// launchd started this process as. The checkout is read through git-read (toPush.gitRead,
// vetted above), never git itself, and the new process checks the restart it comes from.
const restartLoop = createRestartLoop({
  settings: healSettings,
  ledger: healLedger,
  status: () => heal.status(),
  git: toPushSettings.gitRead ? createCheckoutReader({ gitRead: toPushSettings.gitRead, repo: join(HERE, '..') }) : null,
  launchctlPrint: runLaunchctlPrint,
  runProgram: (entry, target) => runSelfRestart(entry, target),
  self: { label: process.env.XPC_SERVICE_NAME ?? null, launchd: process.ppid === 1, pid: process.pid },
  firstPass: () => registry.whenFirstPass(),
  failingNow: () => Object.entries(cache.snapshot()).filter(([, v]) => v.error).map(([k]) => k),
  startedAt: STARTED_AT,
  notify: async (message, { priority = 'default', ntfyTitle = null } = {}) => sendAlert({ topic: await getTopic(), title: 'Control Room', message, ntfyTitle, priority })
});
if (restartLoop.catalogProblem()) console.error(`heal: loop 3's catalog entry was refused (${restartLoop.catalogProblem()}); no restart cards`);
await heal.load();
// Not awaited: checking a restart waits for the first collector pass, after listen.
restartLoop.start().catch(err => console.error(`heal: the restart loop's start failed (${err?.message ?? err})`));
setInterval(() => { restartLoop.pass().catch(err => console.error(`heal: the restart pass failed (${err?.message ?? err})`)); }, RESTART_CHECK_MS).unref();
if (heal.catalogProblem()) console.error(`heal: the catalog was refused (${heal.catalogProblem()}); heals stay off`);
{
  const { status, why } = heal.status();
  console.log(`heal: ${status}${why ? ` (${why})` : ''}, ${healSettings.targets.size} target${healSettings.targets.size === 1 ? '' : 's'}; missed-runs ${healSettings.missedRuns ? 'set' : 'not set, so no missed-run cards'}`);
}
// Its first pass waits for the crons panel's first (untilCached, capped), so the first
// payload after a start already marks an acked job (board 20620d37).
const health = createHealth({ settings: healthSettings, jobNames: roster.jobs, cache, startedAt: STARTED_AT, quietOf: (label, since) => heal.quietOf(label, since), firstCrons: () => untilCached(cache, 'crons') });
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
  let out = overlaid;
  try {
    out = await heal.pass(overlaid, {
      acked: c => Boolean(matchingAck({ kind: 'cron', key: `cron:launchd:${c.label}`, since: c.lastRunAt }, acks, now))
    });
  } catch (err) {
    console.error(`heal: the pass failed (${err?.message ?? err})`);
  }
  // Loop 2's cards and the runs its taps started; it reads the panel and never changes it.
  try {
    await missed.pass(out);
  } catch (err) {
    console.error(`heal: the missed-run pass failed (${err?.message ?? err})`);
  }
  return out;
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
// The lead's roster name: the sessions named so are his, and their permission waits
// are his approval cards (lib/approval-wait.mjs).
const LEAD_NAME = roster.agents[0]?.name ?? null;
// Each session's threads from the last sessions pass (lib/approval-wait.mjs,
// threadTimes): their newest requests, for which permission waits are still held, and
// each subagent's type, for a card's words.
let threadsNow = new Map();
// The tool on the chat's newest open card, for a wait of the lead's whose hooks name no
// tool (set once the chat is on; board e7427be1).
let cardToolHint = null;
const needsYou = createNeedsYouStore({
  whoFor: id => sessionAgents.get(id) ?? null,
  detailFor: (w, asks) => describeWait(w, asks, { typeOf: (sid, key) => threadsNow.get(sid)?.types.get(key) ?? null, rosterName }),
  hintFor: (sid, now) => cardToolHint?.(sid, now) ?? null
});
// The lead's approval cards now (lib/approval-wait.mjs): for the reminders, the answer
// watch's file and the idle wake-up.
const approvalWaitsNow = now => approvalWaits(needsYou.view(now), LEAD_NAME);
// Each roster agent's tokens by the hour from the transcripts, for the OpenTelemetry
// cross-check (lib/otel.mjs). Kept here, not in the sessions panel, so the page never gets it.
let transcriptHours = null;
registry.register('sessions', async () => {
  const { transcripts, coworkSessions, unavailableRoots, unreadablePaths, sessionNames } = await collectSessions({ cache: transcriptCache });
  const now = Date.now();
  sessionAgents.clear();
  for (const t of transcripts) {
    if (t.subagent || !t.sessionId) continue;
    const name = rosterName(t.agentName) ?? rosterName(t.agentSetting);
    if (name) sessionAgents.set(t.sessionId, name);
  }
  // A stopped subagent sends no SubagentStop, so its asks would hold a permission wait
  // open (board 2c49fcfa): its transcript says it stopped (lib/needs-you.mjs, endThreads).
  transcriptHours = agentHours({ transcripts, sessionNames, roster, now });
  const stopped = needsYou.endThreads(endedThreads(transcripts, now), now);
  if (stopped.dropped > 0) console.log(`needs-you: ${stopped.dropped} ask${stopped.dropped === 1 ? '' : 's'} of stopped subagents dropped, ${stopped.ended} wait${stopped.ended === 1 ? '' : 's'} ended, ${stopped.open} open`);
  // A permission wait lives while its thread's transcript shows it held, past the
  // 30-minute lapse, and ends once the thread wrote a request after it (board e7427be1).
  threadsNow = threadTimes(transcripts);
  const confirmed = needsYou.confirm(threadsNow, now);
  if (confirmed.ended > 0 || confirmed.dropped > 0) console.log(`needs-you: the transcripts show ${confirmed.dropped} ask${confirmed.dropped === 1 ? '' : 's'} answered and ${confirmed.ended} permission wait${confirmed.ended === 1 ? '' : 's'} over (a request written after it), ${confirmed.open} open`);
  return {
    ...aggregate(transcripts, now),
    // Burn and the week's heat map on the Orbit page (lib/hourly.mjs).
    hourly: buildHourly(transcripts, now),
    // The agent views on the Orbit page (lib/agent-work.mjs). The schedules name
    // a routine's runs; before the first crons pass they are not read yet, and
    // those runs go unnamed for that minute.
    agentWork: buildAgentWork({ transcripts, sessionNames, roster, crons: cache.get('crons', now).data, now }),
    // The live agents panel on the Overview (lib/live-agents.mjs): runs going now.
    liveAgents: buildLiveAgents({ transcripts, sessionNames, roster, now }),
    unavailableRoots,
    unreadablePaths,
    projects: buildProjects({
      coworkSessions,
      transcripts
    }, now)
  };
}, 60 * 1000);

// Usage by agent from OpenTelemetry (lib/otel.mjs; README, "Usage by agent from
// OpenTelemetry"). With `otel.enabled`, a receiver on 127.0.0.1 at `otel.port` takes OTLP
// metrics as JSON (no logs, no traces), counts each roster agent's tokens by the hour into
// data/otel.json, and the panel sets them beside the transcripts' counts. It feeds no
// alert, push or event: what it shows is a second count, and a gap goes to the log once.
let otelReceiver = 'off';
const otelStore = otelSettings.on ? createOtelStore({ path: join(HERE, 'data', 'otel.json') }) : null;
if (otelStore) {
  const loaded = await otelStore.load();
  const otelHandler = createOtelReceiver({ store: otelStore, port: otelSettings.port, roster });
  const otelServer = createServer(async (req, res) => {
    setBaseHeaders(res);
    try {
      await otelHandler(req, res);
    } catch (err) {
      console.error(`otel: a post failed (${err?.code ?? err?.name ?? 'error'})`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      res.end('{}');
    }
  });
  // A slow sender can't hold a connection open: the whole request within 10 s.
  otelServer.requestTimeout = 10e3;
  otelServer.headersTimeout = 5e3;
  otelServer.maxHeadersCount = 64;
  // A handful of exporters at once is a busy day; idle keep-alive sockets go after 2 s (Ultron's L3).
  otelServer.maxConnections = 32;
  otelServer.keepAliveTimeout = 2e3;
  otelServer.on('error', err => {
    otelReceiver = 'failed';
    console.error(`otel: the receiver could not listen on 127.0.0.1:${otelSettings.port} (${err?.code ?? 'error'}); usage by agent reads "not running"`);
  });
  otelServer.on('close', () => { otelReceiver = 'failed'; console.error('otel: the receiver stopped listening'); });
  otelServer.listen(otelSettings.port, '127.0.0.1', () => {
    otelReceiver = 'listening';
    console.log(`otel: listening on 127.0.0.1:${otelSettings.port} for metrics only (POST /v1/metrics, JSON); store ${loaded}`);
  });
} else {
  console.log(`otel: ${otelSettings.state === 'unset' ? 'off (no otel block in config)' : 'off'}`);
}
const otelCheckLog = createCheckLog();
registry.register('otel', async () => {
  if (otelStore) await otelStore.save();
  const panel = buildOtelPanel({ settings: otelSettings, receiver: otelReceiver, snapshot: otelStore?.snapshot() ?? null, transcript: transcriptHours, roster, now: Date.now() });
  otelCheckLog(panel.check);
  return panel;
}, 60 * 1000);

// The board's size against its PUT cap (routes.mjs), so an alert warns at 75%
// while there is still room to archive the done lane. A stat, nothing more.
// `archive` says whether the done-lane archive is on, its days, its size and the last run.
registry.register('board', async () => ({
  bytes: await todos.size(),
  cap: BOARD_MAX_BODY,
  archive: {
    ...(archiveSweeper ? archiveSweeper.status() : { on: false, days: null, last: null }),
    ...(await todos.archiveSize().catch(() => ({ items: null, bytes: null, unreadable: true })))
  }
}), 60 * 1000);

// What the notifier has told (lib/sent-store.mjs): written through a temp file, 0600.
// A write the last run was stopped in the middle of left its temp file; those go now,
// before this run's first write. Guarded by a source test (test/sent-store-sweep.test.mjs).
const sentStore = createSentStore(join(HERE, 'data', 'notified.json'));
const staleSentTemps = await sentStore.sweep();
if (staleSentTemps > 0) console.log(`notifier: removed ${staleSentTemps} temp file${staleSentTemps === 1 ? '' : 's'} an interrupted write left beside the notifier's file`);

// Events (lib/events.mjs): made from the notifier's alerts after acks, once the chat
// is on (below). Until then, and with the chat off, the hook is absent.
let events = null;
// A limit warning's Web Push to the paired devices (lib/chat-push.mjs, limitWarning):
// set once the chat is on (below); until then a warning goes to ntfy and #pepper only.
let limitPush = null;
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
    readSent: sentStore.read,
    writeSent: sentStore.write,
    acks: await ackStore.read(now),
    // A limit's full line names #jarvis as its feed (lib/limit-warnings.mjs); every
    // other alert goes to #pepper. ntfy gets only the entry's ntfy title, in fixed words
    // (notify.mjs, entryAlert; lib/ntfy-note.mjs): never a command, a link or a label.
    send: entrySender({ alert: entryAlert({ topic }), devices: limitPush }),
    events: events && ((alerts, info) => events.fromAlerts(alerts, { ...info, jobNames: roster.jobs, serviceNames, excludeKeys: eventsSettings.excludeKeys })),
    // A heal hold skips a key the events ledger has (Ultron's L4, 11-13).
    eventKnown: key => Boolean(events?.knows(key)),
    // Back under every full limit: one "limit reset" event to the lead (lib/events.mjs).
    limitReset: events && (() => events.limitReset())
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
// Guarded by a source test (test/approvals-parity.test.mjs): a merge must keep
// `onMoved` on both ingest handlers below.
let answeredElsewhere = null;
const onMoved = value => answeredElsewhere?.(value) ?? 0;
// A routine's message for the chat (lib/routine-chat.mjs): the morning brief and the
// weekly digest, posted to the ingest socket by the routine itself. Made once the chat
// is on; until then the route answers 503. The kill file is beside the sockets.
// Guarded by a source test (test/routine-chat.test.mjs): a merge must keep `onRoutine`
// on the ingest socket's handler, and the chat's own store behind it.
let routineChat = null;
const onRoutine = value => routineChat?.post(value) ?? { ok: false, status: 503, error: 'the chat is off' };
// A local script's alert (lib/local-alerts.mjs): posted to the ingest socket, shown in
// the strip and Needs you from the moment the server starts, and pushed to the paired
// devices once the chat's push is on (`localAlertPush`, set below). Guarded by a source
// test (test/local-alerts.test.mjs): a merge must keep `onLocalAlert` on the ingest
// socket's handler and `localAlerts` on the TCP handler's view. An acknowledged alert
// is never pushed again (an ack covers its repeats: one key per condition), and the kill
// file `local-alerts-off` beside the sockets stops every push at once, no restart; the
// alerts are still shown.
let localAlertPush = null;
const localAlerts = createLocalAlerts({
  push: () => localAlertPush,
  killed: () => existsSync(join(stateDir, LOCAL_ALERTS_KILL_FILE)),
  isAcked: async alert => matchingAck(alert, await ackStore.read(Date.now()), Date.now()) !== null
});
const onLocalAlert = value => localAlerts.post(value);
// The ingest is served on its own socket (below); the TCP port keeps only the
// needs-you route while config's `ingest.tcp` is "legacy" (routes.mjs), each post
// there logged and, once a day, alerted (lib/ingest-socket.mjs).
const ingestSettings = readIngestConfig(config);
for (const problem of ingestSettings.problems) console.error(`config: ${problem}`);
const ingestTcpNotice = createLegacyNotice({
  // ntfy gets only its title (lib/ntfy-note.mjs): the alert's words say how to move a
  // hook or change config, and an ntfy push never says to do anything (board 704e981b).
  alert: async message => sendAlert({ topic: await getTopic(), title: 'Control Room', message, ntfyTitle: NTFY.ingestLegacy }),
  onError: err => console.error('ingest: alert failed', err?.message ?? err)
});
const ackNotices = createAckNotices({
  sendPepper: notice => sendAckPepper(notice),
  sendNtfy: push => sendAckNtfy(push),
  onError: err => console.error('ack: the notice failed', err?.code ?? err?.name ?? 'error')
});
const api = createHandler({
  cache, todos, config, acks: ackStore, needsYou, localAlerts, onBlock, onExact, onMoved, onIngestTcp: ingestTcpNotice,
  // Each ack and renewal (lib/acks.mjs, ackNotice; notify.mjs, sendAckPepper and
  // sendAckNtfy): #pepper gets the details, limited per alert key (the first at once,
  // later ones for the key in 10 minutes counted and sent with the next or at the
  // window's end); ntfy gets a fixed title in fixed words at low priority, at most one an hour across
  // every key and 12 a local day (lib/ack-notice-limit.mjs). Guarded by a source test
  // (test/ack-notice-limit.test.mjs): a merge must keep this line.
  onAckNotice: (notice, key) => ackNotices.notice(key, notice),
  // GET /api/loops and the dashboard's `loops` (lib/heal-runner.mjs and lib/heal-missed.mjs, view).
  loops: () => withLoopParts(heal.view(), [missed.view(), restartLoop.view()]),
  // GET /api/todos/archive says the archive's setting (null: off).
  archiveDays: archiveSettings.days
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
// The Shortcut keys, for the proactive check's expiry rule: set once they are loaded.
let shortcutKeysForProactive = null;
// The idle wake-up's reset on the owner's chat messages (board e10a01ed): the store's
// read of the last one, set with the chat; and what a new one asks of the check's
// timer, set once the passes run (an extra pass at the end of the settle).
let ownerChatForProactive = null;
let ownerWroteForProactive = () => {};
// Read aloud in the Mac's own voice (lib/chat-speech.mjs): set once it has started.
let speech = null;
const chatSettings = readChatConfig(config, hosts.mode);
for (const problem of chatSettings.problems) console.error(`config: ${problem}`);
const stateDir = join(homedir(), '.local', 'state', 'jarvis-os');
const speechCachePath = join(stateDir, 'speech-cache');
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
// try: one alert to #pepper (fixed words; ntfy its fixed title), and while it stays off with
// the TCP route closed, the page's approvals are Deny-only (`ingestOk`, below). Once
// on, a close, an error or a removed or replaced socket file turns it off the same way,
// with its own alert words (INGEST_LOST_ALERT), once per run.
const ingestSocket = startIngestSocket({
  path: ingestSocketPath,
  handler: createIngestHandler({ cache, needsYou, onBlock, onExact, onMoved, onRoutine, onLocalAlert }),
  onOff: async (_, words) => sendAlert({ topic: await getTopic(), title: 'Control Room', message: words, ntfyTitle: NTFY.ingestOff })
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
  // ntfy a fixed title in fixed words (it shows on a lock screen, L10; lib/ntfy-note.mjs). The words, the one-line guard
  // and the alerted kinds are in lib/chat-events.mjs; a refused channel or a takeover
  // pushes at most once per kind per 10 minutes (lib/chat-alert-limit.mjs).
  const chatEvents = createChatEventHandler({
    send: async message => sendAlert({ topic: await getTopic(), title: 'Control Room', message, ntfyTitle: CHAT_NTFY_TITLE })
  });
  const chatStore = createChatStore({ dir: chatDir });
  const loaded = await chatStore.load();
  // The owner's chat messages start the idle wake-up's back-off again (board e10a01ed);
  // an event, a routine's post, the lead's own message, a verdict or a stop never does.
  ownerChatForProactive = after => chatStore.ownerChatAfter(after);
  chatStore.subscribe(e => { if (e?.type === 'message' && isOwnerChat(e.message)) ownerWroteForProactive(e.message.at); });
  // The lead's own chat message (not a routine's brief or digest) says he is answering:
  // the "Jarvis is not answering" alerts raised before it go (lib/local-alerts.mjs,
  // resolveDown; board 80bd2708).
  chatStore.subscribe(e => {
    const m = e?.type === 'message' ? e.message : null;
    if (m && m.from === 'jarvis' && m.kind === 'chat' && !isRoutineMessage(m)) localAlerts.resolveDown(m.at ?? Date.now(), 'the lead wrote in the chat');
  });
  console.log(`chat: ${loaded.messages} messages on file, seq ${loaded.seq}, epoch ${loaded.epoch}`);
  await chatStore.pruneAttachments();
  // Uploads never sent before the last stop: no message carries them, so after an
  // hour they go (lib/chat-store.mjs, pruneOrphans).
  const orphans = await chatStore.pruneOrphans();
  if (orphans) console.log(`chat: removed ${orphans} unsent upload${orphans === 1 ? '' : 's'} left from before the start`);
  // The routines' messages (the brief, the digest) go into this store; `routine-chat-off`
  // beside the sockets refuses them with no restart (lib/routine-chat.mjs).
  const routineOffPath = join(stateDir, 'routine-chat-off');
  routineChat = createRoutineChat({ store: chatStore, killed: () => existsSync(routineOffPath) });
  console.log(`routine-chat: on${existsSync(routineOffPath) ? ' (the kill file is there: every post is refused)' : ''}; the brief and the digest post to the ingest socket`);
  // A revoked device takes the Shortcut keys it made with it (set below, once the
  // keys exist; lib/shortcut-keys.mjs, revokeMadeBy).
  let onDeviceRevoked = null;
  // Face ID for stops (lib/stepup.mjs): a device's passkey goes with its revoke or its approver mark.
  const stepUp = createStepUp({ path: join(chatDir, 'passkeys.json'), onEvent: event => chatEvents(event) });
  const chatDevices = createDeviceStore({
    path: join(chatDir, 'devices.json'),
    onEvent: event => {
      const logged = chatEvents(event);
      if (event?.kind === 'revoked') onDeviceRevoked?.(event.device);
      deviceEvent(stepUp, event)?.catch(err => console.error(`stop: a device's passkey could not be removed (${err?.code ?? err?.name ?? 'error'})`));
      return logged;
    }
  });
  await chatDevices.load();
  const passkeys = await stepUp.load();
  console.log(`stop: ${passkeys} Face ID passkey${passkeys === 1 ? '' : 's'} on file for stops`);
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
    ingestOk,
    // The open cards, so a kept exact-command report rechecks them at once and a
    // marked card is redrawn (Ultron's M1 and L1, 11-13). Guarded by a source test.
    cards: chatStore
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
  limitPush = body => push.limitWarning(body);
  localAlertPush = alert => push.localAlert(alert);
  // Approval cards left waiting (lib/approval-wait.mjs; board e7427be1). A wait of the
  // lead's whose hooks name no tool takes the tool of the chat's newest open card relayed
  // in the two minutes before it (a label only). Each minute: a reminder to the paired
  // devices once a card has waited 10 minutes, then each 30, at most six, held in quiet
  // hours; and data/approval-waits.json for the jarvis repo's answer watch.
  cardToolHint = (sid, now) => {
    if (LEAD_NAME === null || sessionAgents.get(sid) !== LEAD_NAME) return null;
    const card = chatStore.openPermissions().filter(p => now - p.relayedAt <= 2 * 60e3 && p.relayedAt <= now + 5e3).sort((a, b) => b.relayedAt - a.relayedAt)[0];
    return card ? toolLabel(card.tool) : null;
  };
  const approvalReminders = createApprovalReminders({ push: body => push.approvalReminder(body), quiet: at => isQuiet(at) });
  const approvalWaitsFile = createSentStore(join(HERE, 'data', 'approval-waits.json'));
  const staleWaitTemps = await approvalWaitsFile.sweep();
  if (staleWaitTemps > 0) console.log(`approval-wait: removed ${staleWaitTemps} temp file${staleWaitTemps === 1 ? '' : 's'} an interrupted write left`);
  let waitFileSaid = false;
  setInterval(async () => {
    const now = Date.now();
    const waits = approvalWaitsNow(now);
    try { await approvalReminders.step(waits, now); } catch (err) { console.error(`approval-wait: the reminder step failed (${err?.code ?? err?.name ?? 'error'})`); }
    try { await approvalWaitsFile.write(fileView(waits, now)); waitFileSaid = false; } catch (err) {
      if (!waitFileSaid) console.error(`approval-wait: the answer watch's file could not be written (${err?.code ?? err?.name ?? 'error'})`);
      waitFileSaid = true;
    }
  }, 60e3).unref();
  const shortcutSettings = readShortcutsConfig(config);
  for (const problem of shortcutSettings.problems) console.error(`config: ${problem}`);
  // Stop buttons (war room slice 2, lib/agent-stop.mjs): the rows come from the
  // sessions panel's latest pass, so a stop names only a run live this minute.
  const agentStop = createAgentStop({ stepUp, socket: socketRouter, store: chatStore, onEvent: chatEvents, liveRuns: () => cache.get('sessions', Date.now())?.data?.liveAgents?.runs ?? [] });
  // Taps on a heal card (lib/heal-routes.mjs): an approver device, the page's Origin.
  const healTaps = createHealTaps({ loops: { missed, restart: restartLoop }, onEvent: chatEvents, log: line => console.log(oneLine(line)) });
  // Read aloud in the Mac's own voice (lib/chat-speech.mjs): off unless config has a
  // `chat.speech` block. The words are spoken here by macOS's `say` and the page plays
  // the audio; the file `speech-off` beside the sockets turns it off without a restart.
  // The module shares two files with the page (web/src/lib/orbit/speech.js and its
  // markdown.js), so it is loaded here, and only when config turns it on: a broken page
  // file then costs read aloud, never the server's start. Any problem leaves it off,
  // and the page reads in the device's own voice as before.
  const speechSettings = readSpeechConfig(config);
  for (const problem of speechSettings.problems) console.error(`config: ${problem}`);
  if (speechSettings.on && !existsSync(SAY)) console.error(`speech: ${SAY} is not there; read aloud on the Mac stays off`);
  else if (speechSettings.on) {
    const speechOffPath = join(stateDir, 'speech-off');
    try {
      const { createSpeech } = await import('./lib/chat-speech.mjs');
      const made = createSpeech({ store: chatStore, dir: speechCachePath, voice: speechSettings.voice, fallback: speechSettings.fallback, killed: () => existsSync(speechOffPath) });
      await made.start();
      speech = made;
      console.log(`speech: on, asked for ${speechSettings.voice}${existsSync(speechOffPath) ? ' (the kill file is there: the page reads in the device\'s own voice)' : ''}`);
    } catch (err) { console.error(`speech: could not be loaded or started (${err?.code ?? err?.name ?? 'error'}); read aloud on the Mac stays off`); }
  }
  // Restart Jarvis with Face ID (lib/jarvis-recover.mjs; board 98a30b15): off unless
  // config's `recover.enabled` is true; the file `recover-off` beside the sockets turns
  // it off with no restart. It runs one fixed program, the run sheet's jarvis-recover.
  const recoverSettings = readRecoverConfig(config);
  for (const problem of recoverSettings.problems) console.error(`config: ${problem}`);
  const recoverOffPath = join(stateDir, RECOVER_KILL_FILE);
  // `health`: what the health strip says of the lead now, for the sheet's words and the
  // ask's event; a run never waits on it (Ultron's Q1). The stop flag is read by the module.
  // `liveAgents`: the sessions panel the live agents pane, the Stop buttons and the idle
  // wake-up read; a restart stops the lead's runs in it, so the page and the POSTs say so
  // first (board d8f27c49).
  const recover = createRecover({ home: homedir(), dir: chatDir, stepUp, enabled: recoverSettings.on, killed: () => existsSync(recoverOffPath), onEvent: chatEvents, health: () => leadHealth(cache.get('health'), leadName), liveAgents: () => cache.get('sessions', Date.now()), roster });
  const recoverRuns = await recover.load();
  console.log(`recover: Restart Jarvis from the page is ${recoverSettings.on ? 'on' : recoverSettings.state === 'unset' ? 'off (no recover block in config)' : 'off'}${existsSync(recoverOffPath) ? ` (the kill file ${RECOVER_KILL_FILE} is there: every restart is refused)` : ''}; ${recoverRuns} run${recoverRuns === 1 ? '' : 's'} in its ledger`);
  chat = createChatRoutes({ store: chatStore, devices: chatDevices, socket: socketRouter, config, onEvent: chatEvents, push, approvals, agentStop, shortcutKeys: shortcutSettings.on, speech, healTaps, recover });
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
  const adminRouter = createAdminRouter({ devices: chatDevices, onEvent: chatEvents, stepUp });
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
      shortcutKeysForProactive = shortcutKeys;
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
// Read aloud did not start (no `chat.speech`, the chat off, or a problem above): the
// audio an earlier run cached goes, so turning it off leaves none of the lead's replies
// behind as speech (lib/chat-speech-config.mjs; only the cache's own files).
if (speech === null) {
  const cleared = await clearSpeechCache(speechCachePath).catch(() => null);
  if (cleared && (cleared.removed > 0 || cleared.left > 0)) console.log(`speech: off, so ${cleared.removed} cached audio file${cleared.removed === 1 ? '' : 's'} went${cleared.left > 0 ? `; ${cleared.left} other thing${cleared.left === 1 ? '' : 's'} in the cache folder stayed` : ''}`);
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
// The proactive check (lib/proactive.mjs; docs/design/2026-11-18-proactive-check.md):
// every 5 minutes, no model and no network, over the board file, the crons and usage
// panels, the heal ledger and the Shortcut keys. A new hit wakes the lead with one event
// (lib/events.mjs, `proactive`); hits found from 22:00 to 07:00 wait for 07:00. Off
// unless config's `proactive.enabled` is true, and with the chat off no pass runs (no
// events path, no paired device: proactiveStart); the kill file `proactive-off` beside
// the sockets stops every pass with no restart. The board is read from its file, never
// through the board store, whose read can write (it seeds a missing board). Guarded by
// a source test (test/proactive-routes.test.mjs).
const proactiveSettings = readProactiveConfig(config);
for (const problem of proactiveSettings.problems) console.error(`config: ${problem}`);
const proactiveOffPath = join(stateDir, 'proactive-off');
// The idle wake-up's own kill file (docs/design/2026-11-19-dynamic-projection-idle-wake.md):
// config's `proactive.idle` turns the wake-up on; while this file exists none goes.
const idleOffPath = join(stateDir, 'idle-off');
const proactiveStore = createSentStore(join(HERE, 'data', 'proactive.json'));
const proactive = createProactive({
  settings: proactiveSettings,
  readBoard: () => readFile(TODOS_PATH, 'utf8'),
  snapshot: () => cache.snapshot(Date.now()),
  healLines: () => healLedger.lines(),
  healTargetName: targetNamer(healSettings.targets, roster.jobs),
  shortcutKeys: () => shortcutKeysForProactive?.list() ?? null,
  store: proactiveStore,
  events: () => events,
  jobNames: roster.jobs,
  excludeKeys: eventsSettings.excludeKeys,
  killed: () => existsSync(proactiveOffPath),
  idleKilled: () => existsSync(idleOffPath),
  ownerChat: after => ownerChatForProactive?.(after) ?? null,
  repoHeads: () => toPush.heads(),
  // The lead's approval cards: one on his own thread holds the wake-up, a subagent's is
  // said in it (board e7427be1).
  approvalWaits: () => approvalWaitsNow(Date.now())
});
const proactiveRoutes = createProactiveRoutes({
  view: () => proactive.view(),
  devices: chatDevicesForFeed,
  login: chatSettings.on ? chatSettings.login : null
});
const proactiveStarted = proactiveStart({ settings: proactiveSettings, events: Boolean(events), devices: Boolean(chatDevicesForFeed), killFile: existsSync(proactiveOffPath) });
if (proactiveStarted.run) {
  const stale = await proactiveStore.sweep();
  if (stale > 0) console.log(`proactive: removed ${stale} temp file${stale === 1 ? '' : 's'} an interrupted write left`);
  // An extra pass when a reset of the idle back-off ends its wait (board e10a01ed): at
  // the end of the settle after the owner writes, or when a pass says so.
  const soon = createSoonPass({ run: () => runPass() });
  const runPass = () => { proactive.pass().then(r => soon.at(r?.idleNextAt)).catch(err => console.error(`proactive: the pass failed (${err?.message ?? err})`)); };
  // At 07:00 sharp too, so the night's held hits go then and not up to 5 minutes later.
  const atQuietEnd = () => { setTimeout(() => { runPass(); atQuietEnd(); }, nextQuietEnd(Date.now()) - Date.now()).unref(); };
  // The first pass waits for every collector's first run, so the panels it reads are filled.
  registry.whenFirstPass().then(() => {
    runPass();
    setInterval(runPass, PROACTIVE_EVERY_MS).unref();
    atQuietEnd();
    ownerWroteForProactive = at => soon.at(at + IDLE.settleMs + 1000);
  });
}
console.log(proactiveStarted.line);
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
  if (proactiveRoutes.owns(new URL(req.url, 'http://localhost').pathname)) return proactiveRoutes.handler(req, res);
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

// The limit on receiving a whole request, set here and not left to Node's default:
// longer than a Shortcut form's own two minutes, so its answer always comes first.
server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;

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
