// Acknowledging a known miss (lib/acks.mjs, acks.mjs, and the routes that use
// them). Every label, name and figure here is invented. Times are plain numbers,
// so the tests hold in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeAcks, matchingAck, applyAcks, checkAckRequest, makeAck, addAck, removeAck, decoratePayload, sameSince, ambiguousNames,
  ACK_MAX, ACK_CAP_MS, ACK_AFTER_NEXT_MS, ACK_NO_NEXT_MS, ACK_UNKNOWN_SINCE_CAP_MS, SINCE_TOLERANCE_MS, PAGE_BY, LOCAL_BY, ackLogLine,
  unackLogLine, ackNotice, noticeTime, renewalsOf, NTFY_ACK_WORDS, NTFY_RENEW_WORDS
} from '../lib/acks.mjs';
import { createAckStore } from '../acks.mjs';
import { createCache } from '../cache.mjs';
import { createHandler, ACK_WRITES_PER_MINUTE } from '../routes.mjs';
import { createAckNoticeLimiter, createAckNotices, ntfyFlushSuffix } from '../lib/ack-notice-limit.mjs';
import { runNotifier } from '../collectors/notifier.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = 1794380000000;
const SINCE = NOW - 270 * HOUR;
const NEXT = NOW + 3 * DAY;
const KEY = 'cron:launchd:com.example.friday';

const cronAlert = (extra = {}) => ({ text: 'friday cron Overdue · log 270 h old', kind: 'cron', key: KEY, since: SINCE, nextRunAt: NEXT, ...extra });
const serviceAlert = { text: 'Tunnel is not running', kind: 'service', key: 'service:launchd:Tunnel', since: NOW - HOUR };
const limitAlert = { text: 'Weekly at 90%', kind: 'limit', key: 'limit:Weekly' };
const ack = (extra = {}) => ({ key: KEY, kind: 'cron', since: SINCE, by: 'jeff', note: 'mini restarted before login', at: NOW, until: NEXT + ACK_AFTER_NEXT_MS, ...extra });

// ---- matching ----

test('an ack covers the alert with its key and instance, and that alert moves to acked', () => {
  const { alerts, acked } = applyAcks([cronAlert(), limitAlert], [ack()], NOW);
  assert.deepEqual(alerts, [limitAlert]);
  assert.equal(acked.length, 1);
  assert.equal(acked[0].key, KEY);
  assert.equal(acked[0].text, cronAlert().text, 'the alert itself is unchanged');
  assert.deepEqual(acked[0].ack, { key: KEY, kind: 'cron', since: SINCE, by: 'jeff', note: 'mini restarted before login', at: NOW, until: NEXT + ACK_AFTER_NEXT_MS, renewals: 0 });
});

test('a new failure is never covered: the job ran again and failed, so since moved', () => {
  const again = cronAlert({ since: SINCE + 7 * DAY });
  assert.equal(matchingAck(again, [ack()], NOW), null);
  const { alerts, acked } = applyAcks([again], [ack()], NOW);
  assert.equal(alerts.length, 1);
  assert.equal(acked.length, 0);
});

test('since may wander by job-status\'s rounding, but not by a schedule', () => {
  assert.ok(sameSince(SINCE, SINCE + SINCE_TOLERANCE_MS));
  assert.ok(sameSince(SINCE, SINCE - SINCE_TOLERANCE_MS));
  assert.ok(!sameSince(SINCE, SINCE + SINCE_TOLERANCE_MS + 1));
  assert.ok(sameSince(null, null), 'two unknown instances are the same instance');
  assert.ok(!sameSince(null, SINCE), 'an unknown instance never matches a known one');
  assert.ok(matchingAck(cronAlert({ since: SINCE + 30e3 }), [ack()], NOW));
});

test('an expired ack covers nothing, and lapses exactly at until', () => {
  const a = ack();
  assert.ok(matchingAck(cronAlert(), [a], a.until - 1));
  assert.equal(matchingAck(cronAlert(), [a], a.until), null);
  assert.deepEqual(activeAcks([a], a.until), []);
});

test('an ack for another key, or a non-ackable kind, covers nothing', () => {
  assert.equal(matchingAck(cronAlert(), [ack({ key: 'cron:launchd:com.example.other' })], NOW), null);
  assert.equal(matchingAck(limitAlert, [ack({ key: 'limit:Weekly', since: null })], NOW), null);
  assert.equal(matchingAck(serviceAlert, [{ ...ack(), key: serviceAlert.key, kind: 'service', since: serviceAlert.since }], NOW)?.key, serviceAlert.key);
});

test('a malformed entry in the file is ignored, never thrown on', () => {
  const bad = [null, 'x', {}, { key: KEY }, ack({ by: 'not a word' }), ack({ until: 'soon' }), ack({ note: 'n'.repeat(201) }), ack({ key: 'k\u0000' })];
  assert.deepEqual(activeAcks(bad, NOW), []);
  assert.deepEqual(activeAcks('nonsense', NOW), []);
  assert.deepEqual(activeAcks([...bad, ack()], NOW), [ack()]);
});

// ---- the request ----

test('a request is a key, an optional one-line note, an optional until and who', () => {
  assert.deepEqual(checkAckRequest({ key: KEY }, { fromPage: true }), { ok: true, value: { key: KEY, note: null, by: PAGE_BY, until: undefined } });
  assert.deepEqual(checkAckRequest({ key: KEY, note: '  next run Fri ', by: 'jarvis', until: NOW + DAY }).value,
    { key: KEY, note: 'next run Fri', by: 'jarvis', until: NOW + DAY });
  assert.equal(checkAckRequest({ key: KEY, note: '' }).value.note, null);
});

test('who acked, when the request does not say: the owner from the page, "local" from a script', () => {
  assert.equal(PAGE_BY, 'jeff');
  assert.equal(LOCAL_BY, 'local');
  assert.equal(checkAckRequest({ key: KEY }, { fromPage: true }).value.by, 'jeff');
  assert.equal(checkAckRequest({ key: KEY }).value.by, 'local', 'no Origin, no by: a script that did not name itself');
  assert.equal(checkAckRequest({ key: KEY }, { fromPage: false }).value.by, 'local');
  assert.equal(checkAckRequest({ key: KEY, by: null }).value.by, 'local');
  assert.equal(checkAckRequest({ key: KEY, by: 'jarvis' }, { fromPage: true }).value.by, 'jarvis', 'a given by always wins');
  assert.equal(checkAckRequest({ key: KEY, by: 'jarvis' }).value.by, 'jarvis');
});

