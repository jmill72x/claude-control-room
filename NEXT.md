# Next

What's unfinished on this dashboard, written so a fresh session can pick it up cold.
The README covers setup and architecture; this file is only the open items.

## 1. Remote access — done via Tailscale Serve

Remote access is set up. `tailscale serve --bg --http=80 8322` is running on the
host, and the dashboard is reachable at `http://<mini-hostname>.<tailnet>.ts.net/`
from any device on the tailnet, from anywhere — see the README's **"Remote
access"** section for the command, exactly what it does and does not expose, and how
to turn it off.

**No code change was needed or made.** The service still binds `127.0.0.1` only (see
`server.mjs`); it is not reachable from the LAN, only from the tailnet, verified live.

**Remaining nicety, not a blocker: turn on HTTPS.** The tailnet doesn't have HTTPS
certificates enabled yet, so `tailscale serve` is running in `--http=80` mode — real
WireGuard encryption between devices, but plain HTTP inside that tunnel, not `https://`.
The upgrade is two steps, both documented in the README: enable HTTPS Certificates for
the tailnet in the Tailscale admin console's DNS settings, then re-run
`tailscale serve --bg 8322` (no `--http=80`) to pick up a real cert. Worth doing
because it also restores a secure context in the browser, which matters for the
`crypto.randomUUID()` fallback documented in `web/src/components/Lanes.jsx` — that
fallback is currently exercised on every tailnet visit, not just a hypothetical one.

**Cloudflare Tunnel + Access remains documented as the alternative route**, for a
device that can't run Tailscale, but it has not been applied and there is no plan to
apply it unless that need comes up — see the README's **"Alternative: Cloudflare
Tunnel + Access"** subsection for the exact ingress-rule stanza and Access policy
steps. It was deliberately never applied: this machine already runs a `cloudflared`
tunnel serving an unrelated production service (a LinkedIn review tool), and editing
that tunnel's live config to add a route was judged not worth the risk of breaking it
unattended. Any future session that adds the route should apply it by hand, reading
the current tunnel config first, not via a script.

**If it is ever applied, the Access policy must go on before or with the route, never
after.** The hostname becomes publicly reachable the instant the ingress rule exists —
Cloudflare doesn't gate on the Access policy being present, it gates on you having
added one. This dashboard renders account usage, project names, and spend figures, so
a route that outlives an unprotected minute is a real exposure, not a theoretical one.

## 2. Parked findings from the final review

Four issues were identified but not fixed. None are regressions from this session's
work; all pre-date it.

- **A *stale* `agents` envelope still asserts Running/Idle from old data.**
  `server.mjs` computes `agentsAvailable: agentsEnvelope.status !== 'unavailable'`
  before calling `buildProjects()`. The cache (`cache.mjs`) only returns
  `'unavailable'` when a source has *never* produced data; once it has succeeded at
  least once, a subsequent failure downgrades it to `'stale'` while still serving the
  last-good array. `buildProjects()` (`server/lib/projects.mjs`) treats `stale` the
  same as `ok` and prints definite Running/Idle from data that may be many minutes
  old — the unknown-vs-idle fix (`running: null` when the source truly can't be
  read) only covers the case where `claude agents --json` has *never* succeeded, not
  "succeeded once, then started failing." Fix likely means passing the envelope's
  `status` through instead of a collapsed boolean, and treating `stale` as unknown
  too.

- **Array-form `StartCalendarInterval` renders "Every minute."** launchd accepts
  either a single object or an *array* of objects for `StartCalendarInterval` (e.g. a
  job that runs Mondays and Thursdays at 03:00 — two objects in an array). The
  humanizer (`server/lib/humanize.mjs`, `calendarPhrase()`) destructures
  `{ Hour, Minute, Weekday }` directly off `cal` without checking
  `Array.isArray(cal)` first; on an array all three come back `undefined` and it
  falls through to the generic `'Every minute'` string — legal launchd form,
  wrong rendered schedule. No plist on this machine currently uses the array form, so
  this is latent, not actively wrong today. Fix: branch on `Array.isArray` in
  `formatSchedule`/`calendarPhrase` and describe each entry (or at least say
  "multiple times" rather than guessing).

