// Acknowledging a known miss (docs/design/2026-11-10-jarvis-os-home.md, section 6).
//
// An ack silences ONE instance of ONE condition for a bounded time. It never changes
// a verdict (a job's `ok` stays false, its `state` stays failed) and it never carries
// over to a new failure: it is keyed on the alert's key plus `since`, the instance
// (a cron's `lastRunAt`, a service's `downSince`). When the job runs again and still
// fails, `since` moves, the ack no longer matches, and the alert is red again.
//
// The pure parts live here; acks.mjs beside routes.mjs holds the file. Checked by
// test/acks.test.mjs.
import { UNSAFE_CHARS, UNSAFE_SAYS } from './text.mjs';
import { jobDisplayName } from './health.mjs';
import { oneLine } from './chat-events.mjs';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Ack-able kinds: a failed job and a down service. Never a limit, a projection or
// a credit expiry, which move on their own and would only hide money or a wall.
export const ACKABLE_KINDS = new Set(['cron', 'service']);
// At most this many acks on file; the oldest go first when there are more.
export const ACK_MAX = 50;
// How far ahead an ack may reach, whatever the caller asks.
export const ACK_CAP_MS = 14 * DAY;
// The default for a job with a next run: that run plus this, so if the next run
// doesn't happen either, the alert comes back on its own.
export const ACK_AFTER_NEXT_MS = 2 * HOUR;
// The default for a condition with no next run: an interval job, a down service.
export const ACK_NO_NEXT_MS = 24 * HOUR;
// The page's second choice.
export const ACK_WEEK_MS = 7 * DAY;
// When the failure's instance is unknown (no `since`: a job without the job-status
// overlay, an ingested cron), a new failure can't be told from the acked one, so an
// ack reaches at most this far, whatever is asked (the 2026-11-10 security review).
export const ACK_UNKNOWN_SINCE_CAP_MS = 24 * HOUR;
// job-status rounds a log's age to 0.01 h (36 s) and the server reads it once a
// minute, so a cron's `lastRunAt` can wander by a few tens of seconds between
// polls. Two instances this close are the same run; a real new run is at least
// a schedule apart.
export const SINCE_TOLERANCE_MS = 5 * 60e3;
// A POST body is a key, a short note and two words: 4 KB is generous.
export const ACK_MAX_BODY = 4 * 1024;
// Who acked, when the request doesn't say. A browser always sends `Origin` on a
// POST, and only the owner's own devices reach the page, so a request with one is
// the owner's. One without is a script on this machine, which should name itself
// (`by: "jarvis"`); when it doesn't, it is recorded as local, never as the owner.
export const PAGE_BY = 'jeff';
export const LOCAL_BY = 'local';

const BY = /^[A-Za-z0-9-]{1,40}$/;
const MAX_NOTE = 200;
const MAX_KEY = 200;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = error => ({ ok: false, error });
const pass = value => ({ ok: true, value });

// A key as buildAlerts writes one: one line, bounded, nothing unprintable.
export const isAckKey = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY && !UNSAFE_CHARS.test(v);

// The two `since` values of one condition: both unknown, or within the tolerance.
export function sameSince(a, b) {
  const aKnown = Number.isFinite(a), bKnown = Number.isFinite(b);
  if (!aKnown || !bKnown) return !aKnown && !bKnown;
  return Math.abs(a - b) <= SINCE_TOLERANCE_MS;
}

// What the file holds, read defensively: only well-formed, unexpired entries count.
export function activeAcks(list, now) {
  if (!Array.isArray(list)) return [];
  return list.filter(a =>
    isObject(a) && isAckKey(a.key) && typeof a.by === 'string' && BY.test(a.by) &&
    (a.since === null || Number.isFinite(a.since)) && Number.isFinite(a.at) && Number.isFinite(a.until) &&
    (a.note === null || (typeof a.note === 'string' && a.note.length <= MAX_NOTE)) &&
    (a.renewals === undefined || (Number.isSafeInteger(a.renewals) && a.renewals >= 0)) &&
    a.until > now);
}