test('a bad request says what is wrong', () => {
  const bad = v => { const r = checkAckRequest(v); assert.equal(r.ok, false, JSON.stringify(v)); return r.error; };
  assert.match(bad(null), /object/);
  assert.match(bad([]), /object/);
  assert.match(bad({}), /key/);
  assert.match(bad({ key: 'k'.repeat(201) }), /key/);
  assert.match(bad({ key: KEY, note: 'n'.repeat(201) }), /note/);
  assert.match(bad({ key: KEY, note: 'a\u202eb' }), /direction/);
  assert.match(bad({ key: KEY, note: 'a\nb' }), /control/);
  assert.match(bad({ key: KEY, note: 7 }), /note/);
  assert.match(bad({ key: KEY, by: 'two words' }), /by/);
  assert.match(bad({ key: KEY, by: 'x'.repeat(41) }), /by/);
  assert.match(bad({ key: KEY, until: '2026-11-13' }), /until/);
});

test('the ack takes since from the alert, and the default until from its next run plus 2 h', () => {
  const r = makeAck(cronAlert(), checkAckRequest({ key: KEY, note: 'known' }, { fromPage: true }).value, NOW);
  assert.deepEqual(r, { ok: true, value: { key: KEY, kind: 'cron', since: SINCE, by: 'jeff', note: 'known', at: NOW, until: NEXT + ACK_AFTER_NEXT_MS } });
});

test('a job with no next run, or one already past, gets 24 hours; a service too', () => {
  const req = checkAckRequest({ key: KEY }).value;
  assert.equal(makeAck(cronAlert({ nextRunAt: null }), req, NOW).value.until, NOW + ACK_NO_NEXT_MS);
  assert.equal(makeAck(cronAlert({ nextRunAt: NOW - 1 }), req, NOW).value.until, NOW + ACK_NO_NEXT_MS);
  const s = makeAck(serviceAlert, { ...req, key: serviceAlert.key }, NOW).value;
  assert.equal(s.until, NOW + ACK_NO_NEXT_MS);
  assert.equal(s.since, serviceAlert.since);
  assert.equal(s.kind, 'service');
});

test('until is the caller\'s when given, later than now and within the 14-day cap', () => {
  const req = until => ({ ...checkAckRequest({ key: KEY }).value, until });
  assert.equal(makeAck(cronAlert(), req(NOW + 7 * DAY), NOW).value.until, NOW + 7 * DAY);
  assert.equal(makeAck(cronAlert(), req(NOW + ACK_CAP_MS), NOW).value.until, NOW + ACK_CAP_MS);
  assert.match(makeAck(cronAlert(), req(NOW + ACK_CAP_MS + 1), NOW).error, /14 days/);
  assert.match(makeAck(cronAlert(), req(NOW), NOW).error, /later than now/);
  assert.match(makeAck(cronAlert(), req(NOW - 1), NOW).error, /later than now/);
});

test('the default never reaches past the cap either', () => {
  const far = cronAlert({ nextRunAt: NOW + 20 * DAY });
  assert.equal(makeAck(far, checkAckRequest({ key: KEY }).value, NOW).value.until, NOW + ACK_CAP_MS);
});

