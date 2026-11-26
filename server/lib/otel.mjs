// Usage by agent from Claude Code's OpenTelemetry metrics (Orbit Phase 6, board 1e46584d):
// a receiver for OTLP over HTTP with JSON, metrics only, on a loopback port of its own,
// and a second, independent count of each agent's tokens that the panel cross-checks with
// the transcripts' (lib/agent-work.mjs, agentHours). README, "Usage by agent from
// OpenTelemetry", has the settings and what each one does.
//
// What Claude Code sends (read from the 2.1.330 binary on 2026-11-25, not yet seen live):
// `claude_code.token.usage`, a monotonic sum in tokens, one data point per series with the
// attributes `type` (input, output, cacheRead, cacheCreation), `model`, `query_source`
// (main, subagent, auxiliary, plugin_model_*), `effort`, the attribution set (`agent.name`,
// `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`), and
// the account's (`user.id`, `user.email`, `organization.id`, `user.account_uuid`,
// `session.id`, `terminal.type`), plus the resource's (`service.name` "claude-code", and
// anything in OTEL_RESOURCE_ATTRIBUTES). A custom agent's `agent.name` reads "custom"
// unless OTEL_LOG_TOOL_DETAILS is set.
//
// What is kept is far less: for each hour, each roster agent's (or "other"'s) new tokens
// (input + output + cache creation, as the transcripts count them), cache reads apart,
// and background requests apart. No attribute's value is stored, logged or sent to the
// page: no session id, account, email, model, skill, plugin or MCP name. A cumulative
// series is remembered by a hash of its attributes only, to take the difference between
// two exports. The agent comes from `agent.name` when it is a roster agent, otherwise from
// the session's tag (`control_room.agent`, set by OTEL_RESOURCE_ATTRIBUTES when the lead's
// session or a routine starts); see agentFor.
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { createRefusalCounts } from './refusal-counts.mjs';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Not 4318, the OTLP default, so no other program's exporter lands here by default.
export const OTEL_DEFAULT_PORT = 8323;
// One process's export is a few KB; 256 KB is far more than any real one.
export const OTEL_BODY_MAX = 256 * 1024;
// Each Claude Code process exports once a minute; ten at once is a busy day.
export const OTEL_POSTS_PER_MINUTE = 120;
// Bounds on one export, past which the post is refused whole (400).
export const OTEL_POINTS_MAX = 5000;
export const OTEL_ATTRS_MAX = 64;
const ATTR_KEY_MAX = 128;
const ATTR_VALUE_MAX = 1024;
// Cumulative series remembered at once; past it the oldest is forgotten.
export const OTEL_SERIES_MAX = 20000;
// Hours and series older than this go: 7 days for the panel, and a day for the check.
export const OTEL_KEEP_MS = 8 * DAY;
// How often the store's file is written while something changed.
export const OTEL_SAVE_EVERY_MS = 60 * 1000;
// The cross-check: over the last 24 complete hours (fewer just after the receiver first
// ran), an agent's two counts are said to differ when they are more than 20% apart and
// the larger is at least 50,000 new tokens. Smaller counts are too small to judge.
export const CHECK_WINDOW_MS = DAY;
export const CHECK_TOLERANCE = 0.2;
export const CHECK_FLOOR = 50000;

export const TOKEN_METRIC = 'claude_code.token.usage';
export const SERVICE_NAME = 'claude-code';
// The session's agent, from OTEL_RESOURCE_ATTRIBUTES (or a point attribute of that name).
export const AGENT_TAG = 'control_room.agent';
// What an export's own agent attribute says for a custom agent without OTEL_LOG_TOOL_DETAILS.
const REDACTED_AGENT = 'custom';
// The key "other" is stored under: not a roster key's spelling (lib/roster.mjs: lowercase
// letters, digits, hyphens), so it can never collide with one.
export const OTHER = '~other';
// The keys an hour's cells may have: a roster key's spelling, or Other's. Restoring the
// store keeps no other key, so a file can't name `__proto__` (Ultron's L1); `constructor`
// is a roster key's spelling, which is why the cells have no prototype.
const CELL_KEY = /^(?:[a-z0-9-]{1,40}|~other)$/;

