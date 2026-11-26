import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOtelConfig, readExport, agentFor, rosterLookup, nanosToMs, createOtelStore, crossCheck, buildOtelPanel,
  createCheckLog, createOtelReceiver, OtelRefusal, OTHER, OTEL_DEFAULT_PORT, OTEL_POINTS_MAX, OTEL_ATTRS_MAX,
  OTEL_BODY_MAX, OTEL_POSTS_PER_MINUTE, OTEL_SERIES_MAX, OTEL_KEEP_MS, CHECK_FLOOR, TOKEN_METRIC, AGENT_TAG
} from '../lib/otel.mjs';

// Usage by agent from OpenTelemetry (lib/otel.mjs). An invented roster, invented sessions
// and an invented account: never a real agent, session id or address.
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-12T15:20:00Z');
const roster = { agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }, { key: 'quill', name: 'Quill' }] };
const lookup = rosterLookup(roster);
const hourOf = t => Math.floor(t / HOUR) * HOUR;
const nanos = ms => `${BigInt(ms) * 1000000n}`;

const str = (key, value) => ({ key, value: { stringValue: value } });
// What Claude Code puts on every point (read from its binary), with invented values.
const ACCOUNT = [
  str('user.id', 'device-0000-test'), str('session.id', 'sess-1111-test'), str('organization.id', 'org-2222-test'),
  str('user.email', 'owner@example.com'), str('user.account_uuid', 'acct-3333-test'), str('terminal.type', 'tmux')
];
const point = ({ type = 'input', value = 100, at = NOW - 5 * MIN, start = NOW - HOUR, agent, tag, source = 'main', extra = [], int = false } = {}) => ({
  attributes: [
    ...ACCOUNT, str('type', type), str('model', 'claude-test-5'), str('query_source', source), str('effort', 'high'),
    ...(agent === undefined ? [] : [str('agent.name', agent)]),
    ...(tag === undefined ? [] : [str(AGENT_TAG, tag)]),
    ...extra
  ],
  startTimeUnixNano: start === null ? undefined : nanos(start),
  timeUnixNano: nanos(at),
  ...(int ? { asInt: String(value) } : { asDouble: value })
});
const exportOf = (points, { temporality = 2, service = 'claude-code', resourceTag, metric = TOKEN_METRIC } = {}) => ({
  resourceMetrics: [{
    resource: { attributes: [str('service.name', service), str('service.version', '2.1.330'), ...(resourceTag ? [str(AGENT_TAG, resourceTag)] : [])] },
    scopeMetrics: [{
      scope: { name: 'com.anthropic.claude_code', version: '2.1.330' },
      metrics: [
        { name: 'claude_code.session.count', sum: { dataPoints: [{ attributes: ACCOUNT, asInt: '1', timeUnixNano: nanos(NOW) }], aggregationTemporality: temporality, isMonotonic: true } },
        { name: metric, unit: 'tokens', sum: { dataPoints: points, aggregationTemporality: temporality, isMonotonic: true } }
      ]
    }]
  }]
});

const dirs = [];
const tempDir = async () => { const d = await mkdtemp(join(tmpdir(), 'otel-')); dirs.push(d); return d; };
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

// ---- config ----

test('the receiver is off unless config says enabled: true, on its own port', () => {
  assert.deepEqual(readOtelConfig({}), { on: false, state: 'unset', port: OTEL_DEFAULT_PORT, problems: [] });
  assert.equal(OTEL_DEFAULT_PORT, 8323);
  assert.equal(readOtelConfig({ otel: { enabled: false } }).state, 'off');
  assert.deepEqual(readOtelConfig({ otel: { enabled: true } }), { on: true, state: 'on', port: 8323, problems: [] });
  assert.equal(readOtelConfig({ otel: { enabled: true, port: 9555 } }).port, 9555);
  const typo = readOtelConfig({ otel: { enabled: 'yes' } });
  assert.equal(typo.on, false);
  assert.match(typo.problems[0], /otel\.enabled must be true or false/);
  assert.match(readOtelConfig({ otel: true }).problems[0], /not an object/);
  const extra = readOtelConfig({ otel: { enabled: true, logs: true } });
  assert.equal(extra.on, true);
  assert.match(extra.problems[0], /otel\.logs is not a setting/);
});

test("a bad port keeps the receiver off: not a whole number, out of range, or the dashboard's own", () => {
  for (const port of [80, 1023, 65536, 8323.5, '8323', 8322]) {
    const s = readOtelConfig({ otel: { enabled: true, port } }, { dashboardPort: 8322 });
    assert.equal(s.on, false, String(port));
    assert.match(s.problems[0], /otel\.port must be/, String(port));
  }
  assert.equal(readOtelConfig({ otel: { enabled: true, port: 1024 } }).on, true);
  assert.equal(readOtelConfig({ otel: { enabled: true, port: 65535 } }).on, true);
  assert.equal(readOtelConfig({ otel: { enabled: true, port: 9000 } }, { dashboardPort: 9000 }).on, false);
});

// ---- reading an export ----

test('nanosToMs reads a string of digits or a number', () => {
  assert.equal(nanosToMs('1754000000123456789'), 1754000000123);
  // A number (some exporters send one) is good to the millisecond, past 2^53 too.
  assert.equal(nanosToMs(1754000000123 * 1e6), 1754000000123);
  for (const v of [undefined, null, '', '-5', '12a', 'x'.repeat(5), -1, NaN, '1'.repeat(21)]) assert.equal(nanosToMs(v), null, String(v));
});