test('with no since, an ack reaches at most 24 hours: the default is cut to it, and a longer until is refused', () => {
  assert.equal(ACK_UNKNOWN_SINCE_CAP_MS, DAY);
  const unknown = cronAlert({ since: null });
  const req = until => ({ ...checkAckRequest({ key: KEY }).value, until });
  assert.equal(makeAck(unknown, req(undefined), NOW).value.until, NOW + DAY, 'next run + 2 h is 3 days off, so the cap wins');
  assert.equal(makeAck(unknown, req(undefined), NOW).value.since, null);
  assert.equal(makeAck(cronAlert({ since: null, nextRunAt: NOW + 3 * HOUR }), req(undefined), NOW).value.until, NOW + 5 * HOUR, 'a nearer next run keeps its default');
  assert.equal(makeAck(unknown, req(NOW + DAY), NOW).value.until, NOW + DAY);
  const r = makeAck(unknown, req(NOW + DAY + 1), NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /24 hours/);
  assert.match(r.error, /isn't known/);
  assert.match(makeAck(unknown, req(NOW + 7 * DAY), NOW).error, /24 hours/, 'the 7-day choice is refused');
  assert.equal(makeAck(cronAlert(), req(NOW + 7 * DAY), NOW).ok, true, 'with a since, 7 days is fine');
  assert.equal(makeAck({ ...serviceAlert, since: undefined }, { ...req(undefined), key: serviceAlert.key }, NOW).value.until, NOW + DAY);
});

test('only a live cron or service alert can be acked', () => {
  const req = checkAckRequest({ key: 'limit:Weekly' }).value;
  assert.match(makeAck(limitAlert, req, NOW).error, /moves on its own/);
  assert.match(makeAck(null, req, NOW).error, /no such alert/);
  assert.match(makeAck({ ...limitAlert, kind: 'projection' }, req, NOW).error, /moves on its own/);
  assert.match(makeAck({ ...limitAlert, kind: 'credits' }, req, NOW).error, /moves on its own/);
});

// ---- the list ----

test('adding replaces an ack for the same key, drops expired ones and keeps at most 50', () => {
  const list = addAck([ack({ note: 'old' }), ack({ key: 'cron:launchd:com.example.gone', until: NOW - 1 })], ack({ note: 'new' }), NOW);
  assert.deepEqual(list.map(a => [a.key, a.note]), [[KEY, 'new']]);
  const many = Array.from({ length: ACK_MAX }, (_, i) => ack({ key: `cron:launchd:com.example.j${i}`, at: NOW - ACK_MAX + i }));
  const full = addAck(many, ack({ key: 'cron:launchd:com.example.newest', at: NOW }), NOW);
  assert.equal(full.length, ACK_MAX);
  assert.equal(full[0].key, 'cron:launchd:com.example.j1', 'the oldest went first');
  assert.equal(full.at(-1).key, 'cron:launchd:com.example.newest');
});

test('removing drops that key only, and prunes the expired on the way', () => {
  const list = removeAck([ack(), ack({ key: 'cron:launchd:com.example.keep' }), ack({ key: 'cron:launchd:com.example.gone', until: NOW })], KEY, NOW);
  assert.deepEqual(list.map(a => a.key), ['cron:launchd:com.example.keep']);
});

// ---- the payload ----

test('a covered cron, job and service entry gains the ack; verdicts and the cache\'s own objects do not change', () => {
  const cron = { name: 'friday', label: 'com.example.friday', ok: false, state: 'failed', last: 'Overdue · log 270 h old' };
  const other = { name: 'daily', label: 'com.example.daily', ok: true, state: 'ok' };
  const job = { name: 'Friday', state: 'failed', reason: 'log 270 h old' };
  const okJob = { name: 'Friday', state: 'ok', reason: null };
  const svc = { key: 'launchd:Tunnel', kind: 'launchd', state: 'down', downSince: NOW - HOUR };
  const payload = {
    crons: { status: 'ok', data: [cron, other] },
    ingestCrons: { status: 'ok', data: [{ name: 'cloud', label: 'cloud', ok: false }] },
    health: { status: 'ok', data: { jobs: { status: 'ok', list: [job, okJob] }, services: [svc, { key: 'pi:NAS', kind: 'pi', state: 'up' }] } },
    usage: { status: 'ok', data: {} }
  };
  const { acked } = applyAcks([cronAlert(), serviceAlert, { text: 'cloud cron failed', kind: 'cron', key: 'cron:ingest:cloud', since: null, nextRunAt: null }],
    [ack(), { ...ack(), key: serviceAlert.key, kind: 'service', since: serviceAlert.since }, { ...ack(), key: 'cron:ingest:cloud', since: null }], NOW);
  assert.equal(acked.length, 3);
  // The health panel names jobs from config or the label's last part, never by label.
  const out = decoratePayload(payload, acked, { 'com.example.friday': { name: 'Friday' } });
  assert.equal(out.crons.data[0].ack.by, 'jeff');
  assert.equal(out.crons.data[0].ok, false, 'the verdict stands');
  assert.equal(out.crons.data[0].state, 'failed');
  assert.equal(out.crons.data[1].ack, undefined);
  assert.equal(out.ingestCrons.data[0].ack.key, 'cron:ingest:cloud');
  assert.equal(out.health.data.jobs.list[0].ack.key, KEY);
  assert.equal(out.health.data.jobs.list[0].state, 'failed');
  assert.equal(out.health.data.jobs.list[1].ack, undefined, 'a row that is not failed is never marked');
  assert.equal(decoratePayload(payload, acked).health.data.jobs.list[0].ack, undefined, 'with no name in config the row is "friday", not "Friday"');
  assert.equal(decoratePayload({ ...payload, health: { ...payload.health, data: { ...payload.health.data, jobs: { status: 'ok', list: [{ ...job, name: 'friday' }] } } } }, acked).health.data.jobs.list[0].ack.key, KEY);
  assert.equal(out.health.data.services[0].ack.key, serviceAlert.key);
  assert.equal(out.health.data.services[1].ack, undefined);
  assert.equal(out.usage, payload.usage, 'untouched panels are the same objects');
  assert.ok(!('ack' in cron) && !('ack' in job) && !('ack' in svc), 'the cache\'s objects are not written to');
  assert.equal(decoratePayload(payload, []), payload);
});

test('a display name two jobs share marks no health row: the ack would show on a job nobody acked', () => {
  // Two labels whose last part is the same, and no names in config: both read "friday".
  const a = { name: 'friday', label: 'com.example.a.friday', ok: false, state: 'failed', last: 'Failed · 1' };
  const b = { name: 'friday', label: 'com.example.b.friday', ok: false, state: 'failed', last: 'Failed · 1' };
  const rows = [{ name: 'friday', state: 'failed', reason: 'exit 1' }, { name: 'friday', state: 'failed', reason: 'exit 1' }];
  const payload = { crons: { status: 'ok', data: [a, b] }, health: { status: 'ok', data: { jobs: { status: 'ok', list: rows }, services: [] } } };
  const ackA = { ...ack(), key: `cron:launchd:${a.label}` };
  const { acked } = applyAcks([cronAlert({ key: ackA.key })], [ackA], NOW);
  assert.equal(acked.length, 1);
  const out = decoratePayload(payload, acked);
  assert.equal(out.crons.data[0].ack.key, ackA.key, 'the crons panel, keyed by label, still carries it');
  assert.equal(out.crons.data[1].ack, undefined);
  assert.equal(out.health.data.jobs.list[0].ack, undefined, 'neither health row is marked');
  assert.equal(out.health.data.jobs.list[1].ack, undefined);
  // Distinct names in config lift the ambiguity, and the right row is marked.
  const named = { 'com.example.a.friday': { name: 'Friday A' }, 'com.example.b.friday': { name: 'Friday B' } };
  const distinct = { ...payload, health: { status: 'ok', data: { jobs: { status: 'ok', list: [{ ...rows[0], name: 'Friday B' }, { ...rows[1], name: 'Friday A' }] }, services: [] } } };
  const fixed = decoratePayload(distinct, acked, named);
  assert.equal(fixed.health.data.jobs.list[0].ack, undefined);
  assert.equal(fixed.health.data.jobs.list[1].ack.key, ackA.key);
  // Only one of the two listed by the crons panel: still ambiguous, from the two failed rows alone.
  const oneCron = { ...payload, crons: { status: 'ok', data: [a] } };
  assert.equal(decoratePayload(oneCron, acked).health.data.jobs.list[0].ack, undefined);
  // The same label listed twice is one job, not two.
  assert.deepEqual([...ambiguousNames([a, a], [], {})], []);
  assert.deepEqual([...ambiguousNames([a, b], [], {})], ['friday']);
  assert.deepEqual([...ambiguousNames([], rows, {})], ['friday']);
  assert.deepEqual([...ambiguousNames([], [rows[0], { name: 'friday', state: 'ok' }], {})], [], 'an OK row with the name is never marked anyway');
  assert.deepEqual([...ambiguousNames(null, null)], []);
});

test('the log line names the kind, who, until when and the key, never the note', () => {
  const line = ackLogLine(ack({ note: 'private words' }));
  assert.match(line, /^ack: cron by jeff until 2026-\d\d-\d\dT.*Z \(cron:launchd:com\.example\.friday\)$/);
  assert.ok(!line.includes('private words'));
});

// ---- the file ----

test('the store reads an absent file as nothing, writes whole, prunes on read and on write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acks-'));
  try {
    const path = join(dir, 'data', 'acks.json');
    const store = createAckStore(path);
    assert.deepEqual(await store.read(NOW), []);
    await store.add(ack(), NOW);
    await store.add(ack({ key: 'cron:launchd:com.example.short', until: NOW + 1000 }), NOW);
    assert.deepEqual((await store.read(NOW)).map(a => a.key), [KEY, 'cron:launchd:com.example.short']);
    assert.deepEqual((await store.read(NOW + 1000)).map(a => a.key), [KEY], 'expired on read');
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.length, 2, 'the file keeps what was written until the next write');
    await store.remove('cron:launchd:com.example.none', NOW + 1000);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 1, 'a write prunes');
    await store.remove(KEY, NOW + 1000);
    assert.deepEqual(await store.read(NOW + 1000), []);
    await rm(path);
    await writeFile(path, '{not json'); // a fresh file, with the default mode
    assert.deepEqual(await store.read(NOW), [], 'a corrupt file reads as nothing');
    assert.notEqual((await stat(path)).mode & 0o777, 0o600);
    await store.add(ack(), NOW);
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'the file is the service user\'s alone, even replacing one that was not');
    assert.deepEqual(await readdir(join(dir, 'data')), ['acks.json'], 'no temp file is left beside it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two writes at once land in order, neither lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acks-'));
  try {
    const store = createAckStore(join(dir, 'acks.json'));
    await Promise.all([store.add(ack(), NOW), store.add(ack({ key: 'cron:launchd:com.example.two' }), NOW)]);
    assert.deepEqual((await store.read(NOW)).map(a => a.key).sort(), [KEY, 'cron:launchd:com.example.two']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write goes to a temp file first and takes the file\'s place whole: a write that fails leaves the old list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acks-'));
  try {
    const path = join(dir, 'acks.json');
    const store = createAckStore(path);
    await store.add(ack(), NOW);
    const before = await readFile(path, 'utf8');
    // A directory where the file should go: the temp file is written, then the
    // rename can't land, so the add fails and the temp file goes.
    await mkdir(join(dir, 'nested', 'acks.json'), { recursive: true });
    const bad = createAckStore(join(dir, 'nested', 'acks.json'));
    await assert.rejects(bad.add(ack(), NOW));
    assert.equal(await readFile(path, 'utf8'), before, 'the other file is untouched');
    assert.deepEqual(await readdir(join(dir, 'nested')), ['acks.json'], 'no temp file is left beside the failed write');
    assert.deepEqual((await readdir(dir)).sort(), ['acks.json', 'nested']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the routes ----

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, hdrs) => { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const call = async (handler, method, url, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method, url,
    headers: { host: '127.0.0.1:8322', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    on(evt, fn) {
      if (evt === 'data' && body !== undefined) fn(Buffer.from(raw));
      if (evt === 'end') fn();
      return req;
    },
    unpipe() {}, pause() {}
  };
  const res = mockRes();
  await handler(req, res);
  return res;
};
const memoryStore = (initial = []) => {
  let list = [...initial];
  return {
    read: async now => activeAcks(list, now),
    add: async (a, now) => { list = addAck(list, a, now); return list; },
    remove: async (k, now) => { list = removeAck(list, k, now); return list; },
    peek: () => list
  };
};
const failedCron = { name: 'friday', label: 'com.example.friday', ok: false, state: 'failed', last: 'Overdue · log 270 h old', lastRunAt: SINCE, nextRunAt: NEXT, schedule: 'Fridays, 16:45' };
const deps = (store = memoryStore()) => {
  const cache = createCache();
  cache.set('crons', [failedCron, { name: 'daily', label: 'com.example.daily', ok: true, state: 'ok' }]);
  cache.set('health', {
    jobs: { status: 'ok', error: null, list: [{ name: 'friday', schedule: 'Fridays, 16:45', state: 'failed', reason: 'log 270 h old' }] },
    services: [{ key: 'launchd:Tunnel', kind: 'launchd', name: 'Tunnel', state: 'down', downSince: Date.now() - HOUR }]
  });
  cache.set('usage', { limits: [{ label: 'Weekly', pct: 90 }] });
  const todos = { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) };
  const logged = [];
  return { cache, todos, config: { warnThreshold: 85, showAlertBanner: true, present: true }, acks: store, log: line => logged.push(line), logged, store };
};
const dashboard = async handler => JSON.parse((await call(handler, 'GET', '/api/dashboard')).body);

test('POST /api/acks acks a live alert, which then leaves alerts for acked and marks its cron, job and service', async () => {
  const d = deps();
  const h = createHandler(d);
  const before = await dashboard(h);
  assert.deepEqual(before.alerts.map(a => a.key).sort(), ['cron:launchd:com.example.friday', 'limit:Weekly', 'service:launchd:Tunnel']);
  assert.deepEqual(before.acked, []);
  assert.deepEqual(before.acks, []);

  const res = await call(h, 'POST', '/api/acks', { key: KEY, note: 'mini restarted before login' }, { origin: 'http://127.0.0.1:8322' });
  assert.equal(res.statusCode, 200, res.body);
  const list = JSON.parse(res.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].since, SINCE, 'since comes from the cron, not the caller');
  assert.equal(list[0].until, NEXT + ACK_AFTER_NEXT_MS);
  assert.equal(list[0].by, 'jeff', 'the page (an Origin header) is the owner');
  assert.equal(d.logged.length, 1);
  assert.match(d.logged[0], /^ack: cron by jeff until /);

  const after = await dashboard(h);
  assert.deepEqual(after.alerts.map(a => a.key).sort(), ['limit:Weekly', 'service:launchd:Tunnel']);
  assert.equal(after.acked.length, 1);
  assert.equal(after.acked[0].key, KEY);
  assert.equal(after.acked[0].ack.note, 'mini restarted before login');
  assert.equal(after.acks.length, 1);
  assert.equal(after.crons.data[0].ack.by, 'jeff');
  assert.equal(after.crons.data[0].ok, false);
  assert.equal(after.crons.data[0].state, 'failed');
  assert.equal(after.crons.data[1].ack, undefined);
  assert.equal(after.health.data.jobs.list[0].ack.key, KEY);
  assert.equal(after.health.data.jobs.list[0].state, 'failed');
  assert.equal(d.cache.get('crons', Date.now()).data[0].ack, undefined, 'the cache is not written to');

  const svc = await call(h, 'POST', '/api/acks', { key: 'service:launchd:Tunnel', by: 'jarvis' });
  assert.equal(svc.statusCode, 200, svc.body);
  const again = await dashboard(h);
  assert.deepEqual(again.alerts.map(a => a.key), ['limit:Weekly']);
  assert.equal(again.health.data.services[0].ack.by, 'jarvis');
  assert.equal(again.health.data.services[0].state, 'down');
});

