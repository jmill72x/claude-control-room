// The health strip's logic (Orbit plan, Phase 2): the chips under the title and
// the details a chip opens. The server's `health` panel holds the facts
// (server/lib/health.mjs); this turns them into words. Checked by
// web/test/orbit-health.test.js.
import { clock, ago } from './page.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');

// A moment as the strip says it: "1:30 PM" today, "Mon 1:30 PM" this week,
// "10-02 1:30 PM" before that.
export function when(ts, now) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return clock(ts);
  if (now - ts < 6 * 24 * 3600e3) return `${WEEKDAYS[d.getDay()]} ${clock(ts)}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ts)}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- the chips ----

function jobsChip(jobs) {
  if (jobs?.status === 'unset') return { value: 'not set up', tone: 'idle' };
  if (jobs?.status !== 'ok') return { value: 'unknown', tone: 'idle' };
  const list = Array.isArray(jobs.list) ? jobs.list : [];
  if (list.length === 0) return { value: 'none', tone: 'idle' };
  const failed = list.filter(j => j.state === 'failed').length;
  return failed > 0 ? { value: `${failed} failed`, tone: 'bad' } : { value: 'all OK', tone: 'ok' };
}

// This server can't report itself down, so its chip says what the page
// itself sees: answers coming in, late, or none (`fresh` is page.js's
// freshness()).
function selfChip(fresh) {
  if (fresh?.tone === 'down') return { value: 'no answer', tone: 'bad' };
  if (fresh?.tone === 'stale') return { value: 'not current', tone: 'idle' };
  if (fresh?.tone === 'ok') return { value: 'up', tone: 'ok' };
  return { value: '…', tone: 'idle' };
}

function serviceChip(s, fresh) {
  if (s.kind === 'self') return selfChip(fresh);
  if (s.state === 'unknown') return { value: 'unknown', tone: 'idle' };
  if (s.kind === 'launchd') return s.state === 'running' ? { value: 'running', tone: 'ok' } : { value: 'not running', tone: 'bad' };
  if (s.kind === 'pi') return s.state === 'up' ? { value: s.label ?? 'up', tone: 'ok' } : { value: s.label ?? s.state, tone: 'bad' };
  return s.state === 'up' ? { value: 'up', tone: 'ok' } : { value: 'down', tone: 'bad' };
}

// Jobs first, then each service in config's order. No chips at all from a
// server older than the strip (no `health` panel).
export function healthChips(env, fresh) {
  const data = env?.data;
  if (!data) return [];
  const services = Array.isArray(data.services) ? data.services : [];
  return [
    { key: 'jobs', label: 'Jobs', ...jobsChip(data.jobs) },
    ...services.map(s => ({ key: s.key, label: s.name, ...serviceChip(s, fresh) }))
  ];
}

// ---- what a chip opens ----

const JOB_STATE = {
  ok: { state: 'OK', tone: 'ok' },
  new: { state: 'not run yet', tone: 'idle' },
  failed: { state: 'failed', tone: 'bad' }
};

function jobsDetail(jobs) {
  if (jobs?.status === 'unset') return { title: 'Scheduled jobs', note: 'Not set up: config.json names no job-status.', rows: [] };
  if (jobs?.status !== 'ok') return { title: 'Scheduled jobs', note: `Unknown: job-status ${jobs?.error ?? 'has not answered'}.`, rows: [] };
  const list = Array.isArray(jobs.list) ? jobs.list : [];
  const failed = list.filter(j => j.state === 'failed').length;
  const fresh = list.filter(j => j.state === 'new').length;
  const note = [plural(list.length, 'job', 'jobs')];
  if (failed > 0) note.push(`${failed} failed`);
  if (fresh > 0) note.push(`${fresh} ${fresh === 1 ? "hasn't had its" : "haven't had their"} first run yet`);
  return {
    title: 'Scheduled jobs',
    note: note.join(' · '),
    rows: list.map(j => {
      const s = JOB_STATE[j.state] ?? JOB_STATE.failed;
      return {
        name: j.name,
        when: j.schedule ?? 'no schedule',
        state: j.state === 'failed' && j.reason ? `failed: ${j.reason}` : s.state,
        tone: s.tone
      };
    })
  };
}

const TONE = { up: 'ok', running: 'ok', down: 'bad', warning: 'bad', unknown: 'idle' };

function sessionRows(s, now) {
  const rows = [];
  if (s.state === 'up') {
    const others = s.count > 1 ? ` · ${s.count} sessions have this name` : '';
    rows.push({ name: 'Session', when: `running since ${when(s.startedAt, now)}${others}`, state: 'up', tone: 'ok' });
  } else if (s.state === 'down') {
    rows.push({ name: 'Session', when: s.downSince ? `none running since ${when(s.downSince, now)}` : 'none running', state: 'down', tone: 'bad' });
  } else {
    rows.push({ name: 'Session', when: "the process list couldn't be read", state: 'unknown', tone: 'idle' });
  }
  if (s.launcher) {
    const exit = Number.isInteger(s.launcher.lastExit) ? ` · exit ${s.launcher.lastExit}` : '';
    rows.push({ name: 'Launcher', when: 'starts the session, then exits', state: `${s.launcher.state ?? 'unknown'}${exit}`, tone: 'idle' });
  }
  return rows;
}

function selfRows(s, fresh, now) {
  const chip = selfChip(fresh);
  const stop = s.lastStop
    ? (Number.isInteger(s.lastStop.signal) ? `signal ${s.lastStop.signal}${s.lastStop.name ? ` (${s.lastStop.name})` : ''}` : `exit ${s.lastStop.exit}`)
    : 'none on record';
  return [
    { name: 'Server', when: `started ${when(s.startedAt, now)}`, state: chip.value, tone: chip.tone },
    { name: 'Restarts', when: 'since launchd loaded it', state: Number.isInteger(s.runs) ? String(Math.max(0, s.runs - 1)) : 'unknown', tone: 'idle' },
    { name: 'Last stop', when: 'how the run before this one ended', state: stop, tone: 'idle' }
  ];
}

function launchdRows(s, now) {
  if (s.state === 'unknown') return [{ name: 'launchd', when: s.reason ?? 'no reading', state: 'unknown', tone: 'idle' }];
  if (s.state === 'running') return [{ name: 'launchd', when: 'its KeepAlive job', state: 'running', tone: 'ok' }];
  const since = s.downSince ? `not running since ${when(s.downSince, now)}` : 'its KeepAlive job';
  return [{ name: 'launchd', when: since, state: s.launchd ?? 'not running', tone: 'bad' }];
}

function piRows(s, now) {
  const checked = Number.isFinite(s.checkedAt) ? `last ran ${ago(now - s.checkedAt)}` : 'no run on record';
  return [
    { name: 'State', when: s.state === 'unknown' ? (s.why ?? 'no reading') : (s.line ?? ''), state: s.label ?? 'unknown', tone: TONE[s.state] ?? 'idle' },
    { name: 'Watch', when: checked, state: s.state === 'unknown' ? 'not current' : 'current', tone: 'idle' }
  ];
}

const NOTES = {
  session: 'judged by its session alone',
  self: "it can't report itself down: the Updated line turns red when it stops answering",
  launchd: "launchd's state proves the process, not the connection",
  pi: 'from the watch, which pages on every change itself'
};

// The details panel for one chip, or null when the key matches none. When the
// panel's own reading is not current, the note says how old it is.
export function healthDetail(env, key, fresh, now) {
  const data = env?.data;
  if (!data || !key) return null;
  const late = env.status === 'stale' && Number.isFinite(env.fetchedAt) ? `Reading from ${ago(now - env.fetchedAt)} · ` : '';
  if (key === 'jobs') {
    const d = jobsDetail(data.jobs);
    return { ...d, note: `${late}${d.note}` };
  }
  const s = (Array.isArray(data.services) ? data.services : []).find(x => x.key === key);
  if (!s) return null;
  const rows = s.kind === 'session' ? sessionRows(s, now)
    : s.kind === 'self' ? selfRows(s, fresh, now)
      : s.kind === 'launchd' ? launchdRows(s, now)
        : piRows(s, now);
  const note = [s.about, NOTES[s.kind]].filter(Boolean).join(' · ');
  return { title: s.name, note: `${late}${note}`, rows };
}
