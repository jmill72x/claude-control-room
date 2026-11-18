import { Component } from 'react';

// A render throw anywhere below this (a malformed ingest feed, a board body that
// is not a list, any shape the server was not supposed to be able to produce)
// would otherwise unmount the whole document and leave a white page that looks
// like a dead machine. A blank page is the worst failure for a dashboard: it says
// nothing at all. So the page says it failed, shows the error and offers a reload.
//
// It is drawn with the Orbit page's own classes (orbit.css). Until the classic
// page was removed (2026-11-18) this file used that page's tokens, which the
// Orbit page never defined: the Reload button came out navy on navy.
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
      <div className="o-wrap o-main" role="alert">
        <section className="o-panel o-crash">
          <h1 className="o-crash-title">Control Room</h1>
          <h2 className="o-h2 o-h2-accent">Page failed to render</h2>
          <p className="o-note">
            The page could not draw itself, so none of the figures it would have shown are
            on screen. Nothing here is old data passed off as current: there is no data
            here at all. Reload the page. If it fails again, the server is sending
            something this build cannot read.
          </p>
          <pre className="o-mono o-crash-error">{String(this.state.error?.message ?? this.state.error)}</pre>
          <button type="button" className="o-btn o-btn-solid o-crash-reload" onClick={() => window.location.reload()}>Reload</button>
        </section>
      </div>
    );
  }
}