test('a POST with no Origin and no by is recorded as local, never as the owner', async () => {
  const d = deps();
  const h = createHandler(d);
  const res = await call(h, 'POST', '/api/acks', { key: KEY });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body)[0].by, 'local');
  assert.match(d.logged[0], /^ack: cron by local until /);
});

test('an alert with no since takes at most 24 hours over the route too', async () => {
  const d = deps();
  d.cache.set('crons', [{ ...failedCron, lastRunAt: undefined }]);
  const h = createHandler(d);
  const week = await call(h, 'POST', '/api/acks', { key: KEY, until: Date.now() + 7 * DAY });
  assert.equal(week.statusCode, 400);
  assert.match(JSON.parse(week.body).error, /24 hours/);
  const dflt = await call(h, 'POST', '/api/acks', { key: KEY });
  assert.equal(dflt.statusCode, 200, dflt.body);
  const made = JSON.parse(dflt.body)[0];
  assert.equal(made.since, null);
  assert.ok(made.until - made.at <= DAY && made.until - made.at > DAY - 60e3);
  assert.equal((await dashboard(h)).alerts.some(a => a.key === KEY), false, 'covered: both since unknown');
});

test('a new failure of an acked job is red again, and an expired ack lapses', async () => {
  const d = deps();
  const h = createHandler(d);
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY })).statusCode, 200);
  assert.equal((await dashboard(h)).alerts.some(a => a.key === KEY), false);
  d.cache.set('crons', [{ ...failedCron, lastRunAt: SINCE + 7 * DAY }]);
  const moved = await dashboard(h);
  assert.equal(moved.alerts.some(a => a.key === KEY), true, 'a later run that failed is a new instance');
  assert.deepEqual(moved.acked, []);
  assert.equal(moved.acks.length, 1, 'the old ack is still on file, covering nothing');

  const expired = deps(memoryStore([ack({ until: Date.now() - 1 })]));
  const e = await dashboard(createHandler(expired));
  assert.equal(e.alerts.some(a => a.key === KEY), true);
  assert.deepEqual(e.acks, []);
});

