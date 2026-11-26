// The Overview's Attention strip clears (board e7427be1's scope add, 11-26; boards
// 80bd2708 and 3d59b66b's neighbour): a "jarvis-down" local alert goes once Jarvis is
// back (the lead's chat message, or a "jarvis-back" alert), an info alert leaves after an
// hour, an ack from the page saves over the Serve name's address and survives a reload
// and a restart, and a refused ack is one log line. Every name and time is invented;
// nothing touches :8322 or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLocalAlert, createLocalAlerts, alertKey, LOCAL_KINDS, INFO_KEEP_MS, KEEP_MS } from '../lib/local-alerts.mjs';
import { createHandler } from '../routes.mjs';
import { createCache } from '../cache.mjs';
import { createAckStore } from '../acks.mjs';

const MIN = 60e3, HOUR = 60 * MIN;
const T0 = 1794380000000;
const v = over => checkLocalAlert({ title: 'Inventlead is not answering', body: 'x', severity: 'critical', kind: 'jarvis-down', ...over }).value;
const clock = (t = T0) => { const c = { t, now: () => c.t }; return c; };
const store = (c = clock()) => { const logs = []; const pushed = []; return { c, logs, pushed, s: createLocalAlerts({ now: c.now, log: l => logs.push(l), push: () => a => { pushed.push(a); return { tried: 1, reached: 1 }; } }) }; };

test('the kinds: jarvis-back is taken; an info alert is shown an hour', () => {
  assert.deepEqual(LOCAL_KINDS, ['jarvis-down', 'jarvis-back', 'other']);
  assert.equal(checkLocalAlert({ title: 'x', kind: 'jarvis-back' }).value.kind, 'jarvis-back');
  assert.equal(INFO_KEEP_MS, HOUR);
});

test('resolveDown: every jarvis-down alert last raised by then goes, others stay; a repeat after it is a new instance, pushed', async () => {
  const e = store();
  await e.s.post(v());
  e.c.t += MIN;
  await e.s.post(v({ title: 'Inventlead is still not answering' }));
  await e.s.post(v({ kind: 'other', severity: 'warning', title: 'a job failed' }));
  e.c.t += MIN;
  await e.s.post(v({ title: 'Inventlead started degraded' }));
  assert.equal(e.s.resolveDown(T0 + MIN, 'the lead wrote in the chat'), 2);
  assert.deepEqual(e.s.view(e.c.t).map(a => a.text), ['Inventlead started degraded', 'a job failed']);
  assert.ok(e.logs.includes('local-alert: 2 jarvis-down alerts resolved (the lead wrote in the chat)'));
  assert.equal(e.s.resolveDown(NaN), 0);
  assert.equal(e.s.resolveDown(T0), 0, 'nothing left that old: no line');
  e.c.t += HOUR; // past the hour's push cap the posts above used
  const before = e.pushed.length;
  await e.s.post(v());
  const again = e.s.view(e.c.t).find(a => a.text === 'Inventlead is not answering');
  assert.equal(again.since, e.c.t, 'a new instance: its own since, so an old ack can\'t cover it');
  assert.equal(e.pushed.length, before + 1, 'and pushed, not a duplicate');
});

test('a jarvis-back alert takes the earlier down alerts off, and stays itself as an info notice for an hour', async () => {
  const e = store();
  await e.s.post(v());
  e.c.t += 30 * MIN;
  await e.s.post(v({ kind: 'jarvis-back', severity: 'info', title: 'Inventlead is answering again' }));
  assert.deepEqual(e.s.view(e.c.t).map(a => [a.about, a.text]), [['jarvis-back', 'Inventlead is answering again']]);
  assert.equal(e.s.view(e.c.t + HOUR - 1).length, 1);
  assert.equal(e.s.view(e.c.t + HOUR).length, 0, 'an info alert leaves after its hour');
  // A warning keeps its 24 hours.
  const w = store();
  await w.s.post(v({ kind: 'other', severity: 'warning', title: 'a job failed' }));
  assert.equal(w.s.view(T0 + KEEP_MS - 1).length, 1);
  assert.equal(w.s.view(T0 + KEEP_MS).length, 0);
});