// How many times an ack has been renewed: 0 for a first ack and for an entry written
// before the count existed.
export const renewalsOf = a => (Number.isSafeInteger(a?.renewals) && a.renewals >= 0 ? a.renewals : 0);

// The active ack covering an alert, if any: same key, same instance.
export function matchingAck(alert, acks, now) {
  if (!alert || !ACKABLE_KINDS.has(alert.kind)) return null;
  for (const a of activeAcks(acks, now)) {
    if (a.key === alert.key && sameSince(a.since, alert.since)) return a;
  }
  return null;
}

// `alerts` without the acked ones, which go in `acked`, each with its ack.
export function applyAcks(alerts, acks, now) {
  const kept = [], acked = [];
  for (const alert of alerts ?? []) {
    const ack = matchingAck(alert, acks, now);
    if (ack) acked.push({ ...alert, ack: publicAck(ack) });
    else kept.push(alert);
  }
  return { alerts: kept, acked };
}

// What the page sees of an ack: everything it holds, in a fixed order.
export const publicAck = a => ({ key: a.key, kind: a.kind ?? null, since: a.since ?? null, by: a.by, note: a.note ?? null, at: a.at, until: a.until, renewals: renewalsOf(a) });

// `POST /api/acks` body: { key, note?, until?, by? }. `fromPage` is whether the
// request carried an Origin header.
export function checkAckRequest(body, { fromPage = false } = {}) {
  if (!isObject(body)) return fail('the body must be an object');
  if (!isAckKey(body.key)) return fail(`key must be an alert's key: text of at most ${MAX_KEY} characters`);
  const note = body.note === undefined || body.note === null || body.note === '' ? null : body.note;
  if (note !== null) {
    if (typeof note !== 'string' || note.length > MAX_NOTE) return fail(`note must be text of at most ${MAX_NOTE} characters`);
    if (UNSAFE_CHARS.test(note)) return fail(`note ${UNSAFE_SAYS}`);
  }
  const by = body.by === undefined || body.by === null ? (fromPage ? PAGE_BY : LOCAL_BY) : body.by;
  if (typeof by !== 'string' || !BY.test(by)) return fail('by must be a word of at most 40 letters, digits and hyphens');
  if (body.until !== undefined && body.until !== null && !Number.isFinite(body.until)) {
    return fail('until must be a time in milliseconds since the epoch, or left out for the default');
  }
  return pass({ key: body.key, note: note === null ? null : note.trim() || null, by, until: Number.isFinite(body.until) ? body.until : undefined });
}

// How far an ack may reach: 14 days, or 24 hours when the instance is unknown.
export const ackCap = (alert, now) => now + (Number.isFinite(alert?.since) ? ACK_CAP_MS : ACK_UNKNOWN_SINCE_CAP_MS);

// The ack for a live alert. `since` and the default expiry come from the alert's
// own source (the cron's `lastRunAt` and `nextRunAt`, the service's `downSince`),
// never from the caller.
export function makeAck(alert, request, now) {
  if (!alert) return fail('no such alert is raised now: only a live alert can be acknowledged');
  if (!ACKABLE_KINDS.has(alert.kind)) return fail(`a ${alert.kind} alert can't be acknowledged: it moves on its own`);
  const cap = ackCap(alert, now);
  let until = request.until;
  if (until === undefined) {
    const next = alert.nextRunAt;
    until = Number.isFinite(next) && next > now ? next + ACK_AFTER_NEXT_MS : now + ACK_NO_NEXT_MS;
    until = Math.min(until, cap);
  } else if (!(until > now)) {
    return fail('until must be later than now');
  } else if (until > cap) {
    return fail(Number.isFinite(alert.since)
      ? 'until may be at most 14 days away'
      : "until may be at most 24 hours away: when this failure began isn't known, so a new one couldn't be told apart");
  }
  return pass({
    key: alert.key,
    kind: alert.kind,
    since: Number.isFinite(alert.since) ? alert.since : null,
    by: request.by,
    note: request.note ?? null,
    at: now,
    until
  });
}