test('GET /api/acks lists the active acks; DELETE /api/acks/<key> un-acks and answers the list', async () => {
  const d = deps(memoryStore([ack(), ack({ key: 'cron:launchd:com.example.old', until: Date.now() - 1 })]));
  const h = createHandler(d);
  const got = JSON.parse((await call(h, 'GET', '/api/acks')).body);
  assert.deepEqual(got.map(a => a.key), [KEY]);
  const del = await call(h, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`);
  assert.equal(del.statusCode, 200, del.body);
  assert.deepEqual(JSON.parse(del.body), []);
  assert.deepEqual(d.logged, [`un-ack: ${KEY}`]);
  assert.equal((await dashboard(h)).alerts.some(a => a.key === KEY), true);
  const spaced = await call(h, 'DELETE', `/api/acks/${encodeURIComponent('service:self:Control Room')}`);
  assert.equal(spaced.statusCode, 200, 'a key with a space, encoded, is fine');
  assert.equal((await call(h, 'DELETE', '/api/acks/%E0%A4%A')).statusCode, 400, 'bad encoding');
  assert.equal((await call(h, 'DELETE', `/api/acks/${'k'.repeat(201)}`)).statusCode, 400, 'too long');
});

test('nothing can be acked in advance, and nothing but a cron or service alert', async () => {
  const d = deps();
  const h = createHandler(d);
  const future = await call(h, 'POST', '/api/acks', { key: 'cron:launchd:com.example.daily' });
  assert.equal(future.statusCode, 404, 'the daily job is fine today');
  assert.match(JSON.parse(future.body).error, /live alert/);
  const limit = await call(h, 'POST', '/api/acks', { key: 'limit:Weekly' });
  assert.equal(limit.statusCode, 400);
  assert.match(JSON.parse(limit.body).error, /moves on its own/);
  assert.deepEqual(d.store.peek(), [], 'nothing was written');
  assert.deepEqual(d.logged, []);
});

test('the ack routes keep the board\'s guards: same origin, JSON only, a 4 KB body', async () => {
  const d = deps();
  const h = createHandler(d);
  const cross = await call(h, 'POST', '/api/acks', { key: KEY }, { origin: 'https://evil.example' });
  assert.equal(cross.statusCode, 403);
  const nullOrigin = await call(h, 'POST', '/api/acks', { key: KEY }, { origin: 'null' });
  assert.equal(nullOrigin.statusCode, 403);
  const text = await call(h, 'POST', '/api/acks', { key: KEY }, { 'content-type': 'text/plain' });
  assert.equal(text.statusCode, 415);
  const big = await call(h, 'POST', '/api/acks', { key: KEY, note: 'n'.repeat(5000) });
  assert.equal(big.statusCode, 413);
  const badNote = await call(h, 'POST', '/api/acks', { key: KEY, note: 'a\u202eb' });
  assert.equal(badNote.statusCode, 400);
  const badUntil = await call(h, 'POST', '/api/acks', { key: KEY, until: Date.now() + 15 * DAY });
  assert.equal(badUntil.statusCode, 400);
  const crossDelete = await call(h, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`, undefined, { origin: 'https://evil.example' });
  assert.equal(crossDelete.statusCode, 403);
  const own = await call(h, 'POST', '/api/acks', { key: KEY }, { origin: 'http://127.0.0.1:8322' });
  assert.equal(own.statusCode, 200, 'the page itself may ack');
  assert.deepEqual(d.store.peek().map(a => a.key), [KEY]);
  for (const res of [cross, nullOrigin, text, big, badNote, badUntil, crossDelete]) {
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  }
});