// The page as Tailscale Serve hands it on: Host the Serve name, Origin its https page.
const SERVE = { host: 'mini.example.ts.net', origin: 'https://mini.example.ts.net' };
const call = async (handler, method, url, body, headers = {}) => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method, url, socket: { remoteAddress: '127.0.0.1' },
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    on(evt, fn) { if (evt === 'data' && raw) fn(Buffer.from(raw)); if (evt === 'end') fn(); return req; },
    unpipe() {}, pause() {}
  };
  const res = { statusCode: 200, headers: {}, body: '' };
  res.writeHead = (code, h) => { res.statusCode = code; Object.assign(res.headers, h ?? {}); };
  res.end = b => { res.body = b ?? ''; };
  await handler(req, res);
  return res;
};
const failedCron = { name: 'tuesday', label: 'com.example.tuesday', ok: false, state: 'failed', last: 'Failed · 1', lastRunAt: Date.now() - 2 * HOUR, nextRunAt: Date.now() + 5 * 24 * HOUR, schedule: 'Tuesdays' };
function server(dir, localAlerts) {
  const cache = createCache();
  cache.set('crons', [failedCron]);
  const logs = [];
  const handler = createHandler({
    cache, localAlerts, acks: createAckStore(join(dir, 'acks.json')), log: l => logs.push(l),
    todos: { readState: async () => ({ todos: [], revision: null }), save: async l => ({ todos: l, revision: null }) },
    config: { warnThreshold: 85, showAlertBanner: true, present: true, allowedHosts: ['mini.example.ts.net'] }
  });
  return { handler, logs };
}

test('an ack from the page over the Serve name saves, leaves the strip, and survives a reload and a restart; the cron row too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccr-attention-'));
  try {
    const local = createLocalAlerts({ log: () => {} });
    await local.post(v());
    const a = server(dir, local);
    const first = JSON.parse((await call(a.handler, 'GET', '/api/dashboard', undefined, SERVE)).body);
    assert.deepEqual(first.alerts.map(x => x.kind).sort(), ['cron', 'local']);
    for (const alert of first.alerts) {
      const r = await call(a.handler, 'POST', '/api/acks', { key: alert.key, note: 'seen it’s fine' }, SERVE);
      assert.equal(r.statusCode, 200, r.body);
    }
    const reload = JSON.parse((await call(a.handler, 'GET', '/api/dashboard', undefined, SERVE)).body);
    assert.deepEqual(reload.alerts, []);
    assert.deepEqual(reload.acked.map(x => x.kind).sort(), ['cron', 'local']);
    assert.ok(a.logs.some(l => l.startsWith('ack: local by jeff')) && a.logs.some(l => l.startsWith('ack: cron by jeff')));
    // A new server over the same file (a restart keeps the acks; the local alert is posted again by its script).
    const b = server(dir, local);
    assert.deepEqual(JSON.parse((await call(b.handler, 'GET', '/api/dashboard', undefined, SERVE)).body).alerts, []);
    assert.equal(JSON.parse(await readFile(join(dir, 'acks.json'), 'utf8')).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a refused ack is one log line with its status and the server\'s words, never the note; each reason once a minute', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccr-attention-'));
  try {
    const local = createLocalAlerts({ log: () => {} });
    await local.post(v());
    const { handler, logs } = server(dir, local);
    const key = alertKey('jarvis-down', 'Inventlead is not answering');
    assert.equal((await call(handler, 'POST', '/api/acks', { key, note: 'PRIVATE-NOTE' }, { host: 'mini.example.ts.net', origin: 'https://elsewhere.example' })).statusCode, 403);
    assert.equal((await call(handler, 'POST', '/api/acks', { key: 'local:jarvis-down:000000000000', note: 'PRIVATE-NOTE' }, SERVE)).statusCode, 404);
    assert.equal((await call(handler, 'POST', '/api/acks', { key: 'local:jarvis-down:000000000000' }, SERVE)).statusCode, 404);
    assert.deepEqual(logs.filter(l => l.startsWith('ack: refused')), [
      'ack: refused (403: cross-origin write refused)',
      'ack: refused (404: no such alert is raised now: only a live alert can be acknowledged)'
    ]);
    assert.ok(!logs.join('\n').includes('PRIVATE-NOTE'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('server.mjs: the lead\'s own chat message, not a routine\'s, resolves the down alerts', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /m\.from === 'jarvis' && m\.kind === 'chat' && !isRoutineMessage\(m\)\) localAlerts\.resolveDown\(/);
});