test("an export's token points come out with their agent, kind and background flag", () => {
  const { points, redacted } = readExport(exportOf([
    point({ type: 'input', value: 10, agent: 'forge', tag: 'atlas' }),
    point({ type: 'output', value: 20, tag: 'atlas' }),
    point({ type: 'cacheCreation', value: 30, tag: 'atlas', source: 'subagent', agent: 'general-purpose' }),
    point({ type: 'cacheRead', value: 40, tag: 'atlas' }),
    point({ type: 'input', value: 50, tag: 'atlas', source: 'auxiliary' }),
    point({ type: 'output', value: 60, tag: 'atlas', source: 'plugin_model_classify' }),
    point({ type: 'added', value: 70, tag: 'atlas' }),
    point({ type: 'input', value: 80, int: true })
  ]), lookup);
  assert.equal(redacted, false);
  assert.deepEqual(points.map(p => [p.agent, p.kind, p.background, p.value]), [
    ['forge', 'new', false, 10],
    ['atlas', 'new', false, 20],
    ['atlas', 'new', false, 30],
    ['atlas', 'read', false, 40],
    ['atlas', 'new', true, 50],
    ['atlas', 'new', true, 60],
    [OTHER, 'new', false, 80]
  ]);
  assert.equal(points[0].at, NOW - 5 * MIN);
  assert.equal(points[0].start, NOW - HOUR);
  assert.equal(points[0].cumulative, true);
  assert.match(points[0].series, /^[A-Za-z0-9_-]{22}$/);
});

