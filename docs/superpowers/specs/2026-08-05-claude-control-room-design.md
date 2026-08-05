# Claude Control Room — design

**Date:** 2026-08-05
**Status:** approved, pending implementation plan

A single-screen operational dashboard showing one person's Claude account: spend against
limits, running projects and scheduled crons, and a personal backlog. Read at a glance from a
desk browser and an iPad. Runs on the always-on Mac mini.

Design source: `design_handoff_claude_control_room/` in this repo — treat `README.md` there as
the visual spec and `Claude Control Room.dc.html` as the structural reference.

---

## 1. Decisions taken

| Question | Decision |
|---|---|
| Scope | UI plus whatever real data exists; anything unavailable is labeled, never faked |
| Stack | React + Vite SPA, thin Node server, both on the Mac mini |
| Account type | Claude Max subscription only — no Console org, no Admin API |
| Limit bars | Real, from `claude -p "/usage"` polled on a timer |
| To-do storage | Server-side JSON so the list is shared between iPad and desk |
| Cron sources | launchd, plus a generic ingest endpoint for Claude Cloud routines |
| "By surface" bar | Kept (Cowork + Code real, Chat labeled unmeasurable), plus a second by-project bar |
| Credits | Config/ingest fed, with a visible staleness marker |
| Remote access | In v1 — existing cloudflared tunnel + Cloudflare Access, plus a phone breakpoint |

## 2. Research findings

These were verified on this machine on 2026-08-05, not assumed. They are the foundation of
the whole design, so re-verify if implementation starts much later.

**`claude -p "/usage"` works non-interactively** and returns parseable text:

```
Current session: 24% used · resets Aug 5 at 12:09pm (America/New_York)
Current week (all models): 5% used · resets Aug 10 at 8pm (America/New_York)
Current week (Fable): 0% used
```

It also returns request and session counts for 24h and 7d, plus top skills, subagents,
plugins and MCP servers. `/cost` returns the identical panel — it is not a second source.

This supplies both the three limit bars **and** the header countdown, which the handoff warned
might have no source at all.

**`claude agents --json`** returns live sessions as structured JSON — `pid`, `cwd`, `kind`,
`startedAt`, `sessionId`, `name`, `status` (`busy` | `idle`). This is the Projects column.

**Session logs** at `~/.claude/projects/**/*.jsonl` carry, per message: `model`, a full `usage`
object (input / output / cache-creation / cache-read tokens), `timestamp`, `cwd`, `gitBranch`,
`sessionId`, and `aiTitle`. 105 files were touched in the preceding 7 days.

**Cowork is locally observable too.** Sessions live under
`~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<workspace>/`. Each
`local_*.json` holds `title`, `model`, `cwd`, `userSelectedFolders`, `createdAt`,
`lastActivityAt` and `isArchived`; each session directory also nests a transcript at
`.claude/projects/*/*.jsonl` **in the identical format Claude Code uses**. Verified: 135
messages carrying usage, totalling 6,177,515 Sonnet and 1,778,721 Opus tokens. The same parser
serves both roots — only the path differs.

**launchd** is queryable: `~/Library/LaunchAgents/*.plist` for schedule and program, and
`launchctl list` for PID and last exit status.

**Confirmed absent.** No structured rate-limit or reset fields exist anywhere in the session
logs — every transcript was searched. No local trace of usage-credit balances exists in
`~/.claude`. The documented usage and cost reporting endpoints belong to Console organizations,
which this account does not have. `crontab` is empty. Claude Cloud routines have no local CLI
that can list them.

**Chat is the one unmeasurable surface.** Conversations on claude.ai are server-side and the
client never computes per-conversation token usage, so no local source exists. This is a
permanent gap, not a deferred one, and the UI states it rather than hiding it.
`cowork-policy-limits-cache.json` was checked and holds org policy flags, not usage limits.

## 3. Architecture

