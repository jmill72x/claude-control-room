// The Host allowlist (lib/host-guard.mjs): what config may name, which Host
// values pass, and that a request with any other Host gets 421 before a route.
// Every host name here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAllowedHosts, allowedHostSet, hostAllowed, withHostGuard } from '../lib/host-guard.mjs';

const mockRes = () => {
  const res = { statusCode: null, headers: {}, body: '', finished: false };
  res.writeHead = (code, hdrs) => { if (res.finished) throw new Error('writeHead twice'); res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};
const req = host => ({ method: 'GET', url: '/api/health', headers: host === undefined ? {} : { host } });

test('config names hosts with or without a port; anything else is a problem, not a name', () => {
  assert.deepEqual(readAllowedHosts({}), { names: [], mode: 'log', problems: [] });
  assert.deepEqual(readAllowedHosts({ allowedHosts: ['Mini.Example-Net.ts.net', 'box.lan:8080'], hostCheck: 'enforce' }),
    { names: ['mini.example-net.ts.net', 'box.lan:8080'], mode: 'enforce', problems: [] });
  const odd = readAllowedHosts({ hostCheck: 'refuse' });
  assert.equal(odd.mode, 'log', 'an unknown mode logs, never refuses');
  assert.deepEqual(odd.problems, ['hostCheck must be one of log, enforce']);
  const bad = readAllowedHosts({ allowedHosts: ['has space.example', 'a..b', 42, 'x.example:99999', '-lead.example', ''] });
  assert.deepEqual(bad.names, []);
  assert.equal(bad.problems.length, 6);
  assert.match(bad.problems[0], /allowedHosts\[0\]/);
  assert.deepEqual(readAllowedHosts({ allowedHosts: 'mini.example' }).problems, ['allowedHosts is not a list']);
});

test('the set: loopback on this port, each name as given, and the bare form on 80 and 443', () => {
  const set = allowedHostSet(8322, ['mini.example-net.ts.net', 'box.lan:8080']);
  assert.deepEqual([...set].sort(), [
    '127.0.0.1:8322', 'box.lan:8080', 'localhost:8322',
    'mini.example-net.ts.net', 'mini.example-net.ts.net:443', 'mini.example-net.ts.net:80'
  ]);
  assert.ok(hostAllowed('127.0.0.1:8322', set));
  assert.ok(hostAllowed('Mini.Example-Net.ts.net', set), 'a host name has no case');
  assert.ok(hostAllowed('localhost:8322', set));
  assert.ok(!hostAllowed('127.0.0.1', set), 'the port is part of it: a bare loopback Host is not ours');
  assert.ok(!hostAllowed('127.0.0.1:8323', set));
  assert.ok(!hostAllowed('localhost', set));
  assert.ok(!hostAllowed('box.lan', set), 'a name given with a port matches that port only');
  assert.ok(!hostAllowed('attacker.example:8322', set), 'the rebinding case');
  assert.ok(!hostAllowed('', set));
  assert.ok(!hostAllowed(undefined, set));
  assert.ok(!hostAllowed('127.0.0.1:8322.attacker.example', set));
});

test('in enforce mode the guard answers 421 to any other Host, before the handler runs, and logs each refused Host once', async () => {
  const logged = [];
  let reached = 0;
  const handler = (rq, rs) => { reached++; rs.writeHead(200, {}); rs.end('ok'); };
  const guarded = withHostGuard(handler, allowedHostSet(8322, ['mini.example.ts.net']), { mode: 'enforce', log: l => logged.push(l) });

  for (const host of ['127.0.0.1:8322', 'localhost:8322', 'mini.example.ts.net', 'mini.example.ts.net:443']) {
    const res = mockRes();
    await guarded(req(host), res);
    assert.equal(res.statusCode, 200, host);
  }
  assert.equal(reached, 4);

  for (const host of ['attacker.example:8322', '127.0.0.1', 'mini.example.ts.net:8322', undefined]) {
    const res = mockRes();
    await guarded(req(host), res);
    assert.equal(res.statusCode, 421, String(host));
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers.Connection, 'close');
    assert.deepEqual(JSON.parse(res.body), { error: 'this server does not answer to that Host' });
  }
  assert.equal(reached, 4, 'a refused request never reaches a route');

  // The same bad Host again adds no line; a control character is not printed as itself.
  await guarded(req('attacker.example:8322'), mockRes());
  await guarded(req('evil\u0007.example'), mockRes());
  assert.equal(logged.length, 5);
  assert.match(logged[0], /^host: refused a request for "attacker\.example:8322"/);
  assert.match(logged[3], /no Host/);
  assert.match(logged[4], /"evil\?\.example"/);
  assert.ok(logged.every(l => /allowedHosts/.test(l)), 'every line points at the config key');
});

test('in log mode, the default, an unlisted Host is logged once and the request goes through', async () => {
  const logged = [];
  let reached = 0;
  const handler = (rq, rs) => { reached++; rs.writeHead(200, {}); rs.end('ok'); };
  const guarded = withHostGuard(handler, allowedHostSet(8322), { log: l => logged.push(l) });
  for (const host of ['mini.example.ts.net', 'mini.example.ts.net', '127.0.0.1:8322', undefined]) {
    const res = mockRes();
    await guarded(req(host), res);
    assert.equal(res.statusCode, 200, String(host));
  }
  assert.equal(reached, 4);
  assert.equal(logged.length, 2, 'the listed host and a repeat add no line');
  assert.match(logged[0], /^host: a request for "mini\.example\.ts\.net" is not in allowedHosts \(let through: hostCheck is "log"\)$/);
  assert.match(logged[1], /no Host/);
});

test('the log stops at 20 distinct hosts, so a flood of made-up names fills no disk', async () => {
  const logged = [];
  let reached = 0;
  const guarded = withHostGuard((rq, rs) => { reached++; rs.end(''); }, allowedHostSet(8322), { mode: 'enforce', log: l => logged.push(l) });
  for (let i = 0; i < 60; i++) await guarded(req(`h${i}.example`), mockRes());
  assert.equal(logged.length, 20);
  assert.equal(reached, 0);
});