test("a series' hash follows its attributes and start, and nothing else of it is kept", () => {
  const [a, b, c, d] = readExport(exportOf([
    point({ value: 1, tag: 'atlas' }), point({ value: 2, tag: 'atlas', at: NOW }),
    point({ value: 1, tag: 'atlas', start: NOW - 2 * HOUR }), point({ value: 1, tag: 'atlas', extra: [str('speed', 'fast')] })
  ]), lookup).points;
  assert.equal(a.series, b.series);
  assert.notEqual(a.series, c.series);
  assert.notEqual(a.series, d.series);
  const text = JSON.stringify(a);
  for (const word of ['owner@example.com', 'sess-1111', 'acct-3333', 'org-2222', 'device-0000', 'claude-test-5', 'tmux']) assert.ok(!text.includes(word), word);
  // Delta points have no series.
  assert.equal(readExport(exportOf([point({ tag: 'atlas' })], { temporality: 1 }), lookup).points[0].series, null);
  assert.equal(readExport(exportOf([point({ tag: 'atlas' })], { temporality: 'AGGREGATION_TEMPORALITY_DELTA' }), lookup).points[0].cumulative, false);
  assert.equal(readExport(exportOf([point({ tag: 'atlas' })], { temporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE' }), lookup).points[0].cumulative, true);
});

test('the session tag may come from the resource (OTEL_RESOURCE_ATTRIBUTES) or the point', () => {
  const fromResource = readExport(exportOf([point({ value: 5 })], { resourceTag: 'quill' }), lookup).points[0];
  assert.equal(fromResource.agent, 'quill');
  const both = readExport(exportOf([point({ value: 5, tag: 'forge' })], { resourceTag: 'quill' }), lookup).points[0];
  assert.equal(both.agent, 'forge');
});

test('other programs, other metrics, unknown temporality and unreadable points are passed over', () => {
  assert.deepEqual(readExport(exportOf([point({ tag: 'atlas' })], { service: 'some-other-app' }), lookup).points, []);
  assert.deepEqual(readExport(exportOf([point({ tag: 'atlas' })], { metric: 'claude_code.cost.usage' }), lookup).points, []);
  assert.deepEqual(readExport(exportOf([point({ tag: 'atlas' })], { temporality: 0 }), lookup).points, []);
  const odd = [
    { ...point({ tag: 'atlas' }), asDouble: -1 },
    { ...point({ tag: 'atlas' }), asDouble: Infinity },
    { ...point({ tag: 'atlas' }), asDouble: undefined, asInt: '12x' },
    { ...point({ tag: 'atlas' }), timeUnixNano: 'soon' },
    { ...point({ tag: 'atlas' }), asDouble: 2e12 }
  ];
  assert.deepEqual(readExport(exportOf(odd), lookup).points, []);
  // A gauge or a histogram named like the token metric is not it.
  const gauge = { resourceMetrics: [{ resource: { attributes: [str('service.name', 'claude-code')] }, scopeMetrics: [{ metrics: [{ name: TOKEN_METRIC, gauge: { dataPoints: [point()] } }] }] }] };
  assert.deepEqual(readExport(gauge, lookup).points, []);
  assert.deepEqual(readExport({}, lookup).points, []);
});

test('a custom agent named only "custom" is flagged as redacted, and counted by its session', () => {
  const out = readExport(exportOf([point({ agent: 'custom', tag: 'atlas', source: 'subagent' })]), lookup);
  assert.equal(out.redacted, true);
  assert.equal(out.points[0].agent, 'atlas');
});

test('a body of the wrong shape, or over the caps, is refused whole', () => {
  const refused = body => assert.throws(() => readExport(body, lookup), e => e instanceof OtelRefusal && e.status === 400);
  for (const body of [null, [], 'x', 5, { resourceMetrics: {} }, { resourceMetrics: [5] }, { resourceMetrics: [{ scopeMetrics: 'x' }] },
    { resourceMetrics: [{ scopeMetrics: [{ metrics: {} }] }] }, { resourceMetrics: [{ scopeMetrics: [{ metrics: [7] }] }] },
    { resourceMetrics: [{ resource: { attributes: 'x' } }] }]) refused(body);
  // The session.count point counts too: with it, MAX token points are one over the cap.
  const many = Array.from({ length: OTEL_POINTS_MAX }, () => point({ tag: 'atlas' }));
  refused(exportOf(many));
  // At the cap exactly it passes (the session.count point adds one, so one fewer here).
  assert.equal(readExport(exportOf(many.slice(0, OTEL_POINTS_MAX - 1)), lookup).points.length, OTEL_POINTS_MAX - 1);
  // A point with exactly the cap of attributes passes; one more is refused.
  const withAttrs = n => ({ ...point({ tag: 'atlas' }), attributes: [str('type', 'input'), str(AGENT_TAG, 'atlas'), ...Array.from({ length: n - 2 }, (_, i) => str(`x.${i}`, 'v'))] });
  assert.equal(readExport(exportOf([withAttrs(OTEL_ATTRS_MAX)]), lookup).points.length, 1);
  refused(exportOf([withAttrs(OTEL_ATTRS_MAX + 1)]));
  refused(exportOf([point({ tag: 'atlas', extra: [str('long', 'v'.repeat(1025))] })]));
  refused(exportOf([point({ tag: 'atlas', extra: [{ key: 'k'.repeat(129), value: { stringValue: 'v' } }] })]));
  refused(exportOf([point({ tag: 'atlas', extra: [{ value: { stringValue: 'v' } }] })]));
  refused(exportOf([5]));
  // A non-string value is fine: it only counts towards the series' hash.
  assert.equal(readExport(exportOf([point({ tag: 'atlas', extra: [{ key: 'n', value: { intValue: '3' } }] })]), lookup).points.length, 1);
});

test("whose tokens a point's are follows the transcripts' rules", () => {
  // A roster agent by key or by name, in any case.
  assert.equal(agentFor({ agentName: 'forge', tag: 'atlas' }, lookup), 'forge');
  assert.equal(agentFor({ agentName: 'FORGE', tag: undefined }, lookup), 'forge');
  assert.equal(agentFor({ agentName: ' Quill ', tag: 'nobody' }, lookup), 'quill');
  // The session's own requests: its tag.
  assert.equal(agentFor({ agentName: undefined, tag: 'Atlas' }, lookup), 'atlas');
  assert.equal(agentFor({ agentName: undefined, tag: 'quill' }, lookup), 'quill');
  // A helper (a built-in, or "custom") in the lead's session is the lead's; in another's, other.
  assert.equal(agentFor({ agentName: 'general-purpose', tag: 'atlas' }, lookup), 'atlas');
  assert.equal(agentFor({ agentName: 'custom', tag: 'atlas' }, lookup), 'atlas');
  assert.equal(agentFor({ agentName: 'Explore', tag: 'quill' }, lookup), OTHER);
  // No tag, or a tag that isn't on the roster: other.
  assert.equal(agentFor({ agentName: undefined, tag: undefined }, lookup), OTHER);
  assert.equal(agentFor({ agentName: undefined, tag: 'stranger' }, lookup), OTHER);
  assert.equal(agentFor({ agentName: 'stranger', tag: undefined }, lookup), OTHER);
  // A roster name that isn't its key.
  const named = rosterLookup({ agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'sentinel', name: 'Night Watch' }] });
  assert.equal(agentFor({ agentName: 'night watch', tag: undefined }, named), 'sentinel');
  assert.equal(agentFor({ agentName: undefined, tag: 'Night Watch' }, named), 'sentinel');
  // An empty roster has no lead: everything is other.
  const none = rosterLookup({ agents: [] });
  assert.equal(agentFor({ agentName: 'forge', tag: 'atlas' }, none), OTHER);
  assert.equal(OTHER, '~other');
});

// ---- the store ----

const storeAt = async (clock, extra = {}) => {
  const dir = await tempDir();
  const path = join(dir, 'otel.json');
  const timers = [];
  const store = createOtelStore({ path, clock, log: () => {}, setTimer: fn => timers.push(fn), ...extra });
  return { store, path, dir, timers };
};
const cell = (snap, at, agent) => snap.hours[String(hourOf(at))]?.[agent] ?? null;

test('delta points add their values to their hour', async () => {
  let now = NOW;
  const { store } = await storeAt(() => now);
  const read = readExport(exportOf([point({ value: 10, tag: 'atlas' }), point({ value: 3, tag: 'atlas', type: 'cacheRead' }), point({ value: 4, tag: 'atlas', source: 'auxiliary' })], { temporality: 1 }), lookup);
  assert.equal(store.ingest(read), 17);
  assert.equal(store.ingest(read), 17);
  assert.deepEqual(cell(store.snapshot(), NOW - 5 * MIN, 'atlas'), [20, 6, 8]);
  // A point from the future counts now; one older than the store keeps, not at all.
  const odd = readExport(exportOf([point({ value: 1, tag: 'forge', at: NOW + HOUR }), point({ value: 9, tag: 'forge', at: NOW - OTEL_KEEP_MS - MIN })], { temporality: 1 }), lookup);
  assert.equal(store.ingest(odd), 1);
  assert.deepEqual(cell(store.snapshot(), NOW, 'forge'), [1, 0, 0]);
});

test('a cumulative series counts what it adds between exports; one that began before the store, only from then on', async () => {
  let now = NOW;
  const { store } = await storeAt(() => now);
  const since = store.snapshot().since;
  // Began after the store: all of it counts.
  const fresh = v => readExport(exportOf([point({ value: v, tag: 'forge', start: since + MIN, at: now })]), lookup);
  assert.equal(store.ingest(fresh(100)), 100);
  now += MIN;
  assert.equal(store.ingest(fresh(130)), 30);
  now += MIN;
  assert.equal(store.ingest(fresh(130)), 0);
  // A lower reading is a new start (the process began again under the same attributes).
  now += MIN;
  assert.equal(store.ingest(fresh(12)), 12);
  // Began before the store: the first reading is the baseline.
  const old = v => readExport(exportOf([point({ value: v, tag: 'quill', start: since - DAY, at: now })]), lookup);
  assert.equal(store.ingest(old(5000)), 0);
  now += MIN;
  assert.equal(store.ingest(old(5600)), 600);
  // No start time at all: a baseline too.
  const none = readExport(exportOf([point({ value: 70, tag: 'quill', start: null, at: now })]), lookup);
  assert.equal(store.ingest(none), 0);
  const snap = store.snapshot();
  assert.equal(snap.hours[String(hourOf(NOW))].forge[0], 142);
  assert.equal(snap.hours[String(hourOf(NOW))].quill[0], 600);
  assert.equal(snap.posts, 7);
  assert.equal(snap.lastAt, now);
});

test('the store saves 0600 through a temp file, keeps only counts and hashes, and loads them back', async () => {
  let now = NOW;
  const { store, path, dir, timers } = await storeAt(() => now);
  store.ingest(readExport(exportOf([point({ value: 100, tag: 'forge', start: NOW, agent: 'custom', extra: [str('mcp_server.name', 'secret-server'), str('skill.name', 'a-skill'), str('mcp_tool.name', 'a-tool')] })]), lookup));
  assert.equal(timers.length, 1, 'one save is scheduled');
  await timers[0]();
  await store.save();
  const text = await readFile(path, 'utf8');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const word of ['owner@example.com', 'sess-1111', 'acct-3333', 'org-2222', 'device-0000', 'claude-test-5', 'tmux', 'secret-server', 'a-skill', 'a-tool', 'custom', 'main', 'high']) {
    assert.ok(!text.includes(word), word);
  }
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), ['otel.json']);
  const again = createOtelStore({ path, clock: () => now, log: () => {} });
  assert.equal(await again.load(), 'loaded');
  assert.deepEqual(again.snapshot(), store.snapshot());
  // The same series carries on: only the new 50 count.
  now += MIN;
  assert.equal(again.ingest(readExport(exportOf([point({ value: 150, tag: 'forge', start: NOW, agent: 'custom', extra: [str('mcp_server.name', 'secret-server'), str('skill.name', 'a-skill'), str('mcp_tool.name', 'a-tool')] })]), lookup)), 50);
});

