# Claude Control Room Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pace-vs-limit projection, a usage history store that makes trend visible, and a usage-drivers panel built from `/usage` data the dashboard already fetches and discards.

**Architecture:** A new append-only JSONL store captures each successful `/usage` reading — the only non-recoverable data in the system. A pure `pace` module infers each limit window's length by watching reset timestamps roll over, then projects burn from elapsed fraction. The `/usage` parser gains a second, deliberately lenient half for the contributing-factors block. The client renders a tick mark and sparkline on existing bars plus one new panel.

**Tech Stack:** Node 26 (ESM, `node:test`, no server dependencies), React 19 + Vite, plain CSS with design tokens.

**Spec:** `docs/superpowers/specs/2026-08-06-phase-2-pace-and-history-design.md`. Read it first — several decisions in it are deliberate and non-obvious.

## Global Constraints

- **Zero runtime dependencies in `server/`.** Node built-ins only. The web app may use React and Vite.
- **ESM everywhere**, `.mjs` in `server/`. Test files stay **flat in `server/test/`** — the npm glob `test/*.mjs` is non-recursive and silently skips nested files.
- **Radius 0 everywhere.** No `border-radius` outside the single global reset in `tokens.css`.
- **Rules are 2px structural, 1px internal.** Never soften to hairlines.
- **Every numeric carries the `.num` class** (`font-variant-numeric: tabular-nums`). The brief's code blocks have been caught omitting this repeatedly across Phase 1 — audit your own output.
- **Colors from tokens only.** No ad-hoc hex in components; `web/src/lib/format.js` already holds the three literals `heat()` needs.
- **Sizing that a media query must override belongs in CSS, not inline styles.** An inline font-size beats a media query.
- **Never fabricate a value.** No panel may render a `0`, an empty bar, or a reassuring summary where the truth is "we could not find out." A gap in history means "no reading", never "a reading of zero".
- **Tests must never shell out to `claude`.** All CLI access goes behind injected seams.
- **Tests must be timezone-independent** and must not pin `process.env.TZ`. Phase 1 lost multiple review rounds to this. Verify under `TZ=Asia/Tokyo` and `TZ=UTC`.
- **The repo is public.** Synthetic test data only — `/Users/example/...`, never real paths, emails, org IDs or hostnames. `server/data/` is already gitignored.
- Current baseline: **214 tests passing.** Do not break any.

## File Structure

```
server/
  history.mjs                 append-only JSONL store, monthly-rotated
  lib/pace.mjs                window-length inference + pace/projection maths
  lib/parse-usage.mjs         EXTEND: lenient contributing-factors parsing
  lib/alerts.mjs              MODIFY: projection alert rule
  collectors/usage.mjs        MODIFY: append each successful reading to history
  server.mjs                  MODIFY: warm history, thread pace + sparkline series
  routes.mjs                  MODIFY: nothing structural — usage payload gains fields
  data/usage-history-*.jsonl  runtime, gitignored
web/src/
  components/Sparkline.jsx    NEW  inline SVG trend line
  components/LimitBars.jsx    MODIFY: expected-position tick, pace sub-line, sparkline
  components/DriversPanel.jsx NEW  the contributing-factors panel
  App.jsx                     MODIFY: mount DriversPanel
  lib/format.js               MODIFY: pace phrasing
```

---

### Task 1: Lenient contributing-factors parsing

The `/usage` parser is the most fragile component in the project. This widens it, so the two halves must fail differently: limits keep throwing, factors degrade quietly.

**Files:**
- Modify: `server/lib/parse-usage.mjs`
- Test: `server/test/parse-usage.test.mjs` (extend), `server/test/fixtures/usage-ok.txt` (already exists)

**Interfaces:**
- Consumes: nothing new
- Produces: `parseUsage(text, now)` return value gains a `factors` key:
  ```
  factors: null | {
    '24h': Window,
    '7d':  Window
  }
  Window = {
    requests: number|null,
    sessions: number|null,
    behaviours: [{ pct: number, text: string }],
    top: [{ category: string, entries: [{ name: string, pct: number }] }]
  }
  ```
  `requests`/`sessions` remain on the existing top-level `requests`/`sessions` objects too — do **not** remove those, `routes.mjs` and existing tests read them.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/parse-usage.test.mjs`:

```js
const FACTORS = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Aug 6 at 5:49pm (America/New_York)
Current week (all models): 20% used · resets Aug 10 at 7:59pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 1360 requests · 2 sessions
  93% of your usage came from subagent-heavy sessions
  63% of your usage was at >150k context
  Top subagents: general-purpose 48%
  Top MCP servers: claude-in-chrome 31%

Last 7d · 5477 requests · 12 sessions
  100% of your usage came from sessions active for 8+ hours
  Top skills: /superpowers:writing-plans 1%, /claude-in-chrome 1%
  Top plugins: superpowers 4%
