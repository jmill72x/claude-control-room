import { Component } from 'react';

// A render throw anywhere below this — a malformed ingest feed, a non-array
// to-do body, any shape the server was not supposed to be able to produce —
// used to unmount the whole document and leave a white page that looked like a
// dead machine and stayed dead until the service was restarted. A blank page is
// the worst possible failure mode for a dashboard: it says nothing at all.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('control room render failure', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 'var(--s6)', display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}>
        <div style={{ borderBottom: 'var(--rule-strong)', paddingBottom: 'var(--s3)' }}>
          <div className="eyebrow">Anthropic account snapshot</div>
          <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Control Room
          </h1>
        </div>
        <div style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--accent)'
        }}>
          Page failed to render
        </div>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, maxWidth: '60ch', lineHeight: 1.5 }}>
          The dashboard could not draw itself, so none of the figures it would have shown
          are on screen. Nothing here is stale data pretending to be live — there is no
          data here at all. Reload the page; if it fails again the server is returning
          something this build cannot read.
        </p>
        <pre className="num" style={{
          margin: 0, padding: 'var(--s3)', background: 'var(--surface)',
          border: 'var(--rule-fine)', fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto'
        }}>{String(this.state.error?.message ?? this.state.error)}</pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            fontFamily: 'inherit', fontSize: 12, fontWeight: 800, letterSpacing: '0.08em',
            textTransform: 'uppercase', cursor: 'pointer', alignSelf: 'flex-start',
            padding: '8px 14px', background: 'var(--ink)', color: 'var(--ground)', border: 0
          }}
        >Reload</button>
      </div>
    );
  }
}
