# Claude Control Room

A single-screen operational dashboard for one person's Claude account: spend against
limits, running projects and scheduled crons, and a personal backlog. Three equal
columns, built to be read at a glance from a desk browser and an iPad. It runs as a
background service on an always-on Mac and shows real data pulled from the local
machine — nothing is faked, and anything that has no real source says so.

![Control Room screenshot](design_handoff_claude_control_room/screenshots/control-room-full.png)

*(This is the design reference the UI was built to match pixel-for-pixel — see
[Fragility](#fragility) for why a live screenshot isn't checked in.)*

**This is a personal tool for one machine and one account.** The source is public so it
can be read, learned from, and adapted, but it is not a product: it targets one person's
file layout, one person's home directory, and CLI output that Anthropic does not
document or version. See [Adapting it](#adapting-it) before assuming it will run
anywhere else unmodified.

## What it shows, and where the numbers come from

Every panel is wrapped in a status of `ok`, `stale`, or `unavailable`. A `stale` panel
shows the last good data with a visible marker instead of silently going quiet, and an
`unavailable` panel shows its frame and heading with an explicit no-source state —
never a zero or an empty bar standing in for missing data.

| Panel | Source | Reality |
|---|---|---|
| Header countdown | `claude -p "/usage"` reset timestamp | Real |
| Plan block — tier | `claude auth status --json` (`subscriptionType`) | Real, but coarse and can lag a plan change by days — see below |
| Plan block — price, renews, seats | `config.json` | Static — no API exposes pricing, renewal date, or seat count |
| Credits (balance, spend, resets, promo) | `config.json`, or the `/api/ingest/credits` feed | Hand-entered / manually updated, staleness-marked |
| Three limit bars (session, weekly all-models, weekly per-model) | `claude -p "/usage"` | Real |
| By surface · this week (Cowork / Code / Chat) | Session-log token sums under both transcript roots | Real for Cowork and Code; **Chat is permanently unmeasurable** — see below |
| By project · this week | Same transcript roots, top 3 by tokens + Other | Real |
| By model · this week | Same transcript roots | Real |
| Recent sessions | Same transcript roots; percent = that session's share of the week's tokens | Real |
| Projects (column 02) | `claude agents --json` + Cowork session metadata + transcript logs + git branch | Real |
| Scheduled crons | `~/Library/LaunchAgents/*.plist` + `launchctl list`, plus `/api/ingest/crons` for anything that reports in from elsewhere | Real |
| Ideas & to-dos (column 03) | `server/todos.json`, read and written through the server | Real, but local state, not derived from any external source |

**Chat (claude.ai) is not a temporary gap — it has no local source and never will.**
Conversations there are server-side; the client never computes or exposes
per-conversation token usage anywhere on disk. The UI renders the Chat segment
explicitly labeled "not measurable locally" rather than omitting it or showing zero.

**Project task counts are not shown.** No source (agents JSON, session logs, or
anything else on this machine) reliably gives an open-task count per project, so that
field is `null` end-to-end and the UI simply doesn't print the line — it does not
invent a number.

## Why it shells out to the `claude` CLI

**There is no usage or cost API for a consumer Claude subscription.** The Console
usage/cost endpoints and the Admin API exist for Console organizations only; this
account is a Max subscription with no Console org behind it. The only place this
machine's actual usage percentages and reset timestamps exist is the text that
`claude -p "/usage"` prints to a terminal, the only place a live agent/session list
exists is `claude agents --json`, and the only place the plan tier exists at all —
even a lagging, coarse version of it — is `claude auth status --json`.

So the server runs those commands non-interactively on a timer, parses the output, and
caches the result. This is deliberate and is the documented reason it works this way —
**do not "fix" this into an API call.** If Anthropic ships a usage API for consumer
accounts, that would be a real improvement; until then, shelling out to the CLI the
user is already authenticated with is the only source that exists, and it is exactly
why `usage`, `agents`, and `plan` are the collectors that can go `unavailable` if
`claude` isn't on the service's `PATH` (see [Running it](#running-it)).

## Architecture

```
claude-control-room/
  server/
    collectors/     one module per source, each on its own timer, cache-only reads at request time
    cache.mjs        in-memory: { data, fetchedAt, status, error } per panel
    routes.mjs        /api/dashboard · /api/todos · /api/ingest/*
    config.json        user-set values with no API source (gitignored — see config.example.json)
    todos.json          the column 03 backlog (gitignored)
  web/               React + Vite SPA; the server serves the built web/dist bundle
  deploy/            launchd plist template for running the server as a background service
```

Collectors write to cache on a timer; HTTP requests only ever read cache — nothing
shells out on page load. Each collector fails independently: one dying (e.g. `claude`
not being reachable) leaves every other panel intact.

| Collector | Source | Interval |
|---|---|---|
| `usage` | `claude -p "/usage"` | 5 min |
| `sessions` | Claude Code and Cowork transcript roots (`~/.claude/projects` and the Cowork session directory), incremental by mtime | 60 s |
| `agents` | `claude agents --json` | 30 s |
| `crons` | `~/Library/LaunchAgents/*.plist` + `launchctl list` | 60 s |
| `plan` | `claude auth status --json` (tier only — see [Configuration](#configuration)) | 60 min |
| `ingest` | inbound `POST` to `/api/ingest/{crons,projects,credits}`, no timer | — |

The server holds no API key — there is nothing to hold. It shells out to the `claude`
CLI the user is already logged into, and reads local files. It binds to
`127.0.0.1` only; nothing about it is exposed to the network by the server itself.

### What the ingest endpoints require

They are unauthenticated by design (loopback only), so they are narrow instead:

- `Content-Type: application/json` — required. This also stops them being CORS
  *simple* requests, which is what made them reachable from any page the browser
  happened to have open.
- an `Origin` header, if present, must match this server's own host; anything else
  is refused with a 403.
- bodies over 256 KB are refused with a 413 rather than buffered.
- each payload is validated before it is cached — `crons` and `projects` must be
  arrays of objects carrying at least a `name`, `credits` must be an object of
  numbers and date strings — and unknown fields are dropped rather than reaching
  the page. A feed that does not say whether a cron passed leaves that unknown; it
  is never filled in as a pass.

```bash
curl -X POST http://127.0.0.1:8322/api/ingest/crons \
  -H 'Content-Type: application/json' \
  -d '[{"name":"cloud-digest","ok":false,"last":"Failed · 1","schedule":"Daily, 07:00"}]'
```

## Running it

### Prerequisites

- Node.js (developed against v26; anything reasonably current should work)
- The `claude` CLI installed and already authenticated (`claude auth status` should
  show a logged-in session)
- macOS, since crons are read from `launchd` and `plutil`, and Cowork sessions are read
  from a macOS-specific path — this has not been ported to another OS

### Tests and build

```bash
cd server && npm test      # 187 tests, pure-function and collector-seam unit tests, no network, no shelling out to `claude`
cd web && npm run build    # produces web/dist, which the server serves
```

(`server/package.json` also exposes `npm run build` as a convenience alias that runs
the web build from the server directory.)

### Run it directly (foreground, for trying it out)

```bash
cd server && node server.mjs
# then open http://127.0.0.1:8322/
```

### Run it as a background service (launchd)

The repo is public, so what's checked in is `deploy/control-room.plist.example` — a
template with `__HOME__` and `__REPO__` placeholders — not a real plist with this
machine's absolute paths. Generate the real one locally and keep it out of git (the
`.gitignore` already excludes `deploy/*.plist` while keeping `*.plist.example`):

The label in the example is `local.control-room`. It is arbitrary — any reverse-DNS
label works, as long as the filename, the `Label` key and every `launchctl` command
you run agree. Substitute your own below if you prefer.

```bash
LABEL=local.control-room

sed -e "s#__HOME__#$HOME#g" -e "s#__REPO__#$(pwd)#g" \
  deploy/control-room.plist.example > "deploy/$LABEL.plist"

cp "deploy/$LABEL.plist" ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/"$LABEL".plist
```

Give it a minute or two — the `usage` collector shells out to `claude` and that call
alone can take up to 90 seconds — then check:

```bash
launchctl list | grep control-room
curl -s http://127.0.0.1:8322/api/dashboard \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print({k: v.get('status') for k,v in d.items() if isinstance(v, dict)})"
```

`usage`, `sessions`, `agents`, and `crons` should all read `ok`. If any of them says
`unavailable`, check `~/Library/Logs/control-room.log` (both stdout and stderr are
routed there per the plist). **The single most common cause is that `claude` is not on
the launchd service's `PATH`** — launchd services do not inherit your shell's PATH, so
if `claude` lives somewhere non-standard (this machine keeps it in
`~/.local/bin/claude`), the plist's `EnvironmentVariables.PATH` must include that
directory explicitly. The checked-in example already does:

```xml
<key>PATH</key><string>__HOME__/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
```

If you installed `claude` somewhere else, add that directory to `PATH` in the plist and
reload the service (`launchctl unload` then `launchctl load` the same path).

### Remote access: tunnel and Access policy

**This step is documented here, not automated, and intentionally not applied by any
script in this repo.** The dashboard is meant to ride an existing `cloudflared` tunnel
that's already serving other traffic on the host — adding a route to a live tunnel
config is the kind of change that should be reviewed and applied by hand, not run
unattended, especially since a mistake there can take down whatever else that tunnel
serves.

To expose the dashboard through Cloudflare Tunnel + Access:

1. Add a hostname to the **existing** tunnel's config (do not create a second tunnel) —
   in the tunnel's `config.yml`, add an ingress rule pointing at this service before the
   catch-all `service: http_status:404` rule:

   ```yaml
   ingress:
     - hostname: control-room.<your-domain>
       service: http://127.0.0.1:8322
     # ...existing rules above this line...
     - service: http_status:404
   ```

2. Restart the tunnel service so it picks up the new route:

   ```bash
   # substitute your own cloudflared service label — `launchctl list | grep cloudflared`
   launchctl kickstart -k gui/$(id -u)/<your-cloudflared-label>
   ```

3. **In the Cloudflare dashboard**, add a Zero Trust Access policy for that hostname
   *before* testing it from outside the LAN. This is not optional: without an Access
   policy the hostname is public the moment the tunnel route exists, and this dashboard
   shows account usage, project names, and spend figures.

4. Verify from a device off the LAN that the hostname prompts for Access
   authentication first, and only renders the dashboard after that succeeds.

## Configuration

Real configuration lives in `server/config.json`, which is gitignored because it holds
personal figures (spend, plan pricing). `server/config.example.json` is the checked-in
template — copy it to `server/config.json` and fill in real values before running the
server for the first time (if it's missing, the server falls back to the built-in
defaults shown below rather than failing to start).

| Field | Type | Meaning |
|---|---|---|
| `warnThreshold` | number, default `85` | Percent at which any limit bar, and credits spend, turn accent-colored and produce an alert-bar line. Also drives the "70% of threshold" mid heat tier. |
| `showAlertBanner` | bool, default `true` | Whether the alert bar renders at all. Alerts themselves are always computed; this only controls whether they're shown. |
| `plan.price` | string, optional | Plan price, shown as free text (e.g. `"$200 / month"`). Hand-entered — no API exposes it. Omit the field and the price line simply doesn't render; it is never invented. |
| `plan.renews` | ISO date string, optional | An **anchor** renewal date, not necessarily the next one — the server rolls it forward to the next occurrence on or after today (see note below) and that resolved date drives both the RENEWS cell and the "Billing cycle · N days left" note. Hand-entered. |
| `plan.cycle` | `"monthly"` \| `"30d"`, default `"monthly"` | How the anchor rolls forward. `"monthly"` repeats on the same day-of-month (clamped at short months: a 31st anchor becomes the 30th in April, the 28th/29th in February) — this is how Anthropic actually bills. `"30d"` advances in fixed 30-day blocks instead. Change this in one place if the billing model turns out not to be monthly. |
| `plan.seats` | string, optional | Free-text seats line (e.g. `"1 · none"`). Hand-entered — nothing exposes it. |
| `credits.balance` | number | Current credit balance shown in the Credits panel. |
| `credits.spent` | number | Amount spent this cycle; combined with `monthlyLimit` to drive the spend bar and its heat color. |
| `credits.monthlyLimit` | number | Denominator for the spend bar. The printed percent can exceed 100%; the bar fill itself clamps at 100%. |
| `credits.resetsOn` | ISO date string | Shown in the Credits panel's two-cell grid. |
| `credits.promoAmount` | number | Promotional credit amount, if any. |
| `credits.promoExpiresOn` | ISO date string | Drives an alert-bar line when within 30 days of expiring. |
| `credits.updatedAt` | ISO date string | When the credits figures were last hand-updated. The staleness line switches to the accent color past 7 days old, and an alert fires past 14 days old. |

Nothing in `config.json` is fetched automatically — every credits field, and every
remaining plan field, is either typed in by hand or pushed in via
`POST /api/ingest/credits`. There is no browser automation or scraping step that keeps
it current; that's a deliberate scope cut (see spec §12), not an oversight.

**The plan tier is no longer a config field — it's read from `claude auth status
--json`'s `subscriptionType`, on an hourly timer (the `plan` collector,
`server/collectors/plan.mjs`).** That command's output also carries the signed-in
email, org id, and org name; only `subscriptionType` is extracted; the rest is
discarded at the parse boundary and never cached, logged, or returned by the API.

This is a real value, but a coarse and laggy one: `subscriptionType` is reported at
the account level and does not distinguish between all tiers precisely (a Max
subscription can read `"max_5x"`/`"max_20x"`, but has been observed to lag an actual
plan change by at least a couple of days). The deliberate choice here is to show that
lagging real value rather than a hand-typed guess — "Pro" that was true until
recently is still more honest than a tier that was never true. If the `plan` panel is
`unavailable` (`claude` unreachable, or a response with no `subscriptionType`), the
plan block says so via the same status-note treatment every other panel uses; it does
not fall back to a config value, and there isn't one to fall back to.

`plan.price` stays hand-entered because no local or remote source exposes pricing at
all, and the code deliberately does not map tier → price, since Anthropic's pricing
can change independently of this repo. `plan.renews` and `plan.seats` stay
hand-entered too — nothing on this machine exposes a renewal date or a seat count.

`plan.renews` is deliberately an anchor, not a value you have to keep updating by
hand every cycle. `server/lib/renewal.mjs` rolls it forward to the next occurrence
on or after "today" — server-side, so it's unit-tested and computed once rather
than re-derived (and potentially re-derived wrong) in the browser — and ships the
resolved date as `plan.nextRenewal` in the `/api/dashboard` payload; the client
renders that value and never recomputes it. Set the anchor once (e.g. the date a
subscription started or last renewed) and it keeps rolling forward correctly,
including across month-end (a 31st-of-the-month anchor clamps to the last real day
of a shorter month, it does not overflow into the next one). If `plan.renews` is
absent or not a real calendar date, both the RENEWS cell and the billing-cycle note
render as unknown rather than a guess.

## Fragility

This dashboard has no stable, documented interface to the things it reads. It depends
on:

- the exact text format of `claude -p "/usage"` output, parsed **by label, not
  position** so a reordering doesn't silently swap two numbers — but a genuinely
  reworded or restructured output can still break the parser. A parse failure marks the
  `usage` panel `stale` rather than fabricating zeros, but it will still need a fix.
- the JSON shape of `claude agents --json`
- the JSON shape of `claude auth status --json`, specifically that `subscriptionType`
  keeps existing and keeps meaning the plan tier
- the on-disk layout of Claude Code and Cowork transcripts under `~/.claude/projects`
  and the Cowork session directory — none of which is a documented, versioned format
- `launchctl list`'s column format and `plutil`'s JSON conversion of `.plist` files

None of this is an Anthropic-published, versioned API. Any of it can change in any
Claude Code or Cowork release without notice, and probably will eventually. If a panel
starts going `stale` or `unavailable` after an update to `claude` or Claude Desktop,
that's the first thing to suspect.

The re-verification procedure is §2 of the design spec at
`docs/superpowers/specs/2026-08-05-claude-control-room-design.md` — it documents
exactly what was directly checked on this machine on 2026-08-05 (sample `/usage`
output, the `claude agents --json` shape, the transcript file layout for both roots,
what's confirmed absent) and is the starting point for re-verifying any of it after a
CLI update.

## Adapting it

This was built for one person, one Mac, one Max subscription, and one file layout.
Making it work elsewhere is not a supported path, but if you want to try:

- **Different machine, same account type:** the collectors assume macOS paths
  (`~/Library/LaunchAgents`, `~/Library/Application Support/Claude/...` for Cowork).
  Porting to Linux/Windows means rewriting `server/collectors/crons.mjs` and the Cowork
  half of `server/collectors/sessions.mjs` for whatever the equivalent scheduler and
  Cowork storage location are there — if either exists there at all.
- **Console org instead of a consumer subscription:** if you have a Console
  organization, the documented Admin/usage APIs are a *better* source than scraping
  `/usage` text, and would deserve a real HTTP-based `usage` collector instead of a CLI
  shell-out. This codebase does not attempt that; it optimizes for the account type
  that has no API at all.
- **Different home directory / repo location:** the launchd plist template already
  parameterizes these via `__HOME__` / `__REPO__`; nothing else in the server hardcodes
  a path outside of what `os.homedir()` and `import.meta.url` resolve at runtime.
- **Multiple users / shared deployment:** not designed for this at any layer — one
  `config.json`, one `todos.json`, one cache, no auth of its own (auth is delegated
  entirely to Cloudflare Access in front of it). Turning this into a multi-tenant
  service would be a rewrite, not a configuration change.

If you adapt a collector for a new source, keep the shape every panel already commits
to: `{ data, fetchedAt, status: 'ok' | 'stale' | 'unavailable', error }`, and prefer
failing to `stale`/`unavailable` over ever fabricating a number — that discipline is
the one thing in this codebase that isn't specific to this machine.