`;

test('parses behaviour lines for both windows', () => {
  const { factors } = parseUsage(FACTORS, new Date());
  assert.equal(factors['24h'].behaviours.length, 2);
  assert.deepEqual(factors['24h'].behaviours[0], { pct: 93, text: 'subagent-heavy sessions' });
  assert.deepEqual(factors['24h'].behaviours[1], { pct: 63, text: '>150k context' });
  assert.equal(factors['7d'].behaviours[0].pct, 100);
});

test('parses Top categories, preserving the category name', () => {
  const { factors } = parseUsage(FACTORS, new Date());
  const cats = factors['24h'].top.map(t => t.category);
  assert.deepEqual(cats, ['subagents', 'MCP servers']);
  assert.deepEqual(factors['24h'].top[1].entries, [{ name: 'claude-in-chrome', pct: 31 }]);
});

test('parses multiple comma-separated entries with slashes and colons in names', () => {
  const { factors } = parseUsage(FACTORS, new Date());
  const skills = factors['7d'].top.find(t => t.category === 'skills');
  assert.deepEqual(skills.entries, [
    { name: '/superpowers:writing-plans', pct: 1 },
    { name: '/claude-in-chrome', pct: 1 }
  ]);
});

test('carries per-window request and session counts', () => {
  const { factors } = parseUsage(FACTORS, new Date());
  assert.equal(factors['24h'].requests, 1360);
  assert.equal(factors['7d'].sessions, 12);
});

test('an unfamiliar Top category passes through rather than being dropped', () => {
  const text = FACTORS.replace('Top plugins:', 'Top widgets:');
  const { factors } = parseUsage(text, new Date());
  assert.ok(factors['7d'].top.some(t => t.category === 'widgets'));
});

test('an absent factors block yields null, not an empty object', () => {
  const noFactors = `Current session: 5% used · resets Aug 6 at 5:49pm (America/New_York)\n`;
  assert.equal(parseUsage(noFactors, new Date()).factors, null);
});

test('a malformed factors block does NOT break limits parsing', () => {
  const broken = FACTORS.replace('Last 24h · 1360 requests · 2 sessions', 'Last 24h GARBAGE')
                        .replace('Last 7d · 5477 requests · 12 sessions', 'Last 7d GARBAGE');
  const out = parseUsage(broken, new Date());
  assert.equal(out.limits.length, 2);
  assert.equal(out.limits[0].pct, 5);
  assert.equal(out.factors, null);
});

test('the real captured fixture yields usable factors', () => {
  const real = readFileSync(new URL('./fixtures/usage-ok.txt', import.meta.url), 'utf8');
  const { factors } = parseUsage(real, new Date());
  if (factors === null) return; // fixture may predate the factors block
  for (const w of Object.values(factors)) {
    for (const b of w.behaviours) assert.ok(b.pct >= 0 && typeof b.text === 'string');
    for (const t of w.top) assert.ok(typeof t.category === 'string' && Array.isArray(t.entries));
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/parse-usage.test.mjs`
Expected: FAIL — `factors` is `undefined`

- [ ] **Step 3: Implement the factors parser**

Add to `server/lib/parse-usage.mjs`, above `parseUsage`:

```js
const WINDOW_RE = /^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions/;
const BEHAVIOUR_RE = /^(\d+)%\s+of your usage\s+(?:came from|was at)\s+(.+?)\s*$/;
const TOP_RE = /^Top\s+([^:]+):\s*(.+?)\s*$/;
const ENTRY_RE = /^(.*?)\s+(\d+)%$/;

const num = s => Number(String(s).replace(/,/g, ''));

// Deliberately lenient, unlike the limit parsing above. The factors block is
// supplementary; a format change here must never take down the primary numbers.
// Anything unrecognised is skipped, and a block that yields nothing usable
// returns null rather than an empty shape that would read as "no drivers".
function parseFactors(text) {
  const windows = {};
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const w = line.match(WINDOW_RE);
    if (w) {
      current = { requests: num(w[2]), sessions: num(w[3]), behaviours: [], top: [] };
      windows[w[1]] = current;
      continue;
    }
    if (!current) continue;

    const b = line.match(BEHAVIOUR_RE);
    if (b) {
      current.behaviours.push({ pct: Number(b[1]), text: b[2] });
      continue;
    }

    const t = line.match(TOP_RE);
    if (t) {
      const entries = [];
      for (const part of t[2].split(',')) {
        const e = part.trim().match(ENTRY_RE);
        if (e) entries.push({ name: e[1].trim(), pct: Number(e[2]) });
      }
      if (entries.length > 0) current.top.push({ category: t[1].trim(), entries });
    }
  }

  const usable = Object.values(windows).some(w => w.behaviours.length > 0 || w.top.length > 0);
  return usable ? windows : null;
}
```

- [ ] **Step 4: Call it from `parseUsage`, guarded**

Inside `parseUsage`, after the existing limit-parsing loop and its `limits.length === 0` throw, and before the return:

```js
  // Guarded twice over: parseFactors already skips what it cannot read, and a
  // throw from it must still not sink the limits the caller actually needs.
  let factors = null;
  try {
    factors = parseFactors(text);
  } catch {
    factors = null;
  }
```

Then add `factors` to the returned object: `return { limits, requests, sessions, factors };`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, count increased by 8

- [ ] **Step 6: Commit**

```bash
git add server/lib/parse-usage.mjs server/test/parse-usage.test.mjs
git commit -m "feat: parse the /usage contributing-factors block leniently"
```

---

### Task 2: The history store

