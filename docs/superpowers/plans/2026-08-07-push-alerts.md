# Push alerts to the phone — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the alert rules reach the user, instead of only appearing in a bar they have to be looking at.

**Architecture:** `buildAlerts` gains a stable `kind` and `key` per alert. A new timer-driven collector evaluates alerts on a schedule, diffs them against a persisted set of already-notified keys, and pushes only the newly-appeared ones via ntfy. Cron alerts are redacted to a count before leaving the machine.

**Tech Stack:** Node 26, ESM, zero runtime dependencies. `fetch` and `node:child_process` (Keychain) are built in.

## Global Constraints

- **Zero runtime dependencies in `server/`.** Node built-ins only.
- **ESM only**, `.mjs`. Test files flat in `server/test/` — the npm glob `test/*.mjs` is non-recursive.
- **Tests must never make a network request or shell out to `security`.** Both go behind injected seams.
- Tests timezone-independent; no `process.env.TZ` pinning.
- **Never fabricate a value.** Two specific expressions here: never push an alert derived from a panel that is not `ok`, and never claim a push was sent when it failed.
- **A failed push must never fail anything else.** It is a convenience; the dashboard is the source of truth.
- **The repo is public.** No topic, no real paths, no identifiers in anything committed. `server/data/` is already gitignored.
- Baseline: **291 tests passing.** Do not break any.

## The privacy rule, and why it is per-source

The topic name is the only access control on free ntfy.sh — anyone who knows it can publish to it or read it — and the body transits a third party. `~/Projects/linkedin-post-agent/scripts/notify.mjs` already sets this discipline and its comment explains it.

So redaction is decided **per alert source, not per message**:

| kind | pushed as |
|---|---|
| `limit` | full text — `Weekly · all models at 88%` |
| `projection` | full text — `Weekly · all models projected to reach 140% by reset` |
| `credits` | full text — `Promotional credit expires in 12 days` |

Redaction is an **allowlist**: only the three kinds above are quoted. Anything else — a
misspelled kind, a kind added later by someone who has not read this — is counted, so the
failure mode of a future mistake is over-redaction rather than disclosure to a third party.
| anything else | **counted, never quoted** — `1 item needs attention` |

Cron *names* are the sharpest case: they come from `~/Library/LaunchAgents` and include jobs from a private repo, which this project deliberately scrubbed from its own fixtures. They must not leave the machine. The count is enough to know whether to look.

---

### Task 1: Give each alert a kind and a stable key

**Files:**
- Modify: `server/lib/alerts.mjs`
- Test: `server/test/alerts.test.mjs` (extend)

**Interfaces:**
- Produces: each alert becomes `{ text, kind, key }`. `text` is unchanged, so the UI needs no change.
  - `kind` is one of `'cron' | 'limit' | 'projection' | 'credits'`
  - `key` identifies the alert's **subject**, not its wording

**Why a key and not the text.** A limit alert's text changes every poll as the percentage moves — `at 86%` becomes `at 87%`. Deduplicating on text would push a fresh notification every five minutes for one continuous condition. The key must therefore name the subject and stay constant while the condition persists.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/alerts.test.mjs`:

