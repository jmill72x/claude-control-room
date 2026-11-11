// Acknowledging a known miss (lib/acks.mjs, acks.mjs, and the routes that use
// them). Every label, name and figure here is invented. Times are plain numbers,
// so the tests hold in any time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeAcks, matchingAck, applyAcks, checkAckRequest, makeAck, addAck, removeAck, decoratePayload, sameSince,
  ACK_MAX, ACK_CAP_MS, ACK_AFTER_NEXT_MS, ACK_NO_NEXT_MS, SINCE_TOLERANCE_MS, DEFAULT_BY, ackLogLine
} from '../lib/acks.mjs';
import { createAckStore } from '../acks.mjs';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';
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
  assert.deepEqual(acked[0].ack, { key: KEY, kind: 'cron', since: SINCE, by: 'jeff', note: 'mini restarted before login', at: NOW, until: NEXT + ACK_AFTER_NEXT_MS });
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
  assert.deepEqual(checkAckRequest({ key: KEY }), { ok: true, value: { key: KEY, note: null, by: DEFAULT_BY, until: undefined } });
  assert.deepEqual(checkAckRequest({ key: KEY, note: '  next run Fri ', by: 'jarvis', until: NOW + DAY }).value,
    { key: KEY, note: 'next run Fri', by: 'jarvis', until: NOW + DAY });
  assert.equal(checkAckRequest({ key: KEY, note: '' }).value.note, null);
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
  const r = makeAck(cronAlert(), checkAckRequest({ key: KEY, note: 'known' }).value, NOW);
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
    await writeFile(path, '{not json');
    assert.deepEqual(await store.read(NOW), [], 'a corrupt file reads as nothing');
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

  const res = await call(h, 'POST', '/api/acks', { key: KEY, note: 'mini restarted before login' });
  assert.equal(res.statusCode, 200, res.body);
  const list = JSON.parse(res.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].since, SINCE, 'since comes from the cron, not the caller');
  assert.equal(list[0].until, NEXT + ACK_AFTER_NEXT_MS);
  assert.equal(list[0].by, 'jeff');
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