const NEW_TYPES = new Set(['input', 'output', 'cacheCreation']);
const READ_TYPE = 'cacheRead';
// Requests the transcripts never hold (titles, summaries, a plugin's model calls).
const isBackground = source => source === 'auxiliary' || (typeof source === 'string' && source.startsWith('plugin_model_'));

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- config ----

// config's `otel` block: { "enabled": true, "port": 8323 }. Absent is unset and off; the
// receiver listens only when `enabled` is exactly true. A bad port is a `config:` line
// and keeps it off, so a typo never moves it somewhere unexpected.
export function readOtelConfig(config, { dashboardPort = 8322 } = {}) {
  const problems = [];
  const raw = config?.otel;
  const off = state => ({ on: false, state, port: OTEL_DEFAULT_PORT, problems });
  if (raw === undefined || raw === null) return off('unset');
  if (!isObject(raw)) { problems.push('otel is not an object; the OpenTelemetry receiver stays off'); return off('off'); }
  for (const k of Object.keys(raw)) if (k !== 'enabled' && k !== 'port') problems.push(`otel.${k} is not a setting (only "enabled" and "port"); it is ignored`);
  let port = OTEL_DEFAULT_PORT;
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535 || raw.port === dashboardPort) {
      problems.push(`otel.port must be a whole number from 1024 to 65535 and not the dashboard's own port (${dashboardPort}); the OpenTelemetry receiver stays off`);
      return { ...off('off'), port: OTEL_DEFAULT_PORT };
    }
    port = raw.port;
  }
  if (raw.enabled === true) return { on: true, state: 'on', port, problems };
  if (raw.enabled !== false && raw.enabled !== undefined) problems.push('otel.enabled must be true or false; the OpenTelemetry receiver stays off');
  return { on: false, state: 'off', port, problems };
}

// ---- reading an export ----

export class OtelRefusal extends Error {
  constructor(status, words) {
    super(words);
    this.status = status;
  }
}
const bad = words => new OtelRefusal(400, words);

// An attribute list as OTLP/JSON writes it, [{ key, value: { stringValue } }, ...], into
// a Map of key -> string for string values. Over the caps, the export is refused.
function attributesOf(list) {
  const out = new Map();
  if (list === undefined || list === null) return out;
  if (!Array.isArray(list)) throw bad('an attributes field is not a list');
  if (list.length > OTEL_ATTRS_MAX) throw bad(`more than ${OTEL_ATTRS_MAX} attributes on one point or resource`);
  for (const a of list) {
    if (!isObject(a) || typeof a.key !== 'string' || a.key.length > ATTR_KEY_MAX) throw bad('an attribute without a short key');
    const v = isObject(a.value) ? a.value.stringValue : undefined;
    if (typeof v === 'string') {
      if (v.length > ATTR_VALUE_MAX) throw bad('an attribute value is too long');
      out.set(a.key, v);
    } else {
      // Not a string (a number, a list): it counts towards the series' hash only.
      out.set(a.key, JSON.stringify(a.value ?? null).slice(0, ATTR_VALUE_MAX));
    }
  }
  return out;
}

// A time in nanoseconds since the epoch, as a string of digits or a number, in ms.
export function nanosToMs(v) {
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return Number(BigInt(v) / 1000000n);
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v / 1e6);
  return null;
}

// A data point's value: asInt (a string of digits or a number) or asDouble.
function valueOf(p) {
  const raw = p.asInt !== undefined ? p.asInt : p.asDouble;
  const n = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
}

const DELTA = new Set([1, 'AGGREGATION_TEMPORALITY_DELTA']);
const CUMULATIVE = new Set([2, 'AGGREGATION_TEMPORALITY_CUMULATIVE']);

const fold = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// The roster as the receiver needs it: each key and name, folded, to its key.
export function rosterLookup(roster) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const byWord = new Map();
  for (const a of agents) {
    if (typeof a?.key !== 'string') continue;
    byWord.set(fold(a.key), a.key);
    if (typeof a.name === 'string') byWord.set(fold(a.name), a.key);
  }
  return { lead: agents[0]?.key ?? null, keyOf: word => byWord.get(fold(word)) ?? null };
}