test('without a store, the dashboard still answers and a POST says acks are not set up', async () => {
  const d = deps();
  delete d.acks;
  const h = createHandler({ cache: d.cache, todos: d.todos, config: d.config });
  const p = await dashboard(h);
  assert.deepEqual(p.acks, []);
  assert.deepEqual(p.acked, []);
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY })).statusCode, 503);
  assert.equal((await call(h, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`)).statusCode, 503);
  assert.deepEqual(JSON.parse((await call(h, 'GET', '/api/acks')).body), []);
});

test('with the banner off, alerts and acked are empty but an ack still lands', async () => {
  const d = deps();
  d.config.showAlertBanner = false;
  const h = createHandler(d);
  assert.deepEqual(await dashboard(h).then(p => [p.alerts, p.acked]), [[], []]);
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY })).statusCode, 200);
  assert.equal((await dashboard(h)).acks.length, 1);
});

// ---- the notifier ----

test('an acked alert is not pushed, and when its ack lapses with the condition live it is pushed again', async () => {
  const store = {};
  const sent = [];
  const h = {
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { sent.push(msg); return { sent: true }; }
  };
  const snapshot = { crons: { status: 'ok', data: [failedCron] }, ingestCrons: { status: 'ok', data: [] }, usage: { status: 'ok', data: { limits: [] } } };
  const cfg = { warnThreshold: 85 };
  const a = ack({ at: NOW, until: NOW + DAY });

  // Unacked: the counted cron push goes out once.
  await runNotifier({ snapshot, config: cfg, now: NOW, ...h });
  assert.equal(sent.length, 1);
  // Acked: no push, and the key is forgotten because launchd was observable.
  await runNotifier({ snapshot, config: cfg, now: NOW + 60e3, acks: [a], ...h });
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(store), []);
  // Still acked a day minus a minute later: nothing.
  await runNotifier({ snapshot, config: cfg, now: NOW + DAY - 60e3, acks: [a], ...h });
  assert.equal(sent.length, 1);
  // The ack lapsed, the job is still red: pushed again.
  await runNotifier({ snapshot, config: cfg, now: NOW + DAY, acks: [a], ...h });
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(store), [KEY]);
});

test('a fresh ack on a brand-new failure still never covers a later run of the same job', async () => {
  const sent = [];
  const store = {};
  const h = {
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { sent.push(msg); return { sent: true }; }
  };
  const snap = lastRunAt => ({ crons: { status: 'ok', data: [{ ...failedCron, lastRunAt }] }, ingestCrons: { status: 'ok', data: [] }, usage: { status: 'ok', data: { limits: [] } } });
  const a = ack({ at: NOW, until: NOW + 7 * DAY });
  await runNotifier({ snapshot: snap(SINCE), config: {}, now: NOW, acks: [a], ...h });
  assert.equal(sent.length, 0);
  await runNotifier({ snapshot: snap(SINCE + 7 * DAY), config: {}, now: NOW + HOUR, acks: [a], ...h });
  assert.equal(sent.length, 1, 'the next run failed too: that is news');
});

// ---- the notice (board a37d853e) ----

const DAY_MS = 24 * 3600e3;
// Any line break, built from code points (a typed escape has turned into the real
// character in this repo before).
const BREAKS = new RegExp(`[${[0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029].map(c => String.fromCodePoint(c)).join('')}]`);

test('a renewal of the same failure counts on; a new failure, an un-ack or a lapse starts again at 0', () => {
  const first = addAck([], ack(), NOW);
  assert.equal(first[0].renewals, 0, 'a first ack');
  const second = addAck(first, ack({ at: NOW + 1, until: NOW + 7 * DAY_MS }), NOW + 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].renewals, 1);
  assert.equal(second[0].until, NOW + 7 * DAY_MS, 'the renewal\'s own until wins');
  const third = addAck(second, ack({ at: NOW + 2, since: SINCE + 30e3 }), NOW + 2);
  assert.equal(third[0].renewals, 2, 'since within the tolerance is the same failure');
  assert.equal(addAck(third, ack({ at: NOW + 3, since: SINCE + 7 * DAY_MS }), NOW + 3)[0].renewals, 0, 'a new failure');
  assert.equal(addAck(removeAck(third, KEY, NOW + 3), ack({ at: NOW + 3 }), NOW + 3)[0].renewals, 0, 'after an un-ack');
  const lapsed = third.map(a => ({ ...a, until: NOW + 3 }));
  assert.equal(addAck(lapsed, ack({ at: NOW + 4 }), NOW + 4)[0].renewals, 0, 'after the ack lapsed');
  assert.equal(addAck([ack({ since: null })], ack({ since: null, at: NOW + 1 }), NOW + 1)[0].renewals, 1, 'two unknown instances are one failure');
});

test('the count is read defensively: an entry without one is 0, a malformed one is no ack at all', () => {
  assert.equal(renewalsOf(ack()), 0);
  assert.equal(renewalsOf(ack({ renewals: 3 })), 3);
  assert.equal(activeAcks([ack({ renewals: 3 })], NOW).length, 1);
  for (const renewals of [-1, 1.5, '2', null, Infinity]) assert.deepEqual(activeAcks([ack({ renewals })], NOW), [], String(renewals));
  assert.equal(addAck([ack()], ack({ at: NOW + 1 }), NOW + 1)[0].renewals, 1, 'an old entry with no count renews to 1');
});

test('a new ack makes one notice: who, the kind, how long it has failed and until when; ntfy generic and low', () => {
  const n = ackNotice({ ...ack(), renewals: 0 }, NOW);
  assert.deepEqual(Object.keys(n).sort(), ['message', 'ntfyMessage', 'priority']);
  assert.equal(n.priority, 'low');
  assert.equal(n.ntfyMessage, NTFY_ACK_WORDS);
  assert.equal(n.message,
    `jeff acknowledged a failed job (failing since ${noticeTime(SINCE)}, 11 days ago): it is off the alerts until ${noticeTime(NEXT + ACK_AFTER_NEXT_MS)}. Which job, and any note, are on the dashboard.`);
  assert.doesNotMatch(n.message, /renew/);
  for (const text of [n.message, n.ntfyMessage]) {
    assert.ok(!text.includes('com.example'), 'never the label: a cron is counted, never quoted');
    assert.ok(!text.includes('friday'));
    assert.ok(!text.includes('mini restarted before login'), 'never the note');
  }
  const svc = ackNotice({ key: 'service:launchd:Tunnel', kind: 'service', since: NOW - 5 * 3600e3, by: 'jarvis', note: null, at: NOW, until: NOW + DAY_MS, renewals: 0 }, NOW);
  assert.match(svc.message, /^jarvis acknowledged a down service \(down since .*, 5 h ago\): .* Which service, and any note/);
  assert.ok(!svc.message.includes('Tunnel'));
  assert.match(ackNotice({ ...ack(), since: null, renewals: 0 }, NOW).message, /\(when it began is unknown\)/);
});

test('a renewal makes one notice that says renewed and how many times, in #pepper and on ntfy', () => {
  const once = ackNotice({ ...ack(), by: 'local', renewals: 1 }, NOW);
  assert.match(once.message, /^local renewed the acknowledgement of a failed job \(failing since .*, 11 days ago\), renewed 1 time for this failure: it is off the alerts until /);
  assert.equal(once.ntfyMessage, NTFY_RENEW_WORDS);
  assert.equal(once.priority, 'low');
  assert.match(ackNotice({ ...ack(), renewals: 4 }, NOW).message, /, renewed 4 times for this failure:/);
  assert.match(ackLogLine({ ...ack(), renewals: 4 }), /^ack: cron by jeff until \S+ \(renewal 4\) \(cron:launchd:com\.example\.friday\)$/);
  assert.doesNotMatch(ackLogLine({ ...ack(), renewals: 0 }), /renewal/);
});

test('a hostile key, note or by can never forge a second line in the notice or the log', () => {
  // Built from code points: a typed escape has turned into the real character in this repo before.
  const breaks = [0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029, 0x1b, 0x202e].map(c => String.fromCodePoint(c));
  const forged = breaks.join('jeff un-acked everything');
  const hostile = { ...ack(), key: `cron:launchd:x${forged}`, note: `n${forged}`, by: `b${forged}`, renewals: 2 };
  const lines = [ackNotice(hostile, NOW).message, ackLogLine(hostile), unackLogLine(hostile.key)];
  for (const line of lines) {
    for (const ch of breaks) assert.ok(!line.includes(ch), `U+${ch.codePointAt(0).toString(16)} leaked into: ${JSON.stringify(line)}`);
    assert.equal(line.split(BREAKS).length, 1);
  }
  assert.match(ackLogLine(hostile), /⟦U\+000A⟧jeff un-acked everything⟦U\+000D⟧/, 'a break shows as a marker, so a tampered key reads as tampered');
  assert.match(unackLogLine(hostile.key), /⟦U\+2028⟧/);
  assert.match(ackNotice(hostile, NOW).message, /^b⟦U\+000A⟧/, 'by is only a word over the route, but the file can be edited by hand');
  assert.ok(!ackNotice(hostile, NOW).message.includes('cron:launchd:x'), 'and the notice never quotes the key at all');
  assert.ok(ackLogLine({ ...ack(), key: 'k'.repeat(5000) }).length < 700, 'a long line is cut');
});

// The route with a notice hook that records what it was handed.
const noticeDeps = (store = memoryStore()) => {
  const d = deps(store);
  d.notices = [];
  d.onAckNotice = async n => { d.notices.push(n); };
  return d;
};
const settle = () => new Promise(r => setImmediate(r));

test('over the route: a new ack sends one notice, each renewal one more that says renewed, a refusal none', async () => {
  const d = noticeDeps();
  const h = createHandler(d);
  const first = await call(h, 'POST', '/api/acks', { key: KEY, note: 'mini restarted before login' }, { origin: 'http://127.0.0.1:8322' });
  assert.equal(first.statusCode, 200, first.body);
  await settle();
  assert.equal(d.notices.length, 1);
  assert.match(d.notices[0].message, /^jeff acknowledged a failed job \(failing since /);
  assert.equal(d.notices[0].ntfyMessage, NTFY_ACK_WORDS);
  assert.equal(d.notices[0].priority, 'low');
  assert.equal(JSON.parse(first.body)[0].renewals, 0);

  const renew = await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis', until: Date.now() + 7 * DAY_MS });
  assert.equal(renew.statusCode, 200, renew.body);
  await settle();
  assert.equal(d.notices.length, 2);
  assert.match(d.notices[1].message, /^jarvis renewed the acknowledgement of a failed job .*, renewed 1 time for this failure: it is off the alerts until /);
  assert.ok(d.notices[1].message.includes(noticeTime(JSON.parse(renew.body)[0].until)), 'until when, as stored');
  assert.equal(d.notices[1].ntfyMessage, NTFY_RENEW_WORDS);
  assert.equal(JSON.parse(renew.body)[0].renewals, 1);
  assert.match(d.logged.at(-1), /^ack: cron by jarvis until \S+ \(renewal 1\) \(cron:launchd:com\.example\.friday\)$/);

  await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' });
  await settle();
  assert.match(d.notices[2].message, /renewed 2 times for this failure/);
  assert.equal((await dashboard(h)).acks[0].renewals, 2, 'the count is on the page\'s payload too');

  for (const [body, code] of [[{ key: 'limit:Weekly' }, 400], [{ key: 'cron:launchd:com.example.nope' }, 404], [{ key: KEY, until: Date.now() + 15 * DAY_MS }, 400], [{ key: KEY, note: 'a\nb' }, 400]]) {
    assert.equal((await call(h, 'POST', '/api/acks', body)).statusCode, code, JSON.stringify(body));
  }
  assert.equal((await call(h, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`)).statusCode, 200);
  await settle();
  assert.equal(d.notices.length, 3, 'a refused ack and an un-ack send nothing');

  await call(h, 'POST', '/api/acks', { key: KEY });
  await settle();
  assert.equal(d.notices.length, 4);
  assert.match(d.notices[3].message, /^local acknowledged a failed job/, 'after an un-ack, an ack is new again, and says so');
});

