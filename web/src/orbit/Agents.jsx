// The agent views on the Overview: the agent work map, Today agent by agent and
// Latest runs, from the `agentWork` block in the sessions panel. The logic is
// in src/lib/orbit/agents.js.
import { useEffect, useRef } from 'react';
import { envelopeOf } from '../lib/format.js';
import { mapView, todayView, latestRuns, MAP } from '../lib/orbit/agents.js';
import { Avatar } from './Avatar.jsx';
import { Note } from './Note.jsx';
import { unavailable, PARTIAL } from '../lib/orbit/page.js';
import { useReducedMotion } from './useReducedMotion.js';

const REQUEST = '#FF7A45';
const RESULT = '#3FCB82';

function workOf(payload) {
  const env = envelopeOf(payload?.sessions);
  return { env, work: env.data?.agentWork ?? null, partial: (env.data?.unreadablePaths?.length ?? 0) > 0 };
}

// Why a panel has nothing to draw: its source is down, the server running now
// predates these views, or config lists no agents for runs to belong to.
function whyNot(env, work, roster) {
  if (env.status === 'unavailable') return unavailable(env);
  if (!work) return 'The server running now does not send agent runs. They arrive with its next restart.';
  if (!(roster?.agents?.length > 0) || !work.lead) return 'No agents are listed in config, so no run has anyone to belong to.';
  return 'Nothing to show yet.';
}

const listOf = names => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---- the agent work map ----

export function AgentMap({ payload, now, roster }) {
  const { env, work, partial } = workOf(payload);
  const view = mapView({ work, roster, now });
  const reduced = useReducedMotion();
  const label = view && [
    `${view.lead.name} at the centre, with ${view.lead.runs} run${view.lead.runs === 1 ? '' : 's'} today across the team, and ${view.nodes.length} agent${view.nodes.length === 1 ? '' : 's'} around: `,
    view.nodes.map(n => `${n.name}, ${n.runs} today`).join('; '),
    '. Each node is sized by its tokens over 7 days. ',
    view.activeNames.length ? `Pulses run to those that worked in the last hour: ${listOf(view.activeNames)}.` : 'None worked in the last hour.'
  ].join('');
  const active = view ? view.nodes.filter(n => n.active) : [];

  return (
    <section aria-labelledby="o-map" className="o-panel o-panel-dark o-map">
      <div className="o-panel-head">
        <h2 id="o-map" className="o-h2">Agent work map</h2>
        <div className="o-map-legend">
          <span><span className="o-legend-dot" style={{ background: REQUEST }} aria-hidden="true" />request</span>
          <span><span className="o-legend-dot" style={{ background: RESULT }} aria-hidden="true" />checked result</span>
        </div>
      </div>
      {!view ? <Note dark>{whyNot(env, work, roster)}</Note> : (
        <>
          <div className="o-map-box">
            <svg viewBox="0 0 100 100" role="img" aria-label={label} className="o-map-svg">
              <circle cx={MAP.cx} cy={MAP.cy} r={MAP.r} className="o-map-orbit" />
              {view.nodes.map(n => (
                <line key={`l-${n.key}`} x1={MAP.cx} y1={MAP.cy} x2={n.x.toFixed(2)} y2={n.y.toFixed(2)} className={`o-map-line${n.active ? ' o-map-line-on' : ''}`} />
              ))}
              {!reduced && active.map((n, i) => {
                const to = `${(n.x - MAP.cx).toFixed(2)},${(n.y - MAP.cy).toFixed(2)}`;
                const begin = ((i * 0.9) % 2.6).toFixed(1);
                const back = (((i * 0.9) % 2.6) + 1.3).toFixed(1);
                return (
                  <g key={`p-${n.key}`}>
                    <circle cx={MAP.cx} cy={MAP.cy} r="1.3" fill={REQUEST} opacity="0">
                      <animateMotion path={`M0,0 L${to}`} dur="2.6s" begin={`${begin}s`} repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.8;1" dur="2.6s" begin={`${begin}s`} repeatCount="indefinite" />
                    </circle>
                    <circle cx={MAP.cx} cy={MAP.cy} r="1.3" fill={RESULT} opacity="0">
                      <animateMotion path={`M${to} L0,0`} dur="2.6s" begin={`${back}s`} repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.8;1" dur="2.6s" begin={`${back}s`} repeatCount="indefinite" />
                    </circle>
                  </g>
                );
              })}
            </svg>
            {view.nodes.map(n => (
              <div key={n.key} className="o-map-node" aria-hidden="true"
                style={{ left: `${n.x.toFixed(2)}%`, top: `${n.y.toFixed(2)}%`, width: `${n.size.toFixed(2)}%`, height: `${n.size.toFixed(2)}%`, '--agent': n.color }}>
                {n.active && <span className="o-map-ping" />}
                <Avatar agent={n} size="100%" tone="night" />
                <span className="o-map-badge">{n.runs}</span>
                <span className="o-map-name">{n.name}</span>
              </div>
            ))}
            <div className="o-map-node o-map-lead" aria-hidden="true"
              style={{ left: `${MAP.cx}%`, top: `${MAP.cy}%`, width: `${MAP.lead}%`, height: `${MAP.lead}%`, '--agent': view.lead.color }}>
              <Avatar agent={view.lead} size="100%" tone="night" />
              <span className="o-map-badge">{view.lead.runs}</span>
              <span className="o-map-name">{view.lead.name}</span>
            </div>
          </div>
          <span className="o-map-caption">size = tokens, 7 days · badge = runs today</span>
          {partial && <Note dark>{PARTIAL}</Note>}
        </>
      )}
    </section>
  );
}