- **The cron summary's "N failing" is measured against a total that includes
  Unknown crons.** In `web/src/App.jsx`, `cronSummary` is
  `` `${crons.filter(c => c.ok === false).length} failing · ${crons.length} scheduled}` ``.
  Ingested crons (`POST /api/ingest/crons`) may report `ok: undefined` when the
  reporting source doesn't know the result (see `validate-ingest.mjs`, where `c.ok`
  is preserved as `undefined` rather than coerced to a boolean) — those crons count
  toward "scheduled" but are neither counted as failing nor called out separately.
  The projects column already has the right pattern for this: `projectSummary` in
  the same file switches to a `"N total · running unknown"` phrasing when any
  project's `running` is neither `true` nor `false`. The cron summary needs the same
  treatment.

- **`objectFrom(...).invalid` is computed and never rendered.** `App.jsx` defines
  `objectFrom()` for the credits ingest feed (a malformed `ingestCredits` payload —
  anything that isn't a plain object — is caught and flagged `invalid: true`), but
  only `.value` is read from the result; `.invalid` is discarded. Compare to
  `arrayFrom()`, used for `ingestProjects` and `ingestCrons`, where `.invalid` drives
  a visible `StatusNote` reading "Feed ignored" (see the `ingestProjects.invalid` and
  `launchdCrons.invalid || ingestCrons.invalid` blocks in the same file). A bad
  credits POST is silently dropped today instead of surfacing the same "Feed
  ignored" marker the other two feeds get.

## 3. Known-unknowable data (don't go looking for these)

- **Chat (claude.ai) usage** has no local source at all and never will — those
  conversations are server-side, and the client never writes per-conversation token
  usage to disk anywhere. The UI labels it "not measurable locally" rather than
  showing zero.
- **Open-task counts per project** are `null` end-to-end. No source on this machine
  (agents JSON, session logs, anything else) reliably supplies one.
- **Plan tier** comes from `claude auth status --json`'s `subscriptionType`, on an
  hourly timer. It's real but coarse, and has been observed to lag an actual plan
  change by a couple of days.
- **Renewal date and seat count** are hand-entered in `server/config.json`
  (`plan.renews`, `plan.cycle`, `plan.seats`) — nothing on this machine exposes
  either one. `plan.renews` is an anchor date that the server rolls forward to the
  next actual occurrence (`server/lib/renewal.mjs`); it still has to be re-anchored
  by hand if the billing date ever changes for a reason other than normal renewal.

## 4. Fragility warning

Every data source this dashboard reads is an undocumented file layout or CLI output
format that can change in any Claude Code release, with no compatibility guarantee.
Before trusting a panel that starts looking wrong, re-verify against the live machine
using the procedure in **§2 ("Research findings") of
`docs/superpowers/specs/2026-08-05-claude-control-room-design.md`** — it documents
exactly how each source was confirmed the first time and is the template for
re-confirming it.

The four surfaces this depends on, any of which can shift silently:

1. `claude -p "/usage"` text output (parsed by label, not position, but a reworded
   or restructured panel can still break the parser)
2. `claude agents --json` output shape
3. the two transcript roots (Claude Code's `~/.claude/projects/**/*.jsonl` and the
   Cowork local-agent-mode session directory)
4. `launchctl list` output plus the `~/Library/LaunchAgents/*.plist` files it reads
   alongside

## 5. Working on it

```bash
cd server && npm test                       # unit tests, no network, no shelling out
cd web && npm run build                     # produces web/dist, which the server serves
launchctl kickstart -k gui/$(id -u)/<your-service-label>   # restart the running service
```

Config (`server/config.json`, gitignored) and the to-do board (`server/todos.json`,
gitignored) both live under `server/` and are edited directly on the machine running
the service — see the README's Configuration section for the field-by-field
reference. There is no separate staging step: edit the file, restart the service,
done.
