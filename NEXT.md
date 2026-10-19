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

## 2. Open bugs

The four review findings that used to be parked here were all fixed in `ee1e1df`
(2026-09-11). These are the ones still open:

- **P2: the server lost its HTTP listener while staying alive.** From Sep 28 to Oct 2
  the process kept running, collectors still ticking, but held no listening socket,
  so every request hung. The root cause is unknown. Since `e725dbb` the server checks
  its own `/api/health` every minute and exits after three failures in a row, so
  launchd restarts it (see the README), but that watchdog has never been seen firing
  for real. Next step: look for `watchdog:` lines in `~/Library/Logs/control-room.log`;
  the first one is the moment to dig into the cause.

- **P3: `cachedUsageUtilization` vanished from `~/.claude.json` for ten minutes.** On
  2026-10-08, after Claude Code auto-updated itself to 2.1.295, the cached usage
  response the credits panel reads was missing from 19:35 to 19:45 local, then came
  back. The panel stayed honest, showing the last good figures marked stale. Cause
  unknown; watch for a repeat, especially the morning after a CLI update.

- **P3: the web page's cron sort is inconsistent for unknown-state crons.** The
  comparator in `web/src/App.jsx` gives no consistent answer when one cron's `ok` is
  `undefined` (unknown) and the other's is `false`, so their order depends on the
  browser. Harmless until an ingest poster exists. The mod uses a fixed order.

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

## 5. Source-health: diagnose *why* a panel is unavailable, not just that it is

Raised during the Phase 2 design (pace, history, usage-drivers) but not built —
it wasn't in the approved spec for that work, so it's recorded here instead.

Right now `unavailable` means one thing to the UI regardless of cause. From the
outside, a `/usage` output format that Anthropic reworded and a `claude` binary
that crashed or isn't on the service's `PATH` look identical: same status,
same blank panel, same shrug. The dashboard has no way to tell you which one
it is, so every investigation starts from zero.

