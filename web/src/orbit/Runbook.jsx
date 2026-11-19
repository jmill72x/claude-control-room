import { RUNBOOK_URL, RUNBOOK_LABEL } from '../lib/orbit/runbook.js';

// A link to "Bring Jarvis Back" (lib/orbit/runbook.js holds the address), opened in
// a new tab: the run sheet is a claude.ai page, and this one stays where it was.
// `className` styles it for where it sits; the words are always the run sheet's name.
export function RunbookLink({ className = 'o-runbook-link', role, onClick }) {
  return (
    <a className={className} href={RUNBOOK_URL} target="_blank" rel="noopener noreferrer" role={role} onClick={onClick}
      aria-label={`${RUNBOOK_LABEL}, the run sheet (opens in a new tab)`}>
      {RUNBOOK_LABEL}<span className="o-runbook-arrow" aria-hidden="true">↗</span>
    </a>
  );
}

// The home screen's foot: always there, quiet, for when Jarvis is gone but nothing
// on this page has noticed yet.
export function RunbookFoot() {
  return (
    <p className="o-runbook-foot">
      Jarvis down? <RunbookLink />
    </p>
  );
}