```
claude-control-room/
  server/
    collectors/     one module per source, each on its own timer
    cache.mjs       in-memory: { data, fetchedAt, status, error } per panel
    routes/         /api/dashboard · /api/todos · /api/ingest/*
    config.json     user-set values with no API source
    todos.json      the column 03 backlog
  web/              React + Vite; built bundle served by the server
```

The server holds no API key — there is nothing to hold. It shells out to the `claude` CLI the
user is already authenticated with, and reads local files.

**Collectors write to cache on a timer; HTTP requests only read cache.** Nothing shells out on
page load. Each collector is independently failable: one dying leaves every other panel intact.

| Collector | Source | Interval |
|---|---|---|
| `usage` | `claude -p "/usage"` | 5 min |
| `sessions` | Claude Code **and** Cowork transcript roots, incremental by mtime | 60 s |
| `cowork` | Cowork `local_*.json` session metadata | 60 s |
| `agents` | `claude agents --json` | 30 s |
| `crons` | launchd plists + `launchctl list` | 60 s |
| `ingest` | inbound POST, no timer | — |

### Endpoints

- `GET /api/dashboard` — one payload, every panel wrapped as
  `{ data, fetchedAt, status: 'ok' | 'stale' | 'unavailable', error }`
- `GET /api/todos`, `PUT /api/todos` — the column 03 backlog
- `POST /api/ingest/crons`, `POST /api/ingest/projects`, `POST /api/ingest/credits` —
  generic feeds so any source (a Claude Cloud routine, a Cowork job) can report in

The client polls `/api/dashboard` every 30 s and runs one 1 s interval for countdown text.

## 4. Panel data mapping

| Panel | Source | Reality |
|---|---|---|
| Header countdown | `/usage` reset timestamp | Real |
| Plan block | `config.json` | Static — no API exists |
| Credits | `config.json` / ingest | Manual, staleness-marked |
| Three limit bars | `/usage` | Real |
| By surface · this week | Cowork + Code token sums; Chat unmeasurable | Real (2 of 3) |
| By project · this week | both transcript roots, top 3 + Other | Real |
| By model · this week | session-log token sums, both roots | Real |
| Recent sessions | both roots; percent = share of week's tokens | Real |
| Projects | `claude agents --json` + Cowork metadata + logs + git branch | Real |
| Crons | launchd, plus ingest for cloud | Real |
| Ideas & to-dos | `todos.json` | Real |

### Deviations from the prototype, and why

1. **"By surface" is kept, and a second by-project bar is added.** The surface bar keeps the
   original Cowork / Code / Chat structure: Cowork and Code carry real hours and percentages,
   while the Chat slot renders in an explicit "not measurable locally" state — present and
   labeled, never faked or silently dropped. Below it, a second stacked bar of identical
   construction breaks the same week down by project (top 3 by tokens plus "Other"). Column 01
   grows by roughly one bar plus its legend; recent sessions move further down.
2. **Plan block is config, not API.** No endpoint exposes subscription plan details.
3. **Credits panel is new** — not in the prototype. Specified immediately below.
4. **Recent-sessions percent is redefined** as that session's share of the week's tokens. The
   prototype's percent had no stated meaning.

### Credits panel (new)

Sits in column 01 between the plan block and the limit bars, in the established idiom: a 10px
uppercase `.12em` `#7d7979` section label reading `CREDITS`, then

- **Balance** — 20px / 800, matching the plan-name treatment
- **Spend bar** — spent against monthly limit, heat-colored. Percent may exceed 100 %; the bar
  fill clamps at 100 % while the printed figure shows the true value in the accent
- **Two-cell grid** matching the plan block — `RESETS` and `PROMO EXPIRES`
- **Staleness line** — 10px `#7d7979` "updated N days ago", switching to the accent past 7 days

Fields: `balance`, `spent`, `monthlyLimit`, `resetsOn`, `promoAmount`, `promoExpiresOn`,
`updatedAt`.

## 5. Degradation

Non-negotiable, per the handoff: a dashboard that silently shows old numbers is worse than one
that says it is stale.