**Files:**
- Create: `server/history.mjs`
- Test: `server/test/history.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `createHistory({ dir, retentionMs })` returning
  - `append(record)` — `record` is `{ t: number, limits: [{ label, pct, resetsAt }] }`; writes one JSONL line to the month file derived from `record.t`, and adds to the in-memory window
  - `recent(sinceMs)` — records with `t >= sinceMs`, ascending, from memory
  - `warm()` — reads the current and previous month files into memory, trimmed to `retentionMs`
  - `monthFile(t)` — absolute path of the file a timestamp belongs in (exported for tests)

- [ ] **Step 1: Write the failing test**

`server/test/history.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../history.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ccr-hist-'));
const rec = (t, pct) => ({ t, limits: [{ label: 'Current session', pct, resetsAt: null }] });

test('append writes a JSONL line and recent reads it back', async () => {
  const h = createHistory({ dir: dir() });
  await h.append(rec(1000, 5));
  assert.deepEqual(h.recent(0), [rec(1000, 5)]);
});

test('recent filters by cutoff', async () => {
  const h = createHistory({ dir: dir() });
  await h.append(rec(1000, 5));
  await h.append(rec(5000, 9));
  assert.equal(h.recent(2000).length, 1);
  assert.equal(h.recent(2000)[0].pct ?? h.recent(2000)[0].limits[0].pct, 9);
});