test('a missing or unreadable store starts empty and says so', async () => {
  const lines = [];
  const dir = await tempDir();
  const path = join(dir, 'otel.json');
  assert.equal(await createOtelStore({ path, clock: () => NOW, log: l => lines.push(l) }).load(), 'none');
  for (const text of ['{', '[]', '{"v":2,"since":1}', '{"v":1}']) {
    await writeFile(path, text);
    const s = createOtelStore({ path, clock: () => NOW, log: l => lines.push(l) });
    assert.equal(await s.load(), 'unreadable', text);
    assert.equal(s.snapshot().since, NOW);
  }
  assert.equal(lines.length, 4);
  assert.ok(lines.every(l => l === 'otel: the store is not one this server wrote; starting empty'));
});

test('loading drops bad entries and old hours, and keeps the good', async () => {
  const dir = await tempDir();
  const path = join(dir, 'otel.json');
  const h = hourOf(NOW);
  const good = 'A'.repeat(22);
  await writeFile(path, JSON.stringify({
    v: 1, since: NOW - DAY, lastAt: NOW - MIN, redactedAt: 'x', posts: -3,
    hours: { [h]: { atlas: [1, 2, 3], forge: [1, 2], quill: [1, -2, 3], ['x'.repeat(42)]: [1, 1, 1] }, [h - OTEL_KEEP_MS - HOUR]: { atlas: [9, 9, 9] }, soon: { atlas: [1, 1, 1] } },
    series: { [good]: [5, NOW - MIN], short: [1, NOW], ['B'.repeat(22)]: [1, NOW - OTEL_KEEP_MS - MIN], ['C'.repeat(22)]: ['x', NOW] }
  }));
  const s = createOtelStore({ path, clock: () => NOW, log: () => {} });
  assert.equal(await s.load(), 'loaded');
  const snap = s.snapshot();
  assert.deepEqual(snap.hours, { [h]: { atlas: [1, 2, 3] } });
  assert.deepEqual(snap.series, { [good]: [5, NOW - MIN] });
  assert.equal(snap.redactedAt, null);
  assert.equal(snap.posts, 0);
  assert.equal(snap.since, NOW - DAY);
});