```js
test('every alert carries a kind and a key', () => {
  const snapshot = {
    crons: { status: 'ok', data: [{ name: 'nightly', label: 'net.example.nightly', ok: false, last: 'Failed · 1' }] },
    ingestCrons: { data: [] },
    usage: { status: 'ok', data: { limits: [{ label: 'Weekly · all models', pct: 90, pace: { projectedPct: 140 } }] } }
  };
  const alerts = buildAlerts(snapshot, { warnThreshold: 85 }, Date.now());
  for (const a of alerts) {
    assert.ok(typeof a.text === 'string' && a.text.length > 0);
    assert.ok(['cron', 'limit', 'projection', 'credits'].includes(a.kind));
    assert.ok(typeof a.key === 'string' && a.key.length > 0);
  }
});

test('a limit alert keeps the same key as its percentage moves', () => {
  const at = pct => buildAlerts(
    { crons: { data: [] }, ingestCrons: { data: [] },
      usage: { status: 'ok', data: { limits: [{ label: 'Weekly · all models', pct }] } } },
    { warnThreshold: 85 }, Date.now()
  ).find(a => a.kind === 'limit');
  assert.equal(at(86).key, at(87).key);
  assert.notEqual(at(86).text, at(87).text);
});

test('a projection alert keeps the same key as the projection moves', () => {
  const at = projectedPct => buildAlerts(
    { crons: { data: [] }, ingestCrons: { data: [] },
      usage: { status: 'ok', data: { limits: [{ label: 'Weekly · Opus', pct: 50, pace: { projectedPct } }] } } },
    { warnThreshold: 85 }, Date.now()
  ).find(a => a.kind === 'projection');
  assert.equal(at(140).key, at(150).key);
});

test('two limits produce distinct keys', () => {
  const alerts = buildAlerts(
    { crons: { data: [] }, ingestCrons: { data: [] },
      usage: { status: 'ok', data: { limits: [
        { label: 'Weekly · all models', pct: 90 }, { label: 'Weekly · Opus', pct: 91 }
      ] } } },
    { warnThreshold: 85 }, Date.now()
  );
  const keys = alerts.map(a => a.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a cron alert keys on its label, which is stable across runs', () => {
  const alerts = buildAlerts(
    { crons: { status: 'ok', data: [{ name: 'nightly', label: 'net.example.nightly', ok: false, last: 'Failed · 1' }] },
      ingestCrons: { data: [] }, usage: { data: { limits: [] } } },
    { warnThreshold: 85 }, Date.now()
  );
  assert.equal(alerts[0].kind, 'cron');
  assert.equal(alerts[0].key, 'cron:net.example.nightly');
});

test('a cron with no label still gets a key rather than colliding with others', () => {
  const alerts = buildAlerts(
    { crons: { status: 'ok', data: [{ name: 'a', ok: false }, { name: 'b', ok: false }] },
      ingestCrons: { data: [] }, usage: { data: { limits: [] } } },
    { warnThreshold: 85 }, Date.now()
  );
  assert.equal(new Set(alerts.map(a => a.key)).size, 2);
});

test('the two credits rules produce different keys', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const config = { warnThreshold: 85, credits: { promoExpiresOn: '2026-09-19', updatedAt: '2026-07-01' } };
  const alerts = buildAlerts({ crons: { data: [] }, ingestCrons: { data: [] }, usage: { data: { limits: [] } } }, config, now);
  assert.equal(new Set(alerts.map(a => a.key)).size, alerts.length);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test test/alerts.test.mjs`
Expected: FAIL — `kind` is `undefined`

- [ ] **Step 3: Add `kind` and `key` to each push in `server/lib/alerts.mjs`**

Leave every rule's condition and `text` exactly as they are. Add the two fields:

```js
  // `key` names the alert's SUBJECT, not its wording. A limit's text moves with
  // its percentage ("at 86%" -> "at 87%"), so a text-keyed dedup would push a
  // fresh notification every poll for one continuous condition.
```

- cron: `kind: 'cron'`, `key: \`cron:${cron.label ?? cron.name}\`` — the label is the stable launchd identifier; fall back to the name so two unlabelled crons still differ
- limit: `kind: 'limit'`, `key: \`limit:${limit.label}\``
- projection: `kind: 'projection'`, `key: \`projection:${limit.label}\``
- promo expiry: `kind: 'credits'`, `key: 'credits:promo'`
- stale credits: `kind: 'credits'`, `key: 'credits:stale'`

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npm test`
Expected: PASS, 291 + 7

- [ ] **Step 5: Commit**

```bash
git add server/lib/alerts.mjs server/test/alerts.test.mjs
git commit -m "feat: give each alert a kind and a subject-stable key"
```

---

### Task 2: The notifier and the push decision

**Files:**
- Create: `server/notify.mjs` (Keychain + ntfy transport)
- Create: `server/lib/push-alerts.mjs` (pure: what to send, and what has already been sent)
- Test: `server/test/push-alerts.test.mjs`

**Interfaces:**
- `getTopic({ run })` — reads Keychain; `run` injectable; returns the topic or `null`
- `publish({ topic, title, message, fetchImpl })` — POSTs to ntfy; returns `{ sent, reason }`; never throws
- `pushableFrom(alerts)` — applies the redaction rule, returning `[{ key, title, message }]`
- `newKeys(alerts, alreadySent)` — the keys present now and not already notified
- `prune(alreadySent, alerts)` — drops keys whose condition has cleared, so it can fire again later

- [ ] **Step 1: Write the failing tests**

`server/test/push-alerts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushableFrom, newKeys, prune, observableKinds } from '../lib/push-alerts.mjs';