- **ok** — fresh data, normal render
- **stale** — last good data with a visible marker; entered when a collector has failed but
  cached data exists, or when data ages past twice its interval
- **unavailable** — the panel's frame and heading render with an explicit no-source state; no
  zeros, no empty bars that read as real

The `/usage` parser is the most fragile link: it reads a CLI string that may change shape on a
Claude Code update. Two rules follow. It parses **by label, not by position** — the third bar
is model-scoped and currently reads `Fable` where the prototype shows `Opus`, so the label is
data. And a parse failure marks the panel stale rather than emitting zeros.

## 6. Alerts

Derived, never authored. Any of these produces a line in the alert bar:

- any cron whose last exit status is non-zero
- any limit at or above `warnThreshold` (default 85)
- promotional credit expiring within 30 days
- credits data older than 14 days

The bar renders only when at least one line exists.

## 7. Visual fidelity

All tokens from `design_handoff_claude_control_room/styles.css`, lifted into one CSS file:
ground `#f3f2f2`, surface `#eae9e9`, ink `#201e1d`, accent `#ec3013`, the neutral and accent
ramps, spacing 4/8/12/16/24/32. **Radius 0 everywhere.** Rules are 2px structural, 1px
internal. Archivo 400/500/600/700/800, self-hosted rather than loaded from Google Fonts. All
numerics use `font-variant-numeric: tabular-nums`.

Heat coloring is shared by limits, sessions and credits: at or above `warnThreshold` → accent;
at or above 70 % of threshold → `#605d5d`; otherwise ink.

Focus is `outline: 2px solid #ec3013; outline-offset: 2px` — never the browser default.

**Responsive.** Three breakpoints, none of which the prototype implements:

- **Desk** — three equal columns with 2px vertical rules, as designed.
- **iPad portrait** — one column in the order usage → projects → ideas, vertical rules dropped,
  header stat blocks wrapping under the title.
- **Phone** — the same single column, tightened: page padding drops from 32px to 16px, the `h1`
  from 34px to 26px, and the two header stat blocks sit side by side under the title rather
  than beside it. The 2px section rules and zero radius are preserved — the design's structure
  is what survives the narrowing, not what gets sacrificed to it.

## 8. Settings

`showAlertBanner` (bool, default true) and `warnThreshold` (number, default 85, drives all heat
coloring). Both live in `config.json` alongside the plan and credits values.

## 9. Deployment and access

The dashboard runs as a launchd user agent on the mini, bound to localhost, and is reachable
from anywhere through the **existing** `cloudflared` tunnel already running on that machine
(`com.cloudflare.cloudflared.mini`) — a hostname route added to the current tunnel config, with
a **Cloudflare Access policy in front of it**. Nothing is exposed without auth.

This is reused infrastructure, not new infrastructure: the tunnel and Access are already
serving another service on this host. The incremental work is a route, a policy, and a plist.

Consequences for the build: the server binds to localhost only (the tunnel is the sole path
in), and the client must tolerate the higher, more variable latency of a tunnelled connection
on a phone — the 30 s poll already accommodates this, but request failures must degrade to
`stale` rather than blanking panels.

## 10. Testing

- **Parsers get real fixtures.** Captured `/usage` output, a Claude Code `.jsonl` transcript, a
  **Cowork** transcript plus one `local_*.json`, and `launchctl list` output become test
  fixtures. The `/usage` parser is tested against a deliberately malformed variant to prove it
  degrades to stale instead of to zeros. The transcript parser is tested against both roots to
  confirm one implementation genuinely serves both.
- **Collectors are tested in isolation** with the CLI shelled out behind a seam, so tests never
  invoke `claude`.
- **Degradation is tested per panel** — ok, stale and unavailable each render.
- **Heat thresholds** are tested at the boundaries (84 / 85 / 100 / over 100).

## 11. Out of scope for v1

- Chat surface usage — no local source exists, permanently (§2)
- Browser automation to refresh credits automatically
- Historical retention beyond what the session logs already hold
- Claude Cloud routine listing — covered by the ingest endpoint until a queryable source exists