test('records are stored in the month file their own timestamp belongs to', async () => {
  const d = dir();
  const h = createHistory({ dir: d });
  const jan = Date.parse('2026-01-15T12:00:00Z');
  const feb = Date.parse('2026-02-02T12:00:00Z');
  await h.append(rec(jan, 1));
  await h.append(rec(feb, 2));
  assert.match(h.monthFile(jan), /2026-01\.jsonl$/);
  assert.match(h.monthFile(feb), /2026-02\.jsonl$/);
  assert.equal(readFileSync(h.monthFile(jan), 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(h.monthFile(feb), 'utf8').trim().split('\n').length, 1);
});

test('warm reads the current and previous month files from disk', async () => {
  const d = dir();
  const now = Date.parse('2026-02-10T00:00:00Z');
  const h1 = createHistory({ dir: d, now: () => now });
  await h1.append(rec(Date.parse('2026-01-20T00:00:00Z'), 1));
  await h1.append(rec(Date.parse('2026-02-05T00:00:00Z'), 2));

  const h2 = createHistory({ dir: d, now: () => now, retentionMs: 365 * 24 * 3600 * 1000 });
  await h2.warm();
  assert.equal(h2.recent(0).length, 2);
});

test('warm skips corrupt lines rather than throwing', async () => {
  const d = dir();
  const now = Date.parse('2026-02-10T00:00:00Z');
  const h = createHistory({ dir: d, now: () => now });
  mkdirSync(d, { recursive: true });
  writeFileSync(h.monthFile(now), `${JSON.stringify(rec(Date.parse('2026-02-01T00:00:00Z'), 7))}\nnot json\n{"truncated":\n`);
  await h.warm();
  assert.equal(h.recent(0).length, 1);
});

test('warm on an empty directory yields no records and does not throw', async () => {
  const h = createHistory({ dir: dir() });
  await h.warm();
  assert.deepEqual(h.recent(0), []);
});

test('the in-memory window is trimmed to the retention period', async () => {
  const now = Date.parse('2026-02-10T00:00:00Z');
  const h = createHistory({ dir: dir(), now: () => now, retentionMs: 24 * 3600 * 1000 });
  await h.append(rec(now - 48 * 3600 * 1000, 1));
  await h.append(rec(now - 1 * 3600 * 1000, 2));
  assert.equal(h.recent(0).length, 1);
});

test('records are returned in ascending timestamp order regardless of append order', async () => {
  const h = createHistory({ dir: dir() });
  await h.append(rec(5000, 2));
  await h.append(rec(1000, 1));
  assert.deepEqual(h.recent(0).map(r => r.t), [1000, 5000]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/history.test.mjs`
Expected: FAIL — cannot find module `../history.mjs`

- [ ] **Step 3: Implement `server/history.mjs`**

```js
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MONTH = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const DEFAULT_RETENTION = 30 * 24 * 3600 * 1000;

export function createHistory({ dir, now = () => Date.now(), retentionMs = DEFAULT_RETENTION } = {}) {
  let records = [];

  const trim = () => {
    const cutoff = now() - retentionMs;
    records = records.filter(r => r.t >= cutoff).sort((a, b) => a.t - b.t);
  };

  const monthFile = t => join(dir, `usage-history-${MONTH(t)}.jsonl`);

  const loadFile = async path => {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return []; // a month with no readings is normal, not an error
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (Number.isFinite(r?.t)) out.push(r);
      } catch { /* a corrupt line costs that line, never the file */ }
    }
    return out;
  };

  return {
    monthFile,

    async append(record) {
      await mkdir(dir, { recursive: true });
      await appendFile(monthFile(record.t), `${JSON.stringify(record)}\n`);
      records.push(record);
      trim();
    },

    recent(sinceMs) {
      return records.filter(r => r.t >= sinceMs);
    },

    async warm() {
      const t = now();
      const prev = new Date(t);
      prev.setMonth(prev.getMonth() - 1);
      const loaded = [
        ...(await loadFile(monthFile(prev.getTime()))),
        ...(await loadFile(monthFile(t)))
      ];
      records = loaded;
      trim();
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test` and `TZ=Asia/Tokyo npm test`
Expected: PASS both, count increased by 8

- [ ] **Step 5: Commit**

```bash
git add server/history.mjs server/test/history.test.mjs
git commit -m "feat: add a month-rotated usage history store"
```

---

### Task 3: Window inference and pace maths

**Files:**
- Create: `server/lib/pace.mjs`
- Test: `server/test/pace.test.mjs`

**Interfaces:**
- Consumes: history records shaped `{ t, limits: [{ label, pct, resetsAt }] }`
- Produces:
  - `inferWindowMs(records, label) -> number | null` — the most recently observed window length for that label, or `null`
  - `WEEKLY_FALLBACK_MS` — `7 * 24 * 3600 * 1000`
  - `computePace({ pct, resetsAt, windowMs, now }) -> { state, elapsed, expectedPct, projectedPct }` where `state` is one of `'unknown-window' | 'too-early' | 'under' | 'on' | 'ahead'`
  - `MIN_ELAPSED_FOR_PROJECTION` — `0.10`

- [ ] **Step 1: Write the failing test**

`server/test/pace.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferWindowMs, computePace, WEEKLY_FALLBACK_MS, MIN_ELAPSED_FOR_PROJECTION } from '../lib/pace.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const at = (t, label, pct, resetsAt) => ({ t, limits: [{ label, pct, resetsAt }] });

test('infers a window length from a reset rollover', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Current session', 40, iso(r1)),
    at(2, 'Current session', 80, iso(r1)),
    at(3, 'Current session', 2, iso(r1 + 5 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 5 * HOUR);
});

test('returns null when no rollover has been observed', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  assert.equal(inferWindowMs([at(1, 'Current session', 40, iso(r1))], 'Current session'), null);
});

test('returns null for an empty history', () => {
  assert.equal(inferWindowMs([], 'Current session'), null);
});

test('ignores a reset that moves backwards', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Current session', 40, iso(r1)),
    at(2, 'Current session', 5, iso(r1 - 3 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
});

test('prefers the most recent observed length when a window changes', () => {
  const r1 = Date.parse('2026-08-01T00:00:00Z');
  const recs = [
    at(1, 'Current session', 9, iso(r1)),
    at(2, 'Current session', 9, iso(r1 + 5 * HOUR)),
    at(3, 'Current session', 9, iso(r1 + 5 * HOUR + 4 * HOUR))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), 4 * HOUR);
});

test('ignores other labels', () => {
  const r1 = Date.parse('2026-08-06T10:00:00Z');
  const recs = [
    at(1, 'Weekly · all models', 10, iso(r1)),
    at(2, 'Weekly · all models', 1, iso(r1 + 7 * DAY))
  ];
  assert.equal(inferWindowMs(recs, 'Current session'), null);
  assert.equal(inferWindowMs(recs, 'Weekly · all models'), 7 * DAY);
});

test('no window length means no pace, stated explicitly', () => {
  const out = computePace({ pct: 50, resetsAt: iso(Date.now() + HOUR), windowMs: null, now: Date.now() });
  assert.equal(out.state, 'unknown-window');
  assert.equal(out.projectedPct, null);
});

test('below the elapsed guard it refuses to project', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const resetsAt = iso(now + 9.5 * HOUR); // 5% elapsed
  const out = computePace({ pct: 40, resetsAt, windowMs, now });
  assert.ok(out.elapsed < MIN_ELAPSED_FOR_PROJECTION);
  assert.equal(out.state, 'too-early');
  assert.equal(out.projectedPct, null);
});

test('burning evenly reads as on pace', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const out = computePace({ pct: 50, resetsAt: iso(now + 5 * HOUR), windowMs, now });
  assert.equal(out.expectedPct, 50);
  assert.equal(out.state, 'on');
  assert.equal(out.projectedPct, 100);
});

test('burning fast reads as ahead, with an unclamped projection', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const out = computePace({ pct: 90, resetsAt: iso(now + 5 * HOUR), windowMs, now });
  assert.equal(out.state, 'ahead');
  assert.equal(out.projectedPct, 180);
});

test('burning slowly reads as under', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const windowMs = 10 * HOUR;
  const out = computePace({ pct: 10, resetsAt: iso(now + 5 * HOUR), windowMs, now });
  assert.equal(out.state, 'under');
});

test('a reset already in the past yields elapsed 1 and no extrapolation', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const out = computePace({ pct: 70, resetsAt: iso(now - HOUR), windowMs: 10 * HOUR, now });
  assert.equal(out.elapsed, 1);
  assert.equal(out.projectedPct, 70);
});

test('a missing or unparseable reset yields unknown-window', () => {
  const now = Date.now();
  assert.equal(computePace({ pct: 10, resetsAt: null, windowMs: 5 * HOUR, now }).state, 'unknown-window');
  assert.equal(computePace({ pct: 10, resetsAt: 'nonsense', windowMs: 5 * HOUR, now }).state, 'unknown-window');
});

