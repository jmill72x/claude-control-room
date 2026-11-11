// The Now chip in the band (docs/design/2026-11-10-jarvis-os-home.md, §5.1): the
// lead's session and the model it runs on, who is working this minute, and the
// next scheduled job. Plain functions over the payload the page already has,
// checked by web/test/orbit-now.test.js.
import { ago, clock, compactTokens, agentColors } from './page.js';
import { FAMILY_NAMES } from './overview.js';
import { agentOf } from './board.js';
import { envelopeOf } from '../format.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
// An agent whose last request was this recent is working now.
export const WORKING_MS = 5 * MIN;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "4 m", "18 m", "2 h": a short age for the chip's one line.
export const shortAgo = ms => {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
};

// "up 3 d", "up 5 h", "up 12 m" from the session's start.
export const upFor = (startedAt, now) => {
  if (!Number.isFinite(startedAt)) return null;
  const ms = Math.max(0, now - startedAt);
  if (ms >= DAY) return `up ${Math.floor(ms / DAY)} d`;
  if (ms >= HOUR) return `up ${Math.floor(ms / HOUR)} h`;
  return `up ${Math.floor(ms / MIN)} m`;
};

const modelName = family => (family ? FAMILY_NAMES[family] ?? 'Other' : null);

// The lead's part: its name, whether its session is up (from the health panel's
// session service), the model its latest request used (from agentWork), and since
// when. Without a health panel the session's state is unknown, never "down".
export function leadNow({ health, work, roster, now }) {
  const lead = roster?.agents?.[0] ?? null;
  if (!lead) return null;
  const session = (Array.isArray(health?.data?.services) ? health.data.services : []).find(s => s?.kind === 'session') ?? null;
  const state = session ? session.state : 'unknown';
  const parts = [lead.name];
  const model = modelName(work?.leadModel);
  if (model) parts.push(model);
  if (state === 'up') parts.push(upFor(session.startedAt, now) ?? 'up');
  else if (state === 'down') parts.push('down');
  else parts.push('state unknown');
  return { name: lead.name, model, state, startedAt: session?.startedAt ?? null, lastRequest: Number.isFinite(work?.leadLast) ? work.leadLast : null, text: parts.join(' · ') };
}

// The agents at work: one entry per agent with a run whose last request is within
// five minutes, most recent first, with that run's task and tokens. The lead's
// helpers count as the lead at work.
export function workingNow({ work, roster, now }) {
  const runs = Array.isArray(work?.runs) ? work.runs : [];
  const latest = new Map();
  for (const r of runs) {
    if (!Number.isFinite(r?.last) || now - r.last > WORKING_MS || now - r.last < -MIN) continue;
    const agent = agentOf(r.agent, roster);
    if (!agent) continue;
    const have = latest.get(agent.key);
    if (!have || r.last > have.run.last) latest.set(agent.key, { agent, run: r });
  }
  return [...latest.values()]
    .sort((a, b) => b.run.last - a.run.last)
    .map(({ agent, run }) => ({
      key: agent.key, name: agent.name, index: agent.index, color: agentColors(agent.index).day,
      since: shortAgo(now - run.last), startedAgo: ago(now - run.start),
      task: run.task ?? (run.helper ? `${agent.name} helper` : 'Direct run'),
      model: modelName(run.model), tokens: compactTokens(run.tokens)
    }));
}

// The next calendar job: its name from config's `jobs` and its time, today's clock
// or the weekday's. Interval jobs have no `nextRunAt` and never appear.
export function nextJob({ crons, jobs, now }) {
  let best = null;
  for (const c of Array.isArray(crons) ? crons : []) {
    if (!Number.isFinite(c?.nextRunAt) || c.nextRunAt <= now) continue;
    if (!best || c.nextRunAt < best.t) best = { t: c.nextRunAt, name: jobs?.[c.label]?.name ?? c.name ?? c.label };
  }
  if (!best) return null;
  const d = new Date(best.t);
  const today = new Date(now);
  const at = d.toDateString() === today.toDateString() ? clock(best.t) : `${WEEKDAYS[d.getDay()]} ${clock(best.t)}`;
  return { ...best, at, text: `next ${at} ${best.name}` };
}

// The chip's line: "Jarvis · Fable · up 3 d · 2 working: Pepper 4 m, Vision 18 m ·
// next 4:45 PM Friday alert". Null when there is no roster (nothing to say).
export function nowChip({ health, work, crons, jobs, roster, now }) {
  const lead = leadNow({ health, work, roster, now });
  if (!lead) return null;
  const working = workingNow({ work, roster, now });
  const next = nextJob({ crons, jobs, now });
  const parts = [lead.text];
  if (working.length > 0) parts.push(`${working.length} working: ${working.map(w => `${w.name} ${w.since}`).join(', ')}`);
  else parts.push('nobody working');
  if (next) parts.push(next.text);
  const tone = lead.state === 'down' ? 'bad' : working.length > 0 ? 'ok' : 'idle';
  return { lead, working, next, text: parts.join(' · '), tone, count: working.length };
}

// The chip from the whole payload: the health panel, the sessions panel's
// agentWork, the crons panel and config's job names.
export function nowFromPayload({ payload, roster, now }) {
  const sessions = envelopeOf(payload?.sessions);
  const crons = envelopeOf(payload?.crons);
  return nowChip({ health: payload?.health, work: sessions.data?.agentWork ?? null, crons: crons.data, jobs: payload?.config?.data?.jobs ?? {}, roster, now });
}

// What the chip opens: one row per working agent with its task and tokens, then
// the lead's model and last request, then the next job.
export function nowDetail(chip, now) {
  if (!chip) return null;
  const rows = chip.working.map(w => ({
    name: w.name, when: w.task, state: `${w.since} ago · ${w.tokens} tokens${w.model ? ` · ${w.model}` : ''}`, tone: 'ok', color: w.color
  }));
  if (rows.length === 0) rows.push({ name: 'Working', when: 'no agent has made a request in the last 5 minutes', state: 'nobody', tone: 'idle' });
  const lastReq = Number.isFinite(chip.lead.lastRequest) ? `last request ${ago(now - chip.lead.lastRequest)}` : 'no request on record this week';
  rows.push({ name: chip.lead.name, when: lastReq, state: chip.lead.model ? `on ${chip.lead.model}` : 'model unknown', tone: chip.lead.state === 'down' ? 'bad' : 'idle' });
  if (chip.next) rows.push({ name: 'Next', when: chip.next.name, state: chip.next.at, tone: 'idle' });
  return { title: 'Now', note: 'from the transcripts and the schedules; working means a request in the last 5 minutes', rows };
}