const cron = (key, text) => ({ kind: 'cron', key, text });
const limit = (key, text) => ({ kind: 'limit', key, text });

test('a limit alert pushes its real text', () => {
  const out = pushableFrom([limit('limit:W', 'Weekly · all models at 88%')]);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /Weekly · all models at 88%/);
});

test('a cron alert never sends the job name or its exit status', () => {
  const out = pushableFrom([cron('cron:net.example.secret-job', 'secret-job cron Failed · 429')]);
  assert.equal(out.length, 1);
  const blob = `${out[0].title} ${out[0].message}`;
  assert.ok(!blob.includes('secret-job'), 'job name must not leave the machine');
  assert.ok(!blob.includes('429'), 'exit status must not leave the machine');
  assert.match(blob, /needs? attention/i);
});

test('several failing crons collapse into one counted message', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed'), cron('cron:c', 'c failed')]);
  const crons = out.filter(o => /needs? attention/i.test(o.message));
  assert.equal(crons.length, 1);
  assert.match(crons[0].message, /3/);
});

test('the collapsed cron entry still carries every cron key, so each is deduped separately', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed')]);
  const entry = out.find(o => /needs? attention/i.test(o.message));
  assert.deepEqual([...entry.keys].sort(), ['cron:a', 'cron:b']);
});

test('newKeys returns only alerts not already notified', () => {
  const alerts = [limit('limit:A', 'A at 90%'), limit('limit:B', 'B at 91%')];
  assert.deepEqual(newKeys(alerts, { 'limit:A': 1 }), ['limit:B']);
});

test('newKeys on an empty notified set returns everything', () => {
  const alerts = [limit('limit:A', 'A at 90%')];
  assert.deepEqual(newKeys(alerts, {}), ['limit:A']);
});

test('prune forgets a key whose condition has cleared', () => {
  const pruned = prune({ 'limit:A': 1, 'limit:B': 2 }, [limit('limit:A', 'A at 90%')]);
  assert.deepEqual(Object.keys(pruned), ['limit:A']);
});

test('a cleared then returning condition notifies again', () => {
  const a = [limit('limit:A', 'A at 90%')];
  let sent = { 'limit:A': 1 };
  sent = prune(sent, []);                       // condition cleared
  assert.deepEqual(newKeys(a, sent), ['limit:A']); // and returns
});

