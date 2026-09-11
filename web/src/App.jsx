import './styles/tokens.css';
import './styles/app.css';
import { useDashboard } from './hooks/useDashboard.js';
import { useTick } from './hooks/useTick.js';
import { Header } from './components/Header.jsx';
import { AlertBar } from './components/AlertBar.jsx';
import { ConnectionBar } from './components/ConnectionBar.jsx';
import { Panel } from './components/Panel.jsx';
import { StatusNote } from './components/StatusNote.jsx';
import { IncompleteNote } from './components/IncompleteNote.jsx';
import { PlanBlock } from './components/PlanBlock.jsx';
import { CreditsPanel } from './components/CreditsPanel.jsx';
import { LimitBars } from './components/LimitBars.jsx';
import { StackedBar } from './components/StackedBar.jsx';
import { ModelRows } from './components/ModelRows.jsx';
import { SessionRows } from './components/SessionRows.jsx';
import { ProjectRows } from './components/ProjectRows.jsx';
import { CronRows } from './components/CronRows.jsx';
import { DriversPanel } from './components/DriversPanel.jsx';
import { Lanes } from './components/Lanes.jsx';
import { formatTokens, billingCycleNote, summaryOrDash, arrayFrom, envelopeOf, cronState } from './lib/format.js';

// Polling is every 30s. Three minutes of silence without a fetch error means the
// tab was suspended or the machine slept — the numbers on screen are real but no
// longer current, and the page must say so. Deliberately generous: this compares
// a clock on the viewing device (an iPad, over the tunnel) against a clock on the
// server, and a few seconds of skew must not trip a false alarm.
const STALE_AFTER = 3 * 60 * 1000;

// An ingest feed is expected to write an object. Anything else is a feed we
// cannot read: never spread into the UI, never silently treated as empty.
const objectFrom = envelope => {
  const data = envelope?.data;
  if (data === null || data === undefined) return { value: null, invalid: false };
  if (typeof data === 'object' && !Array.isArray(data)) return { value: data, invalid: false };
  return { value: null, invalid: true };
};