test('the weekly fallback is seven days', () => {
  assert.equal(WEEKLY_FALLBACK_MS, 7 * DAY);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/pace.test.mjs`
Expected: FAIL — cannot find module `../lib/pace.mjs`

- [ ] **Step 3: Implement `server/lib/pace.mjs`**

```js
export const WEEKLY_FALLBACK_MS = 7 * 24 * 3600 * 1000;

// Below this fraction of the window, dividing by `elapsed` produces wild
// figures. A projection that cries wolf trains the reader to ignore the one
// signal that matters, so we decline to project instead.
export const MIN_ELAPSED_FOR_PROJECTION = 0.10;

// A pace band either side of the expected position. Without it, "on pace"
// would essentially never occur and every bar would read as ahead or under.
const ON_PACE_BAND = 5;

// `/usage` reports when a window ENDS, never how long it is. But when a window
// rolls over, the new reset jumps forward by exactly one window length — so the
// length is observable rather than assumed, and self-corrects if it ever changes.
export function inferWindowMs(records, label) {
  let previous = null;
  let inferred = null;

  for (const record of records) {
    const limit = (record?.limits ?? []).find(l => l?.label === label);
    if (!limit?.resetsAt) continue;
    const resetsAt = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAt)) continue;

    if (previous !== null && resetsAt > previous) inferred = resetsAt - previous;
    previous = resetsAt;
  }
  return inferred;
}