test('an alert with no key is dropped rather than pushed unkeyed', () => {
  assert.deepEqual(pushableFrom([{ kind: 'limit', text: 'no key' }]), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test test/push-alerts.test.mjs`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `server/lib/push-alerts.mjs`**

```js
// What may leave this machine, and what may not.
//
// The ntfy topic is the only access control on the free tier — anyone who knows
// it can read it — and the body transits a third party. So redaction is decided
// per SOURCE, not per message: usage figures are the user's own and go out in
// full, but cron identifiers come from launchd and include jobs belonging to a
// private repo. Those never leave; a count is enough to know whether to look.
// An ALLOWLIST, deliberately. A denylist would send full text for any kind that
// is missing, misspelled, or added later by someone who has not read this — so
// the failure mode of a future mistake would be disclosure to a third party.
// Anything not named here is counted, never quoted.
const DISCLOSED_KINDS = new Set(['limit', 'projection', 'credits']);

export function pushableFrom(alerts) {
  const keyed = (alerts ?? []).filter(a => typeof a?.key === 'string' && a.key);
  const out = [];

  for (const a of keyed.filter(a => DISCLOSED_KINDS.has(a.kind))) {
    out.push({ keys: [a.key], title: 'Control Room', message: a.text });
  }

  const crons = keyed.filter(a => !DISCLOSED_KINDS.has(a.kind));
  if (crons.length > 0) {
    out.push({
      keys: crons.map(a => a.key),
      title: 'Control Room',
      message: `${crons.length} item${crons.length === 1 ? '' : 's'} need${crons.length === 1 ? 's' : ''} attention — open the dashboard for detail`
    });
  }
  return out;
}

export function newKeys(alerts, alreadySent) {
  return (alerts ?? [])
    .map(a => a?.key)
    .filter(k => typeof k === 'string' && k && !(k in (alreadySent ?? {})));
}

// Which sources we can actually see this run. A key may only be forgotten if we
// could have observed its condition — otherwise a cold start, where the slow
// `/usage` collector has not written yet, looks identical to every alert having
// cleared, and the whole notified set is wiped and re-pushed.
export function observableKinds(snapshot) {
  const ok = k => snapshot?.[k]?.status === 'ok';
  return new Set([
    ...(ok('usage') ? ['limit', 'projection'] : []),
    ...(ok('crons') || ok('ingestCrons') ? ['cron'] : []),
    // Credits alerts are config-backed, not panel-backed: config is loaded at
    // startup and always readable, so they are always observable.
    'credits'
  ]);
}

// A condition that has cleared is forgotten, so that if it returns it notifies
// again — without this, one 88% week would silence that limit forever. But a
// key whose SOURCE is not observable right now is kept, because absence of
// evidence is not evidence the condition cleared.
export function prune(alreadySent, alerts, observable) {
  const live = new Set((alerts ?? []).map(a => a?.key));
  const kinds = observable ?? new Set();
  const out = {};
  for (const [k, v] of Object.entries(alreadySent ?? {})) {
    if (live.has(k) || !kinds.has(String(k).split(':')[0])) out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Implement `server/notify.mjs`**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// The topic is the only access control on free ntfy.sh, so it lives in Keychain
// rather than in this public repo. Its own entry, not the one another project
// uses: a leaked topic should cost one service, not both.
export async function getTopic({ run } = {}) {
  const call = run ?? (async () => {
    const { stdout } = await exec('security', [
      'find-generic-password', '-a', 'claude-control-room', '-s', 'ntfy-topic', '-w'
    ]);
    return stdout;
  });
  try {
    const topic = (await call()).trim();
    return topic || null;
  } catch {
    return null; // not configured is a normal state, not an error
  }
}

export async function publish({ topic, title, message, fetchImpl = fetch }) {
  if (!topic) return { sent: false, reason: 'no topic configured' };
  try {
    // Encoded: an unencoded topic containing `/` or whitespace rewrites the
    // request target entirely.
    const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'default' },
      body: message
    });
    return { sent: res.ok, reason: res.ok ? null : `HTTP ${res.status}` };
  } catch {
    // Deliberately opaque: a fetch error message can quote the whole URL, and
    // the URL contains the topic — which is the only access control there is.
    return { sent: false, reason: 'request failed' };
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && npm test`
Expected: PASS, previous count + 9

- [ ] **Step 6: Commit**

```bash
git add server/notify.mjs server/lib/push-alerts.mjs server/test/push-alerts.test.mjs
git commit -m "feat: add an ntfy notifier and the push-redaction rules"
```

---

### Task 3: Evaluate alerts on a timer and send the new ones

**Files:**
- Create: `server/collectors/notifier.mjs`
- Modify: `server/server.mjs`
- Modify: `README.md`
- Test: `server/test/notifier.test.mjs`

**Interfaces:**
- `runNotifier({ snapshot, config, now, readSent, writeSent, send })` → `{ alerts, sent, skipped }`
- All I/O is injected: `readSent`/`writeSent` persist the notified set, `send` publishes one message

**Why this is a collector and not part of the request handler.** `buildAlerts` currently runs inside `/api/dashboard`, so alerts are only evaluated when someone loads the page. For push that is useless — the whole point is to be told when you are *not* looking. This runs on the registry's timer, reads the cache, and fetches nothing new.

**Why the notified set is persisted.** The service runs under launchd with `KeepAlive`, so it restarts. An in-memory set would re-push every live alert on every restart.

- [ ] **Step 1: Write the failing test**

`server/test/notifier.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNotifier } from '../collectors/notifier.mjs';

const okUsage = limits => ({ status: 'ok', data: { limits } });
const base = limits => ({
  crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] },
  usage: okUsage(limits)
});
const harness = (initial = {}) => {
  const store = { ...initial };
  const sent = [];
  return {
    store, sent,
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { sent.push(msg); return { sent: true }; }
  };
};

test('a newly-appeared alert is sent once', async () => {
  const h = harness();
  const snap = base([{ label: 'Weekly · X', pct: 90 }]);
  const first = await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(first.sent, 1);
  assert.equal(h.sent.length, 1);

  const second = await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(second.sent, 0);
  assert.equal(h.sent.length, 1);
});

test('a moving percentage does not re-send', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 86 }]), config: cfg, now: Date.now(), ...h });
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 91 }]), config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 1);
});

