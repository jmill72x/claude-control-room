import { useEffect, useState } from 'react';
import { envelopeOf } from '../lib/format.js';
import { compactTokens, agentColors, unavailable, PARTIAL } from '../lib/orbit/page.js';
import { agentOf } from '../lib/orbit/board.js';
import {
  ringView, sessionCountdown, next24, burnBars, burnShares, heatRows, SHADES
} from '../lib/orbit/overview.js';
import { routinesView } from '../lib/orbit/routines.js';
import { homeSections, usageFoldLabel, scheduleSub, loopsLine, FOLD_KEYS } from '../lib/orbit/home.js';
import { Note } from './Note.jsx';
import { AgentsCard } from './Agents.jsx';
import { Waiting } from './Waiting.jsx';
import { RoutinesList } from './Routines.jsx';
import { Loops, LoopsFold } from './Loops.jsx';
import { youEvents } from '../lib/orbit/waiting.js';
import { useFold } from './useFold.js';

const DAY = 24 * 3600 * 1000;
const money = v => (Number.isFinite(v) ? `$${Number.isInteger(v) ? v : v.toFixed(2)}` : null);

// ---- Usage: the limits up front, Burn and the week's heat map behind a fold ----

function Usage({ payload, now }) {
  const env = envelopeOf(payload?.usage);
  const limits = Array.isArray(env.data?.limits) ? env.data.limits : [];
  const rings = ringView(limits, now);
  const countdown = sessionCountdown(limits, now);
  // The rings fill once, after the first paint (and not at all with Reduce
  // Motion, which orbit.css handles).
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  const credits = envelopeOf(payload?.accountCredits).data;
  const grants = Array.isArray(credits?.grants) ? credits.grants : [];
  const tier = envelopeOf(payload?.plan).data?.tier ?? null;
  const renews = Date.parse(`${payload?.config?.data?.plan?.nextRenewal ?? ''}T00:00:00`);
  const daysLeft = Number.isFinite(renews) ? Math.max(0, Math.ceil((renews - now) / DAY)) : null;
  const described = rings.map(r => `${r.label} ${r.pctLabel}${r.ghostLabel ? `, ${r.ghostLabel}` : ''}`).join('; ');
  const [more, setMore] = useFold(FOLD_KEYS.usage);
  const { hourly } = hourlyOf(payload);

  return (
    <section aria-labelledby="o-limits" className="o-panel o-panel-dark o-limits">
      <div className="o-panel-head">
        <h2 id="o-limits" className="o-h2">Usage</h2>
        <div className="o-chips">
          {grants.map(g => money(g.remaining) && (
            <span key={g.id ?? g.label} className="o-chip-night" title={g.expiresAt ? `expires ${new Date(g.expiresAt).toLocaleDateString()}` : undefined}>
              {money(g.remaining)} {g.label}
            </span>
          ))}
          {tier && <span className="o-chip-night">{tier}{daysLeft !== null ? ` · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : ''}</span>}
        </div>
      </div>
      {env.status === 'unavailable' && limits.length === 0 ? <Note dark>{unavailable(env)}</Note> : (
        <div className="o-limits-body">
          <div className="o-ring-box">
            <svg viewBox="0 0 200 200" role="img" aria-label={`Limits: ${described}. Faint arcs show where the last window ended.`} className="o-rings">
              <g transform="rotate(-90 100 100)">
                {rings.map(r => <circle key={`t-${r.key}`} cx="100" cy="100" r={r.r} className="o-ring-track" />)}
                {rings.map((r, i) => r.ghost > 0 && (
                  <circle key={`g-${r.key}`} cx="100" cy="100" r={r.r} className="o-arc o-arc-ghost" stroke={r.color}
                    style={{ strokeDasharray: `${drawn ? r.ghost : 0} ${r.circ}`, transitionDelay: `${0.1 + i * 0.1}s` }} />
                ))}
                {rings.map((r, i) => r.arc > 0 && (
                  <circle key={`a-${r.key}`} cx="100" cy="100" r={r.r} className="o-arc" stroke={r.color}
                    style={{ strokeDasharray: `${drawn ? r.arc : 0} ${r.circ}`, transitionDelay: `${1.2 + i * 0.1}s` }} />
                ))}
              </g>
            </svg>
            <div className="o-ring-center">
              <span className="o-mono o-countdown">{countdown ?? '—'}</span>
              <span className="o-mono o-eyebrow-night">{countdown ? 'until the session resets' : 'no session window open'}</span>
            </div>
          </div>
          <div className="o-ring-cols">
            {rings.map(r => (
              <div key={r.key} className="o-ring-col" style={{ borderTopColor: r.color }}>
                <span className="o-big-pct">{r.pctLabel}</span>
                <span className="o-mono o-eyebrow-night">{r.label}</span>
                <span className="o-ring-note">{r.note}{r.ghostLabel && <><br /><span style={{ color: r.color }}>{r.ghostLabel}</span></>}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {env.status === 'stale' && <Note dark>These figures are from an earlier reading: {env.error ?? 'the last poll failed'}.</Note>}
      <button type="button" className="o-fold-toggle o-fold-night" aria-expanded={more} aria-controls="o-usage-more" onClick={() => setMore(!more)}>
        <svg className={`o-wcard-turn${more ? ' o-turned' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        <span>{usageFoldLabel(more, hourly)}</span>
      </button>
      {more && (
        <div id="o-usage-more" className="o-usage-more">
          <Burn payload={payload} />
          <HeatMap payload={payload} />
        </div>
      )}
    </section>
  );
}

// ---- Today's schedule: Today's routines over Next 24 hours, and the loops' line ----

function Schedule({ payload, now, roster, items }) {
  const crons = envelopeOf(payload?.crons);
  const usage = envelopeOf(payload?.usage);
  const routines = routinesView({ crons: crons.data, jobs: payload?.config?.data?.jobs ?? {}, now });
  const { events, ticks } = next24({
    crons: crons.data, limits: usage.data?.limits, jobs: payload?.config?.data?.jobs ?? {}, now, extra: youEvents(items, now)
  });
  const [loopsOpen, setLoopsOpen] = useFold(FOLD_KEYS.loops);
  return (
    <section aria-labelledby="o-schedule" className="o-panel o-schedule">
      <div className="o-panel-head">
        <h2 id="o-schedule" className="o-h2 o-h2-day">Today's schedule</h2>
        <span className="o-sub">{scheduleSub({ routines, events, cronsUnavailable: crons.status === 'unavailable' })}</span>
      </div>
      <RoutinesList crons={crons} view={routines} />
      <NextDay events={events} ticks={ticks} roster={roster} />
      <LoopsFold payload={payload} now={now} line={loopsLine(payload?.loops, now)} open={loopsOpen} onToggle={setLoopsOpen} />
    </section>
  );
}

// Next 24 hours, under the routines: the timeline, as its own panel drew it.
// (The routines above already say when the scheduled jobs can't be read.)
function NextDay({ events, ticks, roster }) {
  const yours = events.filter(e => e.kind === 'you').length;
  const colorOf = e => {
    if (e.kind === 'reset' || e.kind === 'you') return '#C2410C';
    const agent = agentOf(e.owner, roster);
    return agent ? agentColors(agent.index).day : '#4E5872';
  };
  return (
    <div className="o-next">
      <div className="o-panel-head">
        <h3 className="o-mono o-loop-h3">Next 24 hours</h3>
        <span className="o-sub">
          {events.length} thing{events.length === 1 ? '' : 's'}{yours > 0 ? ` · ${yours} of them ${yours === 1 ? 'is' : 'are'} you` : ''}
        </span>
      </div>
      {events.length === 0 ? <Note>Nothing is scheduled in the next 24 hours.</Note> : (
        <div className="o-scroll-x">
          <div className="o-timeline" role="list" aria-label="The next 24 hours, from now">
            <div className="o-timeline-line" aria-hidden="true" />
            {ticks.map(t => <span key={t.label + t.left} className="o-mono o-tick" style={{ left: t.left }} aria-hidden="true">{t.label}</span>)}
            <span className="o-now" aria-hidden="true"><span /></span>
            {events.map(e => (
              <div key={`${e.t}-${e.name}`} role="listitem">
                <span className={`o-event-dot${e.kind === 'you' ? ' o-event-dot-you' : ''}`} aria-hidden="true" style={{ left: e.left, borderColor: colorOf(e) }} />
                <span className={`o-event o-event-${e.row} o-event-${e.align}${e.kind === 'you' ? ' o-event-you' : ''}`} style={{ left: e.left }}>
                  <span className="o-mono o-event-time">{e.at}</span>
                  <span className="o-event-name">{e.name}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Burn and the heat map, inside Usage's fold ----

// The hourly series arrive with the server change in this phase; a server that
// predates it says nothing about them, which is said here rather than drawn as
// an empty chart.
function hourlyOf(payload) {
  const env = envelopeOf(payload?.sessions);
  return { env, hourly: env.data?.hourly ?? null, partial: (env.data?.unreadablePaths?.length ?? 0) > 0 };
}
const NOT_SENT = 'The server running now does not send hourly figures. They arrive with its next restart.';

function Burn({ payload }) {
  const { env, hourly, partial } = hourlyOf(payload);
  const bars = burnBars(hourly?.last24h);
  const shares = burnShares(hourly?.last24h);
  return (
    <div className="o-burn">
      <div className="o-panel-head o-panel-head-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF8A5B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
        <h3 className="o-h2">Burn</h3>
      </div>
      {!hourly ? <Note dark>{env.status === 'unavailable' ? unavailable(env) : NOT_SENT}</Note> : (
        <>
          <div className="o-burn-head">
            <span className="o-burn-big">{compactTokens(hourly.lastHour)}</span>
            <span className="o-sub-night">tokens in the last hour</span>
          </div>
          <div className="o-bars" role="img" aria-label={`Tokens per hour over the last 24 hours, stacked by model: ${shares.families.map(f => `${f.name} ${f.share}`).join(', ') || 'none'}.`}>
            {bars.map((b, i) => (
              <div key={b.start ?? i} className="o-bar">
                {b.segs.length === 0
                  ? <span className="o-bar-stub" />
                  : b.segs.map((s, j) => <span key={s.family} style={{ height: s.h, background: s.color, borderRadius: j === b.segs.length - 1 ? '2px 2px 0 0' : 0 }} />)}
              </div>
            ))}
          </div>
          <div className="o-mono o-bars-axis" aria-hidden="true"><span>24 h ago</span><span>now</span></div>
          <div className="o-shares">
            <div className="o-share-bar" aria-hidden="true">
              {shares.families.map(f => <span key={f.family} style={{ width: f.width, background: f.color }} />)}
            </div>
            <div className="o-share-legend">
              {shares.families.map(f => (
                <span key={f.family}><span className="o-swatch" style={{ background: f.color }} aria-hidden="true" /><b>{f.share}</b> {f.name}</span>
              ))}
              <span>{shares.total > 0 ? `· ${compactTokens(shares.total)} tokens in the last 24 hours` : 'No use in the last 24 hours'}</span>
            </div>
          </div>
          {partial && <Note dark>{PARTIAL}</Note>}
        </>
      )}
    </div>
  );
}

const AXIS = [['12a', '0%'], ['6a', '25%'], ['12p', '50%'], ['6p', '75%'], ['12a', '100%']];

function HeatMap({ payload }) {
  const { env, hourly, partial } = hourlyOf(payload);
  const heat = hourly ? heatRows(hourly.week) : null;
  return (
    <div className="o-inset o-heat">
      <div className="o-panel-head">
        <h3 className="o-h2 o-h2-day">This week, hour by hour</h3>
        {heat && <span className="o-sub"><b className="o-strong">{compactTokens(heat.total)}</b> tokens{heat.peakLabel ? ` · peak ${heat.peakLabel}` : ''}</span>}
      </div>
      {!heat ? <Note>{env.status === 'unavailable' ? unavailable(env) : NOT_SENT}</Note> : (
        <div className="o-heat-grid" role="img" aria-label={`Tokens by hour for today and the six days before it${heat.peakLabel ? `, peaking ${heat.peakLabel}` : ''}. Darker is busier, scaled to the week's busiest hour.`}>
          <div className="o-heat-row o-heat-axis" aria-hidden="true">
            <span />
            <div className="o-mono o-heat-hours">
              {AXIS.map(([label, left], i) => <span key={i} style={{ left }} className={i === 0 ? 'o-first' : i === AXIS.length - 1 ? 'o-last' : ''}>{label}</span>)}
            </div>
            <span />
          </div>
          {heat.rows.map(row => (
            <div key={row.date} className="o-heat-row">
              <span className="o-mono o-heat-day">{row.label}</span>
              <div className="o-heat-cells">
                {row.cells.map(c => <span key={c.hour} className={c.peak ? 'o-peak' : ''} style={{ background: SHADES[c.level] }} />)}
              </div>
              <span className={`o-mono o-heat-total${row.strong ? ' o-strong' : ''}`}>{row.total}</span>
            </div>
          ))}
          <div className="o-mono o-heat-legend" aria-hidden="true">
            <span>less</span>{SHADES.map(s => <span key={s} className="o-heat-key" style={{ background: s }} />)}<span>more</span>
          </div>
        </div>
      )}
      {heat && partial && <Note>{PARTIAL}</Note>}
    </div>
  );
}

// The home screen since 2026-11-14 (board f74ca819): eleven sections became five, in
// the order lib/orbit/home.js gives (homeSections). Needs you; Usage, the limits up
// front with Burn and the week's heat map behind a fold; Today's schedule, the routines
// over Next 24 hours with the loops' line at its foot; one Agents card with tabs Now
// (the live agents and their Stop buttons), Today (the lanes and the work map) and
// Recent (the latest runs); and Loops, only while a loop is open. On an iPad
// Usage and Today's schedule share a row, as Usage limits and Today's routines did.
// Nothing folds by width any more: the tabs and the two folds keep a phone's first
// screens short, and each fold remembers its state per viewer.
export function Overview({ payload, now, roster, board, waiting, setWaiting, onOpenItem, onChanged, agentsTab, setAgentsTab }) {
  const parts = {
    waiting: <Waiting key="waiting" board={board} payload={payload} roster={roster} now={now} state={waiting} setState={setWaiting} onOpenItem={onOpenItem} onChanged={onChanged} />,
    agents: <AgentsCard key="agents" payload={payload} now={now} roster={roster} tab={agentsTab} onTab={setAgentsTab} />,
    usage: (
      <div key="usage" className="o-row">
        <Usage payload={payload} now={now} />
        <Schedule payload={payload} now={now} roster={roster} items={board.todos} />
      </div>
    ),
    schedule: null, // drawn in Usage's row
    loops: <Loops key="loops" payload={payload} now={now} />
  };
  return <main className="o-wrap o-main">{homeSections(payload?.loops).map(k => parts[k])}</main>;
}