The fix is cheap relative to the payoff: have the parsers report what they
matched, not just whether they succeeded outright. `parse-usage.mjs` already
knows, line by line, whether a limit line matched `LIMIT_RE`, whether the
factors block's window-counts header matched, and how many behaviour/top
lines parsed under it — that information exists during parsing and is
discarded the moment the function returns. Surfacing it (something like
"matched 2 of 3 expected limit lines" or "factors header matched, 0 of 4
behaviour lines recognized") turns a silent unavailable into an actual
diagnosis: a partial match points straight at a reworded format, a total
match failure points at the CLI itself (not on `PATH`, timed out, auth
expired, etc.).

This is the highest-value follow-up on the table because it's aimed at the
project's central fact, not an edge case: every source this dashboard reads —
`/usage` text, `claude agents --json`, `claude auth status --json`, the
transcript file layout, `launchctl`'s output — is undocumented and
unversioned (see "Fragility warning" above), and any of it can change in any
Claude Code release without notice. The question isn't whether a parser will
eventually drift out from under this dashboard, it's how long that will take
to notice and diagnose once it does. Right now the answer is "however long it
takes to manually re-run the source-of-truth verification in the design
spec." A parser that reports its own match rate shrinks that to reading one
line of status.

**A `/control-room doctor` command would put this in front of a person.** The idea comes
from SessionDeck (§6): one line per source with its last success, its last error, and a
"format drift suspected" flag when a file that exists stops parsing, as opposed to one
that is simply missing. Telling those apart needs the match rates above. The 2026-10-08
credits flake (§2) took several manual checks to diagnose; this would have made it one.

## 6. On hold: ideas from SessionDeck

Raised 2026-10-15: SessionDeck (`len5ky/sessiondeck`), an editor extension that tracks
live agent sessions. **Take the ideas only, never its code.** It is source-available, not
open source, and its license bars distributing modified copies; this repo is public, so
anything built from these has to be our own code. Waiting on a go-ahead; nothing is built.

- **A "needs you" session state.** Claude Code's Notification, Stop and UserPromptSubmit
  hooks post straight to this server, so the Projects column and the mod pane can show
  working, needs you, finished-unread and idle (`claude agents --json` only ever reports
  busy or idle), and ntfy can push "a session needs you". It needs a hook entry in
  `~/.claude/settings.json`, which only Jeff can add.
- **A "quiet" flag.** A working session that has been silent far longer than its current
  tool normally takes keeps its status but gains "quiet 12m" (SessionDeck allows 5
  minutes for a file read and 15 for a shell command). It flags a possible hang without
  inventing a state, and comes almost free once the first idea exists.

The third idea, a `/control-room doctor` command, is folded into §5.

## 7. Working on it

```bash
cd server && npm test                       # unit tests, no network, no shelling out
cd web && npm run build                     # produces web/dist, which the server serves
launchctl kickstart -k gui/$(id -u)/<your-service-label>   # restart the running service (Vision's and Jeff's job, not the agent's)
```

Config (`server/config.json`, gitignored) and the to-do board (`server/todos.json`,
gitignored) both live under `server/` and are edited directly on the machine running
the service — see the README's Configuration section for the field-by-field
reference. There is no separate staging step: edit the file, restart the service,
done.

## 8. Ranked improvements for the Jarvis era (2026-10-19)

Jeff asked "How can we improve the control panel?" on the day Jarvis went live. Jarvis now
writes the board several times a day, the agents run as subagents of one Jarvis session,
and Jeff reads mostly from an iPad or iPhone. Ranked, all read-only findings, nothing built:

1. **Stop a stale tab from reverting Jarvis's board edits** (bug, S–M). `Lanes.jsx` reads
   `/api/todos` once on mount and every edit PUTs its whole in-memory list, and the PUT has
   no version check. Jarvis saved 5 boards between 11:57 and 13:38 on 10-19, so one tap in
   an iPad tab opened that morning silently reverts all of them (the 10-07 mechanism, now
   routine). Fix: a board revision (ETag/If-Match), a 409 that reloads the list, and a
   re-read when the tab regains focus. The 20 rolling copies make it recoverable, not safe.
2. **Board first on the phone** (S). Below 1024px the grid becomes one column, so the board
   Jeff reads most sits under every usage panel and the Projects column. Put column 03 first
   (CSS `order`) or add a three-tab switcher at phone width.
3. **An Agents panel** (M). Sessions are named by working directory, so Pepper's run shows as
   "linkedin-post-agent" and 31% of the week's tokens land in "Projects". Each subagent
   transcript has a `.meta.json` with `agentType` and the brief's `description` (checked
   10-19), so the server can show, per agent, its last run, what it was asked and its tokens.
4. **Watch the always-on services** (S–M). `collectors/crons.mjs` keeps only plists with a
   schedule, so `com.jeff.jarvis` (Jarvis itself), this service, `cloudflared` and
   `linkedin-review` never appear. Show their PID and last exit from `launchctl list`, and
   alert #pepper when Jarvis has no PID. Read-only, so it stays within Vision's scope.
5. **Board fields for a co-owned board** (M). Add `created` (the P3 item on the board), an
   optional `owner` (agent name) and a done-lane archive (37 of 86 items are done). There is
   no Control Room tag: this dashboard's items sit under Bug, Feature and Infra, so the board
   can't group them.
6. **Source health / `/control-room doctor`** (M, §5 above). Also serve it as a small JSON
   status Jarvis can read for the morning brief, so "is the dashboard right?" is one GET.
7. **Timestamp the service log** (S). `~/Library/Logs/control-room.log` has 51 bare
   "control room on" starts and no times, so neither a restart nor a future `watchdog:` line
   can be dated, which blocks the P2 listener-loss investigation in §2.

Smaller rough edges seen the same day: the board's "push alerts have reached no one" P3 item
is stale (alerts post to #pepper since `4a50a5b`; the log shows 3 posts, and
`server/data/notified.json` now exists); the HTTPS item on the board has no priority.