test('over the route: a note with a line separator lands, but the notice never carries it and stays one line', async () => {
  const d = noticeDeps();
  const h = createHandler(d);
  // U+2028 and U+2029 pass the board's character rule (text.mjs), so the route accepts them.
  const note = `fine${String.fromCodePoint(0x2028)}jarvis renewed nothing${String.fromCodePoint(0x2029)}`;
  const res = await call(h, 'POST', '/api/acks', { key: KEY, note });
  assert.equal(res.statusCode, 200, res.body);
  await settle();
  assert.equal(d.notices.length, 1);
  const { message } = d.notices[0];
  assert.ok(!message.includes('fine') && !message.includes('renewed nothing'), 'the note is never in the notice');
  assert.ok(!BREAKS.test(message));
  assert.equal(d.logged.length, 1);
  assert.ok(!BREAKS.test(d.logged[0]));
});

test('over the route: a notice that fails is logged, and the ack still answers 200', async () => {
  const d = deps();
  d.onAckNotice = async () => { const e = new Error('discord down'); e.code = 'EBOOM'; throw e; };
  const h = createHandler(d);
  const res = await call(h, 'POST', '/api/acks', { key: KEY });
  assert.equal(res.statusCode, 200, res.body);
  await settle();
  assert.deepEqual(d.logged.slice(1), ['ack: the notice failed (EBOOM)']);
  const slow = deps();
  slow.onAckNotice = () => new Promise(() => {});
  const r2 = await call(createHandler(slow), 'POST', '/api/acks', { key: KEY });
  assert.equal(r2.statusCode, 200, 'a push that never settles never holds the answer');
});

// ---- the write limit and the notice limit (Ultron's 11-12 medium, 3-M1) ----