// Whose tokens a point's are, by the transcripts' rules (lib/agent-work.mjs):
//   - `agent.name` names a roster agent: that agent's (a subagent's request);
//   - no `agent.name`, and the session's tag names a roster agent: that agent's (the
//     lead's own session, or a routine started with the tag);
//   - another `agent.name` (a built-in helper, or "custom") in the lead's tagged session:
//     the lead's helper, so the lead's;
//   - anything else: "other".
export function agentFor({ agentName, tag }, lookup) {
  const named = agentName === undefined ? null : lookup.keyOf(agentName);
  if (named) return named;
  const tagged = tag === undefined ? null : lookup.keyOf(tag);
  if (!tagged) return OTHER;
  if (agentName === undefined) return tagged;
  return tagged === lookup.lead ? tagged : OTHER;
}

// A cumulative series' identity: its metric, resource and point attributes and its start,
// hashed. Only the hash is kept.
function seriesHash(resource, attrs, start) {
  const canon = m => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash('sha256').update(`${TOKEN_METRIC}\n${canon(resource)}\n${canon(attrs)}\n${start}`).digest('base64url').slice(0, 22);
}

// One export (ExportMetricsServiceRequest, as JSON) into the token points it carries:
// { agent, kind: 'new' | 'read', background, value, at, cumulative, start, series }.
// Resources that aren't Claude Code's, other metrics, and points of a type that isn't
// tokens are passed over; a body of the wrong shape, or over the caps, is refused (400).
// `redacted` says a point named a custom agent only as "custom".
export function readExport(body, lookup) {
  if (!isObject(body)) throw bad('the body is not an export of metrics');
  const resources = body.resourceMetrics ?? [];
  if (!Array.isArray(resources)) throw bad('resourceMetrics is not a list');
  const points = [];
  let seen = 0, redacted = false;
  for (const rm of resources) {
    if (!isObject(rm)) throw bad('a resourceMetrics entry is not an object');
    const resource = attributesOf(isObject(rm.resource) ? rm.resource.attributes : undefined);
    const scopes = rm.scopeMetrics ?? [];
    if (!Array.isArray(scopes)) throw bad('scopeMetrics is not a list');
    const ours = resource.get('service.name') === SERVICE_NAME;
    for (const sm of scopes) {
      if (!isObject(sm)) throw bad('a scopeMetrics entry is not an object');
      const metrics = sm.metrics ?? [];
      if (!Array.isArray(metrics)) throw bad('metrics is not a list');
      for (const m of metrics) {
        if (!isObject(m)) throw bad('a metric is not an object');
        const sum = isObject(m.sum) ? m.sum : null;
        const dataPoints = sum && Array.isArray(sum.dataPoints) ? sum.dataPoints : [];
        seen += dataPoints.length;
        if (seen > OTEL_POINTS_MAX) throw bad(`more than ${OTEL_POINTS_MAX} data points in one export`);
        if (!ours || m.name !== TOKEN_METRIC || !sum) continue;
        const cumulative = CUMULATIVE.has(sum.aggregationTemporality);
        if (!cumulative && !DELTA.has(sum.aggregationTemporality)) continue;
        for (const p of dataPoints) {
          if (!isObject(p)) throw bad('a data point is not an object');
          const attrs = attributesOf(p.attributes);
          const type = attrs.get('type');
          const kind = NEW_TYPES.has(type) ? 'new' : type === READ_TYPE ? 'read' : null;
          const value = valueOf(p);
          const at = nanosToMs(p.timeUnixNano);
          const start = nanosToMs(p.startTimeUnixNano);
          if (!kind || value === null || at === null) continue;
          const agentName = attrs.get('agent.name');
          if (agentName === REDACTED_AGENT) redacted = true;
          points.push({
            agent: agentFor({ agentName, tag: attrs.get(AGENT_TAG) ?? resource.get(AGENT_TAG) }, lookup),
            kind,
            background: isBackground(attrs.get('query_source')),
            value,
            at,
            cumulative,
            start,
            series: cumulative ? seriesHash(resource, attrs, start ?? 'none') : null
          });
        }
      }
    }
  }
  return { points, redacted };
}

