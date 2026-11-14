// Live agents, on the Overview under Usage limits (war room slice 1): the agent
// runs going right now, from the `liveAgents` block in the sessions panel. Read-only:
// no button here changes anything. The logic is in src/lib/orbit/live.js.
import { envelopeOf } from '../lib/format.js';
import { liveRows, liveSummary } from '../lib/orbit/live.js';
import { unavailable, PARTIAL } from '../lib/orbit/page.js';
import { Avatar } from './Avatar.jsx';
import { Note } from './Note.jsx';

export function LiveAgents({ payload, now, roster }) {
  const env = envelopeOf(payload?.sessions);
  const live = env.data?.liveAgents ?? null;
  const partial = (env.data?.unreadablePaths?.length ?? 0) > 0;
  const rows = live ? liveRows({ live, roster, now }) : [];
  let note = null;
  if (env.status === 'unavailable' && !live) note = unavailable(env);
  else if (env.data && !live) note = 'The server running now does not send live agents. They arrive with its next restart.';
  else if (!env.data) note = 'Nothing to show yet.';
  else if (rows.length === 0) note = 'No agents running.';
  return (
    <section aria-labelledby="o-live" className="o-panel o-live">
      <div className="o-panel-head o-panel-head-base">
        <h2 id="o-live" className="o-h2 o-h2-day">Live agents</h2>
        {live && <span className="o-sub">{liveSummary(live)} · each minute</span>}
      </div>
      {note ? <Note>{note}</Note> : (
        <ul className="o-live-list">
          {rows.map(r => (
            <li key={r.key} className="o-live-row">
              <Avatar agent={r.agent} size={32} />
              <div className="o-live-body">
                <p className="o-live-top">
                  <b className="o-live-name">{r.name}</b>
                  {r.model && <span className="o-live-model">{r.model}</span>}
                  <span className="o-mono o-live-for">{r.running}</span>
                </p>
                <p className="o-live-task">{r.task}</p>
                <p className="o-live-meta">
                  {[r.tokens, r.session].filter(Boolean).join(' · ')}
                  {r.quiet && <span className="o-live-quiet">{r.quiet}</span>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {live && partial && <Note>{PARTIAL}</Note>}
    </section>
  );
}