test('over the route: the 11th ack in a minute is a 429 the writer can read, with Retry-After; a minute later acks go again', async () => {
  const d = deps();
  let now = NOW;
  d.clock = () => now;
  const h = createHandler(d);
  for (let i = 0; i < ACK_WRITES_PER_MINUTE; i++) {
    now = NOW + i * 1000;
    const r = await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' });
    assert.equal(r.statusCode, 200, `ack ${i + 1}: ${r.body}`);
  }
  now = NOW + 20e3;
  const refused = await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' });
  assert.equal(refused.statusCode, 429);
  assert.match(JSON.parse(refused.body).error, /^too many acknowledgements this minute \(at most 10\); try again in 40 s$/);
  assert.equal(refused.headers['Retry-After'], '40', 'the first ack leaves the window 60 s after it was made');
  assert.equal(refused.headers.Connection, 'close', 'the unread body is never drained');
  assert.equal(d.logged.filter(l => l.startsWith('ack: refusing acks')).length, 1, 'the refusal is logged once, not per request');
  now = NOW + 60e3;
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 200, 'the first ack has left the window');
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 429, 'but only that one');
});

// Ultron's 11-12 low: an un-ack only makes an alert visible again, so a local loop of
// acks must never stop the page from un-acking, and un-acks never use up the acks' minute.
test('over the route: an un-ack is never limited, and never counts against the acks', async () => {
  const d = deps();
  const now = NOW;
  d.clock = () => now;
  const h = createHandler(d);
  for (let i = 0; i < ACK_WRITES_PER_MINUTE; i++) {
    assert.equal((await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 200);
  }
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 429, 'the acks are spent');
  const unack = await call(h, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`, undefined, { origin: 'http://127.0.0.1:8322' });
  assert.equal(unack.statusCode, 200, 'the page can still un-ack');
  assert.equal(d.store.peek().length, 0);
  for (let i = 0; i < 3 * ACK_WRITES_PER_MINUTE; i++) {
    assert.equal((await call(h, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`)).statusCode, 200, `un-ack ${i + 1}`);
  }
  // A fresh minute: thirty un-acks used none of it.
  const h2 = createHandler(d);
  for (let i = 0; i < 3 * ACK_WRITES_PER_MINUTE; i++) await call(h2, 'DELETE', `/api/acks/${encodeURIComponent(KEY)}`);
  for (let i = 0; i < ACK_WRITES_PER_MINUTE; i++) {
    assert.equal((await call(h2, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 200, `ack ${i + 1} after the un-acks`);
  }
  assert.equal(d.logged.filter(l => l.startsWith('ack: refusing')).length, 1, 'only the one refused ack was logged');
});

test('over the route: refused writes count against the limit too, and reads never do', async () => {
  const d = deps();
  const now = NOW;
  d.clock = () => now;
  const h = createHandler(d);
  for (let i = 0; i < ACK_WRITES_PER_MINUTE; i++) {
    assert.equal((await call(h, 'POST', '/api/acks', { key: 'cron:launchd:com.example.nope' })).statusCode, 404);
  }
  for (let i = 0; i < 20; i++) assert.equal((await call(h, 'GET', '/api/acks')).statusCode, 200);
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY })).statusCode, 429);
});

test('over the route and the limiter: a renewal loop on one alert pushes the first notice, then one with the full count', async () => {
  const d = deps();
  const sent = [];
  const timers = [];
  let now = NOW;
  const limiter = createAckNoticeLimiter({ send: async n => { sent.push(n); }, clock: () => now, setTimer: (fn, ms) => timers.push({ fn, at: now + ms }) });
  d.onAckNotice = (n, key) => limiter.notice(key, n);
  d.clock = () => now;
  const h = createHandler(d);
  // Ten renewals a minute, the most the write limit lets through, for 9 minutes.
  for (let m = 0; m < 9; m++) {
    for (let i = 0; i < ACK_WRITES_PER_MINUTE; i++) {
      now = NOW + m * 60e3 + i * 100;
      assert.equal((await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 200);
    }
  }
  await settle();
  assert.equal(sent.length, 1, 'one push for 90 renewals');
  assert.match(sent[0].message, /^jarvis acknowledged a failed job/);
  // Another alert is its own key: its ack goes out at once.
  now = NOW + 9 * 60e3 + 5e3;
  assert.equal((await call(h, 'DELETE', `/api/acks/${encodeURIComponent('service:launchd:Tunnel')}`)).statusCode, 200);
  now = NOW + 9 * 60e3 + 61e3;
  assert.equal((await call(h, 'POST', '/api/acks', { key: 'service:launchd:Tunnel', by: 'jarvis' })).statusCode, 200);
  await settle();
  assert.equal(sent.length, 2, 'the route hands the limiter the alert\'s key');
  assert.match(sent[1].message, /^jarvis acknowledged a down service/);
  sent.splice(1, 1);
  now = NOW + 10 * 60e3;
  for (const t of timers.filter(t => t.at <= now)) await t.fn();
  assert.equal(sent.length, 2);
  assert.match(sent[1].message, /renewed 89 times for this failure: .* \(the latest of 89 for this alert held back in the last 10 minutes\)$/);
  assert.ok(!sent[1].message.includes(KEY), 'the key is used to group, never sent');
  assert.equal(sent[1].ntfyMessage, NTFY_RENEW_WORDS, '#pepper\'s limit adds its count to #pepper\'s words only');
});

test('over the route and both limits: two alerts acked, #pepper names each, ntfy pushes once and counts the other at the hour\'s end', async () => {
  const d = deps();
  const pepper = [], ntfy = [], timers = [];
  let now = NOW;
  const notices = createAckNotices({
    sendPepper: async n => { pepper.push(n.message); },
    sendNtfy: async n => { ntfy.push(n); },
    clock: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); }
  });
  d.onAckNotice = (n, key) => notices.notice(key, n);
  d.clock = () => now;
  const h = createHandler(d);
  assert.equal((await call(h, 'POST', '/api/acks', { key: KEY, by: 'jarvis' })).statusCode, 200);
  now = NOW + 60e3;
  assert.equal((await call(h, 'POST', '/api/acks', { key: 'service:launchd:Tunnel', by: 'jarvis' })).statusCode, 200);
  await settle();
  assert.equal(pepper.length, 2);
  assert.match(pepper[0], /^jarvis acknowledged a failed job/);
  assert.match(pepper[1], /^jarvis acknowledged a down service/);
  assert.deepEqual(ntfy, [{ message: NTFY_ACK_WORDS, priority: 'low' }]);
  now = NOW + 3600e3;
  for (const t of timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)) await t.fn();
  assert.deepEqual(ntfy[1], { message: NTFY_ACK_WORDS + ntfyFlushSuffix(1), priority: 'low' });
  assert.ok(ntfy.every(n => !n.message.includes('launchd') && !n.message.includes('jarvis')), 'ntfy never names the alert or who');
});
