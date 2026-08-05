# Claude Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-screen operational dashboard showing Claude usage against limits, running projects and crons, and a personal backlog — driven by real on-machine data, running on the Mac mini.

**Architecture:** A dependency-free Node server runs one collector per data source on a timer, each writing into an in-memory cache tagged with freshness; HTTP handlers only ever read that cache. A React + Vite SPA polls one aggregate endpoint every 30s and runs a single 1s tick for countdowns. Every panel carries an explicit `ok | stale | unavailable` status so the UI can never silently show old numbers.

**Tech Stack:** Node 26 (ESM, `node:test`, no server dependencies), React 19 + Vite, plain CSS with design tokens. macOS launchd for process supervision, existing cloudflared tunnel + Cloudflare Access for remote reach.

**Spec:** `docs/superpowers/specs/2026-08-05-claude-control-room-design.md`. Read §2 before starting — every data source was verified on-machine and the plan depends on those exact shapes.

## Global Constraints

- **Zero runtime dependencies in `server/`.** Node built-ins only (`node:http`, `node:fs`, `node:child_process`, `node:test`). The web app may use React and Vite.
- **ESM everywhere.** `.mjs` in `server/`, `"type": "module"` in both package.json files.
- **Radius 0 everywhere.** No `border-radius` may appear in any CSS file.
- **Rules are 2px structural, 1px internal.** Never soften to hairlines.
- **All numerics** carry `font-variant-numeric: tabular-nums`.
- **Focus is** `outline: 2px solid #ec3013; outline-offset: 2px`. Never the browser default.
- **Colors** come only from the token set in Task 9. No ad-hoc hex values in components.
- **Never fabricate a number.** A missing value renders as an explicit unavailable state, never `0`, never an empty bar.
- **Tests never shell out to `claude`.** The CLI is always behind an injectable seam.
- **Config secrecy:** `server/config.json` and `server/todos.json` are gitignored. Only `config.example.json` is committed.

## File Structure

```
server/
  package.json
  config.example.json
  lib/
    heat.mjs             heat-color thresholds
    humanize.mjs         durations, countdowns, relative time, cron schedules
    parse-usage.mjs      `claude -p "/usage"` text -> limits, resets, counts
    parse-transcript.mjs .jsonl transcripts (both roots) -> usage records
    aggregate.mjs        usage records -> byModel / bySurface / byProject / sessions
    parse-launchd.mjs    plists + `launchctl list` -> cron rows
    cowork.mjs           Cowork local_*.json metadata -> sessions + projects
    config.mjs           config.json loading with defaults
  collectors/
    registry.mjs         timer scheduling, isolation, cache writes
    usage.mjs sessions.mjs agents.mjs crons.mjs
  cache.mjs              { data, fetchedAt, status, error } per panel
  todos.mjs              todos.json read/write
  routes.mjs             request routing
  server.mjs             entry point
  test/
    fixtures/            captured real output — see Task 2, 3, 5
    *.test.mjs
web/
  package.json vite.config.js index.html
  src/
    main.jsx App.jsx
    styles/tokens.css app.css
    fonts/               self-hosted Archivo
    hooks/useDashboard.js useTick.js
    lib/format.js        client-side heat + countdown (mirrors server helpers)
    components/
      Header.jsx AlertBar.jsx Column.jsx Panel.jsx StatusNote.jsx
      PlanBlock.jsx CreditsPanel.jsx LimitBars.jsx StackedBar.jsx
      ModelRows.jsx SessionRows.jsx ProjectRows.jsx CronRows.jsx Lanes.jsx
deploy/
  net.milleradvisorypartners.control-room.plist
README.md
```

---

### Task 1: Scaffold and pure helpers

**Files:**
- Create: `server/package.json`, `server/lib/heat.mjs`, `server/lib/humanize.mjs`
- Test: `server/test/heat.test.mjs`, `server/test/humanize.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `heat(pct: number, threshold = 85) -> '#ec3013' | '#605d5d' | '#201e1d'`
  - `formatCountdown(ms: number) -> string` — `H:MM:SS`, or `MM:SS` under an hour
  - `formatShort(ms: number) -> string` — `2d 4h` / `10h 50m` / `23m`
  - `formatRelative(ms: number) -> string` — `4m ago` / `2d ago` / `yesterday`
  - `formatSchedule(cal: {Hour?, Minute?, Weekday?} | null, intervalSec: number | null) -> string`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "control-room-server",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test test/",
    "start": "node server.mjs"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`server/test/heat.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heat } from '../lib/heat.mjs';

test('at or above threshold is accent', () => {
  assert.equal(heat(85), '#ec3013');
  assert.equal(heat(100), '#ec3013');
  assert.equal(heat(118), '#ec3013');
});

test('at or above 70% of threshold is mid grey', () => {
  assert.equal(heat(60), '#605d5d');
  assert.equal(heat(84), '#605d5d');
});

test('below that is ink', () => {
  assert.equal(heat(0), '#201e1d');
  assert.equal(heat(59), '#201e1d');
});

test('threshold is configurable', () => {
  assert.equal(heat(70, 70), '#ec3013');
  assert.equal(heat(50, 70), '#605d5d');
});
```

`server/test/humanize.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown, formatShort, formatRelative, formatSchedule } from '../lib/humanize.mjs';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test('countdown shows H:MM:SS above an hour', () => {
  assert.equal(formatCountdown(HOUR + 42 * MIN + 9000), '1:42:09');
});

test('countdown shows MM:SS below an hour', () => {
  assert.equal(formatCountdown(9 * MIN + 5000), '09:05');
});

test('countdown clamps negatives to zero', () => {
  assert.equal(formatCountdown(-5000), '00:00');
});

test('short form picks the two largest units', () => {
  assert.equal(formatShort(2 * DAY + 4 * HOUR), '2d 4h');
  assert.equal(formatShort(10 * HOUR + 50 * MIN), '10h 50m');
  assert.equal(formatShort(23 * MIN), '23m');
});

test('relative time reads naturally', () => {
  assert.equal(formatRelative(4 * MIN), '4m ago');
  assert.equal(formatRelative(3 * HOUR), '3h ago');
  assert.equal(formatRelative(2 * DAY), '2d ago');
});

test('schedule renders calendar intervals', () => {
  assert.equal(formatSchedule({ Hour: 2, Minute: 0 }, null), 'Every day, 02:00');
  assert.equal(formatSchedule({ Hour: 12, Minute: 0, Weekday: 3 }, null), 'Wednesdays, 12:00');
});

test('schedule renders second intervals', () => {
  assert.equal(formatSchedule(null, 3600), 'Every hour');
  assert.equal(formatSchedule(null, 300), 'Every 5 minutes');
});

