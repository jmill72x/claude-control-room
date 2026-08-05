import './styles/tokens.css';
import './styles/app.css';
import { useDashboard } from './hooks/useDashboard.js';
import { useTick } from './hooks/useTick.js';
import { Header } from './components/Header.jsx';
import { AlertBar } from './components/AlertBar.jsx';
import { Panel } from './components/Panel.jsx';
import { PlanBlock } from './components/PlanBlock.jsx';
import { CreditsPanel } from './components/CreditsPanel.jsx';
import { LimitBars } from './components/LimitBars.jsx';
import { StackedBar } from './components/StackedBar.jsx';
import { ModelRows } from './components/ModelRows.jsx';
import { SessionRows } from './components/SessionRows.jsx';
import { formatTokens } from './lib/format.js';

export default function App() {
  const { payload } = useDashboard();
  const now = useTick(1000);
  const config = payload?.config?.data;
  const threshold = config?.warnThreshold ?? 85;

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 64 }}>
      <Header usage={payload?.usage} now={now} />
      <AlertBar alerts={payload?.alerts} />
      <div className="ccr-grid">
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head">
            <h2>01&nbsp;&nbsp;Usage</h2>
            <span>{config?.plan?.renews ? `Renews ${config.plan.renews}` : ''}</span>
          </div>
          <PlanBlock plan={config?.plan} />
          <Panel label="Credits">
            <CreditsPanel credits={config?.credits} threshold={threshold} now={now} />
          </Panel>
          <Panel label="Against limits now" envelope={payload?.usage}>
            <LimitBars limits={payload?.usage?.data?.limits ?? []} threshold={threshold} now={now} />
          </Panel>
          <Panel label="By surface · this week" envelope={payload?.sessions}>
            <StackedBar segments={(payload?.sessions?.data?.bySurface ?? []).map(s => ({
              ...s, display: s.measurable ? formatTokens(s.tokens) : null
            }))} />
          </Panel>
          <Panel label="By project · this week" envelope={payload?.sessions}>
            <StackedBar segments={(payload?.sessions?.data?.byProject ?? []).map(p => ({
              ...p, display: formatTokens(p.tokens)
            }))} />
          </Panel>
          <Panel label="By model · this week" envelope={payload?.sessions}>
            <ModelRows models={payload?.sessions?.data?.byModel ?? []} />
          </Panel>
          <Panel label="Recent sessions" envelope={payload?.sessions}>
            <SessionRows sessions={payload?.sessions?.data?.recentSessions ?? []} threshold={threshold} />
          </Panel>
        </section>
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head"><h2>02&nbsp;&nbsp;Projects</h2><span /></div>
        </section>
        <section className="ccr-col">
          <div className="ccr-col-head"><h2>03&nbsp;&nbsp;Ideas &amp; to-dos</h2><span>Saved on this device</span></div>
        </section>
      </div>
    </div>
  );
}