// The list with `ack` in it: one ack per key (the new one wins), expired ones
// gone, the oldest dropped past the cap. An ack that replaces a live one for the
// same instance (same key, same `since`) is a renewal and carries the count on
// (`renewals`), so the notice can say how often this failure has been put off; one
// for a new instance starts at 0. Counted here, inside the store's one-at-a-time
// write, so two renewals at once can't both read the same count.
export function addAck(list, ack, now) {
  const active = activeAcks(list, now);
  const prev = active.find(a => a.key === ack.key && sameSince(a.since, ack.since));
  const kept = active.filter(a => a.key !== ack.key);
  kept.push({ ...ack, renewals: prev ? renewalsOf(prev) + 1 : 0 });
  kept.sort((a, b) => a.at - b.at);
  return kept.slice(Math.max(0, kept.length - ACK_MAX));
}

export function removeAck(list, key, now) {
  return activeAcks(list, now).filter(a => a.key !== key);
}

// The payload with `ack` on each covered entry: `crons[]` and `ingestCrons[]`
// (by label), `health.jobs.list[]` (by the name the Jobs chip shows, since the
// health panel carries no label, and only a failed row) and `health.services[]`
// (by key). Copies, never the cache's own objects, and nothing else about them
// changes.
//
// A display name is ambiguous when two labels share it: two jobs in `crons[]`
// whose names come out the same, or two failed rows in the health list with one
// name. Then no health row is marked for that name (the 2026-11-10 security
// review): marking both would show an ack on a job nobody acked. The crons panel,
// keyed by label, still carries the ack, and the alert is in `acked` either way.
export function decoratePayload(payload, acked, jobNames = {}) {
  if (!acked?.length) return payload;
  const byKey = new Map(acked.map(a => [a.key, a.ack]));
  const cronAck = (source, c) => byKey.get(`cron:${source}:${c?.label ?? c?.name}`);
  const byJobName = new Map();
  for (const [key, ack] of byKey) {
    const m = /^cron:launchd:(.+)$/.exec(key);
    if (m) byJobName.set(jobDisplayName(m[1], jobNames), ack);
  }
  const health = payload.health;
  const jobs = isObject(health?.data) ? health.data.jobs : null;
  const ambiguous = ambiguousNames(payload.crons?.data, jobs?.list, jobNames);
  const jobAck = j => (j?.state === 'failed' && !ambiguous.has(j.name) ? byJobName.get(j.name) : undefined);
  const withAck = (entry, ack) => (ack ? { ...entry, ack } : entry);
  const mapData = (env, fn) => (Array.isArray(env?.data) ? { ...env, data: env.data.map(fn) } : env);
  const out = { ...payload };
  out.crons = mapData(payload.crons, c => withAck(c, cronAck('launchd', c)));
  out.ingestCrons = mapData(payload.ingestCrons, c => withAck(c, cronAck('ingest', c)));
  if (isObject(health?.data)) {
    const services = health.data.services;
    out.health = {
      ...health,
      data: {
        ...health.data,
        jobs: Array.isArray(jobs?.list) ? { ...jobs, list: jobs.list.map(j => withAck(j, jobAck(j))) } : jobs,
        services: Array.isArray(services) ? services.map(s => withAck(s, byKey.get(`service:${s?.key}`))) : services
      }
    };
  }
  return out;
}