export function computePace({ pct, resetsAt, windowMs, now }) {
  const none = { state: 'unknown-window', elapsed: null, expectedPct: null, projectedPct: null };
  if (!windowMs || windowMs <= 0 || !resetsAt) return none;

  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return none;

  const start = end - windowMs;
  const elapsed = Math.min(1, Math.max(0, (now - start) / windowMs));
  const expectedPct = Math.round(elapsed * 100);

  if (elapsed < MIN_ELAPSED_FOR_PROJECTION) {
    return { state: 'too-early', elapsed, expectedPct, projectedPct: null };
  }

  // Not clamped: a projection of 180% is real information. The caller clamps
  // the tick MARK to the bar's width, exactly as the credits bar already does.
  const projectedPct = Math.round(pct / elapsed);

  const delta = pct - expectedPct;
  const state = delta > ON_PACE_BAND ? 'ahead' : delta < -ON_PACE_BAND ? 'under' : 'on';
  return { state, elapsed, expectedPct, projectedPct };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`, `TZ=Asia/Tokyo npm test`, `TZ=UTC npm test`
Expected: PASS all three, count increased by 14

- [ ] **Step 5: Commit**

```bash
git add server/lib/pace.mjs server/test/pace.test.mjs
git commit -m "feat: infer limit windows from reset rollovers and compute pace"
```

---

### Task 4: Wire history and pace into the usage collector and payload

**Files:**
- Modify: `server/collectors/usage.mjs`, `server/server.mjs`
- Test: `server/test/collectors.test.mjs` (extend)

**Interfaces:**
- Consumes: `createHistory` (Task 2), `inferWindowMs`/`computePace`/`WEEKLY_FALLBACK_MS` (Task 3), `parseUsage` with `factors` (Task 1)
- Produces: the `usage` panel's `data` gains, per limit entry, `pace` (the `computePace` result) and `series` (`[{ t, pct }]` for that limit's sparkline range). Existing keys are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `server/test/collectors.test.mjs`:

```js
import { collectUsage } from '../collectors/usage.mjs';

const USAGE_TEXT = `Current session: 50% used · resets Aug 6 at 10:00am (America/New_York)
Current week (all models): 20% used · resets Aug 10 at 8:00pm (America/New_York)
`;

test('collectUsage appends a history record on success', async () => {
  const appended = [];
  await collectUsage({
    run: async () => USAGE_TEXT,
    history: { append: async r => appended.push(r), recent: () => [] }
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].limits.length, 2);
  assert.ok(Number.isFinite(appended[0].t));
});

test('a failed parse appends nothing — a gap must mean no reading, not zero', async () => {
  const appended = [];
  await assert.rejects(() => collectUsage({
    run: async () => 'garbage',
    history: { append: async r => appended.push(r), recent: () => [] }
  }));
  assert.equal(appended.length, 0);
});

test('collectUsage works without a history store injected', async () => {
  const out = await collectUsage({ run: async () => USAGE_TEXT });
  assert.equal(out.limits.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/collectors.test.mjs`
Expected: FAIL — nothing is appended

- [ ] **Step 3: Modify `server/collectors/usage.mjs`**

Replace `collectUsage` with:

```js
export async function collectUsage({ run = runUsageCli, now = () => new Date(), history } = {}) {
  const parsed = parseUsage(await run(), now());

  // Appended only after a successful parse. A gap in the history file must mean
  // "no reading was taken", never "a reading of zero".
  if (history) {
    await history.append({
      t: now().getTime(),
      limits: parsed.limits.map(l => ({ label: l.label, pct: l.pct, resetsAt: l.resetsAt }))
    });
  }
  return parsed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, count increased by 3

- [ ] **Step 5: Wire it up in `server/server.mjs`**

Add near the other imports:

```js
import { createHistory } from './history.mjs';
import { inferWindowMs, computePace, WEEKLY_FALLBACK_MS } from './lib/pace.mjs';
```

After `const cache = createCache();`:

```js
const HOUR = 3600000, DAY = 24 * HOUR;
const history = createHistory({ dir: join(HERE, 'data') });
await history.warm();

// Percentages reset to zero each window, so one range for every bar would render
// the session limit as ~144 sawtooth spikes across a month. Each sparkline spans
// its own limit's natural period instead.
const seriesRangeMs = label => (label === 'Current session' ? DAY : 30 * DAY);
```

Replace the `usage` registration with:

```js
registry.register('usage', async () => {
  const parsed = await collectUsage({ history });
  const now = Date.now();
  const records = history.recent(now - 30 * DAY);

  const limits = parsed.limits.map(limit => {
    const observed = inferWindowMs(records, limit.label);
    const windowMs = observed ?? (limit.label.startsWith('Weekly') ? WEEKLY_FALLBACK_MS : null);
    const since = now - seriesRangeMs(limit.label);
    const series = records
      .filter(r => r.t >= since)
      .map(r => ({ t: r.t, pct: r.limits.find(l => l.label === limit.label)?.pct }))
      .filter(p => Number.isFinite(p.pct));
    return {
      ...limit,
      pace: computePace({ pct: limit.pct, resetsAt: limit.resetsAt, windowMs, now }),
      series
    };
  });

  return { ...parsed, limits };
}, 5 * 60 * 1000);
```

Confirm `join` and `HERE` are already imported/defined in `server.mjs` — they are, from the static-file serving.

- [ ] **Step 6: Verify against the live service**

```bash
cd server && node server.mjs &
sleep 100
curl -s http://127.0.0.1:8322/api/dashboard | python3 -c "
import json,sys
u=json.load(sys.stdin)['usage']['data']
for l in u['limits']: print(l['label'], l['pct'], l['pace']['state'], 'series', len(l['series']))
print('factors windows:', list((u.get('factors') or {}).keys()))
"
kill %1
```

Expected: each limit prints a `pace.state`. On a cold history the session limit shows `unknown-window` and weekly limits show a real state via the fallback. `series` lengths start near 1 and grow.

- [ ] **Step 7: Commit**

```bash
git add server/collectors/usage.mjs server/server.mjs server/test/collectors.test.mjs
git commit -m "feat: record usage history and attach pace and series to each limit"
```

---

### Task 5: The projection alert

**Files:**
- Modify: `server/lib/alerts.mjs`
- Test: `server/test/alerts.test.mjs` (extend)

**Interfaces:**
- Consumes: the `pace` object on each limit (Task 4)
- Produces: no new exports; `buildAlerts` gains one rule

- [ ] **Step 1: Write the failing test**

Append to `server/test/alerts.test.mjs`:

```js
const snapshotWith = limits => ({
  crons: { data: [] },
  ingestCrons: { data: [] },
  usage: { status: 'ok', data: { limits } }
});

test('a limit projected to exceed 100% raises an alert', () => {
  const limits = [{ label: 'Weekly · all models', pct: 60, pace: { state: 'ahead', projectedPct: 140 } }];
  const alerts = buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now());
  assert.ok(alerts.some(a => /projected/i.test(a.text) && /140/.test(a.text)));
});

test('a projection at or under 100% raises nothing', () => {
  const limits = [{ label: 'Weekly · all models', pct: 40, pace: { state: 'on', projectedPct: 100 } }];
  assert.deepEqual(buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now()), []);
});

test('no projection alert below the confidence guard', () => {
  const limits = [{ label: 'Current session', pct: 40, pace: { state: 'too-early', projectedPct: null } }];
  assert.deepEqual(buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now()), []);
});

test('no projection alert when the window length is unknown', () => {
  const limits = [{ label: 'Current session', pct: 90, pace: { state: 'unknown-window', projectedPct: null } }];
  const alerts = buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now());
  assert.equal(alerts.filter(a => /projected/i.test(a.text)).length, 0);
});

test('a limit with no pace object at all is handled', () => {
  const limits = [{ label: 'Weekly · Opus', pct: 10 }];
  assert.deepEqual(buildAlerts(snapshotWith(limits), { warnThreshold: 85 }, Date.now()), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/alerts.test.mjs`
Expected: FAIL — no projection alert produced

- [ ] **Step 3: Add the rule to `server/lib/alerts.mjs`**

Immediately after the existing threshold loop:

```js
  // Pace complements the threshold rule rather than replacing it: 85% tells you
  // that you are nearly out, a projection tells you while you can still act.
  for (const limit of snapshot.usage?.data?.limits ?? []) {
    const projected = limit?.pace?.projectedPct;
    if (Number.isFinite(projected) && projected > 100) {
      alerts.push({ text: `${limit.label} projected to reach ${projected}% by reset` });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS, count increased by 5

- [ ] **Step 5: Commit**

```bash
git add server/lib/alerts.mjs server/test/alerts.test.mjs
git commit -m "feat: alert when a limit is projected to exceed its window"
```

---

### Task 6: The sparkline component

**Files:**
- Create: `web/src/components/Sparkline.jsx`

**Interfaces:**
- Consumes: `series` — `[{ t: number, pct: number }]`
- Produces: `<Sparkline series={...} color={...} />`, an inline SVG. Renders an explicit
  "not enough history yet" state below two points — never a flat line, which would read as
  "no usage".

- [ ] **Step 1: Write the component**

`web/src/components/Sparkline.jsx`:

```jsx
const W = 120, H = 18;

export function Sparkline({ series, color = 'var(--n500)' }) {
  // A flat line would read as "usage was zero", which is a different claim from
  // "we have not been running long enough to know". Say the latter.
  if (!Array.isArray(series) || series.length < 2) {
    return (
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--n500)' }}>
        Not enough history yet
      </div>
    );
  }

  const t0 = series[0].t;
  const tSpan = Math.max(1, series[series.length - 1].t - t0);
  const maxPct = Math.max(100, ...series.map(p => p.pct));

  const points = series
    .map(p => `${((p.t - t0) / tSpan) * W},${H - (p.pct / maxPct) * H}`)
    .join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         style={{ display: 'block' }} aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd web && npm run build`
Expected: succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Sparkline.jsx
git commit -m "feat: add an inline sparkline with an explicit no-history state"
```

---

### Task 7: Pace and sparkline on the limit bars

**Files:**
- Modify: `web/src/components/LimitBars.jsx`, `web/src/lib/format.js`

**Interfaces:**
- Consumes: `limit.pace` and `limit.series` (Task 4), `<Sparkline/>` (Task 6)
- Produces: `paceNote(pace) -> string` in `format.js`

- [ ] **Step 1: Add the phrasing helper to `web/src/lib/format.js`**

```js
// Each state says exactly what is known. 'unknown-window' and 'too-early' are
// not failures — they are honest reports that a projection would be a guess.
export function paceNote(pace) {
  if (!pace) return '';
  switch (pace.state) {
    case 'unknown-window': return 'window length not yet observed';
    case 'too-early': return 'too early to project';
    case 'ahead': return `ahead of pace · projected ${pace.projectedPct}% by reset`;
    case 'under': return `under pace · projected ${pace.projectedPct}% by reset`;
    case 'on': return `on pace · projected ${pace.projectedPct}% by reset`;
    default: return '';
  }
}
```

- [ ] **Step 2: Modify `web/src/components/LimitBars.jsx`**

Change the import line to:

```jsx
import { heat, formatUntil, paceNote } from '../lib/format.js';
import { Sparkline } from './Sparkline.jsx';
```

Inside the `map`, after `const color = heat(l.pct, threshold);` add:

```jsx
        const pace = l.pace;
        // The tick is clamped to the bar even when the projection is not — the
        // credits bar already draws this distinction between mark and figure.
        const tick = Number.isFinite(pace?.expectedPct) ? Math.min(100, Math.max(0, pace.expectedPct)) : null;
```

Replace the track element with:

```jsx
            <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, l.pct)}%`, background: color }} />
              {tick !== null && (
                <div title="expected at this point in the window"
                     style={{ position: 'absolute', top: -2, bottom: -2, left: `${tick}%`, width: 2, background: 'var(--ink)' }} />
              )}
            </div>
```

Then, after the existing reset sub-line `<div>`, add:

```jsx
            {pace && (
              <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
                {paceNote(pace)}
              </div>
            )}
            <Sparkline series={l.series} color={color} />
```

- [ ] **Step 3: Verify live**

```bash
cd web && npm run build
cd .. && launchctl kickstart -k gui/$(id -u)/$(launchctl list | grep control-room | awk '{print $3}')
```

Open `http://127.0.0.1:8322/`. Confirm: each limit bar carries a tick mark, a pace sub-line, and either a sparkline or "not enough history yet". Confirm the session bar reads `window length not yet observed` on a cold history rather than showing a projection.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/LimitBars.jsx web/src/lib/format.js
git commit -m "feat: show expected-pace tick, projection and sparkline on limit bars"
```

---

### Task 8: The usage-drivers panel

**Files:**
- Create: `web/src/components/DriversPanel.jsx`
- Modify: `web/src/App.jsx`

**Interfaces:**
- Consumes: `payload.usage.data.factors` (Task 1)
- Produces: `<DriversPanel factors={...} window="7d" />`

- [ ] **Step 1: Write `web/src/components/DriversPanel.jsx`**

```jsx
export function DriversPanel({ factors, window = '7d' }) {
  const w = factors?.[window];
  if (!w) {
    return (
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--n500)' }}>
        No data source · the usage breakdown was not readable
      </div>
    );
  }

  const rows = [
    ...w.behaviours.map(b => ({ name: b.text, pct: b.pct })),
    ...w.top.flatMap(t => t.entries.map(e => ({ name: `${t.category}: ${e.name}`, pct: e.pct })))
  ];
  const max = Math.max(1, ...rows.map(r => r.pct));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="num" style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
        {w.requests} requests · {w.sessions} sessions
      </div>

      {/* These are independent characteristics, not parts of a whole — Anthropic's
          own output says so, and they do not sum to 100. Rendering them as a
          stacked bar or pie would misrepresent them, so each gets its own track. */}
      {rows.map(r => (
        <div key={r.name} style={{
          display: 'grid', gridTemplateColumns: '1fr 60px 40px', alignItems: 'center',
          gap: 10, padding: '4px 0', borderBottom: 'var(--rule-hair)'
        }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{r.name}</span>
          <span style={{ height: 6, background: 'var(--n300)', position: 'relative', display: 'block' }}>
            <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${(r.pct / max) * 100}%`, background: 'var(--ink)', display: 'block' }} />
          </span>
          <span className="num" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', color: 'var(--n700)' }}>
            {r.pct}%
          </span>
        </div>
      ))}

      {/* Mandatory, not decorative: the percentages above this panel are
          account-wide, these are local-machine-only. Two figures of different
          provenance in one column without the distinction would mislead. */}
      <div style={{ fontSize: 10, color: 'var(--n500)', fontWeight: 500, lineHeight: 1.4 }}>
        Local sessions on this machine only — excludes other devices and claude.ai.
        Characteristics are independent and do not sum to 100%.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `web/src/App.jsx`**

Add the import:

```jsx
import { DriversPanel } from './components/DriversPanel.jsx';
```

At the end of the column-01 `<section>`, after the Recent sessions `<Panel>`:

```jsx
  <Panel label="What's driving usage · last 7d" envelope={payload?.usage}>
    <DriversPanel factors={payload?.usage?.data?.factors} window="7d" />
  </Panel>
```

- [ ] **Step 3: Verify live**

```bash
cd web && npm run build
cd .. && launchctl kickstart -k gui/$(id -u)/$(launchctl list | grep control-room | awk '{print $3}')
```

Open `http://127.0.0.1:8322/`. Scroll to the bottom of column 01. Confirm the panel lists behaviour rows and Top entries with independent bars, shows the request/session counts, and carries the local-only caveat. Confirm it is **not** a stacked bar.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/DriversPanel.jsx web/src/App.jsx
git commit -m "feat: surface the usage-drivers breakdown that was being discarded"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `README.md`, `NEXT.md`

- [ ] **Step 1: Update `README.md`**

In the data-source table, add rows for pace/projection (derived from `/usage` plus observed
window lengths) and the drivers panel (from `/usage`, **local-machine-only and approximate**,
unlike the account-wide percentages). Add a short section covering the history store: where it
lives (`server/data/`, gitignored), that it is append-only and month-rotated, that retention is
indefinite while only 30 days are held in memory, and that it exists because the `/usage`
percentages are the only non-recoverable data in the system.

State plainly that the session window length is **observed from reset rollovers, not assumed**,
and that pace is therefore unavailable on a freshly-started history until the first rollover.

- [ ] **Step 2: Update `NEXT.md`**

Remove anything Phase 2 has now delivered. Add, as a known follow-up, the **source-health**
idea: the dashboard currently reports a panel as unavailable without saying *why* — a `/usage`
format change and a crashed CLI look identical. A parser reporting "matched 2 of 3 expected
limit lines" would turn a silent shrug into a diagnosis, and is the highest-value response to
the fact that every data source here is undocumented and unversioned.

- [ ] **Step 3: Full verification**

```bash
cd server && npm test
TZ=Asia/Tokyo npm test
TZ=UTC npm test
cd ../web && npm run build
cd .. && grep -rn "border-radius" web/src/ | grep -v "border-radius: 0" || echo "no stray radius — correct"
git status --short
```

Expected: all three suites pass with matching counts; build succeeds; no stray radius; no
runtime data files staged (`server/data/` is gitignored).

- [ ] **Step 4: Confirm history is actually accumulating**

```bash
ls -la server/data/
wc -l server/data/usage-history-*.jsonl
```

Expected: at least one month file, growing by one line per successful 5-minute poll.

- [ ] **Step 5: Commit**

```bash
git add README.md NEXT.md
git commit -m "docs: document pace, history and the drivers panel"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 History store — append, rotate, warm, corrupt tolerance | 2 |
| §3 Written only on success | 4 |
| §4 Window inference, weekly fallback, no session fallback | 3, 4 |
| §5 Pace maths, tick mark, confidence guard, unclamped projection | 3, 7 |
| §6 Sparklines, per-limit ranges, no-history state | 4 (ranges), 6, 7 |
| §7 Drivers panel, model-rows idiom, mandatory caveat, counts | 1, 8 |
| §8 Two failure semantics in one parser | 1 |
| §9 Projection alert | 5 |
| §10 Degradation across all additions | 1, 3, 6, 8 |
| §11 Testing incl. timezone independence | 1–5 |

**Deliberate omissions:** no client-side test harness is added — the project has none, and the
web-side changes are verified in the browser, consistent with Phase 1. The source-health idea
raised during design is recorded in `NEXT.md` (Task 9) rather than built; it is not in the
approved spec.

**Type consistency:** `pace` is the `computePace` return shape everywhere (`state`, `elapsed`,
`expectedPct`, `projectedPct`) — produced in Task 4, consumed in Tasks 5 and 7. `series` is
`[{ t, pct }]` — produced in Task 4, consumed in Tasks 6 and 7. `factors` is the Task 1 shape —
consumed in Task 8. History records are `{ t, limits: [{ label, pct, resetsAt }] }` in Tasks 2,
3 and 4 alike.