test("restoring keeps only a roster key's spelling or Other's as a cell's key: no __proto__ or constructor", async () => {
  const dir = await tempDir();
  const path = join(dir, 'otel.json');
  const h = String(hourOf(NOW));
  const h2 = String(hourOf(NOW - 2 * HOUR));
  await writeFile(path, `{"v":1,"since":${NOW - DAY},"hours":{"${h}":{"__proto__":[5,5,5],"constructor":[6,6,6],"Bad Key":[7,7,7],"UPPER":[8,8,8],"atlas":[1,1,1],"~other":[2,2,2]},"${h2}":{"atlas":[1,0,0]}}}`);
  const s = createOtelStore({ path, clock: () => NOW, log: () => {} });
  assert.equal(await s.load(), 'loaded');
  // `constructor` is a spelling a roster key may have; `__proto__` and the rest are not.
  assert.deepEqual(s.snapshot().hours, { [h]: { constructor: [6, 6, 6], atlas: [1, 1, 1], '~other': [2, 2, 2] }, [h2]: { atlas: [1, 0, 0] } });
  // Points for such a key land in its own cell: in a restored hour that has it, one that
  // doesn't, and a new one.
  const odd = rosterLookup({ agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'constructor', name: 'Builder' }] });
  s.ingest(readExport(exportOf([point({ value: 3, agent: 'constructor', at: NOW }), point({ value: 4, agent: 'constructor', at: NOW - 2 * HOUR }), point({ value: 2, agent: 'constructor', at: NOW - 3 * HOUR })], { temporality: 1 }), odd));
  assert.deepEqual(s.snapshot().hours[h].constructor, [9, 6, 6]);
  assert.deepEqual(s.snapshot().hours[h2], { atlas: [1, 0, 0], constructor: [4, 0, 0] });
  assert.deepEqual(s.snapshot().hours[String(hourOf(NOW - 3 * HOUR))], { constructor: [2, 0, 0] });
});

test('past the series cap, the series seen longest ago are forgotten', async () => {
  let now = NOW;
  const { store } = await storeAt(() => now);
  const since = store.snapshot().since;
  // Each series its own by an attribute, all started when the store began.
  const batch = (n, offset) => readExport(exportOf(Array.from({ length: n }, (_, i) => point({ value: 1, tag: 'atlas', start: since, at: now, extra: [str('n', String(offset + i))] }))), lookup);
  for (let k = 0; k < OTEL_SERIES_MAX / 4000; k += 1) { store.ingest(batch(4000, k * 4000)); now += 1; }
  assert.equal(Object.keys(store.snapshot().series).length, OTEL_SERIES_MAX);
  now += 1;
  store.ingest(batch(10, OTEL_SERIES_MAX));
  const series = store.snapshot().series;
  assert.equal(Object.keys(series).length, OTEL_SERIES_MAX);
  // The ten newest are there, and the first batch's ten oldest are not (they share a time,
  // so which ten went is not fixed: count the first batch).
  assert.equal(Object.values(series).filter(([, seen]) => seen === NOW).length, 4000 - 10);
  assert.equal(store.snapshot().evictedAt, now);
  // The forgotten ten come back with the same totals: they started before the eviction,
  // so they are baselines, not counted again from zero (Ultron's L4).
  now += 1;
  assert.equal(store.ingest(batch(4000, 0)), 0);
  // A series that starts after the eviction counts in full.
  const late = readExport(exportOf([point({ value: 9, tag: 'atlas', start: store.snapshot().evictedAt, at: now, extra: [str('n', 'late')] })]), lookup);
  assert.equal(store.ingest(late), 9);
});

test('the eviction time is kept on disk', async () => {
  const dir = await tempDir();
  const path = join(dir, 'otel.json');
  await writeFile(path, JSON.stringify({ v: 1, since: NOW - DAY, evictedAt: NOW - HOUR, hours: {}, series: {} }));
  const s = createOtelStore({ path, clock: () => NOW, log: () => {} });
  await s.load();
  assert.equal(s.snapshot().evictedAt, NOW - HOUR);
  assert.equal(s.ingest(readExport(exportOf([point({ value: 5, tag: 'atlas', start: NOW - 2 * HOUR, at: NOW })]), lookup)), 0);
  assert.equal(s.ingest(readExport(exportOf([point({ value: 5, tag: 'forge', start: NOW - HOUR, at: NOW })]), lookup)), 5);
  await writeFile(path, JSON.stringify({ v: 1, since: NOW - DAY, evictedAt: 'soon', hours: {}, series: {} }));
  const t = createOtelStore({ path, clock: () => NOW, log: () => {} });
  await t.load();
  assert.equal(t.snapshot().evictedAt, null);
});

test('saving forgets hours and series older than the store keeps', async () => {
  let now = NOW;
  const { store, path } = await storeAt(() => now);
  store.ingest(readExport(exportOf([point({ value: 7, tag: 'atlas', start: NOW, at: NOW })]), lookup));
  now = NOW + OTEL_KEEP_MS + HOUR;
  store.ingest(readExport(exportOf([point({ value: 1, tag: 'forge', at: now }, )], { temporality: 1 }), lookup));
  await store.save();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved.hours), [String(hourOf(now))]);
  assert.deepEqual(saved.series, {});
});

test('a failed write keeps the counts, says so, leaves no temp file, and the next save tries again', async () => {
  const lines = [];
  const dir = await tempDir();
  const path = join(dir, 'otel.json');
  // A folder where the file should be: the temp file is written, and the rename fails.
  const { mkdir, readdir } = await import('node:fs/promises');
  await mkdir(join(path, 'inside'), { recursive: true });
  const s = createOtelStore({ path, clock: () => NOW, log: l => lines.push(l), setTimer: () => {} });
  s.ingest(readExport(exportOf([point({ value: 7, tag: 'atlas' })], { temporality: 1 }), lookup));
  await s.save();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^otel: the store could not be written \((EISDIR|ENOTEMPTY|EEXIST|EPERM)\)$/);
  assert.deepEqual(await readdir(dir), ['otel.json'], 'no temp file is left beside it');
  assert.equal(cell(s.snapshot(), NOW - 5 * MIN, 'atlas')[0], 7);
  // With the folder gone, the next save writes what the failed one could not.
  await rm(path, { recursive: true });
  await s.save();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hours[String(hourOf(NOW - 5 * MIN))].atlas[0], 7);
});