test('schedule falls back rather than inventing', () => {
  assert.equal(formatSchedule(null, null), 'On demand');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — cannot find module `../lib/heat.mjs`

- [ ] **Step 4: Implement `server/lib/heat.mjs`**

```js
export const INK = '#201e1d';
export const ACCENT = '#ec3013';
export const MID = '#605d5d';

export function heat(pct, threshold = 85) {
  if (pct >= threshold) return ACCENT;
  if (pct >= threshold * 0.7) return MID;
  return INK;
}
```

- [ ] **Step 5: Implement `server/lib/humanize.mjs`**

```js
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const pad = n => String(n).padStart(2, '0');
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatShort(ms) {
  const total = Math.max(0, ms);
  const d = Math.floor(total / DAY);
  const h = Math.floor((total % DAY) / HOUR);
  const m = Math.floor((total % HOUR) / MIN);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatRelative(ms) {
  const total = Math.max(0, ms);
  if (total < HOUR) return `${Math.floor(total / MIN)}m ago`;
  if (total < DAY) return `${Math.floor(total / HOUR)}h ago`;
  return `${Math.floor(total / DAY)}d ago`;
}

export function formatSchedule(cal, intervalSec) {
  if (cal) {
    const time = `${pad(cal.Hour ?? 0)}:${pad(cal.Minute ?? 0)}`;
    return cal.Weekday === undefined ? `Every day, ${time}` : `${DAYS[cal.Weekday] ?? 'Weekly'}, ${time}`;
  }
  if (intervalSec) {
    if (intervalSec % 3600 === 0) {
      const h = intervalSec / 3600;
      return h === 1 ? 'Every hour' : `Every ${h} hours`;
    }
    const m = Math.round(intervalSec / 60);
    return m === 1 ? 'Every minute' : `Every ${m} minutes`;
  }
  return 'On demand';
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all tests in both files

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/lib/heat.mjs server/lib/humanize.mjs server/test/
git commit -m "feat: add heat thresholds and humanize helpers"
```

---

### Task 2: The `/usage` parser

The single most fragile component: it reads a CLI string that can change shape on any Claude Code release. It must parse **by label, not position**, and must fail loudly rather than emit zeros.

**Files:**
- Create: `server/lib/parse-usage.mjs`, `server/test/fixtures/usage-ok.txt`, `server/test/fixtures/usage-malformed.txt`
- Test: `server/test/parse-usage.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `parseUsage(text: string, now: Date) -> { limits, requests, sessions }` where
  `limits: [{ label: string, pct: number, resetsAt: string | null }]`,
  `requests: { last24h: number|null, last7d: number|null }`,
  `sessions: { last24h: number|null, last7d: number|null }`.
  Throws `UsageParseError` when no limit line is found.

- [ ] **Step 1: Capture the real fixture**

```bash
cd /Users/jeff/Projects/claude-control-room
claude -p "/usage" > server/test/fixtures/usage-ok.txt
cat server/test/fixtures/usage-ok.txt
```

Confirm it contains `Current session:` and at least one `Current week` line. If the format has changed from the spec's §2 sample, stop and update the spec before continuing.

- [ ] **Step 2: Create the malformed fixture**

`server/test/fixtures/usage-malformed.txt`:

```
You are currently using your subscription to power your Claude Code usage

Something went wrong and there is no usage information here.
```

- [ ] **Step 3: Write the failing test**

`server/test/parse-usage.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUsage, UsageParseError } from '../lib/parse-usage.mjs';

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 24% used · resets Aug 5 at 12:09pm (America/New_York)
Current week (all models): 5% used · resets Aug 10 at 8pm (America/New_York)
Current week (Fable): 0% used

What's contributing to your limits usage?

Last 24h · 1349 requests · 2 sessions
Last 7d · 3338 requests · 9 sessions
`;

const NOW = new Date('2026-08-05T12:00:00-04:00');

test('parses every limit line in order', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(limits.length, 3);
  assert.equal(limits[0].label, 'Current session');
  assert.equal(limits[0].pct, 24);
  assert.equal(limits[1].label, 'Weekly · all models');
  assert.equal(limits[1].pct, 5);
});

test('reads the model-scoped label rather than assuming Opus', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(limits[2].label, 'Weekly · Fable');
  assert.equal(limits[2].pct, 0);
});

test('resolves reset timestamps to ISO strings', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(typeof limits[0].resetsAt, 'string');
  assert.ok(new Date(limits[0].resetsAt) > NOW);
});

test('a limit with no reset clause yields null, not a guess', () => {
  const { limits } = parseUsage(SAMPLE, NOW);
  assert.equal(limits[2].resetsAt, null);
});

test('extracts request and session counts', () => {
  const { requests, sessions } = parseUsage(SAMPLE, NOW);
  assert.equal(requests.last24h, 1349);
  assert.equal(sessions.last24h, 2);
  assert.equal(requests.last7d, 3338);
  assert.equal(sessions.last7d, 9);
});

test('throws on unrecognised output instead of returning zeros', () => {
  const bad = readFileSync(new URL('./fixtures/usage-malformed.txt', import.meta.url), 'utf8');
  assert.throws(() => parseUsage(bad, NOW), UsageParseError);
});

test('parses the real captured fixture', () => {
  const real = readFileSync(new URL('./fixtures/usage-ok.txt', import.meta.url), 'utf8');
  const { limits } = parseUsage(real, new Date());
  assert.ok(limits.length >= 2);
  for (const l of limits) {
    assert.ok(l.pct >= 0 && l.pct <= 1000);
    assert.equal(typeof l.label, 'string');
  }
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && node --test test/parse-usage.test.mjs`
Expected: FAIL — cannot find module `../lib/parse-usage.mjs`

- [ ] **Step 5: Implement `server/lib/parse-usage.mjs`**

```js
export class UsageParseError extends Error {}

const LIMIT_RE = /^(Current session|Current week \(([^)]+)\)):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/;
const COUNTS_RE = /^Last\s+(24h|7d)\s*·\s*([\d,]+)\s+requests\s*·\s*([\d,]+)\s+sessions/;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function label(raw, scope) {
  if (raw === 'Current session') return 'Current session';
  return `Weekly · ${scope}`;
}

// "Aug 5 at 12:09pm (America/New_York)" -> ISO string.
// The printed zone is assumed to match the host zone; when it does not, we
// return null rather than silently shifting the countdown by hours.
function resolveReset(clause, now) {
  if (!clause) return null;
  const m = clause.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  const [, mon, day, hourRaw, minRaw, meridiem, zone] = m;
  if (zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone) return null;
  const monthIndex = MONTHS.indexOf(mon.slice(0, 1).toUpperCase() + mon.slice(1, 3).toLowerCase());
  if (monthIndex < 0) return null;
  let hour = Number(hourRaw) % 12;
  if (meridiem.toLowerCase() === 'pm') hour += 12;
  let d = new Date(now.getFullYear(), monthIndex, Number(day), hour, Number(minRaw ?? 0), 0, 0);
  // A reset well in the past means the printed date belongs to next year.
  if (d.getTime() < now.getTime() - 30 * 24 * 3600 * 1000) d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

export function parseUsage(text, now = new Date()) {
  const limits = [];
  const requests = { last24h: null, last7d: null };
  const sessions = { last24h: null, last7d: null };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const lm = trimmed.match(LIMIT_RE);
    if (lm) {
      limits.push({
        label: label(lm[1], lm[2]),
        pct: Number(lm[3]),
        resetsAt: resolveReset(lm[4], now)
      });
      continue;
    }
    const cm = trimmed.match(COUNTS_RE);
    if (cm) {
      const key = cm[1] === '24h' ? 'last24h' : 'last7d';
      requests[key] = Number(cm[2].replace(/,/g, ''));
      sessions[key] = Number(cm[3].replace(/,/g, ''));
    }
  }

  if (limits.length === 0) {
    throw new UsageParseError('no limit lines found in /usage output');
  }
  return { limits, requests, sessions };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && node --test test/parse-usage.test.mjs`
Expected: PASS — all 7 tests

- [ ] **Step 7: Commit**

```bash
git add server/lib/parse-usage.mjs server/test/parse-usage.test.mjs server/test/fixtures/
git commit -m "feat: parse /usage output by label with explicit failure"
```

---

### Task 3: The transcript parser

One parser serves both Claude Code and Cowork, because both write the identical format. This task proves that claim with fixtures from each root.

**Files:**
- Create: `server/lib/parse-transcript.mjs`, `server/test/fixtures/transcript-code.jsonl`, `server/test/fixtures/transcript-cowork.jsonl`
- Test: `server/test/parse-transcript.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseTranscript(text: string, surface: 'Code'|'Cowork') -> { sessionId, title, surface, cwd, gitBranch, records }`
    where `records: [{ ts: number, model: string, tokens: number }]`
  - `totalTokens(usage: object) -> number` — sums input, output, and both cache fields
  - `TRANSCRIPT_ROOTS` — `[{ glob: string, surface: string }]` describing both roots

- [ ] **Step 1: Capture real fixtures (trimmed to keep the repo small)**

```bash
cd /Users/jeff/Projects/claude-control-room
head -c 200000 "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)" \
  | head -n 60 > server/test/fixtures/transcript-code.jsonl
find ~/Library/Application\ Support/Claude/local-agent-mode-sessions \
  -path "*/.claude/projects/*/*.jsonl" | head -1 \
  | xargs head -n 60 > server/test/fixtures/transcript-cowork.jsonl
wc -l server/test/fixtures/transcript-*.jsonl
```

Both files must be non-empty. Truncated trailing lines are expected and the parser must tolerate them.

- [ ] **Step 2: Write the failing test**

`server/test/parse-transcript.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTranscript, totalTokens } from '../lib/parse-transcript.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('totalTokens sums input, output and both cache fields', () => {
  assert.equal(totalTokens({
    input_tokens: 2,
    output_tokens: 107,
    cache_creation_input_tokens: 27921,
    cache_read_input_tokens: 1000
  }), 29030);
});

test('totalTokens treats missing fields as zero', () => {
  assert.equal(totalTokens({ input_tokens: 5 }), 5);
  assert.equal(totalTokens({}), 0);
});

test('extracts usage records from a Claude Code transcript', () => {
  const parsed = parseTranscript(read('transcript-code.jsonl'), 'Code');
  assert.equal(parsed.surface, 'Code');
  assert.ok(parsed.records.length > 0);
  for (const r of parsed.records) {
    assert.equal(typeof r.model, 'string');
    assert.ok(r.tokens > 0);
    assert.ok(Number.isFinite(r.ts));
  }
});

test('the same parser handles a Cowork transcript', () => {
  const parsed = parseTranscript(read('transcript-cowork.jsonl'), 'Cowork');
  assert.equal(parsed.surface, 'Cowork');
  assert.ok(parsed.records.length > 0);
});

test('title comes from the ai-title record, not the usage rows', () => {
  const text = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's1', cwd: '/x', gitBranch: 'main', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Build the thing', timestamp: null, sessionId: 's1' })
  ].join('\n');
  const parsed = parseTranscript(text, 'Code');
  assert.equal(parsed.title, 'Build the thing');
  assert.equal(parsed.sessionId, 's1');
  assert.equal(parsed.cwd, '/x');
  assert.equal(parsed.gitBranch, 'main');
});

test('title is null when no ai-title record exists', () => {
  const text = JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's2', message: { model: 'm', usage: { input_tokens: 1 } } });
  assert.equal(parseTranscript(text, 'Code').title, null);
});

test('malformed lines are skipped, not fatal', () => {
  const text = [
    'not json at all',
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's3', message: { model: 'm', usage: { input_tokens: 4 } } }),
    '{"truncated": '
  ].join('\n');
  const parsed = parseTranscript(text, 'Code');
  assert.equal(parsed.records.length, 1);
});

test('detached HEAD is normalised away', () => {
  const text = JSON.stringify({ type: 'assistant', timestamp: '2026-08-05T13:05:37.167Z', sessionId: 's4', gitBranch: 'HEAD', message: { model: 'm', usage: { input_tokens: 1 } } });
  assert.equal(parseTranscript(text, 'Code').gitBranch, null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/parse-transcript.test.mjs`
Expected: FAIL — cannot find module `../lib/parse-transcript.mjs`

- [ ] **Step 4: Implement `server/lib/parse-transcript.mjs`**

```js
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TRANSCRIPT_ROOTS = [
  { root: join(homedir(), '.claude', 'projects'), surface: 'Code' },
  {
    root: join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    surface: 'Cowork'
  }
];

export function totalTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
}

export function parseTranscript(text, surface) {
  const records = [];
  let sessionId = null, title = null, cwd = null, gitBranch = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (d.sessionId && !sessionId) sessionId = d.sessionId;
    if (d.type === 'ai-title' && d.aiTitle) { title = d.aiTitle; continue; }
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.gitBranch && gitBranch === null) gitBranch = d.gitBranch === 'HEAD' ? null : d.gitBranch;

    const message = d.message;
    if (!message || typeof message !== 'object' || !message.usage) continue;
    const tokens = totalTokens(message.usage);
    if (tokens <= 0) continue;
    const ts = Date.parse(d.timestamp ?? '');
    if (!Number.isFinite(ts)) continue;
    records.push({ ts, model: message.model ?? 'unknown', tokens });
  }

  return { sessionId, title, surface, cwd, gitBranch, records };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node --test test/parse-transcript.test.mjs`
Expected: PASS — all 8 tests

- [ ] **Step 6: Commit**

```bash
git add server/lib/parse-transcript.mjs server/test/parse-transcript.test.mjs server/test/fixtures/
git commit -m "feat: parse Claude Code and Cowork transcripts with one parser"
```

---

### Task 4: Aggregation

Turns flat usage records into the four column-01 panels.

**Files:**
- Create: `server/lib/aggregate.mjs`
- Test: `server/test/aggregate.test.mjs`

**Interfaces:**
- Consumes: `parseTranscript` output from Task 3
- Produces: `aggregate(sessions, now, opts) -> { byModel, bySurface, byProject, recentSessions }`
  where `sessions` is an array of parsed transcripts. Shapes:
  - `byModel: [{ name, tokens, pct }]` sorted descending
  - `bySurface: [{ name: 'Cowork'|'Code'|'Chat', tokens, pct, measurable: boolean }]`
  - `byProject: [{ name, tokens, pct }]` — top 3 plus `Other`
  - `recentSessions: [{ when, title, surface, model, tokens, pct }]` — newest first, max 5

- [ ] **Step 1: Write the failing test**

`server/test/aggregate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../lib/aggregate.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const HOUR = 3600000, DAY = 24 * HOUR;

const sessions = [
  { sessionId: 'a', title: 'Invoice parser', surface: 'Code', cwd: '/Users/jeff/Projects/invoice', gitBranch: 'main',
    records: [
      { ts: NOW - HOUR, model: 'claude-sonnet-5', tokens: 600 },
      { ts: NOW - 2 * HOUR, model: 'claude-opus-5', tokens: 400 }
    ] },
  { sessionId: 'b', title: 'Board narrative', surface: 'Cowork', cwd: '/Users/jeff/CoworkSpace', gitBranch: null,
    records: [{ ts: NOW - 3 * HOUR, model: 'claude-sonnet-5', tokens: 1000 }] },
  { sessionId: 'c', title: 'Ancient', surface: 'Code', cwd: '/Users/jeff/Projects/old', gitBranch: 'main',
    records: [{ ts: NOW - 30 * DAY, model: 'claude-opus-5', tokens: 99999 }] }
];

test('ignores records outside the week window', () => {
  const { byModel } = aggregate(sessions, NOW);
  const total = byModel.reduce((s, m) => s + m.tokens, 0);
  assert.equal(total, 2000);
});

test('byModel sums per model and sorts descending', () => {
  const { byModel } = aggregate(sessions, NOW);
  assert.equal(byModel[0].name, 'Sonnet');
  assert.equal(byModel[0].tokens, 1600);
  assert.equal(byModel[0].pct, 80);
  assert.equal(byModel[1].name, 'Opus');
  assert.equal(byModel[1].pct, 20);
});

test('bySurface splits Cowork and Code and marks Chat unmeasurable', () => {
  const { bySurface } = aggregate(sessions, NOW);
  const chat = bySurface.find(s => s.name === 'Chat');
  assert.equal(chat.measurable, false);
  assert.equal(chat.tokens, null);
  const code = bySurface.find(s => s.name === 'Code');
  assert.equal(code.tokens, 1000);
  assert.equal(code.measurable, true);
});

test('surface percentages are computed over measurable surfaces only', () => {
  const { bySurface } = aggregate(sessions, NOW);
  const measurable = bySurface.filter(s => s.measurable);
  assert.equal(measurable.reduce((s, x) => s + x.pct, 0), 100);
});

test('byProject uses the directory basename and collapses the tail into Other', () => {
  const many = [1, 2, 3, 4, 5].map(i => ({
    sessionId: `p${i}`, title: `t${i}`, surface: 'Code', cwd: `/Users/jeff/Projects/proj${i}`, gitBranch: 'main',
    records: [{ ts: NOW - HOUR, model: 'claude-opus-5', tokens: 100 * (6 - i) }]
  }));
  const { byProject } = aggregate(many, NOW);
  assert.equal(byProject.length, 4);
  assert.equal(byProject[0].name, 'proj1');
  assert.equal(byProject[3].name, 'Other');
  assert.equal(byProject[3].tokens, 300);
});

test('recentSessions are newest first with a share-of-week percentage', () => {
  const { recentSessions } = aggregate(sessions, NOW);
  assert.equal(recentSessions[0].title, 'Invoice parser');
  assert.equal(recentSessions[0].tokens, 1000);
  assert.equal(recentSessions[0].pct, 50);
  assert.equal(recentSessions[0].surface, 'Code');
});

test('a session with no title falls back to its project name', () => {
  const untitled = [{ sessionId: 'x', title: null, surface: 'Code', cwd: '/Users/jeff/Projects/thing', gitBranch: 'main',
    records: [{ ts: NOW - HOUR, model: 'claude-opus-5', tokens: 10 }] }];
  assert.equal(aggregate(untitled, NOW).recentSessions[0].title, 'thing');
});

test('empty input yields empty panels rather than throwing', () => {
  const out = aggregate([], NOW);
  assert.deepEqual(out.byModel, []);
  assert.deepEqual(out.byProject, []);
  assert.equal(out.recentSessions.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/aggregate.test.mjs`
Expected: FAIL — cannot find module `../lib/aggregate.mjs`

- [ ] **Step 3: Implement `server/lib/aggregate.mjs`**

```js
import { basename } from 'node:path';

const WEEK = 7 * 24 * 3600 * 1000;

const MODEL_NAMES = [
  [/opus/i, 'Opus'], [/sonnet/i, 'Sonnet'], [/haiku/i, 'Haiku'], [/fable/i, 'Fable']
];

function prettyModel(id) {
  for (const [re, name] of MODEL_NAMES) if (re.test(id)) return name;
  return id;
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function whenLabel(ts, now) {
  const d = new Date(ts), n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const diffDays = Math.floor((now - ts) / (24 * 3600 * 1000));
  if (diffDays <= 1) return 'Yest';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

export function aggregate(sessions, now = Date.now(), opts = {}) {
  const cutoff = now - (opts.windowMs ?? WEEK);

  const live = sessions.map(s => ({
    ...s,
    records: s.records.filter(r => r.ts >= cutoff)
  })).filter(s => s.records.length > 0);

  const grandTotal = live.reduce((sum, s) => sum + s.records.reduce((a, r) => a + r.tokens, 0), 0);

  const modelTotals = new Map();
  const surfaceTotals = new Map();
  const projectTotals = new Map();

  for (const s of live) {
    const sessionTokens = s.records.reduce((a, r) => a + r.tokens, 0);
    for (const r of s.records) {
      const m = prettyModel(r.model);
      modelTotals.set(m, (modelTotals.get(m) ?? 0) + r.tokens);
    }
    surfaceTotals.set(s.surface, (surfaceTotals.get(s.surface) ?? 0) + sessionTokens);
    const project = s.cwd ? basename(s.cwd) : 'unknown';
    projectTotals.set(project, (projectTotals.get(project) ?? 0) + sessionTokens);
  }

  const byModel = [...modelTotals.entries()]
    .map(([name, tokens]) => ({ name, tokens, pct: pct(tokens, grandTotal) }))
    .sort((a, b) => b.tokens - a.tokens);

  const measurableTotal = (surfaceTotals.get('Cowork') ?? 0) + (surfaceTotals.get('Code') ?? 0);
  const bySurface = [
    { name: 'Cowork', tokens: surfaceTotals.get('Cowork') ?? 0, measurable: true },
    { name: 'Code', tokens: surfaceTotals.get('Code') ?? 0, measurable: true },
    { name: 'Chat', tokens: null, measurable: false }
  ].map(s => ({ ...s, pct: s.measurable ? pct(s.tokens, measurableTotal) : null }));

  const ranked = [...projectTotals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const byProject = top.map(([name, tokens]) => ({ name, tokens, pct: pct(tokens, grandTotal) }));
  if (rest.length > 0) {
    const tokens = rest.reduce((a, [, t]) => a + t, 0);
    byProject.push({ name: 'Other', tokens, pct: pct(tokens, grandTotal) });
  }

  const recentSessions = live
    .map(s => {
      const tokens = s.records.reduce((a, r) => a + r.tokens, 0);
      const last = Math.max(...s.records.map(r => r.ts));
      const model = prettyModel(s.records[s.records.length - 1].model);
      return {
        when: whenLabel(last, now),
        title: s.title ?? (s.cwd ? basename(s.cwd) : 'Untitled'),
        surface: s.surface,
        model,
        tokens,
        pct: pct(tokens, grandTotal),
        ts: last
      };
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);

  return { byModel, bySurface, byProject, recentSessions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test test/aggregate.test.mjs`
Expected: PASS — all 8 tests

- [ ] **Step 5: Commit**

```bash
git add server/lib/aggregate.mjs server/test/aggregate.test.mjs
git commit -m "feat: aggregate usage records into column 01 panels"
```

---

### Task 5: launchd cron parsing

**Files:**
- Create: `server/lib/parse-launchd.mjs`, `server/test/fixtures/launchctl-list.txt`
- Test: `server/test/parse-launchd.test.mjs`

**Interfaces:**
- Consumes: `formatSchedule`, `formatShort` from Task 1
- Produces:
  - `parseLaunchctlList(text) -> Map<label, { pid: number|null, status: number|null }>`
  - `nextRun(cal, now) -> number|null` — epoch ms of the next fire
  - `buildCron({ label, plist, statusRow }, now) -> { name, schedule, nextRunAt, ok, last }`

- [ ] **Step 1: Capture the real fixture**

```bash
cd /Users/jeff/Projects/claude-control-room
launchctl list | grep -v "^PID" | head -30 > server/test/fixtures/launchctl-list.txt
head -5 server/test/fixtures/launchctl-list.txt
```

- [ ] **Step 2: Write the failing test**

`server/test/parse-launchd.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchctlList, nextRun, buildCron } from '../lib/parse-launchd.mjs';

test('parses labels, pids and exit statuses', () => {
  const text = [
    'PID\tStatus\tLabel',
    '30571\t0\tcom.cloudflare.cloudflared.mini',
    '-\t0\tnet.milleradvisorypartners.linkedin-draft',
    '31880\t-15\tnet.milleradvisorypartners.linkedin-review'
  ].join('\n');
  const map = parseLaunchctlList(text);
  assert.equal(map.get('com.cloudflare.cloudflared.mini').pid, 30571);
  assert.equal(map.get('net.milleradvisorypartners.linkedin-draft').pid, null);
  assert.equal(map.get('net.milleradvisorypartners.linkedin-review').status, -15);
});

test('nextRun finds today when the time is still ahead', () => {
  const now = Date.parse('2026-08-05T01:00:00');
  const next = nextRun({ Hour: 2, Minute: 0 }, now);
  assert.equal(new Date(next).getHours(), 2);
  assert.ok(next > now);
});

test('nextRun rolls to tomorrow when the time has passed', () => {
  const now = Date.parse('2026-08-05T03:00:00');
  const next = nextRun({ Hour: 2, Minute: 0 }, now);
  assert.ok(next - now > 20 * 3600 * 1000);
});

test('nextRun honours a weekday', () => {
  const now = Date.parse('2026-08-05T13:00:00'); // Wednesday
  const next = nextRun({ Hour: 7, Minute: 0, Weekday: 1 }, now);
  assert.equal(new Date(next).getDay(), 1);
});

test('nextRun returns null when there is no calendar entry', () => {
  assert.equal(nextRun(null, Date.now()), null);
});

test('a non-zero exit status marks the cron failing', () => {
  const now = Date.parse('2026-08-05T01:00:00');
  const cron = buildCron({
    label: 'net.example.thing',
    plist: { StartCalendarInterval: { Hour: 2, Minute: 0 } },
    statusRow: { pid: null, status: -15 }
  }, now);
  assert.equal(cron.ok, false);
  assert.equal(cron.schedule, 'Every day, 02:00');
  assert.match(cron.last, /-15/);
});

test('a zero exit status is healthy and names the job readably', () => {
  const cron = buildCron({
    label: 'net.milleradvisorypartners.linkedin-draft',
    plist: { StartCalendarInterval: { Hour: 12, Minute: 0, Weekday: 3 } },
    statusRow: { pid: null, status: 0 }
  }, Date.parse('2026-08-05T01:00:00'));
  assert.equal(cron.ok, true);
  assert.equal(cron.name, 'linkedin-draft');
  assert.equal(cron.last, 'OK');
});

test('a running job with no exit status is healthy', () => {
  const cron = buildCron({
    label: 'com.example.daemon',
    plist: { StartInterval: 3600 },
    statusRow: { pid: 1234, status: null }
  }, Date.now());
  assert.equal(cron.ok, true);
  assert.equal(cron.schedule, 'Every hour');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/parse-launchd.test.mjs`
Expected: FAIL — cannot find module `../lib/parse-launchd.mjs`

- [ ] **Step 4: Implement `server/lib/parse-launchd.mjs`**

```js
import { formatSchedule } from './humanize.mjs';

export function parseLaunchctlList(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\t+|\s{2,}/);
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, label] = parts;
    if (label === 'Label' || !label) continue;
    map.set(label, {
      pid: pidRaw === '-' ? null : Number(pidRaw),
      status: statusRaw === '-' ? null : Number(statusRaw)
    });
  }
  return map;
}

export function nextRun(cal, now) {
  if (!cal) return null;
  const hour = cal.Hour ?? 0;
  const minute = cal.Minute ?? 0;
  const base = new Date(now);
  const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);

  if (cal.Weekday === undefined) {
    if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  let delta = (cal.Weekday - candidate.getDay() + 7) % 7;
  if (delta === 0 && candidate.getTime() <= now) delta = 7;
  candidate.setDate(candidate.getDate() + delta);
  return candidate.getTime();
}

function readableName(label) {
  const tail = label.split('.').pop();
  return tail || label;
}

export function buildCron({ label, plist, statusRow }, now = Date.now()) {
  const cal = plist?.StartCalendarInterval ?? null;
  const interval = plist?.StartInterval ?? null;
  const status = statusRow?.status ?? null;
  const ok = status === null || status === 0;
  return {
    name: readableName(label),
    label,
    schedule: formatSchedule(cal, interval),
    nextRunAt: nextRun(cal, now),
    ok,
    last: ok ? 'OK' : `Failed · ${status}`
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node --test test/parse-launchd.test.mjs`
Expected: PASS — all 8 tests

- [ ] **Step 6: Commit**

```bash
git add server/lib/parse-launchd.mjs server/test/parse-launchd.test.mjs server/test/fixtures/launchctl-list.txt
git commit -m "feat: parse launchd jobs into cron rows"
```

---

### Task 6: Cowork metadata and the projects view

**Files:**
- Create: `server/lib/cowork.mjs`, `server/lib/projects.mjs`
- Test: `server/test/cowork.test.mjs`, `server/test/projects.test.mjs`

**Interfaces:**
- Consumes: `formatRelative` from Task 1
- Produces:
  - `parseCoworkSession(json) -> { sessionId, title, model, folder, lastActivityAt, archived }`
  - `buildProjects({ agents, coworkSessions, transcripts }, now) -> [{ name, tool, running, detail, tasks }]`
    sorted running-first then by most recent activity

- [ ] **Step 1: Write the failing tests**

`server/test/cowork.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoworkSession } from '../lib/cowork.mjs';

const RAW = {
  sessionId: 'local_9e7b3f21',
  cliSessionId: 'f6144e8c',
  cwd: '/Users/jeff/Library/Application Support/Claude/local-agent-mode-sessions/x/y/local_9e7b3f21/outputs',
  userSelectedFolders: ['/Users/jeff/CoworkSpace'],
  createdAt: 1785012248192,
  lastActivityAt: 1785012751392,
  model: 'claude-opus-5',
  isArchived: false,
  title: 'Cowork setup'
};

test('reads the fields the dashboard needs', () => {
  const s = parseCoworkSession(RAW);
  assert.equal(s.title, 'Cowork setup');
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.lastActivityAt, 1785012751392);
  assert.equal(s.archived, false);
});

test('prefers the user-selected folder over the internal outputs path', () => {
  assert.equal(parseCoworkSession(RAW).folder, '/Users/jeff/CoworkSpace');
});

test('falls back to cwd when no folder was selected', () => {
  const s = parseCoworkSession({ ...RAW, userSelectedFolders: [] });
  assert.ok(s.folder.includes('outputs'));
});

test('an untitled session yields null rather than a placeholder', () => {
  assert.equal(parseCoworkSession({ ...RAW, title: undefined }).title, null);
});
```

`server/test/projects.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjects } from '../lib/projects.mjs';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const MIN = 60000;

const input = {
  agents: [
    { pid: 1, cwd: '/Users/jeff/Projects/invoice', status: 'busy', name: 'invoice-a1' },
    { pid: 2, cwd: '/Users/jeff/Projects/warehouse', status: 'idle', name: 'warehouse-b2' }
  ],
  coworkSessions: [
    { sessionId: 'c1', title: 'Board narrative', model: 'claude-opus-5', folder: '/Users/jeff/CoworkSpace', lastActivityAt: NOW - 22 * MIN, archived: false },
    { sessionId: 'c2', title: 'Archived thing', model: 'claude-opus-5', folder: '/Users/jeff/Old', lastActivityAt: NOW - 99 * MIN, archived: true }
  ],
  transcripts: [
    { cwd: '/Users/jeff/Projects/invoice', gitBranch: 'main', lastTs: NOW - 4 * MIN },
    { cwd: '/Users/jeff/Projects/warehouse', gitBranch: 'feat/etl', lastTs: NOW - 26 * 60 * MIN }
  ]
};

test('marks a busy agent as running', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'invoice');
  assert.equal(p.running, true);
  assert.equal(p.tool, 'Code');
});

test('marks an idle agent as not running', () => {
  assert.equal(buildProjects(input, NOW).find(x => x.name === 'warehouse').running, false);
});

test('includes the git branch and relative edit time in the detail line', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'invoice');
  assert.equal(p.detail, 'edited 4m ago · main');
});

test('omits the branch when there is none', () => {
  const p = buildProjects(input, NOW).find(x => x.name === 'CoworkSpace');
  assert.equal(p.detail, 'edited 22m ago');
  assert.equal(p.tool, 'Cowork');
});

test('archived Cowork sessions are excluded', () => {
  assert.equal(buildProjects(input, NOW).some(p => p.name === 'Old'), false);
});

test('running projects sort ahead of idle ones', () => {
  const names = buildProjects(input, NOW).map(p => p.name);
  assert.equal(names[0], 'invoice');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/cowork.test.mjs test/projects.test.mjs`
Expected: FAIL — cannot find modules

- [ ] **Step 3: Implement `server/lib/cowork.mjs`**

```js
export function parseCoworkSession(raw) {
  const folder = Array.isArray(raw.userSelectedFolders) && raw.userSelectedFolders.length > 0
    ? raw.userSelectedFolders[0]
    : raw.cwd;
  return {
    sessionId: raw.sessionId,
    title: raw.title ?? null,
    model: raw.model ?? null,
    folder,
    lastActivityAt: raw.lastActivityAt ?? raw.createdAt ?? null,
    archived: raw.isArchived === true
  };
}
```

- [ ] **Step 4: Implement `server/lib/projects.mjs`**

```js
import { basename } from 'node:path';
import { formatRelative } from './humanize.mjs';

export function buildProjects({ agents = [], coworkSessions = [], transcripts = [] }, now = Date.now()) {
  const projects = new Map();

  const touch = (name, tool) => {
    if (!projects.has(name)) {
      projects.set(name, { name, tool, running: false, lastTs: null, branch: null, tasks: null });
    }
    return projects.get(name);
  };

  for (const a of agents) {
    if (!a.cwd) continue;
    const p = touch(basename(a.cwd), 'Code');
    if (a.status === 'busy') p.running = true;
  }

  for (const t of transcripts) {
    if (!t.cwd) continue;
    const p = touch(basename(t.cwd), 'Code');
    if (p.lastTs === null || t.lastTs > p.lastTs) p.lastTs = t.lastTs;
    if (t.gitBranch) p.branch = t.gitBranch;
  }

  for (const s of coworkSessions) {
    if (s.archived || !s.folder) continue;
    const p = touch(basename(s.folder), 'Cowork');
    if (p.lastTs === null || (s.lastActivityAt ?? 0) > p.lastTs) p.lastTs = s.lastActivityAt;
  }

  return [...projects.values()]
    .map(p => {
      const edited = p.lastTs ? `edited ${formatRelative(now - p.lastTs)}` : 'no recent activity';
      return {
        name: p.name,
        tool: p.tool,
        running: p.running,
        detail: p.branch ? `${edited} · ${p.branch}` : edited,
        tasks: p.tasks
      };
    })
    .sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node --test test/cowork.test.mjs test/projects.test.mjs`
Expected: PASS — all 10 tests

- [ ] **Step 6: Commit**

```bash
git add server/lib/cowork.mjs server/lib/projects.mjs server/test/cowork.test.mjs server/test/projects.test.mjs
git commit -m "feat: build the projects view from agents, Cowork and transcripts"
```

---

### Task 7: Cache and collector registry

The isolation guarantee lives here: one failing collector must never blank another panel, and stale data must announce itself.

**Files:**
- Create: `server/cache.mjs`, `server/collectors/registry.mjs`
- Test: `server/test/cache.test.mjs`, `server/test/registry.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createCache() -> { set(key, data), fail(key, error), get(key, now), snapshot(now) }`
  - Panel envelope: `{ data, fetchedAt, status: 'ok'|'stale'|'unavailable', error }`
  - `createRegistry(cache, { setInterval, clearInterval }) -> { register(name, fn, intervalMs), startAll(), stopAll(), runOnce(name) }`

- [ ] **Step 1: Write the failing tests**

`server/test/cache.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';

test('a key never written is unavailable', () => {
  const c = createCache();
  const e = c.get('usage', Date.now());
  assert.equal(e.status, 'unavailable');
  assert.equal(e.data, null);
});

test('a fresh write is ok', () => {
  const c = createCache();
  const now = Date.now();
  c.set('usage', { pct: 5 }, now);
  assert.equal(c.get('usage', now).status, 'ok');
});

test('data older than its staleness budget goes stale but keeps its data', () => {
  const c = createCache({ budgets: { usage: 1000 } });
  const now = Date.now();
  c.set('usage', { pct: 5 }, now);
  const e = c.get('usage', now + 5000);
  assert.equal(e.status, 'stale');
  assert.deepEqual(e.data, { pct: 5 });
});

test('a failure after a good write keeps the old data and marks it stale', () => {
  const c = createCache();
  const now = Date.now();
  c.set('usage', { pct: 5 }, now);
  c.fail('usage', new Error('parse blew up'), now);
  const e = c.get('usage', now);
  assert.equal(e.status, 'stale');
  assert.deepEqual(e.data, { pct: 5 });
  assert.match(e.error, /parse blew up/);
});

test('a failure with no previous data is unavailable, never zeros', () => {
  const c = createCache();
  const now = Date.now();
  c.fail('usage', new Error('nope'), now);
  const e = c.get('usage', now);
  assert.equal(e.status, 'unavailable');
  assert.equal(e.data, null);
});

test('one key failing does not affect another', () => {
  const c = createCache();
  const now = Date.now();
  c.set('crons', [{ name: 'a' }], now);
  c.fail('usage', new Error('boom'), now);
  assert.equal(c.get('crons', now).status, 'ok');
});
```

`server/test/registry.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createRegistry } from '../collectors/registry.mjs';

const fakeTimers = () => {
  const jobs = [];
  return {
    jobs,
    setInterval: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    clearInterval: () => {}
  };
};

test('a successful collector writes to the cache', async () => {
  const cache = createCache();
  const timers = fakeTimers();
  const r = createRegistry(cache, timers);
  r.register('usage', async () => ({ pct: 12 }), 1000);
  await r.runOnce('usage');
  assert.equal(cache.get('usage', Date.now()).data.pct, 12);
});

test('a throwing collector marks a failure without escaping', async () => {
  const cache = createCache();
  const r = createRegistry(cache, fakeTimers());
  r.register('usage', async () => { throw new Error('cli missing'); }, 1000);
  await r.runOnce('usage');
  const e = cache.get('usage', Date.now());
  assert.equal(e.status, 'unavailable');
  assert.match(e.error, /cli missing/);
});

test('one collector throwing leaves the others intact', async () => {
  const cache = createCache();
  const r = createRegistry(cache, fakeTimers());
  r.register('usage', async () => { throw new Error('bad'); }, 1000);
  r.register('crons', async () => [{ name: 'nightly' }], 1000);
  await Promise.all([r.runOnce('usage'), r.runOnce('crons')]);
  assert.equal(cache.get('crons', Date.now()).status, 'ok');
});

test('startAll schedules one timer per collector', () => {
  const timers = fakeTimers();
  const r = createRegistry(createCache(), timers);
  r.register('a', async () => 1, 1000);
  r.register('b', async () => 2, 2000);
  r.startAll();
  assert.equal(timers.jobs.length, 2);
  assert.deepEqual(timers.jobs.map(j => j.ms), [1000, 2000]);
});

test('an overlapping run is skipped rather than stacked', async () => {
  const cache = createCache();
  const r = createRegistry(createCache(), fakeTimers());
  let started = 0;
  r.register('slow', async () => { started++; await new Promise(res => setTimeout(res, 20)); return 1; }, 1000);
  await Promise.all([r.runOnce('slow'), r.runOnce('slow')]);
  assert.equal(started, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/cache.test.mjs test/registry.test.mjs`
Expected: FAIL — cannot find modules

- [ ] **Step 3: Implement `server/cache.mjs`**

```js
const DEFAULT_BUDGETS = {
  usage: 15 * 60 * 1000,
  sessions: 5 * 60 * 1000,
  agents: 3 * 60 * 1000,
  crons: 5 * 60 * 1000
};
const FALLBACK_BUDGET = 5 * 60 * 1000;

export function createCache({ budgets = {} } = {}) {
  const store = new Map();
  const budgetFor = key => budgets[key] ?? DEFAULT_BUDGETS[key] ?? FALLBACK_BUDGET;

  return {
    set(key, data, now = Date.now()) {
      store.set(key, { data, fetchedAt: now, error: null });
    },
    fail(key, error, now = Date.now()) {
      const prev = store.get(key);
      store.set(key, {
        data: prev?.data ?? null,
        fetchedAt: prev?.fetchedAt ?? null,
        error: String(error?.message ?? error),
        failedAt: now
      });
    },
    get(key, now = Date.now()) {
      const entry = store.get(key);
      if (!entry || entry.data === null) {
        return { data: null, fetchedAt: entry?.fetchedAt ?? null, status: 'unavailable', error: entry?.error ?? null };
      }
      const aged = now - entry.fetchedAt > budgetFor(key);
      const status = entry.error || aged ? 'stale' : 'ok';
      return { data: entry.data, fetchedAt: entry.fetchedAt, status, error: entry.error };
    },
    snapshot(now = Date.now()) {
      const out = {};
      for (const key of store.keys()) out[key] = this.get(key, now);
      return out;
    }
  };
}
```

- [ ] **Step 4: Implement `server/collectors/registry.mjs`**

```js
export function createRegistry(cache, timers = { setInterval, clearInterval }) {
  const collectors = new Map();
  const handles = [];

  return {
    register(name, fn, intervalMs) {
      collectors.set(name, { fn, intervalMs, running: false });
    },
    async runOnce(name) {
      const c = collectors.get(name);
      if (!c || c.running) return;
      c.running = true;
      try {
        cache.set(name, await c.fn());
      } catch (err) {
        cache.fail(name, err);
      } finally {
        c.running = false;
      }
    },
    startAll() {
      for (const [name, c] of collectors) {
        this.runOnce(name);
        handles.push(timers.setInterval(() => this.runOnce(name), c.intervalMs));
      }
    },
    stopAll() {
      for (const h of handles) timers.clearInterval(h);
      handles.length = 0;
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node --test test/cache.test.mjs test/registry.test.mjs`
Expected: PASS — all 11 tests

- [ ] **Step 6: Commit**

```bash
git add server/cache.mjs server/collectors/registry.mjs server/test/cache.test.mjs server/test/registry.test.mjs
git commit -m "feat: add freshness-tracking cache and isolated collector registry"
```

---

### Task 8: Collectors, config, todos and the HTTP server

Wires the real sources in behind injectable seams, then serves one aggregate payload.

**Files:**
- Create: `server/lib/config.mjs`, `server/config.example.json`, `server/todos.mjs`, `server/collectors/usage.mjs`, `server/collectors/sessions.mjs`, `server/collectors/agents.mjs`, `server/collectors/crons.mjs`, `server/routes.mjs`, `server/server.mjs`
- Test: `server/test/collectors.test.mjs`, `server/test/routes.test.mjs`, `server/test/todos.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces:
  - `collectUsage({ run }) -> { limits, requests, sessions }` where `run` is an injected `() => Promise<string>`
  - `collectAgents({ run }) -> [{ pid, cwd, status, name }]`
  - `collectSessions({ roots, readDir, readFile }) -> { transcripts, coworkSessions }`
  - `collectCrons({ listAgents, readPlist, runLaunchctl }) -> [cron]`
  - `loadConfig(path) -> { plan, credits, warnThreshold, showAlertBanner }`
  - `buildAlerts(snapshot, config, now) -> [{ text }]`
  - `handler(req, res)` over `GET /api/dashboard`, `GET|PUT /api/todos`, `POST /api/ingest/:kind`

- [ ] **Step 1: Write `server/config.example.json`**

```json
{
  "warnThreshold": 85,
  "showAlertBanner": true,
  "plan": {
    "name": "Max — 20×",
    "price": "$200 / month",
    "renews": "2026-08-21",
    "seats": "1 · none"
  },
  "credits": {
    "balance": 88.62,
    "spent": 23.68,
    "monthlyLimit": 20.00,
    "resetsOn": "2026-09-01",
    "promoAmount": 88.61,
    "promoExpiresOn": "2026-09-19",
    "updatedAt": "2026-08-05"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`server/test/collectors.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUsage } from '../collectors/usage.mjs';
import { collectAgents } from '../collectors/agents.mjs';
import { buildAlerts } from '../lib/alerts.mjs';

const USAGE_TEXT = `Current session: 24% used · resets Aug 5 at 12:09pm (America/New_York)
Current week (all models): 5% used · resets Aug 10 at 8pm (America/New_York)
Current week (Opus): 88% used
`;

test('collectUsage parses whatever the injected runner returns', async () => {
  const out = await collectUsage({ run: async () => USAGE_TEXT });
  assert.equal(out.limits.length, 3);
  assert.equal(out.limits[2].pct, 88);
});

test('collectUsage propagates failure so the registry can mark it', async () => {
  await assert.rejects(() => collectUsage({ run: async () => 'garbage output' }));
});

test('collectAgents parses the JSON array', async () => {
  const json = JSON.stringify([{ pid: 1, cwd: '/x', kind: 'interactive', status: 'busy', name: 'a' }]);
  const out = await collectAgents({ run: async () => json });
  assert.equal(out[0].status, 'busy');
});

test('collectAgents rejects invalid JSON rather than returning empty', async () => {
  await assert.rejects(() => collectAgents({ run: async () => 'not json' }));
});

test('alerts fire for a failing cron', () => {
  const snapshot = {
    crons: { status: 'ok', data: [{ name: 'nightly-sync', ok: false, last: 'Failed · 429' }] },
    usage: { status: 'ok', data: { limits: [] } }
  };
  const alerts = buildAlerts(snapshot, { warnThreshold: 85 }, Date.now());
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /nightly-sync/);
});

test('alerts fire for a limit at or above the threshold', () => {
  const snapshot = {
    crons: { status: 'ok', data: [] },
    usage: { status: 'ok', data: { limits: [{ label: 'Weekly · Opus', pct: 88 }] } }
  };
  const alerts = buildAlerts(snapshot, { warnThreshold: 85 }, Date.now());
  assert.match(alerts[0].text, /88%/);
});

test('no alerts when everything is healthy', () => {
  const snapshot = {
    crons: { status: 'ok', data: [{ name: 'ok-job', ok: true }] },
    usage: { status: 'ok', data: { limits: [{ label: 'Current session', pct: 10 }] } }
  };
  assert.deepEqual(buildAlerts(snapshot, { warnThreshold: 85 }, Date.now()), []);
});

test('a promo credit expiring within 30 days raises an alert', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const config = { warnThreshold: 85, credits: { promoAmount: 88.61, promoExpiresOn: '2026-09-19', updatedAt: '2026-09-01' } };
  const alerts = buildAlerts({ crons: { data: [] }, usage: { data: { limits: [] } } }, config, now);
  assert.match(alerts[0].text, /expire/i);
});

test('credits older than 14 days raise a staleness alert', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const config = { warnThreshold: 85, credits: { promoExpiresOn: '2027-01-01', updatedAt: '2026-08-01' } };
  const alerts = buildAlerts({ crons: { data: [] }, usage: { data: { limits: [] } } }, config, now);
  assert.ok(alerts.some(a => /credits/i.test(a.text)));
});
```

`server/test/todos.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore } from '../todos.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ccr-')), 'todos.json');

test('seeds on first read', async () => {
  const store = createTodoStore(tmp());
  const todos = await store.read();
  assert.ok(todos.length > 0);
  assert.ok(todos.every(t => ['idea', 'doing', 'done'].includes(t.lane)));
});

test('writes survive a reread', async () => {
  const path = tmp();
  const store = createTodoStore(path);
  await store.write([{ id: 1, text: 'x', lane: 'idea', tag: 'Note' }]);
  assert.deepEqual(await createTodoStore(path).read(), [{ id: 1, text: 'x', lane: 'idea', tag: 'Note' }]);
});

test('rejects a non-array payload', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write({ nope: true }));
});

test('rejects an unknown lane', async () => {
  const store = createTodoStore(tmp());
  await assert.rejects(() => store.write([{ id: 1, text: 'x', lane: 'nowhere' }]));
});
```

`server/test/routes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../cache.mjs';
import { createHandler } from '../routes.mjs';

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs ?? {}); };
  res.end = body => { res.body = body ?? ''; res.finished = true; };
  return res;
};

const call = async (handler, method, url, body) => {
  const req = { method, url, headers: {}, on(evt, fn) {
    if (evt === 'data' && body) fn(Buffer.from(JSON.stringify(body)));
    if (evt === 'end') fn();
    return req;
  } };
  const res = mockRes();
  await handler(req, res);
  return res;
};

const deps = () => {
  const cache = createCache();
  const todos = { read: async () => [], write: async () => {} };
  return { cache, todos, config: { warnThreshold: 85, showAlertBanner: true, plan: {}, credits: {} } };
};

test('GET /api/dashboard returns every panel envelope', async () => {
  const d = deps();
  d.cache.set('usage', { limits: [{ label: 'Current session', pct: 10, resetsAt: null }] });
  const res = await call(createHandler(d), 'GET', '/api/dashboard');
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.usage.status, 'ok');
  assert.ok('crons' in payload);
  assert.ok('alerts' in payload);
});

test('an unwritten panel reports unavailable rather than being omitted', async () => {
  const res = await call(createHandler(deps()), 'GET', '/api/dashboard');
  assert.equal(JSON.parse(res.body).usage.status, 'unavailable');
});

test('PUT /api/todos persists through the store', async () => {
  const d = deps();
  let saved = null;
  d.todos.write = async v => { saved = v; };
  const res = await call(createHandler(d), 'PUT', '/api/todos', [{ id: 1, text: 'a', lane: 'idea' }]);
  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, 1);
});

test('POST /api/ingest/crons writes into the cache', async () => {
  const d = deps();
  const res = await call(createHandler(d), 'POST', '/api/ingest/crons', [{ name: 'cloud-job', ok: true }]);
  assert.equal(res.statusCode, 200);
  assert.equal(d.cache.get('ingestCrons', Date.now()).data[0].name, 'cloud-job');
});

test('an unknown route is a 404', async () => {
  const res = await call(createHandler(deps()), 'GET', '/api/nope');
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && node --test test/collectors.test.mjs test/todos.test.mjs test/routes.test.mjs`
Expected: FAIL — cannot find modules

- [ ] **Step 4: Implement the collectors**

`server/collectors/usage.mjs`:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUsage } from '../lib/parse-usage.mjs';

const exec = promisify(execFile);

export const runUsageCli = async () => {
  const { stdout } = await exec('claude', ['-p', '/usage'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function collectUsage({ run = runUsageCli, now = () => new Date() } = {}) {
  return parseUsage(await run(), now());
}
```

`server/collectors/agents.mjs`:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const runAgentsCli = async () => {
  const { stdout } = await exec('claude', ['agents', '--json'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function collectAgents({ run = runAgentsCli } = {}) {
  const parsed = JSON.parse(await run());
  if (!Array.isArray(parsed)) throw new Error('claude agents --json did not return an array');
  return parsed;
}
```

`server/collectors/sessions.mjs`:

```js
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TRANSCRIPT_ROOTS, parseTranscript } from '../lib/parse-transcript.mjs';
import { parseCoworkSession } from '../lib/cowork.mjs';

async function walk(dir, match, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, match, out, depth + 1);
    else if (match(e.name)) out.push(full);
  }
  return out;
}

export async function collectSessions({ roots = TRANSCRIPT_ROOTS, maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const transcripts = [];
  const coworkSessions = [];

  for (const { root, surface } of roots) {
    for (const file of await walk(root, n => n.endsWith('.jsonl'))) {
      let info;
      try { info = await stat(file); } catch { continue; }
      if (info.mtimeMs < cutoff) continue;
      const parsed = parseTranscript(await readFile(file, 'utf8'), surface);
      if (parsed.records.length === 0) continue;
      parsed.lastTs = Math.max(...parsed.records.map(r => r.ts));
      transcripts.push(parsed);
    }
    if (surface !== 'Cowork') continue;
    for (const file of await walk(root, n => n.startsWith('local_') && n.endsWith('.json'))) {
      try {
        coworkSessions.push(parseCoworkSession(JSON.parse(await readFile(file, 'utf8'))));
      } catch { /* a malformed session file must not sink the collector */ }
    }
  }
  return { transcripts, coworkSessions };
}
```

`server/collectors/crons.mjs`:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLaunchctlList, buildCron } from '../lib/parse-launchd.mjs';

const exec = promisify(execFile);
const AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const SKIP = /^com\.(apple|google|openai)\./;

const runLaunchctl = async () => (await exec('launchctl', ['list'], { timeout: 30000 })).stdout;

async function readPlist(path) {
  const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', path], { timeout: 15000 });
  return JSON.parse(stdout);
}

export async function collectCrons({
  listAgents = () => readdir(AGENTS_DIR),
  plistReader = readPlist,
  launchctl = runLaunchctl,
  now = () => Date.now()
} = {}) {
  const statuses = parseLaunchctlList(await launchctl());
  const files = (await listAgents()).filter(f => f.endsWith('.plist'));
  const at = now();
  const crons = [];

  for (const file of files) {
    const label = file.replace(/\.plist$/, '');
    if (SKIP.test(label)) continue;
    let plist;
    try { plist = await plistReader(join(AGENTS_DIR, file)); } catch { continue; }
    if (!plist.StartCalendarInterval && !plist.StartInterval) continue;
    crons.push(buildCron({ label, plist, statusRow: statuses.get(label) ?? null }, at));
  }

  return crons.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    return (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
  });
}
```

- [ ] **Step 5: Implement config, alerts and todos**

`server/lib/config.mjs`:

```js
import { readFile } from 'node:fs/promises';

const DEFAULTS = { warnThreshold: 85, showAlertBanner: true, plan: null, credits: null };

export async function loadConfig(path) {
  try {
    return { ...DEFAULTS, ...JSON.parse(await readFile(path, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
```

`server/lib/alerts.mjs`:

```js
const DAY = 24 * 3600 * 1000;

export function buildAlerts(snapshot, config, now = Date.now()) {
  const alerts = [];
  const threshold = config.warnThreshold ?? 85;

  for (const cron of snapshot.crons?.data ?? []) {
    if (cron.ok === false) alerts.push({ text: `${cron.name} cron ${cron.last ?? 'failed'}` });
  }

  for (const limit of snapshot.usage?.data?.limits ?? []) {
    if (limit.pct >= threshold) alerts.push({ text: `${limit.label} at ${limit.pct}%` });
  }

  const credits = config.credits;
  if (credits?.promoExpiresOn) {
    const expires = Date.parse(credits.promoExpiresOn);
    if (Number.isFinite(expires) && expires - now < 30 * DAY) {
      const days = Math.max(0, Math.round((expires - now) / DAY));
      alerts.push({ text: `Promotional credit expires in ${days} days` });
    }
  }
  if (credits?.updatedAt) {
    const updated = Date.parse(credits.updatedAt);
    if (Number.isFinite(updated) && now - updated > 14 * DAY) {
      alerts.push({ text: 'Credits figures are over 14 days old' });
    }
  }
  return alerts;
}
```

`server/todos.mjs`:

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LANES = new Set(['idea', 'doing', 'done']);
const SEED = [
  { id: 1, text: 'Route bulk transcript cleanup to Haiku — Sonnet is overkill', lane: 'idea', tag: 'Usage' },
  { id: 2, text: 'Cron: weekly digest of all Cowork project status', lane: 'idea', tag: 'Crons' },
  { id: 3, text: 'Rewrite the nightly-sync cron so it retries on 429', lane: 'doing', tag: 'Crons' }
];

export function createTodoStore(path) {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through to seed */ }
      await this.write(SEED);
      return SEED;
    },
    async write(todos) {
      if (!Array.isArray(todos)) throw new Error('todos must be an array');
      for (const t of todos) {
        if (!LANES.has(t.lane)) throw new Error(`unknown lane: ${t.lane}`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(todos, null, 2));
      return todos;
    }
  };
}
```

- [ ] **Step 6: Implement `server/routes.mjs`**

```js
import { buildAlerts } from './lib/alerts.mjs';

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); }
    catch (err) { reject(err); }
  });
  req.on('error', reject);
});

const PANELS = ['usage', 'sessions', 'agents', 'crons', 'ingestCrons', 'ingestProjects', 'ingestCredits'];

export function createHandler({ cache, todos, config }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/dashboard') {
      const now = Date.now();
      const payload = {};
      for (const key of PANELS) payload[key] = cache.get(key, now);
      payload.config = { data: config, fetchedAt: now, status: 'ok', error: null };
      payload.alerts = config.showAlertBanner ? buildAlerts(payload, config, now) : [];
      payload.serverTime = now;
      return json(res, 200, payload);
    }

    if (path === '/api/todos') {
      if (req.method === 'GET') return json(res, 200, await todos.read());
      if (req.method === 'PUT') {
        try {
          return json(res, 200, await todos.write(await readBody(req)));
        } catch (err) {
          return json(res, 400, { error: String(err.message) });
        }
      }
    }

    const ingest = path.match(/^\/api\/ingest\/(crons|projects|credits)$/);
    if (ingest && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const key = 'ingest' + ingest[1][0].toUpperCase() + ingest[1].slice(1);
        cache.set(key, body);
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    return json(res, 404, { error: 'not found' });
  };
}
```

- [ ] **Step 7: Implement `server/server.mjs`**

```js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCache } from './cache.mjs';
import { createRegistry } from './collectors/registry.mjs';
import { collectUsage } from './collectors/usage.mjs';
import { collectAgents } from './collectors/agents.mjs';
import { collectSessions } from './collectors/sessions.mjs';
import { collectCrons } from './collectors/crons.mjs';
import { createTodoStore } from './todos.mjs';
import { loadConfig } from './lib/config.mjs';
import { createHandler } from './routes.mjs';
import { aggregate } from './lib/aggregate.mjs';
import { buildProjects } from './lib/projects.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8322);
const WEB_DIR = join(HERE, '..', 'web', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const config = await loadConfig(join(HERE, 'config.json'));
const cache = createCache();
const todos = createTodoStore(join(HERE, 'todos.json'));
const registry = createRegistry(cache);

registry.register('usage', () => collectUsage(), 5 * 60 * 1000);
registry.register('agents', () => collectAgents(), 30 * 1000);
registry.register('crons', () => collectCrons(), 60 * 1000);
registry.register('sessions', async () => {
  const { transcripts, coworkSessions } = await collectSessions();
  const now = Date.now();
  return {
    ...aggregate(transcripts, now),
    projects: buildProjects({
      agents: cache.get('agents', now).data ?? [],
      coworkSessions,
      transcripts
    }, now)
  };
}, 60 * 1000);

const api = createHandler({ cache, todos, config });

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  try {
    const rel = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
    const body = await readFile(join(WEB_DIR, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(await readFile(join(WEB_DIR, 'index.html')));
    } catch {
      res.writeHead(404); res.end('not built');
    }
  }
}).listen(PORT, '127.0.0.1', () => {
  registry.startAll();
  console.log(`control room on http://127.0.0.1:${PORT}`);
});
```

- [ ] **Step 8: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — every test across all files

- [ ] **Step 9: Smoke-test against real data**

```bash
cd server && cp config.example.json config.json && node server.mjs &
sleep 90
curl -s http://127.0.0.1:8322/api/dashboard | python3 -m json.tool | head -40
kill %1
```

Expected: `usage.status` is `ok` with real percentages; `crons.data` lists your launchd jobs. If `usage` reports `unavailable`, read `usage.error` before proceeding — do not continue to the UI on a broken data layer.

- [ ] **Step 10: Commit**

```bash
git add server/
git commit -m "feat: wire collectors, config, todos and the HTTP API"
```

---

### Task 9: Web scaffold, design tokens and page shell

**Files:**
- Create: `web/package.json`, `web/vite.config.js`, `web/index.html`, `web/src/main.jsx`, `web/src/App.jsx`, `web/src/styles/tokens.css`, `web/src/styles/app.css`, `web/src/hooks/useDashboard.js`, `web/src/hooks/useTick.js`, `web/src/lib/format.js`, `web/src/components/Header.jsx`, `web/src/components/AlertBar.jsx`, `web/src/components/StatusNote.jsx`

**Interfaces:**
- Consumes: `GET /api/dashboard` from Task 8
- Produces:
  - `useDashboard() -> { payload, error }` — polls every 30s
  - `useTick(ms) -> number` — one shared interval, cleared on unmount
  - `formatCountdown`, `heat` (client mirrors of Task 1)
  - `<StatusNote status error fetchedAt />` — the shared stale/unavailable marker

- [ ] **Step 1: Scaffold and install**

```bash
cd /Users/jeff/Projects/claude-control-room
npm create vite@latest web -- --template react
cd web && npm install
```

- [ ] **Step 2: Self-host Archivo**

Download the Archivo variable font and place `web/src/fonts/Archivo.woff2`. The spec forbids the Google Fonts CDN in production:

```bash
mkdir -p web/src/fonts
curl -sL "https://github.com/googlefonts/archivo/raw/main/fonts/variable/Archivo%5Bwdth,wght%5D.woff2" \
  -o web/src/fonts/Archivo.woff2
ls -la web/src/fonts/Archivo.woff2
```

Expected: a non-empty `.woff2`. If the URL 404s, download Archivo from https://fonts.google.com/specimen/Archivo and place the `.woff2` at that path — do **not** fall back to the CDN.

- [ ] **Step 3: Write `web/src/styles/tokens.css`**

```css
@font-face {
  font-family: 'Archivo';
  src: url('../fonts/Archivo.woff2') format('woff2');
  font-weight: 400 800;
  font-display: swap;
}

:root {
  --ground: #f3f2f2;
  --surface: #eae9e9;
  --ink: #201e1d;
  --accent: #ec3013;

  --n100: #f8f4f4; --n200: #eae7e7; --n300: #d7d3d3; --n400: #bab6b6;
  --n500: #9b9797; --n600: #7d7979; --n700: #605d5d; --n800: #444141; --n900: #2d2b2b;

  --a100: #fff2ef; --a200: #ffe0d9; --a300: #ffc4b8;
  --a500: #ff563c; --a600: #dd2b0f; --a700: #ae1800; --a800: #7c1405;

  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --rule-strong: 2px solid var(--ink);
  --rule-fine: 1px solid var(--n300);
  --rule-hair: 1px solid var(--n200);
}

* { box-sizing: border-box; border-radius: 0; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: 'Archivo', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

::selection { background: var(--a300); }
*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.num { font-variant-numeric: tabular-nums; }
.eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--n600);
}
.section-label {
  font-size: 10px; font-weight: 600; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--n600);
}
```

- [ ] **Step 4: Write `web/src/hooks/useDashboard.js`**

```js
import { useEffect, useState } from 'react';

export function useDashboard(intervalMs = 30000) {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setPayload(data); setError(null); }
      } catch (err) {
        // Keep the last payload: a failed poll makes panels stale, never blank.
        if (!cancelled) setError(String(err.message));
      }
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return { payload, error };
}
```

- [ ] **Step 5: Write `web/src/hooks/useTick.js`**

```js
import { useEffect, useState } from 'react';

export function useTick(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
```

- [ ] **Step 6: Write `web/src/lib/format.js`**

```js
export const INK = '#201e1d', ACCENT = '#ec3013', MID = '#605d5d';

export function heat(pct, threshold = 85) {
  if (pct >= threshold) return ACCENT;
  if (pct >= threshold * 0.7) return MID;
  return INK;
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function formatTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
```

- [ ] **Step 7: Write `web/src/components/StatusNote.jsx`**

```jsx
export function StatusNote({ status, error, fetchedAt }) {
  if (status === 'ok') return null;
  const label = status === 'unavailable' ? 'No data source' : 'Stale';
  const detail = status === 'unavailable'
    ? (error ?? 'nothing has reported yet')
    : `last read ${fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown'}`;
  return (
    <div style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: status === 'unavailable' ? 'var(--n500)' : 'var(--accent)',
      padding: '4px 0'
    }}>
      {label} · <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>{detail}</span>
    </div>
  );
}
```

- [ ] **Step 8: Write `web/src/components/Header.jsx`**

```jsx
import { formatCountdown } from '../lib/format.js';

export function Header({ usage, now }) {
  const session = usage?.data?.limits?.find(l => l.label === 'Current session');
  const resetsAt = session?.resetsAt ? Date.parse(session.resetsAt) : null;
  return (
    <header className="ccr-header">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="eyebrow">Anthropic account snapshot</div>
        <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
          Control Room
        </h1>
      </div>
      <div className="ccr-header-stats">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="section-label">Session resets in</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>
            {resetsAt ? formatCountdown(resetsAt - now) : '—'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="section-label">Synced</div>
          <div className="num" style={{ fontSize: 22, fontWeight: 800 }}>
            {usage?.fetchedAt
              ? new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '—'}
          </div>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 9: Write `web/src/components/AlertBar.jsx`**

```jsx
export function AlertBar({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '10px 32px', background: 'var(--accent)', color: 'var(--a100)',
      borderBottom: 'var(--rule-strong)'
    }}>
      <span style={{
        fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
        fontWeight: 800, padding: '3px 8px', background: 'var(--ink)'
      }}>Attention</span>
      {alerts.map((a, i) => (
        <span key={i} style={{ fontSize: 13, fontWeight: 600 }}>{a.text}</span>
      ))}
    </div>
  );
}
```

- [ ] **Step 10: Write `web/src/styles/app.css` (shell + all three breakpoints)**

```css
.ccr-header {
  display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s5);
  padding: var(--s5) var(--s6) var(--s4) var(--s6);
  border-bottom: var(--rule-strong);
}
.ccr-header-stats { display: flex; align-items: flex-end; gap: var(--s6); }

.ccr-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; align-items: stretch; }
.ccr-col { padding: 20px var(--s5) var(--s6) var(--s5); display: flex; flex-direction: column; gap: 20px; }
.ccr-col--ruled { border-right: var(--rule-strong); }

.ccr-col-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3);
  border-bottom: var(--rule-strong); padding-bottom: var(--s2);
}
.ccr-col-head h2 {
  margin: 0; font-size: 15px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
}
.ccr-col-head span { font-size: 11px; font-weight: 700; color: var(--n600); }

/* iPad portrait and below: one column, rules dropped. */
@media (max-width: 1024px) {
  .ccr-grid { grid-template-columns: 1fr; }
  .ccr-col--ruled { border-right: 0; border-bottom: var(--rule-strong); }
}

/* Phone: tighten padding and type, stats sit under the title. */
@media (max-width: 600px) {
  .ccr-header { flex-direction: column; align-items: flex-start; gap: var(--s3); padding: var(--s4); }
  .ccr-header h1 { font-size: 26px; }
  .ccr-header-stats { gap: var(--s5); }
  .ccr-col { padding: var(--s4); }
}
```

- [ ] **Step 11: Write `web/src/App.jsx` (shell only for now)**

```jsx
import './styles/tokens.css';
import './styles/app.css';
import { useDashboard } from './hooks/useDashboard.js';
import { useTick } from './hooks/useTick.js';
import { Header } from './components/Header.jsx';
import { AlertBar } from './components/AlertBar.jsx';

export default function App() {
  const { payload } = useDashboard();
  const now = useTick(1000);

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 64 }}>
      <Header usage={payload?.usage} now={now} />
      <AlertBar alerts={payload?.alerts} />
      <div className="ccr-grid">
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head"><h2>01&nbsp;&nbsp;Usage</h2><span /></div>
        </section>
        <section className="ccr-col ccr-col--ruled">
          <div className="ccr-col-head"><h2>02&nbsp;&nbsp;Projects</h2><span /></div>
        </section>
        <section className="ccr-col">
          <div className="ccr-col-head"><h2>03&nbsp;&nbsp;Ideas &amp; to-dos</h2><span>Saved on this device</span></div>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: Add the dev proxy to `web/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8322' } }
});
```

- [ ] **Step 13: Verify the shell renders against the live server**

```bash
cd server && node server.mjs &
cd ../web && npm run dev
```

Open http://localhost:5173. Expected: header with a live countdown ticking once a second, the three-column grid with 2px rules, and the alert bar if anything is failing. Narrow the window past 1024px and 600px and confirm the collapse. Then `kill %1`.

- [ ] **Step 14: Commit**

```bash
git add web/ && git commit -m "feat: add web shell, design tokens and responsive breakpoints"
```

---

### Task 10: Column 01 — usage panels

**Files:**
- Create: `web/src/components/Panel.jsx`, `web/src/components/PlanBlock.jsx`, `web/src/components/CreditsPanel.jsx`, `web/src/components/LimitBars.jsx`, `web/src/components/StackedBar.jsx`, `web/src/components/ModelRows.jsx`, `web/src/components/SessionRows.jsx`
- Modify: `web/src/App.jsx`

**Interfaces:**
- Consumes: `payload.usage`, `payload.sessions`, `payload.config` from Task 8; `heat`, `formatTokens` from Task 9
- Produces: `<Panel label>{children}</Panel>` — the shared 10px section-label wrapper used by every panel in columns 01 and 02

- [ ] **Step 1: Write `web/src/components/Panel.jsx`**

```jsx
import { StatusNote } from './StatusNote.jsx';

export function Panel({ label, envelope, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="section-label">{label}</div>
      {envelope && <StatusNote {...envelope} />}
      {envelope?.status !== 'unavailable' && children}
    </div>
  );
}
```

- [ ] **Step 2: Write `web/src/components/LimitBars.jsx`**

```jsx
import { heat, formatCountdown } from '../lib/format.js';

export function LimitBars({ limits, threshold, now }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {limits.map(l => {
        const color = heat(l.pct, threshold);
        const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : null;
        return (
          <div key={l.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{l.label}</span>
              <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>{l.pct}%</span>
            </div>
            <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, l.pct)}%`, background: color }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>
              {resetsAt ? `resets ${formatCountdown(resetsAt - now)}` : 'no reset time reported'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Write `web/src/components/StackedBar.jsx`**

Handles the unmeasurable Chat segment explicitly — hatched, labeled, never a fake value.

```jsx
const PALETTE = ['var(--ink)', 'var(--accent)', 'var(--n300)', 'var(--n500)'];
const FG = ['var(--ground)', 'var(--a100)', 'var(--ink)', 'var(--ground)'];

export function StackedBar({ segments, unit = 'tokens' }) {
  const measurable = segments.filter(s => s.measurable !== false);
  const unmeasurable = segments.filter(s => s.measurable === false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', height: 26, border: '1px solid var(--ink)' }}>
        {measurable.map((s, i) => (
          <div key={s.name} style={{
            flex: Math.max(s.pct, 1), background: PALETTE[i % PALETTE.length],
            display: 'flex', alignItems: 'center', paddingLeft: 6, overflow: 'hidden'
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: FG[i % FG.length], letterSpacing: '0.04em' }}>
              {s.pct}%
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {measurable.map((s, i) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, background: PALETTE[i % PALETTE.length], border: '1px solid var(--ink)' }} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>{s.name}</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--n600)' }}>{s.display ?? ''}</span>
          </div>
        ))}
        {unmeasurable.map(s => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 9, height: 9, border: '1px solid var(--n400)',
              background: 'repeating-linear-gradient(45deg, var(--n300) 0 2px, transparent 2px 4px)'
            }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--n500)' }}>{s.name}</span>
            <span style={{ fontSize: 11, color: 'var(--n500)' }}>not measurable locally</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `web/src/components/PlanBlock.jsx`**

```jsx
export function PlanBlock({ plan }) {
  if (!plan) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>{plan.name}</div>
        <div style={{ fontSize: 12, color: 'var(--n700)', fontWeight: 600 }}>{plan.price}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: 'var(--rule-fine)' }}>
        <div style={{ padding: '8px 12px 8px 0', borderRight: 'var(--rule-fine)' }}>
          <div className="section-label">Renews</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{plan.renews}</div>
        </div>
        <div style={{ padding: '8px 0 8px 12px' }}>
          <div className="section-label">Seats · Extra</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{plan.seats}</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write `web/src/components/CreditsPanel.jsx`**

```jsx
import { heat } from '../lib/format.js';

const DAY = 86400000;
const money = n => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);

export function CreditsPanel({ credits, threshold, now }) {
  if (!credits) return null;
  const pct = credits.monthlyLimit > 0 ? Math.round((credits.spent / credits.monthlyLimit) * 100) : 0;
  const color = heat(pct, threshold);
  const updated = credits.updatedAt ? Date.parse(credits.updatedAt) : null;
  const ageDays = updated ? Math.floor((now - updated) / DAY) : null;
  const aged = ageDays !== null && ageDays > 7;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>{money(credits.balance)}</div>
        <div style={{ fontSize: 12, color: 'var(--n700)', fontWeight: 600 }}>balance</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {money(credits.spent)} of {money(credits.monthlyLimit)}
        </span>
        <span className="num" style={{ fontSize: 12, fontWeight: 700, color }}>{pct}%</span>
      </div>
      <div style={{ height: 10, background: 'var(--n300)', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${Math.min(100, pct)}%`, background: color }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: 'var(--rule-fine)' }}>
        <div style={{ padding: '8px 12px 8px 0', borderRight: 'var(--rule-fine)' }}>
          <div className="section-label">Resets</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{credits.resetsOn ?? '—'}</div>
        </div>
        <div style={{ padding: '8px 0 8px 12px' }}>
          <div className="section-label">Promo expires</div>
          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{credits.promoExpiresOn ?? '—'}</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: aged ? 'var(--accent)' : 'var(--n600)', fontWeight: aged ? 700 : 500 }}>
        {ageDays === null ? 'never updated' : `updated ${ageDays} day${ageDays === 1 ? '' : 's'} ago`}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write `web/src/components/ModelRows.jsx`**

```jsx
import { formatTokens } from '../lib/format.js';

export function ModelRows({ models }) {
  const max = Math.max(1, ...models.map(m => m.pct));
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {models.map(m => (
        <div key={m.name} style={{
          display: 'grid', gridTemplateColumns: '70px 1fr 52px', alignItems: 'center',
          gap: 10, padding: '5px 0', borderBottom: 'var(--rule-hair)'
        }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{m.name}</span>
          <span style={{ height: 6, background: 'var(--n300)', position: 'relative', display: 'block' }}>
            <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${(m.pct / max) * 100}%`, background: 'var(--ink)', display: 'block' }} />
          </span>
          <span className="num" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', color: 'var(--n700)' }}>
            {formatTokens(m.tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Write `web/src/components/SessionRows.jsx`**

```jsx
import { heat } from '../lib/format.js';

export function SessionRows({ sessions, threshold }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sessions.map((s, i) => {
        const color = heat(s.pct, threshold);
        return (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '48px 1fr auto', alignItems: 'center',
            gap: 10, padding: '7px 0', borderBottom: 'var(--rule-hair)'
          }}>
            <span className="num" style={{ fontSize: 11, fontWeight: 600, color: 'var(--n600)' }}>{s.when}</span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{s.title}</span>
              <span style={{ fontSize: 10, color: 'var(--n600)' }}>{s.surface} · {s.model}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 56, height: 6, background: 'var(--n300)', position: 'relative', display: 'block' }}>
                <span style={{ position: 'absolute', inset: '0 auto 0 0', width: `${s.pct}%`, background: color, display: 'block' }} />
              </span>
              <span className="num" style={{ fontSize: 11, fontWeight: 800, width: 32, textAlign: 'right' }}>{s.pct}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 8: Wire column 01 into `App.jsx`**

Replace the column-01 `<section>` with:

```jsx
<section className="ccr-col ccr-col--ruled">
  <div className="ccr-col-head">
    <h2>01&nbsp;&nbsp;Usage</h2>
    <span>{config?.plan?.renews ? `Renews ${config.plan.renews}` : ''}</span>
  </div>
  <PlanBlock plan={config?.plan} />
  <Panel label="Credits">
    <CreditsPanel credits={config?.credits} threshold={threshold} now={now} />
  </Panel>
  <Panel label="Against limits now" envelope={payload?.usage}>
    <LimitBars limits={payload?.usage?.data?.limits ?? []} threshold={threshold} now={now} />
  </Panel>
  <Panel label="By surface · this week" envelope={payload?.sessions}>
    <StackedBar segments={(payload?.sessions?.data?.bySurface ?? []).map(s => ({
      ...s, display: s.measurable ? formatTokens(s.tokens) : null
    }))} />
  </Panel>
  <Panel label="By project · this week" envelope={payload?.sessions}>
    <StackedBar segments={(payload?.sessions?.data?.byProject ?? []).map(p => ({
      ...p, display: formatTokens(p.tokens)
    }))} />
  </Panel>
  <Panel label="By model · this week" envelope={payload?.sessions}>
    <ModelRows models={payload?.sessions?.data?.byModel ?? []} />
  </Panel>
  <Panel label="Recent sessions" envelope={payload?.sessions}>
    <SessionRows sessions={payload?.sessions?.data?.recentSessions ?? []} threshold={threshold} />
  </Panel>
</section>
```

Add near the top of the component body:

```jsx
const config = payload?.config?.data;
const threshold = config?.warnThreshold ?? 85;
```

Add the imports for `Panel`, `PlanBlock`, `CreditsPanel`, `LimitBars`, `StackedBar`, `ModelRows`, `SessionRows` and `formatTokens`.

- [ ] **Step 9: Verify against real data**

```bash
cd server && node server.mjs & cd ../web && npm run dev
```

Check: your real limit percentages appear; the Chat legend entry reads "not measurable locally" with a hatched swatch; credits show your config values with an age line; no `border-radius` anywhere.

- [ ] **Step 10: Commit**

```bash
git add web/src && git commit -m "feat: build column 01 usage panels"
```

---

### Task 11: Column 02 — projects and crons

**Files:**
- Create: `web/src/components/ProjectRows.jsx`, `web/src/components/CronRows.jsx`
- Modify: `web/src/App.jsx`

**Interfaces:**
- Consumes: `payload.sessions.data.projects`, `payload.crons`, `payload.ingestCrons`
- Produces: nothing consumed downstream

- [ ] **Step 1: Write `web/src/components/ProjectRows.jsx`**

```jsx
export function ProjectRows({ projects }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {projects.map(p => {
        const dot = p.running ? 'var(--accent)' : 'var(--n400)';
        const isCode = p.tool === 'Code';
        return (
          <div key={`${p.tool}-${p.name}`} style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center',
            gap: 12, padding: '11px 0', borderBottom: 'var(--rule-fine)'
          }}>
            <span style={{ width: 10, height: 10, display: 'block', background: dot, border: '1px solid var(--ink)' }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>{p.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: '2px 6px',
                  background: isCode ? 'var(--ink)' : 'var(--n300)',
                  color: isCode ? 'var(--ground)' : 'var(--ink)'
                }}>{p.tool}</span>
                <span style={{ fontSize: 11, color: 'var(--n600)', fontWeight: 500 }}>{p.detail}</span>
              </span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              <span style={{
                fontSize: 11, fontWeight: 800, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: dot
              }}>{p.running ? 'Running' : 'Idle'}</span>
              {p.tasks && <span className="num" style={{ fontSize: 11, color: 'var(--n600)' }}>{p.tasks}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Write `web/src/components/CronRows.jsx`**

```jsx
export function CronRows({ crons, now }) {
  const short = ms => {
    if (ms === null || ms === undefined) return '—';
    const total = Math.max(0, ms);
    const d = Math.floor(total / 86400000);
    const h = Math.floor((total % 86400000) / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {crons.map(c => {
        const edge = c.ok ? 'var(--ink)' : 'var(--accent)';
        return (
          <div key={c.label ?? c.name} style={{
            display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 12,
            padding: '11px 10px 11px 12px', borderBottom: 'var(--rule-fine)',
            background: c.ok ? 'transparent' : 'var(--a100)', borderLeft: `3px solid ${edge}`
          }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</span>
              <span style={{ fontSize: 11, color: 'var(--n700)', fontWeight: 500 }}>{c.schedule}</span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              <span className="num" style={{ fontSize: 13, fontWeight: 800 }}>
                {c.nextRunAt ? short(c.nextRunAt - now) : '—'}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: edge
              }}>{c.last}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Wire column 02 into `App.jsx`**

```jsx
<section className="ccr-col ccr-col--ruled">
  <div className="ccr-col-head">
    <h2>02&nbsp;&nbsp;Projects</h2>
    <span>{projects.filter(p => p.running).length} running · {projects.length} total</span>
  </div>
  <ProjectRows projects={projects} />
  <div className="ccr-col-head" style={{ marginTop: 4 }}>
    <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
      Scheduled crons
    </h3>
    <span>{crons.filter(c => !c.ok).length} failing · {crons.length} scheduled</span>
  </div>
  <StatusNote {...(payload?.crons ?? { status: 'unavailable' })} />
  <CronRows crons={crons} now={now} />
</section>
```

With, near the top of the component body:

```jsx
const projects = payload?.sessions?.data?.projects ?? [];
const crons = [
  ...(payload?.crons?.data ?? []),
  ...(payload?.ingestCrons?.data ?? [])
].sort((a, b) => (a.ok === b.ok ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) : a.ok ? 1 : -1));
```

- [ ] **Step 4: Verify against real data**

Reload the dev server. Expected: your actual projects with correct running/idle dots (start a `claude` session in another directory and confirm it turns red within 30s), and your launchd jobs sorted failures-first.

- [ ] **Step 5: Commit**

```bash
git add web/src && git commit -m "feat: build column 02 projects and crons"
```

---

### Task 12: Column 03 — ideas and to-dos

**Files:**
- Create: `web/src/components/Lanes.jsx`
- Modify: `web/src/App.jsx`

**Interfaces:**
- Consumes: `GET|PUT /api/todos` from Task 8
- Produces: nothing consumed downstream

- [ ] **Step 1: Write `web/src/components/Lanes.jsx`**

```jsx
import { useEffect, useState } from 'react';

const LANES = [
  { key: 'idea', title: 'Idea', placeholder: '+ new idea', mark: ' ', next: 'doing', edge: 'var(--n400)', box: 'transparent' },
  { key: 'doing', title: 'Doing', placeholder: '+ start something', mark: '›', next: 'done', edge: 'var(--ink)', box: 'var(--n500)' },
  { key: 'done', title: 'Done', placeholder: '+ log something done', mark: '✓', next: 'idea', edge: 'var(--n300)', box: 'var(--ink)' }
];

export function Lanes() {
  const [todos, setTodos] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/todos').then(r => r.json()).then(setTodos).catch(e => setError(String(e.message)));
  }, []);

  const save = async next => {
    const previous = todos;
    setTodos(next); // optimistic
    try {
      const res = await fetch('/api/todos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setError(null);
    } catch (e) {
      setTodos(previous); // a failed save must not look like a success
      setError('could not save');
    }
  };

  const add = (lane, text) => save([...todos, { id: Date.now(), text, lane, tag: 'Note' }]);
  const advance = (id, next) => save(todos.map(t => (t.id === id ? { ...t, lane: next } : t)));
  const remove = id => save(todos.filter(t => t.id !== id));

  return (
    <>
      {error && <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{error}</div>}
      {LANES.map(lane => {
        const items = todos.filter(t => t.lane === lane.key);
        return (
          <div key={lane.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 8, borderBottom: '1px solid var(--ink)', paddingBottom: 5
            }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                {lane.title}
              </span>
              <span className="num" style={{ fontSize: 11, fontWeight: 700, color: 'var(--n600)' }}>{items.length}</span>
            </div>
            {items.map(t => (
              <div key={t.id} style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'start',
                gap: 10, padding: '9px 10px', background: 'var(--surface)',
                borderLeft: `3px solid ${lane.edge}`
              }}>
                <button
                  onClick={() => advance(t.id, lane.next)}
                  title={`Move to ${lane.next}`}
                  style={{
                    fontFamily: 'inherit', cursor: 'pointer', width: 16, height: 16, marginTop: 1,
                    padding: 0, background: lane.box, border: '1.5px solid var(--ink)',
                    color: 'var(--ground)', fontSize: 10, fontWeight: 800, lineHeight: 1
                  }}
                >{lane.mark}</button>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{
                    fontSize: 13, fontWeight: 600, lineHeight: 1.35, textWrap: 'pretty',
                    color: lane.key === 'done' ? 'var(--n500)' : 'var(--ink)',
                    textDecoration: lane.key === 'done' ? 'line-through' : 'none'
                  }}>{t.text}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: 'var(--n600)'
                  }}>{t.tag ?? 'Note'}</span>
                </span>
                <button
                  onClick={() => remove(t.id)}
                  title="Delete"
                  style={{
                    fontFamily: 'inherit', cursor: 'pointer', background: 'transparent',
                    border: 0, padding: '0 2px', fontSize: 14, lineHeight: 1, color: 'var(--n500)'
                  }}
                >×</button>
              </div>
            ))}
            <input
              type="text"
              placeholder={lane.placeholder}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const v = e.target.value.trim();
                if (!v) return;
                add(lane.key, v);
                e.target.value = '';
              }}
              style={{
                fontFamily: 'inherit', fontSize: 12, fontWeight: 500, padding: '8px 10px',
                border: 'var(--rule-fine)', background: 'transparent', color: 'var(--ink)',
                width: '100%'
              }}
            />
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 2: Wire column 03 into `App.jsx`**

```jsx
<section className="ccr-col">
  <div className="ccr-col-head">
    <h2>03&nbsp;&nbsp;Ideas &amp; to-dos</h2>
    <span>Saved on the mini</span>
  </div>
  <Lanes />
</section>
```

Note the header note changed from the prototype's "Saved on this device" — storage is now server-side and shared, so the old copy would be wrong.

- [ ] **Step 3: Verify persistence across devices**

Add an item in the browser, then confirm it survives a reload and appears from another device on the LAN:

```bash
curl -s http://127.0.0.1:8322/api/todos | python3 -m json.tool
```

Expected: the new item is present in `server/todos.json`.

- [ ] **Step 4: Commit**

```bash
git add web/src && git commit -m "feat: build column 03 with server-backed to-dos"
```

---

### Task 13: Deployment, tunnel and README

**Files:**
- Create: `deploy/net.milleradvisorypartners.control-room.plist`, `README.md`
- Modify: `server/package.json` (add a `build` script)

**Interfaces:**
- Consumes: everything
- Produces: a running service

- [ ] **Step 1: Build the web app and confirm the server serves it**

```bash
cd web && npm run build
cd ../server && node server.mjs &
sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8322/
kill %1
```

Expected: `200`

- [ ] **Step 2: Write `deploy/net.milleradvisorypartners.control-room.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.milleradvisorypartners.control-room</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/jeff/Projects/claude-control-room/server/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/jeff/Projects/claude-control-room/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/jeff</string>
    <key>PATH</key><string>/Users/jeff/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/jeff/Library/Logs/control-room.log</string>
  <key>StandardErrorPath</key><string>/Users/jeff/Library/Logs/control-room.log</string>
</dict>
</plist>
```

`PATH` must include `/Users/jeff/.local/bin` — that is where the `claude` binary lives, and the usage and agents collectors shell out to it.

- [ ] **Step 3: Install and verify the service**

```bash
cp deploy/net.milleradvisorypartners.control-room.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/net.milleradvisorypartners.control-room.plist
sleep 90
launchctl list | grep control-room
curl -s http://127.0.0.1:8322/api/dashboard | python3 -c "import json,sys; d=json.load(sys.stdin); print({k: v.get('status') for k,v in d.items() if isinstance(v, dict)})"
```

Expected: exit status `0`, and `usage`, `crons`, `agents`, `sessions` all reporting `ok`. If any report `unavailable`, check `~/Library/Logs/control-room.log` — the usual cause is `claude` not being on the service's `PATH`.

- [ ] **Step 4: Add the tunnel route**

Add a hostname to the existing cloudflared config (do not create a second tunnel), pointing at `http://127.0.0.1:8322`, then restart cloudflared:

```bash
launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared.mini
```

Then, **in the Cloudflare dashboard**, add an Access policy for that hostname before testing from outside. Verify from a device off the LAN that the hostname prompts for Access authentication and only then renders the dashboard.

**Do not skip the Access policy.** Without it the hostname is public, and this dashboard exposes account usage, project names and spend figures.

- [ ] **Step 5: Write `README.md`**

Cover, in this order: what the dashboard is and a screenshot; the data-source table from spec §4 marking which numbers are real, which are hand-entered, and that Chat is unmeasurable; why it shells out to the `claude` CLI (no consumer-subscription API exists — so nobody "fixes" this into an API call later); running it (prereqs, `npm test`, `npm run build`, the plist, the tunnel and Access); configuration (every `config.json` field, pointing at `config.example.json` since the real file is gitignored); the fragility warning (undocumented file layouts and CLI output that can change in any release, with spec §2 as the re-verification procedure); and what someone else would need to change to adapt it, without claiming that path is supported.

- [ ] **Step 6: Final verification**

```bash
cd server && npm test
# tokens.css intentionally carries `border-radius: 0` as the global reset;
# any OTHER border-radius is a defect.
grep -rn "border-radius" web/src/ | grep -v "border-radius: 0" || echo "no stray radius — correct"
grep -rn "fonts.googleapis" web/ --include="*.html" --include="*.jsx" --include="*.css" || echo "no CDN font — correct"
```

Expected: all tests pass; both greps report the "correct" message.

- [ ] **Step 7: Commit**

```bash
git add deploy/ README.md server/package.json
git commit -m "feat: add launchd service, tunnel setup and README"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 Architecture, collectors, endpoints | 7, 8 |
| §4 Every panel in the mapping table | 10, 11, 12 |
| §4 Credits panel | 8 (config), 10 (UI) |
| §5 Degradation, ok/stale/unavailable | 7 (cache), 9 (StatusNote), used throughout |
| §5 Defensive `/usage` parsing | 2 |
| §6 Alerts, all four rules | 8 |
| §7 Tokens, radius 0, focus ring, tabular nums | 9 |
| §7 Three breakpoints | 9 |
| §8 Settings (`warnThreshold`, `showAlertBanner`) | 8 |
| §9 launchd, tunnel, Access, localhost binding | 13 |
| §10 Testing, both roots, boundaries, degradation | 1–8 |
| §11 README | 13 |

**Known gaps, deliberate:** project open-task counts (`tasks`) have no verified source, so `buildProjects` returns `null` and the UI omits the line rather than inventing a number. The ingest endpoints exist for Claude Cloud routines but nothing populates them until a cloud routine is written to POST in — the panel merges whatever arrives.

**Type consistency:** `heat(pct, threshold)` matches between `server/lib/heat.mjs` and `web/src/lib/format.js`. `formatCountdown` is duplicated deliberately across the boundary (the server has no bundler and the client has no filesystem access); both are tested in Task 1 and behave identically. Cache envelopes are `{ data, fetchedAt, status, error }` everywhere. `bySurface` entries carry `measurable` in Task 4 and are read in Task 10.