test('a cleared condition that returns sends again', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 90 }]), config: cfg, now: Date.now(), ...h });
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 10 }]), config: cfg, now: Date.now(), ...h });
  await runNotifier({ snapshot: base([{ label: 'Weekly · X', pct: 90 }]), config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 2);
});

test('nothing is pushed from a panel that is not ok', async () => {
  const h = harness();
  const snap = {
    crons: { status: 'ok', data: [] }, ingestCrons: { status: 'ok', data: [] },
    usage: { status: 'stale', data: { limits: [{ label: 'Weekly · X', pct: 90 }] } }
  };
  const out = await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(out.sent, 0);
  assert.equal(h.sent.length, 0);
});

test('a failed send is not recorded as notified, so it retries next run', async () => {
  const store = {};
  const attempts = [];
  const h = {
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { attempts.push(msg); return { sent: false, reason: 'network down' }; }
  };
  const snap = base([{ label: 'Weekly · X', pct: 90 }]);
  await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  await runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h });
  assert.equal(attempts.length, 2, 'a push that never landed must be retried');
  assert.deepEqual(store, {});
});

test('a throwing send does not escape', async () => {
  const h = harness();
  h.send = async () => { throw new Error('boom'); };
  const snap = base([{ label: 'Weekly · X', pct: 90 }]);
  await assert.doesNotReject(() => runNotifier({ snapshot: snap, config: { warnThreshold: 85 }, now: Date.now(), ...h }));
});