// ---- the cross-check and the panel ----

const snapWith = (since, cells) => ({ since, lastAt: NOW - MIN, redactedAt: null, hours: cells, series: {} });
const transcriptWith = (byAgent, all) => ({ byAgent, all });

test('the cross-check compares the last 24 complete hours, agent by agent and in all', () => {
  const h = hourOf(NOW);
  const snapshot = snapWith(NOW - 3 * DAY, {
    [h - HOUR]: { atlas: [100000, 5, 999999], forge: [70000, 0, 0], [OTHER]: [1000, 0, 0] },
    [h - 30 * HOUR]: { atlas: [999999, 0, 0] },
    [h]: { atlas: [999999, 0, 0] }
  });
  const transcript = transcriptWith({ atlas: { [h - HOUR]: 90000 }, forge: { [h - 2 * HOUR]: 30000 }, quill: { [h - HOUR]: 10 } }, { [h - HOUR]: 171000, [h]: 5 });
  const check = crossCheck({ snapshot, transcript, agents: ['atlas', 'forge', 'quill'], now: NOW });
  assert.equal(check.from, h - DAY);
  assert.equal(check.to, h);
  assert.deepEqual(check.rows, [
    { key: 'atlas', otel: 100000, transcripts: 90000, verdict: 'matches' },
    { key: 'forge', otel: 70000, transcripts: 30000, verdict: 'differs' },
    { key: 'quill', otel: 0, transcripts: 10, verdict: 'small' }
  ]);
  assert.deepEqual(check.total, { otel: 171000, transcripts: 171000, verdict: 'matches' });
});

test("the check's edges: 20% apart still matches, more differs, and the floor is the larger count", () => {
  const h = hourOf(NOW);
  const one = (o, t) => crossCheck({ snapshot: snapWith(NOW - 3 * DAY, { [h - HOUR]: { atlas: [o, 0, 0] } }), transcript: transcriptWith({ atlas: { [h - HOUR]: t } }, {}), agents: ['atlas'], now: NOW }).rows[0].verdict;
  assert.equal(one(100000, 80000), 'matches');
  assert.equal(one(80000, 100000), 'matches');
  assert.equal(one(100000, 79999), 'differs');
  assert.equal(one(79999, 100000), 'differs');
  assert.equal(one(CHECK_FLOOR, 0), 'differs');
  assert.equal(one(0, CHECK_FLOOR), 'differs');
  assert.equal(one(CHECK_FLOOR - 1, 0), 'small');
  // The 2026-10-20 over-count: the transcripts read 3x.
  assert.equal(one(50e6, 150e6), 'differs');
});

test('the check starts with the first complete hour after the store began, and waits for one', () => {
  const h = hourOf(NOW);
  const t = transcriptWith({ atlas: { [h - HOUR]: 5, [h - 2 * HOUR]: 7 } }, {});
  // Began 13:40: 14:00-15:00 is the one complete hour.
  const late = crossCheck({ snapshot: snapWith(h - 80 * MIN, {}), transcript: t, agents: ['atlas'], now: NOW });
  assert.equal(late.from, h - HOUR);
  assert.equal(late.rows[0].transcripts, 5);
  // Began 14:10: no complete hour yet.
  assert.equal(crossCheck({ snapshot: snapWith(h - 50 * MIN, {}), transcript: t, agents: ['atlas'], now: NOW }), null);
  assert.equal(crossCheck({ snapshot: snapWith(NOW - DAY, {}), transcript: null, agents: ['atlas'], now: NOW }), null);
  assert.equal(crossCheck({ snapshot: null, transcript: t, agents: ['atlas'], now: NOW }), null);
});

test('the panel says off, unset or failed without counts, and waiting until the first post', () => {
  const unset = buildOtelPanel({ settings: readOtelConfig({}), receiver: 'off', snapshot: null, transcript: null, roster, now: NOW });
  assert.equal(unset.state, 'unset');
  assert.deepEqual(unset.agents, []);
  assert.equal(buildOtelPanel({ settings: readOtelConfig({ otel: { enabled: false } }), receiver: 'off', snapshot: null, roster, now: NOW }).state, 'off');
  const on = readOtelConfig({ otel: { enabled: true } });
  const failed = buildOtelPanel({ settings: on, receiver: 'failed', snapshot: snapWith(NOW, {}), roster, now: NOW });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.port, 8323);
  const waiting = buildOtelPanel({ settings: on, receiver: 'listening', snapshot: { ...snapWith(NOW - DAY, {}), lastAt: null }, transcript: transcriptWith({}, {}), roster, now: NOW });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.since, null);
  assert.equal(waiting.check, null);
});

