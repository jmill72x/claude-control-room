import './styles/tokens.css';
import './styles/app.css';
import { useDashboard } from './hooks/useDashboard.js';
import { useTick } from './hooks/useTick.js';
import { Header } from './components/Header.jsx';
import { AlertBar } from './components/AlertBar.jsx';

export default function App() {
  const { payload } = useDashboard();
  const now = useTick(1000);

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 64 }}>
      <Header usage={payload?.usage} now={now} />
      <AlertBar alerts={payload?.alerts} />
      <div className="ccr-grid">
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head"><h2>01&nbsp;&nbsp;Usage</h2><span /></div>
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