// The display names more than one job answers to: by the crons panel's labels,
// and by the failed rows of the health list.
export function ambiguousNames(crons, jobList, jobNames = {}) {
  const seen = new Map();
  const count = name => seen.set(name, (seen.get(name) ?? 0) + 1);
  const labels = new Set();
  for (const c of Array.isArray(crons) ? crons : []) {
    if (typeof c?.label === 'string' && !labels.has(c.label)) {
      labels.add(c.label);
      count(jobDisplayName(c.label, jobNames));
    }
  }
  const out = new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
  const failed = new Map();
  for (const j of Array.isArray(jobList) ? jobList : []) {
    if (j?.state !== 'failed' || typeof j.name !== 'string') continue;
    failed.set(j.name, (failed.get(j.name) ?? 0) + 1);
    if (failed.get(j.name) > 1) out.add(j.name);
  }
  return out;
}

// The service log's line for an ack or an un-ack: kind, who, until when, the key,
// and for a renewal its count. Local only, and the log already holds every job
// verdict. Never the note. Made one line by `oneLine` (below), like the notice.
export const ackLogLine = ack => oneLine(`ack: ${ack.kind} by ${ack.by} until ${new Date(ack.until).toISOString()}${renewalsOf(ack) ? ` (renewal ${renewalsOf(ack)})` : ''} (${ack.key})`);
export const unackLogLine = key => oneLine(`un-ack: ${key}`);

// ---- the notice (board a37d853e, Ultron's 11-10 medium) ----
//
// Every ack and every renewal is pushed, at low priority, so an ack nobody meant
// can't hide an outage quietly: #pepper gets who, what kind of alert, how long it
// has been failing, until when it is set aside, and for a renewal how many times
// this failure has been renewed; ntfy, which shows on a lock screen, gets only
// generic words (like the chat's verdicts). Neither gets the key, the job's or
// service's name or the note: a cron or service alert is counted, never quoted,
// on both channels (push-alerts.mjs, README "Push notifications"), and the note is
// free text. The dashboard and the service log name the alert.

// A line that can hold text from outside (a key from launchd or an ingest, a `by`)
// stays one line: a line break or any other control character, a line or paragraph
// separator, or a direction or invisible character becomes a visible ⟦U+XXXX⟧, a
// tab a space. The keys and notes the route accepts already hold no control
// character (text.mjs), but U+2028 and U+2029 pass that rule, and acks.json can be
// edited by hand. `oneLine` is lib/chat-events.mjs's.

export const NTFY_ACK_WORDS = 'An alert on the Control Room was acknowledged: details in #pepper';
export const NTFY_RENEW_WORDS = 'An acknowledgement on the Control Room was renewed: details in #pepper';
export const ACK_NOTICE_PRIORITY = 'low';

// A time as the server's own zone writes it ("Fri, Nov 13, 6:45 PM EST").
export const noticeTime = ms => new Date(ms).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
});
const age = ms => (ms >= 2 * DAY ? `${Math.floor(ms / DAY)} days` : `${Math.max(0, Math.floor(ms / HOUR))} h`);
const KIND_WORDS = {
  cron: { what: 'a failed job', since: 'failing since', which: 'Which job' },
  service: { what: 'a down service', since: 'down since', which: 'Which service' }
};

// The notice for an ack as stored (addAck's entry, with `renewals`), at `now`:
// `{ message, ntfyMessage, priority }`, the message one line.
export function ackNotice(ack, now) {
  const words = KIND_WORDS[ack.kind] ?? { what: 'an alert', since: 'raised since', which: 'Which one' };
  const n = renewalsOf(ack);
  const since = Number.isFinite(ack.since)
    ? `${words.since} ${noticeTime(ack.since)}, ${age(now - ack.since)} ago`
    : 'when it began is unknown';
  const did = n ? `renewed the acknowledgement of ${words.what}` : `acknowledged ${words.what}`;
  const count = n ? `, renewed ${n} time${n === 1 ? '' : 's'} for this failure` : '';
  return {
    message: oneLine(`${ack.by} ${did} (${since})${count}: it is off the alerts until ${noticeTime(ack.until)}. ${words.which}, and any note, are on the dashboard.`),
    ntfyMessage: n ? NTFY_RENEW_WORDS : NTFY_ACK_WORDS,
    priority: ACK_NOTICE_PRIORITY
  };
}