test("the panel's figures: each roster agent's 24 h and 7 d, background included, cache reads apart, and other", () => {
  const h = hourOf(NOW);
  const snapshot = {
    ...snapWith(NOW - 10 * DAY, {
      [h]: { atlas: [10, 1, 2] },
      [h - 23 * HOUR]: { atlas: [100, 0, 0], [OTHER]: [5, 0, 0] },
      [h - 24 * HOUR]: { atlas: [1000, 10, 0] },
      [h - 6 * DAY - 23 * HOUR]: { forge: [7, 3, 0] },
      [h - 7 * DAY]: { forge: [70000, 0, 0] }
    }),
    redactedAt: NOW - 2 * HOUR
  };
  const panel = buildOtelPanel({ settings: readOtelConfig({ otel: { enabled: true } }), receiver: 'listening', snapshot, transcript: transcriptWith({}, {}), roster, now: NOW });
  assert.equal(panel.state, 'on');
  assert.equal(panel.since, NOW - 10 * DAY);
  assert.deepEqual(panel.agents, [
    { key: 'atlas', tokens24h: 112, tokens7d: 1112, cacheRead7d: 11 },
    { key: 'forge', tokens24h: 0, tokens7d: 7, cacheRead7d: 3 },
    { key: 'quill', tokens24h: 0, tokens7d: 0, cacheRead7d: 0 }
  ]);
  assert.deepEqual(panel.other, { tokens24h: 5, tokens7d: 5, cacheRead7d: 0 });
  assert.equal(panel.redacted, true);
  assert.equal(buildOtelPanel({ settings: readOtelConfig({ otel: { enabled: true } }), receiver: 'listening', snapshot: { ...snapshot, redactedAt: NOW - DAY }, transcript: null, roster, now: NOW }).redacted, false);
  // Nothing but counts, times and keys reaches the page.
  assert.deepEqual(Object.keys(panel).sort(), ['agents', 'check', 'lastAt', 'other', 'port', 'redacted', 'since', 'state']);
});

test('the check log writes once when an agent starts to differ, and once when it agrees again', () => {
  const lines = [];
  const note = createCheckLog({ log: l => lines.push(l) });
  const h = hourOf(NOW);
  const check = verdict => ({ from: h - DAY, to: h, rows: [{ key: 'forge', otel: 70000, transcripts: 30000, verdict }, { key: 'atlas', otel: 1, transcripts: 1, verdict: 'small' }], total: { otel: 1, transcripts: 1, verdict: 'matches' } });
  note(check('differs'));
  note(check('differs'));
  note(null);
  note(check('differs'));
  note(check('matches'));
  assert.deepEqual(lines, [
    `otel: the cross-check differs for forge: 70000 new tokens from OpenTelemetry, 30000 from the transcripts, over the 24 h to ${new Date(h).toISOString()}`,
    'otel: the cross-check agrees again for forge',
    `otel: the cross-check differs for forge: 70000 new tokens from OpenTelemetry, 30000 from the transcripts, over the 24 h to ${new Date(h).toISOString()}`,
    'otel: the cross-check agrees again for forge'
  ]);
  const total = [];
  createCheckLog({ log: l => total.push(l) })({ from: h - HOUR, to: h, rows: [], total: { otel: 1e6, transcripts: 3e6, verdict: 'differs' } });
  assert.match(total[0], /^otel: the cross-check differs for all: 1000000 new tokens/);
});

// ---- the receiver, over a real socket ----

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

const receiverAt = async (extra = {}) => {
  let now = NOW;
  const lines = [];
  const { store } = await storeAt(() => now);
  // The port must be known before the handler's Host rule: listen first, then wire it.
  let handler = null;
  const server = createServer((req, res) => handler(req, res).catch(err => { res.writeHead(500); res.end(String(err)); }));
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  handler = createOtelReceiver({ store, port, roster, log: l => lines.push(l), clock: () => now, setTimer: () => {}, ...extra });
  const post = ({ path = '/v1/metrics', method = 'POST', body = exportOf([point({ tag: 'atlas', value: 10 })], { temporality: 1 }), headers = {}, raw = null } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'Content-Length': data.length }), ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : data);
  });
  return { post, store, lines, port, tick: ms => { now += ms; } };
};

test('a good export is counted and answered 200 {}', async () => {
  const { post, store } = await receiverAt();
  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(r.body, '{}');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(cell(store.snapshot(), NOW - 5 * MIN, 'atlas')[0], 10);
  // localhost by name is this port on loopback too.
  const { port } = await receiverAt();
  assert.ok(port > 0);
});

test('the receiver refuses, in order: another Host, a browser, another path, another method', async () => {
  const { post, store, lines, port } = await receiverAt();
  const cases = [
    [{ headers: { Host: 'attacker.example:1234' } }, 421],
    [{ headers: { Host: `127.0.0.1:${port + 1}` } }, 421],
    [{ headers: { Host: '127.0.0.1' } }, 421],
    [{ headers: { Origin: `http://127.0.0.1:${port}` } }, 403],
    [{ headers: { Origin: 'null' } }, 403],
    [{ path: '/v1/logs' }, 404],
    [{ path: '/v1/traces' }, 404],
    [{ path: '/v1/metrics/extra' }, 404],
    [{ path: '/' }, 404],
    [{ method: 'GET' }, 405],
    [{ method: 'PUT' }, 405]
  ];
  for (const [opts, status] of cases) {
    const r = await post(opts);
    assert.equal(r.status, status, JSON.stringify(opts));
    assert.equal(r.headers.connection, 'close', JSON.stringify(opts));
  }
  assert.equal((await post({ method: 'GET' })).headers.allow, 'POST');
  assert.equal(store.snapshot().posts, 0, 'nothing was counted');
  // Lines name the path and a fixed reason, never a header's value.
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(l.startsWith('otel: refused'), l);
    assert.ok(!l.includes('attacker') && !l.includes(String(port + 1)), l);
  }
  assert.ok(lines.some(l => /to \/v1\/logs that is not \/v1\/metrics/.test(l)));
  assert.ok(lines.some(l => /to another path that is not \/v1\/metrics/.test(l)));
  const local = await receiverAt();
  assert.equal((await local.post({ headers: { Host: `localhost:${local.port}` } })).status, 200);
  assert.equal((await local.post({ headers: { Host: `LOCALHOST:${local.port}` } })).status, 200);
});