export default function App() {
  const { payload, error, receivedAt } = useDashboard();
  const now = useTick(1000);

  const configEnv = payload?.config;
  const config = configEnv?.data;
  const threshold = config?.warnThreshold ?? 85;

  // The payload is only as fresh as the moment the server built it. Take the
  // worse of "how old the server said it was" and "how long since it arrived
  // here", so neither a slept tab nor a cached response passes as live.
  const ageMs = payload
    ? Math.max(0, now - (payload.serverTime ?? receivedAt ?? now), now - (receivedAt ?? now))
    : null;
  const pageStale = !error && ageMs !== null && ageMs > STALE_AFTER;

  const usageEnv = payload?.usage;
  const limits = Array.isArray(usageEnv?.data?.limits) ? usageEnv.data.limits : [];

  const sessionsEnv = payload?.sessions;
  const sessionData = sessionsEnv?.data;
  const incomplete = (
    <IncompleteNote
      roots={sessionData?.unavailableRoots}
      paths={sessionData?.unreadablePaths}
      what="these totals"
    />
  );

  // Projects: session-derived plus anything ingested. `running` that is neither
  // true nor false means the agents source could not be read — which is not the
  // same fact as "idle", and must not be summarised as one.
  const ingestProjects = arrayFrom(payload?.ingestProjects);
  const sessionProjects = Array.isArray(sessionData?.projects) ? sessionData.projects : [];
  const projects = [...sessionProjects, ...ingestProjects.items];
  const runningUnknown = projects.some(p => p.running !== true && p.running !== false);
  const projectSummary = runningUnknown
    ? `${projects.length} total · running unknown`
    : `${projects.filter(p => p.running).length} running · ${projects.length} total`;

  const cronsEnv = payload?.crons;
  const launchdCrons = arrayFrom(cronsEnv);
  const ingestCrons = arrayFrom(payload?.ingestCrons);
  const crons = [...launchdCrons.items, ...ingestCrons.items]
    .sort((a, b) => (a.ok === b.ok ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) : a.ok ? 1 : -1));
  // `!c.ok` counted a cron whose state is unknown as a confirmed failure. And a
  // total that silently includes unknown-state jobs overstates what "N failing"
  // was checked against, so the unknowns are named — the counterpart of the
  // projects column's "running unknown".
  const cronUnknown = crons.filter(c => cronState(c) === 'unknown').length;
  const cronSummary = `${crons.filter(c => c.ok === false).length} failing · ${crons.length} scheduled`
    + (cronUnknown > 0 ? ` · ${cronUnknown} unknown` : '');

  // Credits: ingest wins over config once it has actually reported. A feed that
  // carries no updatedAt of its own is dated by when it arrived, so the
  // staleness line is neither blank nor invented.
  const ingestCredits = objectFrom(payload?.ingestCredits);
  const credits = ingestCredits.value
    ? {
      updatedAt: payload?.ingestCredits?.fetchedAt
        ? new Date(payload.ingestCredits.fetchedAt).toISOString().slice(0, 10)
        : null,
      ...ingestCredits.value
    }
    : (config?.credits ?? null);
  const creditsEnv = ingestCredits.value
    ? payload.ingestCredits
    : (credits
      ? configEnv
      : (payload
        ? {
          status: 'unavailable',
          fetchedAt: null,
          // A malformed feed is not "nothing ingested": say which it was, since
          // the Panel hides its note (and children) while unavailable.
          error: configEnv?.error ?? (ingestCredits.invalid
            ? 'the ingested credits feed is not an object, and config.json has no credits'
            : 'no credits in config.json and nothing ingested')
        }
        : undefined));

  // Tier comes from the `plan` envelope (the API), never from config — a
  // stale-but-real tier beats a hand-typed guess. Price, by contrast, has no
  // API source at all, so it stays config-fed and PlanBlock omits it
  // entirely when config doesn't supply one.
  const planEnv = payload?.plan;
  const planTier = planEnv?.data?.tier;

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 64 }}>
      <Header usage={usageEnv} now={now} />
      <ConnectionBar
        error={error}
        capturedAt={payload ? (payload.serverTime ?? receivedAt) : null}
        ageMs={pageStale ? ageMs : null}
      />
      <AlertBar alerts={payload?.alerts} />
      <div className="ccr-grid">
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head">
            <h2>01&nbsp;&nbsp;Usage</h2>
            <span>{billingCycleNote(config?.plan?.nextRenewal, now)}</span>
          </div>
          {planEnv?.status === 'ok' && planTier
            ? (
              <PlanBlock
                tier={planTier}
                price={config?.plan?.price}
                renews={config?.plan?.nextRenewal}
                seats={config?.plan?.seats}
              />
            )
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="section-label">Plan</div>
                <StatusNote {...envelopeOf(planEnv)} />
              </div>
            )}
          <Panel label="Credits" envelope={creditsEnv} note={ingestCredits.invalid && (
            <StatusNote status="stale" fetchedAt={null} label="Feed ignored"
              detail="the ingested credits feed is not an object, so the figures below come from config.json" />
          )}>
            <CreditsPanel credits={credits} threshold={threshold} now={now} />
          </Panel>
          <Panel label="Against limits now" envelope={usageEnv}>
            <LimitBars limits={limits} threshold={threshold} now={now}
                       historyStatus={usageEnv?.data?.history ?? null} />
          </Panel>
          <Panel label="By surface · this week" envelope={sessionsEnv} note={incomplete}>
            <StackedBar segments={(sessionData?.bySurface ?? []).map(s => ({
              ...s, display: s.measurable ? formatTokens(s.tokens) : null
            }))} />
          </Panel>
          <Panel label="By project · this week" envelope={sessionsEnv} note={incomplete}>
            <StackedBar segments={(sessionData?.byProject ?? []).map(p => ({
              ...p, display: formatTokens(p.tokens)
            }))} />
          </Panel>
          <Panel label="By model · this week" envelope={sessionsEnv} note={incomplete}>
            <ModelRows models={sessionData?.byModel ?? []} />
          </Panel>
          <Panel label="Recent sessions" envelope={sessionsEnv} note={incomplete}>
            <SessionRows sessions={sessionData?.recentSessions ?? []} threshold={threshold} />
          </Panel>
          <Panel label="What's driving usage · last 7d" envelope={usageEnv}>
            <DriversPanel factors={payload?.usage?.data?.factors} window="7d" />
          </Panel>
        </section>
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head">
            <h2>02&nbsp;&nbsp;Projects</h2>
            <span className="num">{summaryOrDash(sessionsEnv, projectSummary)}</span>
          </div>
          <StatusNote {...envelopeOf(sessionsEnv)} />
          {incomplete}
          {ingestProjects.invalid && (
            <StatusNote status="stale" fetchedAt={null} label="Feed ignored"
              detail="the ingested projects feed is not a list" />
          )}
          {runningUnknown && projects.length > 0 && (
            <StatusNote status="stale" fetchedAt={null} label="Running state unknown"
              detail="the running agents could not be read, so no project below is claimed idle" />
          )}
          <ProjectRows projects={projects} />
          <div className="ccr-subhead">
            <h3>Scheduled crons</h3>
            <span className="num">{summaryOrDash(cronsEnv, cronSummary)}</span>
          </div>
          <StatusNote {...envelopeOf(cronsEnv)} />
          {(launchdCrons.invalid || ingestCrons.invalid) && (
            <StatusNote status="stale" fetchedAt={null} label="Feed ignored"
              detail="a cron feed is not a list" />
          )}
          {cronUnknown > 0 && (
            <StatusNote status="stale" fetchedAt={null} label="Result unknown"
              detail={`${cronUnknown} ingested cron${cronUnknown === 1 ? '' : 's'} reported no result, so ${cronUnknown === 1 ? 'it is' : 'they are'} neither failing nor OK`} />
          )}
          {crons.length > 0 && <CronRows crons={crons} now={now} />}
        </section>
        <section className="ccr-col">
          <div className="ccr-col-head"><h2>03&nbsp;&nbsp;Ideas &amp; to-dos</h2><span>Saved on the mini</span></div>
          <Lanes />
        </section>
      </div>
    </div>
  );
}