test('cron alerts are counted, and each key deduped separately', async () => {
  const h = harness();
  const cfg = { warnThreshold: 85 };
  const two = {
    crons: { status: 'ok', data: [{ name: 'a', label: 'l:a', ok: false }, { name: 'b', label: 'l:b', ok: false }] },
    ingestCrons: { status: 'ok', data: [] }, usage: okUsage([])
  };
  await runNotifier({ snapshot: two, config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /2 items need attention/);

  const three = {
    crons: { status: 'ok', data: [
      { name: 'a', label: 'l:a', ok: false }, { name: 'b', label: 'l:b', ok: false }, { name: 'c', label: 'l:c', ok: false }
    ] },
    ingestCrons: { status: 'ok', data: [] }, usage: okUsage([])
  };
  await runNotifier({ snapshot: three, config: cfg, now: Date.now(), ...h });
  assert.equal(h.sent.length, 2, 'a third failing job is new and must notify');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/notifier.test.mjs`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement `server/collectors/notifier.mjs`**

```js
import { buildAlerts } from '../lib/alerts.mjs';
import { pushableFrom, newKeys, prune, observableKinds } from '../lib/push-alerts.mjs';

// Only push from panels that are actually current. A `stale` panel still holds
// its last good reading, which is right to keep showing on screen — but pushing
// "you are at 88%" from an hour-old number tells the user something about now
// that we do not know.
const okOnly = snapshot => {
  const out = {};
  for (const [k, v] of Object.entries(snapshot ?? {})) {
    out[k] = v?.status === 'ok' ? v : { ...v, data: undefined };
  }
  return out;
};

export async function runNotifier({ snapshot, config, now, readSent, writeSent, send }) {
  const alerts = buildAlerts(okOnly(snapshot), config ?? {}, now);
  const alreadySent = prune((await readSent()) ?? {}, alerts, observableKinds(snapshot));
  const unsentKeys = new Set(newKeys(alerts, alreadySent));

  let sent = 0, skipped = 0;
  for (const entry of pushableFrom(alerts)) {
    // A grouped cron entry carries several keys; it is new if ANY of them is.
    if (!entry.keys.some(k => unsentKeys.has(k))) { skipped++; continue; }
    let result;
    try {
      result = await send(entry);
    } catch (err) {
      result = { sent: false, reason: err.message };
    }
    if (result?.sent) {
      sent++;
      // Record only what actually landed, so a failed push retries next run
      // rather than being silently swallowed.
      for (const k of entry.keys) alreadySent[k] = now;
    }
  }

  await writeSent(alreadySent);
  return { alerts: alerts.length, sent, skipped };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm test`
Expected: PASS, previous count + 7

- [ ] **Step 5: Wire it into `server/server.mjs`**

Add the imports:

```js
import { runNotifier } from './collectors/notifier.mjs';
import { getTopic, publish } from './notify.mjs';
```

Add a small persisted store beside the others, and register the collector after the existing registrations:

```js
const SENT_PATH = join(HERE, 'data', 'notified.json');
const readSent = async () => {
  try { return JSON.parse(await readFile(SENT_PATH, 'utf8')); } catch { return {}; }
};
const writeSent = async next => {
  await mkdir(dirname(SENT_PATH), { recursive: true });
  await writeFile(SENT_PATH, JSON.stringify(next, null, 2));
};

registry.register('notifier', async () => {
  const topic = await getTopic();
  // Not configured is a normal state — the dashboard works without it.
  if (!topic) return { configured: false, sent: 0 };
  const now = Date.now();
  const out = await runNotifier({
    snapshot: cache.snapshot(now),
    config,
    now,
    readSent,
    writeSent,
    send: entry => publish({ topic, title: entry.title, message: entry.message })
  });
  return { configured: true, ...out };
}, 5 * 60 * 1000);
```

Import `readFile`, `writeFile`, `mkdir` from `node:fs/promises` and `dirname` from `node:path` if not already imported.

- [ ] **Step 6: Document it in `README.md`**

Add a short section: what pushes (the four alert kinds), that cron alerts are redacted to a count and why, that the topic lives in Keychain rather than the repo, and the one-time setup:

```bash
security add-generic-password -a claude-control-room -s ntfy-topic -w 'your-topic-here'
```

State plainly that without a topic the notifier does nothing and the dashboard is unaffected, and that the topic is the only access control on free ntfy.sh — so it should be long and random, and the same topic should not be shared with another service.

- [ ] **Step 7: Verify against the live service**

```bash
cd /Users/jeff/Projects/claude-control-room/server && npm test
TZ=Asia/Tokyo npm test
```

Then, **without** a topic configured, restart the service and confirm the dashboard is unaffected and the notifier reports `configured: false` rather than erroring:

```bash
launchctl kickstart -k gui/$(id -u)/$(launchctl list | grep control-room | awk '{print $3}')
sleep 20
curl -s http://127.0.0.1:8322/api/dashboard | python3 -c "
import json,sys
d=json.load(sys.stdin)
print({k: v.get('status') for k,v in d.items() if isinstance(v,dict) and 'status' in v})
"
```

Report the panel statuses. Do **not** set a real topic or send a real push — that is the user's to do, and a test push to a guessed topic would go to a stranger.

- [ ] **Step 8: Commit**

```bash
git add server/collectors/notifier.mjs server/server.mjs server/test/notifier.test.mjs README.md
git commit -m "feat: evaluate alerts on a timer and push the new ones"
```

---

## Self-Review

**Spec coverage:** kind and stable key (Task 1); per-source redaction with cron names never leaving the machine (Task 2); transition-only pushing with a persisted set surviving restart (Task 3); timer-driven evaluation so alerts fire when nobody is looking (Task 3); a failed push retried rather than swallowed (Task 3).

**Deliberate omissions:** no quiet hours and no rate limit beyond transition-only dedup — the alert set is small and each condition notifies once. No test sends a real push or reads the real Keychain; both are injected.

**The riskiest part** is the persisted dedup: if `notified.json` is lost, every live alert re-notifies once. That is the safe direction — a duplicate notification is an annoyance, a missed one is the failure this feature exists to prevent.