test('the receiver refuses compressed, non-JSON, over-size and malformed bodies', async () => {
  const { post, store } = await receiverAt();
  assert.equal((await post({ headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await post({ headers: { 'Content-Encoding': 'identity' } })).status, 200);
  assert.equal((await post({ headers: { 'Content-Type': 'application/x-protobuf' } })).status, 415);
  assert.equal((await post({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post({ headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
  const big = Buffer.alloc(OTEL_BODY_MAX + 1, 0x20);
  assert.equal((await post({ raw: big })).status, 413);
  // At the cap exactly, the body is read (and here, being only spaces, is not JSON).
  assert.equal((await post({ raw: Buffer.alloc(OTEL_BODY_MAX, 0x20) })).status, 400);
  assert.equal((await post({ body: '{"resourceMetrics": [' })).status, 400);
  assert.equal((await post({ body: { resourceMetrics: 'x' } })).status, 400);
  assert.equal(store.snapshot().posts, 2);
});

test('a body over the cap with no length given is cut off at the cap', async () => {
  const { port, store } = await receiverAt();
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/metrics', method: 'POST', agent: false, headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', err => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? resolve('closed') : reject(err)));
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    for (let i = 0; i < 5; i += 1) req.write(chunk);
    req.end();
  });
  assert.ok(status === 413 || status === 'closed', String(status));
  assert.equal(store.snapshot().posts, 0);
});

test('past the posts a minute, a 429 with Retry-After; refused posts count too, and the minute moves on', async () => {
  const { post, tick, store } = await receiverAt();
  for (let i = 0; i < OTEL_POSTS_PER_MINUTE - 1; i += 1) assert.equal((await post()).status, 200);
  assert.equal((await post({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const held = await post();
  assert.equal(held.status, 429);
  assert.equal(held.headers['retry-after'], '60');
  // 29.5 s left is said as 30 (rounded up, so a sender that waits that long gets in).
  tick(30500);
  assert.equal((await post()).headers['retry-after'], '30');
  tick(29500);
  assert.equal((await post()).status, 200);
  assert.equal(store.snapshot().posts, OTEL_POSTS_PER_MINUTE);
  // Refusals before the limit (a wrong Host) are not counted against it.
  const fresh = await receiverAt();
  for (let i = 0; i < 5; i += 1) await fresh.post({ path: '/v1/logs' });
  for (let i = 0; i < OTEL_POSTS_PER_MINUTE; i += 1) assert.equal((await fresh.post()).status, 200);
});

// ---- the wiring in server.mjs (it can't run in a test) ----

test('server.mjs starts the receiver only when config turns it on, on 127.0.0.1 only, with the base headers', async () => {
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const otelStore = otelSettings\.on \? createOtelStore\(/);
  assert.match(src, /if \(otelStore\) \{/);
  // Every listen of the receiver's server names loopback (one call, the address its second argument).
  const listens = [...src.matchAll(/otelServer\.listen\(([^,]*),\s*([^,]*),/g)].map(m => [m[1].trim(), m[2].trim()]);
  assert.deepEqual(listens, [['otelSettings.port', "'127.0.0.1'"]]);
  assert.equal((src.match(/otelServer\.listen\(/g) ?? []).length, 1);
  assert.match(src, /const otelServer = createServer\(async \(req, res\) => \{\s*setBaseHeaders\(res\);/);
  assert.match(src, /otelServer\.requestTimeout = 10e3;/);
  assert.match(src, /otelServer\.maxConnections = 32;/);
  assert.match(src, /otelServer\.keepAliveTimeout = 2e3;/);
  assert.match(src, /registry\.register\('otel', /);
  assert.match(src, /transcriptHours = agentHours\(\{ transcripts, sessionNames, roster, now \}\);/);
});

// Over a real socket Node's client sends Connection: close itself, so the answer carries it
// whatever the route does: a mock response sees the route's own headers.
test('every refusal sets Connection: close itself, and a good post does not', async () => {
  const { Readable } = await import('node:stream');
  const { store } = await storeAt(() => NOW);
  const handler = createOtelReceiver({ store, port: 9555, roster, log: () => {}, clock: () => NOW, setTimer: () => {} });
  const call = async (headers, body = JSON.stringify(exportOf([point({ tag: 'atlas' })], { temporality: 1 })), url = '/v1/metrics', method = 'POST') => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { url, method, headers: { host: '127.0.0.1:9555', 'content-type': 'application/json', ...headers } });
    const res = { status: null, headers: null, writeHead(code, h) { if (this.status !== null) throw new Error('second writeHead'); this.status = code; this.headers = h; }, end() {} };
    await handler(req, res);
    return res;
  };
  for (const [h, url, method, status] of [[{ host: 'elsewhere:9555' }, '/v1/metrics', 'POST', 421], [{ origin: 'http://x' }, '/v1/metrics', 'POST', 403], [{}, '/v1/logs', 'POST', 404],
    [{}, '/v1/metrics', 'GET', 405], [{ 'content-encoding': 'gzip' }, '/v1/metrics', 'POST', 415], [{ 'content-type': 'text/plain' }, '/v1/metrics', 'POST', 415],
    [{ 'content-length': String(OTEL_BODY_MAX + 1) }, '/v1/metrics', 'POST', 413]]) {
    const res = await call(h, undefined, url, method);
    assert.equal(res.status, status, `${status}`);
    assert.equal(res.headers.Connection, 'close', `${status}`);
  }
  const bad = await call({}, '{"resourceMetrics": 5}');
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.Connection, 'close');
  const good = await call({});
  assert.equal(good.status, 200);
  assert.equal(good.headers.Connection, undefined);
});