// ---- the store ----

const hourOf = t => Math.floor(t / HOUR) * HOUR;
// An hour's cell: [new tokens, cache reads, new tokens of background requests].
const CELL = 3;

// Kept in server/data/otel.json (gitignored), written through a temp file, 0600.
// `since` is when the receiver first counted anything: a cumulative series that started
// before it (a session already running when the receiver came up, or after the file was
// lost) is taken as a baseline and only what it adds afterwards is counted, since when
// its earlier tokens were spent is unknown.
export function createOtelStore({ path, clock = () => Date.now(), log = console.log, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; } } = {}) {
  let state = fresh(clock());
  let dirty = false, timer = false, saving = Promise.resolve();

  // `evictedAt`: when the series cap last forgot series (prune). An unknown series that
  // started before then may be one it forgot, so it is a baseline, never counted again
  // from zero (Ultron's L4).
  function fresh(now) { return { v: 1, since: now, lastAt: null, redactedAt: null, evictedAt: null, posts: 0, hours: {}, series: {} }; }

  const cleanCell = c => (Array.isArray(c) && c.length === CELL && c.every(n => Number.isFinite(n) && n >= 0) ? c.slice() : null);
  function restore(raw, now) {
    if (!isObject(raw) || raw.v !== 1 || !Number.isFinite(raw.since)) return null;
    const out = fresh(raw.since);
    out.lastAt = Number.isFinite(raw.lastAt) ? raw.lastAt : null;
    out.redactedAt = Number.isFinite(raw.redactedAt) ? raw.redactedAt : null;
    out.evictedAt = Number.isFinite(raw.evictedAt) ? raw.evictedAt : null;
    out.posts = Number.isInteger(raw.posts) && raw.posts >= 0 ? raw.posts : 0;
    for (const [hour, cells] of Object.entries(isObject(raw.hours) ? raw.hours : {})) {
      if (!/^\d{1,15}$/.test(hour) || !isObject(cells)) continue;
      // No prototype: a roster key may be spelled `constructor`.
      const kept = Object.create(null);
      for (const [agent, cell] of Object.entries(cells)) {
        const c = cleanCell(cell);
        if (c && CELL_KEY.test(agent)) kept[agent] = c;
      }
      out.hours[hour] = kept;
    }
    for (const [hash, s] of Object.entries(isObject(raw.series) ? raw.series : {})) {
      if (/^[A-Za-z0-9_-]{22}$/.test(hash) && Array.isArray(s) && s.length === 2 && s.every(Number.isFinite)) out.series[hash] = s.slice();
    }
    prune(out, now);
    return out;
  }

  function prune(s, now) {
    const cut = now - OTEL_KEEP_MS;
    for (const hour of Object.keys(s.hours)) if (Number(hour) < hourOf(cut)) delete s.hours[hour];
    const series = Object.entries(s.series).filter(([, [, seen]]) => seen >= cut);
    if (series.length > OTEL_SERIES_MAX) {
      series.sort((a, b) => b[1][1] - a[1][1]).length = OTEL_SERIES_MAX;
      s.evictedAt = now;
    }
    s.series = Object.fromEntries(series);
  }

  async function load() {
    let text;
    try { text = await readFile(path, 'utf8'); } catch (err) {
      if (err?.code === 'ENOENT') return 'none';
      log(`otel: the store could not be read (${err?.code ?? 'error'}); starting empty`);
      return 'unreadable';
    }
    let raw = null;
    try { raw = JSON.parse(text); } catch { raw = null; }
    const restored = restore(raw, clock());
    if (!restored) { log('otel: the store is not one this server wrote; starting empty'); return 'unreadable'; }
    state = restored;
    return 'loaded';
  }

  async function save() {
    const run = saving.then(async () => {
      if (!dirty) return;
      dirty = false;
      prune(state, clock());
      const tmp = `${path}.tmp-${process.pid}`;
      try {
        await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (err) {
        dirty = true;
        await unlink(tmp).catch(() => {});
        log(`otel: the store could not be written (${err?.code ?? 'error'})`);
      }
    });
    saving = run.catch(() => {});
    return run;
  }

  const later = () => {
    dirty = true;
    if (timer) return;
    timer = true;
    setTimer(() => { timer = false; save(); }, OTEL_SAVE_EVERY_MS);
  };

  // Counts an export's points. Returns how many tokens it added, for tests and the log.
  function ingest({ points, redacted }) {
    const now = clock();
    let added = 0;
    for (const p of points) {
      const at = Math.min(p.at, now);
      if (at < now - OTEL_KEEP_MS) continue;
      let n = p.value;
      if (p.cumulative) {
        const known = state.series[p.series];
        if (!known) {
          // Counted from zero only if it started after the store began and after the cap
          // last forgot series; no start time at all is a baseline too. A series forgotten
          // for age (8 days unseen) can't come back: a live exporter resends it each minute.
          n = (p.start ?? -Infinity) >= Math.max(state.since, state.evictedAt ?? -Infinity) ? p.value : 0;
        } else {
          n = p.value >= known[0] ? p.value - known[0] : p.value;
        }
        state.series[p.series] = [p.value, now];
      }
      if (n <= 0) continue;
      const hour = String(hourOf(at));
      const cells = (state.hours[hour] ??= Object.create(null));
      const cell = (cells[p.agent] ??= [0, 0, 0]);
      if (p.kind === 'read') cell[1] += n;
      else if (p.background) cell[2] += n;
      else cell[0] += n;
      added += n;
    }
    // Past the cap, the series seen longest ago are forgotten (prune), at once.
    if (points.some(p => p.cumulative) && Object.keys(state.series).length > OTEL_SERIES_MAX) prune(state, now);
    state.posts += 1;
    state.lastAt = now;
    if (redacted) state.redactedAt = now;
    later();
    return added;
  }

  return {
    load,
    save,
    ingest,
    // A copy, so nothing outside can change the counts.
    snapshot: () => JSON.parse(JSON.stringify(state))
  };
}

// ---- the panel ----

const sumHours = (hours, from, to, pick) => {
  let n = 0;
  for (const [hour, v] of Object.entries(hours ?? {})) {
    const h = Number(hour);
    if (h >= from && h < to) n += pick(v);
  }
  return n;
};

// The two counts side by side, per roster agent and for everything: OpenTelemetry's new
// tokens of foreground requests (main sessions and subagents, as the transcripts hold
// them) against the transcripts' (lib/agent-work.mjs, agentHours). Null until a complete
// hour has passed since the receiver first counted, or without the transcripts' hours.
export function crossCheck({ snapshot, transcript, agents, now }) {
  if (!snapshot || !transcript) return null;
  const to = hourOf(now);
  const from = Math.max(to - CHECK_WINDOW_MS, hourOf(snapshot.since) + HOUR);
  if (to - from < HOUR) return null;
  const otelOf = key => sumHours(snapshot.hours, from, to, cells => cells[key]?.[0] ?? 0);
  const otelAll = sumHours(snapshot.hours, from, to, cells => Object.values(cells).reduce((a, c) => a + c[0], 0));
  const verdict = (otel, transcripts) => {
    const big = Math.max(otel, transcripts);
    if (big < CHECK_FLOOR) return 'small';
    return Math.abs(otel - transcripts) / big > CHECK_TOLERANCE ? 'differs' : 'matches';
  };
  const rows = agents.map(key => {
    const otel = otelOf(key);
    const transcripts = sumHours(transcript.byAgent?.[key], from, to, n => n);
    return { key, otel, transcripts, verdict: verdict(otel, transcripts) };
  });
  const transcriptsAll = sumHours(transcript.all, from, to, n => n);
  return { from, to, rows, total: { otel: otelAll, transcripts: transcriptsAll, verdict: verdict(otelAll, transcriptsAll) } };
}

// The `otel` panel the page draws (web/src/lib/orbit/agent-usage.js): counts and times,
// keyed by roster agent, nothing else. `receiver` is 'off', 'listening' or 'failed'.
export function buildOtelPanel({ settings, receiver, snapshot, transcript, roster, now }) {
  const agents = (Array.isArray(roster?.agents) ? roster.agents : []).map(a => a.key);
  if (!settings?.on) return { state: settings?.state ?? 'unset', port: null, since: null, lastAt: null, agents: [], other: null, redacted: false, check: null };
  if (receiver !== 'listening') return { state: 'failed', port: settings.port, since: null, lastAt: null, agents: [], other: null, redacted: false, check: null };
  const day = hourOf(now) + HOUR - DAY;
  const week = hourOf(now) + HOUR - 7 * DAY;
  const end = hourOf(now) + HOUR;
  const totals = key => ({
    tokens24h: sumHours(snapshot.hours, day, end, cells => (cells[key] ? cells[key][0] + cells[key][2] : 0)),
    tokens7d: sumHours(snapshot.hours, week, end, cells => (cells[key] ? cells[key][0] + cells[key][2] : 0)),
    cacheRead7d: sumHours(snapshot.hours, week, end, cells => cells[key]?.[1] ?? 0)
  });
  return {
    state: snapshot.lastAt === null ? 'waiting' : 'on',
    port: settings.port,
    since: snapshot.lastAt === null ? null : snapshot.since,
    lastAt: snapshot.lastAt,
    agents: agents.map(key => ({ key, ...totals(key) })),
    other: totals(OTHER),
    // Custom agents named only "custom" in the last day: their tokens fall to the lead or
    // to other, and the check says so.
    redacted: Number.isFinite(snapshot.redactedAt) && now - snapshot.redactedAt < DAY,
    check: snapshot.lastAt === null ? null : crossCheck({ snapshot, transcript, agents, now })
  };
}

// One line when an agent's check turns to "differs" or back, so a gap reaches the log
// once, not every minute. Names roster keys and counts only.
export function createCheckLog({ log = console.log } = {}) {
  let differs = new Set();
  return check => {
    const now = new Set();
    for (const r of [...(check?.rows ?? []), ...(check ? [{ ...check.total, key: 'all' }] : [])]) {
      if (r.verdict !== 'differs') continue;
      now.add(r.key);
      if (!differs.has(r.key)) log(`otel: the cross-check differs for ${r.key}: ${r.otel} new tokens from OpenTelemetry, ${r.transcripts} from the transcripts, over the ${Math.round((check.to - check.from) / HOUR)} h to ${new Date(check.to).toISOString()}`);
    }
    for (const key of differs) if (!now.has(key)) log(`otel: the cross-check agrees again for ${key}`);
    differs = now;
  };
}

// ---- the receiver ----

const ANSWER = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const answer = (res, code, body, headers = {}) => {
  res.writeHead(code, { ...ANSWER, ...headers });
  res.end(JSON.stringify(body));
};

export const OTEL_REFUSAL_WORDS = Object.freeze({
  count: (path, reason, count, total) => `otel: refused ${count} more ${count === 1 ? 'post' : 'posts'} to ${path} ${reason} since the last such line (${total} since the start)`,
  other: (count, total, first, maxKeys) => `otel: refused ${count} ${count === 1 ? 'post' : 'posts'} on other paths and reasons ${first ? 'past the first' : 'since the last such line'} (${total} since the start; the log names ${maxKeys} at most)`
});

// The request handler for the receiver's own port. In order: the Host must be this port on
// loopback (so a page re-pointed at 127.0.0.1 by DNS rebinding is refused), no Origin
// (exporters send none; a browser always does on a POST), POST /v1/metrics only (logs and
// traces are 404: this receiver takes metrics only), at most OTEL_POSTS_PER_MINUTE posts
// in any minute, no Content-Encoding, JSON only, and at most OTEL_BODY_MAX bytes. A post
// refused before its body is read is answered with Connection: close, so the body is
// never drained. A refusal's log line names the path and a fixed reason, never a value.
export function createOtelReceiver({ store, port, roster, log = console.log, clock = () => Date.now(), setTimer = undefined }) {
  const lookup = rosterLookup(roster);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const countRefusal = createRefusalCounts({ log, clock, words: OTEL_REFUSAL_WORDS, ...(setTimer ? { setTimer } : {}) });
  const posts = [];
  const refuse = (res, path, code, reason, words, headers = {}) => {
    countRefusal(path, reason, `otel: refused a post to ${path} ${reason}`);
    answer(res, code, { message: words }, { Connection: 'close', ...headers });
  };
  const rateWait = () => {
    const now = clock();
    while (posts.length && now - posts[0] >= 60e3) posts.shift();
    if (posts.length >= OTEL_POSTS_PER_MINUTE) return Math.max(1, Math.ceil((posts[0] + 60e3 - now) / 1000));
    posts.push(now);
    return 0;
  };

  return async function otelHandler(req, res) {
    let path = '/';
    try { path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch { path = '/'; }
    // Only the paths an exporter uses are named in a line; anything else is "another path".
    const named = path === '/v1/metrics' || path === '/v1/logs' || path === '/v1/traces' ? path : 'another path';
    if (!hosts.has(String(req.headers?.host ?? '').toLowerCase())) return refuse(res, named, 421, 'with a Host that is not this port on loopback', 'this receiver answers only to 127.0.0.1 and localhost on its own port');
    if (req.headers?.origin !== undefined) return refuse(res, named, 403, 'from a browser (it sent Origin)', 'this receiver takes posts from programs on this machine only');
    if (path !== '/v1/metrics') return refuse(res, named, 404, 'that is not /v1/metrics', 'this receiver takes metrics only, at /v1/metrics');
    if (req.method !== 'POST') return refuse(res, named, 405, 'that is not a POST', 'only POST', { Allow: 'POST' });
    const wait = rateWait();
    if (wait > 0) return refuse(res, named, 429, `past ${OTEL_POSTS_PER_MINUTE} in a minute`, `more than ${OTEL_POSTS_PER_MINUTE} posts this minute; try again in ${wait} s`, { 'Retry-After': String(wait) });
    const encoding = String(req.headers?.['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity') return refuse(res, named, 415, 'with a Content-Encoding', 'send the export uncompressed');
    const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return refuse(res, named, 415, 'that is not JSON', 'send OTLP as JSON (http/json)');
    const length = Number(req.headers?.['content-length']);
    if (Number.isFinite(length) && length > OTEL_BODY_MAX) return refuse(res, named, 413, 'over the size cap', `the body is over ${OTEL_BODY_MAX} bytes`);

    let body;
    try {
      body = await readCapped(req, OTEL_BODY_MAX);
    } catch (err) {
      return refuse(res, named, err?.status ?? 400, err?.status === 413 ? 'over the size cap' : 'whose body could not be read', err?.status === 413 ? `the body is over ${OTEL_BODY_MAX} bytes` : 'the body could not be read');
    }
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { return refuse(res, named, 400, 'that is not valid JSON', 'invalid JSON'); }
    let read;
    try { read = readExport(parsed, lookup); } catch (err) {
      if (err instanceof OtelRefusal) return refuse(res, named, err.status, 'that is not an export of metrics in bounds', err.message);
      throw err;
    }
    store.ingest(read);
    return answer(res, 200, {});
  };
}

// The body, up to `limit` bytes; past it, a 413 (the read stops, the socket is left for
// the answer, which closes it).
function readCapped(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    const stop = (fn, v) => { if (!done) { done = true; fn(v); } };
    req.on('data', c => {
      if (done) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > limit) {
        req.pause?.();
        return stop(reject, Object.assign(new Error('too big'), { status: 413 }));
      }
      chunks.push(buf);
    });
    req.on('end', () => stop(resolve, Buffer.concat(chunks)));
    req.on('error', () => stop(reject, Object.assign(new Error('read failed'), { status: 400 })));
  });
}
