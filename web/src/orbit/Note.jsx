// A panel whose source is missing, failed, or not sent by the server that is
// running says so, in place of figures.
export function Note({ children, dark = false }) {
  return <p className={`o-note${dark ? ' o-note-dark' : ''}`}>{children}</p>;
}