// ---- Today, agent by agent ----

const ClockIcon = () => (
  <span className="o-today-clock" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4E5872" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  </span>
);

const laneLabel = l => {
  const what = l.scheduled ? `${l.count} due so far today` : `${l.count} run${l.count === 1 ? '' : 's'} today`;
  return `${l.name}: ${what}${l.marks.length ? `: ${l.marks.map(m => m.title).join('; ')}` : ''}${l.note ? `. ${l.note}` : ''}`;
};

export function TodayByAgent({ payload, now, roster }) {
  const { env, work, partial } = workOf(payload);
  const view = todayView({ work, roster, crons: envelopeOf(payload?.crons).data, jobs: payload?.config?.data?.jobs ?? {}, now });
  // Where the lanes scroll sideways (a phone), they open with "now" three
  // quarters of the way across, since that is where today's runs are. Once,
  // when they first appear, so it never fights the viewer's own scrolling.
  const scroller = useRef(null);
  const placed = useRef(false);
  const nowLeft = view?.nowLeft;
  useEffect(() => {
    const el = scroller.current;
    if (!el || placed.current || !nowLeft) return;
    placed.current = true;
    const names = el.querySelector('.o-today-row > :first-child')?.getBoundingClientRect().width ?? 0;
    const track = el.scrollWidth - names;
    el.scrollLeft = Math.max(0, (parseFloat(nowLeft) / 100) * track - 0.75 * (el.clientWidth - names));
  }, [nowLeft]);
  return (
    <section aria-labelledby="o-day" className="o-panel">
      <div className="o-panel-head o-panel-head-base">
        <h2 id="o-day" className="o-h2 o-h2-day">Today, agent by agent</h2>
        {view && <span className="o-sub">{view.total} run{view.total === 1 ? '' : 's'} · dot size = tokens · now {view.nowLabel}</span>}
      </div>
      {!view ? <Note>{whyNot(env, work, roster)}</Note> : (
        <div className="o-scroll-x" ref={scroller}>
          <div className="o-today">
            <div className="o-today-row o-today-axis" aria-hidden="true">
              <span />
              <div className="o-today-hours">
                {view.hours.map(h => <span key={h.left} className={`o-mono o-hour-${h.align}`} style={{ left: h.left }}>{h.label}</span>)}
              </div>
            </div>
            {view.lanes.map(l => (
              <div key={l.key} className="o-today-row">
                <span className="o-today-name">
                  {l.scheduled ? <ClockIcon /> : <Avatar agent={l.agent} size="var(--lane-avatar)" />}
                  <span className="o-today-label">{l.name}</span>
                  <span className="o-mono o-today-count">{l.count}</span>
                </span>
                <div className="o-today-track" role="img" aria-label={laneLabel(l)}>
                  {l.marks.map((m, i) => (
                    <span key={i} title={m.title} className={`o-today-mark${l.scheduled ? ' o-today-sched' : ''}`}
                      style={{ left: m.left, width: m.d, height: m.d, borderColor: l.color, background: m.hollow ? 'transparent' : l.scheduled ? l.color : `${l.color}33` }} />
                  ))}
                  {l.note && <span className="o-today-note">{l.note}</span>}
                  <span className="o-today-now" style={{ left: view.nowLeft }} aria-hidden="true" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {view && partial && <Note>{PARTIAL}</Note>}
    </section>
  );
}

// ---- Latest runs ----

export function LatestRuns({ payload, now, roster }) {
  const { env, work, partial } = workOf(payload);
  const ok = Boolean(work && work.lead && roster?.agents?.length > 0);
  const rows = ok ? latestRuns({ work, roster, now }) : [];
  return (
    <section aria-labelledby="o-latest" className="o-panel">
      <div className="o-panel-head o-panel-head-base">
        <h2 id="o-latest" className="o-h2 o-h2-day">Latest runs</h2>
        <span className="o-sub">the 10 most recent · tokens per run</span>
      </div>
      {!ok ? <Note>{whyNot(env, work, roster)}</Note> : rows.length === 0 ? <Note>No runs in the last 7 days.</Note> : (
        <ol className="o-latest">
          {rows.map(r => (
            <li key={r.key}>
              <span className="o-mono o-latest-time">{r.day && <span>{r.day}</span>}<span>{r.time}</span></span>
              <span className="o-latest-what">
                <Avatar agent={r.agent} size={24} />
                <span className="o-latest-text"><b>{r.name}</b> · {r.task}</span>
              </span>
              <span className="o-mono o-latest-tok">{r.tokens}</span>
            </li>
          ))}
        </ol>
      )}
      {ok && partial && <Note>{PARTIAL}</Note>}
    </section>
  );
}
