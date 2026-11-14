import { unavailable } from '../lib/orbit/page.js';
import { Note } from './Note.jsx';

// Today's routines (docs/design/2026-11-10-jarvis-os-home.md, §5.4): the calendar
// jobs due today with their verdicts, then the next one. Since 2026-11-14 (board
// f74ca819) it is the top of the Today's schedule card (Overview.jsx), which draws the
// heading and the summary; this draws the list. The logic is in
// src/lib/orbit/routines.js; the data is the crons panel the Scheduled lane draws.
export function RoutinesList({ crons, view }) {
  return (
    <>
      {crons.status === 'unavailable' ? <Note>Scheduled jobs: {unavailable(crons)}</Note> : (
        <ol className="o-routine-list" aria-label="Today's scheduled jobs">
          {view.rows.map(r => (
            <li key={r.key} className={`o-routine o-tone-${r.tone}`}>
              <span className="o-routine-mark" aria-hidden="true">{r.verdict === 'ran' ? '✓' : r.verdict === 'missed' ? '✕' : '○'}</span>
              <span className="o-mono o-routine-time">{r.time}</span>
              <span className="o-routine-name">{r.name}</span>
              <span className="o-mono o-routine-word">{r.word}</span>
            </li>
          ))}
          {view.rows.length === 0 && <li className="o-routine o-routine-none">No calendar job runs today.</li>}
          {view.next && <li className="o-routine o-routine-next"><span className="o-routine-mark" aria-hidden="true">·</span><span className="o-mono o-routine-time">next</span><span className="o-routine-name">{view.next.text}</span></li>}
        </ol>
      )}
      {crons.status === 'stale' && <Note>From an earlier reading: {crons.error ?? 'the last poll failed'}.</Note>}
    </>
  );
}
